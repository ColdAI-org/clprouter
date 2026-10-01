// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {Committee} from "../helpers/Committee.sol";

contract ProviderRegistryTest is Committee {
    ProviderRegistry internal reg;
    string internal constant HEDERA = "hedera:mainnet";
    string internal constant ACCT = "eip155:1:0x00000000000000000000000000000000000000ee";
    bytes32 internal constant CASE = keccak256("case-1");

    function setUp() public {
        vm.warp(1_800_000_000);
        _initCommittee();
        reg = _deployRegistry();
    }

    function _expiry() internal view returns (uint64) {
        return uint64(block.timestamp + CERT_NOTICE + 300 days);
    }

    function _certified(string memory ledger, uint8 label) internal view returns (bool ok, uint64 em) {
        return reg.certificationAt(Caip.certKey(ledger, label), reg.version());
    }

    // ═════════════════════════════════════════════════════════════════════
    // Signatures
    // ═════════════════════════════════════════════════════════════════════

    function _notices() internal pure returns (uint64[6] memory) {
        return [CERT_NOTICE, REMOVAL_NOTICE, REENABLE_NOTICE, DISABLE_LAPSE, BLACKLIST_LAPSE, COMMITTEE_NOTICE];
    }

    function test_constructor_rejectsBadCommittee() public {
        address[] memory three = new address[](3);
        three[0] = address(1);
        three[1] = address(2);
        three[2] = address(3);
        uint64[6] memory n = _notices();
        vm.expectRevert(ProviderRegistry.InvalidCommittee.selector);
        new ProviderRegistry(DEPLOYMENT_ID, three, 3, CONTACT, n); // k + 1 > n
        vm.expectRevert(ProviderRegistry.InvalidCommittee.selector);
        new ProviderRegistry(DEPLOYMENT_ID, three, 1, CONTACT, n); // k < 2
        address[] memory two = new address[](2);
        two[0] = address(1);
        two[1] = address(2);
        vm.expectRevert(ProviderRegistry.InvalidCommittee.selector);
        new ProviderRegistry(DEPLOYMENT_ID, two, 1, CONTACT, n); // n < 3
        address[] memory four = new address[](4);
        for (uint256 i = 0; i < 4; i++) {
            four[i] = address(uint160(i + 1));
        }
        vm.expectRevert(ProviderRegistry.InvalidCommittee.selector);
        new ProviderRegistry(DEPLOYMENT_ID, four, 2, CONTACT, n); // k must be a strict majority
        three[2] = address(2);
        vm.expectRevert(ProviderRegistry.InvalidCommittee.selector);
        new ProviderRegistry(DEPLOYMENT_ID, three, 2, CONTACT, n); // not strictly ascending
        new ProviderRegistry(DEPLOYMENT_ID, four, 3, CONTACT, n); // smallest valid shapes
        three[2] = address(3);
        new ProviderRegistry(DEPLOYMENT_ID, three, 2, CONTACT, n);
    }

    function test_constructor_rejectsBadParameters() public {
        uint64[6] memory n = _notices();
        vm.expectRevert(ProviderRegistry.InvalidParameters.selector);
        new ProviderRegistry(bytes32(0), memberAddrs, K, CONTACT, n); // no deployment id
        for (uint256 i = 0; i < 6; i++) {
            uint64[6] memory z = _notices();
            z[i] = 0;
            vm.expectRevert(ProviderRegistry.InvalidParameters.selector);
            new ProviderRegistry(DEPLOYMENT_ID, memberAddrs, K, CONTACT, z);
        }
        n[1] = CERT_NOTICE + 1; // removal notice longer than the certification notice
        vm.expectRevert(ProviderRegistry.InvalidParameters.selector);
        new ProviderRegistry(DEPLOYMENT_ID, memberAddrs, K, CONTACT, n);
        n = _notices();
        n[5] = 6 days; // committee notice below its floor
        vm.expectRevert(ProviderRegistry.InvalidParameters.selector);
        new ProviderRegistry(DEPLOYMENT_ID, memberAddrs, K, CONTACT, n);
    }

    function test_submit_acceptsKSignaturesForCertification_anyoneRelays() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, _expiry(), 0));
        bytes[] memory sigs = _sign(address(reg), d, K);
        vm.prank(makeAddr("random-relayer"));
        bytes32 digest = reg.submit(d, sigs);
        assertEq(reg.version(), 1);
        (uint64 v, bytes32 h) = reg.head();
        assertEq(v, 1);
        assertEq(h, digest, "the digest is the new head");
        assertEq(reg.headAt(1), digest);
        assertTrue(reg.headAt(0) != bytes32(0), "genesis head");
    }

    function test_submit_insufficientSigners() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, _expiry(), 0));
        bytes[] memory sigs = _sign(address(reg), d, K - 1);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K - 1, K));
        reg.submit(d, sigs);
    }

    function test_disableAndBlacklist_needKPlusOne() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_DISABLE, _disablePayload(2, Caip.ledgerKey(HEDERA)));
        bytes[] memory sigs = _sign(address(reg), d, K);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K, K + 1));
        reg.submit(d, sigs);

        d = _decision(reg, A_BLACKLIST, _blacklistPayload(ACCT, CASE));
        sigs = _sign(address(reg), d, K);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K, K + 1));
        reg.submit(d, sigs);

        assertEq(reg.requiredSignatures(A_DISABLE), K + 1);
        assertEq(reg.requiredSignatures(A_BLACKLIST), K + 1);
        assertEq(reg.requiredSignatures(A_DELIST), K + 1);
        assertEq(reg.requiredSignatures(A_COMMITTEE), K + 1); // max(k + 1, ceil(2 * 5 / 3)) = 4
        assertEq(reg.requiredSignatures(A_CERTIFY), K);
        assertEq(reg.requiredSignatures(A_ENABLE), K);
    }

    function test_submit_badSignature() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, _expiry(), 0));
        bytes[] memory sigs = _sign(address(reg), d, K);
        sigs[1] = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27));
        vm.expectRevert();
        reg.submit(d, sigs);
    }

    function test_submit_signatureOverDifferentDecision() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, _expiry(), 0));
        bytes[] memory sigs = _sign(address(reg), d, K);
        d.payload = _certifyPayload(HEDERA, 2, _expiry(), 0); // tampered after signing
        vm.expectRevert(); // recovers non-members
        reg.submit(d, sigs);
    }

    function test_submit_nonMemberSigner() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, _expiry(), 0));
        uint256[] memory pks = new uint256[](3);
        pks[0] = memberPks[0];
        pks[1] = memberPks[1];
        pks[2] = 0xBAD;
        bytes[] memory sigs = _signWith(address(reg), d, pks, 3);
        // order by address may be wrong too; either error is a rejection
        vm.expectRevert();
        reg.submit(d, sigs);
    }

    function test_submit_duplicateSignerRejected() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, _expiry(), 0));
        bytes[] memory sigs = _sign(address(reg), d, K);
        sigs[2] = sigs[1];
        vm.expectRevert(ProviderRegistry.SignersNotSorted.selector);
        reg.submit(d, sigs);
    }

    function test_submit_replayRejected() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("x"));
        bytes[] memory sigs = _sign(address(reg), d, K);
        reg.submit(d, sigs);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.OutOfOrder.selector, 2, 1));
        reg.submit(d, sigs);
    }

    function test_submit_outOfOrderNonce() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("x"));
        d.nonce = 2;
        bytes[] memory sigs = _sign(address(reg), d, K);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.OutOfOrder.selector, 1, 2));
        reg.submit(d, sigs);
    }

    function test_submit_validUntilNotEnforcedForOrderedDecisions() public {
        // A signed registry decision is final: a ledger that reaches its position late must still apply it.
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("x"));
        bytes[] memory sigs = _sign(address(reg), d, K);
        vm.warp(d.validUntil + 365 days);
        reg.submit(d, sigs);
        assertEq(reg.contact(), "x");
    }

    function test_submit_effectiveAtBoundedByMaxNotice() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("x"));
        d.effectiveAt = uint64(block.timestamp + reg.MAX_NOTICE() + 1);
        bytes[] memory sigs = _sign(address(reg), d, K);
        vm.expectRevert(ProviderRegistry.EffectiveTooFar.selector);
        reg.submit(d, sigs);
        vm.warp(block.timestamp + 1); // a later relay only relaxes the bound
        reg.submit(d, sigs);
    }

    function test_submit_missingEvidence() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("x"));
        d.evidenceHash = bytes32(0);
        bytes[] memory sigs = _sign(address(reg), d, K);
        vm.expectRevert(ProviderRegistry.MissingEvidence.selector);
        reg.submit(d, sigs);
    }

    function test_submit_vaultActionsAreNotAcceptedHere() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_VAULT_RELEASE, abi.encode(uint256(1)));
        bytes[] memory sigs = _sign(address(reg), d, K);
        vm.expectRevert(ProviderRegistry.UnsupportedAction.selector);
        reg.submit(d, sigs);
        d.action = 0;
        vm.expectRevert(ProviderRegistry.UnsupportedAction.selector);
        reg.submit(d, sigs);
    }

    function test_sameDecisionAppliesOnEveryLedger() public {
        ProviderRegistry other = _deployRegistry();
        IProviderRegistry.Decision memory d = _decision(reg, A_DISABLE, _disablePayload(2, Caip.ledgerKey(HEDERA)));
        bytes[] memory sigs = _sign(address(reg), d, K + 1);
        reg.submit(d, sigs);
        other.submit(d, sigs);
        assertEq(reg.headAt(1), other.headAt(1), "same history");
        assertTrue(reg.isDisabled(Caip.ledgerKey(HEDERA)));
        assertTrue(other.isDisabled(Caip.ledgerKey(HEDERA)));
        assertEq(reg.version(), other.version());
    }

    // ═════════════════════════════════════════════════════════════════════
    // Committee changes
    // ═════════════════════════════════════════════════════════════════════

    function _newCommittee() internal pure returns (uint256[] memory newPks, address[] memory newMembers) {
        newPks = new uint256[](4);
        newPks[0] = 0x1111;
        newPks[1] = 0x2222;
        newPks[2] = 0x3333;
        newPks[3] = 0x4444;
        newMembers = new address[](4);
        for (uint256 i = 0; i < 4; i++) {
            newMembers[i] = vm.addr(newPks[i]);
        }
        for (uint256 i = 1; i < 4; i++) {
            for (uint256 j = i; j > 0 && newMembers[j - 1] > newMembers[j]; j--) {
                (newMembers[j - 1], newMembers[j]) = (newMembers[j], newMembers[j - 1]);
                (newPks[j - 1], newPks[j]) = (newPks[j], newPks[j - 1]);
            }
        }
    }

    function test_committeeChange_needsSupermajority_noticeThenTakeOver() public {
        (uint256[] memory newPks, address[] memory newMembers) = _newCommittee();
        IProviderRegistry.Decision memory c = _decision(reg, A_COMMITTEE, abi.encode(newMembers, uint8(3)));
        bytes[] memory kSigs = _sign(address(reg), c, K);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K, K + 1));
        reg.submit(c, kSigs);
        reg.submit(c, _sign(address(reg), c, K + 1));

        // Scheduled, visible, not in effect.
        (uint64 pe, address[] memory pm, uint8 pk, uint64 at) = reg.pendingCommittee();
        assertEq(pe, 1);
        assertEq(pm.length, 4);
        assertEq(pk, 3);
        assertEq(at, block.timestamp + COMMITTEE_NOTICE);
        assertEq(reg.epoch(), 0);
        assertTrue(reg.isMember(memberAddrs[0]));
        assertTrue(reg.isProviderAccount(newMembers[0]), "named members are provider accounts at once");

        // The outgoing committee keeps acting during the notice (k for a k action).
        _apply(reg, A_CONTACT, abi.encode("during notice"));
        // The incoming one cannot yet.
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("by new committee"));
        d.epoch = pe;
        bytes[] memory newSigs = _signWith(address(reg), d, newPks, 3);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.CommitteeNotYetActive.selector, at));
        reg.submit(d, newSigs);

        vm.warp(at);
        reg.submit(d, newSigs); // takes over with its first decision
        assertEq(reg.epoch(), 1);
        assertEq(reg.threshold(), 3);
        assertTrue(reg.isMember(newMembers[0]));
        assertFalse(reg.isMember(memberAddrs[0]));
        assertTrue(reg.isProviderAccount(memberAddrs[0]), "past members stay provider accounts");
        assertEq(reg.contact(), "by new committee");
        (,,, at) = reg.pendingCommittee();
        assertEq(at, 0);

        // Old committee can no longer act.
        d = _decision(reg, A_CONTACT, abi.encode("by old committee"));
        d.epoch = 0;
        bytes[] memory sigs = _sign(address(reg), d, 5);
        vm.expectRevert(ProviderRegistry.WrongEpoch.selector);
        reg.submit(d, sigs);
    }

    function test_committeeChange_outgoingNeedsSupermajorityAfterNotice() public {
        (, address[] memory newMembers) = _newCommittee();
        _apply(reg, A_COMMITTEE, abi.encode(newMembers, uint8(3)));
        vm.warp(block.timestamp + COMMITTEE_NOTICE);
        // k outgoing keys can no longer fill positions to stall the hand-over...
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("stall"));
        bytes[] memory sigs_1 = _sign(address(reg), d, K);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K, K + 1));
        reg.submit(d, sigs_1);
        // ...but the same decision with more outgoing signatures still applies (nothing is ever stuck).
        reg.submit(d, _sign(address(reg), d, K + 1));
        assertEq(reg.contact(), "stall");
    }

    function test_committeeChange_replacedOrCancelledDuringNotice() public {
        (uint256[] memory newPks, address[] memory newMembers) = _newCommittee();
        _apply(reg, A_COMMITTEE, abi.encode(newMembers, uint8(3)));
        uint64 replaced = reg.pendingEpoch();
        _apply(reg, A_COMMITTEE, abi.encode(memberAddrs, K)); // cancel: re-state the current committee
        assertTrue(reg.pendingEpoch() != replaced);
        vm.warp(block.timestamp + COMMITTEE_NOTICE);
        IProviderRegistry.Decision memory d = _decision(reg, A_CONTACT, abi.encode("x"));
        d.epoch = replaced;
        bytes[] memory sigs = _signWith(address(reg), d, newPks, 3);
        vm.expectRevert(ProviderRegistry.WrongEpoch.selector);
        reg.submit(d, sigs);
    }

    function test_committeeChange_enforcesFloors() public {
        address[] memory three = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            three[i] = memberAddrs[i];
        }
        IProviderRegistry.Decision memory d = _decision(reg, A_COMMITTEE, abi.encode(three, uint8(1)));
        bytes[] memory sigs = _sign(address(reg), d, K + 1);
        vm.expectRevert(ProviderRegistry.InvalidCommittee.selector);
        reg.submit(d, sigs);
    }

    function test_contactChange() public {
        _apply(reg, A_CONTACT, abi.encode("mailto:new@provider.example"));
        assertEq(reg.contact(), "mailto:new@provider.example");
    }

    // ═════════════════════════════════════════════════════════════════════
    // Certification
    // ═════════════════════════════════════════════════════════════════════

    function test_certify_takesEffectAfterNotice() public {
        vm.expectEmit(true, true, false, false, address(reg));
        emit ProviderRegistry.CertificationScheduled(
            Caip.certKey(HEDERA, 1), HEDERA, 1, true, 0, 0, 0, "", 0, bytes32(0), bytes32(0)
        );
        _apply(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, _expiry(), 0));
        (bool ok,) = _certified(HEDERA, 1);
        assertFalse(ok, "not yet");
        vm.warp(block.timestamp + CERT_NOTICE - 1);
        (ok,) = _certified(HEDERA, 1);
        assertFalse(ok);
        vm.warp(block.timestamp + 1);
        (ok,) = _certified(HEDERA, 1);
        assertTrue(ok);
    }

    function test_certify_expires() public {
        uint64 expiry = _expiry();
        _apply(reg, A_CERTIFY, _certifyPayload(HEDERA, 2, expiry, 0));
        vm.warp(expiry - 1);
        (bool ok,) = _certified(HEDERA, 2);
        assertTrue(ok);
        vm.warp(expiry);
        (ok,) = _certified(HEDERA, 2);
        assertFalse(ok);
    }

    function test_certify_expiryClampedToOneYear_neverReverts() public {
        uint64 t0 = uint64(block.timestamp);
        _apply(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, t0 + CERT_NOTICE + 400 days, 0));
        ProviderRegistry.Certification[] memory log = reg.certificationLog(Caip.certKey(HEDERA, 1));
        assertEq(log[0].expiry, t0 + CERT_NOTICE + 366 days, "clamped to MAX_CERT_DURATION");
        // Relayed so late that it is expired on arrival: recorded, never holds, the sequence goes on.
        _apply(reg, A_CERTIFY, _certifyPayload(HEDERA, 2, t0 + 1 days, 0));
        vm.warp(t0 + CERT_NOTICE);
        (bool ok,) = _certified(HEDERA, 2);
        assertFalse(ok);
        // Only a signed-values contradiction is rejected (on every ledger alike).
        IProviderRegistry.Decision memory d = _decision(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, t0 + 30 days, 0));
        d.effectiveAt = t0 + 30 days;
        bytes[] memory sigs = _sign(address(reg), d, K);
        vm.expectRevert(ProviderRegistry.InvalidExpiry.selector);
        reg.submit(d, sigs);
    }

    function test_certify_invalidLabel() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CERTIFY, _certifyPayload(HEDERA, 4, _expiry(), 0));
        bytes[] memory sigs = _sign(address(reg), d, K);
        vm.expectRevert(ProviderRegistry.InvalidLabel.selector);
        reg.submit(d, sigs);
    }

    function test_energy_storesMicrogramsAndAllowsSmallValues() public {
        _apply(reg, A_CERTIFY, _certifyPayload(HEDERA, 3, _expiry(), 2400)); // 0.0024 gCO2e/tx
        vm.warp(block.timestamp + CERT_NOTICE);
        (bool ok, uint64 em) = _certified(HEDERA, 3);
        assertTrue(ok);
        assertEq(em, 2400);
        _apply(reg, A_CERTIFY, _certifyPayload("eip155:1", 3, _expiry() + CERT_NOTICE, 1));
        vm.warp(block.timestamp + CERT_NOTICE);
        (ok, em) = _certified("eip155:1", 3);
        assertTrue(ok);
        assertEq(em, 1, "1 microgram is representable");
    }

    function test_energy_requiresFigureAndSource() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_CERTIFY, _certifyPayload(HEDERA, 3, _expiry(), 0));
        bytes[] memory sigs = _sign(address(reg), d, K);
        vm.expectRevert(ProviderRegistry.MissingEmissions.selector);
        reg.submit(d, sigs);
        d = _decision(reg, A_CERTIFY, abi.encode(HEDERA, uint8(3), _expiry(), uint64(2400), ""));
        sigs = _sign(address(reg), d, K);
        vm.expectRevert(ProviderRegistry.MissingEmissions.selector);
        reg.submit(d, sigs);
    }

    function test_uncertify_afterRemovalNotice() public {
        _apply(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, _expiry(), 0));
        vm.warp(block.timestamp + CERT_NOTICE);
        _apply(reg, A_UNCERTIFY, abi.encode(HEDERA, uint8(1)));
        (bool ok,) = _certified(HEDERA, 1);
        assertTrue(ok, "removal not yet effective");
        vm.warp(block.timestamp + REMOVAL_NOTICE);
        (ok,) = _certified(HEDERA, 1);
        assertFalse(ok);
    }

    function test_versionPinning_oldVersionStaysReadable() public {
        _apply(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, _expiry(), 0));
        vm.warp(block.timestamp + CERT_NOTICE);
        uint64 v1 = reg.version();
        _apply(reg, A_UNCERTIFY, abi.encode(HEDERA, uint8(1)));
        vm.warp(block.timestamp + REMOVAL_NOTICE);
        (bool atV1,) = reg.certificationAt(Caip.certKey(HEDERA, 1), v1);
        (bool atV2,) = reg.certificationAt(Caip.certKey(HEDERA, 1), reg.version());
        assertTrue(atV1, "pinned to the version before the removal");
        assertFalse(atV2);
        (bool future,) = reg.certificationAt(Caip.certKey(HEDERA, 1), reg.version() + 1);
        assertFalse(future, "a version this registry has not reached fails closed");
        assertEq(reg.certificationLog(Caip.certKey(HEDERA, 1)).length, 2, "append-only");
    }

    function test_laterRemovalSupersedesPendingCertification() public {
        _apply(reg, A_CERTIFY, _certifyPayload(HEDERA, 1, _expiry(), 0)); // effective in 7 days
        _apply(reg, A_UNCERTIFY, abi.encode(HEDERA, uint8(1))); // effective in 72 hours
        ProviderRegistry.Certification[] memory log = reg.certificationLog(Caip.certKey(HEDERA, 1));
        assertEq(log[1].effectiveFrom, block.timestamp + REMOVAL_NOTICE, "not queued behind the certification");
        vm.warp(block.timestamp + CERT_NOTICE);
        (bool ok,) = _certified(HEDERA, 1);
        assertFalse(ok, "the later removal wins");
    }

    // ═════════════════════════════════════════════════════════════════════
    // Disable / re-enable
    // ═════════════════════════════════════════════════════════════════════

    function test_disable_immediate_lapses_renewable() public {
        bytes32 subject = Caip.edgeKey(keccak256("ch"), HEDERA);
        _apply(reg, A_DISABLE, _disablePayload(1, subject));
        assertTrue(reg.isDisabled(subject), "immediate");
        vm.warp(block.timestamp + DISABLE_LAPSE - 1);
        _apply(reg, A_DISABLE, _disablePayload(1, subject)); // renewal with incident report
        vm.warp(block.timestamp + 2);
        assertTrue(reg.isDisabled(subject), "renewed");
        vm.warp(block.timestamp + DISABLE_LAPSE);
        assertFalse(reg.isDisabled(subject), "lapsed");
    }

    function test_disable_invalidTarget() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_DISABLE, _disablePayload(5, bytes32(uint256(1))));
        bytes[] memory sigs = _sign(address(reg), d, K + 1);
        vm.expectRevert(ProviderRegistry.InvalidTarget.selector);
        reg.submit(d, sigs);
        d = _decision(reg, A_DISABLE, _disablePayload(1, bytes32(0)));
        sigs = _sign(address(reg), d, K + 1);
        vm.expectRevert(ProviderRegistry.InvalidTarget.selector);
        reg.submit(d, sigs);
    }

    function test_reenable_afterNotice() public {
        bytes32 subject = Caip.ledgerKey(HEDERA);
        _apply(reg, A_DISABLE, _disablePayload(2, subject));
        _apply(reg, A_ENABLE, abi.encode(uint8(2), subject));
        assertTrue(reg.isDisabled(subject));
        vm.warp(block.timestamp + REENABLE_NOTICE);
        assertFalse(reg.isDisabled(subject));
    }

    function test_reenable_whenNotDisabled_isNoOpButAdvancesVersion() public {
        uint64 v = reg.version();
        _apply(reg, A_ENABLE, abi.encode(uint8(2), Caip.ledgerKey(HEDERA)));
        assertEq(reg.version(), v + 1);
        (,, uint64 reenableAt) = reg.switches(Caip.ledgerKey(HEDERA));
        assertEq(reenableAt, 0);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Blacklist
    // ═════════════════════════════════════════════════════════════════════

    function test_blacklist_immediate_lapses_renewable_delist() public {
        bytes32 key = Caip.accountKey(ACCT);
        _apply(reg, A_BLACKLIST, _blacklistPayload(ACCT, CASE));
        (bool listed, bytes32 cid) = reg.blacklisted(key);
        assertTrue(listed);
        assertEq(cid, CASE);

        vm.warp(block.timestamp + BLACKLIST_LAPSE - 1);
        _apply(reg, A_BLACKLIST, _blacklistPayload(ACCT, CASE)); // renewed with an updated case
        vm.warp(block.timestamp + 2);
        (listed,) = reg.blacklisted(key);
        assertTrue(listed);

        _apply(reg, A_DELIST, abi.encode(ACCT, CASE));
        (listed, cid) = reg.blacklisted(key);
        assertFalse(listed);
        assertEq(cid, bytes32(0));
    }

    function test_blacklist_lapsesAfterThirtyDays() public {
        _apply(reg, A_BLACKLIST, _blacklistPayload(ACCT, CASE));
        vm.warp(block.timestamp + BLACKLIST_LAPSE);
        (bool listed,) = reg.blacklisted(Caip.accountKey(ACCT));
        assertFalse(listed);
    }

    function test_blacklist_requiresCaseId() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_BLACKLIST, _blacklistPayload(ACCT, bytes32(0)));
        bytes[] memory sigs = _sign(address(reg), d, K + 1);
        vm.expectRevert(ProviderRegistry.InvalidTarget.selector);
        reg.submit(d, sigs);
    }

    function test_delist_needsKPlusOne() public {
        _apply(reg, A_BLACKLIST, _blacklistPayload(ACCT, CASE));
        IProviderRegistry.Decision memory d = _decision(reg, A_DELIST, abi.encode(ACCT, CASE));
        bytes[] memory sigs = _sign(address(reg), d, K);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K, K + 1));
        reg.submit(d, sigs);
    }

    function test_delist_wrongCase_isNoOp() public {
        _apply(reg, A_BLACKLIST, _blacklistPayload(ACCT, CASE));
        _apply(reg, A_DELIST, abi.encode(ACCT, keccak256("other-case")));
        (bool listed,) = reg.blacklisted(Caip.accountKey(ACCT));
        assertTrue(listed);
    }

    function test_blacklist_isCaseInsensitive() public {
        _apply(reg, A_BLACKLIST, _blacklistPayload("eip155:1:0xABCDEF0000000000000000000000000000000001", CASE));
        (bool listed,) = reg.blacklisted(Caip.accountKey("eip155:1:0xabcdef0000000000000000000000000000000001"));
        assertTrue(listed);
    }

    function test_everyActionEmitsEvidence() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_BLACKLIST, _blacklistPayload(ACCT, CASE));
        bytes[] memory sigs = _sign(address(reg), d, K + 1);
        bytes32 digest = reg.decisionDigest(d);
        vm.expectEmit(true, true, true, true, address(reg));
        emit ProviderRegistry.DecisionApplied(1, A_BLACKLIST, digest, EVIDENCE);
        reg.submit(d, sigs);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Trust-tier labels (Channel directions)
    // ═════════════════════════════════════════════════════════════════════

    uint8 internal constant A_TRUST_TIER = 11;
    bytes32 internal constant CH = keccak256("channel-eth-hedera");

    function _tier(string memory toLedger, uint8 tier) internal returns (bytes32) {
        return _apply(reg, A_TRUST_TIER, abi.encode(CH, toLedger, tier));
    }

    function _tierOf(string memory toLedger) internal view returns (bool labelled, uint8 tier) {
        return reg.trustTier(Caip.edgeKey(CH, toLedger));
    }

    function test_trustTier_needsKSignatures_andAdvancesVersion() public {
        assertEq(reg.requiredSignatures(A_TRUST_TIER), K);
        IProviderRegistry.Decision memory d = _decision(reg, A_TRUST_TIER, abi.encode(CH, HEDERA, uint8(2)));
        bytes[] memory few = _sign(address(reg), d, K - 1);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K - 1, K));
        reg.submit(d, few);
        bytes32 digest = reg.decisionDigest(d);
        vm.expectEmit(true, true, true, true, address(reg));
        emit ProviderRegistry.TrustTierScheduled(
            Caip.edgeKey(CH, HEDERA), CH, HEDERA, 2, uint64(block.timestamp + CERT_NOTICE), EVIDENCE, digest
        );
        reg.submit(d, _sign(address(reg), d, K));
        assertEq(reg.version(), 1);
    }

    function test_trustTier_raisingWaitsForCertNotice() public {
        (bool labelled,) = _tierOf(HEDERA);
        assertFalse(labelled, "unlabelled by default");
        _tier(HEDERA, 2);
        vm.warp(block.timestamp + CERT_NOTICE - 1);
        (labelled,) = _tierOf(HEDERA);
        assertFalse(labelled);
        vm.warp(block.timestamp + 1);
        uint8 tier;
        (labelled, tier) = _tierOf(HEDERA);
        assertTrue(labelled);
        assertEq(tier, 2);
        // The label is per direction: the opposite direction of the same Channel stays unlabelled.
        (labelled,) = _tierOf("eip155:1");
        assertFalse(labelled);
    }

    function test_trustTier_attestedIsALabelToo() public {
        _tier(HEDERA, 0);
        vm.warp(block.timestamp + CERT_NOTICE);
        (bool labelled, uint8 tier) = _tierOf(HEDERA);
        assertTrue(labelled);
        assertEq(tier, 0);
    }

    function test_trustTier_loweringAndRemovalWaitForRemovalNotice() public {
        _tier(HEDERA, 3);
        vm.warp(block.timestamp + CERT_NOTICE);
        _tier(HEDERA, 1);
        vm.warp(block.timestamp + REMOVAL_NOTICE - 1);
        (, uint8 tier) = _tierOf(HEDERA);
        assertEq(tier, 3, "still the old tier during the notice");
        vm.warp(block.timestamp + 1);
        (, tier) = _tierOf(HEDERA);
        assertEq(tier, 1);

        _tier(HEDERA, 255); // TIER_NONE
        vm.warp(block.timestamp + REMOVAL_NOTICE);
        (bool labelled,) = _tierOf(HEDERA);
        assertFalse(labelled);
    }

    function test_trustTier_laterDecisionSupersedesPendingOne() public {
        _tier(HEDERA, 3);
        _tier(HEDERA, 255); // withdrawn before it took effect
        vm.warp(block.timestamp + CERT_NOTICE);
        (bool labelled,) = _tierOf(HEDERA);
        assertFalse(labelled);
    }

    function test_trustTier_rejectsInvalidTierAndTarget() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_TRUST_TIER, abi.encode(CH, HEDERA, uint8(4)));
        bytes[] memory sigs = _sign(address(reg), d, K);
        vm.expectRevert(ProviderRegistry.InvalidTier.selector);
        reg.submit(d, sigs);
        d.payload = abi.encode(bytes32(0), HEDERA, uint8(1));
        sigs = _sign(address(reg), d, K);
        vm.expectRevert(ProviderRegistry.InvalidTarget.selector);
        reg.submit(d, sigs);
        d.payload = abi.encode(CH, "", uint8(1));
        sigs = _sign(address(reg), d, K);
        vm.expectRevert(ProviderRegistry.InvalidTarget.selector);
        reg.submit(d, sigs);
        d.action = 12; // VAULT_BIND_ROUTER: vault only
        d.payload = abi.encode(CH, HEDERA, uint8(1));
        sigs = _sign(address(reg), d, K);
        vm.expectRevert(ProviderRegistry.UnsupportedAction.selector);
        reg.submit(d, sigs);
    }

    function test_vaultNameRecoveryStillNotAcceptedHere() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_VAULT_NAME_RECOVERY, abi.encode(uint256(1)));
        bytes[] memory sigs = _sign(address(reg), d, K);
        vm.expectRevert(ProviderRegistry.UnsupportedAction.selector);
        reg.submit(d, sigs);
    }
}
