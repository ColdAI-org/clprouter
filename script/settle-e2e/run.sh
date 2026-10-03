#!/usr/bin/env bash
# End-to-end run of settle-on-Hedera across three local anvil chains:
#   Y (31001) the user pays · X (31002) the Connector delivers · H (31003) stands in for Hedera, holds the order book
# Each chain runs the unchanged reference ClprService. The Connector side is the reference Connector service
# (services/connector): it quotes, watches deposits, delivers, relays bundles and closes orders.
#
# TEST ONLY: every Channel uses the CLPR repo's E2EVerifier (decodes bundles, checks no proof) and the service's
# e2e-test-only relay. This shows the flow, gas and Hedera trace size, not verification.
#
# Scenarios: 1 delivered · 2 Connector misses the deadline, the user is paid from the bond on H
#            3 the delivery proof reaches H before the deposit proof (closeWithRecordedDelivery)
#
# Usage: script/settle-e2e/run.sh     (ports 18555-18557; override with PORT_Y/PORT_X/PORT_H)
# Needs: foundry (anvil, forge, cast), jq, node 22 and `pnpm install` in services/.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)

PORTS=("${PORT_Y:-18555}" "${PORT_X:-18556}" "${PORT_H:-18557}")
CHAIN_IDS=(31001 31002 31003)
NAMES=(Y X H)
RPCS=()
for p in "${PORTS[@]}"; do RPCS+=("http://127.0.0.1:$p"); done
export RPC_Y="${RPCS[0]}" RPC_X="${RPCS[1]}" RPC_H="${RPCS[2]}"

OUT=e2e-out/settle
rm -rf "$OUT" && mkdir -p "$OUT" .anvil
GAS=$OUT/gas.tsv
TRACE=$OUT/trace-size.txt
LOG=$OUT/run.log
: >"$LOG"
: >"$TRACE"
printf 'scenario\tstep\tchain\ttx\tgasUsed\n' >"$GAS"

