#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# One real settle-on-Hedera order on the testnet deployment (settle.sh), driven step by step:
#
#   script/deploy/settle-order.sh check                       is the order book ready? (source active, Channel anchor
#                                                             = current Sepolia period, bond, CLPR connector funds)
#   script/deploy/settle-order.sh quote <label> <amountOutWei> [deadlineS]
#                                                             signed quote from the local Connector service (serve)
#   script/deploy/settle-order.sh deposit <label> [--broadcast]  SettleDeposit.deposit on Sepolia (deployer = user)
#   script/deploy/settle-order.sh deliver [orderId-to-skip] [--broadcast]
#                                                             one Connector pass: delivers the deposits it should
#                                                             (SettleDelivery on Sepolia), skips the given order
#   script/deploy/settle-order.sh relay [--broadcast]          prove every pending Sepolia message of the Channel to
#                                                             Hedera (EthMainnetVerifier bundle) and submitBundle
#   script/deploy/settle-order.sh status <label>               the order on the order book
#   script/deploy/settle-order.sh claim <label> [--broadcast]  claimDefault after deadline + PROOF_GRACE
#
# Delivered order:  quote a → deposit a → deliver → relay → status a (DELIVERED)
# Missed deadline:  quote b <amt> 480 → deposit b → deliver <id b> → relay → (wait) → claim b → status b (DEFAULTED)
#
# Keys: deployer (the paying user) from ~/clpr/.env; the Connector's keys stay in the service. Budget and the
# shared-key pending-nonce guard of settle.sh apply; every broadcast is recorded in deployments/<network>.json.
set -euo pipefail

CMD="${1:?usage: settle-order.sh <check|quote|deposit|deliver|relay|status|claim> ...}"
shift
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
D="$ROOT/script/deploy"
SETTLE="$D/settle.sh"
ORD="$D/.build/orders"
mkdir -p "$ORD"
set -a
# shellcheck disable=SC1090
. "${CLPR_ENV_FILE:-$HOME/clpr/.env}"
set +a
cfgj() { python3 -c "import json,functools; print(functools.reduce(lambda d,k: d[k], '$1'.split('.'), json.load(open('$2'))))"; }
SVC_CFG="$ROOT/services/connector/config.testnet.json"
OB="$(cfgj hedera.orderBook "$SVC_CFG")"
DEPOSIT="$(python3 -c "import json; print(json.load(open('$SVC_CFG'))['chains'][0]['deposit'])")"
CH="$(python3 -c "import json; print(json.load(open('$SVC_CFG'))['chains'][0]['channelId'])")"
SVC=0xa6db474e3047c3d43b10a4ff7abad547d89982b9
CLPR_CONN="$(cfgj settle.contracts.SettleTestnetConnector.address "$ROOT/deployments/hedera-testnet.json")"
H="$HEDERA_TESTNET_RPC_URL"; S="$SEPOLIA_RPC_URL"
broadcast() { [[ " $* " == *" --broadcast "* ]]; }
hash_of() { python3 -c 'import json,sys; print(json.load(sys.stdin)["transactionHash"])'; }
record() { RECORD_STEP="order-$1" "$SETTLE" record-cast - "${@:2}"; }
order_id() { python3 -c "import json; print(json.load(open('$ORD/$1.json'))['orderId'])"; }

case "$CMD" in
    check)
        now="$(cast block latest -f timestamp --rpc-url "$H")"
        read -r ledger _ _ active < <(cast call "$OB" "sources(bytes32)(bytes32,bytes32,bytes32,uint64)" "$CH" --rpc-url "$H" | awk '{print $1}' | tr '\n' ' '; echo)
        echo "source for Sepolia: active at $active (Hedera now $now) → $([[ "$ledger" != 0x0000000000000000000000000000000000000000000000000000000000000000 && $now -ge $active ]] && echo READY || echo NOT YET)"
        python3 - "$now" <<'EOF'
import sys, time
g = 1655733600
slot = (int(time.time()) - g) // 12
print(f"Sepolia sync-committee period now {slot // 8192} (next boundary in {(8192 - slot % 8192) * 12 / 3600:.1f} h)")
EOF
        echo "test Connector free bond: $(cast call "$OB" "freeCapacity(address,address)(uint256)" 0x316323692104293b58366e6Bc66a796B919108E7 0x0000000000000000000000000000000000000000 --rpc-url "$H") tinybar"
        echo "settle CLPR connector on Hedera: $(cast balance --ether "$CLPR_CONN" --rpc-url "$H") HBAR for inbound execution"
        echo "test Connector on Sepolia: $(cast balance --ether 0x316323692104293b58366e6Bc66a796B919108E7 --rpc-url "$S") ETH"
        echo "Channel anchor (a bundle for a current header must verify; dry run, nothing sent):"
        B="$(cast block-number --rpc-url "$S")"
        (cd "$D" && npx tsx relay/eth-bundle.ts --channel "$CH" --min-block "$((B - 64))" --out "$ORD/check-bundle.env" 2>&1 | tail -2) \
            && echo "Channel LIVE (proof pre-flight accepted on Hedera)" || echo "Channel NOT LIVE"
        ;;
    quote)
        label="${1:?label}"; amt="${2:?amountOut in wei}"; dl="${3:-}"
        me="$CLPR_TESTNET_ADDRESS"
        body="{\"srcLedger\":\"eip155:11155111\",\"assetIn\":\"0x0000000000000000000000000000000000000000\",\"dstLedger\":\"eip155:11155111\",\"assetOut\":\"0x0000000000000000000000000000000000000000\",\"amountOut\":\"$amt\",\"recipient\":\"$me\",\"user\":\"$me\",\"refundTo\":\"$me\""
        if [[ -n "$dl" ]]; then body="$body,\"deadline\":$(( $(cast block latest -f timestamp --rpc-url "$S") + dl ))"; fi
        curl -sf -X POST 127.0.0.1:8787/quote -H 'content-type: application/json' -d "$body}" > "$ORD/$label.json"
        python3 -c "import json; q=json.load(open('$ORD/$label.json')); print('order', q['orderId'], 'amountIn', q['quote']['amountIn'], 'expiry', q['quote']['expiry'], 'deadline', q['quote']['deadline'], 'owedOnDefault', q['owedOnDefault'])"
        ;;
    deposit)
        label="${1:?label}"
        args="$(python3 - "$ORD/$label.json" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1])); q = r["quote"]
