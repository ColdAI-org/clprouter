// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IProviderRegistry} from "./interfaces/IProviderRegistry.sol";

/// @title QuarantineVault
/// @notice Holds funds a CLPRouter diverted because a sender or recipient is blacklisted.
///         One vault per ledger. Funds stay in their original (native) asset and are recorded per deposit
///         against the route id and case id.
/// @dev Fixed release rules, enforced here and not by policy:
///        - every vault decision is signed by the registry's active committee over a digest bound to this
///          deployment, this chain id and this vault's address, so it acts on this vault only; it is not
///          acted on before its `effectiveAt` nor after its `validUntil`;
///        - deposits come only from the Router this vault is bound to, once bound (a one-time k + 1 decision);
///        - a release to the deposit's original sender or recipient needs k signatures;
///        - a recovery address for a case needs k + 1 signatures to name, and a recovery release waits
///          `RECOVERY_NOTICE` + `CHALLENGE_WINDOW` after the naming. Until then, the deposit's own sender or
///          recipient can challenge it. A challenge is per deposit and per address and is never cleared: naming the
///          same address again does not lift it. A challenged recovery is paid only by an override decision
///          signed by a supermajority of the committee (the quorum for committee changes) after one more
///          `CHALLENGE_WINDOW`;
///        - nothing goes to a provider account (any past, present or scheduled committee member), the registry or
///          the vault itself, and nothing moves without a case id;
///        - every deposit, naming, challenge and release is an event.
///      Native value only (no ERC-20 path).
contract QuarantineVault {
    uint8 internal constant ACTION_COMMITTEE = 7;
    uint8 internal constant ACTION_VAULT_RELEASE = 9;
    uint8 internal constant ACTION_VAULT_NAME_RECOVERY = 10;
    uint8 internal constant ACTION_VAULT_BIND_ROUTER = 12;

    /// @notice Floors for the immutable windows (zero would make recovery immediate and unchallengeable).
    uint64 public constant MIN_RECOVERY_NOTICE = 1 days;
    uint64 public constant MIN_CHALLENGE_WINDOW = 3 days;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)");
    bytes32 public constant VAULT_DECISION_TYPEHASH = keccak256(
        "VaultDecision(uint8 action,bytes payload,bytes32 evidenceHash,uint64 nonce,uint64 effectiveAt,uint64 validUntil,uint64 epoch)"
    );
    string public constant NAME = "CLPRouter.QuarantineVault";
    string public constant PROTOCOL_VERSION = "2";

    enum Beneficiary {
        SENDER,
        RECIPIENT,
        RECOVERY,
        /// @dev RECOVERY to an address a party of this deposit challenged (supermajority, after a second window).
        RECOVERY_OVER_CHALLENGE
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
    }

    error NoCase();
    error NoFunds();
    error UnknownDeposit();
    error AlreadyReleased();
    error CaseMismatch();
    error DecisionAlreadyUsed();
    error DecisionExpired();
    error NotYetEffective();
    error MissingEvidence();
    error WrongAction();
    error ForbiddenBeneficiary();
    error RecoveryNotReady();
    error ChallengeClosed();
    error NotAParty();
    error NotChallenged();
    error TransferFailed();
    error NotRouter();
    error AlreadyBound();
    error InvalidParameters();

    event Deposited(
        uint256 indexed depositId,
        bytes16 indexed routeId,
        bytes32 indexed caseId,
        address depositor,
        address sender,
        address recipient,
        uint256 amount
    );
    event RouterBound(address indexed router, bytes32 evidenceHash, bytes32 digest);
    event RecoveryNamed(bytes32 indexed caseId, address to, uint64 releasableAt, bytes32 evidenceHash, bytes32 digest);
    /// @notice A party of `depositId` objected to paying it out to `to`.
    event RecoveryChallenged(
        bytes32 indexed caseId, uint256 indexed depositId, address indexed by, address to, bytes32 evidenceHash
    );
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

    /// @notice The only depositor once set (zero until the committee binds this ledger's Router).
    address public router;
    uint256 public depositCount;
    mapping(uint256 => Deposit) public deposits;
    mapping(bytes32 => Recovery) public recoveries;
    /// @notice depositId => recovery address => time a party of that deposit challenged it (0 = never).
    mapping(uint256 => mapping(address => uint64)) public challengedAt;
    mapping(bytes32 => bool) public used;

    constructor(IProviderRegistry registry, uint64 recoveryNotice, uint64 challengeWindow) {
        if (
            address(registry) == address(0) || recoveryNotice < MIN_RECOVERY_NOTICE
                || challengeWindow < MIN_CHALLENGE_WINDOW
        ) revert InvalidParameters();
        REGISTRY = registry;
        RECOVERY_NOTICE = recoveryNotice;
        CHALLENGE_WINDOW = challengeWindow;
    }

    /// @notice EIP-712-style digest of a vault decision: deployment id, chain id and this vault's address are in
    ///         the domain, so a vault decision acts on this vault only. Members sign its EIP-191 hash.
    function decisionDigest(IProviderRegistry.Decision calldata d) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes(NAME)),
                keccak256(bytes(PROTOCOL_VERSION)),
                block.chainid,
                address(this),
                REGISTRY.DEPLOYMENT_ID()
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                VAULT_DECISION_TYPEHASH,
                d.action,
                keccak256(d.payload),
                d.evidenceHash,
                d.nonce,
                d.effectiveAt,
                d.validUntil,
                d.epoch
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    /// @notice Bind this vault to its ledger's Router, once (committee decision, k + 1, payload `(address router)`).
    ///         From then on only that Router can deposit.
    function bindRouter(IProviderRegistry.Decision calldata d, bytes[] calldata sigs) external {
        bytes32 digest = _consume(d, sigs, ACTION_VAULT_BIND_ROUTER, REGISTRY.requiredSignatures(ACTION_VAULT_BIND_ROUTER));
        if (router != address(0)) revert AlreadyBound();
        address r = abi.decode(d.payload, (address));
        if (r == address(0)) revert InvalidParameters();
        router = r;
        emit RouterBound(r, d.evidenceHash, digest);
    }

    /// @notice Record diverted funds. Only the bound Router may call, once one is bound.
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
        address r = router;
        if (r != address(0) && msg.sender != r) revert NotRouter();
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

    /// @notice Name a recovery address for a case (committee decision, k + 1, payload `(bytes32 caseId, address to)`).
    ///         Starts the notice period and challenge window. Challenges already raised against `to` stay.
    function nameRecovery(IProviderRegistry.Decision calldata d, bytes[] calldata sigs) external {
        bytes32 digest =
            _consume(d, sigs, ACTION_VAULT_NAME_RECOVERY, REGISTRY.requiredSignatures(ACTION_VAULT_NAME_RECOVERY));
        (bytes32 caseId, address to) = abi.decode(d.payload, (bytes32, address));
        if (caseId == bytes32(0)) revert NoCase();
        _checkBeneficiary(to);
        uint64 releasableAt = uint64(block.timestamp) + RECOVERY_NOTICE + CHALLENGE_WINDOW;
        recoveries[caseId] = Recovery({to: to, namedAt: uint64(block.timestamp), releasableAt: releasableAt});
        emit RecoveryNamed(caseId, to, releasableAt, d.evidenceHash, digest);
    }

    /// @notice Challenge paying deposit `depositId` to the recovery address named for its case. Only the deposit's
    ///         original sender or recipient may challenge, and only before the window closes. The challenge stays
    ///         for that deposit and address until the committee overrides it (see {Beneficiary}).
    function challengeRecovery(uint256 depositId, bytes32 evidenceHash) external {
        Deposit storage dep = deposits[depositId];
        if (dep.amount == 0) revert UnknownDeposit();
        if (msg.sender != dep.sender && msg.sender != dep.recipient) revert NotAParty();
        if (dep.released) revert AlreadyReleased();
        Recovery storage r = recoveries[dep.caseId];
        if (r.to == address(0) || block.timestamp >= r.releasableAt) revert ChallengeClosed();
        if (challengedAt[depositId][r.to] == 0) challengedAt[depositId][r.to] = uint64(block.timestamp);
        emit RecoveryChallenged(dep.caseId, depositId, msg.sender, r.to, evidenceHash);
    }

    /// @notice Release a deposit (committee decision, payload `(uint256 depositId, bytes32 caseId, uint8 kind)`).
    function release(IProviderRegistry.Decision calldata d, bytes[] calldata sigs) external {
        if (d.action != ACTION_VAULT_RELEASE) revert WrongAction(); // before decoding a foreign payload
        (uint256 depositId, bytes32 caseId, uint8 kindRaw) = abi.decode(d.payload, (uint256, bytes32, uint8));
        Beneficiary kind = Beneficiary(kindRaw);
        bytes32 digest = _consume(
            d,
            sigs,
            ACTION_VAULT_RELEASE,
            REGISTRY.requiredSignatures(
                kind == Beneficiary.RECOVERY_OVER_CHALLENGE ? ACTION_COMMITTEE : ACTION_VAULT_RELEASE
            )
        );
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
            to = r.to;
            uint64 challenged = challengedAt[depositId][to];
            if (to == address(0) || block.timestamp < r.releasableAt) revert RecoveryNotReady();
            if (kind == Beneficiary.RECOVERY) {
                if (challenged != 0) revert RecoveryNotReady();
            } else {
                if (challenged == 0) revert NotChallenged();
                if (block.timestamp < uint256(r.releasableAt) + CHALLENGE_WINDOW) revert RecoveryNotReady();
            }
        }
        _checkBeneficiary(to);

        dep.released = true;
        uint256 amount = dep.amount;
        emit Released(depositId, caseId, to, kind, amount, d.evidenceHash, digest);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _consume(IProviderRegistry.Decision calldata d, bytes[] calldata sigs, uint8 action, uint256 required)
        private
        returns (bytes32 digest)
    {
        if (d.action != action) revert WrongAction();
        if (block.timestamp > d.validUntil) revert DecisionExpired();
        if (block.timestamp < d.effectiveAt) revert NotYetEffective();
        if (d.evidenceHash == bytes32(0)) revert MissingEvidence();
        digest = decisionDigest(d);
        if (used[digest]) revert DecisionAlreadyUsed();
        REGISTRY.checkApproval(digest, d.epoch, sigs, required);
        used[digest] = true;
    }

    function _checkBeneficiary(address to) private view {
        if (to == address(0) || to == address(this) || to == address(REGISTRY) || REGISTRY.isProviderAccount(to)) {
            revert ForbiddenBeneficiary();
        }
    }
}
