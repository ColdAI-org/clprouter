// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {QuarantineVault} from "@clprouter/QuarantineVault.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {AuditBase} from "./AuditBase.sol";

/// @notice Recovery windows per deposit, and the vault's quorums during a committee hand-over.
contract VaultWindowsAndQuorumsTest is AuditBase {
    ProviderRegistry internal reg;
    QuarantineVault internal vault;
    address internal recovery = makeAddr("recovery");

    function setUp() public {
        vm.warp(1_800_000_000);
        _initCommittee();
        reg = _deployRegistry();
        vault = _newVault(reg);
        _bind(reg, vault, address(this)); // this test stands in for the ledger's Router
    }

    function _dep(uint256 amt, address s, address r) internal returns (uint256) {
        vm.deal(address(this), address(this).balance + amt);
        return vault.deposit{value: amt}(ROUTE, CASE, s, r);
    }

    function _name(address to) internal {
        IProviderRegistry.Decision memory n = _vaultDecision(reg, A_VAULT_NAME_RECOVERY, abi.encode(CASE, to));
        vault.nameRecovery(n, _sign(address(vault), n, K + 1));
    }

    function _releaseDecision(uint256 id, QuarantineVault.Beneficiary kind)
        internal
        returns (IProviderRegistry.Decision memory d)
    {
        d = _vaultDecision(reg, A_VAULT_RELEASE, abi.encode(id, CASE, uint8(kind)));
        d.validUntil = type(uint64).max; // (via-IR caches block.timestamp across vm.warp in the helper)
    }

    // ═════════════════════════════════════════════════════════════════════
    // Every deposit gets its own full challenge window
    // ═════════════════════════════════════════════════════════════════════

    /// @dev A deposit made long after its case's recovery address was named can still be challenged by its
    ///      parties, and is not releasable to the recovery address before its own notice and window have passed.
    function test_lateDepositGetsItsOwnChallengeWindow() public {
        _dep(1 ether, makeAddr("first-sender"), address(0));
        _name(recovery);
        vm.warp(block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW + 30 days);

        address innocent = makeAddr("innocent-sender");
        uint256 id = _dep(5 ether, innocent, makeAddr("listed-recipient"));
        assertEq(vault.releasableAt(id), block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW);

        IProviderRegistry.Decision memory d = _releaseDecision(id, QuarantineVault.Beneficiary.RECOVERY);
        bytes[] memory sigs = _sign(address(vault), d, K);
        vm.expectRevert(QuarantineVault.RecoveryNotReady.selector);
        vault.release(d, sigs);

        vm.prank(innocent);
        vault.challengeRecovery(id, keccak256("not my recovery address"));
        assertGt(vault.challengedAt(id, recovery), 0, "the challenge holds");

        vm.warp(block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW);
        vm.expectRevert(QuarantineVault.RecoveryNotReady.selector);
        vault.release(d, sigs); // challenged: only an override after one more window
        assertEq(recovery.balance, 0);
    }

    /// @dev A deposit made before the naming keeps the case's window; one made after starts its own.
    function test_depositWindowIsTheLaterOfNamingAndDeposit() public {
        uint256 early = _dep(1 ether, makeAddr("s1"), address(0));
        vm.warp(block.timestamp + 1 days);
        _name(recovery);
        (,, uint64 caseAt) = vault.recoveries(CASE);
        assertEq(vault.releasableAt(early), caseAt);
        vm.warp(block.timestamp + 2 days);
        uint256 late = _dep(1 ether, makeAddr("s2"), address(0));
        assertEq(vault.releasableAt(late), block.timestamp + RECOVERY_NOTICE + CHALLENGE_WINDOW);
        assertGt(vault.releasableAt(late), caseAt);

        vm.warp(caseAt);
        IProviderRegistry.Decision memory e = _releaseDecision(early, QuarantineVault.Beneficiary.RECOVERY);
        vault.release(e, _sign(address(vault), e, K));
        assertEq(recovery.balance, 1 ether, "the early deposit on the case's schedule");
        IProviderRegistry.Decision memory d = _releaseDecision(late, QuarantineVault.Beneficiary.RECOVERY);
        bytes[] memory sigs = _sign(address(vault), d, K);
        vm.expectRevert(QuarantineVault.RecoveryNotReady.selector);
        vault.release(d, sigs);
        vm.warp(vault.releasableAt(late));
        vault.release(d, sigs);
        assertEq(recovery.balance, 2 ether);
    }

    /// @dev With no recovery address named there is no recovery time either.
    function test_releasableAtIsZeroWithoutRecovery() public {
        uint256 id = _dep(1 ether, makeAddr("s"), address(0));
        assertEq(vault.releasableAt(id), 0);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Quorums: the vault applies the registry's hand-over rule
    // ═════════════════════════════════════════════════════════════════════

    /// @dev Once a scheduled committee's notice has passed, k outgoing keys can no longer release deposits (or
    ///      name recovery addresses) on a ledger where the new committee has not taken over yet: the vault asks
    ///      the registry, which then requires a supermajority for every action.
    function test_vaultActionsNeedSupermajorityAfterCommitteeNotice() public {
        uint256 id = _dep(1 ether, makeAddr("s"), makeAddr("r"));
        uint256[] memory next = new uint256[](3);
        next[0] = 0x51;
        next[1] = 0x52;
        next[2] = 0x53;
        _apply(reg, A_COMMITTEE, abi.encode(_sortedAddrs(next), uint8(2)));
        uint256 superMajority = reg.requiredSignatures(A_COMMITTEE);
        assertEq(reg.requiredSignatures(A_VAULT_RELEASE), K, "k before the notice has passed");

        vm.warp(block.timestamp + COMMITTEE_NOTICE);
        assertEq(reg.requiredSignatures(A_VAULT_RELEASE), superMajority);
        assertEq(reg.requiredSignatures(A_VAULT_NAME_RECOVERY), superMajority);

        IProviderRegistry.Decision memory d = _releaseDecision(id, QuarantineVault.Beneficiary.SENDER);
        bytes[] memory few = _sign(address(vault), d, K);
        vm.expectRevert(abi.encodeWithSelector(ProviderRegistry.InsufficientSignatures.selector, K, superMajority));
        vault.release(d, few);
        vault.release(d, _sign(address(vault), d, superMajority));
        assertEq(makeAddr("s").balance, 1 ether);
    }

    /// @dev Overriding a challenge needs the committee-change quorum, never less than the naming quorum.
    function test_challengeOverrideNeedsCommitteeChangeQuorum() public view {
        assertGe(reg.requiredSignatures(A_COMMITTEE), reg.requiredSignatures(A_VAULT_NAME_RECOVERY));
        assertGt(reg.requiredSignatures(A_COMMITTEE), reg.requiredSignatures(A_VAULT_RELEASE));
    }
}
