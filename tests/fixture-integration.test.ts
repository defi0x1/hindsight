import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../src/rpc.js";
import { resolveChain, loadChains } from "../src/chains.js";
import { buildReport } from "../src/report.js";
import { scanWalletDeltas } from "../src/deltas.js";
import { computeLeaks } from "../src/leaks.js";
import { buildPositions } from "../src/positions.js";
import { loadPricerForChain } from "../src/report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "..", "fixtures", "demo");

interface Manifest {
  chainId: number;
  address: string;
  fromBlock: number;
  toBlock: number;
  sinceLabel: string;
  untilLabel: string;
  untilTimestamp: number;
}

function loadFixtureRpc(): { rpc: RpcClient; manifest: Manifest } {
  const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8")) as Manifest;
  const dir = mkdtempSync(join(tmpdir(), "hindsight-fixture-"));
  cpSync(join(FIXTURE_DIR, "cache"), dir, { recursive: true });
  const rpc = new RpcClient({ rpcUrl: "offline://test", cacheDir: dir, offline: true });
  return { rpc, manifest };
}

// This exercises exactly the pipeline `hindsight demo`, `hindsight leaks`,
// and `hindsight positions` run, entirely offline against the bundled
// fixture -- the same guarantee the CLI gives when a user runs those
// commands against the bundled demo wallet address.

test("the full report runs against the bundled fixture with zero network calls", async () => {
  const { rpc, manifest } = loadFixtureRpc();
  const chain = resolveChain(manifest.chainId, loadChains());

  const result = await buildReport({
    rpc,
    chain,
    address: manifest.address,
    fromBlock: manifest.fromBlock,
    toBlock: manifest.toBlock,
    sinceLabel: manifest.sinceLabel,
    untilLabel: manifest.untilLabel,
    untilTimestamp: manifest.untilTimestamp,
  });

  assert.equal(rpc.networkCalls, 0, "the fixture run must not attempt any network calls");
  assert.equal(result.benchmarks.length, 4);
  const perfectExits = result.benchmarks.find((b) => b.key === "perfect_exits")!;
  assert.equal(perfectExits.isCeiling, true);
  assert.equal(result.positionCount > 0, true);
  assert.equal(result.unpricedCount >= 1, true, "the fixture includes a deliberately unpriced token-to-token swap");
  assert.equal(result.leaks.failedTxCount, 4, "the fixture includes four reverted transactions");
  assert.equal(typeof result.pattern, "string");
  assert.ok(result.pattern.length > 0);
});

test("leaks against the fixture: reverted transactions are counted with real gas cost", async () => {
  const { rpc, manifest } = loadFixtureRpc();
  const chain = resolveChain(manifest.chainId, loadChains());
  const pricer = loadPricerForChain(chain);
  const scan = await scanWalletDeltas(rpc, manifest.address, manifest.fromBlock, manifest.toBlock);
  const leaks = computeLeaks(scan.deltas, pricer, scan.feeSweepComplete);

  assert.equal(scan.feeSweepComplete, true);
  assert.equal(leaks.failedTxCount, 4);
  assert.ok(leaks.failedTxFeeWei > 0n);
  assert.ok(leaks.totalFeeWei >= leaks.failedTxFeeWei);
  assert.ok(leaks.totalFeeUsd != null && leaks.totalFeeUsd > 0);
});

test("positions against the fixture: round trips, a loser, and an unpriced swap all show up", async () => {
  const { rpc, manifest } = loadFixtureRpc();
  const chain = resolveChain(manifest.chainId, loadChains());
  const pricer = loadPricerForChain(chain);
  const scan = await scanWalletDeltas(rpc, manifest.address, manifest.fromBlock, manifest.toBlock);
  const positions = await buildPositions(scan.deltas, { chain, pricer, rpc });

  assert.ok(positions.positions.length >= 5);
  assert.ok(positions.unpricedCount >= 1);
  const roundTrip = positions.positions.find((p) => p.closeEvents >= 2);
  assert.ok(roundTrip, "expected at least one token bought and fully sold more than once");
  const loser = positions.positions.find((p) => p.realizedPnlUsd < 0);
  assert.ok(loser, "expected at least one losing position");
  // The TOKE side of the token-to-token swap was never priced, so it
  // should not appear as a tracked position at all.
  const tokeAddress = "0x555555555555555555555555555555555555000e";
  assert.equal(
    positions.positions.some((p) => p.token === tokeAddress),
    false
  );
});
