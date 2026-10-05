// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IProviderRegistry} from "../interfaces/IProviderRegistry.sol";
import {IClprRouter} from "../interfaces/IClprRouter.sol";
import {IClprRouteApplication} from "../interfaces/IClprRouteApplication.sol";
import {RouteTypes} from "./RouteTypes.sol";
import {RouteLogic} from "./RouteLogic.sol";
import {Caip} from "./Caip.sol";

/// @title RouteReceipts
/// @notice Building the receipt a hop sends back to the origin when it delivers or stops a route.
/// @dev External library (public functions run by DELEGATECALL in the Router's context: `address(this)` is the
///      Router and events are the Router's); keeps ClprRouter under EIP-170.
library RouteReceipts {
    /// @notice Report route `e` at hop `e.hopIndex` (this ledger) with `status`: emit {IClprRouter.RouteStopped}
    ///         (unless DELIVERED) and, when QUARANTINED, the quarantine notice (and the destination application's
    ///         notice hook, with exactly `appGas` or the call reverts), then build the receipt.
    /// @return h The receipt's first hop (this ledger and the Channel back).
    /// @return target Router of the receipt's next hop.
    /// @return data Encoded receipt envelope.
    /// @return receiptId Id of the receipt message.
    /// @return open Whether the edge back is currently open (not disabled).
    function report(
        IProviderRegistry registry,
        RouteTypes.Envelope memory e,
        RouteTypes.Receipt memory r,
        string memory here,
        uint64 appGas,
        uint32 version
    ) public returns (RouteTypes.Hop memory h, bytes memory target, bytes memory data, bytes16 receiptId, bool open) {
        if (r.status != RouteTypes.ReceiptStatus.DELIVERED) {
            emit IClprRouter.RouteStopped(e.routeId, e.hopIndex, r.status, r.reason);
        }
        if (r.status == RouteTypes.ReceiptStatus.QUARANTINED) {
            r.contact = registry.contact();
            emit IClprRouter.QuarantineNotice(Caip.accountKey(e.recipient), e.routeId, e.recipient, r.caseId, r.contact);
            bytes memory a = e.destination.application;
            if (e.hopIndex == e.hops.length - 1 && a.length == 20 && address(bytes20(a)).code.length > 0) {
                // The hook gets its full gas or the whole call reverts (no caller can starve it).
                if (gasleft() < uint256(appGas) + appGas / 63 + 10_000) revert IClprRouter.InsufficientGas();
                try IClprRouteApplication(address(bytes20(a))).onRouteNotice{gas: appGas}(
                    e.routeId, r.caseId, r.contact
                ) {}
                    catch {}
            }
        }
        RouteTypes.Hop[] memory hops;
        (receiptId, hops, data) = RouteLogic.buildReceipt(e, r, here, address(this), version);
        emit IClprRouter.ReceiptSent(receiptId, e.routeId, r.status, r.reason);
        h = hops[0];
        target = hops[1].router;
        open = RouteLogic.edgeSafety(registry, h, hops[1]) == RouteTypes.Reason.NONE;
    }
}
