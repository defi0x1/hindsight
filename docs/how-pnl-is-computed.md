# How the numbers are made

This document is the specification for `src/deltas.ts`, `src/positions.ts`,
and `src/pricing.ts`. If those files and this document disagree, one of
them is wrong -- file an issue. The goal here is precision about exactly
where a number in the report can be wrong, not marketing copy.

## 1. Trades come from balance deltas, not decoded calldata

hindsight never decodes a swap instruction. Instead, for a wallet address
and a block range, it:

1. Calls `eth_getLogs` twice -- once filtering the ERC-20 `Transfer` topic
   with the wallet in `topic1` (the `from` position), once with the wallet
   in `topic2` (the `to` position).
2. Groups the resulting logs by transaction hash.
3. For each transaction, sums the wallet's net movement per token: what it
   sent, subtracted from what it received.
4. Adds native value from the transaction's own `value` field (for the
   sender and, if different, the recipient), and gas cost from the
   transaction receipt.

Whatever nets out to exactly one asset leaving the wallet and one asset
arriving, in the same transaction, is treated as a swap. This is
program-agnostic: it works identically for Uniswap, 1inch, CoWSwap,
pump.fun-style launchpads, or a router that does not exist yet, because
none of them are named anywhere in the code. It costs nothing to support a
new DEX.

**What this approach cannot see:**

- **A transaction that reverts emits no logs at all.** This is EVM
  semantics, not a hindsight limitation -- a failed call rolls back every
  log the same way it rolls back every balance change. hindsight recovers
  reverted transactions with a second, bounded pass: `eth_getBlockByNumber`
  with full transactions, over the same block range, to find every
  transaction the wallet sent that Transfer-log scanning missed. This pass
  is capped by block count (100,000 blocks by default) because it costs
  one RPC call per block; a range wider than the cap skips it, and the
  report says so explicitly rather than silently under-reporting fees and
  failures.
- **Value moved by an internal call is invisible.** If a router unwraps
  WETH and sends raw ETH to the user via a low-level internal call, that
  transfer shows up in neither a log nor the top-level transaction's
  `value` field. hindsight treats WETH as equivalent to native ETH for
  exactly this reason (see below); a swap that pays out in wrapped native
  is fully visible, one that pays out in unwrapped native via an internal
  call is not modeled. This is the same reason perpetuals, LP positions,
  staking, and lending are out of scope for v1 -- see the README's
  Limitations section.
- **A plain native-asset transfer with no ERC-20 leg at all**, sent by a
  wallet that hindsight has no other reason to look at that block for, is
  not discovered outside the bounded fee sweep above.

## 2. Every swap prices itself

A transaction that moves `-2.5 WETH` and `+1,000,000 TOKEN` for the wallet
tells you exactly what TOKEN cost, in WETH, at that block's timestamp. No
historical price API is needed for realized PnL on the vast majority of
trades. hindsight needs exactly two external inputs:

- **One daily native/USD series per chain** (`data/eth-usd.json`, one row
  per chain that uses ETH as gas -- see "Quote assets and chain config"
  below), to convert a WETH- or ETH-denominated trade into USD.
- **Nothing else.** There is no live price feed, no oracle, and no
  external token-price API anywhere in this codebase.

### Quote assets

A **quote asset** is a token whose USD value hindsight can determine
independently of any trade: native ETH (or the chain's native gas token),
its wrapped form (WETH), and USDC/USDT/DAI, fixed at $1. USDC/USDT/DAI
are **not** monitored for depegs in v1 -- a real depeg event would silently
distort PnL for trades executed during it. This is a known, accepted
simplification.

Every other token is a **non-quote asset**. Its price is only ever known
through a trade against a quote asset:

- **quote → non-quote** (a buy): cost basis per unit = (quote amount spent
  x quote/USD price at that block) / units received.
- **non-quote → quote** (a sell): proceeds = quote amount received x
  quote/USD price at that block. Realized PnL = proceeds - FIFO cost basis
  of the units sold (see below).
- **quote → quote** (e.g. WETH → USDC): a currency conversion. It does not
  create or close a position, and it has no PnL effect in this model --
  hindsight does not track gains or losses from choosing to hold ETH vs. a
  stablecoin between trades. This is a deliberate scope boundary: it is
  exactly why "if you had held ETH" is a separate, explicit benchmark
  rather than folded into "actual."
- **non-quote → non-quote** (e.g. swapping one memecoin directly for
  another): neither side has an independent USD basis. hindsight does
  **not** guess by chaining through an unrelated price. The transaction is
  marked `unpriced`, excluded from every total, and counted. The final
  line of every report states the excluded count honestly:
  `N positions · M unpriced and excluded`.
- **Selling more than the recorded basis** (the wallet acquired some of
  the position before the scanned block range began) is handled the same
  way: the covered portion is priced normally, and the uncovered portion
  is marked unpriced and excluded, rather than assuming a cost basis of
  zero or guessing a price.

### Chain config and adding quote assets

Quote assets are configured per chain in `data/chains.json`, under each
chain's `quoteAssets` array (`address`, `symbol`, `decimals`). **Adding a
chain, or adding a quote asset to an existing chain, is a config change,
never a code change.**

If a chain's `quoteAssets` list is empty (this ships true for Robinhood
Chain, since hindsight will not invent contract addresses it cannot
verify), no swap on that chain can be self-priced: every trade comes back
`unpriced`, and `positions`/PnL/benchmark columns come back empty. The CLI
prints this explicitly rather than returning a report that looks
identical to "this wallet never traded" -- an empty result with no
explanation is worse than a stated limitation. `leaks` and `approvals` are
unaffected, since neither needs a token price, only the native/USD series
and log data.

