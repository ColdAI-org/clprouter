// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {QuarantineVault} from "@clprouter/QuarantineVault.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {AuditBase} from "./AuditBase.sol";

/// @notice Drives a registry and a vault with random signer sets, actions, rotations, deposits, releases,
///         namings, challenges and time jumps, and records every rule a successful call must have obeyed.
contract RegistryVaultHandler is AuditBase {
    ProviderRegistry public reg;
    QuarantineVault public vault;

    // 5 initial members + 3 outsiders; rotations draw from all 8.
    uint256[] internal pool;
    address[] public actors;
    bytes32[2] internal cases = [keccak256("case-a"), keccak256("case-b")];
    string[2] internal ledgers = ["hedera:mainnet", "eip155:1"];

    // ghosts
    uint256 public applied;
    uint64 public lastVersion;
    bool public versionWentBack;
    bool public quorumViolated;
    bool public releaseRuleViolated;
    bool public providerPaid;
    uint256 public sumUnreleased;
    uint256 public releasedCount;
    mapping(bytes32 => uint256) public logLen;
    mapping(bytes32 => bytes32) public logHead; // hash of entry 0, must never change
    bytes32[] internal certKeys;

    constructor(ProviderRegistry r, QuarantineVault v, uint256[] memory pks) {
        reg = r;
        vault = v;
        for (uint256 i = 0; i < pks.length; i++) {
            pool.push(pks[i]);
        }
        pool.push(0x0111);
        pool.push(0x0222);
        pool.push(0x0333);
        actors.push(address(0xA001));
        actors.push(address(0xA002));
        actors.push(address(0xA003));
        actors.push(vm.addr(pks[0])); // a provider account as a deposit party
        for (uint256 l = 0; l < 2; l++) {
            for (uint8 lab = 1; lab <= 3; lab++) {
                certKeys.push(Caip.certKey(ledgers[l], lab));
            }
        }
    }

    // ── registry ───────────────────────────────────────────────────────────

    function submit(uint8 actionSeed, uint8 signerMask, uint256 argSeed, bool badNonce) external {
        uint8 action = uint8(bound(actionSeed, 1, 11));
        if (action == 9 || action == 10) action = 8;
        bytes memory payload = _payload(action, argSeed);
        IProviderRegistry.Decision memory d = IProviderRegistry.Decision({
            action: action,
            payload: payload,
            evidenceHash: keccak256(abi.encode(argSeed)),
            nonce: reg.version() + (badNonce ? 2 : 1),
            effectiveAt: uint64(block.timestamp + (argSeed % 3) * 1 days),
            validUntil: uint64(block.timestamp + 1 days),
            epoch: reg.epoch()
        });
        (uint256[] memory chosen, uint256 nMembers) = _chosen(signerMask);
        bytes[] memory sigs = _signSorted(d, chosen);
        uint256 required = reg.requiredSignatures(action);
        uint256[] memory before = _snapLens();
        try reg.submit(d, sigs) {
            applied++;
            if (nMembers < required || nMembers != chosen.length || badNonce) quorumViolated = true;
        } catch {}
        _checkLogs(before);
        uint64 v = reg.version();
        if (v < lastVersion) versionWentBack = true;
        lastVersion = v;
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 20 days));
    }

    // ── vault ──────────────────────────────────────────────────────────────

    function deposit(uint96 amt, uint8 s, uint8 r, bool caseB) external {
        amt = uint96(bound(amt, 1, 100 ether));
        vm.deal(address(this), amt);
        vault.deposit{value: amt}(ROUTE, cases[caseB ? 1 : 0], actors[s % 4], actors[r % 4]);
        sumUnreleased += amt;
    }

    function nameRecovery(uint8 to, bool caseB, uint8 signerMask) external {
        address target = to % 5 == 4 ? address(0xBEEF) : actors[to % 4];
        IProviderRegistry.Decision memory d =
            _vaultDecision(reg, A_VAULT_NAME_RECOVERY, abi.encode(cases[caseB ? 1 : 0], target));
        (uint256[] memory chosen,) = _chosen(signerMask);
        try vault.nameRecovery(d, _signSorted(d, chosen)) {} catch {}
    }

    function challenge(uint256 idSeed, uint8 who) external {
        uint256 n = vault.depositCount();
        if (n == 0) return;
        vm.prank(actors[who % 4]);
        try vault.challengeRecovery(bound(idSeed, 1, n), bytes32(0)) {} catch {}
    }

    function release(uint256 idSeed, uint8 kind, bool wrongCase, uint8 signerMask) external {
        uint256 n = vault.depositCount();
        if (n == 0) return;
        uint256 id = bound(idSeed, 1, n);
        (,, , address s, address r, uint256 amt, bool rel) = vault.deposits(id);
        (bytes16 rid, bytes32 cid,,,,,) = vault.deposits(id);
        rid;
        bytes32 c = wrongCase ? keccak256("nope") : cid;
        IProviderRegistry.Decision memory d =
            _vaultDecision(reg, A_VAULT_RELEASE, abi.encode(id, c, uint8(kind % 3)));
        (uint256[] memory chosen, uint256 nMembers) = _chosen(signerMask);
        (address recTo,, uint64 relAt, bool challenged) = vault.recoveries(cid);
        address[] memory watch = new address[](3);
        watch[0] = s;
        watch[1] = r;
        watch[2] = recTo;
        uint256[3] memory bal = [s.balance, r.balance, recTo.balance];
        try vault.release(d, _signSorted(d, chosen)) {
            releasedCount++;
            sumUnreleased -= amt;
            if (rel || wrongCase || nMembers < reg.threshold() || nMembers != chosen.length) {
                releaseRuleViolated = true;
            }
            if (kind % 3 == 2 && (challenged || block.timestamp < relAt || recTo == address(0))) {
                releaseRuleViolated = true;
            }
            address paid = kind % 3 == 0 ? s : kind % 3 == 1 ? r : recTo;
            if (reg.isProviderAccount(paid)) providerPaid = true;
            uint256 idx = kind % 3;
            if (watch[idx].balance < bal[idx] + amt && watch[idx] != address(this)) releaseRuleViolated = true;
        } catch {}
    }

    // ── helpers ────────────────────────────────────────────────────────────

    function _chosen(uint8 mask) internal view returns (uint256[] memory chosen, uint256 nMembers) {
        uint256 cnt;
        for (uint256 i = 0; i < pool.length; i++) {
            if (mask & (1 << i) != 0) cnt++;
        }
        chosen = new uint256[](cnt);
        uint256 j;
        for (uint256 i = 0; i < pool.length; i++) {
            if (mask & (1 << i) != 0) {
                chosen[j++] = pool[i];
                if (reg.isMember(vm.addr(pool[i]))) nMembers++;
            }
        }
    }

    function _payload(uint8 action, uint256 seed) internal view returns (bytes memory) {
        string memory ledger = ledgers[seed % 2];
        uint8 label = uint8(1 + (seed >> 8) % 3);
        if (action == A_CERTIFY) {
            uint64 em = label == 3 ? uint64(1 + (seed >> 16) % 5000) : 0;
            return _certifyPayload(ledger, label, uint64(block.timestamp + 10 days + 30 days), em);
        }
        if (action == A_UNCERTIFY) return abi.encode(ledger, label);
        if (action == A_DISABLE) return _disablePayload(2, Caip.ledgerKey(ledger));
        if (action == A_ENABLE) return abi.encode(uint8(2), Caip.ledgerKey(ledger));
        if (action == A_BLACKLIST) return _blacklistPayload(ACCT, cases[seed % 2]);
        if (action == A_DELIST) return abi.encode(ACCT, cases[seed % 2]);
        if (action == A_COMMITTEE) {
            // 3..8 pool members, k = n - 1 or n - 2 (>= 1)
            uint256 m = (seed >> 24) | 0x7; // at least three set bits among the low ones
            uint256 cnt;
            for (uint256 i = 0; i < pool.length; i++) {
                if (m & (1 << i) != 0) cnt++;
            }
            uint256[] memory pk = new uint256[](cnt);
            uint256 j;
            for (uint256 i = 0; i < pool.length; i++) {
                if (m & (1 << i) != 0) pk[j++] = pool[i];
            }
            uint8 k = uint8(cnt - 1 - ((seed >> 40) % 2));
            return abi.encode(_sortedAddrs(pk), k == 0 ? uint8(1) : k);
        }
        if (action == 11) return abi.encode(keccak256("ch"), ledger, uint8(seed % 4));
        return abi.encode("mailto:x");
    }

    function _snapLens() internal view returns (uint256[] memory l) {
        l = new uint256[](certKeys.length);
        for (uint256 i = 0; i < certKeys.length; i++) {
            l[i] = reg.certificationLog(certKeys[i]).length;
        }
    }

    function _checkLogs(uint256[] memory before) internal {
        for (uint256 i = 0; i < certKeys.length; i++) {
            ProviderRegistry.Certification[] memory log = reg.certificationLog(certKeys[i]);
            if (log.length < before[i]) versionWentBack = true; // history shrank
            if (log.length > 0) {
                bytes32 h = keccak256(abi.encode(log[0]));
                if (logHead[certKeys[i]] == bytes32(0)) logHead[certKeys[i]] = h;
                else if (logHead[certKeys[i]] != h) versionWentBack = true; // history rewritten
                for (uint256 j = 1; j < log.length; j++) {
                    if (log[j].version <= log[j - 1].version || log[j].effectiveFrom < log[j - 1].effectiveFrom) {
                        versionWentBack = true;
                    }
                }
            }
            logLen[certKeys[i]] = log.length;
        }
    }

    function sumUnreleasedOnChain() external view returns (uint256 s) {
        for (uint256 i = 1; i <= vault.depositCount(); i++) {
            (,,,,, uint256 amt, bool rel) = vault.deposits(i);
            if (!rel) s += amt;
        }
    }

    receive() external payable {}
}

