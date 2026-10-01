// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {RouteCodec} from "@clprouter/libraries/RouteCodec.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {RouteLogic} from "@clprouter/libraries/RouteLogic.sol";

contract RouteCodecTest is Test {
    function _sample() internal pure returns (RouteTypes.Envelope memory e) {
        e.routeId = bytes16(0x0123456789abcdef0123456789abcdef);
        e.origin = RouteTypes.Endpoint("eip155:1", hex"1111111111111111111111111111111111111111");
        e.destination = RouteTypes.Endpoint("hedera:mainnet", hex"2222222222222222222222222222222222222222");
        e.sender = "eip155:1:0x1111111111111111111111111111111111111111";
        e.recipient = "hedera:mainnet:0.0.1234";
        e.hops = new RouteTypes.Hop[](2);
        e.hops[0] = RouteTypes.Hop("eip155:1", hex"aa", keccak256("c"), keccak256("k"), 300, hex"bb");
        e.hops[1] = RouteTypes.Hop("hedera:mainnet", hex"cc", bytes32(0), bytes32(0), 0, "");
        e.hopIndex = 1;
        e.mode = RouteTypes.Mode.GREENEST;
        e.constraints = RouteTypes.Constraints(7, 1_900_000_000, 1e18, 5e17, 2, 3, true, 2400);
        e.payloadType = RouteTypes.PayloadType.ISO20022;
        e.payload = "pacs.008-hash";
        e.receiptPath = new RouteTypes.Hop[](1);
        e.receiptPath[0] = RouteTypes.Hop("x", "", bytes32(0), bytes32(0), 0, "");
        e.originSignature = hex"5151";
        e.filterRegistryVersions = new RouteTypes.RegistryVersion[](2);
        e.filterRegistryVersions[0] = RouteTypes.RegistryVersion(1, 17);
        e.filterRegistryVersions[1] = RouteTypes.RegistryVersion(4, 17);
        e.routerVersion = 1;
    }

    function test_envelope_roundTrip() public pure {
        RouteTypes.Envelope memory e = _sample();
        bytes memory enc = RouteCodec.encodeEnvelope(e);
        RouteTypes.Envelope memory d = RouteCodec.decodeEnvelope(enc);
        assertEq(keccak256(abi.encode(d)), keccak256(abi.encode(e)));
        assertEq(keccak256(RouteCodec.encodeEnvelope(d)), keccak256(enc), "canonical");
    }

    function test_envelope_emptyRoundTrip() public pure {
        RouteTypes.Envelope memory e;
        bytes memory enc = RouteCodec.encodeEnvelope(e);
        assertEq(enc.length, 0);
        RouteTypes.Envelope memory d = RouteCodec.decodeEnvelope(enc);
        assertEq(d.hops.length, 0);
    }

    /// @dev Known-answer vector for cross-implementation checks (the planner SDK encodes the same bytes):
    ///      route_id=0x01..10, hop_index=2, router_version=1.
    function test_envelope_knownAnswer() public pure {
        RouteTypes.Envelope memory e;
        e.routeId = bytes16(0x0102030405060708090a0b0c0d0e0f10);
        e.hopIndex = 2;
        e.routerVersion = 1;
        assertEq(RouteCodec.encodeEnvelope(e), hex"0a100102030405060708090a0b0c0d0e0f10380278" hex"01");
    }

    /// @dev Unknown fields are rejected (every hop runs the same router_version; L-02 canonical decoding).
    function test_decode_rejectsUnknownFields() public {
        bytes memory enc = RouteCodec.encodeEnvelope(_sample());
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        RouteCodec.decodeEnvelope(bytes.concat(enc, hex"980601")); // field 99 varint
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        RouteCodec.decodeEnvelope(bytes.concat(enc, hex"a9060102030405060708")); // field 101 fixed64
    }

    function test_envelope_isoUetr_roundTrip() public pure {
        RouteTypes.Envelope memory e = _sample();
        e.isoUetr = bytes16(0x8a1b2c3d4e5f40718293a4b5c6d7e8f9);
        bytes memory enc = RouteCodec.encodeEnvelope(e);
        assertEq(RouteCodec.decodeEnvelope(enc).isoUetr, e.isoUetr);
        // field 16, wire type 2: key 0x82 0x01, length 0x10, then 16 bytes, at the very end
        assertEq(enc[enc.length - 19], bytes1(0x82));
        assertEq(enc[enc.length - 18], bytes1(0x01));
        assertEq(enc[enc.length - 17], bytes1(0x10));
    }

    function test_decode_rejectsTruncated() public {
        bytes memory enc = RouteCodec.encodeEnvelope(_sample());
        bytes memory cut = new bytes(enc.length - 3);
        for (uint256 i = 0; i < cut.length; i++) {
            cut[i] = enc[i];
        }
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        RouteCodec.decodeEnvelope(cut);
    }

    function test_decode_rejectsWrongIdLengths() public {
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        RouteCodec.decodeEnvelope(hex"0a03010203"); // route_id of 3 bytes
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        RouteCodec.decodeEnvelope(hex"32041a020102"); // hop channel_id of 2 bytes
    }

    function test_decode_rejectsBadWireTypeAndFieldZero() public {
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        RouteCodec.decodeEnvelope(hex"0b"); // wire type 3 (start group)
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        RouteCodec.decodeEnvelope(hex"0001"); // field 0
    }

    function test_decode_rejectsOutOfRangeEnums() public {
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        RouteCodec.decodeEnvelope(hex"4005"); // mode = 5
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        RouteCodec.decodeEnvelope(hex"5004"); // payload_type = 4
    }

    function test_decode_rejectsOverlongVarint() public {
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        RouteCodec.decodeEnvelope(hex"38ffffffffffffffffff7f");
    }

    function test_receipt_roundTrip() public pure {
        RouteTypes.Receipt memory r;
        r.routeId = bytes16(uint128(5));
        r.status = RouteTypes.ReceiptStatus.QUARANTINED;
        r.hopIndex = 2;
        r.ledgerId = "eip155:31003";
        r.reason = RouteTypes.Reason.BLACKLIST;
        r.caseId = keccak256("case");
        r.contact = "mailto:x@y";
        r.responseHash = keccak256("resp");
        r.routePrefix = _sample().hops;
        r.routeEdge = keccak256("edge");
        r.routeRest = keccak256("rest");
        RouteTypes.Receipt memory d = RouteCodec.decodeReceipt(RouteCodec.encodeReceipt(r));
        assertEq(keccak256(abi.encode(d)), keccak256(abi.encode(r)));
    }

    /// @dev Fields 10 and 11 (route_edge, route_rest) are fixed 32-byte ids; field 9 is absent in the common case
    ///      and route_rest is absent at the destination.
    function test_receipt_commitmentFields_knownAnswer() public pure {
        RouteTypes.Receipt memory r;
        r.status = RouteTypes.ReceiptStatus.DELIVERED;
        r.hopIndex = 2;
        r.routeEdge = bytes32(uint256(1));
        assertEq(RouteCodec.encodeReceipt(r), bytes.concat(hex"100118025220", bytes32(uint256(1))));
        r.routeRest = bytes32(uint256(2));
        RouteTypes.Receipt memory d = RouteCodec.decodeReceipt(RouteCodec.encodeReceipt(r));
        assertEq(d.routeEdge, bytes32(uint256(1)));
        assertEq(d.routeRest, bytes32(uint256(2)));
    }

    function test_hopsCommitment_changesWithAnyField() public pure {
        RouteTypes.Hop[] memory h = _sample().hops;
        bytes32 base = RouteLogic.hopsCommitment(h, 0);
        h[0].feePayee = hex"bc";
        assertTrue(RouteLogic.hopsCommitment(h, 0) != base);
        h = _sample().hops;
        h[1].router = hex"cd";
        assertTrue(RouteLogic.hopsCommitment(h, 0) != base);
        h = _sample().hops;
        h[1].ledgerId = "hedera:testnet";
        assertTrue(RouteLogic.hopsCommitment(h, 0) != base);
        h = _sample().hops;
        h[0].fee = 301;
        assertTrue(RouteLogic.hopsCommitment(h, 0) != base);
        h = _sample().hops;
        h[0].connectorId = bytes32(0);
        assertTrue(RouteLogic.hopsCommitment(h, 0) != base);
        assertEq(RouteLogic.hopsCommitment(h, h.length), bytes32(0), "nothing after the destination");
    }

    function testFuzz_envelope_roundTrip(
        bytes16 id,
        string calldata sender,
        uint32 hopIndex,
        uint64 deadline,
        uint64 budget,
        bool loose,
        bytes calldata payload,
        uint64 fee,
        uint64 version
    ) public pure {
        RouteTypes.Envelope memory e = _sample();
        e.routeId = id;
        e.sender = sender;
        e.hopIndex = hopIndex;
        e.constraints.deadline = deadline;
        e.constraints.remainingFeeBudget = budget;
        e.constraints.loose = loose;
        e.payload = payload;
        e.hops[0].fee = fee;
        e.filterRegistryVersions[0].version = version;
        RouteTypes.Envelope memory d = RouteCodec.decodeEnvelope(RouteCodec.encodeEnvelope(e));
        assertEq(keccak256(abi.encode(d)), keccak256(abi.encode(e)));
    }

    function testFuzz_decode_neverPanics(bytes calldata junk) public {
        try this.decodeExternal(junk) {}
        catch (bytes memory err) {
            assertEq(bytes4(err), RouteCodec.MalformedProtobuf.selector, "only MalformedProtobuf");
        }
    }

    function decodeExternal(bytes calldata b) external pure returns (RouteTypes.Envelope memory) {
        return RouteCodec.decodeEnvelope(b);
    }

    // ── Caip ───────────────────────────────────────────────────────────────

    function test_caip_account_lowercaseHex() public pure {
        assertEq(
            Caip.account("eip155:1", 0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD),
            "eip155:1:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
        );
    }

    function test_caip_accountKey_caseInsensitive() public pure {
        assertEq(Caip.accountKey("EIP155:1:0xAB"), Caip.accountKey("eip155:1:0xab"));
    }
}
