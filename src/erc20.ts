import { join } from "node:path";
import { RpcClient } from "./rpc.js";

export interface Erc20Meta {
  symbol: string;
  decimals: number;
}

const SELECTOR_DECIMALS = "0x313ce567";
const SELECTOR_SYMBOL = "0x95d89b41";

function decodeString(hex: string): string {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length === 0) return "";
  // Dynamic ABI string: [offset(32)][length(32)][data...]
  if (body.length >= 128) {
    const lengthWord = body.slice(64, 128);
    const length = Number.parseInt(lengthWord, 16);
    if (Number.isFinite(length) && length > 0 && length <= (body.length - 128) / 2) {
      const dataHex = body.slice(128, 128 + length * 2);
      return hexToUtf8(dataHex);
    }
  }
  // Legacy bytes32 string (e.g. MKR).
  return hexToUtf8(body).replace(/\0+$/, "");
}

function hexToUtf8(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return Buffer.from(bytes).toString("utf8").replace(/\0+$/, "").trim();
}

/**
 * Resolves and permanently caches an ERC-20's decimals() and symbol(). A
 * token that reverts or returns garbage on either call has no reliable
 * basis for unit conversion, so it comes back null and callers treat it as
 * unpriced -- same as a token with no path to a quote asset.
 */
export async function getErc20Meta(rpc: RpcClient, tokenAddress: string): Promise<Erc20Meta | null> {
  const addr = tokenAddress.toLowerCase();
  const cacheKey = join("erc20", `${addr}.json`);
  const cached = rpc.readJsonCache<Erc20Meta | null>(cacheKey);
  if (cached !== undefined) return cached;

  let meta: Erc20Meta | null = null;
  try {
    const [decimalsHex, symbolHex] = await Promise.all([
      rpc.ethCall(addr, SELECTOR_DECIMALS),
      rpc.ethCall(addr, SELECTOR_SYMBOL),
    ]);
    const decimals = Number.parseInt(decimalsHex, 16);
    const symbol = decodeString(symbolHex) || addr.slice(0, 8);
    if (Number.isFinite(decimals) && decimals >= 0 && decimals <= 255) {
      meta = { symbol, decimals };
    }
  } catch {
    meta = null;
  }
  rpc.writeJsonCache(cacheKey, meta);
  return meta;
}
