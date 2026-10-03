// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/console.sol";
import {SettleOrderBook} from "@clprouter/settle/SettleOrderBook.sol";
import {SettleTypes} from "@clprouter/settle/SettleTypes.sol";
import {SettleFixture} from "./helpers/SettleFixture.sol";

/// @notice Settle-on-Hedera flows over the unchanged reference ClprService on three ledgers (Y pays, X delivers,
///         H holds the order book). TEST ONLY verifier on every Channel (see SettleFixture).
contract SettleIntegrationTest is SettleFixture {
    /// @dev Gas of each step of the happy path, for docs/settle-on-hedera.md.
    function test_delivered_endToEnd_gas() public {
        SettleTypes.Quote memory q = _quote();
        bytes memory sig = _sign(q, SIGNER_PK);
        bytes32 id = book.orderIdOf(q);

        uint256 g = gasleft();
        vm.prank(user);
        (bytes32 got,) = Y.deposit.deposit{value: 1 ether}(q, sig);
        uint256 gDeposit = g - gasleft();
        assertEq(got, id);
        assertEq(connector.balance, 1000 ether - 100 ether + 1 ether);

        assertTrue(_relay(Y, H, chYH));
        uint256 gOpen = lastSubmitGas;
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.OPEN));
        assertEq(book.freeCapacity(connector, address(0)), 89 ether);

        vm.startPrank(connector);
        usdcX.approve(address(X.delivery), 2500e6);
        g = gasleft();
        X.delivery.deliver(id, address(usdcX), user, 2500e6);
        uint256 gDeliver = g - gasleft();
        vm.stopPrank();
        assertEq(usdcX.balanceOf(user), 2500e6);

        assertTrue(_relay(X, H, chXH));
        uint256 gClose = lastSubmitGas;
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.DELIVERED));
        assertEq(book.freeCapacity(connector, address(0)), 100 ether);

        _settleAll(); // acknowledgements back to Y and X keep their queues short
        assertEq(Y.service.getChannel(chYH).ackedMessageId, 1);

        console.log("gas deposit on Y            ", gDeposit);
        console.log("gas submitBundle on H (open)", gOpen);
        console.log("gas deliver on X            ", gDeliver);
        console.log("gas submitBundle on H (close)", gClose);
        assertLt(gOpen, 15_000_000);
        assertLt(gClose, 15_000_000);
    }

    function test_missedDeadline_userPaidFromBond() public {
        SettleTypes.Quote memory q = _quote();
        bytes memory sig = _sign(q, SIGNER_PK);
        bytes32 id = book.orderIdOf(q);
        vm.prank(user);
        Y.deposit.deposit{value: 1 ether}(q, sig);
        _relay(Y, H, chYH);

        vm.warp(uint256(q.deadline) + PROOF_GRACE);
        vm.expectRevert(SettleOrderBook.DeadlineNotPassed.selector);
        book.claimDefault(id);
        vm.warp(uint256(q.deadline) + PROOF_GRACE + 1);
        uint256 g = gasleft();
        book.claimDefault(id);
        console.log("gas claimDefault on H       ", g - gasleft());
        assertEq(refundTo.balance, 11 ether);
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.DEFAULTED));

        // A delivery that arrives after the default moves nothing.
        vm.startPrank(connector);
        usdcX.approve(address(X.delivery), 2500e6);
        X.delivery.deliver(id, address(usdcX), user, 2500e6);
        vm.stopPrank();
        _relay(X, H, chXH);
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.DEFAULTED));
        assertEq(refundTo.balance, 11 ether);
    }

    function test_deliveryProofFirst_thenDeposit_thenClose() public {
        SettleTypes.Quote memory q = _quote();
        bytes memory sig = _sign(q, SIGNER_PK);
        bytes32 id = book.orderIdOf(q);
        vm.prank(user);
        Y.deposit.deposit{value: 1 ether}(q, sig);

        vm.startPrank(connector);
        usdcX.approve(address(X.delivery), 2500e6);
        X.delivery.deliver(id, address(usdcX), user, 2500e6);
        vm.stopPrank();
        SettleTypes.Delivery memory d = SettleTypes.Delivery({
            orderId: id,
            asset: q.assetOut,
            recipient: q.recipient,
            amount: 2500e6,
            deliveredAt: uint64(vm.getBlockTimestamp()),
            deliverer: SettleTypes.toBytes32(connector)
        });

        _relay(X, H, chXH); // delivery proof lands first
        assertTrue(book.deliverySeen(id, book.deliveryHash(keccak256(bytes(ID_X)), d)));
        _relay(Y, H, chYH); // then the deposit
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.OPEN));
        book.closeWithRecordedDelivery(keccak256(bytes(ID_X)), d);
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.DELIVERED));
    }

    function test_resubmittedBundle_doesNotReopenOrDoubleCount() public {
        SettleTypes.Quote memory q = _quote();
        bytes memory sig = _sign(q, SIGNER_PK);
        bytes32 id = book.orderIdOf(q);
        vm.prank(user);
        Y.deposit.deposit{value: 1 ether}(q, sig);
        bytes memory bundle = _bundle(Y, H, chYH);
        H.service.submitBundle(chYH, bundle);
        assertEq(book.freeCapacity(connector, address(0)), 89 ether);
        // The same bundle again: the Service refuses it, and the order book is unchanged.
        vm.expectRevert();
        H.service.submitBundle(chYH, bundle);
        assertEq(book.freeCapacity(connector, address(0)), 89 ether);
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.OPEN));
    }

    function test_userTamperedQuote_rejected_noCover() public {
        SettleTypes.Quote memory q = _quote();
        bytes memory sig = _sign(q, SIGNER_PK);
        q.amountOut = 1_000_000e6; // edited after signing
        vm.prank(user);
        (bytes32 id,) = Y.deposit.deposit{value: 1 ether}(q, sig);
        _relay(Y, H, chYH);
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.REJECTED));
        assertEq(book.freeCapacity(connector, address(0)), 100 ether);
    }

    function test_maliciousConnector_shortDelivery_stillDefaults() public {
        SettleTypes.Quote memory q = _quote();
        bytes memory sig = _sign(q, SIGNER_PK);
        bytes32 id = book.orderIdOf(q);
        vm.prank(user);
        Y.deposit.deposit{value: 1 ether}(q, sig);
        _relay(Y, H, chYH);
        vm.startPrank(connector);
        usdcX.approve(address(X.delivery), 2500e6);
        X.delivery.deliver(id, address(usdcX), user, 2499e6); // one unit short of 2,500 USDC
        X.delivery.deliver(id, address(usdcX), makeAddr("accomplice"), 1e6); // the rest to someone else
        vm.stopPrank();
        _relay(X, H, chXH);
        assertEq(uint8(_status(id)), uint8(SettleOrderBook.Status.OPEN));
        vm.warp(uint256(q.deadline) + PROOF_GRACE + 1);
        book.claimDefault(id);
        assertEq(refundTo.balance, 11 ether);
    }

    function test_connectorCannotWithdrawBehindOpenOrder() public {
        SettleTypes.Quote memory q = _quote();
        bytes memory sig = _sign(q, SIGNER_PK);
        vm.prank(user);
        Y.deposit.deposit{value: 1 ether}(q, sig);
        _relay(Y, H, chYH);
        vm.prank(connector);
        vm.expectRevert(SettleOrderBook.InsufficientFree.selector);
        book.requestWithdraw(address(0), 100 ether);
    }
}
