import { NATIVE_PSEUDO_ADDRESS } from "./types.js";
import type { Lot, PositionSummary, PositionsResult, RealizedTrade, TxDelta } from "./types.js";
import type { ChainConfig } from "./types.js";
import { isQuoteToken } from "./pricing.js";
import type { Pricer } from "./pricing.js";
import type { RpcClient } from "./rpc.js";
import { getErc20Meta } from "./erc20.js";

const EPSILON = 1e-9;

interface MutablePosition {
  token: string;
  symbol: string;
  lots: Lot[];
  totalBoughtQty: number;
  totalSoldQty: number;
  totalBuyCostUsd: number;
  totalSellProceedsUsd: number;
  realizedPnlUsd: number;
  maxObservedPriceUsd: number | null;
  lastPriceTimestamp: number | null;
  markPriceUsd: number | null;
  firstBuyTimestamp: number | null;
  lastActivityTimestamp: number | null;
  closeEvents: number;
  wasOpen: boolean;
  realizedTrades: RealizedTrade[];
}

function newPosition(token: string, symbol: string): MutablePosition {
  return {
    token,
    symbol,
    lots: [],
    totalBoughtQty: 0,
    totalSoldQty: 0,
    totalBuyCostUsd: 0,
    totalSellProceedsUsd: 0,
    realizedPnlUsd: 0,
    maxObservedPriceUsd: null,
    lastPriceTimestamp: null,
    markPriceUsd: null,
    firstBuyTimestamp: null,
    lastActivityTimestamp: null,
    closeEvents: 0,
    wasOpen: false,
    realizedTrades: [],
  };
}

function recordPricePoint(pos: MutablePosition, priceUsd: number, timestamp: number): void {
  pos.maxObservedPriceUsd = pos.maxObservedPriceUsd == null ? priceUsd : Math.max(pos.maxObservedPriceUsd, priceUsd);
  if (pos.lastPriceTimestamp == null || timestamp >= pos.lastPriceTimestamp) {
    pos.lastPriceTimestamp = timestamp;
    pos.markPriceUsd = priceUsd;
  }
}

function addLot(pos: MutablePosition, qty: number, costBasisUsdPerUnit: number, timestamp: number, hash: string): void {
  const wasZero = currentQty(pos) <= EPSILON;
  pos.lots.push({ qty, costBasisUsdPerUnit, timestamp, hash });
  pos.totalBoughtQty += qty;
  pos.totalBuyCostUsd += qty * costBasisUsdPerUnit;
  if (pos.firstBuyTimestamp == null) pos.firstBuyTimestamp = timestamp;
  pos.lastActivityTimestamp = timestamp;
  if (wasZero) pos.wasOpen = true;
}

function currentQty(pos: MutablePosition): number {
  return pos.lots.reduce((s, l) => s + l.qty, 0);
}

/**
 * Consumes up to `qty` from FIFO lots. Returns the qty actually consumed
 * (may be less than requested if the wallet is selling more than hindsight
 * has a recorded basis for -- e.g. tokens acquired before the scan window)
 * plus the weighted cost basis and buy timestamp of what was consumed.
 */
function consumeFifo(pos: MutablePosition, qty: number): { consumedQty: number; costUsd: number; weightedBuyTs: number } {
  let remaining = qty;
  let costUsd = 0;
  let weightedTsSum = 0;
  while (remaining > EPSILON && pos.lots.length > 0) {
    const lot = pos.lots[0]!;
    const take = Math.min(lot.qty, remaining);
    costUsd += take * lot.costBasisUsdPerUnit;
    weightedTsSum += take * lot.timestamp;
    lot.qty -= take;
    remaining -= take;
    if (lot.qty <= EPSILON) pos.lots.shift();
  }
  const consumedQty = qty - remaining;
  const weightedBuyTs = consumedQty > EPSILON ? weightedTsSum / consumedQty : 0;
  return { consumedQty, costUsd, weightedBuyTs };
}

export interface BuildPositionsOptions {
  chain: ChainConfig;
  pricer: Pricer;
  rpc: RpcClient;
}

