import { join } from "node:path";
import { RpcClient, LogRangeError } from "./rpc.js";
import type { RawLog } from "./types.js";

export function toHex(n: number): string {
  return "0x" + n.toString(16);
}

export function fromHex(hex: string): number {
  return Number.parseInt(hex, 16);
}

export function addressTopic(address: string): string {
  return "0x" + "0".repeat(24) + address.toLowerCase().replace(/^0x/, "");
}

interface Manifest {
  scannedFrom: number;
  scannedTo: number;
  // Every leaf range actually fetched from the network (or seeded by a
  // fixture), non-overlapping. This is the reassembly index: rather than
  // re-deriving how a range was split, we just record what was written.
  chunks: Array<[number, number]>;
}

function loadManifest(rpc: RpcClient, manifestPath: string): Manifest | undefined {
  return rpc.readJsonCache<Manifest>(manifestPath);
}

/**
 * Scans eth_getLogs for one topic filter, across a block range, in chunks
 * that adaptively halve when a provider rejects the range (too large / too
 * many results -- every provider enforces a different cap). Successful
 * chunks are cached to disk keyed by their exact block range, and a
 * manifest tracks the contiguous range already scanned for this
 * (namespace, address) pair plus an index of the chunk files on disk, so a
 * later run only fetches the new tail and reassembles the rest from cache
 * with zero network calls.
 */
export async function scanLogs(
  rpc: RpcClient,
  opts: {
    namespace: string; // "transfers-from" | "transfers-to" | "approvals"
    address: string; // the wallet, used only for cache keying + directory layout
    topics: (string | null)[];
    filterAddress?: string; // restrict to logs emitted by this contract (rare; usually omitted)
    fromBlock: number;
    toBlock: number;
    minChunk?: number;
  }
): Promise<RawLog[]> {
  const dir = join("logs", opts.namespace, opts.address.toLowerCase());
  const manifestPath = join(dir, "manifest.json");
  const manifest = loadManifest(rpc, manifestPath);

  const wanted: Array<[number, number]> = [];
  if (!manifest) {
    wanted.push([opts.fromBlock, opts.toBlock]);
  } else {
    if (opts.fromBlock < manifest.scannedFrom) {
      wanted.push([opts.fromBlock, manifest.scannedFrom - 1]);
    }
    if (opts.toBlock > manifest.scannedTo) {
      wanted.push([manifest.scannedTo + 1, opts.toBlock]);
    }
  }

  const newChunks: Array<[number, number]> = [];
  for (const [from, to] of wanted) {
    if (from > to) continue;
    await fetchRangeCached(rpc, dir, opts, from, to, opts.minChunk ?? 1, newChunks);
  }

  const allChunks = [...(manifest?.chunks ?? []), ...newChunks];
  const newFrom = manifest ? Math.min(manifest.scannedFrom, opts.fromBlock) : opts.fromBlock;
  const newTo = manifest ? Math.max(manifest.scannedTo, opts.toBlock) : opts.toBlock;
  if (!manifest || newChunks.length > 0) {
    rpc.writeJsonCache(manifestPath, {
      scannedFrom: newFrom,
      scannedTo: newTo,
      chunks: allChunks,
    } satisfies Manifest);
  }

  return readChunksInRange(rpc, dir, allChunks, opts.fromBlock, opts.toBlock);
}

async function fetchRangeCached(
  rpc: RpcClient,
  dir: string,
  opts: { topics: (string | null)[]; filterAddress?: string },
  from: number,
  to: number,
  minChunk: number,
  newChunks: Array<[number, number]>
): Promise<void> {
  const chunkPath = join(dir, `${from}-${to}.json`);
  const cached = rpc.readJsonCache<RawLog[]>(chunkPath);
  if (cached) {
    newChunks.push([from, to]);
    return;
  }

  try {
    const logs = await rpc.getLogsRaw({
      fromBlock: toHex(from),
      toBlock: toHex(to),
      address: opts.filterAddress,
      topics: opts.topics,
    });
    rpc.writeJsonCache(chunkPath, logs);
    newChunks.push([from, to]);
  } catch (err) {
    if (err instanceof LogRangeError && to > from && to - from + 1 > minChunk) {
      const mid = from + Math.floor((to - from) / 2);
      await fetchRangeCached(rpc, dir, opts, from, mid, minChunk, newChunks);
      await fetchRangeCached(rpc, dir, opts, mid + 1, to, minChunk, newChunks);
      return;
    }
    throw err;
  }
}

function readChunksInRange(
  rpc: RpcClient,
  dir: string,
  chunks: Array<[number, number]>,
  from: number,
  to: number
): RawLog[] {
  const relevant = chunks
    .filter(([cFrom, cTo]) => cTo >= from && cFrom <= to)
    .sort((a, b) => a[0] - b[0]);
  const out: RawLog[] = [];
  for (const [cFrom, cTo] of relevant) {
    const logs = rpc.readJsonCache<RawLog[]>(join(dir, `${cFrom}-${cTo}.json`)) ?? [];
    for (const log of logs) {
      const bn = fromHex(log.blockNumber);
      if (bn >= from && bn <= to) out.push(log);
    }
  }
  return out;
}
