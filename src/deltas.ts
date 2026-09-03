import { ERC20_TRANSFER_TOPIC, NATIVE_PSEUDO_ADDRESS } from "./types.js";
import type { RawLog, TxDelta } from "./types.js";
import type { RpcClient } from "./rpc.js";
import { addressTopic, fromHex, scanLogs, toHex } from "./logs.js";
import { getErc20Meta } from "./erc20.js";

function topicToAddress(topic: string): string {
  return ("0x" + topic.slice(-40)).toLowerCase();
}

function decodeUint256(dataHex: string): bigint {
  const hex = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  if (hex.length === 0) return 0n;
  return BigInt("0x" + hex);
}

export interface ScanResult {
  deltas: TxDelta[];
  unresolvedTokens: Set<string>;
  // Whether the bounded full-block sweep for gas/failed-tx completeness
  // ran. If false (range too wide), fee totals and failed-tx counts only
  // cover transactions that also moved a token, and leaks.ts under-counts
  // plain sends and reverted swaps. See docs/how-pnl-is-computed.md.
  feeSweepComplete: boolean;
}

const DEFAULT_FEE_SWEEP_BLOCK_CAP = 100_000;

async function buildDeltaForTx(
  rpc: RpcClient,
  wallet: string,
  hash: string,
  logs: RawLog[],
  unresolvedTokens: Set<string>
): Promise<TxDelta | null> {
  const [receipt, tx] = await Promise.all([rpc.getTransactionReceipt(hash), rpc.getTransactionByHash(hash)]);
  if (!receipt || !tx) return null;
  const block = await rpc.getBlockByNumber(receipt.blockNumber);
  if (!block) return null;

  const tokenDeltas: Record<string, number> = {};
  const decimals: Record<string, number> = {};

  for (const log of logs) {
    if (log.topics.length < 3) continue;
    const from = topicToAddress(log.topics[1]!);
    const to = topicToAddress(log.topics[2]!);
    if (from !== wallet && to !== wallet) continue;
    const token = log.address.toLowerCase();
    const meta = await getErc20Meta(rpc, token);
    if (!meta) {
      unresolvedTokens.add(token);
      continue; // no reliable decimals: excluded, not guessed
    }
    const raw = decodeUint256(log.data);
    const ui = Number(raw) / 10 ** meta.decimals;
    let delta = 0;
    if (from === wallet) delta -= ui;
    if (to === wallet) delta += ui; // self-transfer nets to 0, correctly
    if (delta === 0) continue;
    tokenDeltas[token] = (tokenDeltas[token] ?? 0) + delta;
    decimals[token] = meta.decimals;
  }

  const isSender = tx.from.toLowerCase() === wallet;
  const value = BigInt(tx.value ?? "0x0");
  if (value > 0n) {
    const ui = Number(value) / 1e18;
    if (isSender) tokenDeltas[NATIVE_PSEUDO_ADDRESS] = (tokenDeltas[NATIVE_PSEUDO_ADDRESS] ?? 0) - ui;
    else if (tx.to?.toLowerCase() === wallet) {
      tokenDeltas[NATIVE_PSEUDO_ADDRESS] = (tokenDeltas[NATIVE_PSEUDO_ADDRESS] ?? 0) + ui;
    }
    decimals[NATIVE_PSEUDO_ADDRESS] = 18;
  }

  const gasUsedWei = BigInt(receipt.gasUsed);
  const effectiveGasPriceWei = BigInt(receipt.effectiveGasPrice);
  const baseFeePerGasWei = block.baseFeePerGas != null ? BigInt(block.baseFeePerGas) : null;

  return {
    hash,
    blockNumber: fromHex(receipt.blockNumber),
    timestamp: fromHex(block.timestamp),
    failed: receipt.status === "0x0",
    isSender,
    gasUsedWei,
    effectiveGasPriceWei,
    baseFeePerGasWei,
    deltas: tokenDeltas,
    decimals,
  };
}

/**
 * Reconstructs the wallet's trades over [fromBlock, toBlock] from ERC-20
 * Transfer logs plus the wallet's own transaction value and gas. No
 * calldata is decoded and no DEX/router is special-cased: whatever tokens
 * moved in and out of the wallet within one transaction are that
 * transaction's trade legs. This works identically for Uniswap, 1inch,
 * CoWSwap, or an aggregator that doesn't exist yet.
 *
 * A transaction that reverts emits no logs at all -- that is EVM
 * semantics, not a hindsight limitation -- so Transfer-log scanning alone
 * cannot discover a purely failed transaction, or a plain native transfer
 * with no token leg. To keep the LEAKS numbers honest, this also runs a
 * bounded full-block sweep (eth_getBlockByNumber with full transactions)
 * over the same range to pick up every other transaction the wallet sent,
 * purely for gas/failure accounting. The sweep is capped by block count
 * (feeSweepBlockCap) because it costs one call per block; a range wider
 * than the cap skips it and feeSweepComplete comes back false.
 */
export async function scanWalletDeltas(
  rpc: RpcClient,
  address: string,
  fromBlock: number,
  toBlock: number,
  opts: { feeSweepBlockCap?: number } = {}
): Promise<ScanResult> {
  const wallet = address.toLowerCase();
  const walletTopic = addressTopic(wallet);

  const [outgoing, incoming] = await Promise.all([
    scanLogs(rpc, {
      namespace: "transfers-from",
      address: wallet,
      topics: [ERC20_TRANSFER_TOPIC, walletTopic, null],
      fromBlock,
      toBlock,
    }),
    scanLogs(rpc, {
      namespace: "transfers-to",
      address: wallet,
      topics: [ERC20_TRANSFER_TOPIC, null, walletTopic],
      fromBlock,
      toBlock,
    }),
  ]);

  const byTx = new Map<string, RawLog[]>();
  for (const log of [...outgoing, ...incoming]) {
    const list = byTx.get(log.transactionHash) ?? [];
    list.push(log);
    byTx.set(log.transactionHash, list);
  }

  const unresolvedTokens = new Set<string>();
  const deltas: TxDelta[] = [];

  for (const [hash, logs] of byTx) {
    const delta = await buildDeltaForTx(rpc, wallet, hash, logs, unresolvedTokens);
    if (delta) deltas.push(delta);
  }

  const cap = opts.feeSweepBlockCap ?? DEFAULT_FEE_SWEEP_BLOCK_CAP;
  let feeSweepComplete = false;
  if (toBlock - fromBlock + 1 <= cap) {
    feeSweepComplete = true;
    const seen = new Set(deltas.map((d) => d.hash));
    for (let bn = fromBlock; bn <= toBlock; bn++) {
      const block = await rpc.getBlockWithTransactions(toHex(bn));
      if (!block) continue;
      for (const tx of block.transactions) {
        if (tx.from.toLowerCase() !== wallet) continue;
        if (seen.has(tx.hash)) continue;
        seen.add(tx.hash);
        const delta = await buildDeltaForTx(rpc, wallet, tx.hash, [], unresolvedTokens);
        if (delta) deltas.push(delta);
      }
    }
  }

  deltas.sort((a, b) => a.timestamp - b.timestamp || a.blockNumber - b.blockNumber);
  return { deltas, unresolvedTokens, feeSweepComplete };
}
