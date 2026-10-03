// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {SettleTypes} from "./SettleTypes.sol";

/// @title SettleDeposit
/// @notice Chain-side entry of "settle on Hedera" (chain Y): a user pays a bonded Connector against the Connector's
///         signed quote, and this contract proves it to the order book on Hedera with a CLPR message.
/// @dev Holds no funds: `amountIn` goes straight from the user to the Connector's `payTo`. What protects the user
///      is the Connector's bond on Hedera, so this contract checks only what the user and the chain can check
///      (signature, expiry, binding to this chain and contract, the exact amount moved) and the order book checks
///      the rest (that the signer is the Connector's). Immutable, no admin.
///
///      Each quote can be used once. The order id is the quote's EIP-712 digest under the order book's domain.
contract SettleDeposit is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    IClprService public immutable SERVICE;
    /// @notice CLPR Channel between this chain and Hedera.
    bytes32 public immutable CHANNEL_ID;
    /// @notice CLPR connector that pays this contract's messages on Hedera.
    bytes32 public immutable CLPR_CONNECTOR_ID;
    /// @notice The order book on Hedera (CLPR target application).
    address public immutable ORDER_BOOK;
    /// @notice keccak256 of this chain's CAIP-2 id.
    bytes32 public immutable LEDGER;
    /// @notice EIP-712 domain separator of the order book (Hedera chain id, order book address).
    bytes32 public immutable DOMAIN_SEPARATOR;

    /// @notice Quotes already deposited, by order id.
    mapping(bytes32 => bool) public used;

    event Deposited(
        bytes32 indexed orderId,
        address indexed connector,
        address indexed user,
        address signer,
        bytes32 assetIn,
        uint256 amountIn,
        bytes32 payTo,
        uint64 messageId
    );

    error WrongLedger();
    error WrongDepositApp();
    error NotQuoteUser();
    error QuoteExpired();
    error BadTimes();
    error QuoteUsed();
    error BadSignature();
    error NotAnAddress();
    error WrongValue();
    error AmountMismatch();
    error PaymentFailed();
    error ZeroAmount();

    constructor(
        IClprService service,
        bytes32 channelId,
        bytes32 clprConnectorId,
        address orderBook,
        string memory ledgerId,
        uint256 hederaChainId
    ) {
        SERVICE = service;
        CHANNEL_ID = channelId;
        CLPR_CONNECTOR_ID = clprConnectorId;
        ORDER_BOOK = orderBook;
        LEDGER = SettleTypes.ledgerId(ledgerId);
        DOMAIN_SEPARATOR = SettleTypes.domainSeparator(hederaChainId, orderBook);
    }

    /// @notice The order id (EIP-712 digest) of `q`.
    function orderIdOf(SettleTypes.Quote calldata q) external view returns (bytes32) {
        return SettleTypes.orderId(DOMAIN_SEPARATOR, q);
    }

    /// @notice Pay `q.amountIn` of `q.assetIn` to the Connector's `q.payTo` and prove it to the order book.
    /// @dev Native coin: `msg.value` must equal `amountIn`. ERC-20: approve this contract first; the payee must
    ///      receive exactly `amountIn` (fee-on-transfer tokens are refused).
    /// @return orderId The order id the Connector and the order book use.
    /// @return messageId The CLPR message id on this chain's Channel to Hedera.
    function deposit(SettleTypes.Quote calldata q, bytes calldata sig)
        external
        payable
        nonReentrant
        returns (bytes32 orderId, uint64 messageId)
    {
        if (q.srcLedger != LEDGER) revert WrongLedger();
        if (q.depositApp != SettleTypes.toBytes32(address(this))) revert WrongDepositApp();
        if (!SettleTypes.isAddress(q.user) || !SettleTypes.isAddress(q.payTo) || !SettleTypes.isAddress(q.assetIn)) {
            revert NotAnAddress();
        }
        if (address(uint160(uint256(q.user))) != msg.sender) revert NotQuoteUser();
        if (block.timestamp > q.expiry) revert QuoteExpired();
        if (q.expiry >= q.deadline || q.issuedAt > q.expiry) revert BadTimes();
        if (q.amountIn == 0) revert ZeroAmount();

        orderId = SettleTypes.orderId(DOMAIN_SEPARATOR, q);
        if (used[orderId]) revert QuoteUsed();
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(orderId, sig);
        if (err != ECDSA.RecoverError.NoError) revert BadSignature();
        used[orderId] = true;

        address payTo = address(uint160(uint256(q.payTo)));
        address asset = address(uint160(uint256(q.assetIn)));
        if (asset == address(0)) {
            if (msg.value != q.amountIn) revert WrongValue();
            (bool ok,) = payTo.call{value: q.amountIn}("");
            if (!ok) revert PaymentFailed();
        } else {
            if (msg.value != 0) revert WrongValue();
            uint256 before = IERC20(asset).balanceOf(payTo);
            IERC20(asset).safeTransferFrom(msg.sender, payTo, q.amountIn);
            if (IERC20(asset).balanceOf(payTo) - before != q.amountIn) revert AmountMismatch();
        }

        messageId = SERVICE.sendMessage(
            CHANNEL_ID,
            CLPR_CONNECTOR_ID,
            abi.encodePacked(ORDER_BOOK),
            SettleTypes.encodeDeposit(q, sig, uint64(block.timestamp))
        );
        emit Deposited(orderId, q.connector, msg.sender, signer, q.assetIn, q.amountIn, q.payTo, messageId);
    }
}
