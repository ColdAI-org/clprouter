// SPDX-License-Identifier: MIT
// Build a real EthMainnetVerifier bundle proof for the Sepolia -> Hedera Channel.
//
// 1. Polls the Sepolia light-client finality update until its attested execution block is at or past
//    --min-block (the block of the Router `send`), so the sync committee has signed a header whose state
//    contains the message.
// 2. Immediately fetches eth_getProof for the Sepolia ClprService at that block: the Channel's queue-metadata
//    slots and the running-hash slot of the last outbound message; reads the message payloads at that block.
// 3. Assembles the 10-item proof (attested header, sync aggregate, execution branch, account and storage proofs,
//    bundle content, non-signer Merkle proofs) exactly as the vendored live builder does, with this Channel's id
//    and the real messages instead of exclusion proofs.
// 4. Pre-flight on Hedera: the trust anchor rebuilt here must equal the one stored on the Hedera Channel, and
//    EthMainnetVerifier.verifyBundle must accept the proof under it (eth_call), before anything is sent.
//
//   npx tsx relay/eth-bundle.ts --channel 0x.. --min-block N --out ../.build/bundle.env
import {decodeFunctionResult, encodeFunctionData, type Hex} from "viem";
import {
    buildExecutionStateRootBranch,
    signedHeaderInputs,
    signingCommittee,
    SUPPORTED_FORKS,
    type FinalityUpdateJson,
    type LiveCapture
} from "./vendor/relay/buildEthLiveProof.js";
import {
    deriveChannelSlots,
    deriveMessageRunningHashSlot,
    encodeEthTrustAnchor,
    type EthGetProofResult
} from "./vendor/relay/buildEthMainnetProof.js";
import {pbBytes} from "./vendor/lib/proto.js";
import {rlpEncode, hexToBuf} from "./vendor/lib/rlp.js";
import {abiOf, arg, beaconApis, beaconCapture, client, env, getJson, hexOf, rpc, writeEnvFile} from "./common.js";

const SYNC_COMMITTEE_SIZE = 512;

