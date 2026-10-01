#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Record a deploy/route step in deployments/<network>.json: contract addresses and code hashes from the forge
// log, and every broadcast transaction with its gas and what it cost. No secrets are read or written.
//
//   node script/deploy/record.mjs <network> <step> <forge log> [broadcast run json]
//
// Cost: on Sepolia gasUsed x effectiveGasPrice (+ value sent); on Hedera the HBAR the network actually charged
// (mirror node charged_tx_fee, which is at least 80% of the gas limit), plus value sent.
import {existsSync, readFileSync, writeFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const [network, step, logFile, runFile] = process.argv.slice(2);
if (!network || !step || !logFile) {
    console.error("usage: record.mjs <network> <step> <forge log> [broadcast run json]");
    process.exit(1);
}
const cfg = {
    ...JSON.parse(readFileSync(path.join(ROOT, "script/deploy/config", "canonical.json"), "utf8")),
    ...JSON.parse(readFileSync(path.join(ROOT, "script/deploy/config", `${network}.json`), "utf8"))
};
const DEP_DIR = process.env.DEPLOYMENTS_DIR ? path.resolve(process.env.DEPLOYMENTS_DIR) : path.join(ROOT, "deployments");
const outFile = path.join(DEP_DIR, `${network}.json`);
const dep = existsSync(outFile)
    ? JSON.parse(readFileSync(outFile, "utf8"))
    : {
        network: cfg.network,
        chainId: cfg.chainId,
        ledgerId: cfg.ledgerId,
        explorer: cfg.explorer,
        clprService: cfg.clprService,
        contracts: {},
        libraries: {},
        fixtures: {},
        transactions: []
    };

// ── contracts from the forge log ─────────────────────────────────────────────
const lines = readFileSync(logFile, "utf8").split("\n").map((l) => l.trim());
const FIXTURES = new Set(["TestnetConnector", "TestOnlyStubVerifier", "TestnetRouteApp", "EthMainnetVerifier"]);
const bucket = (name) => (FIXTURES.has(name) ? dep.fixtures : dep.contracts);
for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^(DEPLOYED|EXISTS|REUSED) (\w+) (0x[0-9a-fA-F]{40})$/))) {
        const b = bucket(m[2]);
        b[m[2]] = {...(b[m[2]] ?? {}), address: m[3]};
        if (m[1] === "REUSED") b[m[2]].reusedExisting = true;
    } else if ((m = l.match(/^CODEHASH (\w+)$/))) {
        const b = bucket(m[1]);
        b[m[1]] = {...(b[m[1]] ?? {}), runtimeCodeHash: lines[i + 1]};
    } else if ((m = l.match(/^CODESIZE (\w+) (\d+)$/))) {
        const b = bucket(m[1]);
        b[m[1]] = {...(b[m[1]] ?? {}), runtimeCodeSize: Number(m[2])};
    } else if (l === "DEPLOYMENT_ID") {
        dep.deploymentId = lines[i + 1];
    } else if ((m = l.match(/^CANONICAL_ROUTER (\S+) (0x[0-9a-fA-F]{40})$/))) {
        dep.canonicalRouters = {...(dep.canonicalRouters ?? {}), [m[1]]: m[2]};
    } else if (l === "ROUTER_INIT_CODE_HASH") {
        dep.routerInitCodeHash = lines[i + 1];
    } else if (l === "ROUTE_SENT") {
        dep.route = {...(dep.route ?? {}), routeId: lines[i + 1]};
    } else if ((m = l.match(/^ROUTE_DELIVERED app (0x[0-9a-fA-F]{40})$/))) {
        dep.route = {...(dep.route ?? {}), deliveredTo: m[1], routeIdDelivered: lines[i + 1]};
    } else if (l.startsWith("RECEIPT_QUEUED")) {
        dep.route = {...(dep.route ?? {}), receipt: "DELIVERED receipt queued in the Router outbox"};
    } else if (l.startsWith("RECEIPT_FLUSHED")) {
        dep.route = {...(dep.route ?? {}), receipt: "DELIVERED receipt flushed into the Hedera -> Sepolia CLPR queue; it cannot be proven to Sepolia (no Hiero proof source)"};
    } else if ((m = l.match(/^(CHANNEL_OPENED|CHANNEL_EXISTS)$/))) {
        dep.channel = {...(dep.channel ?? {}), channelId: lines[i + 1]};
    } else if ((m = l.match(/^(CONNECTOR_REGISTERED|CONNECTOR_EXISTS)$/))) {
        dep.channel = {...(dep.channel ?? {}), connectorId: lines[i + 1]};
    } else if (l === "CHECKS_OK") {
        dep.postDeployChecks = {passed: true, at: new Date().toISOString(), against: "live chain (verification run)"};
    }
}
if (step === "deploy-router") {
    const committee = JSON.parse(readFileSync(path.join(ROOT, "deployments/test-committee.json"), "utf8"));
    dep.salt = cfg.salt;
    dep.deploymentIdSeed = cfg.deploymentIdSeed;
    dep.create2Factory = cfg.create2Factory;
    dep.compiler = {
        solc: "0.8.30", viaIR: true, evmVersion: "osaka", optimizerRuns: 200, bytecodeHash: "none", cborMetadata: false,
        note: "Registry, vault and Router come from one forge script compile unit that includes ClprRouter, so all three use the 'small' profile (optimizer runs 200, see foundry.toml compilation_restrictions)."
    };
    const c = dep.contracts;
    if (c.ProviderRegistry) c.ProviderRegistry.constructorArgs = {
        deploymentId: dep.deploymentId, initialMembers: committee.members, k: committee.threshold_k, contact: cfg.registry.contact,
        notices: {certNotice: cfg.registry.certNotice, removalNotice: cfg.registry.removalNotice,
            reenableNotice: cfg.registry.reenableNotice, disableLapse: cfg.registry.disableLapse,
            blacklistLapse: cfg.registry.blacklistLapse, committeeNotice: cfg.registry.committeeNotice}
    };
    if (c.QuarantineVault) c.QuarantineVault.constructorArgs = {
        registry: c.ProviderRegistry?.address, recoveryNotice: cfg.vault.recoveryNotice,
        challengeWindow: cfg.vault.challengeWindow
    };
    if (c.ClprRouterDeployer) c.ClprRouterDeployer.constructorArgs = {
        owner: cfg.routerDeployerOwner,
        deploymentSalt: "keccak256(abi.encodePacked(keccak256(salt), \"ClprRouter\", deploymentId))",
        initCodeHash: dep.routerInitCodeHash
    };
    if (c.ClprRouter) c.ClprRouter.deployParams = {
        note: "no constructor arguments; read from ClprRouterDeployer.parameters() during deploy()",
        service: cfg.clprService, registry: c.ProviderRegistry?.address, vault: c.QuarantineVault?.address,
        ledgerId: cfg.ledgerId, reclaimGrace: cfg.router.reclaimGrace, appGas: cfg.router.appGas,
        minSendGas: cfg.router.minSendGas
    };
}

