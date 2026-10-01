// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {ClprService} from "@hiero-ledger/clpr/ClprService.sol";
import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprTypes} from "@hiero-ledger/clpr/libraries/ClprTypes.sol";
import {ClprProtobuf} from "@hiero-ledger/clpr/libraries/codec/ClprProtobuf.sol";
import {ChannelLogic} from "@hiero-ledger/clpr/logic/ChannelLogic.sol";
import {MessagingLogic} from "@hiero-ledger/clpr/logic/MessagingLogic.sol";
import {BundleLogic} from "@hiero-ledger/clpr/logic/BundleLogic.sol";
import {ConnectorLogic} from "@hiero-ledger/clpr/logic/ConnectorLogic.sol";
import {AdminLogic} from "@hiero-ledger/clpr/logic/AdminLogic.sol";
import {BundleDecodeHelper} from "@hiero-ledger/clpr/libraries/codec/BundleDecodeHelper.sol";
import {E2EVerifier} from "@test/E2EVerifier.sol";
import {MockClprConnector} from "@test/mocks/MockClprConnector.sol";

import {ClprRouter} from "@clprouter/ClprRouter.sol";
import {ClprRouterDeployer} from "@clprouter/ClprRouterDeployer.sol";
import {IClprRouter, IClprRouterDeployer} from "@clprouter/interfaces/IClprRouter.sol";
import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {QuarantineVault} from "@clprouter/QuarantineVault.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {IQuarantineVault} from "@clprouter/interfaces/IQuarantineVault.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {RouteLogic} from "@clprouter/libraries/RouteLogic.sol";
import {RouteApp} from "../../test/helpers/RouteApp.sol";

