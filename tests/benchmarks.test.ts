import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBenchmarks, moneyLeftOnTable } from "../src/benchmarks.js";
import { Pricer } from "../src/pricing.js";
import type { ChainConfig, LeakSummary, PositionSummary, PositionsResult } from "../src/types.js";

const chain: ChainConfig = {
  id: 1,
  name: "ethereum",
  displayName: "Ethereum",
  rpcUrl: "https://example.invalid",
  nativeSymbol: "ETH",
  nativeUsdSeries: "eth-usd.json",
  explorerTxUrl: "https://etherscan.io/tx/{hash}",
  quoteAssets: [],
};

function ts(dateStr: string): number {
  return Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 1000);
}

function makeLeaks(totalFeeUsd: number | null): LeakSummary {
  return {
    totalFeeWei: 0n,
    totalFeeUsd,
    priorityFeeWei: 0n,
    priorityFeeUsd: null,
    txCount: 0,
    failedTxCount: 0,
    failedTxFeeWei: 0n,
    failedTxFeeUsd: null,
    feeSweepComplete: true,
    sandwichDetection: "not_implemented",
  };
}

function makePosition(overrides: Partial<PositionSummary>): PositionSummary {
  return {
    token: "0xtoken",
    symbol: "TOK",
    totalBoughtQty: 0,
    totalSoldQty: 0,
    totalBuyCostUsd: 0,
    totalSellProceedsUsd: 0,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    currentQty: 0,
    currentCostBasisUsd: 0,
    markPriceUsd: null,
    maxObservedPriceUsd: null,
    lastPriceTimestamp: null,
    firstBuyTimestamp: null,
    lastActivityTimestamp: null,
    closeEvents: 0,
    realizedTrades: [],
    ...overrides,
  };
}

test("the four benchmarks compute from the documented formulas", () => {
  const pricer = new Pricer(chain, { "2026-01-01": 2000, "2026-01-02": 3000 });
  const position = makePosition({
    totalBoughtQty: 10,
    realizedPnlUsd: 50,
    unrealizedPnlUsd: 30,
    markPriceUsd: 100,
    maxObservedPriceUsd: 150,
  });
  const positions: PositionsResult = {
    positions: [position],
    unpricedCount: 0,
    unpricedTxHashes: [],
    capitalDeployedUsd: 1000,
    capitalFlows: [{ timestamp: ts("2026-01-01"), usdAmount: 1000 }],
    totalBuyCostUsd: 800,
    firstInflowTimestamp: ts("2026-01-01"),
    lastActivityTimestamp: ts("2026-01-02"),
  };
  const leaks = makeLeaks(20);

  const rows = computeBenchmarks(positions, leaks, pricer, ts("2026-01-02"));
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

  // actual: 1000 + 50 + 30 - 20 = 1060 -> +6%
  assert.ok(Math.abs(byKey.actual!.endUsd - 1060) < 1e-9);
  assert.ok(Math.abs(byKey.actual!.pctChange - 6) < 1e-9);

  // hodl native: $1000 deposited at $2000/ETH = 0.5 ETH, valued at $3000/ETH = $1500 -> +50%
  assert.ok(Math.abs(byKey.hodl_native!.endUsd - 1500) < 1e-9);
  assert.ok(Math.abs(byKey.hodl_native!.pctChange - 50) < 1e-9);

  // never sold: leftover cash (1000-800=200) + 10 units at mark $100 = 1200 -> +20%
  assert.ok(Math.abs(byKey.never_sold!.endUsd - 1200) < 1e-9);
  assert.ok(Math.abs(byKey.never_sold!.pctChange - 20) < 1e-9);

  // perfect exits: 200 + 10 * $150 = 1700 -> +70%, flagged as a ceiling
  assert.ok(Math.abs(byKey.perfect_exits!.endUsd - 1700) < 1e-9);
  assert.ok(Math.abs(byKey.perfect_exits!.pctChange - 70) < 1e-9);
  assert.equal(byKey.perfect_exits!.isCeiling, true);
  assert.equal(byKey.actual!.isCeiling, false);

  const left = moneyLeftOnTable(rows);
  // best realistic alternative is hodl_native (1500) vs actual (1060) = 440
  assert.ok(left != null && Math.abs(left - 440) < 1e-9);
});

test("zero starting capital does not divide by zero", () => {
  const pricer = new Pricer(chain, { "2026-01-01": 2000 });
  const positions: PositionsResult = {
    positions: [],
    unpricedCount: 0,
    unpricedTxHashes: [],
    capitalDeployedUsd: 0,
    capitalFlows: [],
    totalBuyCostUsd: 0,
    firstInflowTimestamp: null,
    lastActivityTimestamp: null,
  };
  const rows = computeBenchmarks(positions, makeLeaks(0), pricer, ts("2026-01-01"));
  for (const row of rows) {
    assert.equal(row.pctChange, 0);
    assert.equal(Number.isFinite(row.pctChange), true);
  }
});
