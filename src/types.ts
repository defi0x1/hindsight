// Shared types for the hindsight EVM pipeline.

export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const ERC20_APPROVAL_TOPIC =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

// type(uint256).max -- the conventional "unlimited approval" value.
export const UNLIMITED_APPROVAL = (1n << 256n) - 1n;
// Anything above this threshold is treated as "effectively unlimited" too,
// since some wallets/routers approve slightly-below-max sentinel values.
export const UNLIMITED_APPROVAL_THRESHOLD = (1n << 255n);

export interface QuoteAsset {
  address: string; // lowercase 0x-prefixed
  symbol: string;
  decimals: number;
}

export interface ChainConfig {
  id: number;
  name: string;
  displayName: string;
  rpcUrl: string;
  nativeSymbol: string;
  nativeUsdSeries: string | null; // filename under data/, or null if unpriced
  explorerTxUrl: string; // "{hash}" placeholder
  quoteAssets: QuoteAsset[];
}

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string; // hex
  transactionHash: string;
  logIndex: string; // hex
  removed?: boolean;
}

export interface TransactionReceipt {
  transactionHash: string;
  blockNumber: string; // hex
  from: string;
  to: string | null;
  status: string; // hex "0x1" success, "0x0" reverted
  gasUsed: string; // hex
  effectiveGasPrice: string; // hex, wei
}

export interface BlockHeader {
  number: string; // hex
  timestamp: string; // hex, unix seconds
  baseFeePerGas?: string; // hex, wei, EIP-1559 chains
}

export interface RawTx {
  hash: string;
  from: string;
  to: string | null;
  value: string; // hex, wei
  blockNumber: string; // hex
}

// One transaction, reduced to what the wallet's balances did. Native value
// uses the pseudo-address NATIVE for uniform bookkeeping alongside ERC-20s.
export const NATIVE_PSEUDO_ADDRESS = "native";

export interface TxDelta {
  hash: string;
  blockNumber: number;
  timestamp: number; // seconds, unix epoch
  failed: boolean; // receipt.status === 0 (reverted, gas still paid)
  isSender: boolean;
  gasUsedWei: bigint;
  effectiveGasPriceWei: bigint;
  baseFeePerGasWei: bigint | null;
  // Net movement per token address (lowercase, or NATIVE_PSEUDO_ADDRESS) in
  // UI (decimal) units. Positive = received, negative = sent. Gas is not
  // folded into the native delta -- it is accounted separately in leaks so
  // a pure "sell token for ETH" trade isn't off by the gas cost.
  deltas: Record<string, number>;
  decimals: Record<string, number>;
}

export type TradeKind =
  | "buy"
  | "sell"
  | "unpriced"
  | "transfer_in"
  | "transfer_out"
  | "quote_swap"
  | "noop";

export interface Lot {
  qty: number;
  costBasisUsdPerUnit: number;
  timestamp: number;
  hash: string;
}

export interface RealizedTrade {
  token: string;
  hash: string;
  qty: number;
  proceedsUsd: number;
  costUsd: number;
  pnlUsd: number;
  gainPct: number;
  buyTimestamp: number;
  sellTimestamp: number;
  holdSeconds: number;
}

export interface PositionSummary {
  token: string;
  symbol: string;
  totalBoughtQty: number;
  totalSoldQty: number;
  totalBuyCostUsd: number;
  totalSellProceedsUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  currentQty: number;
  currentCostBasisUsd: number;
  markPriceUsd: number | null;
  maxObservedPriceUsd: number | null;
  lastPriceTimestamp: number | null;
  firstBuyTimestamp: number | null;
  lastActivityTimestamp: number | null;
  closeEvents: number;
  realizedTrades: RealizedTrade[];
}

export interface PositionsResult {
  positions: PositionSummary[];
  unpricedCount: number;
  unpricedTxHashes: string[];
  capitalDeployedUsd: number;
  capitalFlows: Array<{ timestamp: number; usdAmount: number }>;
  totalBuyCostUsd: number;
  firstInflowTimestamp: number | null;
  lastActivityTimestamp: number | null;
}

export interface BenchmarkRow {
  key: "actual" | "hodl_native" | "never_sold" | "perfect_exits";
  label: string;
  pctChange: number;
  startUsd: number;
  endUsd: number;
  isCeiling: boolean;
}

export interface LeakSummary {
  totalFeeWei: bigint;
  totalFeeUsd: number | null;
  priorityFeeWei: bigint;
  priorityFeeUsd: number | null;
  txCount: number;
  failedTxCount: number;
  failedTxFeeWei: bigint;
  failedTxFeeUsd: number | null;
  feeSweepComplete: boolean;
  sandwichDetection: "not_implemented";
}

export interface BehaviorMetrics {
  medianWinGainPct: number | null;
  medianLossPct: number | null;
  medianHoldSecondsWinners: number | null;
  medianHoldSecondsLosers: number | null;
  winRate: number | null;
  totalClosedTrades: number;
  wins: number;
  losses: number;
  largestWinUsd: number | null;
  largestLossUsd: number | null;
  roundTripTokens: number;
  hourOfDayUtc: Array<{ hour: number; pnlUsd: number; trades: number }>;
}

export interface ReportResult {
  address: string;
  chain: ChainConfig;
  since: string | null;
  until: string;
  positions: PositionsResult;
  benchmarks: BenchmarkRow[];
  leaks: LeakSummary;
  behavior: BehaviorMetrics;
  moneyLeftOnTableUsd: number | null;
  pattern: string;
  positionCount: number;
  unpricedCount: number;
}

export interface OpenApproval {
  token: string;
  tokenSymbol: string;
  spender: string;
  amount: bigint;
  unlimited: boolean;
  firstSeenTimestamp: number;
  lastUpdatedTimestamp: number;
  txHash: string;
}
