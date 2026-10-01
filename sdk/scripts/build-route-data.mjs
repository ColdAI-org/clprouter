#!/usr/bin/env node
/**
 * Rebuilds sdk/data/chains.json and sdk/data/edges.json from the verifier branches of clpr-smart-contracts.
 *
 *   node scripts/build-route-data.mjs [path/to/clpr-smart-contracts]
 *
 * Default repo path: $CLPR_CONTRACTS_REPO, else ../../clpr-smart-contracts relative to sdk/.
 *
 * How numbers are sourced: everything in CURATION below is a verbatim substring of a file on a branch
 * (`git show <branch>:<file>`). The script finds the line that holds it, parses the number out of it and records
 * branch + file + line. If a substring is not found, the build fails, so a number can never drift from its source.
 * The only figures not read from the branches are the uniform planner placeholders in PLACEHOLDERS, which are
 * listed in every record's `synthetic` array.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";

const SDK = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(process.argv[2] ?? process.env.CLPR_CONTRACTS_REPO ?? join(SDK, "../../clpr-smart-contracts"));
const OUT = join(SDK, "data");

const BRANCHES = [
  "cometbft-family", "xlayer", "opadapters", "dydx", "bsc", "flare", "solana", "stellar", "tron", "bitcoin",
  "ethtwins", "ethereum", "arbitrum", "canton", "grandpa", "zksync", "arcplasma", "monad", "xrpl", "starknet",
  "neartons", "kaiasigner", "btcl2s", "conflux", "cardalgo", "hard51", "antelope",
].map((b) => `pr/${b}`);

const HEDERA = "hedera:mainnet";
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

/** Uniform placeholders for fields the branches do not measure. Every use is listed in `synthetic`. */
const PLACEHOLDERS = {
  ledger: { nativeUsd: 1, gasPriceNative: 1e-9, enqueueGas: 120000, execGasPerMessage: 150000 },
  timing: { sourceFinalityS: 60, bundleCadenceS: 60, proofGenS: 5, verifyS: 6 },
  connectors: [
    { id: "conn-a", marginUsd: 0.02, balanceUsd: 500, successRate: 0.999 },
    { id: "conn-b", marginUsd: 0.035, balanceUsd: 5000, successRate: 0.9995 },
  ],
  history: { attempts: 200, successes: 199, pauses30d: 0 },
  maxPayloadBytes: 65536,
  offChain: { kWhPerBundle: 0.0002, gridKgPerKWh: 0.475 },
  /** Hiero → chain bundle: the sample graph's projected placeholder; nothing is measured in this direction. */
  reverseBundleGas: 450000,
};

// ---------------------------------------------------------------------------------------------------------------
// Curation: one entry per docs/chains page. Strings in `gas`, `calldata`, `at` are verbatim substrings of a single
// line of the page (or of `file` when given). `basis` says what the bundle figure is:
//   live-mainnet | live-testnet | live-partial (part of a bundle only) | family-proxy (same code, other chain)
//   | synthetic | estimate
// ---------------------------------------------------------------------------------------------------------------
const OP_ROT = { gas: "about 4.84M gas", calldata: "66,902 B", basis: "family-proxy", note: "L1 sync-committee rotation (Ethereum figure)" };
const COMET_SAME = { sameAsBundle: true, note: "a bundle at the rotation header returns the new anchor" };
const OP_TIER = { tier: "committee", why: "reads Ethereum L1 through the sync committee; the weakest link is the 512-key committee" };
const ARB_PROXY = {
  bundle: { basis: "family-proxy", network: "Plume mainnet (same ArbitrumNitroVerifier code)", txs: [{ gas: "2,459,563 gas", calldata: "24,996 B" }] },
  rotation: { gas: "7,408,325 gas", calldata: "91,268 B", basis: "family-proxy", note: "Plume rotation bundle" },
  finality: { at: "45,818 L1 blocks (about 6.4 days)", seconds: 552960, note: "assertion confirm period; sets latency" },
};

