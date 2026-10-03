// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {SettleDeposit} from "@clprouter/settle/SettleDeposit.sol";
import {SettleDelivery} from "@clprouter/settle/SettleDelivery.sol";
import {SettleTypes} from "@clprouter/settle/SettleTypes.sol";
import {MockSendService, MockToken, FeeToken, Rejecter} from "./helpers/SettleMocks.sol";

/// @dev Exposes the calldata decoders for round-trip checks.
contract SettleCodecHarness {
    function decodeDeposit(bytes calldata m) external pure returns (SettleTypes.Quote memory, bytes memory, uint64) {
        return SettleTypes.decodeDeposit(m);
    }

    function decodeDelivery(bytes calldata m) external pure returns (SettleTypes.Delivery memory) {
        return SettleTypes.decodeDelivery(m);
    }

    function header(bytes calldata m) external pure returns (uint8, uint8) {
        return SettleTypes.header(m);
    }
}

contract SettleDepositDeliveryTest is Test {
    MockSendService internal svc;
    SettleDeposit internal dep;
    SettleDelivery internal del;
    SettleCodecHarness internal codec;
    MockToken internal token;

    string internal constant ID_Y = "eip155:31001";
    bytes32 internal constant CH = keccak256("Y-H");
    bytes32 internal constant CONN = keccak256("clpr connector");
    address internal constant BOOK = address(0xB00C);
    uint256 internal constant HEDERA_CHAIN = 296;
    uint256 internal constant SIGNER_PK = 0x51600;

    address internal user = makeAddr("user");
    address internal payTo = makeAddr("payTo");
    address internal connector = makeAddr("connector");
    uint256 internal salt;

    function setUp() public {
        vm.warp(1_800_000_000);
        svc = new MockSendService();
        dep = new SettleDeposit(IClprService(address(svc)), CH, CONN, BOOK, ID_Y, HEDERA_CHAIN);
        del = new SettleDelivery(IClprService(address(svc)), CH, CONN, BOOK);
        codec = new SettleCodecHarness();
        token = new MockToken("USDC", 6);
        vm.deal(user, 100 ether);
    }

    function _quote() internal returns (SettleTypes.Quote memory q) {
        q.connector = connector;
        q.srcLedger = keccak256(bytes(ID_Y));
        q.depositApp = SettleTypes.toBytes32(address(dep));
        q.user = SettleTypes.toBytes32(user);
        q.payTo = SettleTypes.toBytes32(payTo);
        q.assetIn = bytes32(0);
        q.amountIn = 1 ether;
        q.dstLedger = keccak256("eip155:31002");
        q.assetOut = bytes32(0);
        q.recipient = SettleTypes.toBytes32(user);
        q.amountOut = 0.99 ether;
        q.coverAsset = address(0);
        q.coverAmount = 10 ether;
        q.refundTo = makeAddr("refundTo");
        q.issuedAt = uint64(block.timestamp);
        q.expiry = uint64(block.timestamp + 5 minutes);
        q.deadline = uint64(block.timestamp + 1 hours);
        q.salt = bytes32(++salt);
    }

    function _sign(SettleTypes.Quote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, dep.orderIdOf(q));
        return abi.encodePacked(r, s, v);
    }

    // ═════════════════════════════════════════════════════════════════════
    // SettleDeposit
    // ═════════════════════════════════════════════════════════════════════

    function test_domain_matchesOrderBookDomain() public view {
        assertEq(dep.DOMAIN_SEPARATOR(), SettleTypes.domainSeparator(HEDERA_CHAIN, BOOK));
        assertEq(dep.LEDGER(), keccak256(bytes(ID_Y)));
    }

    function test_deposit_native_paysConnector_sendsMessage() public {
        SettleTypes.Quote memory q = _quote();
        bytes memory sig = _sign(q);
        bytes32 expected = dep.orderIdOf(q);
        vm.expectEmit(true, true, true, true, address(dep));
        emit SettleDeposit.Deposited(expected, connector, user, vm.addr(SIGNER_PK), bytes32(0), 1 ether, q.payTo, 1);
        vm.prank(user);
        (bytes32 id, uint64 mid) = dep.deposit{value: 1 ether}(q, sig);
        assertEq(id, expected);
        assertEq(mid, 1);
        assertEq(payTo.balance, 1 ether);
        assertEq(address(dep).balance, 0);
        assertTrue(dep.used(id));

        MockSendService.Sent memory m = svc.last();
        assertEq(m.channelId, CH);
        assertEq(m.connectorId, CONN);
        assertEq(m.target, abi.encodePacked(BOOK));
        assertEq(m.sender, address(dep));
        (SettleTypes.Quote memory q2, bytes memory sig2, uint64 at) = codec.decodeDeposit(m.data);
        assertEq(keccak256(abi.encode(q2)), keccak256(abi.encode(q)));
        assertEq(sig2, sig);
        assertEq(at, block.timestamp);
        (uint8 v, uint8 k) = codec.header(m.data);
        assertEq(v, SettleTypes.VERSION);
        assertEq(k, SettleTypes.MSG_DEPOSIT);
    }

    function test_deposit_token_exactAmount() public {
        SettleTypes.Quote memory q = _quote();
        q.assetIn = SettleTypes.toBytes32(address(token));
        q.amountIn = 1000e6;
        bytes memory sig = _sign(q);
        token.mint(user, 1000e6);
        vm.startPrank(user);
        token.approve(address(dep), 1000e6);
        vm.expectRevert(SettleDeposit.WrongValue.selector);
        dep.deposit{value: 1}(q, sig);
        dep.deposit(q, sig);
        vm.stopPrank();
        assertEq(token.balanceOf(payTo), 1000e6);
    }

    function test_deposit_feeOnTransfer_refused() public {
        FeeToken f = new FeeToken();
        SettleTypes.Quote memory q = _quote();
        q.assetIn = SettleTypes.toBytes32(address(f));
        bytes memory sig = _sign(q);
        f.mint(user, 1 ether);
        vm.startPrank(user);
        f.approve(address(dep), 1 ether);
        vm.expectRevert(SettleDeposit.AmountMismatch.selector);
        dep.deposit(q, sig);
        vm.stopPrank();
    }

    function test_deposit_replay_refused() public {
        SettleTypes.Quote memory q = _quote();
        bytes memory sig = _sign(q);
        vm.startPrank(user);
        dep.deposit{value: 1 ether}(q, sig);
        vm.expectRevert(SettleDeposit.QuoteUsed.selector);
        dep.deposit{value: 1 ether}(q, sig);
        vm.stopPrank();
    }

    function test_deposit_checks() public {
        SettleTypes.Quote memory q;
        bytes memory sig;

        q = _quote();
        q.srcLedger = keccak256("eip155:1");
        sig = _sign(q);
        _expect(q, sig, 1 ether, SettleDeposit.WrongLedger.selector);

        q = _quote();
        q.depositApp = SettleTypes.toBytes32(address(0xD0));
        sig = _sign(q);
        _expect(q, sig, 1 ether, SettleDeposit.WrongDepositApp.selector);

        q = _quote();
        q.user = SettleTypes.toBytes32(makeAddr("someone else"));
        sig = _sign(q);
        _expect(q, sig, 1 ether, SettleDeposit.NotQuoteUser.selector);

        q = _quote();
        q.payTo = keccak256("not an address");
        sig = _sign(q);
        _expect(q, sig, 1 ether, SettleDeposit.NotAnAddress.selector);

        q = _quote();
        q.expiry = uint64(block.timestamp - 1);
        q.issuedAt = q.expiry - 1;
        sig = _sign(q);
        _expect(q, sig, 1 ether, SettleDeposit.QuoteExpired.selector);

        q = _quote();
        q.deadline = q.expiry;
        sig = _sign(q);
        _expect(q, sig, 1 ether, SettleDeposit.BadTimes.selector);

        q = _quote();
        q.issuedAt = q.expiry + 1;
        sig = _sign(q);
        _expect(q, sig, 1 ether, SettleDeposit.BadTimes.selector);

        q = _quote();
        q.amountIn = 0;
        sig = _sign(q);
        _expect(q, sig, 0, SettleDeposit.ZeroAmount.selector);

        q = _quote();
        sig = _sign(q);
        _expect(q, sig, 1 ether - 1, SettleDeposit.WrongValue.selector);
        _expect(q, hex"00", 1 ether, SettleDeposit.BadSignature.selector);
    }

    function test_deposit_tamperedQuote_recoversOtherSigner_orderIdChanges() public {
        SettleTypes.Quote memory q = _quote();
        bytes memory sig = _sign(q);
        bytes32 id = dep.orderIdOf(q);
        q.amountOut = 100 ether; // user edits the promised output
        vm.prank(user);
        (bytes32 id2,) = dep.deposit{value: 1 ether}(q, sig);
        // It goes through on Y (only the order book knows the Connector's signer), but under another order id and
        // with a recovered signer that is not the Connector's: the order book rejects it (SettleOrderBook tests).
        assertTrue(id2 != id);
    }

    function test_deposit_payeeRejects_reverts() public {
        Rejecter rj = new Rejecter();
        SettleTypes.Quote memory q = _quote();
        q.payTo = SettleTypes.toBytes32(address(rj));
        bytes memory sig = _sign(q);
        _expect(q, sig, 1 ether, SettleDeposit.PaymentFailed.selector);
    }

    function test_deposit_sendFailure_revertsWhole() public {
        svc.setFail(true);
        SettleTypes.Quote memory q = _quote();
        bytes memory sig = _sign(q);
        vm.prank(user);
        vm.expectRevert("send failed");
        dep.deposit{value: 1 ether}(q, sig);
        assertEq(payTo.balance, 0);
        assertFalse(dep.used(dep.orderIdOf(q)));
    }

    function _expect(SettleTypes.Quote memory q, bytes memory sig, uint256 value, bytes4 err) internal {
        vm.prank(user);
        vm.expectRevert(err);
        dep.deposit{value: value}(q, sig);
    }

    function testFuzz_deposit_onlyExactNativeValue(uint256 value) public {
        value = bound(value, 0, 10 ether);
        SettleTypes.Quote memory q = _quote();
        bytes memory sig = _sign(q);
        vm.prank(user);
        if (value != 1 ether) vm.expectRevert(SettleDeposit.WrongValue.selector);
        dep.deposit{value: value}(q, sig);
    }

    // ═════════════════════════════════════════════════════════════════════
    // SettleDelivery
    // ═════════════════════════════════════════════════════════════════════

    function test_deliver_native() public {
        address rcpt = makeAddr("recipient");
        bytes32 id = keccak256("order");
        vm.deal(connector, 5 ether);
        vm.prank(connector);
        uint64 mid = del.deliver{value: 2 ether}(id, address(0), rcpt, 2 ether);
        assertEq(mid, 1);
        assertEq(rcpt.balance, 2 ether);
        SettleTypes.Delivery memory d = codec.decodeDelivery(svc.last().data);
        assertEq(d.orderId, id);
        assertEq(d.asset, bytes32(0));
        assertEq(d.recipient, SettleTypes.toBytes32(rcpt));
        assertEq(d.amount, 2 ether);
        assertEq(d.deliveredAt, block.timestamp);
        assertEq(d.deliverer, SettleTypes.toBytes32(connector));
        (, uint8 k) = codec.header(svc.last().data);
        assertEq(k, SettleTypes.MSG_DELIVERY);
    }

    function test_deliver_token_reportsReceived() public {
        FeeToken f = new FeeToken();
        address rcpt = makeAddr("recipient");
        f.mint(connector, 100 ether);
        vm.startPrank(connector);
        f.approve(address(del), 100 ether);
        del.deliver(keccak256("o"), address(f), rcpt, 100 ether);
        vm.stopPrank();
        SettleTypes.Delivery memory d = codec.decodeDelivery(svc.last().data);
        assertEq(d.amount, 99 ether); // what arrived, not what was sent
    }

    function test_deliver_checks() public {
        vm.deal(connector, 5 ether);
        vm.startPrank(connector);
        vm.expectRevert(SettleDelivery.ZeroAmount.selector);
        del.deliver(bytes32(0), address(0), user, 0);
        vm.expectRevert(SettleDelivery.ZeroRecipient.selector);
        del.deliver(bytes32(0), address(0), address(0), 1);
        vm.expectRevert(SettleDelivery.WrongValue.selector);
        del.deliver{value: 1}(bytes32(0), address(0), user, 2);
        vm.expectRevert(SettleDelivery.WrongValue.selector);
        del.deliver{value: 1}(bytes32(0), address(token), user, 1);
        Rejecter rj = new Rejecter();
        vm.expectRevert(SettleDelivery.PaymentFailed.selector);
        del.deliver{value: 1}(bytes32(0), address(0), address(rj), 1);
        vm.stopPrank();
    }

    function test_header_shortOrOversized() public view {
        (uint8 v, uint8 k) = codec.header(hex"0102");
        assertEq(v, 0);
        assertEq(k, 0);
        (v, k) = codec.header(abi.encode(uint256(256), uint256(1)));
        assertEq(v, 0);
        (v, k) = codec.header(abi.encode(uint256(1), uint256(256)));
        assertEq(k, 0);
    }
}
