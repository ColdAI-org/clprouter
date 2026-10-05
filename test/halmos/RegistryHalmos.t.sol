// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SymTest} from "halmos-cheatcodes/SymTest.sol";
import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";

/// @title Symbolic proofs: provider decisions need k-of-n (k + 1 for disable, blacklist and delist)
/// @notice Run with `halmos` (see docs/quality.md). Functions are named `check_*` so `forge test` skips them.
///         ECDSA recovery is modelled by halmos as an uninterpreted function, so every proof below holds for
///         every possible signature bytes and every signer the recovery could return.
contract RegistryHalmos is Test, SymTest {
    uint64[6] internal NOTICES = [uint64(7 days), 72 hours, 7 days, 7 days, 30 days, 7 days];

    uint8 internal constant A_DISABLE = 3;
    uint8 internal constant A_BLACKLIST = 5;
    uint8 internal constant A_DELIST = 6;
    uint8 internal constant A_COMMITTEE = 7;
    uint8 internal constant A_VAULT_NAME_RECOVERY = 10;
    uint8 internal constant A_VAULT_BIND_ROUTER = 12;

    function _committee(uint256 n) internal pure returns (address[] memory m) {
        m = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            m[i] = address(uint160(0x1000 + i));
        }
    }

    /// @notice For every committee shape the constructor accepts (n in 3..7, every k) and every action id:
    ///         a disable, blacklist, delist, recovery naming or Router binding needs exactly k + 1 signatures;
    ///         a committee change max(k + 1, ceil(2n/3)); everything else k. Every quorum is a strict majority
    ///         (two disjoint quorums cannot both act) and is reachable (<= n).
    function check_requiredSignatures_matchesRules(uint8 k, uint8 action) public {
        // n is iterated concretely (3..7); k and the action id are symbolic.
        for (uint256 n = 3; n <= 7; n++) {
            // The constructor's committee rule; any other shape reverts at deployment (proven below).
            if (!(k >= 2 && 2 * uint256(k) > n && uint256(k) + 1 <= n)) continue;
            ProviderRegistry r = new ProviderRegistry(bytes32(uint256(1)), _committee(n), k, "c", NOTICES);

            uint256 req = r.requiredSignatures(action);
            uint256 supermajority = uint256(k) + 1 > (2 * n + 2) / 3 ? uint256(k) + 1 : (2 * n + 2) / 3;
            if (
                action == A_DISABLE || action == A_BLACKLIST || action == A_DELIST || action == A_VAULT_NAME_RECOVERY
                    || action == A_VAULT_BIND_ROUTER
            ) {
                assert(req == uint256(k) + 1);
            } else if (action == A_COMMITTEE) {
                assert(req == supermajority);
            } else {
                assert(req == k);
            }
            assert(req >= k);
            assert(2 * req > n);
            assert(req <= n);
        }
    }

    /// @notice Constructor rejects every committee shape outside the rule (n >= 3, k >= 2, k > n/2, k + 1 <= n).
    function check_constructor_rejectsWeakCommittees(uint8 k) public {
        for (uint256 n = 0; n <= 7; n++) {
            if (n >= 3 && k >= 2 && 2 * uint256(k) > n && uint256(k) + 1 <= n) continue;
            try new ProviderRegistry(bytes32(uint256(1)), _committee(n), k, "c", NOTICES) returns (ProviderRegistry) {
                assert(false);
            } catch {}
        }
    }

    /// @notice `checkApproval` (used by the registry for every decision and by the vault for every vault
    ///         decision) accepts a signature set only if it has at least `required` entries whose recovered
    ///         signers are members of the epoch's committee, in strictly ascending order (so pairwise distinct).
    function check_checkApproval_needsDistinctMembers(bytes32 digest, uint256 required) public {
        ProviderRegistry r = new ProviderRegistry(bytes32(uint256(1)), _committee(4), 3, "c", NOTICES);
        bytes32 h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        // Signature-set sizes 0..3 are iterated concretely; contents are symbolic.
        for (uint256 len = 0; len <= 3; len++) {
            bytes[] memory sigs = new bytes[](len);
            for (uint256 i = 0; i < len; i++) {
                sigs[i] = svm.createBytes(65, "sig");
            }
            (bool ok,) = address(r).staticcall(abi.encodeCall(r.checkApproval, (digest, 0, sigs, required)));
            if (!ok) continue;
            assert(len >= required);
            address last;
            for (uint256 i = 0; i < len; i++) {
                address signer = _recover(h, sigs[i]);
                assert(r.isMemberOf(0, signer));
                assert(signer > last);
                last = signer;
            }
        }
    }

    /// @dev The recovery OpenZeppelin's ECDSA.tryRecover performs for a 65-byte signature.
    function _recover(bytes32 h, bytes memory sig) internal pure returns (address) {
        bytes32 rr;
        bytes32 ss;
        uint8 v;
        assembly ("memory-safe") {
            rr := mload(add(sig, 0x20))
            ss := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        return ecrecover(h, v, rr, ss);
    }

    /// @notice A relayed decision with fewer signatures than its action's quorum is always rejected, whatever the
    ///         action, payload, signatures or timing (4 members, k = 3: disable/blacklist/delist need 4).
    function check_submit_rejectsBelowQuorum(uint8 action, bytes32 evidence, uint64 effectiveAt, uint64 validUntil)
        public
    {
        ProviderRegistry r = new ProviderRegistry(bytes32(uint256(1)), _committee(4), 3, "c", NOTICES);
        IProviderRegistry.Decision memory d = IProviderRegistry.Decision({
            action: action,
            payload: svm.createBytes(96, "payload"),
            evidenceHash: evidence,
            nonce: 1,
            effectiveAt: effectiveAt,
            validUntil: validUntil,
            epoch: 0
        });
        uint256 req = r.requiredSignatures(action);
        for (uint256 len = 0; len <= 3; len++) {
            if (len >= req) continue;
            bytes[] memory sigs = new bytes[](len);
            for (uint256 i = 0; i < len; i++) {
                sigs[i] = svm.createBytes(65, "sig");
            }
            (bool ok,) = address(r).call(abi.encodeCall(r.submit, (d, sigs)));
            assert(!ok);
            assert(r.version() == 0);
        }
    }
}

