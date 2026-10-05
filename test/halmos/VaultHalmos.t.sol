// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SymTest} from "halmos-cheatcodes/SymTest.sol";
import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {QuarantineVault} from "@clprouter/QuarantineVault.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";

/// @dev Registry stand-in for the vault's own release logic: approves every signature set (quorum is proven
///      separately against the real registry, below and in RegistryHalmos) and answers `isProviderAccount` for
///      four committee members.
contract ApprovingRegistry {
    bytes32 public constant DEPLOYMENT_ID = bytes32(uint256(1));
    mapping(address => bool) public isProviderAccount;

    constructor(address[] memory m) {
        for (uint256 i = 0; i < m.length; i++) {
            isProviderAccount[m[i]] = true;
        }
    }

    function requiredSignatures(uint8) external pure returns (uint256) {
        return 0;
    }

    function checkApproval(bytes32, uint64, bytes[] calldata, uint256) external pure {}
}

/// @dev Registry stand-in that applies the real quorum table (4 members, k = 3) and records the quorum the vault
///      asks `checkApproval` to enforce.
contract RecordingRegistry {
    bytes32 public constant DEPLOYMENT_ID = bytes32(uint256(1));
    uint256 public asked;

    function isProviderAccount(address) external pure returns (bool) {
        return false;
    }

    function requiredSignatures(uint8 action) external pure returns (uint256) {
        if (action == 7) return 4; // committee: max(k + 1, ceil(2n/3))
        if (action == 10 || action == 12) return 4; // k + 1
        return 3; // k
    }

    function checkApproval(bytes32, uint64, bytes[] calldata, uint256 required) external {
        asked = required;
    }
}

