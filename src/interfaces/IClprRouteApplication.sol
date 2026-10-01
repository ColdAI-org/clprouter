// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IClprRouteApplication
/// @notice Implemented by destination applications that receive routed messages from a CLPRouter.
/// @dev Implementations MUST check that `msg.sender` is the CLPRouter they trust. The origin fields are as
///      strong as the weakest hop of the route (every verifier and every Router on it).
interface IClprRouteApplication {
    /// @notice Deliver a routed message. Reverting makes the destination Router send a FAILED receipt.
    /// @param routeId Route id, derived by the origin Router (unique per origin Router; the ISO 20022 UETR travels
    ///        separately in the envelope's `iso_uetr` and inside the ISO payload).
    /// @param originLedger CAIP-2 id of the origin ledger.
    /// @param originApplication Application (Router caller) on the origin ledger.
    /// @param sender CAIP-10 id of the paying sender, stamped by the origin Router.
    /// @param payloadType RouteTypes.PayloadType.
    /// @param payload Application bytes.
    /// @return response Bytes whose keccak256 is reported back to the origin in the DELIVERED receipt. The Router
    ///         copies at most `ClprRouter.MAX_RESPONSE` (4096) bytes of it; a longer response is hashed over its
    ///         first 4096 bytes. A return value that is not an ABI-encoded `bytes` counts as a failure.
    function onRouteMessage(
        bytes16 routeId,
        string calldata originLedger,
        bytes calldata originApplication,
        string calldata sender,
        uint8 payloadType,
        bytes calldata payload
    ) external returns (bytes memory response);

    /// @notice Optional notice hook: a transfer to this application is held because of a blacklist case.
    /// @dev Best effort with a bounded gas stipend; a revert is ignored. Carries no accusation.
    function onRouteNotice(bytes16 routeId, bytes32 caseId, string calldata contact) external;
}

/// @title IClprRouteSender
/// @notice Optional callback for origin applications that want to observe the final receipt of their routes.
interface IClprRouteSender {
    /// @dev Best effort with a bounded gas stipend; a revert is ignored.
    function onRouteReceipt(bytes16 routeId, uint8 status, uint8 reason, bytes32 caseId, bytes32 responseHash) external;
}