async function main(): Promise<void> {
    const channelId = arg("channel") as Hex;
    const minBlock = BigInt(arg("min-block"));
    const out = arg("out");
    const service = arg("service", "0xa6db474e3047c3d43b10a4ff7abad547d89982b9") as Hex;
    const sepRpc = env("SEPOLIA_RPC_URL");
    const hedRpc = env("HEDERA_TESTNET_RPC_URL");
    const svcAbi = abiOf("IClprService");
    const verifierAbi = abiOf("EthMainnetVerifier");
    const apis = beaconApis();

    // 1. Wait for a signed header at or past the send block.
    let fu: FinalityUpdateJson;
    let base: string;
    const deadline = Date.now() + 15 * 60_000;
    for (;;) {
        ({json: fu, base} = await getJson<FinalityUpdateJson>(apis, "/eth/v1/beacon/light_client/finality_update"));
        const b = BigInt(fu.data.attested_header.execution.block_number);
        if (b >= minBlock) break;
        if (Date.now() > deadline) throw new Error(`no attested block >= ${minBlock} within 15 min (latest ${b})`);
        console.error(`waiting: attested execution block ${b} < ${minBlock}`);
        await new Promise((r) => setTimeout(r, 6000));
    }
    if (!SUPPORTED_FORKS.has(fu.version)) throw new Error(`unsupported fork ${fu.version}`);
    const attested = fu.data.attested_header;
    const blockTag = ("0x" + BigInt(attested.execution.block_number).toString(16)) as Hex;

    // 2. Channel state and storage proofs at the attested block (fetched first, while the node has the state).
    const sep = client(sepRpc);
    const callAt = async (fn: string, args: unknown[]) => decodeFunctionResult({
        abi: svcAbi, functionName: fn,
        data: (await sep.call({to: service, data: encodeFunctionData({abi: svcAbi, functionName: fn, args} as never), blockNumber: BigInt(blockTag)})).data!
    } as never) as never;
    const ch = (await callAt("getChannel", [channelId])) as {nextMessageId: bigint; receivedMessageId: bigint};
    const hed = client(hedRpc);
    const hedCh = (await hed.readContract({address: service, abi: svcAbi, functionName: "getChannel", args: [channelId]} as never)) as {
        receivedMessageId: bigint; trustAnchor: Hex; verifier: Hex;
    };
    const from = hedCh.receivedMessageId + 1n;
    const last = ch.nextMessageId - 1n;
    if (last < from) throw new Error(`nothing to relay (Sepolia nextMessageId ${ch.nextMessageId}, Hedera received ${hedCh.receivedMessageId})`);
    const storageKeys = [...deriveChannelSlots(channelId), deriveMessageRunningHashSlot(channelId, last)];
    const proof = await rpc<EthGetProofResult & {codeHash: string}>(sepRpc, "eth_getProof", [service, storageKeys, blockTag]);
    const block = await rpc<{hash: string; stateRoot: string; number: string}>(sepRpc, "eth_getBlockByNumber", [blockTag, false]);
    if (block.stateRoot.toLowerCase() !== attested.execution.state_root.toLowerCase()) throw new Error("state root mismatch");
    if (block.hash.toLowerCase() !== attested.execution.block_hash.toLowerCase()) throw new Error("block hash mismatch");
    const payloads: Hex[] = [];
    for (let id = from; id <= last; id++) {
        const m = (await callAt("getMessage", [channelId, id])) as {payload: Hex};
        payloads.push(m.payload);
    }

    // 3. Beacon side and the proof.
    const cap = await beaconCapture(apis, fu, base) as unknown as LiveCapture;
    const {committee, period} = signingCommittee(cap);
    const signed = signedHeaderInputs(cap, committee, attested.beacon, fu.data.sync_aggregate, BigInt(fu.data.signature_slot));
    const exec = buildExecutionStateRootBranch(attested);
    const byKey = new Map(proof.storageProof.map((sp) => [BigInt(sp.key), sp]));
    const storageProof = storageKeys.map((k) => {
        const sp = byKey.get(BigInt(k));
        if (!sp) throw new Error(`eth_getProof missing slot ${k}`);
        return [hexToBuf(k), sp.proof.map(hexToBuf)];
    });
    const bundleContent = Buffer.concat(payloads.map((p) => pbBytes(2, hexToBuf(p))));
    const proofBytes = hexOf(rlpEncode([
        signed.attestedHeaderRlp,
        [signed.bits, signed.signatureUncompressed],
        exec.stateRoot,
        exec.branch,
        Buffer.alloc(0),
        [],
        proof.accountProof.map(hexToBuf),
        storageProof,
        bundleContent,
        signed.nonSignerEntries
    ]));

    // 4. Pre-flight against the Hedera Channel's stored anchor and the deployed verifier.
    const anchor = encodeEthTrustAnchor(channelId, proof.codeHash as Hex, committee, {
        gvr: cap.genesisValidatorsRoot as Hex, forkVersion: signed.forkVersion
    });
    if (anchor.toLowerCase() !== hedCh.trustAnchor.toLowerCase()) {
        throw new Error(`trust anchor mismatch: Hedera Channel anchor != period ${period} committee (rotation needed?)`);
    }
    // Best-effort eth_call (the relay's mirror-node EVM may not price or support EIP-2537 like consensus does);
    // the binding pre-flight is forge's local simulation of submitBundle on a Hedera fork in route.sh deliver.
    const ctx = (channelId + service.slice(2).toLowerCase()) as Hex;
    let preflight = "skipped";
    try {
        const [, msgs] = (await hed.readContract({
            address: hedCh.verifier, abi: verifierAbi, functionName: "verifyBundle", args: [proofBytes, anchor, ctx]
        } as never)) as [unknown, Hex[]];
        if (msgs.length !== payloads.length) throw new Error("verifier returned a different message count");
        preflight = `OK (${msgs.length} message(s))`;
    } catch (err) {
        preflight = `eth_call failed: ${String(err).split("\n")[0].slice(0, 160)}`;
    }

    writeEnvFile(out, {BUNDLE_PROOF: proofBytes, BUNDLE_ATTESTED_BLOCK: BigInt(blockTag).toString()});
    console.log(
        `eth-bundle: attested slot ${attested.beacon.slot} (exec block ${BigInt(blockTag)}), period ${period}, ` +
        `participation ${signed.participants}/${SYNC_COMMITTEE_SIZE}, messages ${from}..${last}, ` +
        `proof ${(proofBytes.length - 2) / 2} B; Hedera eth_call pre-flight ${preflight} → ${out}`
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
