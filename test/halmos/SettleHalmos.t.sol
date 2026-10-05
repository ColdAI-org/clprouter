// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SymTest} from "halmos-cheatcodes/SymTest.sol";
import {SettleOrderBook} from "@clprouter/settle/SettleOrderBook.sol";

function hbarOnly() pure returns (address[] memory a) {
    a = new address[](1);
    a[0] = address(0);
}

/// @dev The real order book, with HBAR as its only bond asset and a symbolic penalty.
contract BookHarness is SettleOrderBook {
    constructor(uint16 penaltyBps)
        SettleOrderBook(address(0xC1), address(0xAD), hbarOnly(), penaltyBps, 1 days, 30 minutes, 10 minutes, 1 days)
    {}
}

/// @title Symbolic proofs: settle-on-Hedera bond accounting (SettleOrderBook)
/// @notice Run with `halmos` (see docs/quality.md). The order book's storage is fully symbolic: each proof starts
///         from every state in which the accounting invariant holds for one Connector's HBAR bond and one of its
///         orders, applies one operation with symbolic arguments, and shows the invariant still holds (an
///         inductive proof), that HBAR is conserved, and that a default or cancel pays at most cover + penalty,
///         once.
contract SettleHalmos is Test, SymTest {
    address internal constant C = address(0xC0FFEE);
    address internal constant A = address(0); // HBAR

    BookHarness internal book;

    struct Snap {
        uint256 total;
        uint256 reserved;
        uint256 pending;
        uint256 balance;
        uint256 totalOwed;
        uint256 refundToOwed;
        uint256 refundToBalance;
        SettleOrderBook.Status status;
        uint256 orderReserved;
        uint256 owedOnDefault;
    }

    function _bond() internal view returns (uint256 total, uint256 reserved, uint256 pending) {
        (total, reserved, pending,) = book.bonds(C, A);
    }

    function _order(bytes32 id)
        internal
        view
        returns (
            address connector,
            SettleOrderBook.Status st,
            address asset,
            address refundTo,
            uint256 owedOnDefault,
            uint256 reserved
        )
    {
        (connector, st,, asset,, refundTo,,,,, owedOnDefault, reserved) = book.orders(id);
    }

    function _snap(bytes32 id) internal view returns (Snap memory s) {
        (s.total, s.reserved, s.pending) = _bond();
        s.balance = address(book).balance;
        s.totalOwed = book.totalOwed(A);
        (, SettleOrderBook.Status st,, address refundTo, uint256 owedOnDefault, uint256 r) = _order(id);
        s.status = st;
        s.orderReserved = r;
        s.owedOnDefault = owedOnDefault;
        s.refundToOwed = book.owed(refundTo, A);
        s.refundToBalance = refundTo.balance;
    }

    /// @dev Symbolic state satisfying the invariant for bond (C, HBAR) and order `id`.
    function _assumeInvariant(bytes32 id) internal view {
        (uint256 total, uint256 reserved, uint256 pending) = _bond();
        vm.assume(reserved <= total && pending <= total - reserved);
        vm.assume(total < 2 ** 128 && book.totalOwed(A) < 2 ** 128);
        vm.assume(address(book).balance >= total + book.totalOwed(A));
        (
            address connector,
            SettleOrderBook.Status st,
            address asset,
            address refundTo,
            uint256 owedOnDefault,
            uint256 r
        ) = _order(id);
        vm.assume(r <= owedOnDefault);
        if (st == SettleOrderBook.Status.OPEN) {
            vm.assume(connector == C && asset == A && r <= reserved);
        }
        // Payout recipients are outside accounts (not the book, not a precompile).
        vm.assume(refundTo != address(book) && uint160(refundTo) > 0x1000 && refundTo != C);
        vm.assume(book.owed(refundTo, A) <= book.totalOwed(A));
    }

    function _deploy(uint16 bps) internal {
        vm.assume(bps <= 5000);
        book = new BookHarness(bps);
        svm.enableSymbolicStorage(address(book));
        vm.deal(address(book), svm.createUint(128, "bookBalance"));
        vm.warp(svm.createUint(40, "now"));
    }

    /// @notice Inductive bond accounting: from any state where reserved + pendingWithdraw <= total (free bond is
    ///         never negative) and the order's reservation is part of its Connector's reservation, every bond and
    ///         order operation keeps it so; the book's HBAR moves exactly with `total` and `totalOwed`.
    function check_bondAccounting_inductive(uint16 bps, uint8 op, bytes32 id, uint256 amount) public {
        _deploy(bps);
        _assumeInvariant(id);
        Snap memory s = _snap(id);
        (,,, address refundTo,,) = _order(id);

        bool ok;
        if (op == 0) {
            vm.assume(amount < 2 ** 128);
            vm.deal(C, amount);
            vm.prank(C);
            (ok,) = address(book).call{value: amount}(abi.encodeCall(book.postBond, (A, amount)));
        } else if (op == 1) {
            vm.prank(C);
            (ok,) = address(book).call(abi.encodeCall(book.requestWithdraw, (A, amount)));
        } else if (op == 2) {
            vm.prank(C);
            (ok,) = address(book).call(abi.encodeCall(book.cancelWithdraw, (A)));
        } else if (op == 3) {
            vm.prank(C);
            (ok,) = address(book).call(abi.encodeCall(book.executeWithdraw, (A)));
        } else if (op == 4) {
            (ok,) = address(book).call(abi.encodeCall(book.claimDefault, (id)));
        } else if (op == 5) {
            vm.prank(C);
            (ok,) = address(book).call(abi.encodeCall(book.cancelOrder, (id)));
        } else {
            return;
        }
        vm.assume(ok);

        (uint256 total, uint256 reserved, uint256 pending) = _bond();
        assert(reserved <= total && pending <= total - reserved);
        assert(book.freeCapacity(C, A) == total - reserved - pending);
        // HBAR conservation: the book's balance moves exactly with `total` (bonds) plus `totalOwed` (credited
        // payouts not yet pulled): balance - total - totalOwed is unchanged.
        assert(address(book).balance + s.total + s.totalOwed == s.balance + total + book.totalOwed(A));

        if (op == 4 || op == 5) {
            (, SettleOrderBook.Status st,,,,) = _order(id);
            assert(s.status == SettleOrderBook.Status.OPEN);
            assert(st == (op == 4 ? SettleOrderBook.Status.DEFAULTED : SettleOrderBook.Status.CANCELLED));
            // The user gets exactly the reservation (pushed or credited), which is at most cover + penalty.
            uint256 got = (refundTo.balance - s.refundToBalance) + (book.owed(refundTo, A) - s.refundToOwed);
            assert(got == s.orderReserved);
            assert(got <= s.owedOnDefault);
            assert(total == s.total - s.orderReserved && reserved == s.reserved - s.orderReserved);
        }
    }

    /// @notice A default or a cancel pays an order at most once: once the order is not OPEN, both revert.
    function check_noDoublePayout(uint16 bps, bytes32 id, address caller) public {
        _deploy(bps);
        (, SettleOrderBook.Status st,,,,) = _order(id);
        vm.assume(st != SettleOrderBook.Status.OPEN);
        uint256 bal = address(book).balance;
        vm.prank(caller);
        (bool ok1,) = address(book).call(abi.encodeCall(book.claimDefault, (id)));
        vm.prank(caller);
        (bool ok2,) = address(book).call(abi.encodeCall(book.cancelOrder, (id)));
        assert(!ok1 && !ok2);
        assert(address(book).balance == bal);
    }
}
