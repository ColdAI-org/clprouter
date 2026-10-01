// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IProviderRegistry} from "./interfaces/IProviderRegistry.sol";

/// @title QuarantineVault
/// @notice Holds funds a CLPRouter diverted because a sender or recipient is blacklisted.
///         One vault per ledger. Funds stay in their original (native) asset and are recorded per deposit
///         against the route id and case id.
/// @dev Fixed release rules, enforced here and not by policy:
///        - a release needs a committee decision (k of n, verified through the registry);
///        - funds go only to the deposit's original sender, its original recipient, or a recovery address the
///          committee named for the case; a recovery release waits `RECOVERY_NOTICE` + `CHALLENGE_WINDOW`, and
///          the sender or recipient can challenge during that time, which blocks that recovery address;
///        - nothing goes to a provider account (any past or present committee member), the registry or the
///          vault itself, and nothing moves without a case id;
///        - every deposit, naming, challenge and release is an event.
contract QuarantineVault {
    uint8 internal constant ACTION_VAULT_RELEASE = 9;
    uint8 internal constant ACTION_VAULT_NAME_RECOVERY = 10;

    enum Beneficiary {
        SENDER,
        RECIPIENT,
        RECOVERY
    }

    struct Deposit {
        bytes16 routeId;
        bytes32 caseId;
        address depositor;
        address sender;
        address recipient;
        uint256 amount;
        bool released;
    }

    struct Recovery {
        address to;
        uint64 namedAt;
        uint64 releasableAt;
        bool challenged;
    }

    error NoCase();
    error NoFunds();
    error UnknownDeposit();
    error AlreadyReleased();
    error CaseMismatch();
    error DecisionAlreadyUsed();
    error DecisionExpired();
    error MissingEvidence();
    error WrongAction();
    error ForbiddenBeneficiary();
    error RecoveryNotReady();
    error ChallengeClosed();
    error NotAParty();
    error TransferFailed();

    event Deposited(
        uint256 indexed depositId,
        bytes16 indexed routeId,
        bytes32 indexed caseId,
        address depositor,
        address sender,
        address recipient,
        uint256 amount
    );
    event RecoveryNamed(bytes32 indexed caseId, address to, uint64 releasableAt, bytes32 evidenceHash, bytes32 digest);
    event RecoveryChallenged(bytes32 indexed caseId, address indexed by, bytes32 evidenceHash);
    event Released(
        uint256 indexed depositId,
        bytes32 indexed caseId,
        address indexed to,
        Beneficiary kind,
        uint256 amount,
        bytes32 evidenceHash,
        bytes32 digest
    );

    IProviderRegistry public immutable REGISTRY;
    uint64 public immutable RECOVERY_NOTICE;
    uint64 public immutable CHALLENGE_WINDOW;

    uint256 public depositCount;
    mapping(uint256 => Deposit) public deposits;
    mapping(bytes32 => Recovery) public recoveries;
    mapping(bytes32 => bool) public used;

    constructor(IProviderRegistry registry, uint64 recoveryNotice, uint64 challengeWindow) {
        REGISTRY = registry;
        RECOVERY_NOTICE = recoveryNotice;
        CHALLENGE_WINDOW = challengeWindow;
    }

    /// @notice Record diverted funds. Called by Routers; anyone may call (a depositor can only lock its own funds).
    /// @param routeId Route the funds belonged to.
    /// @param caseId Blacklist case that caused the diversion (required).
    /// @param sender Original sender of the funds on this ledger.
    /// @param recipient Original recipient of the funds on this ledger (zero if none on this ledger).
    /// @return depositId Id of the new deposit.
    function deposit(bytes16 routeId, bytes32 caseId, address sender, address recipient)
        external
        payable
        returns (uint256 depositId)
    {
        if (caseId == bytes32(0)) revert NoCase();
        if (msg.value == 0) revert NoFunds();
        depositId = ++depositCount;
        deposits[depositId] = Deposit({
            routeId: routeId,
            caseId: caseId,
            depositor: msg.sender,
            sender: sender,
            recipient: recipient,
            amount: msg.value,
            released: false
        });
        emit Deposited(depositId, routeId, caseId, msg.sender, sender, recipient, msg.value);
    }

    /// @notice Name a recovery address for a case (committee decision, payload `(bytes32 caseId, address to)`).
    ///         Starts the notice period and challenge window.
    function nameRecovery(IProviderRegistry.Decision calldata d, bytes[] calldata sigs) external {
        bytes32 digest = _consume(d, sigs, ACTION_VAULT_NAME_RECOVERY);
        (bytes32 caseId, address to) = abi.decode(d.payload, (bytes32, address));
        if (caseId == bytes32(0)) revert NoCase();
        _checkBeneficiary(to);
        uint64 releasableAt = uint64(block.timestamp) + RECOVERY_NOTICE + CHALLENGE_WINDOW;
        recoveries[caseId] =
            Recovery({to: to, namedAt: uint64(block.timestamp), releasableAt: releasableAt, challenged: false});
        emit RecoveryNamed(caseId, to, releasableAt, d.evidenceHash, digest);
    }

    /// @notice Challenge the recovery address named for the case of `depositId`. Only the deposit's original
    ///         sender or recipient may challenge, and only before the window closes. A challenge blocks that
    ///         recovery address; the committee can still release to the sender or recipient, or name a new one.
    function challengeRecovery(uint256 depositId, bytes32 evidenceHash) external {
        Deposit storage dep = deposits[depositId];
        if (dep.amount == 0) revert UnknownDeposit();
        if (msg.sender != dep.sender && msg.sender != dep.recipient) revert NotAParty();
        Recovery storage r = recoveries[dep.caseId];
        if (r.to == address(0) || block.timestamp >= r.releasableAt) revert ChallengeClosed();
        r.challenged = true;
        emit RecoveryChallenged(dep.caseId, msg.sender, evidenceHash);
    }

    /// @notice Release a deposit (committee decision, payload `(uint256 depositId, bytes32 caseId, uint8 kind)`).
    function release(IProviderRegistry.Decision calldata d, bytes[] calldata sigs) external {
        bytes32 digest = _consume(d, sigs, ACTION_VAULT_RELEASE);
        (uint256 depositId, bytes32 caseId, uint8 kindRaw) = abi.decode(d.payload, (uint256, bytes32, uint8));
        Beneficiary kind = Beneficiary(kindRaw);
        Deposit storage dep = deposits[depositId];
        if (dep.amount == 0) revert UnknownDeposit();
        if (dep.released) revert AlreadyReleased();
        if (caseId == bytes32(0) || dep.caseId != caseId) revert CaseMismatch();

        address to;
        if (kind == Beneficiary.SENDER) {
            to = dep.sender;
        } else if (kind == Beneficiary.RECIPIENT) {
            to = dep.recipient;
        } else {
            Recovery storage r = recoveries[caseId];
            if (r.to == address(0) || r.challenged || block.timestamp < r.releasableAt) revert RecoveryNotReady();
            to = r.to;
        }
        _checkBeneficiary(to);

        dep.released = true;
        uint256 amount = dep.amount;
        emit Released(depositId, caseId, to, kind, amount, d.evidenceHash, digest);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _consume(IProviderRegistry.Decision calldata d, bytes[] calldata sigs, uint8 action)
        private
        returns (bytes32 digest)
    {
        if (d.action != action) revert WrongAction();
        if (block.timestamp > d.validUntil) revert DecisionExpired();
        if (d.evidenceHash == bytes32(0)) revert MissingEvidence();
        digest = REGISTRY.decisionDigest(d);
        if (used[digest]) revert DecisionAlreadyUsed();
        REGISTRY.checkApproval(digest, d.epoch, sigs, REGISTRY.requiredSignatures(action));
        used[digest] = true;
    }

    function _checkBeneficiary(address to) private view {
        if (to == address(0) || to == address(this) || to == address(REGISTRY) || REGISTRY.isProviderAccount(to)) {
            revert ForbiddenBeneficiary();
        }
    }
}
