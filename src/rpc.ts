import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RawLog, TransactionReceipt, BlockHeader, RawTx } from "./types.js";

export interface RpcClientOptions {
  rpcUrl: string;
  cacheDir: string;
  maxRetries?: number;
  baseDelayMs?: number;
  offline?: boolean; // never hit the network; used by `demo`
  onRateLimit?: (attempt: number, delayMs: number) => void;
}

export class RpcError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

/** Thrown when a provider rejects eth_getLogs for asking too much in one call. */
export class LogRangeError extends RpcError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "LogRangeError";
  }
}

const RANGE_ERROR_PATTERN =
  /range|too many|limit|10.?000|result set|query returned more|block range/i;

let requestId = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimal JSON-RPC client for the EVM surface hindsight needs: eth_getLogs,
 * eth_getTransactionReceipt, eth_getBlockByNumber, eth_call, eth_chainId,
 * eth_blockNumber. No SDK, just fetch, with retry + exponential backoff on
 * 429 and transient network errors, and an on-disk cache so re-running
 * against a wallet costs zero network calls for data already fetched.
 */
export class RpcClient {
  private readonly rpcUrl: string;
  readonly cacheDir: string;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly offline: boolean;
  private readonly onRateLimit?: (attempt: number, delayMs: number) => void;
  public networkCalls = 0;
  public cacheHits = 0;

  constructor(opts: RpcClientOptions) {
    this.rpcUrl = opts.rpcUrl;
    this.cacheDir = opts.cacheDir;
    this.maxRetries = opts.maxRetries ?? 5;
    this.baseDelayMs = opts.baseDelayMs ?? 400;
    this.offline = opts.offline ?? false;
    this.onRateLimit = opts.onRateLimit;
    mkdirSync(this.cacheDir, { recursive: true });
  }

  // ---- generic on-disk JSON cache -----------------------------------

  cachePath(...segments: string[]): string {
    return join(this.cacheDir, ...segments);
  }

  readJsonCache<T>(relPath: string): T | undefined {
    const path = this.cachePath(relPath);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  writeJsonCache(relPath: string, value: unknown): void {
    const path = this.cachePath(relPath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  }

  // ---- transport ------------------------------------------------------

  private backoffDelay(attempt: number): number {
    const jitter = Math.random() * this.baseDelayMs;
    return this.baseDelayMs * 2 ** attempt + jitter;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    if (this.offline) {
      throw new RpcError(`offline mode: refusing network call for ${method}`);
    }
    let attempt = 0;
    let lastError: unknown;
    while (attempt <= this.maxRetries) {
      try {
        this.networkCalls += 1;
        const res = await fetch(this.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
        });
        if (res.status === 429) {
          const delay = this.backoffDelay(attempt);
          this.onRateLimit?.(attempt, delay);
          await sleep(delay);
          attempt += 1;
          continue;
        }
        if (!res.ok) {
          throw new RpcError(`RPC HTTP ${res.status} calling ${method}`);
        }
        const body = (await res.json()) as { result?: T; error?: { message: string; code: number } };
        if (body.error) {
          if (method === "eth_getLogs" && RANGE_ERROR_PATTERN.test(body.error.message)) {
            throw new LogRangeError(`eth_getLogs range rejected: ${body.error.message}`);
          }
          throw new RpcError(`RPC error calling ${method}: ${body.error.message} (${body.error.code})`);
        }
        return body.result as T;
      } catch (err) {
        if (err instanceof LogRangeError) throw err;
        lastError = err;
        if (attempt >= this.maxRetries) break;
        const delay = this.backoffDelay(attempt);
        await sleep(delay);
        attempt += 1;
      }
    }
    throw new RpcError(`RPC call to ${method} failed after ${this.maxRetries + 1} attempts`, lastError);
  }

  // ---- typed helpers ----------------------------------------------------

  async getLogsRaw(params: {
    fromBlock: string;
    toBlock: string;
    address?: string;
    topics: (string | null)[];
  }): Promise<RawLog[]> {
    return this.call<RawLog[]>("eth_getLogs", [params]);
  }

  async getTransactionReceipt(hash: string): Promise<TransactionReceipt | null> {
    const key = join("receipts", `${hash}.json`);
    const cached = this.readJsonCache<TransactionReceipt>(key);
    if (cached) {
      this.cacheHits += 1;
      return cached;
    }
    const result = await this.call<TransactionReceipt | null>("eth_getTransactionReceipt", [hash]);
    if (result) this.writeJsonCache(key, result);
    return result;
  }

  async getTransactionByHash(hash: string): Promise<RawTx | null> {
    const key = join("txs", `${hash}.json`);
    const cached = this.readJsonCache<RawTx>(key);
    if (cached) {
      this.cacheHits += 1;
      return cached;
    }
    const result = await this.call<RawTx | null>("eth_getTransactionByHash", [hash]);
    if (result) this.writeJsonCache(key, result);
    return result;
  }

  async getBlockByNumber(blockNumberHex: string): Promise<BlockHeader | null> {
    const key = join("blocks", `${blockNumberHex}.json`);
    const cached = this.readJsonCache<BlockHeader>(key);
    if (cached) {
      this.cacheHits += 1;
      return cached;
    }
    const result = await this.call<BlockHeader | null>("eth_getBlockByNumber", [blockNumberHex, false]);
    if (result) this.writeJsonCache(key, result);
    return result;
  }

  /** Full block including every transaction object -- used only for the bounded gas/failed-tx sweep. */
  async getBlockWithTransactions(
    blockNumberHex: string
  ): Promise<(BlockHeader & { transactions: RawTx[] }) | null> {
    const key = join("blocks-full", `${blockNumberHex}.json`);
    const cached = this.readJsonCache<BlockHeader & { transactions: RawTx[] }>(key);
    if (cached) {
      this.cacheHits += 1;
      return cached;
    }
    const result = await this.call<(BlockHeader & { transactions: RawTx[] }) | null>(
      "eth_getBlockByNumber",
      [blockNumberHex, true]
    );
    if (result) this.writeJsonCache(key, result);
    return result;
  }

  async ethCall(to: string, data: string): Promise<string> {
    return this.call<string>("eth_call", [{ to, data }, "latest"]);
  }

  async chainId(): Promise<number> {
    const hex = await this.call<string>("eth_chainId", []);
    return Number(hex);
  }

  async blockNumber(): Promise<number> {
    const hex = await this.call<string>("eth_blockNumber", []);
    return Number(hex);
  }

  async getBalance(address: string): Promise<bigint> {
    const hex = await this.call<string>("eth_getBalance", [address, "latest"]);
    return BigInt(hex);
  }

  /** Seed a cache entry directly, e.g. from a bundled fixture. */
  seedCache(relPath: string, value: unknown): void {
    this.writeJsonCache(relPath, value);
  }
}
