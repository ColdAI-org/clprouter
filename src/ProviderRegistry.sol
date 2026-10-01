// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IProviderRegistry} from "./interfaces/IProviderRegistry.sol";
import {Caip} from "./libraries/Caip.sol";

/// @title ProviderRegistry
/// @notice The provider's only on-chain power in CLPRouter: certify networks for the ISO 20022, MiCA and Energy
///         filters; label Channel directions with their verifier trust tier (read by Routers to enforce a route's
///         trust floor); disable and re-enable malicious routes (a Channel direction, a ledger, a Router deployment
///         or a Router version); and blacklist CAIP-10 accounts after an exploit.
/// @dev Append-only and admin-less. A decision is signed once off-chain by committee members over an EIP-712-style
///      digest bound to `DEPLOYMENT_ID` (one CLPRouter deployment, shared by every ledger it runs on), so anyone
///      can relay it to the registry on every ledger of that deployment and on no other deployment. Rules:
///        - certification changes (k signatures) take effect after a notice period
///          (`CERT_NOTICE` to certify, `REMOVAL_NOTICE` to uncertify); certifications last at most a year; the
///          newest decision in effect wins, so an uncertify is never held back by an earlier, later-dated certify;
///        - trust-tier labels (k signatures) take effect after `CERT_NOTICE` when they raise an edge's tier and
///          after `REMOVAL_NOTICE` when they lower or remove it. A label only describes an edge: it moves no
///          funds, and a lowered label can at most stop routes whose floor it no longer meets (they are refunded);
///        - disables and blacklist entries need k + 1 signatures, take effect immediately, and lapse after
///          `DISABLE_LAPSE` / `BLACKLIST_LAPSE` unless renewed by a new decision;
///        - delisting needs k + 1 (the quorum that listed); re-enabling (k) takes effect after `REENABLE_NOTICE`,
///          during which a k + 1 renewal of the disable cancels it;
///        - committee changes are the strongest decision: a supermajority of the current committee
///          (at least k + 1 and at least ceil(2n/3)) schedules the new committee, which takes over only after
///          `COMMITTEE_NOTICE` (visible on-chain via {pendingCommittee}) and with the first decision it signs.
///          Every committee keeps n >= 3, k >= 2 and k > n / 2. Until then the outgoing committee keeps acting
///          and can replace the pending change with another supermajority decision; once the notice has
///          passed, it needs a supermajority for everything, so k outgoing keys cannot stall the hand-over.
///      Residual risk: a supermajority of the current committee can install any committee after the notice period.
///      The notice makes that visible; nothing on-chain can stop it.
///
///      Decision chain. Decisions form a hash chain: decision N commits (in its digest) to the head hash after
///      decision N - 1, and is accepted only as `nonce == version + 1` on a registry whose head is that hash. So a
///      position can only ever be filled by the one decision that extends the current head, and version N names
///      one registry history everywhere; {headAt} exposes version -> head hash so anyone can check that two
///      ledgers agree before trusting a pinned version. Nothing that depends on relay time or local state makes a
///      decision revert: `validUntil` is not enforced for these ordered decisions (a signed decision is final and
///      must be relayed to every ledger), effective times are recorded with the decision and evaluated when read,
///      certification expiry is clamped instead of rejected, and handlers whose effect depends on local state
///      (re-enable something not disabled, delist an entry that already lapsed) apply as no-ops. The only checks
///      that can fail are on signed values alone (so they fail on every ledger alike), plus
///      `effectiveAt <= now + MAX_NOTICE`, which a later relay only relaxes.
///
///      A route pins the version it was sent against (`filter_registry_versions`); each hop reads certifications
///      as of that version. Effective time is a separate, second condition: an entry visible at the pinned version
///      applies only once its notice period has passed (and until its expiry).
///
///      History is never rewritten: each (ledger, label) keeps its full certification log, so every past
///      version stays readable.
contract ProviderRegistry is IProviderRegistry {
    // ── Types ───────────────────────────────────────────────────────────────

    enum Action {
        NONE,
        CERTIFY, // (string ledgerId, uint8 label, uint64 expiry, uint64 emissionsUg, string emissionsSource)
        UNCERTIFY, // (string ledgerId, uint8 label)
        DISABLE, // (uint8 kind, bytes32 subject, string reason)   — also renews
        ENABLE, // (uint8 kind, bytes32 subject)
        BLACKLIST, // (string caip10, bytes32 caseId, string reason) — also renews
        DELIST, // (string caip10, bytes32 caseId)
        COMMITTEE, // (address[] members, uint8 threshold)
        CONTACT, // (string contact)
        VAULT_RELEASE, // verified by QuarantineVault, never accepted here
        VAULT_NAME_RECOVERY, // verified by QuarantineVault, never accepted here
        TRUST_TIER, // (bytes32 channelId, string toLedgerId, uint8 tier) — tier TIER_NONE removes the label
        VAULT_BIND_ROUTER // verified by QuarantineVault, never accepted here
    }

    /// @notice Certification labels (filter names).
    uint8 public constant LABEL_ISO20022 = 1;
    uint8 public constant LABEL_MICA = 2;
    uint8 public constant LABEL_ENERGY = 3;

    /// @notice What a disable acts on.
    uint8 public constant TARGET_EDGE = 1;
    uint8 public constant TARGET_LEDGER = 2;
    uint8 public constant TARGET_ROUTER = 3;
    uint8 public constant TARGET_ROUTER_VERSION = 4;

    /// @notice Verifier trust tiers, weakest to strongest (same numbers as the envelope's `trust_floor`).
    uint8 public constant TIER_ATTESTED = 0;
    uint8 public constant TIER_COMMITTEE = 1;
    uint8 public constant TIER_LIGHT_CLIENT = 2;
    uint8 public constant TIER_VALIDITY_PROOF = 3;
    /// @notice Payload value of a TRUST_TIER decision that removes an edge's label.
    uint8 public constant TIER_NONE = type(uint8).max;

    uint64 public constant MAX_CERT_DURATION = 366 days;
    /// @notice Furthest a decision may schedule its effect: `effectiveAt <= block.timestamp + MAX_NOTICE`.
    uint64 public constant MAX_NOTICE = 90 days;

    /// @notice Floors for the immutable notice periods and lapses (a zero would silently disable a rule).
    uint64 public constant MIN_CERT_NOTICE = 1 days;
    uint64 public constant MIN_REMOVAL_NOTICE = 1 hours;
    uint64 public constant MIN_REENABLE_NOTICE = 1 days;
    uint64 public constant MIN_LAPSE = 1 days;
    uint64 public constant MIN_COMMITTEE_NOTICE = 7 days;

    struct Certification {
        uint64 version; // registry version that appended this entry
        uint64 effectiveFrom;
        uint64 expiry;
        bool certified;
        /// @dev ENERGY only: certified emissions in micrograms of CO2-equivalent per transaction (µgCO2e/tx).
        ///      Example: ~0.0024 gCO2e/tx is stored as 2400.
        uint64 emissionsUg;
        bytes32 evidenceHash;
    }

    struct Switch {
        uint64 disabledAt;
        uint64 lapseAt;
        uint64 reenableAt; // 0 = no re-enable scheduled
    }

    /// @dev Trust-tier label of one Channel direction. Tiers are stored as tier + 1 so that 0 means "unlabelled".
    ///      A scheduled change sits in `next` until `nextFrom`.
    struct TierLabel {
        uint8 current;
        uint8 next;
        uint64 nextFrom; // 0 = nothing scheduled
    }

    struct Listing {
        bytes32 caseId;
        uint64 listedAt;
        uint64 lapseAt;
    }

    // ── Errors ──────────────────────────────────────────────────────────────

    error OutOfOrder(uint64 expectedNonce, uint64 nonce);
    error WrongEpoch();
    error MissingEvidence();
    error InsufficientSignatures(uint256 valid, uint256 required);
    error BadSignature();
    error SignersNotSorted();
    error UnsupportedAction();
    error InvalidLabel();
    error InvalidTarget();
    error InvalidExpiry();
    error MissingEmissions();
    error InvalidCommittee();
    error InvalidTier();
    error InvalidParameters();
    error EffectiveTooFar();
    error CommitteeNotYetActive(uint64 activatesAt);

    // ── Events (every action carries its evidence hash and decision digest) ─

    /// @notice A decision was applied and the registry moved to `version`.
    event DecisionApplied(uint64 indexed version, uint8 indexed action, bytes32 indexed digest, bytes32 evidenceHash);
    event CertificationScheduled(
        bytes32 indexed certKey,
        string ledgerId,
        uint8 indexed label,
        bool certified,
        uint64 effectiveFrom,
        uint64 expiry,
        uint64 emissionsUg,
        string emissionsSource,
        uint64 version,
        bytes32 evidenceHash,
        bytes32 indexed digest
    );
    event RouteDisabled(
        uint8 indexed kind,
        bytes32 indexed subject,
        uint64 lapseAt,
        bool renewed,
        string reason,
        bytes32 evidenceHash,
        bytes32 indexed digest
    );
    /// @notice `reenableAt` is zero when the subject was not disabled (the decision applied as a no-op).
    event RouteReenableScheduled(
        uint8 indexed kind, bytes32 indexed subject, uint64 reenableAt, bytes32 evidenceHash, bytes32 indexed digest
    );
    event AccountBlacklisted(
        bytes32 indexed accountKey,
        string caip10,
        bytes32 indexed caseId,
        uint64 lapseAt,
        bool renewed,
        string reason,
        bytes32 evidenceHash,
        bytes32 digest
    );
    /// @notice `applied` is false when no live entry under `caseId` existed (no-op).
    event AccountDelisted(
        bytes32 indexed accountKey,
        string caip10,
        bytes32 indexed caseId,
        bool applied,
        bytes32 evidenceHash,
        bytes32 digest
    );
    /// @notice A committee change was signed; `epoch` takes over at `activatesAt` at the earliest, with the first
    ///         decision its members sign.
    event CommitteeScheduled(
        uint64 indexed epoch,
        address[] members,
        uint8 threshold,
        uint64 activatesAt,
        bytes32 evidenceHash,
        bytes32 digest
    );
    /// @notice `epoch` took over (emitted with the first decision it signed).
    event CommitteeChanged(
        uint64 indexed epoch, address[] members, uint8 threshold, bytes32 evidenceHash, bytes32 digest
    );
    event ContactChanged(string contact, bytes32 evidenceHash, bytes32 digest);
    /// @notice `tier` is TIER_NONE when the label is removed.
    event TrustTierScheduled(
        bytes32 indexed edgeKey,
        bytes32 channelId,
        string toLedgerId,
        uint8 tier,
        uint64 effectiveFrom,
        bytes32 evidenceHash,
        bytes32 indexed digest
    );

    // ── Immutable parameters ────────────────────────────────────────────────

    /// @notice EIP-712 domain: name, version and `salt = DEPLOYMENT_ID`. No chain id and no contract address on
    ///         purpose: registry decisions relay to every ledger of the deployment.
    bytes32 internal constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,bytes32 salt)");
    bytes32 public constant DECISION_TYPEHASH = keccak256(
        "Decision(uint8 action,bytes payload,bytes32 evidenceHash,uint64 nonce,bytes32 prevHead,uint64 effectiveAt,uint64 validUntil,uint64 epoch)"
    );
    string public constant NAME = "CLPRouter.ProviderRegistry";
    string public constant PROTOCOL_VERSION = "2";

    /// @notice Id of the CLPRouter deployment this registry belongs to (identical on all of its ledgers).
    bytes32 public immutable DEPLOYMENT_ID;
    bytes32 public immutable DOMAIN_SEPARATOR;

    uint64 public immutable CERT_NOTICE;
    uint64 public immutable REMOVAL_NOTICE;
    uint64 public immutable REENABLE_NOTICE;
    uint64 public immutable DISABLE_LAPSE;
    uint64 public immutable BLACKLIST_LAPSE;
    uint64 public immutable COMMITTEE_NOTICE;

    // ── State ───────────────────────────────────────────────────────────────

    /// @notice Registry version: number of decisions applied so far. Monotonically increasing; the next
    ///         decision must carry nonce `version + 1`.
    uint64 public version;
    /// @notice Head hash after `version` decisions (the digest of decision `version`; a genesis hash at 0).
    mapping(uint64 => bytes32) public headAt;

    uint64 public epoch;
    uint8 public threshold;
    address[] private _members;
    mapping(uint64 => mapping(address => bool)) private _isMember;
    mapping(address => bool) public isProviderAccount;

    /// @notice Scheduled committee (0 = none): its epoch id, threshold and earliest take-over time.
    uint64 public pendingEpoch;
    uint8 public pendingThreshold;
    uint64 public pendingFrom;
    address[] private _pendingMembers;
    uint64 private _epochCount;

    string public contact;

    mapping(bytes32 => Certification[]) private _certs;
    mapping(bytes32 => Switch) public switches;
    mapping(bytes32 => Listing) public listings;
    mapping(bytes32 => TierLabel) private _tiers;

    /// @param deploymentId Id of the CLPRouter deployment; the same on every ledger of the deployment.
    /// @param initialMembers Initial committee, strictly ascending addresses.
    /// @param k Signatures needed for a certification change (disable/blacklist/delist need k + 1, committee
    ///        changes a supermajority).
    /// @param contact_ Provider contact address quoted in quarantine notices.
    /// @param notices [certNotice, removalNotice, reenableNotice, disableLapse, blacklistLapse, committeeNotice]
    ///        in seconds, each at least its MIN_* floor, with removalNotice <= certNotice <= MAX_NOTICE.
    constructor(
        bytes32 deploymentId,
        address[] memory initialMembers,
        uint8 k,
        string memory contact_,
        uint64[6] memory notices
    ) {
        if (
            deploymentId == bytes32(0) || notices[0] < MIN_CERT_NOTICE || notices[0] > MAX_NOTICE
                || notices[1] < MIN_REMOVAL_NOTICE || notices[1] > notices[0] || notices[2] < MIN_REENABLE_NOTICE
                || notices[2] > MAX_NOTICE || notices[3] < MIN_LAPSE || notices[4] < MIN_LAPSE
                || notices[5] < MIN_COMMITTEE_NOTICE || notices[5] > MAX_NOTICE
        ) revert InvalidParameters();
        _checkCommittee(initialMembers, k);
        for (uint256 i = 0; i < initialMembers.length; i++) {
            _isMember[0][initialMembers[i]] = true;
            isProviderAccount[initialMembers[i]] = true;
        }
        _members = initialMembers;
        threshold = k;
        contact = contact_;
        DEPLOYMENT_ID = deploymentId;
        bytes32 sep = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(NAME)), keccak256(bytes(PROTOCOL_VERSION)), deploymentId)
        );
        DOMAIN_SEPARATOR = sep;
        CERT_NOTICE = notices[0];
        REMOVAL_NOTICE = notices[1];
        REENABLE_NOTICE = notices[2];
        DISABLE_LAPSE = notices[3];
        BLACKLIST_LAPSE = notices[4];
        COMMITTEE_NOTICE = notices[5];
        // Genesis commits to the whole initial configuration: a ledger deployed with different parameters never
        // shares a head with the others, so it can accept no decision of theirs.
        headAt[0] = keccak256(abi.encode(sep, initialMembers, k, contact_, notices));
    }

    // ═════════════════════════════════════════════════════════════════════
    // Relaying decisions
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Apply the next committee decision. Anyone may relay it.
    /// @param d The signed decision; `d.nonce` must be `version + 1` and it must have been signed over the
    ///        current head (see {decisionDigest}).
    /// @param sigs 65-byte ECDSA signatures over the EIP-191 hash of {decisionDigest}, ordered by signer address.
    /// @return digest The decision digest, which is the new head hash.
    function submit(Decision calldata d, bytes[] calldata sigs) external returns (bytes32 digest) {
        if (
            d.action == uint8(Action.NONE) || d.action == uint8(Action.VAULT_RELEASE)
                || d.action == uint8(Action.VAULT_NAME_RECOVERY) || d.action > uint8(Action.TRUST_TIER)
        ) revert UnsupportedAction();
        Action action = Action(d.action);
        if (d.evidenceHash == bytes32(0)) revert MissingEvidence();
        if (d.nonce != version + 1) revert OutOfOrder(version + 1, d.nonce);
        // A later relay only relaxes this bound, so it never turns a relayable decision into a stuck one.
        if (d.effectiveAt > block.timestamp + MAX_NOTICE) revert EffectiveTooFar();
        digest = decisionDigest(d);

        // Which committee signs: the active one, or the scheduled one once its notice has passed (it then takes
        // over). After the notice the outgoing committee needs a supermajority for everything.
        uint64 from = pendingFrom;
        bool takeOver = from != 0 && d.epoch == pendingEpoch;
        uint256 n;
        uint256 k;
        if (takeOver) {
            if (block.timestamp < from) revert CommitteeNotYetActive(from);
            n = _pendingMembers.length;
            k = pendingThreshold;
        } else {
            if (d.epoch != epoch) revert WrongEpoch();
            n = _members.length;
            k = threshold;
        }
        uint256 required = _required(d.action, k, n);
        if (!takeOver && from != 0 && block.timestamp >= from) required = _max(required, _supermajority(k, n));
        _verify(digest, d.epoch, sigs, required);
        if (takeOver) _activate(d.evidenceHash, digest);

        uint64 v = ++version;
        headAt[v] = digest;

        if (action == Action.CERTIFY || action == Action.UNCERTIFY) _certify(action, d, digest, v);
        else if (action == Action.DISABLE) _disable(d, digest);
        else if (action == Action.ENABLE) _enable(d, digest);
        else if (action == Action.BLACKLIST) _blacklist(d, digest);
        else if (action == Action.DELIST) _delist(d, digest);
        else if (action == Action.COMMITTEE) _committee(d, digest);
        else if (action == Action.TRUST_TIER) _trustTier(d, digest);
        else _contact(d, digest);
        emit DecisionApplied(v, d.action, digest, d.evidenceHash);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Views
    // ═════════════════════════════════════════════════════════════════════

    /// @inheritdoc IProviderRegistry
    function decisionDigest(Decision calldata d) public view returns (bytes32) {
        // Position `nonce` extends the head after `nonce - 1` decisions (zero while this registry has not got there).
        bytes32 prevHead = d.nonce == 0 ? bytes32(0) : headAt[d.nonce - 1];
        bytes32 structHash = keccak256(
            abi.encode(
                DECISION_TYPEHASH,
                d.action,
                keccak256(d.payload),
                d.evidenceHash,
                d.nonce,
                prevHead,
                d.effectiveAt,
                d.validUntil,
                d.epoch
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// @notice Current version and head hash. A pinned version names one history: compare `headAt(v)` across ledgers.
    function head() external view returns (uint64, bytes32) {
        return (version, headAt[version]);
    }

    /// @inheritdoc IProviderRegistry
    function requiredSignatures(uint8 action) public view returns (uint256) {
        return _required(action, threshold, _members.length);
    }

    /// @inheritdoc IProviderRegistry
    function checkApproval(bytes32 digest, uint64 decisionEpoch, bytes[] calldata sigs, uint256 required) public view {
        if (decisionEpoch != epoch) revert WrongEpoch();
        _verify(digest, decisionEpoch, sigs, required);
    }

    /// @notice The scheduled committee (empty when none): epoch id, members, threshold and earliest take-over.
    function pendingCommittee()
        external
        view
        returns (uint64 epoch_, address[] memory members_, uint8 threshold_, uint64 activatesAt)
    {
        return (pendingEpoch, _pendingMembers, pendingThreshold, pendingFrom);
    }

    /// @notice True if `account` is a member of committee epoch `epochId` (active, past or scheduled).
    function isMemberOf(uint64 epochId, address account) external view returns (bool) {
        return _isMember[epochId][account];
    }

    /// @inheritdoc IProviderRegistry
    function isDisabled(bytes32 key) public view returns (bool) {
        Switch storage s = switches[key];
        if (block.timestamp >= s.lapseAt) return false;
        return s.reenableAt == 0 || block.timestamp < s.reenableAt;
    }

    /// @inheritdoc IProviderRegistry
    function blacklisted(bytes32 key) external view returns (bool listed, bytes32 caseId) {
        Listing storage l = listings[key];
        listed = block.timestamp < l.lapseAt;
        caseId = listed ? l.caseId : bytes32(0);
    }

    /// @inheritdoc IProviderRegistry
    function certificationAt(bytes32 key, uint64 atVersion) external view returns (bool certified, uint64 emissionsUg) {
        if (atVersion > version) return (false, 0); // this registry has not reached the pinned version yet
        Certification[] storage log = _certs[key];
        for (uint256 i = log.length; i > 0; i--) {
            Certification storage c = log[i - 1];
            if (c.version > atVersion || c.effectiveFrom > block.timestamp) continue;
            certified = c.certified && block.timestamp < c.expiry;
            emissionsUg = certified ? c.emissionsUg : 0;
            return (certified, emissionsUg);
        }
    }

    /// @inheritdoc IProviderRegistry
    function trustTier(bytes32 edgeKey_) public view returns (bool labelled, uint8 tier) {
        TierLabel storage t = _tiers[edgeKey_];
        uint8 v = t.nextFrom != 0 && block.timestamp >= t.nextFrom ? t.next : t.current;
        return v == 0 ? (false, 0) : (true, v - 1);
    }

    /// @notice Full certification log of `key` (every past version stays readable).
    function certificationLog(bytes32 key) external view returns (Certification[] memory) {
        return _certs[key];
    }

    /// @notice Members of the current committee.
    function members() external view returns (address[] memory) {
        return _members;
    }

    /// @notice True if `account` sits on the current committee.
    function isMember(address account) external view returns (bool) {
        return _isMember[epoch][account];
    }

    // ── Key helpers (so relayers and tests derive the same subjects as the Router) ─

    function edgeKey(bytes32 channelId, string calldata toLedgerId) external pure returns (bytes32) {
        return Caip.edgeKey(channelId, toLedgerId);
    }

    function ledgerKey(string calldata ledgerId) external pure returns (bytes32) {
        return Caip.ledgerKey(ledgerId);
    }

    function routerKey(string calldata ledgerId, bytes calldata router) external pure returns (bytes32) {
        return Caip.routerKey(ledgerId, router);
    }

    function routerVersionKey(uint32 routerVersion) external pure returns (bytes32) {
        return Caip.routerVersionKey(routerVersion);
    }

    function accountKey(string calldata caip10) external pure returns (bytes32) {
        return Caip.accountKey(caip10);
    }

    function certKey(string calldata ledgerId, uint8 label) external pure returns (bytes32) {
        return Caip.certKey(ledgerId, label);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Action handlers
    // ═════════════════════════════════════════════════════════════════════

    function _certify(Action action, Decision calldata d, bytes32 digest, uint64 v) private {
        bool certify = action == Action.CERTIFY;
        string memory ledgerId;
        string memory source;
        Certification memory c;
        uint8 label;
        if (certify) {
            (ledgerId, label, c.expiry, c.emissionsUg, source) =
                abi.decode(d.payload, (string, uint8, uint64, uint64, string));
        } else {
            (ledgerId, label) = abi.decode(d.payload, (string, uint8));
        }
        if (label < LABEL_ISO20022 || label > LABEL_ENERGY) revert InvalidLabel();

        // No clamp to earlier entries: readers take the newest entry in effect, so a later decision supersedes a
        // pending earlier one instead of queueing behind it.
        c.effectiveFrom = uint64(_max(d.effectiveAt, block.timestamp + (certify ? CERT_NOTICE : REMOVAL_NOTICE)));
        if (certify) {
            // Signed values only (identical on every ledger); the time-dependent part degrades instead of reverting.
            if (c.expiry <= d.effectiveAt) revert InvalidExpiry();
            if (label == LABEL_ENERGY && (c.emissionsUg == 0 || bytes(source).length == 0)) revert MissingEmissions();
            if (label != LABEL_ENERGY) c.emissionsUg = 0;
            // At most a year of validity; relayed so late that it would be expired on arrival, it simply never holds.
            if (c.expiry > c.effectiveFrom + MAX_CERT_DURATION) c.expiry = c.effectiveFrom + MAX_CERT_DURATION;
        }
        c.version = v;
        c.certified = certify;
        c.evidenceHash = d.evidenceHash;
        bytes32 key = Caip.certKey(ledgerId, label);
        _certs[key].push(c);
        emit CertificationScheduled(
            key, ledgerId, label, certify, c.effectiveFrom, c.expiry, c.emissionsUg, source, v, c.evidenceHash, digest
        );
    }

    function _disable(Decision calldata d, bytes32 digest) private {
        (uint8 kind, bytes32 subject, string memory reason) = abi.decode(d.payload, (uint8, bytes32, string));
        if (kind < TARGET_EDGE || kind > TARGET_ROUTER_VERSION || subject == bytes32(0)) revert InvalidTarget();
        bool renewed = isDisabled(subject);
        uint64 lapseAt = uint64(block.timestamp) + DISABLE_LAPSE;
        switches[subject] = Switch({
            disabledAt: renewed ? switches[subject].disabledAt : uint64(block.timestamp),
            lapseAt: lapseAt,
            reenableAt: 0
        });
        emit RouteDisabled(kind, subject, lapseAt, renewed, reason, d.evidenceHash, digest);
    }

    function _enable(Decision calldata d, bytes32 digest) private {
        (uint8 kind, bytes32 subject) = abi.decode(d.payload, (uint8, bytes32));
        if (kind < TARGET_EDGE || kind > TARGET_ROUTER_VERSION || subject == bytes32(0)) revert InvalidTarget();
        uint64 reenableAt;
        if (isDisabled(subject)) {
            reenableAt = uint64(_max(d.effectiveAt, block.timestamp + REENABLE_NOTICE));
            switches[subject].reenableAt = reenableAt;
        }
        emit RouteReenableScheduled(kind, subject, reenableAt, d.evidenceHash, digest);
    }

    function _blacklist(Decision calldata d, bytes32 digest) private {
        (string memory caip10, bytes32 caseId, string memory reason) = abi.decode(d.payload, (string, bytes32, string));
        if (caseId == bytes32(0) || bytes(caip10).length == 0) revert InvalidTarget();
        bytes32 key = Caip.accountKey(caip10);
        Listing storage l = listings[key];
        // Renewal = same case still live; anything else starts a new listing under `caseId`.
        bool renewed = block.timestamp < l.lapseAt && l.caseId == caseId;
        if (!renewed) {
            l.caseId = caseId;
            l.listedAt = uint64(block.timestamp);
        }
        uint64 lapseAt = uint64(block.timestamp) + BLACKLIST_LAPSE;
        l.lapseAt = lapseAt;
        emit AccountBlacklisted(key, caip10, caseId, lapseAt, renewed, reason, d.evidenceHash, digest);
    }

    function _delist(Decision calldata d, bytes32 digest) private {
        (string memory caip10, bytes32 caseId) = abi.decode(d.payload, (string, bytes32));
        bytes32 key = Caip.accountKey(caip10);
        Listing storage l = listings[key];
        bool applied = l.caseId == caseId && block.timestamp < l.lapseAt;
        if (applied) l.lapseAt = uint64(block.timestamp);
        emit AccountDelisted(key, caip10, caseId, applied, d.evidenceHash, digest);
    }

    function _trustTier(Decision calldata d, bytes32 digest) private {
        (bytes32 channelId, string memory toLedgerId, uint8 tier) = abi.decode(d.payload, (bytes32, string, uint8));
        if (tier > TIER_VALIDITY_PROOF && tier != TIER_NONE) revert InvalidTier();
        if (channelId == bytes32(0) || bytes(toLedgerId).length == 0) revert InvalidTarget();
        bytes32 key = Caip.edgeKey(channelId, toLedgerId);
        TierLabel storage t = _tiers[key];
        // Fold a scheduled change that already took effect; a pending one is superseded by this decision.
        if (t.nextFrom != 0 && block.timestamp >= t.nextFrom) t.current = t.next;
        uint8 stored = tier == TIER_NONE ? 0 : tier + 1;
        // Raising trust needs the certification notice; lowering or removing it the (shorter) removal notice.
        uint64 notice = stored > t.current ? CERT_NOTICE : REMOVAL_NOTICE;
        uint64 effectiveFrom = uint64(_max(d.effectiveAt, block.timestamp + notice));
        t.next = stored;
        t.nextFrom = effectiveFrom;
        emit TrustTierScheduled(key, channelId, toLedgerId, tier, effectiveFrom, d.evidenceHash, digest);
    }

    function _committee(Decision calldata d, bytes32 digest) private {
        (address[] memory newMembers, uint8 k) = abi.decode(d.payload, (address[], uint8));
        _checkCommittee(newMembers, k);
        // A fresh epoch id per scheduled change, so a replaced schedule can never take over.
        uint64 id = ++_epochCount;
        for (uint256 i = 0; i < newMembers.length; i++) {
            _isMember[id][newMembers[i]] = true;
            isProviderAccount[newMembers[i]] = true; // never a vault beneficiary, from the moment it is named
        }
        uint64 activatesAt = uint64(_max(d.effectiveAt, block.timestamp + COMMITTEE_NOTICE));
        pendingEpoch = id;
        pendingThreshold = k;
        pendingFrom = activatesAt;
        _pendingMembers = newMembers;
        emit CommitteeScheduled(id, newMembers, k, activatesAt, d.evidenceHash, digest);
    }

    function _activate(bytes32 evidenceHash, bytes32 digest) private {
        epoch = pendingEpoch;
        threshold = pendingThreshold;
        _members = _pendingMembers;
        delete _pendingMembers;
        pendingEpoch = 0;
        pendingThreshold = 0;
        pendingFrom = 0;
        emit CommitteeChanged(epoch, _members, threshold, evidenceHash, digest);
    }

    function _contact(Decision calldata d, bytes32 digest) private {
        string memory c = abi.decode(d.payload, (string));
        contact = c;
        emit ContactChanged(c, d.evidenceHash, digest);
    }

    /// @dev n >= 3, 2 <= k, k > n / 2 (two disjoint quorums cannot both act) and k + 1 <= n (so the k + 1 rules
    ///      remain satisfiable); members strictly ascending.
    function _checkCommittee(address[] memory m, uint8 k) private pure {
        uint256 n = m.length;
        if (n < 3 || k < 2 || 2 * uint256(k) <= n || uint256(k) + 1 > n) revert InvalidCommittee();
        address last;
        for (uint256 i = 0; i < n; i++) {
            if (m[i] <= last) revert InvalidCommittee();
            last = m[i];
        }
    }

    function _required(uint8 action, uint256 k, uint256 n) private pure returns (uint256) {
        if (action == uint8(Action.COMMITTEE)) return _supermajority(k, n);
        if (
            action == uint8(Action.DISABLE) || action == uint8(Action.BLACKLIST) || action == uint8(Action.DELIST)
                || action == uint8(Action.VAULT_NAME_RECOVERY) || action == uint8(Action.VAULT_BIND_ROUTER)
        ) return k + 1;
        return k;
    }

    /// @dev max(k + 1, ceil(2n / 3)).
    function _supermajority(uint256 k, uint256 n) private pure returns (uint256) {
        return _max(k + 1, (2 * n + 2) / 3);
    }

    function _verify(bytes32 digest, uint64 epochId, bytes[] calldata sigs, uint256 required) private view {
        bytes32 h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        address last;
        for (uint256 i = 0; i < sigs.length; i++) {
            (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(h, sigs[i]);
            if (err != ECDSA.RecoverError.NoError) revert BadSignature();
            if (signer <= last) revert SignersNotSorted();
            last = signer;
            if (!_isMember[epochId][signer]) revert BadSignature();
        }
        if (sigs.length < required) revert InsufficientSignatures(sigs.length, required);
    }

    function _max(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a : b;
    }
}
