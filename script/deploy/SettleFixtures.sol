// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IClprConnector} from "@hiero-ledger/clpr/interfaces/IClprConnector.sol";

/// @title SettleTestnetConnector
/// @notice CLPR connector for the settle-on-Hedera testnet deployment. Like `TestnetConnector`, but it authorizes
///         outbound messages from a set of senders (`SettleDeposit` and `SettleDelivery` both send over the same
///         Channel), so the Router's `TestnetConnector` keeps its single allowed sender. Authorizes only calls from
///         the local CLPR Service; pays execution costs only to the Service; the owner can withdraw its balance.
///         TESTNET ONLY: no fee policy, no rate limits.
contract SettleTestnetConnector is IClprConnector {
    address public immutable SERVICE;
    address public immutable OWNER;
    mapping(address => bool) public allowed;

    error NotService();
    error NotOwner();

    event AllowedSender(address sender, bool allowed);
    event Inbound(bytes32 indexed channelId, uint64 messageId, bytes sender, bytes targetApplication);

    constructor(address service, address owner) {
        SERVICE = service;
        OWNER = owner;
    }

    function setAllowed(address sender, bool ok) external {
        if (msg.sender != OWNER) revert NotOwner();
        allowed[sender] = ok;
        emit AllowedSender(sender, ok);
    }

    function authorizeOutboundMessage(bytes32, bytes calldata, bytes calldata sender, bytes calldata)
        external
        view
        returns (bool)
    {
        if (msg.sender != SERVICE) revert NotService();
        return sender.length == 20 && allowed[address(bytes20(sender))];
    }

    function payForExecution(uint256 amount) external {
        if (msg.sender != SERVICE) revert NotService();
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "pay failed");
    }

    function onInboundMessage(
        bytes32 channelId,
        uint64 messageId,
        bytes calldata sender,
        bytes calldata targetApplication,
        bytes calldata
    ) external {
        if (msg.sender != SERVICE) revert NotService();
        emit Inbound(channelId, messageId, sender, targetApplication);
    }

    function withdraw(address payable to, uint256 amount) external {
        if (msg.sender != OWNER) revert NotOwner();
        (bool ok,) = to.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    receive() external payable {}
}
