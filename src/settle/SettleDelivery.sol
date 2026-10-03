// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {SettleTypes} from "./SettleTypes.sol";

/// @title SettleDelivery
/// @notice Chain-side exit of "settle on Hedera" (chain X): a Connector (or anyone) pays an order's recipient
///         through this contract, and it proves the payment to the order book on Hedera with a CLPR message.
/// @dev Holds no funds. It proves only what moved (asset, recipient, amount actually received, time); whether that
///      satisfies an order is decided by the order book. Immutable, no admin.
contract SettleDelivery is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    IClprService public immutable SERVICE;
    bytes32 public immutable CHANNEL_ID;
    bytes32 public immutable CLPR_CONNECTOR_ID;
    address public immutable ORDER_BOOK;

    event Delivered(
        bytes32 indexed orderId,
        address indexed deliverer,
        address indexed recipient,
        address asset,
        uint256 amount,
        uint64 messageId
    );

    error ZeroAmount();
    error ZeroRecipient();
    error WrongValue();
    error PaymentFailed();

    constructor(IClprService service, bytes32 channelId, bytes32 clprConnectorId, address orderBook) {
        SERVICE = service;
        CHANNEL_ID = channelId;
        CLPR_CONNECTOR_ID = clprConnectorId;
        ORDER_BOOK = orderBook;
    }

    /// @notice Pay `amount` of `asset` (address(0) = native coin) to `recipient` for `orderId` and prove it.
    /// @dev Native coin: `msg.value` must equal `amount`. ERC-20: approve this contract first; the message carries
    ///      what the recipient actually received.
    function deliver(bytes32 orderId, address asset, address recipient, uint256 amount)
        external
        payable
        nonReentrant
        returns (uint64 messageId)
    {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroRecipient();
        uint256 received;
        if (asset == address(0)) {
            if (msg.value != amount) revert WrongValue();
            (bool ok,) = recipient.call{value: amount}("");
            if (!ok) revert PaymentFailed();
            received = amount;
        } else {
            if (msg.value != 0) revert WrongValue();
            uint256 before = IERC20(asset).balanceOf(recipient);
            IERC20(asset).safeTransferFrom(msg.sender, recipient, amount);
            received = IERC20(asset).balanceOf(recipient) - before;
        }
        SettleTypes.Delivery memory d = SettleTypes.Delivery({
            orderId: orderId,
            asset: SettleTypes.toBytes32(asset),
            recipient: SettleTypes.toBytes32(recipient),
            amount: received,
            deliveredAt: uint64(block.timestamp),
            deliverer: SettleTypes.toBytes32(msg.sender)
        });
        messageId = SERVICE.sendMessage(
            CHANNEL_ID, CLPR_CONNECTOR_ID, abi.encodePacked(ORDER_BOOK), SettleTypes.encodeDelivery(d)
        );
        emit Delivered(orderId, msg.sender, recipient, asset, received, messageId);
    }
}
