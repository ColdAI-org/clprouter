#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Settle on Hedera on the public testnets: SettleOrderBook on Hedera testnet, SettleDeposit + SettleDelivery on
# Sepolia (both legs of the demo on Sepolia), over the Sepolia -> Hedera Channel of route.sh, plus a test
# Connector with a small HBAR bond.
#
#   script/deploy/settle.sh <step> [--broadcast]
#
# Steps (each idempotent, one chain each; without --broadcast forge steps only simulate on a fork):
#   order-book              SettleOrderBook on Hedera (CREATE2)
#   sepolia                 SettleDeposit + SettleDelivery on Sepolia (CREATE2, bound to the order book's address)
#   source                  proposeSource(Channel, Sepolia, deposit, delivery) on the order book (active after
#                           SOURCE_NOTICE = 1 day)
#   clpr-connector-hedera   SettleTestnetConnector on Hedera, registered on the Channel, funded for inbound execution
#   clpr-connector-sepolia  SettleTestnetConnector on Sepolia allowing both settle contracts, registered (locked stake)
#   connector-fund          send accountFundingHbar to the test Connector's account on Hedera
#   connector-register      register(signer) + postBond(HBAR, bondTinybar) from the test Connector's account
#   status-hedera | status-sepolia
#
# Keys: CLPR_TESTNET_PRIVATE_KEY from ~/clpr/.env (deployer, order-book admin); the test Connector account, its quote
# signer and the settle CLPR connector key from deployments/.local/settle-keys.secret.json (git-excluded). Keys reach
# forge and cast through the environment only and are never printed.
#
# Budget (config/settle.json .budget): broadcasts stop once the settle steps recorded in deployments/<network>.json
# reach 25 HBAR / 0.002 ETH, and a Sepolia step refuses to run if it could leave less than 0.003 ETH
# (STEP_MAX_ETH, the step's worst-case cost, default 0.002).
set -euo pipefail

STEP="${1:?usage: settle.sh <step> [--broadcast]}"
BROADCAST="${2:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
D="$ROOT/script/deploy"
ENV_FILE="${CLPR_ENV_FILE:-$HOME/clpr/.env}"
KEYS="$ROOT/deployments/.local/settle-keys.secret.json"
DEP="${DEPLOYMENTS_DIR:-$ROOT/deployments}"
export DEPLOYMENTS_DIR="$DEP"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
: "${CLPR_TESTNET_PRIVATE_KEY:?}" "${CLPR_TESTNET_ADDRESS:?}" "${SEPOLIA_RPC_URL:?}" "${HEDERA_TESTNET_RPC_URL:?}"

key() { python3 -c "import json; print(json.load(open('$KEYS'))['$1']['$2'])"; }
cfg() { python3 -c "import json,functools; print(functools.reduce(lambda d,k: d[k], '$1'.split('.'), json.load(open('$D/config/settle.json'))))"; }
export SETTLE_CONFIG="$(cat "$D/config/settle.json")"
export SETTLE_CLPR_CONNECTOR_PK="$(key settleClprConnector private_key)"
export SETTLE_CLPR_CONNECTOR_PUB="$(cast wallet public-key --private-key "$SETTLE_CLPR_CONNECTOR_PK")"
export SETTLE_CHANNEL_ID="$(cfg channelId)"

BUILD=(--out "$D/.build/out" --cache-path "$D/.build/cache")
mkdir -p "$D/.build"
cd "$ROOT"

# Settle steps' recorded spend on <network> must stay under the budget; Sepolia must keep its floor.
budget_ok() { # <network>
    python3 - "$1" "$DEP" "$D/config/settle.json" "${STEP_MAX_ETH:-0.002}" <<'EOF'
import json, os, sys, subprocess
net, dep, cfgp, step_max = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
b = json.load(open(cfgp))["budget"]
p = f"{dep}/{net}.json"
txs = json.load(open(p)).get("transactions", []) if os.path.exists(p) else []
# connector-register is paid by the test Connector's account out of connector-fund, which is already counted.
settle = [t for t in txs if str(t.get("step", "")).startswith("settle-") and t.get("step") != "settle-connector-register"]
if net == "hedera-testnet":
    spent = sum(float(t.get("costHbar") or 0) for t in settle)
    print(f"settle budget: {spent:.8f} of {b['hbar']} HBAR spent on {net}")
    sys.exit(0 if spent < b["hbar"] else 1)
spent = sum(float(t.get("costEth") or 0) for t in settle)
bal = int(subprocess.check_output(["cast", "balance", os.environ["CLPR_TESTNET_ADDRESS"], "--rpc-url", os.environ["SEPOLIA_RPC_URL"]]).strip()) / 1e18
print(f"settle budget: {spent:.9f} of {b['eth']} ETH spent on {net}; balance {bal:.9f} ETH, step at most {step_max} ETH, floor {b['sepoliaFloorEth']} ETH")
ok = spent + step_max <= b["eth"] + 1e-12 and bal - step_max >= b["sepoliaFloorEth"]
sys.exit(0 if ok else 1)
EOF
}

