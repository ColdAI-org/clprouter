// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {QuarantineVault} from "@clprouter/QuarantineVault.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {Committee} from "../helpers/Committee.sol";

contract QuarantineVaultTest is Committee {
    ProviderRegistry internal reg;
    QuarantineVault internal vault;
    uint64 internal constant RECOVERY_NOTICE = 3 days;
    uint64 internal constant CHALLENGE_WINDOW = 7 days;
    bytes32 internal constant CASE = keccak256("case-42");
    bytes16 internal constant ROUTE = bytes16(keccak256("route"));

    address internal sender = makeAddr("sender");
    address internal recipient = makeAddr("recipient");
    address internal recovery = makeAddr("recovery");
    uint64 internal vaultNonce;

    function setUp() public {
        vm.warp(1_800_000_000);
        _initCommittee();
        reg = _deployRegistry();
        vault = new QuarantineVault(IProviderRegistry(address(reg)), RECOVERY_NOTICE, CHALLENGE_WINDOW);
    }

    function _deposit(uint256 amount) internal returns (uint256 id) {
        vm.deal(address(this), amount);
        id = vault.deposit{value: amount}(ROUTE, CASE, sender, recipient);
    }

    function _vaultDecision(uint8 action, bytes memory payload)
        internal
        returns (IProviderRegistry.Decision memory d, bytes[] memory sigs)
    {
        d = _decision(reg, action, payload);
        d.nonce = ++vaultNonce; // vault decisions keep their own replay set
        sigs = _sign(address(vault), d, reg.requiredSignatures(action));
    }

    function _release(uint256 id, bytes32 caseId, QuarantineVault.Beneficiary kind) internal {
        (IProviderRegistry.Decision memory d, bytes[] memory sigs) =
            _vaultDecision(A_VAULT_RELEASE, abi.encode(id, caseId, uint8(kind)));
        vault.release(d, sigs);
    }

    function _nameRecovery(address to) internal {
        (IProviderRegistry.Decision memory d, bytes[] memory sigs) =
            _vaultDecision(A_VAULT_NAME_RECOVERY, abi.encode(CASE, to));
        vault.nameRecovery(d, sigs);
    }

    // ── deposits ───────────────────────────────────────────────────────────

    function test_deposit_recordsAndEmits() public {
        vm.deal(address(this), 1 ether);
        vm.expectEmit(true, true, true, true, address(vault));
        emit QuarantineVault.Deposited(1, ROUTE, CASE, address(this), sender, recipient, 1 ether);
        uint256 id = vault.deposit{value: 1 ether}(ROUTE, CASE, sender, recipient);
        (bytes16 r, bytes32 c, address dep, address s, address rc, uint256 amt, bool rel) = vault.deposits(id);
        assertEq(r, ROUTE);
        assertEq(c, CASE);
        assertEq(dep, address(this));
        assertEq(s, sender);
        assertEq(rc, recipient);
        assertEq(amt, 1 ether);
        assertFalse(rel);
    }

    function test_constructor_enforcesMinimumWindows() public {
        vm.expectRevert(QuarantineVault.InvalidParameters.selector);
        new QuarantineVault(IProviderRegistry(address(reg)), 0, CHALLENGE_WINDOW);
        vm.expectRevert(QuarantineVault.InvalidParameters.selector);
        new QuarantineVault(IProviderRegistry(address(reg)), RECOVERY_NOTICE, 3 days - 1);
        vm.expectRevert(QuarantineVault.InvalidParameters.selector);
        new QuarantineVault(IProviderRegistry(address(0)), RECOVERY_NOTICE, CHALLENGE_WINDOW);
    }

    function test_bindRouter_onceWithKPlusOne_thenOnlyRouterDeposits() public {
        address router = makeAddr("router");
        IProviderRegistry.Decision memory d = _decision(reg, 12, abi.encode(router));
        d.nonce = ++vaultNonce;
        bytes[] memory few = _sign(address(vault), d, K);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K, K + 1));
        vault.bindRouter(d, few);
        vault.bindRouter(d, _sign(address(vault), d, K + 1));
        assertEq(vault.router(), router);

        vm.deal(address(this), 1 ether);
        vm.expectRevert(QuarantineVault.NotRouter.selector);
        vault.deposit{value: 1 ether}(ROUTE, CASE, sender, recipient);
        vm.deal(router, 1 ether);
        vm.prank(router);
        vault.deposit{value: 1 ether}(ROUTE, CASE, sender, recipient);

        (IProviderRegistry.Decision memory d2, bytes[] memory s2) = _vaultDecision(12, abi.encode(address(this)));
        vm.expectRevert(QuarantineVault.AlreadyBound.selector);
        vault.bindRouter(d2, s2);
    }

    function test_decisionsBindToThisVault() public {
        QuarantineVault other = new QuarantineVault(IProviderRegistry(address(reg)), RECOVERY_NOTICE, CHALLENGE_WINDOW);
        uint256 id = _deposit(1 ether);
        vm.deal(address(this), 1 ether);
        other.deposit{value: 1 ether}(ROUTE, CASE, sender, recipient);
        (IProviderRegistry.Decision memory d, bytes[] memory sigs) =
            _vaultDecision(A_VAULT_RELEASE, abi.encode(id, CASE, uint8(0)));
        assertTrue(vault.decisionDigest(d) != other.decisionDigest(d));
        vm.expectRevert(ProviderRegistry.BadSignature.selector);
        other.release(d, sigs);
        vault.release(d, sigs);
    }

    function test_release_waitsForEffectiveAt() public {
        uint256 id = _deposit(1 ether);
        IProviderRegistry.Decision memory d = _decision(reg, A_VAULT_RELEASE, abi.encode(id, CASE, uint8(0)));
        d.nonce = ++vaultNonce;
        d.effectiveAt = uint64(block.timestamp + 2 days);
        d.validUntil = uint64(block.timestamp + 3 days);
        bytes[] memory sigs = _sign(address(vault), d, K);
        vm.expectRevert(QuarantineVault.NotYetEffective.selector);
        vault.release(d, sigs);
        vm.warp(d.effectiveAt);
        vault.release(d, sigs);
        assertEq(sender.balance, 1 ether);
    }

    function test_nameRecovery_needsKPlusOne() public {
        IProviderRegistry.Decision memory d = _decision(reg, A_VAULT_NAME_RECOVERY, abi.encode(CASE, recovery));
        d.nonce = ++vaultNonce;
        bytes[] memory sigs = _sign(address(vault), d, K);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K, K + 1));
        vault.nameRecovery(d, sigs);
    }

    function test_deposit_requiresCaseAndFunds() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(QuarantineVault.NoCase.selector);
        vault.deposit{value: 1 ether}(ROUTE, bytes32(0), sender, recipient);
        vm.expectRevert(QuarantineVault.NoFunds.selector);
        vault.deposit(ROUTE, CASE, sender, recipient);
    }

    // ── releases to the original parties ───────────────────────────────────

    function test_release_toOriginalSender() public {
        uint256 id = _deposit(1 ether);
        _release(id, CASE, QuarantineVault.Beneficiary.SENDER);
        assertEq(sender.balance, 1 ether);
    }

    function test_release_toOriginalRecipient_falsePositive() public {
        uint256 id = _deposit(1 ether);
        _release(id, CASE, QuarantineVault.Beneficiary.RECIPIENT);
        assertEq(recipient.balance, 1 ether);
    }

    function test_release_onlyOnce() public {
        uint256 id = _deposit(1 ether);
        _release(id, CASE, QuarantineVault.Beneficiary.SENDER);
        (IProviderRegistry.Decision memory d, bytes[] memory sigs) =
            _vaultDecision(A_VAULT_RELEASE, abi.encode(id, CASE, uint8(1)));
        vm.expectRevert(QuarantineVault.AlreadyReleased.selector);
        vault.release(d, sigs);
    }

    function test_release_wrongCase() public {
        uint256 id = _deposit(1 ether);
        (IProviderRegistry.Decision memory d, bytes[] memory sigs) =
            _vaultDecision(A_VAULT_RELEASE, abi.encode(id, keccak256("other"), uint8(0)));
        vm.expectRevert(QuarantineVault.CaseMismatch.selector);
        vault.release(d, sigs);
        (d, sigs) = _vaultDecision(A_VAULT_RELEASE, abi.encode(id, bytes32(0), uint8(0)));
        vm.expectRevert(QuarantineVault.CaseMismatch.selector);
        vault.release(d, sigs);
    }

    function test_release_unknownDeposit() public {
        (IProviderRegistry.Decision memory d, bytes[] memory sigs) =
            _vaultDecision(A_VAULT_RELEASE, abi.encode(uint256(7), CASE, uint8(0)));
        vm.expectRevert(QuarantineVault.UnknownDeposit.selector);
        vault.release(d, sigs);
    }

    function test_release_insufficientSignatures() public {
        uint256 id = _deposit(1 ether);
        IProviderRegistry.Decision memory d = _decision(reg, A_VAULT_RELEASE, abi.encode(id, CASE, uint8(0)));
        bytes[] memory sigs = _sign(address(vault), d, K - 1);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K - 1, K));
        vault.release(d, sigs);
    }

    function test_release_replayedDecision() public {
        uint256 id = _deposit(1 ether);
        _deposit(1 ether);
        (IProviderRegistry.Decision memory d, bytes[] memory sigs) =
            _vaultDecision(A_VAULT_NAME_RECOVERY, abi.encode(CASE, recovery));
        vault.nameRecovery(d, sigs);
        vm.expectRevert(QuarantineVault.DecisionAlreadyUsed.selector);
        vault.nameRecovery(d, sigs);
        id; // silence
    }

    function test_release_wrongActionType() public {
        uint256 id = _deposit(1 ether);
        (IProviderRegistry.Decision memory d, bytes[] memory sigs) =
            _vaultDecision(A_VAULT_NAME_RECOVERY, abi.encode(id, CASE, uint8(0)));
        vm.expectRevert(QuarantineVault.WrongAction.selector);
        vault.release(d, sigs);
    }

    function test_release_expiredDecision() public {
        uint256 id = _deposit(1 ether);
        (IProviderRegistry.Decision memory d, bytes[] memory sigs) =
            _vaultDecision(A_VAULT_RELEASE, abi.encode(id, CASE, uint8(0)));
        vm.warp(d.validUntil + 1);
        vm.expectRevert(QuarantineVault.DecisionExpired.selector);
        vault.release(d, sigs);
    }

    // ── recovery address ───────────────────────────────────────────────────

    function test_recovery_onlyAfterNoticeAndChallengeWindow() public {
        uint256 id = _deposit(1 ether);
        _nameRecovery(recovery);
        (IProviderRegistry.Decision memory d, bytes[] memory sigs) =
            _vaultDecision(A_VAULT_RELEASE, abi.encode(id, CASE, uint8(2)));
        vm.expectRevert(QuarantineVault.RecoveryNotReady.selector);
        vault.release(d, sigs);
        vm.warp(block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW - 1);
        (d, sigs) = _vaultDecision(A_VAULT_RELEASE, abi.encode(id, CASE, uint8(2)));
        vm.expectRevert(QuarantineVault.RecoveryNotReady.selector);
        vault.release(d, sigs);
        vm.warp(block.timestamp + 1);
        vault.release(d, sigs);
        assertEq(recovery.balance, 1 ether);
    }

    function test_recovery_challengedByPartyIsBlocked() public {
        uint256 id = _deposit(1 ether);
        _nameRecovery(recovery);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(QuarantineVault.NotAParty.selector);
        vault.challengeRecovery(id, keccak256("objection"));

        vm.warp(block.timestamp + RECOVERY_NOTICE + 1);
        vm.prank(recipient);
        vault.challengeRecovery(id, keccak256("objection"));
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        (IProviderRegistry.Decision memory d, bytes[] memory sigs) =
            _vaultDecision(A_VAULT_RELEASE, abi.encode(id, CASE, uint8(2)));
        vm.expectRevert(QuarantineVault.RecoveryNotReady.selector);
        vault.release(d, sigs);
        // the original parties can still be paid
        _release(id, CASE, QuarantineVault.Beneficiary.RECIPIENT);
        assertEq(recipient.balance, 1 ether);
    }

    function test_recovery_challengePersists_overrideNeedsSupermajorityAndSecondWindow() public {
        uint256 id = _deposit(1 ether);
        uint256 other = _deposit(1 ether);
        _nameRecovery(recovery);
        vm.prank(sender);
        vault.challengeRecovery(id, keccak256("objection"));
        _nameRecovery(recovery); // naming the same address again does not lift the challenge
        assertGt(vault.challengedAt(id, recovery), 0);
        vm.warp(block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW);
        (IProviderRegistry.Decision memory d, bytes[] memory sigs) =
            _vaultDecision(A_VAULT_RELEASE, abi.encode(id, CASE, uint8(2)));
        vm.expectRevert(QuarantineVault.RecoveryNotReady.selector);
        vault.release(d, sigs);
        // The challenge is scoped to the challenger's own deposit.
        _release(other, CASE, QuarantineVault.Beneficiary.RECOVERY);
        assertEq(recovery.balance, 1 ether);

        // Override: kind 3, supermajority, and only after one more window.
        IProviderRegistry.Decision memory o = _decision(reg, A_VAULT_RELEASE, abi.encode(id, CASE, uint8(3)));
        o.nonce = ++vaultNonce;
        o.validUntil = uint64(block.timestamp + 30 days);
        bytes[] memory kp1 = _sign(address(vault), o, K);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K, K + 1));
        vault.release(o, kp1);
        bytes[] memory sup = _sign(address(vault), o, reg.requiredSignatures(7));
        vm.expectRevert(QuarantineVault.RecoveryNotReady.selector);
        vault.release(o, sup);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        vault.release(o, sup);
        assertEq(recovery.balance, 2 ether);
    }

    function test_recovery_overrideOnlyForChallengedDeposit() public {
        uint256 id = _deposit(1 ether);
        _nameRecovery(recovery);
        vm.warp(block.timestamp + RECOVERY_NOTICE + 2 * CHALLENGE_WINDOW);
        IProviderRegistry.Decision memory d = _decision(reg, A_VAULT_RELEASE, abi.encode(id, CASE, uint8(3)));
        d.nonce = ++vaultNonce;
        bytes[] memory sigs = _sign(address(vault), d, reg.requiredSignatures(7));
        vm.expectRevert(QuarantineVault.NotChallenged.selector);
        vault.release(d, sigs);
    }

    function test_recovery_challengeAfterWindowRejected() public {
        uint256 id = _deposit(1 ether);
        _nameRecovery(recovery);
        vm.warp(block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW);
        vm.prank(sender);
        vm.expectRevert(QuarantineVault.ChallengeClosed.selector);
        vault.challengeRecovery(id, keccak256("late"));
    }

    function test_recovery_neverToProviderAccounts() public {
        _deposit(1 ether);
        (IProviderRegistry.Decision memory d, bytes[] memory sigs) =
            _vaultDecision(A_VAULT_NAME_RECOVERY, abi.encode(CASE, memberAddrs[0]));
        vm.expectRevert(QuarantineVault.ForbiddenBeneficiary.selector);
        vault.nameRecovery(d, sigs);
        (d, sigs) = _vaultDecision(A_VAULT_NAME_RECOVERY, abi.encode(CASE, address(reg)));
        vm.expectRevert(QuarantineVault.ForbiddenBeneficiary.selector);
        vault.nameRecovery(d, sigs);
        (d, sigs) = _vaultDecision(A_VAULT_NAME_RECOVERY, abi.encode(CASE, address(vault)));
        vm.expectRevert(QuarantineVault.ForbiddenBeneficiary.selector);
        vault.nameRecovery(d, sigs);
    }

    function test_release_neverToProviderEvenIfOriginalParty() public {
        vm.deal(address(this), 1 ether);
        uint256 id = vault.deposit{value: 1 ether}(ROUTE, CASE, memberAddrs[1], recipient);
        (IProviderRegistry.Decision memory d, bytes[] memory sigs) =
            _vaultDecision(A_VAULT_RELEASE, abi.encode(id, CASE, uint8(0)));
        vm.expectRevert(QuarantineVault.ForbiddenBeneficiary.selector);
        vault.release(d, sigs);
    }

    function test_recovery_requiresCase() public {
        (IProviderRegistry.Decision memory d, bytes[] memory sigs) =
            _vaultDecision(A_VAULT_NAME_RECOVERY, abi.encode(bytes32(0), recovery));
        vm.expectRevert(QuarantineVault.NoCase.selector);
        vault.nameRecovery(d, sigs);
    }

    function test_releaseEmitsEvent() public {
        uint256 id = _deposit(1 ether);
        (IProviderRegistry.Decision memory d, bytes[] memory sigs) =
            _vaultDecision(A_VAULT_RELEASE, abi.encode(id, CASE, uint8(0)));
        vm.expectEmit(true, true, true, false, address(vault));
        emit QuarantineVault.Released(id, CASE, sender, QuarantineVault.Beneficiary.SENDER, 1 ether, EVIDENCE, 0);
        vault.release(d, sigs);
    }

    receive() external payable {}
}
