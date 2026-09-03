import type { AgentConfig } from "./config.js";
import type { ChainConfig, ReportResult } from "./types.js";
import type { RpcClient } from "./rpc.js";
import { toHex, fromHex } from "./logs.js";
import { scanWalletDeltas } from "./deltas.js";
import { Pricer, loadUsdSeries } from "./pricing.js";
import { buildPositions } from "./positions.js";
import { computeBenchmarks, moneyLeftOnTable } from "./benchmarks.js";
import { computeLeaks } from "./leaks.js";
import { computeBehavior } from "./behavior.js";
import { buildPattern } from "./pattern.js";

export function loadPricerForChain(chain: ChainConfig): Pricer {
  const series = chain.nativeUsdSeries ? loadUsdSeries(chain.nativeUsdSeries) : null;
  return new Pricer(chain, series);
}

/** Binary search for the first block at or after a given unix timestamp. Every call is permanently cached. */
export async function blockForTimestamp(rpc: RpcClient, targetTs: number, latestBlock: number): Promise<number> {
  let lo = 0;
  let hi = latestBlock;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const block = await rpc.getBlockByNumber(toHex(mid));
    const ts = block ? fromHex(block.timestamp) : 0;
    if (ts < targetTs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface BuildReportOptions {
  rpc: RpcClient;
  chain: ChainConfig;
  address: string;
  fromBlock: number;
  toBlock: number;
  sinceLabel: string | null;
  untilLabel: string;
  untilTimestamp: number;
  agent?: AgentConfig;
}

export async function buildReport(opts: BuildReportOptions): Promise<ReportResult> {
  const pricer = loadPricerForChain(opts.chain);
  const scan = await scanWalletDeltas(opts.rpc, opts.address, opts.fromBlock, opts.toBlock);
  const positions = await buildPositions(scan.deltas, { chain: opts.chain, pricer, rpc: opts.rpc });
  const leaks = computeLeaks(scan.deltas, pricer, scan.feeSweepComplete);
  const benchmarks = computeBenchmarks(positions, leaks, pricer, opts.untilTimestamp);
  const behavior = computeBehavior(positions);
  const totalLossUsd = positions.positions
    .flatMap((p) => p.realizedTrades)
    .filter((t) => t.pnlUsd < 0)
    .reduce((s, t) => s + t.pnlUsd, 0);
  const pattern = await buildPattern(behavior, leaks, positions.positions.length, totalLossUsd, opts.agent);

  return {
    address: opts.address,
    chain: opts.chain,
    since: opts.sinceLabel,
    until: opts.untilLabel,
    positions,
    benchmarks,
    leaks,
    behavior,
    moneyLeftOnTableUsd: moneyLeftOnTable(benchmarks),
    pattern,
    positionCount: positions.positions.length,
    unpricedCount: positions.unpricedCount + scan.unresolvedTokens.size,
  };
}

// ---- rendering ------------------------------------------------------------

export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function pad(label: string, width: number): string {
  return label + " ".repeat(Math.max(0, width - label.length));
}

function padStart(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

export function formatReportText(r: ReportResult): string {
  const lines: string[] = [];
  const since = r.since ?? "genesis";
  lines.push(`HINDSIGHT · ${shortAddress(r.address)} · ${since} → ${r.until}`);
  lines.push("");

  const rows = r.benchmarks.map((b) => {
    const pctStr = padStart(fmtPct(b.pctChange), 9);
    if (b.key === "actual" || b.key === "hodl_native") {
      return `  ${pad(b.label, 22)} ${pctStr}    ${fmtUsd(b.startUsd)} → ${fmtUsd(b.endUsd)}`;
    }
    if (b.isCeiling) {
      return `  ${pad(b.label, 22)} ${pctStr}    (the ceiling, not a target)`;
    }
    return `  ${pad(b.label, 22)} ${pctStr}`;
  });
  lines.push(...rows);
  lines.push("");
  if (r.moneyLeftOnTableUsd != null) {
    lines.push(`  you left ${fmtUsd(r.moneyLeftOnTableUsd)} on the table.`);
    lines.push("");
  }

  lines.push("  LEAKS");
  const priorityUsd = r.leaks.priorityFeeUsd;
  const failedUsd = r.leaks.failedTxFeeUsd;
  lines.push(
    `    priority fees         ${priorityUsd != null ? padStart(fmtUsd(priorityUsd), 8) : padStart(`${(Number(r.leaks.priorityFeeWei) / 1e18).toFixed(4)} ${r.chain.nativeSymbol}`, 8)}   across ${r.leaks.txCount.toLocaleString()} txs`
  );
  lines.push(
    `    failed transactions   ${failedUsd != null ? padStart(fmtUsd(failedUsd), 8) : padStart(`${(Number(r.leaks.failedTxFeeWei) / 1e18).toFixed(4)} ${r.chain.nativeSymbol}`, 8)}   across ${r.leaks.failedTxCount.toLocaleString()} failures`
  );
  if (!r.leaks.feeSweepComplete) {
    lines.push(`    (fee sweep skipped: block range too wide -- fees/failures may be undercounted)`);
  }
  lines.push("");

  lines.push("  PATTERN");
  for (const line of r.pattern.split("\n")) {
    lines.push(`    ${line}`);
  }
  lines.push("");

  lines.push(`  ${r.positionCount} positions · ${r.unpricedCount} unpriced and excluded`);
  return lines.join("\n");
}