const CURATION = {
  // --- CometBFT family ---
  "cometbft-family/0g.md": { family: null, bundle: null, why: "no verifier: EVM state is in an MPT, not an IAVL store" },
  "cometbft-family/cronos.md": {
    family: "cometbft-light-client", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "7,835,260 gas", calldata: "15.9 KB" }] },
    rotation: COMET_SAME,
    catchUp: { gas: "12,606,099 gas", calldata: "17.3 KB", note: "missed rotation: bundle + one hop" },
  },
  "cometbft-family/injective.md": {
    family: "cometbft-light-client", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "12,598,455 gas", calldata: "15.0 KB" }] },
    rotation: COMET_SAME,
    catchUp: { gas: "22,784,596 gas", calldata: "18.6 KB", note: "bundle + one hop does not fit 15M gas; split into a lone hop and a bundle" },
    multiTx: [{ at: "does **not** fit 15M", note: "a missed rotation needs a separate hop transaction" }],
  },
  "cometbft-family/kava.md": {
    family: "cometbft-light-client", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "8,285,366 gas", calldata: "17.6 KB" }] },
    rotation: COMET_SAME,
    catchUp: { gas: "13,438,331 gas", calldata: "20.7 KB", note: "bundle + one hop" },
  },
  "cometbft-family/mantra.md": {
    family: "cometbft-light-client", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "7,764,628 gas", calldata: "12.7 KB" }] },
    rotation: COMET_SAME,
    catchUp: { gas: "13,410,752 gas", calldata: "15.4 KB", note: "bundle + one hop" },
  },
  "cometbft-family/mezo.md": {
    family: "cometbft-light-client", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "12,844,413 gas", calldata: "16.3 KB" }] },
    rotation: COMET_SAME,
    catchUp: { gas: "22,792,493 gas", calldata: "18.9 KB", note: "does not fit 15M; catch up with one bundle per rotation header" },
    multiTx: [{ at: "one bundle per rotation header", note: "a missed rotation is caught up with one bundle per rotation header" }],
  },
  "cometbft-family/polygon-pos.md": {
    family: "polygon-pos-heimdall", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "3,450,850 gas", calldata: "29.6 KB" }] },
    rotation: { gas: "3,445,272 gas", calldata: "29.5 KB", basis: "live-mainnet" },
    catchUp: { gas: "5,001,483 gas", calldata: "38.7 KB", note: "missed rotation with one inline hop" },
  },
  "cometbft-family/provenance.md": {
    family: "cosmwasm-cometbft", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "13,113,627 gas", calldata: "8.9 KB" }] },
    rotation: { gas: "13,120,821 gas", calldata: "8.9 KB", basis: "live-mainnet" },
    multiTx: [{ at: "accumulate both commits (7.0M + 6.9M + 12.7M)", note: "missed rotation: accumulate both commits, then a bundle by hash" }],
  },
  "cometbft-family/sei.md": { family: "cometbft-light-client", tier: "light-client", finalized: true, bundle: null, why: "not measured on live Sei data; CAIP-2 not recorded" },
  "cometbft-family/stable.md": { family: "cometbft-light-client", tier: "light-client", finalized: true, bundle: null, why: "not measured: no public CometBFT RPC for the commit" },
  "cometbft-family/thorchain.md": {
    family: "cosmwasm-cometbft", tier: "light-client", finalized: true,
    bundle: {
      basis: "live-mainnet",
      txs: [
        { label: "accumulate", count: 4, gas: "11,141,574–11,914,216 gas", calldata: "5.9–6.0 KB" },
        { label: "bundle by hash", gas: "583,234 gas", calldata: "3.0 KB" },
      ],
      note: "ranges taken at their upper bound",
    },
    rotation: {
      basis: "live-mainnet",
      txs: [
        { label: "accumulate", count: 4, gas: "11,101,964–11,260,593" },
        { label: "bundle by hash", gas: "583,609 gas" },
      ],
    },
  },
  "cometbft-family/zigchain.md": {
    family: "cosmwasm-cometbft", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "3,312,486 gas", calldata: "3.8 KB" }] },
    rotation: { gas: "3,320,815 gas", calldata: "3.8 KB", basis: "live-mainnet" },
    catchUp: { gas: "6,156,159 gas", calldata: "5.2 KB", note: "catch-up with one inline hop" },
  },
  // --- OP Stack dispute games ---
  "xlayer/base.md": {
    family: "opstack-dispute-game", ...OP_TIER, finalized: false,
    bundle: { basis: "live-testnet", network: "Base Sepolia, PROPOSED", txs: [{ gas: "3,910,935 gas", calldata: "46,084 B" }] },
    rotation: OP_ROT, rotationCadence: { at: "8,192 L1 slots, about 27 h" },
  },
  "xlayer/bob.md": {
    family: "opstack-dispute-game", ...OP_TIER, finalized: false,
    bundle: { basis: "live-mainnet", network: "FINALIZED, anvil", txs: [{ gas: "3,647,899 gas", calldata: "38,180 B" }] },
    rotation: { gas: "about 4.84M gas", calldata: "66,902 B", basis: "family-proxy", note: "adds the next sync committee (Ethereum figure)" },
    finality: { at: "about a day from an L2 block to FINALIZED delivery", seconds: 86400 },
  },
  ...Object.fromEntries(["celo", "ink", "op-mainnet", "soneium", "world-chain"].map((c) => [`xlayer/${c}.md`, {
    family: "opstack-dispute-game", ...OP_TIER, finalized: false,
    bundle: { basis: "family-proxy", network: "Base Sepolia PROPOSED full bundle", txs: [{ gas: "3,910,935 gas", calldata: "46,084 B" }] },
    rotation: OP_ROT, rotationCadence: { at: "8,192 L1 slots, about 27 h" },
  }])),
  "xlayer/megaeth.md": {
    family: "opstack-dispute-game", ...OP_TIER, finalized: false,
    bundle: { basis: "live-partial", network: "FINALIZED verifyL2StateRoot only; no public eth_getProof", txs: [{ gas: "2,835,004 gas", calldata: "33,860 B" }] },
    rotation: { gas: "about 4.84M gas", calldata: "66,902 B", basis: "family-proxy" },
    finality: { at: "FINALIZED delivers about 10.5 days after the L2 block", seconds: 907200 },
    cadence: { at: "Proposals come about once per hour", seconds: 3600 },
  },
  "xlayer/rise.md": {
    family: "opstack-dispute-game", ...OP_TIER, finalized: false,
    bundle: { basis: "live-partial", network: "FINALIZED verifyL2StateRoot only", txs: [{ gas: "2,596,353 gas", calldata: "28,868 B" }] },
    rotation: { gas: "about 4.84M gas", calldata: "66,902 B", basis: "family-proxy" },
  },
  "xlayer/rollux.md": { family: "opstack-output-oracle", bundle: null, why: "blocked: settles on Syscoin NEVM, which no verifier covers" },
  "xlayer/ronin.md": {
    family: "opstack-dispute-game", ...OP_TIER, finalized: false,
    bundle: { basis: "live-partial", network: "FINALIZED verifyL2StateRoot only; no public eth_getProof", txs: [{ gas: "2,701,785 gas", calldata: "28,740 B" }] },
    rotation: { gas: "about 4.84M gas", calldata: "66,902 B", basis: "family-proxy" },
  },
  "xlayer/unichain.md": {
    family: "opstack-dispute-game", ...OP_TIER, finalized: false,
    bundle: { basis: "live-partial", network: "FINALIZED verifyL2StateRoot, ANCHOR mode; no full bundle", txs: [{ gas: "1,754,014 gas", calldata: "21,700 B" }] },
    rotation: { gas: "about 4.84M gas", calldata: "66,902 B", basis: "family-proxy" },
  },
  "xlayer/x-layer.md": {
    family: "opstack-dispute-game", ...OP_TIER, finalized: false,
    bundle: { basis: "live-partial", network: "FINALIZED GAME verifyL2StateRoot; full bundle not yet measured", txs: [{ gas: "2,577,100 gas", calldata: "26,948 B" }] },
    rotation: OP_ROT,
    finality: { at: "About 3.6 days from L2 block to FINALIZED delivery", seconds: 311040 },
    cadence: { at: "Games about every hour", seconds: 3600 },
  },
  // --- OP output oracles ---
  "opadapters/blast.md": {
    family: "opstack-output-oracle", tier: "committee", why: "L1 via sync committee; Blast state trusts the proposer", finalized: false,
    bundle: { basis: "live-mainnet", network: "PROPOSED full bundle", txs: [{ gas: "3,048,294 gas", calldata: "30,884 B" }] },
    rotation: OP_ROT,
    finality: { file: "src/verifiers/evm/opstack/oracle/README.md", at: "Blast and Mantle: one output interval (about 1 h)", seconds: 3600, note: "PROPOSED latency" },
    cadence: { at: "Outputs every 1,800 L2 blocks (about 1 h)", seconds: 3600 },
  },
  "opadapters/fraxtal.md": {
    family: "opstack-output-oracle", tier: "committee", why: "L1 via sync committee; no state validation, trusts the proposer", finalized: false,
    bundle: { basis: "live-mainnet", network: "FINALIZED full bundle", txs: [{ gas: "3,031,541 gas", calldata: "30,564 B" }] },
    rotation: { gas: "about 4.84M gas", calldata: "66,902 B", basis: "family-proxy" },
    finality: { at: "FINALIZED delivers about 7 days after an", seconds: 604800 },
    cadence: { at: "Outputs are posted every 1,800 L2 blocks (about 1 h)", seconds: 3600 },
  },
  "opadapters/katana.md": {
    family: "opstack-output-oracle", ...OP_TIER, finalized: false,
    bundle: { basis: "live-mainnet", network: "FINALIZED full bundle", txs: [{ gas: "2,634,859 gas", calldata: "22,756 B" }] },
    rotation: OP_ROT,
    finality: { file: "src/verifiers/evm/opstack/oracle/README.md", at: "Katana up to about 1 h", seconds: 3600 },
    cadence: { at: "One output per AggLayer certificate, about 1 h", seconds: 3600 },
  },
  "opadapters/mantle.md": {
    family: "opstack-output-oracle", ...OP_TIER, finalized: false,
    bundle: { basis: "live-mainnet", network: "FINALIZED full bundle", txs: [{ gas: "3,640,599 gas", calldata: "37,732 B" }] },
    rotation: OP_ROT,
    finality: { file: "src/verifiers/evm/opstack/oracle/README.md", at: "Mantle about 12 h + up to 1 h", seconds: 46800, note: "upper bound, FINALIZED" },
    cadence: { at: "Outputs every ≥ 1,800 L2 blocks (about 1 h)", seconds: 3600 },
  },
  // --- dYdX ---
  "dydx/dydx.md": {
    family: "cosmos-module-cometbft", tier: "light-client", finalized: true,
    bundle: { basis: "live-partial", network: "mainnet commit + one store entry (module not on mainnet)", txs: [{ gas: "7,033,228 gas", calldata: "3.8 KB" }] },
    rotation: { gas: "estimate 7.1–7.2M", basis: "estimate", note: "same as a bundle at the rotation header" },
    multiTx: [{ at: "Catch-up across a rotation about 14M (estimate): use the accumulator", note: "catch-up across a rotation uses the commit accumulator" }],
  },
  // --- BSC Parlia ---
  "bsc/anubis.md": {
    family: "bsc-parlia-fast-finality", tier: "light-client", finalized: true,
    bundle: { basis: "family-proxy", network: "BSC mainnet, same 21-validator size", txs: [{ gas: "1,953,408 gas", calldata: "23,684 B" }] },
    rotation: { gas: "about 0.41M gas", calldata: "5.4 KB", basis: "family-proxy", increment: true, note: "BSC mainnet, added per rotation" },
  },
  "bsc/bnb-smart-chain.md": {
    family: "bsc-parlia-fast-finality", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "1,953,408 gas", calldata: "23,684 B calldata" }] },
    rotation: { gas: "2,439,616 gas", calldata: "29,060 B", basis: "live-mainnet", note: "bundle with one rotation" },
  },
  "bsc/bot-chain.md": {
    family: "bsc-parlia-fast-finality", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "1,097,399 gas", calldata: "9,124 B calldata" }] },
    rotation: { gas: "1,460,454 gas", calldata: "10,820 B calldata", basis: "live-mainnet", note: "bundle with one rotation" },
  },
  "bsc/core.md": {
    family: "bsc-parlia-fast-finality", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "1,745,153 gas", calldata: "19,812 B calldata" }] },
    rotation: { gas: "2,145,690 gas", calldata: "22,436 B calldata", basis: "live-mainnet", note: "bundle with one rotation" },
  },
  // --- Avalanche Warp ---
  "flare/avalanche-c-chain.md": {
    family: "avalanche-warp", tier: "light-client", finalized: true,
    bundle: { basis: "live-testnet", network: "Fuji", txs: [{ gas: "1,738,297 gas", calldata: "23,172 B" }], note: "mainnet-scale synthetic: 2,040,114 gas, 63,236 B" },
    rotation: { gas: "1,861,747 gas", calldata: "23,396 B", basis: "live-testnet" },
  },
  "flare/flare.md": {
    family: "avalanche-warp", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "2,307,686 gas", calldata: "38,660 B" }] },
    rotation: { gas: "2,548,571 gas", calldata: "38,884 B", basis: "live-mainnet" },
  },
  // --- Solana ---
  "solana/solana.md": {
    family: "solana-alpenglow", tier: "committee", why: "K-of-N attestor committee for queue state; Alpenglow certificate for finality", finalized: true,
    bundle: { basis: "live-testnet", network: "ALPENGLOW, devnet certificate", txs: [{ gas: "429,023 gas", calldata: "7,812 B" }] },
    rotation: { gas: "74,285 execution gas", calldata: "3,296 B", basis: "synthetic", note: "committee 5 → 7" },
  },
  // --- Stellar ---
  "stellar/stellar.md": {
    family: "stellar-scp", tier: "light-client", finalized: true,
    bundle: {
      basis: "live-mainnet", network: "pubnet (harness)",
      txs: [{ gas: "13.38M gas", calldata: "83.7 KB" }, { gas: "1.92M gas", calldata: "68.4 KB" }],
      note: "testnet: 1 transaction, 2.21M gas / 32.2 KB",
    },
    rotation: { gas: "10.58M gas", calldata: "113.2 KB", basis: "live-mainnet" },
    cadence: { file: "src/verifiers/evm/stellar/README.md", at: "Archive checkpoints are published every 64 ledgers (~6 min)", seconds: 360 },
  },
  // --- TRON ---
  "tron/tron.md": {
    family: "tron-dpos-attestor", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "959,816 gas", calldata: "5,508 B calldata" }] },
    rotation: { gas: "2,750,499 gas", calldata: "13,796 B", basis: "live-mainnet", note: "rotation + bundle" },
    multiTx: [{ file: "src/verifiers/evm/tron/README.md", at: "Every bundle needs one `attestQueue` transaction on TRON", note: "one attestQueue transaction on TRON (energy) per bundle" }],
  },
  // --- Bitcoin SPV ---
  "bitcoin/bitcoin-cash.md": {
    family: "bitcoin-spv", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", network: "6 real mainnet headers, no messages", txs: [{ gas: "105,368 gas", calldata: "1,284 B calldata" }] },
    rotation: { none: true, note: "no validator set" },
    catchUp: { gas: "1,711,498 gas", calldata: "12,324 B calldata", note: "one day of lag (144 headers)" },
  },
  "bitcoin/bitcoin.md": {
    family: "bitcoin-spv", tier: "light-client", finalized: true,
    bundle: { basis: "live-testnet", network: "regtest", txs: [{ gas: "192,050 gas", calldata: "3,972 B calldata" }] },
    rotation: { none: true, note: "no validator set" },
    finality: { at: "about 1 hour at `k = 6`", seconds: 3600 },
  },
  // --- Ethereum twins ---
  "ethtwins/gnosis.md": {
    family: "eth-beacon-twin", tier: "committee", why: "sync committee (512 keys)", finalized: false,
    bundle: { basis: "live-mainnet", txs: [{ gas: "1,934,671 gas", calldata: "23,108 B calldata" }] },
    rotation: { gas: "4,836,051 gas", calldata: "66,902 B", basis: "live-mainnet", note: "_verifyRotation alone" },
  },
  "ethtwins/pulsechain.md": {
    family: "eth-beacon-twin", tier: "committee", why: "sync committee (512 keys)", finalized: false,
    bundle: { basis: "live-mainnet", txs: [{ gas: "1,320,015 gas", calldata: "12,452 B calldata" }] },
    rotation: { gas: "6,195,813 gas", calldata: "79,300 B calldata", basis: "live-mainnet" },
  },
  // --- Ethereum ---
  "ethereum/ethereum.md": {
    family: "ethereum-sync-committee", tier: "committee", why: "sync committee (512 keys) over the attested header", finalized: false,
    bundle: { basis: "live-testnet", network: "Sepolia data, executed on Hedera testnet", txs: [{ gas: "1,645,052 gas", calldata: "19,140 B calldata" }] },
    rotation: { gas: "4,836,081 gas", calldata: "66,902 B", basis: "live-testnet" },
    rotationCadence: { at: "once per 8,192 slots, about 27 h" },
    hederaCost: "test/e2e/fixtures/sepolia-live/hiero-gas-hedera-testnet.json",
  },
  // --- Arbitrum ---
  "arbitrum/arbitrum-nova.md": { family: "arbitrum-nitro-bold", ...OP_TIER, finalized: false, ...ARB_PROXY },
  "arbitrum/arbitrum-one.md": { family: "arbitrum-nitro-bold", ...OP_TIER, finalized: false, ...ARB_PROXY },
  "arbitrum/reya.md": { family: "arbitrum-nitro-bold", ...OP_TIER, finalized: false, ...ARB_PROXY },
  "arbitrum/robinhood-chain.md": { family: "arbitrum-nitro-bold", ...OP_TIER, finalized: false, ...ARB_PROXY },
  "arbitrum/plume.md": {
    family: "arbitrum-nitro-bold", ...OP_TIER, finalized: false,
    bundle: { basis: "live-mainnet", txs: [{ gas: "2,459,563 gas", calldata: "24,996 B calldata" }] },
    rotation: { gas: "7,408,325 gas", calldata: "91,268 B", basis: "live-mainnet" },
    finality: { file: "src/verifiers/evm/arbitrum/README.md", at: "about 5.6 days on Plume", seconds: 483840, note: "state reaches Hiero 5.6 to 6.1 days after it is produced" },
    cadence: { at: "Plume asserts about every 12 h", seconds: 43200 },
  },
  // --- Canton ---
  "canton/canton.md": {
    family: "canton-attested-operators", tier: "attested", why: "t-of-n CLPR operators attest; nothing about Canton is proven", finalized: true,
    caip2: { id: "canton:sandbox", provisional: true, why: "no CAIP-2 namespace yet; id pinned by the deployment (e2e test)" },
    bundle: { basis: "live-testnet", network: "local sandbox e2e, 2-of-3, 3 messages", txs: [{ gas: "66,260 gas" }], note: "calldata not stated for the e2e run; synthetic n=10: 4,544 B" },
    rotation: { gas: "75,128 gas", basis: "live-testnet", note: "2-of-3 + one rotation, 1 message" },
  },
  // --- GRANDPA / BEEFY ---
  "grandpa/bifrost-network.md": {
    family: "grandpa", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "8,439,093 gas", calldata: "8,100 B" }] },
    rotation: { gas: "8,430,845 gas", calldata: "8,388 B", basis: "live-mainnet" },
  },
  "grandpa/bittensor.md": {
    family: "grandpa", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "9.36M gas", calldata: "14.3 KB" }] },
    rotation: { gas: "9.34M gas", calldata: "14.1 KB", basis: "live-mainnet" },
  },
  "grandpa/chainflip.md": {
    family: "grandpa-pallet-accumulator", tier: "light-client", finalized: true,
    bundle: {
      basis: "live-mainnet", network: "finality and storage proofs; no CLPR pallet, so no queue",
      txs: [
        { label: "5 accumulator transactions (total)", gas: "total 56,318,367 gas", calldata: "largest 12,232,209 gas, 7,972 B", calldataMaxPerTx: true, count: 5, gasIsTotal: true },
        { label: "verifyBundle", gas: "559,394 gas", calldata: "10,404 B" },
      ],
      note: "accumulator calldata: 5 × the largest (upper bound)",
    },
    rotation: { gas: "total 56,917,055 gas", basis: "live-mainnet", note: "5 accumulator transactions, then verifyBundle at 701,762 gas" },
    edgeStatus: { status: "projected", why: "no CLPR pallet exists on Chainflip, so there is no queue to deliver from" },
    rotationCadence: { at: "6 s block time that is about 72.5 hours" },
  },
  "grandpa/hydration.md": {
    family: "beefy-parachain", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "4.22M gas", calldata: "52.5 KB" }] },
    rotation: { gas: "4.16M gas", calldata: "50.9 KB", basis: "live-mainnet" },
    catchUp: { gas: "7.39M gas", calldata: "91.7 KB", note: "hop + newer commitment" },
  },
  // --- ZK Stack ---
  "zksync/abstract.md": {
    family: "zksync-era", tier: "committee", why: "L1 via sync committee + ZK Stack validity proofs", finalized: false,
    bundle: { proxyOf: "zksync/zksync-era.md" },
    rotation: { proxyOf: "zksync/zksync-era.md" },
  },
  "zksync/zksync-era.md": {
    family: "zksync-era", tier: "committee", why: "L1 via sync committee + ZK Stack validity proofs", finalized: false,
    bundle: { basis: "live-testnet", network: "ZKsync Sepolia, one tx", txs: [{ gas: "14,529,485 gas", calldata: "27,492 B" }], note: "can split: recordStorage 12,632,320 gas + verifyBundle 1,946,164 gas" },
    rotation: { gas: "synthetic 5.12M execution gas", calldata: "69,675 proof bytes", basis: "synthetic", note: "in-bundle" },
    finality: { at: "`ValidatorTimelock.executionDelay()` was 10,800 s (3 hours)", seconds: 10800, note: "plus proving time; lower bound, not measured by a test" },
  },
  // --- Arc / Plasma ---
  "arcplasma/arc.md": {
    family: "arc-malachite", tier: "light-client", finalized: true,
    caipNote: "testnet id; mainnet not checked",
    bundle: { basis: "live-testnet", txs: [{ gas: "7,862,185 gas", calldata: "12,036 B calldata" }] },
    rotation: { gas: "11,973,337 gas", calldata: "28,804 B calldata", basis: "live-testnet", note: "bundle + rotation" },
  },
  "arcplasma/plasma.md": {
    family: "plasmabft-committee", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "3,320,812 gas", calldata: "9,316 B calldata" }] },
    rotation: { none: true, note: "not supported; a committee change halts the channel" },
  },
  // --- Monad ---
  "monad/monad.md": {
    family: "monadbft", tier: "light-client", finalized: true,
    bundle: { basis: "synthetic", network: "196 validators; full bundle needs own node", txs: [{ gas: "1.89M tx gas", calldata: "37.1 KB calldata" }], note: "live QC check on mainnet: about 0.98M gas, 32 KB" },
    rotation: { gas: "about 35M gas total", basis: "synthetic", note: "warm rotation: 4 transactions" },
    multiTx: [{ at: "warm 4 transactions", note: "an epoch rotation takes 4 (warm) to 8 (cold) transactions" }],
  },
  // --- XRPL lab ---
  "xrpl/hyperliquid.md": {
    family: "hyperevm-attestors", tier: "attested", why: "t-of-n attestors; nothing about HyperEVM is proven", finalized: false,
    bundle: { basis: "live-mainnet", network: "live block, test attestors", txs: [{ gas: "556,441 gas", calldata: "3,332 B" }] },
    rotation: { gas: "734,875 gas", calldata: "4,612 B", basis: "live-mainnet" },
  },
  "xrpl/mixin.md": {
    family: "mixin-kernel", tier: "attested", why: "kernel CoSi is verified, but the MTG app's k-of-n members decide record content", finalized: true,
    caip2: { id: "mixin:mainnet", provisional: true, why: "no registered CAIP-2 namespace; id used by the tests" },
    bundle: { basis: "live-mainnet", txs: [{ gas: "1,208,229 gas", calldata: "3,364 B" }] },
    rotation: { gas: "3,248,524 gas", calldata: "6,308 B", basis: "live-mainnet" },
  },
  "xrpl/xrp-ledger.md": {
    family: "xrpl-validators", tier: "attested", why: "UNL validations are verified, but the outbox's k-of-n signer list decides message content", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "5,883,034 gas", calldata: "11,812 B" }], note: "testnet via skip list: 6,890,892 gas, 15,204 B" },
    rotation: { gas: "7,665,815 gas", calldata: "13,700 B", basis: "live-mainnet" },
  },
  // --- Starknet ---
  "starknet/starknet.md": {
    family: "starknet", tier: "committee", why: "L1 via sync committee + Starknet validity proofs", finalized: false,
    bundle: { basis: "live-testnet", network: "Starknet Sepolia, ACK-only", txs: [{ gas: "7,145,849 gas", calldata: "28,900 B calldata" }] },
    rotation: { gas: "9,062,012 execution gas", calldata: "76,109 B proof", basis: "synthetic", note: "in-bundle" },
    finality: { at: "10 minutes after the Starknet head passed them", seconds: 600, note: "Sepolia observation, not measured by a test" },
  },
  // --- NEAR / TON / Aurora ---
  "neartons/aurora.md": {
    family: "aurora-near", tier: "light-client", finalized: true,
    bundle: {
      basis: "live-mainnet", network: "live Aurora silo on NEAR mainnet",
      txs: [{ label: "cache", gas: "(8.90M" }, { label: "cache", gas: "4.92M gas" }, { label: "bundle", gas: "2.80M gas", calldata: "64.7 KB" }],
      note: "cache transaction calldata not stated",
    },
    rotation: { gas: "+679 gas", basis: "live-mainnet", increment: true, note: "NEAR epoch change inside the bundle" },
  },
  "neartons/near.md": {
    family: "near-light-client", tier: "light-client", finalized: true,
    bundle: {
      basis: "live-mainnet",
      txs: [{ label: "cache", count: 2, gas: "(8.90M" }, { label: "cache", gas: "4.02M gas" }, { label: "bundle", gas: "1.26M gas", calldata: "18.1 KB" }],
      note: "cache transaction calldata not stated; testnet inline: 2.94M gas, 9.8 KB",
    },
    rotation: { gas: "+600 gas", basis: "live-mainnet", increment: true, note: "epoch change inside the bundle" },
  },
  "neartons/ton.md": {
    family: "ton-light-client", tier: "light-client", finalized: true,
    bundle: {
      basis: "live-mainnet",
      txs: [{ label: "cache", count: 4, gas: "about 12.44M gas each" }, { label: "bundle", gas: "1.90M gas", calldata: "15.8 KB" }],
      note: "cache transaction calldata not stated; testnet inline: 7.61M gas, 7.7 KB",
    },
    rotation: { gas: "Mainnet 5.88M gas", calldata: "32.6 KB", basis: "live-mainnet", note: "plus 4 cache transactions for the key block" },
  },
  // --- Kaia / signer replay ---
  "kaiasigner/grx-chain.md": {
    family: "signer-replay", tier: "committee", why: "majority of 3 validators; no finality", finalized: false,
    bundle: { basis: "live-mainnet", txs: [{ gas: "1,427,520 gas", calldata: "16,516 B calldata" }] },
    rotation: { gas: "1,434,413 gas", calldata: "16,516 B calldata", basis: "live-mainnet" },
  },
  "kaiasigner/immutable-zkevm.md": {
    family: "signer-replay", tier: "attested", why: "a single Clique signer key", finalized: false,
    bundle: { basis: "live-mainnet", txs: [{ gas: "1,536,232 gas", calldata: "18,404 B calldata" }] },
    rotation: { gas: "1,540,088 gas", calldata: "18,404 B calldata", basis: "live-mainnet" },
  },
  "kaiasigner/kaia.md": {
    family: "kaia-istanbul", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "1,501,674 gas", calldata: "14,500 B calldata" }] },
    rotation: { gas: "1,609,912 gas", calldata: "14,468 B calldata", basis: "live-mainnet" },
  },
  "kaiasigner/kub-chain.md": {
    family: "signer-replay", tier: "committee", why: "majority of 6-7 signers incl. the super node; no finality", finalized: false,
    bundle: { basis: "live-mainnet", txs: [{ gas: "942,986 gas", calldata: "10,628 B calldata" }] },
    rotation: { gas: "1,041,365 gas", calldata: "10,628 B calldata", basis: "live-mainnet" },
  },
  "kaiasigner/ontology.md": { family: null, bundle: null, why: "blocked: no EVM state proofs" },
  // --- Bitcoin L2s ---
  "btcl2s/rootstock.md": {
    family: "rootstock-merged-mining", tier: "light-client", finalized: true,
    bundle: { basis: "live-partial", network: "12-header window on mainnet (headers only)", txs: [{ gas: "2,422,030 gas", calldata: "16,932 B" }], note: "full bundle on regtest: 1,090,059 gas, 14,468 B" },
    rotation: { none: true, note: "no validator set" },
    finality: { at: "about 7 minutes at `k = 12`", seconds: 420 },
  },
  "btcl2s/stacks.md": {
    family: "stacks-signers", tier: "committee", why: "70%-of-weight signer committee; Bitcoin anchoring not checked", finalized: true,
    bundle: { basis: "live-mainnet", network: "queue record synthetic", txs: [{ gas: "12,084,553 gas", calldata: "56,868 B calldata" }] },
    rotation: { gas: "13,136,304 gas", calldata: "59,844 B calldata", basis: "live-mainnet", note: "per reward cycle" },
  },
  // --- BLS committees ---
  "conflux/conflux.md": {
    family: "conflux-pos-bls", tier: "light-client", finalized: true,
    bundle: { basis: "live-partial", network: "finality + pivot header; no storage proof", txs: [{ gas: "446,398 gas", calldata: "4,356 B" }] },
    rotation: { gas: "1,000,171 gas", calldata: "10,180 B", basis: "live-mainnet", note: "per PoS epoch" },
  },
  "conflux/flow.md": { family: null, bundle: null, why: "blocked: no public EVM storage proofs" },
  "conflux/sonic.md": { family: null, bundle: null, why: "blocked: no BLS finality certificate on mainnet" },
  // --- Cardano / Algorand ---
  "cardalgo/algorand.md": {
    family: "algorand-state-proofs", tier: "committee", why: "state-proof threshold over the top 1,024 accounts (sampled weight)", finalized: true,
    bundle: { basis: "live-mainnet", txs: [{ gas: "457,701 gas", calldata: "2,112 B" }] },
    rotation: { gas: "703.1M gas", basis: "live-mainnet", note: "every 256 rounds: 62 transactions (max 11,792,178 gas and 7,012 B each)" },
    rotationCadence: { at: "Every 256 rounds (about 12 minutes)" },
    multiTx: [{ at: "every interval must be accumulated", note: "every 256-round interval must be accumulated (62 transactions on mainnet) to keep the channel live" }],
  },
  "cardalgo/cardano.md": {
    family: "cardano-mithril", tier: "committee", why: "Mithril stake-pool multi-signature, not Ouroboros itself", finalized: true,
    bundle: { basis: "live-testnet", network: "preprod, with one epoch rotation", txs: [{ gas: "2,153,379 gas", calldata: "5,092 B" }] },
    rotation: { gas: "11,218,993 gas", calldata: "79,204 B", basis: "live-mainnet", note: "rotation + certificate" },
    rotationCadence: { at: "Every epoch (5 days)" },
    edgeStatus: { status: "projected", why: "mainnet bundles blocked" },
  },
  // --- hard cases ---
  "hard51/afx.md": { family: null, bundle: null, why: "blocked: no node source, no RPC, no signed state commitment" },
  "hard51/fantom-opera.md": { family: null, bundle: null, why: "blocked: no eth_getProof and no public LLR vote export" },
  "hard51/osmosis.md": {
    family: "cosmwasm-cometbft", tier: "light-client", finalized: true,
    bundle: { basis: "estimate", network: "by analogy with Provenance (18 Ed25519 signatures)", txs: [{ gas: "Estimate ~13M gas", calldata: "~9 KB" }] },
    rotation: COMET_SAME,
    edgeStatus: { status: "projected", why: "no CLPR Service until a governance or allow-listed code upload" },
  },
  "hard51/strato.md": { family: "strato-blockstanbul", bundle: null, why: "no verifier yet (sketch only); estimate 200–350k gas, 2–4 KB" },
  "hard51/vite.md": { family: null, bundle: null, why: "blocked: no reachable RPC, single-producer blocks, no state root" },
  // --- Antelope ---
  "antelope/telos.md": {
    family: "antelope-savanna", tier: "light-client", finalized: true,
    bundle: { basis: "synthetic", network: "same policy shape", txs: [{ gas: "437,329 gas", calldata: "3,812 B calldata" }] },
    rotation: { gas: "978,807 gas", calldata: "6,628 B calldata", basis: "synthetic" },
  },
  "antelope/vaulta.md": {
    family: "antelope-savanna", tier: "light-client", finalized: true,
    bundle: { basis: "synthetic", network: "same policy shape", txs: [{ gas: "437,329 gas", calldata: "3,812 B calldata" }] },
    rotation: { gas: "978,807 gas", calldata: "6,628 B calldata", basis: "synthetic" },
  },
  "antelope/xpr-network.md": {
    family: "antelope-dpos", tier: "light-client", finalized: true,
    bundle: { basis: "live-mainnet", network: "finality + inclusion", txs: [{ gas: "3,733,705 gas", calldata: "45,636 B" }] },
    rotation: { gas: "8,672,871 gas", calldata: "92,868 B calldata", basis: "synthetic" },
  },
};

