import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient } from "../src/rpc.js";
import { scanWalletDeltas } from "../src/deltas.js";
import { addressTopic, toHex } from "../src/logs.js";
import { ERC20_TRANSFER_TOPIC, NATIVE_PSEUDO_ADDRESS } from "../src/types.js";
import type { RawLog } from "../src/types.js";

const WALLET = "0x0000000000000000000000000000000000000001";
const ROUTER = "0x0000000000000000000000000000000000000002";
const WETH = "0x00000000000000000000000000000000000000ee";
const TOKEN = "0x00000000000000000000000000000000000000aa";

function freshRpc(): RpcClient {
  const dir = mkdtempSync(join(tmpdir(), "hindsight-test-"));
  return new RpcClient({ rpcUrl: "offline://test", cacheDir: dir, offline: true });
}

function transferLog(block: number, hash: string, token: string, from: string, to: string, amountWei: bigint): RawLog {
  return {
    address: token,
    topics: [ERC20_TRANSFER_TOPIC, addressTopic(from), addressTopic(to)],
    data: "0x" + amountWei.toString(16).padStart(64, "0"),
    blockNumber: toHex(block),
    transactionHash: hash,
    logIndex: "0x0",
  };
}

function seedNamespace(rpc: RpcClient, namespace: string, wallet: string, from: number, to: number, logs: RawLog[]) {
  const dir = join("logs", namespace, wallet.toLowerCase());
  rpc.seedCache(join(dir, `${from}-${to}.json`), logs);
  rpc.seedCache(join(dir, "manifest.json"), { scannedFrom: from, scannedTo: to, chunks: [[from, to]] });
}

test("a buy is reconstructed from a WETH-out, TOKEN-in Transfer log pair", async () => {
  const rpc = freshRpc();
  const hash = "0xhash1";
  const block = 1;
  const timestamp = 1_700_000_000;

  const outLog = transferLog(block, hash, WETH, WALLET, ROUTER, 1_000_000_000_000_000_000n); // 1 WETH
  const inLog = transferLog(block, hash, TOKEN, ROUTER, WALLET, 100_000_000_000_000_000_000n); // 100 TOKEN

  seedNamespace(rpc, "transfers-from", WALLET, block, block, [outLog]);
  seedNamespace(rpc, "transfers-to", WALLET, block, block, [inLog]);

  rpc.seedCache(join("erc20", `${WETH}.json`), { symbol: "WETH", decimals: 18 });
  rpc.seedCache(join("erc20", `${TOKEN}.json`), { symbol: "TOKEN", decimals: 18 });
  rpc.seedCache(join("receipts", `${hash}.json`), {
    transactionHash: hash,
    blockNumber: toHex(block),
    from: WALLET,
    to: ROUTER,
    status: "0x1",
    gasUsed: toHex(150_000),
    effectiveGasPrice: toHex(20_000_000_000),
  });
  rpc.seedCache(join("txs", `${hash}.json`), { hash, from: WALLET, to: ROUTER, value: "0x0", blockNumber: toHex(block) });
  rpc.seedCache(join("blocks", `${toHex(block)}.json`), { number: toHex(block), timestamp: toHex(timestamp), baseFeePerGas: toHex(15_000_000_000) });
  rpc.seedCache(join("blocks-full", `${toHex(block)}.json`), {
    number: toHex(block),
    timestamp: toHex(timestamp),
    baseFeePerGas: toHex(15_000_000_000),
    transactions: [{ hash, from: WALLET, to: ROUTER, value: "0x0", blockNumber: toHex(block) }],
  });

  const result = await scanWalletDeltas(rpc, WALLET, block, block);
  assert.equal(result.deltas.length, 1);
  const delta = result.deltas[0]!;
  assert.equal(delta.hash, hash);
  assert.equal(delta.failed, false);
  assert.ok(Math.abs(delta.deltas[WETH]! - -1) < 1e-9);
  assert.ok(Math.abs(delta.deltas[TOKEN]! - 100) < 1e-9);
  assert.equal(result.feeSweepComplete, true);
});

