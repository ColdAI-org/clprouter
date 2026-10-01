// SPDX-License-Identifier: MIT
// EthMainnetVerifier bootstrap config for the Hedera side of the Sepolia <-> Hedera Channel.
//
// Fetches the Sepolia sync committee that signs the current light-client finality update (512 keys,
// decompressed to EIP-2537 uncompressed points; the published aggregate is checked against their sum), the
// genesis validators root and the fork version at the signature slot, and writes them as env lines for
// SetupRoute.openChannel (ETH_CONFIG_SLOT, ETH_GVR, ETH_FORK_VERSION, ETH_COMMITTEE_PUBKEYS,
// ETH_COMMITTEE_AGGREGATE). The committee is valid until the end of its sync-committee period (8192 slots,
// about 27 h); the bundle must be signed in the same period (rotation needs an archive eth_getProof).
//
//   npx tsx relay/eth-config.ts --out ../.build/eth-config.env
import {
    signingCommittee,
    signatureForkVersion,
    type FinalityUpdateJson
} from "./vendor/relay/buildEthLiveProof.js";
import {arg, beaconApis, beaconCapture, getJson, hexOf, writeEnvFile} from "./common.js";

async function main(): Promise<void> {
    const apis = beaconApis();
    const {json: fu, base} = await getJson<FinalityUpdateJson>(apis, "/eth/v1/beacon/light_client/finality_update");
    const cap = await beaconCapture(apis, fu, base);
    const {committee, period} = signingCommittee(cap as never);
    const sigSlot = BigInt(fu.data.signature_slot);
    const forkVersion = signatureForkVersion(cap.spec, sigSlot);
    const spp = BigInt(cap.spec.SLOTS_PER_EPOCH) * BigInt(cap.spec.EPOCHS_PER_SYNC_COMMITTEE_PERIOD);
    const slotsLeft = (period + 1n) * spp - sigSlot;
    const out = arg("out");
    writeEnvFile(out, {
        ETH_CONFIG_SLOT: sigSlot.toString(),
        ETH_GVR: cap.genesisValidatorsRoot,
        ETH_FORK_VERSION: forkVersion,
        ETH_COMMITTEE_PUBKEYS: hexOf(Buffer.concat(committee.pubkeys)),
        ETH_COMMITTEE_AGGREGATE: hexOf(committee.aggregate),
        ETH_PERIOD: period.toString()
    });
    console.log(
        `eth-config: ${cap.network} ${fu.version} period ${period} (signature slot ${sigSlot}, ` +
        `${slotsLeft} slots ≈ ${(Number(slotsLeft) * 12 / 3600).toFixed(1)} h left in the period), ` +
        `fork version ${forkVersion}, beacon API ${base} → ${out}`
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
