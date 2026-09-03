import type { BenchmarkRow, LeakSummary, PositionsResult } from "./types.js";
import type { Pricer } from "./pricing.js";

/**
 * The four counterfactuals. Every input here is a number already computed
 * by positions.ts or leaks.ts from on-chain data -- no model, no guess.
 * See docs/benchmarks.md for the construction of each row and why
 * "perfect exits" is flagged as a ceiling rather than a target.
 */
export function computeBenchmarks(
  positions: PositionsResult,
  leaks: LeakSummary,
  pricer: Pricer,
  untilTimestamp: number
): BenchmarkRow[] {
  const startUsd = positions.capitalDeployedUsd;
  const totalFeesUsd = leaks.totalFeeUsd ?? 0;
  const pct = (endUsd: number) => (startUsd > 0 ? ((endUsd - startUsd) / startUsd) * 100 : 0);

  // 1. actual: what really happened.
  const realizedPnlUsd = positions.positions.reduce((s, p) => s + p.realizedPnlUsd, 0);
  const unrealizedPnlUsd = positions.positions.reduce((s, p) => s + p.unrealizedPnlUsd, 0);
  const actualEndUsd = startUsd + realizedPnlUsd + unrealizedPnlUsd - totalFeesUsd;

  // 2. hodl native: the same capital, converted to the chain's native
  // asset at the moment each deposit landed, held untouched to the end.
  let hodlEndUsd = 0;
  if (pricer.hasNativeSeries) {
    for (const flow of positions.capitalFlows) {
      const priceAtDeposit = pricer.nativeUsdAt(flow.timestamp);
      const priceAtEnd = pricer.nativeUsdAt(untilTimestamp);
      if (priceAtDeposit && priceAtEnd && priceAtDeposit > 0) {
        hodlEndUsd += (flow.usdAmount / priceAtDeposit) * priceAtEnd;
      } else {
        hodlEndUsd += flow.usdAmount;
      }
    }
  } else {
    hodlEndUsd = startUsd;
  }

  // Capital deployed into buys but not (yet) reflected as a token
  // position's current mark -- deposits that never got spent.
  const leftoverCashUsd = Math.max(0, startUsd - positions.totalBuyCostUsd);

  // 3. never sold: every buy held to the report's end date, every sell
  // reversed. Value uses the same mark price as unrealized PnL: the
  // wallet's own last observed execution price for that token.
  const neverSoldEndUsd =
    leftoverCashUsd + positions.positions.reduce((s, p) => s + p.totalBoughtQty * (p.markPriceUsd ?? 0), 0);

  // 4. perfect exits: every unit ever bought, sold at the highest price
  // this wallet's own trade history ever observed for that token. This is
  // a ceiling bounded by what the wallet actually saw on-chain, not a true
  // all-time high, and it is not a target -- see docs/benchmarks.md.
  const perfectExitsEndUsd =
    leftoverCashUsd +
    positions.positions.reduce((s, p) => s + p.totalBoughtQty * (p.maxObservedPriceUsd ?? p.markPriceUsd ?? 0), 0);

  return [
    {
      key: "actual",
      label: "you",
      pctChange: pct(actualEndUsd),
      startUsd,
      endUsd: actualEndUsd,
      isCeiling: false,
    },
    {
      key: "hodl_native",
      label: `if you had held ${pricer.chain.nativeSymbol}`,
      pctChange: pct(hodlEndUsd),
      startUsd,
      endUsd: hodlEndUsd,
      isCeiling: false,
    },
    {
      key: "never_sold",
      label: "if you never sold",
      pctChange: pct(neverSoldEndUsd),
      startUsd,
      endUsd: neverSoldEndUsd,
      isCeiling: false,
    },
    {
      key: "perfect_exits",
      label: "perfect exits",
      pctChange: pct(perfectExitsEndUsd),
      startUsd,
      endUsd: perfectExitsEndUsd,
      isCeiling: true,
    },
  ];
}

/** Money left on the table: the best realistic (non-ceiling) alternative, minus what actually happened. */
export function moneyLeftOnTable(benchmarks: BenchmarkRow[]): number | null {
  const actual = benchmarks.find((b) => b.key === "actual");
  const realistic = benchmarks.filter((b) => !b.isCeiling && b.key !== "actual");
  if (!actual || realistic.length === 0) return null;
  const best = realistic.reduce((a, b) => (b.endUsd > a.endUsd ? b : a));
  return best.endUsd - actual.endUsd;
}
