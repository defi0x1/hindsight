import type { BehaviorMetrics, PositionsResult, RealizedTrade } from "./types.js";

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Behavioral metrics, computed deterministically from realized trades.
 * pattern.ts turns these numbers into one sentence; nothing here is
 * inferred or generated.
 */
export function computeBehavior(positions: PositionsResult): BehaviorMetrics {
  const allTrades: RealizedTrade[] = positions.positions.flatMap((p) => p.realizedTrades);
  const wins = allTrades.filter((t) => t.pnlUsd > 0);
  const losses = allTrades.filter((t) => t.pnlUsd < 0);

  const hourBuckets = Array.from({ length: 24 }, (_, hour) => ({ hour, pnlUsd: 0, trades: 0 }));
  for (const t of allTrades) {
    const hour = new Date(t.sellTimestamp * 1000).getUTCHours();
    hourBuckets[hour]!.pnlUsd += t.pnlUsd;
    hourBuckets[hour]!.trades += 1;
  }

  const roundTripTokens = positions.positions.filter((p) => p.closeEvents >= 2).length;

  return {
    medianWinGainPct: median(wins.map((t) => t.gainPct)),
    medianLossPct: median(losses.map((t) => t.gainPct)),
    medianHoldSecondsWinners: median(wins.map((t) => t.holdSeconds)),
    medianHoldSecondsLosers: median(losses.map((t) => t.holdSeconds)),
    winRate: allTrades.length > 0 ? wins.length / allTrades.length : null,
    totalClosedTrades: allTrades.length,
    wins: wins.length,
    losses: losses.length,
    largestWinUsd: wins.length > 0 ? Math.max(...wins.map((t) => t.pnlUsd)) : null,
    largestLossUsd: losses.length > 0 ? Math.min(...losses.map((t) => t.pnlUsd)) : null,
    roundTripTokens,
    hourOfDayUtc: hourBuckets,
  };
}
