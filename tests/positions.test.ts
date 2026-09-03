import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPositions } from "../src/positions.js";
import { Pricer } from "../src/pricing.js";
import { RpcClient } from "../src/rpc.js";
import type { ChainConfig, TxDelta } from "../src/types.js";

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const TOKEN = "0x1234567890123456789012345678901234567890";
const TOKEN2 = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

const chain: ChainConfig = {
  id: 1,
  name: "ethereum",
  displayName: "Ethereum",
  rpcUrl: "https://example.invalid",
  nativeSymbol: "ETH",
  nativeUsdSeries: "eth-usd.json",
  explorerTxUrl: "https://etherscan.io/tx/{hash}",
  quoteAssets: [{ address: WETH, symbol: "WETH", decimals: 18 }],
};

function ts(dateStr: string): number {
  return Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 1000);
}

function freshRpc(): RpcClient {
  const dir = mkdtempSync(join(tmpdir(), "hindsight-test-"));
  return new RpcClient({ rpcUrl: "offline://test", cacheDir: dir, offline: true });
}

function swapDelta(opts: {
  hash: string;
  date: string;
  out: [string, number];
  in: [string, number];
}): TxDelta {
  const deltas: Record<string, number> = {};
  deltas[opts.out[0]] = -opts.out[1];
  deltas[opts.in[0]] = (deltas[opts.in[0]] ?? 0) + opts.in[1];
  return {
    hash: opts.hash,
    blockNumber: 1,
    timestamp: ts(opts.date),
    failed: false,
    isSender: true,
    gasUsedWei: 100_000n,
    effectiveGasPriceWei: 20_000_000_000n,
    baseFeePerGasWei: 15_000_000_000n,
    deltas,
    decimals: {},
  };
}

test("FIFO basis: partial sell consumes the oldest lot first", async () => {
  const series = { "2026-01-01": 2000, "2026-01-02": 2200, "2026-01-03": 2100 };
  const pricer = new Pricer(chain, series);
  const deltas: TxDelta[] = [
    swapDelta({ hash: "buy1", date: "2026-01-01", out: [WETH, 1], in: [TOKEN, 100] }),
    swapDelta({ hash: "buy2", date: "2026-01-02", out: [WETH, 1.5], in: [TOKEN, 100] }),
    swapDelta({ hash: "sell1", date: "2026-01-03", out: [TOKEN, 150], in: [WETH, 2] }),
  ];

  const result = await buildPositions(deltas, { chain, pricer, rpc: freshRpc() });
  const pos = result.positions.find((p) => p.token === TOKEN)!;
  assert.ok(pos, "position for TOKEN should exist");

  const cost1 = 1 * 2000; // lot 1: 100 units at $20/unit
  const cost2 = 1.5 * 2200; // lot 2: 100 units at $33/unit
  const proceeds = 2 * 2100;
  const costOfSold = cost1 + (50 / 100) * cost2; // lot1 fully consumed + half of lot2
  const expectedPnl = proceeds - costOfSold;

  assert.ok(Math.abs(pos.realizedPnlUsd - expectedPnl) < 1e-6, `expected pnl ~${expectedPnl}, got ${pos.realizedPnlUsd}`);
  assert.equal(pos.currentQty, 50); // 50 units left from lot 2
  assert.ok(Math.abs(pos.currentCostBasisUsd - 0.5 * cost2) < 1e-6);
  assert.equal(pos.closeEvents, 0); // never fully closed
  assert.equal(pos.realizedTrades.length, 1);
  assert.equal(pos.realizedTrades[0]!.qty, 150);
});

test("a position fully sold then rebought and sold again counts two close events", async () => {
  const series = { "2026-01-01": 2000, "2026-01-05": 2000, "2026-02-01": 2000, "2026-02-05": 2000 };
  const pricer = new Pricer(chain, series);
  const deltas: TxDelta[] = [
    swapDelta({ hash: "b1", date: "2026-01-01", out: [WETH, 1], in: [TOKEN2, 100] }),
    swapDelta({ hash: "s1", date: "2026-01-05", out: [TOKEN2, 100], in: [WETH, 1.2] }),
    swapDelta({ hash: "b2", date: "2026-02-01", out: [WETH, 1], in: [TOKEN2, 100] }),
    swapDelta({ hash: "s2", date: "2026-02-05", out: [TOKEN2, 100], in: [WETH, 0.8] }),
  ];
  const result = await buildPositions(deltas, { chain, pricer, rpc: freshRpc() });
  const pos = result.positions.find((p) => p.token === TOKEN2)!;
  assert.equal(pos.closeEvents, 2);
  assert.equal(pos.currentQty, 0);
});

