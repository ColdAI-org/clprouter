// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ClprService} from "@hiero-ledger/clpr/ClprService.sol";
import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprTypes} from "@hiero-ledger/clpr/libraries/ClprTypes.sol";
import {ClprProtobuf} from "@hiero-ledger/clpr/libraries/codec/ClprProtobuf.sol";
import {ClprDeployHelper} from "@test/helpers/ClprDeployHelper.sol";
import {ConnectorRegistrar} from "@test/helpers/ConnectorRegistrar.sol";
import {E2EVerifier} from "@test/E2EVerifier.sol";
import {MockClprConnector} from "@test/mocks/MockClprConnector.sol";

import {SettleDeposit} from "@clprouter/settle/SettleDeposit.sol";
import {SettleDelivery} from "@clprouter/settle/SettleDelivery.sol";
import {SettleOrderBook} from "@clprouter/settle/SettleOrderBook.sol";
import {SettleTypes} from "@clprouter/settle/SettleTypes.sol";
import {MockToken} from "./SettleMocks.sol";
import "../../helpers/ClprArtifacts.sol";

/// @notice Three ledgers in one EVM, each with the unchanged reference ClprService: Y (the user pays), X (the
///         Connector delivers) and H (stands in for Hedera, holds the order book). Channels Y↔H and X↔H.
///
///         TEST ONLY: every Channel uses the CLPR repo's `E2EVerifier`, which decodes real bundle protobufs but checks
///         no proof. It shows the message flow and gas on the real Service, not verification. An in-process relay
///         plays the CLPR endpoints.
abstract contract SettleFixture is Test {
    struct Ledger {
        string id;
        ClprService service;
        SettleDeposit deposit;
        SettleDelivery delivery;
    }

    string internal constant ID_Y = "eip155:31001";
    string internal constant ID_X = "eip155:31002";
    string internal constant ID_H = "eip155:31003";
    uint256 internal constant CHANNEL_PK = 0xC1A;
    uint256 internal constant SIGNER_PK = 0x51600;

    uint16 internal constant PENALTY_BPS = 1000;
    uint64 internal constant WITHDRAW_DELAY = 1 days;
    uint64 internal constant PROOF_GRACE = 30 minutes;
    uint64 internal constant MAX_QUOTE_TTL = 10 minutes;
    uint64 internal constant SOURCE_NOTICE = 1 days;

    Ledger internal Y;
    Ledger internal X;
    Ledger internal H;
    bytes32 internal chYH;
    bytes32 internal chXH;
    bytes32 internal connYH;
    bytes32 internal connXH;
    SettleOrderBook internal book;
    MockToken internal usdcX;

    address internal user = makeAddr("user");
    address internal refundTo = makeAddr("user@hedera");
    address internal connector = makeAddr("connector");
    address internal signer;
    uint256 internal saltNonce;
    uint256 internal lastSubmitGas;

    ClprTypes.Throttles internal throttles = ClprTypes.Throttles({
        maxMessagesPerBundle: 100,
        maxMessagePayloadBytes: 16_384,
        maxGasPerMessage: 3_000_000,
        maxQueueDepth: 1000,
        maxSyncBytes: 1_048_576,
        maxLocalEndpoints: 0,
        maxPeerEndpoints: 0
    });

    ClprTypes.EconomicConfig internal econ = ClprTypes.EconomicConfig({
        messageExecutionCost: 0.001 ether,
        endpointMarginPercent: 10,
        minLockedStake: 0.1 ether,
        minEndpointBond: 0,
        basePenalty: 0.01 ether,
        penaltyMultiplier: 2,
        slashBanThreshold: 5,
        connectorQueueQuotaPct: 50,
        connectorInboundGasStipend: 500_000,
        maxChannels: 0,
        maxConnectors: 0
    });

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        signer = vm.addr(SIGNER_PK);
        Y = _ledger(ID_Y);
        X = _ledger(ID_X);
        H = _ledger(ID_H);
        chYH = _channel(Y, H, bytes32("YH"));
        chXH = _channel(X, H, bytes32("XH"));
        connYH = _connector(Y, H, chYH, bytes32("conn-YH"));
        connXH = _connector(X, H, chXH, bytes32("conn-XH"));

        usdcX = new MockToken("USDC", 6);
        address[] memory assets = new address[](1);
        assets[0] = address(0); // HBAR (tinybars on Hedera; plain wei here)
        book = new SettleOrderBook(
            address(H.service),
            address(this),
            assets,
            PENALTY_BPS,
            WITHDRAW_DELAY,
            PROOF_GRACE,
            MAX_QUOTE_TTL,
            SOURCE_NOTICE
        );
        _wireChain(Y, chYH, connYH);
        _wireChain(X, chXH, connXH);
        vm.warp(block.timestamp + SOURCE_NOTICE);

        vm.deal(connector, 1000 ether);
        vm.startPrank(connector);
        book.register(signer);
        book.postBond{value: 100 ether}(address(0), 100 ether);
        vm.stopPrank();
        vm.deal(user, 100 ether);
        usdcX.mint(connector, 1_000_000e6);
    }

    function _ledger(string memory id) internal returns (Ledger memory l) {
        l.id = id;
        l.service = ClprDeployHelper.deployServiceForTests(address(this), 1, id);
        l.service.initialize(abi.encodePacked(address(l.service)), throttles, "", "", econ);
        l.service.setClprEnabled(true);
    }

    /// @dev Deposit and Delivery contracts on chain `l` (both speak to the order book over `ch`), and the source.
    function _wireChain(Ledger storage l, bytes32 ch, bytes32 conn) internal {
        l.deposit = new SettleDeposit(IClprService(address(l.service)), ch, conn, address(book), l.id, block.chainid);
        l.delivery = new SettleDelivery(IClprService(address(l.service)), ch, conn, address(book));
        book.proposeSource(
            ch, keccak256(bytes(l.id)), abi.encodePacked(address(l.deposit)), abi.encodePacked(address(l.delivery))
        );
    }

    function _channel(Ledger memory a, Ledger memory b, bytes32 salt) internal returns (bytes32 ch) {
        Vm.Wallet memory w = vm.createWallet(CHANNEL_PK);
        bytes memory pubKey = abi.encodePacked(w.publicKeyX, w.publicKeyY);
        (bytes memory lo, bytes memory hi) =
            keccak256(bytes(a.id)) <= keccak256(bytes(b.id)) ? (bytes(a.id), bytes(b.id)) : (bytes(b.id), bytes(a.id));
        ch = keccak256(abi.encodePacked(lo, hi, pubKey, salt));
        _completeSide(a, b, ch, pubKey, salt);
        _completeSide(b, a, ch, pubKey, salt);
    }

    function _completeSide(Ledger memory self, Ledger memory peer, bytes32 ch, bytes memory pubKey, bytes32 salt)
        internal
    {
        E2EVerifier v = new E2EVerifier();
        v.configure(
            peer.id, abi.encodePacked(address(peer.service)), 1000, throttles, "", "", new ClprTypes.Endpoint[](0)
        );
        self.service.registerChannel(ch, keccak256(abi.encodePacked(ch, pubKey)));
        bytes32 h = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(abi.encodePacked(ch, address(self.service))))
        );
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(CHANNEL_PK, h);
        self.service.completeChannel(ch, pubKey, abi.encodePacked(r, s, sv), salt, address(v), hex"0001", "");
    }

    function _connector(Ledger memory a, Ledger memory b, bytes32 ch, bytes32 seed) internal returns (bytes32 id) {
        id = _connectorOn(a, ch, seed);
        require(id == _connectorOn(b, ch, seed), "connector ids differ");
    }

    function _connectorOn(Ledger memory l, bytes32 ch, bytes32 seed) internal returns (bytes32) {
        MockClprConnector c = new MockClprConnector();
        vm.deal(address(c), 10 ether);
        vm.deal(address(this), address(this).balance + 1 ether);
        return
            ConnectorRegistrar.register(IClprService(address(l.service)), ch, seed, address(c), address(this), 1 ether);
    }

    // ── Quotes ──────────────────────────────────────────────────────────────

    /// @dev User pays 1 ETH on Y; the Connector delivers 2,500 USDC on X by the deadline; cover 10 (H native).
    function _quote() internal returns (SettleTypes.Quote memory q) {
        q.connector = connector;
        q.srcLedger = keccak256(bytes(ID_Y));
        q.depositApp = SettleTypes.toBytes32(address(Y.deposit));
        q.user = SettleTypes.toBytes32(user);
        q.payTo = SettleTypes.toBytes32(connector);
        q.assetIn = bytes32(0);
        q.amountIn = 1 ether;
        q.dstLedger = keccak256(bytes(ID_X));
        q.assetOut = SettleTypes.toBytes32(address(usdcX));
        q.recipient = SettleTypes.toBytes32(user);
        q.amountOut = 2500e6;
        q.coverAsset = address(0);
        q.coverAmount = 10 ether;
        q.refundTo = refundTo;
        q.issuedAt = uint64(vm.getBlockTimestamp());
        q.expiry = uint64(vm.getBlockTimestamp() + 5 minutes);
        q.deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        q.salt = bytes32(++saltNonce);
    }

    function _sign(SettleTypes.Quote memory q, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, book.orderIdOf(q));
        return abi.encodePacked(r, s, v);
    }

    function _status(bytes32 id) internal view returns (SettleOrderBook.Status s) {
        (, s,,,,,,,,,,) = book.orders(id);
    }

    // ── In-process relay ────────────────────────────────────────────────────

    /// @dev One bundle `src` → `dst` over `ch` with every unreceived message and the latest ack. Returns false if
    ///      there was nothing to send.
    function _relay(Ledger memory src, Ledger memory dst, bytes32 ch) internal returns (bool) {
        bytes memory bundle = _bundle(src, dst, ch);
        if (bundle.length == 0) return false;
        uint256 g = gasleft();
        dst.service.submitBundle(ch, bundle);
        lastSubmitGas = g - gasleft();
        return true;
    }

    function _bundle(Ledger memory src, Ledger memory dst, bytes32 ch) internal returns (bytes memory) {
        ClprTypes.Channel memory s = src.service.getChannel(ch);
        ClprTypes.Channel memory d = dst.service.getChannel(ch);
        uint64 from = d.receivedMessageId + 1;
        bool newMessages = s.nextMessageId > from;
        bool newAck = s.receivedMessageId > d.ackedMessageId;
        if (!newMessages && !newAck) return "";
        uint64 count = newMessages ? s.nextMessageId - from : 0;
        bytes[] memory payloads = new bytes[](count);
        for (uint64 i = 0; i < count; i++) {
            payloads[i] = src.service.getMessage(ch, from + i).payload;
        }
        return ClprProtobuf.encodeBundleContent(
            ClprTypes.QueueMetadata({
                nextMessageId: s.nextMessageId,
                sentRunningHash: s.sentRunningHash,
                receivedMessageId: s.receivedMessageId,
                receivedRunningHash: s.receivedRunningHash,
                state: s.status,
                endpointManifestVersion: s.endpointManifestVersion
            }),
            payloads
        );
    }

    /// @dev Relay every direction until quiet (acks included).
    function _settleAll() internal {
        for (uint256 i = 0; i < 6; i++) {
            bool moved = _relay(Y, H, chYH) || false;
            moved = _relay(X, H, chXH) || moved;
            moved = _relay(H, Y, chYH) || moved;
            moved = _relay(H, X, chXH) || moved;
            if (!moved) return;
        }
        revert("relay did not settle");
    }

    receive() external payable {}
}