# forge script on one chain: <network> <sig>
fs() {
    local net="$1" sig="$2"; shift 2
    local rpc chain tx=()
    if [[ "$net" == "sepolia" ]]; then rpc="$SEPOLIA_RPC_URL"; chain=11155111
        # Cap the max fee so the budget holds even if the base fee rises (the tx waits instead).
        tx=(--with-gas-price "${SEPOLIA_MAX_FEE_WEI:-1250000000}" --priority-gas-price "${SEPOLIA_TIP_WEI:-1000000}")
    else
        rpc="$HEDERA_TESTNET_RPC_URL"; chain=296
        tx=(--legacy --with-gas-price "$(cast gas-price --rpc-url "$rpc")")
    fi
    local log="$D/.build/settle-$STEP.log"
    if [[ "$BROADCAST" == "--broadcast" ]]; then
        budget_ok "$net" || { echo "SETTLE BUDGET EXCEEDED on $net: stopping" >&2; exit 2; }
        tx+=(--broadcast)
    fi
    forge script "$D/DeploySettle.s.sol:DeploySettle" --sig "$sig" "${BUILD[@]}" --rpc-url "$rpc" \
        --sender "$CLPR_TESTNET_ADDRESS" --gas-estimate-multiplier "${GAS_MULT:-130}" --slow "${tx[@]}" "$@" 2>&1 | tee "$log"
    if [[ "$BROADCAST" == "--broadcast" ]]; then
        local fn="${sig%%(*}"
        node "$D/record.mjs" "$net" "settle-$STEP" "$log" "$ROOT/broadcast/DeploySettle.s.sol/$chain/$fn-latest.json"
    fi
}

# Record transactions sent with cast (Hedera native value needs the relay's weibar units, which a forge script
# cannot simulate): <network> <contract> <function> <tx hash>...
record_cast() {
    local net="$1" contract="$2" fn="$3"; shift 3
    local rpc; [[ "$net" == "sepolia" ]] && rpc="$SEPOLIA_RPC_URL" || rpc="$HEDERA_TESTNET_RPC_URL"
    local run="$D/.build/settle-$STEP-run.json" log="$D/.build/settle-$STEP.log"
    : > "$log"
    python3 - "$run" "$contract" "$fn" "$rpc" "$@" <<'EOF'
import json, subprocess, sys
out, contract, fn, rpc, hashes = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:]
run = {"transactions": [], "receipts": []}
for h in hashes:
    t = json.loads(subprocess.check_output(["cast", "tx", h, "--json", "--rpc-url", rpc]))
    r = json.loads(subprocess.check_output(["cast", "receipt", h, "--json", "--rpc-url", rpc]))
    run["transactions"].append({"hash": h, "contractName": contract, "function": fn,
                                "transaction": {"to": t.get("to"), "value": t.get("value", "0x0"), "gas": t.get("gas", "0x0"), "gasPrice": t.get("gasPrice")}})
    run["receipts"].append(r)
json.dump(run, open(out, "w"))
EOF
    node "$D/record.mjs" "$net" "settle-$STEP" "$log" "$run"
}

ob_address() {
    python3 -c "import json; print(json.load(open('$DEP/hedera-testnet.json'))['settle']['contracts']['SettleOrderBook']['address'])"
}