PIDS=()
cleanup() { for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT

for i in 0 1 2; do
  anvil --port "${PORTS[$i]}" --chain-id "${CHAIN_IDS[$i]}" --hardfork osaka --silent >".anvil/settle-${NAMES[$i]}.log" 2>&1 &
  PIDS+=($!)
done
for i in 0 1 2; do
  until cast chain-id --rpc-url "${RPCS[$i]}" >/dev/null 2>&1; do sleep 0.2; done
done
echo "anvil Y/X/H up on ${PORTS[*]}"

# fs <chain index> <signature> [args...]: one forge script run that broadcasts to that chain only.
fs() {
  local here=$1
  shift
  forge script script/SettleE2E.s.sol:SettleE2E --rpc-url "${RPCS[$here]}" --broadcast --slow -g 200 \
    --sig "$@" 2>&1 | tee -a "$LOG"
}
block() { cast block-number --rpc-url "$1"; }
connector() { (cd services && node --import tsx connector/src/main.ts "$@" 2>>"$ROOT/$LOG"); }

# Record gasUsed of every transaction mined on chain $1 in blocks ($2, $3]; on H also its estimated trace size.
record() {
  local chain=$1 from=$2 to=$3 scen=$4 step=$5 rpc=${RPCS[$1]}
  for ((b = from + 1; b <= to; b++)); do
    for tx in $(cast block "$b" --json --rpc-url "$rpc" | jq -r '.transactions[]'); do
      g=$(cast receipt "$tx" gasUsed --rpc-url "$rpc")
      printf '%s\t%s\t%s\t%s\t%s\n' "$scen" "$step" "${NAMES[$chain]}" "$tx" "$g" >>"$GAS"
      if [ "$chain" = 2 ]; then
        printf '%s\t%s\t' "$scen" "$step" >>"$TRACE"
        node script/deploy/trace-size.mjs "$rpc" "$tx" >>"$TRACE" || { echo "trace size above 90% of Hedera's limit: $tx"; exit 1; }
      fi
    done
  done
}

# Run a step and record what it mined on every chain.
step() {
  local scen=$1 name=$2
  shift 2
  local b0 b1 b2
  b0=$(block "${RPCS[0]}"); b1=$(block "${RPCS[1]}"); b2=$(block "${RPCS[2]}")
  "$@"
  record 0 "$b0" "$(block "${RPCS[0]}")" "$scen" "$name"
  record 1 "$b1" "$(block "${RPCS[1]}")" "$scen" "$name"
  record 2 "$b2" "$(block "${RPCS[2]}")" "$scen" "$name"
}

warp_all() {
  for i in 0 1 2; do
    cast rpc evm_increaseTime "$1" --rpc-url "${RPCS[$i]}" >/dev/null
    cast rpc evm_mine --rpc-url "${RPCS[$i]}" >/dev/null
  done
}

echo "== deploy"
fs 2 'deployHub()' >/dev/null
fs 0 'deployChain(uint8)' 0 >/dev/null
fs 1 'deployChain(uint8)' 1 >/dev/null
for c in 0 1; do
  fs "$c" 'wireChannel(uint8,uint8)' "$c" "$c" >/dev/null
  fs 2 'wireChannel(uint8,uint8)' 2 "$c" >/dev/null
  fs "$c" 'wireConnector(uint8,uint8)' "$c" "$c" >/dev/null
  fs 2 'wireConnector(uint8,uint8)' 2 "$c" >/dev/null
done
step 0 sources fs 2 'proposeSources()' >/dev/null
warp_all 86401 # SOURCE_NOTICE
fs 2 'writeConfig()' >/dev/null
# The service resolves the store path from services/; make it absolute.
# Cap bundles at 3 messages so scenario 4's five deposits reach H in more than one bundle (partial bundles).
jq --arg s "$ROOT/$OUT/connector-store.json" '.store = $s | .relay.maxMessagesPerBundle = 3' "$OUT/connector.json" >"$OUT/connector.tmp" &&
  mv "$OUT/connector.tmp" "$OUT/connector.json"
CFG="$ROOT/$OUT/connector.json"
echo "   order book $(jq -r .orderBook "$OUT/L2.json") on H; Deposit/Delivery on Y and X"

step 0 bond connector bond --config "$CFG" post 50000000000000000000 >/dev/null

for n in 1 2 3; do
  echo "== scenario $n"
  fs 0 'request(uint8)' "$n" >/dev/null
  connector quote --config "$CFG" --request "$ROOT/$OUT/request-$n.json" --out "$ROOT/$OUT/quote-$n.json"
  echo "   quote $(jq -r .orderId "$OUT/quote-$n.json"): pay $(jq -r .quote.amountIn "$OUT/quote-$n.json") on Y for $(jq -r .quote.amountOut "$OUT/quote-$n.json") on X, owed on default $(jq -r .owedOnDefault "$OUT/quote-$n.json") on H"
  step "$n" deposit fs 0 'deposit(uint8)' "$n" >/dev/null
  case $n in
    1) args=() ;;
    2) args=(--skip-delivery all) ;;
    3) args=(--relay-order delivery-first) ;;
  esac
  step "$n" connector-run connector run --config "$CFG" --once "${args[@]}" | tee -a "$LOG" | sed 's/^/   connector: /'
  # A second pass picks up anything the first pass made relayable (acknowledgements).
  step "$n" connector-run-2 connector run --config "$CFG" --once "${args[@]}" >/dev/null
  if [ "$n" = 2 ]; then
    warp_all $((600 + 1800 + 60)) # past deadline + PROOF_GRACE
    step 2 claimDefault fs 2 'claim(uint8)' 2 >/dev/null
  fi
  fs 2 'check(uint8)' "$n" | grep -E 'CHECK_OK|  status|delivered on X|paid from bond' || { echo "scenario $n FAILED"; exit 1; }
done

echo "== scenario 4: five deposits at once, relayed in bundles of at most 3 messages"
BOOK=$(jq -r .orderBook "$OUT/L2.json")
for m in 41 42 43 44 45; do
  fs 0 'request(uint8)' "$m" >/dev/null
  connector quote --config "$CFG" --request "$ROOT/$OUT/request-$m.json" --out "$ROOT/$OUT/quote-$m.json"
  fs 0 'deposit(uint8)' "$m" >/dev/null
done
step 4 connector-run connector run --config "$CFG" --once | tee -a "$LOG" | sed 's/^/   connector: /'
step 4 connector-run-2 connector run --config "$CFG" --once | tee -a "$LOG" | sed 's/^/   connector: /'
step 4 connector-run-3 connector run --config "$CFG" --once >/dev/null
for m in 41 42 43 44 45; do
  st=$(cast call "$BOOK" 'orders(bytes32)(address,uint8,uint64,address,uint64,address,bytes32,bytes32,bytes32,uint256,uint256,uint256)' \
    "$(jq -r .orderId "$OUT/quote-$m.json")" --rpc-url "$RPC_H" | sed -n 2p)
  [ "$st" = 2 ] || { echo "batch order $m not delivered (status $st)"; exit 1; }
done
echo "  CHECK_OK scenario 4 (5 orders delivered)"

echo "== all scenarios passed; gas per transaction in $GAS, Hedera trace-size estimates in $TRACE"
column -t -s $'\t' "$GAS"
echo
cat "$TRACE"
