#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Verify the deployed sources on Sourcify (Sepolia: shown by Etherscan/Blockscout; Hedera testnet: HashScan uses
# Sourcify). Etherscan's own verifier needs ETHERSCAN_API_KEY, which the testnet env does not have.
#
#   script/deploy/verify.sh <network>      # sepolia | hedera-testnet
#
# Each contract is tried with the compilation profile it was built in (the deploy scripts include ClprRouter, so
# their compile unit uses the 'small' profile; EthMainnetVerifier uses 'default'). Results are written to
# deployments/<network>.json under sourceVerification.
set -uo pipefail
NET="${1:?usage: verify.sh <network>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEP="$ROOT/deployments/$NET.json"
CHAIN="$(python3 -c "import json; print(json.load(open('$DEP'))['chainId'])")"
export FOUNDRY_OUT="$ROOT/script/deploy/.build/out" FOUNDRY_CACHE_PATH="$ROOT/script/deploy/.build/cache"
cd "$ROOT"

j() { python3 -c "import json,sys; d=json.load(open('$DEP')); print(eval(sys.argv[1]))" "$1"; }
LIBS=()
for l in RouteCodec RouteLogic RouteOrigin RouteReceipts RouteSettlement; do
    LIBS+=(--libraries "src/libraries/$l.sol:$l:$(j "d['libraries']['$l']['address']")")
done
DEPLOYMENT_ID="$(j "d['deploymentId']")"
OWNER="$(python3 -c "import json; print(json.load(open('script/deploy/config/canonical.json'))['routerDeployerOwner'])")"
SALT="$(cast keccak "$(cast concat-hex "$(cast keccak "$(python3 -c "import json; print(json.load(open('script/deploy/config/canonical.json'))['salt'])")")" "$(cast from-utf8 ClprRouter)" "$DEPLOYMENT_ID")")"
INIT_HASH="$(j "d['routerInitCodeHash']")"
MEMBERS="[$(python3 -c "import json; print(','.join(json.load(open('deployments/test-committee.json'))['members']))")]"
REG_ARGS="$(cast abi-encode "f(bytes32,address[],uint8,string,uint64[6])" "$DEPLOYMENT_ID" "$MEMBERS" 3 \
    "testnet-only: no incident contact (TEST committee)" "[604800,259200,604800,604800,2592000,604800]")"
VAULT_ARGS="$(cast abi-encode "f(address,uint64,uint64)" "$(j "d['contracts']['QuarantineVault']['constructorArgs']['registry']")" 259200 604800)"
DEPL_ARGS="$(cast abi-encode "f(address,bytes32,bytes32)" "$OWNER" "$SALT" "$INIT_HASH")"
SVC=0xa6db474e3047c3d43b10a4ff7abad547d89982b9
CONN_ARGS="$(cast abi-encode "f(address,address)" "$SVC" "$OWNER")"

RESULTS=()
verify() { # name address target args [extra...]
    local name="$1" addr="$2" target="$3" args="$4"; shift 4
    local out status="no_match"
    for prof in small default; do
        out="$(forge verify-contract "$addr" "$target" --chain "$CHAIN" --verifier sourcify --compilation-profile "$prof" \
            ${args:+--constructor-args "$args"} "$@" --watch 2>&1)"
        if grep -qiE "successfully verified|already verified|Status: \`(perfect|match|partial)" <<<"$out"; then
            status="verified (sourcify, profile $prof)"; break
        fi
    done
    echo "$name $addr: $status"
    RESULTS+=("$name=$status")
}

verify ProviderRegistry "$(j "d['contracts']['ProviderRegistry']['address']")" src/ProviderRegistry.sol:ProviderRegistry "$REG_ARGS"
verify QuarantineVault "$(j "d['contracts']['QuarantineVault']['address']")" src/QuarantineVault.sol:QuarantineVault "$VAULT_ARGS"
verify ClprRouterDeployer "$(j "d['contracts']['ClprRouterDeployer']['address']")" src/ClprRouterDeployer.sol:ClprRouterDeployer "$DEPL_ARGS"
verify ClprRouter "$(j "d['contracts']['ClprRouter']['address']")" src/ClprRouter.sol:ClprRouter "" "${LIBS[@]}"
for l in RouteCodec RouteLogic RouteOrigin RouteReceipts RouteSettlement; do
    verify "$l" "$(j "d['libraries']['$l']['address']")" "src/libraries/$l.sol:$l" ""
done
verify TestnetConnector "$(j "d['fixtures']['TestnetConnector']['address']")" script/deploy/TestnetFixtures.sol:TestnetConnector "$CONN_ARGS"
if [[ "$NET" == "sepolia" ]]; then
    STUB_ARGS="$(cast abi-encode "f(string,bytes,(uint32,uint64,uint64,uint32,uint64,uint32,uint32))" 296 "$SVC" \
        "(100,16384,3000000,1000,1048576,0,0)")"
    verify TestOnlyStubVerifier "$(j "d['fixtures']['TestOnlyStubVerifier']['address']")" script/deploy/TestnetFixtures.sol:TestOnlyStubVerifier "$STUB_ARGS"
else
    verify TestnetRouteApp "$(j "d['fixtures']['TestnetRouteApp']['address']")" script/deploy/TestnetFixtures.sol:TestnetRouteApp \
        "$(cast abi-encode "f(address)" "$(j "d['contracts']['ClprRouter']['address']")")"
fi

python3 - "$DEP" "${RESULTS[@]}" <<'EOF'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d["sourceVerification"] = dict(r.split("=", 1) for r in sys.argv[2:])
json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
EOF
