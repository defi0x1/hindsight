# Contributing

hindsight has one job: reconstruct what a wallet actually did, and compare it
honestly against a few deterministic counterfactuals. Contributions that keep
it small, correct, and dependency-free are welcome.

## Ground rules

- Zero runtime dependencies. If a change needs a package, it probably belongs
  in a different tool. Talk to the RPC endpoint with `fetch`, nothing else.
- No per-program instruction decoders. Trades are reconstructed from balance
  deltas (`preTokenBalances` / `postTokenBalances`). This is what makes the
  tool work against DEXes that do not exist yet. Do not special-case a
  program ID.
- Every number in the report must be traceable to arithmetic over on-chain
  data. If you are adding something a model would have to guess, it does not
  belong in the numbers.
- No emoji, no hype adjectives, in code, docs, comments, or CLI output.

## Setup

```
git clone https://github.com/defi0x1/hindsight
cd hindsight
npm install
npm run build
node --test dist/tests
```

`hindsight demo` runs the full pipeline offline against the bundled fixture
in `fixtures/demo/`. Use it to sanity-check any change before touching a real
wallet.

## Making a change

1. Open an issue first for anything beyond a small fix, so the approach can
   be discussed before code is written.
2. Add or update a test under `tests/` for any change to `src/`. The test
   suite runs against compiled output (`node --test dist/tests`), so build
   before testing.
3. Run `tests/smoke.sh` before opening a pull request. CI runs the same
   script on Node 20, 22, and 24, on Linux and macOS.
4. Keep pull requests scoped to one behavior change. Explain the "why" in
   the description, not just the diff.

## Reporting bugs

Use the bug report template. Include the wallet address if the bug is
data-dependent (public addresses only — never a private key or seed phrase,
and hindsight will never ask for one).

## What is out of scope for v1

- Perpetuals, LP positions, staking, lending, cross-chain flows.
- Sandwich detection. There is a stub for it in `src/leaks.ts`; do not fill
  it in with a heuristic that cannot be defended in the docs.
- Any code path that signs a transaction or requests a private key.

See `docs/how-pnl-is-computed.md` and `docs/benchmarks.md` before changing
anything in `src/positions.ts`, `src/pricing.ts`, or `src/benchmarks.ts` —
those documents are the specification, and they should be updated in the
same pull request if the behavior changes.