test("native ETH value transfers are read from the transaction, not a log", async () => {
  const rpc = freshRpc();
  const hash = "0xhash2";
  const block = 1;
  const timestamp = 1_700_000_000;
  const other = "0x0000000000000000000000000000000000000099";

  // Wallet is the *recipient* of a plain ETH transfer that happens to
  // co-occur with an unrelated token transfer so it's discoverable via
  // Transfer-log scanning (a pure native send with no token leg at all is
  // a documented blind spot -- see docs/how-pnl-is-computed.md).
  const inLog = transferLog(block, hash, TOKEN, other, WALLET, 5_000_000_000_000_000_000n);
  seedNamespace(rpc, "transfers-from", WALLET, block, block, []);
  seedNamespace(rpc, "transfers-to", WALLET, block, block, [inLog]);
  rpc.seedCache(join("erc20", `${TOKEN}.json`), { symbol: "TOKEN", decimals: 18 });
  rpc.seedCache(join("receipts", `${hash}.json`), {
    transactionHash: hash,
    blockNumber: toHex(block),
    from: other,
    to: WALLET,
    status: "0x1",
    gasUsed: toHex(21_000),
    effectiveGasPrice: toHex(10_000_000_000),
  });
  rpc.seedCache(join("txs", `${hash}.json`), {
    hash,
    from: other,
    to: WALLET,
    value: "0x" + (2_000_000_000_000_000_000n).toString(16), // 2 ETH
    blockNumber: toHex(block),
  });
  rpc.seedCache(join("blocks", `${toHex(block)}.json`), { number: toHex(block), timestamp: toHex(timestamp), baseFeePerGas: toHex(8_000_000_000) });
  rpc.seedCache(join("blocks-full", `${toHex(block)}.json`), {
    number: toHex(block),
    timestamp: toHex(timestamp),
    baseFeePerGas: toHex(8_000_000_000),
    transactions: [{ hash, from: other, to: WALLET, value: "0x" + (2_000_000_000_000_000_000n).toString(16), blockNumber: toHex(block) }],
  });

  const result = await scanWalletDeltas(rpc, WALLET, block, block);
  const delta = result.deltas.find((d) => d.hash === hash)!;
  assert.ok(Math.abs(delta.deltas[NATIVE_PSEUDO_ADDRESS]! - 2) < 1e-9);
  assert.equal(delta.isSender, false); // wallet received; someone else paid gas
});

test("a reverted transaction with no logs is still found by the bounded fee sweep", async () => {
  const rpc = freshRpc();
  const hash = "0xfailed1";
  const block = 1;
  const timestamp = 1_700_000_000;

  seedNamespace(rpc, "transfers-from", WALLET, block, block, []);
  seedNamespace(rpc, "transfers-to", WALLET, block, block, []);
  rpc.seedCache(join("receipts", `${hash}.json`), {
    transactionHash: hash,
    blockNumber: toHex(block),
    from: WALLET,
    to: ROUTER,
    status: "0x0",
    gasUsed: toHex(90_000),
    effectiveGasPrice: toHex(25_000_000_000),
  });
  rpc.seedCache(join("txs", `${hash}.json`), { hash, from: WALLET, to: ROUTER, value: "0x0", blockNumber: toHex(block) });
  rpc.seedCache(join("blocks", `${toHex(block)}.json`), { number: toHex(block), timestamp: toHex(timestamp), baseFeePerGas: toHex(20_000_000_000) });
  rpc.seedCache(join("blocks-full", `${toHex(block)}.json`), {
    number: toHex(block),
    timestamp: toHex(timestamp),
    baseFeePerGas: toHex(20_000_000_000),
    transactions: [{ hash, from: WALLET, to: ROUTER, value: "0x0", blockNumber: toHex(block) }],
  });

  const result = await scanWalletDeltas(rpc, WALLET, block, block);
  assert.equal(result.feeSweepComplete, true);
  const delta = result.deltas.find((d) => d.hash === hash);
  assert.ok(delta, "reverted tx should be discovered via the block sweep");
  assert.equal(delta!.failed, true);
  assert.equal(delta!.gasUsedWei, 90_000n);
});
