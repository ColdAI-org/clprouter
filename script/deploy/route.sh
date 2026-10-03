#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# CLPR Channel Sepolia <-> Hedera testnet and one CLPRouter route Sepolia -> Hedera over it.
#
#   script/deploy/route.sh <step> [--broadcast]
#
# Steps, in order (each is idempotent and broadcasts to one chain; without --broadcast it only simulates):
#   init-sepolia | init-hedera          initialize + enable the CLPR Service (owner, once)
#   fixtures-sepolia | fixtures-hedera  TestnetConnector (both), TestOnlyStubVerifier (Sepolia)
#   eth-verifier                        reuse/deploy EthMainnetVerifier on Hedera (byte-identical check)
#   staged-verifier                     StagedEthConfigVerifier on Hedera in front of it (staged bootstrap committee)
#   channel-sepolia                     open the Channel on Sepolia (TestOnlyStubVerifier)
#   channel-hedera                      fetch the current Sepolia sync committee, stage it on the
#                                       StagedEthConfigVerifier (16 chunk transactions), open the Channel on
#                                       Hedera; the route must then run within the same sync-committee period
#                                       (printed)
#   connector-sepolia | connector-hedera
#   route-fixtures-sepolia | route-fixtures-hedera   (after deploy.sh) allow the Router on the Connector,
#                                       destination app on Hedera
#   send                                Router.send on Sepolia
#   deliver                             wait for a sync-committee-signed header past the send block, build the
#                                       bundle proof, pre-flight it on Hedera, submitBundle on Hedera
#   status-sepolia | status-hedera      read-only
#
# Keys: CLPR_TESTNET_PRIVATE_KEY from ~/clpr/.env; Channel and Connector keys from
# deployments/.local/testnet-keys.secret.json (git-excluded). Passed to forge through the environment only.
# Budget guard: refuses to broadcast once deployments/<network>.json totals reach the budget
# (BUDGET_HBAR, default 150; BUDGET_ETH, default 0.5).
set -euo pipefail

STEP="${1:?usage: route.sh <step> [--broadcast]}"
BROADCAST="${2:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
D="$ROOT/script/deploy"
ENV_FILE="${CLPR_ENV_FILE:-$HOME/clpr/.env}"
SECRETS="$ROOT/deployments/.local/testnet-keys.secret.json"
BUDGET_HBAR="${BUDGET_HBAR:-150}"
BUDGET_ETH="${BUDGET_ETH:-0.5}"
DEP="${DEPLOYMENTS_DIR:-$ROOT/deployments}"  # override for rehearsals on local forks
export DEPLOYMENTS_DIR="$DEP"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
: "${CLPR_TESTNET_PRIVATE_KEY:?}" "${CLPR_TESTNET_ADDRESS:?}" "${SEPOLIA_RPC_URL:?}" "${HEDERA_TESTNET_RPC_URL:?}"

secret() { python3 -c "import json; print(json.load(open('$SECRETS'))['$1']['private_key'])"; }
export CHANNEL_PK="$(secret channel)"
export CONNECTOR_PK="$(secret connector)"
export ROUTE_CONFIG="$(cat "$D/config/route.json")"
[[ -f "$DEP/sepolia.json" ]] && export SEPOLIA_DEPLOYMENT="$(cat "$DEP/sepolia.json")"
[[ -f "$DEP/hedera-testnet.json" ]] && export HEDERA_DEPLOYMENT="$(cat "$DEP/hedera-testnet.json")"

BUILD=(--out "$D/.build/out" --cache-path "$D/.build/cache")
mkdir -p "$D/.build"
cd "$ROOT"

budget_ok() { # <network>
    python3 - "$1" "$BUDGET_HBAR" "$BUDGET_ETH" "$DEP" <<'EOF'
import json, os, sys
net, hbar, eth, dep = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
p = f"{dep}/{net}.json"
if not os.path.exists(p):
    sys.exit(0)
t = json.load(open(p)).get("totals", {})
spent, cap, unit = (float(t.get("costHbar", 0)), hbar, "HBAR") if net == "hedera-testnet" else (float(t.get("costEth", 0)), eth, "ETH")
print(f"budget: {spent} of {cap} {unit} spent on {net}")
sys.exit(0 if spent < cap else 1)
EOF
}

# forge script on one chain: <network> <sig> [extra forge args]
fs() {
    local net="$1" sig="$2"; shift 2
    local rpc chain tx=()
    if [[ "$net" == "sepolia" ]]; then rpc="$SEPOLIA_RPC_URL"; chain=11155111; else
        rpc="$HEDERA_TESTNET_RPC_URL"; chain=296
        tx=(--legacy --with-gas-price "$(cast gas-price --rpc-url "$rpc")")
    fi
    local log="$D/.build/$STEP.log"
    if [[ "$BROADCAST" == "--broadcast" ]]; then
        budget_ok "$net" || { echo "BUDGET EXCEEDED on $net: stopping" >&2; exit 2; }
        tx+=(--broadcast)
    fi
    forge script "$D/SetupRoute.s.sol:SetupRoute" --sig "$sig" "${BUILD[@]}" --rpc-url "$rpc" \
        --sender "$CLPR_TESTNET_ADDRESS" --gas-estimate-multiplier "${GAS_MULT:-130}" --slow "${tx[@]}" "$@" 2>&1 | tee "$log"
    if [[ "$BROADCAST" == "--broadcast" ]]; then
        local fn="${sig%%(*}"
        node "$D/record.mjs" "$net" "$STEP" "$log" "$ROOT/broadcast/SetupRoute.s.sol/$chain/$fn-latest.json"
    fi
}

