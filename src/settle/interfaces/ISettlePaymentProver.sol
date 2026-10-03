// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ISettlePaymentProver
/// @notice Proves a plain payment on a chain without a CLPR Service of its own (Bitcoin, XRPL, Stellar...), so the
///         order book can accept a deposit or a delivery there without a `SettleDeposit` / `SettleDelivery`
///         contract. One prover per ledger, registered in the order book.
/// @dev A prover wraps that chain's CLPR verifier logic (finality, inclusion and transaction parsing) and returns a
///      payment only once it is final under that verifier's rules; otherwise it reverts. The order book binds the
///      payment to an order through `memo` (the order id, e.g. an OP_RETURN or a memo field) and spends each
///      `(ledger, txId)` at most once.
interface ISettlePaymentProver {
    struct Payment {
        /// @dev keccak256 of the chain's CAIP-2 id.
        bytes32 ledger;
        /// @dev Unique id of the payment on that chain (transaction hash, plus output index if needed).
        bytes32 txId;
        /// @dev Payer and payee in the prover's 32-byte account form.
        bytes32 from;
        bytes32 to;
        /// @dev bytes32(0) = the chain's native coin.
        bytes32 asset;
        uint256 amount;
        /// @dev The order id the payment carries.
        bytes32 memo;
        /// @dev Time of the block / ledger that includes the payment (unix seconds).
        uint64 timestamp;
    }

    /// @notice The final payment `proof` proves on this prover's ledger. Reverts if it proves nothing.
    function provePayment(bytes calldata proof) external returns (Payment memory);
}