test("selling more than the recorded basis marks the shortfall unpriced instead of guessing", async () => {
  const series = { "2026-01-01": 2000, "2026-01-10": 2000 };
  const pricer = new Pricer(chain, series);
  const deltas: TxDelta[] = [
    swapDelta({ hash: "b1", date: "2026-01-01", out: [WETH, 1], in: [TOKEN, 100] }),
    swapDelta({ hash: "s1", date: "2026-01-10", out: [TOKEN, 250], in: [WETH, 2] }), // only 100 have a basis
  ];
  const result = await buildPositions(deltas, { chain, pricer, rpc: freshRpc() });
  assert.equal(result.unpricedCount, 1);
  assert.ok(result.unpricedTxHashes.includes("s1"));
});

test("a swap where neither leg is a quote asset is excluded and counted, not guessed", async () => {
  const pricer = new Pricer(chain, { "2026-01-01": 2000 });
  const otherToken = "0x000000000000000000000000009999999999abcd";
  const deltas: TxDelta[] = [
    swapDelta({ hash: "t2t", date: "2026-01-01", out: [TOKEN, 10], in: [otherToken, 5] }),
  ];
  const result = await buildPositions(deltas, { chain, pricer, rpc: freshRpc() });
  assert.equal(result.unpricedCount, 1);
  assert.equal(result.positions.length, 0);
});

test("a quote-to-quote swap does not create a position or affect capital", async () => {
  const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const chainWithUsdc: ChainConfig = {
    ...chain,
    quoteAssets: [...chain.quoteAssets, { address: usdc, symbol: "USDC", decimals: 6 }],
  };
  const pricer = new Pricer(chainWithUsdc, { "2026-01-01": 2000 });
  const deltas: TxDelta[] = [swapDelta({ hash: "qs", date: "2026-01-01", out: [WETH, 1], in: [usdc, 2000] })];
  const result = await buildPositions(deltas, { chain: chainWithUsdc, pricer, rpc: freshRpc() });
  assert.equal(result.positions.length, 0);
  assert.equal(result.capitalDeployedUsd, 0);
});

test("a plain deposit of a quote asset becomes a capital flow at receipt-time value", async () => {
  const pricer = new Pricer(chain, { "2026-01-01": 2500 });
  const deltas: TxDelta[] = [
    {
      hash: "deposit",
      blockNumber: 1,
      timestamp: ts("2026-01-01"),
      failed: false,
      isSender: false,
      gasUsedWei: 0n,
      effectiveGasPriceWei: 0n,
      baseFeePerGasWei: null,
      deltas: { [WETH]: 3 },
      decimals: {},
    },
  ];
  const result = await buildPositions(deltas, { chain, pricer, rpc: freshRpc() });
  assert.equal(result.capitalDeployedUsd, 3 * 2500);
});

test("an airdropped non-quote token is recorded at zero cost basis", async () => {
  const pricer = new Pricer(chain, { "2026-01-01": 2000, "2026-02-01": 2000 });
  const deltas: TxDelta[] = [
    {
      hash: "airdrop",
      blockNumber: 1,
      timestamp: ts("2026-01-01"),
      failed: false,
      isSender: false,
      gasUsedWei: 0n,
      effectiveGasPriceWei: 0n,
      baseFeePerGasWei: null,
      deltas: { [TOKEN]: 1000 },
      decimals: {},
    },
    swapDelta({ hash: "sell-airdrop", date: "2026-02-01", out: [TOKEN, 1000], in: [WETH, 0.5] }),
  ];
  const result = await buildPositions(deltas, { chain, pricer, rpc: freshRpc() });
  const pos = result.positions.find((p) => p.token === TOKEN)!;
  assert.equal(pos.totalBuyCostUsd, 0);
  assert.equal(pos.realizedPnlUsd, 0.5 * 2000); // pure proceeds, zero cost
});

test("failed transactions are skipped entirely by position reconstruction", async () => {
  const pricer = new Pricer(chain, { "2026-01-01": 2000 });
  const deltas: TxDelta[] = [
    {
      hash: "failed",
      blockNumber: 1,
      timestamp: ts("2026-01-01"),
      failed: true,
      isSender: true,
      gasUsedWei: 100_000n,
      effectiveGasPriceWei: 20_000_000_000n,
      baseFeePerGasWei: 15_000_000_000n,
      deltas: { [WETH]: -1, [TOKEN]: 100 }, // would look like a buy if not skipped
      decimals: {},
    },
  ];
  const result = await buildPositions(deltas, { chain, pricer, rpc: freshRpc() });
  assert.equal(result.positions.length, 0);
  assert.equal(result.unpricedCount, 0);
});
