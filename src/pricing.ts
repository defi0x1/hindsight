import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_PSEUDO_ADDRESS } from "./types.js";
import type { ChainConfig } from "./types.js";
import { dataDir, isQuoteAsset } from "./chains.js";

export type UsdSeries = Record<string, number>; // "YYYY-MM-DD" -> USD

export function loadUsdSeries(fileName: string): UsdSeries {
  const raw = readFileSync(join(dataDir(), fileName), "utf8");
  return JSON.parse(raw) as UsdSeries;
}

function dayKey(timestampSec: number): string {
  return new Date(timestampSec * 1000).toISOString().slice(0, 10);
}

/**
 * Pricing engine. Native/USD comes from the chain's bundled daily series
 * (linear interpolation across any missing days). USDC, USDT, and DAI are
 * treated as fixed at 1 USD -- v1 does not model depegs. WETH (or the
 * chain's wrapped-native quote asset) is priced off the same native series.
 * Every other token has no independent USD price; it is only ever priced
 * through a trade against one of these quote assets.
 */
export class Pricer {
  private readonly series: UsdSeries | null;
  private readonly sortedDays: string[];
  readonly chain: ChainConfig;

  constructor(chain: ChainConfig, series: UsdSeries | null) {
    this.chain = chain;
    this.series = series;
    this.sortedDays = series ? Object.keys(series).sort() : [];
  }

  get hasNativeSeries(): boolean {
    return this.series != null;
  }

  nativeUsdAt(timestampSec: number): number | null {
    if (!this.series) return null;
    const key = dayKey(timestampSec);
    const exact = this.series[key];
    if (exact != null) return exact;
    if (this.sortedDays.length === 0) return null;

    let lower: string | undefined;
    let upper: string | undefined;
    for (const d of this.sortedDays) {
      if (d <= key) lower = d;
      if (d >= key && upper === undefined) upper = d;
    }
    if (lower && upper) {
      if (lower === upper) return this.series[lower]!;
      const lowerT = Date.parse(`${lower}T00:00:00Z`);
      const upperT = Date.parse(`${upper}T00:00:00Z`);
      const t = Date.parse(`${key}T00:00:00Z`);
      const frac = (t - lowerT) / (upperT - lowerT);
      return this.series[lower]! + (this.series[upper]! - this.series[lower]!) * frac;
    }
    const fallback = lower ?? upper;
    return this.series[fallback!]!;
  }

  /** USD price of one unit of a quote asset (native, wrapped-native, or a stable) at a given time. */
  quotePriceUsd(tokenAddress: string, timestampSec: number): number | null {
    if (tokenAddress === NATIVE_PSEUDO_ADDRESS) return this.nativeUsdAt(timestampSec);
    const quote = isQuoteAsset(this.chain, tokenAddress);
    if (!quote) throw new Error(`${tokenAddress} is not a quote asset on ${this.chain.name}`);
    if (quote.symbol === "WETH" || quote.symbol.startsWith("W") && quote.symbol.slice(1) === this.chain.nativeSymbol) {
      return this.nativeUsdAt(timestampSec);
    }
    // Stablecoins: fixed at 1 USD. v1 does not model depegs.
    return 1;
  }
}

export function isQuoteToken(chain: ChainConfig, tokenAddress: string): boolean {
  if (tokenAddress === NATIVE_PSEUDO_ADDRESS) return true;
  return isQuoteAsset(chain, tokenAddress) != null;
}
