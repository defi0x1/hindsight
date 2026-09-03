import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicPattern, buildPattern } from "../src/pattern.js";
import type { BehaviorMetrics, LeakSummary } from "../src/types.js";

function makeBehavior(overrides: Partial<BehaviorMetrics>): BehaviorMetrics {
  return {
    medianWinGainPct: null,
    medianLossPct: null,
    medianHoldSecondsWinners: null,
    medianHoldSecondsLosers: null,
    winRate: null,
    totalClosedTrades: 0,
    wins: 0,
    losses: 0,
    largestWinUsd: null,
    largestLossUsd: null,
    roundTripTokens: 0,
    hourOfDayUtc: [],
    ...overrides,
  };
}

const leaks: LeakSummary = {
  totalFeeWei: 0n,
  totalFeeUsd: 100,
  priorityFeeWei: 0n,
  priorityFeeUsd: null,
  txCount: 0,
  failedTxCount: 0,
  failedTxFeeWei: 0n,
  failedTxFeeUsd: null,
  feeSweepComplete: true,
  sandwichDetection: "not_implemented",
};

test("no closed trades produces an honest 'not enough data' message, not a fabricated pattern", () => {
  const text = deterministicPattern(makeBehavior({ totalClosedTrades: 0 }), leaks, 0, 0);
  assert.match(text, /not enough closed trades/);
});

test("winners sold small, losers held to big losses triggers the disposition-effect template", () => {
  const behavior = makeBehavior({
    totalClosedTrades: 10,
    medianWinGainPct: 15,
    medianLossPct: -70,
    winRate: 0.6,
    roundTripTokens: 0,
  });
  const text = deterministicPattern(behavior, leaks, 5, -1000);
  assert.match(text, /sell winners/);
  assert.match(text, /\+15%/);
  assert.match(text, /-70%/);
});

test("heavy round-tripping on a minority of tokens triggers the churn template when disposition doesn't fit", () => {
  const behavior = makeBehavior({
    totalClosedTrades: 10,
    medianWinGainPct: 20,
    medianLossPct: -10, // winners bigger than losers: disposition template should NOT fire
    winRate: 0.6,
    roundTripTokens: 4,
  });
  const text = deterministicPattern(behavior, leaks, 10, -100);
  assert.match(text, /re-entered/);
});

test("a low win rate with no other pattern triggers the win-rate template", () => {
  const behavior = makeBehavior({
    totalClosedTrades: 10,
    medianWinGainPct: 20,
    medianLossPct: -10,
    winRate: 0.3,
    roundTripTokens: 0,
  });
  const text = deterministicPattern(behavior, leaks, 10, -100);
  assert.match(text, /won 30%/);
});

test("buildPattern falls back to the deterministic template when no agent is configured", async () => {
  const behavior = makeBehavior({ totalClosedTrades: 0 });
  const text = await buildPattern(behavior, leaks, 0, 0, undefined);
  assert.match(text, /not enough closed trades/);
});

test("buildPattern falls back to the deterministic template when the agent command fails", async () => {
  const behavior = makeBehavior({ totalClosedTrades: 0 });
  const text = await buildPattern(behavior, leaks, 0, 0, { command: "this-command-does-not-exist-anywhere" });
  assert.match(text, /not enough closed trades/);
});
