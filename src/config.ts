import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { ChainConfig } from "./types.js";

export const DEFAULT_RPC_WARNING =
  "using the chain's public RPC endpoint. It rate-limits eth_getLogs hard and " +
  "will be slow on wallets with real trade history. Set --rpc or " +
  "HINDSIGHT_RPC_URL to a dedicated endpoint (Alchemy, Infura, QuickNode, " +
  "or the chain's own paid tier) for a materially better experience.";

export interface AgentConfig {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export interface HindsightConfig {
  rpcUrl: string;
  usingDefaultRpc: boolean;
  cacheDir: string;
  agent?: AgentConfig;
}

interface ConfigFile {
  rpcUrl?: string;
  agent?: AgentConfig;
}

function findConfigFile(): ConfigFile {
  const candidates = [join(process.cwd(), ".hindsight.json"), join(homedir(), ".hindsight.json")];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        return JSON.parse(raw) as ConfigFile;
      } catch {
        return {};
      }
    }
  }
  return {};
}

export function loadConfig(
  chain: ChainConfig,
  overrides: { rpcUrl?: string; cacheDir?: string } = {}
): HindsightConfig {
  const file = findConfigFile();
  const envRpc = process.env.HINDSIGHT_RPC_URL;
  const rpcUrl = overrides.rpcUrl ?? envRpc ?? file.rpcUrl ?? chain.rpcUrl;
  const usingDefaultRpc = rpcUrl === chain.rpcUrl;
  const cacheDir = overrides.cacheDir ?? join(process.cwd(), ".hindsight", "cache", String(chain.id));
  return {
    rpcUrl,
    usingDefaultRpc,
    cacheDir,
    agent: file.agent,
  };
}
