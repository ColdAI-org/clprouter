// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title RouteTypes
/// @notice Solidity mirror of proto/clprouter/v1/route_envelope.proto plus shared constants.
/// @dev Field order and meaning follow the protobuf schema exactly; see RouteCodec for the wire format.
library RouteTypes {
    // ── Enums (values equal the protobuf enum numbers) ──────────────────────

    /// @notice Objective the off-chain planner optimised (carried, never re-planned on-chain).
    enum Mode {
        BALANCED,
        CHEAPEST,
        FASTEST,
        MOST_RELIABLE,
        GREENEST
    }

    enum PayloadType {
        RAW,
        ISO20022,
        ASSET,
        RECEIPT
    }

    enum ReceiptStatus {
        UNSPECIFIED,
        DELIVERED,
        FAILED,
        EXPIRED,
        QUARANTINED
    }

    enum Reason {
        NONE,
        APPLICATION_ERROR,
        DEADLINE,
        DISABLED_EDGE,
        DISABLED_LEDGER,
        DISABLED_ROUTER,
        DISABLED_INBOUND,
        FILTER,
        FEE_BUDGET,
        BLACKLIST,
        NEXT_HOP_ERROR,
        SEND_FAILED,
        BAD_ROUTE,
        TRUST_FLOOR
    }

    // ── Filter bits (RouteFilter) ───────────────────────────────────────────

    uint32 internal constant FILTER_ISO20022 = 1;
    uint32 internal constant FILTER_MICA = 2;
    uint32 internal constant FILTER_ENERGY = 4;
    uint32 internal constant FILTER_MASK = 7;

    /// @notice Default `max_hops` when the sender leaves it at zero.
    uint32 internal constant DEFAULT_MAX_HOPS = 3;
    /// @notice Hard cap on edges per route, whatever the sender asks for.
    uint32 internal constant ABSOLUTE_MAX_HOPS = 8;

    // ── Messages ────────────────────────────────────────────────────────────

    struct Endpoint {
        string ledgerId;
        bytes application;
    }

    /// @notice hops[i]: the i-th ledger on the route and the edge leaving it (empty at the destination).
    struct Hop {
        string ledgerId;
        bytes router;
        bytes32 channelId;
        bytes32 connectorId;
        uint64 fee;
        bytes feePayee;
    }

    struct Constraints {
        uint32 filters;
        uint64 deadline;
        uint64 maxFee;
        uint64 remainingFeeBudget;
        uint32 trustFloor; // minimum verifier tier of every edge (0 attested … 3 validity proof); 0 = no floor
        uint32 maxHops;
        bool loose;
        uint64 energyCap; // Energy filter: max certified µgCO2e per transaction (0 = no cap)
    }

    /// @notice Registry version a filter is checked against: the provider registry's decision counter
    ///         ({ProviderRegistry.version}) when the route was sent.
    struct RegistryVersion {
        uint32 filter;
        uint64 version;
    }

    struct Envelope {
        bytes16 routeId;
        Endpoint origin;
        Endpoint destination;
        string sender;
        string recipient;
        Hop[] hops;
        uint32 hopIndex;
        Mode mode;
        Constraints constraints;
        PayloadType payloadType;
        bytes payload;
        Hop[] receiptPath;
        bytes originSignature;
        RegistryVersion[] filterRegistryVersions;
        uint32 routerVersion;
        /// @dev ISO 20022 UETR (UUIDv4 bytes) chosen by the origin application; never used as a key.
        bytes16 isoUetr;
    }

    struct Receipt {
        bytes16 routeId;
        ReceiptStatus status;
        uint32 hopIndex;
        string ledgerId;
        Reason reason;
        bytes32 caseId;
        string contact;
        bytes32 responseHash;
        /// @dev hops[0..hopIndex) of the route; only when the receipt does not travel the reverse route.
        Hop[] routePrefix;
        /// @dev RouteLogic.edgeDigest of the reporting hop's own entry (its outgoing edge).
        bytes32 routeEdge;
        /// @dev RouteLogic.hopsCommitment of the hops after the reporting one (zero at the destination).
        bytes32 routeRest;
    }
}
