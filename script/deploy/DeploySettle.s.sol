// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {SettleOrderBook} from "../../src/settle/SettleOrderBook.sol";
import {SettleDeposit} from "../../src/settle/SettleDeposit.sol";
import {SettleDelivery} from "../../src/settle/SettleDelivery.sol";
import {SettleTypes} from "../../src/settle/SettleTypes.sol";
import {SettleTestnetConnector} from "./SettleFixtures.sol";

/// @notice Settle on Hedera on the public testnets: `SettleOrderBook` on Hedera testnet, `SettleDeposit` and
///         `SettleDelivery` on Sepolia, over the existing Sepolia -> Hedera CLPR Channel (config/route.json), and the
///         CLPR connector that carries their messages. Driven by script/deploy/settle.sh; every function broadcasts
///         to exactly one chain (the --rpc-url one), skips what already exists and re-checks it.
///
///         All addresses are CREATE2 (deterministic-deployment proxy), so the Sepolia contracts can name the order
///         book before it exists and the order book's source can name them.
///
///         Environment (set by settle.sh; keys are never printed):
///           SETTLE_CONFIG                script/deploy/config/settle.json
///           CLPR_TESTNET_PRIVATE_KEY     deployer, order-book admin, CLPR connector owner (testnet only)
///           SETTLE_CLPR_CONNECTOR_PK     throwaway CLPR connector operator key (deployments/.local/)
contract DeploySettle is Script {
    uint256 internal constant SEPOLIA = 11155111;
    uint256 internal constant HEDERA = 296;

    // ═════════════════════════════════════════════════════════════════════
    // Steps
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Hedera: the order book (admin = the deployer; it can only add sources and provers).
    function deployOrderBook() external {
        require(block.chainid == HEDERA, "order book runs on Hedera");
        SettleOrderBook ob = SettleOrderBook(_create2("SettleOrderBook", _orderBookInit()));
        require(ob.CLPR_SERVICE() == _addr(".hedera.service"), "order book: wrong service");
        require(ob.admin() == vm.addr(_ownerPk()), "order book: wrong admin");
        _codeInfo("SettleOrderBook", address(ob));
        console.log("DOMAIN_SEPARATOR");
        console.logBytes32(ob.DOMAIN_SEPARATOR());
    }

    /// @notice Sepolia: SettleDeposit and SettleDelivery, bound to the Channel, the settle CLPR connector and the
    ///         order book's CREATE2 address on Hedera.
    function deploySepolia() external {
        require(block.chainid == SEPOLIA, "deposit/delivery run on Sepolia");
        bytes32 id = _clprConnectorId();
        require(_service().deriveConnectorId(_channel(), _clprPub(), _clprSalt()) == id, "connector id derivation");
        require(_clprConnectorIdView() == id, "SETTLE_CLPR_CONNECTOR_PUB does not match the key");
        SettleDeposit dep = SettleDeposit(_create2("SettleDeposit", _depositInit()));
        SettleDelivery del = SettleDelivery(_create2("SettleDelivery", _deliveryInit()));
        require(dep.ORDER_BOOK() == orderBookAddress() && del.ORDER_BOOK() == orderBookAddress(), "wrong order book");
        require(dep.CHANNEL_ID() == _channel() && del.CHANNEL_ID() == _channel(), "wrong channel");
        require(dep.CLPR_CONNECTOR_ID() == id && del.CLPR_CONNECTOR_ID() == id, "wrong CLPR connector");
        require(dep.LEDGER() == SettleTypes.ledgerId(_str(".sepolia.ledgerId")), "wrong ledger");
        _codeInfo("SettleDeposit", address(dep));
        _codeInfo("SettleDelivery", address(del));
    }

    /// @notice Hedera: register the Channel as the Sepolia source (deposit and delivery senders). Effective after
    ///         SOURCE_NOTICE; never replaced.
    function proposeSource() external {
        require(block.chainid == HEDERA, "sources live on Hedera");
        SettleOrderBook ob = SettleOrderBook(orderBookAddress());
        require(address(ob).code.length > 0, "order book not deployed");
        bytes32 ledger = SettleTypes.ledgerId(_str(".sepolia.ledgerId"));
        (bytes32 have,,, uint64 activeAt) = ob.sources(_channel());
        if (have == bytes32(0)) {
            vm.startBroadcast(_ownerPk());
            ob.proposeSource(
                _channel(), ledger, abi.encodePacked(depositAddress()), abi.encodePacked(deliveryAddress())
            );
            vm.stopBroadcast();
            (,,, activeAt) = ob.sources(_channel());
            console.log("SOURCE_PROPOSED active at", activeAt);
        } else {
            require(have == ledger, "channel is the source of another ledger");
            console.log("SOURCE_EXISTS active at", activeAt);
        }
        (, bytes32 depositSender, bytes32 deliverySender,) = ob.sources(_channel());
        require(depositSender == keccak256(abi.encodePacked(depositAddress())), "source: deposit sender");
        require(deliverySender == keccak256(abi.encodePacked(deliveryAddress())), "source: delivery sender");
    }

    /// @notice Either chain: the settle CLPR connector contract, allowing SettleDeposit and SettleDelivery (on
    ///         Hedera it only pays for inbound execution, so it allows nothing).
    function deployClprConnector() external {
        address c = _create2("SettleTestnetConnector", _clprConnectorInit(block.chainid));
        SettleTestnetConnector conn = SettleTestnetConnector(payable(c));
        if (block.chainid == SEPOLIA) {
            vm.startBroadcast(_ownerPk());
            if (!conn.allowed(depositAddress())) conn.setAllowed(depositAddress(), true);
            if (!conn.allowed(deliveryAddress())) conn.setAllowed(deliveryAddress(), true);
            vm.stopBroadcast();
        }
        _codeInfo("SettleTestnetConnector", c);
    }

    /// @notice Either chain: register the settle CLPR connector on the Channel (commit-reveal, locked stake per the
    ///         Service's economics); on Hedera, fund it for inbound execution.
    function registerClprConnector() external {
        IClprService svc = _service();
        bytes32 id = _clprConnectorId();
        address conn = _clprConnectorAddress(block.chainid);
        require(conn.code.length > 0, "SettleTestnetConnector not deployed");
        if (svc.hasConnector(_channel(), id)) {
            console.log("CLPR_CONNECTOR_EXISTS");
            console.logBytes32(id);
        } else {
            bytes memory pub = _clprPub();
            bytes memory sig =
                _sign(vm.envUint("SETTLE_CLPR_CONNECTOR_PK"), keccak256(abi.encodePacked(id, address(svc))));
            uint256 stake = svc.getEconomicConfig().minLockedStake;
            vm.startBroadcast(_ownerPk());
            svc.registerConnector(keccak256(abi.encodePacked(id, pub)));
            svc.completeConnector{value: stake}(id, pub, sig, _clprSalt(), _channel(), conn, vm.addr(_ownerPk()));
            vm.stopBroadcast();
            console.log("CLPR_CONNECTOR_REGISTERED");
            console.logBytes32(id);
        }
        if (block.chainid == HEDERA) {
            // 1 HBAR = 1e18 in the relay's units; the relay converts value to tinybars.
            uint256 target = vm.parseJsonUint(_cfg(), ".clprConnector.hederaFundingWei");
            if (conn.balance < target) {
                vm.startBroadcast(_ownerPk());
                (bool ok,) = payable(conn).call{value: target - conn.balance}("");
                vm.stopBroadcast();
                require(ok, "funding failed");
                console.log("CLPR_CONNECTOR_FUNDED wei", target);
            }
        }
    }

    /// @notice Read-only summary of everything above on the current chain.
    function status() external {
        console.log("ORDER_BOOK", orderBookAddress());
        console.log("SETTLE_DEPOSIT", depositAddress());
        console.log("SETTLE_DELIVERY", deliveryAddress());
        console.log("CLPR_CONNECTOR_ID");
        console.logBytes32(_clprConnectorId());
        console.log("CLPR_CONNECTOR_CONTRACT", _clprConnectorAddress(block.chainid));
        IClprService svc = _service();
        console.log("clpr connector registered", svc.hasConnector(_channel(), _clprConnectorId()));
        if (block.chainid == HEDERA && orderBookAddress().code.length > 0) {
            SettleOrderBook ob = SettleOrderBook(orderBookAddress());
            (bytes32 ledger,,, uint64 activeAt) = ob.sources(_channel());
            console.log("source ledger set", ledger != bytes32(0));
            console.log("source active at", activeAt, "now", block.timestamp);
        } else if (block.chainid == SEPOLIA) {
            console.log("deposit deployed", depositAddress().code.length > 0);
            console.log("delivery deployed", deliveryAddress().code.length > 0);
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // Addresses (CREATE2, recomputed from the init code)
    // ═════════════════════════════════════════════════════════════════════

    function orderBookAddress() public view returns (address) {
        return vm.computeCreate2Address(_salt("SettleOrderBook"), keccak256(_orderBookInit()), CREATE2_FACTORY);
    }

    function depositAddress() public view returns (address) {
        return vm.computeCreate2Address(_salt("SettleDeposit"), keccak256(_depositInit()), CREATE2_FACTORY);
    }

    function deliveryAddress() public view returns (address) {
        return vm.computeCreate2Address(_salt("SettleDelivery"), keccak256(_deliveryInit()), CREATE2_FACTORY);
    }

    function _clprConnectorAddress(uint256 chain) internal view returns (address) {
        return vm.computeCreate2Address(
            _salt("SettleTestnetConnector"), keccak256(_clprConnectorInit(chain)), CREATE2_FACTORY
        );
    }

    // ═════════════════════════════════════════════════════════════════════
    // Init code
    // ═════════════════════════════════════════════════════════════════════

    function _orderBookInit() internal view returns (bytes memory) {
        string memory c = _cfg();
        return abi.encodePacked(
            type(SettleOrderBook).creationCode,
            abi.encode(
                _addr(".hedera.service"),
                vm.addr(_ownerPk()),
                vm.parseJsonAddressArray(c, ".orderBook.coverAssets"),
                uint16(vm.parseJsonUint(c, ".orderBook.penaltyBps")),
                uint64(vm.parseJsonUint(c, ".orderBook.withdrawDelay")),
                uint64(vm.parseJsonUint(c, ".orderBook.proofGrace")),
                uint64(vm.parseJsonUint(c, ".orderBook.maxQuoteTtl")),
                uint64(vm.parseJsonUint(c, ".orderBook.sourceNotice"))
            )
        );
    }

    function _depositInit() internal view returns (bytes memory) {
        return abi.encodePacked(
            type(SettleDeposit).creationCode,
            abi.encode(
                _addr(".sepolia.service"),
                _channel(),
                _clprConnectorIdView(),
                orderBookAddress(),
                _str(".sepolia.ledgerId"),
                vm.parseJsonUint(_cfg(), ".hedera.chainId")
            )
        );
    }

    function _deliveryInit() internal view returns (bytes memory) {
        return abi.encodePacked(
            type(SettleDelivery).creationCode,
            abi.encode(_addr(".sepolia.service"), _channel(), _clprConnectorIdView(), orderBookAddress())
        );
    }

    function _clprConnectorInit(uint256 chain) internal view returns (bytes memory) {
        address svc = _addr(chain == SEPOLIA ? ".sepolia.service" : ".hedera.service");
        return abi.encodePacked(type(SettleTestnetConnector).creationCode, abi.encode(svc, vm.addr(_ownerPk())));
    }

    // ═════════════════════════════════════════════════════════════════════
    // Helpers
    // ═════════════════════════════════════════════════════════════════════

    function _cfg() internal view returns (string memory) {
        return vm.envString("SETTLE_CONFIG");
    }

    function _str(string memory key) internal view returns (string memory) {
        return vm.parseJsonString(_cfg(), key);
    }

    function _addr(string memory key) internal view returns (address) {
        return vm.parseJsonAddress(_cfg(), key);
    }

    function _channel() internal view returns (bytes32) {
        return vm.parseJsonBytes32(_cfg(), ".channelId");
    }

    function _clprSalt() internal view returns (bytes32) {
        return vm.parseJsonBytes32(_cfg(), ".clprConnector.salt");
    }

    function _service() internal view returns (IClprService) {
        return IClprService(_addr(block.chainid == SEPOLIA ? ".sepolia.service" : ".hedera.service"));
    }

    function _ownerPk() internal view returns (uint256) {
        return vm.envUint("CLPR_TESTNET_PRIVATE_KEY");
    }

    function _clprPub() internal returns (bytes memory) {
        Vm.Wallet memory w = vm.createWallet(vm.envUint("SETTLE_CLPR_CONNECTOR_PK"));
        return abi.encodePacked(w.publicKeyX, w.publicKeyY);
    }

    /// @dev keccak256(channelId || pubKey || salt), as `ClprService.deriveConnectorId` (checked on Sepolia).
    function _clprConnectorId() internal returns (bytes32) {
        return keccak256(abi.encodePacked(_channel(), _clprPub(), _clprSalt()));
    }

    /// @dev Same as {_clprConnectorId} from the public key in SETTLE_CLPR_CONNECTOR_PUB (64-byte X || Y), so the
    ///      address helpers stay `view`.
    function _clprConnectorIdView() internal view returns (bytes32) {
        return keccak256(abi.encodePacked(_channel(), vm.envBytes("SETTLE_CLPR_CONNECTOR_PUB"), _clprSalt()));
    }

    function _sign(uint256 pk, bytes32 inner) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner)));
        return abi.encodePacked(r, s, v);
    }

    function _salt(string memory name) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(keccak256(bytes(_str(".salt"))), name));
    }

    function _codeInfo(string memory name, address a) internal view {
        console.log(string.concat("CODEHASH ", name));
        console.logBytes32(a.codehash);
        console.log(string.concat("CODESIZE ", name, " ", vm.toString(a.code.length)));
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
