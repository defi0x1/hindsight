import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { ChainConfig, QuoteAsset } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function dataDir(): string {
  // src/chains.ts compiles to dist/src/chains.js; data/ ships two levels up.
  return join(__dirname, "..", "..", "data");
}

interface RawChainConfig extends Omit<ChainConfig, "quoteAssets"> {
  quoteAssets: QuoteAsset[];
}

let cachedChains: RawChainConfig[] | null = null;

export function loadChains(path: string = join(dataDir(), "chains.json")): ChainConfig[] {
  if (!cachedChains) {
    const raw = readFileSync(path, "utf8");
    cachedChains = JSON.parse(raw) as RawChainConfig[];
  }
  return cachedChains.map((c) => ({
    ...c,
    quoteAssets: c.quoteAssets.map((q) => ({ ...q, address: q.address.toLowerCase() })),
  }));
}

/** Resolve a chain by name (case-insensitive) or numeric chain id. */
export function resolveChain(idOrName: string | number, chains: ChainConfig[] = loadChains()): ChainConfig {
  const asNumber = typeof idOrName === "number" ? idOrName : Number(idOrName);
  const byId = !Number.isNaN(asNumber) ? chains.find((c) => c.id === asNumber) : undefined;
  if (byId) return byId;
  const name = String(idOrName).toLowerCase();
  const byName = chains.find((c) => c.name === name || c.displayName.toLowerCase() === name);
  if (byName) return byName;
  const known = chains.map((c) => `${c.name} (${c.id})`).join(", ");
  throw new Error(`unknown chain "${idOrName}". Known chains: ${known}`);
}

export function isQuoteAsset(chain: ChainConfig, tokenAddress: string): QuoteAsset | undefined {
  const addr = tokenAddress.toLowerCase();
  return chain.quoteAssets.find((q) => q.address === addr);
}

export function explorerTxUrl(chain: ChainConfig, hash: string): string {
  return chain.explorerTxUrl.replace("{hash}", hash);
}
