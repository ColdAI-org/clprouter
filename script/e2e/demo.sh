#!/usr/bin/env bash
# `make demo`: preflight checks, a short banner, script/e2e/run.sh, then a summary table built from e2e-out/.
# run.sh does all the work (and all the assertions); this wrapper only explains and summarises it.
#
# Usage: script/e2e/demo.sh             (make demo)
#        script/e2e/demo.sh --summary   reprint the summary of the last run
set -euo pipefail
cd "$(dirname "$0")/../.."

bold() { printf '\033[1m%s\033[0m\n' "$*"; }

# Summary table from e2e-out/: gas.tsv (every send and relay transaction) and run.log (the status check per scenario).
summary() {
  awk -F'\t' '
    BEGIN {
      split("delivered,destination app reverts,edge B->C disabled mid-route,recipient blacklisted on B,deadline passes before B", what, ",")
      split("NONE,PENDING,DELIVERED,FAILED,EXPIRED,QUARANTINED", st, ",")
    }
    FNR == NR {
      if (FNR > 1) { txs[$1]++; gas[$1] += $5 }
      next
    }
    /CHECK_OK scenario/ { k = split($0, w, " "); n = w[k] }
    /^ *status [0-9]+$/ && n != "" { k = split($0, w, " "); status[n] = st[w[k] + 1]; n = "" }
    END {
      printf "  %-3s %-32s %-12s %4s %12s\n", "#", "scenario", "route on A", "txs", "gas used"
      for (i = 1; i <= 5; i++) {
        printf "  %-3s %-32s %-12s %4d %12d\n", i, what[i], (i in status ? status[i] : "?"), txs[i], gas[i]
        total += gas[i]; ntx += txs[i]
      }
      printf "  %-3s %-32s %-12s %4d %12d\n", "", "total", "", ntx, total
    }
  ' e2e-out/gas.tsv e2e-out/run.log
}

if [ "${1:-}" = --summary ]; then summary; exit 0; fi  # reprint the table of the last run

# Preflight: the tools run.sh calls.
missing=()
for tool in forge anvil cast jq; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "make demo needs: ${missing[*]}" >&2
  echo "  forge, anvil, cast: Foundry v1.5.1  (curl -L https://foundry.paradigm.xyz | bash && foundryup -i v1.5.1)" >&2
  echo "  jq:                 brew install jq  /  apt-get install jq" >&2
  echo "Or run it in Docker (needs only Docker): make demo-docker" >&2
  exit 1
fi
if [ ! -f lib/clpr-smart-contracts/foundry.toml ]; then
  echo "The CLPR submodule is missing. Run: git submodule update --init --recursive" >&2
  exit 1
fi
for p in "${PORT_A:-18545}" "${PORT_B:-18546}" "${PORT_C:-18547}"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
    echo "Port $p is in use. Free it or set PORT_A/PORT_B/PORT_C." >&2
    exit 1
  fi
done

bold "CLPRouter end-to-end demo: three local anvil chains, A (31001) - B (31002) - C (31003)"
cat <<'EOF'
  1. Start three anvil chains. On each, deploy the unchanged reference CLPR Service with the CLPR repo's
     E2E verifier, a ProviderRegistry, a QuarantineVault and a ClprRouter at its canonical address.
     Wire Channels and Connectors A<->B and B<->C.
  2. Send a route A -> B -> C five times. A relayer moves each bundle, each hop forwards, and the receipt
     travels back to A. Each scenario ends with an on-chain check of the route status on A:
       1 delivered          escrow released, receipt back on A
       2 destination fails  the app on C reverts             -> FAILED
       3 edge disabled      B -> C disabled mid-route        -> FAILED
       4 quarantined        recipient blacklisted on B       -> QUARANTINED
       5 expired            deadline passes before B         -> EXPIRED
  3. Record gasUsed for every transaction in e2e-out/gas.tsv (full log: e2e-out/run.log).
  Uses anvil's well-known development key only. Takes about 5-10 minutes (most of it is forge script runs).
EOF
echo

start=$(date +%s)
if ! forge --version | grep -q '1\.5\.1'; then
  echo "note: tested with Foundry v1.5.1; you have $(forge --version | head -1)"
fi
script/e2e/run.sh
elapsed=$(($(date +%s) - start))

echo
bold "Summary (send and relay transactions per scenario)"
summary
printf '\n  all 5 scenarios passed in %dm%02ds  ·  gas per transaction: e2e-out/gas.tsv  ·  log: e2e-out/run.log\n' \
  $((elapsed / 60)) $((elapsed % 60))