/// @title Symbolic proofs: the quarantine vault never pays the provider and releases each deposit at most once
/// @notice Run with `halmos` (see docs/quality.md). The vault's storage is fully symbolic in the release proofs,
///         so they hold from every vault state: any deposits, any recovery naming, any challenge, any bound
///         Router, any time. Those proofs use a registry that approves every decision, so they hold even if a
///         quorum signs a bad decision; that decisions need a quorum is proven against the real registry
///         (4 members, k = 3: release 3, naming / binding 4, release over a challenge 4).
contract VaultHalmos is Test, SymTest {
    uint64[6] internal NOTICES = [uint64(7 days), 72 hours, 7 days, 7 days, 30 days, 7 days];
    uint8 internal constant A_VAULT_RELEASE = 9;
    uint8 internal constant A_VAULT_NAME_RECOVERY = 10;
    uint8 internal constant A_VAULT_BIND_ROUTER = 12;

    ProviderRegistry internal registry;
    QuarantineVault internal vault;
    ApprovingRegistry internal approving;
    QuarantineVault internal logicVault; // vault bound to the approving registry
    address[] internal members;

    function setUp() public {
        members = new address[](4);
        for (uint256 i = 0; i < 4; i++) {
            members[i] = address(uint160(0x1000 + i));
        }
        registry = new ProviderRegistry(bytes32(uint256(1)), members, 3, "c", NOTICES);
        vault = new QuarantineVault(IProviderRegistry(address(registry)), 1 days, 3 days);
        approving = new ApprovingRegistry(members);
        logicVault = new QuarantineVault(IProviderRegistry(address(approving)), 1 days, 3 days);
    }

    function _decision(uint8 action, bytes memory payload) internal returns (IProviderRegistry.Decision memory) {
        return IProviderRegistry.Decision({
            action: action,
            payload: payload,
            evidenceHash: svm.createBytes32("evidence"),
            nonce: uint64(svm.createUint(64, "nonce")),
            effectiveAt: uint64(svm.createUint(64, "effectiveAt")),
            validUntil: uint64(svm.createUint(64, "validUntil")),
            epoch: uint64(svm.createUint(64, "epoch"))
        });
    }

    /// @notice From any vault state, a successful release pays exactly the deposit's amount, to an address that is
    ///         not a committee member (past, present or scheduled: `isProviderAccount`), not the registry and not
    ///         the vault, and marks the deposit released. Covers every beneficiary kind (sender, recipient,
    ///         recovery, recovery over a challenge).
    function check_release_neverPaysProviderAndPaysOnce(uint256 depositId, bytes32 caseId, uint8 kind, uint256 bal)
        public
    {
        svm.enableSymbolicStorage(address(logicVault));
        vm.deal(address(logicVault), bal);
        vm.warp(svm.createUint(64, "now"));
        IProviderRegistry.Decision memory d = _decision(A_VAULT_RELEASE, abi.encode(depositId, caseId, kind));
        bytes[] memory sigs = new bytes[](0);

        (,,,,, uint256 amount, bool releasedBefore) = logicVault.deposits(depositId);
        uint256[4] memory mb;
        for (uint256 i = 0; i < 4; i++) {
            mb[i] = members[i].balance;
        }
        uint256 regBal = address(approving).balance;

        (bool ok,) = address(logicVault).call(abi.encodeCall(logicVault.release, (d, sigs)));
        if (ok) {
            assert(!releasedBefore);
            (,,,,,, bool releasedAfter) = logicVault.deposits(depositId);
            assert(releasedAfter);
            assert(amount > 0);
            assert(address(logicVault).balance == bal - amount);
            for (uint256 i = 0; i < 4; i++) {
                assert(members[i].balance == mb[i]);
            }
            assert(address(approving).balance == regBal);
        }
    }

    /// @notice From any vault state, a release to the recovery address (with or without a challenge override)
    ///         happens only once the deposit's own window has passed: `RECOVERY_NOTICE + CHALLENGE_WINDOW` after
    ///         the naming and after the deposit itself, whichever is later.
    function check_recoveryRelease_waitsForDepositWindow(uint256 depositId, bytes32 caseId, uint8 kind) public {
        svm.enableSymbolicStorage(address(logicVault));
        vm.deal(address(logicVault), svm.createUint(128, "bal"));
        uint256 t = svm.createUint(64, "now");
        vm.warp(t);
        uint64 depositedAt = logicVault.depositedAt(depositId);
        (,, uint64 caseAt) = logicVault.recoveries(caseId);
        IProviderRegistry.Decision memory d = _decision(A_VAULT_RELEASE, abi.encode(depositId, caseId, kind));
        (bool ok,) = address(logicVault).call(abi.encodeCall(logicVault.release, (d, new bytes[](0))));
        if (ok && kind >= 2) {
            assert(t >= uint256(depositedAt) + 1 days + 3 days);
            assert(t >= caseAt);
        }
    }

    /// @notice A released deposit can never be released again, by any decision.
    function check_release_releasedDepositIsFinal(uint256 depositId, bytes32 caseId, uint8 kind) public {
        svm.enableSymbolicStorage(address(logicVault));
        vm.warp(svm.createUint(64, "now"));
        (,,,,,, bool released) = logicVault.deposits(depositId);
        vm.assume(released);
        IProviderRegistry.Decision memory d = _decision(A_VAULT_RELEASE, abi.encode(depositId, caseId, kind));
        (bool ok,) = address(logicVault).call(abi.encodeCall(logicVault.release, (d, new bytes[](0))));
        assert(!ok);
    }

    /// @notice Every vault decision is checked against the right quorum: a release to the sender, recipient or
    ///         recovery address k (3), a release over a challenge the committee-change supermajority (4), a
    ///         recovery naming and a Router binding k + 1 (4). Together with RegistryHalmos (checkApproval rejects
    ///         fewer than `required` distinct members; the quorum table) nothing moves below quorum. From any
    ///         vault state.
    function check_vaultDecisions_askRightQuorum(uint256 depositId, bytes32 caseId, uint8 kind, address to, uint8 op)
        public
    {
        RecordingRegistry rec = new RecordingRegistry();
        QuarantineVault v = new QuarantineVault(IProviderRegistry(address(rec)), 1 days, 3 days);
        svm.enableSymbolicStorage(address(v));
        vm.deal(address(v), svm.createUint(128, "bal"));
        vm.warp(svm.createUint(64, "now"));
        bool ok;
        uint256 expected;
        if (op == 0) {
            IProviderRegistry.Decision memory d = _decision(A_VAULT_RELEASE, abi.encode(depositId, caseId, kind));
            (ok,) = address(v).call(abi.encodeCall(v.release, (d, new bytes[](0))));
            expected = kind == 3 ? 4 : 3;
        } else if (op == 1) {
            IProviderRegistry.Decision memory n = _decision(A_VAULT_NAME_RECOVERY, abi.encode(caseId, to));
            (ok,) = address(v).call(abi.encodeCall(v.nameRecovery, (n, new bytes[](0))));
            expected = 4;
        } else {
            IProviderRegistry.Decision memory b = _decision(A_VAULT_BIND_ROUTER, abi.encode(to));
            (ok,) = address(v).call(abi.encodeCall(v.bindRouter, (b, new bytes[](0))));
            expected = 4;
        }
        if (ok) assert(rec.asked() == expected);
    }

    /// @notice A recovery address can never be a provider account, the registry, the vault or zero, even with
    ///         every signature approved.
    function check_nameRecovery_rejectsForbiddenBeneficiaries(bytes32 caseId, uint8 which) public {
        vm.warp(svm.createUint(64, "now"));
        address to;
        if (which < 4) to = members[which];
        else if (which == 4) to = address(approving);
        else if (which == 5) to = address(logicVault);
        else to = address(0);
        IProviderRegistry.Decision memory n = _decision(A_VAULT_NAME_RECOVERY, abi.encode(caseId, to));
        (bool ok,) = address(logicVault).call(abi.encodeCall(logicVault.nameRecovery, (n, new bytes[](0))));
        assert(!ok);
    }

    /// @notice Deposits: only the bound Router once bound, never without a case or value, and the vault balance
    ///         grows by exactly the deposit.
    function check_deposit_accounting(bytes16 routeId, bytes32 caseId, address sender, address recipient) public {
        svm.enableSymbolicStorage(address(vault));
        address caller = svm.createAddress("caller");
        vm.assume(caller != address(vault));
        uint256 value = svm.createUint(96, "value");
        vm.deal(caller, value);
        uint256 before = address(vault).balance;
        uint256 count = vault.depositCount();
        vm.assume(count < type(uint256).max);
        address bound = vault.router();
        vm.prank(caller);
        (bool ok,) =
            address(vault).call{value: value}(abi.encodeCall(vault.deposit, (routeId, caseId, sender, recipient)));
        if (ok) {
            assert(bound == address(0) || caller == bound);
            assert(caseId != bytes32(0) && value > 0);
            assert(address(vault).balance == before + value);
            (,,,,, uint256 amount, bool released) = vault.deposits(count + 1);
            assert(amount == value && !released);
        }
    }
}
