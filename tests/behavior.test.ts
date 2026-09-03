import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBehavior } from "../src/behavior.js";
import type { PositionSummary, PositionsResult, RealizedTrade } from "../src/types.js";

function makeTrade(overrides: Partial<RealizedTrade>): RealizedTrade {
  return {
    token: "0xtoken",
    hash: "0xhash",
    qty: 1,
    proceedsUsd: 0,
    costUsd: 0,
    pnlUsd: 0,
    gainPct: 0,
    buyTimestamp: 0,
    sellTimestamp: 0,
    holdSeconds: 0,
    ...overrides,
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

function makePositions(positions: PositionSummary[]): PositionsResult {
  return {
    positions,
    unpricedCount: 0,
    unpricedTxHashes: [],
    capitalDeployedUsd: 0,
    capitalFlows: [],
    totalBuyCostUsd: 0,
    firstInflowTimestamp: null,
    lastActivityTimestamp: null,
  };
}

test("median gain/loss and win rate are computed from realized trades", () => {
  const trades = [
    makeTrade({ pnlUsd: 10, gainPct: 10, holdSeconds: 86400 }),
    makeTrade({ pnlUsd: 20, gainPct: 30, holdSeconds: 172800 }),
    makeTrade({ pnlUsd: -5, gainPct: -50, holdSeconds: 864000 }),
    makeTrade({ pnlUsd: -15, gainPct: -70, holdSeconds: 1728000 }),
  ];
  const positions = makePositions([makePosition({ realizedTrades: trades })]);
  const behavior = computeBehavior(positions);

  assert.equal(behavior.totalClosedTrades, 4);
  assert.equal(behavior.wins, 2);
  assert.equal(behavior.losses, 2);
  assert.equal(behavior.winRate, 0.5);
  assert.equal(behavior.medianWinGainPct, 20); // median of [10, 30]
  assert.equal(behavior.medianLossPct, -60); // median of [-50, -70]
  assert.equal(behavior.largestWinUsd, 20);
  assert.equal(behavior.largestLossUsd, -15);
});

test("a token closed twice counts as one round-trip token", () => {
  const positions = makePositions([
    makePosition({ token: "0xa", closeEvents: 2 }),
    makePosition({ token: "0xb", closeEvents: 1 }),
    makePosition({ token: "0xc", closeEvents: 0 }),
  ]);
  const behavior = computeBehavior(positions);
  assert.equal(behavior.roundTripTokens, 1);
});

test("hour-of-day buckets sum pnl by UTC hour of the sell", () => {
  const noonUtc = Date.UTC(2026, 0, 1, 12, 0, 0) / 1000;
  const trades = [makeTrade({ pnlUsd: 5, sellTimestamp: noonUtc }), makeTrade({ pnlUsd: 7, sellTimestamp: noonUtc })];
  const positions = makePositions([makePosition({ realizedTrades: trades })]);
  const behavior = computeBehavior(positions);
  const bucket = behavior.hourOfDayUtc.find((h) => h.hour === 12)!;
  assert.equal(bucket.trades, 2);
  assert.equal(bucket.pnlUsd, 12);
});

test("no closed trades yields nulls, not NaN or a crash", () => {
  const behavior = computeBehavior(makePositions([]));
  assert.equal(behavior.medianWinGainPct, null);
  assert.equal(behavior.medianLossPct, null);
  assert.equal(behavior.winRate, null);
  assert.equal(behavior.totalClosedTrades, 0);
});
