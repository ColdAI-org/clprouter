// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {ClprService} from "@hiero-ledger/clpr/ClprService.sol";
import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprTypes} from "@hiero-ledger/clpr/libraries/ClprTypes.sol";
import {ChannelLogic} from "@hiero-ledger/clpr/logic/ChannelLogic.sol";
import {MessagingLogic} from "@hiero-ledger/clpr/logic/MessagingLogic.sol";
import {BundleLogic} from "@hiero-ledger/clpr/logic/BundleLogic.sol";
import {ConnectorLogic} from "@hiero-ledger/clpr/logic/ConnectorLogic.sol";
import {AdminLogic} from "@hiero-ledger/clpr/logic/AdminLogic.sol";
import {BundleDecodeHelper} from "@hiero-ledger/clpr/libraries/codec/BundleDecodeHelper.sol";
import {E2EVerifier} from "@test/E2EVerifier.sol";
import {MockClprConnector} from "@test/mocks/MockClprConnector.sol";
import {BundleEncoderHelper} from "@test/BundleEncoderHelper.sol";

import {SettleDeposit} from "@clprouter/settle/SettleDeposit.sol";
import {SettleDelivery} from "@clprouter/settle/SettleDelivery.sol";
import {SettleOrderBook} from "@clprouter/settle/SettleOrderBook.sol";
import {SettleTypes} from "@clprouter/settle/SettleTypes.sol";

