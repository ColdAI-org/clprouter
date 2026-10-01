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
import {RouteApp} from "../test/helpers/RouteApp.sol";

/// @notice Cross-process end-to-end run of CLPRouter on three anvil chains A (31001) — B (31002) — C (31003),
///         each with the unchanged reference ClprService and the CLPR repo's E2EVerifier. Driven step by step
///         by script/e2e/run.sh: every step is one `forge script` run that reads live chain state.
///
///         Every step broadcasts to exactly one chain — the one given with --rpc-url, passed as `here` — and
///         only reads the other chains through forks (multi-chain broadcasts cannot link libraries).
///         Steps: deployStack · wireChannel · wireConnector · setAppRevert · send · decide · relay · check.
///
///         Every Router is deployed by one ClprRouterDeployer at its canonical CREATE2 address. The deployer
///         itself is created through the deterministic-deployment proxy (0x4e59b448…, installed by run.sh with
///         anvil_setCode if anvil lacks it) with the same owner, salt and Router init-code hash on every chain, so
///         it has one address on A, B and C. Each vault is bound to its ledger's Router by a k + 1 committee
///         decision before the first route is sent.
///         relay() plays the CLPR endpoint (copies the source queue into a bundle and submits it on the
///         destination) and the permissionless pumper (completes Router hops deferred inside delivery).
contract E2E is Script {
    // anvil default accounts 0 (deployer, relayer) and 1 (alice, the paying sender on A)
    uint256 internal constant DEPLOYER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant ALICE_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant CHANNEL_PK = 0xC1A;
    string internal constant CONTACT = "mailto:incident@provider.example";
    bytes32 internal constant CASE = keccak256("e2e-case-1");
    /// @dev Deployment id of the e2e registries (EIP-712 domain salt of every committee decision).
    bytes32 internal constant DEPLOYMENT_ID = keccak256("clprouter-e2e");
    /// @dev CREATE2 salt of the ClprRouterDeployer (through the deterministic-deployment proxy) and the
    ///      deployment salt of the Routers it deploys.
    bytes32 internal constant DEPLOYER_SALT = keccak256("clprouter-e2e.deployer");
    bytes32 internal constant ROUTER_SALT = keccak256("clprouter-e2e.routers");
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
    bytes32 internal chAB;
    bytes32 internal chBC;
    bytes32 internal connAB;
    bytes32 internal connBC;
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
        vm.startBroadcast(DEPLOYER_PK);
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
        svc.initialize(abi.encodePacked(address(svc)), throttles, "", "", _econ());
        svc.setClprEnabled(true);
        ProviderRegistry reg = new ProviderRegistry(
            DEPLOYMENT_ID, _members(), K, CONTACT, [uint64(7 days), 72 hours, 7 days, 7 days, 30 days, 7 days]
        );
        QuarantineVault vault = new QuarantineVault(IProviderRegistry(address(reg)), 3 days, 7 days);
        bytes memory routerInit = type(ClprRouter).creationCode;
        // Same owner, salt and init-code hash on every chain → the same deployer address on A, B and C.
        ClprRouterDeployer deployer =
            new ClprRouterDeployer{salt: DEPLOYER_SALT}(vm.addr(DEPLOYER_PK), ROUTER_SALT, keccak256(routerInit));
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
        console.log("deployer", address(deployer));
    }

    /// @notice Open this ledger's side of the Channel to `peer` (commit-reveal with the E2EVerifier).
    function wireChannel(uint8 here, uint8 peer) external {
        _load(here);
        Vm.Wallet memory w = vm.createWallet(CHANNEL_PK);
        bytes memory pubKey = abi.encodePacked(w.publicKeyX, w.publicKeyY);
        bytes32 ch = here + peer == 1 ? chAB : chBC;
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
        bytes32 ch = here + peer == 1 ? chAB : chBC;
        bytes32 seed = here + peer == 1 ? bytes32("conn-AB") : bytes32("conn-BC");
        uint256 pk = uint256(keccak256(abi.encodePacked("clpr.test.connectorSigner", seed)));
        Vm.Wallet memory w = vm.createWallet(pk);
        bytes memory pubKey = abi.encodePacked(w.publicKeyX, w.publicKeyY);
        bytes32 id = L[here].service.deriveConnectorId(ch, pubKey, bytes32(0));
        require(id == (here + peer == 1 ? connAB : connBC), "connector id");
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
        (bool ok,) = address(c).call{value: 10 ether}("");
        require(ok, "fund connector");
        L[here].service.registerConnector(keccak256(abi.encodePacked(id, pubKey)));
        L[here].service.completeConnector{value: 1 ether}(
            id, pubKey, abi.encodePacked(r, s, v), bytes32(0), ch, address(c), vm.addr(DEPLOYER_PK)
        );
        vm.stopBroadcast();
    }

    // ═════════════════════════════════════════════════════════════════════
    // Scenarios: one route A → B → C each
    //   1 delivered with escrow · 2 destination app reverts · 3 edge B→C disabled mid-route
    //   4 recipient blacklisted on B mid-route · 5 deadline passes before B
    // ═════════════════════════════════════════════════════════════════════

    /// @notice On C (here = 2): make the destination app revert or not.
    function setAppRevert(uint8 here, bool v) external {
        _load(here);
        vm.startBroadcast(DEPLOYER_PK);
        L[here].app.setShouldRevert(v);
        vm.stopBroadcast();
    }

    /// @notice On A (here = 0): alice sends route `n` with a 1 ETH escrow and a 0.1 ETH fee budget.
    function send(uint8 here, uint8 n) external {
        _load(here);
        IClprRouter.SendRequest memory req;
        req.destination = RouteTypes.Endpoint({ledgerId: L[2].id, application: abi.encodePacked(address(L[2].app))});
        req.recipient = Caip.account(L[2].id, address(L[2].app));
        req.hops = new RouteTypes.Hop[](3);
        req.hops[0] = _hop(0, chAB, connAB, 0.01 ether, _feePayee(0));
        req.hops[1] = _hop(1, chBC, connBC, 0.02 ether, _feePayee(1));
        req.hops[2] = _hop(2, bytes32(0), bytes32(0), 0, address(0));
        req.mode = RouteTypes.Mode.CHEAPEST;
        req.constraints.deadline = uint64(block.timestamp + (n == 5 ? 60 : 1 hours));
        req.payload = abi.encodePacked("e2e scenario ", vm.toString(n));
        req.isoUetr = _uetr(n);
        req.escrow = 1 ether;
        req.payee = _payee(n);
        bytes16 expected = _routeId(n);
        vm.startBroadcast(ALICE_PK);
        bytes16 id = L[here].router.send{value: 1.1 ether}(req);
        vm.stopBroadcast();
        require(id == expected, "route id is not the Router-derived one");
        console.log("ROUTE_ID");
        console.logBytes16(id);
    }

    /// @notice On B (here = 1): relay the provider decision of scenario `n` (k + 1 committee signatures).
    function decide(uint8 here, uint8 n) external {
        _load(here);
        if (n == 3) {
            _decide(here, 3, abi.encode(uint8(1), Caip.edgeKey(chBC, L[2].id), "e2e: verifier B->C compromised"));
        } else if (n == 4) {
            _decide(here, 5, abi.encode(Caip.account(L[2].id, address(L[2].app)), CASE, "e2e: exploit proceeds"));
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // relay(src, here): one bundle src → here, then complete deferred Router hops on `here`
    // ═════════════════════════════════════════════════════════════════════

    function relay(uint8 src, uint8 here) external {
        _load(here);
        bytes32 ch = (src + here == 1) ? chAB : chBC;
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
    }

    // ═════════════════════════════════════════════════════════════════════
    // check(n): assert the outcome on A (and C)
    // ═════════════════════════════════════════════════════════════════════

    function check(uint8 n) external {
        _load(0);
        bytes16 id = _routeId(n);
        vm.selectFork(L[0].fork);
        (,, IClprRouter.RouteStatus status,,,,,,,,,,,) = L[0].router.routes(id);
        uint256 payeeBal = _payee(n).balance;
        uint256 vaultBal = address(L[0].vault).balance;
        vm.selectFork(L[2].fork);
        uint256 delivered = L[2].app.deliveredCount();

        IClprRouter.RouteStatus want = n == 1
            ? IClprRouter.RouteStatus.DELIVERED
            : n == 4
                ? IClprRouter.RouteStatus.QUARANTINED
                : n == 5 ? IClprRouter.RouteStatus.EXPIRED : IClprRouter.RouteStatus.FAILED;
        require(
            status == want, string.concat("route status ", vm.toString(uint8(status)), " != ", vm.toString(uint8(want)))
        );
        if (n == 1) require(payeeBal == 1 ether, "payee paid");
        else require(payeeBal == 0, "payee not paid");
        if (n == 4) require(vaultBal >= 1 ether, "escrow quarantined on A");
        console.log("CHECK_OK scenario", n);
        console.log("  status", uint8(status));
        console.log("  delivered on C (cumulative)", delivered);
        console.log("  vault on A", vaultBal);
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

    function _econ() internal pure returns (ClprTypes.EconomicConfig memory) {
        return ClprTypes.EconomicConfig({
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

    function _payee(uint8 n) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked("e2e-payee", n)))));
    }

    function _feePayee(uint256 i) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked("e2e-fee", i)))));
    }

    /// @dev Relay a committee decision (k + 1 signatures) to the registry on ledger `i`.
    function _decide(uint256 i, uint8 action, bytes memory payload) internal {
        vm.selectFork(L[i].fork);
        ProviderRegistry reg = L[i].registry;
        IProviderRegistry.Decision memory d = IProviderRegistry.Decision({
            action: action,
            payload: payload,
            evidenceHash: keccak256(payload),
            nonce: reg.version() + 1,
            effectiveAt: 0,
            validUntil: uint64(block.timestamp + 1 days),
            epoch: reg.epoch()
        });
        bytes[] memory sigs = _sign(reg.decisionDigest(d), reg.requiredSignatures(action));
        vm.startBroadcast(DEPLOYER_PK);
        reg.submit(d, sigs);
        vm.stopBroadcast();
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

    /// @dev Set up `here` as the broadcast chain (the --rpc-url fork) and create read forks for the others.
    function _ctx(uint8 here) internal {
        string[3] memory ids = ["eip155:31001", "eip155:31002", "eip155:31003"];
        string[3] memory rpcs = [
            vm.envOr("RPC_A", string("http://127.0.0.1:18545")),
            vm.envOr("RPC_B", string("http://127.0.0.1:18546")),
            vm.envOr("RPC_C", string("http://127.0.0.1:18547"))
        ];
        uint256 active = vm.activeFork();
        for (uint256 i = 0; i < 3; i++) {
            L[i].id = ids[i];
            L[i].rpc = rpcs[i];
            L[i].fork = i == here ? active : vm.createFork(rpcs[i]);
        }
        Vm.Wallet memory w = vm.createWallet(CHANNEL_PK);
        bytes memory pubKey = abi.encodePacked(w.publicKeyX, w.publicKeyY);
        chAB = _channelId(ids[0], ids[1], pubKey, bytes32("AB"));
        chBC = _channelId(ids[1], ids[2], pubKey, bytes32("BC"));
        connAB = _connectorId(chAB, bytes32("conn-AB"));
        connBC = _connectorId(chBC, bytes32("conn-BC"));
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
        return string.concat("e2e-out/L", vm.toString(i), ".json");
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
        return ch == chAB ? bytes32("AB") : bytes32("BC");
    }

    /// @dev connector_id = keccak256(channel_id || public_key || salt) (CLPR spec §2.2), salt = 0.
    function _connectorId(bytes32 ch, bytes32 seed) internal returns (bytes32) {
        Vm.Wallet memory w = vm.createWallet(uint256(keccak256(abi.encodePacked("clpr.test.connectorSigner", seed))));
        return keccak256(abi.encodePacked(ch, abi.encodePacked(w.publicKeyX, w.publicKeyY), bytes32(0)));
    }

    /// @dev Route id the Router on A derives for alice's route of scenario `n` (alice sends one route per
    ///      scenario, in order, so its nonce is n - 1).
    function _routeId(uint8 n) internal view returns (bytes16) {
        return RouteLogic.routeId(keccak256(bytes(L[0].id)), address(L[0].router), vm.addr(ALICE_PK), uint256(n) - 1);
    }

    /// @dev ISO 20022 UETR carried in the envelope (informational; it is not the route id).
    function _uetr(uint8 n) internal pure returns (bytes16) {
        return bytes16(keccak256(abi.encodePacked("e2e-uetr", n)));
    }
}
