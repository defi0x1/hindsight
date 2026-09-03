# The four benchmarks

Every benchmark starts from the same number: **capital deployed**, the sum
of every quote-asset deposit hindsight found, each valued in USD at the
moment it landed in the wallet (see `docs/how-pnl-is-computed.md` for how
a deposit is detected). All four rows in the report compare an end-state
USD value against that same starting figure, so they are directly
comparable to each other.

Source: `src/benchmarks.ts`.

## 1. actual

What really happened, converted to USD:

```
actual_end = capital_deployed
           + realized PnL (sum across every closed position)
           + unrealized PnL (sum across every open position, marked at
             each token's own last observed trade price)
           - total gas fees paid (successful and failed transactions both)
```

This is the only row that reflects real trading fees and real execution
prices. Every other row is a counterfactual: same capital, different
decisions, same fee treatment where fees would still apply (native
transfers/deposits are fee-free in every row; `actual` is the only row
that reflects gas spent on *trading*, since the counterfactuals below
assume the wallet made a different set of trades, or none).

## 2. if you had held `<NATIVE>`

What the same capital would be worth if, instead of trading, it had been
converted to the chain's native asset at the moment each deposit landed,
and held untouched to the report's end date:

```
hodl_end = sum over each deposit of:
    (deposit_usd / native_usd_price_at_deposit_time) * native_usd_price_at_end
```

Each deposit is converted independently at its own timestamp -- a wallet
that deposited in three different months gets three different entry
prices, summed. This is the benchmark most people ask first ("was trading
even worth it, versus just holding?"), which is why it is the first
counterfactual in the report.

## 3. if you never sold

Every buy, held to the report's end date; every sell, reversed:

```
never_sold_end = leftover_cash + sum over every token ever bought of:
    total_units_ever_bought * that_token's_mark_price
```

`leftover_cash` is capital that was deposited but never spent on a buy
(`max(0, capital_deployed - total_buy_cost)`) -- it carries forward
unchanged, same as it does in `actual`. The mark price is the same
last-observed-trade convention used for unrealized PnL: if the wallet
never sold in reality, its own last **buy** price is what's available; if
it did sell in reality but this counterfactual pretends it didn't, the
real sell still counts as a valid price observation for that token, since
it's a genuine on-chain execution price, just one this counterfactual
assumes the wallet didn't act on.

This benchmark answers "how much of the realized loss came from selling
early, versus the token just being a bad bet regardless?" -- a wallet
where `never sold` is *worse* than `actual` was right to sell.

## 4. perfect exits -- a ceiling, not a target

Every unit ever bought, sold at the highest price this wallet's own trade
history ever observed for that token:

```
perfect_exits_end = leftover_cash + sum over every token ever bought of:
    total_units_ever_bought * max_price_this_wallet_ever_saw_for_that_token
```

**This number is not achievable and is not a goal.** It is bounded by
prices the wallet's own transactions happened to observe within the
scanned range -- not a true all-time high, not an intraday high, not a
number from any external source. A wallet that only ever bought a token
once and never saw it trade again will show `perfect_exits` identical to
`never_sold` for that token, because there is no second price point to
be better than. It exists to answer one question only: *given exactly the
tokens this wallet chose, and exactly the prices it happened to trade at,
how much of the gap between "actual" and "ideal" was decision-making
versus token selection?* The report labels it explicitly --
`(the ceiling, not a target)` -- everywhere it appears, in the CLI output,
the share card, and here. Do not read it as a return you could have
gotten. You could not have.

## "you left $X on the table"

The report's headline number is the gap between what actually happened
and the better of the two **realistic** counterfactuals (`hodl <NATIVE>`
and `never sold` -- `perfect exits` is deliberately excluded from this
comparison, for the reason above):

```
money_left_on_table = max(hodl_end, never_sold_end) - actual_end
```

If `actual` beat both realistic alternatives, this number is negative or
near zero, and the honest reading is that the wallet's trading added
value over the alternatives shown -- the report does not hide that case,
it just won't be a very quotable headline.