case "$STEP" in
    order-book) fs hedera-testnet "deployOrderBook()" ;;
    sepolia) fs sepolia "deploySepolia()" ;;
    source) fs hedera-testnet "proposeSource()" ;;
    clpr-connector-hedera)
        fs hedera-testnet "deployClprConnector()"
        STEP=clpr-connector-hedera-register fs hedera-testnet "registerClprConnector()"
        ;;
    clpr-connector-sepolia)
        fs sepolia "deployClprConnector()"
        STEP=clpr-connector-sepolia-register fs sepolia "registerClprConnector()"
        ;;
    connector-fund)
        to="$(key settleConnector address)"
        amt="$(cfg connector.accountFundingHbar)"
        have="$(cast balance --ether "$to" --rpc-url "$HEDERA_TESTNET_RPC_URL")"
        echo "test Connector $to has $have HBAR; target $amt"
        if python3 -c "import sys; sys.exit(0 if float('$have') < float('$amt') else 1)"; then
            [[ "$BROADCAST" == "--broadcast" ]] || { echo "(simulation) would send $amt HBAR"; exit 0; }
            budget_ok hedera-testnet || exit 2
            h="$(cast send "$to" --value "${amt}ether" --private-key "$CLPR_TESTNET_PRIVATE_KEY" --legacy \
                --rpc-url "$HEDERA_TESTNET_RPC_URL" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["transactionHash"])')"
            echo "FUNDED $h"
            record_cast hedera-testnet "settle Connector account" "transfer (HBAR)" "$h"
        fi
        ;;
    connector-fund-sepolia)
        # Delivery liquidity on Sepolia for the test Connector (it only quotes what it can deliver).
        to="$(key settleConnector address)"
        amt="$(cfg connector.sepoliaFundingEth)"
        have="$(cast balance --ether "$to" --rpc-url "$SEPOLIA_RPC_URL")"
        echo "test Connector $to has $have ETH on Sepolia; target $amt"
        if python3 -c "import sys; sys.exit(0 if float('$have') < float('$amt') else 1)"; then
            [[ "$BROADCAST" == "--broadcast" ]] || { echo "(simulation) would send $amt ETH"; exit 0; }
            STEP_MAX_ETH="$(python3 -c "print(float('$amt') + 0.00005)")" budget_ok sepolia || exit 2
            h="$(cast send "$to" --value "${amt}ether" --private-key "$CLPR_TESTNET_PRIVATE_KEY" \
                --gas-price "${SEPOLIA_MAX_FEE_WEI:-1250000000}" --priority-gas-price "${SEPOLIA_TIP_WEI:-1000000}" \
                --rpc-url "$SEPOLIA_RPC_URL" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["transactionHash"])')"
            echo "FUNDED $h"
            record_cast sepolia "settle Connector account" "transfer (ETH)" "$h"
        fi
        ;;
    connector-register)
        OB="$(ob_address)"
        PK="$(key settleConnector private_key)"
        me="$(key settleConnector address)"
        signer="$(key settleSigner address)"
        bond="$(cfg connector.bondTinybar)"
        reg="$(cast call "$OB" "connectors(address)(address,address,uint64,uint64,uint32)" "$me" --rpc-url "$HEDERA_TESTNET_RPC_URL" | sed -n 4p | awk '{print $1}')"
        total="$(cast call "$OB" "bonds(address,address)(uint256,uint256,uint256,uint64)" "$me" 0x0000000000000000000000000000000000000000 --rpc-url "$HEDERA_TESTNET_RPC_URL" | sed -n 1p | awk '{print $1}')"
        echo "test Connector $me: registeredAt=$reg bond=$total tinybar (target $bond), signer $signer"
        [[ "$BROADCAST" == "--broadcast" ]] || { echo "(simulation) would register and post the bond"; exit 0; }
        budget_ok hedera-testnet || exit 2
        hashes=()
        if [[ "$reg" == "0" ]]; then
            hashes+=("$(cast send "$OB" "register(address)" "$signer" --private-key "$PK" --legacy \
                --rpc-url "$HEDERA_TESTNET_RPC_URL" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["transactionHash"])')")
            record_cast hedera-testnet SettleOrderBook "register(address)" "${hashes[-1]}"
        fi
        if (( total < bond )); then
            need=$(( bond - total ))
            # postBond(HBAR, amount): the EVM sees tinybars; the relay takes value in weibars (x 1e10).
            hashes+=("$(cast send "$OB" "postBond(address,uint256)" 0x0000000000000000000000000000000000000000 "$need" \
                --value "$(( need ))0000000000" --private-key "$PK" --legacy --rpc-url "$HEDERA_TESTNET_RPC_URL" --json \
                | python3 -c 'import json,sys; print(json.load(sys.stdin)["transactionHash"])')")
            record_cast hedera-testnet SettleOrderBook "postBond(address,uint256)" "${hashes[-1]}"
        fi
        cast call "$OB" "freeCapacity(address,address)(uint256)" "$me" 0x0000000000000000000000000000000000000000 --rpc-url "$HEDERA_TESTNET_RPC_URL"
        ;;
    status-hedera) BROADCAST=""; fs hedera-testnet "status()" ;;
    status-sepolia) BROADCAST=""; fs sepolia "status()" ;;
    *) echo "unknown step $STEP" >&2; exit 1 ;;
esac
