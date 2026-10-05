// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {RouteTypes} from "../libraries/RouteTypes.sol";
import {IProviderRegistry} from "./IProviderRegistry.sol";
import {IQuarantineVault} from "./IQuarantineVault.sol";

/// @title IClprRouterDeployer
/// @notice What a CLPRouter reads from the contract that CREATE2-deploys it (see ClprRouterDeployer).
interface IClprRouterDeployer {
    /// @notice Per-ledger constructor parameters of the Router being deployed (only set during `deploy`).
    struct Params {
        IClprService service;
        IProviderRegistry registry;
        IQuarantineVault vault;
        string ledgerId;
        uint64 reclaimGrace;
        uint64 appGas;
        uint64 minSendGas;
    }

    /// @notice What a deployer fixes for every Router of the deployment (its constructor arguments).
    /// @param reclaimGrace Router RECLAIM_GRACE (seconds per edge of the way back).
    /// @param appGas Router APP_GAS (gas for destination applications and hooks).
    /// @param minSendGas Router MIN_SEND_GAS.
    /// @param registryCodeHash Runtime code hash of the provider registry.
    /// @param registryGenesis The registry's genesis head `headAt(0)` (deployment id, initial committee, notices).
    /// @param vaultCodeHash Runtime code hash of the quarantine vault.
    struct Pins {
        uint64 reclaimGrace;
        uint64 appGas;
        uint64 minSendGas;
        bytes32 registryCodeHash;
        bytes32 registryGenesis;
        bytes32 vaultCodeHash;
    }

    function parameters() external view returns (Params memory);

    /// @notice Deployment-wide salt; the Router of ledger L is at CREATE2(deployer, keccak256(abi.encode(
    ///         DEPLOYMENT_SALT, keccak256(L))), INIT_CODE_HASH).
    function DEPLOYMENT_SALT() external view returns (bytes32);

    /// @notice keccak256 of the Router's init code (identical on every ledger of the deployment).
    function INIT_CODE_HASH() external view returns (bytes32);
}

/// @title IClprRouter
/// @notice Types, events and errors of the CLPRouter (shared by ClprRouter and its settlement library).
interface IClprRouter {
    // ── Types ───────────────────────────────────────────────────────────────

    /// @notice Per-envelope state on a ledger that received it, keyed by
    ///         keccak256(abi.encode(keccak256(hops[0].ledgerId), keccak256(hops[0].router), routeId))
    ///         (RouteLogic.inboundKey). Anything but NONE is also the replay set.
    enum HopState {
        NONE,
        SEEN,
        FORWARD_PENDING, // a route waiting for {forward}, or a receipt held while a disable is in force
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

    /// @notice What the origin keeps for a route it sent.
    struct OriginRoute {
        address sender;
        uint64 deadline;
        RouteStatus status;
        bool strict;
        uint8 edges; // edges of the longest way back (route or receipt path): scales the reclaim window
        uint8 held; // receipts for this route held at this Router while a disable is in force (blocks reclaim)
        address payee;
        uint64 feeBudget;
        RouteStatus late; // authenticated receipt that arrived after a reclaim refunded the route (else NONE)
        uint64 reclaimAt; // 0 = no reclaim requested; else earliest time the requested reclaim may finalise
        uint256 escrow;
        bytes32 hopsHash; // RouteLogic.hopsCommitment(hops, 0); checked for strict routes only
        bytes32 firstHop; // keccak256(channelId of hop 0, router of hop 1): where reverse-path receipts arrive from
        bytes32 pathHash; // keccak256(abi.encode(receiptPath)) for routes with an explicit receipt path, else 0
    }

    /// @notice An outbound CLPR message of this Router.
    /// @param kind 0 = a route sent from this origin, 1 = a route forwarded by this hop, 2 = a receipt.
    /// @param key `kind` 1: the inbound key of the route; `kind` 2: the outbox key of the receipt message.
    struct Outbound {
        bytes16 routeId;
        uint32 hopIndex;
        uint8 kind;
        bytes32 key;
    }

