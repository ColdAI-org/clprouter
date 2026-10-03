#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Estimate a transaction's Hedera contract trace data (the ContractActions + ContractStateChanges sidecars) and
// compare it with the consensus node's `contracts.maxSerializedTraceDataBytes` (default 262,144). Above it the
// node fails the transaction with INSUFFICIENT_GAS after executing it (hiero-consensus-node
// ConversionUtils.throwIfUnsuccessfulCall), although eth_estimateGas and forks succeed.
//
// Run it against an anvil fork of Hedera testnet on which the transaction was rehearsed (debug_trace* needed):
//
//   node script/deploy/trace-size.mjs <rpc url> <tx hash> [<tx hash> ...]
//
// The estimate is the raw bytes (every call frame's input and output, precompile calls included, as Hedera
// records them) plus a per-frame and per-storage-slot allowance for the protobuf fields around them; it is meant
// to be conservative, not exact. Exit code 1 if any transaction is above 90 % of the limit.
const LIMIT = Number(process.env.HEDERA_TRACE_LIMIT ?? 262144);
const PER_ACTION = 96; // call type, caller/recipient ids, gas, gas used, depth, operation type, length prefixes
const PER_SLOT = 112; // slot, value read, value written, length prefixes

const [rpc, ...hashes] = process.argv.slice(2);
if (!rpc || hashes.length === 0) {
    console.error("usage: trace-size.mjs <rpc url> <tx hash> [...]");
    process.exit(2);
}

async function call(method, params) {
    const r = await fetch(rpc, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params})
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    return j.result;
}

const hexLen = (h) => (h && h.length > 2 ? (h.length - 2) / 2 : 0);

let worst = 0;
for (const hash of hashes) {
    const frames = await call("debug_traceTransaction", [hash, {tracer: "callTracer"}]);
    let actions = 0;
    let raw = 0;
    const walk = (f) => {
        actions++;
        raw += hexLen(f.input) + hexLen(f.output);
        for (const c of f.calls ?? []) walk(c);
    };
    walk(frames);
    // Every storage slot read or written (Hedera records reads too).
    const pre = await call("debug_traceTransaction", [hash, {tracer: "prestateTracer"}]);
    const slots = new Set();
    for (const [addr, acc] of Object.entries(pre)) {
        for (const k of Object.keys(acc.storage ?? {})) slots.add(`${addr}:${k}`);
    }
    const est = raw + actions * PER_ACTION + slots.size * PER_SLOT;
    worst = Math.max(worst, est / LIMIT);
    console.log(
        `${hash} actions ${actions} raw ${raw} B, storage slots ${slots.size} → ~${est} B ` +
        `(${((100 * est) / LIMIT).toFixed(1)} % of ${LIMIT})`
    );
}
process.exit(worst > 0.9 ? 1 : 0);
