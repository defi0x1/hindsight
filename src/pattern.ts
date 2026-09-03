import { spawn } from "node:child_process";
import type { AgentConfig } from "./config.js";
import type { BehaviorMetrics, LeakSummary } from "./types.js";

/**
 * The pattern paragraph is the only prose hindsight ever produces. Every
 * number quoted in it was computed by behavior.ts; this module only picks
 * which deterministic template fits the numbers, and formats them. An
 * optional `agent` block in config can hand these same metrics to a CLI
 * for a better-written paragraph -- strictly an upgrade, never required.
 * With no agent configured, or if the agent call fails or times out, the
 * deterministic template is the output. There is no other path.
 */
export async function buildPattern(
  behavior: BehaviorMetrics,
  leaks: LeakSummary,
  positionCount: number,
  totalLossUsd: number,
  agent?: AgentConfig
): Promise<string> {
  const deterministic = deterministicPattern(behavior, leaks, positionCount, totalLossUsd);
  if (!agent) return deterministic;
  try {
    const upgraded = await runAgent(agent, { behavior, leaks: serializeLeaks(leaks), positionCount, deterministic });
    return upgraded?.trim() || deterministic;
  } catch {
    return deterministic;
  }
}

function serializeLeaks(leaks: LeakSummary) {
  return {
    ...leaks,
    totalFeeWei: leaks.totalFeeWei.toString(),
    priorityFeeWei: leaks.priorityFeeWei.toString(),
    failedTxFeeWei: leaks.failedTxFeeWei.toString(),
  };
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(0)}%`;
}

function usd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function deterministicPattern(
  behavior: BehaviorMetrics,
  leaks: LeakSummary,
  positionCount: number,
  totalLossUsd: number
): string {
  if (behavior.totalClosedTrades === 0) {
    return "not enough closed trades yet to name a pattern. Come back after a few round trips.";
  }

  const { medianWinGainPct, medianLossPct, roundTripTokens, winRate } = behavior;

  // Disposition effect: winners sold early, losers held.
  if (medianWinGainPct != null && medianLossPct != null && medianWinGainPct < Math.abs(medianLossPct)) {
    const feeUsd = leaks.totalFeeUsd ?? 0;
    const comparison = Math.abs(totalLossUsd) > feeUsd ? "more than every fee combined" : "less than total fees, but it still added up";
    return (
      `you sell winners at ${pct(medianWinGainPct)} median and hold losers to ${pct(medianLossPct)} median.\n` +
      `across ${positionCount} positions that gap cost you ${comparison}.`
    );
  }

  // Churner: the same tokens, bought and sold repeatedly.
  if (positionCount > 0 && roundTripTokens / positionCount >= 0.3 && roundTripTokens >= 3) {
    return (
      `you re-entered ${roundTripTokens} of your ${positionCount} positions more than once.\n` +
      `repeated round trips on the same tokens paid fees each time without changing the outcome.`
    );
  }

  // Low win rate.
  if (winRate != null && winRate < 0.4) {
    return (
      `you won ${(winRate * 100).toFixed(0)}% of closed trades across ${positionCount} positions.\n` +
      `losers outnumbered winners; sizing or entry timing is the likelier drag, not any single trade.`
    );
  }

  // Fallback: neutral summary.
  const winRatePct = winRate != null ? `${(winRate * 100).toFixed(0)}%` : "n/a";
  return (
    `win rate ${winRatePct} across ${positionCount} positions, ${behavior.wins} winners and ${behavior.losses} losers.\n` +
    `no single behavioral pattern dominates this history.`
  );
}

function runAgent(
  agent: AgentConfig,
  payload: unknown
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(agent.command, agent.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("agent timed out"));
    }, agent.timeoutMs ?? 10_000);
    child.stdout.on("data", (chunk) => (out += chunk.toString()));
    child.stderr.on("data", (chunk) => (err += chunk.toString()));
    child.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(out);
      else reject(new Error(`agent exited ${code}: ${err}`));
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}
