// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {QuarantineVault} from "@clprouter/QuarantineVault.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {AuditBase} from "./AuditBase.sol";

/// @dev A beneficiary that re-enters the vault on receipt.
contract ReentrantBeneficiary {
    QuarantineVault public vault;
    IProviderRegistry.Decision internal d;
    bytes[] internal sigs;
    bool public reentered;
    bool public reentryReverted;

    function arm(QuarantineVault v, IProviderRegistry.Decision memory d_, bytes[] memory sigs_) external {
        vault = v;
        d = d_;
        delete sigs;
        for (uint256 i = 0; i < sigs_.length; i++) {
            sigs.push(sigs_[i]);
        }
    }

    receive() external payable {
        if (reentered) return;
        reentered = true;
        try vault.release(d, sigs) {} catch {
            reentryReverted = true;
        }
    }
}

/// @dev A sender app that cannot take native value (the Router itself falls back to `owed`, the vault does not).
contract NoReceive {}

/// @notice Demonstrations of the vault findings in docs/audit/registry-vault-findings.md.
contract VaultFindingsTest is AuditBase {
    ProviderRegistry internal reg;
    QuarantineVault internal vault;
    QuarantineVault internal vaultB; // vault on another ledger, same committee
    address internal sender = makeAddr("sender");
    address internal recipient = makeAddr("recipient");
    address internal recovery = makeAddr("recovery");

    function setUp() public {
        vm.warp(1_800_000_000);
        _initCommittee();
        reg = _deployRegistry();
        vault = _newVault(reg);
        vaultB = _newVault(_deployRegistry());
    }

    function _dep(QuarantineVault v, uint256 amt, address s, address r) internal returns (uint256) {
        vm.deal(address(this), address(this).balance + amt);
        return v.deposit{value: amt}(ROUTE, CASE, s, r);
    }

    function _name(QuarantineVault v, address to) internal returns (IProviderRegistry.Decision memory d, bytes[] memory s) {
        d = _vaultDecision(reg, A_VAULT_NAME_RECOVERY, abi.encode(CASE, to));
        s = _sign(d, K);
        v.nameRecovery(d, s);
    }

    function _rel(uint256 id, QuarantineVault.Beneficiary kind)
        internal
        returns (IProviderRegistry.Decision memory d, bytes[] memory s)
    {
        d = _vaultDecision(reg, A_VAULT_RELEASE, abi.encode(id, CASE, uint8(kind)));
        s = _sign(d, K);
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-04 (Medium): vault decisions replay across every vault on every ledger
    // ═════════════════════════════════════════════════════════════════════

    function test_RV04_recoveryNamingAndReleaseReplayOntoAnotherLedgersVault() public {
        _dep(vault, 1 ether, sender, recipient); // ledger A, deposit #1, case X
        address otherSender = makeAddr("ledger-B-sender");
        _dep(vaultB, 7 ether, otherSender, address(0)); // ledger B, deposit #1, same case X

        // Committee decides about ledger A only; anyone relays the same naming to ledger B.
        (IProviderRegistry.Decision memory n, bytes[] memory ns) = _name(vault, recovery);
        vaultB.nameRecovery(n, ns);
        vm.warp(block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW);
        (IProviderRegistry.Decision memory r, bytes[] memory rs) = _rel(1, QuarantineVault.Beneficiary.RECOVERY);
        r.validUntil = uint64(block.timestamp + 1 days);
        rs = _sign(r, K);
        vault.release(r, rs);
        assertEq(recovery.balance, 1 ether);
        vaultB.release(r, rs); // the release for A's deposit #1 also pays out B's deposit #1
        assertEq(recovery.balance, 8 ether, "ledger B's 7 ether followed decisions signed for ledger A");
    }

    function test_RV04_releaseToSenderReplaysOntoSameIdOtherLedger() public {
        _dep(vault, 1 ether, sender, recipient);
        address otherSender = makeAddr("ledger-B-sender");
        _dep(vaultB, 3 ether, otherSender, recipient);
        (IProviderRegistry.Decision memory r, bytes[] memory rs) = _rel(1, QuarantineVault.Beneficiary.RECIPIENT);
        vault.release(r, rs);
        vaultB.release(r, rs); // not decided for B, but valid there
        assertEq(recipient.balance, 4 ether);
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-08 (Medium): re-naming the same address wipes a challenge
    // ═════════════════════════════════════════════════════════════════════

    function test_RV08_renamingSameAddressClearsChallenge() public {
        uint256 id = _dep(vault, 2 ether, sender, recipient);
        _name(vault, recovery);
        vm.prank(sender);
        vault.challengeRecovery(id, keccak256("this is not my recovery address"));
        (,,, bool challenged) = vault.recoveries(CASE);
        assertTrue(challenged);

        _name(vault, recovery); // same address, new nonce
        (,,, challenged) = vault.recoveries(CASE);
        assertFalse(challenged, "the challenge is erased");
        vm.warp(block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW);
        (IProviderRegistry.Decision memory r, bytes[] memory rs) = _rel(id, QuarantineVault.Beneficiary.RECOVERY);
        vault.release(r, rs);
        assertEq(recovery.balance, 2 ether, "challenged address paid after one more naming");
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-09 (Medium): anyone can join a case for 1 wei and veto every recovery; funds can lock forever
    // ═════════════════════════════════════════════════════════════════════

    function test_RV09_oneWeiDepositGrantsChallengeRightOverWholeCase() public {
        uint256 id = _dep(vault, 10 ether, sender, recipient);
        address griefer = makeAddr("griefer");
        vm.deal(griefer, 1);
        vm.prank(griefer);
        uint256 junk = vault.deposit{value: 1}(ROUTE, CASE, griefer, address(0)); // permissionless
        _name(vault, recovery);
        vm.prank(griefer);
        vault.challengeRecovery(junk, bytes32(0));
        vm.warp(block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW);
        (IProviderRegistry.Decision memory r, bytes[] memory rs) = _rel(id, QuarantineVault.Beneficiary.RECOVERY);
        vm.expectRevert(QuarantineVault.RecoveryNotReady.selector);
        vault.release(r, rs);
    }

    function test_RV09_noReceiveSenderAndNoRecipient_onlyRecovery_whichIsVetoable() public {
        // Router quarantines a fee-only route of a sender app without receive(); payee is zero.
        address app = address(new NoReceive());
        uint256 id = _dep(vault, 1 ether, app, address(0));
        (IProviderRegistry.Decision memory r, bytes[] memory rs) = _rel(id, QuarantineVault.Beneficiary.SENDER);
        vm.expectRevert(QuarantineVault.TransferFailed.selector);
        vault.release(r, rs);
        (r, rs) = _rel(id, QuarantineVault.Beneficiary.RECIPIENT);
        vm.expectRevert(QuarantineVault.ForbiddenBeneficiary.selector);
        vault.release(r, rs);
        // The only exit is RECOVERY, and any 1-wei party (RV-09) can block it each time it is named.
        address griefer = makeAddr("griefer");
        vm.deal(griefer, 1);
        vm.prank(griefer);
        uint256 junk = vault.deposit{value: 1}(ROUTE, CASE, griefer, address(0));
        _name(vault, recovery);
        vm.prank(griefer);
        vault.challengeRecovery(junk, bytes32(0));
        vm.warp(block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW);
        (r, rs) = _rel(id, QuarantineVault.Beneficiary.RECOVERY);
        vm.expectRevert(QuarantineVault.RecoveryNotReady.selector);
        vault.release(r, rs);
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-10 (Info): effectiveAt is ignored by the vault
    // ═════════════════════════════════════════════════════════════════════

    function test_RV10_vaultIgnoresEffectiveAt() public {
        uint256 id = _dep(vault, 1 ether, sender, recipient);
        IProviderRegistry.Decision memory d =
            _vaultDecision(reg, A_VAULT_RELEASE, abi.encode(id, CASE, uint8(QuarantineVault.Beneficiary.SENDER)));
        d.effectiveAt = uint64(block.timestamp + 30 days);
        d.validUntil = uint64(block.timestamp + 60 days);
        vault.release(d, _sign(d, K)); // applies now, 30 days early
        assertEq(sender.balance, 1 ether);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Properties that hold
    // ═════════════════════════════════════════════════════════════════════

    function test_ok_reentrantBeneficiaryCannotDoubleRelease() public {
        ReentrantBeneficiary evil = new ReentrantBeneficiary();
        uint256 id = _dep(vault, 1 ether, address(evil), recipient);
        _dep(vault, 1 ether, address(evil), recipient); // a second deposit that must stay put
        (IProviderRegistry.Decision memory r, bytes[] memory rs) = _rel(id, QuarantineVault.Beneficiary.SENDER);
        evil.arm(vault, r, rs); // replays the same decision during the payout
        vault.release(r, rs);
        assertTrue(evil.reentered());
        assertTrue(evil.reentryReverted());
        assertEq(address(evil).balance, 1 ether);
        assertEq(address(vault).balance, 1 ether);
    }

    function test_ok_secondDecisionCannotReleaseTwice() public {
        uint256 id = _dep(vault, 1 ether, sender, recipient);
        (IProviderRegistry.Decision memory r, bytes[] memory rs) = _rel(id, QuarantineVault.Beneficiary.SENDER);
        vault.release(r, rs);
        (r, rs) = _rel(id, QuarantineVault.Beneficiary.RECIPIENT);
        vm.expectRevert(QuarantineVault.AlreadyReleased.selector);
        vault.release(r, rs);
    }

    function test_ok_neverToProviderAccounts_evenFormerMembers() public {
        // A deposit that names a committee member as sender can never pay it out.
        uint256 id = _dep(vault, 1 ether, memberAddrs[0], recipient);
        (IProviderRegistry.Decision memory r, bytes[] memory rs) = _rel(id, QuarantineVault.Beneficiary.SENDER);
        vm.expectRevert(QuarantineVault.ForbiddenBeneficiary.selector);
        vault.release(r, rs);
        IProviderRegistry.Decision memory n =
            _vaultDecision(reg, A_VAULT_NAME_RECOVERY, abi.encode(CASE, memberAddrs[1]));
        bytes[] memory ns = _sign(n, K);
        vm.expectRevert(QuarantineVault.ForbiddenBeneficiary.selector);
        vault.nameRecovery(n, ns);
        for (uint256 i = 0; i < 2; i++) {
            address bad = i == 0 ? address(vault) : address(reg);
            n = _vaultDecision(reg, A_VAULT_NAME_RECOVERY, abi.encode(CASE, bad));
            ns = _sign(n, K);
            vm.expectRevert(QuarantineVault.ForbiddenBeneficiary.selector);
            vault.nameRecovery(n, ns);
        }
    }

    function test_ok_noReleaseWithoutOrWithWrongCase() public {
        uint256 id = _dep(vault, 1 ether, sender, recipient);
        IProviderRegistry.Decision memory d =
            _vaultDecision(reg, A_VAULT_RELEASE, abi.encode(id, bytes32(0), uint8(0)));
        bytes[] memory s = _sign(d, K);
        vm.expectRevert(QuarantineVault.CaseMismatch.selector);
        vault.release(d, s);
        d = _vaultDecision(reg, A_VAULT_RELEASE, abi.encode(id, keccak256("other"), uint8(0)));
        s = _sign(d, K);
        vm.expectRevert(QuarantineVault.CaseMismatch.selector);
        vault.release(d, s);
        vm.expectRevert(QuarantineVault.NoCase.selector);
        vault.deposit{value: 0}(ROUTE, bytes32(0), sender, recipient);
    }

    function test_ok_recoveryWaitsNoticePlusWindow_andRegistryDecisionsDontCount() public {
        uint256 id = _dep(vault, 1 ether, sender, recipient);
        _name(vault, recovery);
        vm.warp(block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW - 1);
        (IProviderRegistry.Decision memory r, bytes[] memory rs) = _rel(id, QuarantineVault.Beneficiary.RECOVERY);
        vm.expectRevert(QuarantineVault.RecoveryNotReady.selector);
        vault.release(r, rs);
        vm.prank(sender);
        vault.challengeRecovery(id, bytes32(0)); // still open at the last second
        vm.warp(block.timestamp + 1);
        vm.prank(recipient);
        vm.expectRevert(QuarantineVault.ChallengeClosed.selector);
        vault.challengeRecovery(id, bytes32(0));
        // A registry-action decision (e.g. CONTACT) cannot be used as a vault release.
        IProviderRegistry.Decision memory c = _decision(reg, A_CONTACT, abi.encode(id, CASE, uint8(0)));
        bytes[] memory cs = _sign(c, K);
        vm.expectRevert(QuarantineVault.WrongAction.selector);
        vault.release(c, cs);
    }

    function test_ok_vaultReleaseNeedsKFromCurrentEpoch() public {
        uint256 id = _dep(vault, 1 ether, sender, recipient);
        (IProviderRegistry.Decision memory r,) = _rel(id, QuarantineVault.Beneficiary.SENDER);
        bytes[] memory few = _sign(r, K - 1);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K - 1, K));
        vault.release(r, few);
        // Rotation invalidates an unrelayed release signed by the old epoch.
        address[] memory keep = new address[](4);
        for (uint256 i = 0; i < 4; i++) {
            keep[i] = memberAddrs[i + 1];
        }
        _apply(reg, A_COMMITTEE, abi.encode(keep, uint8(3)));
        bytes[] memory full = _sign(r, K);
        vm.expectRevert(ProviderRegistry.WrongEpoch.selector);
        vault.release(r, full);
    }

    receive() external payable {}
}
