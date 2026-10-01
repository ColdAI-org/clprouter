// SPDX-License-Identifier: MIT
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

/// @notice Regression tests for the vault findings in docs/audit/registry-vault-findings.md (each `test_RV*`
///         used to demonstrate the issue and now asserts the fix).
contract VaultFindingsTest is AuditBase {
    ProviderRegistry internal reg;
    QuarantineVault internal vault;
    ProviderRegistry internal regB; // registry of another ledger of the same deployment
    QuarantineVault internal vaultB; // vault on that ledger, same committee (unbound: permissionless deposits)
    address internal sender = makeAddr("sender");
    address internal recipient = makeAddr("recipient");
    address internal recovery = makeAddr("recovery");

    function setUp() public {
        vm.warp(1_800_000_000);
        _initCommittee();
        reg = _deployRegistry();
        vault = _newVault(reg);
        regB = _deployRegistry();
        vaultB = _newVault(regB);
        _bind(reg, vault, address(this)); // this test stands in for ledger A's Router
    }

    function _dep(QuarantineVault v, uint256 amt, address s, address r) internal returns (uint256) {
        vm.deal(address(this), address(this).balance + amt);
        return v.deposit{value: amt}(ROUTE, CASE, s, r);
    }

    function _name(QuarantineVault v, address to) internal returns (IProviderRegistry.Decision memory d, bytes[] memory s) {
        d = _vaultDecision(reg, A_VAULT_NAME_RECOVERY, abi.encode(CASE, to));
        s = _sign(address(v), d, K + 1);
        v.nameRecovery(d, s);
    }

    function _rel(uint256 id, QuarantineVault.Beneficiary kind)
        internal
        returns (IProviderRegistry.Decision memory d, bytes[] memory s)
    {
        return _relOn(vault, id, kind);
    }

    function _relOn(QuarantineVault v, uint256 id, QuarantineVault.Beneficiary kind)
        internal
        returns (IProviderRegistry.Decision memory d, bytes[] memory s)
    {
        d = _vaultDecision(reg, A_VAULT_RELEASE, abi.encode(id, CASE, uint8(kind)));
        s = _sign(address(v), d, kind == QuarantineVault.Beneficiary.RECOVERY_OVER_CHALLENGE ? K + 1 : K);
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-04 (Medium, fixed): vault decisions bind to chain id + vault address (+ deployment id)
    // ═════════════════════════════════════════════════════════════════════

    function test_RV04_recoveryNamingAndReleaseDoNotReplayOntoAnotherLedgersVault() public {
        _dep(vault, 1 ether, sender, recipient); // ledger A, deposit #1, case X
        address otherSender = makeAddr("ledger-B-sender");
        _dep(vaultB, 7 ether, otherSender, address(0)); // ledger B, deposit #1, same case X

        (IProviderRegistry.Decision memory n, bytes[] memory ns) = _name(vault, recovery);
        vm.expectRevert(ProviderRegistry.BadSignature.selector);
        vaultB.nameRecovery(n, ns);
        vm.warp(block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW);
        (IProviderRegistry.Decision memory r, bytes[] memory rs) = _rel(1, QuarantineVault.Beneficiary.RECOVERY);
        vault.release(r, rs);
        assertEq(recovery.balance, 1 ether);
        vm.expectRevert(ProviderRegistry.BadSignature.selector);
        vaultB.release(r, rs);
        assertEq(address(vaultB).balance, 7 ether, "ledger B's deposit only follows decisions signed for B");
    }

    function test_RV04_releaseToSenderDoesNotReplayOntoSameIdOtherLedger() public {
        _dep(vault, 1 ether, sender, recipient);
        address otherSender = makeAddr("ledger-B-sender");
        _dep(vaultB, 3 ether, otherSender, recipient);
        (IProviderRegistry.Decision memory r, bytes[] memory rs) = _rel(1, QuarantineVault.Beneficiary.RECIPIENT);
        vault.release(r, rs);
        vm.expectRevert(ProviderRegistry.BadSignature.selector);
        vaultB.release(r, rs);
        assertEq(recipient.balance, 1 ether);
        // The digest commits to the chain id too: the same vault address on a fork with another chain id differs.
        bytes32 here = vault.decisionDigest(r);
        vm.chainId(block.chainid + 1);
        assertTrue(vault.decisionDigest(r) != here);
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-08 (Medium, fixed): re-naming the same address keeps the challenge
    // ═════════════════════════════════════════════════════════════════════

    function test_RV08_renamingSameAddressKeepsChallenge() public {
        uint256 id = _dep(vault, 2 ether, sender, recipient);
        _name(vault, recovery);
        vm.prank(sender);
        vault.challengeRecovery(id, keccak256("this is not my recovery address"));
        uint64 at = vault.challengedAt(id, recovery);
        assertGt(at, 0);

        _name(vault, recovery); // same address, new nonce
        assertEq(vault.challengedAt(id, recovery), at, "the challenge stays");
        vm.warp(block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW);
        (IProviderRegistry.Decision memory r, bytes[] memory rs) = _rel(id, QuarantineVault.Beneficiary.RECOVERY);
        vm.expectRevert(QuarantineVault.RecoveryNotReady.selector);
        vault.release(r, rs);
        assertEq(recovery.balance, 0);
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-09 (Medium, fixed): deposits only from the bound Router; challenges only bind the challenger's deposit;
    //                        a challenge escalates to a supermajority override instead of a permanent veto
    // ═════════════════════════════════════════════════════════════════════

    function test_RV09_strangerCannotJoinCase_partyOfOtherDepositCannotBlockThisOne() public {
        uint256 id = _dep(vault, 10 ether, sender, recipient);
        address griefer = makeAddr("griefer");
        vm.deal(griefer, 1);
        vm.prank(griefer);
        vm.expectRevert(QuarantineVault.NotRouter.selector);
        vault.deposit{value: 1}(ROUTE, CASE, griefer, address(0));
        // Even a party of another deposit under the case (e.g. a 1-wei route the Router diverted) only blocks
        // its own deposit.
        uint256 junk = _dep(vault, 1, griefer, address(0));
        _name(vault, recovery);
        vm.prank(griefer);
        vault.challengeRecovery(junk, bytes32(0));
        vm.prank(griefer);
        vm.expectRevert(QuarantineVault.NotAParty.selector);
        vault.challengeRecovery(id, bytes32(0));
        vm.warp(block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW);
        (IProviderRegistry.Decision memory r, bytes[] memory rs) = _rel(id, QuarantineVault.Beneficiary.RECOVERY);
        vault.release(r, rs);
        assertEq(recovery.balance, 10 ether);
    }

    function test_RV09_noReceiveSenderAndNoRecipient_recoveryCannotBeVetoedForever() public {
        // Router quarantines a fee-only route of a sender app without receive(); payee is zero.
        address app = address(new NoReceive());
        uint256 id = _dep(vault, 1 ether, app, address(0));
        (IProviderRegistry.Decision memory r, bytes[] memory rs) = _rel(id, QuarantineVault.Beneficiary.SENDER);
        vm.expectRevert(QuarantineVault.TransferFailed.selector);
        vault.release(r, rs);
        (r, rs) = _rel(id, QuarantineVault.Beneficiary.RECIPIENT);
        vm.expectRevert(QuarantineVault.ForbiddenBeneficiary.selector);
        vault.release(r, rs);
        // The blacklisted party itself (the deposit's sender) challenges the recovery address...
        _name(vault, recovery);
        vm.prank(app);
        vault.challengeRecovery(id, keccak256("mine"));
        vm.warp(block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW);
        (r, rs) = _rel(id, QuarantineVault.Beneficiary.RECOVERY);
        vm.expectRevert(QuarantineVault.RecoveryNotReady.selector);
        vault.release(r, rs);
        // ...which escalates to a supermajority override after a second window, not to a permanent lock.
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        (r, rs) = _rel(id, QuarantineVault.Beneficiary.RECOVERY_OVER_CHALLENGE);
        vault.release(r, rs);
        assertEq(recovery.balance, 1 ether);
    }

    // ═════════════════════════════════════════════════════════════════════
    // RV-10 (Info, fixed): the vault honours effectiveAt
    // ═════════════════════════════════════════════════════════════════════

    function test_RV10_vaultHonoursEffectiveAt() public {
        uint256 id = _dep(vault, 1 ether, sender, recipient);
        IProviderRegistry.Decision memory d =
            _vaultDecision(reg, A_VAULT_RELEASE, abi.encode(id, CASE, uint8(QuarantineVault.Beneficiary.SENDER)));
        d.effectiveAt = uint64(block.timestamp + 30 days);
        d.validUntil = uint64(block.timestamp + 60 days);
        bytes[] memory s = _sign(address(vault), d, K);
        vm.expectRevert(QuarantineVault.NotYetEffective.selector);
        vault.release(d, s);
        vm.warp(d.effectiveAt);
        vault.release(d, s);
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
        bytes[] memory ns = _sign(address(vault), n, K + 1);
        vm.expectRevert(QuarantineVault.ForbiddenBeneficiary.selector);
        vault.nameRecovery(n, ns);
        for (uint256 i = 0; i < 2; i++) {
            address bad = i == 0 ? address(vault) : address(reg);
            n = _vaultDecision(reg, A_VAULT_NAME_RECOVERY, abi.encode(CASE, bad));
            ns = _sign(address(vault), n, K + 1);
            vm.expectRevert(QuarantineVault.ForbiddenBeneficiary.selector);
            vault.nameRecovery(n, ns);
        }
    }

    function test_ok_noReleaseWithoutOrWithWrongCase() public {
        uint256 id = _dep(vault, 1 ether, sender, recipient);
        IProviderRegistry.Decision memory d =
            _vaultDecision(reg, A_VAULT_RELEASE, abi.encode(id, bytes32(0), uint8(0)));
        bytes[] memory s = _sign(address(vault), d, K);
        vm.expectRevert(QuarantineVault.CaseMismatch.selector);
        vault.release(d, s);
        d = _vaultDecision(reg, A_VAULT_RELEASE, abi.encode(id, keccak256("other"), uint8(0)));
        s = _sign(address(vault), d, K);
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
        bytes[] memory cs = _sign(address(vault), c, K);
        vm.expectRevert(QuarantineVault.WrongAction.selector);
        vault.release(c, cs);
    }

    function test_ok_vaultReleaseNeedsKFromCurrentEpoch() public {
        uint256 id = _dep(vault, 1 ether, sender, recipient);
        (IProviderRegistry.Decision memory r,) = _rel(id, QuarantineVault.Beneficiary.SENDER);
        r.validUntil = uint64(block.timestamp + 30 days); // outlives the rotation's notice
        bytes[] memory few = _sign(address(vault), r, K - 1);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K - 1, K));
        vault.release(r, few);
        // Rotation invalidates an unrelayed release signed by the old epoch.
        uint256[] memory keep = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) {
            keep[i] = memberPks[i + 1];
        }
        _rotate(reg, keep, 3);
        bytes[] memory full = _sign(address(vault), r, K);
        vm.expectRevert(ProviderRegistry.WrongEpoch.selector);
        vault.release(r, full);
    }

    receive() external payable {}
}
