// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprRouter} from "@clprouter/ClprRouter.sol";
import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {QuarantineVault} from "@clprouter/QuarantineVault.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {IQuarantineVault} from "@clprouter/interfaces/IQuarantineVault.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {RouteCodec} from "@clprouter/libraries/RouteCodec.sol";
import {RouteLogic} from "@clprouter/libraries/RouteLogic.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {Committee} from "../helpers/Committee.sol";
import {MockRouteService} from "../helpers/MockRouteService.sol";

/// @notice One intermediate hop (ledger B) in isolation, on a CLPR Service that lets `sendMessage` run inside
///         delivery. Covers the direct forward path, CLPR-level rejections, strict vs loose routing, receipts
///         in transit, and every inbound validation rule.
contract RouterHopTest is Committee {
    string internal constant ID_A = "eip155:31001";
    string internal constant ID_B = "eip155:31002";
    string internal constant ID_C = "eip155:31003";
    string internal constant ID_D = "eip155:31004";
    bytes32 internal constant CH_AB = keccak256("AB");
    bytes32 internal constant CH_BC = keccak256("BC");
    bytes32 internal constant CH_BD = keccak256("BD");
    bytes32 internal constant CONN = keccak256("connector");

    MockRouteService internal svc;
    ProviderRegistry internal reg;
    ClprRouter internal router;
    address internal routerA = makeAddr("router-A");
    address internal routerC = makeAddr("router-C");
    address internal routerD = makeAddr("router-D");

    function setUp() public {
        vm.warp(1_800_000_000);
        _initCommittee();
        svc = new MockRouteService(ID_B);
        svc.setPeer(CH_AB, ID_A);
        svc.setPeer(CH_BC, ID_C);
        svc.setPeer(CH_BD, ID_D);
        reg = _deployRegistry();
        QuarantineVault vault = new QuarantineVault(IProviderRegistry(address(reg)), 3 days, 7 days);
        router = new ClprRouter(
            IClprService(address(svc)),
            IProviderRegistry(address(reg)),
            IQuarantineVault(address(vault)),
            ID_B,
            1 hours,
            300_000
        );
    }

    // ── envelope builders ──────────────────────────────────────────────────

    function _hops() internal returns (RouteTypes.Hop[] memory h) {
        h = new RouteTypes.Hop[](3);
        h[0] = RouteTypes.Hop(ID_A, abi.encodePacked(routerA), CH_AB, CONN, 10, abi.encodePacked(makeAddr("pA")));
        h[1] = RouteTypes.Hop(ID_B, abi.encodePacked(address(router)), CH_BC, CONN, 20, "");
        h[2] = RouteTypes.Hop(ID_C, abi.encodePacked(routerC), bytes32(0), bytes32(0), 0, "");
    }

    function _env(bool loose) internal returns (RouteTypes.Envelope memory e) {
        e.routeId = bytes16(keccak256("route-1"));
        e.origin = RouteTypes.Endpoint(ID_A, abi.encodePacked(makeAddr("origin-app")));
        e.destination = RouteTypes.Endpoint(ID_C, abi.encodePacked(makeAddr("dest-app")));
        e.sender = Caip.account(ID_A, makeAddr("origin-app"));
        e.recipient = Caip.account(ID_C, makeAddr("dest-app"));
        e.hops = _hops();
        e.hopIndex = 1;
        e.constraints.deadline = uint64(block.timestamp + 1 hours);
        e.constraints.remainingFeeBudget = 20;
        e.constraints.loose = loose;
        e.payload = "data";
        e.routerVersion = 1;
    }

    function _deliver(RouteTypes.Envelope memory e) internal returns (bytes memory held, bytes memory resp) {
        held = RouteCodec.encodeEnvelope(e);
        resp = svc.deliver(router, CH_AB, abi.encodePacked(routerA), held);
    }

    function _sentEnvelope(uint256 i) internal view returns (RouteTypes.Envelope memory) {
        return RouteCodec.decodeEnvelope(svc.sent(i).data);
    }

    function _sentReceipt(uint256 i) internal view returns (RouteTypes.Receipt memory r) {
        RouteTypes.Envelope memory re = _sentEnvelope(i);
        assertEq(uint8(re.payloadType), uint8(RouteTypes.PayloadType.RECEIPT));
        r = RouteCodec.decodeReceipt(re.payload);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Direct forwarding inside delivery
    // ═════════════════════════════════════════════════════════════════════

    function test_forwardsInsideDelivery_andDeductsFee() public {
        (, bytes memory resp) = _deliver(_env(false));
        assertEq(resp, abi.encodePacked(uint8(1), uint8(0)), "accepted");
        assertEq(svc.sentCount(), 1);
        MockRouteService.Sent memory s = svc.sent(0);
        assertEq(s.channelId, CH_BC);
        assertEq(s.connectorId, CONN);
        assertEq(s.target, abi.encodePacked(routerC));
        RouteTypes.Envelope memory out = RouteCodec.decodeEnvelope(s.data);
        assertEq(out.hopIndex, 2);
        assertEq(out.constraints.remainingFeeBudget, 0);
        assertEq(uint8(router.hopState(out.routeId)), uint8(ClprRouter.HopState.FORWARDED));
    }

    function test_successResponse_closesHop() public {
        (bytes memory held,) = _deliver(_env(false));
        bytes16 id = _env(false).routeId;
        assertEq(router.pendingHash(id), keccak256(held));
        svc.respond(router, CH_BC, svc.lastId(), 0);
        assertEq(uint8(router.hopState(id)), uint8(ClprRouter.HopState.DONE));
        assertEq(router.pendingHash(id), bytes32(0));
    }

    function test_unknownResponse_isIgnored() public {
        svc.respond(router, CH_BC, 99, 1);
    }

    function test_guardedService_defersAndAnyoneCompletes() public {
        svc.setGuard(true);
        (bytes memory held,) = _deliver(_env(false));
        assertEq(svc.sentCount(), 0);
        bytes16 id = _env(false).routeId;
        assertEq(uint8(router.hopState(id)), uint8(ClprRouter.HopState.FORWARD_PENDING));
        vm.prank(makeAddr("anyone"));
        router.forward(held, new RouteTypes.Hop[](0));
        assertEq(svc.sentCount(), 1);
        assertEq(uint8(router.hopState(id)), uint8(ClprRouter.HopState.FORWARDED));
    }

    function test_pumpedHop_recheckedAfterDeadline() public {
        svc.setGuard(true);
        (bytes memory held,) = _deliver(_env(false));
        vm.warp(block.timestamp + 2 hours);
        router.forward(held, new RouteTypes.Hop[](0));
        RouteTypes.Receipt memory r = _sentReceipt(0);
        assertEq(uint8(r.status), uint8(RouteTypes.ReceiptStatus.EXPIRED));
        assertEq(svc.sent(0).channelId, CH_AB, "receipt goes back towards the origin");
    }

    // ═════════════════════════════════════════════════════════════════════
    // CLPR-level rejection of a forward (NACK), strict vs loose
    // ═════════════════════════════════════════════════════════════════════

    function test_nack_strict_sendsFailureReceipt() public {
        (bytes memory held,) = _deliver(_env(false));
        bytes16 id = _env(false).routeId;
        svc.respond(router, CH_BC, svc.lastId(), 3); // CONNECTOR_UNDERFUNDED
        assertEq(uint8(router.hopState(id)), uint8(ClprRouter.HopState.NACKED));

        vm.expectRevert(ClprRouter.LooseRoutingRequired.selector);
        router.forward(held, _tailViaD());

        router.forward(held, new RouteTypes.Hop[](0));
        RouteTypes.Receipt memory r = _sentReceipt(1);
        assertEq(r.routeId, id);
        assertEq(uint8(r.status), uint8(RouteTypes.ReceiptStatus.FAILED));
        assertEq(uint8(r.reason), uint8(RouteTypes.Reason.NEXT_HOP_ERROR));
        assertEq(r.hopIndex, 1);
        assertEq(r.ledgerId, ID_B);
        assertEq(svc.sent(1).target, abi.encodePacked(routerA));
    }

    function test_nack_loose_reroutesOverAlternateTail() public {
        (bytes memory held,) = _deliver(_env(true));
        svc.respond(router, CH_BC, svc.lastId(), 1);
        router.forward(held, _tailViaD());
        MockRouteService.Sent memory s = svc.sent(1);
        assertEq(s.channelId, CH_BD);
        assertEq(s.target, abi.encodePacked(routerD));
        RouteTypes.Envelope memory out = RouteCodec.decodeEnvelope(s.data);
        assertEq(out.hops.length, 4);
        assertEq(out.hops[2].ledgerId, ID_D);
        assertEq(out.hopIndex, 2);
    }

    function test_loose_tailMustStartHereAndEndAtDestination() public {
        (bytes memory held,) = _deliver(_env(true));
        svc.respond(router, CH_BC, svc.lastId(), 1);
        RouteTypes.Hop[] memory tail = _tailViaD();
        tail[2].ledgerId = ID_A; // revisits the origin and misses the destination
        vm.expectRevert(abi.encodeWithSelector(RouteLogic.InvalidRoute.selector, RouteTypes.Reason.BAD_ROUTE));
        router.forward(held, tail);
    }

    function test_sendFailure_strict_failureReceipt() public {
        svc.setFailChannel(CH_BC, true);
        (, bytes memory resp) = _deliver(_env(false));
        assertEq(resp, abi.encodePacked(uint8(2), uint8(RouteTypes.Reason.SEND_FAILED)));
        RouteTypes.Receipt memory r = _sentReceipt(0);
        assertEq(uint8(r.reason), uint8(RouteTypes.Reason.SEND_FAILED));
    }

    function test_sendFailure_loose_waitsForReroute() public {
        svc.setFailChannel(CH_BC, true);
        (bytes memory held,) = _deliver(_env(true));
        assertEq(svc.sentCount(), 0);
        assertEq(uint8(router.hopState(_env(true).routeId)), uint8(ClprRouter.HopState.NACKED));
        router.forward(held, _tailViaD());
        assertEq(svc.sent(0).channelId, CH_BD);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Per-hop constraints
    // ═════════════════════════════════════════════════════════════════════

    function test_feeBudgetExhausted_failureReceipt() public {
        RouteTypes.Envelope memory e = _env(false);
        e.constraints.remainingFeeBudget = 19;
        _deliver(e);
        assertEq(uint8(_sentReceipt(0).reason), uint8(RouteTypes.Reason.FEE_BUDGET));
    }

    function test_trustFloor_nextEdgeBelowFloor_failureReceipt() public {
        _apply(reg, 11, abi.encode(CH_BC, ID_C, uint8(1)));
        vm.warp(block.timestamp + CERT_NOTICE);
        RouteTypes.Envelope memory e = _env(false);
        e.constraints.deadline = uint64(block.timestamp + 1 hours);
        e.constraints.trustFloor = 2;
        (, bytes memory resp) = _deliver(e);
        assertEq(resp, abi.encodePacked(uint8(2), uint8(RouteTypes.Reason.TRUST_FLOOR)));
        assertEq(svc.sentCount(), 1, "only the receipt");
        assertEq(uint8(_sentReceipt(0).reason), uint8(RouteTypes.Reason.TRUST_FLOOR));
    }

    function test_trustFloor_unlabelledNextEdge_failsClosed() public {
        RouteTypes.Envelope memory e = _env(false);
        e.constraints.trustFloor = 1;
        _deliver(e);
        assertEq(uint8(_sentReceipt(0).reason), uint8(RouteTypes.Reason.TRUST_FLOOR));
    }

    function test_trustFloor_nextEdgeAtFloor_forwards() public {
        _apply(reg, 11, abi.encode(CH_BC, ID_C, uint8(2)));
        vm.warp(block.timestamp + CERT_NOTICE);
        RouteTypes.Envelope memory e = _env(false);
        e.constraints.deadline = uint64(block.timestamp + 1 hours);
        e.constraints.trustFloor = 2;
        (, bytes memory resp) = _deliver(e);
        assertEq(resp, abi.encodePacked(uint8(1), uint8(0)));
        assertEq(svc.sent(0).channelId, CH_BC);
    }

    function test_nextChannelGoesToAnotherLedger_failureReceipt() public {
        RouteTypes.Envelope memory e = _env(false);
        e.hops[1].channelId = CH_BD; // goes to D, but the route says C
        _deliver(e);
        assertEq(uint8(_sentReceipt(0).reason), uint8(RouteTypes.Reason.BAD_ROUTE));
    }

    function test_disabledNextRouter_failureReceipt() public {
        _apply(reg, A_DISABLE, _disablePayload(3, Caip.routerKey(ID_C, abi.encodePacked(routerC))));
        _deliver(_env(false));
        assertEq(uint8(_sentReceipt(0).reason), uint8(RouteTypes.Reason.DISABLED_ROUTER));
    }

    /// @dev A message from a disabled Router is not forwarded; the receipt is not sent back to that Router
    ///      either (the origin reclaims after the deadline).
    function test_disabledPreviousRouter_refusesToForward() public {
        _apply(reg, A_DISABLE, _disablePayload(3, Caip.routerKey(ID_A, abi.encodePacked(routerA))));
        RouteTypes.Envelope memory e = _env(false);
        bytes memory held = RouteCodec.encodeEnvelope(e);
        vm.expectEmit(true, false, false, true, address(router));
        emit ClprRouter.RouteStopped(e.routeId, 1, RouteTypes.ReceiptStatus.FAILED, RouteTypes.Reason.DISABLED_INBOUND);
        svc.deliver(router, CH_AB, abi.encodePacked(routerA), held);
        assertEq(svc.sentCount(), 0);
    }

    function test_disabledInboundEdge_failureReceiptStillGoesBack() public {
        _apply(reg, A_DISABLE, _disablePayload(1, Caip.edgeKey(CH_AB, ID_B)));
        _deliver(_env(false));
        assertEq(svc.sentCount(), 1, "only the receipt, nothing forwarded");
        assertEq(uint8(_sentReceipt(0).reason), uint8(RouteTypes.Reason.DISABLED_INBOUND));
    }

    // ═════════════════════════════════════════════════════════════════════
    // Receipts in transit
    // ═════════════════════════════════════════════════════════════════════

    function _receiptAtB() internal returns (RouteTypes.Envelope memory re) {
        RouteTypes.Receipt memory r;
        r.routeId = bytes16(keccak256("route-1"));
        r.status = RouteTypes.ReceiptStatus.DELIVERED;
        r.hopIndex = 2;
        r.ledgerId = ID_C;
        r.routeHops = _hops();
        re.routeId = bytes16(keccak256("receipt-1"));
        re.origin = RouteTypes.Endpoint(ID_C, abi.encodePacked(routerC));
        re.destination = RouteTypes.Endpoint(ID_A, abi.encodePacked(routerA));
        re.hops = RouteLogic.reversePrefix(_hops(), 2);
        re.hopIndex = 1;
        re.payloadType = RouteTypes.PayloadType.RECEIPT;
        re.payload = RouteCodec.encodeReceipt(r);
        re.routerVersion = 1;
    }

    function test_receiptInTransit_isForwardedTowardsOrigin() public {
        RouteTypes.Envelope memory re = _receiptAtB();
        svc.deliver(router, CH_BC, abi.encodePacked(routerC), RouteCodec.encodeEnvelope(re));
        MockRouteService.Sent memory s = svc.sent(0);
        assertEq(s.channelId, CH_AB);
        assertEq(s.target, abi.encodePacked(routerA));
        assertEq(RouteCodec.decodeEnvelope(s.data).hopIndex, 2);
        assertEq(uint8(router.hopState(re.routeId)), uint8(ClprRouter.HopState.DONE));
    }

    function test_receiptOverDisabledEdge_isDropped() public {
        _apply(reg, A_DISABLE, _disablePayload(1, Caip.edgeKey(CH_AB, ID_A)));
        RouteTypes.Envelope memory re = _receiptAtB();
        bytes memory data = RouteCodec.encodeEnvelope(re);
        vm.expectEmit(true, false, false, true, address(router));
        emit ClprRouter.ReceiptUndeliverable(re.routeId, RouteTypes.Reason.DISABLED_EDGE);
        svc.deliver(router, CH_BC, abi.encodePacked(routerC), data);
        assertEq(svc.sentCount(), 0);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Inbound validation (reverts → CLPR APPLICATION_ERROR to the previous hop)
    // ═════════════════════════════════════════════════════════════════════

    function test_replay_reverts() public {
        _deliver(_env(false));
        bytes memory held = RouteCodec.encodeEnvelope(_env(false));
        vm.expectRevert(ClprRouter.RouteReplayed.selector);
        svc.deliver(router, CH_AB, abi.encodePacked(routerA), held);
    }

    function test_wrongSenderRouter_reverts() public {
        bytes memory held = RouteCodec.encodeEnvelope(_env(false));
        vm.expectRevert(ClprRouter.UnexpectedSender.selector);
        svc.deliver(router, CH_AB, abi.encodePacked(makeAddr("impostor")), held);
    }

    function test_wrongInboundChannel_reverts() public {
        bytes memory held = RouteCodec.encodeEnvelope(_env(false));
        vm.expectRevert(ClprRouter.UnexpectedSender.selector);
        svc.deliver(router, CH_BD, abi.encodePacked(routerA), held);
    }

    function test_previousLedgerMislabelled_reverts() public {
        RouteTypes.Envelope memory e = _env(false);
        e.hops[0].ledgerId = ID_D; // channel AB's peer is A, not D
        bytes memory held = RouteCodec.encodeEnvelope(e);
        vm.expectRevert(ClprRouter.UnexpectedSender.selector);
        svc.deliver(router, CH_AB, abi.encodePacked(routerA), held);
    }

    function test_notAddressedToThisRouter_reverts() public {
        RouteTypes.Envelope memory e = _env(false);
        e.hops[1].router = abi.encodePacked(makeAddr("other-router-on-B"));
        bytes memory held = RouteCodec.encodeEnvelope(e);
        vm.expectRevert(ClprRouter.NotForThisHop.selector);
        svc.deliver(router, CH_AB, abi.encodePacked(routerA), held);
    }

    function test_hopIndexZero_reverts() public {
        RouteTypes.Envelope memory e = _env(false);
        e.hopIndex = 0;
        bytes memory held = RouteCodec.encodeEnvelope(e);
        vm.expectRevert(ClprRouter.NotForThisHop.selector);
        svc.deliver(router, CH_AB, abi.encodePacked(routerA), held);
    }

    function test_wrongRouterVersion_reverts() public {
        RouteTypes.Envelope memory e = _env(false);
        e.routerVersion = 2;
        bytes memory held = RouteCodec.encodeEnvelope(e);
        vm.expectRevert(ClprRouter.WrongVersion.selector);
        svc.deliver(router, CH_AB, abi.encodePacked(routerA), held);
    }

    function test_loopInEnvelope_reverts() public {
        RouteTypes.Envelope memory e = _env(false);
        e.hops[2].ledgerId = ID_A; // A → B → A
        bytes memory held = RouteCodec.encodeEnvelope(e);
        vm.expectRevert(abi.encodeWithSelector(RouteLogic.InvalidRoute.selector, RouteTypes.Reason.BAD_ROUTE));
        svc.deliver(router, CH_AB, abi.encodePacked(routerA), held);
    }

    function test_tooManyHopsInEnvelope_reverts() public {
        RouteTypes.Envelope memory e = _env(false);
        e.constraints.maxHops = 1;
        bytes memory held = RouteCodec.encodeEnvelope(e);
        vm.expectRevert(abi.encodeWithSelector(RouteLogic.InvalidRoute.selector, RouteTypes.Reason.BAD_ROUTE));
        svc.deliver(router, CH_AB, abi.encodePacked(routerA), held);
    }

    function test_missingDeadline_reverts() public {
        RouteTypes.Envelope memory e = _env(false);
        e.constraints.deadline = 0;
        bytes memory held = RouteCodec.encodeEnvelope(e);
        vm.expectRevert(abi.encodeWithSelector(ClprRouter.InvalidRoute.selector, RouteTypes.Reason.DEADLINE));
        svc.deliver(router, CH_AB, abi.encodePacked(routerA), held);
    }

    function test_malformedEnvelope_reverts() public {
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        svc.deliver(router, CH_AB, abi.encodePacked(routerA), hex"0aff");
    }

    // ── helpers ────────────────────────────────────────────────────────────

    /// @dev Alternate tail B → D → C.
    function _tailViaD() internal returns (RouteTypes.Hop[] memory t) {
        t = new RouteTypes.Hop[](3);
        t[0] = RouteTypes.Hop(ID_B, abi.encodePacked(address(router)), CH_BD, CONN, 0, "");
        t[1] = RouteTypes.Hop(ID_D, abi.encodePacked(routerD), keccak256("DC"), CONN, 0, "");
        t[2] = RouteTypes.Hop(ID_C, abi.encodePacked(routerC), bytes32(0), bytes32(0), 0, "");
    }
}