/// @notice CLPRouter end-to-end run that routes THROUGH a local Hiero network:
///         A (anvil, eip155:31001) → H (Hiero Solo EVM, eip155:1338) → B (anvil, eip155:31002), and the DELIVERED
///         receipt back B → H → A. Driven step by step by script/e2e-hiero/run.sh; every step is one
///         `forge script` run that broadcasts to exactly one chain (the --rpc-url one, passed as `here`) and reads
///         the others through forks.
///
///         Each ledger runs the unchanged reference ClprService and the CLPR repo's E2EVerifier (bundle decoded,
///         no cryptographic check), as in the CLPR repo's anvil:solo roundtrip spec. The real Hiero → EVM proof
///         (TSS-signed block proof + HIP-1081 state proof checked by HieroVerifier) is probed separately by
///         run.sh; see the README section "End-to-end through Hiero".
///
///         Hiero specifics handled here (index 1): msg.value inside the EVM is in tinybars (1e-8 HBAR) while
///         transaction values are in weibars (1e-18 HBAR), and the relay does not carry tx.value into the
///         ClprService's delegatecall modules, so the Connector on H posts no locked stake (minLockedStake 0)
///         and is funded with a plain transfer; H only forwards, it never holds route funds.
///
///         Routers are deployed by one ClprRouterDeployer at their canonical CREATE2 addresses. The deployer is
///         the first contract the deployer key creates after the two libraries (nonce 2) on each chain, so it has
///         the same address on A, H and B without relying on a deterministic-deployment proxy on Solo. Each vault
///         is bound to its ledger's Router by a k + 1 committee decision.
contract E2EHiero is Script {
    // anvil default accounts 0 (deployer, relayer, also funded on Solo by run.sh) and 1 (alice, sender on A)
    uint256 internal constant DEPLOYER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant ALICE_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant CHANNEL_PK = 0xC1A;
    uint8 internal constant H = 1;
    string internal constant CONTACT = "mailto:incident@provider.example";
    /// @dev Deployment id of the e2e registries (EIP-712 domain salt of every committee decision).
    bytes32 internal constant DEPLOYMENT_ID = keccak256("clprouter-e2e-hiero");
    /// @dev Deployment salt of the Routers (ClprRouterDeployer.DEPLOYMENT_SALT).
    bytes32 internal constant ROUTER_SALT = keccak256("clprouter-e2e-hiero.routers");
    uint8 internal constant K = 3;
    uint8 internal constant ACTION_VAULT_BIND_ROUTER = 12;

    struct Ledger {
        string id;
        string rpc;
        uint256 fork;
        ClprService service;
        ProviderRegistry registry;
        QuarantineVault vault;
        ClprRouter router;
        RouteApp app;
    }

    Ledger[3] internal L;
    bytes32 internal chAH;
    bytes32 internal chHB;
    bytes32 internal connAH;
    bytes32 internal connHB;
    uint256[5] internal committeePks = [uint256(0xA11CE), 0xB0B, 0xCA401, 0xD00D, 0xE7E];

    ClprTypes.Throttles internal throttles = ClprTypes.Throttles({
        maxMessagesPerBundle: 100,
        maxMessagePayloadBytes: 16_384,
        maxGasPerMessage: 3_000_000,
        maxQueueDepth: 1000,
        maxSyncBytes: 1_048_576,
        maxLocalEndpoints: 0,
        maxPeerEndpoints: 0
    });

    // ═════════════════════════════════════════════════════════════════════
    // Deployment (one chain per run)
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Deploy ClprService (reference, unchanged), registry, vault, Router and test app on `here`.
    function deployStack(uint8 here) external {
        _ctx(here);
        address deployerKey = vm.addr(DEPLOYER_PK);
        require(vm.getNonce(deployerKey) == 2, "deployer key must be at nonce 2 (after the two libraries)");
        bytes memory routerInit = type(ClprRouter).creationCode;
        vm.startBroadcast(DEPLOYER_PK);
        // Nonce 2 on every chain, same constructor arguments → the same deployer address on A, H and B.
        ClprRouterDeployer deployer = new ClprRouterDeployer(deployerKey, ROUTER_SALT, keccak256(routerInit));
        require(address(deployer) == vm.computeCreateAddress(deployerKey, 2), "deployer address");
        ClprService svc = new ClprService(
            vm.addr(DEPLOYER_PK),
            1,
            L[here].id,
            address(new ChannelLogic()),
            address(new MessagingLogic()),
            address(new BundleLogic()),
            address(new ConnectorLogic()),
            address(new AdminLogic()),
            address(new BundleDecodeHelper())
        );
        svc.initialize(abi.encodePacked(address(svc)), throttles, "", "", _econ(here));
        svc.setClprEnabled(true);
        ProviderRegistry reg = new ProviderRegistry(
            DEPLOYMENT_ID, _members(), K, CONTACT, [uint64(7 days), 72 hours, 7 days, 7 days, 30 days, 7 days]
        );
        QuarantineVault vault = new QuarantineVault(IProviderRegistry(address(reg)), 3 days, 7 days);
        ClprRouter router = ClprRouter(
            deployer.deploy(
                routerInit,
                IClprRouterDeployer.Params({
                    service: IClprService(address(svc)),
                    registry: IProviderRegistry(address(reg)),
                    vault: IQuarantineVault(address(vault)),
                    ledgerId: L[here].id,
                    reclaimGrace: 1 hours,
                    appGas: 300_000,
                    minSendGas: 1_500_000
                })
            )
        );
        require(address(router) == deployer.routerAddress(L[here].id), "router not canonical");
        vm.stopBroadcast();

        // The committee binds the vault to this Router (k + 1 signatures over the vault-bound digest).
        IProviderRegistry.Decision memory d = IProviderRegistry.Decision({
            action: ACTION_VAULT_BIND_ROUTER,
            payload: abi.encode(address(router)),
            evidenceHash: keccak256("e2e: bind vault to the canonical Router"),
            nonce: 1,
            effectiveAt: 0,
            validUntil: uint64(block.timestamp + 1 days),
            epoch: reg.epoch()
        });
        bytes[] memory sigs = _sign(vault.decisionDigest(d), reg.requiredSignatures(ACTION_VAULT_BIND_ROUTER));
        vm.startBroadcast(DEPLOYER_PK);
        vault.bindRouter(d, sigs);
        RouteApp app = new RouteApp();
        app.setRouter(address(router));
        vm.stopBroadcast();

        string memory k = string.concat("L", vm.toString(here));
        vm.serializeAddress(k, "service", address(svc));
        vm.serializeAddress(k, "registry", address(reg));
        vm.serializeAddress(k, "vault", address(vault));
        vm.serializeAddress(k, "router", address(router));
        vm.serializeAddress(k, "deployer", address(deployer));
        vm.writeJson(vm.serializeAddress(k, "app", address(app)), _file(here));
        console.log("router", L[here].id, address(router));
        console.log("service", L[here].id, address(svc));
    }

    /// @notice Open this ledger's side of the Channel to `peer` (commit-reveal with the E2EVerifier).
    function wireChannel(uint8 here, uint8 peer) external {
        _load(here);
        Vm.Wallet memory w = vm.createWallet(CHANNEL_PK);
        bytes memory pubKey = abi.encodePacked(w.publicKeyX, w.publicKeyY);
        bytes32 ch = _channelOf(here, peer);
        bytes32 h = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32", keccak256(abi.encodePacked(ch, address(L[here].service)))
            )
        );
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(CHANNEL_PK, h);
        vm.startBroadcast(DEPLOYER_PK);
        E2EVerifier v = new E2EVerifier();
        v.configure(
            L[peer].id, abi.encodePacked(address(L[peer].service)), 1000, throttles, "", "", new ClprTypes.Endpoint[](0)
        );
        L[here].service.registerChannel(ch, keccak256(abi.encodePacked(ch, pubKey)));
        L[here].service.completeChannel(ch, pubKey, abi.encodePacked(r, s, sv), _salt(ch), address(v), hex"0001", "");
        vm.stopBroadcast();
    }

    /// @notice Register this ledger's side of the Connector for the Channel to `peer` (same id on both sides).
    function wireConnector(uint8 here, uint8 peer) external {
        _load(here);
        bytes32 ch = _channelOf(here, peer);
        bytes32 seed = ch == chAH ? bytes32("conn-AH") : bytes32("conn-HB");
        uint256 pk = uint256(keccak256(abi.encodePacked("clpr.test.connectorSigner", seed)));
        Vm.Wallet memory w = vm.createWallet(pk);
        bytes memory pubKey = abi.encodePacked(w.publicKeyX, w.publicKeyY);
        bytes32 id = L[here].service.deriveConnectorId(ch, pubKey, bytes32(0));
        require(id == (ch == chAH ? connAH : connHB), "connector id");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            pk,
            keccak256(
                abi.encodePacked(
                    "\x19Ethereum Signed Message:\n32", keccak256(abi.encodePacked(id, address(L[here].service)))
                )
            )
        );
        vm.startBroadcast(DEPLOYER_PK);
        MockClprConnector c = new MockClprConnector();
        // On H: 100 HBAR (tx value in weibars); pays the endpoint gas * tx.gasprice (tinybars) per delivery.
        (bool ok,) = address(c).call{value: here == H ? 100 ether : 10 ether}("");
        require(ok, "fund connector");
        L[here].service.registerConnector(keccak256(abi.encodePacked(id, pubKey)));
        L[here].service.completeConnector{value: here == H ? 0 : 1 ether}(
            id, pubKey, abi.encodePacked(r, s, v), bytes32(0), ch, address(c), vm.addr(DEPLOYER_PK)
        );
        vm.stopBroadcast();
    }

    // ═════════════════════════════════════════════════════════════════════
    // Route: A → H → B with a 1 ETH escrow on A, receipt back B → H → A
    // ═════════════════════════════════════════════════════════════════════

    /// @notice On A (here = 0): alice sends the route with a 1 ETH escrow and a 0.1 ETH fee budget.
    function send(uint8 here) external {
        _load(here);
        IClprRouter.SendRequest memory req;
        req.destination = RouteTypes.Endpoint({ledgerId: L[2].id, application: abi.encodePacked(address(L[2].app))});
        req.recipient = Caip.account(L[2].id, address(L[2].app));
        req.hops = new RouteTypes.Hop[](3);
        req.hops[0] = _hop(0, chAH, connAH, 0.01 ether, _feePayee(0));
        req.hops[1] = _hop(1, chHB, connHB, 0.02 ether, _feePayee(1));
        req.hops[2] = _hop(2, bytes32(0), bytes32(0), 0, address(0));
        req.mode = RouteTypes.Mode.CHEAPEST;
        req.constraints.deadline = uint64(block.timestamp + 2 hours);
        req.payload = "e2e through Hiero";
        req.isoUetr = bytes16(keccak256("e2e-hiero-uetr-1"));
        req.escrow = 1 ether;
        req.payee = _payee();
        bytes16 expected = _routeId();
        vm.startBroadcast(ALICE_PK);
        bytes16 id = L[here].router.send{value: 1.1 ether}(req);
        vm.stopBroadcast();
        require(id == expected, "route id is not the Router-derived one");
        console.log("ROUTE_ID");
        console.logBytes16(id);
    }

    // ═════════════════════════════════════════════════════════════════════
    // relay(src, here): one bundle src → here, then complete deferred Router hops on `here`
    // ═════════════════════════════════════════════════════════════════════

    function relay(uint8 src, uint8 here) external {
        _load(here);
        bytes32 ch = _channelOf(src, here);
        uint8 dst = here;

        vm.selectFork(L[src].fork);
        ClprTypes.Channel memory s = L[src].service.getChannel(ch);
        bytes[] memory payloads;
        vm.selectFork(L[dst].fork);
        ClprTypes.Channel memory d = L[dst].service.getChannel(ch);
        uint64 from = d.receivedMessageId + 1;
        uint64 count = s.nextMessageId > from ? s.nextMessageId - from : 0;
        if (count == 0 && s.receivedMessageId <= d.ackedMessageId) {
            console.log("RELAY_BUNDLES 0");
            return;
        }
        vm.selectFork(L[src].fork);
        payloads = new bytes[](count);
        for (uint64 i = 0; i < count; i++) {
            payloads[i] = L[src].service.getMessage(ch, from + i).payload;
        }
        bytes memory bundle = ClprProtobuf.encodeBundleContent(
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

        vm.selectFork(L[dst].fork);
        vm.recordLogs();
        vm.startBroadcast(DEPLOYER_PK);
        L[dst].service.submitBundle(ch, bundle);
        vm.stopBroadcast();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 pumped;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] == IClprRouter.ForwardPending.selector) {
                (, bytes memory env) = abi.decode(logs[i].data, (uint32, bytes));
                vm.startBroadcast(DEPLOYER_PK);
                ClprRouter(logs[i].emitter).forward(env, new RouteTypes.Hop[](0));
                vm.stopBroadcast();
                pumped++;
            } else if (logs[i].topics[0] == IClprRouter.OutboxQueued.selector) {
                (bytes32 c, bytes32 k, bytes memory target, bytes memory data) =
                    abi.decode(logs[i].data, (bytes32, bytes32, bytes, bytes));
                vm.startBroadcast(DEPLOYER_PK);
                ClprRouter(logs[i].emitter).flush(c, k, target, data);
                vm.stopBroadcast();
                pumped++;
            }
        }
        console.log("RELAY_BUNDLES 1");
        console.log("RELAY_MESSAGES", count);
        console.log("RELAY_PUMPED", pumped);
        console.log("RELAY_CHANNEL");
        console.logBytes32(ch);
        console.log("RELAY_SOURCE_SERVICE", address(L[src].service));
    }

    // ═════════════════════════════════════════════════════════════════════
    // check(): assert the outcome on A, H and B
    // ═════════════════════════════════════════════════════════════════════

    function check() external {
        _load(0);
        bytes16 id = _routeId();
        vm.selectFork(L[0].fork);
        (,, IClprRouter.RouteStatus status,,,,,,,,,,,) = L[0].router.routes(id);
        uint256 payeeBal = _payee().balance;
        uint256 fee0 = L[0].router.owed(_feePayee(0)) + _feePayee(0).balance;
        uint256 fee1 = L[0].router.owed(_feePayee(1)) + _feePayee(1).balance;
        vm.selectFork(L[H].fork);
        // Hop state is keyed by (origin ledger, origin Router, route id) (RouteLogic.inboundKey).
        bytes32 key =
            keccak256(abi.encode(keccak256(bytes(L[0].id)), keccak256(abi.encodePacked(address(L[0].router))), id));
        IClprRouter.HopState hState = L[H].router.hopState(key);
        vm.selectFork(L[2].fork);
        uint256 delivered = L[2].app.deliveredCount();

        require(status == IClprRouter.RouteStatus.DELIVERED, string.concat("route status ", vm.toString(uint8(status))));
        require(payeeBal == 1 ether, "payee paid on A");
        require(delivered == 1, "delivered on B");
        console.log("CHECK_OK");
        console.log("  status on A (2 = DELIVERED)", uint8(status));
        console.log("  hop state on H", uint8(hState));
        console.log("  delivered on B", delivered);
        console.log("  payee on A", payeeBal);
        console.log("  fees owed/paid on A: hop A, hop H", fee0, fee1);
    }

    /// @notice Print the deployed H service and the H → B / H → A channel ids (for the Hiero proof probe).
    function info() external {
        _load(H);
        console.log("H_SERVICE", address(L[H].service));
        console.log("H_CH_HB");
        console.logBytes32(chHB);
        console.log("H_CH_AH");
        console.logBytes32(chAH);
    }

    // ═════════════════════════════════════════════════════════════════════
    // helpers
    // ═════════════════════════════════════════════════════════════════════

    function _members() internal view returns (address[] memory m) {
        m = new address[](5);
        for (uint256 i = 0; i < 5; i++) {
            m[i] = vm.addr(committeePks[i]);
        }
        for (uint256 i = 1; i < 5; i++) {
            for (uint256 j = i; j > 0 && m[j - 1] > m[j]; j--) {
                (m[j - 1], m[j]) = (m[j], m[j - 1]);
            }
        }
    }

    /// @dev On H, amounts are tinybars inside the EVM and value does not reach the delegatecall modules:
    ///      no stake or bond (as the CLPR harness's `wireConfig({soloRelay: true})`).
    function _econ(uint8 here) internal pure returns (ClprTypes.EconomicConfig memory) {
        bool h = here == H;
        return ClprTypes.EconomicConfig({
            messageExecutionCost: h ? 0 : 0.001 ether,
            endpointMarginPercent: 10,
            minLockedStake: h ? 0 : 0.1 ether,
            minEndpointBond: 0,
            basePenalty: h ? 0 : 0.01 ether,
            penaltyMultiplier: 2,
            slashBanThreshold: 5,
            connectorQueueQuotaPct: 50,
            connectorInboundGasStipend: 500_000,
            maxChannels: 0,
            maxConnectors: 0
        });
    }

    function _hop(uint256 i, bytes32 ch, bytes32 conn, uint64 fee, address feePayee)
        internal
        view
        returns (RouteTypes.Hop memory)
    {
        return RouteTypes.Hop({
            ledgerId: L[i].id,
            router: abi.encodePacked(address(L[i].router)),
            channelId: ch,
            connectorId: conn,
            fee: fee,
            feePayee: feePayee == address(0) ? bytes("") : abi.encodePacked(feePayee)
        });
    }

    /// @dev EIP-191 signatures over `digest` by the first `need` committee members in address order.
    function _sign(bytes32 digest, uint256 need) internal view returns (bytes[] memory sigs) {
        bytes32 h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        address[] memory m = _members();
        sigs = new bytes[](need);
        for (uint256 j = 0; j < need; j++) {
            uint256 pk;
            for (uint256 q = 0; q < 5; q++) {
                if (vm.addr(committeePks[q]) == m[j]) pk = committeePks[q];
            }
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
            sigs[j] = abi.encodePacked(r, s, v);
        }
    }

    function _payee() internal pure returns (address) {
        return address(uint160(uint256(keccak256("e2e-hiero-payee"))));
    }

    function _feePayee(uint256 i) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked("e2e-hiero-fee", i)))));
    }

    function _channelOf(uint8 x, uint8 y) internal view returns (bytes32) {
        return x + y == 1 ? chAH : chHB; // {A,H} → chAH, {H,B} → chHB
    }

    /// @dev Set up `here` as the broadcast chain (the --rpc-url fork) and create read forks for the others.
    function _ctx(uint8 here) internal {
        string[3] memory ids = ["eip155:31001", "eip155:1338", "eip155:31002"];
        string[3] memory rpcs = [
            vm.envOr("RPC_A", string("http://127.0.0.1:18545")),
            vm.envOr("RPC_H", string("http://127.0.0.1:37547")),
            vm.envOr("RPC_B", string("http://127.0.0.1:18546"))
        ];
        uint256 active = vm.activeFork();
        for (uint256 i = 0; i < 3; i++) {
            L[i].id = ids[i];
            L[i].rpc = rpcs[i];
            L[i].fork = i == here ? active : vm.createFork(rpcs[i]);
        }
        Vm.Wallet memory w = vm.createWallet(CHANNEL_PK);
        bytes memory pubKey = abi.encodePacked(w.publicKeyX, w.publicKeyY);
        chAH = _channelId(ids[0], ids[1], pubKey, bytes32("AH"));
        chHB = _channelId(ids[1], ids[2], pubKey, bytes32("HB"));
        connAH = _connectorId(chAH, bytes32("conn-AH"));
        connHB = _connectorId(chHB, bytes32("conn-HB"));
    }

    function _load(uint8 here) internal {
        _ctx(here);
        for (uint256 i = 0; i < 3; i++) {
            string memory json = vm.readFile(_file(i));
            L[i].service = ClprService(payable(vm.parseJsonAddress(json, ".service")));
            L[i].registry = ProviderRegistry(vm.parseJsonAddress(json, ".registry"));
            L[i].vault = QuarantineVault(vm.parseJsonAddress(json, ".vault"));
            L[i].router = ClprRouter(vm.parseJsonAddress(json, ".router"));
            L[i].app = RouteApp(payable(vm.parseJsonAddress(json, ".app")));
        }
        vm.selectFork(L[here].fork);
    }

    function _file(uint256 i) internal view returns (string memory) {
        return string.concat("e2e-out/hiero/L", vm.toString(i), ".json");
    }

    function _channelId(string memory x, string memory y, bytes memory pubKey, bytes32 salt)
        internal
        pure
        returns (bytes32)
    {
        (bytes memory a, bytes memory b) =
            keccak256(bytes(x)) <= keccak256(bytes(y)) ? (bytes(x), bytes(y)) : (bytes(y), bytes(x));
        return keccak256(abi.encodePacked(a, b, pubKey, salt));
    }

    function _salt(bytes32 ch) internal view returns (bytes32) {
        return ch == chAH ? bytes32("AH") : bytes32("HB");
    }

    /// @dev connector_id = keccak256(channel_id || public_key || salt) (CLPR spec §2.2), salt = 0.
    function _connectorId(bytes32 ch, bytes32 seed) internal returns (bytes32) {
        Vm.Wallet memory w = vm.createWallet(uint256(keccak256(abi.encodePacked("clpr.test.connectorSigner", seed))));
        return keccak256(abi.encodePacked(ch, abi.encodePacked(w.publicKeyX, w.publicKeyY), bytes32(0)));
    }

    /// @dev Route id the Router on A derives for alice's first route (nonce 0).
    function _routeId() internal view returns (bytes16) {
        return RouteLogic.routeId(keccak256(bytes(L[0].id)), address(L[0].router), vm.addr(ALICE_PK), 0);
    }
}
