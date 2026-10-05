#!/usr/bin/env bash
# End-to-end run of CLPRouter across three local anvil chains A (31001) — B (31002) — C (31003),
# using the unchanged reference ClprService and the CLPR repo's E2EVerifier.
#
# Every step is one `forge script` run against live chain state (run one at a time):
#   deploy · scenario n · relay src→dst (endpoint + permissionless pumper) · check n
#
# Scenarios: 1 delivered (escrow released, receipt back) · 2 destination app reverts → FAILED
#            3 edge B→C disabled mid-route → FAILED · 4 recipient blacklisted on B → QUARANTINED
#            5 deadline passes before B → EXPIRED
#
# Usage: script/e2e/run.sh            (ports 18545-18547; override with PORT_A/PORT_B/PORT_C)
set -euo pipefail
cd "$(dirname "$0")/../.."

PORTS=("${PORT_A:-18545}" "${PORT_B:-18546}" "${PORT_C:-18547}")
CHAIN_IDS=(31001 31002 31003)
NAMES=(A B C)
RPCS=()
for p in "${PORTS[@]}"; do RPCS+=("http://127.0.0.1:$p"); done
export RPC_A="${RPCS[0]}" RPC_B="${RPCS[1]}" RPC_C="${RPCS[2]}"

mkdir -p e2e-out .anvil
GAS=e2e-out/gas.tsv
LOG=e2e-out/run.log
: >"$LOG"
printf 'scenario\tstep\tchain\ttx\tgasUsed\n' >"$GAS"