// ---------------------------------------------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------------------------------------------
const cache = new Map();
function git(...args) {
  return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
function show(branch, file) {
  const k = `${branch}:${file}`;
  if (!cache.has(k)) cache.set(k, git("show", k).split("\n"));
  return cache.get(k);
}
function exists(branch, file) {
  try {
    return git("ls-tree", "--name-only", branch, "--", file).trim() === file;
  } catch {
    return false;
  }
}

/** Locate a verbatim substring; prefer the Quick facts table. Returns { line, text, ref }. */
function locate(branch, file, needle, preferRange) {
  const lines = show(branch, file);
  const order = [...lines.keys()];
  if (preferRange) order.sort((a, b) => inRange(b, preferRange) - inRange(a, preferRange));
  for (const i of order) {
    if (lines[i].includes(needle)) return { line: i + 1, text: lines[i].trim(), ref: `${branch}:${file}#L${i + 1}` };
  }
  throw new Error(`not found in ${branch}:${file}: ${JSON.stringify(needle)}`);
}
const inRange = (i, [a, b]) => (i >= a && i < b ? 1 : 0);

// ---------------------------------------------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------------------------------------------
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;
/** Parse the first quantity in `s`. kind: gas → gas units; bytes → bytes (KB = 1,000 B). Ranges → upper bound. */
function parseQty(s, kind) {
  s = s.replace(/ (proof )?bytes\b/, " B");
  const re = new RegExp(`${NUM}(?:\\s*[–-]\\s*${NUM})?\\s*(M|k|KB|B)?`);
  const m = s.match(re);
  if (!m) throw new Error(`no number in ${JSON.stringify(s)}`);
  const v = (x) => Number(x.replace(/,/g, ""));
  let unit = m[3];
  if (!unit && m[2] === undefined) {
    // "(8.90M" style: unit right after the number
    const after = s.slice(m.index + m[0].length).trim();
    if (/^M/.test(after)) unit = "M";
  }
  const mult = unit === "M" ? 1e6 : unit === "k" ? 1e3 : unit === "KB" ? 1e3 : 1;
  if (kind === "bytes" && unit !== "KB" && unit !== "B") {
    // bytes only from an explicit B / KB unit
    const b = s.match(new RegExp(`${NUM}(?:\\s*[–-]\\s*${NUM})?\\s*(KB|B)\\b`));
    if (!b) throw new Error(`no byte figure in ${JSON.stringify(s)}`);
    return parseQty(b[0], "bytes");
  }
  const lo = Math.round(v(m[1]) * mult);
  const hi = m[2] !== undefined ? Math.round(v(m[2]) * mult) : lo;
  return { value: hi, min: lo, max: hi, range: m[2] !== undefined };
}

function quickFacts(lines) {
  const start = lines.findIndex((l) => /^## Quick facts/.test(l));
  if (start < 0) throw new Error("no Quick facts");
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const rows = {};
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*$/);
    if (!m || /^-+$/.test(m[1]) || m[1] === "" || m[1] === "Item") continue;
    rows[m[1]] = { text: m[2], line: i + 1 };
  }
  return { rows, range: [start, end] };
}

