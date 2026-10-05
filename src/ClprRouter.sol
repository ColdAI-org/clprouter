// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IClprApplication} from "@hiero-ledger/clpr/interfaces/IClprApplication.sol";
import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprTypes} from "@hiero-ledger/clpr/libraries/ClprTypes.sol";
import {IProviderRegistry} from "./interfaces/IProviderRegistry.sol";
import {IQuarantineVault} from "./interfaces/IQuarantineVault.sol";
import {IClprRouter, IClprRouterDeployer} from "./interfaces/IClprRouter.sol";
import {IClprRouteApplication} from "./interfaces/IClprRouteApplication.sol";
import {RouteTypes} from "./libraries/RouteTypes.sol";
import {RouteCodec} from "./libraries/RouteCodec.sol";
import {RouteLogic} from "./libraries/RouteLogic.sol";
import {RouteSettlement} from "./libraries/RouteSettlement.sol";
import {RouteOrigin} from "./libraries/RouteOrigin.sol";
import {RouteReceipts} from "./libraries/RouteReceipts.sol";
import {Caip} from "./libraries/Caip.sol";

/// @title ClprRouter
/// @notice CLPRouter for one ledger: delivers a message (and, at the origin, an escrowed payment) between two
///         ledgers that share no CLPR Channel by forwarding a `ClprRouteEnvelope` across intermediate ledgers.
///         A CLPR application on top of an unchanged CLPR Service: it only calls `sendMessage` and implements
///         `IClprApplication`.
/// @dev Immutable, no admin key, no pause. Deployed by {ClprRouterDeployer} at the canonical CREATE2 address of its
///      ledger; it accepts envelopes only from, and forwards only to, the canonical Routers of the deployment, and
///      only over Channel directions the provider registry approves (with, on the receiving side, exactly the
///      verifier the approval names), so every envelope on the wire was built by this code and carried by an
///      approved Channel. The only outside inputs that change behaviour are the provider registry (Channel
///      approvals and trust tiers, route disables, blacklist, filter certifications) whose address is fixed at
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
///      {forward} (receipts: {flush}) in a later transaction. Every check is re-run at that point.
///
///      Receipts are never dropped: a receipt that cannot be sent (deferred, transient failure, blocked edge) or
///      that CLPR rejects waits in the outbox until {flush} sends it; one that arrives over a disabled edge,
///      ledger or Router is held until {forward} can process it.
contract ClprRouter is IClprApplication, IClprRouter, ReentrancyGuardTransient {
    // ── Constants ───────────────────────────────────────────────────────────

    /// @notice Envelope and code version; every hop must run the same version.
    uint32 public constant VERSION = 1;
    /// @notice Bytes of a destination application's response that are copied and hashed (the rest is ignored).
    uint256 public constant MAX_RESPONSE = 4096;

    uint8 private constant RESP_ACCEPTED = 1;
    uint8 private constant RESP_REJECTED = 2;
    uint8 private constant KIND_ORIGIN = 0;
    uint8 private constant KIND_HOP = 1;
    uint8 private constant KIND_RECEIPT = 2;

    enum SendResult {
        SENT,
        DEFERRED,
        FAILED
    }

    // ── Immutable configuration ─────────────────────────────────────────────

    IClprService public immutable SERVICE;
    IProviderRegistry public immutable REGISTRY;
    IQuarantineVault public immutable VAULT;
    /// @notice Worst-case latency of one receipt edge (relay plus permissionless pump). The origin accepts a
    ///         reclaim request after the deadline plus this much per edge of the way back, and finalises it this
    ///         much later.
    uint64 public immutable RECLAIM_GRACE;
    /// @notice Gas given to destination applications and notice / receipt hooks.
    uint64 public immutable APP_GAS;
    /// @notice Gas that must be left before calling `sendMessage` from a hop. Below it (or when the call runs out
    ///         of gas) a permissionless {forward} reverts as a whole, and a send inside delivery stays pending,
    ///         so nobody can fail a hop for good by under-funding the transaction.
    uint64 public immutable MIN_SEND_GAS;
    /// @notice The {ClprRouterDeployer} of the deployment, its salt and the Router init-code hash: together they
    ///         fix the canonical Router address of every EVM ledger ({canonicalRouter}).
    address public immutable DEPLOYER;
    bytes32 public immutable DEPLOYMENT_SALT;
    bytes32 public immutable INIT_CODE_HASH;

    bytes32 private immutable _LEDGER_HASH;
    bytes32 private immutable _SELF_HASH;
    bytes32 private immutable _SELF_ROUTER_KEY;

    /// @notice CAIP-2 id of the ledger this Router runs on (the CLPR Service's chain id, normalised to CAIP-2).
    string public ledgerId;

    // ── State ───────────────────────────────────────────────────────────────

    /// @notice Routes this Router originated, by route id.
    mapping(bytes16 => OriginRoute) public routes;
    /// @notice Received envelopes by RouteLogic.inboundKey (origin ledger, origin Router, id).
    mapping(bytes32 => HopState) public hopState;
    /// @notice keccak256 of the envelope (as held on this ledger) of a pending, held, forwarded or rejected hop.
    mapping(bytes32 => bytes32) public pendingHash;
    /// @notice keccak256(channelId, messageId) of an outbound CLPR message → what it carries.
    mapping(bytes32 => Outbound) public outbound;
    /// @notice Receipt messages waiting to be sent, by keccak256(abi.encode(channel, connector, target, data)).
    mapping(bytes32 => bool) public outbox;
    /// @notice Pull payments that could not be pushed.
    mapping(address => uint256) public owed;
    /// @notice Routes sent so far by each sender (the next route id's nonce).
    mapping(address => uint256) public nonces;

    mapping(bytes32 => bytes32) private _peerLedger;
    /// @dev Set while handling CLPR delivery: a send that cannot go through now is deferred instead of reverting.
    bool private transient _inDelivery;

    /// @dev Deployed only by {ClprRouterDeployer}, which supplies the parameters (see IClprRouterDeployer.Params).
    constructor() {
        IClprRouterDeployer d = IClprRouterDeployer(msg.sender);
        IClprRouterDeployer.Params memory p = d.parameters();
        if (RouteLogic.ledgerHash(p.service.getLedgerConfiguration().chainId) != keccak256(bytes(p.ledgerId))) {
            revert LedgerMismatch();
        }
        SERVICE = p.service;
        REGISTRY = p.registry;
        VAULT = p.vault;
        RECLAIM_GRACE = p.reclaimGrace;
        APP_GAS = p.appGas;
        MIN_SEND_GAS = p.minSendGas;
        DEPLOYER = msg.sender;
        DEPLOYMENT_SALT = d.DEPLOYMENT_SALT();
        INIT_CODE_HASH = d.INIT_CODE_HASH();
        ledgerId = p.ledgerId;
        _LEDGER_HASH = keccak256(bytes(p.ledgerId));
        _SELF_HASH = keccak256(abi.encodePacked(address(this)));
        _SELF_ROUTER_KEY = Caip.routerKey(p.ledgerId, abi.encodePacked(address(this)));
    }

    /// @notice Canonical Router address of the EVM ledger `ledgerId_` in this deployment.
    function canonicalRouter(string calldata ledgerId_) external view returns (address) {
        return RouteLogic.canonicalRouter(_canon(), ledgerId_);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Origin: send, reclaim, withdraw
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Send a routed message, optionally with an escrowed payment.
    /// @dev `msg.value = escrow + fee budget`. Reverts if the route is malformed, names a non-canonical Router, is
    ///      disabled or fails a filter (nothing moves), or if a loose route or a route with an explicit receipt
    ///      path carries any value ({ValueRoutesMustBeStrict}). If the sender, recipient, destination application
    ///      or payee is blacklisted the call succeeds but nothing is forwarded: all value goes to the quarantine
    ///      vault and the route settles as QUARANTINED.
    /// @return routeId The route id: derived from this ledger, this Router, the sender and its nonce.
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
        uint256 back = e.receiptPath.length > e.hops.length ? e.receiptPath.length : e.hops.length;
        o.edges = uint8(back - 1);
        o.payee = req.payee;
        o.feeBudget = uint64(budget);
        o.escrow = req.escrow;
        o.hopsHash = RouteLogic.hopsCommitment(e.hops, 0);
        o.firstHop = keccak256(abi.encodePacked(e.hops[0].channelId, e.hops[1].router));
        if (e.receiptPath.length > 0) o.pathHash = keccak256(abi.encode(e.receiptPath));

        // Blacklist: the origin checks the sender, the final recipient, the destination application and the payee
        // before taking the funds.
        (bool listed, bytes32 caseId) = RouteLogic.screen(
            REGISTRY,
            e.sender,
            e.recipient,
            e.destination,
            req.payee == address(0) ? "" : Caip.account(ledgerId, req.payee)
        );
        if (listed) {
            emit RouteSent(routeId, msg.sender, e.destination.ledgerId, req.escrow, uint64(budget), o.deadline, 0);
            emit QuarantineNotice(Caip.accountKey(e.recipient), routeId, e.recipient, caseId, REGISTRY.contact());
            _finish(routeId, RouteStatus.QUARANTINED, RouteTypes.Reason.BLACKLIST, caseId);
            return routeId;
        }

        e.constraints.remainingFeeBudget = uint64(budget) - e.hops[0].fee;
        e.hopIndex = 1;
        uint64 messageId = SERVICE.sendMessage(
            e.hops[0].channelId, e.hops[0].connectorId, e.hops[1].router, RouteCodec.encodeEnvelope(e)
        );
        outbound[_msgKey(e.hops[0].channelId, messageId)] = Outbound(routeId, 0, KIND_ORIGIN, 0);
        emit RouteSent(routeId, msg.sender, e.destination.ledgerId, req.escrow, uint64(budget), o.deadline, messageId);
    }

    /// @notice Refund a route that never got a receipt, in two calls: the first (after the deadline plus
    ///         {RECLAIM_GRACE} per edge of the way back) requests it, the second ({RECLAIM_GRACE} later) refunds
    ///         the escrow and the whole fee budget to the sender. A receipt arriving in between settles the route
    ///         normally; one arriving later is recorded (`routes(id).late`, {LateReceipt}). Anyone may call.
    function reclaim(bytes16 routeId) external nonReentrant {
        RouteSettlement.reclaim(routes, owed, _ctx(), routeId);
    }

    /// @notice Withdraw payments that could not be pushed.
    function withdraw() external nonReentrant {
        uint256 amount = owed[msg.sender];
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
    }

    // ═════════════════════════════════════════════════════════════════════
    // CLPR application delivery
    // ═════════════════════════════════════════════════════════════════════

    /// @notice CLPR delivery of an envelope from the previous hop's Router.
    /// @dev Reverts (CLPR APPLICATION_ERROR to the previous hop) only if the envelope is malformed, names a
    ///      non-canonical Router, is not addressed to this hop, not from the Router named for the previous hop,
    ///      arrived over a Channel direction the registry does not approve ({ChannelNotApproved}), or is a replay
    ///      (or if too little gas was given to run the destination application). Every other
    ///      outcome — forwarded, pending, held, delivered, or stopped with a receipt — returns normally.
    /// @return response `abi.encodePacked(uint8 accepted|rejected, uint8 reason)`.
    function onClprMessage(bytes32 channelId, bytes calldata sender, bytes calldata messageData)
        external
        nonReentrant
        returns (bytes memory response)
    {
        if (msg.sender != address(SERVICE)) revert NotService();
        RouteTypes.Envelope memory e = RouteCodec.decodeEnvelope(messageData);
        bytes32 key = _validateInbound(e, channelId, sender);
        hopState[key] = HopState.SEEN;
        _inDelivery = true;
        RouteTypes.Reason reason = _advance(e, key, messageData, false);
        _inDelivery = false;
        return abi.encodePacked(reason == RouteTypes.Reason.NONE ? RESP_ACCEPTED : RESP_REJECTED, uint8(reason));
    }

    /// @notice CLPR Response to a message this Router sent.
    /// @dev A non-SUCCESS response means the next hop never processed the message. A route sent from this
    ///      origin settles as FAILED; a forwarded route is marked NACKED so anyone can re-route it (loose
    ///      routing) or report the failure ({forward}); a receipt goes back to the outbox ({flush}).
    function onClprResponse(bytes32 channelId, uint64 messageId, uint8 status, bytes calldata) external nonReentrant {
        if (msg.sender != address(SERVICE)) revert NotService();
        bytes32 k = _msgKey(channelId, messageId);
        Outbound memory out = outbound[k];
        if (out.routeId == bytes16(0)) return;
        delete outbound[k];
        emit HopResponse(out.routeId, channelId, messageId, status);
        if (status == uint8(ClprTypes.ReplyStatus.SUCCESS)) {
            if (out.kind == KIND_HOP && hopState[out.key] == HopState.FORWARDED) {
                hopState[out.key] = HopState.DONE;
                delete pendingHash[out.key];
            }
        } else if (out.kind == KIND_RECEIPT) {
            outbox[out.key] = true;
            emit ReceiptRequeued(out.key, status);
        } else if (out.kind == KIND_ORIGIN) {
            if (routes[out.routeId].status == RouteStatus.PENDING) {
                _finish(out.routeId, RouteStatus.FAILED, RouteTypes.Reason.NEXT_HOP_ERROR, bytes32(0));
            }
        } else if (hopState[out.key] == HopState.FORWARDED) {
            hopState[out.key] = HopState.NACKED;
            emit ForwardRejected(
                out.routeId, out.hopIndex, pendingHash[out.key], status, RouteTypes.Reason.NEXT_HOP_ERROR, ""
            );
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // Permissionless completion of deferred hops
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Complete a pending or rejected hop, or a held receipt. Anyone may call.
    /// @param envelope The envelope as held on this ledger (from {ForwardPending} / the inbound CLPR message).
    /// @param newTail Loose routing only: replacement hops from this ledger to the destination
    ///        (newTail[0] is this ledger with its new outgoing Channel; every Router canonical). Empty = keep the
    ///        route.
    /// @dev A pending hop is re-checked and forwarded; a transient send failure reverts the whole call (the hop
    ///      stays pending until it can be sent or its deadline passes). A rejected hop is re-routed over
    ///      `newTail` when the route is loose and a tail is given; otherwise a FAILED (NEXT_HOP_ERROR) receipt goes
    ///      to the origin. A held receipt is processed once no disable blocks it ({ReceiptHeld} until then).
    function forward(bytes calldata envelope, RouteTypes.Hop[] calldata newTail) external nonReentrant {
        RouteTypes.Envelope memory e = RouteCodec.decodeEnvelope(envelope);
        if (e.hops.length == 0) revert NothingPending();
        bytes32 key = RouteLogic.inboundKey(e);
        HopState st = hopState[key];
        if ((st != HopState.FORWARD_PENDING && st != HopState.NACKED) || pendingHash[key] != keccak256(envelope)) {
            revert NothingPending();
        }
        delete pendingHash[key];
        bytes memory held = envelope;
        if (newTail.length > 0) {
            if (!e.constraints.loose) revert LooseRoutingRequired();
            e = RouteLogic.splice(e, newTail, _LEDGER_HASH, _SELF_HASH, _canon());
            held = RouteCodec.encodeEnvelope(e);
        } else if (st == HopState.NACKED) {
            _stop(e, key, RouteTypes.ReceiptStatus.FAILED, RouteTypes.Reason.NEXT_HOP_ERROR, bytes32(0));
            return;
        }
        hopState[key] = HopState.SEEN;
        _advance(e, key, held, true);
    }

    /// @notice Send a receipt message from the outbox. Anyone may call; reverts (and the message stays queued)
    ///         while its outgoing edge is disabled or `sendMessage` fails.
    function flush(bytes32 channelId, bytes32 connectorId, bytes calldata target, bytes calldata data)
        external
        nonReentrant
    {
        bytes32 k = keccak256(abi.encode(channelId, connectorId, target, data));
        if (!outbox[k]) revert NothingPending();
        delete outbox[k];
        RouteTypes.Envelope memory re = RouteCodec.decodeEnvelope(data);
        uint32 idx = re.hopIndex - 1;
        RouteTypes.Reason blocked = RouteLogic.edgeSafety(REGISTRY, re.hops[idx], re.hops[idx + 1]);
        if (blocked != RouteTypes.Reason.NONE) revert RouteBlocked(idx, blocked);
        uint64 messageId = SERVICE.sendMessage(channelId, connectorId, target, data);
        outbound[_msgKey(channelId, messageId)] = Outbound(re.routeId, idx, KIND_RECEIPT, k);
        emit RouteForwarded(re.routeId, idx, channelId, messageId, k, "");
    }

    // ═════════════════════════════════════════════════════════════════════
    // Hop processing
    // ═════════════════════════════════════════════════════════════════════

    /// @dev Process an envelope held on this ledger at `e.hopIndex`: stop it, deliver it, settle it (receipt at
    ///      the origin), hold it, or forward it. Returns NONE unless the route was stopped here.
    /// @param wasPending The envelope comes from {forward} (it was pending or held here).
    function _advance(RouteTypes.Envelope memory e, bytes32 key, bytes memory held, bool wasPending)
        private
        returns (RouteTypes.Reason)
    {
        bool isReceipt = e.payloadType == RouteTypes.PayloadType.RECEIPT;
        uint256 idx = e.hopIndex;
        uint256 last = e.hops.length - 1;

        (RouteTypes.ReceiptStatus st, RouteTypes.Reason reason, bytes32 caseId) =
            RouteLogic.checkHere(REGISTRY, _SELF_ROUTER_KEY, VERSION, ledgerId, e);
        if (reason != RouteTypes.Reason.NONE) {
            if (isReceipt) return _hold(e, key, held, reason, idx == last);
            _stop(e, key, st, reason, caseId);
            return reason;
        }

        if (idx == last) {
            hopState[key] = HopState.DONE;
            if (isReceipt) RouteSettlement.settle(routes, owed, _ctx(), e, wasPending);
            else _deliver(e, key);
            return RouteTypes.Reason.NONE;
        }

        RouteTypes.Hop memory h = e.hops[idx];
        // The next Channel must lead to the next ledger; then route safety (and, for routes, filters, trust
        // floor and fee budget) on the edge.
        reason = _peerLedgerHash(h.channelId) != keccak256(bytes(e.hops[idx + 1].ledgerId))
            ? RouteTypes.Reason.BAD_ROUTE
            : RouteLogic.checkNext(REGISTRY, e, idx);
        if (!isReceipt) {
            if (reason != RouteTypes.Reason.NONE) {
                _stop(e, key, RouteTypes.ReceiptStatus.FAILED, reason, bytes32(0));
                return reason;
            }
            e.constraints.remainingFeeBudget -= h.fee;
        }
        e.hopIndex = uint32(idx + 1);
        bytes memory data = RouteCodec.encodeEnvelope(e);
        if (isReceipt) {
            // A receipt in transit is never dropped: a blocked next edge only queues it.
            hopState[key] = HopState.DONE;
            _sendReceiptMessage(
                h, e.hops[idx + 1].router, data, e.routeId, uint32(idx), reason == RouteTypes.Reason.NONE
            );
            return RouteTypes.Reason.NONE;
        }

        (SendResult r, uint64 messageId) = _trySend(h.channelId, h.connectorId, e.hops[idx + 1].router, data, true);
        bytes32 hh = keccak256(held);
        if (r == SendResult.SENT) {
            hopState[key] = HopState.FORWARDED;
            pendingHash[key] = hh;
            outbound[_msgKey(h.channelId, messageId)] = Outbound(e.routeId, uint32(idx), KIND_HOP, key);
            emit RouteForwarded(e.routeId, uint32(idx), h.channelId, messageId, hh, held);
        } else if (r == SendResult.DEFERRED) {
            hopState[key] = HopState.FORWARD_PENDING;
            pendingHash[key] = hh;
            emit ForwardPending(e.routeId, uint32(idx), held);
        } else if (e.constraints.loose) {
            hopState[key] = HopState.NACKED;
            pendingHash[key] = hh;
            emit ForwardRejected(e.routeId, uint32(idx), hh, 0, RouteTypes.Reason.SEND_FAILED, held);
        } else {
            e.hopIndex = uint32(idx);
            _stop(e, key, RouteTypes.ReceiptStatus.FAILED, RouteTypes.Reason.SEND_FAILED, bytes32(0));
            return RouteTypes.Reason.SEND_FAILED;
        }
        return RouteTypes.Reason.NONE;
    }

    /// @dev A receipt arrived over (or at) something disabled: hold it instead of dropping it. Inside delivery it
    ///      is recorded (and, at the origin, blocks reclaim of its route); from {forward} the call reverts so it
    ///      stays held.
    function _hold(
        RouteTypes.Envelope memory e,
        bytes32 key,
        bytes memory held,
        RouteTypes.Reason reason,
        bool atOrigin
    ) private returns (RouteTypes.Reason) {
        if (!_inDelivery) revert ReceiptHeld(reason);
        hopState[key] = HopState.FORWARD_PENDING;
        pendingHash[key] = keccak256(held);
        if (atOrigin) {
            OriginRoute storage o = routes[RouteCodec.decodeReceipt(e.payload).routeId];
            if (o.status == RouteStatus.PENDING) o.held++;
        }
        emit ForwardPending(e.routeId, e.hopIndex, held);
        return RouteTypes.Reason.NONE;
    }

    /// @dev Deliver to the destination application and send the DELIVERED (or FAILED) receipt. The application
    ///      gets exactly APP_GAS (delivery reverts as a whole if that much is not available, so a starved
    ///      application call never turns into a FAILED receipt) and at most {MAX_RESPONSE} bytes of its response
    ///      are copied and hashed.
    function _deliver(RouteTypes.Envelope memory e, bytes32 key) private {
        address app = _toAddress(e.destination.application);
        if (keccak256(bytes(e.destination.ledgerId)) != _LEDGER_HASH || app.code.length == 0) {
            _stop(e, key, RouteTypes.ReceiptStatus.FAILED, RouteTypes.Reason.BAD_ROUTE, bytes32(0));
            return;
        }
        (bool ok, bytes32 respHash) = RouteOrigin.callApplication(app, e, APP_GAS, MAX_RESPONSE);
        if (ok) {
            emit RouteDelivered(e.routeId, app, respHash);
            _sendReceipt(e, RouteTypes.ReceiptStatus.DELIVERED, RouteTypes.Reason.NONE, bytes32(0), respHash);
        } else {
            _stop(e, key, RouteTypes.ReceiptStatus.FAILED, RouteTypes.Reason.APPLICATION_ERROR, bytes32(0));
        }
    }

    /// @dev Stop a route here and send its receipt to the origin (with a quarantine notice when QUARANTINED).
    function _stop(
        RouteTypes.Envelope memory e,
        bytes32 key,
        RouteTypes.ReceiptStatus status,
        RouteTypes.Reason reason,
        bytes32 caseId
    ) private {
        hopState[key] = HopState.DONE;
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
        (RouteTypes.Hop memory h, bytes memory target, bytes memory data, bytes16 receiptId, bool open) =
            RouteReceipts.report(REGISTRY, e, r, ledgerId, APP_GAS, VERSION);
        _sendReceiptMessage(h, target, data, receiptId, 0, open);
    }

    /// @dev Send a receipt message, or queue it in the outbox (for {flush}) when its edge is blocked or the send
    ///      does not go through now.
    function _sendReceiptMessage(
        RouteTypes.Hop memory h,
        bytes memory target,
        bytes memory data,
        bytes16 receiptId,
        uint32 idx,
        bool open
    ) private {
        bytes32 k = keccak256(abi.encode(h.channelId, h.connectorId, target, data));
        if (open) {
            (SendResult r, uint64 messageId) = _trySend(h.channelId, h.connectorId, target, data, false);
            if (r == SendResult.SENT) {
                outbound[_msgKey(h.channelId, messageId)] = Outbound(receiptId, idx, KIND_RECEIPT, k);
                emit RouteForwarded(receiptId, idx, h.channelId, messageId, k, data);
                return;
            }
        }
        outbox[k] = true;
        emit OutboxQueued(k, h.channelId, h.connectorId, target, data);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Validation helpers
    // ═════════════════════════════════════════════════════════════════════

    function _buildEnvelope(SendRequest calldata req, uint64 budget) private returns (RouteTypes.Envelope memory e) {
        e = RouteOrigin.buildSend(
            req,
            RouteOrigin.SendCtx({
                ledgerId: ledgerId,
                ledgerHash: _LEDGER_HASH,
                selfHash: _SELF_HASH,
                selfRouterKey: _SELF_ROUTER_KEY,
                registry: REGISTRY,
                canon: _canon(),
                sender: msg.sender,
                routeId: RouteLogic.routeId(_LEDGER_HASH, address(this), msg.sender, nonces[msg.sender]++),
                value: msg.value,
                budget: budget,
                version: VERSION
            })
        );
        if (_peerLedgerHash(e.hops[0].channelId) != keccak256(bytes(e.hops[1].ledgerId))) {
            revert RouteBlocked(0, RouteTypes.Reason.BAD_ROUTE);
        }
    }

    /// @dev Inbound checks; any failure reverts so the previous hop sees a CLPR APPLICATION_ERROR.
    /// @return key The envelope's inbound key (RouteLogic.inboundKey).
    function _validateInbound(RouteTypes.Envelope memory e, bytes32 channelId, bytes calldata sender)
        private
        returns (bytes32 key)
    {
        if (e.routerVersion != VERSION) revert WrongVersion();
        RouteLogic.validateStructure(e, _canon());
        uint256 idx = e.hopIndex;
        if (idx == 0 || idx >= e.hops.length) revert NotForThisHop();
        RouteTypes.Hop memory here = e.hops[idx];
        RouteTypes.Hop memory prev = e.hops[idx - 1];
        if (keccak256(bytes(here.ledgerId)) != _LEDGER_HASH || keccak256(here.router) != _SELF_HASH) {
            revert NotForThisHop();
        }
        if (prev.channelId != channelId || keccak256(prev.router) != keccak256(sender)) revert UnexpectedSender();
        // The Channel must lead to the previous hop's ledger, and its direction into this ledger must be approved
        // with the verifier this ledger's Service uses for it: a Channel anyone opened proves nothing.
        (bytes32 peer, bool approved) = RouteLogic.inboundChannel(SERVICE, REGISTRY, channelId, ledgerId);
        if (peer != keccak256(bytes(prev.ledgerId))) revert UnexpectedSender();
        if (!approved) revert ChannelNotApproved(channelId);
        if (e.payloadType == RouteTypes.PayloadType.RECEIPT) {
            // A receipt is reported by the Router that built it: its origin is its first hop.
            if (
                keccak256(bytes(e.origin.ledgerId)) != keccak256(bytes(e.hops[0].ledgerId))
                    || keccak256(e.origin.application) != keccak256(e.hops[0].router)
            ) revert UnexpectedSender();
        } else if (e.constraints.deadline == 0) {
            revert InvalidRoute(RouteTypes.Reason.DEADLINE);
        }
        key = RouteLogic.inboundKey(e);
        if (hopState[key] != HopState.NONE) revert RouteReplayed();
    }

    /// @dev keccak256 of the CAIP-2 id of the peer of `channelId`, cached after the first lookup.
    function _peerLedgerHash(bytes32 channelId) private returns (bytes32 h) {
        h = _peerLedger[channelId];
        if (h != bytes32(0)) return h;
        h = RouteLogic.peerLedgerHash(SERVICE, channelId);
        if (h != bytes32(0)) _peerLedger[channelId] = h;
    }

    /// @dev Send over CLPR. DEFERRED = not now but maybe later (reentrancy lock, low gas, or a transient Service
    ///      error such as a full queue, an exceeded quota, a paused Channel or a refusing Connector); FAILED = a
    ///      definite rejection (unknown Channel or Connector, payload too large for the peer). A route sent from a
    ///      permissionless call (`route` and not inside delivery) never defers: the call reverts with the cause,
    ///      so nobody can turn a transient failure into a final one by choosing when to call.
    function _trySend(bytes32 channelId, bytes32 connectorId, bytes memory target, bytes memory data, bool route)
        private
        returns (SendResult, uint64)
    {
        bool mustSend = route && !_inDelivery;
        uint256 g = gasleft();
        if (g < MIN_SEND_GAS) {
            if (mustSend) revert InsufficientGas();
            return (SendResult.DEFERRED, 0);
        }
        try SERVICE.sendMessage(channelId, connectorId, target, data) returns (uint64 id) {
            return (SendResult.SENT, id);
        } catch (bytes memory err) {
            // Out of gas inside the call (only the 1/64 reserve is left) is never a verdict on the hop.
            bool starved = gasleft() < g / 63;
            bytes4 sel = err.length >= 4 ? bytes4(err) : bytes4(0);
            if (
                !starved
                    && (sel == ClprTypes.ClprChannelNotFound.selector
                        || sel == ClprTypes.ClprConnectorNotFound.selector
                        || sel == ClprTypes.ClprPayloadTooLarge.selector)
            ) return (SendResult.FAILED, 0);
            if (mustSend) {
                if (starved) revert InsufficientGas();
                assembly ("memory-safe") {
                    revert(add(err, 0x20), mload(err))
                }
            }
            return (SendResult.DEFERRED, 0);
        }
    }

    function _finish(bytes16 routeId, RouteStatus status, RouteTypes.Reason reason, bytes32 caseId) private {
        RouteSettlement.finish(
            routes, owed, _ctx(), routeId, status, reason, 0, caseId, bytes32(0), new RouteTypes.Hop[](0)
        );
    }

    function _ctx() private view returns (RouteSettlement.Ctx memory) {
        return RouteSettlement.Ctx(REGISTRY, VAULT, ledgerId, APP_GAS, RECLAIM_GRACE);
    }

    function _canon() private view returns (RouteLogic.Canon memory) {
        return RouteLogic.Canon(DEPLOYER, DEPLOYMENT_SALT, INIT_CODE_HASH);
    }

    function _msgKey(bytes32 channelId, uint64 messageId) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(channelId, messageId));
    }

    function _toAddress(bytes memory b) private pure returns (address) {
        if (b.length != 20) return address(0);
        return address(bytes20(b));
    }
}
