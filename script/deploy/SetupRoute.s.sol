// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {RLP} from "@openzeppelin/contracts/utils/RLP.sol";
import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprTypes} from "@hiero-ledger/clpr/libraries/ClprTypes.sol";
import {ClprProtobuf} from "@hiero-ledger/clpr/libraries/codec/ClprProtobuf.sol";

import {ClprRouter} from "@clprouter/ClprRouter.sol";
import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {IClprRouter} from "@clprouter/interfaces/IClprRouter.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {TestOnlyStubVerifier, TestnetConnector, TestnetRouteApp} from "./TestnetFixtures.sol";
import {StagedEthConfigVerifier} from "./StagedEthConfigVerifier.sol";

/// @notice Wires a CLPR Channel Sepolia ↔ Hedera testnet on the already deployed reference ClprService (same
///         address on both), and runs one CLPRouter route Sepolia → Hedera over it. Driven by
///         script/deploy/route.sh; every function broadcasts to exactly one chain (the --rpc-url one) and is
///         idempotent (it skips whatever already exists on-chain).
///
///         Environment (set by route.sh; keys never printed):
///           ROUTE_CONFIG              script/deploy/config/route.json
///           SEPOLIA_DEPLOYMENT,
///           HEDERA_DEPLOYMENT         deployments/<network>.json (Router addresses)
///           CLPR_TESTNET_PRIVATE_KEY  deployer / CLPR Service owner (testnet only)
///           CHANNEL_PK, CONNECTOR_PK  throwaway Channel and Connector operator keys (deployments/.local/)
///           COMMITTEE_PKS             approveChannel only: comma-separated TEST committee keys (at least k)
///
///         Verification per direction:
///           Sepolia → Hedera: EthMainnetVerifier (real sync-committee light client) on Hedera, behind
///           StagedEthConfigVerifier, which takes the 512-key bootstrap committee in 16 staged chunks (the
///           single 67 KB completeChannel exceeds Hedera's contract trace-size limit) and forwards every bundle.
///           Hedera → Sepolia: TestOnlyStubVerifier on Sepolia, which accepts no bundles (no Hiero proof source
///           exists yet), so the route ends at delivery on Hedera and its receipt cannot reach Sepolia.
contract SetupRoute is Script {
    uint256 internal constant SEPOLIA = 11155111;
    uint256 internal constant HEDERA = 296;

    // ═════════════════════════════════════════════════════════════════════
    // 1. CLPR Service bring-up (initialize + enable), owner only, once
    // ═════════════════════════════════════════════════════════════════════

    function initService() external {
        IClprService svc = _service();
        (bool enabled, bool initialized) = _flags(address(svc));
        string memory k = _netKey();
        vm.startBroadcast(_ownerPk());
        if (!initialized) {
            svc.initialize(abi.encodePacked(address(svc)), _throttles(), "", "", _econ(k));
            console.log("INITIALIZED", address(svc));
        }
        if (!enabled) {
            svc.setClprEnabled(true);
            console.log("ENABLED", address(svc));
        }
        vm.stopBroadcast();
        (enabled, initialized) = _flags(address(svc));
        require(enabled && initialized, "service not live");
        require(keccak256(svc.getLedgerConfiguration().serviceAddress) == keccak256(abi.encodePacked(address(svc))));
    }

    // ═════════════════════════════════════════════════════════════════════
    // 2a. Channel fixtures (CREATE2, independent of the Router): Connector on both, stub verifier on Sepolia
    // ═════════════════════════════════════════════════════════════════════

    function deployChannelFixtures() external {
        address svc = address(_service());
        address owner = vm.addr(_ownerPk());
        _create2("TestnetConnector", abi.encodePacked(type(TestnetConnector).creationCode, abi.encode(svc, owner)));
        if (block.chainid == SEPOLIA) {
            _create2(
                "TestOnlyStubVerifier",
                abi.encodePacked(
                    type(TestOnlyStubVerifier).creationCode,
                    abi.encode(_peerLedger(), abi.encodePacked(svc), _throttles())
                )
            );
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // 2b. Route fixtures (after the Router): allow the Router on the Connector; destination app on Hedera
    // ═════════════════════════════════════════════════════════════════════

    function deployRouteFixtures() external {
        address router = _router(block.chainid);
        require(router.code.length > 0, "router not deployed");
        TestnetConnector conn = TestnetConnector(payable(_fixture("TestnetConnector", block.chainid)));
        if (block.chainid == HEDERA) {
            _create2("TestnetRouteApp", abi.encodePacked(type(TestnetRouteApp).creationCode, abi.encode(router)));
        }
        if (conn.allowedSender() != router) {
            vm.startBroadcast(_ownerPk());
            conn.setAllowedSender(router);
            vm.stopBroadcast();
            console.log("CONNECTOR_ALLOWS", router);
        }
        // The destination Connector pays for inbound execution (BundleLib: affordable gas = balance / (gas price
        // x margin)); with a zero balance the message is answered CONNECTOR_UNDERFUNDED and never reaches the
        // Router. Top it up to `.econ.<net>.connectorFunding` (wei; 1 HBAR = 1e18 in Hedera EVM units).
        uint256 target =
            vm.parseJsonUint(vm.envString("ROUTE_CONFIG"), string.concat(".econ.", _netKey(), ".connectorFunding"));
        if (address(conn).balance < target) {
            uint256 topUp = target - address(conn).balance;
            vm.startBroadcast(_ownerPk());
            (bool ok,) = payable(address(conn)).call{value: topUp}("");
            vm.stopBroadcast();
            require(ok, "connector funding failed");
            console.log("CONNECTOR_FUNDED wei", topUp);
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // 3. Channel (commit-reveal). On Hedera the EthMainnetVerifier bootstrap committee (passed in ETH_*,
    //    fetched from the beacon API by relay/eth-config.ts) is staged in 16 chunks of 32 keys on the
    //    StagedEthConfigVerifier, and the config then names the 16 chunk roots; Sepolia's live ledger
    //    configuration and ClprService code hash are read through a Sepolia fork.
    // ═════════════════════════════════════════════════════════════════════

    /// @notice CREATE2-deploy StagedEthConfigVerifier on Hedera in front of ETH_VERIFIER (EthMainnetVerifier).
    function deployStagedVerifier() external {
        require(block.chainid == HEDERA, "staged verifier runs on Hedera");
        address eth = vm.envAddress("ETH_VERIFIER");
        require(eth.code.length > 0, "EthMainnetVerifier not deployed");
        address a = _create2("StagedEthConfigVerifier", _stagedInit());
        require(address(StagedEthConfigVerifier(a).ETH_VERIFIER()) == eth, "staged verifier: wrong EthMainnetVerifier");
        console.log("CODEHASH StagedEthConfigVerifier");
        console.logBytes32(a.codehash);
    }

    /// @notice Stage the committee in ETH_COMMITTEE_PUBKEYS: one stageChunk transaction per 32-key chunk not
    ///         staged yet (each well under Hedera's 6 KB non-jumbo transaction size and its trace limit).
    function stageCommittee() external {
        require(block.chainid == HEDERA, "staging runs on Hedera");
        StagedEthConfigVerifier v = StagedEthConfigVerifier(_fixture("StagedEthConfigVerifier", HEDERA));
        require(address(v).code.length > 0, "staged verifier not deployed");
        bytes[] memory chunks = _committeeChunks();
        uint256 sent;
        for (uint256 c = 0; c < chunks.length; c++) {
            bytes32 root = v.chunkRoot(chunks[c]);
            if (v.stagedChunk(root)) continue;
            vm.startBroadcast(_ownerPk());
            v.stageChunk(chunks[c]);
            vm.stopBroadcast();
            sent++;
        }
        console.log("COMMITTEE_STAGED chunks sent", sent);
    }

    function openChannel() external {
        IClprService svc = _service();
        (bytes32 ch, bytes memory pubKey, bytes32 salt) = _channel(svc);
        if (_channelExists(svc, ch)) {
            console.log("CHANNEL_EXISTS");
            console.logBytes32(ch);
            return;
        }
        address verifier;
        bytes memory configProof;
        if (block.chainid == SEPOLIA) {
            verifier = _fixture("TestOnlyStubVerifier", block.chainid);
            configProof = hex"00";
        } else {
            verifier = _fixture("StagedEthConfigVerifier", HEDERA);
            configProof = _stagedEthConfigProof(StagedEthConfigVerifier(verifier));
        }
        require(verifier.code.length > 0, "verifier not deployed");
        bytes memory sig = _sign(vm.envUint("CHANNEL_PK"), keccak256(abi.encodePacked(ch, address(svc))));
        vm.startBroadcast(_ownerPk());
        svc.registerChannel(ch, keccak256(abi.encodePacked(ch, pubKey)));
        svc.completeChannel(ch, pubKey, sig, salt, verifier, configProof, "");
        vm.stopBroadcast();
        console.log("CHANNEL_OPENED");
        console.logBytes32(ch);
    }

    /// @dev StagedEthConfigVerifier config: RLP [slot, [[chunkRoot × 16], aggregate], gvr, forkVersion,
    ///      ledgerConfig, codeHash]. Same fields as the EthMainnetVerifier config except that the committee's
    ///      512 keys are replaced by the roots of their 16 staged 32-key chunks (all must be staged).
    function _stagedEthConfigProof(StagedEthConfigVerifier v) internal returns (bytes memory) {
        uint256 here = vm.activeFork();
        vm.createSelectFork(vm.envString("SEPOLIA_RPC_URL"));
        IClprService s = IClprService(_cfgAddress(".sepolia.service"));
        ClprTypes.LedgerConfiguration memory lc = s.getLedgerConfiguration();
        bytes32 codeHash = address(s).codehash;
        vm.selectFork(here);
        require(keccak256(bytes(lc.chainId)) == keccak256(bytes(_peerLedger())), "sepolia chain id");
        require(lc.serviceAddress.length == 20, "sepolia service not initialized");

        bytes[] memory chunks = _committeeChunks();
        bytes[] memory roots = new bytes[](chunks.length);
        for (uint256 c = 0; c < chunks.length; c++) {
            bytes32 root = v.chunkRoot(chunks[c]);
            require(v.stagedChunk(root), "committee chunk not staged (run stageCommittee)");
            roots[c] = RLP.encode(abi.encodePacked(root));
        }
        bytes[] memory committee = new bytes[](2);
        committee[0] = RLP.encode(roots);
        committee[1] = RLP.encode(vm.envBytes("ETH_COMMITTEE_AGGREGATE"));

        bytes[] memory cfg = new bytes[](6);
        cfg[0] = RLP.encode(vm.envUint("ETH_CONFIG_SLOT"));
        cfg[1] = RLP.encode(committee);
        cfg[2] = RLP.encode(abi.encodePacked(vm.envBytes32("ETH_GVR")));
        cfg[3] = RLP.encode(vm.envBytes("ETH_FORK_VERSION"));
        cfg[4] = RLP.encode(ClprProtobuf.encodeControlMessage(lc));
        cfg[5] = RLP.encode(abi.encodePacked(codeHash));
        console.log("SEPOLIA_SERVICE_CODEHASH");
        console.logBytes32(codeHash);
        return RLP.encode(cfg);
    }

    /// @dev ETH_COMMITTEE_PUBKEYS (512 x 128-byte uncompressed G1, concatenated) as 16 chunks of 32 keys.
    function _committeeChunks() internal view returns (bytes[] memory chunks) {
        bytes memory keys = vm.envBytes("ETH_COMMITTEE_PUBKEYS");
        require(keys.length == 512 * 128, "committee size");
        uint256 len = 32 * 128;
        chunks = new bytes[](16);
        for (uint256 c = 0; c < 16; c++) {
            bytes memory chunk = new bytes(len);
            assembly ("memory-safe") {
                mcopy(add(chunk, 32), add(add(keys, 32), mul(c, len)), len)
            }
            chunks[c] = chunk;
        }
    }

    function _stagedInit() internal view returns (bytes memory) {
        return abi.encodePacked(type(StagedEthConfigVerifier).creationCode, abi.encode(vm.envAddress("ETH_VERIFIER")));
    }

    // ═════════════════════════════════════════════════════════════════════
    // 4. Connector (same id on both ledgers)
    // ═════════════════════════════════════════════════════════════════════

    function registerConnector() external {
        IClprService svc = _service();
        (bytes32 ch,,) = _channel(svc);
        (bytes32 id, bytes memory pubKey) = _connector(svc, ch);
        if (svc.hasConnector(ch, id)) {
            console.log("CONNECTOR_EXISTS");
            console.logBytes32(id);
            return;
        }
        address conn = _fixture("TestnetConnector", block.chainid);
        bytes memory sig = _sign(vm.envUint("CONNECTOR_PK"), keccak256(abi.encodePacked(id, address(svc))));
        uint256 stake =
            vm.parseJsonUint(vm.envString("ROUTE_CONFIG"), string.concat(".econ.", _netKey(), ".minLockedStake"));
        vm.startBroadcast(_ownerPk());
        svc.registerConnector(keccak256(abi.encodePacked(id, pubKey)));
        svc.completeConnector{value: stake}(id, pubKey, sig, bytes32(0), ch, conn, vm.addr(_ownerPk()));
        vm.stopBroadcast();
        console.log("CONNECTOR_REGISTERED");
        console.logBytes32(id);
    }

    // ═════════════════════════════════════════════════════════════════════
    // 4b. Channel approval: the TEST committee labels both directions of the Channel in this chain's registry
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Relay the committee's approval of both directions of the Channel to this chain's registry (k
    ///         signatures each). Each label names the verifier the receiving ledger's Service uses for the Channel,
    ///         read from that ledger (a fork of the other chain). The two decisions carry only values that are the
    ///         same on both chains (no timestamps), so relaying them to both registries keeps their decision
    ///         chains identical. Routes can use the Channel once the registry's certification notice has passed.
    function approveChannel() external {
        IClprService svc = _service();
        (bytes32 ch,,) = _channel(svc);
        ProviderRegistry reg = ProviderRegistry(_registry(block.chainid));
        uint256 here = vm.activeFork();
        uint256 other =
            vm.createFork(vm.envString(block.chainid == SEPOLIA ? "HEDERA_TESTNET_RPC_URL" : "SEPOLIA_RPC_URL"));
        bool onSepolia = block.chainid == SEPOLIA;
        _approveDirection(reg, ch, SEPOLIA, onSepolia ? here : other, here);
        _approveDirection(reg, ch, HEDERA, onSepolia ? other : here, here);
    }

    function _approveDirection(ProviderRegistry reg, bytes32 ch, uint256 into, uint256 intoFork, uint256 here)
        internal
    {
        vm.selectFork(intoFork);
        address verifier = _service().getChannel(ch).verifier;
        bytes32 codeHash = verifier.codehash;
        vm.selectFork(here);
        bytes32 key = Caip.edgeKey(ch, _routerLedger(into));
        (bool approved,, address current,) = reg.channelApproval(key);
        if (approved && current == verifier) {
            console.log("CHANNEL_DIRECTION_APPROVED", _routerLedger(into));
            return;
        }
        bytes memory payload = abi.encode(ch, _routerLedger(into), uint8(0), verifier, codeHash);
        IProviderRegistry.Decision memory d = IProviderRegistry.Decision({
            action: 11, // TRUST_TIER
            payload: payload,
            evidenceHash: keccak256(abi.encode("testnet: approve Channel direction", payload)),
            nonce: reg.version() + 1,
            effectiveAt: 0,
            validUntil: type(uint64).max,
            epoch: reg.epoch()
        });
        bytes[] memory sigs = _committeeSigs(reg.decisionDigest(d), reg.requiredSignatures(11));
        vm.startBroadcast(_ownerPk());
        reg.submit(d, sigs);
        vm.stopBroadcast();
        console.log("CHANNEL_DIRECTION_SCHEDULED", _routerLedger(into), block.timestamp + reg.CERT_NOTICE());
    }

    /// @dev `need` signatures over `digest` from COMMITTEE_PKS, in ascending signer order.
    function _committeeSigs(bytes32 digest, uint256 need) internal view returns (bytes[] memory sigs) {
        uint256[] memory pks = vm.envUint("COMMITTEE_PKS", ",");
        require(pks.length >= need, "COMMITTEE_PKS: fewer keys than the quorum");
        for (uint256 i = 1; i < pks.length; i++) {
            for (uint256 j = i; j > 0 && vm.addr(pks[j - 1]) > vm.addr(pks[j]); j--) {
                (pks[j - 1], pks[j]) = (pks[j], pks[j - 1]);
            }
        }
        sigs = new bytes[](need);
        for (uint256 i = 0; i < need; i++) {
            sigs[i] = _sign(pks[i], digest);
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // 5. Route: send on Sepolia
    // ═════════════════════════════════════════════════════════════════════

    function send() external {
        require(block.chainid == SEPOLIA, "send runs on Sepolia");
        IClprService svc = _service();
        (bytes32 ch,,) = _channel(svc);
        (bytes32 conn,) = _connector(svc, ch);
        ClprRouter r = ClprRouter(payable(_router(SEPOLIA)));
        string memory rc = vm.envString("ROUTE_CONFIG");
        address sender = vm.addr(_ownerPk());
        // Route ids are derived by the Router from (ledger, Router, sender, nonce): one route per configured count.
        uint256 sent = r.nonces(sender);
        if (sent >= vm.parseJsonUint(rc, ".route.count")) {
            console.log("ROUTES_ALREADY_SENT", sent);
            return;
        }
        address app = _fixture("TestnetRouteApp", HEDERA);

        ClprRouter.SendRequest memory req;
        req.destination = RouteTypes.Endpoint({ledgerId: _routerLedger(HEDERA), application: abi.encodePacked(app)});
        req.recipient = Caip.account(_routerLedger(HEDERA), app);
        req.hops = new RouteTypes.Hop[](2);
        req.hops[0] = RouteTypes.Hop({
            ledgerId: _routerLedger(SEPOLIA),
            router: abi.encodePacked(address(r)),
            channelId: ch,
            connectorId: conn,
            fee: 0,
            feePayee: ""
        });
        req.hops[1] = RouteTypes.Hop({
            ledgerId: _routerLedger(HEDERA),
            router: abi.encodePacked(_router(HEDERA)),
            channelId: bytes32(0),
            connectorId: bytes32(0),
            fee: 0,
            feePayee: ""
        });
        req.mode = RouteTypes.Mode.CHEAPEST;
        req.constraints.deadline = uint64(block.timestamp + vm.parseJsonUint(rc, ".route.deadlineSeconds"));
        req.payload = bytes(vm.parseJsonString(rc, ".route.payload"));
        uint256 budget = vm.parseJsonUint(rc, ".route.feeBudgetWei");

        vm.startBroadcast(_ownerPk());
        bytes16 routeId = r.send{value: budget}(req);
        vm.stopBroadcast();
        console.log("ROUTE_SENT");
        console.logBytes16(routeId);
        ClprTypes.Channel memory c = svc.getChannel(ch);
        console.log("SEPOLIA_NEXT_MESSAGE_ID", c.nextMessageId);
    }

    // ═════════════════════════════════════════════════════════════════════
    // 6. Delivery on Hedera: submit the EthMainnetVerifier bundle, then complete deferred Router sends
    // ═════════════════════════════════════════════════════════════════════

    function deliver() external {
        require(block.chainid == HEDERA, "deliver runs on Hedera");
        IClprService svc = _service();
        (bytes32 ch,,) = _channel(svc);
        bytes memory proof = vm.envBytes("BUNDLE_PROOF");
        vm.recordLogs();
        vm.startBroadcast(_ownerPk());
        svc.submitBundle(ch, proof);
        vm.stopBroadcast();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool flushReceipt = vm.envOr("FLUSH_RECEIPT", false);
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] == IClprRouter.RouteDelivered.selector) {
                console.log("ROUTE_DELIVERED app", address(uint160(uint256(logs[i].topics[2]))));
                console.logBytes32(logs[i].topics[1]);
            } else if (logs[i].topics[0] == IClprRouter.OutboxQueued.selector) {
                (bytes32 c, bytes32 k, bytes memory target, bytes memory data) =
                    abi.decode(logs[i].data, (bytes32, bytes32, bytes, bytes));
                console.log("RECEIPT_QUEUED (DELIVERED receipt, deferred behind the Service lock)");
                if (flushReceipt) {
                    vm.startBroadcast(_ownerPk());
                    ClprRouter(payable(logs[i].emitter)).flush(c, k, target, data);
                    vm.stopBroadcast();
                    console.log("RECEIPT_FLUSHED into the Hedera -> Sepolia queue");
                }
            }
        }
        ClprTypes.Channel memory d = svc.getChannel(ch);
        console.log("HEDERA_RECEIVED_MESSAGE_ID", d.receivedMessageId);
    }

    /// @notice Read-only status of the route (ROUTE_ID env, bytes16) on both ledgers.
    function status() external {
        IClprService svc = _service();
        (bytes32 ch,,) = _channel(svc);
        ClprTypes.Channel memory c = svc.getChannel(ch);
        console.log("CHANNEL");
        console.logBytes32(ch);
        console.log("nextMessageId", c.nextMessageId);
        console.log("receivedMessageId", c.receivedMessageId);
        console.log("ackedMessageId", c.ackedMessageId);
        bytes memory rid = vm.envOr("ROUTE_ID", new bytes(0));
        if (rid.length != 16) return;
        bytes16 routeId = bytes16(rid);
        if (block.chainid == SEPOLIA) {
            IClprRouter.OriginRoute memory o = _origin(ClprRouter(payable(_router(SEPOLIA))), routeId);
            console.log("origin route status (1 PENDING, 2 DELIVERED, 3 FAILED, 4 EXPIRED)", uint8(o.status));
            console.log("origin deadline", o.deadline);
        } else {
            bytes32 key = keccak256(
                abi.encode(
                    keccak256(bytes(_routerLedger(SEPOLIA))), keccak256(abi.encodePacked(_router(SEPOLIA))), routeId
                )
            );
            console.log("hop state on Hedera (5 DONE)", uint8(ClprRouter(payable(_router(HEDERA))).hopState(key)));
            console.log("delivered count", TestnetRouteApp(_fixture("TestnetRouteApp", HEDERA)).deliveredCount());
        }
    }

    function _origin(ClprRouter r, bytes16 id) internal view returns (IClprRouter.OriginRoute memory o) {
        (bool ok, bytes memory ret) = address(r).staticcall(abi.encodeCall(r.routes, (id)));
        require(ok, "routes()");
        o = abi.decode(ret, (IClprRouter.OriginRoute));
    }

    // ═════════════════════════════════════════════════════════════════════
    // helpers
    // ═════════════════════════════════════════════════════════════════════

    function _ownerPk() internal view returns (uint256) {
        return vm.envUint("CLPR_TESTNET_PRIVATE_KEY");
    }

    function _netKey() internal view returns (string memory) {
        if (block.chainid == SEPOLIA) return "sepolia";
        if (block.chainid == HEDERA) return "hedera";
        revert("unsupported chain");
    }

    function _ledger(uint256 chain) internal view returns (string memory) {
        return
            vm.parseJsonString(
                vm.envString("ROUTE_CONFIG"), chain == SEPOLIA ? ".sepolia.ledgerId" : ".hedera.ledgerId"
            );
    }

    /// @dev CAIP-2 ledger id used by the Router and in envelopes ("eip155:<chain id>").
    function _routerLedger(uint256 chain) internal view returns (string memory) {
        return vm.parseJsonString(
            vm.envString("ROUTE_CONFIG"), chain == SEPOLIA ? ".sepolia.routerLedgerId" : ".hedera.routerLedgerId"
        );
    }

    function _peerLedger() internal view returns (string memory) {
        return _ledger(block.chainid == SEPOLIA ? HEDERA : SEPOLIA);
    }

    function _cfgAddress(string memory key) internal view returns (address) {
        return vm.parseJsonAddress(vm.envString("ROUTE_CONFIG"), key);
    }

    function _service() internal view returns (IClprService) {
        return IClprService(_cfgAddress(string.concat(".", _netKey(), ".service")));
    }

    function _router(uint256 chain) internal view returns (address) {
        string memory d = vm.envString(chain == SEPOLIA ? "SEPOLIA_DEPLOYMENT" : "HEDERA_DEPLOYMENT");
        return vm.parseJsonAddress(d, ".contracts.ClprRouter.address");
    }

    function _registry(uint256 chain) internal view returns (address) {
        string memory d = vm.envString(chain == SEPOLIA ? "SEPOLIA_DEPLOYMENT" : "HEDERA_DEPLOYMENT");
        return vm.parseJsonAddress(d, ".contracts.ProviderRegistry.address");
    }

    function _flags(address svc) internal view returns (bool enabled, bool initialized) {
        uint256 slot2 = uint256(vm.load(svc, bytes32(uint256(2))));
        enabled = (slot2 >> 160) & 0xff != 0;
        initialized = (slot2 >> 168) & 0xff != 0;
    }

    function _throttles() internal view returns (ClprTypes.Throttles memory t) {
        string memory rc = vm.envString("ROUTE_CONFIG");
        t.maxMessagesPerBundle = uint32(vm.parseJsonUint(rc, ".throttles.maxMessagesPerBundle"));
        t.maxMessagePayloadBytes = uint64(vm.parseJsonUint(rc, ".throttles.maxMessagePayloadBytes"));
        t.maxGasPerMessage = uint64(vm.parseJsonUint(rc, ".throttles.maxGasPerMessage"));
        t.maxQueueDepth = uint32(vm.parseJsonUint(rc, ".throttles.maxQueueDepth"));
        t.maxSyncBytes = uint64(vm.parseJsonUint(rc, ".throttles.maxSyncBytes"));
        t.maxLocalEndpoints = uint32(vm.parseJsonUint(rc, ".throttles.maxLocalEndpoints"));
        t.maxPeerEndpoints = uint32(vm.parseJsonUint(rc, ".throttles.maxPeerEndpoints"));
    }

    function _econ(string memory k) internal view returns (ClprTypes.EconomicConfig memory e) {
        string memory rc = vm.envString("ROUTE_CONFIG");
        string memory p = string.concat(".econ.", k, ".");
        e.messageExecutionCost = vm.parseJsonUint(rc, string.concat(p, "messageExecutionCost"));
        e.endpointMarginPercent = vm.parseJsonUint(rc, string.concat(p, "endpointMarginPercent"));
        e.minLockedStake = vm.parseJsonUint(rc, string.concat(p, "minLockedStake"));
        e.minEndpointBond = vm.parseJsonUint(rc, string.concat(p, "minEndpointBond"));
        e.basePenalty = vm.parseJsonUint(rc, string.concat(p, "basePenalty"));
        e.penaltyMultiplier = vm.parseJsonUint(rc, string.concat(p, "penaltyMultiplier"));
        e.slashBanThreshold = uint32(vm.parseJsonUint(rc, string.concat(p, "slashBanThreshold")));
        e.connectorQueueQuotaPct = uint32(vm.parseJsonUint(rc, string.concat(p, "connectorQueueQuotaPct")));
        e.connectorInboundGasStipend = uint64(vm.parseJsonUint(rc, string.concat(p, "connectorInboundGasStipend")));
        e.maxChannels = uint32(vm.parseJsonUint(rc, string.concat(p, "maxChannels")));
        e.maxConnectors = uint32(vm.parseJsonUint(rc, string.concat(p, "maxConnectors")));
    }

    function _pub(uint256 pk) internal returns (bytes memory) {
        Vm.Wallet memory w = vm.createWallet(pk);
        return abi.encodePacked(w.publicKeyX, w.publicKeyY);
    }

    function _channel(IClprService svc) internal returns (bytes32 ch, bytes memory pubKey, bytes32 salt) {
        pubKey = _pub(vm.envUint("CHANNEL_PK"));
        salt = keccak256(bytes(vm.parseJsonString(vm.envString("ROUTE_CONFIG"), ".channelSalt")));
        ch = svc.deriveChannelId(_peerLedger(), pubKey, salt);
    }

    function _connector(IClprService svc, bytes32 ch) internal returns (bytes32 id, bytes memory pubKey) {
        pubKey = _pub(vm.envUint("CONNECTOR_PK"));
        id = svc.deriveConnectorId(ch, pubKey, bytes32(0));
    }

    function _channelExists(IClprService svc, bytes32 ch) internal returns (bool) {
        try svc.getChannel(ch) returns (ClprTypes.Channel memory c) {
            return c.verifier != address(0);
        } catch {
            return false;
        }
    }

    function _sign(uint256 pk, bytes32 inner) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner)));
        return abi.encodePacked(r, s, v);
    }

    function _salt(string memory name) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(keccak256(bytes(vm.parseJsonString(vm.envString("ROUTE_CONFIG"), ".fixtureSalt"))), name)
        );
    }

    /// @dev CREATE2 address of a fixture as deployed by {deployFixtures} on `chain` (constructor args recomputed).
    function _fixture(string memory name, uint256 chain) internal view returns (address) {
        address svc = _cfgAddress(chain == SEPOLIA ? ".sepolia.service" : ".hedera.service");
        address owner = vm.addr(_ownerPk());
        bytes memory init;
        if (keccak256(bytes(name)) == keccak256("TestnetConnector")) {
            init = abi.encodePacked(type(TestnetConnector).creationCode, abi.encode(svc, owner));
        } else if (keccak256(bytes(name)) == keccak256("StagedEthConfigVerifier")) {
            init = _stagedInit();
        } else if (keccak256(bytes(name)) == keccak256("TestOnlyStubVerifier")) {
            init = abi.encodePacked(
                type(TestOnlyStubVerifier).creationCode,
                abi.encode(_ledger(HEDERA), abi.encodePacked(svc), _throttles())
            );
        } else {
            init = abi.encodePacked(type(TestnetRouteApp).creationCode, abi.encode(_router(chain)));
        }
        return vm.computeCreate2Address(_salt(name), keccak256(init), CREATE2_FACTORY);
    }

    function _create2(string memory name, bytes memory init) internal returns (address a) {
        bytes32 salt = _salt(name);
        a = vm.computeCreate2Address(salt, keccak256(init), CREATE2_FACTORY);
        if (a.code.length > 0) {
            console.log(string.concat("EXISTS ", name), a);
            return a;
        }
        vm.startBroadcast(_ownerPk());
        (bool ok, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(salt, init));
        vm.stopBroadcast();
        require(ok && address(bytes20(ret)) == a, string.concat(name, ": CREATE2 failed"));
        console.log(string.concat("DEPLOYED ", name), a);
    }
}
