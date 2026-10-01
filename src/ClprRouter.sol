// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IClprApplication} from "@hiero-ledger/clpr/interfaces/IClprApplication.sol";
import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprTypes} from "@hiero-ledger/clpr/libraries/ClprTypes.sol";
import {IProviderRegistry} from "./interfaces/IProviderRegistry.sol";
import {IQuarantineVault} from "./interfaces/IQuarantineVault.sol";
import {IClprRouteApplication, IClprRouteSender} from "./interfaces/IClprRouteApplication.sol";
import {RouteTypes} from "./libraries/RouteTypes.sol";
import {RouteCodec} from "./libraries/RouteCodec.sol";
import {RouteLogic} from "./libraries/RouteLogic.sol";
import {Caip} from "./libraries/Caip.sol";

/// @title ClprRouter
/// @notice CLPRouter for one ledger: delivers a message (and, at the origin, an escrowed payment) between two
///         ledgers that share no CLPR Channel by forwarding a `ClprRouteEnvelope` across intermediate ledgers.
///         A CLPR application on top of an unchanged CLPR Service: it only calls `sendMessage` and implements
///         `IClprApplication`.
/// @dev Immutable, no admin key, no pause. The only outside inputs that change behaviour are the provider
///      registry (route disables, blacklist, filter certifications, edge trust tiers) whose address is fixed at
///      deployment.
///
///      Flow: `send` on the origin → forward inside CLPR application delivery on each intermediate ledger →
///      deliver to the destination application → receipt back to the origin as a new routed message → origin
///      settles the escrow and fee budget.
///
///      Forwarding inside delivery: on receipt of an envelope the Router checks it and immediately calls
///      `sendMessage` on the next Channel. CLPR Service implementations that guard `sendMessage` and
///      `submitBundle` with one shared reentrancy lock (as the reference Solidity ClprService does) reject
///      that nested call; the Router then records the hop as pending and anyone may complete it with
///      {forward} (or {flush} for receipts) in a later transaction. Every check is re-run at that point.
contract ClprRouter is IClprApplication, ReentrancyGuardTransient {
    // ── Constants ───────────────────────────────────────────────────────────

    /// @notice Envelope and code version; every hop must run the same version.
    uint32 public constant VERSION = 1;

    bytes4 private constant REENTRANT_CALL = bytes4(keccak256("ReentrancyGuardReentrantCall()"));

    uint8 private constant RESP_ACCEPTED = 1;
    uint8 private constant RESP_REJECTED = 2;

    // ── Types ───────────────────────────────────────────────────────────────

    /// @notice Per-route state on a non-origin ledger (also the replay set: anything but NONE was seen).
    enum HopState {
        NONE,
        SEEN,
        FORWARD_PENDING,
        FORWARDED,
        NACKED,
        DONE
    }

    enum RouteStatus {
        NONE,
        PENDING,
        DELIVERED,
        FAILED,
        EXPIRED,
        QUARANTINED
    }

    enum SendResult {
        SENT,
        DEFERRED,
        FAILED
    }

    /// @notice What the origin keeps for a route it sent.
    struct OriginRoute {
        address sender;
        uint64 deadline;
        RouteStatus status;
        bool strict;
        bool verifyPath;
        address payee;
        uint64 feeBudget;
        uint256 escrow;
        bytes32 hopsHash;
        bytes32 firstHop; // keccak256(channelId of hop 0, router of hop 1)
    }

    /// @notice Arguments of {send}.
    /// @param destination Destination ledger and application.
    /// @param recipient CAIP-10 id of the final recipient (checked against the blacklist at every hop).
    /// @param hops Full route from the planner, hops[0] = this ledger and this Router.
    /// @param mode Objective the planner optimised.
    /// @param constraints Filters, deadline, max fee, trust floor, max hops, strict/loose, energy cap.
    ///        `remainingFeeBudget` is ignored: the fee budget is `msg.value - escrow`.
    /// @param payloadType RAW, ISO20022 or ASSET.
    /// @param payload Application bytes (hash or ciphertext under the ISO 20022 / MiCA filters).
    /// @param receiptPath Explicit way back for the delivery receipt; empty = reverse of `hops`.
    /// @param originSignature Optional end-to-end signature by the origin application.
    /// @param routeId Optional caller-chosen 16-byte id (the UETR under ISO 20022); zero = generated.
    /// @param escrow Part of `msg.value` held until the route settles (released to `payee` on delivery).
    /// @param payee Origin-ledger account paid the escrow on a DELIVERED receipt.
    struct SendRequest {
        RouteTypes.Endpoint destination;
        string recipient;
        RouteTypes.Hop[] hops;
        RouteTypes.Mode mode;
        RouteTypes.Constraints constraints;
        RouteTypes.PayloadType payloadType;
        bytes payload;
        RouteTypes.Hop[] receiptPath;
        bytes originSignature;
        bytes16 routeId;
        uint256 escrow;
        address payee;
    }

    // ── Errors ──────────────────────────────────────────────────────────────

    error NotService();
    error InvalidRoute(RouteTypes.Reason reason);
    error RouteBlocked(uint256 hop, RouteTypes.Reason reason);
    error DuplicateRouteId();
    error InsufficientValue();
    error ValueRoutesMustBeStrict();
    error WrongVersion();
    error NotForThisHop();
    error UnexpectedSender();
    error RouteReplayed();
    error NothingPending();
    error LooseRoutingRequired();
    error NotReclaimable();
    error LedgerMismatch();

    // ── Events ──────────────────────────────────────────────────────────────

    event RouteSent(
        bytes16 indexed routeId,
        address indexed sender,
        string destinationLedger,
        uint256 escrow,
        uint64 feeBudget,
        uint64 deadline,
        uint64 messageId
    );
    event RouteForwarded(bytes16 indexed routeId, uint32 hopIndex, bytes32 channelId, uint64 messageId);
    /// @notice A hop could not be sent inside CLPR delivery; complete it with {forward}(envelope, []).
    event ForwardPending(bytes16 indexed routeId, uint32 hopIndex, bytes envelope);
    /// @notice A forward was rejected by the next hop at the CLPR level; complete it with {forward}.
    event ForwardRejected(bytes16 indexed routeId, uint8 clprStatus, bytes envelope);
    /// @notice A receipt could not be sent inside CLPR delivery; complete it with {flush}.
    event OutboxQueued(bytes32 indexed key, bytes32 channelId, bytes32 connectorId, bytes target, bytes data);
    event RouteDelivered(bytes16 indexed routeId, address indexed application, bytes32 responseHash);
    event RouteStopped(
        bytes16 indexed routeId, uint32 hopIndex, RouteTypes.ReceiptStatus status, RouteTypes.Reason reason
    );
    event ReceiptSent(
        bytes16 indexed receiptId, bytes16 indexed routeId, RouteTypes.ReceiptStatus status, RouteTypes.Reason reason
    );
    event ReceiptUndeliverable(bytes16 indexed routeId, RouteTypes.Reason reason);
    event ReceiptIgnored(bytes16 indexed routeId);
    /// @notice Notice to the recipient that a transfer is held; no accusation, only whom to contact.
    event QuarantineNotice(
        bytes32 indexed recipientKey, bytes16 indexed routeId, string recipient, bytes32 caseId, string contact
    );
    event RouteSettled(
        bytes16 indexed routeId,
        RouteStatus status,
        RouteTypes.Reason reason,
        uint32 hopIndex,
        bytes32 caseId,
        string contact,
        uint256 feesPaid
    );
    event HopResponse(bytes16 indexed routeId, bytes32 channelId, uint64 messageId, uint8 status);

    // ── Immutable configuration ─────────────────────────────────────────────

    IClprService public immutable SERVICE;
    IProviderRegistry public immutable REGISTRY;
    IQuarantineVault public immutable VAULT;
    /// @notice Time after the deadline before the origin may reclaim a route that never got a receipt.
    uint64 public immutable RECLAIM_GRACE;
    /// @notice Gas given to destination applications and notice / receipt hooks.
    uint64 public immutable APP_GAS;

    bytes32 private immutable _LEDGER_HASH;
    bytes32 private immutable _SELF_HASH;
    bytes32 private immutable _SELF_ROUTER_KEY;

    /// @notice CAIP-2 id of the ledger this Router runs on (equals the CLPR Service's chain id).
    string public ledgerId;

    // ── State ───────────────────────────────────────────────────────────────

    mapping(bytes16 => OriginRoute) public routes;
    mapping(bytes16 => HopState) public hopState;
    /// @notice keccak256 of the envelope (as held on this ledger) of a pending, forwarded or rejected hop.
    mapping(bytes16 => bytes32) public pendingHash;
    /// @notice keccak256(channelId, messageId) of an outbound CLPR message → route id.
    mapping(bytes32 => bytes16) public outbound;
    /// @notice Deferred raw sends (receipts) by keccak256(abi.encode(channel, connector, target, data)).
    mapping(bytes32 => bool) public outbox;
    /// @notice Pull payments that could not be pushed.
    mapping(address => uint256) public owed;

    mapping(bytes32 => bytes32) private _peerLedger;
    uint256 private _nonce;

    /// @param service The CLPR Service on this ledger.
    /// @param registry The provider registry on this ledger (fixed forever).
    /// @param vault The quarantine vault on this ledger (fixed forever).
    /// @param ledgerId_ CAIP-2 id of this ledger; must equal the Service's configured chain id.
    /// @param reclaimGrace Seconds after a route's deadline before the origin may reclaim it.
    /// @param appGas Gas stipend for application callbacks.
    constructor(
        IClprService service,
        IProviderRegistry registry,
        IQuarantineVault vault,
        string memory ledgerId_,
        uint64 reclaimGrace,
        uint64 appGas
    ) {
        if (keccak256(bytes(service.getLedgerConfiguration().chainId)) != keccak256(bytes(ledgerId_))) {
            revert LedgerMismatch();
        }
        SERVICE = service;
        REGISTRY = registry;
        VAULT = vault;
        RECLAIM_GRACE = reclaimGrace;
        APP_GAS = appGas;
        ledgerId = ledgerId_;
        _LEDGER_HASH = keccak256(bytes(ledgerId_));
        _SELF_HASH = keccak256(abi.encodePacked(address(this)));
        _SELF_ROUTER_KEY = Caip.routerKey(ledgerId_, abi.encodePacked(address(this)));
    }

    // ═════════════════════════════════════════════════════════════════════
    // Origin: send
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Send a routed message, optionally with an escrowed payment.
    /// @dev `msg.value = escrow + fee budget`. Reverts if the route is malformed, disabled or fails a filter
    ///      (nothing moves), or if a loose route carries any value ({ValueRoutesMustBeStrict}). If the sender, recipient or payee is blacklisted the call succeeds but nothing is
    ///      forwarded: all value goes to the quarantine vault and the route settles as QUARANTINED.
    /// @return routeId The route id.
    function send(SendRequest calldata req) external payable nonReentrant returns (bytes16 routeId) {
        if (msg.value < req.escrow) revert InsufficientValue();
        uint256 budget = msg.value - req.escrow;
        if (budget > type(uint64).max) revert InvalidRoute(RouteTypes.Reason.FEE_BUDGET);

        RouteTypes.Envelope memory e = _buildEnvelope(req, uint64(budget));
        routeId = e.routeId;

        OriginRoute storage o = routes[routeId];
        o.sender = msg.sender;
        o.deadline = e.constraints.deadline;
        o.status = RouteStatus.PENDING;
        o.strict = !e.constraints.loose;
        o.verifyPath = !e.constraints.loose && e.receiptPath.length == 0;
        o.payee = req.payee;
        o.feeBudget = uint64(budget);
        o.escrow = req.escrow;
        o.hopsHash = RouteCodec.hashHops(e.hops);
        o.firstHop = keccak256(abi.encodePacked(e.hops[0].channelId, e.hops[1].router));
        hopState[routeId] = HopState.DONE;

        // Blacklist: the origin checks the sender, the final recipient and the payee before taking the funds.
        (bool listed, bytes32 caseId) = _listed(e.sender);
        if (!listed) (listed, caseId) = _listed(e.recipient);
        if (!listed && req.payee != address(0)) (listed, caseId) = _listed(Caip.account(ledgerId, req.payee));
        if (listed) {
            emit RouteSent(routeId, msg.sender, e.destination.ledgerId, req.escrow, uint64(budget), o.deadline, 0);
            emit QuarantineNotice(Caip.accountKey(e.recipient), routeId, e.recipient, caseId, REGISTRY.contact());
            _finish(routeId, RouteStatus.QUARANTINED, RouteTypes.Reason.BLACKLIST, 0, caseId, bytes32(0), e.hops);
            return routeId;
        }

        e.constraints.remainingFeeBudget = uint64(budget) - e.hops[0].fee;
        e.hopIndex = 1;
        uint64 messageId = SERVICE.sendMessage(
            e.hops[0].channelId, e.hops[0].connectorId, e.hops[1].router, RouteCodec.encodeEnvelope(e)
        );
        outbound[keccak256(abi.encodePacked(e.hops[0].channelId, messageId))] = routeId;
        emit RouteSent(routeId, msg.sender, e.destination.ledgerId, req.escrow, uint64(budget), o.deadline, messageId);
    }

    /// @notice Refund a route that never got a receipt, once its deadline plus {RECLAIM_GRACE} has passed.
    /// @dev Anyone may call; the escrow and the whole fee budget go back to the sender.
    function reclaim(bytes16 routeId) external nonReentrant {
        OriginRoute storage o = routes[routeId];
        if (o.status != RouteStatus.PENDING || block.timestamp <= uint256(o.deadline) + RECLAIM_GRACE) {
            revert NotReclaimable();
        }
        _finish(routeId, RouteStatus.EXPIRED, RouteTypes.Reason.DEADLINE, 0, bytes32(0), bytes32(0), _noHops());
    }

    /// @notice Withdraw payments that could not be pushed.
    function withdraw() external nonReentrant {
        uint256 amount = owed[msg.sender];
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    // ═════════════════════════════════════════════════════════════════════
    // CLPR application delivery
    // ═════════════════════════════════════════════════════════════════════

    /// @notice CLPR delivery of an envelope from the previous hop's Router.
    /// @dev Reverts (CLPR APPLICATION_ERROR to the previous hop) only if the envelope is malformed, not
    ///      addressed to this hop, not from the Router named for the previous hop, or a replay. Every other
    ///      outcome — forwarded, pending, delivered, or stopped with a receipt — returns normally.
    /// @return response `abi.encodePacked(uint8 accepted|rejected, uint8 reason)`.
    function onClprMessage(bytes32 channelId, bytes calldata sender, bytes calldata messageData)
        external
        nonReentrant
        returns (bytes memory response)
    {
        if (msg.sender != address(SERVICE)) revert NotService();
        RouteTypes.Envelope memory e = RouteCodec.decodeEnvelope(messageData);
        _validateInbound(e, channelId, sender);
        hopState[e.routeId] = HopState.SEEN;
        RouteTypes.Reason reason = _advance(e, messageData);
        return abi.encodePacked(reason == RouteTypes.Reason.NONE ? RESP_ACCEPTED : RESP_REJECTED, uint8(reason));
    }

    /// @notice CLPR Response to a message this Router sent.
    /// @dev A non-SUCCESS response means the next hop never processed the envelope (connector failure or the
    ///      next Router rejected it). The origin settles the route as FAILED; an intermediate hop marks it
    ///      NACKED so anyone can re-route it (loose routing) or report the failure ({forward}).
    function onClprResponse(bytes32 channelId, uint64 messageId, uint8 status, bytes calldata) external nonReentrant {
        if (msg.sender != address(SERVICE)) revert NotService();
        bytes32 k = keccak256(abi.encodePacked(channelId, messageId));
        bytes16 routeId = outbound[k];
        if (routeId == bytes16(0)) return;
        delete outbound[k];
        emit HopResponse(routeId, channelId, messageId, status);
        bool ok = status == uint8(ClprTypes.ReplyStatus.SUCCESS);

        if (routes[routeId].status == RouteStatus.PENDING) {
            if (!ok) {
                _finish(
                    routeId, RouteStatus.FAILED, RouteTypes.Reason.NEXT_HOP_ERROR, 0, bytes32(0), bytes32(0), _noHops()
                );
            }
            return;
        }
        if (hopState[routeId] != HopState.FORWARDED) return;
        if (ok) {
            hopState[routeId] = HopState.DONE;
            delete pendingHash[routeId];
        } else {
            hopState[routeId] = HopState.NACKED;
            emit ForwardRejected(routeId, status, "");
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // Permissionless completion of deferred hops
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Complete a pending or rejected hop. Anyone may call.
    /// @param envelope The envelope as held on this ledger (from {ForwardPending} / the inbound CLPR message).
    /// @param newTail Loose routing only: replacement hops from this ledger to the destination
    ///        (newTail[0] is this ledger with its new outgoing Channel). Empty = keep the route.
    /// @dev A pending hop is re-checked and forwarded. A rejected hop is re-routed over `newTail` when the
    ///      route is loose and a tail is given; otherwise a FAILED (NEXT_HOP_ERROR) receipt goes to the origin.
    function forward(bytes calldata envelope, RouteTypes.Hop[] calldata newTail) external nonReentrant {
        RouteTypes.Envelope memory e = RouteCodec.decodeEnvelope(envelope);
        HopState st = hopState[e.routeId];
        if ((st != HopState.FORWARD_PENDING && st != HopState.NACKED) || pendingHash[e.routeId] != keccak256(envelope))
        {
            revert NothingPending();
        }
        delete pendingHash[e.routeId];
        bytes memory held = envelope;
        if (newTail.length > 0) {
            if (!e.constraints.loose) revert LooseRoutingRequired();
            e = RouteLogic.splice(e, newTail, _LEDGER_HASH, _SELF_HASH);
            held = RouteCodec.encodeEnvelope(e);
        } else if (st == HopState.NACKED) {
            _stop(e, RouteTypes.ReceiptStatus.FAILED, RouteTypes.Reason.NEXT_HOP_ERROR, bytes32(0));
            return;
        }
        hopState[e.routeId] = HopState.SEEN;
        _advance(e, held);
    }

    /// @notice Send a deferred receipt. Anyone may call.
    function flush(bytes32 channelId, bytes32 connectorId, bytes calldata target, bytes calldata data)
        external
        nonReentrant
    {
        bytes32 k = keccak256(abi.encode(channelId, connectorId, target, data));
        if (!outbox[k]) revert NothingPending();
        delete outbox[k];
        SERVICE.sendMessage(channelId, connectorId, target, data);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Hop processing
    // ═════════════════════════════════════════════════════════════════════

    /// @dev Process an envelope held on this ledger at `e.hopIndex`: stop it, deliver it, settle it (receipt at
    ///      the origin), or forward it. Returns NONE unless the route was stopped here.
    function _advance(RouteTypes.Envelope memory e, bytes memory held) private returns (RouteTypes.Reason) {
        bool isReceipt = e.payloadType == RouteTypes.PayloadType.RECEIPT;
        uint256 idx = e.hopIndex;
        uint256 last = e.hops.length - 1;

        (RouteTypes.ReceiptStatus st, RouteTypes.Reason reason, bytes32 caseId) = _checkHere(e, isReceipt);
        if (reason != RouteTypes.Reason.NONE) {
            _stop(e, st, reason, caseId);
            return reason;
        }

        if (idx == last) {
            hopState[e.routeId] = HopState.DONE;
            if (isReceipt) _settle(e);
            else _deliver(e);
            return RouteTypes.Reason.NONE;
        }

        reason = _checkNext(e, idx, isReceipt);
        if (reason != RouteTypes.Reason.NONE) {
            _stop(e, RouteTypes.ReceiptStatus.FAILED, reason, bytes32(0));
            return reason;
        }

        RouteTypes.Hop memory h = e.hops[idx];
        if (!isReceipt) e.constraints.remainingFeeBudget -= h.fee;
        e.hopIndex = uint32(idx + 1);
        (SendResult r, uint64 messageId) =
            _trySend(h.channelId, h.connectorId, e.hops[idx + 1].router, RouteCodec.encodeEnvelope(e));

        if (r == SendResult.SENT) {
            emit RouteForwarded(e.routeId, uint32(idx), h.channelId, messageId);
            if (isReceipt) {
                hopState[e.routeId] = HopState.DONE;
            } else {
                hopState[e.routeId] = HopState.FORWARDED;
                pendingHash[e.routeId] = keccak256(held);
                outbound[keccak256(abi.encodePacked(h.channelId, messageId))] = e.routeId;
            }
        } else if (r == SendResult.DEFERRED) {
            hopState[e.routeId] = HopState.FORWARD_PENDING;
            pendingHash[e.routeId] = keccak256(held);
            emit ForwardPending(e.routeId, uint32(idx), held);
        } else if (!isReceipt && e.constraints.loose) {
            hopState[e.routeId] = HopState.NACKED;
            pendingHash[e.routeId] = keccak256(held);
            emit ForwardRejected(e.routeId, 0, held);
        } else {
            e.hopIndex = uint32(idx);
            _stop(e, RouteTypes.ReceiptStatus.FAILED, RouteTypes.Reason.SEND_FAILED, bytes32(0));
            return RouteTypes.Reason.SEND_FAILED;
        }
        return RouteTypes.Reason.NONE;
    }

    /// @dev Checks about the ledger holding the message: own Router disabled, arrived over a disabled edge /
    ///      ledger / Router, deadline, blacklist. Receipts only get the route-safety checks.
    function _checkHere(RouteTypes.Envelope memory e, bool isReceipt)
        private
        view
        returns (RouteTypes.ReceiptStatus, RouteTypes.Reason, bytes32)
    {
        RouteTypes.Reason safety =
            RouteLogic.hereSafety(REGISTRY, _SELF_ROUTER_KEY, VERSION, ledgerId, e.hops[e.hopIndex - 1]);
        if (safety != RouteTypes.Reason.NONE) return (RouteTypes.ReceiptStatus.FAILED, safety, 0);
        if (isReceipt) return (RouteTypes.ReceiptStatus.UNSPECIFIED, RouteTypes.Reason.NONE, 0);

        if (block.timestamp > e.constraints.deadline) {
            return (RouteTypes.ReceiptStatus.EXPIRED, RouteTypes.Reason.DEADLINE, 0);
        }
        (bool listed, bytes32 caseId) = _listed(e.sender);
        if (!listed) (listed, caseId) = _listed(e.recipient);
        if (listed) return (RouteTypes.ReceiptStatus.QUARANTINED, RouteTypes.Reason.BLACKLIST, caseId);
        return (RouteTypes.ReceiptStatus.UNSPECIFIED, RouteTypes.Reason.NONE, 0);
    }

    /// @dev Checks on the edge leaving hop `idx`: disabled edge, ledger or Router; Channel goes to the named
    ///      ledger; (routes only) filters on the next ledger at the pinned registry version, the edge's trust tier
    ///      against the route's trust floor, and fee budget.
    function _checkNext(RouteTypes.Envelope memory e, uint256 idx, bool isReceipt) private returns (RouteTypes.Reason) {
        RouteTypes.Hop memory h = e.hops[idx];
        RouteTypes.Hop memory next = e.hops[idx + 1];
        RouteTypes.Reason r = RouteLogic.edgeSafety(REGISTRY, h, next);
        if (r != RouteTypes.Reason.NONE) return r;
        if (_peerLedgerHash(h.channelId) != keccak256(bytes(next.ledgerId))) return RouteTypes.Reason.BAD_ROUTE;
        if (isReceipt) return RouteTypes.Reason.NONE;
        if (!RouteLogic.filtersPass(REGISTRY, next.ledgerId, e.constraints, e.filterRegistryVersions)) {
            return RouteTypes.Reason.FILTER;
        }
        if (!RouteLogic.edgeTrusted(REGISTRY, h, next, e.constraints.trustFloor)) return RouteTypes.Reason.TRUST_FLOOR;
        if (e.constraints.remainingFeeBudget < h.fee) return RouteTypes.Reason.FEE_BUDGET;
        return RouteTypes.Reason.NONE;
    }

    /// @dev Deliver to the destination application and send the DELIVERED (or FAILED) receipt.
    function _deliver(RouteTypes.Envelope memory e) private {
        address app = _toAddress(e.destination.application);
        if (keccak256(bytes(e.destination.ledgerId)) != _LEDGER_HASH || app.code.length == 0) {
            _stop(e, RouteTypes.ReceiptStatus.FAILED, RouteTypes.Reason.BAD_ROUTE, bytes32(0));
            return;
        }
        try IClprRouteApplication(app).onRouteMessage{gas: APP_GAS}(
            e.routeId, e.origin.ledgerId, e.origin.application, e.sender, uint8(e.payloadType), e.payload
        ) returns (
            bytes memory resp
        ) {
            bytes32 respHash = keccak256(resp);
            emit RouteDelivered(e.routeId, app, respHash);
            _sendReceipt(e, RouteTypes.ReceiptStatus.DELIVERED, RouteTypes.Reason.NONE, bytes32(0), respHash);
        } catch {
            _stop(e, RouteTypes.ReceiptStatus.FAILED, RouteTypes.Reason.APPLICATION_ERROR, bytes32(0));
        }
    }

    /// @dev Stop a route here. Routes get a receipt to the origin (and quarantine notices); receipts are dropped.
    function _stop(
        RouteTypes.Envelope memory e,
        RouteTypes.ReceiptStatus status,
        RouteTypes.Reason reason,
        bytes32 caseId
    ) private {
        hopState[e.routeId] = HopState.DONE;
        if (e.payloadType == RouteTypes.PayloadType.RECEIPT) {
            emit ReceiptUndeliverable(e.routeId, reason);
            return;
        }
        emit RouteStopped(e.routeId, e.hopIndex, status, reason);
        if (status == RouteTypes.ReceiptStatus.QUARANTINED) {
            string memory contact_ = REGISTRY.contact();
            emit QuarantineNotice(Caip.accountKey(e.recipient), e.routeId, e.recipient, caseId, contact_);
            if (e.hopIndex == e.hops.length - 1) {
                address app = _toAddress(e.destination.application);
                if (app.code.length > 0) {
                    try IClprRouteApplication(app).onRouteNotice{gas: APP_GAS}(e.routeId, caseId, contact_) {} catch {}
                }
            }
        }
        _sendReceipt(e, status, reason, caseId, bytes32(0));
    }

    /// @dev Build and send a receipt for route `e` from this hop back to the origin, as a new routed message.
    function _sendReceipt(
        RouteTypes.Envelope memory e,
        RouteTypes.ReceiptStatus status,
        RouteTypes.Reason reason,
        bytes32 caseId,
        bytes32 responseHash
    ) private {
        RouteTypes.Receipt memory r;
        r.status = status;
        r.reason = reason;
        r.caseId = caseId;
        r.responseHash = responseHash;
        if (status == RouteTypes.ReceiptStatus.QUARANTINED) r.contact = REGISTRY.contact();
        (bytes16 receiptId, RouteTypes.Hop[] memory hops, bytes memory data) =
            RouteLogic.buildReceipt(e, r, ledgerId, address(this), VERSION);
        hopState[receiptId] = HopState.DONE;
        emit ReceiptSent(receiptId, e.routeId, status, reason);

        RouteTypes.Hop memory h = hops[0];
        RouteTypes.Reason blocked = RouteLogic.edgeSafety(REGISTRY, h, hops[1]);
        if (blocked != RouteTypes.Reason.NONE) {
            emit ReceiptUndeliverable(e.routeId, blocked);
            return;
        }
        (SendResult res,) = _trySend(h.channelId, h.connectorId, hops[1].router, data);
        if (res == SendResult.DEFERRED) {
            bytes32 k = keccak256(abi.encode(h.channelId, h.connectorId, hops[1].router, data));
            outbox[k] = true;
            emit OutboxQueued(k, h.channelId, h.connectorId, hops[1].router, data);
        } else if (res == SendResult.FAILED) {
            emit ReceiptUndeliverable(e.routeId, RouteTypes.Reason.SEND_FAILED);
        }
    }

    /// @dev A receipt envelope reached the origin: authenticate it against the stored route and settle.
    function _settle(RouteTypes.Envelope memory re) private {
        RouteTypes.Receipt memory r = RouteCodec.decodeReceipt(re.payload);
        OriginRoute storage o = routes[r.routeId];
        bool ok = o.status == RouteStatus.PENDING
            && RouteLogic.receiptValid(re, r, o.firstHop, o.strict ? o.hopsHash : bytes32(0), o.verifyPath);
        if (!ok) {
            emit ReceiptIgnored(r.routeId);
            return;
        }
        RouteStatus s = r.status == RouteTypes.ReceiptStatus.DELIVERED
            ? RouteStatus.DELIVERED
            : r.status == RouteTypes.ReceiptStatus.EXPIRED
                ? RouteStatus.EXPIRED
                : r.status == RouteTypes.ReceiptStatus.QUARANTINED ? RouteStatus.QUARANTINED : RouteStatus.FAILED;
        _finish(r.routeId, s, r.reason, r.hopIndex, r.caseId, r.responseHash, r.routeHops);
    }

    /// @dev Pay hop fees for the hops that forwarded, then release, refund or quarantine the rest.
    function _finish(
        bytes16 routeId,
        RouteStatus status,
        RouteTypes.Reason reason,
        uint32 reachedHop,
        bytes32 caseId,
        bytes32 responseHash,
        RouteTypes.Hop[] memory hops
    ) private {
        OriginRoute storage o = routes[routeId];
        uint256 budget = o.feeBudget;
        uint256 escrow = o.escrow;
        address sender = o.sender;
        address payee = o.payee;

        // Late blacklist entries still catch a route that is about to pay out.
        if (status == RouteStatus.DELIVERED) {
            (bool listed, bytes32 cid) = _listed(Caip.account(ledgerId, sender));
            if (!listed && payee != address(0)) (listed, cid) = _listed(Caip.account(ledgerId, payee));
            if (listed) {
                status = RouteStatus.QUARANTINED;
                reason = RouteTypes.Reason.BLACKLIST;
                caseId = cid;
            }
        }
        o.status = status;

        uint256 paid;
        for (uint256 i = 0; i < reachedHop && i + 1 < hops.length; i++) {
            uint256 fee = hops[i].fee;
            if (fee == 0 || hops[i].feePayee.length != 20 || paid + fee > budget) continue;
            paid += fee;
            _pay(_toAddress(hops[i].feePayee), fee);
        }
        uint256 rest = budget - paid;
        string memory contact_;
        if (status == RouteStatus.QUARANTINED) {
            contact_ = REGISTRY.contact();
            if (escrow + rest > 0) VAULT.deposit{value: escrow + rest}(routeId, caseId, sender, payee);
        } else if (status == RouteStatus.DELIVERED) {
            _pay(payee, escrow);
            _pay(sender, rest);
        } else {
            _pay(sender, escrow + rest);
        }
        emit RouteSettled(routeId, status, reason, reachedHop, caseId, contact_, paid);

        if (sender.code.length > 0) {
            try IClprRouteSender(sender).onRouteReceipt{gas: APP_GAS}(
                routeId, uint8(status), uint8(reason), caseId, responseHash
            ) {}
                catch {}
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // Validation helpers
    // ═════════════════════════════════════════════════════════════════════

    function _buildEnvelope(SendRequest calldata req, uint64 budget) private returns (RouteTypes.Envelope memory e) {
        if (req.payloadType == RouteTypes.PayloadType.RECEIPT) revert InvalidRoute(RouteTypes.Reason.BAD_ROUTE);
        // Value routes are strict: the origin settles fees and escrow against the hop list it stored, which a
        // loose route may change. So a loose route carries no value at all (no escrow and no fee budget).
        if (
            (req.constraints.loose && msg.value > 0)
                || (req.escrow > 0 && (req.receiptPath.length > 0 || req.payee == address(0)))
        ) revert ValueRoutesMustBeStrict();
        e.routeId = req.routeId == bytes16(0)
            ? bytes16(keccak256(abi.encodePacked(address(this), ledgerId, msg.sender, ++_nonce)))
            : req.routeId;
        if (hopState[e.routeId] != HopState.NONE || routes[e.routeId].status != RouteStatus.NONE) {
            revert DuplicateRouteId();
        }
        e.origin = RouteTypes.Endpoint({ledgerId: ledgerId, application: abi.encodePacked(msg.sender)});
        e.destination = req.destination;
        e.sender = Caip.account(ledgerId, msg.sender);
        e.recipient = req.recipient;
        e.hops = req.hops;
        e.mode = req.mode;
        e.constraints = req.constraints;
        e.constraints.remainingFeeBudget = budget;
        e.payloadType = req.payloadType;
        e.payload = req.payload;
        e.receiptPath = req.receiptPath;
        e.originSignature = req.originSignature;
        e.routerVersion = VERSION;

        e = RouteLogic.prepareSend(e, _LEDGER_HASH, _SELF_HASH, req.constraints.filters == 0 ? 0 : REGISTRY.version());

        // Route safety and filters on every ledger and edge, before any value moves.
        (uint256 hop, RouteTypes.Reason blocked) = RouteLogic.checkRoute(REGISTRY, _SELF_ROUTER_KEY, VERSION, e);
        if (blocked != RouteTypes.Reason.NONE) revert RouteBlocked(hop, blocked);
        if (_peerLedgerHash(e.hops[0].channelId) != keccak256(bytes(e.hops[1].ledgerId))) {
            revert RouteBlocked(0, RouteTypes.Reason.BAD_ROUTE);
        }
    }

    /// @dev Inbound checks; any failure reverts so the previous hop sees a CLPR APPLICATION_ERROR.
    function _validateInbound(RouteTypes.Envelope memory e, bytes32 channelId, bytes calldata sender) private {
        if (e.routerVersion != VERSION) revert WrongVersion();
        RouteLogic.validateStructure(e);
        uint256 idx = e.hopIndex;
        if (idx == 0 || idx >= e.hops.length) revert NotForThisHop();
        RouteTypes.Hop memory here = e.hops[idx];
        RouteTypes.Hop memory prev = e.hops[idx - 1];
        if (keccak256(bytes(here.ledgerId)) != _LEDGER_HASH || keccak256(here.router) != _SELF_HASH) {
            revert NotForThisHop();
        }
        if (prev.channelId != channelId || keccak256(prev.router) != keccak256(sender)) revert UnexpectedSender();
        if (_peerLedgerHash(channelId) != keccak256(bytes(prev.ledgerId))) revert UnexpectedSender();
        if (e.payloadType != RouteTypes.PayloadType.RECEIPT && e.constraints.deadline == 0) {
            revert InvalidRoute(RouteTypes.Reason.DEADLINE);
        }
        if (hopState[e.routeId] != HopState.NONE || routes[e.routeId].status != RouteStatus.NONE) {
            revert RouteReplayed();
        }
    }

    function _listed(string memory caip10) private view returns (bool, bytes32) {
        if (bytes(caip10).length == 0) return (false, 0);
        return REGISTRY.blacklisted(Caip.accountKey(caip10));
    }

    /// @dev keccak256 of the CAIP-2 id of the peer of `channelId`, cached after the first lookup.
    function _peerLedgerHash(bytes32 channelId) private returns (bytes32 h) {
        h = _peerLedger[channelId];
        if (h != bytes32(0)) return h;
        h = RouteLogic.peerLedgerHash(SERVICE, channelId);
        if (h != bytes32(0)) _peerLedger[channelId] = h;
    }

    function _trySend(bytes32 channelId, bytes32 connectorId, bytes memory target, bytes memory data)
        private
        returns (SendResult, uint64)
    {
        try SERVICE.sendMessage(channelId, connectorId, target, data) returns (uint64 id) {
            return (SendResult.SENT, id);
        } catch (bytes memory err) {
            if (err.length >= 4 && bytes4(err) == REENTRANT_CALL) return (SendResult.DEFERRED, 0);
            return (SendResult.FAILED, 0);
        }
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount, gas: 30_000}("");
        if (!ok) owed[to] += amount;
    }

    function _toAddress(bytes memory b) private pure returns (address) {
        if (b.length != 20) return address(0);
        return address(bytes20(b));
    }

    function _noHops() private pure returns (RouteTypes.Hop[] memory) {
        return new RouteTypes.Hop[](0);
    }
}
