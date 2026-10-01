// Solo side of the CLPRouter A → Hiero → B run. Reuses the CLPR repo's own Solo harness
// (test/e2e/backend/solo in clpr-smart-contracts, set CLPR_REPO) for port-forwards and readiness, so the
// checks are exactly the ones its anvil:solo roundtrip spec relies on. Run with
//   node --experimental-strip-types test/e2e-hiero/solo.ts <ready|fund <address>|stop|proof-probe ...>
//
//   ready        port-forward relay / mirror REST / block node for side B (the existing clpr-solo-b
//                cluster, chain id 1338), then wait for eth_chainId, a transfer estimate, and Mirror
//                Node web3 contract simulation (the harness's readiness checks)
//   fund <addr>  fund <addr> on Solo from the deployment's ecdsa-alias test account (1000 HBAR)
//   stop         stop the port-forwards started by `ready`
//   proof-probe <service> <channelId> <fromId> <throughId>
//                try to build the Hiero TSS state proof for messages [fromId, throughId] of <channelId>
//                in the EVM ClprService <service> on Solo, the way the CLPR harness's buildHieroProof does
//                (block node BlockAccessService.getBlock + ProofService.getStateProof per SlotKey).
//                Prints PROOF_OK or PROOF_BLOCKED with the exact failing step.
import path from "node:path";

const CLPR = process.env.CLPR_REPO ?? path.join(process.env.HOME ?? "", "clpr/clpr-smart-contracts");
const solo = (f: string) => import(path.join(CLPR, "test/e2e/backend/solo", f));
const SIDE = "b" as const;

async function ready(): Promise<void> {
    const pf = await solo("portForward.ts");
    const fund = await solo("fund.ts");
    const state = await solo("state.ts");
    const cfg = await solo("config.ts");
    await pf.startRelayPortForward(SIDE);
    await state.writeRelayUrl(SIDE, cfg.relayRpcUrlFor(SIDE));
    await pf.startAuxiliaryPortForwards(SIDE);
    await fund.waitForSoloRelayTransfers(SIDE, 600_000);
    await fund.waitForSoloMirrorContractSim(SIDE, 600_000);
    console.log(`SOLO_READY ${cfg.relayRpcUrlFor(SIDE)} ${cfg.mirrorRestUrlFor(SIDE)} ${cfg.blockNodeGrpcUrlFor(SIDE)}`);
}

async function stop(): Promise<void> {
    const pf = await solo("portForward.ts");
    await pf.stopAllPortForwards();
    console.log("SOLO_FORWARDS_STOPPED");
}

async function fundAddr(addr: `0x${string}`): Promise<void> {
    const fund = await solo("fund.ts");
    await fund.fundSoloSide(SIDE, addr);
    console.log(`SOLO_FUNDED ${addr}`);
}

async function proofProbe(service: `0x${string}`, channelId: `0x${string}`, fromId: bigint, throughId: bigint) {
    // These modules use extension-less / .js specifiers, so load them through tsx (from the CLPR repo).
    const lib = (f: string) => import(path.join(CLPR, "test/e2e/lib", f));
    const bn = await lib("blockNodeClient.ts");
    const slots = await lib("storageSlots.ts");
    const slotKey = await lib("slotKey.ts");
    const cfg = await solo("config.ts");
    const host = cfg.blockNodeGrpcUrlFor(SIDE);
    const mirror = cfg.mirrorRestUrlFor(SIDE);

    const step = (s: string) => console.log(`  step: ${s}`);
    step(`mirror: EVM address ${service} -> contract id`);
    const res = await fetch(`${mirror}/api/v1/contracts/${service}`);
    const contractId = ((await res.json()) as {contract_id?: string}).contract_id;
    if (!contractId) throw new Error("PROOF_BLOCKED mirror has no contract id");
    console.log(`    contract ${contractId}`);

    step("block node: BlockAccessService.getBlock(latest) — TSS-signed block proof");
    const latest = await bn.getLatestBlock(host);
    console.log(`    block ${latest.blockNumber}, signed_block_proof ${latest.signedBlockProof.length} bytes`);

    const keys: Buffer[] = [];
    for (const s of slots.deriveChannelFieldSlots(channelId)) keys.push(slotKey.encodeSlotKey(contractId, s));
    for (let id = fromId; id <= throughId; id++) {
        keys.push(slotKey.encodeSlotKey(contractId, slots.deriveMessagePayloadSlot(channelId, id)));
        keys.push(slotKey.encodeSlotKey(contractId, slots.deriveMessageRunningHashSlot(channelId, id)));
    }
    step(`block node: ProofService.getStateProof for ${keys.length} SlotKeys (HIP-1081)`);
    try {
        const r = await bn.getStateProof(host, latest.blockNumber, keys[0]);
        console.log(`    status ${r.status}, proof ${r.stateProof?.length ?? 0} bytes`);
        console.log("PROOF_OK");
    } catch (err) {
        console.log(`PROOF_BLOCKED ${err instanceof Error ? err.message : String(err)}`);
    }
}

const [cmd, ...args] = process.argv.slice(2);
const run =
    cmd === "ready" ? ready() :
    cmd === "stop" ? stop() :
    cmd === "fund" ? fundAddr(args[0] as `0x${string}`) :
    cmd === "proof-probe" ? proofProbe(args[0] as `0x${string}`, args[1] as `0x${string}`, BigInt(args[2]), BigInt(args[3])) :
    Promise.reject(new Error("usage: solo.ts <ready|fund <addr>|stop|proof-probe <service> <channelId> <from> <through>>"));
run.then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
});
