// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {RLP} from "@openzeppelin/contracts/utils/RLP.sol";
import {EthMainnetVerifier} from "@hiero-ledger/clpr/verifiers/evm/ethereum/EthMainnetVerifier.sol";
import {IClprVerifier} from "@hiero-ledger/clpr/interfaces/IClprVerifier.sol";
import {ClprTypes} from "@hiero-ledger/clpr/libraries/ClprTypes.sol";
import {ClprProtobuf} from "@hiero-ledger/clpr/libraries/codec/ClprProtobuf.sol";
import {ClprBeaconBls} from "@hiero-ledger/clpr/libraries/proof/beacon/ClprBeaconBls.sol";
import {ClprCommitteeMerkle} from "@hiero-ledger/clpr/libraries/proof/beacon/ClprCommitteeMerkle.sol";

import {StagedEthConfigVerifier} from "../../script/deploy/StagedEthConfigVerifier.sol";

/// @notice The staged bring-up adapter returns exactly what the CLPR repo's EthMainnetVerifier returns for the
///         full 512-key config, and refuses unstaged or off-curve keys.
contract StagedEthConfigVerifierTest is Test {
    bytes internal constant G1_GEN =
        hex"0000000000000000000000000000000017f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb0000000000000000000000000000000008b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1";
    address internal constant BLS12_G1MSM = address(0x0c);
    bytes32 internal constant CHANNEL_ID = keccak256("channel");
    bytes32 internal constant GVR = keccak256("gvr");
    bytes4 internal constant FORK_VERSION = 0x90000075;
    bytes32 internal constant CODE_HASH = keccak256("code");
    uint256 internal constant SLOT = 8192 * 1234 + 77;

    EthMainnetVerifier internal real;
    StagedEthConfigVerifier internal staged;
    bytes[] internal keys; // 512 distinct points k·G, k = 1..512
    bytes internal aggregate; // Σ k·G
    bytes internal ledger;

    function setUp() public {
        real = new EthMainnetVerifier();
        staged = new StagedEthConfigVerifier(IClprVerifier(address(real)));
        for (uint256 i = 0; i < 512; i++) {
            keys.push(_mul(i + 1));
        }
        aggregate = _mul(512 * 513 / 2);
        ClprTypes.LedgerConfiguration memory lc;
        lc.protocolVersion = 1;
        lc.chainId = "eip155:11155111";
        lc.serviceAddress = abi.encodePacked(address(0xA6DB474E3047C3d43b10a4Ff7AbAD547d89982B9));
        lc.nanosSinceEpoch = 1_790_000_000_123_456_789;
        lc.throttles.maxGasPerMessage = 2_000_000;
        lc.throttles.maxMessagesPerBundle = 10;
        lc.throttles.maxMessagePayloadBytes = 4096;
        lc.throttles.maxLocalEndpoints = 3;
        lc.throttles.maxPeerEndpoints = 5;
        ledger = ClprProtobuf.encodeControlMessage(lc);
    }

    function test_parityWithEthMainnetVerifier() public {
        _stageAll();
        bytes memory a = _call(address(real), _fullConfig());
        bytes memory b = _call(address(staged), _stagedConfig(aggregate));
        assertEq(keccak256(b), keccak256(a), "staged verifyConfig output == EthMainnetVerifier.verifyConfig output");

        (,,,,, bytes memory anchor, bytes memory anchorId,) =
            staged.verifyConfig(_stagedConfig(aggregate), CHANNEL_ID, "");
        assertEq(anchor.length, 260);
        bytes32 root;
        assembly {
            root := mload(add(anchor, add(32, 196)))
        }
        assertEq(root, ClprCommitteeMerkle.root(keys), "committee root");
        assertEq(anchorId, abi.encodePacked(uint64(1234)));
    }

    function test_unstagedChunk_reverts() public {
        _stageAll();
        bytes memory k = _chunk(7);
        bytes32 r = staged.chunkRoot(k);
        // A config naming a chunk root nobody staged.
        bytes32[] memory roots = _roots();
        roots[7] = keccak256(abi.encodePacked(r));
        vm.expectRevert(abi.encodeWithSelector(StagedEthConfigVerifier.ChunkNotStaged.selector, 7, roots[7]));
        staged.verifyConfig(_configWith(roots, aggregate), CHANNEL_ID, "");
    }

    function test_offCurveKey_reverts() public {
        bytes memory k = _chunk(3);
        k[127] = bytes1(uint8(k[127]) ^ 1); // corrupt the y coordinate of the first key
        vm.expectRevert(ClprBeaconBls.BlsPointNotOnCurveG1.selector);
        staged.stageChunk(k);
    }

    function test_offCurveAggregate_reverts() public {
        _stageAll();
        bytes memory bad = bytes.concat(aggregate);
        bad[127] = bytes1(uint8(bad[127]) ^ 1);
        bytes memory cfg = _stagedConfig(bad);
        vm.expectRevert(ClprBeaconBls.BlsPointNotOnCurveG1.selector);
        staged.verifyConfig(cfg, CHANNEL_ID, "");
    }

    function test_wrongChunkLength_reverts() public {
        vm.expectRevert(StagedEthConfigVerifier.InvalidChunk.selector);
        staged.stageChunk(new bytes(31 * 128));
    }

    function test_manifestProof_unsupported() public {
        _stageAll();
        bytes memory cfg = _stagedConfig(aggregate);
        vm.expectRevert(StagedEthConfigVerifier.EndpointManifestProofUnsupported.selector);
        staged.verifyConfig(cfg, CHANNEL_ID, hex"c0");
    }

    function test_verifyBundle_forwardsToEthMainnetVerifier() public {
        vm.expectRevert(EthMainnetVerifier.InvalidTrustAnchor.selector);
        staged.verifyBundle(hex"c0", new bytes(10), "");
    }

    function test_stageChunk_idempotent() public {
        bytes32 r1 = staged.stageChunk(_chunk(0));
        bytes32 r2 = staged.stageChunk(_chunk(0));
        assertEq(r1, r2);
        assertTrue(staged.stagedChunk(r1));
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    function _mul(uint256 k) internal view returns (bytes memory p) {
        bool ok;
        (ok, p) = BLS12_G1MSM.staticcall(abi.encodePacked(G1_GEN, bytes32(k)));
        require(ok && p.length == 128, "G1MSM");
    }

    function _chunk(uint256 c) internal view returns (bytes memory out) {
        for (uint256 i = 0; i < 32; i++) {
            out = bytes.concat(out, keys[c * 32 + i]);
        }
    }

    function _stageAll() internal {
        for (uint256 c = 0; c < 16; c++) {
            staged.stageChunk(_chunk(c));
        }
    }

    function _roots() internal view returns (bytes32[] memory roots) {
        roots = new bytes32[](16);
        for (uint256 c = 0; c < 16; c++) {
            roots[c] = staged.chunkRoot(_chunk(c));
        }
    }

    function _call(address v, bytes memory cfg) internal view returns (bytes memory ret) {
        bool ok;
        (ok, ret) = v.staticcall(abi.encodeCall(IClprVerifier.verifyConfig, (cfg, CHANNEL_ID, "")));
        require(ok, "verifyConfig reverted");
    }

    function _fullConfig() internal view returns (bytes memory) {
        bytes[] memory items = new bytes[](512);
        for (uint256 i = 0; i < 512; i++) {
            items[i] = RLP.encode(keys[i]);
        }
        bytes[] memory committee = new bytes[](2);
        committee[0] = RLP.encode(items);
        committee[1] = RLP.encode(aggregate);
        return _config(RLP.encode(committee));
    }

    function _stagedConfig(bytes memory agg) internal view returns (bytes memory) {
        return _configWith(_roots(), agg);
    }

    function _configWith(bytes32[] memory roots, bytes memory agg) internal view returns (bytes memory) {
        bytes[] memory items = new bytes[](16);
        for (uint256 c = 0; c < 16; c++) {
            items[c] = RLP.encode(abi.encodePacked(roots[c]));
        }
        bytes[] memory committee = new bytes[](2);
        committee[0] = RLP.encode(items);
        committee[1] = RLP.encode(agg);
        return _config(RLP.encode(committee));
    }

    function _config(bytes memory committee) internal view returns (bytes memory) {
        bytes[] memory cfg = new bytes[](6);
        cfg[0] = RLP.encode(SLOT);
        cfg[1] = committee;
        cfg[2] = RLP.encode(abi.encodePacked(GVR));
        cfg[3] = RLP.encode(abi.encodePacked(FORK_VERSION));
        cfg[4] = RLP.encode(ledger);
        cfg[5] = RLP.encode(abi.encodePacked(CODE_HASH));
        return RLP.encode(cfg);
    }
}
