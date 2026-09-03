import type { LeakSummary, TxDelta } from "./types.js";
import type { Pricer } from "./pricing.js";

/**
 * Fee arithmetic. Every number here comes straight off the transaction
 * receipts and blocks already fetched to reconstruct trades -- no extra
 * RPC calls. A reverted transaction (receipt.status === 0) still burned
 * the gas it used; that is reported explicitly, not folded away.
 *
 * Priority fee is estimated as effectiveGasPrice - block.baseFeePerGas,
 * per transaction, on chains with EIP-1559 blocks. A chain or transaction
 * without a base fee (legacy pricing) reports 0 priority fee for that
 * transaction rather than guessing.
 */
export function computeLeaks(deltas: TxDelta[], pricer: Pricer, feeSweepComplete: boolean): LeakSummary {
  let totalFeeWei = 0n;
  let priorityFeeWei = 0n;
  let failedTxFeeWei = 0n;
  let txCount = 0;
  let failedTxCount = 0;
  let feeUsdSum = 0;
  let failedFeeUsdSum = 0;
  let priorityUsdSum = 0;
  const hasUsd = pricer.hasNativeSeries;

  for (const d of deltas) {
    if (!d.isSender) continue;
    txCount += 1;
    const feeWei = d.gasUsedWei * d.effectiveGasPriceWei;
    totalFeeWei += feeWei;
    const feeUsd = hasUsd ? (Number(feeWei) / 1e18) * (pricer.nativeUsdAt(d.timestamp) ?? 0) : 0;
    feeUsdSum += feeUsd;

    if (d.baseFeePerGasWei != null && d.effectiveGasPriceWei > d.baseFeePerGasWei) {
      const tipWei = (d.effectiveGasPriceWei - d.baseFeePerGasWei) * d.gasUsedWei;
      priorityFeeWei += tipWei;
      priorityUsdSum += hasUsd ? (Number(tipWei) / 1e18) * (pricer.nativeUsdAt(d.timestamp) ?? 0) : 0;
    }

    if (d.failed) {
      failedTxCount += 1;
      failedTxFeeWei += feeWei;
      failedFeeUsdSum += feeUsd;
    }
  }

  return {
    totalFeeWei,
    totalFeeUsd: hasUsd ? feeUsdSum : null,
    priorityFeeWei,
    priorityFeeUsd: hasUsd ? priorityUsdSum : null,
    txCount,
    failedTxCount,
    failedTxFeeWei,
    failedTxFeeUsd: hasUsd ? failedFeeUsdSum : null,
    feeSweepComplete,
    // Sandwich detection needs a mempool/block-ordering view this tool
    // does not have (it only reads confirmed state). Out of scope for v1;
    // do not approximate it with a heuristic that can't be defended.
    sandwichDetection: "not_implemented",
  };
}
