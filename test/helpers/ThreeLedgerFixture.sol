// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ClprService} from "@hiero-ledger/clpr/ClprService.sol";
import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprTypes} from "@hiero-ledger/clpr/libraries/ClprTypes.sol";
import {ClprProtobuf} from "@hiero-ledger/clpr/libraries/codec/ClprProtobuf.sol";
import {ClprDeployHelper} from "@test/helpers/ClprDeployHelper.sol";
import {ConnectorRegistrar} from "@test/helpers/ConnectorRegistrar.sol";
import {E2EVerifier} from "@test/E2EVerifier.sol";
import {MockClprConnector} from "@test/mocks/MockClprConnector.sol";

import {ClprRouter} from "@clprouter/ClprRouter.sol";
import {IClprRouter} from "@clprouter/interfaces/IClprRouter.sol";
import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {QuarantineVault} from "@clprouter/QuarantineVault.sol";
import {IQuarantineVault} from "@clprouter/interfaces/IQuarantineVault.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {Committee} from "./Committee.sol";
import {RouterDeploy} from "./RouterDeploy.sol";
import {RouteApp} from "./RouteApp.sol";
import "./ClprArtifacts.sol";

/// @notice Three ledgers A — B — C in one EVM, each with the unchanged reference ClprService, a provider
///         registry, a quarantine vault, a CLPRouter and a test app. Channels A↔B and B↔C use the CLPR repo's
///         E2EVerifier (decodes real bundle protobufs, no crypto). An in-process relay plays the endpoints:
///         it copies queued messages into bundles, submits them, and completes pending Router hops.
abstract contract ThreeLedgerFixture is Committee, RouterDeploy {
    struct Ledger {
        string id;
        ClprService service;
        ProviderRegistry registry;
        QuarantineVault vault;
        ClprRouter router;
        RouteApp app;
    }

    string internal constant ID_A = "eip155:31001";
    string internal constant ID_B = "eip155:31002";
    string internal constant ID_C = "eip155:31003";
    uint64 internal constant RECLAIM_GRACE = 1 hours;
    uint64 internal constant APP_GAS = 300_000;
    /// @dev Reference ClprService sendMessage with the mock connector costs ~1.2M gas; margin on top.
    uint64 internal constant MIN_SEND_GAS = 1_500_000;
    uint256 internal constant CHANNEL_PK = 0xC1A;

    Ledger internal A;
    Ledger internal B;
    Ledger internal C;
    bytes32 internal chAB;
    bytes32 internal chBC;
    bytes32 internal connAB;
    bytes32 internal connBC;

    address internal alice = makeAddr("alice"); // EOA sender on A
    address internal payee = makeAddr("payee"); // origin-ledger payee on A
    address internal feeA = makeAddr("fee-A"); // fee payees (origin-ledger accounts)
    address internal feeB = makeAddr("fee-B");

    /// @dev Gas used by the last pumping pass, per destination ledger and operation (for reports).
    uint256 internal lastSubmitGas;
    uint256 internal lastPumpGas;

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
        _initCommittee();
        A = _ledger(ID_A);
        B = _ledger(ID_B);
        C = _ledger(ID_C);
        chAB = _channel(A, B, bytes32("AB"));
        chBC = _channel(B, C, bytes32("BC"));
        connAB = _connector(A, B, chAB, bytes32("conn-AB"));
        connBC = _connector(B, C, chBC, bytes32("conn-BC"));
        vm.deal(alice, 100 ether);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Deployment
    // ═════════════════════════════════════════════════════════════════════

    function _ledger(string memory id) internal returns (Ledger memory l) {
        l.id = id;
        l.service = ClprDeployHelper.deployServiceForTests(address(this), 1, id);
        l.service.initialize(abi.encodePacked(address(l.service)), throttles, "", "", econ);
        l.service.setClprEnabled(true);
        l.registry = _deployRegistry();
        l.vault = new QuarantineVault(IProviderRegistry(address(l.registry)), 3 days, 7 days);
        l.router = _deployRouter(
            IClprService(address(l.service)),
            IProviderRegistry(address(l.registry)),
            IQuarantineVault(address(l.vault)),
            id,
            RECLAIM_GRACE,
            APP_GAS,
            MIN_SEND_GAS
        );
        l.app = new RouteApp();
        l.app.setRouter(address(l.router));
    }

    function _channel(Ledger memory x, Ledger memory y, bytes32 salt) internal returns (bytes32 ch) {
        Vm.Wallet memory w = vm.createWallet(CHANNEL_PK);
        bytes memory pubKey = abi.encodePacked(w.publicKeyX, w.publicKeyY);
        (bytes memory a, bytes memory b) =
            keccak256(bytes(x.id)) <= keccak256(bytes(y.id)) ? (bytes(x.id), bytes(y.id)) : (bytes(y.id), bytes(x.id));
        ch = keccak256(abi.encodePacked(a, b, pubKey, salt));
        _completeSide(x, y, ch, pubKey, salt);
        _completeSide(y, x, ch, pubKey, salt);
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

    function _connector(Ledger memory x, Ledger memory y, bytes32 ch, bytes32 seed) internal returns (bytes32 id) {
        id = _connectorOn(x, ch, seed);
        bytes32 id2 = _connectorOn(y, ch, seed);
        require(id == id2, "connector ids differ");
    }

    function _connectorOn(Ledger memory x, bytes32 ch, bytes32 seed) internal returns (bytes32) {
        MockClprConnector c = new MockClprConnector();
        vm.deal(address(c), 10 ether);
        vm.deal(address(this), address(this).balance + 1 ether);
        return
            ConnectorRegistrar.register(IClprService(address(x.service)), ch, seed, address(c), address(this), 1 ether);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Route building
    // ═════════════════════════════════════════════════════════════════════

    function _hop(Ledger memory l, bytes32 ch, bytes32 conn, uint64 fee, address feePayee)
        internal
        pure
        returns (RouteTypes.Hop memory)
    {
        return RouteTypes.Hop({
            ledgerId: l.id,
            router: abi.encodePacked(address(l.router)),
            channelId: ch,
            connectorId: conn,
            fee: fee,
            feePayee: feePayee == address(0) ? bytes("") : abi.encodePacked(feePayee)
        });
    }

    /// @dev A → B → C with fees 0.01 (A) and 0.02 (B).
    function _hopsABC() internal view returns (RouteTypes.Hop[] memory h) {
        h = new RouteTypes.Hop[](3);
        h[0] = _hop(A, chAB, connAB, 0.01 ether, feeA);
        h[1] = _hop(B, chBC, connBC, 0.02 ether, feeB);
        h[2] = _hop(C, bytes32(0), bytes32(0), 0, address(0));
    }

    function _request(uint256 escrow) internal view returns (IClprRouter.SendRequest memory req) {
        req.destination = RouteTypes.Endpoint({ledgerId: C.id, application: abi.encodePacked(address(C.app))});
        req.recipient = Caip.account(C.id, address(C.app));
        req.hops = _hopsABC();
        req.mode = RouteTypes.Mode.FASTEST;
        req.constraints.deadline = uint64(block.timestamp + 1 hours);
        req.payloadType = RouteTypes.PayloadType.RAW;
        req.payload = "hello from A";
        req.escrow = escrow;
        req.payee = escrow > 0 ? payee : address(0);
    }

    function _sendAs(address who, IClprRouter.SendRequest memory req, uint256 value) internal returns (bytes16) {
        vm.prank(who);
        return A.router.send{value: value}(req);
    }

    // ═════════════════════════════════════════════════════════════════════
    // In-process relay (plays the CLPR endpoints and the permissionless pumpers)
    // ═════════════════════════════════════════════════════════════════════

    /// @dev Relay everything until quiet. Returns the number of bundles submitted.
    function _settle() internal returns (uint256 bundles) {
        for (uint256 round = 0; round < 20; round++) {
            uint256 n = _relay(A, B, chAB) + _relay(B, A, chAB) + _relay(B, C, chBC) + _relay(C, B, chBC);
            if (n == 0) return bundles;
            bundles += n;
        }
        revert("relay did not settle");
    }

    /// @dev Relay one direction of one Channel: one bundle with all unreceived messages and the latest ack,
    ///      then complete any Router hops that were deferred inside delivery.
    function _relay(Ledger memory src, Ledger memory dst, bytes32 ch) internal returns (uint256) {
        (uint256 n,) = _relayWithLogs(src, dst, ch);
        return n;
    }

    /// @dev As {_relay}, also returning the logs emitted while the bundle was delivered.
    function _relayWithLogs(Ledger memory src, Ledger memory dst, bytes32 ch)
        internal
        returns (uint256, Vm.Log[] memory logs)
    {
        bytes memory bundle = _bundle(src, dst, ch);
        if (bundle.length == 0) return (0, logs);
        vm.recordLogs();
        uint256 g = gasleft();
        dst.service.submitBundle(ch, bundle);
        lastSubmitGas = g - gasleft();
        logs = vm.getRecordedLogs();
        _pump(logs);
        return (1, logs);
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
        ClprTypes.QueueMetadata memory meta = ClprTypes.QueueMetadata({
            nextMessageId: s.nextMessageId,
            sentRunningHash: s.sentRunningHash,
            receivedMessageId: s.receivedMessageId,
            receivedRunningHash: s.receivedRunningHash,
            state: s.status,
            endpointManifestVersion: s.endpointManifestVersion
        });
        return ClprProtobuf.encodeBundleContent(meta, payloads);
    }

    /// @dev Complete deferred hops: ForwardPending → forward(envelope, []), OutboxQueued → flush(...).
    function _pump(Vm.Log[] memory logs) internal {
        uint256 g = gasleft();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] == IClprRouter.ForwardPending.selector) {
                (, bytes memory env) = abi.decode(logs[i].data, (uint32, bytes));
                vm.recordLogs();
                // A held receipt stays held (reverts) while its disable is in force; tests retry it explicitly.
                try ClprRouter(logs[i].emitter).forward(env, new RouteTypes.Hop[](0)) {} catch {}
                _pump(vm.getRecordedLogs()); // a pumped hop may itself stop and queue a receipt
            } else if (logs[i].topics[0] == IClprRouter.OutboxQueued.selector) {
                (bytes32 c, bytes32 k, bytes memory target, bytes memory data) =
                    abi.decode(logs[i].data, (bytes32, bytes32, bytes, bytes));
                vm.recordLogs();
                // A queued receipt stays queued (reverts) while its edge is blocked or the send fails.
                try ClprRouter(logs[i].emitter).flush(c, k, target, data) {} catch {}
                _pump(vm.getRecordedLogs());
            }
        }
        lastPumpGas = g - gasleft();
    }

    // ═════════════════════════════════════════════════════════════════════
    // Registry helpers acting on one or all ledgers
    // ═════════════════════════════════════════════════════════════════════

    function _applyAll(uint8 action, bytes memory payload) internal {
        _apply(A.registry, action, payload);
        _apply(B.registry, action, payload);
        _apply(C.registry, action, payload);
    }

    /// @dev Certify every ledger for `label` and let the notice period pass.
    function _certifyAll(uint8 label, uint64 emissionsUg) internal {
        uint64 expiry = uint64(block.timestamp + CERT_NOTICE + 300 days);
        string[3] memory ids = [ID_A, ID_B, ID_C];
        for (uint256 i = 0; i < 3; i++) {
            _applyAll(A_CERTIFY, _certifyPayload(ids[i], label, expiry, emissionsUg));
        }
    }

    /// @dev Hop-state key (on B or C) of route `id` sent from A.
    function _hk(bytes16 id) internal view returns (bytes32) {
        return _key(ID_A, address(A.router), id);
    }

    function _routeStatus(bytes16 id) internal view returns (IClprRouter.RouteStatus s) {
        (,, s,,,,,,,,,,,) = A.router.routes(id);
    }

    receive() external payable {}
}
