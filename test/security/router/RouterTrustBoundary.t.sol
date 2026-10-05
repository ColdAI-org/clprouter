// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ClprDeployHelper} from "@test/helpers/ClprDeployHelper.sol";
import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprProtobuf} from "@hiero-ledger/clpr/libraries/codec/ClprProtobuf.sol";
import {IClprRouter} from "@clprouter/interfaces/IClprRouter.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {RouteCodec} from "@clprouter/libraries/RouteCodec.sol";
import {RouteLogic} from "@clprouter/libraries/RouteLogic.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {ThreeLedgerFixture} from "../../helpers/ThreeLedgerFixture.sol";

/// @notice Trust boundary of the Router on three ledgers running the unchanged reference ClprService: which
///         Channels it listens to.
contract RouterTrustBoundaryTest is ThreeLedgerFixture {
    // ═════════════════════════════════════════════════════════════════════
    // Only Channels the provider registry approves carry messages
    // ═════════════════════════════════════════════════════════════════════

    /// @dev A bare ClprService that says it is ledger `id`: stands for a Channel whose verifier accepts anything,
    ///      with any stamped sender. Opening such a Channel is permissionless.
    function _openSide(string memory id) internal returns (Ledger memory l) {
        l.id = id;
        l.service = ClprDeployHelper.deployServiceForTests(address(this), 1, id);
        l.service.initialize(abi.encodePacked(address(l.service)), throttles, "", "", econ);
        l.service.setClprEnabled(true);
    }

    /// @dev An envelope "from A.app on ledger A, routed by A's and B's Routers" arrives at C over a Channel nobody
    ///      approved, whose verifier vouches for B's canonical Router. C refuses it; nothing reaches C.app.
    function test_rejectsMessageFromUnapprovedChannel() public {
        Ledger memory fakeB = _openSide(ID_B);
        bytes32 ch = _channel(fakeB, C, bytes32("unapproved"));
        bytes32 conn = _connector(fakeB, C, ch, bytes32("conn-unapproved"));

        RouteTypes.Envelope memory e;
        e.routeId = bytes16(keccak256("unsent route"));
        e.origin = RouteTypes.Endpoint(ID_A, abi.encodePacked(address(A.app)));
        e.destination = RouteTypes.Endpoint(ID_C, abi.encodePacked(address(C.app)));
        e.sender = Caip.account(ID_A, address(A.app));
        e.recipient = Caip.account(ID_C, address(C.app));
        e.hops = new RouteTypes.Hop[](3);
        e.hops[0] = _hop(A, chAB, connAB, 0, address(0));
        e.hops[1] = _hop(B, ch, conn, 0, address(0));
        e.hops[2] = _hop(C, bytes32(0), bytes32(0), 0, address(0));
        e.hopIndex = 2;
        e.constraints.deadline = uint64(block.timestamp + 1 hours);
        e.payload = "release 1000 units";
        e.routerVersion = 1;
        bytes memory data = RouteCodec.encodeEnvelope(e);

        vm.prank(address(C.service));
        vm.expectRevert(abi.encodeWithSelector(IClprRouter.ChannelNotApproved.selector, ch));
        C.router.onClprMessage(ch, abi.encodePacked(address(B.router)), data);

        vm.prank(address(B.router)); // the Channel's verifier vouches for this sender
        fakeB.service.sendMessage(ch, conn, abi.encodePacked(address(C.router)), data);
        _relay(fakeB, C, ch);
        assertEq(C.app.deliveredCount(), 0, "nothing delivered over an unapproved Channel");
    }

    /// @dev The same Channel id approved with another verifier than the one the receiving Service uses for it
    ///      is refused as well.
    function test_rejectsApprovedChannelWithAnotherVerifier() public {
        _labelAllWith(chAB, B, address(A.service)); // names a contract that is not B's verifier for chAB
        vm.warp(block.timestamp + CERT_NOTICE);
        bytes16 id = _sendAs(alice, _request(0), 0.03 ether);
        bytes memory data = RouteCodec.encodeEnvelope(_lastSent(A, chAB));
        vm.prank(address(B.service));
        vm.expectRevert(abi.encodeWithSelector(IClprRouter.ChannelNotApproved.selector, chAB));
        B.router.onClprMessage(chAB, abi.encodePacked(address(A.router)), data);
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.PENDING));
    }

    /// @dev A sender cannot route over a Channel of its own (not approved): `send` refuses before any value moves.
    function test_sendRejectsUnapprovedChannel() public {
        bytes32 own = _channel(A, B, bytes32("sender-AB"));
        bytes32 connOwn = _connector(A, B, own, bytes32("sender-conn"));
        IClprRouter.SendRequest memory req = _request(1 ether);
        req.hops[0].channelId = own;
        req.hops[0].connectorId = connOwn;
        vm.expectRevert(abi.encodeWithSelector(IClprRouter.RouteBlocked.selector, 0, RouteTypes.Reason.DISABLED_EDGE));
        _sendAs(alice, req, 1.1 ether);
    }

    /// @dev Both directions of every edge must be approved at send: the receipt comes back the other way.
    function test_sendRejectsEdgeWithoutApprovedWayBack() public {
        _apply(A.registry, A_TRUST_TIER, _trustPayload(chBC, ID_B, 255, address(0))); // B <- C label removed on A
        vm.warp(block.timestamp + REMOVAL_NOTICE);
        vm.expectRevert(abi.encodeWithSelector(IClprRouter.RouteBlocked.selector, 1, RouteTypes.Reason.DISABLED_EDGE));
        _sendAs(alice, _request(0), 0.03 ether);
    }

    /// @dev A FAILED receipt for a route that is really delivered, built from the public route and sent "by B's
    ///      Router" over the sender's own Channel, is refused at the origin: the payee is paid on delivery.
    function test_unapprovedChannelCannotSettleRoute() public {
        bytes32 own = _channel(A, B, bytes32("sender-AB"));
        bytes32 connOwn = _connector(A, B, own, bytes32("sender-conn"));
        uint256 before = alice.balance;
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);

        RouteTypes.Envelope memory sent = _lastSent(A, chAB);
        sent.hopIndex = 1;
        RouteTypes.Receipt memory r;
        r.status = RouteTypes.ReceiptStatus.FAILED;
        r.reason = RouteTypes.Reason.NEXT_HOP_ERROR;
        RouteTypes.Hop[] memory back = RouteLogic.reversePrefix(sent.hops, 1);
        back[0].channelId = own;
        back[0].connectorId = connOwn;
        (,, bytes memory receipt) = RouteLogic.buildReceipt(sent, r, ID_B, address(B.router), 1);
        RouteTypes.Envelope memory re = RouteCodec.decodeEnvelope(receipt);
        re.hops = back;
        bytes memory data = RouteCodec.encodeEnvelope(re);

        vm.prank(address(A.service));
        vm.expectRevert(abi.encodeWithSelector(IClprRouter.ChannelNotApproved.selector, own));
        A.router.onClprMessage(own, abi.encodePacked(address(B.router)), data);
        vm.prank(address(B.router));
        B.service.sendMessage(own, connOwn, abi.encodePacked(address(A.router)), data);
        _relay(B, A, own);
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.PENDING), "receipt refused");

        _settle();
        assertEq(C.app.deliveredCount(), 1);
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.DELIVERED));
        assertEq(payee.balance, 1 ether, "payee paid on delivery");
        assertEq(alice.balance, before - 1.1 ether + 0.07 ether, "sender pays escrow and the two hop fees");
    }

    /// @dev Nobody but the canonical Routers, over approved Channels, can use a receipt's replay key at the
    ///      origin: a junk "receipt" with the genuine receipt's id over an unapproved Channel is refused, and the
    ///      genuine DELIVERED receipt then settles the route.
    function test_thirdPartyCannotConsumeReceiptReplayKey() public {
        Ledger memory fakeB = _openSide(ID_B);
        bytes32 ch = _channel(fakeB, A, bytes32("unapproved-A"));
        bytes32 conn = _connector(fakeB, A, ch, bytes32("conn-unapproved-A"));
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);

        RouteTypes.Receipt memory r;
        r.routeId = id;
        r.status = RouteTypes.ReceiptStatus.FAILED;
        r.hopIndex = 1;
        RouteTypes.Envelope memory re;
        re.routeId = bytes16(
            keccak256(
                abi.encode(
                    keccak256("clprouter.v1.receipt"),
                    keccak256(bytes(ID_A)),
                    keccak256(abi.encodePacked(address(A.router))),
                    id,
                    uint256(2)
                )
            )
        );
        re.origin = RouteTypes.Endpoint(ID_C, abi.encodePacked(address(C.router)));
        re.destination = RouteTypes.Endpoint(ID_A, abi.encodePacked(alice));
        re.hops = new RouteTypes.Hop[](3);
        re.hops[0] = _hop(C, chBC, connBC, 0, address(0));
        re.hops[1] = _hop(B, ch, conn, 0, address(0));
        re.hops[2] = _hop(A, bytes32(0), bytes32(0), 0, address(0));
        re.hopIndex = 2;
        re.payloadType = RouteTypes.PayloadType.RECEIPT;
        re.routerVersion = 1;
        re.payload = RouteCodec.encodeReceipt(r);
        bytes memory data = RouteCodec.encodeEnvelope(re);
        vm.prank(address(B.router));
        fakeB.service.sendMessage(ch, conn, abi.encodePacked(address(A.router)), data);
        _relay(fakeB, A, ch);
        bytes32 receiptKey = _key(ID_C, address(C.router), re.routeId);
        assertEq(uint8(A.router.hopState(receiptKey)), uint8(IClprRouter.HopState.NONE), "replay key untouched");

        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.DELIVERED));
        assertEq(payee.balance, 1 ether, "payee paid after delivery");
        vm.warp(block.timestamp + 1 hours + 3 * RECLAIM_GRACE + 1);
        vm.expectRevert(IClprRouter.NotReclaimable.selector);
        A.router.reclaim(id);
    }

    // ── helpers ────────────────────────────────────────────────────────────

    /// @dev Label the direction of `ch` into `to` on every ledger, naming `verifier`.
    function _labelAllWith(bytes32 ch, Ledger memory to, address verifier) internal {
        _applyAll(A_TRUST_TIER, _trustPayload(ch, to.id, 0, verifier));
    }

    /// @dev The envelope of the last message `l` queued on `ch`.
    function _lastSent(Ledger memory l, bytes32 ch) internal returns (RouteTypes.Envelope memory) {
        return RouteCodec.decodeEnvelope(
            ClprProtobuf.decodeDataMessage(l.service.getMessage(ch, l.service.getChannel(ch).nextMessageId - 1).payload)
            .messageData
        );
    }
}
