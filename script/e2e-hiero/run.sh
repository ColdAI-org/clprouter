#!/usr/bin/env bash
# CLPRouter end-to-end run THROUGH a local Hiero network:
#   A (anvil, eip155:31001) → H (Hiero Solo EVM, eip155:1338) → B (anvil, eip155:31002), receipt B → H → A.
#
# Needs the CLPR repo's Solo side B running (one Solo network, kind cluster clpr-solo-b-cluster); this script
# re-establishes its port-forwards and readiness checks through the CLPR harness (test/e2e-hiero/solo.ts) and
# funds the anvil deployer key on Solo from the deployment's ecdsa-alias test account. Local networks and the
# repos' test keys only.
#
# Every step is one `forge script` run against live chain state (one at a time). On H, transactions are legacy
# with the gas price floored at eth_gasPrice (Hedera rejects anything below it), and the gas limit is forge's
# estimate × 1.3 (Hedera charges at least 80% of the limit, and caps a transaction at 15M gas).
#
# Usage: script/e2e-hiero/run.sh
#   env: PORT_A/PORT_B (anvil, default 18545/18546), CLPR_REPO (default ~/clpr/clpr-smart-contracts),
#        HIERO_PROBE=0 to skip the Hiero state-proof probe at the end.
set -euo pipefail
trap 'echo "FAILED at run.sh line $LINENO (log: e2e-out/hiero/run.log)"' ERR
cd "$(dirname "$0")/../.."

CLPR_REPO="${CLPR_REPO:-$HOME/clpr/clpr-smart-contracts}"
export CLPR_REPO
TSX="$CLPR_REPO/node_modules/.bin/tsx"
PORT_A="${PORT_A:-18545}"
PORT_B="${PORT_B:-18546}"
export RPC_A="http://127.0.0.1:$PORT_A" RPC_B="http://127.0.0.1:$PORT_B" RPC_H="${RPC_H:-http://127.0.0.1:37547}"
MIRROR_H="${MIRROR_H:-http://127.0.0.1:39082}"
RPCS=("$RPC_A" "$RPC_H" "$RPC_B")
NAMES=(A H B)
HIERO_LIMIT=15000000

OUT=e2e-out/hiero
mkdir -p "$OUT" .anvil
GAS="$OUT/gas.tsv"
LOG="$OUT/run.log"
: >"$LOG"
printf 'step\tchain\ttx\tgasUsed(receipt)\tgasConsumed(Hiero)\tgasLimit\n' >"$GAS"

