// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprRouter} from "@clprouter/ClprRouter.sol";
import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {QuarantineVault} from "@clprouter/QuarantineVault.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {IQuarantineVault} from "@clprouter/interfaces/IQuarantineVault.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {RouteCodec} from "@clprouter/libraries/RouteCodec.sol";
import {RouteLogic} from "@clprouter/libraries/RouteLogic.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {OriginHarness, SecMockService, GasHungryApp, ReturnBomb} from "./RouterAuditBase.sol";

/// @notice Router findings reproduced on single Routers over {SecMockService} (docs/audit/router-findings.md).
///         Each `test_<ID>_...` asserts the SECURE behaviour, so it fails until the finding is fixed.
contract RouterFindingsUnitTest is OriginHarness {
    SecMockService internal svcB;
    ClprRouter internal hopB;
    SecMockService internal svcC;
    ClprRouter internal destC;
    address internal routerAaddr = makeAddr("router-A-remote");
    address internal originApp = makeAddr("origin-app");
    address internal destApp0 = makeAddr("dest-app");
    address internal pA = makeAddr("pA");
    address internal pB = makeAddr("pB");

    function setUp() public {
        vm.warp(1_800_000_000);
        _deployOrigin();
        (svcB, hopB) = _router(ID_B);
        svcB.setPeer(CH_AB, ID_A);
        svcB.setPeer(CH_BC, ID_C);
        (svcC, destC) = _router(ID_C);
        svcC.setPeer(CH_BC, ID_B);
    }

    function _router(string memory id) internal returns (SecMockService s, ClprRouter r) {
        s = new SecMockService(id);
        ProviderRegistry reg = _deployRegistry();
        QuarantineVault v = new QuarantineVault(IProviderRegistry(address(reg)), 3 days, 7 days);
        r = new ClprRouter(
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
        bytes16 id = _inbound(1, address(0)).routeId;
        assertEq(uint8(hopB.hopState(id)), uint8(ClprRouter.HopState.FORWARD_PENDING));

        svcB.setFailChannel(CH_BC, true); // griefer-induced, transient
        vm.prank(makeAddr("griefer"));
        try hopB.forward(held, new RouteTypes.Hop[](0)) {} catch {}

        assertEq(uint8(hopB.hopState(id)), uint8(ClprRouter.HopState.FORWARD_PENDING), "M-02: route failed for good");
    }

    /// @dev Worse for receipts: a pending receipt whose send fails is dropped (ReceiptUndeliverable, DONE).
    ///      A DELIVERED receipt lost this way leaves the origin with only `reclaim`, i.e. a refund to the sender
    ///      after the destination acted, and the sender is the party motivated to cause it.
    function test_M02b_pendingReceipt_survivesTransientSendFailure() public {
        RouteTypes.Envelope memory e = _inbound(2, makeAddr("dest-app"));
        RouteTypes.Receipt memory r;
        r.status = RouteTypes.ReceiptStatus.DELIVERED;
        (bytes16 receiptId,, bytes memory data) = RouteLogic.buildReceipt(e, r, ID_C, address(destC), 1);
        // The receipt arrives at B (its hop 1) from C's Router over CH_BC.
        svcB.setGuard(true);
        svcB.deliver(hopB, CH_BC, abi.encodePacked(address(destC)), data);
        assertEq(uint8(hopB.hopState(receiptId)), uint8(ClprRouter.HopState.FORWARD_PENDING));
        bytes memory held = data; // the envelope as held on B

        svcB.setFailChannel(CH_AB, true);
        try hopB.forward(held, new RouteTypes.Hop[](0)) {} catch {}
        svcB.setFailChannel(CH_AB, false);
        try hopB.forward(held, new RouteTypes.Hop[](0)) {} catch {}

        assertEq(svcB.sentCount(), 1, "M-02: DELIVERED receipt dropped by a transient send failure");
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
        bytes16 id = _inbound(2, address(0)).routeId;

        // Sanity: with enough gas the application accepts the message.
        uint256 s0 = vm.snapshotState();
        svcC.deliverWithGas(destC, CH_BC, abi.encodePacked(address(hopB)), data, 5_000_000);
        assertEq(app.accepted(), 1);
        vm.revertToState(s0);

        uint256 badGas;
        for (uint256 g = 100_000; g <= 1_500_000; g += 5_000) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = svcC.deliverWithGas(destC, CH_BC, abi.encodePacked(address(hopB)), data, g);
            bool wronglyFailed = ok && app.accepted() == 0 && destC.hopState(id) == ClprRouter.HopState.DONE;
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

    /// @dev Protobuf merges a repeated embedded singular message; the Solidity codec replaces it. An envelope
    ///      with two `constraints` fields decodes to different routes on-chain and in protobuf-based tooling.
    function test_L02b_duplicateEmbeddedMessage_mergesLikeProtobuf() public view {
        // constraints { loose: true } appended after the canonical constraints { deadline, budget }
        bytes memory b = bytes.concat(_canonical(), hex"4a023801");
        RouteTypes.Envelope memory e = RouteCodec.decodeEnvelope(b);
        assertTrue(e.constraints.loose);
        assertEq(e.constraints.deadline, uint64(block.timestamp + 1 hours), "L-02: deadline lost on merge");
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

        ClprRouter.SendRequest memory req = _req(0, address(0), 1, makeAddr("p0"), 1, makeAddr("p1"));
        req.destination = RouteTypes.Endpoint(ID_C, abi.encodePacked(badApp));
        req.recipient = Caip.account(ID_C, makeAddr("innocent-label"));
        address s = makeAddr("sender");
        vm.deal(s, 1 ether);
        vm.prank(s);
        bytes16 id = routerA.send{value: 2}(req);
        assertEq(uint8(_status(id)), uint8(ClprRouter.RouteStatus.QUARANTINED), "L-03: sent to a blacklisted app");
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
        ClprRouter.SendRequest memory req;
        req.hops = new RouteTypes.Hop[](n);
        for (uint256 i = 0; i < n; i++) {
            string memory id = i == 0 ? ID_A : string.concat("eip155:4", vm.toString(i));
            address r = i == 0 ? address(routerA) : makeAddr(string.concat("r", vm.toString(i)));
            bytes32 ch = i == 0 ? CH_AB : (i + 1 < n ? keccak256(abi.encode(i)) : bytes32(0));
            req.hops[i] = _hop(id, r, ch, i + 1 < n ? 1 : 0, i + 1 < n ? address(new ReturnBomb(BOMB)) : address(0));
        }
        req.hops[1].ledgerId = ID_B;
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
        assertEq(uint8(_status(id)), uint8(ClprRouter.RouteStatus.DELIVERED));
    }
}
