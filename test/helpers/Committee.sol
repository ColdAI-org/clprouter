// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";

/// @notice Provider committee test helper: 5 members, k = 3 (disable/blacklist need 4).
abstract contract Committee is Test {
    uint8 internal constant K = 3;
    uint64 internal constant CERT_NOTICE = 7 days;
    uint64 internal constant REMOVAL_NOTICE = 72 hours;
    uint64 internal constant REENABLE_NOTICE = 7 days;
    uint64 internal constant DISABLE_LAPSE = 7 days;
    uint64 internal constant BLACKLIST_LAPSE = 30 days;
    string internal constant CONTACT = "mailto:incident@provider.example";
    bytes32 internal constant EVIDENCE = keccak256("evidence-document-v1");

    uint8 internal constant A_CERTIFY = 1;
    uint8 internal constant A_UNCERTIFY = 2;
    uint8 internal constant A_DISABLE = 3;
    uint8 internal constant A_ENABLE = 4;
    uint8 internal constant A_BLACKLIST = 5;
    uint8 internal constant A_DELIST = 6;
    uint8 internal constant A_COMMITTEE = 7;
    uint8 internal constant A_CONTACT = 8;
    uint8 internal constant A_VAULT_RELEASE = 9;
    uint8 internal constant A_VAULT_NAME_RECOVERY = 10;

    uint256[] internal memberPks; // sorted by address
    address[] internal memberAddrs;

    function _initCommittee() internal {
        uint256[5] memory pks = [uint256(0xA11CE), 0xB0B, 0xCA401, 0xD00D, 0xE7E];
        // sort by address (insertion sort)
        for (uint256 i = 0; i < pks.length; i++) {
            memberPks.push(pks[i]);
            memberAddrs.push(vm.addr(pks[i]));
        }
        for (uint256 i = 1; i < memberAddrs.length; i++) {
            for (uint256 j = i; j > 0 && memberAddrs[j - 1] > memberAddrs[j]; j--) {
                (memberAddrs[j - 1], memberAddrs[j]) = (memberAddrs[j], memberAddrs[j - 1]);
                (memberPks[j - 1], memberPks[j]) = (memberPks[j], memberPks[j - 1]);
            }
        }
    }

    function _deployRegistry() internal returns (ProviderRegistry) {
        return new ProviderRegistry(
            memberAddrs, K, CONTACT, [CERT_NOTICE, REMOVAL_NOTICE, REENABLE_NOTICE, DISABLE_LAPSE, BLACKLIST_LAPSE]
        );
    }

    /// @dev A decision with the next nonce for `reg` (vault decisions pass an explicit nonce).
    function _decision(ProviderRegistry reg, uint8 action, bytes memory payload)
        internal
        view
        returns (IProviderRegistry.Decision memory d)
    {
        d = IProviderRegistry.Decision({
            action: action,
            payload: payload,
            evidenceHash: EVIDENCE,
            nonce: reg.version() + 1,
            effectiveAt: 0,
            validUntil: uint64(block.timestamp + 1 days),
            epoch: reg.epoch()
        });
    }

    /// @dev Signatures of the first `count` members (address order) over `d`.
    function _sign(IProviderRegistry.Decision memory d, uint256 count) internal view returns (bytes[] memory sigs) {
        return _signWith(d, memberPks, count);
    }

    function _signWith(IProviderRegistry.Decision memory d, uint256[] memory pks, uint256 count)
        internal
        pure
        returns (bytes[] memory sigs)
    {
        bytes32 digest = keccak256(
            abi.encode(
                keccak256("CLPRouter.ProviderRegistry.v1"),
                d.action,
                keccak256(d.payload),
                d.evidenceHash,
                d.nonce,
                d.effectiveAt,
                d.validUntil,
                d.epoch
            )
        );
        bytes32 h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        sigs = new bytes[](count);
        for (uint256 i = 0; i < count; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[i], h);
            sigs[i] = abi.encodePacked(r, s, v);
        }
    }

    /// @dev Apply a decision with exactly the required number of signatures.
    function _apply(ProviderRegistry reg, uint8 action, bytes memory payload) internal returns (bytes32) {
        IProviderRegistry.Decision memory d = _decision(reg, action, payload);
        return reg.submit(d, _sign(d, reg.requiredSignatures(action)));
    }

    // ── payload builders ───────────────────────────────────────────────────

    function _certifyPayload(string memory ledger, uint8 label, uint64 expiry, uint64 emissionsUg)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(ledger, label, expiry, emissionsUg, emissionsUg == 0 ? "" : "MiCA white paper 2025");
    }

    function _disablePayload(uint8 kind, bytes32 subject) internal pure returns (bytes memory) {
        return abi.encode(kind, subject, "verifier compromised");
    }

    function _blacklistPayload(string memory caip10, bytes32 caseId) internal pure returns (bytes memory) {
        return abi.encode(caip10, caseId, "exploit proceeds");
    }
}
