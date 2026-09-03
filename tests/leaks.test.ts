import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLeaks } from "../src/leaks.js";
import { Pricer } from "../src/pricing.js";
import type { ChainConfig, TxDelta } from "../src/types.js";

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

function makeDelta(opts: {
  hash: string;
  isSender: boolean;
  failed: boolean;
  gasUsed: bigint;
  gasPrice: bigint;
  baseFee: bigint | null;
}): TxDelta {
  return {
    hash: opts.hash,
    blockNumber: 1,
    timestamp: ts("2026-01-01"),
    failed: opts.failed,
    isSender: opts.isSender,
    gasUsedWei: opts.gasUsed,
    effectiveGasPriceWei: opts.gasPrice,
    baseFeePerGasWei: opts.baseFee,
    deltas: {},
    decimals: {},
  };
}

test("total fees sum gas cost only for transactions the wallet paid for", () => {
  const pricer = new Pricer(chain, { "2026-01-01": 2000 });
  const deltas: TxDelta[] = [
    makeDelta({ hash: "a", isSender: true, failed: false, gasUsed: 100_000n, gasPrice: 20_000_000_000n, baseFee: 15_000_000_000n }),
    makeDelta({ hash: "b", isSender: false, failed: false, gasUsed: 999_999n, gasPrice: 999_000_000_000n, baseFee: null }), // wallet didn't pay
  ];
  const leaks = computeLeaks(deltas, pricer, true);
  const expectedFeeWei = 100_000n * 20_000_000_000n;
  assert.equal(leaks.totalFeeWei, expectedFeeWei);
  assert.equal(leaks.txCount, 1);
  const expectedUsd = (Number(expectedFeeWei) / 1e18) * 2000;
  assert.ok(leaks.totalFeeUsd != null && Math.abs(leaks.totalFeeUsd - expectedUsd) < 1e-9);
});

test("priority fee is effectiveGasPrice minus baseFeePerGas, per transaction", () => {
  const pricer = new Pricer(chain, { "2026-01-01": 2000 });
  const deltas: TxDelta[] = [
    makeDelta({ hash: "a", isSender: true, failed: false, gasUsed: 100_000n, gasPrice: 20_000_000_000n, baseFee: 15_000_000_000n }),
  ];
  const leaks = computeLeaks(deltas, pricer, true);
  const expectedTip = (20_000_000_000n - 15_000_000_000n) * 100_000n;
  assert.equal(leaks.priorityFeeWei, expectedTip);
});

test("legacy transactions with no base fee report zero priority fee rather than guessing", () => {
  const pricer = new Pricer(chain, { "2026-01-01": 2000 });
  const deltas: TxDelta[] = [
    makeDelta({ hash: "a", isSender: true, failed: false, gasUsed: 100_000n, gasPrice: 20_000_000_000n, baseFee: null }),
  ];
  const leaks = computeLeaks(deltas, pricer, true);
  assert.equal(leaks.priorityFeeWei, 0n);
});

test("a reverted transaction still burned gas, and it is counted as a failure", () => {
  const pricer = new Pricer(chain, { "2026-01-01": 2000 });
  const deltas: TxDelta[] = [
    makeDelta({ hash: "ok", isSender: true, failed: false, gasUsed: 100_000n, gasPrice: 20_000_000_000n, baseFee: 15_000_000_000n }),
    makeDelta({ hash: "fail", isSender: true, failed: true, gasUsed: 90_000n, gasPrice: 30_000_000_000n, baseFee: 25_000_000_000n }),
  ];
  const leaks = computeLeaks(deltas, pricer, true);
  assert.equal(leaks.failedTxCount, 1);
  const expectedFailedFeeWei = 90_000n * 30_000_000_000n;
  assert.equal(leaks.failedTxFeeWei, expectedFailedFeeWei);
  // Failed tx fees are still part of the total.
  assert.equal(leaks.totalFeeWei, 100_000n * 20_000_000_000n + expectedFailedFeeWei);
});

test("without a native price series, USD figures come back null instead of a guess", () => {
  const noSeriesChain: ChainConfig = { ...chain, nativeUsdSeries: null };
  const pricer = new Pricer(noSeriesChain, null);
  const deltas: TxDelta[] = [
    makeDelta({ hash: "a", isSender: true, failed: false, gasUsed: 100_000n, gasPrice: 20_000_000_000n, baseFee: 15_000_000_000n }),
  ];
  const leaks = computeLeaks(deltas, pricer, true);
  assert.equal(leaks.totalFeeUsd, null);
  assert.equal(leaks.priorityFeeUsd, null);
  assert.ok(leaks.totalFeeWei > 0n);
});

test("sandwich detection is an explicit stub, not a heuristic", () => {
  const pricer = new Pricer(chain, { "2026-01-01": 2000 });
  const leaks = computeLeaks([], pricer, true);
  assert.equal(leaks.sandwichDetection, "not_implemented");
});
