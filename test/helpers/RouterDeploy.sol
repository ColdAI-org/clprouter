// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprRouter} from "@clprouter/ClprRouter.sol";
import {ClprRouterDeployer} from "@clprouter/ClprRouterDeployer.sol";
import {IClprRouterDeployer} from "@clprouter/interfaces/IClprRouter.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {IQuarantineVault} from "@clprouter/interfaces/IQuarantineVault.sol";
import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {Committee} from "./Committee.sol";

/// @notice Deploys CLPRouters of one test deployment at their canonical CREATE2 addresses and computes the
///         canonical address of any (deployed or not) ledger's Router.
abstract contract RouterDeploy is Committee {
    ClprRouterDeployer internal routerDeployer;

    function _initRouterDeployer() internal {
        if (address(routerDeployer) != address(0)) return;
        routerDeployer = new ClprRouterDeployer(
            address(this), keccak256("clprouter-test"), keccak256(type(ClprRouter).creationCode)
        );
    }

    function _deployRouter(
        IClprService service,
        IProviderRegistry registry,
        IQuarantineVault vault,
        string memory ledgerId,
        uint64 grace,
        uint64 appGas,
        uint64 minSendGas
    ) internal returns (ClprRouter) {
        _initRouterDeployer();
        return ClprRouter(
            routerDeployer.deploy(
                type(ClprRouter).creationCode,
                IClprRouterDeployer.Params(service, registry, vault, ledgerId, grace, appGas, minSendGas)
            )
        );
    }

    /// @dev Canonical Router address of `ledgerId` (the deployer must exist).
    function _routerAddr(string memory ledgerId) internal view returns (address) {
        return routerDeployer.routerAddress(ledgerId);
    }

    /// @dev Hop-state / replay key of envelope `id` that originated at (`ledgerId`, `router`).
    function _key(string memory ledgerId, address router, bytes16 id) internal pure returns (bytes32) {
        return keccak256(abi.encode(keccak256(bytes(ledgerId)), keccak256(abi.encodePacked(router)), id));
    }

    /// @dev Approve the direction of `ch` into `toLedger` on `reg` with `verifier` (tier 0); effective after CERT_NOTICE.
    function _approveChannel(ProviderRegistry reg, bytes32 ch, string memory toLedger, address verifier) internal {
        _apply(reg, A_TRUST_TIER, _trustPayload(ch, toLedger, 0, verifier));
    }

    /// @dev Approve both directions of `ch` between `x` and `y` on `reg` (tier 0, `verifier` on both sides).
    function _approveBoth(ProviderRegistry reg, bytes32 ch, string memory x, string memory y, address verifier)
        internal
    {
        _approveChannel(reg, ch, x, verifier);
        _approveChannel(reg, ch, y, verifier);
    }
}