export async function buildPositions(deltas: TxDelta[], opts: BuildPositionsOptions): Promise<PositionsResult> {
  const { chain, pricer } = opts;
  const positions = new Map<string, MutablePosition>();
  const capitalFlows: Array<{ timestamp: number; usdAmount: number }> = [];
  let unpricedCount = 0;
  const unpricedTxHashes: string[] = [];
  let lastActivityTimestamp: number | null = null;

  const symbolCache = new Map<string, string>();
  async function symbolOf(token: string): Promise<string> {
    if (token === NATIVE_PSEUDO_ADDRESS) return chain.nativeSymbol;
    const quote = chain.quoteAssets.find((q) => q.address === token);
    if (quote) return quote.symbol;
    if (symbolCache.has(token)) return symbolCache.get(token)!;
    const meta = await getErc20Meta(opts.rpc, token);
    const symbol = meta?.symbol ?? token.slice(0, 8);
    symbolCache.set(token, symbol);
    return symbol;
  }

  function getPosition(token: string, symbol: string): MutablePosition {
    let pos = positions.get(token);
    if (!pos) {
      pos = newPosition(token, symbol);
      positions.set(token, pos);
    }
    return pos;
  }

  for (const delta of deltas) {
    if (delta.failed) continue;
    lastActivityTimestamp = delta.timestamp;

    const entries = Object.entries(delta.deltas).filter(([, v]) => Math.abs(v) > EPSILON);
    const outflows = entries.filter(([, v]) => v < 0);
    const inflows = entries.filter(([, v]) => v > 0);

    // Pure deposit: capital entering the wallet.
    if (outflows.length === 0 && inflows.length === 1) {
      const [token, amount] = inflows[0]!;
      if (isQuoteToken(chain, token)) {
        const price = pricer.quotePriceUsd(token, delta.timestamp);
        if (price != null) capitalFlows.push({ timestamp: delta.timestamp, usdAmount: amount * price });
      } else {
        // Airdrop / transfer of a non-quote token: recorded as a deposit
        // at zero cost basis, since hindsight has no independent price
        // source for an arbitrary token at receipt time. See
        // docs/how-pnl-is-computed.md.
        const symbol = await symbolOf(token);
        const pos = getPosition(token, symbol);
        addLot(pos, amount, 0, delta.timestamp, delta.hash);
      }
      continue;
    }

    // Pure withdrawal: capital or a token leaving with nothing back.
    if (outflows.length === 1 && inflows.length === 0) {
      const [token, amount] = outflows[0]!;
      const qty = -amount;
      if (isQuoteToken(chain, token)) {
        const price = pricer.quotePriceUsd(token, delta.timestamp);
        if (price != null) capitalFlows.push({ timestamp: delta.timestamp, usdAmount: -qty * price });
      } else {
        const symbol = await symbolOf(token);
        const pos = getPosition(token, symbol);
        const { consumedQty, costUsd, weightedBuyTs } = consumeFifo(pos, qty);
        if (consumedQty > EPSILON) {
          pos.realizedPnlUsd += -costUsd; // sent away for nothing: full loss of basis
          pos.realizedTrades.push({
            token,
            hash: delta.hash,
            qty: consumedQty,
            proceedsUsd: 0,
            costUsd,
            pnlUsd: -costUsd,
            gainPct: costUsd > 0 ? -100 : 0,
            buyTimestamp: weightedBuyTs,
            sellTimestamp: delta.timestamp,
            holdSeconds: Math.max(0, delta.timestamp - weightedBuyTs),
          });
          pos.lastActivityTimestamp = delta.timestamp;
          if (currentQty(pos) <= EPSILON && pos.wasOpen) {
            pos.closeEvents += 1;
            pos.wasOpen = false;
          }
        }
      }
      continue;
    }

    // The core case: exactly one asset out, one asset in -- a swap.
    if (outflows.length === 1 && inflows.length === 1) {
      const [outToken, outAmountSigned] = outflows[0]!;
      const [inToken, inAmount] = inflows[0]!;
      const outAmount = -outAmountSigned;
      const outIsQuote = isQuoteToken(chain, outToken);
      const inIsQuote = isQuoteToken(chain, inToken);

      if (outIsQuote && inIsQuote) {
        continue; // currency conversion between quote assets; out of scope for position PnL
      }

      if (outIsQuote && !inIsQuote) {
        // BUY: spent a quote asset, received a token.
        const price = pricer.quotePriceUsd(outToken, delta.timestamp);
        if (price == null) {
          unpricedCount += 1;
          unpricedTxHashes.push(delta.hash);
          continue;
        }
        const quoteUsd = outAmount * price;
        const perUnit = inAmount > 0 ? quoteUsd / inAmount : 0;
        const symbol = await symbolOf(inToken);
        const pos = getPosition(inToken, symbol);
        addLot(pos, inAmount, perUnit, delta.timestamp, delta.hash);
        recordPricePoint(pos, perUnit, delta.timestamp);
        continue;
      }

      if (!outIsQuote && inIsQuote) {
        // SELL: sent a token, received a quote asset.
        const price = pricer.quotePriceUsd(inToken, delta.timestamp);
        if (price == null) {
          unpricedCount += 1;
          unpricedTxHashes.push(delta.hash);
          continue;
        }
        const proceedsUsd = inAmount * price;
        const symbol = await symbolOf(outToken);
        const pos = getPosition(outToken, symbol);
        const { consumedQty, costUsd, weightedBuyTs } = consumeFifo(pos, outAmount);
        if (consumedQty <= EPSILON) {
          unpricedCount += 1;
          unpricedTxHashes.push(delta.hash);
          continue;
        }
        // If the wallet sold more than hindsight has a basis for (tokens
        // acquired before the scan window), price only the covered
        // portion and report the rest honestly rather than guessing.
        const coveredProceeds = proceedsUsd * (consumedQty / outAmount);
        const pnl = coveredProceeds - costUsd;
        pos.totalSoldQty += consumedQty;
        pos.totalSellProceedsUsd += coveredProceeds;
        pos.realizedPnlUsd += pnl;
        pos.lastActivityTimestamp = delta.timestamp;
        const perUnitSell = inAmount > 0 ? proceedsUsd / outAmount : 0;
        recordPricePoint(pos, perUnitSell, delta.timestamp);
        pos.realizedTrades.push({
          token: outToken,
          hash: delta.hash,
          qty: consumedQty,
          proceedsUsd: coveredProceeds,
          costUsd,
          pnlUsd: pnl,
          gainPct: costUsd > 0 ? (pnl / costUsd) * 100 : 0,
          buyTimestamp: weightedBuyTs,
          sellTimestamp: delta.timestamp,
          holdSeconds: Math.max(0, delta.timestamp - weightedBuyTs),
        });
        if (currentQty(pos) <= EPSILON && pos.wasOpen) {
          pos.closeEvents += 1;
          pos.wasOpen = false;
        }
        if (consumedQty < outAmount - EPSILON) {
          unpricedCount += 1;
          unpricedTxHashes.push(delta.hash);
        }
        continue;
      }

      // Neither leg is a quote asset: no basis to price this trade from
      // either side. Excluded from totals, counted honestly.
      unpricedCount += 1;
      unpricedTxHashes.push(delta.hash);
      continue;
    }

    // More than one asset moved on one or both sides: a complex/multi-hop
    // transaction. hindsight does not guess at how to attribute it.
    if (outflows.length > 0 || inflows.length > 0) {
      unpricedCount += 1;
      unpricedTxHashes.push(delta.hash);
    }
  }

  const summaries: PositionSummary[] = [];
  for (const pos of positions.values()) {
    const currentQtyVal = currentQty(pos);
    const currentCostBasisUsd = pos.lots.reduce((s, l) => s + l.qty * l.costBasisUsdPerUnit, 0);
    const unrealizedPnlUsd =
      pos.markPriceUsd != null ? currentQtyVal * pos.markPriceUsd - currentCostBasisUsd : 0;
    summaries.push({
      token: pos.token,
      symbol: pos.symbol,
      totalBoughtQty: pos.totalBoughtQty,
      totalSoldQty: pos.totalSoldQty,
      totalBuyCostUsd: pos.totalBuyCostUsd,
      totalSellProceedsUsd: pos.totalSellProceedsUsd,
      realizedPnlUsd: pos.realizedPnlUsd,
      unrealizedPnlUsd,
      currentQty: currentQtyVal,
      currentCostBasisUsd,
      markPriceUsd: pos.markPriceUsd,
      maxObservedPriceUsd: pos.maxObservedPriceUsd,
      lastPriceTimestamp: pos.lastPriceTimestamp,
      firstBuyTimestamp: pos.firstBuyTimestamp,
      lastActivityTimestamp: pos.lastActivityTimestamp,
      closeEvents: pos.closeEvents,
      realizedTrades: pos.realizedTrades,
    });
  }
  summaries.sort((a, b) => (b.lastActivityTimestamp ?? 0) - (a.lastActivityTimestamp ?? 0));

  const capitalDeployedUsd = capitalFlows.reduce((s, f) => s + f.usdAmount, 0);
  const totalBuyCostUsd = summaries.reduce((s, p) => s + p.totalBuyCostUsd, 0);
  const firstInflowTimestamp = capitalFlows.length > 0 ? Math.min(...capitalFlows.map((f) => f.timestamp)) : null;

  return {
    positions: summaries,
    unpricedCount,
    unpricedTxHashes,
    capitalDeployedUsd,
    capitalFlows,
    totalBuyCostUsd,
    firstInflowTimestamp,
    lastActivityTimestamp,
  };
}
