// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {QuarantineVault} from "@clprouter/QuarantineVault.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {Committee} from "../../helpers/Committee.sol";

/// @notice Shared helpers for the registry / vault security suite (docs/audit/registry-vault-findings.md).
abstract contract AuditBase is Committee {
    uint64 internal constant RECOVERY_NOTICE = 3 days;
    uint64 internal constant CHALLENGE_WINDOW = 7 days;
    string internal constant HEDERA = "hedera:mainnet";
    string internal constant ACCT = "eip155:1:0x00000000000000000000000000000000000000ee";
    bytes32 internal constant CASE = keccak256("case-42");
    bytes16 internal constant ROUTE = bytes16(keccak256("route"));

    uint64 internal vaultNonce;

    function _newVault(ProviderRegistry r) internal returns (QuarantineVault) {
        return new QuarantineVault(IProviderRegistry(address(r)), RECOVERY_NOTICE, CHALLENGE_WINDOW);
    }

    /// @dev Signatures over `d` (as digested by `target`) by `pks` (any order), sorted by signer address as the
    ///      registry requires.
    function _signSorted(address target, IProviderRegistry.Decision memory d, uint256[] memory pks)
        internal
        view
        returns (bytes[] memory sigs)
    {
        uint256 n = pks.length;
        uint256[] memory p = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            p[i] = pks[i];
        }
        for (uint256 i = 1; i < n; i++) {
            for (uint256 j = i; j > 0 && vm.addr(p[j - 1]) > vm.addr(p[j]); j--) {
                (p[j - 1], p[j]) = (p[j], p[j - 1]);
            }
        }
        return _signWith(target, d, p, n);
    }

    function _vaultDecision(ProviderRegistry r, uint8 action, bytes memory payload)
        internal
        returns (IProviderRegistry.Decision memory d)
    {
        d = _decision(r, action, payload);
        d.nonce = ++vaultNonce;
    }

    /// @dev Bind `v` to `router` (k + 1 vault decision).
    function _bind(ProviderRegistry r, QuarantineVault v, address router) internal {
        IProviderRegistry.Decision memory d = _vaultDecision(r, 12, abi.encode(router));
        v.bindRouter(d, _sign(address(v), d, K + 1));
    }

    function _firstK(uint256 count) internal view returns (uint256[] memory pks) {
        pks = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            pks[i] = memberPks[i];
        }
    }

    function _sortedAddrs(uint256[] memory pks) internal pure returns (address[] memory a) {
        a = new address[](pks.length);
        for (uint256 i = 0; i < pks.length; i++) {
            a[i] = vm.addr(pks[i]);
        }
        for (uint256 i = 1; i < a.length; i++) {
            for (uint256 j = i; j > 0 && a[j - 1] > a[j]; j--) {
                (a[j - 1], a[j]) = (a[j], a[j - 1]);
            }
        }
    }
}
