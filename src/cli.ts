#!/usr/bin/env node
import { mkdirSync, existsSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { loadChains, resolveChain } from "./chains.js";
import { loadConfig, DEFAULT_RPC_WARNING } from "./config.js";
import { RpcClient } from "./rpc.js";
import { toHex } from "./logs.js";
import { buildReport, blockForTimestamp, formatReportText, shortAddress, loadPricerForChain } from "./report.js";
import { scanWalletDeltas } from "./deltas.js";
import { computeLeaks } from "./leaks.js";
import { buildPositions } from "./positions.js";
import { scanApprovals } from "./approvals.js";
import { renderCard } from "./card.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOOKBACK_DAYS = 90;
const DEMO_ADDRESS = "0x00000000000000000000000000000000dec0de01";

function fixturesDemoDir(): string {
  return join(__dirname, "..", "..", "fixtures", "demo");
}

interface DemoManifest {
  chainId: number;
  address: string;
  fromBlock: number;
  toBlock: number;
  sinceLabel: string;
  untilLabel: string;
  untilTimestamp: number;
}

function loadDemoManifest(): DemoManifest {
  const fixtureDir = fixturesDemoDir();
  const manifestPath = join(fixtureDir, "manifest.json");
  if (!existsSync(manifestPath)) fail("bundled demo fixture is missing");
  return JSON.parse(readFileSync(manifestPath, "utf8")) as DemoManifest;
}

function demoCacheDir(): string {
  const fixtureDir = fixturesDemoDir();
  const cacheDir = join(process.cwd(), ".hindsight", "cache", "demo");
  if (!existsSync(cacheDir)) {
    mkdirSync(join(process.cwd(), ".hindsight", "cache"), { recursive: true });
    cpSync(join(fixtureDir, "cache"), cacheDir, { recursive: true });
  }
  return cacheDir;
}

interface ResolvedRun {
  rpc: RpcClient;
  chain: ReturnType<typeof resolveChain>;
  address: string;
  fromBlock: number;
  toBlock: number;
  sinceLabel: string;
  untilLabel: string;
  untilTimestamp: number;
  isDemo: boolean;
}

/**
 * Shared setup for every address-taking command. The bundled demo wallet
 * address is special-cased to run entirely offline against the fixture --
 * this is what lets `hindsight leaks` and `hindsight positions` be
 * exercised against the same fixture `hindsight demo` uses, with zero
 * network access, for fast sanity-checking of a change or of this build.
 * Any other address goes through the normal live-RPC path.
 */
async function resolveRun(address: string, flags: Flags): Promise<ResolvedRun> {
  if (address === DEMO_ADDRESS) {
    const manifest = loadDemoManifest();
    const chain = resolveChain(manifest.chainId, loadChains());
    const rpc = new RpcClient({ rpcUrl: "offline://demo", cacheDir: demoCacheDir(), offline: true });
    console.error("hindsight: demo wallet address detected, running offline against the bundled fixture.");
    return {
      rpc,
      chain,
      address: manifest.address,
      fromBlock: manifest.fromBlock,
      toBlock: manifest.toBlock,
      sinceLabel: manifest.sinceLabel,
      untilLabel: manifest.untilLabel,
      untilTimestamp: manifest.untilTimestamp,
      isDemo: true,
    };
  }

  const chain = resolveChain(flags.chain ?? "ethereum", loadChains());
  const config = loadConfig(chain, { rpcUrl: flags.rpc });
  printRpcWarning(config.usingDefaultRpc);
  const rpc = new RpcClient({ rpcUrl: config.rpcUrl, cacheDir: config.cacheDir });
  const range = await resolveRange(rpc, flags);
  return { rpc, chain, address, ...range, isDemo: false };
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

interface Flags {
  since?: string;
  until?: string;
  json: boolean;
  card?: string;
  chain?: string;
  rpc?: string;
}

function parseFlags(args: string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = { json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--json":
        flags.json = true;
        break;
      case "--since":
        flags.since = args[++i];
        break;
      case "--until":
        flags.until = args[++i];
        break;
      case "--card":
        flags.card = args[++i];
        break;
      case "--chain":
        flags.chain = args[++i];
        break;
      case "--rpc":
        flags.rpc = args[++i];
        break;
      default:
        if (a.startsWith("--")) fail(`unknown flag ${a}`);
        positionals.push(a);
    }
  }
  return { positionals, flags };
}

function requireAddress(positionals: string[]): string {
  const addr = positionals[0];
  if (!addr) fail("missing wallet address");
  if (addr.endsWith(".eth")) {
    fail("ENS resolution is not implemented. Pass a 0x address directly.");
  }
  if (!isAddress(addr)) fail(`"${addr}" is not a 0x-prefixed 40-hex-character address`);
  return addr.toLowerCase();
}

async function resolveRange(
  rpc: RpcClient,
  flags: Flags
): Promise<{ fromBlock: number; toBlock: number; sinceLabel: string; untilLabel: string; untilTimestamp: number }> {
  const latestBlock = await rpc.blockNumber();
  const latestBlockHeader = await rpc.getBlockByNumber(toHex(latestBlock));
  const nowTs = latestBlockHeader ? Number.parseInt(latestBlockHeader.timestamp, 16) : Math.floor(Date.now() / 1000);

  const untilTimestamp = flags.until ? Math.floor(new Date(flags.until).getTime() / 1000) : nowTs;
  const sinceTimestamp = flags.since
    ? Math.floor(new Date(flags.since).getTime() / 1000)
    : untilTimestamp - DEFAULT_LOOKBACK_DAYS * 86400;

  const toBlock = flags.until ? await blockForTimestamp(rpc, untilTimestamp, latestBlock) : latestBlock;
  const fromBlock = await blockForTimestamp(rpc, sinceTimestamp, latestBlock);

  return {
    fromBlock,
    toBlock,
    sinceLabel: new Date(sinceTimestamp * 1000).toISOString().slice(0, 10),
    untilLabel: new Date(untilTimestamp * 1000).toISOString().slice(0, 10),
    untilTimestamp,
  };
}

function printRpcWarning(usingDefaultRpc: boolean): void {
  if (usingDefaultRpc) console.error(`hindsight: ${DEFAULT_RPC_WARNING}`);
}

/**
 * A chain with no quote assets configured cannot have any swap self-priced
 * (see docs/how-pnl-is-computed.md): there is nothing to value a trade
 * against. Silently returning a report with zero positions and zero PnL
 * would look identical to "this wallet never traded", which is a lie by
 * omission. Say it plainly instead, for any command that needs pricing.
 */
function warnIfNoQuoteAssets(chain: ReturnType<typeof resolveChain>): void {
  if (chain.quoteAssets.length === 0) {
    console.error(
      `hindsight: ${chain.displayName} has no quote assets configured, so no swap on it can be self-priced. ` +
        `PnL and benchmark columns will come back empty -- every trade will show as unpriced. ` +
        `"leaks" and "approvals" do not need pricing and remain accurate. ` +
        `Add quote assets for this chain in data/chains.json (or a local chain config override); no code change required.`
    );
  }
}

async function cmdReport(positionals: string[], flags: Flags): Promise<void> {
  const address = requireAddress(positionals);
  const run = await resolveRun(address, flags);
  warnIfNoQuoteAssets(run.chain);
  const config = run.isDemo ? undefined : loadConfig(run.chain);

  const result = await buildReport({
    rpc: run.rpc,
    chain: run.chain,
    address: run.address,
    fromBlock: run.fromBlock,
    toBlock: run.toBlock,
    sinceLabel: run.sinceLabel,
    untilLabel: run.untilLabel,
    untilTimestamp: run.untilTimestamp,
    agent: config?.agent,
  });

  if (flags.card) {
    writeFileSync(flags.card, renderCard(result));
    console.error(`wrote share card to ${flags.card}`);
  }

  if (flags.json) {
    console.log(JSON.stringify(result, jsonReplacer, 2));
  } else {
    console.log(formatReportText(result));
  }
}

async function cmdLeaks(positionals: string[], flags: Flags): Promise<void> {
  const address = requireAddress(positionals);
  const run = await resolveRun(address, flags);
  const pricer = loadPricerForChain(run.chain);
  const scan = await scanWalletDeltas(run.rpc, run.address, run.fromBlock, run.toBlock);
  const leaks = computeLeaks(scan.deltas, pricer, scan.feeSweepComplete);

  if (flags.json) {
    console.log(JSON.stringify(leaks, jsonReplacer, 2));
    return;
  }
  console.log(`HINDSIGHT LEAKS · ${shortAddress(run.address)} · ${run.sinceLabel} → ${run.untilLabel}`);
  console.log("");
  const feeUsd =
    leaks.totalFeeUsd != null ? fmtUsd(leaks.totalFeeUsd) : `${weiToNative(leaks.totalFeeWei)} ${run.chain.nativeSymbol}`;
  const prioUsd =
    leaks.priorityFeeUsd != null
      ? fmtUsd(leaks.priorityFeeUsd)
      : `${weiToNative(leaks.priorityFeeWei)} ${run.chain.nativeSymbol}`;
  const failUsd =
    leaks.failedTxFeeUsd != null
      ? fmtUsd(leaks.failedTxFeeUsd)
      : `${weiToNative(leaks.failedTxFeeWei)} ${run.chain.nativeSymbol}`;
  console.log(`  total fees        ${feeUsd}   across ${leaks.txCount} txs`);
  console.log(`  priority fees     ${prioUsd}   across ${leaks.txCount} txs`);
  console.log(`  failed txs        ${failUsd}   across ${leaks.failedTxCount} failures`);
  if (!leaks.feeSweepComplete) {
    console.log(`  (fee sweep skipped: block range too wide -- fees/failures may be undercounted)`);
  }
  console.log(`  sandwich detection: ${leaks.sandwichDetection}`);
}

async function cmdPositions(positionals: string[], flags: Flags): Promise<void> {
  const address = requireAddress(positionals);
  const run = await resolveRun(address, flags);
  warnIfNoQuoteAssets(run.chain);
  const pricer = loadPricerForChain(run.chain);
  const scan = await scanWalletDeltas(run.rpc, run.address, run.fromBlock, run.toBlock);
  const positions = await buildPositions(scan.deltas, { chain: run.chain, pricer, rpc: run.rpc });

  if (flags.json) {
    console.log(JSON.stringify(positions, jsonReplacer, 2));
    return;
  }
  console.log(`HINDSIGHT POSITIONS · ${shortAddress(run.address)} · ${run.sinceLabel} → ${run.untilLabel}`);
  console.log("");
  console.log(
    `  ${"TOKEN".padEnd(10)}${"BOUGHT".padStart(14)}${"SOLD".padStart(14)}${"REALIZED".padStart(14)}${"UNREALIZED".padStart(14)}${"HOLD".padStart(12)}`
  );
  for (const p of positions.positions) {
    const endTs = p.currentQty > 1e-9 ? run.untilTimestamp : p.lastActivityTimestamp;
    const hold =
      p.firstBuyTimestamp != null && endTs != null
        ? `${Math.round((endTs - p.firstBuyTimestamp) / 86400)}d`
        : "-";
    console.log(
      `  ${p.symbol.padEnd(10)}${p.totalBoughtQty.toFixed(2).padStart(14)}${p.totalSoldQty.toFixed(2).padStart(14)}${fmtUsd(p.realizedPnlUsd).padStart(14)}${fmtUsd(p.unrealizedPnlUsd).padStart(14)}${hold.padStart(12)}`
    );
  }
  console.log("");
  console.log(`  ${positions.positions.length} positions · ${positions.unpricedCount} unpriced and excluded`);
}

async function cmdApprovals(positionals: string[], flags: Flags): Promise<void> {
  const address = requireAddress(positionals);
  const run = await resolveRun(address, flags);
  const approvals = await scanApprovals(run.rpc, run.address, run.fromBlock, run.toBlock);

  if (flags.json) {
    console.log(JSON.stringify(approvals, jsonReplacer, 2));
    return;
  }
  console.log(`HINDSIGHT APPROVALS · ${shortAddress(run.address)} · ${run.sinceLabel} → ${run.untilLabel}`);
  console.log("");
  if (approvals.length === 0) {
    console.log("  no open approvals found in range.");
  }
  for (const a of approvals) {
    const amount = a.unlimited ? "unlimited" : a.amount.toString();
    const days = Math.max(0, Math.round((Date.now() / 1000 - a.lastUpdatedTimestamp) / 86400));
    const url = run.chain.explorerTxUrl.replace("{hash}", a.txHash);
    console.log(`  ${a.tokenSymbol.padEnd(8)} -> ${a.spender}  ${amount}${a.unlimited ? " (!)" : ""}  open ${days}d  ${url}`);
  }
  console.log("");
  console.log(`  report only: hindsight never revokes an approval or signs anything.`);
}

async function cmdDemo(flags: Flags): Promise<void> {
  console.error("hindsight demo: offline fixture, no RPC calls, no network access.");
  await cmdReport([DEMO_ADDRESS], flags);
}

async function cmdDoctor(flags: Flags): Promise<void> {
  const chain = resolveChain(flags.chain ?? "ethereum", loadChains());
  const config = loadConfig(chain, { rpcUrl: flags.rpc });
  console.log(`chain:        ${chain.displayName} (${chain.id})`);
  console.log(`rpc:          ${config.rpcUrl}${config.usingDefaultRpc ? "  (default, see --rpc)" : ""}`);

  const rpc = new RpcClient({ rpcUrl: config.rpcUrl, cacheDir: config.cacheDir });
  const start = Date.now();
  let reachable = false;
  try {
    await rpc.chainId();
    reachable = true;
  } catch {
    reachable = false;
  }
  const latencyMs = Date.now() - start;
  console.log(`rpc reachable: ${reachable ? "yes" : "no"}${reachable ? ` (${latencyMs}ms)` : ""}`);

  let cacheWritable = false;
  try {
    mkdirSync(config.cacheDir, { recursive: true });
    const probe = join(config.cacheDir, ".doctor-probe");
    writeFileSync(probe, "ok");
    cacheWritable = true;
  } catch {
    cacheWritable = false;
  }
  console.log(`cache dir:    ${config.cacheDir}`);
  console.log(`cache writable: ${cacheWritable ? "yes" : "no"}`);

  let seriesLoaded = false;
  let seriesDays = 0;
  if (chain.nativeUsdSeries) {
    try {
      const pricer = loadPricerForChain(chain);
      seriesLoaded = pricer.hasNativeSeries;
      seriesDays = seriesLoaded ? Object.keys(JSON.parse(readFileSync(join(__dirname, "..", "..", "data", chain.nativeUsdSeries), "utf8"))).length : 0;
    } catch {
      seriesLoaded = false;
    }
  }
  console.log(
    `price series: ${chain.nativeUsdSeries ? `${chain.nativeUsdSeries} (${seriesDays} days)` : "none bundled for this chain -- gas USD figures will be omitted"}`
  );

  console.log(`rate limit headroom: advisory only -- hindsight backs off on HTTP 429 with exponential delay; no guarantee against a strict provider quota.`);

  if (!reachable || !cacheWritable) process.exitCode = 1;
}

function usage(): string {
  return `hindsight -- read-only counterfactual replay for EVM wallets

usage:
  hindsight <address> [--chain <name|id>] [--since <date>] [--until <date>] [--json] [--card <out.html>]
  hindsight leaks <address> [--chain <name|id>] [--since <date>] [--until <date>] [--json]
  hindsight positions <address> [--chain <name|id>] [--since <date>] [--until <date>] [--json]
  hindsight approvals <address> [--chain <name|id>] [--since <date>] [--until <date>] [--json]
  hindsight demo [--json] [--card <out.html>]
  hindsight doctor [--chain <name|id>]

chains: ${loadChains().map((c) => `${c.name} (${c.id})`).join(", ")}

rpc endpoint: --rpc <url> or HINDSIGHT_RPC_URL, defaults to the chain's public endpoint.
never asks for a private key or seed phrase. never signs. never sends a transaction.`;
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function weiToNative(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(5);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(usage());
    return;
  }

  const [first, ...rest] = argv;
  const { positionals, flags } = parseFlags(rest);

  switch (first) {
    case "leaks":
      await cmdLeaks(positionals, flags);
      break;
    case "positions":
      await cmdPositions(positionals, flags);
      break;
    case "approvals":
      await cmdApprovals(positionals, flags);
      break;
    case "demo":
      await cmdDemo(flags);
      break;
    case "doctor":
      await cmdDoctor(flags);
      break;
    default: {
      // Not a subcommand keyword: treat the whole invocation as the report command.
      const { positionals: allPositionals, flags: allFlags } = parseFlags(argv);
      await cmdReport(allPositionals, allFlags);
    }
  }
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