function row(rows, ...names) {
  for (const n of names) if (rows[n]) return { key: n, ...rows[n] };
  return null;
}

function classifyStatus(t) {
  const s = t.toLowerCase();
  if (/^in progress \(blocked\)/.test(s) || /^blocked/.test(s)) return "blocked";
  if (/^in progress/.test(s)) return "in-progress";
  if (/^family-covered/.test(s)) return "family-covered";
  if (/live-verified/.test(s)) return "live-verified";
  throw new Error(`unknown status ${t}`);
}

function statusReason(t) {
  const i = t.search(/[:;]/);
  return i < 0 ? null : t.slice(i + 1).trim();
}

const dateIn = (s) => s.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;

// ---------------------------------------------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------------------------------------------
function figure(branch, file, spec, qfRange, kind) {
  if (spec === undefined || spec === null) return null;
  const at = locate(branch, file, spec, qfRange);
  const q = parseQty(spec, kind);
  return { value: q.value, ...(q.range ? { min: q.min, max: q.max } : {}), quote: spec, source: at.ref };
}

function buildTxs(branch, file, txs, qfRange) {
  const out = [];
  let gas = 0;
  let calldata = 0;
  let calldataComplete = true;
  for (const t of txs) {
    const count = t.count ?? 1;
    const g = figure(branch, file, t.gas, qfRange, "gas");
    const c = t.calldata ? figure(branch, file, t.calldata, qfRange, "bytes") : null;
    gas += t.gasIsTotal ? g.value : g.value * count;
    if (c) calldata += c.value * count;
    else calldataComplete = false;
    out.push({
      ...(t.label ? { label: t.label } : {}),
      count,
      gas: g,
      ...(t.gasIsTotal ? { gasIsTotal: true } : {}),
      calldataBytes: c ?? { value: null, reason: "not stated in the source" },
      ...(t.calldataMaxPerTx ? { calldataIsMaxPerTx: true } : {}),
    });
  }
  return { gas, calldata: calldataComplete || calldata > 0 ? calldata : null, calldataComplete, txs: out };
}

