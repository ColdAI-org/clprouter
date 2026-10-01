// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IClprRouterDeployer} from "./interfaces/IClprRouter.sol";

/// @title ClprRouterDeployer
/// @notice CREATE2 deployer that pins every CLPRouter of one deployment to a canonical address.
/// @dev The Router of ledger L is deployed at
///        CREATE2(this, keccak256(abi.encode(DEPLOYMENT_SALT, keccak256(bytes(L)))), INIT_CODE_HASH)
///      and keeps (this, DEPLOYMENT_SALT, INIT_CODE_HASH) as immutables, so every Router can recompute the
///      canonical Router address of any EVM ledger and refuses envelopes naming any other Router. The Router's
///      init code carries no constructor arguments (it reads them from {parameters} during deployment), so its
///      hash is the same on every ledger.
///
///      Deploy this contract at the same address on every EVM ledger of the deployment (e.g. through the
///      deterministic-deployment proxy, with the same owner, salt and init-code hash). Only `OWNER` may deploy
///      Routers (otherwise anyone could take a ledger's canonical address with a Router wired to a fake CLPR
///      Service), and only the pinned init code. The owner has no other power: a Router cannot be replaced (the
///      address is taken) and has no admin functions.
contract ClprRouterDeployer is IClprRouterDeployer {
    error NotOwner();
    error WrongInitCode();
    error DeployFailed();

    event RouterDeployed(string ledgerId, address router);

    address public immutable OWNER;
    bytes32 public immutable DEPLOYMENT_SALT;
    bytes32 public immutable INIT_CODE_HASH;

    Params private _params;

    constructor(address owner, bytes32 deploymentSalt, bytes32 initCodeHash) {
        OWNER = owner;
        DEPLOYMENT_SALT = deploymentSalt;
        INIT_CODE_HASH = initCodeHash;
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
    function deploy(bytes memory initCode, Params calldata p) external returns (address router) {
        if (msg.sender != OWNER) revert NotOwner();
        if (keccak256(initCode) != INIT_CODE_HASH) revert WrongInitCode();
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
