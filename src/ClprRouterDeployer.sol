// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IClprRouterDeployer} from "./interfaces/IClprRouter.sol";

/// @title ClprRouterDeployer
/// @notice CREATE2 deployer that pins every CLPRouter of one deployment to a canonical address and to the
///         deployment's parameters.
/// @dev The Router of ledger L is deployed at
///        CREATE2(this, keccak256(abi.encode(DEPLOYMENT_SALT, keccak256(bytes(L)))), INIT_CODE_HASH)
///      and keeps (this, DEPLOYMENT_SALT, INIT_CODE_HASH) as immutables, so every Router can recompute the
///      canonical Router address of any EVM ledger and refuses envelopes naming any other Router. The Router's
///      init code carries no constructor arguments (it reads them from {parameters} during deployment), so its
///      hash is the same on every ledger.
///
///      Deploy this contract at the same address on every EVM ledger of the deployment (e.g. through the
///      deterministic-deployment proxy, with the same constructor arguments). Its constructor arguments fix, for
///      every Router it will ever deploy, the gas and grace parameters (range-checked here), the code and initial
///      committee of the provider registry and the code of the quarantine vault; since they determine this
///      contract's address, they are part of every canonical Router address. Only `OWNER` may deploy Routers
///      (otherwise anyone could take a ledger's canonical address with a Router wired to a fake CLPR Service), and
///      only the pinned init code; what the owner still chooses for a ledger not yet deployed is its CLPR Service
///      (which must report that ledger's chain id) and which registry and vault instances (which must carry the
///      pinned code and committee) the Router uses. A Router cannot be replaced (the address is taken) and has no
///      admin functions.
contract ClprRouterDeployer is IClprRouterDeployer {
    error NotOwner();
    error WrongInitCode();
    error DeployFailed();
    /// @notice A deployment parameter is out of range, or a deploy names parameters, a registry or a vault that
    ///         do not match what this deployer pins.
    error InvalidParameters();

    event RouterDeployed(string ledgerId, address router);

    /// @notice Bounds of the Router's gas and grace parameters.
    uint64 public constant MIN_RECLAIM_GRACE = 1 hours;
    uint64 public constant MAX_RECLAIM_GRACE = 30 days;
    uint64 public constant MIN_APP_GAS = 50_000;
    uint64 public constant MAX_APP_GAS = 10_000_000;
    uint64 public constant MIN_MIN_SEND_GAS = 100_000;
    uint64 public constant MAX_MIN_SEND_GAS = 30_000_000;

    address public immutable OWNER;
    bytes32 public immutable DEPLOYMENT_SALT;
    bytes32 public immutable INIT_CODE_HASH;
    /// @notice Gas and grace parameters of every Router of the deployment.
    uint64 public immutable RECLAIM_GRACE;
    uint64 public immutable APP_GAS;
    uint64 public immutable MIN_SEND_GAS;
    /// @notice Runtime code hash of the provider registry, and its genesis head (`headAt(0)`, which commits to the
    ///         deployment id, the initial committee and threshold, the contact and the notice periods).
    bytes32 public immutable REGISTRY_CODE_HASH;
    bytes32 public immutable REGISTRY_GENESIS;
    /// @notice Runtime code hash of the quarantine vault (independent of the registry it serves).
    bytes32 public immutable VAULT_CODE_HASH;

    Params private _params;

    constructor(address owner, bytes32 deploymentSalt, bytes32 initCodeHash, Pins memory pins) {
        if (
            pins.reclaimGrace < MIN_RECLAIM_GRACE || pins.reclaimGrace > MAX_RECLAIM_GRACE || pins.appGas < MIN_APP_GAS
                || pins.appGas > MAX_APP_GAS || pins.minSendGas < MIN_MIN_SEND_GAS || pins.minSendGas > MAX_MIN_SEND_GAS
                || pins.registryCodeHash == bytes32(0) || pins.registryGenesis == bytes32(0)
                || pins.vaultCodeHash == bytes32(0)
        ) revert InvalidParameters();
        OWNER = owner;
        DEPLOYMENT_SALT = deploymentSalt;
        INIT_CODE_HASH = initCodeHash;
        RECLAIM_GRACE = pins.reclaimGrace;
        APP_GAS = pins.appGas;
        MIN_SEND_GAS = pins.minSendGas;
        REGISTRY_CODE_HASH = pins.registryCodeHash;
        REGISTRY_GENESIS = pins.registryGenesis;
        VAULT_CODE_HASH = pins.vaultCodeHash;
    }

    /// @notice CREATE2 salt of the Router of `ledgerId`.
    function saltFor(string memory ledgerId) public view returns (bytes32) {
        return keccak256(abi.encode(DEPLOYMENT_SALT, keccak256(bytes(ledgerId))));
    }

    /// @notice Canonical Router address of `ledgerId` (whether or not it is deployed yet).
    function routerAddress(string memory ledgerId) external view returns (address) {
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), saltFor(ledgerId), INIT_CODE_HASH)))
            )
        );
    }

    /// @notice Deploy the Router of `p.ledgerId` at its canonical address.
    /// @param initCode `type(ClprRouter).creationCode` with its libraries linked; must hash to INIT_CODE_HASH.
    /// @param p The ledger's CLPR Service, registry and vault instances, and its ledger id; the gas and grace
    ///        parameters must equal the pinned ones, the registry must carry the pinned code and genesis head, and
    ///        the vault the pinned code and that registry.
    function deploy(bytes memory initCode, Params calldata p) external returns (address router) {
        if (msg.sender != OWNER) revert NotOwner();
        if (keccak256(initCode) != INIT_CODE_HASH) revert WrongInitCode();
        address registry = address(p.registry);
        address vault = address(p.vault);
        if (
            p.reclaimGrace != RECLAIM_GRACE || p.appGas != APP_GAS || p.minSendGas != MIN_SEND_GAS
                || registry.codehash != REGISTRY_CODE_HASH || vault.codehash != VAULT_CODE_HASH
                || IPinnedRegistry(registry).headAt(0) != REGISTRY_GENESIS || IPinnedVault(vault).REGISTRY() != registry
        ) revert InvalidParameters();
        _params = p;
        bytes32 salt = saltFor(p.ledgerId);
        assembly ("memory-safe") {
            router := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        delete _params;
        if (router == address(0)) revert DeployFailed();
        emit RouterDeployed(p.ledgerId, router);
    }

    /// @inheritdoc IClprRouterDeployer
    function parameters() external view returns (Params memory) {
        return _params;
    }
}

/// @dev What the deployer reads from the registry and vault it checks.
interface IPinnedRegistry {
    function headAt(uint64 version) external view returns (bytes32);
}

interface IPinnedVault {
    function REGISTRY() external view returns (address);
}