eth_verifier() {
    python3 -c "import json; print(json.load(open('$DEP/hedera-testnet.json'))['fixtures']['EthMainnetVerifier']['address'])"
}

case "$STEP" in
    init-sepolia) fs sepolia "initService()" ;;
    init-hedera) fs hedera-testnet "initService()" ;;
    fixtures-sepolia) fs sepolia "deployChannelFixtures()" ;;
    fixtures-hedera) fs hedera-testnet "deployChannelFixtures()" ;;
    eth-verifier)
        tx=(--legacy --with-gas-price "$(cast gas-price --rpc-url "$HEDERA_TESTNET_RPC_URL")")
        [[ "$BROADCAST" == "--broadcast" ]] && tx+=(--broadcast)
        ETH_VERIFIER_SALT="$(python3 -c "import json; print(json.load(open('$D/config/route.json'))['ethVerifier']['salt'])")" \
        ETH_VERIFIER_REUSE="$(python3 -c "import json; print(json.load(open('$D/config/route.json'))['ethVerifier']['reuse'] or '')")" \
            forge script "$D/DeployEthVerifier.s.sol:DeployEthVerifier" "${BUILD[@]}" \
            --rpc-url "$HEDERA_TESTNET_RPC_URL" --sender "$CLPR_TESTNET_ADDRESS" --gas-estimate-multiplier 130 \
            "${tx[@]}" 2>&1 | tee "$D/.build/$STEP.log"
        if [[ "$BROADCAST" == "--broadcast" ]]; then
            node "$D/record.mjs" hedera-testnet "$STEP" "$D/.build/$STEP.log" \
                "$ROOT/broadcast/DeployEthVerifier.s.sol/296/run-latest.json"
        fi
        ;;
    staged-verifier)
        ETH_VERIFIER="$(eth_verifier)"; export ETH_VERIFIER
        fs hedera-testnet "deployStagedVerifier()"
        ;;
    channel-sepolia) fs sepolia "openChannel()" ;;
    channel-hedera)
        # Reuse the fetched committee while it is still the current period's (staging and opening may be re-run).
        if [[ -z "${ETH_CONFIG_REUSE:-}" || ! -f "$D/.build/eth-config.env" ]]; then
            (cd "$D" && npx tsx relay/eth-config.ts --out "$D/.build/eth-config.env")
        fi
        set -a; . "$D/.build/eth-config.env"; set +a
        ETH_VERIFIER="$(eth_verifier)"; export ETH_VERIFIER
        # Hedera rejects the single 67 KB completeChannel (contract trace-size limit): stage the committee first.
        STEP=channel-hedera-stage fs hedera-testnet "stageCommittee()"
        fs hedera-testnet "openChannel()"
        ;;
    connector-sepolia) fs sepolia "registerConnector()" ;;
    connector-hedera) fs hedera-testnet "registerConnector()" ;;
    route-fixtures-sepolia) fs sepolia "deployRouteFixtures()" ;;
    route-fixtures-hedera) fs hedera-testnet "deployRouteFixtures()" ;;
    send)
        fs sepolia "send()"
        if [[ "$BROADCAST" == "--broadcast" ]]; then
            grep -A1 "ROUTE_SENT" "$D/.build/send.log" | tail -1 | tr -d ' ' > "$DEP/.route-id"
        fi
        ;;
    deliver)
        CH="$(grep -A1 -E "CHANNEL_(OPENED|EXISTS)" "$D/.build/channel-hedera.log" | tail -1 | tr -d ' ')"
        SEND_BLOCK="$(python3 -c "
import json
t=[x for x in json.load(open('$DEP/sepolia.json'))['transactions'] if x['step']=='send']
print(t[-1]['block'])")"
        # The relay reads the IClprService and EthMainnetVerifier ABIs from the deploy build.
        forge build "$D/SetupRoute.s.sol" "$D/DeployEthVerifier.s.sol" "${BUILD[@]}" > /dev/null
        (cd "$D" && npx tsx relay/eth-bundle.ts --channel "$CH" --min-block "$SEND_BLOCK" --out "$D/.build/bundle.env")
        set -a; . "$D/.build/bundle.env"; set +a
        export FLUSH_RECEIPT="${FLUSH_RECEIPT:-true}"
        # Hedera prices the BLS12-381 precompiles on its own schedule: leave headroom over forge's estimate.
        GAS_MULT="${GAS_MULT:-200}" fs hedera-testnet "deliver()"
        ;;
    status-sepolia|status-hedera)
        [[ -f "$DEP/.route-id" ]] && export ROUTE_ID="$(cat "$DEP/.route-id")"
        BROADCAST=""
        if [[ "$STEP" == "status-sepolia" ]]; then fs sepolia "status()"; else fs hedera-testnet "status()"; fi
        ;;
    *) echo "unknown step $STEP" >&2; exit 1 ;;
esac
