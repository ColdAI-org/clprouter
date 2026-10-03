// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SettleOrderBook} from "@clprouter/settle/SettleOrderBook.sol";
import {SettleTypes} from "@clprouter/settle/SettleTypes.sol";
import {ISettlePaymentProver} from "@clprouter/settle/interfaces/ISettlePaymentProver.sol";
import {SettleBase} from "./helpers/SettleBase.sol";
import {BlockingToken, GasHog, Rejecter, TestPaymentProver, FeeToken} from "./helpers/SettleMocks.sol";

contract SettleOrderBookTest is SettleBase {
    // ═════════════════════════════════════════════════════════════════════
    // Construction and admin
    // ═════════════════════════════════════════════════════════════════════

    function test_constructor_rejectsBadParams() public {
        address[] memory a = new address[](1);
        vm.expectRevert(SettleOrderBook.BadParams.selector);
        new SettleOrderBook(address(0), admin, a, 100, 1 days, 0, 1, 1 days);
        vm.expectRevert(SettleOrderBook.BadParams.selector);
        new SettleOrderBook(address(this), admin, a, 5001, 1 days, 0, 1, 1 days);
        vm.expectRevert(SettleOrderBook.BadParams.selector);
        new SettleOrderBook(address(this), admin, a, 100, 59 minutes, 0, 1, 1 days);
        vm.expectRevert(SettleOrderBook.BadParams.selector);
        new SettleOrderBook(address(this), admin, a, 100, 1 days, 0, 1, 23 hours);
        vm.expectRevert(SettleOrderBook.BadParams.selector);
        new SettleOrderBook(address(this), admin, new address[](0), 100, 1 days, 0, 1, 1 days);
    }

    function test_coverAssets_listed() public view {
        address[] memory a = book.coverAssets();
        assertEq(a.length, 2);
        assertTrue(book.isCoverAsset(address(0)));
        assertTrue(book.isCoverAsset(address(usdc)));
        assertFalse(book.isCoverAsset(address(0xBEEF)));
    }

    function test_source_onlyAdmin_onceEach_afterNotice() public {
        bytes32 ch = keccak256("ch Z");
        bytes32 ledgerZ = keccak256("eip155:31009");
        vm.expectRevert(SettleOrderBook.OnlyAdmin.selector);
        book.proposeSource(ch, ledgerZ, hex"01", hex"02");

        vm.prank(admin);
        book.proposeSource(ch, ledgerZ, abi.encodePacked(depositY), "");
        // Not active during the notice: messages over it revert.
        SettleTypes.Quote memory q = _quote();
        q.srcLedger = ledgerZ;
        vm.expectRevert(SettleOrderBook.UnknownSource.selector);
        book.onClprMessage(ch, abi.encodePacked(depositY), SettleTypes.encodeDeposit(q, "", 0));

        // Same ledger or same Channel again: refused (never replaced).
        vm.startPrank(admin);
        vm.expectRevert(SettleOrderBook.SourceExists.selector);
        book.proposeSource(keccak256("other"), ledgerZ, hex"01", hex"02");
        vm.expectRevert(SettleOrderBook.SourceExists.selector);
        book.proposeSource(ch, keccak256("other ledger"), hex"01", hex"02");
        vm.expectRevert(SettleOrderBook.BadParams.selector);
        book.proposeSource(bytes32(0), keccak256("l"), hex"01", hex"02");
        vm.stopPrank();
    }

    function test_admin_transfer_and_renounce() public {
        address next = makeAddr("next");
        vm.prank(admin);
        book.transferAdmin(next);
        vm.expectRevert(SettleOrderBook.OnlyAdmin.selector);
        book.acceptAdmin();
        vm.prank(next);
        book.acceptAdmin();
        assertEq(book.admin(), next);
        vm.prank(next);
        book.renounceAdmin();
        assertEq(book.admin(), address(0));
        vm.prank(next);
        vm.expectRevert(SettleOrderBook.OnlyAdmin.selector);
        book.proposeSource(keccak256("c"), keccak256("l"), "", "");
    }

    function test_prover_onceAfterNotice() public {
        TestPaymentProver p = new TestPaymentProver();
        bytes32 btc = keccak256("bip122:000000000019d6689c085ae165831e93");
        vm.prank(admin);
        book.proposeProver(btc, p);
        vm.prank(admin);
        vm.expectRevert(SettleOrderBook.SourceExists.selector);
        book.proposeProver(btc, p);
        (ISettlePaymentProver pr, uint64 at) = book.provers(btc);
        assertEq(address(pr), address(p));
        assertEq(at, block.timestamp + SOURCE_NOTICE);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Connectors and bonds
    // ═════════════════════════════════════════════════════════════════════

    function test_register_once_nonZero() public {
        vm.expectRevert(SettleOrderBook.ZeroSigner.selector);
        book.register(address(0));
        vm.prank(connector);
        vm.expectRevert(SettleOrderBook.AlreadyRegistered.selector);
        book.register(signer);
    }

    function test_postBond_requiresRegistration_coverAsset_exactValue() public {
        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(SettleOrderBook.NotRegistered.selector);
        book.postBond{value: 1}(address(0), 1);
        vm.startPrank(connector);
        vm.expectRevert(SettleOrderBook.NotCoverAsset.selector);
        book.postBond(address(0xBEEF), 1);
        vm.expectRevert(SettleOrderBook.WrongValue.selector);
        book.postBond{value: 1}(address(0), 2);
        vm.expectRevert(SettleOrderBook.ZeroAmount.selector);
        book.postBond(address(0), 0);
        vm.expectRevert(SettleOrderBook.WrongValue.selector);
        book.postBond{value: 1}(address(usdc), 1);
        vm.stopPrank();
    }

    function test_postBond_token() public {
        usdc.mint(connector, 5000e6);
        vm.startPrank(connector);
        usdc.approve(address(book), 5000e6);
        book.postBond(address(usdc), 5000e6);
        vm.stopPrank();
        (uint256 total,,,) = _bondOf(connector, address(usdc));
        assertEq(total, 5000e6);
        assertEq(book.freeCapacity(connector, address(usdc)), 5000e6);
    }

    function test_withdraw_delay_cancel_execute() public {
        vm.startPrank(connector);
        vm.expectRevert(SettleOrderBook.InsufficientFree.selector);
        book.requestWithdraw(address(0), 101 ether);
        book.requestWithdraw(address(0), 40 ether);
        assertEq(book.freeCapacity(connector, address(0)), 60 ether);
        vm.expectRevert(SettleOrderBook.WithdrawNotReady.selector);
        book.executeWithdraw(address(0));
        book.cancelWithdraw(address(0));
        assertEq(book.freeCapacity(connector, address(0)), 100 ether);
        vm.expectRevert(SettleOrderBook.NothingPending.selector);
        book.cancelWithdraw(address(0));

        book.requestWithdraw(address(0), 40 ether);
        vm.warp(block.timestamp + WITHDRAW_DELAY - 1);
        vm.expectRevert(SettleOrderBook.WithdrawNotReady.selector);
        book.executeWithdraw(address(0));
        vm.warp(block.timestamp + 1);
        uint256 before = connector.balance;
        book.executeWithdraw(address(0));
        vm.stopPrank();
        assertEq(connector.balance - before, 40 ether);
        (uint256 total,, uint256 pending,) = _bondOf(connector, address(0));
        assertEq(total, 60 ether);
        assertEq(pending, 0);
    }

    function test_withdraw_cannotTouchReserved() public {
        bytes32 id = _open(_quote()); // reserves 11 ether
        assertEq(_reserved(id), 11 ether);
        vm.prank(connector);
        vm.expectRevert(SettleOrderBook.InsufficientFree.selector);
        book.requestWithdraw(address(0), 90 ether);
        vm.prank(connector);
        book.requestWithdraw(address(0), 89 ether);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Deposits
    // ═════════════════════════════════════════════════════════════════════

    function test_deposit_opensOrder_reservesCoverPlusPenalty() public {
        SettleTypes.Quote memory q = _quote();
        bytes32 id = _id(q);
        vm.expectEmit(true, true, true, true, address(book));
        emit SettleOrderBook.OrderOpened(
            id, connector, refundTo, LEDGER_Y, LEDGER_X, address(0), 11 ether, 11 ether, q.deadline
        );
        _open(q);
        (
            address c,
            SettleOrderBook.Status s,
            uint64 deadline,
            address coverAsset,
            uint64 openedAt,
            address r,
            bytes32 dst,
            bytes32 assetOut,
            bytes32 recipient,
            uint256 amountOut,
            uint256 owed,
            uint256 reserved
        ) = book.orders(id);
        assertEq(c, connector);
        assertEq(uint8(s), uint8(SettleOrderBook.Status.OPEN));
        assertEq(deadline, q.deadline);
        assertEq(coverAsset, address(0));
        assertEq(openedAt, block.timestamp);
        assertEq(r, refundTo);
        assertEq(dst, LEDGER_X);
        assertEq(assetOut, q.assetOut);
        assertEq(recipient, q.recipient);
        assertEq(amountOut, q.amountOut);
        assertEq(owed, 11 ether);
        assertEq(reserved, 11 ether);
        assertEq(book.freeCapacity(connector, address(0)), 89 ether);
    }

    function test_deposit_unknownConnector_rejected() public {
        SettleTypes.Quote memory q = _quote();
        q.connector = makeAddr("nobody");
        bytes32 id = _id(q);
        vm.expectEmit(true, true, false, true, address(book));
        emit SettleOrderBook.OrderRejected(id, q.connector, SettleOrderBook.Reject.UNKNOWN_CONNECTOR);
        _depositMsg(q, _sign(q, SIGNER_PK));
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.REJECTED));
    }

    function test_deposit_wrongSigner_rejected() public {
        SettleTypes.Quote memory q = _quote();
        _depositMsg(q, _sign(q, SIGNER2_PK));
        assertEq(uint8(_status(_id(q))), uint8(SettleOrderBook.Status.REJECTED));
        assertEq(book.freeCapacity(connector, address(0)), 100 ether);
    }

    function test_deposit_garbageSignature_rejected_noRevert() public {
        SettleTypes.Quote memory q = _quote();
        _depositMsg(q, hex"1234");
        assertEq(uint8(_status(_id(q))), uint8(SettleOrderBook.Status.REJECTED));
    }

    function test_deposit_quoteNamingOtherLedger_rejectedAsWrongSource() public {
        SettleTypes.Quote memory q = _quote();
        q.srcLedger = LEDGER_X; // signed for X, but proven by Y's Deposit contract
        bytes32 id = _id(q);
        vm.expectEmit(true, true, false, true, address(book));
        emit SettleOrderBook.OrderRejected(id, connector, SettleOrderBook.Reject.WRONG_SOURCE);
        _depositMsg(q, _sign(q, SIGNER_PK));
    }

    function test_deposit_quoteNamingOtherDepositApp_rejectedAsWrongSource() public {
        SettleTypes.Quote memory q = _quote();
        q.depositApp = SettleTypes.toBytes32(makeAddr("another deposit app"));
        _depositMsg(q, _sign(q, SIGNER_PK));
        assertEq(uint8(_status(_id(q))), uint8(SettleOrderBook.Status.REJECTED));
    }

    function test_deposit_depositAppWithDirtyHighBits_rejected() public {
        SettleTypes.Quote memory q = _quote();
        q.depositApp = bytes32(uint256(uint160(depositY)) | (uint256(1) << 200));
        _depositMsg(q, _sign(q, SIGNER_PK));
        assertEq(uint8(_status(_id(q))), uint8(SettleOrderBook.Status.REJECTED));
    }

    function test_message_auth() public {
        SettleTypes.Quote memory q = _quote();
        bytes memory m = SettleTypes.encodeDeposit(q, _sign(q, SIGNER_PK), uint64(block.timestamp));
        // Only the ClprService.
        vm.prank(makeAddr("anyone"));
        vm.expectRevert(SettleOrderBook.OnlyService.selector);
        book.onClprMessage(CH_Y, abi.encodePacked(depositY), m);
        // Unknown Channel.
        vm.expectRevert(SettleOrderBook.UnknownSource.selector);
        book.onClprMessage(keccak256("unknown"), abi.encodePacked(depositY), m);
        // Deposit from the delivery contract, or from X's deposit contract over Y's Channel.
        vm.expectRevert(SettleOrderBook.UnauthorizedSender.selector);
        book.onClprMessage(CH_Y, abi.encodePacked(deliveryY), m);
        vm.expectRevert(SettleOrderBook.UnauthorizedSender.selector);
        book.onClprMessage(CH_Y, abi.encodePacked(depositX), m);
        // Delivery from the deposit contract.
        bytes memory dm = SettleTypes.encodeDelivery(_deliveryFor(q));
        vm.expectRevert(SettleOrderBook.UnauthorizedSender.selector);
        book.onClprMessage(CH_X, abi.encodePacked(depositX), dm);
        // Version and kind.
        vm.expectRevert(SettleOrderBook.UnsupportedMessage.selector);
        book.onClprMessage(CH_Y, abi.encodePacked(depositY), abi.encode(uint8(2), uint8(1)));
        vm.expectRevert(SettleOrderBook.UnsupportedMessage.selector);
        book.onClprMessage(CH_Y, abi.encodePacked(depositY), abi.encode(uint8(1), uint8(9)));
        vm.expectRevert(SettleOrderBook.UnsupportedMessage.selector);
        book.onClprMessage(CH_Y, abi.encodePacked(depositY), hex"01");
        vm.expectRevert(SettleOrderBook.UnsupportedMessage.selector);
        book.onClprMessage(CH_Y, abi.encodePacked(depositY), abi.encode(uint256(1) << 200, uint8(1)));
    }

    function test_onClprResponse_onlyService() public {
        book.onClprResponse(CH_Y, 1, 0, "");
        vm.prank(makeAddr("x"));
        vm.expectRevert(SettleOrderBook.OnlyService.selector);
        book.onClprResponse(CH_Y, 1, 0, "");
    }

    /// @dev Replayed and duplicated messages: the same deposit twice (or a conflicting message for the same
    ///      order id) leaves the first order and its reservation untouched.
    function test_duplicateDeposit_ignored() public {
        SettleTypes.Quote memory q = _quote();
        bytes memory sig = _sign(q, SIGNER_PK);
        _depositMsg(q, sig);
        bytes32 id = _id(q);
        vm.expectEmit(true, false, false, true, address(book));
        emit SettleOrderBook.DuplicateDeposit(id, LEDGER_Y);
        _depositMsgAt(q, sig, uint64(block.timestamp + 7));
        assertEq(_reserved(id), 11 ether);
        assertEq(book.freeCapacity(connector, address(0)), 89 ether);
        // Rejected first, then a "correct" duplicate: stays rejected.
        SettleTypes.Quote memory q2 = _quote();
        _depositMsg(q2, _sign(q2, SIGNER2_PK));
        _depositMsg(q2, _sign(q2, SIGNER_PK));
        assertEq(uint8(_status(_id(q2))), uint8(SettleOrderBook.Status.REJECTED));
    }

    function test_shortfall_whenBondTooSmall() public {
        SettleTypes.Quote memory q = _quote();
        q.coverAmount = 95 ether; // needs 104.5
        bytes32 id = _id(q);
        vm.expectEmit(true, true, false, true, address(book));
        emit SettleOrderBook.CoverShortfall(id, connector, 104.5 ether, 100 ether);
        _depositMsg(q, _sign(q, SIGNER_PK));
        assertEq(_reserved(id), 100 ether);
        (,,,, uint32 shortfalls) = book.connectors(connector);
        assertEq(shortfalls, 1);
        assertEq(book.freeCapacity(connector, address(0)), 0);
    }

    function test_reservation_drawsFromPendingWithdrawal() public {
        vm.prank(connector);
        book.requestWithdraw(address(0), 95 ether); // free 5
        bytes32 id = _open(_quote()); // needs 11: 5 free + 6 from pending
        assertEq(_reserved(id), 11 ether);
        (uint256 total, uint256 reserved, uint256 pending,) = _bondOf(connector, address(0));
        assertEq(total, 100 ether);
        assertEq(reserved, 11 ether);
        assertEq(pending, 89 ether);
        vm.warp(block.timestamp + WITHDRAW_DELAY);
        vm.prank(connector);
        book.executeWithdraw(address(0));
        (total,,,) = _bondOf(connector, address(0));
        assertEq(total, 11 ether);
    }

    function test_coverAssetNotBondAsset_opensWithZeroReserve() public {
        SettleTypes.Quote memory q = _quote();
        q.coverAsset = address(0xBEEF);
        bytes32 id = _open(q);
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.OPEN));
        assertEq(_reserved(id), 0);
    }

    function test_hugeCover_saturates_noRevert() public {
        SettleTypes.Quote memory q = _quote();
        q.coverAmount = type(uint256).max;
        bytes32 id = _open(q);
        assertEq(book.owedFor(type(uint256).max), type(uint256).max);
        assertEq(_reserved(id), 100 ether);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Signer rotation
    // ═════════════════════════════════════════════════════════════════════

    function test_rotation_oldSignerHonouredForQuotesIssuedBefore() public {
        uint256 t0 = vm.getBlockTimestamp();
        SettleTypes.Quote memory before = _quote();
        bytes memory oldSig = _sign(before, SIGNER_PK);
        vm.warp(t0 + 1);
        vm.prank(connector);
        book.rotateSigner(vm.addr(SIGNER2_PK));
        // Deposit of the old-key quote lands after the rotation: still opens.
        _depositMsg(before, oldSig);
        assertEq(uint8(_status(_id(before))), uint8(SettleOrderBook.Status.OPEN));
        // A quote issued after the rotation with the old key: rejected.
        vm.warp(t0 + 2);
        SettleTypes.Quote memory after_ = _quote();
        after_.issuedAt = uint64(t0 + 2);
        _depositMsg(after_, _sign(after_, SIGNER_PK));
        assertEq(uint8(_status(_id(after_))), uint8(SettleOrderBook.Status.REJECTED));
        // The new key works.
        SettleTypes.Quote memory fresh = _quote();
        _depositMsg(fresh, _sign(fresh, SIGNER2_PK));
        assertEq(uint8(_status(_id(fresh))), uint8(SettleOrderBook.Status.OPEN));
    }

    function test_rotation_oldSignerQuoteLivingTooLong_rejected() public {
        SettleTypes.Quote memory q = _quote();
        q.expiry = uint64(block.timestamp + MAX_QUOTE_TTL + 1);
        bytes memory sig = _sign(q, SIGNER_PK);
        vm.prank(connector);
        book.rotateSigner(vm.addr(SIGNER2_PK));
        _depositMsg(q, sig);
        assertEq(uint8(_status(_id(q))), uint8(SettleOrderBook.Status.REJECTED));
    }

    function test_rotation_rateLimited() public {
        vm.startPrank(connector);
        book.rotateSigner(vm.addr(SIGNER2_PK));
        vm.expectRevert(SettleOrderBook.RotationTooSoon.selector);
        book.rotateSigner(signer);
        vm.warp(block.timestamp + MAX_QUOTE_TTL);
        book.rotateSigner(signer);
        vm.expectRevert(SettleOrderBook.ZeroSigner.selector);
        book.rotateSigner(address(0));
        vm.stopPrank();
        vm.prank(makeAddr("x"));
        vm.expectRevert(SettleOrderBook.NotRegistered.selector);
        book.rotateSigner(signer);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Deliveries
    // ═════════════════════════════════════════════════════════════════════

    function test_delivery_closesOrder_releasesReservation() public {
        SettleTypes.Quote memory q = _quote();
        bytes32 id = _open(q);
        SettleTypes.Delivery memory d = _deliveryFor(q);
        vm.expectEmit(true, false, false, true, address(book));
        emit SettleOrderBook.OrderDelivered(id, book.deliveryHash(LEDGER_X, d), d.deliveredAt);
        _deliverMsg(d);
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.DELIVERED));
        assertEq(book.freeCapacity(connector, address(0)), 100 ether);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(SettleOrderBook.NotOpen.selector);
        book.claimDefault(id);
    }

    function test_delivery_overpaid_closes() public {
        SettleTypes.Quote memory q = _quote();
        bytes32 id = _open(q);
        SettleTypes.Delivery memory d = _deliveryFor(q);
        d.amount += 1;
        _deliverMsg(d);
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.DELIVERED));
    }

    function test_delivery_mismatches_leaveOrderOpen() public {
        SettleTypes.Quote memory q = _quote();
        bytes32 id = _open(q);
        SettleTypes.Delivery memory d;

        d = _deliveryFor(q);
        d.amount -= 1;
        _expectMismatch(id, d);
        d = _deliveryFor(q);
        d.asset = bytes32(0);
        _expectMismatch(id, d);
        d = _deliveryFor(q);
        d.recipient = SettleTypes.toBytes32(makeAddr("thief"));
        _expectMismatch(id, d);
        d = _deliveryFor(q);
        d.deliveredAt = q.deadline + 1;
        _expectMismatch(id, d);

        // Right fields, wrong ledger: proven on Y instead of X.
        d = _deliveryFor(q);
        book.onClprMessage(CH_Y, abi.encodePacked(deliveryY), SettleTypes.encodeDelivery(d));
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.OPEN));
        assertEq(_reserved(id), 11 ether);
    }

    function _expectMismatch(bytes32 id, SettleTypes.Delivery memory d) internal {
        vm.expectEmit(true, true, false, false, address(book));
        emit SettleOrderBook.DeliveryMismatch(id, book.deliveryHash(LEDGER_X, d));
        _deliverMsg(d);
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.OPEN));
    }

    function test_delivery_atDeadline_accepted() public {
        SettleTypes.Quote memory q = _quote();
        bytes32 id = _open(q);
        SettleTypes.Delivery memory d = _deliveryFor(q);
        d.deliveredAt = q.deadline;
        _deliverMsg(d);
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.DELIVERED));
    }

    function test_deliveryBeforeDeposit_recorded_thenClosed() public {
        SettleTypes.Quote memory q = _quote();
        bytes32 id = _id(q);
        SettleTypes.Delivery memory d = _deliveryFor(q);
        bytes32 h = book.deliveryHash(LEDGER_X, d);
        vm.expectEmit(true, true, false, true, address(book));
        emit SettleOrderBook.DeliveryRecorded(id, h, LEDGER_X);
        _deliverMsg(d);
        assertTrue(book.deliverySeen(id, h));

        // Not open yet.
        vm.expectRevert(SettleOrderBook.NotOpen.selector);
        book.closeWithRecordedDelivery(LEDGER_X, d);

        _open(q);
        // A delivery that was never proven cannot be used.
        SettleTypes.Delivery memory fake = _deliveryFor(q);
        fake.deliverer = SettleTypes.toBytes32(makeAddr("other"));
        vm.expectRevert(SettleOrderBook.UnknownDelivery.selector);
        book.closeWithRecordedDelivery(LEDGER_X, fake);
        // Proven on the wrong ledger key.
        vm.expectRevert(SettleOrderBook.UnknownDelivery.selector);
        book.closeWithRecordedDelivery(LEDGER_Y, d);

        vm.prank(makeAddr("anyone"));
        book.closeWithRecordedDelivery(LEDGER_X, d);
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.DELIVERED));
        assertEq(book.freeCapacity(connector, address(0)), 100 ether);
    }

    function test_recordedDelivery_notMatching_cannotClose() public {
        SettleTypes.Quote memory q = _quote();
        SettleTypes.Delivery memory d = _deliveryFor(q);
        d.amount = 1; // spam delivery recorded before the deposit
        _deliverMsg(d);
        _open(q);
        vm.expectRevert(SettleOrderBook.NotMatching.selector);
        book.closeWithRecordedDelivery(LEDGER_X, d);
    }

    function test_lateDelivery_afterDefault_movesNothing() public {
        SettleTypes.Quote memory q = _quote();
        bytes32 id = _open(q);
        SettleTypes.Delivery memory d = _deliveryFor(q);
        vm.warp(uint256(q.deadline) + PROOF_GRACE + 1);
        book.claimDefault(id);
        uint256 bal = address(book).balance;
        vm.expectEmit(true, true, false, true, address(book));
        emit SettleOrderBook.LateDelivery(id, book.deliveryHash(LEDGER_X, d), SettleOrderBook.Status.DEFAULTED);
        _deliverMsg(d);
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.DEFAULTED));
        assertEq(address(book).balance, bal);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Default, cancel, payouts
    // ═════════════════════════════════════════════════════════════════════

    function test_claimDefault_boundary_paysCoverPlusPenalty() public {
        SettleTypes.Quote memory q = _quote();
        bytes32 id = _open(q);
        vm.warp(uint256(q.deadline) + PROOF_GRACE);
        vm.expectRevert(SettleOrderBook.DeadlineNotPassed.selector);
        book.claimDefault(id);
        vm.warp(block.timestamp + 1);
        vm.expectEmit(true, true, false, true, address(book));
        emit SettleOrderBook.OrderDefaulted(id, refundTo, address(0), 11 ether);
        vm.prank(makeAddr("keeper"));
        book.claimDefault(id);
        assertEq(refundTo.balance, 11 ether);
        (uint256 total, uint256 reserved,,) = _bondOf(connector, address(0));
        assertEq(total, 89 ether);
        assertEq(reserved, 0);
        // Exactly once.
        vm.expectRevert(SettleOrderBook.NotOpen.selector);
        book.claimDefault(id);
        vm.expectRevert(SettleOrderBook.NotOpen.selector);
        book.claimDefault(keccak256("never opened"));
    }

    function test_claimDefault_shortfall_paysOnlyReserved() public {
        SettleTypes.Quote memory q = _quote();
        q.coverAmount = 95 ether;
        bytes32 id = _open(q);
        vm.warp(uint256(q.deadline) + PROOF_GRACE + 1);
        book.claimDefault(id);
        assertEq(refundTo.balance, 100 ether);
    }

    function test_cancel_onlyConnector_paysNow() public {
        SettleTypes.Quote memory q = _quote();
        bytes32 id = _open(q);
        vm.prank(makeAddr("x"));
        vm.expectRevert(SettleOrderBook.NotConnector.selector);
        book.cancelOrder(id);
        vm.prank(connector);
        book.cancelOrder(id);
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.CANCELLED));
        assertEq(refundTo.balance, 11 ether);
        vm.prank(connector);
        vm.expectRevert(SettleOrderBook.NotOpen.selector);
        book.cancelOrder(id);
    }

    function test_payout_toRejectingAccount_creditedForPull() public {
        Rejecter rj = new Rejecter();
        SettleTypes.Quote memory q = _quote();
        q.refundTo = address(rj);
        bytes32 id = _open(q);
        vm.warp(uint256(q.deadline) + PROOF_GRACE + 1);
        book.claimDefault(id);
        assertEq(book.owed(address(rj), address(0)), 11 ether);
        assertEq(book.totalOwed(address(0)), 11 ether);
        // The rejecting contract cannot pull either (it reverts on receive) — the credit stays.
        vm.prank(address(rj));
        vm.expectRevert(SettleOrderBook.TransferFailed.selector);
        book.withdrawOwed(address(0));
    }

    function test_payout_gasHog_creditedThenPulled() public {
        GasHog hog = new GasHog();
        SettleTypes.Quote memory q = _quote();
        q.refundTo = address(hog);
        bytes32 id = _open(q);
        vm.warp(uint256(q.deadline) + PROOF_GRACE + 1);
        book.claimDefault(id);
        assertEq(book.owed(address(hog), address(0)), 11 ether);
        vm.prank(address(hog));
        book.withdrawOwed(address(0));
        assertEq(address(hog).balance, 11 ether);
        assertEq(book.totalOwed(address(0)), 0);
        vm.prank(address(hog));
        vm.expectRevert(SettleOrderBook.NothingPending.selector);
        book.withdrawOwed(address(0));
    }

    function test_tokenCover_unassociatedRecipient_creditedThenPulled() public {
        BlockingToken t = new BlockingToken();
        address[] memory assets = new address[](1);
        assets[0] = address(t);
        SettleOrderBook b2 = new SettleOrderBook(
            address(this), admin, assets, PENALTY_BPS, WITHDRAW_DELAY, PROOF_GRACE, MAX_QUOTE_TTL, SOURCE_NOTICE
        );
        vm.prank(admin);
        b2.proposeSource(CH_Y, LEDGER_Y, abi.encodePacked(depositY), abi.encodePacked(deliveryY));
        vm.warp(block.timestamp + SOURCE_NOTICE);
        vm.startPrank(connector);
        b2.register(signer);
        t.mint(connector, 1000e6);
        t.approve(address(b2), 1000e6);
        b2.postBond(address(t), 1000e6);
        vm.stopPrank();

        SettleTypes.Quote memory q = _quote();
        q.coverAsset = address(t);
        q.coverAmount = 100e6;
        bytes32 id = SettleTypes.orderId(b2.DOMAIN_SEPARATOR(), q);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, id);
        b2.onClprMessage(
            CH_Y,
            abi.encodePacked(depositY),
            SettleTypes.encodeDeposit(q, abi.encodePacked(r, s, v), uint64(block.timestamp))
        );
        t.setBlocked(refundTo, true);
        vm.warp(uint256(q.deadline) + PROOF_GRACE + 1);
        b2.claimDefault(id);
        assertEq(b2.owed(refundTo, address(t)), 110e6);
        t.setBlocked(refundTo, false);
        vm.prank(refundTo);
        b2.withdrawOwed(address(t));
        assertEq(t.balanceOf(refundTo), 110e6);
        assertEq(t.balanceOf(address(b2)), 890e6);
    }

    function test_feeOnTransferBond_refused() public {
        FeeToken f = new FeeToken();
        address[] memory assets = new address[](1);
        assets[0] = address(f);
        SettleOrderBook b2 = new SettleOrderBook(
            address(this), admin, assets, PENALTY_BPS, WITHDRAW_DELAY, PROOF_GRACE, MAX_QUOTE_TTL, SOURCE_NOTICE
        );
        vm.startPrank(connector);
        b2.register(signer);
        f.mint(connector, 100 ether);
        f.approve(address(b2), 100 ether);
        vm.expectRevert(SettleOrderBook.WrongValue.selector);
        b2.postBond(address(f), 100 ether);
        vm.stopPrank();
    }

    function test_associateCoverAssets_reportsCode() public {
        // HTS precompile stand-in returning SUCCESS (22).
        vm.etch(address(0x167), hex"60166000526020" hex"6000f3");
        vm.recordLogs();
        book.associateCoverAssets();
        assertEq(vm.getRecordedLogs().length, 1);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Payment-proven ledgers
    // ═════════════════════════════════════════════════════════════════════

    bytes32 internal constant BTC = keccak256("bip122:000000000019d6689c085ae165831e93");

    function _paymentSetup() internal returns (TestPaymentProver p) {
        p = new TestPaymentProver();
        vm.prank(admin);
        book.proposeProver(BTC, p);
        vm.warp(block.timestamp + SOURCE_NOTICE);
    }

    function _btcQuote() internal returns (SettleTypes.Quote memory q) {
        q = _quote();
        q.srcLedger = BTC;
        q.depositApp = bytes32(0);
        q.user = keccak256("user btc script");
        q.payTo = keccak256("connector btc script");
        q.amountIn = 100_000; // sats
    }

    function test_payment_opensAndCloses() public {
        TestPaymentProver p = _paymentSetup();
        SettleTypes.Quote memory q = _btcQuote();
        q.dstLedger = BTC;
        q.assetOut = bytes32(0);
        q.recipient = keccak256("user btc script");
        q.amountOut = 99_000;
        bytes32 id = _id(q);
        p.set(
            "dep",
            ISettlePaymentProver.Payment(BTC, keccak256("tx1"), q.user, q.payTo, bytes32(0), 100_000, id, q.expiry)
        );
        p.set(
            "del",
            ISettlePaymentProver.Payment(
                BTC, keccak256("tx2"), q.payTo, q.recipient, bytes32(0), 99_000, id, q.deadline
            )
        );
        bytes memory sig = _sign(q, SIGNER_PK);
        assertEq(book.openByPayment(q, sig, "dep"), id);
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.OPEN));
        vm.expectRevert(SettleOrderBook.PaymentReplayed.selector);
        book.openByPayment(q, sig, "dep");
        book.closeByPayment(id, "del");
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.DELIVERED));
    }

    function test_payment_mismatches_revert() public {
        TestPaymentProver p = _paymentSetup();
        SettleTypes.Quote memory q = _btcQuote();
        bytes32 id = _id(q);
        bytes memory sig = _sign(q, SIGNER_PK);
        ISettlePaymentProver.Payment memory good =
            ISettlePaymentProver.Payment(BTC, keccak256("tx"), q.user, q.payTo, bytes32(0), 100_000, id, q.expiry);
        ISettlePaymentProver.Payment memory bad;

        bad = good;
        bad.memo = keccak256("other order");
        _expectPaymentMismatch(p, q, sig, bad, "m1");
        bad = good;
        bad.amount = 99_999;
        _expectPaymentMismatch(p, q, sig, bad, "m2");
        bad = good;
        bad.to = keccak256("thief");
        _expectPaymentMismatch(p, q, sig, bad, "m3");
        bad = good;
        bad.timestamp = q.expiry + 1;
        _expectPaymentMismatch(p, q, sig, bad, "m4");
        bad = good;
        bad.from = keccak256("someone else");
        _expectPaymentMismatch(p, q, sig, bad, "m5");
        bad = good;
        bad.ledger = keccak256("other chain");
        _expectPaymentMismatch(p, q, sig, bad, "m6");

        // A quote for a Deposit contract cannot be opened by payment.
        SettleTypes.Quote memory q2 = _btcQuote();
        q2.depositApp = SettleTypes.toBytes32(depositY);
        vm.expectRevert(SettleOrderBook.PaymentMismatch.selector);
        book.openByPayment(q2, sig, "m1");
        // No prover for Y.
        SettleTypes.Quote memory q3 = _quote();
        q3.depositApp = bytes32(0);
        vm.expectRevert(SettleOrderBook.NoProver.selector);
        book.openByPayment(q3, sig, "m1");
    }

    function _expectPaymentMismatch(
        TestPaymentProver p,
        SettleTypes.Quote memory q,
        bytes memory sig,
        ISettlePaymentProver.Payment memory pay,
        bytes memory proof
    ) internal {
        p.set(proof, pay);
        vm.expectRevert(SettleOrderBook.PaymentMismatch.selector);
        book.openByPayment(q, sig, proof);
    }

    function test_payment_txReuse_acrossOrders_refused() public {
        TestPaymentProver p = _paymentSetup();
        SettleTypes.Quote memory q = _btcQuote();
        bytes32 id = _id(q);
        p.set(
            "a", ISettlePaymentProver.Payment(BTC, keccak256("tx"), q.user, q.payTo, bytes32(0), 100_000, id, q.expiry)
        );
        book.openByPayment(q, _sign(q, SIGNER_PK), "a");
        // A second order whose proof points at the same transaction id.
        SettleTypes.Quote memory q2 = _btcQuote();
        bytes32 id2 = _id(q2);
        p.set(
            "b",
            ISettlePaymentProver.Payment(BTC, keccak256("tx"), q2.user, q2.payTo, bytes32(0), 100_000, id2, q2.expiry)
        );
        bytes memory sig2 = _sign(q2, SIGNER_PK);
        vm.expectRevert(SettleOrderBook.PaymentReplayed.selector);
        book.openByPayment(q2, sig2, "b");
    }

    function test_closeByPayment_requiresOpen_andMatch() public {
        TestPaymentProver p = _paymentSetup();
        SettleTypes.Quote memory q = _quote();
        q.dstLedger = BTC;
        q.assetOut = bytes32(0);
        q.recipient = keccak256("user btc");
        bytes32 id = _open(q);
        p.set(
            "late",
            ISettlePaymentProver.Payment(BTC, keccak256("t"), 0, q.recipient, 0, q.amountOut, id, q.deadline + 1)
        );
        vm.expectRevert(SettleOrderBook.PaymentMismatch.selector);
        book.closeByPayment(id, "late");
        vm.expectRevert(SettleOrderBook.NotOpen.selector);
        book.closeByPayment(keccak256("nope"), "late");
    }

    // ═════════════════════════════════════════════════════════════════════
    // Fuzz
    // ═════════════════════════════════════════════════════════════════════

    function testFuzz_defaultTiming(uint64 deadlineOffset, uint64 waitAfter) public {
        deadlineOffset = uint64(bound(deadlineOffset, 6 minutes, 30 days));
        waitAfter = uint64(bound(waitAfter, 0, 60 days));
        SettleTypes.Quote memory q = _quote();
        q.deadline = uint64(block.timestamp) + deadlineOffset;
        bytes32 id = _open(q);
        vm.warp(block.timestamp + waitAfter);
        if (block.timestamp <= uint256(q.deadline) + PROOF_GRACE) {
            vm.expectRevert(SettleOrderBook.DeadlineNotPassed.selector);
            book.claimDefault(id);
        } else {
            book.claimDefault(id);
            assertEq(refundTo.balance, 11 ether);
        }
    }

    function testFuzz_deliveryMatch(uint256 amount, uint64 deliveredAt, bool sameAsset, bool sameRecipient) public {
        SettleTypes.Quote memory q = _quote();
        bytes32 id = _open(q);
        SettleTypes.Delivery memory d = _deliveryFor(q);
        d.amount = amount;
        d.deliveredAt = deliveredAt;
        if (!sameAsset) d.asset = keccak256(abi.encode(d.asset));
        if (!sameRecipient) d.recipient = keccak256(abi.encode(d.recipient));
        _deliverMsg(d);
        bool ok = amount >= q.amountOut && deliveredAt <= q.deadline && sameAsset && sameRecipient;
        assertEq(uint8(_status(id)), uint8(ok ? SettleOrderBook.Status.DELIVERED : SettleOrderBook.Status.OPEN));
        assertEq(book.freeCapacity(connector, address(0)), ok ? 100 ether : 89 ether);
    }

    function testFuzz_reserveNeverExceedsBond(uint256 cover, uint256 bond, uint256 pending) public {
        bond = bound(bond, 1, 1e30);
        vm.deal(connector, bond);
        address c2 = makeAddr("c2");
        vm.deal(c2, bond);
        vm.startPrank(c2);
        book.register(signer);
        book.postBond{value: bond}(address(0), bond);
        pending = bound(pending, 0, bond);
        if (pending > 0) book.requestWithdraw(address(0), pending);
        vm.stopPrank();
        SettleTypes.Quote memory q = _quote();
        q.connector = c2;
        q.coverAmount = cover;
        bytes32 id = _open(q);
        (uint256 total, uint256 reserved, uint256 pend,) = _bondOf(c2, address(0));
        assertEq(total, bond);
        assertLe(reserved + pend, total);
        assertEq(reserved, _reserved(id));
        uint256 need = book.owedFor(cover);
        assertEq(reserved, need < bond ? need : bond);
    }

    function testFuzz_signatureMalleability_rejected(uint8 vFlip) public {
        SettleTypes.Quote memory q = _quote();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, _id(q));
        // High-s twin of the same signature (EIP-2): not accepted.
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 s2 = bytes32(n - uint256(s));
        uint8 v2 = (vFlip % 2 == 0) ? (v == 27 ? 28 : 27) : v;
        _depositMsg(q, abi.encodePacked(r, s2, v2));
        assertEq(uint8(_status(_id(q))), uint8(SettleOrderBook.Status.REJECTED));
    }
}
