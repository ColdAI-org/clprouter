// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IProviderRegistry} from "./interfaces/IProviderRegistry.sol";
import {Caip} from "./libraries/Caip.sol";

/// @title ProviderRegistry
/// @notice The provider's only on-chain power in CLPRouter: certify networks for the ISO 20022, MiCA and Energy
///         filters; label Channel directions with their verifier trust tier (read by Routers to enforce a route's
///         trust floor); disable and re-enable malicious routes (a Channel direction, a ledger, a Router deployment
///         or a Router version); and blacklist CAIP-10 accounts after an exploit.
/// @dev Append-only and admin-less. A decision is signed once off-chain by k of n committee members over a
///      ledger-independent digest, and anyone can relay it to the registry on any ledger. Rules:
///        - certification changes (k signatures) take effect after a notice period
///          (`CERT_NOTICE` to certify, `REMOVAL_NOTICE` to uncertify); certifications last at most a year;
///        - trust-tier labels (k signatures) take effect after `CERT_NOTICE` when they raise an edge's tier and
///          after `REMOVAL_NOTICE` when they lower or remove it. A label only describes an edge: it moves no
///          funds, and a lowered label can at most stop routes whose floor it no longer meets (they are refunded);
///        - disables and blacklist entries need k + 1 signatures, take effect immediately, and lapse after
///          `DISABLE_LAPSE` / `BLACKLIST_LAPSE` unless renewed by a new decision;
///        - re-enabling (k) takes effect after `REENABLE_NOTICE`; delisting (k) is immediate;
///        - committee changes are signed by the current committee (k) and bump the epoch, which invalidates
///          every decision signed by the previous committee that has not been relayed yet.
///
///      Registry version. Every applied decision increments {version}, and decisions must be relayed in nonce
///      order (`nonce == version + 1`), so every ledger's registry passes through the same sequence of versions
///      and a version number names the same registry state on every ledger. A route pins the version it was
///      sent against (`filter_registry_versions`); each hop reads certifications as of that version. Effective
///      time is a separate, second condition: an entry visible at the pinned version applies only once its
///      notice period has passed (and until its expiry). To keep the sequence from ever getting stuck, handlers
///      whose effect depends on local state (re-enable something not disabled, delist an entry that already
///      lapsed) apply as no-ops instead of reverting; a malformed or expired decision is replaced by the
///      committee signing a new decision with the same nonce.
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
        TRUST_TIER // (bytes32 channelId, string toLedgerId, uint8 tier) — tier TIER_NONE removes the label
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

    error DecisionAlreadyUsed();
    error DecisionExpired();
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

    bytes32 public constant DOMAIN = keccak256("CLPRouter.ProviderRegistry.v1");

    uint64 public immutable CERT_NOTICE;
    uint64 public immutable REMOVAL_NOTICE;
    uint64 public immutable REENABLE_NOTICE;
    uint64 public immutable DISABLE_LAPSE;
    uint64 public immutable BLACKLIST_LAPSE;

    // ── State ───────────────────────────────────────────────────────────────

    /// @notice Registry version: number of decisions applied so far. Monotonically increasing; the next
    ///         decision must carry nonce `version + 1`.
    uint64 public version;

    uint64 public epoch;
    uint8 public threshold;
    address[] private _members;
    mapping(uint64 => mapping(address => bool)) private _isMember;
    mapping(address => bool) public isProviderAccount;

    string public contact;

    mapping(bytes32 => bool) public used;
    mapping(bytes32 => Certification[]) private _certs;
    mapping(bytes32 => Switch) public switches;
    mapping(bytes32 => Listing) public listings;
    mapping(bytes32 => TierLabel) private _tiers;

    /// @param initialMembers Initial committee, strictly ascending addresses.
    /// @param k Signatures needed for a certification change (disable/blacklist need k + 1).
    /// @param contact_ Provider contact address quoted in quarantine notices.
    /// @param notices [certNotice, removalNotice, reenableNotice, disableLapse, blacklistLapse] in seconds.
    constructor(address[] memory initialMembers, uint8 k, string memory contact_, uint64[5] memory notices) {
        _setCommittee(initialMembers, k);
        contact = contact_;
        CERT_NOTICE = notices[0];
        REMOVAL_NOTICE = notices[1];
        REENABLE_NOTICE = notices[2];
        DISABLE_LAPSE = notices[3];
        BLACKLIST_LAPSE = notices[4];
    }

    // ═════════════════════════════════════════════════════════════════════
    // Relaying decisions
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Apply the next committee decision. Anyone may relay it.
    /// @param d The signed decision; `d.nonce` must be `version + 1`.
    /// @param sigs 65-byte ECDSA signatures over the EIP-191 hash of {decisionDigest}, ordered by signer address.
    /// @return digest The decision digest (also the replay key).
    function submit(Decision calldata d, bytes[] calldata sigs) external returns (bytes32 digest) {
        if (
            d.action == uint8(Action.NONE) || d.action == uint8(Action.VAULT_RELEASE)
                || d.action == uint8(Action.VAULT_NAME_RECOVERY) || d.action > uint8(Action.TRUST_TIER)
        ) revert UnsupportedAction();
        Action action = Action(d.action);
        if (block.timestamp > d.validUntil) revert DecisionExpired();
        if (d.evidenceHash == bytes32(0)) revert MissingEvidence();
        if (d.nonce != version + 1) revert OutOfOrder(version + 1, d.nonce);
        digest = decisionDigest(d);
        if (used[digest]) revert DecisionAlreadyUsed();
        checkApproval(digest, d.epoch, sigs, requiredSignatures(d.action));
        used[digest] = true;
        uint64 v = ++version;

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
    function decisionDigest(Decision calldata d) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN, d.action, keccak256(d.payload), d.evidenceHash, d.nonce, d.effectiveAt, d.validUntil, d.epoch
            )
        );
    }

    /// @inheritdoc IProviderRegistry
    function requiredSignatures(uint8 action) public view returns (uint256) {
        if (action == uint8(Action.DISABLE) || action == uint8(Action.BLACKLIST)) return uint256(threshold) + 1;
        return threshold;
    }

    /// @inheritdoc IProviderRegistry
    function checkApproval(bytes32 digest, uint64 decisionEpoch, bytes[] calldata sigs, uint256 required) public view {
        if (decisionEpoch != epoch) revert WrongEpoch();
        bytes32 h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        uint256 valid;
        address last;
        for (uint256 i = 0; i < sigs.length; i++) {
            (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(h, sigs[i]);
            if (err != ECDSA.RecoverError.NoError) revert BadSignature();
            if (signer <= last) revert SignersNotSorted();
            last = signer;
            if (!_isMember[epoch][signer]) revert BadSignature();
            valid++;
        }
        if (valid < required) revert InsufficientSignatures(valid, required);
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
        string memory ledgerId;
        uint8 label;
        uint64 expiry;
        uint64 emissionsUg;
        string memory source;
        if (action == Action.CERTIFY) {
            (ledgerId, label, expiry, emissionsUg, source) =
                abi.decode(d.payload, (string, uint8, uint64, uint64, string));
        } else {
            (ledgerId, label) = abi.decode(d.payload, (string, uint8));
        }
        if (label < LABEL_ISO20022 || label > LABEL_ENERGY) revert InvalidLabel();

        bytes32 key = Caip.certKey(ledgerId, label);
        Certification[] storage log = _certs[key];
        uint64 notice = action == Action.CERTIFY ? CERT_NOTICE : REMOVAL_NOTICE;
        uint64 effectiveFrom = _max(d.effectiveAt, uint64(block.timestamp) + notice);
        // Keep the log ordered by effective time: a later decision never takes effect before an earlier one.
        if (log.length > 0 && log[log.length - 1].effectiveFrom > effectiveFrom) {
            effectiveFrom = log[log.length - 1].effectiveFrom;
        }
        if (action == Action.CERTIFY) {
            if (expiry <= effectiveFrom || expiry > effectiveFrom + MAX_CERT_DURATION) revert InvalidExpiry();
            if (label == LABEL_ENERGY && (emissionsUg == 0 || bytes(source).length == 0)) revert MissingEmissions();
            if (label != LABEL_ENERGY) emissionsUg = 0;
        }
        log.push(
            Certification({
                version: v,
                effectiveFrom: effectiveFrom,
                expiry: expiry,
                certified: action == Action.CERTIFY,
                emissionsUg: emissionsUg,
                evidenceHash: d.evidenceHash
            })
        );
        emit CertificationScheduled(
            key,
            ledgerId,
            label,
            action == Action.CERTIFY,
            effectiveFrom,
            expiry,
            emissionsUg,
            source,
            v,
            d.evidenceHash,
            digest
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
            reenableAt = _max(d.effectiveAt, uint64(block.timestamp) + REENABLE_NOTICE);
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
        uint64 effectiveFrom = _max(d.effectiveAt, uint64(block.timestamp) + notice);
        t.next = stored;
        t.nextFrom = effectiveFrom;
        emit TrustTierScheduled(key, channelId, toLedgerId, tier, effectiveFrom, d.evidenceHash, digest);
    }

    function _committee(Decision calldata d, bytes32 digest) private {
        (address[] memory newMembers, uint8 k) = abi.decode(d.payload, (address[], uint8));
        _setCommittee(newMembers, k);
        emit CommitteeChanged(epoch, newMembers, k, d.evidenceHash, digest);
    }

    function _contact(Decision calldata d, bytes32 digest) private {
        string memory c = abi.decode(d.payload, (string));
        contact = c;
        emit ContactChanged(c, d.evidenceHash, digest);
    }

    function _setCommittee(address[] memory newMembers, uint8 k) private {
        // k >= 1 and k + 1 <= n so that disables and blacklist entries remain possible.
        if (k == 0 || uint256(k) + 1 > newMembers.length) revert InvalidCommittee();
        uint64 next = _members.length == 0 ? 0 : epoch + 1;
        address last;
        for (uint256 i = 0; i < newMembers.length; i++) {
            if (newMembers[i] <= last) revert InvalidCommittee();
            last = newMembers[i];
            _isMember[next][newMembers[i]] = true;
            isProviderAccount[newMembers[i]] = true;
        }
        epoch = next;
        threshold = k;
        _members = newMembers;
    }

    function _max(uint64 a, uint64 b) private pure returns (uint64) {
        return a > b ? a : b;
    }
}