/// @notice Cross-process end-to-end run of settle-on-Hedera on three anvil chains: Y (31001, the user pays),
///         X (31002, the Connector delivers) and H (31003, stands in for Hedera's EVM and holds the order book),
///         each with the unchanged reference ClprService. Driven by script/settle-e2e/run.sh; every step is one
///         `forge script` run that broadcasts to the chain given with --rpc-url (`here`) and reads the others
///         through forks. The Connector side (quotes, delivery, relaying, closing) is the reference Connector
///         service in services/connector, run by run.sh between these steps.
///
///         TEST ONLY: Channels use the CLPR repo's `E2EVerifier`, which decodes bundles and checks no proof, and
///         the service's `e2e-test-only` relay. Never deploy this setup on a live network.
///
///         Steps: deployHub · deployChain · wireChannel · wireConnector · proposeSources · writeConfig ·
///         request · deposit · claim · check.
contract SettleE2E is Script {
    // anvil's published development keys: 0 deployer/relayer, 1 the user, 2 the Connector, 3 its quote signer
    uint256 internal constant DEPLOYER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant USER_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant CONNECTOR_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 internal constant SIGNER_PK = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
    uint256 internal constant CHANNEL_PK = 0xC1A;

    uint8 internal constant Y = 0;
    uint8 internal constant X = 1;
    uint8 internal constant H = 2;

    uint16 internal constant PENALTY_BPS = 1000;
    uint64 internal constant WITHDRAW_DELAY = 1 days;
    uint64 internal constant PROOF_GRACE = 30 minutes;
    uint64 internal constant MAX_QUOTE_TTL = 10 minutes;
    uint64 internal constant SOURCE_NOTICE = 1 days;

    string[3] internal ids = ["eip155:31001", "eip155:31002", "eip155:31003"];
    string[3] internal rpcs;
    uint256[3] internal forks;

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
    // Deployment
    // ═════════════════════════════════════════════════════════════════════

    /// @notice On H: ClprService, the order book (HBAR bonds) and the test-only bundle encoder for the relay.
    function deployHub() external {
        _ctx(H);
        vm.startBroadcast(DEPLOYER_PK);
        ClprService svc = _service(H);
        address[] memory assets = new address[](1);
        assets[0] = address(0);
        SettleOrderBook book = new SettleOrderBook(
            address(svc),
            vm.addr(DEPLOYER_PK),
            assets,
            PENALTY_BPS,
            WITHDRAW_DELAY,
            PROOF_GRACE,
            MAX_QUOTE_TTL,
            SOURCE_NOTICE
        );
        BundleEncoderHelper enc = new BundleEncoderHelper();
        vm.stopBroadcast();
        string memory k = "H";
        vm.serializeAddress(k, "service", address(svc));
        vm.serializeAddress(k, "bundleEncoder", address(enc));
        vm.writeJson(vm.serializeAddress(k, "orderBook", address(book)), _file(H));
        console.log("order book", address(book));
    }

    /// @notice On Y or X: ClprService, SettleDeposit and SettleDelivery (both speak to the order book on H).
    function deployChain(uint8 here) external {
        _ctx(here);
        address book = vm.parseJsonAddress(vm.readFile(_file(H)), ".orderBook");
        bytes32 ch = _channelId(here);
        bytes32 conn = _connectorId(ch, _seed(here));
        vm.startBroadcast(DEPLOYER_PK);
        ClprService svc = _service(here);
        SettleDeposit dep = new SettleDeposit(IClprService(address(svc)), ch, conn, book, ids[here], 31003);
        SettleDelivery del = new SettleDelivery(IClprService(address(svc)), ch, conn, book);
        vm.stopBroadcast();
        string memory k = string.concat("L", vm.toString(here));
        vm.serializeAddress(k, "service", address(svc));
        vm.serializeAddress(k, "deposit", address(dep));
        vm.writeJson(vm.serializeAddress(k, "delivery", address(del)), _file(here));
    }

    /// @notice Open `here`'s side of the Channel between chain `c` (Y or X) and H (E2EVerifier, TEST ONLY).
    function wireChannel(uint8 here, uint8 c) external {
        _ctx(here);
        uint8 peer = here == H ? c : H;
        bytes32 ch = _channelId(c);
        address svc = _svc(here);
        Vm.Wallet memory w = vm.createWallet(CHANNEL_PK);
        bytes memory pubKey = abi.encodePacked(w.publicKeyX, w.publicKeyY);
        bytes32 h =
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(abi.encodePacked(ch, svc))));
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(CHANNEL_PK, h);
        string memory peerId = ids[peer];
        bytes memory peerSvc = abi.encodePacked(_svc(peer));
        bytes memory sig = abi.encodePacked(r, s, sv);
        bytes32 salt = _salt(c);
        vm.startBroadcast(DEPLOYER_PK);
        address v = _verifier(peerId, peerSvc);
        IClprService(svc).registerChannel(ch, keccak256(abi.encodePacked(ch, pubKey)));
        IClprService(svc).completeChannel(ch, pubKey, sig, salt, v, hex"0001", "");
        vm.stopBroadcast();
    }

    function _verifier(string memory peerId, bytes memory peerSvc) internal returns (address) {
        E2EVerifier v = new E2EVerifier();
        v.configure(peerId, peerSvc, 1000, throttles, "", "", new ClprTypes.Endpoint[](0));
        return address(v);
    }

    /// @notice Register `here`'s side of the CLPR connector for the Channel of chain `c` (same id on both sides).
    function wireConnector(uint8 here, uint8 c) external {
        _ctx(here);
        bytes32 ch = _channelId(c);
        bytes32 seed = _seed(c);
        uint256 pk = uint256(keccak256(abi.encodePacked("clpr.test.connectorSigner", seed)));
        Vm.Wallet memory w = vm.createWallet(pk);
        bytes memory pubKey = abi.encodePacked(w.publicKeyX, w.publicKeyY);
        bytes32 id = keccak256(abi.encodePacked(ch, pubKey, bytes32(0)));
        address svc = _svc(here);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            pk, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(abi.encodePacked(id, svc))))
        );
        vm.startBroadcast(DEPLOYER_PK);
        MockClprConnector mc = new MockClprConnector();
        (bool ok,) = address(mc).call{value: 10 ether}("");
        require(ok, "fund connector");
        IClprService(svc).registerConnector(keccak256(abi.encodePacked(id, pubKey)));
        IClprService(svc).completeConnector{value: 1 ether}(
            id, pubKey, abi.encodePacked(r, s, v), bytes32(0), ch, address(mc), vm.addr(DEPLOYER_PK)
        );
        vm.stopBroadcast();
    }

    /// @notice On H: register Y and X as sources (effective after SOURCE_NOTICE; run.sh moves H's clock).
    function proposeSources() external {
        _ctx(H);
        SettleOrderBook book = _book();
        bytes memory depY = abi.encodePacked(vm.parseJsonAddress(vm.readFile(_file(Y)), ".deposit"));
        bytes memory delY = abi.encodePacked(vm.parseJsonAddress(vm.readFile(_file(Y)), ".delivery"));
        bytes memory depX = abi.encodePacked(vm.parseJsonAddress(vm.readFile(_file(X)), ".deposit"));
        bytes memory delX = abi.encodePacked(vm.parseJsonAddress(vm.readFile(_file(X)), ".delivery"));
        bytes32 chY = _channelId(Y);
        bytes32 chX = _channelId(X);
        vm.startBroadcast(DEPLOYER_PK);
        book.proposeSource(chY, keccak256(bytes(ids[Y])), depY, delY);
        book.proposeSource(chX, keccak256(bytes(ids[X])), depX, delX);
        vm.stopBroadcast();
    }

    /// @notice Write the reference Connector service's config (local anvil keys only; TEST ONLY relay).
    function writeConfig() external {
        _ctx(H);
        string memory k = "cfg";
        vm.serializeString(k, "name", "settle-e2e-connector");
        vm.serializeString(k, "hedera", _hubJson());
        string[] memory chains = new string[](2);
        chains[0] = _chainJson(Y);
        chains[1] = _chainJson(X);
        vm.serializeString(k, "chains", chains);
        string[] memory routes = new string[](1);
        routes[0] = _routeJson();
        vm.serializeString(k, "routes", routes);
        vm.serializeString(k, "bond", _bondJson());
        vm.serializeString(k, "quote", _quoteCfgJson());
        vm.serializeString(k, "keys", _keysJson());
        vm.serializeString(k, "relay", _relayJson());
        vm.serializeString(k, "store", "e2e-out/settle/connector-store.json");
        string memory json = vm.serializeString(k, "http", _httpJson());
        vm.writeJson(json, "e2e-out/settle/connector.json");
    }

    function _hubJson() internal returns (string memory) {
        string memory hub = vm.readFile(_file(H));
        string memory k = "hub";
        vm.serializeString(k, "ledgerId", ids[H]);
        vm.serializeString(k, "rpcUrl", rpcs[H]);
        vm.serializeUint(k, "chainId", 31003);
        vm.serializeAddress(k, "orderBook", vm.parseJsonAddress(hub, ".orderBook"));
        return vm.serializeAddress(k, "clprService", vm.parseJsonAddress(hub, ".service"));
    }

    function _chainJson(uint8 c) internal returns (string memory) {
        string memory cj = vm.readFile(_file(c));
        string memory k = string.concat("chain", vm.toString(c));
        vm.serializeString(k, "ledgerId", ids[c]);
        vm.serializeString(k, "rpcUrl", rpcs[c]);
        vm.serializeUint(k, "chainId", 31001 + uint256(c));
        vm.serializeAddress(k, "clprService", vm.parseJsonAddress(cj, ".service"));
        vm.serializeAddress(k, "deposit", vm.parseJsonAddress(cj, ".deposit"));
        vm.serializeAddress(k, "delivery", vm.parseJsonAddress(cj, ".delivery"));
        vm.serializeBytes32(k, "channelId", _channelId(c));
        vm.serializeUint(k, "confirmations", 0);
        return vm.serializeUint(k, "startBlock", 0);
    }

    function _routeJson() internal returns (string memory) {
        string memory k = "route";
        vm.serializeString(k, "srcLedger", ids[Y]);
        vm.serializeAddress(k, "assetIn", address(0));
        vm.serializeString(k, "dstLedger", ids[X]);
        vm.serializeAddress(k, "assetOut", address(0));
        vm.serializeString(k, "rateNum", "1");
        vm.serializeString(k, "rateDen", "1");
        vm.serializeUint(k, "feeBps", 100);
        vm.serializeString(k, "coverNum", "1");
        vm.serializeString(k, "coverDen", "1");
        return vm.serializeUint(k, "deliveryP90S", 60);
    }

    function _bondJson() internal returns (string memory) {
        vm.serializeAddress("bond", "asset", address(0));
        return vm.serializeString("bond", "target", "50000000000000000000");
    }

    function _quoteCfgJson() internal returns (string memory) {
        vm.serializeUint("quoteCfg", "ttlS", 300);
        vm.serializeUint("quoteCfg", "defaultDeadlineS", 3600);
        return vm.serializeUint("quoteCfg", "minDeliveryMarginS", 30);
    }

    function _keysJson() internal returns (string memory) {
        vm.serializeString("ckey", "kind", "local-test-key");
        string memory c = vm.serializeString("ckey", "privateKey", vm.toString(bytes32(CONNECTOR_PK)));
        vm.serializeString("skey", "kind", "local-test-key");
        string memory s = vm.serializeString("skey", "privateKey", vm.toString(bytes32(SIGNER_PK)));
        vm.serializeString("keys", "connector", c);
        return vm.serializeString("keys", "signer", s);
    }

    function _relayJson() internal returns (string memory) {
        vm.serializeString("relay", "kind", "e2e-test-only");
        vm.serializeAddress("relay", "bundleEncoder", vm.parseJsonAddress(vm.readFile(_file(H)), ".bundleEncoder"));
        return vm.serializeString("relay", "bundleEncoderLedger", ids[H]);
    }

    function _httpJson() internal returns (string memory) {
        vm.serializeString("http", "host", "127.0.0.1");
        return vm.serializeUint("http", "port", 8787);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Scenarios
    //   1 delivered · 2 Connector misses the deadline, user paid from the bond on H
    //   3 delivery proof reaches H before the deposit proof
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Write the user's quote request of scenario `n` (pay on Y, receive 0.5 on X; refund account on H).
    function request(uint8 n) external {
        _ctx(Y);
        address u = vm.addr(USER_PK);
        string memory k = string.concat("req", vm.toString(n));
        vm.serializeString(k, "srcLedger", ids[Y]);
        vm.serializeAddress(k, "assetIn", address(0));
        vm.serializeString(k, "dstLedger", ids[X]);
        vm.serializeAddress(k, "assetOut", address(0));
        vm.serializeString(k, "amountOut", "500000000000000000");
        vm.serializeAddress(k, "recipient", _recipient(n));
        vm.serializeAddress(k, "user", u);
        vm.serializeAddress(k, "refundTo", _refundTo(n));
        string memory json = vm.serializeUint(k, "deadline", block.timestamp + (n == 2 ? 600 : 3600));
        vm.writeJson(json, string.concat("e2e-out/settle/request-", vm.toString(n), ".json"));
    }

    /// @notice On Y: the user deposits against the Connector's quote of scenario `n`.
    function deposit(uint8 n) external {
        _ctx(Y);
        string memory json = vm.readFile(string.concat("e2e-out/settle/quote-", vm.toString(n), ".json"));
        SettleTypes.Quote memory q = _parseQuote(json);
        bytes memory sig = vm.parseJsonBytes(json, ".signature");
        SettleDeposit dep = SettleDeposit(vm.parseJsonAddress(vm.readFile(_file(Y)), ".deposit"));
        require(dep.orderIdOf(q) == vm.parseJsonBytes32(json, ".orderId"), "order id differs from the service's");
        vm.startBroadcast(USER_PK);
        (bytes32 id,) = dep.deposit{value: q.amountIn}(q, sig);
        vm.stopBroadcast();
        console.log("ORDER_ID");
        console.logBytes32(id);
    }

    /// @notice On H: anyone claims the default of scenario `n` (after run.sh moved the clocks past the deadline).
    function claim(uint8 n) external {
        _ctx(H);
        bytes32 id = vm.parseJsonBytes32(
            vm.readFile(string.concat("e2e-out/settle/quote-", vm.toString(n), ".json")), ".orderId"
        );
        vm.startBroadcast(DEPLOYER_PK);
        _book().claimDefault(id);
        vm.stopBroadcast();
    }

    function check(uint8 n) external {
        _ctx(H);
        string memory json = vm.readFile(string.concat("e2e-out/settle/quote-", vm.toString(n), ".json"));
        bytes32 id = vm.parseJsonBytes32(json, ".orderId");
        uint256 amountOut = vm.parseUint(vm.parseJsonString(json, ".quote.amountOut"));
        (, SettleOrderBook.Status s,,,,,,,,, uint256 owedOnDefault,) = _book().orders(id);
        uint256 refund = _refundTo(n).balance;
        vm.selectFork(forks[X]);
        uint256 received = _recipient(n).balance;

        uint8 want = uint8(n == 2 ? SettleOrderBook.Status.DEFAULTED : SettleOrderBook.Status.DELIVERED);
        require(uint8(s) == want, string.concat("status ", vm.toString(uint8(s)), " != ", vm.toString(want)));
        if (n == 2) {
            require(refund == owedOnDefault, "user paid cover + penalty on H");
            require(received == 0, "nothing delivered on X");
        } else {
            require(received == amountOut, "recipient paid on X");
            require(refund == 0, "no bond payout");
        }
        console.log("CHECK_OK scenario", n);
        console.log("  status", uint8(s));
        console.log("  delivered on X", received);
        console.log("  paid from bond on H", refund);
    }

    // ═════════════════════════════════════════════════════════════════════
    // helpers
    // ═════════════════════════════════════════════════════════════════════

    function _service(uint8 here) internal returns (ClprService svc) {
        svc = new ClprService(
            vm.addr(DEPLOYER_PK),
            1,
            ids[here],
            address(new ChannelLogic()),
            address(new MessagingLogic()),
            address(new BundleLogic()),
            address(new ConnectorLogic()),
            address(new AdminLogic()),
            address(new BundleDecodeHelper())
        );
        svc.initialize(abi.encodePacked(address(svc)), throttles, "", "", _econ());
        svc.setClprEnabled(true);
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

    function _parseQuote(string memory json) internal pure returns (SettleTypes.Quote memory q) {
        q.connector = vm.parseJsonAddress(json, ".quote.connector");
        q.srcLedger = vm.parseJsonBytes32(json, ".quote.srcLedger");
        q.depositApp = vm.parseJsonBytes32(json, ".quote.depositApp");
        q.user = vm.parseJsonBytes32(json, ".quote.user");
        q.payTo = vm.parseJsonBytes32(json, ".quote.payTo");
        q.assetIn = vm.parseJsonBytes32(json, ".quote.assetIn");
        q.amountIn = vm.parseUint(vm.parseJsonString(json, ".quote.amountIn"));
        q.dstLedger = vm.parseJsonBytes32(json, ".quote.dstLedger");
        q.assetOut = vm.parseJsonBytes32(json, ".quote.assetOut");
        q.recipient = vm.parseJsonBytes32(json, ".quote.recipient");
        q.amountOut = vm.parseUint(vm.parseJsonString(json, ".quote.amountOut"));
        q.coverAsset = vm.parseJsonAddress(json, ".quote.coverAsset");
        q.coverAmount = vm.parseUint(vm.parseJsonString(json, ".quote.coverAmount"));
        q.refundTo = vm.parseJsonAddress(json, ".quote.refundTo");
        q.issuedAt = uint64(vm.parseJsonUint(json, ".quote.issuedAt"));
        q.expiry = uint64(vm.parseJsonUint(json, ".quote.expiry"));
        q.deadline = uint64(vm.parseJsonUint(json, ".quote.deadline"));
        q.salt = vm.parseJsonBytes32(json, ".quote.salt");
    }

    function _ctx(uint8 here) internal {
        rpcs[0] = vm.envOr("RPC_Y", string("http://127.0.0.1:18555"));
        rpcs[1] = vm.envOr("RPC_X", string("http://127.0.0.1:18556"));
        rpcs[2] = vm.envOr("RPC_H", string("http://127.0.0.1:18557"));
        uint256 active = vm.activeFork();
        for (uint8 i = 0; i < 3; i++) {
            forks[i] = i == here ? active : vm.createFork(rpcs[i]);
        }
        vm.selectFork(forks[here]);
    }

    function _svc(uint8 i) internal view returns (address) {
        return vm.parseJsonAddress(vm.readFile(_file(i)), ".service");
    }

    function _book() internal view returns (SettleOrderBook) {
        return SettleOrderBook(payable(vm.parseJsonAddress(vm.readFile(_file(H)), ".orderBook")));
    }

    function _file(uint8 i) internal pure returns (string memory) {
        return string.concat("e2e-out/settle/L", vm.toString(i), ".json");
    }

    function _seed(uint8 c) internal pure returns (bytes32) {
        return c == Y ? bytes32("conn-YH") : bytes32("conn-XH");
    }

    function _salt(uint8 c) internal pure returns (bytes32) {
        return c == Y ? bytes32("YH") : bytes32("XH");
    }

    /// @dev Channel between chain `c` (Y or X) and H.
    function _channelId(uint8 c) internal returns (bytes32) {
        Vm.Wallet memory w = vm.createWallet(CHANNEL_PK);
        bytes memory pubKey = abi.encodePacked(w.publicKeyX, w.publicKeyY);
        string memory a = ids[c];
        string memory b = ids[H];
        (bytes memory lo, bytes memory hi) =
            keccak256(bytes(a)) <= keccak256(bytes(b)) ? (bytes(a), bytes(b)) : (bytes(b), bytes(a));
        return keccak256(abi.encodePacked(lo, hi, pubKey, _salt(c)));
    }

    function _connectorId(bytes32 ch, bytes32 seed) internal returns (bytes32) {
        Vm.Wallet memory w = vm.createWallet(uint256(keccak256(abi.encodePacked("clpr.test.connectorSigner", seed))));
        return keccak256(abi.encodePacked(ch, abi.encodePacked(w.publicKeyX, w.publicKeyY), bytes32(0)));
    }

    function _recipient(uint8 n) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked("settle-e2e-recipient", n)))));
    }

    function _refundTo(uint8 n) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked("settle-e2e-refund", n)))));
    }
}
