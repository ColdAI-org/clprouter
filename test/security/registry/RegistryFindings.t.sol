// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {QuarantineVault} from "@clprouter/QuarantineVault.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {AuditBase} from "./AuditBase.sol";

/// @notice Demonstrations of the registry findings in docs/audit/registry-vault-findings.md.
///         Each `test_RV0x_*` passes while the issue is present; once fixed, flip it to expect the revert.
///         The `test_ok_*` tests pin properties that were checked and hold.
contract RegistryFindingsTest is AuditBase {
    ProviderRegistry internal reg; // "ledger A"
    ProviderRegistry internal regB; // "ledger B" (same committee, same constructor args)

    function setUp() public {
        vm.warp(1_800_000_000);
        _initCommittee();
        reg = _deployRegistry();
        regB = _deployRegistry();
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-01 (High): k signatures rotate the committee immediately -> k+1 rules and every bound collapse
    // ═════════════════════════════════════════════════════════════════════

    function test_RV01_kSignaturesCaptureCommittee_thenBlacklistWithoutKPlusOne() public {
        // k = 3 of 5 compromised keys sign a rotation to a 2-member committee with threshold 1 they control.
        uint256[] memory atk = new uint256[](2);
        atk[0] = 0xBAD1;
        atk[1] = 0xBAD2;
        address[] memory atkAddrs = _sortedAddrs(atk);
        IProviderRegistry.Decision memory d = _decision(reg, A_COMMITTEE, abi.encode(atkAddrs, uint8(1)));
        reg.submit(d, _sign(d, K)); // only k, no notice, effective in the same tx
        assertEq(reg.threshold(), 1);

        // Now two attacker keys (none of them an original member) satisfy "k+1" for a blacklist and a disable
        // of the whole ledger, immediately.
        uint256[] memory one = atk;
        IProviderRegistry.Decision memory bl = _decision(reg, A_BLACKLIST, _blacklistPayload(ACCT, CASE));
        reg.submit(bl, _signSorted(bl, one));
        IProviderRegistry.Decision memory dis =
            _decision(reg, A_DISABLE, _disablePayload(2, Caip.ledgerKey(HEDERA)));
        reg.submit(dis, _signSorted(dis, one));
        (bool listed,) = reg.blacklisted(Caip.accountKey(ACCT));
        assertTrue(listed);
        assertTrue(reg.isDisabled(Caip.ledgerKey(HEDERA)));
        // The honest remaining members (2 of the old 5) can no longer sign anything.
        assertFalse(reg.isMember(memberAddrs[3]));
    }

    function test_RV01_kSignaturesCaptureCommittee_thenDrainVaultViaFreshRecoveryAddress() public {
        QuarantineVault vault = _newVault(reg);
        address victimSender = makeAddr("victim-sender");
        vm.deal(address(this), 5 ether);
        uint256 id = vault.deposit{value: 5 ether}(ROUTE, CASE, victimSender, address(0));

        // Compromised k name a fresh EOA they control (not a committee member, so not a "provider account").
        address loot = makeAddr("attacker-fresh-eoa");
        IProviderRegistry.Decision memory n =
            _vaultDecision(reg, A_VAULT_NAME_RECOVERY, abi.encode(CASE, loot));
        vault.nameRecovery(n, _sign(n, K));
        vm.warp(block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW);
        IProviderRegistry.Decision memory r =
            _vaultDecision(reg, A_VAULT_RELEASE, abi.encode(id, CASE, uint8(QuarantineVault.Beneficiary.RECOVERY)));
        vault.release(r, _sign(r, K));
        assertEq(loot.balance, 5 ether, "unchallenged recovery pays an arbitrary non-member address");
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-02 (High): same nonce, different decisions -> ledgers diverge; old keys race a rotation
    // ═════════════════════════════════════════════════════════════════════

    function test_RV02_nonceEquivocation_sameVersionDifferentStateAcrossLedgers() public {
        uint64 exp = uint64(block.timestamp + CERT_NOTICE + 300 days);
        IProviderRegistry.Decision memory x = _decision(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, exp, 0));
        IProviderRegistry.Decision memory y = _decision(regB, A_CERTIFY, _certifyPayload("eip155:1", 1, exp, 0));
        assertEq(x.nonce, y.nonce);
        // A relayer (or the committee, re-signing "a replacement") lands x on A and y on B.
        reg.submit(x, _sign(x, K));
        regB.submit(y, _sign(y, K));
        assertEq(reg.version(), regB.version(), "both ledgers report version 1");
        vm.warp(block.timestamp + CERT_NOTICE);
        (bool aHedera,) = reg.certificationAt(Caip.certKey(HEDERA, 1), 1);
        (bool bHedera,) = regB.certificationAt(Caip.certKey(HEDERA, 1), 1);
        assertTrue(aHedera);
        assertFalse(bHedera, "version 1 names different registry states on A and B");
    }

    function test_RV02_removedKeysRaceRotationOnLaggingLedger() public {
        // Rotation away from leaked keys (members 0..2) is signed and relayed to ledger A.
        uint256[] memory fresh = new uint256[](3);
        fresh[0] = 0xF1;
        fresh[1] = 0xF2;
        fresh[2] = 0xF3;
        IProviderRegistry.Decision memory rot = _decision(reg, A_COMMITTEE, abi.encode(_sortedAddrs(fresh), uint8(2)));
        bytes[] memory rotSigs = _sign(rot, K);
        reg.submit(rot, rotSigs);

        // Before anyone relays it to ledger B, the leaked keys sign a competing epoch-0 decision with the
        // same nonce and land it on B first.
        uint256[] memory atk = new uint256[](2);
        atk[0] = 0xBAD1;
        atk[1] = 0xBAD2;
        IProviderRegistry.Decision memory evil =
            _decision(regB, A_COMMITTEE, abi.encode(_sortedAddrs(atk), uint8(1)));
        assertEq(evil.nonce, rot.nonce);
        regB.submit(evil, _sign(evil, K));

        // The legitimate rotation can never apply on B any more.
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.OutOfOrder.selector, uint64(2), uint64(1)));
        regB.submit(rot, rotSigs);
        assertTrue(regB.isMember(vm.addr(0xBAD1)));
        assertFalse(regB.isMember(vm.addr(0xF1)));
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-03 (Medium): a decision that applies on one ledger can revert on another -> that ledger halts
    // ═════════════════════════════════════════════════════════════════════

    function test_RV03_certifyRevertsWhenRelayedLate_ledgerHaltsForever() public {
        // Committee picks expiry = now + CERT_NOTICE + 1 day, valid for relay for 2 days.
        IProviderRegistry.Decision memory d =
            _decision(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, uint64(block.timestamp + CERT_NOTICE + 1 days), 0));
        d.validUntil = uint64(block.timestamp + 2 days);
        bytes[] memory sigs = _sign(d, K);
        reg.submit(d, sigs); // ledger A: fine

        vm.warp(block.timestamp + 1 days + 1); // ledger B relay is a day late, still inside validUntil
        vm.expectRevert(ProviderRegistry.InvalidExpiry.selector);
        regB.submit(d, sigs);

        // Nothing after nonce 1 can ever apply on B (e.g. an urgent k+1 disable).
        IProviderRegistry.Decision memory dis = _decision(reg, A_DISABLE, _disablePayload(2, Caip.ledgerKey(HEDERA)));
        bytes[] memory disSigs = _sign(dis, K + 1);
        reg.submit(dis, disSigs);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.OutOfOrder.selector, uint64(1), uint64(2)));
        regB.submit(dis, disSigs);
        assertFalse(regB.isDisabled(Caip.ledgerKey(HEDERA)));
    }

    function test_RV03_effectiveAtNearMaxBricksCertKey() public {
        // An UNCERTIFY with a huge effectiveAt is accepted (no bound)...
        IProviderRegistry.Decision memory u = _decision(reg, A_UNCERTIFY, abi.encode(HEDERA, uint8(1)));
        u.effectiveAt = type(uint64).max - 1 days;
        reg.submit(u, _sign(u, K));
        // ...and every later CERTIFY of that key is clamped past it: `expiry <= effectiveFrom` or
        // `effectiveFrom + MAX_CERT_DURATION` overflows, so the key can never be certified again and any
        // CERTIFY decision for it halts the sequence until nonce 2 is re-signed (RV-02).
        IProviderRegistry.Decision memory c = _decision(
            reg, A_CERTIFY, _certifyPayload(HEDERA, 1, uint64(block.timestamp + CERT_NOTICE + 30 days), 0)
        );
        vm.expectRevert(); // InvalidExpiry, or a checked-arithmetic panic for a larger expiry
        reg.submit(c, _sign(c, K));
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-04 (Medium): digest binds no deployment -> replay across registries / vaults
    // ═════════════════════════════════════════════════════════════════════

    function test_RV04_decisionReplaysOntoUnrelatedRegistryWithSameCommittee() public {
        // e.g. a staging registry and a production registry run by the same provider keys.
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("mailto:staging@example"));
        bytes[] memory sigs = _sign(d, K);
        reg.submit(d, sigs);
        regB.submit(d, sigs); // replayed verbatim, no chain id / address / registry id in the digest
        assertEq(regB.contact(), "mailto:staging@example");
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-05 (Low): DELIST (k, immediate) undoes a BLACKLIST that needed k + 1
    // ═════════════════════════════════════════════════════════════════════

    function test_RV05_kMembersImmediatelyUndoKPlusOneBlacklist() public {
        _apply(reg, A_BLACKLIST, _blacklistPayload(ACCT, CASE));
        IProviderRegistry.Decision memory d = _decision(reg, A_DELIST, abi.encode(ACCT, CASE));
        reg.submit(d, _sign(d, K));
        (bool listed,) = reg.blacklisted(Caip.accountKey(ACCT));
        assertFalse(listed, "k members lift a k+1 freeze in the same block");
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-06 (Low): a far-future CERTIFY delays every later UNCERTIFY of that key
    // ═════════════════════════════════════════════════════════════════════

    function test_RV06_farFutureCertifyBlocksTimelyRemoval() public {
        uint64 t0 = uint64(block.timestamp);
        _apply(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, t0 + CERT_NOTICE + 360 days, 0));
        IProviderRegistry.Decision memory c2 =
            _decision(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, t0 + 300 days + 300 days, 0));
        c2.effectiveAt = t0 + 300 days;
        reg.submit(c2, _sign(c2, K));
        _apply(reg, A_UNCERTIFY, abi.encode(HEDERA, uint8(1))); // urgent removal
        vm.warp(t0 + CERT_NOTICE + REMOVAL_NOTICE + 30 days);
        (bool ok,) = reg.certificationAt(Caip.certKey(HEDERA, 1), reg.version());
        assertTrue(ok, "removal is clamped to the far-future entry (300 days), not REMOVAL_NOTICE");
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-07 (Info): notice periods are not validated (zero = no notice at all)
    // ═════════════════════════════════════════════════════════════════════

    function test_RV07_zeroNoticesAccepted() public {
        uint64[5] memory zero;
        ProviderRegistry r = new ProviderRegistry(memberAddrs, K, CONTACT, zero);
        QuarantineVault v = new QuarantineVault(IProviderRegistry(address(r)), 0, 0);
        assertEq(r.CERT_NOTICE(), 0);
        assertEq(r.DISABLE_LAPSE(), 0); // a disable lapses in the block it applies: it never takes effect
        assertEq(v.CHALLENGE_WINDOW(), 0);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Properties that hold
    // ═════════════════════════════════════════════════════════════════════

    function test_ok_highSMalleatedSignatureRejected() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("x"));
        bytes[] memory sigs = _sign(d, K);
        bytes memory s0 = sigs[0];
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(s0, 0x20))
            s := mload(add(s0, 0x40))
            v := byte(0, mload(add(s0, 0x60)))
        }
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        sigs[0] = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(ProviderRegistry.BadSignature.selector);
        reg.submit(d, sigs);
    }

    function test_ok_compactAndBadVRejected() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("x"));
        bytes[] memory sigs = _sign(d, K);
        bytes memory s0 = sigs[0];
        bytes32 r;
        bytes32 s;
        assembly {
            r := mload(add(s0, 0x20))
            s := mload(add(s0, 0x40))
        }
        sigs[0] = abi.encodePacked(r, s); // 64-byte compact form
        vm.expectRevert(ProviderRegistry.BadSignature.selector);
        reg.submit(d, sigs);
        sigs[0] = abi.encodePacked(r, s, uint8(29));
        vm.expectRevert(ProviderRegistry.BadSignature.selector);
        reg.submit(d, sigs);
    }

    function test_ok_duplicateAndUnsortedSignersRejected() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("x"));
        bytes[] memory sigs = _sign(d, K);
        bytes[] memory dup = new bytes[](K);
        dup[0] = sigs[0];
        dup[1] = sigs[0];
        dup[2] = sigs[1];
        vm.expectRevert(ProviderRegistry.SignersNotSorted.selector);
        reg.submit(d, dup);
        (sigs[0], sigs[1]) = (sigs[1], sigs[0]);
        vm.expectRevert(ProviderRegistry.SignersNotSorted.selector);
        reg.submit(d, sigs);
    }

    function test_ok_removedMemberCannotSignAfterRotation() public {
        // Rotate out member 0 (keep 1..4, k = 3).
        address[] memory keep = new address[](4);
        for (uint256 i = 0; i < 4; i++) {
            keep[i] = memberAddrs[i + 1];
        }
        _apply(reg, A_COMMITTEE, abi.encode(keep, uint8(3)));
        assertFalse(reg.isMember(memberAddrs[0]));
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("x"));
        vm.expectRevert(ProviderRegistry.BadSignature.selector);
        reg.submit(d, _sign(d, K)); // member 0's signature is first
        // An old-epoch decision fails even with the new members' signatures on it.
        d.epoch = 0;
        vm.expectRevert(ProviderRegistry.WrongEpoch.selector);
        reg.submit(d, _sign(d, K));
        // Still a provider account forever (vault never pays it).
        assertTrue(reg.isProviderAccount(memberAddrs[0]));
    }

    function test_ok_vaultActionsNeverAcceptedByRegistry() public {
        for (uint8 a = 9; a <= 10; a++) {
            IProviderRegistry.Decision memory d = _decision(reg, a, abi.encode(uint256(1)));
            vm.expectRevert(ProviderRegistry.UnsupportedAction.selector);
            reg.submit(d, _sign(d, K));
        }
        IProviderRegistry.Decision memory d2 = _decision(reg, 12, "");
        vm.expectRevert(ProviderRegistry.UnsupportedAction.selector);
        reg.submit(d2, _sign(d2, K));
    }

    function test_ok_trustTierRaiseWaitsCertNotice_lowerWaitsRemovalNotice() public {
        bytes32 ch = keccak256("ch");
        bytes32 ek = Caip.edgeKey(ch, HEDERA);
        _apply(reg, 11, abi.encode(ch, HEDERA, uint8(3)));
        vm.warp(block.timestamp + CERT_NOTICE - 1);
        (bool l,) = reg.trustTier(ek);
        assertFalse(l);
        vm.warp(block.timestamp + 1);
        (, uint8 t) = reg.trustTier(ek);
        assertEq(t, 3);
        _apply(reg, 11, abi.encode(ch, HEDERA, uint8(0)));
        vm.warp(block.timestamp + REMOVAL_NOTICE - 1);
        (, t) = reg.trustTier(ek);
        assertEq(t, 3);
        vm.warp(block.timestamp + 1);
        (, t) = reg.trustTier(ek);
        assertEq(t, 0);
        // Bad tier rejected.
        IProviderRegistry.Decision memory d = _decision(reg, 11, abi.encode(ch, HEDERA, uint8(4)));
        vm.expectRevert(ProviderRegistry.InvalidTier.selector);
        reg.submit(d, _sign(d, K));
    }

    function test_ok_energyStoredInMicrograms_otherLabelsZeroed() public {
        uint64 exp = uint64(block.timestamp + CERT_NOTICE + 300 days);
        _apply(reg, A_CERTIFY, _certifyPayload(HEDERA, 3, exp, 2400));
        _apply(reg, A_CERTIFY, _certifyPayload(HEDERA, 2, exp, 999)); // MiCA: emissions dropped
        vm.warp(block.timestamp + CERT_NOTICE);
        (bool ok, uint64 em) = reg.certificationAt(Caip.certKey(HEDERA, 3), reg.version());
        assertTrue(ok);
        assertEq(em, 2400);
        (ok, em) = reg.certificationAt(Caip.certKey(HEDERA, 2), reg.version());
        assertTrue(ok);
        assertEq(em, 0);
        // A pinned version below the entry ignores it; a version above this registry fails closed.
        (ok,) = reg.certificationAt(Caip.certKey(HEDERA, 3), 0);
        assertFalse(ok);
        (ok,) = reg.certificationAt(Caip.certKey(HEDERA, 3), reg.version() + 1);
        assertFalse(ok);
    }

    // ── fuzz ──────────────────────────────────────────────────────────────

    /// Any set of signers that contains a non-member, or fewer than the required members, is rejected.
    function testFuzz_quorumNeedsEnoughDistinctMembers(uint8 mask, uint8 action, uint64 outsiderSeed) public {
        action = uint8(bound(action, 1, 8));
        if (action == A_COMMITTEE) action = A_CONTACT; // keep payload simple
        uint256[] memory pool = new uint256[](6);
        for (uint256 i = 0; i < 5; i++) {
            pool[i] = memberPks[i];
        }
        pool[5] = uint256(keccak256(abi.encode(outsiderSeed))) % 1e30 + 1;
        uint256 cnt;
        for (uint256 i = 0; i < 6; i++) {
            if (mask & (1 << i) != 0) cnt++;
        }
        uint256[] memory chosen = new uint256[](cnt);
        uint256 j;
        uint256 members_;
        for (uint256 i = 0; i < 6; i++) {
            if (mask & (1 << i) != 0) {
                chosen[j++] = pool[i];
                if (i < 5) members_++;
            }
        }
        bytes memory payload = _payloadFor(action);
        IProviderRegistry.Decision memory d = _decision(reg, action, payload);
        bytes[] memory sigs = _signSorted(d, chosen);
        bool shouldPass = members_ == cnt && members_ >= reg.requiredSignatures(action);
        if (shouldPass) {
            reg.submit(d, sigs);
            assertEq(reg.version(), 1);
        } else {
            vm.expectRevert();
            reg.submit(d, sigs);
        }
    }

    /// Nonce must be exactly version + 1; validUntil and evidence enforced.
    function testFuzz_nonceOrderingAndExpiry(uint64 nonce, uint64 validUntil) public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("x"));
        d.nonce = nonce;
        d.validUntil = validUntil;
        bytes[] memory sigs = _sign(d, K);
        if (validUntil < block.timestamp || nonce != 1) {
            vm.expectRevert();
            reg.submit(d, sigs);
        } else {
            reg.submit(d, sigs);
            vm.expectRevert(); // never twice
            reg.submit(d, sigs);
        }
    }

    function _payloadFor(uint8 action) internal view returns (bytes memory) {
        if (action == A_CERTIFY) return _certifyPayload(HEDERA, 1, uint64(block.timestamp + CERT_NOTICE + 1 days), 0);
        if (action == A_UNCERTIFY) return abi.encode(HEDERA, uint8(1));
        if (action == A_DISABLE) return _disablePayload(1, keccak256("edge"));
        if (action == A_ENABLE) return abi.encode(uint8(1), keccak256("edge"));
        if (action == A_BLACKLIST) return _blacklistPayload(ACCT, CASE);
        if (action == A_DELIST) return abi.encode(ACCT, CASE);
        return abi.encode("mailto:x");
    }
}
