// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IProviderRegistry} from "../interfaces/IProviderRegistry.sol";
import {IQuarantineVault} from "../interfaces/IQuarantineVault.sol";
import {IClprRouter} from "../interfaces/IClprRouter.sol";
import {IClprRouteSender} from "../interfaces/IClprRouteApplication.sol";
import {RouteTypes} from "./RouteTypes.sol";
import {RouteCodec} from "./RouteCodec.sol";
import {RouteLogic} from "./RouteLogic.sol";
import {Caip} from "./Caip.sol";

/// @title RouteSettlement
/// @notice Origin-side settlement of CLPRouter routes: receipt authentication, fee payment, escrow release,
///         refund or quarantine, and the two-phase reclaim.
/// @dev External library: its public functions run by DELEGATECALL in the Router's context (storage, balance,
///      `msg.sender` and events are the Router's), so its bytecode does not count against the Router's EIP-170
///      limit. Called only from ClprRouter under its reentrancy lock.
library RouteSettlement {
    /// @notice Gas forwarded to a payment receiver (no return data is copied, whatever it returns).
    uint256 internal constant PAY_GAS = 30_000;
    /// @notice Gas kept on top of the hook's own gas (and the 1/64 the call withholds) for the rest of the call.
    uint256 internal constant HOOK_MARGIN = 10_000;

    /// @notice What the settlement needs from the Router's immutables.
    struct Ctx {
        IProviderRegistry registry;
        IQuarantineVault vault;
        string ledgerId;
        uint64 appGas;
        uint64 reclaimGrace;
    }

    /// @notice A receipt envelope `re` reached its origin (this Router): authenticate it against the stored route
    ///         and settle. `wasHeld` = it had been held here while a disable was in force.
    function settle(
        mapping(bytes16 => IClprRouter.OriginRoute) storage routes,
        mapping(address => uint256) storage owed,
        Ctx memory c,
        RouteTypes.Envelope memory re,
        bool wasHeld
    ) public {
        RouteTypes.Receipt memory r = RouteCodec.decodeReceipt(re.payload);
        IClprRouter.OriginRoute storage o = routes[r.routeId];
        if (wasHeld && o.held > 0) o.held--;
        IClprRouter.RouteStatus st = o.status;
        bool ok;
        RouteTypes.Hop[] memory prefix;
        if (st == IClprRouter.RouteStatus.PENDING || (st == IClprRouter.RouteStatus.EXPIRED && o.reclaimAt != 0)) {
            (ok, prefix) = RouteLogic.checkReceipt(re, r, o.firstHop, o.strict ? o.hopsHash : bytes32(0), o.pathHash);
        }
        if (!ok) {
            emit IClprRouter.ReceiptIgnored(r.routeId);
            return;
        }
        if (st != IClprRouter.RouteStatus.PENDING) {
            // Refunded by reclaim before this authentic receipt arrived: record the claim, move nothing.
            if (o.late == IClprRouter.RouteStatus.NONE) o.late = _status(r.status);
            emit IClprRouter.LateReceipt(r.routeId, r.status, r.hopIndex, r.responseHash);
            return;
        }
        finish(routes, owed, c, r.routeId, _status(r.status), r.reason, r.hopIndex, r.caseId, r.responseHash, prefix);
    }

    /// @notice Two-phase refund of a route that never got a receipt. Phase 1 (after the deadline plus
    ///         `reclaimGrace` per edge of the longest way back) publishes the request; phase 2 (another
    ///         `reclaimGrace` later) refunds. Any authentic receipt arriving before phase 2 settles the route
    ///         instead; one arriving later is recorded ({IClprRouter.LateReceipt}). Blocked while a receipt for
    ///         the route is held here.
    function reclaim(
        mapping(bytes16 => IClprRouter.OriginRoute) storage routes,
        mapping(address => uint256) storage owed,
        Ctx memory c,
        bytes16 routeId
    ) public {
        IClprRouter.OriginRoute storage o = routes[routeId];
        if (o.status != IClprRouter.RouteStatus.PENDING || o.held != 0) revert IClprRouter.NotReclaimable();
        if (o.reclaimAt == 0) {
            if (block.timestamp <= uint256(o.deadline) + uint256(c.reclaimGrace) * o.edges) {
                revert IClprRouter.NotReclaimable();
            }
            uint64 at = uint64(block.timestamp + c.reclaimGrace);
            o.reclaimAt = at;
            emit IClprRouter.ReclaimRequested(routeId, at);
            return;
        }
        if (block.timestamp < o.reclaimAt) revert IClprRouter.NotReclaimable();
        finish(
            routes,
            owed,
            c,
            routeId,
            IClprRouter.RouteStatus.EXPIRED,
            RouteTypes.Reason.DEADLINE,
            0,
            bytes32(0),
            bytes32(0),
            new RouteTypes.Hop[](0)
        );
    }

    /// @notice Pay the fees of `forwarded` (the hops before the reporting one), then release, refund or
    ///         quarantine the rest. Payments are pushed with a bounded call that copies no return data; a failed
    ///         push is credited to `owed` (pull with ClprRouter.withdraw). A sender that is a contract then gets
    ///         `onRouteReceipt` with exactly `appGas`; if that much is not left the call reverts (InsufficientGas).
    function finish(
        mapping(bytes16 => IClprRouter.OriginRoute) storage routes,
        mapping(address => uint256) storage owed,
        Ctx memory c,
        bytes16 routeId,
        IClprRouter.RouteStatus status,
        RouteTypes.Reason reason,
        uint32 reachedHop,
        bytes32 caseId,
        bytes32 responseHash,
        RouteTypes.Hop[] memory forwarded
    ) public {
        IClprRouter.OriginRoute storage o = routes[routeId];
        uint256 budget = o.feeBudget;
        uint256 escrow = o.escrow;
        address sender = o.sender;
        address payee = o.payee;

        // Late blacklist entries still catch a route that is about to pay out.
        if (status == IClprRouter.RouteStatus.DELIVERED) {
            (bool listed, bytes32 cid) = _listed(c, Caip.account(c.ledgerId, sender));
            if (!listed && payee != address(0)) (listed, cid) = _listed(c, Caip.account(c.ledgerId, payee));
            if (listed) {
                status = IClprRouter.RouteStatus.QUARANTINED;
                reason = RouteTypes.Reason.BLACKLIST;
                caseId = cid;
            }
        }
        o.status = status;

        uint256 paid;
        for (uint256 i = 0; i < forwarded.length; i++) {
            uint256 fee = forwarded[i].fee;
            if (fee == 0 || forwarded[i].feePayee.length != 20 || paid + fee > budget) continue;
            paid += fee;
            _pay(owed, address(bytes20(forwarded[i].feePayee)), fee);
        }
        uint256 rest = budget - paid;
        string memory contact_;
        if (status == IClprRouter.RouteStatus.QUARANTINED) {
            contact_ = c.registry.contact();
            if (escrow + rest > 0) c.vault.deposit{value: escrow + rest}(routeId, caseId, sender, payee);
        } else if (status == IClprRouter.RouteStatus.DELIVERED) {
            _pay(owed, payee, escrow);
            _pay(owed, sender, rest);
        } else {
            _pay(owed, sender, escrow + rest);
        }
        emit IClprRouter.RouteSettled(routeId, status, reason, reachedHop, caseId, contact_, paid);

        if (sender.code.length > 0) {
            // The hook gets its full gas or the whole call reverts: whoever pays for this transaction (a
            // permissionless reclaim or forward, a relayer) cannot settle the route and starve the callback.
            if (gasleft() < uint256(c.appGas) + c.appGas / 63 + HOOK_MARGIN) revert IClprRouter.InsufficientGas();
            // No return values are declared, so no return data is copied.
            try IClprRouteSender(sender).onRouteReceipt{gas: c.appGas}(
                routeId, uint8(status), uint8(reason), caseId, responseHash
            ) {}
                catch {}
        }
    }

    function _pay(mapping(address => uint256) storage owed, address to, uint256 amount) private {
        if (amount == 0) return;
        bool ok;
        uint256 g = PAY_GAS;
        assembly ("memory-safe") {
            ok := call(g, to, amount, 0, 0, 0, 0)
        }
        if (!ok) owed[to] += amount;
    }

    function _listed(Ctx memory c, string memory caip10) private view returns (bool, bytes32) {
        return c.registry.blacklisted(Caip.accountKey(caip10));
    }

    function _status(RouteTypes.ReceiptStatus s) private pure returns (IClprRouter.RouteStatus) {
        return s == RouteTypes.ReceiptStatus.DELIVERED
            ? IClprRouter.RouteStatus.DELIVERED
            : s == RouteTypes.ReceiptStatus.EXPIRED
                ? IClprRouter.RouteStatus.EXPIRED
                : s == RouteTypes.ReceiptStatus.QUARANTINED
                    ? IClprRouter.RouteStatus.QUARANTINED
                    : IClprRouter.RouteStatus.FAILED;
    }
}