To add quote assets for a chain yourself, edit `data/chains.json` and add
entries to that chain's `quoteAssets` array:

```json
{ "address": "0x...", "symbol": "USDC", "decimals": 6 }
```

Two things matter for correctness:

- **`decimals` must match the token's actual on-chain `decimals()`.** A
  wrong value silently scales every price computed against that asset by a
  power of 10. hindsight does not verify this for quote assets the way it
  does for ordinary tokens (see below) -- you are asserting it.
- **`address` must be lowercase-comparable** (hindsight lowercases on
  read, so mixed case is fine) and must be the token actually used as the
  swap counterparty on that chain -- e.g. the chain's *native* USDC
  deployment, not a bridged variant with a different address, unless that
  bridged variant is genuinely what the wallets you care about trade
  against.

No other quote asset is fixed at $1 automatically -- only tokens explicitly
listed. Wrapped-native detection (treating a chain's `W<NATIVE_SYMBOL>`
quote asset the same as native for pricing) is automatic based on symbol
naming and does not need special-casing.

### Native, non-quote token metadata

For every non-quote token, `decimals()` and `symbol()` are read with
`eth_call` and cached permanently (they cannot change for a deployed
token). A token that reverts or returns garbage on either call has no
reliable unit conversion and is treated as unpriced and excluded -- same
rule as a token with no quote-asset counterparty.

## 3. FIFO cost basis

Within one token, lots are consumed first-in-first-out. A sell that spans
multiple buy lots is recorded as one realized trade with:

- `qty` = total units sold in that transaction
- `costUsd` = sum of each consumed lot's cost basis
- `proceedsUsd` = the sell's USD value
- `buyTimestamp` = the quantity-weighted average timestamp of the consumed
  lots (used for hold-time and behavioral metrics)

FIFO was chosen because it is the least assumption-laden convention and
matches how most tax jurisdictions default absent an election -- not
because it is guaranteed optimal for any individual wallet.

### Deposits, withdrawals, and airdrops

- A quote-asset deposit (the wallet receives WETH/USDC/USDT/DAI/ETH with
  no offsetting outflow in the same transaction) becomes a **capital
  flow**, valued in USD at the block's timestamp. The sum of all capital
  flows is the "starting capital" figure every benchmark is measured
  against.
- A non-quote token received the same way (an airdrop, or a plain
  transfer-in) is recorded as a deposit **at zero cost basis**. hindsight
  has no independent price source for an arbitrary token at an arbitrary
  receipt time, and zero is the only value it can assert without
  guessing. This means realized gains on a later sale of an airdropped
  token are overstated relative to whatever the recipient might argue its
  "fair value" was at receipt -- a known, deliberate simplification, and
  the reason `docs/benchmarks.md` and the README both flag it.
- A non-quote token sent away with nothing received in return (a transfer
  out, a burn, a bridge deposit with no tracked receipt) is recorded as a
  full realized loss of its remaining cost basis: money left, nothing
  came back, arithmetic does not need to know why.

## 4. Current price ("mark") for open positions

Unrealized PnL needs a "current price" for a token the wallet still
holds. hindsight has no live price oracle and adds no dependency to get
one. Instead, the **mark price is the wallet's own most recent observed
execution price for that token** -- the price implied by its last buy or
sell in the scanned range. This keeps the entire pricing model
self-consistent (everything comes from the wallet's own trades and the
bundled native/USD series) at the cost of being a lagging, not live,
figure: if the market moved after the wallet's last trade in that token,
unrealized PnL will not reflect it. `never sold` and `perfect exits` use
this same convention for their end-state valuation -- see
`docs/benchmarks.md`.

## 5. Where the numbers can be wrong -- a summary

- Depegs on USDC/USDT/DAI are not modeled; all three are fixed at $1.
- A wrong `decimals` value hand-configured for a quote asset silently
  scales every price against it.
- Non-quote token metadata that fails `eth_call` excludes that token
  entirely rather than guessing.
- Reverted transactions outside the bounded fee-sweep block cap are
  under-counted in `leaks`, with the report saying so.
- Value moved by an internal call (not a top-level `value` transfer, not a
  logged ERC-20 Transfer) is invisible.
- Airdropped/transferred-in non-quote tokens are valued at $0 on receipt,
  overstating their later realized gain.
- Unrealized PnL and the `never sold` / `perfect exits` benchmarks use the
  wallet's last observed trade price as a mark, not a live price.
- The native/USD series is daily; intraday moves are approximated by
  linear interpolation between the nearest two known days.
- Perpetuals, LP positions, staking, lending, and bridges are not modeled
  at all -- see the README's Limitations section.

None of this is a bug to be silently patched over with a guess. Every one
of these is a documented boundary: past it, hindsight excludes and counts
rather than invents a number.