// ── transactions from the broadcast file ─────────────────────────────────────
async function hederaCharged(hash) {
    const mirror = process.env.HEDERA_TESTNET_MIRROR_URL;
    if (!mirror || process.env.REHEARSAL) return undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            const r = await fetch(`${mirror}/api/v1/contracts/results/${hash}`);
            if (r.ok) {
                const cr = await r.json();
                const t = await (await fetch(`${mirror}/api/v1/transactions?timestamp=${cr.timestamp}`)).json();
                const tx = t.transactions?.[0];
                if (tx) return {
                    chargedTinybar: tx.charged_tx_fee, transactionId: tx.transaction_id,
                    gasConsumed: cr.gas_consumed, gasLimit: cr.gas_limit, result: cr.result
                };
            }
        } catch {}
        await new Promise((res) => setTimeout(res, 3000));
    }
    return undefined;
}

if (runFile && existsSync(runFile)) {
    const run = JSON.parse(readFileSync(runFile, "utf8"));
    const known = new Set(dep.transactions.map((t) => t.hash));
    for (let i = 0; i < run.receipts.length; i++) {
        const r = run.receipts[i];
        const t = run.transactions.find((x) => x.hash === r.transactionHash) ?? run.transactions[i] ?? {};
        if (known.has(r.transactionHash)) continue;
        const gasUsed = BigInt(r.gasUsed);
        const price = BigInt(r.effectiveGasPrice ?? t.transaction?.gasPrice ?? 0);
        const value = BigInt(t.transaction?.value ?? 0);
        const entry = {
            step,
            hash: r.transactionHash,
            block: Number(BigInt(r.blockNumber)),
            status: Number(BigInt(r.status)) === 1 ? "success" : "reverted",
            contract: t.contractName ?? null,
            function: t.function ?? (t.transactionType === "CREATE2" ? "CREATE2 deploy" : null),
            to: t.transaction?.to ?? null,
            createdAddress: t.contractAddress ?? r.contractAddress ?? null,
            gasUsed: gasUsed.toString(),
            gasLimit: BigInt(t.transaction?.gas ?? 0).toString()
        };
        if (cfg.chainId === 296) {
            const h = await hederaCharged(r.transactionHash);
            const valueTinybar = value / 10_000_000_000n;
            entry.gasConsumed = h?.gasConsumed;
            entry.hederaTransactionId = h?.transactionId;
            entry.feeTinybar = h?.chargedTinybar;
            entry.valueTinybar = valueTinybar.toString();
            entry.costHbar = h ? (Number(BigInt(h.chargedTinybar) + valueTinybar) / 1e8).toFixed(8) : null;
            entry.explorerUrl = `${cfg.explorer}/transaction/${r.transactionHash}`;
        } else {
            const fee = gasUsed * price;
            entry.effectiveGasPriceWei = price.toString();
            entry.feeWei = fee.toString();
            entry.valueWei = value.toString();
            entry.costEth = (Number(fee + value) / 1e18).toFixed(9);
            entry.explorerUrl = `${cfg.explorer}/tx/${r.transactionHash}`;
        }
        dep.transactions.push(entry);
        known.add(r.transactionHash);
    }
    if (run.libraries?.length) {
        for (const l of run.libraries) {
            const [file, name, addr] = l.split(":");
            dep.libraries[name] = {address: addr, source: file, deployment: "CREATE2 (forge, salt 0)"};
        }
    }
}