f = ["connector","srcLedger","depositApp","user","payTo","assetIn","amountIn","dstLedger","assetOut","recipient","amountOut","coverAsset","coverAmount","refundTo","issuedAt","expiry","deadline","salt"]
print("(" + ",".join(str(q[k]) for k in f) + ")", r["signature"], q["amountIn"])
EOF
)"
        read -r tuple sig value <<< "$args"
        SIG="deposit((address,bytes32,bytes32,bytes32,bytes32,bytes32,uint256,bytes32,bytes32,bytes32,uint256,address,uint256,address,uint64,uint64,uint64,bytes32),bytes)"
        cast call "$DEPOSIT" "$SIG" "$tuple" "$sig" --value "$value" --from "$CLPR_TESTNET_ADDRESS" --rpc-url "$S" > /dev/null && echo "deposit pre-flight ok (eth_call)"
        broadcast "$@" || exit 0
        STEP_MAX_ETH=0.0025 "$SETTLE" budget-sepolia
        h="$(cast send "$DEPOSIT" "$SIG" "$tuple" "$sig" --value "$value" --private-key "$CLPR_TESTNET_PRIVATE_KEY" \
            --gas-price "${SEPOLIA_MAX_FEE_WEI:-1250000000}" --priority-gas-price "${SEPOLIA_TIP_WEI:-1000000}" --rpc-url "$S" --json | hash_of)"
        echo "DEPOSITED $h"
        record "$label" sepolia SettleDeposit "deposit(order $(order_id "$label"))" "$h"
        ;;
    deliver)
        skip=(); [[ "${1:-}" =~ ^0x[0-9a-fA-F]{64}$ ]] && skip=(--skip-delivery "$1")
        broadcast "$@" || { echo "(dry) would run one Connector pass ${skip[*]}"; exit 0; }
        "$D/settle-connector.sh" run --once "${skip[@]}" | tee "$ORD/deliver-$(date +%s).json"
        ;;
    relay)
        B="$(cast block-number --rpc-url "$S")"
        (cd "$D" && npx tsx relay/eth-bundle.ts --channel "$CH" --min-block "$B" --out "$ORD/bundle.env")
        set -a; . "$ORD/bundle.env"; set +a
        gas="$(cast estimate "$SVC" "submitBundle(bytes32,bytes)" "$CH" "$BUNDLE_PROOF" --from "$CLPR_TESTNET_ADDRESS" --rpc-url "$H")"
        limit=$(( gas * ${GAS_MULT:-200} / 100 ))
        echo "submitBundle estimate $gas gas, limit $limit"
        broadcast "$@" || exit 0
        "$SETTLE" budget-hedera
        h="$(cast send "$SVC" "submitBundle(bytes32,bytes)" "$CH" "$BUNDLE_PROOF" --gas-limit "$limit" --legacy \
            --private-key "$CLPR_TESTNET_PRIVATE_KEY" --rpc-url "$H" --json | hash_of)"
        echo "SUBMITTED $h"
        record relay hedera-testnet ClprService "submitBundle(bytes32,bytes) settle messages" "$h"
        ;;
    status)
        id="$(order_id "${1:?label}")"
        cast call "$OB" "orders(bytes32)(address,uint8,uint64,address,uint64,address,bytes32,bytes32,bytes32,uint256,uint256,uint256)" "$id" --rpc-url "$H" \
            | sed -n 2p | awk '{split("NONE OPEN DELIVERED DEFAULTED CANCELLED REJECTED", s, " "); print "order status", s[$1 + 1]}'
        ;;
    claim)
        label="${1:?label}"; id="$(order_id "$label")"
        cast call "$OB" "claimDefault(bytes32)" "$id" --from "$CLPR_TESTNET_ADDRESS" --rpc-url "$H" > /dev/null && echo "claim pre-flight ok"
        broadcast "$@" || exit 0
        "$SETTLE" budget-hedera
        h="$(cast send "$OB" "claimDefault(bytes32)" "$id" --legacy --private-key "$CLPR_TESTNET_PRIVATE_KEY" --rpc-url "$H" --json | hash_of)"
        echo "CLAIMED $h"
        record "$label" hedera-testnet SettleOrderBook "claimDefault(order $id)" "$h"
        ;;
    *) echo "unknown command $CMD" >&2; exit 1 ;;
esac
