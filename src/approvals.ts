import { ERC20_APPROVAL_TOPIC, UNLIMITED_APPROVAL_THRESHOLD } from "./types.js";
import type { OpenApproval } from "./types.js";
import type { RpcClient } from "./rpc.js";
import { addressTopic, fromHex, scanLogs } from "./logs.js";
import { getErc20Meta } from "./erc20.js";

function topicToAddress(topic: string): string {
  return ("0x" + topic.slice(-40)).toLowerCase();
}

function decodeUint256(dataHex: string): bigint {
  const hex = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  if (hex.length === 0) return 0n;
  return BigInt("0x" + hex);
}

/**
 * Scans ERC-20 Approval logs for the wallet and reports what is still
 * outstanding. approve() overwrites the prior allowance, so for each
 * (token, spender) pair the most recent Approval log is the current
 * allowance -- everything older is superseded. A pair whose latest value
 * is 0 is not reported as open. This does not see allowance consumed by
 * transferFrom (most tokens do not emit an event for that), so an
 * "outstanding" amount here is the ceiling the spender could still move,
 * not necessarily what remains after partial use -- documented in
 * docs/how-pnl-is-computed.md. Report only: this never revokes anything.
 */
export async function scanApprovals(
  rpc: RpcClient,
  address: string,
  fromBlock: number,
  toBlock: number
): Promise<OpenApproval[]> {
  const wallet = address.toLowerCase();
  const walletTopic = addressTopic(wallet);

  const logs = await scanLogs(rpc, {
    namespace: "approvals",
    address: wallet,
    topics: [ERC20_APPROVAL_TOPIC, walletTopic, null],
    fromBlock,
    toBlock,
  });

  interface Entry {
    token: string;
    spender: string;
    blockNumber: number;
    hash: string;
    value: bigint;
  }
  const entries: Entry[] = [];
  for (const log of logs) {
    if (log.topics.length < 3) continue;
    const spender = topicToAddress(log.topics[2]!);
    entries.push({
      token: log.address.toLowerCase(),
      spender,
      blockNumber: fromHex(log.blockNumber),
      hash: log.transactionHash,
      value: decodeUint256(log.data),
    });
  }
  entries.sort((a, b) => a.blockNumber - b.blockNumber);

  const byPair = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = `${e.token}:${e.spender}`;
    const list = byPair.get(key) ?? [];
    list.push(e);
    byPair.set(key, list);
  }

  const blockNumbers = new Set(entries.map((e) => e.blockNumber));
  const timestamps = new Map<number, number>();
  await Promise.all(
    [...blockNumbers].map(async (bn) => {
      const block = await rpc.getBlockByNumber("0x" + bn.toString(16));
      if (block) timestamps.set(bn, fromHex(block.timestamp));
    })
  );

  const out: OpenApproval[] = [];
  for (const [, list] of byPair) {
    const latest = list[list.length - 1]!;
    if (latest.value === 0n) continue;
    const meta = await getErc20Meta(rpc, latest.token);
    out.push({
      token: latest.token,
      tokenSymbol: meta?.symbol ?? latest.token.slice(0, 8),
      spender: latest.spender,
      amount: latest.value,
      unlimited: latest.value >= UNLIMITED_APPROVAL_THRESHOLD,
      firstSeenTimestamp: timestamps.get(list[0]!.blockNumber) ?? 0,
      lastUpdatedTimestamp: timestamps.get(latest.blockNumber) ?? 0,
      txHash: latest.hash,
    });
  }

  out.sort((a, b) => b.lastUpdatedTimestamp - a.lastUpdatedTimestamp);
  return out;
}
