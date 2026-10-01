// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ClprTypes} from "@hiero-ledger/clpr/libraries/ClprTypes.sol";
import {ClprProtobuf} from "@hiero-ledger/clpr/libraries/codec/ClprProtobuf.sol";
import {ClprRouter} from "@clprouter/ClprRouter.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {RouteCodec} from "@clprouter/libraries/RouteCodec.sol";
import {RouteLogic} from "@clprouter/libraries/RouteLogic.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {ThreeLedgerFixture} from "../helpers/ThreeLedgerFixture.sol";

/// @notice End-to-end Router behaviour across three ledgers running the unchanged reference ClprService.
contract RouterFlowTest is ThreeLedgerFixture {
    uint8 internal constant ISO = 1;
    uint8 internal constant MICA = 2;
    uint8 internal constant ENERGY = 3;
    bytes32 internal constant CASE = keccak256("case-2026-001");

    // ═════════════════════════════════════════════════════════════════════
    // Happy paths
    // ═════════════════════════════════════════════════════════════════════

    function test_delivers_A_B_C_andSettlesEscrowAndFees() public {
        uint256 aliceBefore = alice.balance;
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.PENDING));
        assertEq(address(A.router).balance, 1.1 ether);

        _settle();

        assertEq(C.app.deliveredCount(), 1);
        (
            bytes16 rid,
            string memory originLedger,
            bytes memory originApp,
            string memory sender,
            uint8 pt,
            bytes memory p
        ) = C.app.delivered(0);
        assertEq(rid, id);
        assertEq(originLedger, ID_A);
        assertEq(originApp, abi.encodePacked(alice));
        assertEq(sender, Caip.account(ID_A, alice));
        assertEq(pt, uint8(RouteTypes.PayloadType.RAW));
        assertEq(p, bytes("hello from A"));

        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.DELIVERED));
        assertEq(payee.balance, 1 ether, "escrow released to payee");
        assertEq(feeA.balance, 0.01 ether, "hop 0 fee");
        assertEq(feeB.balance, 0.02 ether, "hop 1 fee");
        assertEq(alice.balance, aliceBefore - 1.1 ether + 0.07 ether, "unused budget refunded");
        assertEq(address(A.router).balance, 0);
        assertEq(uint8(B.router.hopState(id)), uint8(ClprRouter.HopState.DONE));
        assertEq(uint8(C.router.hopState(id)), uint8(ClprRouter.HopState.DONE));
    }

    function test_contractSender_getsReceiptCallback() public {
        ClprRouter.SendRequest memory req = _request(0);
        vm.deal(address(A.app), 1 ether);
        vm.prank(address(A.app));
        bytes16 id = A.router.send{value: 0.03 ether}(req);
        _settle();
        assertEq(A.app.receiptCount(), 1);
        (bytes16 rid, uint8 status,,, bytes32 respHash) = A.app.receipts(0);
        assertEq(rid, id);
        assertEq(status, uint8(ClprRouter.RouteStatus.DELIVERED));
        assertEq(respHash, keccak256("ack"));
    }

    /// @dev The reference ClprService guards sendMessage and submitBundle with one reentrancy lock, so the
    ///      intermediate hop cannot forward inside delivery: it records the hop as pending, and a permissionless
    ///      forward() completes it in a second transaction.
    function test_forwardInsideDelivery_isDeferredOnReferenceService() public {
        bytes16 id = _sendAs(alice, _request(0), 0.03 ether);
        bytes memory bundle = _bundle(A, B, chAB);
        vm.recordLogs();
        B.service.submitBundle(chAB, bundle);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory held;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == ClprRouter.ForwardPending.selector) {
                (, held) = abi.decode(logs[i].data, (uint32, bytes));
            }
        }
        assertGt(held.length, 0, "ForwardPending emitted");
        assertEq(uint8(B.router.hopState(id)), uint8(ClprRouter.HopState.FORWARD_PENDING));
        assertEq(B.router.pendingHash(id), keccak256(held));

        // The CLPR Response to A says "accepted".
        ClprTypes.Channel memory chB = B.service.getChannel(chAB);
        ClprTypes.DecodedReply memory reply =
            ClprProtobuf.decodeReplyMessage(B.service.getMessage(chAB, chB.nextMessageId - 1).payload);
        assertEq(uint8(reply.status), uint8(ClprTypes.ReplyStatus.SUCCESS));
        assertEq(reply.messageReplyData, abi.encodePacked(uint8(1), uint8(0)));

        // Anyone completes the hop.
        vm.prank(makeAddr("anyone"));
        B.router.forward(held, new RouteTypes.Hop[](0));
        assertEq(uint8(B.router.hopState(id)), uint8(ClprRouter.HopState.FORWARDED));

        // Cannot be pumped twice, nor with a different envelope.
        vm.expectRevert(ClprRouter.NothingPending.selector);
        B.router.forward(held, new RouteTypes.Hop[](0));

        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.DELIVERED));
    }

    function test_forward_rejectsUnknownEnvelope() public {
        RouteTypes.Envelope memory e;
        e.routeId = bytes16(uint128(1));
        bytes memory env = RouteCodec.encodeEnvelope(e);
        vm.expectRevert(ClprRouter.NothingPending.selector);
        B.router.forward(env, new RouteTypes.Hop[](0));
    }

    function test_flush_rejectsUnknownEntry() public {
        vm.expectRevert(ClprRouter.NothingPending.selector);
        B.router.flush(chAB, connAB, abi.encodePacked(address(A.router)), "x");
    }

    function test_explicitReceiptPath_strictDataRoute() public {
        ClprRouter.SendRequest memory req = _request(0);
        req.receiptPath = RouteLogic.reversePrefix(req.hops, 2);
        bytes16 id = _sendAs(alice, req, 0.03 ether);
        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.DELIVERED));
    }

    function test_iso20022Payload_withUetrRouteId() public {
        _certifyAll(ISO, 0);
        vm.warp(block.timestamp + CERT_NOTICE + 1);
        ClprRouter.SendRequest memory req = _request(0);
        req.routeId = bytes16(0x8a1b2c3d4e5f40718293a4b5c6d7e8f9);
        req.payloadType = RouteTypes.PayloadType.ISO20022;
        req.payload = abi.encodePacked(keccak256("pacs.008 ciphertext"));
        req.constraints.filters = RouteTypes.FILTER_ISO20022;
        req.constraints.deadline = uint64(block.timestamp + 1 hours);
        bytes16 id = _sendAs(alice, req, 0.03 ether);
        assertEq(id, req.routeId);
        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.DELIVERED));
        (,,,, uint8 pt,) = C.app.delivered(0);
        assertEq(pt, uint8(RouteTypes.PayloadType.ISO20022));
    }

    // ═════════════════════════════════════════════════════════════════════
    // Send-time validation (nothing moves)
    // ═════════════════════════════════════════════════════════════════════

    function test_send_revertsOnLoop() public {
        ClprRouter.SendRequest memory req = _request(0);
        req.hops[2] = _hop(A, bytes32(0), bytes32(0), 0, address(0));
        req.destination.ledgerId = ID_A;
        vm.expectRevert(abi.encodeWithSelector(RouteLogic.InvalidRoute.selector, RouteTypes.Reason.BAD_ROUTE));
        _sendAs(alice, req, 0.03 ether);
    }

    function test_send_revertsOnTooManyHops() public {
        ClprRouter.SendRequest memory req = _request(0);
        req.constraints.maxHops = 1;
        vm.expectRevert(abi.encodeWithSelector(RouteLogic.InvalidRoute.selector, RouteTypes.Reason.BAD_ROUTE));
        _sendAs(alice, req, 0.03 ether);
    }

    function test_send_revertsWhenFirstHopIsNotThisRouter() public {
        ClprRouter.SendRequest memory req = _request(0);
        req.hops[0].router = abi.encodePacked(address(B.router));
        vm.expectRevert(abi.encodeWithSelector(RouteLogic.InvalidRoute.selector, RouteTypes.Reason.BAD_ROUTE));
        _sendAs(alice, req, 0.03 ether);
    }

    function test_send_revertsOnPastDeadline() public {
        ClprRouter.SendRequest memory req = _request(0);
        req.constraints.deadline = uint64(block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(RouteLogic.InvalidRoute.selector, RouteTypes.Reason.DEADLINE));
        _sendAs(alice, req, 0.03 ether);
    }

    function test_send_revertsWhenFeesExceedBudget() public {
        vm.expectRevert(abi.encodeWithSelector(RouteLogic.InvalidRoute.selector, RouteTypes.Reason.FEE_BUDGET));
        _sendAs(alice, _request(0), 0.029 ether);
    }

    function test_send_revertsWhenFeesExceedMaxFee() public {
        ClprRouter.SendRequest memory req = _request(0);
        req.constraints.maxFee = 0.02 ether;
        vm.expectRevert(abi.encodeWithSelector(RouteLogic.InvalidRoute.selector, RouteTypes.Reason.FEE_BUDGET));
        _sendAs(alice, req, 1 ether);
    }

    function test_send_revertsWhenValueBelowEscrow() public {
        vm.expectRevert(ClprRouter.InsufficientValue.selector);
        _sendAs(alice, _request(1 ether), 0.5 ether);
    }

    function test_send_valueRoutesMustBeStrict() public {
        ClprRouter.SendRequest memory req = _request(1 ether);
        req.constraints.loose = true;
        vm.expectRevert(ClprRouter.ValueRoutesMustBeStrict.selector);
        _sendAs(alice, req, 1.1 ether);

        req = _request(1 ether);
        req.receiptPath = RouteLogic.reversePrefix(req.hops, 2);
        vm.expectRevert(ClprRouter.ValueRoutesMustBeStrict.selector);
        _sendAs(alice, req, 1.1 ether);

        req = _request(1 ether);
        req.payee = address(0);
        vm.expectRevert(ClprRouter.ValueRoutesMustBeStrict.selector);
        _sendAs(alice, req, 1.1 ether);
    }

    /// @dev Receipts of loose routes cannot be checked against a stored hop list, so loose routes carry no value:
    ///      neither escrow nor a fee budget.
    function test_send_looseRoutesCarryNoValue() public {
        ClprRouter.SendRequest memory req = _request(0);
        req.constraints.loose = true;
        vm.expectRevert(ClprRouter.ValueRoutesMustBeStrict.selector);
        _sendAs(alice, req, 0.03 ether); // fee budget only

        vm.expectRevert(ClprRouter.ValueRoutesMustBeStrict.selector);
        _sendAs(alice, req, 1 wei);

        req = _request(1 ether);
        req.constraints.loose = true;
        req.hops[0].fee = 0;
        req.hops[1].fee = 0;
        vm.expectRevert(ClprRouter.ValueRoutesMustBeStrict.selector);
        _sendAs(alice, req, 1 ether); // escrow only
    }

    function test_looseDataRoute_withoutValue_delivers() public {
        ClprRouter.SendRequest memory req = _request(0);
        req.constraints.loose = true;
        req.hops[0].fee = 0;
        req.hops[1].fee = 0;
        bytes16 id = _sendAs(alice, req, 0);
        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.DELIVERED));
        assertEq(C.app.deliveredCount(), 1);

        // A loose route whose hops still ask for fees cannot be paid from a zero budget.
        req = _request(0);
        req.constraints.loose = true;
        vm.expectRevert(abi.encodeWithSelector(RouteLogic.InvalidRoute.selector, RouteTypes.Reason.FEE_BUDGET));
        _sendAs(alice, req, 0);
    }

    function test_send_revertsOnDuplicateRouteId() public {
        ClprRouter.SendRequest memory req = _request(0);
        req.routeId = bytes16(uint128(42));
        _sendAs(alice, req, 0.03 ether);
        vm.expectRevert(ClprRouter.DuplicateRouteId.selector);
        _sendAs(alice, req, 0.03 ether);
    }

    function test_send_revertsOnReceiptPayloadType() public {
        ClprRouter.SendRequest memory req = _request(0);
        req.payloadType = RouteTypes.PayloadType.RECEIPT;
        vm.expectRevert(abi.encodeWithSelector(ClprRouter.InvalidRoute.selector, RouteTypes.Reason.BAD_ROUTE));
        _sendAs(alice, req, 0.03 ether);
    }

    function test_send_revertsWhenFirstChannelGoesElsewhere() public {
        ClprRouter.SendRequest memory req = _request(0);
        req.hops[0].channelId = chBC; // not a channel on A
        vm.expectRevert(abi.encodeWithSelector(ClprRouter.RouteBlocked.selector, 0, RouteTypes.Reason.BAD_ROUTE));
        _sendAs(alice, req, 0.03 ether);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Deadline and reclaim
    // ═════════════════════════════════════════════════════════════════════

    function test_deadlinePassesBeforeIntermediateHop_expiryReceiptRefunds() public {
        uint256 before = alice.balance;
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);
        vm.warp(block.timestamp + 2 hours);
        _settle();
        assertEq(C.app.deliveredCount(), 0);
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.EXPIRED));
        assertEq(feeA.balance, 0.01 ether, "hop A forwarded, so it is paid");
        assertEq(feeB.balance, 0, "hop B never forwarded");
        assertEq(alice.balance, before - 0.01 ether);
        assertEq(payee.balance, 0);
    }

    function test_deadlinePassesBeforeDestination_expiryReceipt() public {
        bytes16 id = _sendAs(alice, _request(0), 0.03 ether);
        _relay(A, B, chAB);
        vm.warp(block.timestamp + 2 hours);
        _settle();
        assertEq(C.app.deliveredCount(), 0);
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.EXPIRED));
        assertEq(feeB.balance, 0.02 ether);
    }

    function test_reclaim_onlyAfterDeadlinePlusGrace_thenLateReceiptIgnored() public {
        uint256 before = alice.balance;
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);

        vm.expectRevert(ClprRouter.NotReclaimable.selector);
        A.router.reclaim(id);
        vm.warp(block.timestamp + 1 hours + RECLAIM_GRACE);
        vm.expectRevert(ClprRouter.NotReclaimable.selector);
        A.router.reclaim(id);
        vm.warp(block.timestamp + 1);
        A.router.reclaim(id);
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.EXPIRED));
        assertEq(alice.balance, before, "everything back");
        vm.expectRevert(ClprRouter.NotReclaimable.selector);
        A.router.reclaim(id);

        // The expiry receipt that later arrives changes nothing.
        vm.recordLogs();
        _settle();
        assertEq(alice.balance, before);
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.EXPIRED));
    }

    // ═════════════════════════════════════════════════════════════════════
    // Application failure
    // ═════════════════════════════════════════════════════════════════════

    function test_destinationAppReverts_failureReceiptRefundsEscrow() public {
        C.app.setShouldRevert(true);
        uint256 before = alice.balance;
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);
        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.FAILED));
        assertEq(payee.balance, 0);
        assertEq(alice.balance, before - 0.03 ether, "escrow refunded, both forwarding fees paid");
    }

    // ═════════════════════════════════════════════════════════════════════
    // Route safety: disable / re-enable
    // ═════════════════════════════════════════════════════════════════════

    function test_disabledEdge_atSend_reverts() public {
        _apply(A.registry, A_DISABLE, _disablePayload(1, Caip.edgeKey(chBC, ID_C)));
        vm.expectRevert(abi.encodeWithSelector(ClprRouter.RouteBlocked.selector, 1, RouteTypes.Reason.DISABLED_EDGE));
        _sendAs(alice, _request(0), 0.03 ether);
    }

    function test_disabledLedger_atSend_reverts() public {
        _apply(A.registry, A_DISABLE, _disablePayload(2, Caip.ledgerKey(ID_C)));
        vm.expectRevert(abi.encodeWithSelector(ClprRouter.RouteBlocked.selector, 1, RouteTypes.Reason.DISABLED_LEDGER));
        _sendAs(alice, _request(0), 0.03 ether);
    }

    function test_disabledRouterDeployment_atSend_reverts() public {
        _apply(A.registry, A_DISABLE, _disablePayload(3, Caip.routerKey(ID_B, abi.encodePacked(address(B.router)))));
        vm.expectRevert(abi.encodeWithSelector(ClprRouter.RouteBlocked.selector, 0, RouteTypes.Reason.DISABLED_ROUTER));
        _sendAs(alice, _request(0), 0.03 ether);
    }

    function test_disabledRouterVersion_atSend_reverts() public {
        _apply(A.registry, A_DISABLE, _disablePayload(4, Caip.routerVersionKey(1)));
        vm.expectRevert(abi.encodeWithSelector(ClprRouter.RouteBlocked.selector, 0, RouteTypes.Reason.DISABLED_ROUTER));
        _sendAs(alice, _request(0), 0.03 ether);
    }

    function test_disabledEdgeMidRoute_stopsWithFailureReceiptAndRefund() public {
        uint256 before = alice.balance;
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);
        // Edge B→C disabled on B while the message is in flight.
        _apply(B.registry, A_DISABLE, _disablePayload(1, Caip.edgeKey(chBC, ID_C)));
        _settle();
        assertEq(C.app.deliveredCount(), 0);
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.FAILED));
        assertEq(alice.balance, before - 0.01 ether, "escrow and unused fees refunded");
        assertEq(C.service.getChannel(chBC).receivedMessageId, 0, "nothing sent onto the disabled edge");
    }

    function test_messageOverDisabledInboundEdge_isNotForwarded() public {
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);
        _apply(B.registry, A_DISABLE, _disablePayload(1, Caip.edgeKey(chAB, ID_B)));
        (, Vm.Log[] memory logs) = _relayWithLogs(A, B, chAB);
        bool stopped;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == ClprRouter.RouteStopped.selector) {
                (, RouteTypes.ReceiptStatus st, RouteTypes.Reason r) =
                    abi.decode(logs[i].data, (uint32, RouteTypes.ReceiptStatus, RouteTypes.Reason));
                assertEq(uint8(st), uint8(RouteTypes.ReceiptStatus.FAILED));
                assertEq(uint8(r), uint8(RouteTypes.Reason.DISABLED_INBOUND));
                stopped = true;
            }
        }
        assertTrue(stopped);
        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.FAILED));
        assertEq(C.app.deliveredCount(), 0);
    }

    function test_disabledLedgerMidRoute_stops() public {
        bytes16 id = _sendAs(alice, _request(0), 0.03 ether);
        _apply(B.registry, A_DISABLE, _disablePayload(2, Caip.ledgerKey(ID_C)));
        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.FAILED));
    }

    function test_disabledOwnRouterMidRoute_stops() public {
        bytes16 id = _sendAs(alice, _request(0), 0.03 ether);
        _apply(B.registry, A_DISABLE, _disablePayload(4, Caip.routerVersionKey(1)));
        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.FAILED));
    }

    function test_disableLapsesAfterSevenDays() public {
        _apply(A.registry, A_DISABLE, _disablePayload(2, Caip.ledgerKey(ID_C)));
        vm.warp(block.timestamp + DISABLE_LAPSE);
        bytes16 id = _sendAs(alice, _request(0), 0.03 ether);
        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.DELIVERED));
    }

    function test_reenableTakesEffectAfterNotice() public {
        _apply(A.registry, A_DISABLE, _disablePayload(2, Caip.ledgerKey(ID_C)));
        _apply(A.registry, A_ENABLE, abi.encode(uint8(2), Caip.ledgerKey(ID_C)));
        vm.warp(block.timestamp + REENABLE_NOTICE - 1);
        vm.expectRevert(abi.encodeWithSelector(ClprRouter.RouteBlocked.selector, 1, RouteTypes.Reason.DISABLED_LEDGER));
        _sendAs(alice, _request(0), 0.03 ether);
        vm.warp(block.timestamp + 1);
        _sendAs(alice, _request(0), 0.03 ether);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Blacklist and quarantine
    // ═════════════════════════════════════════════════════════════════════

    function test_blacklistedSender_atOrigin_quarantinesEverything() public {
        _apply(A.registry, A_BLACKLIST, _blacklistPayload(Caip.account(ID_A, alice), CASE));
        uint64 nextBefore = A.service.getChannel(chAB).nextMessageId;

        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);

        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.QUARANTINED));
        assertEq(address(A.vault).balance, 1.1 ether);
        assertEq(A.service.getChannel(chAB).nextMessageId, nextBefore, "nothing forwarded");
        (bytes16 rid, bytes32 cid,, address s, address r, uint256 amt,) = A.vault.deposits(1);
        assertEq(rid, id);
        assertEq(cid, CASE);
        assertEq(s, alice);
        assertEq(r, payee);
        assertEq(amt, 1.1 ether);
    }

    function test_blacklistedPayee_atOrigin_quarantines() public {
        _apply(A.registry, A_BLACKLIST, _blacklistPayload(Caip.account(ID_A, payee), CASE));
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.QUARANTINED));
    }

    function test_blacklistIsCaseInsensitive() public {
        string memory upper = string.concat(ID_A, ":", vm.toString(alice)); // checksummed (mixed case)
        _apply(A.registry, A_BLACKLIST, _blacklistPayload(upper, CASE));
        bytes16 id = _sendAs(alice, _request(0), 0.03 ether);
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.QUARANTINED));
    }

    function test_blacklistedRecipientMidRoute_quarantineReceipt_originVault() public {
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);
        _apply(B.registry, A_BLACKLIST, _blacklistPayload(Caip.account(ID_C, address(C.app)), CASE));

        (, Vm.Log[] memory logs) = _relayWithLogs(A, B, chAB);
        bool noticed;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(B.router) && logs[i].topics[0] == ClprRouter.QuarantineNotice.selector) {
                assertEq(logs[i].topics[1], Caip.accountKey(Caip.account(ID_C, address(C.app))));
                (string memory recip, bytes32 cid, string memory contact) =
                    abi.decode(logs[i].data, (string, bytes32, string));
                assertEq(recip, Caip.account(ID_C, address(C.app)));
                assertEq(cid, CASE);
                assertEq(contact, CONTACT);
                noticed = true;
            }
        }
        assertTrue(noticed, "notice addressed to the recipient");

        _settle();
        assertEq(C.app.deliveredCount(), 0);
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.QUARANTINED));
        // fee for hop A was earned; escrow + rest of the budget sits in A's vault under the case
        assertEq(feeA.balance, 0.01 ether);
        assertEq(address(A.vault).balance, 1.09 ether);
        (bytes16 rid, bytes32 cid2,,,,,) = A.vault.deposits(1);
        assertEq(rid, id);
        assertEq(cid2, CASE);
    }

    function test_blacklistAtDestination_callsNoticeHook() public {
        bytes16 id = _sendAs(alice, _request(0), 0.03 ether);
        _apply(C.registry, A_BLACKLIST, _blacklistPayload(Caip.account(ID_A, alice), CASE));
        _settle();
        assertEq(C.app.deliveredCount(), 0);
        assertEq(C.app.lastNoticeRoute(), id);
        assertEq(C.app.lastNoticeCase(), CASE);
        assertEq(C.app.lastNoticeContact(), CONTACT);
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.QUARANTINED));
    }

    function test_blacklistAddedBeforeReceipt_lateCatchAtOrigin() public {
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);
        _relay(A, B, chAB);
        _relay(B, C, chBC);
        _apply(A.registry, A_BLACKLIST, _blacklistPayload(Caip.account(ID_A, payee), CASE));
        _settle();
        assertEq(C.app.deliveredCount(), 1, "already delivered");
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.QUARANTINED));
        assertEq(payee.balance, 0);
        assertEq(address(A.vault).balance, 1 ether + 0.07 ether);
    }

    function test_blacklistLapsesAfterThirtyDays_andDelistIsImmediate() public {
        _apply(A.registry, A_BLACKLIST, _blacklistPayload(Caip.account(ID_A, alice), CASE));
        vm.warp(block.timestamp + BLACKLIST_LAPSE);
        bytes16 id = _sendAs(alice, _request(0), 0.03 ether);
        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.DELIVERED));

        _apply(A.registry, A_BLACKLIST, _blacklistPayload(Caip.account(ID_A, alice), CASE));
        _apply(A.registry, A_DELIST, abi.encode(Caip.account(ID_A, alice), CASE));
        id = _sendAs(alice, _request(0), 0.03 ether);
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.PENDING));
    }

    // ═════════════════════════════════════════════════════════════════════
    // Compliance filters
    // ═════════════════════════════════════════════════════════════════════

    function test_filters_isoMicaEnergy_allCertified_delivers() public {
        _certifyAll(ISO, 0);
        _certifyAll(MICA, 0);
        _certifyAll(ENERGY, 2400); // ~0.0024 gCO2e/tx, stored in µg
        vm.warp(block.timestamp + CERT_NOTICE);
        ClprRouter.SendRequest memory req = _request(0);
        req.constraints.filters = 7;
        req.constraints.energyCap = 3000;
        req.constraints.deadline = uint64(block.timestamp + 1 hours);
        bytes16 id = _sendAs(alice, req, 0.03 ether);
        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.DELIVERED));
    }

    function test_filter_beforeNoticePeriod_reverts() public {
        _certifyAll(ISO, 0);
        vm.warp(block.timestamp + CERT_NOTICE - 1);
        ClprRouter.SendRequest memory req = _request(0);
        req.constraints.filters = RouteTypes.FILTER_ISO20022;
        req.constraints.deadline = uint64(block.timestamp + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(ClprRouter.RouteBlocked.selector, 0, RouteTypes.Reason.FILTER));
        _sendAs(alice, req, 0.03 ether);
    }

    function test_filter_uncertifiedDestination_reverts() public {
        uint64 expiry = uint64(block.timestamp + CERT_NOTICE + 300 days);
        _applyAll(A_CERTIFY, _certifyPayload(ID_A, ISO, expiry, 0));
        _applyAll(A_CERTIFY, _certifyPayload(ID_B, ISO, expiry, 0));
        vm.warp(block.timestamp + CERT_NOTICE);
        ClprRouter.SendRequest memory req = _request(0);
        req.constraints.filters = RouteTypes.FILTER_ISO20022;
        req.constraints.deadline = uint64(block.timestamp + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(ClprRouter.RouteBlocked.selector, 1, RouteTypes.Reason.FILTER));
        _sendAs(alice, req, 0.03 ether);
    }

    function test_filter_energyCapExceeded_reverts() public {
        _certifyAll(ENERGY, 2400);
        vm.warp(block.timestamp + CERT_NOTICE);
        ClprRouter.SendRequest memory req = _request(0);
        req.constraints.filters = RouteTypes.FILTER_ENERGY;
        req.constraints.energyCap = 2399;
        req.constraints.deadline = uint64(block.timestamp + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(ClprRouter.RouteBlocked.selector, 0, RouteTypes.Reason.FILTER));
        _sendAs(alice, req, 0.03 ether);
    }

    function test_filter_unfilteredRouteIgnoresCertifications() public {
        // No certification at all: unfiltered routes never consult the certification registry.
        bytes16 id = _sendAs(alice, _request(0), 0.03 ether);
        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.DELIVERED));
    }

    /// @dev A route pins the registry version it was sent against; a removal applied later on an
    ///      intermediate ledger does not affect it, but does affect routes sent afterwards.
    function test_filter_pinnedVersion_survivesLaterUncertification() public {
        _certifyAll(ISO, 0);
        vm.warp(block.timestamp + CERT_NOTICE);
        ClprRouter.SendRequest memory req = _request(0);
        req.constraints.filters = RouteTypes.FILTER_ISO20022;
        req.constraints.deadline = uint64(block.timestamp + 10 days);
        bytes16 id = _sendAs(alice, req, 0.03 ether);
        uint64 pinned = A.registry.version();

        _applyAll(A_UNCERTIFY, abi.encode(ID_C, ISO));
        vm.warp(block.timestamp + REMOVAL_NOTICE);
        assertGt(B.registry.version(), pinned);

        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.DELIVERED), "pinned route finishes");

        req.constraints.deadline = uint64(block.timestamp + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(ClprRouter.RouteBlocked.selector, 1, RouteTypes.Reason.FILTER));
        _sendAs(alice, req, 0.03 ether);
    }

    /// @dev If an intermediate registry has not reached the pinned version, the filter check fails closed.
    function test_filter_registryBehindPinnedVersion_failsClosed() public {
        _certifyAll(ISO, 0);
        vm.warp(block.timestamp + CERT_NOTICE);
        _apply(A.registry, A_CONTACT, abi.encode("mailto:new@provider.example")); // only A moves ahead
        ClprRouter.SendRequest memory req = _request(0);
        req.constraints.filters = RouteTypes.FILTER_ISO20022;
        req.constraints.deadline = uint64(block.timestamp + 1 hours);
        bytes16 id = _sendAs(alice, req, 0.03 ether);
        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.FAILED));
        assertEq(C.app.deliveredCount(), 0);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Trust floor (edge trust tiers labelled in the provider registry)
    // ═════════════════════════════════════════════════════════════════════

    uint8 internal constant A_TRUST_TIER = 11;

    /// @dev Label the edge `ch` → `toLedger` with `tier` on every ledger's registry.
    function _labelAll(bytes32 ch, string memory toLedger, uint8 tier) internal {
        _applyAll(A_TRUST_TIER, abi.encode(ch, toLedger, tier));
    }

    function _floorRequest(uint256 escrow, uint32 floor) internal view returns (ClprRouter.SendRequest memory req) {
        req = _request(escrow);
        req.constraints.trustFloor = floor;
        req.constraints.deadline = uint64(block.timestamp + 10 days);
    }

    /// @dev Only forward edges are labelled: receipts carry no floor, so the unlabelled reverse edges still
    ///      bring the DELIVERED receipt home.
    function test_trustFloor_edgesAtOrAboveFloor_deliver() public {
        _labelAll(chAB, ID_B, 3);
        _labelAll(chBC, ID_C, 2);
        vm.warp(block.timestamp + CERT_NOTICE);
        bytes16 id = _sendAs(alice, _floorRequest(1 ether, 2), 1.1 ether);
        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.DELIVERED));
        assertEq(payee.balance, 1 ether);
    }

    function test_trustFloor_zero_ignoresMissingLabels() public {
        bytes16 id = _sendAs(alice, _floorRequest(0, 0), 0.03 ether);
        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.DELIVERED));
    }

    function test_trustFloor_unlabelledEdge_atSend_reverts() public {
        _labelAll(chAB, ID_B, 3);
        vm.warp(block.timestamp + CERT_NOTICE);
        vm.expectRevert(abi.encodeWithSelector(ClprRouter.RouteBlocked.selector, 1, RouteTypes.Reason.TRUST_FLOOR));
        _sendAs(alice, _floorRequest(0, 1), 0.03 ether);
    }

    function test_trustFloor_edgeBelowFloor_atSend_reverts() public {
        _labelAll(chAB, ID_B, 1); // committee tier
        _labelAll(chBC, ID_C, 3);
        vm.warp(block.timestamp + CERT_NOTICE);
        vm.expectRevert(abi.encodeWithSelector(ClprRouter.RouteBlocked.selector, 0, RouteTypes.Reason.TRUST_FLOOR));
        _sendAs(alice, _floorRequest(1 ether, 2), 1.1 ether);
    }

    function test_trustFloor_labelBeforeNotice_reverts() public {
        _labelAll(chAB, ID_B, 3);
        _labelAll(chBC, ID_C, 3);
        vm.warp(block.timestamp + CERT_NOTICE - 1);
        vm.expectRevert(abi.encodeWithSelector(ClprRouter.RouteBlocked.selector, 0, RouteTypes.Reason.TRUST_FLOOR));
        _sendAs(alice, _floorRequest(0, 1), 0.03 ether);
    }

    function test_trustFloor_aboveHighestTier_neverPasses() public {
        _labelAll(chAB, ID_B, 3);
        _labelAll(chBC, ID_C, 3);
        vm.warp(block.timestamp + CERT_NOTICE);
        vm.expectRevert(abi.encodeWithSelector(ClprRouter.RouteBlocked.selector, 0, RouteTypes.Reason.TRUST_FLOOR));
        _sendAs(alice, _floorRequest(0, 4), 0.03 ether);
    }

    /// @dev B's registry lowers B → C below the floor while the route is in flight: B refuses to forward,
    ///      sends a FAILED receipt, and the origin refunds the escrow and the unused budget.
    function test_trustFloor_downgradeMidRoute_stopsAtHopAndRefunds() public {
        _labelAll(chAB, ID_B, 3);
        _labelAll(chBC, ID_C, 3);
        vm.warp(block.timestamp + CERT_NOTICE);
        uint256 before = alice.balance;
        bytes16 id = _sendAs(alice, _floorRequest(1 ether, 3), 1.1 ether);
        _apply(B.registry, A_TRUST_TIER, abi.encode(chBC, ID_C, uint8(2)));
        vm.warp(block.timestamp + REMOVAL_NOTICE);

        (, Vm.Log[] memory logs) = _relayWithLogs(A, B, chAB);
        bool stopped;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(B.router) && logs[i].topics[0] == ClprRouter.RouteStopped.selector) {
                (, RouteTypes.ReceiptStatus st, RouteTypes.Reason r) =
                    abi.decode(logs[i].data, (uint32, RouteTypes.ReceiptStatus, RouteTypes.Reason));
                assertEq(uint8(st), uint8(RouteTypes.ReceiptStatus.FAILED));
                assertEq(uint8(r), uint8(RouteTypes.Reason.TRUST_FLOOR));
                stopped = true;
            }
        }
        assertTrue(stopped, "B refused to forward");
        _settle();
        assertEq(C.app.deliveredCount(), 0);
        assertEq(C.service.getChannel(chBC).receivedMessageId, 0, "nothing sent onto the downgraded edge");
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.FAILED));
        assertEq(alice.balance, before - 0.01 ether, "escrow and unused fees refunded");
        assertEq(payee.balance, 0);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Forged receipts and inbound authentication
    // ═════════════════════════════════════════════════════════════════════

    function test_forgedReceipt_withAlteredRouteHops_isIgnored() public {
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);
        RouteTypes.Hop[] memory hops = _hopsABC();
        hops[1].feePayee = abi.encodePacked(makeAddr("thief"));
        bytes memory forged = _receiptEnvelope(id, hops, RouteTypes.ReceiptStatus.DELIVERED, 2);

        vm.expectEmit(true, false, false, false, address(A.router));
        emit ClprRouter.ReceiptIgnored(id);
        vm.prank(address(A.service));
        A.router.onClprMessage(chAB, abi.encodePacked(address(B.router)), forged);
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.PENDING));
    }

    function test_forgedReceipt_claimingDeliveryFromIntermediateHop_isIgnored() public {
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);
        // B (honest-looking) claims DELIVERED although it is hop 1 of 2.
        bytes memory forged = _receiptEnvelope(id, _hopsABC(), RouteTypes.ReceiptStatus.DELIVERED, 1);
        vm.prank(address(A.service));
        A.router.onClprMessage(chAB, abi.encodePacked(address(B.router)), forged);
        assertEq(uint8(_routeStatus(id)), uint8(ClprRouter.RouteStatus.PENDING));
    }

    function test_inbound_fromUnexpectedSender_reverts() public {
        bytes16 id = _sendAs(alice, _request(0), 0.03 ether);
        bytes memory forged = _receiptEnvelope(id, _hopsABC(), RouteTypes.ReceiptStatus.FAILED, 1);
        vm.prank(address(A.service));
        vm.expectRevert(ClprRouter.UnexpectedSender.selector);
        A.router.onClprMessage(chAB, abi.encodePacked(makeAddr("fake-router")), forged);
    }

    function test_inbound_onlyService() public {
        vm.expectRevert(ClprRouter.NotService.selector);
        A.router.onClprMessage(chAB, "", "");
        vm.expectRevert(ClprRouter.NotService.selector);
        A.router.onClprResponse(chAB, 1, 0, "");
    }

    // ── helpers ────────────────────────────────────────────────────────────

    /// @dev Receipt envelope from B to A (as B's Router would build it) with arbitrary receipt fields.
    function _receiptEnvelope(
        bytes16 id,
        RouteTypes.Hop[] memory routeHops,
        RouteTypes.ReceiptStatus status,
        uint32 reportedHop
    ) internal view returns (bytes memory) {
        RouteTypes.Receipt memory r;
        r.routeId = id;
        r.status = status;
        r.hopIndex = reportedHop;
        r.ledgerId = ID_B;
        r.routeHops = routeHops;
        RouteTypes.Envelope memory re;
        re.routeId = bytes16(keccak256(abi.encodePacked(id, "forged")));
        re.origin = RouteTypes.Endpoint(ID_B, abi.encodePacked(address(B.router)));
        re.destination = RouteTypes.Endpoint(ID_A, abi.encodePacked(alice));
        re.hops = RouteLogic.reversePrefix(_hopsABC(), 1);
        re.hopIndex = 1;
        re.payloadType = RouteTypes.PayloadType.RECEIPT;
        re.payload = RouteCodec.encodeReceipt(r);
        re.routerVersion = 1;
        return RouteCodec.encodeEnvelope(re);
    }
}
