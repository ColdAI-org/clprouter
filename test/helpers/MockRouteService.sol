// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ClprTypes} from "@hiero-ledger/clpr/libraries/ClprTypes.sol";
import {ClprRouter} from "@clprouter/ClprRouter.sol";

/// @notice Minimal stand-in for a CLPR Service on one ledger, for Router unit tests. Unlike the reference
///         ClprService it can let `sendMessage` succeed inside application delivery (as a platform with
///         system-level dispatch would), fail sends per Channel, or mimic the reference reentrancy guard.
contract MockRouteService {
    error ReentrancyGuardReentrantCall();

    struct Sent {
        bytes32 channelId;
        bytes32 connectorId;
        bytes target;
        bytes data;
    }

    string public chainId;
    mapping(bytes32 => string) public peerOf;
    mapping(bytes32 => bool) public failChannel;
    mapping(bytes32 => bool) public transientChannel;
    bool public guardActive;
    /// @dev Gas sendMessage burns before doing anything (type(uint256).max = until it runs out).
    uint256 public burnGas;
    bool private _inDelivery;
    Sent[] private _sent;
    uint64 private _nextId;

    constructor(string memory chainId_) {
        chainId = chainId_;
    }

    function setPeer(bytes32 ch, string calldata peer) external {
        peerOf[ch] = peer;
    }

    function setFailChannel(bytes32 ch, bool v) external {
        failChannel[ch] = v;
    }

    function setTransientChannel(bytes32 ch, bool v) external {
        transientChannel[ch] = v;
    }

    /// @dev When true, sendMessage during deliver() reverts like the reference ClprService.
    function setGuard(bool v) external {
        guardActive = v;
    }

    function setBurn(uint256 g) external {
        burnGas = g;
    }

    function getLedgerConfiguration() external view returns (ClprTypes.LedgerConfiguration memory c) {
        c.chainId = chainId;
    }

    function getChannel(bytes32 ch) external view returns (ClprTypes.Channel memory c) {
        if (bytes(peerOf[ch]).length == 0) revert ClprTypes.ClprChannelNotFound();
        c.channelId = ch;
        c.chainId = peerOf[ch];
    }

    function sendMessage(bytes32 ch, bytes32 conn, bytes calldata target, bytes calldata data)
        external
        returns (uint64)
    {
        if (guardActive && _inDelivery) revert ReentrancyGuardReentrantCall();
        if (failChannel[ch]) revert ClprTypes.ClprChannelNotFound(); // a definite rejection
        if (transientChannel[ch]) revert ClprTypes.ClprQueueFull();
        if (burnGas > 0) {
            uint256 stop = gasleft() > burnGas ? gasleft() - burnGas : 0;
            while (gasleft() > stop) {}
        }
        _sent.push(Sent(ch, conn, target, data));
        return ++_nextId;
    }

    function deliver(ClprRouter router, bytes32 ch, bytes calldata sender, bytes calldata data)
        external
        returns (bytes memory)
    {
        _inDelivery = true;
        bytes memory r = router.onClprMessage(ch, sender, data);
        _inDelivery = false;
        return r;
    }

    function respond(ClprRouter router, bytes32 ch, uint64 messageId, uint8 status) external {
        _inDelivery = true;
        router.onClprResponse(ch, messageId, status, "");
        _inDelivery = false;
    }

    function sentCount() external view returns (uint256) {
        return _sent.length;
    }

    function sent(uint256 i) external view returns (Sent memory) {
        return _sent[i];
    }

    function lastId() external view returns (uint64) {
        return _nextId;
    }
}