/// @title Symbolic proof: during a committee hand-over the outgoing committee needs a supermajority
/// @notice Its own contract: the take-over time is written into the registry's storage, which other proofs never see.
contract RegistryHandOverHalmos is Test, SymTest {
    uint64[6] internal NOTICES = [uint64(7 days), 72 hours, 7 days, 7 days, 30 days, 7 days];

    function _committee(uint256 n) internal pure returns (address[] memory m) {
        m = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            m[i] = address(uint160(0x1000 + i));
        }
    }

    /// @notice Once a scheduled committee's notice has passed, every action of the outgoing committee needs at
    ///         least the supermajority max(k + 1, ceil(2n/3)), registry and vault actions alike (the vault asks
    ///         `requiredSignatures`); before it, the quorum table above applies unchanged. For every committee
    ///         shape with n in 3..7, every k, every action id and every scheduled take-over time, before or after
    ///         `now` (the clock stays concrete, so no symbolic time leaks into the other proofs).
    function check_requiredSignatures_supermajorityAfterNotice(uint8 k, uint8 action, uint64 from) public {
        vm.assume(from != 0);
        vm.warp(1_800_000_000);
        for (uint256 n = 3; n <= 7; n++) {
            if (!(k >= 2 && 2 * uint256(k) > n && uint256(k) + 1 <= n)) continue;
            ProviderRegistry r = new ProviderRegistry(bytes32(uint256(1)), _committee(n), k, "c", NOTICES);
            uint256 base = r.requiredSignatures(action);
            // Schedule a take-over at `from` (slot 6: pendingEpoch | pendingThreshold << 64 | pendingFrom << 72).
            vm.store(address(r), bytes32(uint256(6)), bytes32((uint256(from) << 72) | (uint256(2) << 64) | 1));
            uint256 t = block.timestamp;
            uint256 req = r.requiredSignatures(action);
            uint256 supermajority = uint256(k) + 1 > (2 * n + 2) / 3 ? uint256(k) + 1 : (2 * n + 2) / 3;
            if (t >= from) {
                assert(req >= supermajority);
                assert(req == (base > supermajority ? base : supermajority));
            } else {
                assert(req == base);
            }
            assert(req <= n);
        }
    }
}
