// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprTypes} from "@hiero-ledger/clpr/libraries/ClprTypes.sol";

import {ClprRouter} from "@clprouter/ClprRouter.sol";
import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {QuarantineVault} from "@clprouter/QuarantineVault.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {IQuarantineVault} from "@clprouter/interfaces/IQuarantineVault.sol";
import {IClprRouterDeployer} from "@clprouter/interfaces/IClprRouter.sol";
import {ClprRouterDeployer} from "@clprouter/ClprRouterDeployer.sol";
import {RouteLogic} from "@clprouter/libraries/RouteLogic.sol";

/// @notice Deterministic, idempotent deployment of the CLPRouter stack next to an existing CLPR Service:
///         ProviderRegistry, QuarantineVault, ClprRouterDeployer and the ledger's canonical ClprRouter.
///         Driven by script/deploy/deploy.sh, which passes:
///           CANONICAL_CONFIG  script/deploy/config/canonical.json: every input shared by all networks
///           DEPLOY_CONFIG     script/deploy/config/<network>.json: chain id, CAIP-2 ledger id, RPC, tx settings
///           COMMITTEE         deployments/test-committee.json (public addresses only)
///           DEPLOYMENT_ID     optional bytes32; default keccak256(canonical.deploymentIdSeed)
///
///         Addresses. Registry, vault and deployer are created through the deterministic-deployment proxy
///         0x4e59b448… (same code at the same address on Sepolia and Hedera testnet) with a salt derived from
///         the canonical `salt` and the contract name. Their constructor inputs are all canonical, so each has
///         one address on every network. The Router's external libraries are linked and deployed by forge
///         through the same proxy (salt 0), so they too have one address everywhere and the Router's init code
///         (which takes no constructor arguments) hashes the same on every network. The deployer (owner = the
///         deployer key, DEPLOYMENT_SALT = keccak256(salt, "ClprRouter", deployment id), INIT_CODE_HASH) puts
///         the Router of ledger L at CREATE2(deployer, keccak256(abi.encode(DEPLOYMENT_SALT, keccak256(L))),
///         INIT_CODE_HASH): one canonical address per ledger, computable from any ledger. A contract whose
///         address already has code is not deployed again; the checks below then run against it.
///
///         Post-deploy checks (all `require`, so a mismatch fails the run before anything is recorded):
///           - runtime code hash equals that of a fresh deployment of the same init code at the same address
///             (re-created in a reverted snapshot): bytecode, constructor args and address-dependent immutables;
///           - constructor args read back (deployment id, committee, notices, contact, vault windows, Router
///             parameters, deployer owner / salt / init-code hash);
///           - registry wired into the vault and the Router, vault into the Router, Router's Service is the
///             configured CLPR Service whose chain id normalises to the Router's ledger id;
///           - the committee equals deployments/test-committee.json, at epoch 0, version 0, threshold k;
///           - for every ledger in canonical.ledgers, the Router's canonicalRouter() equals the deployer's
///             routerAddress().
contract DeployRouter is Script {
    // CREATE2_FACTORY (0x4e59b448…, the deterministic deployment proxy) comes from forge-std.

    struct Cfg {
        string network;
        string ledgerId;
        address service;
        bytes32 baseSalt;
        bytes32 deploymentId;
        address[] members;
        uint8 k;
        string contact;
        uint64[6] notices;
        uint64 recoveryNotice;
        uint64 challengeWindow;
        uint64 reclaimGrace;
        uint64 appGas;
        uint64 minSendGas;
        address owner;
        bytes32 routerSalt;
    }

    function run() external {
        Cfg memory c = _load();
        console.log("DEPLOYMENT_ID");
        console.logBytes32(c.deploymentId);
        require(block.chainid == vm.parseJsonUint(vm.envString("DEPLOY_CONFIG"), ".chainId"), "wrong chain");
        require(CREATE2_FACTORY.code.length > 0, "CREATE2 factory missing on this chain");
        require(
            RouteLogic.ledgerHash(IClprService(c.service).getLedgerConfiguration().chainId) == keccak256(bytes(c.ledgerId)),
            "CLPR Service chain id != ledgerId"
        );

        // ── ProviderRegistry ────────────────────────────────────────────────
        bytes memory regInit = abi.encodePacked(
            type(ProviderRegistry).creationCode, abi.encode(c.deploymentId, c.members, c.k, c.contact, c.notices)
        );
        address reg = _deploy("ProviderRegistry", _salt(c, "ProviderRegistry"), regInit);

        // ── QuarantineVault ─────────────────────────────────────────────────
        bytes memory vaultInit = abi.encodePacked(
            type(QuarantineVault).creationCode, abi.encode(reg, c.recoveryNotice, c.challengeWindow)
        );
        address vault = _deploy("QuarantineVault", _salt(c, "QuarantineVault"), vaultInit);

        // ── ClprRouterDeployer (same owner, salt and init-code hash everywhere → same address) ──
        bytes memory routerInit = type(ClprRouter).creationCode; // libraries linked by forge (CREATE2, salt 0)
        bytes memory deployerInit = abi.encodePacked(
            type(ClprRouterDeployer).creationCode, abi.encode(c.owner, c.routerSalt, keccak256(routerInit))
        );
        ClprRouterDeployer dep =
            ClprRouterDeployer(_deploy("ClprRouterDeployer", _salt(c, "ClprRouterDeployer"), deployerInit));

        // ── ClprRouter at the canonical address of this ledger ──────────────
        IClprRouterDeployer.Params memory p = IClprRouterDeployer.Params({
            service: IClprService(c.service),
            registry: IProviderRegistry(reg),
            vault: IQuarantineVault(vault),
            ledgerId: c.ledgerId,
            reclaimGrace: c.reclaimGrace,
            appGas: c.appGas,
            minSendGas: c.minSendGas
        });
        address router = dep.routerAddress(c.ledgerId);
        if (router.code.length > 0) {
            console.log("EXISTS ClprRouter", router);
        } else {
            vm.startBroadcast(vm.envUint("CLPR_TESTNET_PRIVATE_KEY"));
            address got = dep.deploy(routerInit, p);
            vm.stopBroadcast();
            require(got == router && router.code.length > 0, "ClprRouter: deploy failed");
            console.log("DEPLOYED ClprRouter", router);
        }

        // ── Post-deploy checks ──────────────────────────────────────────────
        _checkCodeHash("ProviderRegistry", reg, _salt(c, "ProviderRegistry"), regInit);
        _checkCodeHash("QuarantineVault", vault, _salt(c, "QuarantineVault"), vaultInit);
        _checkCodeHash("ClprRouterDeployer", address(dep), _salt(c, "ClprRouterDeployer"), deployerInit);
        _checkRouterCodeHash(dep, router, routerInit, p, c.owner);
        _checkRegistry(ProviderRegistry(reg), c);
        _checkVault(QuarantineVault(payable(vault)), reg, c);
        _checkDeployer(dep, routerInit, c);
        _checkRouter(ClprRouter(payable(router)), reg, vault, address(dep), c);
        console.log("CHECKS_OK");

        // Canonical addresses: the same deployer predicts every ledger's Router; this Router agrees.
        string[] memory ledgers = vm.parseJsonStringArray(vm.envString("CANONICAL_CONFIG"), ".ledgers");
        for (uint256 i = 0; i < ledgers.length; i++) {
            address a = dep.routerAddress(ledgers[i]);
            require(ClprRouter(payable(router)).canonicalRouter(ledgers[i]) == a, "canonical address disagreement");
            console.log(string.concat("CANONICAL_ROUTER ", ledgers[i]), a);
        }
        console.log("ROUTER_INIT_CODE_HASH");
        console.logBytes32(keccak256(routerInit));
    }

    /// @dev Re-deploy the Router through the deployer in a reverted snapshot (as its owner) and compare runtime hashes.
    function _checkRouterCodeHash(
        ClprRouterDeployer dep,
        address router,
        bytes memory initCode,
        IClprRouterDeployer.Params memory p,
        address owner
    ) internal {
        bytes32 live = router.codehash;
        uint256 snap = vm.snapshotState();
        vm.etch(router, "");
        vm.resetNonce(router);
        vm.prank(owner);
        address got = dep.deploy(initCode, p);
        bytes32 fresh = router.codehash;
        vm.revertToState(snap);
        require(got == router && fresh == live, "ClprRouter: runtime code hash mismatch");
        console.log("CODEHASH ClprRouter");
        console.logBytes32(live);
        console.log("CODESIZE ClprRouter", router.code.length);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Deployment
    // ═════════════════════════════════════════════════════════════════════

    function _deploy(string memory name, bytes32 salt, bytes memory initCode) internal returns (address a) {
        a = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_FACTORY);
        if (a.code.length > 0) {
            console.log(string.concat("EXISTS ", name), a);
            return a;
        }
        vm.startBroadcast(vm.envUint("CLPR_TESTNET_PRIVATE_KEY"));
        (bool ok, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(salt, initCode));
        vm.stopBroadcast();
        require(ok && ret.length == 20 && address(bytes20(ret)) == a, string.concat(name, ": CREATE2 failed"));
        require(a.code.length > 0, string.concat(name, ": no code"));
        console.log(string.concat("DEPLOYED ", name), a);
    }

    /// @dev Re-create the same init code at the same address in a reverted snapshot and compare runtime hashes.
    function _checkCodeHash(string memory name, address a, bytes32 salt, bytes memory initCode) internal {
        bytes32 live = a.codehash;
        uint256 snap = vm.snapshotState();
        vm.etch(a, "");
        vm.resetNonce(a);
        (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(salt, initCode));
        bytes32 fresh = a.codehash;
        vm.revertToState(snap);
        require(ok && fresh == live, string.concat(name, ": runtime code hash mismatch"));
        console.log(string.concat("CODEHASH ", name));
        console.logBytes32(live);
        console.log(string.concat("CODESIZE ", name), a.code.length);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Checks
    // ═════════════════════════════════════════════════════════════════════

    function _checkRegistry(ProviderRegistry r, Cfg memory c) internal view {
        address[] memory m = r.members();
        require(m.length == c.members.length, "registry: committee size");
        for (uint256 i = 0; i < m.length; i++) {
            require(m[i] == c.members[i], "registry: committee member");
            require(r.isMember(c.members[i]), "registry: isMember");
        }
        require(r.threshold() == c.k, "registry: k");
        require(r.epoch() == 0, "registry: epoch");
        require(r.version() == 0, "registry: version (decisions already applied)");
        require(keccak256(bytes(r.contact())) == keccak256(bytes(c.contact)), "registry: contact");
        require(r.CERT_NOTICE() == c.notices[0], "registry: CERT_NOTICE");
        require(r.REMOVAL_NOTICE() == c.notices[1], "registry: REMOVAL_NOTICE");
        require(r.REENABLE_NOTICE() == c.notices[2], "registry: REENABLE_NOTICE");
        require(r.DISABLE_LAPSE() == c.notices[3], "registry: DISABLE_LAPSE");
        require(r.BLACKLIST_LAPSE() == c.notices[4], "registry: BLACKLIST_LAPSE");
        require(r.COMMITTEE_NOTICE() == c.notices[5], "registry: COMMITTEE_NOTICE");
        require(r.DEPLOYMENT_ID() == c.deploymentId, "registry: DEPLOYMENT_ID");
    }

    function _checkVault(QuarantineVault v, address reg, Cfg memory c) internal view {
        require(address(v.REGISTRY()) == reg, "vault: registry not wired");
        require(v.RECOVERY_NOTICE() == c.recoveryNotice, "vault: RECOVERY_NOTICE");
        require(v.CHALLENGE_WINDOW() == c.challengeWindow, "vault: CHALLENGE_WINDOW");
    }

    function _checkDeployer(ClprRouterDeployer d, bytes memory routerInit, Cfg memory c) internal view {
        require(d.OWNER() == c.owner, "deployer: owner");
        require(d.DEPLOYMENT_SALT() == c.routerSalt, "deployer: salt");
        require(d.INIT_CODE_HASH() == keccak256(routerInit), "deployer: init code hash (libraries or bytecode differ)");
    }

    function _checkRouter(ClprRouter r, address reg, address vault, address dep, Cfg memory c) internal {
        require(address(r.SERVICE()) == c.service, "router: service");
        require(address(r.REGISTRY()) == reg, "router: registry not wired");
        require(address(r.VAULT()) == vault, "router: vault not wired");
        require(keccak256(bytes(r.ledgerId())) == keccak256(bytes(c.ledgerId)), "router: ledgerId");
        require(r.RECLAIM_GRACE() == c.reclaimGrace, "router: RECLAIM_GRACE");
        require(r.APP_GAS() == c.appGas, "router: APP_GAS");
        require(r.MIN_SEND_GAS() == c.minSendGas, "router: MIN_SEND_GAS");
        require(r.DEPLOYER() == dep, "router: DEPLOYER");
        require(r.DEPLOYMENT_SALT() == c.routerSalt, "router: DEPLOYMENT_SALT");
        ClprTypes.LedgerConfiguration memory lc = IClprService(c.service).getLedgerConfiguration();
        require(RouteLogic.ledgerHash(lc.chainId) == keccak256(bytes(r.ledgerId())), "router: ledger != service chain id");
    }

    // ═════════════════════════════════════════════════════════════════════
    // Config
    // ═════════════════════════════════════════════════════════════════════

    function _load() internal view returns (Cfg memory c) {
        string memory n = vm.envString("DEPLOY_CONFIG");
        string memory j = vm.envString("CANONICAL_CONFIG");
        string memory cm = vm.envString("COMMITTEE");
        // Per-network files must not carry constructor inputs: those live only in canonical.json.
        require(!vm.keyExistsJson(n, ".salt") && !vm.keyExistsJson(n, ".registry") && !vm.keyExistsJson(n, ".router")
            && !vm.keyExistsJson(n, ".vault") && !vm.keyExistsJson(n, ".clprService"), "network config overrides canonical");
        require(vm.parseJsonAddress(j, ".create2Factory") == CREATE2_FACTORY, "factory");
        c.network = vm.parseJsonString(n, ".network");
        c.ledgerId = vm.parseJsonString(n, ".ledgerId");
        c.service = vm.parseJsonAddress(j, ".clprService");
        c.baseSalt = keccak256(bytes(vm.parseJsonString(j, ".salt")));
        // Deployment id (domain input for committee decisions once the registry takes it; one id for the whole
        // multi-ledger deployment so decisions relay across ledgers): DEPLOYMENT_ID env overrides the seed.
        c.deploymentId = vm.envOr("DEPLOYMENT_ID", keccak256(bytes(vm.parseJsonString(j, ".deploymentIdSeed"))));
        c.members = vm.parseJsonAddressArray(cm, ".members");
        c.k = uint8(vm.parseJsonUint(cm, ".threshold_k"));
        require(c.k == vm.parseJsonUint(j, ".registry.k"), "committee k != config k");
        c.contact = vm.parseJsonString(j, ".registry.contact");
        c.notices = [
            uint64(vm.parseJsonUint(j, ".registry.certNotice")),
            uint64(vm.parseJsonUint(j, ".registry.removalNotice")),
            uint64(vm.parseJsonUint(j, ".registry.reenableNotice")),
            uint64(vm.parseJsonUint(j, ".registry.disableLapse")),
            uint64(vm.parseJsonUint(j, ".registry.blacklistLapse")),
            uint64(vm.parseJsonUint(j, ".registry.committeeNotice"))
        ];
        c.recoveryNotice = uint64(vm.parseJsonUint(j, ".vault.recoveryNotice"));
        c.challengeWindow = uint64(vm.parseJsonUint(j, ".vault.challengeWindow"));
        c.reclaimGrace = uint64(vm.parseJsonUint(j, ".router.reclaimGrace"));
        c.appGas = uint64(vm.parseJsonUint(j, ".router.appGas"));
        c.minSendGas = uint64(vm.parseJsonUint(j, ".router.minSendGas"));
        c.owner = vm.parseJsonAddress(j, ".routerDeployerOwner");
        require(c.owner == vm.addr(vm.envUint("CLPR_TESTNET_PRIVATE_KEY")), "deployer owner != broadcasting key");
        c.routerSalt = keccak256(abi.encodePacked(c.baseSalt, "ClprRouter", c.deploymentId));
    }

    /// @dev Same salt on every network; addresses still differ where constructor args differ (ledger id).
    function _salt(Cfg memory c, string memory name) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(c.baseSalt, name));
    }
}
