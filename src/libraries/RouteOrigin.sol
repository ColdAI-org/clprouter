// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IProviderRegistry} from "../interfaces/IProviderRegistry.sol";
import {IClprRouter} from "../interfaces/IClprRouter.sol";
import {IClprRouteApplication} from "../interfaces/IClprRouteApplication.sol";
import {RouteTypes} from "./RouteTypes.sol";
import {RouteLogic} from "./RouteLogic.sol";
import {Caip} from "./Caip.sol";

/// @title RouteOrigin
/// @notice Envelope construction at the origin and the bounded call into the destination application.
/// @dev External library (public functions run by DELEGATECALL in the Router's context, so the application sees
///      the Router as `msg.sender`); keeps ClprRouter under EIP-170.
library RouteOrigin {
    /// @notice What {buildSend} needs from the origin Router.
    struct SendCtx {
        string ledgerId;
        bytes32 ledgerHash;
        bytes32 selfHash;
        bytes32 selfRouterKey;
        IProviderRegistry registry;
        RouteLogic.Canon canon;
        address sender;
        bytes16 routeId;
        uint256 value;
        uint64 budget;
        uint32 version;
    }

    /// @notice Build and check the envelope of a {ClprRouter.send}: value rules, structure (canonical Routers),
    ///         origin and destination hops, deadline, fees, filter pinning, then route safety, trust floor and
    ///         filters on every ledger and edge. Reverts on any failure; nothing has moved yet.
    function buildSend(IClprRouter.SendRequest calldata req, SendCtx memory c)
        public
        view
        returns (RouteTypes.Envelope memory e)
    {
        if (req.payloadType == RouteTypes.PayloadType.RECEIPT) {
            revert IClprRouter.InvalidRoute(RouteTypes.Reason.BAD_ROUTE);
        }
        // Value routes are strict and come back the reverse way: the origin settles fees and escrow against the
        // hop list it stored, which a loose route may change, and a sender-chosen receipt path the origin cannot
        // check could strand the receipt that pays the payee and the hops. So loose routes and routes with an
        // explicit receipt path carry no value at all (no escrow and no fee budget).
        if (
            ((req.constraints.loose || req.receiptPath.length > 0) && c.value > 0)
                || (req.escrow > 0 && req.payee == address(0))
        ) revert IClprRouter.ValueRoutesMustBeStrict();
        e.routeId = c.routeId;
        e.origin = RouteTypes.Endpoint({ledgerId: c.ledgerId, application: abi.encodePacked(c.sender)});
        e.destination = req.destination;
        e.sender = Caip.account(c.ledgerId, c.sender);
        e.recipient = req.recipient;
        e.hops = req.hops;
        e.mode = req.mode;
        e.constraints = req.constraints;
        e.constraints.remainingFeeBudget = c.budget;
        e.payloadType = req.payloadType;
        e.payload = req.payload;
        e.receiptPath = req.receiptPath;
        e.originSignature = req.originSignature;
        e.routerVersion = c.version;
        e.isoUetr = req.isoUetr;

        e = RouteLogic.prepareSend(
            e, c.ledgerHash, c.selfHash, req.constraints.filters == 0 ? 0 : c.registry.version(), c.canon
        );
        (uint256 hop, RouteTypes.Reason blocked) = RouteLogic.checkRoute(c.registry, c.selfRouterKey, c.version, e);
        if (blocked != RouteTypes.Reason.NONE) revert IClprRouter.RouteBlocked(hop, blocked);
    }

    /// @notice Call the destination application with exactly `appGas` and hash at most `maxResponse` bytes of its
    ///         response (no unbounded return-data copy). Reverts with InsufficientGas if `appGas` is not available,
    ///         so a starved application call never turns into a FAILED receipt.
    /// @return ok The call succeeded and returned a well-formed `bytes`.
    /// @return respHash keccak256 of the response (its first `maxResponse` bytes if longer).
    function callApplication(address app, RouteTypes.Envelope memory e, uint256 appGas, uint256 maxResponse)
        public
        returns (bool ok, bytes32 respHash)
    {
        bytes memory cd = abi.encodeCall(
            IClprRouteApplication.onRouteMessage,
            (e.routeId, e.origin.ledgerId, e.origin.application, e.sender, uint8(e.payloadType), e.payload)
        );
        if (gasleft() < appGas + appGas / 63 + 10_000) revert IClprRouter.InsufficientGas();
        uint256 maxCopy = maxResponse + 64;
        assembly ("memory-safe") {
            ok := call(appGas, app, 0, add(cd, 0x20), mload(cd), 0, 0)
            if ok {
                // Expect abi.encode(bytes): offset 0x20, length, data. Copy at most maxResponse data bytes.
                let rds := returndatasize()
                let n := rds
                if gt(n, maxCopy) { n := maxCopy }
                let p := mload(0x40)
                returndatacopy(p, 0, n)
                ok := 0
                if and(iszero(lt(n, 64)), eq(mload(p), 0x20)) {
                    let len := mload(add(p, 0x20))
                    if iszero(gt(add(64, len), rds)) {
                        let take := len
                        if gt(take, maxResponse) { take := maxResponse }
                        ok := 1
                        respHash := keccak256(add(p, 0x40), take)
                    }
                }
            }
        }
    }
}
