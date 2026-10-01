// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {QuarantineVault} from "@clprouter/QuarantineVault.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {AuditBase} from "./AuditBase.sol";

/// @notice Regression tests for the registry findings in docs/audit/registry-vault-findings.md.
///         Each `test_RV0x_*` used to demonstrate the issue and now asserts the fix (or, where named `residual`,
///         pins the documented residual risk). The `test_ok_*` tests pin properties that were checked and hold.
contract RegistryFindingsTest is AuditBase {
    ProviderRegistry internal reg; // "ledger A"
    ProviderRegistry internal regB; // "ledger B" of the same deployment (same committee, same constructor args)

    function setUp() public {
        vm.warp(1_800_000_000);
        _initCommittee();
        reg = _deployRegistry();
        regB = _deployRegistry();
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-01 (High, fixed): committee changes need a supermajority, respect floors and wait COMMITTEE_NOTICE
    // ═════════════════════════════════════════════════════════════════════

    function test_RV01_kSignaturesCannotRotate_supermajorityOnlySchedules() public {
        uint256[] memory atk = new uint256[](3);
        atk[0] = 0xBAD1;
        atk[1] = 0xBAD2;
        atk[2] = 0xBAD3;
        address[] memory atkAddrs = _sortedAddrs(atk);
        IProviderRegistry.Decision memory d = _decision(reg, A_COMMITTEE, abi.encode(atkAddrs, uint8(2)));
        // k compromised keys: rejected outright.
        bytes[] memory sigs_2 = _sign(address(reg), d, K);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K, K + 1));
        reg.submit(d, sigs_2);
        // Floors: a 2-member committee with k = 1 can never be installed, whoever signs.
        IProviderRegistry.Decision memory tiny =
            _decision(reg, A_COMMITTEE, abi.encode(_sortedAddrs(_firstTwo(atk)), uint8(1)));
        bytes[] memory sigs_3 = _sign(address(reg), tiny, 5);
        vm.expectRevert(ProviderRegistry.InvalidCommittee.selector);
        reg.submit(tiny, sigs_3);

        // Even a supermajority only schedules: nothing changes until the notice has passed, and the change is
        // visible on-chain the whole time.
        reg.submit(d, _sign(address(reg), d, K + 1));
        assertEq(reg.epoch(), 0);
        assertEq(reg.threshold(), K);
        (uint64 pe,,, uint64 at) = reg.pendingCommittee();
        assertEq(at, block.timestamp + COMMITTEE_NOTICE);
        IProviderRegistry.Decision memory bl = _decision(reg, A_BLACKLIST, _blacklistPayload(ACCT, CASE));
        bl.epoch = pe;
        bytes[] memory atkSigs = _signSorted(address(reg), bl, atk);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.CommitteeNotYetActive.selector, at));
        reg.submit(bl, atkSigs);
        // The outgoing supermajority can cancel during the notice (re-state the current committee).
        _apply(reg, A_COMMITTEE, abi.encode(memberAddrs, K));
        vm.warp(at);
        bl = _decision(reg, A_BLACKLIST, _blacklistPayload(ACCT, CASE));
        bl.epoch = pe;
        atkSigs = _signSorted(address(reg), bl, atk);
        vm.expectRevert(ProviderRegistry.WrongEpoch.selector);
        reg.submit(bl, atkSigs);
        assertTrue(reg.isMember(memberAddrs[3]));
    }

    function test_RV01_kSignaturesCannotNameRecovery_partiesCanBlock_overrideNeedsSupermajority() public {
        QuarantineVault vault = _newVault(reg);
        address victimSender = makeAddr("victim-sender");
        vm.deal(address(this), 5 ether);
        uint256 id = vault.deposit{value: 5 ether}(ROUTE, CASE, victimSender, address(0));

        address loot = makeAddr("attacker-fresh-eoa");
        IProviderRegistry.Decision memory n = _vaultDecision(reg, A_VAULT_NAME_RECOVERY, abi.encode(CASE, loot));
        bytes[] memory sigs_4 = _sign(address(vault), n, K);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K, K + 1));
        vault.nameRecovery(n, sigs_4);
        // With k + 1 keys the naming goes through, but the depositor's own party objects within the window...
        vault.nameRecovery(n, _sign(address(vault), n, K + 1));
        vm.prank(victimSender);
        vault.challengeRecovery(id, keccak256("not mine"));
        vm.warp(block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW);
        IProviderRegistry.Decision memory r =
            _vaultDecision(reg, A_VAULT_RELEASE, abi.encode(id, CASE, uint8(QuarantineVault.Beneficiary.RECOVERY)));
        bytes[] memory rs = _sign(address(vault), r, 5);
        vm.expectRevert(QuarantineVault.RecoveryNotReady.selector);
        vault.release(r, rs);
        // ...and only a supermajority override after a second window could still pay it.
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        IProviderRegistry.Decision memory o = _vaultDecision(
            reg, A_VAULT_RELEASE, abi.encode(id, CASE, uint8(QuarantineVault.Beneficiary.RECOVERY_OVER_CHALLENGE))
        );
        bytes[] memory sigs_5 = _sign(address(vault), o, K);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K, K + 1));
        vault.release(o, sigs_5);
        assertEq(loot.balance, 0);
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-02 (High, fixed): decisions form a hash chain; a position takes only the decision extending the head
    // ═════════════════════════════════════════════════════════════════════

    function test_RV02_sameNonceOnOtherHeadRejected_andForkIsVisibleInHead() public {
        uint64 exp = uint64(block.timestamp + CERT_NOTICE + 300 days);
        IProviderRegistry.Decision memory x = _decision(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, exp, 0));
        IProviderRegistry.Decision memory y = _decision(regB, A_CERTIFY, _certifyPayload("eip155:1", 1, exp, 0));
        bytes[] memory xs = _sign(address(reg), x, K);
        reg.submit(x, xs);
        regB.submit(y, _sign(address(regB), y, K)); // a quorum that equivocates can still split a ledger...
        assertEq(reg.version(), regB.version());
        assertTrue(reg.headAt(1) != regB.headAt(1), "...but version 1 no longer hides it: the heads differ");

        // Nothing mixes the two histories: x cannot be replayed at B's next position, and A's next decision
        // (signed over A's head) is rejected on B.
        x.nonce = 2;
        bytes[] memory sigs_6 = _sign(address(reg), x, K);
        vm.expectRevert(ProviderRegistry.BadSignature.selector);
        regB.submit(x, sigs_6);
        IProviderRegistry.Decision memory next = _decision(reg, A_CONTACT, abi.encode("next"));
        bytes[] memory ns = _sign(address(reg), next, K);
        reg.submit(next, ns);
        vm.expectRevert(ProviderRegistry.BadSignature.selector);
        regB.submit(next, ns);
    }

    function test_RV02_removedKeysCannotRaceRotation_rotationAppliesOnLaggingLedger() public {
        uint256[] memory fresh = new uint256[](3);
        fresh[0] = 0xF1;
        fresh[1] = 0xF2;
        fresh[2] = 0xF3;
        IProviderRegistry.Decision memory rot =
            _decision(reg, A_COMMITTEE, abi.encode(_sortedAddrs(fresh), uint8(2)));
        bytes[] memory rotSigs = _sign(address(reg), rot, K + 1);
        reg.submit(rot, rotSigs);

        // The k leaked keys cannot land a competing rotation on the lagging ledger B...
        uint256[] memory atk = new uint256[](3);
        atk[0] = 0xBAD1;
        atk[1] = 0xBAD2;
        atk[2] = 0xBAD3;
        IProviderRegistry.Decision memory evil = _decision(regB, A_COMMITTEE, abi.encode(_sortedAddrs(atk), uint8(2)));
        assertEq(evil.nonce, rot.nonce);
        bytes[] memory sigs_7 = _sign(address(regB), evil, K);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K, K + 1));
        regB.submit(evil, sigs_7);

        // ...so the legitimate rotation still applies there, with the same head as on A.
        regB.submit(rot, rotSigs);
        assertEq(regB.headAt(1), reg.headAt(1));
        (uint64 pe,,,) = regB.pendingCommittee();
        assertTrue(regB.isMemberOf(pe, vm.addr(0xF1)));
        assertFalse(regB.isMemberOf(pe, vm.addr(0xBAD1)));
    }

    /// Residual risk (documented): k leaked keys can still fill a lagging ledger's next position with a k action
    /// first. The fork is visible (heads differ) and the lagging ledger then refuses the canonical chain.
    function test_RV02_residual_kKeysForkLaggingLedgerWithKAction_detectable() public {
        IProviderRegistry.Decision memory canon = _decision(reg, A_CONTACT, abi.encode("canonical"));
        bytes[] memory cs = _sign(address(reg), canon, K);
        reg.submit(canon, cs);
        IProviderRegistry.Decision memory evil = _decision(regB, A_CONTACT, abi.encode("evil"));
        regB.submit(evil, _sign(address(regB), evil, K));
        assertTrue(reg.headAt(1) != regB.headAt(1));
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.OutOfOrder.selector, uint64(2), uint64(1)));
        regB.submit(canon, cs);
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-03 (Medium, fixed): late relay never reverts; effectiveAt is bounded
    // ═════════════════════════════════════════════════════════════════════

    function test_RV03_lateRelayApplies_ledgerKeepsGoing() public {
        IProviderRegistry.Decision memory d =
            _decision(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, uint64(block.timestamp + CERT_NOTICE + 1 days), 0));
        d.validUntil = uint64(block.timestamp + 2 days);
        bytes[] memory sigs = _sign(address(reg), d, K);
        reg.submit(d, sigs);

        vm.warp(block.timestamp + 30 days); // ledger B is a month late, past validUntil
        regB.submit(d, sigs); // applies (as a certification that never holds there: it is expired on arrival)
        assertEq(regB.headAt(1), reg.headAt(1));
        (bool ok,) = regB.certificationAt(Caip.certKey(HEDERA, 1), 1);
        assertFalse(ok);

        IProviderRegistry.Decision memory dis = _decision(reg, A_DISABLE, _disablePayload(2, Caip.ledgerKey(HEDERA)));
        bytes[] memory disSigs = _sign(address(reg), dis, K + 1);
        reg.submit(dis, disSigs);
        regB.submit(dis, disSigs);
        assertTrue(regB.isDisabled(Caip.ledgerKey(HEDERA)));
    }

    function test_RV03_effectiveAtNearMaxRejected_keyStaysUsable() public {
        IProviderRegistry.Decision memory u = _decision(reg, A_UNCERTIFY, abi.encode(HEDERA, uint8(1)));
        u.effectiveAt = type(uint64).max - 1 days;
        bytes[] memory sigs_8 = _sign(address(reg), u, K);
        vm.expectRevert(ProviderRegistry.EffectiveTooFar.selector);
        reg.submit(u, sigs_8);
        // The furthest allowed uncertify does not hold back a later certify (newest decision in effect wins).
        u.effectiveAt = uint64(block.timestamp + reg.MAX_NOTICE());
        reg.submit(u, _sign(address(reg), u, K));
        _apply(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, uint64(block.timestamp + CERT_NOTICE + 30 days), 0));
        vm.warp(block.timestamp + CERT_NOTICE);
        (bool ok,) = reg.certificationAt(Caip.certKey(HEDERA, 1), reg.version());
        assertTrue(ok);
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-04 (Medium, fixed): decisions bind to the deployment id
    // ═════════════════════════════════════════════════════════════════════

    function test_RV04_decisionDoesNotReplayOntoOtherDeployment() public {
        ProviderRegistry staging = _deployRegistry(keccak256("staging"));
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("mailto:prod@example"));
        bytes[] memory sigs = _sign(address(reg), d, K);
        reg.submit(d, sigs);
        regB.submit(d, sigs); // another ledger of the same deployment: intended
        vm.expectRevert(ProviderRegistry.BadSignature.selector);
        staging.submit(d, sigs); // same committee, other deployment: rejected
        assertEq(staging.contact(), CONTACT);
        assertTrue(staging.decisionDigest(d) != reg.decisionDigest(d));
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-05 (Low, fixed): DELIST needs k + 1, like BLACKLIST
    // ═════════════════════════════════════════════════════════════════════

    function test_RV05_kMembersCannotUndoKPlusOneBlacklist() public {
        _apply(reg, A_BLACKLIST, _blacklistPayload(ACCT, CASE));
        IProviderRegistry.Decision memory d = _decision(reg, A_DELIST, abi.encode(ACCT, CASE));
        bytes[] memory sigs_9 = _sign(address(reg), d, K);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K, K + 1));
        reg.submit(d, sigs_9);
        (bool listed,) = reg.blacklisted(Caip.accountKey(ACCT));
        assertTrue(listed);
        reg.submit(d, _sign(address(reg), d, K + 1));
        (listed,) = reg.blacklisted(Caip.accountKey(ACCT));
        assertFalse(listed);
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-06 (Low, fixed): scheduling horizon capped; a removal is never queued behind a later-dated certify
    // ═════════════════════════════════════════════════════════════════════

    function test_RV06_farFutureCertifyCannotBlockRemoval() public {
        uint64 t0 = uint64(block.timestamp);
        _apply(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, t0 + CERT_NOTICE + 360 days, 0));
        IProviderRegistry.Decision memory c2 =
            _decision(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, t0 + 300 days + 300 days, 0));
        c2.effectiveAt = t0 + 300 days;
        bytes[] memory sigs_10 = _sign(address(reg), c2, K);
        vm.expectRevert(ProviderRegistry.EffectiveTooFar.selector);
        reg.submit(c2, sigs_10);
        c2.effectiveAt = t0 + reg.MAX_NOTICE(); // the furthest allowed
        reg.submit(c2, _sign(address(reg), c2, K));
        _apply(reg, A_UNCERTIFY, abi.encode(HEDERA, uint8(1))); // urgent removal
        vm.warp(t0 + CERT_NOTICE + REMOVAL_NOTICE);
        (bool ok,) = reg.certificationAt(Caip.certKey(HEDERA, 1), reg.version());
        assertFalse(ok, "removal effective after REMOVAL_NOTICE");
        vm.warp(t0 + reg.MAX_NOTICE() + 1);
        (ok,) = reg.certificationAt(Caip.certKey(HEDERA, 1), reg.version());
        assertFalse(ok, "the superseded future certification never comes back");
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-07 (Info, fixed): notice periods, lapses and vault windows have floors
    // ═════════════════════════════════════════════════════════════════════

    function test_RV07_zeroNoticesRejected() public {
        uint64[6] memory zero;
        vm.expectRevert(ProviderRegistry.InvalidParameters.selector);
        new ProviderRegistry(DEPLOYMENT_ID, memberAddrs, K, CONTACT, zero);
        vm.expectRevert(QuarantineVault.InvalidParameters.selector);
        new QuarantineVault(IProviderRegistry(address(reg)), 0, 0);
        assertGe(reg.DISABLE_LAPSE(), reg.MIN_LAPSE());
        assertGe(reg.COMMITTEE_NOTICE(), reg.MIN_COMMITTEE_NOTICE());
    }

    function _firstTwo(uint256[] memory a) internal pure returns (uint256[] memory b) {
        b = new uint256[](2);
        b[0] = a[0];
        b[1] = a[1];
    }

    // ═════════════════════════════════════════════════════════════════════
    // Properties that hold
    // ═════════════════════════════════════════════════════════════════════

    function test_ok_highSMalleatedSignatureRejected() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("x"));
        bytes[] memory sigs = _sign(address(reg), d, K);
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
        bytes[] memory sigs = _sign(address(reg), d, K);
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
        bytes[] memory sigs = _sign(address(reg), d, K);
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
        uint256[] memory keep = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) {
            keep[i] = memberPks[i + 1];
        }
        _rotate(reg, keep, 3);
        assertFalse(reg.isMember(memberAddrs[0]));
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("x"));
        bytes[] memory sigs_11 = _sign(address(reg), d, K);
        vm.expectRevert(ProviderRegistry.BadSignature.selector);
        reg.submit(d, sigs_11); // member 0's signature is first
        // An old-epoch decision fails even with the new members' signatures on it.
        d.epoch = 0;
        bytes[] memory sigs_12 = _sign(address(reg), d, K);
        vm.expectRevert(ProviderRegistry.WrongEpoch.selector);
        reg.submit(d, sigs_12);
        // Still a provider account forever (vault never pays it).
        assertTrue(reg.isProviderAccount(memberAddrs[0]));
    }

    function test_ok_vaultActionsNeverAcceptedByRegistry() public {
        for (uint8 a = 9; a <= 10; a++) {
            IProviderRegistry.Decision memory d = _decision(reg, a, abi.encode(uint256(1)));
            bytes[] memory sigs_13 = _sign(address(reg), d, K);
            vm.expectRevert(ProviderRegistry.UnsupportedAction.selector);
            reg.submit(d, sigs_13);
        }
        IProviderRegistry.Decision memory d2 = _decision(reg, 12, "");
        bytes[] memory sigs_14 = _sign(address(reg), d2, K);
        vm.expectRevert(ProviderRegistry.UnsupportedAction.selector);
        reg.submit(d2, sigs_14);
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
        bytes[] memory sigs_15 = _sign(address(reg), d, K);
        vm.expectRevert(ProviderRegistry.InvalidTier.selector);
        reg.submit(d, sigs_15);
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
        bytes[] memory sigs = _signSorted(address(reg), d, chosen);
        bool shouldPass = members_ == cnt && members_ >= reg.requiredSignatures(action);
        if (shouldPass) {
            reg.submit(d, sigs);
            assertEq(reg.version(), 1);
        } else {
            vm.expectRevert();
            reg.submit(d, sigs);
        }
    }

    /// Nonce must be exactly version + 1 (and extend the head); validUntil is signed but not enforced for ordered
    /// decisions (RV-03), so a decision applies exactly once whenever it is relayed.
    function testFuzz_nonceOrderingAndExpiry(uint64 nonce, uint64 validUntil) public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("x"));
        d.nonce = nonce;
        d.validUntil = validUntil;
        bytes[] memory sigs = _sign(address(reg), d, K);
        if (nonce != 1) {
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