function buildBundle(key, cur, ctx) {
  const spec = cur.bundle;
  if (!spec) return { gas: null, calldataBytes: null, reason: cur.why ?? "not measured" };
  if (spec.proxyOf) {
    const [pb, pf] = spec.proxyOf.split("/");
    const p = CURATION[spec.proxyOf].bundle;
    const qf = quickFacts(show(`pr/${pb}`, `docs/chains/${pf}`));
    const b = buildTxs(`pr/${pb}`, `docs/chains/${pf}`, p.txs, qf.range);
    return {
      gas: b.gas, calldataBytes: b.calldata, basis: "family-proxy", network: `${pf.replace(".md", "")}: ${p.network ?? ""}`.trim(),
      transactions: b.txs.reduce((a, t) => a + t.count, 0), txs: b.txs,
      ...(b.calldataComplete ? {} : { calldataIncomplete: true }),
      note: `not measured on this chain; ${spec.proxyOf} figures (cost does not depend on the chain)`,
      text: ctx.typical?.text ?? null, textSource: ctx.typical ? `${ctx.branch}:${ctx.file}#L${ctx.typical.line}` : null,
    };
  }
  const b = buildTxs(ctx.branch, ctx.file, spec.txs, ctx.qfRange);
  return {
    gas: b.gas,
    calldataBytes: b.calldata,
    basis: spec.basis,
    ...(spec.network ? { network: spec.network } : {}),
    transactions: b.txs.reduce((a, t) => a + t.count, 0),
    txs: b.txs,
    ...(b.calldataComplete ? {} : { calldataIncomplete: true }),
    ...(spec.note ? { note: spec.note } : {}),
    text: ctx.typical?.text ?? null,
    textSource: ctx.typical ? `${ctx.branch}:${ctx.file}#L${ctx.typical.line}` : null,
  };
}

