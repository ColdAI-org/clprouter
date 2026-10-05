// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ClprRouter} from "@clprouter/ClprRouter.sol";
import {IClprRouter} from "@clprouter/interfaces/IClprRouter.sol";
import {QuarantineVault} from "@clprouter/QuarantineVault.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {RouteCodec} from "@clprouter/libraries/RouteCodec.sol";
import {RouteLogic} from "@clprouter/libraries/RouteLogic.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {OriginHarness, SecMockService, RejectingReceiver} from "./RouterAuditBase.sol";

/// @notice Drives one origin Router: sends, honest receipts, forged receipts, CLPR responses, reclaims,
///         withdrawals and junk calls, and records any violation of the properties in ghost flags.
contract OriginHandler is Test {
    struct Route {
        bytes16 id;
        bytes wire; // the envelope as the origin sent it
        uint64 messageId;
        bool loose;
    }

    ClprRouter public router;
    SecMockService public svc;
    address public routerB;
    address public routerC;
    address[] public senders;
    address[] public payees;
    address[] public feePayees;
    bytes32 internal constant CH_AB = keccak256("AB");
    /// @dev A Channel to B that the Service knows but the provider registry never approved.
    bytes32 internal constant CH_UNAPPROVED = keccak256("AB-unapproved");
    bytes32 internal constant CONN = keccak256("connector");

    Route[] internal _routes;
    mapping(bytes16 => uint8) public terminal; // first terminal status seen (0 = still pending / unknown)

    // ghost flags
    bool public doubleSettle;
    bool public forgedAccepted;
    bool public revertChanged;
    bool public honestIgnored;
    bool public unapprovedAccepted;
    uint256 public unapprovedTried;
    uint256 public calls;
    uint256 public settled; // routes that reached a terminal status (coverage)
    uint256 public forgedTried;

    constructor(
        ClprRouter r,
        SecMockService s,
        address b,
        address c,
        address[] memory s_,
        address[] memory p_,
        address[] memory f_
    ) {
        router = r;
        svc = s;
        routerB = b;
        routerC = c;
        senders = s_;
        payees = p_;
        feePayees = f_;
    }

    function routeCount() external view returns (uint256) {
        return _routes.length;
    }

    function routeId(uint256 i) external view returns (bytes16) {
        return _routes[i].id;
    }

    function _status(bytes16 id) internal view returns (IClprRouter.RouteStatus s) {
        (,, s,,,,,,,,,,,) = router.routes(id);
    }

    /// @dev After every action: a route that reached a terminal status never changes again.
    function _sweep() internal {
        calls++;
        for (uint256 i = 0; i < _routes.length; i++) {
            bytes16 id = _routes[i].id;
            uint8 s = uint8(_status(id));
            if (s == uint8(IClprRouter.RouteStatus.PENDING)) {
                if (terminal[id] != 0) doubleSettle = true;
            } else if (terminal[id] == 0) {
                terminal[id] = s;
                settled++;
            } else if (terminal[id] != s) {
                doubleSettle = true;
            }
        }
    }

    function _fingerprint() internal view returns (bytes32 f) {
        f = keccak256(abi.encode(address(router).balance, svc.sentCount()));
        for (uint256 i = 0; i < _routes.length; i++) {
            f = keccak256(abi.encode(f, _status(_routes[i].id), router.hopState(_routes[i].id)));
        }
        for (uint256 i = 0; i < payees.length; i++) {
            f = keccak256(abi.encode(f, router.owed(payees[i]), router.owed(feePayees[i])));
        }
    }

    // ── actions ────────────────────────────────────────────────────────────

    function send(uint256 who, uint256 payeeIdx, uint256 escrow, uint64 f0, uint64 f1, uint64 extra, uint8 mode)
        external
    {
        address sender = senders[who % senders.length];
        bool loose = mode % 4 == 0;
        IClprRouter.SendRequest memory req;
        req.destination = RouteTypes.Endpoint("eip155:31003", abi.encodePacked(address(0xDE57)));
        req.recipient = Caip.account("eip155:31003", address(0xDE57));
        f0 = loose ? 0 : uint64(bound(f0, 0, 1 ether));
        f1 = loose ? 0 : uint64(bound(f1, 0, 1 ether));
        extra = loose ? 0 : uint64(bound(extra, 0, 1 ether));
        escrow = loose ? 0 : bound(escrow, 0, 5 ether);
        req.hops = new RouteTypes.Hop[](3);
        req.hops[0] = RouteTypes.Hop(
            "eip155:31001",
            abi.encodePacked(address(router)),
            CH_AB,
            CONN,
            f0,
            abi.encodePacked(feePayees[payeeIdx % feePayees.length])
        );
        req.hops[1] = RouteTypes.Hop(
            "eip155:31002",
            abi.encodePacked(routerB),
            keccak256("BC"),
            CONN,
            f1,
            abi.encodePacked(feePayees[(payeeIdx + 1) % feePayees.length])
        );
        req.hops[2] = RouteTypes.Hop("eip155:31003", abi.encodePacked(routerC), 0, 0, 0, "");
        req.constraints.deadline = uint64(block.timestamp + 1 hours);
        req.constraints.loose = loose;
        req.payload = "p";
        req.escrow = escrow;
        if (escrow > 0 || mode % 3 == 0) req.payee = payees[payeeIdx % payees.length];
        uint256 value = escrow + f0 + f1 + extra;
        if (sender.balance < value) return;

        uint256 before = svc.sentCount();
        vm.prank(sender);
        bytes16 id = router.send{value: value}(req);
        bytes memory wire = svc.sentCount() > before ? svc.sent(before).data : bytes("");
        _routes.push(Route(id, wire, svc.sentCount() > before ? svc.lastId() : 0, loose));
        _sweep();
    }

    function _receipt(Route storage r, uint256 k, uint8 statusSeed)
        internal
        view
        returns (bytes memory data, RouteTypes.ReceiptStatus st)
    {
        RouteTypes.Envelope memory e = RouteCodec.decodeEnvelope(r.wire);
        e.hopIndex = uint32(k);
        RouteTypes.Receipt memory rc;
        if (k == 2 && statusSeed % 2 == 0) st = RouteTypes.ReceiptStatus.DELIVERED;
        else st = RouteTypes.ReceiptStatus(2 + statusSeed % 3); // FAILED, EXPIRED, QUARANTINED
        rc.status = st;
        rc.reason = st == RouteTypes.ReceiptStatus.DELIVERED ? RouteTypes.Reason.NONE : RouteTypes.Reason.DEADLINE;
        if (st == RouteTypes.ReceiptStatus.QUARANTINED) {
            rc.caseId = keccak256("case");
            rc.contact = "c";
        }
        (,, bytes memory out) =
            RouteLogic.buildReceipt(e, rc, e.hops[k].ledgerId, address(bytes20(e.hops[k].router)), 1);
        RouteTypes.Envelope memory re = RouteCodec.decodeEnvelope(out);
        re.hopIndex = uint32(re.hops.length - 1);
        data = RouteCodec.encodeEnvelope(re);
    }

    function honestReceipt(uint256 idx, uint256 kSeed, uint8 statusSeed) external {
        if (_routes.length == 0) return;
        Route storage r = _routes[idx % _routes.length];
        if (r.wire.length == 0) return;
        uint256 k = 1 + kSeed % 2;
        (bytes memory data,) = _receipt(r, k, statusSeed);
        bool wasPending = _status(r.id) == IClprRouter.RouteStatus.PENDING;
        try svc.deliver(router, CH_AB, abi.encodePacked(routerB), data) {
            if (wasPending && _status(r.id) == IClprRouter.RouteStatus.PENDING) honestIgnored = true;
        } catch {
            // Only an exact replay of an earlier receipt (same receipt id) may be refused.
        }
        _sweep();
    }

    function forgedReceipt(uint256 idx, uint256 kSeed, uint8 statusSeed, uint8 mutation, bytes32 junk) external {
        // Prefer a pending strict route (forging against a settled one proves little).
        uint256 n = _routes.length;
        uint256 pick = type(uint256).max;
        for (uint256 j = 0; j < n; j++) {
            Route storage c = _routes[(idx + j) % n];
            if (c.wire.length != 0 && !c.loose && _status(c.id) == IClprRouter.RouteStatus.PENDING) {
                pick = (idx + j) % n;
                break;
            }
        }
        // Loose routes are excluded: they keep no hop commitment, so a receipt the canonical first-hop Router relays
        // is taken as is. Third parties cannot inject one any more (M-03: every Router on the way is canonical).
        if (pick == type(uint256).max) return;
        Route storage r = _routes[pick];
        uint256 k = 1 + kSeed % 2;
        (bytes memory data,) = _receipt(r, k, statusSeed);
        RouteTypes.Envelope memory re = RouteCodec.decodeEnvelope(data);
        RouteTypes.Receipt memory rc = RouteCodec.decodeReceipt(re.payload);
        if (junk == bytes32(0)) junk = keccak256("junk");
        uint8 m = mutation % 7;
        if (m == 0) rc.routeEdge = junk;
        else if (m == 1) rc.routeRest = junk;
        else if (m == 2) rc.hopIndex = uint32(k == 1 ? 2 : 1);
        else if (m == 3) re.hops[re.hops.length - 2].fee += 1; // claim a different fee for hop 0
        else if (m == 4) re.origin.application = abi.encodePacked(address(uint160(uint256(junk))));
        else if (m == 5) re.hops[0].feePayee = abi.encodePacked(address(uint160(uint256(junk))));
        else rc.status = RouteTypes.ReceiptStatus.DELIVERED; // from hop 1, or with a non-zero rest
        if (m == 6 && k == 2) rc.routeRest = junk;
        re.payload = RouteCodec.encodeReceipt(rc);
        re.routeId = bytes16(junk); // fresh receipt id
        bytes memory forged = RouteCodec.encodeEnvelope(re);

        forgedTried++;
        IClprRouter.RouteStatus before = _status(r.id);
        uint256 bal = address(router).balance;
        try svc.deliver(router, CH_AB, abi.encodePacked(routerB), forged) {} catch {}
        if (_status(r.id) != before || address(router).balance != bal) forgedAccepted = true;
        _sweep();
    }

    /// @dev A receipt that is honest in every respect except the Channel it arrives over, which the registry never
    ///      approved (its peer is B, and the Service stamps B's canonical Router as sender). It must be refused
    ///      before anything is recorded: no settlement, no replay key, no held count, no balance change.
    function overUnapprovedChannel(uint256 idx, uint256 kSeed, uint8 statusSeed) external {
        if (_routes.length == 0) return;
        Route storage r = _routes[idx % _routes.length];
        if (r.wire.length == 0) return;
        (bytes memory data,) = _receipt(r, 1 + kSeed % 2, statusSeed);
        RouteTypes.Envelope memory re = RouteCodec.decodeEnvelope(data);
        re.hops[re.hopIndex - 1].channelId = CH_UNAPPROVED;
        bytes memory moved = RouteCodec.encodeEnvelope(re);
        bytes32 key = RouteLogic.inboundKey(re);
        (,,,,, uint8 heldBefore,,,,,,,,) = router.routes(r.id);
        IClprRouter.HopState keyBefore = router.hopState(key);
        bytes32 f = _fingerprint();
        unapprovedTried++;
        try svc.deliver(router, CH_UNAPPROVED, abi.encodePacked(routerB), moved) {
            unapprovedAccepted = true;
        } catch {}
        (,,,,, uint8 heldAfter,,,,,,,,) = router.routes(r.id);
        if (_fingerprint() != f || router.hopState(key) != keyBefore || heldAfter != heldBefore) {
            unapprovedAccepted = true;
        }
        _sweep();
    }

    function respond(uint256 idx, bool ok) external {
        if (_routes.length == 0) return;
        Route storage r = _routes[idx % _routes.length];
        if (r.messageId == 0) return;
        svc.respond(router, CH_AB, r.messageId, ok ? 0 : 1);
        _sweep();
    }

    function reclaim(uint256 idx, uint256 dt) external {
        if (_routes.length == 0) return;
        vm.warp(block.timestamp + bound(dt, 0, 3 hours));
        Route storage r = _routes[idx % _routes.length];
        bytes32 f = _fingerprint();
        try router.reclaim(r.id) {}
        catch {
            if (_fingerprint() != f) revertChanged = true;
        }
        _sweep();
    }

    function withdraw(uint256 who) external {
        address a = who % 2 == 0 ? payees[who / 2 % payees.length] : feePayees[who / 2 % feePayees.length];
        bytes32 f = _fingerprint();
        vm.prank(a);
        try router.withdraw() {}
        catch {
            if (_fingerprint() != f) revertChanged = true;
        }
        _sweep();
    }

    /// @dev Calls that must revert, and must leave no trace when they do.
    function junkCalls(bytes calldata blob, bytes32 x, uint256 idx) external {
        bytes32 f = _fingerprint();
        try router.forward(blob, new RouteTypes.Hop[](0)) {} catch {}
        try router.flush(x, x, blob, blob) {} catch {}
        try router.onClprMessage(CH_AB, abi.encodePacked(routerB), blob) {} catch {}
        try router.onClprResponse(CH_AB, uint64(uint256(x)), 1, "") {} catch {}
        if (_routes.length > 0) {
            Route storage r = _routes[idx % _routes.length];
            // exact replay of the route's own envelope into its origin
            try svc.deliver(router, CH_AB, abi.encodePacked(routerB), r.wire) {} catch {}
        }
        if (_fingerprint() != f) revertChanged = true;
        _sweep();
    }
}

