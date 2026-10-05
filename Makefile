# Thin wrappers around the commands in README.md, docs/ and CI. `make` alone lists the targets.
#
# Prerequisites: Foundry v1.5.1 (forge, anvil, cast), Node >= 22.13, pnpm, jq. `make demo-docker` needs only Docker.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

# Tests whose assertions depend on exact gas; coverage instrumentation changes gas, so `coverage` skips them (as CI).
GAS_CALIBRATED_TESTS := belowMinSendGas|outOfGasInsideSend|definiteServiceRevert
# Left out of the gas snapshot (input-dependent gas), as in CI.
SNAPSHOT_EXCLUDE := ^(testFuzz|invariant)

.PHONY: help build test test-contracts test-sdk test-services test-services-integration test-pack \
        demo demo-docker snapshot snapshot-check coverage halmos slither clean

help: ## List the targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-zA-Z_-]+:.*## / { printf "  \033[1m%-27s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

sdk/node_modules: sdk/package.json sdk/pnpm-lock.yaml
	cd sdk && pnpm install --frozen-lockfile
	@touch $@

services/node_modules: services/package.json services/pnpm-lock.yaml | sdk/node_modules
	cd services && pnpm install --frozen-lockfile
	@touch $@

build: sdk/node_modules ## Build the contracts (forge build) and the SDK (sdk/dist)
	forge build
	cd sdk && pnpm run build

test: test-contracts test-sdk test-services ## Contracts, SDK and services unit tests

test-contracts: ## forge test: unit, fuzz, invariant, security
	forge test --skip 'script/**'

test-sdk: sdk/node_modules ## SDK: typecheck and vitest (planner, envelope, ISO 20022)
	cd sdk && pnpm run typecheck && pnpm test

test-pack: sdk/node_modules ## SDK: pack the npm tarball, install it into a scratch project, import every entry point
	cd sdk && pnpm run test:pack

test-services: services/node_modules ## Services: typecheck and unit tests
	cd services && pnpm run typecheck && pnpm run test:unit

test-services-integration: services/node_modules ## Services against one anvil with three Router stacks (needs forge build)
	@test -d out || forge build
	cd services && pnpm run test:integration

demo: ## End-to-end run A -> B -> C and back on three local anvil chains, with a summary (5-10 min)
	script/e2e/demo.sh

# The repository is mounted read-write so e2e-out/ lands on the host; build output and the solc cache stay in
# named volumes so they never mix with a host build. On Linux the container runs as the host user; Docker Desktop
# and Colima map file ownership themselves.
DOCKER_USER := $(if $(filter Linux,$(shell uname -s)),--user $(shell id -u):$(shell id -g))
demo-docker: ## The same demo inside the Foundry v1.5.1 image (needs only Docker)
	docker build -t clprouter-demo:foundry-v1.5.1 - < script/e2e/demo.Dockerfile
	docker run --rm -t $(DOCKER_USER) -v "$(CURDIR):/repo" -v clprouter-demo-out:/repo/out \
	  -v clprouter-demo-cache:/repo/cache -v clprouter-demo-svm:/home/foundry/.svm clprouter-demo:foundry-v1.5.1

snapshot: ## Rewrite .gas-snapshot (unit tests; fuzz and invariant runs excluded)
	forge snapshot --no-match-test '$(SNAPSHOT_EXCLUDE)'

snapshot-check: ## Compare gas against .gas-snapshot (as CI)
	forge snapshot --no-match-test '$(SNAPSHOT_EXCLUDE)' --check

coverage: ## forge coverage summary of src/ (CI also drops the ClprRouter size restriction first; see ci.yml)
	forge coverage --ir-minimum --no-match-test '$(GAS_CALIBRATED_TESTS)' \
	  --no-match-coverage '^(test|script|lib)/' --report summary

halmos: ## Symbolic tests in test/halmos (foundry profile `halmos`); needs halmos (pip install halmos)
	@command -v halmos >/dev/null || { echo "halmos not found: pip install halmos" >&2; exit 1; }
	FOUNDRY_PROFILE=halmos halmos --forge-build-out out-halmos --loop 4

slither: ## Static analysis with the CI configuration; needs slither (pip install slither-analyzer)
	@command -v slither >/dev/null || { echo "slither not found: pip install slither-analyzer" >&2; exit 1; }
	slither . --config-file .github/slither.config.json

clean: ## Remove build output and demo output
	forge clean
	rm -rf out-halmos cache-halmos e2e-out .anvil sdk/dist services/dist
