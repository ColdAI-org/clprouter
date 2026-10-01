// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {RouteCodec} from "@clprouter/libraries/RouteCodec.sol";

/// @dev External wrapper so the tests can try/catch the library's reverts.
contract CodecHarness {
    function decodeEnvelope(bytes calldata b) external pure returns (RouteTypes.Envelope memory) {
        return RouteCodec.decodeEnvelope(b);
    }

    function decodeReceipt(bytes calldata b) external pure returns (RouteTypes.Receipt memory) {
        return RouteCodec.decodeReceipt(b);
    }
}

/// @notice Codec fuzzing for the router security suite (docs/audit/router-findings.md):
///         decode(encode(x)) == x, encode(decode(·)) is a fixpoint (one canonical form), and arbitrary or
///         mutated input either decodes or reverts with MalformedProtobuf (never a panic or another error).
///         The non-canonical inputs the decoder accepts are finding L-02 (RouterFindingsUnit.t.sol).
contract RouteCodecFuzzTest is Test {
    CodecHarness internal h;

    function setUp() public {
        h = new CodecHarness();
    }

    // ── pseudo-random builders ─────────────────────────────────────────────

    function _r(bytes32 s, uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(s, i)));
    }

    function _bytes(bytes32 s, uint256 i, uint256 maxLen) internal pure returns (bytes memory out) {
        uint256 len = _r(s, i) % (maxLen + 1);
        out = new bytes(len);
        for (uint256 j = 0; j < len; j++) {
            out[j] = bytes1(uint8(_r(s, i * 1000 + j + 1)));
        }
    }

    function _b32(bytes32 s, uint256 i) internal pure returns (bytes32) {
        return _r(s, i) % 3 == 0 ? bytes32(0) : bytes32(_r(s, i + 7));
    }

    function _u64(bytes32 s, uint256 i) internal pure returns (uint64) {
        uint256 v = _r(s, i);
        return v % 3 == 0 ? 0 : uint64(v >> (v % 64));
    }

    function _u32(bytes32 s, uint256 i) internal pure returns (uint32) {
        uint256 v = _r(s, i);
        return v % 3 == 0 ? 0 : uint32(v >> (v % 32));
    }

    function _hop(bytes32 s, uint256 i) internal pure returns (RouteTypes.Hop memory x) {
        x.ledgerId = string(_bytes(s, i + 1, 20));
        x.router = _bytes(s, i + 2, 24);
        x.channelId = _b32(s, i + 3);
        x.connectorId = _b32(s, i + 4);
        x.fee = _u64(s, i + 5);
        x.feePayee = _bytes(s, i + 6, 24);
    }

    function _hops(bytes32 s, uint256 i, uint256 max) internal pure returns (RouteTypes.Hop[] memory xs) {
        xs = new RouteTypes.Hop[](_r(s, i) % (max + 1));
        for (uint256 j = 0; j < xs.length; j++) {
            xs[j] = _hop(s, i * 100 + j * 10);
        }
    }

    function _envelope(bytes32 s) internal pure returns (RouteTypes.Envelope memory e) {
        e.routeId = _r(s, 1) % 4 == 0 ? bytes16(0) : bytes16(bytes32(_r(s, 2)));
        e.origin = RouteTypes.Endpoint(string(_bytes(s, 3, 16)), _bytes(s, 4, 20));
        e.destination = RouteTypes.Endpoint(string(_bytes(s, 5, 16)), _bytes(s, 6, 20));
        e.sender = string(_bytes(s, 7, 40));
        e.recipient = string(_bytes(s, 8, 40));
        e.hops = _hops(s, 9, 4);
        e.hopIndex = _u32(s, 10);
        e.mode = RouteTypes.Mode(_r(s, 11) % 5);
        e.constraints = RouteTypes.Constraints({
            filters: _u32(s, 12),
            deadline: _u64(s, 13),
            maxFee: _u64(s, 14),
            remainingFeeBudget: _u64(s, 15),
            trustFloor: _u32(s, 16),
            maxHops: _u32(s, 17),
            loose: _r(s, 18) % 2 == 0,
            energyCap: _u64(s, 19)
        });
        e.payloadType = RouteTypes.PayloadType(_r(s, 20) % 4);
        e.payload = _bytes(s, 21, 64);
        e.receiptPath = _hops(s, 22, 2);
        e.originSignature = _bytes(s, 23, 65);
        e.filterRegistryVersions = new RouteTypes.RegistryVersion[](_r(s, 24) % 4);
        for (uint256 j = 0; j < e.filterRegistryVersions.length; j++) {
            e.filterRegistryVersions[j] = RouteTypes.RegistryVersion(_u32(s, 25 + j), _u64(s, 30 + j));
        }
        e.routerVersion = _u32(s, 35);
    }

    function _receipt(bytes32 s) internal pure returns (RouteTypes.Receipt memory r) {
        r.routeId = _r(s, 1) % 4 == 0 ? bytes16(0) : bytes16(bytes32(_r(s, 2)));
        r.status = RouteTypes.ReceiptStatus(_r(s, 3) % 5);
        r.hopIndex = _u32(s, 4);
        r.ledgerId = string(_bytes(s, 5, 20));
        r.reason = RouteTypes.Reason(_r(s, 6) % 14);
        r.caseId = _b32(s, 7);
        r.contact = string(_bytes(s, 8, 30));
        r.responseHash = _b32(s, 9);
        r.routePrefix = _hops(s, 10, 3);
        r.routeEdge = _b32(s, 11);
        r.routeRest = _b32(s, 12);
    }

    // ── round trips ────────────────────────────────────────────────────────

    function testFuzz_envelope_decodeEncode_isIdentity(bytes32 seed) public pure {
        RouteTypes.Envelope memory e = _envelope(seed);
        bytes memory b = RouteCodec.encodeEnvelope(e);
        RouteTypes.Envelope memory d = RouteCodec.decodeEnvelope(b);
        assertEq(keccak256(abi.encode(d)), keccak256(abi.encode(e)), "decode(encode(x)) != x");
        assertEq(RouteCodec.encodeEnvelope(d), b, "encode not a fixpoint");
    }

    function testFuzz_receipt_decodeEncode_isIdentity(bytes32 seed) public pure {
        RouteTypes.Receipt memory r = _receipt(seed);
        bytes memory b = RouteCodec.encodeReceipt(r);
        RouteTypes.Receipt memory d = RouteCodec.decodeReceipt(b);
        assertEq(keccak256(abi.encode(d)), keccak256(abi.encode(r)), "decode(encode(x)) != x");
        assertEq(RouteCodec.encodeReceipt(d), b);
    }

    // ── hostile input ──────────────────────────────────────────────────────

    function _checkEnvelopeInput(bytes memory b) internal view {
        try h.decodeEnvelope(b) returns (RouteTypes.Envelope memory e) {
            // Whatever is accepted has exactly one canonical form, and that form decodes to the same value.
            bytes memory c = RouteCodec.encodeEnvelope(e);
            RouteTypes.Envelope memory e2 = h.decodeEnvelope(c);
            assertEq(keccak256(abi.encode(e2)), keccak256(abi.encode(e)), "canonical form decodes differently");
            assertEq(RouteCodec.encodeEnvelope(e2), c, "canonical form not a fixpoint");
        } catch (bytes memory err) {
            assertEq(err.length, 4, "revert is not a bare custom error (panic / OOG?)");
            assertEq(bytes4(err), RouteCodec.MalformedProtobuf.selector, "unexpected revert");
        }
    }

    function testFuzz_envelope_arbitraryBytes_decodeOrMalformed(bytes calldata b) public view {
        _checkEnvelopeInput(b);
    }

    /// @dev Structured inputs: a valid encoding with one byte overwritten and optionally truncated.
    function testFuzz_envelope_mutated_decodeOrMalformed(bytes32 seed, uint256 pos, uint8 val, uint256 cut)
        public
        view
    {
        bytes memory b = RouteCodec.encodeEnvelope(_envelope(seed));
        if (b.length == 0) return;
        b[pos % b.length] = bytes1(val);
        cut = cut % (b.length + 1);
        assembly ("memory-safe") {
            if lt(cut, mload(b)) { mstore(b, cut) }
        }
        _checkEnvelopeInput(b);
    }

    function testFuzz_receipt_mutated_decodeOrMalformed(bytes32 seed, uint256 pos, uint8 val) public view {
        bytes memory b = RouteCodec.encodeReceipt(_receipt(seed));
        if (b.length == 0) return;
        b[pos % b.length] = bytes1(val);
        try h.decodeReceipt(b) returns (RouteTypes.Receipt memory r) {
            bytes memory c = RouteCodec.encodeReceipt(r);
            assertEq(keccak256(abi.encode(h.decodeReceipt(c))), keccak256(abi.encode(r)));
        } catch (bytes memory err) {
            assertEq(err.length, 4);
            assertEq(bytes4(err), RouteCodec.MalformedProtobuf.selector);
        }
    }

    /// @dev Fixed-length id fields of any other length are rejected (route_id 16, channel/connector/case 32).
    function testFuzz_fixedLengthIds_wrongLengthRejected(uint8 len) public {
        vm.assume(len != 0 && len != 16 && len < 120);
        bytes memory b = bytes.concat(hex"0a", bytes1(len), new bytes(len)); // route_id of `len` bytes
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        h.decodeEnvelope(b);
    }

    /// @dev Varints above uint64, uint32 fields above uint32 and out-of-range enums are rejected.
    function test_rangeChecks() public {
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        h.decodeEnvelope(hex"38ffffffffffffffffff02"); // varint value >= 2^64
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        h.decodeEnvelope(hex"388080808010"); // hop_index = 2^32
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        h.decodeEnvelope(hex"4005"); // mode = 5
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        h.decodeEnvelope(hex"5004"); // payload_type = 4
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        h.decodeReceipt(hex"1005"); // status = 5
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        h.decodeReceipt(hex"280e"); // reason = 14
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        h.decodeEnvelope(hex"0b"); // wire type 3 (group)
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        h.decodeEnvelope(hex"00"); // field number 0
    }
}