/// @notice Invariants of the origin Router (docs/audit/router-findings.md):
///         escrow conservation, solvency, settle-at-most-once, receipts only from the stored hop commitment,
///         no state change on reverted paths, and only approved Channels carry messages.
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 60
contract RouterInvariantsTest is StdInvariant, OriginHarness {
    OriginHandler internal handler;
    address[] internal actors;
    uint256 internal total;

    function setUp() public {
        vm.warp(1_800_000_000);
        _deployOrigin();
        svcA.setPeer(keccak256("AB-unapproved"), ID_B); // known to the Service, never approved

        address[] memory s = new address[](4);
        address[] memory p = new address[](3);
        address[] memory f = new address[](3);
        for (uint256 i = 0; i < 4; i++) {
            s[i] = address(uint160(0x5E00 + i));
            vm.deal(s[i], 100 ether);
        }
        p[0] = address(uint160(0xBA00));
        p[1] = address(uint160(0xBA01));
        p[2] = address(new RejectingReceiver());
        f[0] = address(uint160(0xFE00));
        f[1] = address(uint160(0xFE01));
        f[2] = address(new RejectingReceiver());
        // Sender 3 is blacklisted: its routes are quarantined at send.
        _apply(regA, A_BLACKLIST, _blacklistPayload(Caip.account(ID_A, s[3]), keccak256("case-s3")));

        handler = new OriginHandler(routerA, svcA, routerB, routerC, s, p, f);
        for (uint256 i = 0; i < 4; i++) {
            actors.push(s[i]);
        }
        for (uint256 i = 0; i < 3; i++) {
            actors.push(p[i]);
            actors.push(f[i]);
        }
        total = _held();
        targetContract(address(handler));
    }

    function _held() internal view returns (uint256 sum) {
        sum = address(routerA).balance + address(vaultA).balance;
        for (uint256 i = 0; i < actors.length; i++) {
            sum += actors[i].balance;
        }
    }

    /// @notice Funds in = paid out + refunded + quarantined + held: nothing is created or lost.
    function invariant_escrowConservation() public view {
        assertEq(_held(), total);
    }

    /// @notice The Router holds exactly the escrow + fee budget of its pending routes plus what it owes.
    function invariant_routerSolvent() public view {
        uint256 need;
        for (uint256 i = 0; i < handler.routeCount(); i++) {
            (,, IClprRouter.RouteStatus st,,,,, uint64 budget,,, uint256 escrow,,,) = routerA.routes(handler.routeId(i));
            if (st == IClprRouter.RouteStatus.PENDING) need += escrow + budget;
        }
        for (uint256 i = 0; i < actors.length; i++) {
            need += routerA.owed(actors[i]);
        }
        assertEq(address(routerA).balance, need);
    }

    function invariant_settlesAtMostOnce() public view {
        assertFalse(handler.doubleSettle());
    }

    function invariant_receiptsOnlyFromStoredCommitment() public view {
        assertFalse(handler.forgedAccepted());
    }

    function invariant_honestReceiptsSettlePendingRoutes() public view {
        assertFalse(handler.honestIgnored());
    }

    function invariant_noStateChangeOnRevertedPaths() public view {
        assertFalse(handler.revertChanged());
    }

    /// @notice Nothing that arrives over a Channel the provider registry does not approve is accepted or recorded.
    function invariant_onlyApprovedChannelsCarryMessages() public view {
        assertFalse(handler.unapprovedAccepted());
    }

    /// @notice Focused fuzz of the same property: every single-field tampering of an honest receipt for a
    ///         pending strict route is ignored (complements the stateful run, where routes settle quickly).
    function testFuzz_forgedReceiptNeverSettles(uint256 k, uint8 st, uint8 m, bytes32 junk) public {
        handler.send(0, 0, 1 ether, 0.1 ether, 0.1 ether, 0, 1);
        handler.forgedReceipt(0, k, st, m, junk);
        assertEq(handler.forgedTried(), 1);
        assertFalse(handler.forgedAccepted());
        (,, IClprRouter.RouteStatus s,,,,,,,,,,,) = routerA.routes(handler.routeId(0));
        assertEq(uint8(s), uint8(IClprRouter.RouteStatus.PENDING));
    }

    /// @dev Coverage report for each run (not a property).
    function afterInvariant() public {
        emit log_named_uint("routes", handler.routeCount());
        emit log_named_uint("settled", handler.settled());
        emit log_named_uint("forged receipts tried", handler.forgedTried());
        emit log_named_uint("unapproved-Channel receipts tried", handler.unapprovedTried());
    }
}
