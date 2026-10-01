#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Deploy (or re-check) the CLPRouter stack on a public testnet.
#
#   script/deploy/deploy.sh <network> [--broadcast]
#
# <network> is a file name in script/deploy/config/ (sepolia, hedera-testnet). Without --broadcast the run
# is a simulation against a fork of the live chain: it prints the CREATE2 addresses and runs every
# post-deploy check, and against an existing deployment it is the verification run. With --broadcast it
# sends the transactions, then re-runs the script without broadcasting so the checks run against the
# chain's real state, and records the result in deployments/<network>.json.
#
# The deployer key is read from ~/clpr/.env (CLPR_TESTNET_PRIVATE_KEY, testnet-only) and passed to forge
# through the environment; it is never printed. On Hedera the gas price is floored at eth_gasPrice and
# transactions are legacy (the relay's fee rule); the gas limit is forge's estimate x gasEstimateMultiplier.
set -euo pipefail

NET="${1:?usage: deploy.sh <network> [--broadcast]}"
BROADCAST="${2:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CFG="$ROOT/script/deploy/config/$NET.json"
ENV_FILE="${CLPR_ENV_FILE:-$HOME/clpr/.env}"
[[ -f "$CFG" ]] || { echo "no config $CFG" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "no env file $ENV_FILE" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

jqr() { python3 -c "import json,sys; d=json.load(open('$CFG')); print(eval('d'+sys.argv[1]))" "$1"; }
RPC_ENV="$(jqr "['rpcEnv']")"
RPC="${!RPC_ENV:?missing $RPC_ENV in env file}"
LEGACY="$(jqr "['tx']['legacy']")"
FLOOR="$(jqr "['tx']['gasPriceFloorFromRpc']")"
MULT="$(jqr "['tx']['gasEstimateMultiplier']")"

export DEPLOY_CONFIG="$(cat "$CFG")"
export CANONICAL_CONFIG="$(cat "$ROOT/script/deploy/config/canonical.json")"
export COMMITTEE="$(cat "$ROOT/deployments/test-committee.json")"
export DEPLOYMENTS_DIR="${DEPLOYMENTS_DIR:-$ROOT/deployments}"  # override for rehearsals on local forks
export ETH_RPC_URL="$RPC"
# The script reads the key from CLPR_TESTNET_PRIVATE_KEY (vm.envUint), so it never appears on a command line.
: "${CLPR_TESTNET_PRIVATE_KEY:?missing CLPR_TESTNET_PRIVATE_KEY}"
SENDER="${CLPR_TESTNET_ADDRESS:?missing CLPR_TESTNET_ADDRESS}"

BUILD=(--out "$ROOT/script/deploy/.build/out" --cache-path "$ROOT/script/deploy/.build/cache")
TX=(--gas-estimate-multiplier "$MULT" --slow)
if [[ "$LEGACY" == "True" ]]; then TX+=(--legacy); fi
if [[ "$FLOOR" == "True" ]]; then TX+=(--with-gas-price "$(cast gas-price --rpc-url "$RPC")"); fi
# Optional EIP-1559 fee cap (e.g. MAX_FEE_GWEI=1.5): keeps gasLimit x maxFee within a small balance.
if [[ -n "${MAX_FEE_GWEI:-}" ]]; then TX+=(--with-gas-price "${MAX_FEE_GWEI}gwei" --priority-gas-price "${PRIORITY_FEE_GWEI:-0.05}gwei"); fi

cd "$ROOT"
LOG="$ROOT/script/deploy/.build/$NET-deploy.log"
mkdir -p "$(dirname "$LOG")"

run_script() {
    forge script script/deploy/DeployRouter.s.sol:DeployRouter "${BUILD[@]}" --rpc-url "$RPC" \
        --sender "$SENDER" "${TX[@]}" "$@"
}

if [[ "$BROADCAST" == "--broadcast" ]]; then
    run_script --broadcast 2>&1 | tee "$LOG"
    echo "--- verification run against the live chain ---"
    run_script 2>&1 | tee "$LOG.verify"
    CHAIN_ID="$(jqr "['chainId']")"
    node "$ROOT/script/deploy/record.mjs" "$NET" deploy-router "$LOG.verify" \
        "$ROOT/broadcast/DeployRouter.s.sol/$CHAIN_ID/run-latest.json"
else
    run_script 2>&1 | tee "$LOG"
fi