PIDS=()
cleanup() { for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT

for i in 0 1 2; do
  anvil --port "${PORTS[$i]}" --chain-id "${CHAIN_IDS[$i]}" --hardfork osaka --silent >".anvil/${NAMES[$i]}.log" 2>&1 &
  PIDS+=($!)
done
for i in 0 1 2; do
  until cast chain-id --rpc-url "${RPCS[$i]}" >/dev/null 2>&1; do sleep 0.2; done
done
echo "anvil A/B/C up on ${PORTS[*]}"

# The ClprRouterDeployer is created through the deterministic-deployment proxy, so it has one address on A, B
# and C. Recent anvils pre-install the proxy; install its runtime code where it is missing.
CREATE2_PROXY=0x4e59b44847b379578588920ca78fbf26c0b4956c
CREATE2_PROXY_CODE=0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3
for i in 0 1 2; do
  if [ "$(cast code "$CREATE2_PROXY" --rpc-url "${RPCS[$i]}")" = "0x" ]; then
    cast rpc anvil_setCode "$CREATE2_PROXY" "$CREATE2_PROXY_CODE" --rpc-url "${RPCS[$i]}" >/dev/null
  fi
done

# Multi-chain forge scripts cannot link libraries, so the two external libraries are deployed first at the
# deployer's nonces 0 and 1 on every (fresh) chain — the same addresses everywhere — and linked explicitly.
DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PK")
CODEC=$(cast compute-address --nonce 0 "$DEPLOYER" | awk '{print $NF}')
LOGIC=$(cast compute-address --nonce 1 "$DEPLOYER" | awk '{print $NF}')
LIBS=(--libraries "src/libraries/RouteCodec.sol:RouteCodec:$CODEC" --libraries "src/libraries/RouteLogic.sol:RouteLogic:$LOGIC")
for i in 0 1 2; do
  forge create src/libraries/RouteCodec.sol:RouteCodec "${LIBS[@]}" --rpc-url "${RPCS[$i]}" --private-key "$DEPLOYER_PK" --broadcast >>"$LOG" 2>&1
  forge create src/libraries/RouteLogic.sol:RouteLogic "${LIBS[@]}" --rpc-url "${RPCS[$i]}" --private-key "$DEPLOYER_PK" --broadcast >>"$LOG" 2>&1
  [ "$(cast code "$LOGIC" --rpc-url "${RPCS[$i]}")" != "0x" ] || { echo "library deploy failed on ${NAMES[$i]}"; exit 1; }
done
echo "libraries: RouteCodec $CODEC, RouteLogic $LOGIC"

# fs <chain index> <signature> [args...]: one forge script run that broadcasts to that chain only.
fs() {
  local here=$1
  shift
  forge script script/E2E.s.sol:E2E "${LIBS[@]}" --rpc-url "${RPCS[$here]}" --broadcast --slow -g 200 \
    --sig "$@" 2>&1 | tee -a "$LOG"
}
block() { cast block-number --rpc-url "$1"; }

# Record gasUsed of every transaction mined on chain $1 in blocks ($2, $3].
record_gas() {
  local chain=$1 from=$2 to=$3 scen=$4 step=$5 rpc=${RPCS[$1]}
  for ((b = from + 1; b <= to; b++)); do
    for tx in $(cast block "$b" --json --rpc-url "$rpc" | jq -r '.transactions[]' | sed 's/"//g'); do
      g=$(cast receipt "$tx" gasUsed --rpc-url "$rpc")
      printf '%s\t%s\t%s\t%s\t%s\n' "$scen" "$step" "${NAMES[$chain]}" "$tx" "$g" >>"$GAS"
    done
  done
}

echo "== deploy"
for i in 0 1 2; do fs "$i" 'deployStack(uint8)' "$i" >/dev/null; done
# One deployer address everywhere, so every Router is at its canonical address.
[ "$(jq -r .deployer e2e-out/L0.json)" = "$(jq -r .deployer e2e-out/L1.json)" ] &&
  [ "$(jq -r .deployer e2e-out/L1.json)" = "$(jq -r .deployer e2e-out/L2.json)" ] || { echo "deployer addresses differ"; exit 1; }
echo "   ClprRouterDeployer $(jq -r .deployer e2e-out/L0.json) on A, B and C; vaults bound to their Routers"
fs 0 'wireChannel(uint8,uint8)' 0 1 >/dev/null
fs 1 'wireChannel(uint8,uint8)' 1 0 >/dev/null
fs 1 'wireChannel(uint8,uint8)' 1 2 >/dev/null
fs 2 'wireChannel(uint8,uint8)' 2 1 >/dev/null
fs 0 'wireConnector(uint8,uint8)' 0 1 >/dev/null
fs 1 'wireConnector(uint8,uint8)' 1 0 >/dev/null
fs 1 'wireConnector(uint8,uint8)' 1 2 >/dev/null
fs 2 'wireConnector(uint8,uint8)' 2 1 >/dev/null
DIRS=("0 1" "1 2" "2 1" "1 0")

for n in 1 2 3 4 5; do
  echo "== scenario $n"
  if [ "$n" = 2 ]; then fs 2 'setAppRevert(uint8,bool)' 2 true >/dev/null; fi
  if [ "$n" = 3 ]; then fs 2 'setAppRevert(uint8,bool)' 2 false >/dev/null; fi
  a0=$(block "${RPCS[0]}")
  fs 0 'send(uint8,uint8)' 0 "$n" >/dev/null
  record_gas 0 "$a0" "$(block "${RPCS[0]}")" "$n" send
  if [ "$n" = 3 ] || [ "$n" = 4 ]; then fs 1 'decide(uint8,uint8)' 1 "$n" >/dev/null; fi
  if [ "$n" = 5 ]; then
    for i in 1 2; do
      cast rpc evm_increaseTime 120 --rpc-url "${RPCS[$i]}" >/dev/null
      cast rpc evm_mine --rpc-url "${RPCS[$i]}" >/dev/null
    done
  fi
  for pass in 1 2 3 4 5 6; do
    moved=0
    for d in "${DIRS[@]}"; do
      read -r s t <<<"$d"
      b0=$(block "${RPCS[$t]}")
      out=$(fs "$t" 'relay(uint8,uint8)' "$s" "$t")
      if grep -q 'RELAY_BUNDLES 1' <<<"$out"; then
        moved=1
        record_gas "$t" "$b0" "$(block "${RPCS[$t]}")" "$n" "relay-${NAMES[$s]}${NAMES[$t]}"
        echo "   relay ${NAMES[$s]}->${NAMES[$t]}: $(grep -o 'RELAY_MESSAGES [0-9]*' <<<"$out") $(grep -o 'RELAY_PUMPED [0-9]*' <<<"$out")"
      fi
    done
    [ "$moved" = 0 ] && break
  done
  fs 0 'check(uint8)' "$n" | grep -E 'CHECK_OK|  status|vault on A' || { echo "scenario $n FAILED"; exit 1; }
done

echo "== all scenarios passed; gas per transaction in $GAS"
if command -v column >/dev/null; then column -t -s $'\t' "$GAS"; else cat "$GAS"; fi
