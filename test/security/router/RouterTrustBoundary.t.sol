// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ClprDeployHelper} from "@test/helpers/ClprDeployHelper.sol";
import {ConnectorRegistrar} from "@test/helpers/ConnectorRegistrar.sol";
import {IClprConnector} from "@hiero-ledger/clpr/interfaces/IClprConnector.sol";
import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprProtobuf} from "@hiero-ledger/clpr/libraries/codec/ClprProtobuf.sol";
import {ClprRouter} from "@clprouter/ClprRouter.sol";
import {IClprRouter} from "@clprouter/interfaces/IClprRouter.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {RouteCodec} from "@clprouter/libraries/RouteCodec.sol";
import {RouteLogic} from "@clprouter/libraries/RouteLogic.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {ThreeLedgerFixture} from "../../helpers/ThreeLedgerFixture.sol";

/// @notice A Connector contract run by a route's sender: it authorises and pays for everything except receipt
///         envelopes, which it refuses (ClprConnectorUnauthorized on `sendMessage`).
contract ReceiptRefusingConnector is IClprConnector {
    function authorizeOutboundMessage(bytes32, bytes calldata, bytes calldata, bytes calldata data)
        external
        view
        returns (bool)
    {
        try this.payloadType(data) returns (uint8 t) {
            return t != uint8(RouteTypes.PayloadType.RECEIPT);
        } catch {
            return true;
        }
    }

    function payloadType(bytes calldata data) external pure returns (uint8) {
        return uint8(RouteCodec.decodeEnvelope(data).payloadType);
    }

    function payForExecution(uint256 amount) external {
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "pay");
    }

    function onInboundMessage(bytes32, uint64, bytes calldata, bytes calldata, bytes calldata) external {}

    receive() external payable {}
}

