import { test } from "node:test";
import assert from "node:assert/strict";
import { Pricer } from "../src/pricing.js";
import type { ChainConfig } from "../src/types.js";
import { NATIVE_PSEUDO_ADDRESS } from "../src/types.js";

const chain: ChainConfig = {
  id: 1,
  name: "ethereum",
  displayName: "Ethereum",
  rpcUrl: "https://example.invalid",
  nativeSymbol: "ETH",
  nativeUsdSeries: "eth-usd.json",
  explorerTxUrl: "https://etherscan.io/tx/{hash}",
  quoteAssets: [
    { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
    { address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", symbol: "WETH", decimals: 18 },
  ],
};

function ts(dateStr: string): number {
  return Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 1000);
}

test("exact-day lookups return the series value directly", () => {
  const pricer = new Pricer(chain, { "2026-01-01": 3000, "2026-01-03": 3200 });
  assert.equal(pricer.nativeUsdAt(ts("2026-01-01")), 3000);
});

test("missing days interpolate linearly between the nearest available days", () => {
  const pricer = new Pricer(chain, { "2026-01-01": 3000, "2026-01-03": 3200 });
  // 2026-01-02 is exactly halfway between the two known days.
  assert.equal(pricer.nativeUsdAt(ts("2026-01-02")), 3100);
});

test("timestamps off the edge of the series fall back to the nearest known day", () => {
  const pricer = new Pricer(chain, { "2026-01-05": 3000, "2026-01-10": 3500 });
  assert.equal(pricer.nativeUsdAt(ts("2026-01-01")), 3000);
  assert.equal(pricer.nativeUsdAt(ts("2026-02-01")), 3500);
});

test("stablecoins are fixed at 1 USD", () => {
  const pricer = new Pricer(chain, { "2026-01-01": 3000 });
  assert.equal(pricer.quotePriceUsd("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", ts("2026-01-01")), 1);
});

test("WETH prices off the native series", () => {
  const pricer = new Pricer(chain, { "2026-01-01": 3000 });
  assert.equal(pricer.quotePriceUsd("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", ts("2026-01-01")), 3000);
});

test("native pseudo-address prices off the native series", () => {
  const pricer = new Pricer(chain, { "2026-01-01": 3000 });
  assert.equal(pricer.quotePriceUsd(NATIVE_PSEUDO_ADDRESS, ts("2026-01-01")), 3000);
});

test("a chain with no bundled series returns null instead of guessing", () => {
  const polygon: ChainConfig = { ...chain, nativeUsdSeries: null };
  const pricer = new Pricer(polygon, null);
  assert.equal(pricer.hasNativeSeries, false);
  assert.equal(pricer.nativeUsdAt(ts("2026-01-01")), null);
});

test("a non-quote token throws rather than silently returning a price", () => {
  const pricer = new Pricer(chain, { "2026-01-01": 3000 });
  assert.throws(() => pricer.quotePriceUsd("0x1234567890123456789012345678901234567890", ts("2026-01-01")));
});