PIDS=()
cleanup() { for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT

# ── Solo (H) ────────────────────────────────────────────────────────────────
if [ "$(cast chain-id --rpc-url "$RPC_H" 2>/dev/null || true)" != "1338" ]; then
  echo "== Solo: port-forwards and readiness (CLPR harness)"
  "$TSX" test/e2e-hiero/solo.ts ready | tee -a "$LOG" | grep SOLO_READY
fi
DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PK")
"$TSX" test/e2e-hiero/solo.ts fund "$(tr 'A-F' 'a-f' <<<"$DEPLOYER")" >>"$LOG" 2>&1
H_GAS_PRICE=$(cast gas-price --rpc-url "$RPC_H")
echo "Solo H up: $RPC_H, gas price $H_GAS_PRICE weibar, deployer balance $(cast balance "$DEPLOYER" --rpc-url "$RPC_H" --ether) HBAR"
[ "$(cast nonce "$DEPLOYER" --rpc-url "$RPC_H")" = 0 ] || {
  echo "deployer already used on Solo H: libraries and the ClprRouterDeployer would not land at the anvil addresses (redeploy Solo)"
  exit 1
}

# ── anvil A and B ───────────────────────────────────────────────────────────
anvil --port "$PORT_A" --chain-id 31001 --hardfork osaka --silent >.anvil/hiero-A.log 2>&1 &
PIDS+=($!)
anvil --port "$PORT_B" --chain-id 31002 --hardfork osaka --silent >.anvil/hiero-B.log 2>&1 &
PIDS+=($!)
for r in "$RPC_A" "$RPC_B"; do until cast chain-id --rpc-url "$r" >/dev/null 2>&1; do sleep 0.2; done; done
echo "anvil A/B up on $PORT_A/$PORT_B"

# Per-chain transaction flags. H: legacy, gas price floored at eth_gasPrice, modest gas headroom.
# chain_flags <chain index> [create]: forge create spells the gas price flag --gas-price, forge script
# --with-gas-price.
chain_flags() {
  if [ "$1" = 1 ]; then
    if [ "${2:-}" = create ]; then echo "--legacy --gas-price $H_GAS_PRICE"; else echo "--legacy --with-gas-price $H_GAS_PRICE"; fi
  else
    echo ""
  fi
}

# The external libraries are deployed at the deployer's nonces 0 and 1 on every chain (fresh key on each), so
# they have the same addresses everywhere and one link setting serves all chains. deployStack then creates the
# ClprRouterDeployer at nonce 2, so it too has one address on A, H and B and every Router is canonical (Hedera derives the address
# of a contract created by an EthereumTransaction from sender and nonce, as Ethereum does; checked below).
CODEC=$(cast compute-address --nonce 0 "$DEPLOYER" | awk '{print $NF}')
LOGIC=$(cast compute-address --nonce 1 "$DEPLOYER" | awk '{print $NF}')
LIBS=(--libraries "src/libraries/RouteCodec.sol:RouteCodec:$CODEC" --libraries "src/libraries/RouteLogic.sol:RouteLogic:$LOGIC")
for i in 0 1 2; do
  # shellcheck disable=SC2046
  forge create src/libraries/RouteCodec.sol:RouteCodec "${LIBS[@]}" --rpc-url "${RPCS[$i]}" \
    --private-key "$DEPLOYER_PK" --broadcast $(chain_flags "$i" create) >>"$LOG" 2>&1
  # shellcheck disable=SC2046
  forge create src/libraries/RouteLogic.sol:RouteLogic "${LIBS[@]}" --rpc-url "${RPCS[$i]}" \
    --private-key "$DEPLOYER_PK" --broadcast $(chain_flags "$i" create) >>"$LOG" 2>&1
  [ "$(cast code "$LOGIC" --rpc-url "${RPCS[$i]}")" != "0x" ] || { echo "library deploy failed on ${NAMES[$i]}"; exit 1; }
done
echo "libraries: RouteCodec $CODEC, RouteLogic $LOGIC (same on A, H, B)"

# Record gas of every transaction of the last forge script run on chain $1 (from its broadcast file).
# On H also the mirror node's gas_consumed (what the EVM actually used; Hedera's receipt gasUsed is at least
# 80% of the gas limit) and the gas limit, both checked against the 15M per-transaction limit.
record_gas() {
  local chain=$1 step=$2 cid file
  cid=$(cast chain-id --rpc-url "${RPCS[$chain]}")
  file=$(ls -t broadcast/E2EHiero.s.sol/"$cid"/*-latest.json 2>/dev/null | head -1)
  [ -n "$file" ] || return 0
  jq -r '.receipts[] | "\(.transactionHash) \(.gasUsed)"' "$file" | while read -r tx gu; do
    local used consumed="-" limit="-"
    used=$(printf '%d' "$gu")
    if [ "$chain" = 1 ]; then
      local res
      res=$(curl -s "$MIRROR_H/api/v1/contracts/results/$tx")
      consumed=$(jq -r '.gas_consumed // "-"' <<<"$res")
      limit=$(jq -r '.gas_limit // "-"' <<<"$res")
      if [ "$limit" != "-" ] && [ "$limit" -gt "$HIERO_LIMIT" ]; then echo "   !! $step on H: gas limit $limit > 15M"; fi
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$step" "${NAMES[$chain]}" "$tx" "$used" "$consumed" "$limit" >>"$GAS"
  done
  rm -f "$file"
}

# fs <chain index> <step label> <signature> [args...]: one forge script run that broadcasts to that chain only.
fs() {
  local here=$1 step=$2
  shift 2
  local gmul=200
  [ "$here" = 1 ] && gmul=130
  # shellcheck disable=SC2046
  forge script script/e2e-hiero/E2EHiero.s.sol:E2EHiero "${LIBS[@]}" --rpc-url "${RPCS[$here]}" --broadcast --slow \
    -g "$gmul" $(chain_flags "$here") --sig "$@" 2>&1 | tee -a "$LOG"
  record_gas "$here" "$step"
}

echo "== deploy"
for i in 0 1 2; do fs "$i" deploy 'deployStack(uint8)' "$i" | grep -E '^  (router|service)' || true; done
for s in 0 1 2; do
  f="$OUT/L$s.json"
  for k in service deployer router app; do
    a=$(jq -r ".$k" "$f")
    [ "$(cast code "$a" --rpc-url "${RPCS[$s]}")" != "0x" ] || { echo "no code for $k at $a on ${NAMES[$s]}"; exit 1; }
  done
done
fs 0 wire 'wireChannel(uint8,uint8)' 0 1 >/dev/null
fs 1 wire 'wireChannel(uint8,uint8)' 1 0 >/dev/null
fs 1 wire 'wireChannel(uint8,uint8)' 1 2 >/dev/null
fs 2 wire 'wireChannel(uint8,uint8)' 2 1 >/dev/null
fs 0 wire 'wireConnector(uint8,uint8)' 0 1 >/dev/null
fs 1 wire 'wireConnector(uint8,uint8)' 1 0 >/dev/null
fs 1 wire 'wireConnector(uint8,uint8)' 1 2 >/dev/null
fs 2 wire 'wireConnector(uint8,uint8)' 2 1 >/dev/null
echo "   channels A-H and H-B open, connectors registered"

echo "== route A → H → B"
fs 0 send-A 'send(uint8)' 0 >/dev/null
DIRS=("0 1" "1 2" "2 1" "1 0")
for pass in 1 2 3 4 5 6; do
  moved=0
  for d in "${DIRS[@]}"; do
    read -r s t <<<"$d"
    out=$(fs "$t" "relay-${NAMES[$s]}${NAMES[$t]}" 'relay(uint8,uint8)' "$s" "$t")
    if grep -q 'RELAY_BUNDLES 1' <<<"$out"; then
      moved=1
      echo "   relay ${NAMES[$s]}->${NAMES[$t]}: $(grep -o 'RELAY_MESSAGES [0-9]*' <<<"$out") $(grep -o 'RELAY_PUMPED [0-9]*' <<<"$out")"
    fi
  done
  [ "$moved" = 0 ] && break
done
fs 0 check 'check()' | grep -E 'CHECK_OK|^  ' || { echo "route FAILED"; exit 1; }

echo "== gas per transaction ($GAS)"
column -t -s $'\t' "$GAS"
echo "== Hiero steps vs the 15M per-transaction limit (gas consumed by the EVM / gas limit sent)"
awk -F'\t' '$2=="H" && $1!="deploy" && $1!="wire" {printf "   %-12s consumed %9s  limit %9s  (%.1f%% of 15M)\n", $1, $5, $6, 100*$5/15000000}' "$GAS"

if [ "${HIERO_PROBE:-1}" = 1 ]; then
  echo "== Hiero → EVM proof probe (what a real HieroVerifier on B or A would need)"
  info=$(forge script script/e2e-hiero/E2EHiero.s.sol:E2EHiero "${LIBS[@]}" --rpc-url "$RPC_H" --sig 'info()' 2>&1)
  svc=$(awk '/H_SERVICE/{print $2}' <<<"$info")
  ch=$(grep -A1 'H_CH_HB' <<<"$info" | tail -1 | tr -d ' ')
  "$TSX" test/e2e-hiero/solo.ts proof-probe "$svc" "$ch" 1 1 2>&1 | tee -a "$LOG" | grep -E 'step|PROOF_|    '
fi
echo "== done"