/// @notice Trust boundary of the Router on three ledgers running the unchanged reference ClprService: which
///         Channels it listens to, and which Connectors can hold a receipt back.
contract RouterTrustBoundaryTest is ThreeLedgerFixture {
    // ═════════════════════════════════════════════════════════════════════
    // Only Channels the provider registry approves carry messages
    // ═════════════════════════════════════════════════════════════════════

    /// @dev A bare ClprService that says it is ledger `id`: stands for a Channel whose verifier accepts anything,
    ///      with any stamped sender. Opening such a Channel is permissionless.
    function _openSide(string memory id) internal returns (Ledger memory l) {
        l.id = id;
        l.service = ClprDeployHelper.deployServiceForTests(address(this), 1, id);
        l.service.initialize(abi.encodePacked(address(l.service)), throttles, "", "", econ);
        l.service.setClprEnabled(true);
    }

    /// @dev An envelope "from A.app on ledger A, routed by A's and B's Routers" arrives at C over a Channel nobody
    ///      approved, whose verifier vouches for B's canonical Router. C refuses it; nothing reaches C.app.
    function test_rejectsMessageFromUnapprovedChannel() public {
        Ledger memory fakeB = _openSide(ID_B);
        bytes32 ch = _channel(fakeB, C, bytes32("unapproved"));
        bytes32 conn = _connector(fakeB, C, ch, bytes32("conn-unapproved"));

        RouteTypes.Envelope memory e;
        e.routeId = bytes16(keccak256("unsent route"));
        e.origin = RouteTypes.Endpoint(ID_A, abi.encodePacked(address(A.app)));
        e.destination = RouteTypes.Endpoint(ID_C, abi.encodePacked(address(C.app)));
        e.sender = Caip.account(ID_A, address(A.app));
        e.recipient = Caip.account(ID_C, address(C.app));
        e.hops = new RouteTypes.Hop[](3);
        e.hops[0] = _hop(A, chAB, connAB, 0, address(0));
        e.hops[1] = _hop(B, ch, conn, 0, address(0));
        e.hops[2] = _hop(C, bytes32(0), bytes32(0), 0, address(0));
        e.hopIndex = 2;
        e.constraints.deadline = uint64(block.timestamp + 1 hours);
        e.payload = "release 1000 units";
        e.routerVersion = 1;
        bytes memory data = RouteCodec.encodeEnvelope(e);

        vm.prank(address(C.service));
        vm.expectRevert(abi.encodeWithSelector(IClprRouter.ChannelNotApproved.selector, ch));
        C.router.onClprMessage(ch, abi.encodePacked(address(B.router)), data);

        vm.prank(address(B.router)); // the Channel's verifier vouches for this sender
        fakeB.service.sendMessage(ch, conn, abi.encodePacked(address(C.router)), data);
        _relay(fakeB, C, ch);
        assertEq(C.app.deliveredCount(), 0, "nothing delivered over an unapproved Channel");
    }

    /// @dev The same Channel id approved with another verifier than the one the receiving Service uses for it
    ///      is refused as well.
    function test_rejectsApprovedChannelWithAnotherVerifier() public {
        _labelAllWith(chAB, B, address(A.service)); // names a contract that is not B's verifier for chAB
        vm.warp(block.timestamp + CERT_NOTICE);
        bytes16 id = _sendAs(alice, _request(0), 0.03 ether);
        bytes memory data = RouteCodec.encodeEnvelope(_lastSent(A, chAB));
        vm.prank(address(B.service));
        vm.expectRevert(abi.encodeWithSelector(IClprRouter.ChannelNotApproved.selector, chAB));
        B.router.onClprMessage(chAB, abi.encodePacked(address(A.router)), data);
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.PENDING));
    }

    /// @dev A sender cannot route over a Channel of its own (not approved): `send` refuses before any value moves.
    function test_sendRejectsUnapprovedChannel() public {
        bytes32 own = _channel(A, B, bytes32("sender-AB"));
        bytes32 connOwn = _connector(A, B, own, bytes32("sender-conn"));
        IClprRouter.SendRequest memory req = _request(1 ether);
        req.hops[0].channelId = own;
        req.hops[0].connectorId = connOwn;
        vm.expectRevert(abi.encodeWithSelector(IClprRouter.RouteBlocked.selector, 0, RouteTypes.Reason.DISABLED_EDGE));
        _sendAs(alice, req, 1.1 ether);
    }

    /// @dev Both directions of every edge must be approved at send: the receipt comes back the other way.
    function test_sendRejectsEdgeWithoutApprovedWayBack() public {
        _apply(A.registry, A_TRUST_TIER, _trustPayload(chBC, ID_B, 255, address(0))); // B <- C label removed on A
        vm.warp(block.timestamp + REMOVAL_NOTICE);
        vm.expectRevert(abi.encodeWithSelector(IClprRouter.RouteBlocked.selector, 1, RouteTypes.Reason.DISABLED_EDGE));
        _sendAs(alice, _request(0), 0.03 ether);
    }

    /// @dev A FAILED receipt for a route that is really delivered, built from the public route and sent "by B's
    ///      Router" over the sender's own Channel, is refused at the origin: the payee is paid on delivery.
    function test_unapprovedChannelCannotSettleRoute() public {
        bytes32 own = _channel(A, B, bytes32("sender-AB"));
        bytes32 connOwn = _connector(A, B, own, bytes32("sender-conn"));
        uint256 before = alice.balance;
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);

        RouteTypes.Envelope memory sent = _lastSent(A, chAB);
        sent.hopIndex = 1;
        RouteTypes.Receipt memory r;
        r.status = RouteTypes.ReceiptStatus.FAILED;
        r.reason = RouteTypes.Reason.NEXT_HOP_ERROR;
        RouteTypes.Hop[] memory back = RouteLogic.reversePrefix(sent.hops, 1);
        back[0].channelId = own;
        back[0].connectorId = connOwn;
        (,, bytes memory receipt) = RouteLogic.buildReceipt(sent, r, ID_B, address(B.router), 1);
        RouteTypes.Envelope memory re = RouteCodec.decodeEnvelope(receipt);
        re.hops = back;
        bytes memory data = RouteCodec.encodeEnvelope(re);

        vm.prank(address(A.service));
        vm.expectRevert(abi.encodeWithSelector(IClprRouter.ChannelNotApproved.selector, own));
        A.router.onClprMessage(own, abi.encodePacked(address(B.router)), data);
        vm.prank(address(B.router));
        B.service.sendMessage(own, connOwn, abi.encodePacked(address(A.router)), data);
        _relay(B, A, own);
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.PENDING), "receipt refused");

        _settle();
        assertEq(C.app.deliveredCount(), 1);
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.DELIVERED));
        assertEq(payee.balance, 1 ether, "payee paid on delivery");
        assertEq(alice.balance, before - 1.1 ether + 0.07 ether, "sender pays escrow and the two hop fees");
    }

    /// @dev Nobody but the canonical Routers, over approved Channels, can use a receipt's replay key at the
    ///      origin: a junk "receipt" with the genuine receipt's id over an unapproved Channel is refused, and the
    ///      genuine DELIVERED receipt then settles the route.
    function test_thirdPartyCannotConsumeReceiptReplayKey() public {
        Ledger memory fakeB = _openSide(ID_B);
        bytes32 ch = _channel(fakeB, A, bytes32("unapproved-A"));
        bytes32 conn = _connector(fakeB, A, ch, bytes32("conn-unapproved-A"));
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);

        RouteTypes.Receipt memory r;
        r.routeId = id;
        r.status = RouteTypes.ReceiptStatus.FAILED;
        r.hopIndex = 1;
        RouteTypes.Envelope memory re;
        re.routeId = bytes16(
            keccak256(
                abi.encode(
                    keccak256("clprouter.v1.receipt"),
                    keccak256(bytes(ID_A)),
                    keccak256(abi.encodePacked(address(A.router))),
                    id,
                    uint256(2)
                )
            )
        );
        re.origin = RouteTypes.Endpoint(ID_C, abi.encodePacked(address(C.router)));
        re.destination = RouteTypes.Endpoint(ID_A, abi.encodePacked(alice));
        re.hops = new RouteTypes.Hop[](3);
        re.hops[0] = _hop(C, chBC, connBC, 0, address(0));
        re.hops[1] = _hop(B, ch, conn, 0, address(0));
        re.hops[2] = _hop(A, bytes32(0), bytes32(0), 0, address(0));
        re.hopIndex = 2;
        re.payloadType = RouteTypes.PayloadType.RECEIPT;
        re.routerVersion = 1;
        re.payload = RouteCodec.encodeReceipt(r);
        bytes memory data = RouteCodec.encodeEnvelope(re);
        vm.prank(address(B.router));
        fakeB.service.sendMessage(ch, conn, abi.encodePacked(address(A.router)), data);
        _relay(fakeB, A, ch);
        bytes32 receiptKey = _key(ID_C, address(C.router), re.routeId);
        assertEq(uint8(A.router.hopState(receiptKey)), uint8(IClprRouter.HopState.NONE), "replay key untouched");

        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.DELIVERED));
        assertEq(payee.balance, 1 ether, "payee paid after delivery");
        vm.warp(block.timestamp + 1 hours + 3 * RECLAIM_GRACE + 1);
        vm.expectRevert(IClprRouter.NotReclaimable.selector);
        A.router.reclaim(id);
    }

    // ═════════════════════════════════════════════════════════════════════
    // No single Connector can hold a receipt back
    // ═════════════════════════════════════════════════════════════════════

    /// @dev The sender names its own Connector for B -> C; it carries the route and refuses the DELIVERED receipt
    ///      on the way back. The receipt waits in C's outbox and anyone sends it over another Connector of the
    ///      same Channel; the origin accepts it (its content does not depend on the Connector) and pays the payee.
    function test_receiptTravelsOverAnyConnectorOfItsChannel() public {
        address cB = address(new ReceiptRefusingConnector());
        address cC = address(new ReceiptRefusingConnector());
        vm.deal(cB, 10 ether);
        vm.deal(cC, 10 ether);
        vm.deal(address(this), address(this).balance + 2 ether);
        bytes32 conn =
            ConnectorRegistrar.register(IClprService(address(B.service)), chBC, "refusing", cB, alice, 1 ether);
        require(
            ConnectorRegistrar.register(IClprService(address(C.service)), chBC, "refusing", cC, alice, 1 ether) == conn
        );

        IClprRouter.SendRequest memory req = _request(1 ether);
        req.hops[1].connectorId = conn;
        bytes16 id = _sendAs(alice, req, 1.1 ether);
        _relay(A, B, chAB);
        (, Vm.Log[] memory logs) = _relayWithLogs(B, C, chBC);
        (bytes32 qc, bytes32 qconn, bytes memory target, bytes memory data) = _queuedReceipt(C, logs);
        assertEq(C.app.deliveredCount(), 1, "destination acted");
        assertEq(qconn, conn, "the route's Connector refused the receipt");
        assertTrue(C.router.outbox(keccak256(abi.encode(qc, target, data))), "receipt queued");

        // Over the refusing Connector it stays queued; over another Connector of the Channel it goes.
        vm.expectRevert();
        C.router.flush(qc, conn, target, data);
        C.router.flush(qc, connBC, target, data);
        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.DELIVERED));
        assertEq(payee.balance, 1 ether, "payee paid after delivery");
    }

    /// @dev A receipt message whose CLPR reply never reached the Router (B refused it, and the Response callback
    ///      on C then failed, e.g. out of gas, which the Service swallows) is put back in the outbox by anyone once
    ///      C's Service has processed that reply; the route then settles.
    function test_receiptWithLostReplyCanBeRequeued() public {
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);
        _relay(A, B, chAB);
        (, Vm.Log[] memory logs) = _relayWithLogs(B, C, chBC);
        assertEq(C.app.deliveredCount(), 1);
        // C's DELIVERED receipt to B: queued inside delivery, then flushed by the pumper as C's last message.
        (,,, bytes memory data) = _queuedReceipt(C, logs);
        uint64 mid = C.service.getChannel(chBC).nextMessageId - 1;

        vm.mockCallRevert(address(B.router), abi.encodeWithSelector(ClprRouter.onClprMessage.selector), "down");
        _relay(C, B, chBC); // B replies APPLICATION_ERROR
        vm.clearMockedCalls();
        vm.expectRevert(IClprRouter.NothingPending.selector);
        C.router.requeue(chBC, mid); // C's Service has not processed that reply yet

        vm.mockCallRevert(address(C.router), abi.encodeWithSelector(ClprRouter.onClprResponse.selector), "no gas");
        _relay(B, C, chBC); // the reply is processed, the callback fails
        vm.clearMockedCalls();
        bytes memory target = abi.encodePacked(address(B.router));
        bytes32 k = keccak256(abi.encode(chBC, target, data));
        assertFalse(C.router.outbox(k), "the Router never learnt of the refusal");
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.PENDING));

        vm.expectEmit(true, false, false, true, address(C.router));
        emit IClprRouter.ReceiptRequeued(k, type(uint8).max);
        C.router.requeue(chBC, mid);
        assertTrue(C.router.outbox(k), "back in the outbox");
        vm.expectRevert(IClprRouter.NothingPending.selector);
        C.router.requeue(chBC, mid); // once only
        C.router.flush(chBC, connBC, target, data);
        _settle();
        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.DELIVERED));
        assertEq(payee.balance, 1 ether);
    }

    // ── helpers ────────────────────────────────────────────────────────────

    /// @dev Label the direction of `ch` into `to` on every ledger, naming `verifier`.
    function _labelAllWith(bytes32 ch, Ledger memory to, address verifier) internal {
        _applyAll(A_TRUST_TIER, _trustPayload(ch, to.id, 0, verifier));
    }

    /// @dev The envelope of the last message `l` queued on `ch`.
    function _lastSent(Ledger memory l, bytes32 ch) internal returns (RouteTypes.Envelope memory) {
        return RouteCodec.decodeEnvelope(
            ClprProtobuf.decodeDataMessage(l.service.getMessage(ch, l.service.getChannel(ch).nextMessageId - 1).payload)
            .messageData
        );
    }

    /// @dev The receipt `l`'s Router queued in `logs` (OutboxQueued).
    function _queuedReceipt(Ledger memory l, Vm.Log[] memory logs)
        internal
        pure
        returns (bytes32 ch, bytes32 conn, bytes memory target, bytes memory data)
    {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(l.router) && logs[i].topics[0] == IClprRouter.OutboxQueued.selector) {
                return abi.decode(logs[i].data, (bytes32, bytes32, bytes, bytes));
            }
        }
        revert("no receipt queued");
    }
}