function buildRotation(cur, ctx, bundle) {
  const r = cur.rotation;
  const text = ctx.rotRow?.text ?? null;
  const textSource = ctx.rotRow ? `${ctx.branch}:${ctx.file}#L${ctx.rotRow.line}` : null;
  if (!r) return { gas: null, calldataBytes: null, reason: cur.why ?? "not measured", text, textSource };
  if (r.proxyOf) {
    const [pb, pf] = r.proxyOf.split("/");
    const p = CURATION[r.proxyOf].rotation;
    const qf = quickFacts(show(`pr/${pb}`, `docs/chains/${pf}`));
    const g = figure(`pr/${pb}`, `docs/chains/${pf}`, p.gas, qf.range, "gas");
    const c = p.calldata ? figure(`pr/${pb}`, `docs/chains/${pf}`, p.calldata, qf.range, "bytes") : null;
    return { gas: g.value, calldataBytes: c?.value ?? null, basis: "family-proxy", gasSource: g, calldataSource: c, note: `${r.proxyOf} figure; ${p.note ?? ""}`.trim(), text, textSource };
  }
  if (r.none) return { gas: null, calldataBytes: null, reason: `no rotation: ${r.note}`, text, textSource };
  if (r.sameAsBundle) return { gas: bundle.gas, calldataBytes: bundle.calldataBytes, basis: bundle.basis, sameAsBundle: true, note: r.note, text, textSource };
  if (r.txs) {
    const b = buildTxs(ctx.branch, ctx.file, r.txs, ctx.qfRange);
    return { gas: b.gas, calldataBytes: b.calldata, basis: r.basis, transactions: b.txs.reduce((a, t) => a + t.count, 0), txs: b.txs, text, textSource };
  }
  const g = figure(ctx.branch, ctx.file, r.gas, ctx.qfRange, "gas");
  const c = r.calldata ? figure(ctx.branch, ctx.file, r.calldata, ctx.qfRange, "bytes") : null;
  return {
    gas: g.value, calldataBytes: c?.value ?? null, basis: r.basis,
    ...(r.increment ? { increment: true } : {}),
    gasSource: g, calldataSource: c ?? { value: null, reason: "not stated in the source" },
    ...(r.note ? { note: r.note } : {}),
    text, textSource,
  };
}

function timeFact(spec, ctx) {
  if (!spec) return null;
  const file = spec.file ?? ctx.file;
  const at = locate(ctx.branch, file, spec.at);
  return { seconds: spec.seconds ?? null, quote: spec.at, ...(spec.note ? { note: spec.note } : {}), source: at.ref };
}