    /// @notice Arguments of {ClprRouter.send}.
    /// @param destination Destination ledger and application.
    /// @param recipient CAIP-10 id of the final recipient (checked against the blacklist at every hop).
    /// @param hops Full route from the planner, hops[0] = this ledger and this Router. Every Router must be the
    ///        canonical deployment of its ledger.
    /// @param mode Objective the planner optimised.
    /// @param constraints Filters, deadline, max fee, trust floor, max hops, strict/loose, energy cap.
    ///        `remainingFeeBudget` is ignored: the fee budget is `msg.value - escrow`.
    /// @param payloadType RAW, ISO20022 or ASSET.
    /// @param payload Application bytes (hash or ciphertext under the ISO 20022 / MiCA filters).
    /// @param receiptPath Explicit way back for the delivery receipt (routes without value only); empty =
    ///        reverse of `hops`.
    /// @param originSignature Optional end-to-end signature by the origin application.
    /// @param isoUetr UETR of the ISO 20022 message (16 bytes), carried as the envelope's `iso_uetr`. It is
    ///        informational: the route id is always derived by the Router.
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
        bytes16 isoUetr;
        uint256 escrow;
        address payee;
    }

    // ── Errors ──────────────────────────────────────────────────────────────

    error NotService();
    error InvalidRoute(RouteTypes.Reason reason);
    error RouteBlocked(uint256 hop, RouteTypes.Reason reason);
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
    error InsufficientGas();
    error WithdrawFailed();
    /// @notice A held receipt is still blocked by a disable; retry {ClprRouter.forward} once it lapses.
    error ReceiptHeld(RouteTypes.Reason reason);
    /// @notice An envelope arrived over a Channel whose direction into this ledger the provider registry does not
    ///         approve (or approves with another verifier than the one this ledger's CLPR Service uses for it).
    error ChannelNotApproved(bytes32 channelId);

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
    /// @notice A CLPR message left this Router. Routes: `key` = keccak256 of the envelope as held on this ledger
    ///         (the key of a later {ForwardRejected}), `data` = that envelope. Receipts: `key` = outbox key
    ///         (the key of a later {ReceiptRequeued}), `data` = the message data (empty when sent by {flush}:
    ///         it is the data of the {OutboxQueued} with that key).
    event RouteForwarded(
        bytes16 indexed routeId, uint32 hopIndex, bytes32 channelId, uint64 messageId, bytes32 key, bytes data
    );
    /// @notice A hop could not be sent inside CLPR delivery, or a receipt is held while a disable is in force;
    ///         complete it with {ClprRouter.forward}(envelope, []).
    event ForwardPending(bytes16 indexed routeId, uint32 hopIndex, bytes envelope);
    /// @notice A forward was rejected; complete it with {ClprRouter.forward}(envelope, tail) — an empty tail sends
    ///         the FAILED receipt that refunds the origin. `clprStatus` is the CLPR reply status (0 = the local
    ///         `sendMessage` failed for good, reason SEND_FAILED; otherwise reason NEXT_HOP_ERROR). `envelope` is
    ///         empty when the rejection came in a CLPR Response: it is the one with `envelopeHash` in the earlier
    ///         {RouteForwarded} (or {ForwardPending}) of this route on this Router.
    event ForwardRejected(
        bytes16 indexed routeId,
        uint32 hopIndex,
        bytes32 envelopeHash,
        uint8 clprStatus,
        RouteTypes.Reason reason,
        bytes envelope
    );
    /// @notice A receipt message waits in the outbox; anyone sends it with {ClprRouter.flush}, over `connectorId` (the
    ///         Connector the route named) or any other Connector of `channelId`.
    event OutboxQueued(bytes32 indexed key, bytes32 channelId, bytes32 connectorId, bytes target, bytes data);
    /// @notice A receipt message was rejected by CLPR (`clprStatus`), or its reply never reached the Router
    ///         (`clprStatus` 255, {ClprRouter.requeue}); it is back in the outbox under `key` (its data is in the
    ///         earlier {OutboxQueued} or {RouteForwarded} with that key). Receipts are never dropped.
    event ReceiptRequeued(bytes32 indexed key, uint8 clprStatus);
    event RouteDelivered(bytes16 indexed routeId, address indexed application, bytes32 responseHash);
    event RouteStopped(
        bytes16 indexed routeId, uint32 hopIndex, RouteTypes.ReceiptStatus status, RouteTypes.Reason reason
    );
    event ReceiptSent(
        bytes16 indexed receiptId, bytes16 indexed routeId, RouteTypes.ReceiptStatus status, RouteTypes.Reason reason
    );
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
    /// @notice First phase of {ClprRouter.reclaim}: the refund can be finalised from `finalAt` unless a receipt
    ///         settles the route first.
    event ReclaimRequested(bytes16 indexed routeId, uint64 finalAt);
    /// @notice An authentic receipt arrived after a reclaim had refunded the route. The route stays EXPIRED (the
    ///         funds are gone); the claim is recorded in `routes(routeId).late` for the parties to settle.
    event LateReceipt(bytes16 indexed routeId, RouteTypes.ReceiptStatus status, uint32 hopIndex, bytes32 responseHash);
}
