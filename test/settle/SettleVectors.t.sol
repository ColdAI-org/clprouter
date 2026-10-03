// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SettleTypes} from "@clprouter/settle/SettleTypes.sol";

/// @notice Writes `sdk/test/vectors/settle-quote.json`: one quote, its EIP-712 digest (the order id), a signature
///         and both CLPR message encodings, for the TypeScript Connector service and wallet clients to check their
///         hashing and decoding against. The signing key is the public BIP-39 test vector account
///         ("abandon ... about", m/44'/60'/0'/0/0); never use it for anything else.
contract SettleVectorsTest is Test {
    uint256 internal constant BIP39_TEST_PK = 0x1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727;
    uint256 internal constant HEDERA_TESTNET = 296;
    address internal constant BOOK = 0x5e77100000000000000000000000000000000B00;

    function _quote() internal pure returns (SettleTypes.Quote memory q) {
        q.connector = 0x9858EfFD232B4033E47d90003D41EC34EcaEda94;
        q.srcLedger = keccak256("eip155:11155111");
        q.depositApp = SettleTypes.toBytes32(0xDE90517000000000000000000000000000000001);
        q.user = SettleTypes.toBytes32(0x0000000000000000000000000000000000001234);
        q.payTo = SettleTypes.toBytes32(0x0000000000000000000000000000000000005678);
        q.assetIn = bytes32(0);
        q.amountIn = 1_010_000_000_000_000_000;
        q.dstLedger = keccak256("eip155:84532");
        q.assetOut = SettleTypes.toBytes32(0x036CbD53842c5426634e7929541eC2318f3dCF7e);
        q.recipient = SettleTypes.toBytes32(0x0000000000000000000000000000000000001234);
        q.amountOut = 2_500_000_000;
        q.coverAsset = address(0);
        q.coverAmount = 1_500_000_000_000;
        q.refundTo = 0x00000000000000000000000000000000000A1b2C;
        q.issuedAt = 1_800_000_000;
        q.expiry = 1_800_000_300;
        q.deadline = 1_800_003_600;
        q.salt = keccak256("vector-1");
    }

    function test_writeVector() public {
        SettleTypes.Quote memory q = _quote();
        bytes32 domain = SettleTypes.domainSeparator(HEDERA_TESTNET, BOOK);
        bytes32 id = SettleTypes.orderId(domain, q);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BIP39_TEST_PK, id);
        bytes memory sig = abi.encodePacked(r, s, v);
        assertEq(vm.addr(BIP39_TEST_PK), q.connector);

        SettleTypes.Delivery memory d = SettleTypes.Delivery({
            orderId: id,
            asset: q.assetOut,
            recipient: q.recipient,
            amount: q.amountOut,
            deliveredAt: 1_800_001_000,
            deliverer: SettleTypes.toBytes32(address(0xC0FFEE))
        });

        string memory k = "settle";
        vm.serializeUint(k, "hederaChainId", HEDERA_TESTNET);
        vm.serializeAddress(k, "orderBook", BOOK);
        vm.serializeBytes32(k, "domainSeparator", domain);
        vm.serializeBytes32(k, "quoteTypehash", SettleTypes.QUOTE_TYPEHASH);
        vm.serializeBytes32(k, "structHash", SettleTypes.structHash(q));
        vm.serializeBytes32(k, "orderId", id);
        vm.serializeAddress(k, "signer", vm.addr(BIP39_TEST_PK));
        vm.serializeBytes(k, "signature", sig);
        vm.serializeBytes(k, "depositMessage", SettleTypes.encodeDeposit(q, sig, 1_800_000_100));
        vm.serializeBytes(k, "deliveryMessage", SettleTypes.encodeDelivery(d));
        string memory json = vm.serializeString(k, "quoteJson", _quoteJson(q));
        vm.writeJson(json, "sdk/test/vectors/settle-quote.json");
    }

    function _quoteJson(SettleTypes.Quote memory q) internal returns (string memory) {
        string memory k = "quote";
        vm.serializeAddress(k, "connector", q.connector);
        vm.serializeBytes32(k, "srcLedger", q.srcLedger);
        vm.serializeBytes32(k, "depositApp", q.depositApp);
        vm.serializeBytes32(k, "user", q.user);
        vm.serializeBytes32(k, "payTo", q.payTo);
        vm.serializeBytes32(k, "assetIn", q.assetIn);
        vm.serializeString(k, "amountIn", vm.toString(q.amountIn));
        vm.serializeBytes32(k, "dstLedger", q.dstLedger);
        vm.serializeBytes32(k, "assetOut", q.assetOut);
        vm.serializeBytes32(k, "recipient", q.recipient);
        vm.serializeString(k, "amountOut", vm.toString(q.amountOut));
        vm.serializeAddress(k, "coverAsset", q.coverAsset);
        vm.serializeString(k, "coverAmount", vm.toString(q.coverAmount));
        vm.serializeAddress(k, "refundTo", q.refundTo);
        vm.serializeUint(k, "issuedAt", q.issuedAt);
        vm.serializeUint(k, "expiry", q.expiry);
        vm.serializeUint(k, "deadline", q.deadline);
        return vm.serializeBytes32(k, "salt", q.salt);
    }
}