function reverseDirection(lines, branch, file) {
  const h = lines.findIndex((l) => /^## Hiero → /.test(l));
  if (h < 0) return { status: "blocked", reason: "no Hiero → chain section on this page; blocked for every chain (clprouter-spec.md 'Where Hiero stands today')", source: null };
  let i = h + 1;
  while (i < lines.length && lines[i].trim() === "") i++;
  const para = [];
  let j = i;
  for (; j < lines.length && lines[j].trim() !== "" && !/^## /.test(lines[j]); j++) para.push(lines[j].trim());
  return { status: "blocked", heading: lines[h].replace(/^## /, ""), text: para.join(" "), source: `${branch}:${file}#L${h + 1}` };
}

function main() {
  const branchShas = {};
  for (const b of BRANCHES) branchShas[b] = git("rev-parse", b).trim();
  const branchDates = Object.fromEntries(BRANCHES.map((b) => [b, git("log", "-1", "--format=%cs", b).trim()]));
  const asOf = Object.values(branchDates).sort().at(-1);

  const chains = [];
  const seenCuration = new Set();
  for (const branch of BRANCHES) {
    const short = branch.replace(/^pr\//, "");
    const pages = git("ls-tree", "-r", "--name-only", branch, "docs/chains/")
      .split("\n").filter((f) => f.endsWith(".md") && !f.endsWith("/README.md"));
    const index = show(branch, "docs/chains/README.md");
    for (const file of pages) {
      const page = posix.basename(file);
      const key = `${short}/${page}`;
      const cur = CURATION[key];
      if (!cur) throw new Error(`no curation for ${key}`);
      seenCuration.add(key);
      const lines = show(branch, file);
      const { rows, range } = quickFacts(lines);
      const title = lines[0].replace(/^# /, "");
      const name = title.split(/ → | · /)[0].trim();

      // status from the branch's chain index
      const idx = index.findIndex((l) => l.startsWith("|") && (l.includes(`(${page})`) || l.includes(`(./${page})`)));
      if (idx < 0) throw new Error(`${key}: not in docs/chains/README.md`);
      const cells = index[idx].split("|").map((c) => c.trim()).slice(1, -1);
      const header = index.slice(0, idx).reverse().find((l) => /^\|\s*Chain\s*\|/.test(l));
      const hcells = header.split("|").map((c) => c.trim()).slice(1, -1);
      const statusText = cells[hcells.indexOf("Status")];
      const statusClass = classifyStatus(statusText);

      // CAIP-2
      const idRow = row(rows, "Chain id / CAIP-2", "CAIP-2");
      let caip2 = null;
      if (cur.caip2) caip2 = { id: cur.caip2.id, provisional: true, reason: cur.caip2.why, source: idRow ? `${branch}:${file}#L${idRow.line}` : null };
      else if (idRow) {
        const tok = [...idRow.text.matchAll(/`([^`]+)`/g)].map((m) => m[1]).find((t) => CAIP2.test(t));
        if (tok) caip2 = { id: tok, source: `${branch}:${file}#L${idRow.line}`, ...(cur.caipNote ? { note: cur.caipNote } : {}) };
      }
      if (!caip2) caip2 = { id: null, reason: `no CAIP-2 id in the source: ${idRow?.text ?? "no id row"}`, source: idRow ? `${branch}:${file}#L${idRow.line}` : null };

      const trustRow = row(rows, "Trust tier");
      const verRow = row(rows, "Verifier", "Verifier contract", "Contract", "Contracts");
      const finRow = row(rows, "Finality source");
      const typical = row(rows, "Typical bundle", "Typical full bundle", "Typical proof", "Typical bundle / rotation");
      const rotRow = row(rows, "Rotation", "Rotation bundle", "Typical bundle / rotation");
      const ctx = { branch, file, qfRange: range, typical, rotRow };

      // verifier README: from links in the verifier row, else family READMEs on the branch
      const links = verRow ? [...verRow.text.matchAll(/\]\(([^)]+)\)/g)].map((m) => posix.normalize(posix.join("docs/chains", m[1]))) : [];
      let verifierReadme = links.find((l) => l.endsWith("README.md") && exists(branch, l)) ?? null;
      if (!verifierReadme && links.length) {
        const dir = posix.dirname(links[0]);
        if (exists(branch, `${dir}/README.md`)) verifierReadme = `${dir}/README.md`;
      }

      const bundle = buildBundle(key, cur, ctx);
      const rotation = buildRotation(cur, ctx, bundle);
      const catchUp = cur.catchUp
        ? {
            gas: figure(branch, file, cur.catchUp.gas, range, "gas"),
            calldataBytes: cur.catchUp.calldata ? figure(branch, file, cur.catchUp.calldata, range, "bytes") : null,
            note: cur.catchUp.note,
          }
        : null;
      const multiTx = [];
      if (bundle.transactions > 1) multiTx.push({ note: `a bundle takes ${bundle.transactions} transactions on Hiero`, source: bundle.textSource });
      for (const m of cur.multiTx ?? []) {
        const at = locate(branch, m.file ?? file, m.at, m.file ? undefined : range);
        multiTx.push({ note: m.note, quote: m.at, source: at.ref });
      }

      const finality = timeFact(cur.finality, ctx);
      const cadence = timeFact(cur.cadence, ctx);
      const rotationCadence = cur.rotationCadence ? timeFact({ ...cur.rotationCadence, seconds: null }, ctx) : null;
      const verifierExists = cur.family !== null && cur.bundle !== null;

      let edge = null;
      if (caip2.id && bundle.gas !== null && statusClass !== "blocked") {
        if (cur.edgeStatus) edge = { status: cur.edgeStatus.status, reason: cur.edgeStatus.why };
        else if (statusClass === "in-progress") edge = { status: "projected", reason: `in progress: ${statusReason(statusText) ?? statusText}` };
        else edge = { status: "active", reason: statusText };
      }

      chains.push({
        key,
        name,
        title,
        caip2,
        branch,
        branchSha: branchShas[branch],
        page: file,
        status: {
          class: statusClass,
          text: statusText,
          ...(statusClass === "blocked" || statusClass === "in-progress" ? { reason: statusReason(statusText) ?? cur.why ?? null } : {}),
          source: `${branch}:docs/chains/README.md#L${idx + 1}`,
          date: dateIn(statusText) ?? dateIn(title),
        },
        chainType: row(rows, "Chain type")?.text ?? null,
        verifier: {
          family: cur.family,
          text: verRow?.text ?? null,
          source: verRow ? `${branch}:${file}#L${verRow.line}` : null,
          readme: verifierReadme ? `${branch}:${verifierReadme}` : null,
          exists: verifierExists,
        },
        finalitySource: finRow ? { text: finRow.text, source: `${branch}:${file}#L${finRow.line}` } : null,
        trust: {
          text: trustRow?.text ?? null,
          source: trustRow ? `${branch}:${file}#L${trustRow.line}` : null,
          tier: cur.tier ?? null,
          tierRationale: cur.why && cur.tier ? cur.why : cur.tier ? "verifier checks the source chain's own consensus quorum" : "no verifier",
          finalized: cur.finalized ?? null,
        },
        bundle,
        rotation,
        ...(catchUp ? { catchUp } : {}),
        multiTx: multiTx.length ? multiTx : null,
        finalityTime: finality ?? { seconds: null, reason: "not stated in the chain page or verifier README" },
        bundleCadence: cadence ?? { seconds: null, reason: "not stated in the chain page or verifier README" },
        ...(rotationCadence ? { rotationCadence } : {}),
        toHiero: edge ?? { status: "none", reason: !caip2.id ? "no CAIP-2 id" : bundle.gas === null ? `no bundle figure: ${bundle.reason}` : `blocked: ${statusReason(statusText) ?? statusText}` },
        fromHiero: reverseDirection(lines, branch, file),
      });
    }
  }
  for (const k of Object.keys(CURATION)) if (!seenCuration.has(k)) throw new Error(`curation for unknown page ${k}`);
  const ids = chains.map((c) => c.caip2.id).filter(Boolean);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`duplicate CAIP-2 ${dup}`);
  chains.sort((a, b) => a.name.localeCompare(b.name));

  // Hedera ledger + measured gas price from the Ethereum fixture
  const eth = CURATION["ethereum/ethereum.md"];
  const fixtureFile = eth.hederaCost;
  const fixture = JSON.parse(show("pr/ethereum", fixtureFile).join("\n"));
  const hbar = fixture.verify.chargedTinybar / fixture.tinybarPerHbar;
  const hederaGasPrice = hbar / fixture.verify.gasConsumed;
  const fixtureRef = `pr/ethereum:${fixtureFile}#L${locate("pr/ethereum", fixtureFile, `"chargedTinybar": ${fixture.verify.chargedTinybar}`).line}`;
  const sample = JSON.parse(readFileSync(join(SDK, "src/data/sample-graph.json"), "utf8"));
  const sampleLedger = Object.fromEntries(sample.ledgers.map((l) => [l.id, l]));
  const hedera = structuredClone(sampleLedger[HEDERA]);
  hedera.gasPriceNative = hederaGasPrice;
  hedera.sources = {
    gasPriceNative: { kind: "measured", ref: `${fixtureRef}: ${fixture.verify.gasConsumed} gas charged ${fixture.verify.chargedTinybar} tinybar on Hedera testnet`, date: fixture.measuredAt.slice(0, 10) },
  };

  const ledgers = [hedera];
  const edges = [];
  for (const c of chains) {
    if (c.toHiero.status === "none") continue;
    const s = sampleLedger[c.caip2.id];
    const ledger = {
      id: c.caip2.id,
      name: c.name,
      routerVersion: 1,
      nativeUsd: s?.nativeUsd ?? PLACEHOLDERS.ledger.nativeUsd,
      gasPriceNative: s?.gasPriceNative ?? PLACEHOLDERS.ledger.gasPriceNative,
      enqueueGas: PLACEHOLDERS.ledger.enqueueGas,
      execGasPerMessage: PLACEHOLDERS.ledger.execGasPerMessage,
      ...(s?.consensus ? { consensus: s.consensus } : {}),
      ...(s?.avgTxGas ? { avgTxGas: s.avgTxGas } : {}),
      ...(s?.jurisdictions ? { jurisdictions: s.jurisdictions } : {}),
      ...(s?.certifications ? { certifications: s.certifications } : {}),
      ...(s?.operatedRouter ? { operatedRouter: s.operatedRouter } : {}),
      synthetic: s ? [...new Set([...(s.synthetic ?? []), "nativeUsd", "gasPriceNative", "enqueueGas", "execGasPerMessage"])] : ["nativeUsd", "gasPriceNative", "enqueueGas", "execGasPerMessage", "routerVersion"],
      sources: {
        chain: { kind: "measured", ref: `sdk/data/chains.json ${c.key} (${c.page} on ${c.branch})`, date: c.status.date ?? asOf },
        ...(s ? { economics: { kind: "synthetic", ref: "carried over from sdk/src/data/sample-graph.json (placeholders)", date: sample.asOf } } : {}),
      },
    };
    ledgers.push(ledger);

    const measuredKinds = ["live-mainnet", "live-testnet", "live-partial"];
    const bundleSynthetic = !measuredKinds.includes(c.bundle.basis);
    const synthetic = ["connectors", "history", "offChain", "maxPayloadBytes", "bundle.messagesPerBundle", "timing.proofGenS", "timing.verifyS"];
    if (c.finalityTime.seconds === null) synthetic.push("timing.sourceFinalityS");
    if (c.bundleCadence.seconds === null) synthetic.push("timing.bundleCadenceS");
    if (bundleSynthetic) synthetic.push("bundle.gas");
    if (c.bundle.calldataBytes === null || c.bundle.calldataIncomplete) synthetic.push("bundle.calldataBytes");
    const notes = [
      `status: ${c.status.text}`,
      `bundle basis ${c.bundle.basis}${c.bundle.network ? ` (${c.bundle.network})` : ""}`,
      ...(c.bundle.note ? [c.bundle.note] : []),
      ...(c.multiTx ? c.multiTx.map((m) => `multi-tx: ${m.note}`) : []),
      ...(c.toHiero.status === "projected" ? [`projected: ${c.toHiero.reason}`] : []),
      `trust: ${c.trust.text}`,
    ];
    const timingRefs = [c.finalityTime.source, c.bundleCadence.source].filter(Boolean);
    edges.push({
      from: c.caip2.id,
      to: HEDERA,
      channelId: `ch-${c.caip2.id.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40)}-hedera`,
      verifierFamily: c.verifier.family,
      trustTier: c.trust.tier,
      finalized: c.trust.finalized,
      timing: {
        sourceFinalityS: c.finalityTime.seconds ?? PLACEHOLDERS.timing.sourceFinalityS,
        bundleCadenceS: c.bundleCadence.seconds ?? PLACEHOLDERS.timing.bundleCadenceS,
        proofGenS: PLACEHOLDERS.timing.proofGenS,
        verifyS: PLACEHOLDERS.timing.verifyS,
        source: timingRefs.length
          ? { kind: "measured", ref: timingRefs.join("; "), date: c.status.date ?? asOf }
          : { kind: "synthetic", ref: "placeholder, not stated in the source", date: asOf },
      },
      bundle: {
        gas: c.bundle.gas,
        calldataBytes: c.bundle.calldataBytes ?? 0,
        messagesPerBundle: 1,
        ...(c.key === "ethereum/ethereum.md" ? { costNative: hbar } : {}),
        source: {
          kind: bundleSynthetic ? "synthetic" : "measured",
          ref: `${c.bundle.basis}: ${c.bundle.txs.map((t) => t.gas.source).filter((v, i, a) => a.indexOf(v) === i).join("; ")}`,
          date: c.status.date ?? asOf,
        },
      },
      connectors: structuredClone(PLACEHOLDERS.connectors),
      status: c.toHiero.status,
      history: { ...PLACEHOLDERS.history },
      maxPayloadBytes: PLACEHOLDERS.maxPayloadBytes,
      offChain: { ...PLACEHOLDERS.offChain, source: { kind: "synthetic", ref: "placeholder, not measured", date: asOf } },
      synthetic,
      notes: notes.join(" | "),
    });
  }
  // Hiero → chain: projected/blocked for every chain we can reach.
  for (const c of chains) {
    if (c.toHiero.status === "none") continue;
    edges.push({
      from: HEDERA,
      to: c.caip2.id,
      channelId: `ch-${c.caip2.id.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40)}-hedera`,
      verifierFamily: "hiero-tss",
      trustTier: "light-client",
      finalized: true,
      timing: { ...PLACEHOLDERS.timing, source: { kind: "synthetic", ref: "placeholder: Hiero → chain is blocked, nothing measured", date: asOf } },
      bundle: {
        gas: PLACEHOLDERS.reverseBundleGas,
        calldataBytes: 0,
        messagesPerBundle: 1,
        source: { kind: "synthetic", ref: "placeholder from sdk/src/data/sample-graph.json; Hiero → chain is blocked", date: asOf },
      },
      connectors: structuredClone(PLACEHOLDERS.connectors),
      status: "projected",
      history: { attempts: 0, successes: 0, pauses30d: 0 },
      maxPayloadBytes: PLACEHOLDERS.maxPayloadBytes,
      offChain: { ...PLACEHOLDERS.offChain, source: { kind: "synthetic", ref: "placeholder, not measured", date: asOf } },
      synthetic: ["timing", "bundle", "connectors", "history", "offChain", "maxPayloadBytes"],
      notes: `projected/blocked: ${c.fromHiero.text ?? c.fromHiero.reason}${c.fromHiero.source ? ` (${c.fromHiero.source})` : ""}`.slice(0, 600),
    });
  }

  const generator = "sdk/scripts/build-route-data.mjs";
  const repo = { path: "clpr-smart-contracts", branches: branchShas };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, "chains.json"),
    JSON.stringify({ version: `measured-${asOf}`, asOf, generator, repo, count: chains.length, chains }, null, 2) + "\n",
  );
  writeFileSync(
    join(OUT, "edges.json"),
    JSON.stringify(
      {
        version: `measured-${asOf}`,
        asOf,
        generator,
        repo,
        disabledRouterVersions: [],
        ledgers,
        edges,
      },
      null,
      2,
    ) + "\n",
  );
  const by = (k) => chains.reduce((a, c) => ((a[k(c)] = (a[k(c)] ?? 0) + 1), a), {});
  console.log(`chains: ${chains.length}`, by((c) => c.status.class));
  console.log(`edges: ${edges.length} (chain → Hiero ${edges.filter((e) => e.to === HEDERA).length}: `, by((c) => c.toHiero.status), ")");
}

main();