// Name CREATE2 deployments the broadcast file left unnamed (e.g. "ProviderRegistry.small" artifacts).
const byAddr = new Map();
for (const group of [dep.contracts, dep.libraries, dep.fixtures]) {
    for (const [name, v] of Object.entries(group)) if (v?.address) byAddr.set(v.address.toLowerCase(), name);
}
for (const t of dep.transactions) {
    if (!t.contract && t.createdAddress) t.contract = byAddr.get(t.createdAddress.toLowerCase()) ?? null;
    if (!t.contract && t.to && t.to.toLowerCase() === String(dep.clprService).toLowerCase()) t.contract = "ClprService";
    if (!t.contract && t.to) t.contract = byAddr.get(t.to.toLowerCase()) ?? null;
}

// ── totals ───────────────────────────────────────────────────────────────────
const sum = (f) => dep.transactions.reduce((a, t) => a + Number(t[f] ?? 0), 0);
dep.totals = {
    transactions: dep.transactions.length,
    gasUsed: dep.transactions.reduce((a, t) => a + BigInt(t.gasUsed), 0n).toString(),
    ...(cfg.chainId === 296
        ? {costHbar: sum("costHbar").toFixed(8)}
        : {costEth: sum("costEth").toFixed(9)})
};
dep.status = "pre-audit (re-audit in progress)";
dep.updatedAt = new Date().toISOString();
writeFileSync(outFile, JSON.stringify(dep, null, 2) + "\n");
console.log(`recorded ${step} → ${outFile} (${dep.totals.transactions} txs, ` +
    `${dep.totals.costHbar ?? dep.totals.costEth} ${cfg.chainId === 296 ? "HBAR" : "ETH"} total)`);