contract RegistryVaultInvariantTest is AuditBase {
    ProviderRegistry internal reg;
    QuarantineVault internal vault;
    RegistryVaultHandler internal h;

    function setUp() public {
        vm.warp(1_800_000_000);
        _initCommittee();
        reg = _deployRegistry();
        vault = _newVault(reg);
        h = new RegistryVaultHandler(reg, vault, memberPks);
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](6);
        sel[0] = h.submit.selector;
        sel[1] = h.warp.selector;
        sel[2] = h.deposit.selector;
        sel[3] = h.nameRecovery.selector;
        sel[4] = h.challenge.selector;
        sel[5] = h.release.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// Registry version == number of applied decisions, and never decreases.
    function invariant_versionCountsAppliedDecisions() public view {
        assertEq(reg.version(), h.applied());
        assertFalse(h.versionWentBack());
    }

    /// A decision only applies with >= required distinct current-epoch members, no outsiders, right nonce.
    function invariant_decisionsOnlyWithQuorum() public view {
        assertFalse(h.quorumViolated());
    }

    /// Vault balance equals the sum of unreleased deposits (no forced sends in this harness).
    function invariant_vaultBalanceConservation() public view {
        assertEq(address(vault).balance, h.sumUnreleased());
        assertEq(h.sumUnreleased(), h.sumUnreleasedOnChain());
    }

    /// Every release followed the rules and never paid a provider account.
    function invariant_releasesFollowRules() public view {
        assertFalse(h.releaseRuleViolated());
        assertFalse(h.providerPaid());
    }

    function afterInvariant() public {
        emit log_named_uint("applied decisions", h.applied());
        emit log_named_uint("vault releases", h.releasedCount());
        emit log_named_uint("rotations epoch", reg.epoch());
    }

    /// The committee always keeps k >= 1 and k + 1 <= n.
    function invariant_committeeShape() public view {
        uint256 n = reg.members().length;
        assertGe(reg.threshold(), 1);
        assertLe(uint256(reg.threshold()) + 1, n);
    }
}
