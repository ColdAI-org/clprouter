#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Run the reference Connector service (services/connector) against the testnet settle deployment:
#   script/deploy/settle-connector.sh run --once | serve [--http-only] | quote --request <file> --out <file> | bond ...
# Keys come from deployments/.local/settle-keys.secret.json (git-excluded) through the environment only;
# RPC URLs from ~/clpr/.env. Config: services/connector/config.testnet.json.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KEYS="$ROOT/deployments/.local/settle-keys.secret.json"
set -a
# shellcheck disable=SC1090
. "${CLPR_ENV_FILE:-$HOME/clpr/.env}"
set +a
key() { python3 -c "import json; print(json.load(open('$KEYS'))['$1']['private_key'])"; }
SETTLE_CONNECTOR_KEY="$(key settleConnector)" SETTLE_SIGNER_KEY="$(key settleSigner)" \
    exec pnpm --dir "$ROOT/services" --silent connector "$1" --config connector/config.testnet.json "${@:2}"
