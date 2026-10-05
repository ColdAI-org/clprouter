// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprRouter} from "@clprouter/ClprRouter.sol";
import {IClprRouter} from "@clprouter/interfaces/IClprRouter.sol";
import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {QuarantineVault} from "@clprouter/QuarantineVault.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {IQuarantineVault} from "@clprouter/interfaces/IQuarantineVault.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {RouteCodec} from "@clprouter/libraries/RouteCodec.sol";
import {RouteLogic} from "@clprouter/libraries/RouteLogic.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {Vm} from "forge-std/Vm.sol";
import {OriginHarness, SecMockService, GasHungryApp, ReturnBomb, ResponseBomb} from "./RouterAuditBase.sol";

/// @notice Router findings reproduced on single Routers over {SecMockService} (docs/audit/router-findings.md).
///         Regression tests: each `test_<ID>_...` asserts the secure behaviour of the fixed Router.
contract RouterFindingsUnitTest is OriginHarness {
    SecMockService internal svcB;
    ClprRouter internal hopB;
    SecMockService internal svcC;
    ClprRouter internal destC;
    address internal routerAaddr; // = routerA: hops must name canonical Routers
    address internal originApp = makeAddr("origin-app");
    address internal destApp0 = makeAddr("dest-app");
    address internal pA = makeAddr("pA");
    address internal pB = makeAddr("pB");

    function setUp() public {
        vm.warp(1_800_000_000);
        _deployOrigin();
        routerAaddr = address(routerA);
        (svcB, hopB) = _router(ID_B);
        svcB.setPeer(CH_AB, ID_A);
        svcB.setPeer(CH_BC, ID_C);
        (svcC, destC) = _router(ID_C);
        svcC.setPeer(CH_BC, ID_B);
    }

    function _router(string memory id) internal returns (SecMockService s, ClprRouter r) {
        s = new SecMockService(id);
        ProviderRegistry reg = _deployRegistry();
        _approveBoth(reg, CH_AB, ID_A, ID_B, address(s));
        _approveBoth(reg, CH_BC, ID_B, ID_C, address(s));
        vm.warp(block.timestamp + CERT_NOTICE);
        QuarantineVault v = new QuarantineVault(IProviderRegistry(address(reg)), 3 days, 7 days);
        r = _deployRouter(
            IClprService(address(s)),
            IProviderRegistry(address(reg)),
            IQuarantineVault(address(v)),
            id,
            GRACE,
            APP_GAS_,
            MIN_SEND_GAS_
        );
    }

    /// @dev A strict A -> B -> C envelope as it arrives at hop `idx` (B = hopB, C = destC).
    function _inbound(uint32 idx, address destApp) internal view returns (RouteTypes.Envelope memory e) {
        e.routeId = bytes16(keccak256("route-x"));
        e.origin = RouteTypes.Endpoint(ID_A, abi.encodePacked(originApp));
        e.destination = RouteTypes.Endpoint(ID_C, abi.encodePacked(destApp));
        e.sender = Caip.account(ID_A, originApp);
        e.recipient = Caip.account(ID_C, destApp);
        e.hops = new RouteTypes.Hop[](3);
        e.hops[0] = _hop(ID_A, routerAaddr, CH_AB, 10, pA);
        e.hops[1] = _hop(ID_B, address(hopB), CH_BC, 20, pB);
        e.hops[2] = _hop(ID_C, address(destC), bytes32(0), 0, address(0));
        e.hopIndex = idx;
        e.constraints.deadline = uint64(block.timestamp + 1 hours);
        e.constraints.remainingFeeBudget = idx == 1 ? 20 : 0;
        e.payload = "data";
        e.routerVersion = 1;
    }

    // ═════════════════════════════════════════════════════════════════════
    // M-02  forward() turns a transient sendMessage revert into a final outcome
    // ═════════════════════════════════════════════════════════════════════

    /// @dev On the reference ClprService every hop goes through forward(). Anyone may call it, at a moment of
    ///      their choosing: e.g. right after filling the Connector's queue quota (ClprQueueQuotaExceeded) or the
    ///      Channel queue (ClprQueueFull) in the same transaction. A strict route then fails for good.
    function test_M02_forwardDuringTransientSendFailure_keepsHopPending() public {
        svcB.setGuard(true);
        bytes memory held = RouteCodec.encodeEnvelope(_inbound(1, destApp0));
        svcB.deliver(hopB, CH_AB, abi.encodePacked(routerAaddr), held);
        bytes32 key = _key(ID_A, routerAaddr, _inbound(1, address(0)).routeId);
        assertEq(uint8(hopB.hopState(key)), uint8(IClprRouter.HopState.FORWARD_PENDING));

        svcB.setFailChannel(CH_BC, true); // griefer-induced, transient (ClprQueueFull)
        vm.prank(makeAddr("griefer"));
        vm.expectRevert(abi.encodeWithSignature("ClprQueueFull()"));
        hopB.forward(held, new RouteTypes.Hop[](0));
        assertEq(uint8(hopB.hopState(key)), uint8(IClprRouter.HopState.FORWARD_PENDING), "M-02: route failed for good");
        assertEq(hopB.pendingHash(key), keccak256(held));

        // Once the queue drains, anyone completes the hop.
        svcB.setFailChannel(CH_BC, false);
        hopB.forward(held, new RouteTypes.Hop[](0));
        assertEq(uint8(hopB.hopState(key)), uint8(IClprRouter.HopState.FORWARDED));
    }

    /// @dev Inside delivery a transient failure defers the hop (it never becomes SEND_FAILED).
    function test_M02c_transientFailureInsideDelivery_defers() public {
        svcB.setFailChannel(CH_BC, true);
        bytes memory held = RouteCodec.encodeEnvelope(_inbound(1, destApp0));
        bytes memory resp = svcB.deliver(hopB, CH_AB, abi.encodePacked(routerAaddr), held);
        assertEq(resp, abi.encodePacked(uint8(1), uint8(0)), "accepted, not rejected");
        bytes32 key = _key(ID_A, routerAaddr, _inbound(1, address(0)).routeId);
        assertEq(uint8(hopB.hopState(key)), uint8(IClprRouter.HopState.FORWARD_PENDING));
        assertEq(svcB.sentCount(), 0, "no FAILED receipt");
    }

    /// @dev Worse for receipts: a pending receipt whose send fails is dropped (ReceiptUndeliverable, DONE).
    ///      A DELIVERED receipt lost this way leaves the origin with only `reclaim`, i.e. a refund to the sender
    ///      after the destination acted, and the sender is the party motivated to cause it.
    function test_M02b_pendingReceipt_survivesTransientSendFailure() public {
        RouteTypes.Envelope memory e = _inbound(2, makeAddr("dest-app"));
        RouteTypes.Receipt memory r;
        r.status = RouteTypes.ReceiptStatus.DELIVERED;
        (,, bytes memory data) = RouteLogic.buildReceipt(e, r, ID_C, address(destC), 1);
        // The receipt arrives at B (its hop 1) from C's Router over CH_BC; the guard defers it to the outbox.
        svcB.setGuard(true);
        vm.recordLogs();
        svcB.deliver(hopB, CH_BC, abi.encodePacked(address(destC)), data);
        (bytes32 ch, bytes32 conn, bytes memory target, bytes memory out) = _queued(vm.getRecordedLogs());
        assertTrue(hopB.outbox(keccak256(abi.encode(ch, conn, target, out))));

        svcB.setFailChannel(CH_AB, true);
        try hopB.flush(ch, conn, target, out) {} catch {}
        assertEq(svcB.sentCount(), 0);
        assertTrue(hopB.outbox(keccak256(abi.encode(ch, conn, target, out))), "still queued");
        svcB.setFailChannel(CH_AB, false);
        hopB.flush(ch, conn, target, out);

        assertEq(svcB.sentCount(), 1, "M-02: DELIVERED receipt dropped by a transient send failure");
    }

    function _queued(Vm.Log[] memory logs)
        internal
        pure
        returns (bytes32 ch, bytes32 conn, bytes memory target, bytes memory data)
    {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == IClprRouter.OutboxQueued.selector) {
                (ch, conn, target, data) = abi.decode(logs[i].data, (bytes32, bytes32, bytes, bytes));
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // NF-01 (checked, not a finding) Under-gassed destination delivery
    // ═════════════════════════════════════════════════════════════════════

    /// @dev Regression guard (passes today). `_deliver` calls the application with `{gas: APP_GAS}` without
    ///      checking that APP_GAS is left. Swept over every delivery gas limit from 100k to 1.5M: whenever the
    ///      application call is starved, the 1/64 the Router keeps is too little to build the receipt, so the
    ///      whole delivery reverts instead of returning a final APPLICATION_ERROR. Keep it that way, or add an
    ///      explicit `gasleft() >= APP_GAS + margin` check.
    function test_NF01_underGassedDelivery_neverReturnsNormallyWithAppError() public {
        GasHungryApp app = new GasHungryApp(address(destC), 150_000); // needs half of APP_GAS
        svcC.setGuard(true);
        bytes memory data = RouteCodec.encodeEnvelope(_inbound(2, address(app)));
        bytes32 id = _key(ID_A, routerAaddr, _inbound(2, address(0)).routeId);

        // Sanity: with enough gas the application accepts the message.
        uint256 s0 = vm.snapshotState();
        svcC.deliverWithGas(destC, CH_BC, abi.encodePacked(address(hopB)), data, 5_000_000);
        assertEq(app.accepted(), 1);
        vm.revertToState(s0);

        uint256 badGas;
        for (uint256 g = 100_000; g <= 1_500_000; g += 5_000) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = svcC.deliverWithGas(destC, CH_BC, abi.encodePacked(address(hopB)), data, g);
            bool wronglyFailed = ok && app.accepted() == 0 && destC.hopState(id) == IClprRouter.HopState.DONE;
            vm.revertToState(snap);
            if (wronglyFailed) {
                badGas = g;
                break;
            }
        }
        assertEq(badGas, 0, "delivery with this gas limit stopped the route with APPLICATION_ERROR");
    }

    // ═════════════════════════════════════════════════════════════════════
    // L-02  The codec accepts non-canonical encodings
    // ═════════════════════════════════════════════════════════════════════

    function _canonical() internal view returns (bytes memory) {
        return RouteCodec.encodeEnvelope(_inbound(1, destApp0));
    }

    /// @dev An over-long varint (0x81 0x00 = 1) for a field already present is accepted and overrides it.
    function test_L02_decodeRejectsOverlongVarint() public {
        bytes memory b = bytes.concat(_canonical(), hex"388100"); // hop_index = 1, encoded in two bytes
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        this.decodeExt(b);
    }

    /// @dev Protobuf merges a repeated embedded singular message; the old codec replaced it, so tooling and chain
    ///      could read different envelopes. The codec now rejects any repeated singular field (and anything
    ///      else that is not the canonical encoding).
    function test_L02b_duplicateEmbeddedMessage_isRejected() public {
        // constraints { loose: true } appended after the canonical constraints { deadline, budget }
        bytes memory b = bytes.concat(_canonical(), hex"4a023801");
        vm.expectRevert(RouteCodec.MalformedProtobuf.selector);
        this.decodeExt(b);
    }

    /// @dev Every accepted encoding is canonical: re-encoding gives back the same bytes.
    function test_L02c_acceptedBytes_reEncodeIdentically() public view {
        bytes memory b = _canonical();
        assertEq(RouteCodec.encodeEnvelope(this.decodeExt(b)), b);
    }

    function decodeExt(bytes calldata b) external pure returns (RouteTypes.Envelope memory) {
        return RouteCodec.decodeEnvelope(b);
    }

    // ═════════════════════════════════════════════════════════════════════
    // L-03  Blacklist never looks at the destination application
    // ═════════════════════════════════════════════════════════════════════

    /// @dev The origin checks the sender, the payee and the free-form `recipient` string. The destination
    ///      application, which actually receives the message, is not checked, and `recipient` need not name it.
    function test_L03_blacklistedDestinationApp_isQuarantined() public {
        address badApp = makeAddr("blacklisted-app");
        _apply(regA, A_BLACKLIST, _blacklistPayload(Caip.account(ID_C, badApp), keccak256("case")));

        IClprRouter.SendRequest memory req = _req(0, address(0), 1, makeAddr("p0"), 1, makeAddr("p1"));
        req.destination = RouteTypes.Endpoint(ID_C, abi.encodePacked(badApp));
        req.recipient = Caip.account(ID_C, makeAddr("innocent-label"));
        address s = makeAddr("sender");
        vm.deal(s, 1 ether);
        vm.prank(s);
        bytes16 id = routerA.send{value: 2}(req);
        assertEq(uint8(_status(id)), uint8(IClprRouter.RouteStatus.QUARANTINED), "L-03: sent to a blacklisted app");
    }

    // ═════════════════════════════════════════════════════════════════════
    // M-05  Payment return data is copied: return bombs push settlement past the CLPR gas limit
    // ═════════════════════════════════════════════════════════════════════

    /// @dev `_pay` uses `(bool ok,) = to.call{value, gas: 30_000}("")`, which still copies the callee's return
    ///      data into the Router's memory. The sender picks every fee payee, the payee and itself; each can
    ///      return ~106 KB within its 30,000 gas (+2,300 stipend). Memory grows across the ten payments, and the
    ///      settlement of a DELIVERED receipt on an 8-edge route needs ~3.02M gas (497k without bombs), more
    ///      than the CLPR per-message gas limit (3,000,000 in the test fixture). The receipt delivery reverts,
    ///      the CLPR message is consumed with APPLICATION_ERROR, and the sender later reclaims the escrow.
    uint256 internal BOMB = 106_000;

    function test_M05_returnBombs_doNotBreakSettlementUnder3MGas() public {
        uint256 n = 9; // 8 edges, the absolute maximum
        ReturnBomb sender = new ReturnBomb(BOMB);
        vm.deal(address(sender), 10 ether);
        IClprRouter.SendRequest memory req;
        req.hops = new RouteTypes.Hop[](n);
        for (uint256 i = 0; i < n; i++) {
            string memory id = i == 0 ? ID_A : string.concat("eip155:4", vm.toString(i));
            address r =
                i == 0 ? address(routerA) : _routerAddr(i == 1 ? ID_B : string.concat("eip155:4", vm.toString(i)));
            bytes32 ch = i == 0 ? CH_AB : (i + 1 < n ? keccak256(abi.encode(i)) : bytes32(0));
            req.hops[i] = _hop(id, r, ch, i + 1 < n ? 1 : 0, i + 1 < n ? address(new ReturnBomb(BOMB)) : address(0));
        }
        req.hops[1].ledgerId = ID_B;
        for (uint256 i = 1; i + 1 < n; i++) {
            _approveBoth(regA, req.hops[i].channelId, req.hops[i].ledgerId, req.hops[i + 1].ledgerId, address(svcA));
        }
        vm.warp(block.timestamp + CERT_NOTICE);
        req.destination = RouteTypes.Endpoint(req.hops[n - 1].ledgerId, abi.encodePacked(makeAddr("dest")));
        req.recipient = "x";
        req.constraints.deadline = uint64(block.timestamp + 1 hours);
        req.constraints.maxHops = 8;
        req.escrow = 1 ether;
        req.payee = address(new ReturnBomb(BOMB));
        bytes16 id = sender.sendRoute{value: 1 ether + 100}(routerA, req);

        RouteTypes.Envelope memory sent = RouteCodec.decodeEnvelope(svcA.sent(0).data);
        bytes memory rec = _receiptAtOrigin(sent, n - 1, RouteTypes.ReceiptStatus.DELIVERED, RouteTypes.Reason.NONE, 0);
        uint256 g0 = gasleft();
        (bool ok,) = svcA.deliverWithGas(routerA, CH_AB, sent.hops[1].router, rec, 3_000_000);
        emit log_named_uint("settlement gas with return bombs", g0 - gasleft());
        assertTrue(ok, "M-05: settlement ran out of 3M gas, receipt lost");
        assertEq(uint8(_status(id)), uint8(IClprRouter.RouteStatus.DELIVERED));
    }

    /// @dev I-06 / M-05: a destination application's response is copied and hashed only up to MAX_RESPONSE bytes,
    ///      so a huge response neither breaks delivery nor costs the Router more than a bounded copy.
    function test_M05b_destinationResponseBomb_isBounded() public {
        ResponseBomb app = new ResponseBomb(150_000);
        bytes memory data = RouteCodec.encodeEnvelope(_inbound(2, address(app)));
        uint256 g0 = gasleft();
        (bool ok,) = svcC.deliverWithGas(destC, CH_BC, abi.encodePacked(address(hopB)), data, 3_000_000);
        uint256 used = g0 - gasleft();
        emit log_named_uint("delivery gas with a 150 KB response", used);
        assertTrue(ok);
        RouteTypes.Envelope memory re = RouteCodec.decodeEnvelope(svcC.sent(0).data);
        RouteTypes.Receipt memory r = RouteCodec.decodeReceipt(re.payload);
        assertEq(uint8(r.status), uint8(RouteTypes.ReceiptStatus.DELIVERED));
        // The bomb's data starts at its memory offset 0x40, which holds Solidity's free-memory pointer (0x80).
        bytes memory head = bytes.concat(bytes32(uint256(0x80)), new bytes(destC.MAX_RESPONSE() - 32));
        assertEq(r.responseHash, keccak256(head), "hash of the first MAX_RESPONSE bytes");
    }
}
