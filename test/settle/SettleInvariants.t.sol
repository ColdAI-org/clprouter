// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {SettleOrderBook} from "@clprouter/settle/SettleOrderBook.sol";
import {SettleTypes} from "@clprouter/settle/SettleTypes.sol";
import {MockToken} from "./helpers/SettleMocks.sol";

/// @notice Drives the order book as its ClprService, its Connectors, users and keepers: bonds, withdrawals, deposits
///         (some signed by the wrong key, some replayed), deliveries (some wrong, some before the deposit, some late),
///         defaults and cancels, with time moving forward.
contract SettleHandler is Test {
    SettleOrderBook public book;
    MockToken public usdc;
    bytes32 public constant CH_Y = keccak256("Y");
    bytes32 public constant CH_X = keccak256("X");
    bytes32 public immutable LEDGER_Y = keccak256("eip155:31001");
    bytes32 public immutable LEDGER_X = keccak256("eip155:31002");
    address public depositY = address(0xD1);
    address public deliveryX = address(0xD2);
    uint256 internal constant SIGNER_PK = 0x51600;

    address[3] public connectors;
    address[2] public assets;
    bytes32[] public ids;
    mapping(bytes32 => SettleTypes.Quote) internal quotes;
    mapping(bytes32 => uint256) public paidTo; // ghost: what the order's refundTo received or was credited
    mapping(bytes32 => uint8) public lastStatus;
    uint256 internal salt;
    uint256 public now_;

    constructor() {
        now_ = 1_800_000_000;
        vm.warp(now_);
        usdc = new MockToken("USDC", 6);
        assets[0] = address(0);
        assets[1] = address(usdc);
        address[] memory a = new address[](2);
        a[0] = address(0);
        a[1] = address(usdc);
        book = new SettleOrderBook(address(this), address(this), a, 1000, 1 days, 30 minutes, 10 minutes, 1 days);
        book.proposeSource(CH_Y, LEDGER_Y, abi.encodePacked(depositY), "");
        book.proposeSource(CH_X, LEDGER_X, "", abi.encodePacked(deliveryX));
        _advance(1 days);
        for (uint256 i = 0; i < 3; i++) {
            connectors[i] = address(uint160(0xC000 + i));
            vm.prank(connectors[i]);
            book.register(vm.addr(SIGNER_PK + i));
        }
    }

    function _advance(uint256 dt) internal {
        now_ += dt;
        vm.warp(now_);
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    // ── Connector actions ───────────────────────────────────────────────────

    function post(uint256 c, uint256 a, uint256 amount) external {
        address con = connectors[c % 3];
        address asset = assets[a % 2];
        amount = bound(amount, 1, 1e24);
        vm.startPrank(con);
        if (asset == address(0)) {
            vm.deal(con, amount);
            book.postBond{value: amount}(asset, amount);
        } else {
            usdc.mint(con, amount);
            usdc.approve(address(book), amount);
            book.postBond(asset, amount);
        }
        vm.stopPrank();
    }

    function requestWithdraw(uint256 c, uint256 a, uint256 amount) external {
        address con = connectors[c % 3];
        address asset = assets[a % 2];
        uint256 free = book.freeCapacity(con, asset);
        if (free == 0) return;
        vm.prank(con);
        book.requestWithdraw(asset, bound(amount, 1, free));
    }

    function cancelWithdraw(uint256 c, uint256 a) external {
        (,, uint256 pending,) = book.bonds(connectors[c % 3], assets[a % 2]);
        if (pending == 0) return;
        vm.prank(connectors[c % 3]);
        book.cancelWithdraw(assets[a % 2]);
    }

    function executeWithdraw(uint256 c, uint256 a) external {
        (,, uint256 pending, uint64 readyAt) = book.bonds(connectors[c % 3], assets[a % 2]);
        if (pending == 0) return;
        if (now_ < readyAt) _advance(readyAt - now_);
        vm.prank(connectors[c % 3]);
        book.executeWithdraw(assets[a % 2]);
    }

    function cancelOrder(uint256 i) external {
        if (ids.length == 0) return;
        bytes32 id = ids[i % ids.length];
        (address con, SettleOrderBook.Status s,,,,,,,,,,) = book.orders(id);
        if (s != SettleOrderBook.Status.OPEN) return;
        address r = quotes[id].refundTo;
        uint256 before = _received(r, quotes[id].coverAsset);
        vm.prank(con);
        book.cancelOrder(id);
        paidTo[id] += _received(r, quotes[id].coverAsset) - before;
    }

    // ── Messages (as the ClprService) ───────────────────────────────────────

    function deposit(uint256 c, uint256 a, uint256 cover, uint256 deadlineOffset, uint8 flags) external {
        SettleTypes.Quote memory q;
        uint256 ci = c % 3;
        q.connector = connectors[ci];
        q.srcLedger = LEDGER_Y;
        q.depositApp = SettleTypes.toBytes32(depositY);
        q.user = bytes32(uint256(1));
        q.payTo = bytes32(uint256(2));
        q.amountIn = 1;
        q.dstLedger = LEDGER_X;
        q.assetOut = bytes32(uint256(3));
        q.recipient = bytes32(uint256(4));
        q.amountOut = 1000;
        q.coverAsset = assets[a % 2];
        q.coverAmount = bound(cover, 0, 1e24);
        q.refundTo = address(uint160(uint256(keccak256(abi.encode("refund", salt + 1)))));
        q.issuedAt = uint64(now_);
        q.expiry = uint64(now_ + 5 minutes);
        q.deadline = uint64(now_ + bound(deadlineOffset, 6 minutes, 3 days));
        q.salt = bytes32(++salt);
        bytes32 id = SettleTypes.orderId(book.DOMAIN_SEPARATOR(), q);
        // flags bit 0: signed by another Connector's key (must be rejected).
        uint256 pk = (flags & 1) == 1 ? SIGNER_PK + ((ci + 1) % 3) : SIGNER_PK + ci;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, id);
        bytes memory m = SettleTypes.encodeDeposit(q, abi.encodePacked(r, s, v), uint64(now_));
        quotes[id] = q;
        ids.push(id);
        book.onClprMessage(CH_Y, abi.encodePacked(depositY), m);
        // flags bit 1: the same message again (replayed or duplicated delivery of the same message).
        if ((flags & 2) == 2) book.onClprMessage(CH_Y, abi.encodePacked(depositY), m);
        _track(id);
    }

    /// @dev `kind`: 0 correct, 1 short amount, 2 wrong recipient, 3 after the deadline.
    function deliver(uint256 i, uint8 kind) external {
        if (ids.length == 0) return;
        bytes32 id = ids[i % ids.length];
        SettleTypes.Quote storage q = quotes[id];
        SettleTypes.Delivery memory d = SettleTypes.Delivery({
            orderId: id,
            asset: q.assetOut,
            recipient: q.recipient,
            amount: q.amountOut,
            deliveredAt: uint64(now_),
            deliverer: bytes32(uint256(5))
        });
        kind = kind % 4;
        if (kind == 1) d.amount -= 1;
        if (kind == 2) d.recipient = bytes32(uint256(6));
        if (kind == 3) d.deliveredAt = q.deadline + 1;
        book.onClprMessage(CH_X, abi.encodePacked(deliveryX), SettleTypes.encodeDelivery(d));
        _track(id);
    }

    function claimDefault(uint256 i, uint256 wait) external {
        if (ids.length == 0) return;
        bytes32 id = ids[i % ids.length];
        (, SettleOrderBook.Status s, uint64 deadline,,,,,,,,,) = book.orders(id);
        if (s != SettleOrderBook.Status.OPEN) return;
        uint256 due = uint256(deadline) + book.PROOF_GRACE() + 1;
        if (now_ < due) {
            if (wait % 2 == 0) return;
            _advance(due - now_);
        }
        address r = quotes[id].refundTo;
        uint256 before = _received(r, quotes[id].coverAsset);
        book.claimDefault(id);
        paidTo[id] += _received(r, quotes[id].coverAsset) - before;
        _track(id);
    }

    function warp(uint256 dt) external {
        _advance(bound(dt, 1, 2 days));
    }

    function _received(address r, address asset) internal view returns (uint256) {
        uint256 bal = asset == address(0) ? r.balance : usdc.balanceOf(r);
        return bal + book.owed(r, asset);
    }

    function _track(bytes32 id) internal {
        (, SettleOrderBook.Status s,,,,,,,,,,) = book.orders(id);
        uint8 prev = lastStatus[id];
        uint8 cur = uint8(s);
        // Terminal states never change; NONE only moves to OPEN or REJECTED; OPEN only to a terminal state.
        if (prev >= 2) require(cur == prev, "terminal state changed");
        if (prev == 0) require(cur <= 1 || cur == 5, "NONE -> ?");
        lastStatus[id] = cur;
    }

    function quoteOf(bytes32 id) external view returns (SettleTypes.Quote memory) {
        return quotes[id];
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 60
/// forge-config: deep.invariant.runs = 10000
/// forge-config: deep.invariant.depth = 60
/// forge-config: default.invariant.fail-on-revert = true
contract SettleInvariantsTest is Test {
    SettleHandler internal h;

    function setUp() public {
        h = new SettleHandler();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](9);
        sel[0] = SettleHandler.post.selector;
        sel[1] = SettleHandler.requestWithdraw.selector;
        sel[2] = SettleHandler.cancelWithdraw.selector;
        sel[3] = SettleHandler.executeWithdraw.selector;
        sel[4] = SettleHandler.cancelOrder.selector;
        sel[5] = SettleHandler.deposit.selector;
        sel[6] = SettleHandler.deliver.selector;
        sel[7] = SettleHandler.claimDefault.selector;
        sel[8] = SettleHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// @dev The order book holds exactly the bonds plus the credited payouts, per asset.
    function invariant_solvency() public view {
        SettleOrderBook book = h.book();
        for (uint256 a = 0; a < 2; a++) {
            address asset = h.assets(a);
            uint256 sum;
            for (uint256 c = 0; c < 3; c++) {
                (uint256 total,,,) = book.bonds(h.connectors(c), asset);
                sum += total;
            }
            uint256 held = asset == address(0) ? address(book).balance : h.usdc().balanceOf(address(book));
            assertEq(held, sum + book.totalOwed(asset), "held != bonds + owed");
        }
    }

    /// @dev reserved + pending withdrawal never exceed the bond, and `reserved` is exactly the open orders' reservations.
    function invariant_bondAccounting() public view {
        SettleOrderBook book = h.book();
        uint256 n = h.idsLength();
        for (uint256 c = 0; c < 3; c++) {
            for (uint256 a = 0; a < 2; a++) {
                address con = h.connectors(c);
                address asset = h.assets(a);
                (uint256 total, uint256 reserved, uint256 pending,) = book.bonds(con, asset);
                assertLe(reserved + pending, total, "over-committed bond");
                uint256 open;
                for (uint256 i = 0; i < n; i++) {
                    (address oc, SettleOrderBook.Status s,, address oa,,,,,,,, uint256 r) = book.orders(h.ids(i));
                    if (s == SettleOrderBook.Status.OPEN && oc == con && oa == asset) open += r;
                }
                assertEq(open, reserved, "reserved != open reservations");
            }
        }
    }

    /// @dev Every order is paid at most once, never more than reserved, and only if defaulted or cancelled.
    function invariant_payouts() public view {
        SettleOrderBook book = h.book();
        uint256 n = h.idsLength();
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = h.ids(i);
            (, SettleOrderBook.Status s,,,,,,,,, uint256 owedOnDefault, uint256 r) = book.orders(id);
            uint256 paid = h.paidTo(id);
            if (s == SettleOrderBook.Status.DEFAULTED || s == SettleOrderBook.Status.CANCELLED) {
                assertEq(paid, r, "paid != reserved");
                assertLe(r, owedOnDefault);
            } else {
                assertEq(paid, 0, "paid without default");
            }
        }
    }
}
