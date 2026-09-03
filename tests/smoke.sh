#!/usr/bin/env bash
# End-to-end smoke test: build, unit tests, offline demo. CI calls this
# directly (see .github/workflows/test.yml). No network access is required
# for any step here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== npm install =="
npm install

echo "== npm run build =="
npm run build

echo "== node --test =="
node --test dist/tests/*.test.js

echo "== hindsight demo =="
rm -rf .hindsight
DEMO_OUTPUT="$(node dist/src/cli.js demo)"
echo "$DEMO_OUTPUT"
echo "$DEMO_OUTPUT" | grep -q "HINDSIGHT ·" || { echo "smoke: demo output missing header"; exit 1; }
echo "$DEMO_OUTPUT" | grep -q "PATTERN" || { echo "smoke: demo output missing PATTERN block"; exit 1; }
echo "$DEMO_OUTPUT" | grep -q "unpriced and excluded" || { echo "smoke: demo output missing position summary"; exit 1; }

echo "== hindsight leaks (demo wallet) =="
node dist/src/cli.js leaks 0x00000000000000000000000000000000dec0de01 | grep -q "failed txs" \
  || { echo "smoke: leaks output missing failed txs line"; exit 1; }

echo "== hindsight positions (demo wallet) =="
node dist/src/cli.js positions 0x00000000000000000000000000000000dec0de01 | grep -q "TOKEN" \
  || { echo "smoke: positions output missing table header"; exit 1; }

echo "== hindsight demo --card =="
CARD_PATH="$(mktemp -d)/card.html"
node dist/src/cli.js demo --card "$CARD_PATH" > /dev/null
[ -s "$CARD_PATH" ] || { echo "smoke: card file was not written"; exit 1; }
if grep -qE 'https?://' "$CARD_PATH"; then
  echo "smoke: card references an external URL, must be fully self-contained"
  grep -nE 'https?://' "$CARD_PATH"
  exit 1
fi
echo "card written to $CARD_PATH ($(wc -c < "$CARD_PATH") bytes)"

echo "== hindsight doctor =="
node dist/src/cli.js doctor || echo "doctor: non-zero exit is fine offline (no network / no RPC in CI sandbox is expected in some environments)"

echo "smoke: all checks passed"
