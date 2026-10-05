// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprRouter} from "@clprouter/ClprRouter.sol";
import {IClprRouter} from "@clprouter/interfaces/IClprRouter.sol";
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
import {RouterDeploy} from "../helpers/RouterDeploy.sol";

/// @notice One intermediate hop (ledger B) in isolation, on a CLPR Service that lets `sendMessage` run inside
///         delivery. Covers the direct forward path, CLPR-level rejections, strict vs loose routing, receipts
///         in transit, and every inbound validation rule.
contract RouterHopTest is Committee, RouterDeploy {
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
    address internal routerA;
    address internal routerC;
    address internal routerD;

    function setUp() public {
        vm.warp(1_800_000_000);
        _initCommittee();
        svc = new MockRouteService(ID_B);
        svc.setPeer(CH_AB, ID_A);
        svc.setPeer(CH_BC, ID_C);
        svc.setPeer(CH_BD, ID_D);
        reg = _deployRegistry();
        _approveBoth(reg, CH_AB, ID_A, ID_B, address(svc));
        _approveBoth(reg, CH_BC, ID_B, ID_C, address(svc));
        _approveBoth(reg, CH_BD, ID_B, ID_D, address(svc));
        vm.warp(block.timestamp + CERT_NOTICE);
        QuarantineVault vault = new QuarantineVault(IProviderRegistry(address(reg)), 3 days, 7 days);
        _initRouterDeployer();
        routerA = _routerAddr(ID_A);
        routerC = _routerAddr(ID_C);
        routerD = _routerAddr(ID_D);
        router = _deployRouter(
            IClprService(address(svc)),
            IProviderRegistry(address(reg)),
            IQuarantineVault(address(vault)),
            ID_B,
            1 hours,
            300_000,
            200_000
        );
    }

    /// @dev Enough gas for forward() to reach the send, too little for MIN_SEND_GAS (200k) to be left there.
    uint256 internal constant MIN_SEND_PROBE = 330_000;

    // ── envelope builders ──────────────────────────────────────────────────

    /// @dev Hop-state key of a route from A's Router.
    function _k(bytes16 id) internal view returns (bytes32) {
        return _key(ID_A, routerA, id);
    }

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
        e.constraints.remainingFeeBudget = loose ? 0 : 20; // loose routes carry no value
        if (loose) e.hops[1].fee = 0;
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
        assertEq(uint8(router.hopState(_k(out.routeId))), uint8(IClprRouter.HopState.FORWARDED));
    }

    function test_successResponse_closesHop() public {
        (bytes memory held,) = _deliver(_env(false));
        bytes16 id = _env(false).routeId;
        assertEq(router.pendingHash(_k(id)), keccak256(held));
        svc.respond(router, CH_BC, svc.lastId(), 0);
        assertEq(uint8(router.hopState(_k(id))), uint8(IClprRouter.HopState.DONE));
        assertEq(router.pendingHash(_k(id)), bytes32(0));
    }

    function test_unknownResponse_isIgnored() public {
        svc.respond(router, CH_BC, 99, 1);
    }

    function test_guardedService_defersAndAnyoneCompletes() public {
        svc.setGuard(true);
        (bytes memory held,) = _deliver(_env(false));
        assertEq(svc.sentCount(), 0);
        bytes16 id = _env(false).routeId;
        assertEq(uint8(router.hopState(_k(id))), uint8(IClprRouter.HopState.FORWARD_PENDING));
        vm.prank(makeAddr("anyone"));
        router.forward(held, new RouteTypes.Hop[](0));
        assertEq(svc.sentCount(), 1);
        assertEq(uint8(router.hopState(_k(id))), uint8(IClprRouter.HopState.FORWARDED));
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
        assertEq(uint8(router.hopState(_k(id))), uint8(IClprRouter.HopState.NACKED));

        vm.expectRevert(IClprRouter.LooseRoutingRequired.selector);
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

    /// @dev A NACK from a CLPR Response names the route, hop and envelope hash; the envelope itself is in the
    ///      earlier RouteForwarded, and forward() with it sends the FAILED receipt that refunds the origin.
    function test_nack_eventCarriesEnoughToCompleteTheRefund() public {
        vm.recordLogs();
        (bytes memory held,) = _deliver(_env(false));
        bytes16 id = _env(false).routeId;
        bytes memory fromEvent;
        bytes32 hashFromEvent;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == IClprRouter.RouteForwarded.selector) {
                (,,, hashFromEvent, fromEvent) = abi.decode(logs[i].data, (uint32, bytes32, uint64, bytes32, bytes));
            }
        }
        assertEq(fromEvent, held, "RouteForwarded carries the held envelope");
        assertEq(hashFromEvent, keccak256(held));

        vm.expectEmit(true, false, false, true, address(router));
        emit IClprRouter.ForwardRejected(id, 1, keccak256(held), 3, RouteTypes.Reason.NEXT_HOP_ERROR, "");
        svc.respond(router, CH_BC, svc.lastId(), 3);
        (, uint32 hopIdx,,) = router.outbound(keccak256(abi.encodePacked(CH_BC, svc.lastId())));
        assertEq(hopIdx, 0, "outbound entry cleared");

        vm.prank(makeAddr("services"));
        router.forward(fromEvent, new RouteTypes.Hop[](0));
        RouteTypes.Receipt memory r = _sentReceipt(1);
        assertEq(uint8(r.status), uint8(RouteTypes.ReceiptStatus.FAILED));
        assertEq(uint8(r.reason), uint8(RouteTypes.Reason.NEXT_HOP_ERROR));
        assertEq(svc.sent(1).target, abi.encodePacked(routerA), "receipt goes to the origin Router");
    }

    function test_sendFailure_loose_eventCarriesEnvelope() public {
        svc.setFailChannel(CH_BC, true);
        RouteTypes.Envelope memory e = _env(true);
        bytes memory held = RouteCodec.encodeEnvelope(e);
        vm.expectEmit(true, false, false, true, address(router));
        emit IClprRouter.ForwardRejected(e.routeId, 1, keccak256(held), 0, RouteTypes.Reason.SEND_FAILED, held);
        svc.deliver(router, CH_AB, abi.encodePacked(routerA), held);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Gas griefing: an under-funded forward() cannot fail a hop for good
    // ═════════════════════════════════════════════════════════════════════

    function _pendingHop() internal returns (bytes memory held, bytes16 id) {
        svc.setGuard(true);
        (held,) = _deliver(_env(false));
        svc.setGuard(false);
        id = _env(false).routeId;
        assertEq(uint8(router.hopState(_k(id))), uint8(IClprRouter.HopState.FORWARD_PENDING));
    }

    function test_forward_belowMinSendGas_revertsAndKeepsHopPending() public {
        (bytes memory held, bytes16 id) = _pendingHop();
        vm.expectRevert(IClprRouter.InsufficientGas.selector);
        router.forward{gas: MIN_SEND_PROBE}(held, new RouteTypes.Hop[](0));
        assertEq(uint8(router.hopState(_k(id))), uint8(IClprRouter.HopState.FORWARD_PENDING));
        assertEq(router.pendingHash(_k(id)), keccak256(held));
        assertEq(svc.sentCount(), 0);

        router.forward(held, new RouteTypes.Hop[](0));
        assertEq(uint8(router.hopState(_k(id))), uint8(IClprRouter.HopState.FORWARDED));
        assertEq(svc.sent(0).channelId, CH_BC);
    }

    /// @dev Enough gas for the pre-check, but sendMessage runs out of gas (63/64 rule): before the fix the catch
    ///      turned this into a permanent SEND_FAILED; now the whole call reverts.
    function test_forward_outOfGasInsideSend_revertsAndKeepsHopPending() public {
        (bytes memory held, bytes16 id) = _pendingHop();
        svc.setBurn(type(uint256).max);
        vm.expectRevert(IClprRouter.InsufficientGas.selector);
        router.forward{gas: 1_000_000}(held, new RouteTypes.Hop[](0));
        assertEq(uint8(router.hopState(_k(id))), uint8(IClprRouter.HopState.FORWARD_PENDING));
        assertEq(svc.sentCount(), 0);

        svc.setBurn(0);
        router.forward{gas: 1_000_000}(held, new RouteTypes.Hop[](0));
        assertEq(uint8(router.hopState(_k(id))), uint8(IClprRouter.HopState.FORWARDED));
    }

    /// @dev Inside CLPR delivery an out-of-gas send defers the hop instead of failing it.
    function test_delivery_outOfGasInsideSend_defers() public {
        svc.setBurn(type(uint256).max);
        (bytes memory held, bytes memory resp) = _deliver(_env(false));
        assertEq(resp, abi.encodePacked(uint8(1), uint8(0)), "accepted, not rejected");
        bytes16 id = _env(false).routeId;
        assertEq(uint8(router.hopState(_k(id))), uint8(IClprRouter.HopState.FORWARD_PENDING));
        svc.setBurn(0);
        router.forward(held, new RouteTypes.Hop[](0));
        assertEq(uint8(router.hopState(_k(id))), uint8(IClprRouter.HopState.FORWARDED));
    }

    /// @dev A definite revert from the Service still fails the hop (strict) with a receipt.
    function test_definiteServiceRevert_stillFailsTheHop() public {
        (bytes memory held, bytes16 id) = _pendingHop();
        svc.setFailChannel(CH_BC, true);
        router.forward{gas: 1_000_000}(held, new RouteTypes.Hop[](0));
        assertEq(uint8(router.hopState(_k(id))), uint8(IClprRouter.HopState.DONE));
        assertEq(uint8(_sentReceipt(0).reason), uint8(RouteTypes.Reason.SEND_FAILED));
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
        assertEq(uint8(router.hopState(_k(_env(true).routeId))), uint8(IClprRouter.HopState.NACKED));
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
        _apply(reg, A_TRUST_TIER, _trustPayload(CH_BC, ID_C, 1, address(svc)));
        vm.warp(block.timestamp + CERT_NOTICE);
        RouteTypes.Envelope memory e = _env(false);
        e.constraints.deadline = uint64(block.timestamp + 1 hours);
        e.constraints.trustFloor = 2;
        (, bytes memory resp) = _deliver(e);
        assertEq(resp, abi.encodePacked(uint8(2), uint8(RouteTypes.Reason.TRUST_FLOOR)));
        assertEq(svc.sentCount(), 1, "only the receipt");
        assertEq(uint8(_sentReceipt(0).reason), uint8(RouteTypes.Reason.TRUST_FLOOR));
    }

    function test_trustFloor_nextEdgeAtLowestTier_failsClosed() public {
        RouteTypes.Envelope memory e = _env(false);
        e.constraints.trustFloor = 1;
        _deliver(e);
        assertEq(uint8(_sentReceipt(0).reason), uint8(RouteTypes.Reason.TRUST_FLOOR));
    }

    function test_trustFloor_nextEdgeAtFloor_forwards() public {
        _apply(reg, A_TRUST_TIER, _trustPayload(CH_BC, ID_C, 2, address(svc)));
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
        emit IClprRouter.RouteStopped(e.routeId, 1, RouteTypes.ReceiptStatus.FAILED, RouteTypes.Reason.DISABLED_INBOUND);
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
        r.routeEdge = RouteLogic.edgeDigest(_hops()[2]);
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
        assertEq(uint8(router.hopState(_key(ID_C, routerC, re.routeId))), uint8(IClprRouter.HopState.DONE));
    }

    /// @dev Receipts are never dropped (I-01): over a disabled next edge the receipt is queued, flush() refuses
    ///      while the edge is disabled, and sends it once the disable lapses.
    function test_receiptOverDisabledEdge_isQueuedNotDropped() public {
        _apply(reg, A_DISABLE, _disablePayload(1, Caip.edgeKey(CH_AB, ID_A)));
        RouteTypes.Envelope memory re = _receiptAtB();
        RouteTypes.Envelope memory next = _receiptAtB();
        next.hopIndex = 2;
        bytes memory out = RouteCodec.encodeEnvelope(next);
        bytes32 k = keccak256(abi.encode(CH_AB, abi.encodePacked(routerA), out));
        vm.recordLogs();
        svc.deliver(router, CH_BC, abi.encodePacked(routerC), RouteCodec.encodeEnvelope(re));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (,,, bytes memory queued) = abi.decode(logs[logs.length - 1].data, (bytes32, bytes32, bytes, bytes));
        assertEq(logs[logs.length - 1].topics[0], IClprRouter.OutboxQueued.selector);
        assertEq(queued, out);
        assertEq(svc.sentCount(), 0);
        assertTrue(router.outbox(k));

        vm.expectRevert(abi.encodeWithSelector(IClprRouter.RouteBlocked.selector, 1, RouteTypes.Reason.DISABLED_EDGE));
        router.flush(CH_AB, CONN, abi.encodePacked(routerA), out);
        vm.warp(block.timestamp + DISABLE_LAPSE + 1);
        router.flush(CH_AB, CONN, abi.encodePacked(routerA), out);
        assertEq(svc.sentCount(), 1);
        assertFalse(router.outbox(k));
    }

    /// @dev A CLPR rejection of a receipt message puts it back in the outbox (never fire-and-forget).
    function test_receiptRejectedByClpr_isRequeued() public {
        RouteTypes.Envelope memory re = _receiptAtB();
        svc.deliver(router, CH_BC, abi.encodePacked(routerC), RouteCodec.encodeEnvelope(re));
        MockRouteService.Sent memory s = svc.sent(0);
        bytes32 k = keccak256(abi.encode(s.channelId, s.target, s.data));
        assertFalse(router.outbox(k));
        vm.expectEmit(true, false, false, true, address(router));
        emit IClprRouter.ReceiptRequeued(k, 1);
        svc.respond(router, CH_AB, svc.lastId(), 1);
        assertTrue(router.outbox(k));
        router.flush(s.channelId, s.connectorId, s.target, s.data);
        assertEq(svc.sentCount(), 2);
        assertEq(svc.sent(1).data, s.data);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Inbound validation (reverts → CLPR APPLICATION_ERROR to the previous hop)
    // ═════════════════════════════════════════════════════════════════════

    function test_replay_reverts() public {
        _deliver(_env(false));
        bytes memory held = RouteCodec.encodeEnvelope(_env(false));
        vm.expectRevert(IClprRouter.RouteReplayed.selector);
        svc.deliver(router, CH_AB, abi.encodePacked(routerA), held);
    }

    function test_wrongSenderRouter_reverts() public {
        bytes memory held = RouteCodec.encodeEnvelope(_env(false));
        vm.expectRevert(IClprRouter.UnexpectedSender.selector);
        svc.deliver(router, CH_AB, abi.encodePacked(makeAddr("impostor")), held);
    }

    function test_wrongInboundChannel_reverts() public {
        bytes memory held = RouteCodec.encodeEnvelope(_env(false));
        vm.expectRevert(IClprRouter.UnexpectedSender.selector);
        svc.deliver(router, CH_BD, abi.encodePacked(routerA), held);
    }

    function test_previousLedgerMislabelled_reverts() public {
        RouteTypes.Envelope memory e = _env(false);
        e.hops[0].ledgerId = ID_D; // channel AB's peer is A, not D
        e.hops[0].router = abi.encodePacked(routerD);
        bytes memory held = RouteCodec.encodeEnvelope(e);
        vm.expectRevert(IClprRouter.UnexpectedSender.selector);
        svc.deliver(router, CH_AB, abi.encodePacked(routerD), held);
    }

    function test_notAddressedToThisRouter_reverts() public {
        RouteTypes.Envelope memory e = _env(false);
        e.hops[1].router = abi.encodePacked(makeAddr("other-router-on-B"));
        bytes memory held = RouteCodec.encodeEnvelope(e);
        vm.expectRevert(abi.encodeWithSelector(RouteLogic.NonCanonicalRouter.selector, ID_B));
        svc.deliver(router, CH_AB, abi.encodePacked(routerA), held);
        e.hops[1] = RouteTypes.Hop(ID_D, abi.encodePacked(routerD), CH_BC, CONN, 20, ""); // canonical, but for D
        held = RouteCodec.encodeEnvelope(e);
        vm.expectRevert(IClprRouter.NotForThisHop.selector);
        svc.deliver(router, CH_AB, abi.encodePacked(routerA), held);
    }

    function test_hopIndexZero_reverts() public {
        RouteTypes.Envelope memory e = _env(false);
        e.hopIndex = 0;
        bytes memory held = RouteCodec.encodeEnvelope(e);
        vm.expectRevert(IClprRouter.NotForThisHop.selector);
        svc.deliver(router, CH_AB, abi.encodePacked(routerA), held);
    }

    function test_wrongRouterVersion_reverts() public {
        RouteTypes.Envelope memory e = _env(false);
        e.routerVersion = 2;
        bytes memory held = RouteCodec.encodeEnvelope(e);
        vm.expectRevert(IClprRouter.WrongVersion.selector);
        svc.deliver(router, CH_AB, abi.encodePacked(routerA), held);
    }

    function test_loopInEnvelope_reverts() public {
        RouteTypes.Envelope memory e = _env(false);
        e.hops[2].ledgerId = ID_A; // A → B → A
        e.hops[2].router = abi.encodePacked(routerA);
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
        vm.expectRevert(abi.encodeWithSelector(IClprRouter.InvalidRoute.selector, RouteTypes.Reason.DEADLINE));
        svc.deliver(router, CH_AB, abi.encodePacked(routerA), held);
    }

    function test_looseEnvelopeWithFeeBudget_reverts() public {
        RouteTypes.Envelope memory e = _env(true);
        e.constraints.remainingFeeBudget = 1;
        bytes memory held = RouteCodec.encodeEnvelope(e);
        vm.expectRevert(abi.encodeWithSelector(RouteLogic.InvalidRoute.selector, RouteTypes.Reason.FEE_BUDGET));
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
