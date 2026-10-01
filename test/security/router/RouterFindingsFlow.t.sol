// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprProtobuf} from "@hiero-ledger/clpr/libraries/codec/ClprProtobuf.sol";
import {ClprRouter} from "@clprouter/ClprRouter.sol";
import {IClprRouter} from "@clprouter/interfaces/IClprRouter.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {RouteCodec} from "@clprouter/libraries/RouteCodec.sol";
import {RouteLogic} from "@clprouter/libraries/RouteLogic.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {ThreeLedgerFixture} from "../../helpers/ThreeLedgerFixture.sol";
import {ClprMessenger, FakeRouter} from "./RouterAuditBase.sol";

/// @notice Router findings replayed on three ledgers running the unchanged reference ClprService
///         (docs/audit/router-findings.md). Regression tests: each `test_<ID>_...` runs the original exploit and
///         asserts the secure behaviour of the fixed Router.
contract RouterFindingsFlowTest is ThreeLedgerFixture {
    // ── helpers ────────────────────────────────────────────────────────────

    /// @dev Receipt id of route `routeId` (sent from A's Router) reported by hop `hop`.
    function _receiptId(bytes16 routeId, uint256 hop) internal view returns (bytes16) {
        return bytes16(
            keccak256(
                abi.encode(
                    keccak256("clprouter.v1.receipt"),
                    keccak256(bytes(ID_A)),
                    keccak256(abi.encodePacked(address(A.router))),
                    routeId,
                    hop
                )
            )
        );
    }

    /// @dev A receipt envelope as a third party on ledger C would hand it to B's Router over chBC, naming
    ///      `reporter` (ledger C or B) as the receipt's origin.
    function _forgedReceiptEnvelope(
        address forger,
        string memory reporterLedger,
        address reporter,
        RouteTypes.Receipt memory r
    ) internal view returns (bytes memory) {
        RouteTypes.Envelope memory re;
        re.routeId = bytes16(keccak256(abi.encode("forged", r.routeId, r.status)));
        re.origin = RouteTypes.Endpoint(reporterLedger, abi.encodePacked(reporter));
        re.destination = RouteTypes.Endpoint(ID_A, abi.encodePacked(alice));
        re.hops = new RouteTypes.Hop[](3);
        re.hops[0] = _hop(C, chBC, connBC, 0, address(0));
        re.hops[0].router = abi.encodePacked(forger);
        re.hops[1] = _hop(B, chAB, connAB, 0, address(0));
        re.hops[2] = _hop(A, bytes32(0), bytes32(0), 0, address(0));
        re.hopIndex = 1;
        re.payloadType = RouteTypes.PayloadType.RECEIPT;
        re.routerVersion = 1;
        re.payload = RouteCodec.encodeReceipt(r);
        return RouteCodec.encodeEnvelope(re);
    }

    // ═════════════════════════════════════════════════════════════════════
    // H-01  Receipt-id squatting at the origin: delivered, then refunded
    // ═════════════════════════════════════════════════════════════════════

    /// @dev The exploit registered the (predictable) receipt id as a route id of the sender's own on the origin
    ///      Router, so the honest DELIVERED receipt was refused as a replay and the sender reclaimed the escrow.
    ///      Fixed: `send` takes no route id (ids are derived from ledger, Router, sender and nonce), receipt ids
    ///      live under their own domain tag, and replay keys include the envelope's origin (hops[0]).
    function test_H01_receiptIdSquatting_payeeIsPaidAfterDelivery() public {
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);
        bytes16 receiptId = _receiptId(id, 2); // DELIVERED receipt is reported by hop 2 (the destination)

        // The sender's next route id is fixed by its nonce and cannot be the receipt id.
        IClprRouter.SendRequest memory again = _request(0);
        again.payload = "squat attempt";
        bytes16 next = _sendAs(alice, again, 0.03 ether);
        assertTrue(next != receiptId);

        _settle();
        (bytes16 deliveredId,,,,,) = C.app.delivered(0);
        assertEq(deliveredId, id, "destination application acted on the route");
        // The receipt is keyed under its reporter (C's Router), never under A's own routes.
        assertEq(uint8(A.router.hopState(_key(ID_C, address(C.router), receiptId))), uint8(IClprRouter.HopState.DONE));

        vm.warp(block.timestamp + 1 hours + 3 * RECLAIM_GRACE + 1);
        vm.expectRevert(IClprRouter.NotReclaimable.selector);
        A.router.reclaim(id);
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.DELIVERED), "H-01: DELIVERED receipt lost");
        assertEq(payee.balance, 1 ether, "H-01: payee not paid although the message was delivered");
    }

    // ═════════════════════════════════════════════════════════════════════
    // H-02  Receipt forgery on strict routes with an explicit receipt_path
    // ═════════════════════════════════════════════════════════════════════

    /// @dev With `routePrefix` set, RouteLogic.checkReceipt takes the reporter identity from the receipt
    ///      envelope's own `origin` field, which the sender of the envelope chooses freely, and never compares
    ///      the path the receipt travelled with the route's receipt_path. Any application on any ledger
    ///      peered with the first-hop ledger B can therefore inject a receipt into B's Router (B only checks
    ///      the immediately previous hop) that A accepts. Here: QUARANTINED before the route has even left A,
    ///      sending the sender's unused fee budget to the quarantine vault under a made-up case id.
    function test_H02_explicitReceiptPath_thirdPartyCannotForgeReceipt() public {
        IClprRouter.SendRequest memory req = _request(0);
        req.hops[0].fee = 0; // routes with an explicit receipt path carry no value any more
        req.hops[1].fee = 0;
        req.receiptPath = RouteLogic.reversePrefix(req.hops, 2);
        bytes16 id = _sendAs(alice, req, 0);

        ClprMessenger mallory = new ClprMessenger(); // any contract on ledger C
        RouteTypes.Hop[] memory hops = req.hops;
        hops[0].router = abi.encodePacked(address(A.router));
        RouteTypes.Receipt memory r;
        r.routeId = id;
        r.status = RouteTypes.ReceiptStatus.QUARANTINED;
        r.hopIndex = 1;
        r.ledgerId = ID_B;
        r.reason = RouteTypes.Reason.BLACKLIST;
        r.caseId = keccak256("made-up case");
        r.contact = "mailto:mallory@example";
        r.routePrefix = new RouteTypes.Hop[](1);
        r.routePrefix[0] = hops[0];
        r.routeEdge = RouteLogic.edgeDigest(hops[1]);
        r.routeRest = RouteLogic.hopsCommitment(hops, 2);
        bytes memory forged = _forgedReceiptEnvelope(address(mallory), ID_B, address(B.router), r);
        mallory.send(IClprService(address(C.service)), chBC, connBC, abi.encodePacked(address(B.router)), forged);

        // B's Router refuses it: the receipt's first hop names a non-canonical Router (CLPR APPLICATION_ERROR).
        (, Vm.Log[] memory logs) = _relayWithLogs(C, B, chBC);
        assertEq(_count(logs, IClprRouter.RouteForwarded.selector) + _count(logs, IClprRouter.OutboxQueued.selector), 0);
        _relay(B, A, chAB);

        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.PENDING), "H-02: forged receipt settled");
        assertEq(address(A.vault).balance, 0, "H-02: fee budget moved to the vault by a forged receipt");
    }

    /// @dev Same root cause, DELIVERED variant: a forged "delivered" with an attacker-chosen response hash
    ///      settles the route before the destination ever sees the message.
    function test_H02b_explicitReceiptPath_forgedDeliveredBeforeDelivery() public {
        IClprRouter.SendRequest memory req = _request(0);
        req.hops[0].fee = 0; // routes with an explicit receipt path carry no value any more
        req.hops[1].fee = 0;
        req.receiptPath = RouteLogic.reversePrefix(req.hops, 2);
        bytes16 id = _sendAs(alice, req, 0);

        ClprMessenger mallory = new ClprMessenger();
        RouteTypes.Hop[] memory hops = req.hops;
        RouteTypes.Receipt memory r;
        r.routeId = id;
        r.status = RouteTypes.ReceiptStatus.DELIVERED;
        r.hopIndex = 2;
        r.ledgerId = ID_C;
        r.responseHash = keccak256("whatever mallory wants");
        r.routePrefix = new RouteTypes.Hop[](2);
        r.routePrefix[0] = hops[0];
        r.routePrefix[1] = hops[1];
        r.routeEdge = RouteLogic.edgeDigest(hops[2]);
        bytes memory forged = _forgedReceiptEnvelope(address(mallory), ID_C, address(C.router), r);
        mallory.send(IClprService(address(C.service)), chBC, connBC, abi.encodePacked(address(B.router)), forged);

        _relay(C, B, chBC);
        _relay(B, A, chAB);

        assertEq(C.app.deliveredCount(), 0);
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.PENDING), "H-02: forged DELIVERED settled");
    }

    function _count(Vm.Log[] memory logs, bytes32 topic) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) n++;
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // M-01  Route-id squatting on a downstream ledger
    // ═════════════════════════════════════════════════════════════════════

    /// @dev Route ids are global but each Router's replay set also holds ids of routes it originated. Anyone
    ///      on B who sees a route id (RouteSent on A, or a caller-chosen UETR) sends a route of their own from
    ///      B with that id before the bundle is relayed; the real route is then rejected at B as a replay.
    function test_M01_routeIdSquattingDownstream_cannotCensorRoute() public {
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);

        address mallory = makeAddr("mallory");
        vm.deal(mallory, 1 ether);
        IClprRouter.SendRequest memory squat;
        squat.destination = RouteTypes.Endpoint(C.id, abi.encodePacked(address(C.app)));
        squat.recipient = Caip.account(C.id, address(C.app));
        squat.hops = new RouteTypes.Hop[](2);
        squat.hops[0] = _hop(B, chBC, connBC, 0, address(0));
        squat.hops[1] = _hop(C, bytes32(0), bytes32(0), 0, address(0));
        squat.constraints.deadline = uint64(block.timestamp + 1 hours);
        // There is no route id to choose any more; mallory's route gets an id derived on B, and B keys the real
        // route by its origin (A's Router), so the two can never collide.
        vm.prank(mallory);
        bytes16 own = B.router.send(squat);
        assertTrue(own != id);

        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.DELIVERED), "M-01: route censored by squatter");
        assertEq(uint8(B.router.hopState(_hk(id))), uint8(IClprRouter.HopState.DONE));
    }

    // ═════════════════════════════════════════════════════════════════════
    // M-03  Loose routes: third parties cannot forge receipts or hijack re-routing
    // ═════════════════════════════════════════════════════════════════════

    /// @dev The exploit: any application on C hands B's Router a receipt for a loose route naming itself as the
    ///      reporter; B relayed it and A settled the route with the attacker's status. Fixed: every Router of an
    ///      envelope must be canonical, so B refuses it; the route settles only on its genuine receipt.
    function test_M03_looseRoute_thirdPartyCannotForgeStatus() public {
        IClprRouter.SendRequest memory req = _request(0);
        req.constraints.loose = true;
        req.hops[0].fee = 0;
        req.hops[1].fee = 0;
        vm.prank(address(A.app));
        bytes16 id = A.router.send(req);

        ClprMessenger mallory = new ClprMessenger();
        RouteTypes.Receipt memory r;
        r.routeId = id;
        r.status = RouteTypes.ReceiptStatus.QUARANTINED;
        r.hopIndex = 2;
        r.caseId = keccak256("made-up case");
        bytes memory forged = _forgedReceiptEnvelope(address(mallory), ID_C, address(mallory), r);
        mallory.send(IClprService(address(C.service)), chBC, connBC, abi.encodePacked(address(B.router)), forged);
        _relay(C, B, chBC);
        _relay(B, A, chAB);
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.PENDING), "M-03: forged status settled");
        assertEq(A.app.receiptCount(), 0);

        _settle(); // the genuine route and receipt
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.DELIVERED));
        (, uint8 st,,,) = A.app.receipts(0);
        assertEq(st, uint8(IClprRouter.RouteStatus.DELIVERED));
    }

    /// @dev Loose re-routing may only choose canonical Routers for the new tail.
    function test_M03b_looseReroute_tailMustBeCanonical() public {
        RouteTypes.Hop[] memory tail = new RouteTypes.Hop[](2);
        tail[0] = _hop(B, chBC, connBC, 0, address(0));
        tail[1] = _hop(C, bytes32(0), bytes32(0), 0, address(0));
        tail[1].router = abi.encodePacked(makeAddr("front-runner-router"));
        RouteTypes.Envelope memory e;
        e.hops = new RouteTypes.Hop[](2);
        e.hops[0] = _hop(A, chAB, connAB, 0, address(0));
        e.hops[1] = tail[0];
        e.hopIndex = 1;
        e.destination = RouteTypes.Endpoint(ID_C, abi.encodePacked(address(C.app)));
        vm.expectRevert(abi.encodeWithSelector(RouteLogic.NonCanonicalRouter.selector, ID_C));
        this.spliceExt(e, tail);
    }

    function spliceExt(RouteTypes.Envelope memory e, RouteTypes.Hop[] memory tail)
        external
        view
        returns (RouteTypes.Envelope memory)
    {
        return RouteLogic.splice(
            e,
            tail,
            keccak256(bytes(ID_B)),
            keccak256(abi.encodePacked(address(B.router))),
            RouteLogic.Canon(address(routerDeployer), routerDeployer.DEPLOYMENT_SALT(), routerDeployer.INIT_CODE_HASH())
        );
    }

    // ═════════════════════════════════════════════════════════════════════
    // M-04  Sender-chosen intermediate Router decides the settlement
    // ═════════════════════════════════════════════════════════════════════

    /// @dev The exploit named a sender-controlled contract as hop 1: it forwarded honestly and reported FAILED,
    ///      refunding the sender after delivery. Fixed: (1) `send` refuses a non-canonical Router; (2) a fake
    ///      "Router" holding a copy of a real envelope can neither forward it (C refuses a non-canonical previous
    ///      hop) nor report on it (A refuses it as the receipt's sender).
    function test_M04_fakeIntermediateRouter_cannotDecideSettlement() public {
        FakeRouter fake = new FakeRouter(IClprService(address(B.service)), ID_B);
        IClprRouter.SendRequest memory req = _request(1 ether);
        req.hops[1].router = abi.encodePacked(address(fake));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RouteLogic.NonCanonicalRouter.selector, ID_B));
        A.router.send{value: 1.1 ether}(req);

        // An honest route; the fake gets a copy of the envelope B received and plays a Router with it.
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);
        fake.setHeld(
            ClprProtobuf.decodeDataMessage(
                A.service.getMessage(chAB, A.service.getChannel(chAB).nextMessageId - 1).payload
            )
            .messageData
        );
        fake.pump(); // forwards a copy to C and sends a FAILED receipt to A, both from the fake
        _settle();

        assertEq(C.app.deliveredCount(), 1, "delivered once, by the genuine route");
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.DELIVERED));
        assertEq(payee.balance, 1 ether, "payee paid");
    }

    // ═════════════════════════════════════════════════════════════════════
    // L-01  A disable at the origin drops a DELIVERED receipt for good
    // ═════════════════════════════════════════════════════════════════════

    /// @dev Receipts arriving over a disabled inbound edge / ledger / Router were dropped. Fixed: the origin
    ///      holds the receipt (blocking reclaim of its route) and anyone settles it with forward() once the
    ///      disable lapses.
    function test_L01_disabledInboundAtOrigin_receiptIsHeldNotDropped() public {
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);
        _relay(A, B, chAB);
        _relay(B, C, chBC);
        _relay(C, B, chBC); // DELIVERED receipt now on its way B -> A
        assertEq(C.app.deliveredCount(), 1);

        _apply(A.registry, A_DISABLE, _disablePayload(2, Caip.ledgerKey(ID_B)));
        (, Vm.Log[] memory logs) = _relayWithLogs(B, A, chAB);
        bytes memory held;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == IClprRouter.ForwardPending.selector) {
                (, held) = abi.decode(logs[i].data, (uint32, bytes));
            }
        }
        assertGt(held.length, 0, "receipt held");
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.PENDING));

        // While held, the route cannot be reclaimed, and forward() keeps it held.
        vm.warp(block.timestamp + 1 hours + 2 * RECLAIM_GRACE + 1);
        vm.expectRevert(IClprRouter.NotReclaimable.selector);
        A.router.reclaim(id);
        vm.expectRevert(abi.encodeWithSelector(IClprRouter.ReceiptHeld.selector, RouteTypes.Reason.DISABLED_INBOUND));
        A.router.forward(held, new RouteTypes.Hop[](0));

        vm.warp(block.timestamp + DISABLE_LAPSE + 1);
        A.router.forward(held, new RouteTypes.Hop[](0));
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.DELIVERED), "L-01: delivered receipt dropped");
        assertEq(payee.balance, 1 ether);
    }
}
