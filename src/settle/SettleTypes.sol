// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title SettleTypes
/// @notice Shared types, EIP-712 hashing and CLPR message encoding of "settle on Hedera".
/// @dev Three contracts use these:
///        - `SettleDeposit` on the chain a user pays on (chain Y): the user pays a bonded Connector and the
///          contract sends a DEPOSIT message (the signed quote) to the order book on Hedera over CLPR;
///        - `SettleDelivery` on the chain the Connector delivers on (chain X): the Connector pays the user and the
///          contract sends a DELIVERY message to the order book over CLPR;
///        - `SettleOrderBook` on Hedera: holds Connector bonds, opens an order per proven deposit, closes it on a
///          proven delivery, and pays the user from the bond (cover + penalty) when the deadline is missed.
///      Messages only flow chain → Hedera, so nothing on chain X or Y waits for Hedera.
///
///      Chain-side values (accounts, assets, ledgers) are `bytes32` so the same quote format covers EVM chains
///      (an address left-padded to 32 bytes) and chains whose CLPR verifier proves plain payments (see
///      {ISettlePaymentProver}; there the prover defines the 32-byte form, e.g. a hash of the native address).
///      The native coin of a chain is asset `bytes32(0)`. Ledgers are `keccak256(bytes(CAIP-2 id))`.
///
///      "Connector" here means a bonded liquidity provider of this protocol; the CLPR messaging connector that
///      pays a message's execution on the destination is called the CLPR connector (`clprConnectorId`).
library SettleTypes {
    /// @notice Message format version (first word of every message).
    uint8 internal constant VERSION = 1;
    uint8 internal constant MSG_DEPOSIT = 1;
    uint8 internal constant MSG_DELIVERY = 2;

    /// @notice EIP-712 domain of the order book. The chain id and verifying contract are Hedera's and the order
    ///         book's, so a quote is bound to one order book on one network wherever it is checked.
    string internal constant DOMAIN_NAME = "ClprSettle";
    string internal constant DOMAIN_VERSION = "1";

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @notice A Connector's signed offer. Its EIP-712 digest is the order id everywhere.
    /// @param connector Connector id: its account on Hedera (registered in the order book).
    /// @param srcLedger Ledger the user pays on (keccak256 of its CAIP-2 id).
    /// @param depositApp The `SettleDeposit` contract on `srcLedger` (bytes32(0) for payment-proven ledgers).
    /// @param user The paying account on `srcLedger`; the deposit must come from it.
    /// @param payTo The Connector's account on `srcLedger` that receives `amountIn`.
    /// @param assetIn Asset paid on `srcLedger` (bytes32(0) = native coin).
    /// @param amountIn Base units of `assetIn` the user pays, fee included.
    /// @param dstLedger Ledger the Connector delivers on.
    /// @param assetOut Asset delivered on `dstLedger` (bytes32(0) = native coin).
    /// @param recipient Account on `dstLedger` that must receive `amountOut`.
    /// @param amountOut Base units of `assetOut` the Connector must deliver by `deadline`.
    /// @param coverAsset Bond asset on Hedera paid to the user on default: address(0) = HBAR, else an HTS token's
    ///        EVM address (e.g. USDC).
    /// @param coverAmount What the user is paid from the bond on default, before the penalty.
    /// @param refundTo The user's account on Hedera that receives cover + penalty on default.
    /// @param issuedAt When the Connector signed (unix seconds). Bounds how long a rotated-out key stays valid.
    /// @param expiry Last time the deposit may be made (unix seconds, chain Y clock).
    /// @param deadline Last time the delivery may be made (unix seconds, chain X clock).
    /// @param salt Connector-chosen uniqueness.
    struct Quote {
        address connector;
        bytes32 srcLedger;
        bytes32 depositApp;
        bytes32 user;
        bytes32 payTo;
        bytes32 assetIn;
        uint256 amountIn;
        bytes32 dstLedger;
        bytes32 assetOut;
        bytes32 recipient;
        uint256 amountOut;
        address coverAsset;
        uint256 coverAmount;
        address refundTo;
        uint64 issuedAt;
        uint64 expiry;
        uint64 deadline;
        bytes32 salt;
    }

    /// @notice What `SettleDelivery` proves: `amount` of `asset` reached `recipient` at `deliveredAt` for `orderId`.
    struct Delivery {
        bytes32 orderId;
        bytes32 asset;
        bytes32 recipient;
        uint256 amount;
        uint64 deliveredAt;
        bytes32 deliverer;
    }

    bytes32 internal constant QUOTE_TYPEHASH = keccak256(
        "Quote(address connector,bytes32 srcLedger,bytes32 depositApp,bytes32 user,bytes32 payTo,bytes32 assetIn,uint256 amountIn,bytes32 dstLedger,bytes32 assetOut,bytes32 recipient,uint256 amountOut,address coverAsset,uint256 coverAmount,address refundTo,uint64 issuedAt,uint64 expiry,uint64 deadline,bytes32 salt)"
    );

    function ledgerId(string memory caip2) internal pure returns (bytes32) {
        return keccak256(bytes(caip2));
    }

    function toBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// @dev True when `b` is an EVM address left-padded to 32 bytes.
    function isAddress(bytes32 b) internal pure returns (bool) {
        return uint256(b) >> 160 == 0;
    }

    function domainSeparator(uint256 chainId, address orderBook) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256(bytes(DOMAIN_NAME)), keccak256(bytes(DOMAIN_VERSION)), chainId, orderBook
            )
        );
    }

    function structHash(Quote memory q) internal pure returns (bytes32 h) {
        // Two halves keep the encoder off the stack limit; the result equals abi.encode of all 19 words.
        bytes memory a = abi.encode(
            QUOTE_TYPEHASH,
            q.connector,
            q.srcLedger,
            q.depositApp,
            q.user,
            q.payTo,
            q.assetIn,
            q.amountIn,
            q.dstLedger,
            q.assetOut
        );
        bytes memory b = abi.encode(
            q.recipient, q.amountOut, q.coverAsset, q.coverAmount, q.refundTo, q.issuedAt, q.expiry, q.deadline, q.salt
        );
        h = keccak256(bytes.concat(a, b));
    }

    /// @notice The order id: the EIP-712 digest of `q` under `domainSep`.
    function orderId(bytes32 domainSep, Quote memory q) internal pure returns (bytes32 d) {
        bytes32 s = structHash(q);
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, hex"1901")
            mstore(add(p, 0x02), domainSep)
            mstore(add(p, 0x22), s)
            d := keccak256(p, 0x42)
        }
    }

    // ── Messages ────────────────────────────────────────────────────────────

    function encodeDeposit(Quote memory q, bytes memory sig, uint64 depositedAt) internal pure returns (bytes memory) {
        return abi.encode(VERSION, MSG_DEPOSIT, q, sig, depositedAt);
    }

    function decodeDeposit(bytes calldata data)
        internal
        pure
        returns (Quote memory q, bytes memory sig, uint64 depositedAt)
    {
        (,, q, sig, depositedAt) = abi.decode(data, (uint8, uint8, Quote, bytes, uint64));
    }

    function encodeDelivery(Delivery memory d) internal pure returns (bytes memory) {
        return abi.encode(VERSION, MSG_DELIVERY, d);
    }

    function decodeDelivery(bytes calldata data) internal pure returns (Delivery memory d) {
        (,, d) = abi.decode(data, (uint8, uint8, Delivery));
    }

    /// @notice (version, kind) of a message, or (0, 0) if it is too short to carry them.
    function header(bytes calldata data) internal pure returns (uint8 version, uint8 kind) {
        if (data.length < 64) return (0, 0);
        uint256 v = uint256(bytes32(data[0:32]));
        uint256 k = uint256(bytes32(data[32:64]));
        if (v > type(uint8).max || k > type(uint8).max) return (0, 0);
        return (uint8(v), uint8(k));
    }
}
