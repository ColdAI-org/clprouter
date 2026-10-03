// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SettleOrderBook} from "@clprouter/settle/SettleOrderBook.sol";
import {SettleTypes} from "@clprouter/settle/SettleTypes.sol";
import {MockToken} from "./SettleMocks.sol";

/// @notice An order book whose "ClprService" is this test contract, with two EVM sources registered: ledger Y
///         (deposits come from `depositY`) and ledger X (deliveries come from `deliveryX`). Messages are fed
///         straight into `onClprMessage` as the Service would after the Channel's verifier accepted a bundle.
abstract contract SettleBase is Test {
    SettleOrderBook internal book;
    MockToken internal usdc;

    string internal constant ID_Y = "eip155:31001";
    string internal constant ID_X = "eip155:31002";
    bytes32 internal LEDGER_Y = keccak256(bytes(ID_Y));
    bytes32 internal LEDGER_X = keccak256(bytes(ID_X));
    bytes32 internal constant CH_Y = keccak256("channel Y-H");
    bytes32 internal constant CH_X = keccak256("channel X-H");

    address internal depositY = makeAddr("SettleDeposit@Y");
    address internal deliveryY = makeAddr("SettleDelivery@Y");
    address internal depositX = makeAddr("SettleDeposit@X");
    address internal deliveryX = makeAddr("SettleDelivery@X");
    address internal admin = makeAddr("admin");

    uint256 internal constant SIGNER_PK = 0x51600;
    uint256 internal constant SIGNER2_PK = 0x51601;
    address internal signer;
    address internal connector = makeAddr("connector");
    address internal user = makeAddr("user");
    address internal refundTo = makeAddr("refundTo@hedera");

    uint16 internal constant PENALTY_BPS = 1000; // 10%
    uint64 internal constant WITHDRAW_DELAY = 1 days;
    uint64 internal constant PROOF_GRACE = 30 minutes;
    uint64 internal constant MAX_QUOTE_TTL = 10 minutes;
    uint64 internal constant SOURCE_NOTICE = 2 days;

    uint256 internal saltNonce;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        signer = vm.addr(SIGNER_PK);
        usdc = new MockToken("USDC", 6);
        address[] memory assets = new address[](2);
        assets[0] = address(0);
        assets[1] = address(usdc);
        book = new SettleOrderBook(
            address(this), admin, assets, PENALTY_BPS, WITHDRAW_DELAY, PROOF_GRACE, MAX_QUOTE_TTL, SOURCE_NOTICE
        );
        vm.startPrank(admin);
        book.proposeSource(CH_Y, LEDGER_Y, abi.encodePacked(depositY), abi.encodePacked(deliveryY));
        book.proposeSource(CH_X, LEDGER_X, abi.encodePacked(depositX), abi.encodePacked(deliveryX));
        vm.stopPrank();
        vm.warp(block.timestamp + SOURCE_NOTICE);

        vm.prank(connector);
        book.register(signer);
        vm.deal(connector, 1000 ether);
        _bond(100 ether);
    }

    // ── Builders ────────────────────────────────────────────────────────────

    function _bond(uint256 amount) internal {
        vm.prank(connector);
        book.postBond{value: amount}(address(0), amount);
    }

    /// @dev A quote Y → X paying 1 ether native on Y for 2,500 USDC-units on X, cover 10 ether HBAR-units.
    function _quote() internal returns (SettleTypes.Quote memory q) {
        q.connector = connector;
        q.srcLedger = LEDGER_Y;
        q.depositApp = SettleTypes.toBytes32(depositY);
        q.user = SettleTypes.toBytes32(user);
        q.payTo = SettleTypes.toBytes32(connector);
        q.assetIn = bytes32(0);
        q.amountIn = 1 ether;
        q.dstLedger = LEDGER_X;
        q.assetOut = SettleTypes.toBytes32(address(0xA55E7));
        q.recipient = SettleTypes.toBytes32(user);
        q.amountOut = 2500e6;
        q.coverAsset = address(0);
        q.coverAmount = 10 ether;
        q.refundTo = refundTo;
        q.issuedAt = uint64(block.timestamp);
        q.expiry = uint64(block.timestamp + 5 minutes);
        q.deadline = uint64(block.timestamp + 1 hours);
        q.salt = bytes32(++saltNonce);
    }

    function _id(SettleTypes.Quote memory q) internal view returns (bytes32) {
        return SettleTypes.orderId(book.DOMAIN_SEPARATOR(), q);
    }

    function _sign(SettleTypes.Quote memory q, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _id(q));
        return abi.encodePacked(r, s, v);
    }

    function _deliveryFor(SettleTypes.Quote memory q) internal view returns (SettleTypes.Delivery memory d) {
        d = SettleTypes.Delivery({
            orderId: _id(q),
            asset: q.assetOut,
            recipient: q.recipient,
            amount: q.amountOut,
            deliveredAt: uint64(block.timestamp),
            deliverer: SettleTypes.toBytes32(connector)
        });
    }

    // ── Message feeds (as the ClprService on Hedera) ────────────────────────

    function _depositMsg(SettleTypes.Quote memory q, bytes memory sig) internal {
        _depositMsgAt(q, sig, uint64(block.timestamp));
    }

    function _depositMsgAt(SettleTypes.Quote memory q, bytes memory sig, uint64 at) internal {
        book.onClprMessage(CH_Y, abi.encodePacked(depositY), SettleTypes.encodeDeposit(q, sig, at));
    }

    function _open(SettleTypes.Quote memory q) internal returns (bytes32 id) {
        _depositMsg(q, _sign(q, SIGNER_PK));
        id = _id(q);
    }

    function _deliverMsg(SettleTypes.Delivery memory d) internal {
        book.onClprMessage(CH_X, abi.encodePacked(deliveryX), SettleTypes.encodeDelivery(d));
    }

    // ── Reads ───────────────────────────────────────────────────────────────

    function _status(bytes32 id) internal view returns (SettleOrderBook.Status s) {
        (, s,,,,,,,,,,) = book.orders(id);
    }

    function _reserved(bytes32 id) internal view returns (uint256 r) {
        (,,,,,,,,,,, r) = book.orders(id);
    }

    function _bondOf(address c, address asset)
        internal
        view
        returns (uint256 total, uint256 reserved, uint256 pending, uint64 readyAt)
    {
        (total, reserved, pending, readyAt) = book.bonds(c, asset);
    }
}
