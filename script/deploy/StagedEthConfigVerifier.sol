// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IClprVerifier} from "@hiero-ledger/clpr/interfaces/IClprVerifier.sol";
import {ClprTypes} from "@hiero-ledger/clpr/libraries/ClprTypes.sol";
import {ClprProtobuf} from "@hiero-ledger/clpr/libraries/codec/ClprProtobuf.sol";
import {ClprBeaconBls} from "@hiero-ledger/clpr/libraries/proof/beacon/ClprBeaconBls.sol";
import {RLP} from "@openzeppelin/contracts/utils/RLP.sol";
import {Memory} from "@openzeppelin/contracts/utils/Memory.sol";

/// @title StagedEthConfigVerifier
/// @notice TESTNET bring-up adapter in front of the CLPR repo's unchanged `EthMainnetVerifier`, so that an
///         EthMainnetVerifier Channel can be opened on Hedera.
///
///         Why: `EthMainnetVerifier.verifyConfig` takes the 512 sync-committee keys (67 KB) in one call. On
///         Hedera the call trace of `completeChannel` with that payload (the 67 KB input recorded on the
///         Service call, the delegatecall into its logic and the verifier call, plus 257 BLS12_G1ADD calls)
///         exceeds the consensus node's `contracts.maxSerializedTraceDataBytes` (256 KiB), and the node then
///         fails the transaction with INSUFFICIENT_GAS after it has executed. See deployments/README.md.
///
///         How: the committee is staged first, in chunks of 32 keys (one small transaction each, under the
///         6 KB non-jumbo size): {stageChunk} runs the same EIP-2537 on-curve check as `verifyConfig`
///         (`ClprBeaconBls.requireOnCurveG1`) and records the chunk's keccak Merkle subtree root. The config
///         then carries the 16 subtree roots instead of the 512 keys:
///
///             RLP [slot, [[subRoot0 .. subRoot15], aggregate], gvr, forkVersion, ledgerConfiguration, codeHash]
///
///         {verifyConfig} folds the 16 staged roots into the same `ClprCommitteeMerkle` root (512 leaves
///         `keccak256(key)`, parent `keccak256(left ‖ right)`; 32-leaf subtrees are its level-5 nodes) and
///         returns exactly what `EthMainnetVerifier.verifyConfig` returns for the full config: the same
///         260-byte trust anchor `gvr ‖ forkVersion ‖ channelId ‖ aggregate ‖ committeeRoot ‖ codeHash`, the
///         period id, the channel context and the uninitialized endpoint manifest (parity is tested in
///         test/unit/StagedEthConfigVerifier.t.sol). {verifyBundle} forwards unchanged to the real verifier.
///
///         Limits: no config-time endpoint-manifest proof (bring-up only: an empty proof, as the deploy uses);
///         a rotation bundle carries the next 512 keys and would hit the same Hedera trace limit, so a Channel
///         opened through this adapter lives for one sync-committee period unless rotation is staged too.
///         Trust is unchanged from `EthMainnetVerifier.verifyConfig`: the committee in a config is accepted
///         as given by the Channel operator; staging only splits the key validation across transactions.
contract StagedEthConfigVerifier is IClprVerifier {
    uint256 public constant COMMITTEE_SIZE = 512;
    uint256 public constant KEY_LENGTH = 128; // uncompressed EIP-2537 G1
    uint256 public constant CHUNK_KEYS = 32;
    uint256 public constant CHUNKS = COMMITTEE_SIZE / CHUNK_KEYS; // 16

    uint256 internal constant CONFIG_FIELDS = 6;
    uint256 internal constant FORK_VERSION_LENGTH = 4;
    uint64 internal constant SLOTS_PER_SYNC_COMMITTEE_PERIOD = 8192;

    /// @notice The CLPR repo's EthMainnetVerifier that verifies every bundle.
    IClprVerifier public immutable ETH_VERIFIER;

    /// @notice Subtree root of a 32-key chunk whose keys all passed the on-curve check => true.
    mapping(bytes32 => bool) public stagedChunk;

    event ChunkStaged(bytes32 indexed chunkRoot, address indexed stager);

    error InvalidVerifier();
    error InvalidChunk();
    error ChunkNotStaged(uint256 index, bytes32 chunkRoot);
    error InvalidConfigPayload();
    error EndpointManifestProofUnsupported();

    constructor(IClprVerifier ethVerifier) {
        if (address(ethVerifier).code.length == 0) revert InvalidVerifier();
        ETH_VERIFIER = ethVerifier;
    }

    /// @notice Validate 32 consecutive committee keys (32 × 128 bytes, concatenated) and record their
    ///         subtree root. Idempotent; anyone may stage (a staged chunk only says "these keys are on G1").
    function stageChunk(bytes calldata keys) external returns (bytes32 root) {
        bytes[] memory k = _split(keys);
        // Same check as EthMainnetVerifier.verifyConfig; an even count pairs the "aggregate" with the
        // point at infinity, so the all-zero 128 bytes stand in for it here.
        ClprBeaconBls.requireOnCurveG1(k, new bytes(KEY_LENGTH));
        root = _subtreeRoot(k);
        if (!stagedChunk[root]) {
            stagedChunk[root] = true;
            emit ChunkStaged(root, msg.sender);
        }
    }

    /// @notice Subtree root of a 32-key chunk (for building the staged config off-chain).
    function chunkRoot(bytes calldata keys) external pure returns (bytes32) {
        return _subtreeRoot(_split(keys));
    }

    /// @inheritdoc IClprVerifier
    function verifyConfig(bytes calldata configProofBytes, bytes32 channelId, bytes calldata endpointManifestProofBytes)
        external
        view
        override
        returns (
            bytes memory channelContext,
            string memory chainId,
            bytes memory serviceAddress,
            uint96 peerConfigNanos,
            ClprTypes.Throttles memory throttles,
            bytes memory initialTrustAnchor,
            bytes memory initialTrustAnchorId,
            ClprTypes.ClprEndpointManifest memory endpointManifest
        )
    {
        if (configProofBytes.length == 0) revert InvalidConfigPayload();
        if (endpointManifestProofBytes.length != 0) revert EndpointManifestProofUnsupported();

        bytes memory configMem = configProofBytes;
        Memory.Slice[] memory cfg = RLP.decodeList(configMem);
        if (cfg.length != CONFIG_FIELDS) revert InvalidConfigPayload();

        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 slot = uint64(RLP.readUint256(cfg[0]));
        (bytes32 committeeRoot, bytes memory aggregate) = _stagedCommittee(cfg[1]);
        bytes32 gvr = RLP.readBytes32(cfg[2]);
        bytes memory forkVersion = RLP.readBytes(cfg[3]);
        if (forkVersion.length != FORK_VERSION_LENGTH) revert InvalidConfigPayload();
        ClprTypes.LedgerConfiguration memory lc = ClprProtobuf.decodeControlMessage(RLP.readBytes(cfg[4])).config;
        bytes32 codeHash = RLP.readBytes32(cfg[5]);

        initialTrustAnchor = abi.encodePacked(gvr, forkVersion, channelId, aggregate, committeeRoot, codeHash);
        serviceAddress = lc.serviceAddress;
        channelContext = ClprTypes.encodeChannelContext(
            ClprTypes.ChannelContext({channelId: channelId, remoteServiceAddress: serviceAddress})
        );
        chainId = lc.chainId;
        peerConfigNanos = lc.nanosSinceEpoch;
        throttles = lc.throttles;
        initialTrustAnchorId = abi.encodePacked(slot / SLOTS_PER_SYNC_COMMITTEE_PERIOD);
        // Same as EthMainnetVerifier for an empty manifest proof: uninitialized (version 0) manifest.
        endpointManifest.serviceAddress = serviceAddress;
        endpointManifest.endpoints = new ClprTypes.Endpoint[](0);
    }

    /// @inheritdoc IClprVerifier
    function verifyBundle(bytes calldata proofBytes, bytes calldata trustAnchor, bytes calldata channelContext)
        external
        view
        override
        returns (
            ClprTypes.QueueMetadata memory,
            bytes[] memory,
            bytes memory,
            bytes memory,
            ClprTypes.ClprEndpointManifest memory
        )
    {
        return ETH_VERIFIER.verifyBundle(proofBytes, trustAnchor, channelContext);
    }

    /// @dev `[[subRoot × 16], aggregate]` → (committee Merkle root, aggregate), every chunk staged and the
    ///      aggregate on G1 (both as EthMainnetVerifier.verifyConfig requires of the full committee).
    function _stagedCommittee(Memory.Slice item) private view returns (bytes32 root, bytes memory aggregate) {
        Memory.Slice[] memory committee = RLP.readList(item);
        if (committee.length != 2) revert InvalidConfigPayload();
        Memory.Slice[] memory roots = RLP.readList(committee[0]);
        if (roots.length != CHUNKS) revert InvalidConfigPayload();
        bytes32[] memory nodes = new bytes32[](CHUNKS);
        for (uint256 i = 0; i < CHUNKS; i++) {
            nodes[i] = RLP.readBytes32(roots[i]);
            if (!stagedChunk[nodes[i]]) revert ChunkNotStaged(i, nodes[i]);
        }
        root = _fold(nodes);
        aggregate = RLP.readBytes(committee[1]);
        if (aggregate.length != KEY_LENGTH) revert InvalidConfigPayload();
        ClprBeaconBls.requireOnCurveG1(new bytes[](0), aggregate); // one G1ADD(aggregate, infinity)
    }

    function _split(bytes calldata keys) private pure returns (bytes[] memory k) {
        if (keys.length != CHUNK_KEYS * KEY_LENGTH) revert InvalidChunk();
        k = new bytes[](CHUNK_KEYS);
        for (uint256 i = 0; i < CHUNK_KEYS; i++) {
            k[i] = keys[i * KEY_LENGTH:(i + 1) * KEY_LENGTH];
        }
    }

    function _subtreeRoot(bytes[] memory keys) private pure returns (bytes32) {
        bytes32[] memory nodes = new bytes32[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            nodes[i] = keccak256(keys[i]);
        }
        return _fold(nodes);
    }

    /// @dev Pairwise keccak fold of a power-of-two node list, as ClprCommitteeMerkle.root does.
    function _fold(bytes32[] memory nodes) private pure returns (bytes32) {
        for (uint256 n = nodes.length; n > 1; n >>= 1) {
            for (uint256 i = 0; i < n / 2; i++) {
                nodes[i] = keccak256(abi.encodePacked(nodes[2 * i], nodes[2 * i + 1]));
            }
        }
        return nodes[0];
    }
}
