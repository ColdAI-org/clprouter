// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprTypes} from "@hiero-ledger/clpr/libraries/ClprTypes.sol";
import {IProviderRegistry} from "../interfaces/IProviderRegistry.sol";
import {RouteCodec} from "./RouteCodec.sol";
import {RouteTypes} from "./RouteTypes.sol";
import {Caip} from "./Caip.sol";

/// @title RouteLogic
/// @notice Stateless route checks shared by every CLPRouter hop: route structure, route safety against the
///         provider registry, compliance filters at a pinned registry version, and receipt paths.
/// @dev Deployed as an external library (public functions) to keep ClprRouter under EIP-170.
library RouteLogic {
    error InvalidRoute(RouteTypes.Reason reason);
    /// @notice A hop (or receipt-path hop) names a Router that is not its ledger's canonical deployment.
    error NonCanonicalRouter(string ledgerId);

    /// @notice Domain tags of the two id namespaces (route ids and receipt ids never collide).
    bytes32 internal constant ROUTE_TAG = keccak256("clprouter.v1.route");
    bytes32 internal constant RECEIPT_TAG = keccak256("clprouter.v1.receipt");

    /// @notice What fixes the canonical Router addresses of a deployment (see ClprRouterDeployer).
    struct Canon {
        address deployer;
        bytes32 salt;
        bytes32 initCodeHash;
    }

    // ── Ids, keys and canonical Routers ────────────────────────────────────

    /// @notice Route id of the `nonce`-th route `sender` sends through `router` on `ledgerHash` (never chosen by
    ///         the sender, so it cannot be squatted).
    function routeId(bytes32 originLedger, address router, address sender, uint256 nonce)
        internal
        pure
        returns (bytes16)
    {
        return bytes16(keccak256(abi.encode(ROUTE_TAG, originLedger, router, sender, nonce)));
    }

    /// @notice Replay / hop-state key of an envelope: its origin (hops[0]) and its id. Ids are unique per origin
    ///         Router, and hops[0] of a receipt is the reporting Router, so routes and receipts of different
    ///         origins never share a key.
    function inboundKey(RouteTypes.Envelope memory e) internal pure returns (bytes32) {
        return keccak256(abi.encode(keccak256(bytes(e.hops[0].ledgerId)), keccak256(e.hops[0].router), e.routeId));
    }

    /// @notice keccak256 of a CAIP-2 ledger id, normalising a bare EIP-155 chain id ("296") to "eip155:296"
    ///         (CLPR Services may report either form).
    function ledgerHash(string memory id) public pure returns (bytes32) {
        bytes memory b = bytes(id);
        if (b.length == 0) return keccak256(b);
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] < "0" || b[i] > "9") return keccak256(b);
        }
        return keccak256(bytes.concat("eip155:", b));
    }

    /// @notice Canonical Router address of `ledgerId` in the deployment `c`.
    function canonicalRouter(Canon memory c, string memory ledgerId) public pure returns (address) {
        bytes32 salt = keccak256(abi.encode(c.salt, keccak256(bytes(ledgerId))));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), c.deployer, salt, c.initCodeHash)))));
    }

    /// @dev Every Router named in `hops` is the canonical deployment of its ledger.
    ///      EVM ledgers (20-byte Router addresses) use the CREATE2 address. Non-EVM ledgers need a
    ///      provider-certified Router address from the registry, which it does not expose yet: until it does they
    ///      fail closed here (hook: replace the `length != 20` branch with that registry lookup).
    function _checkRouters(RouteTypes.Hop[] memory hops, Canon memory c) private pure {
        for (uint256 i = 0; i < hops.length; i++) {
            bytes memory r = hops[i].router;
            if (r.length != 20 || address(bytes20(r)) != canonicalRouter(c, hops[i].ledgerId)) {
                revert NonCanonicalRouter(hops[i].ledgerId);
            }
        }
    }

    // ── Structure ───────────────────────────────────────────────────────────

    /// @notice At least one edge, at most min(max_hops, ABSOLUTE_MAX_HOPS) edges, no ledger twice, no fee
    ///         budget on a loose route (loose routes carry no value; see ClprRouter.send), and every Router of
    ///         the route and of its receipt path canonical.
    function validateStructure(RouteTypes.Envelope memory e, Canon memory c) public pure {
        _checkRouters(e.hops, c);
        _checkRouters(e.receiptPath, c);
        if (e.constraints.loose && e.constraints.remainingFeeBudget != 0) {
            revert InvalidRoute(RouteTypes.Reason.FEE_BUDGET);
        }
        uint256 n = e.hops.length;
        uint256 maxHops = e.constraints.maxHops == 0 ? RouteTypes.DEFAULT_MAX_HOPS : e.constraints.maxHops;
        if (maxHops > RouteTypes.ABSOLUTE_MAX_HOPS) maxHops = RouteTypes.ABSOLUTE_MAX_HOPS;
        if (e.payloadType == RouteTypes.PayloadType.RECEIPT) maxHops = RouteTypes.ABSOLUTE_MAX_HOPS;
        if (n < 2 || n - 1 > maxHops) revert InvalidRoute(RouteTypes.Reason.BAD_ROUTE);
        bytes32[] memory seen = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            bytes32 h = keccak256(bytes(e.hops[i].ledgerId));
            for (uint256 j = 0; j < i; j++) {
                if (seen[j] == h) revert InvalidRoute(RouteTypes.Reason.BAD_ROUTE);
            }
            seen[i] = h;
        }
    }

    /// @notice Route-safety reason for the edge hops[i] -> hops[i+1] (disabled edge, ledger or Router), or NONE.
    function edgeSafety(IProviderRegistry registry, RouteTypes.Hop memory h, RouteTypes.Hop memory next)
        public
        view
        returns (RouteTypes.Reason)
    {
        if (registry.isDisabled(Caip.edgeKey(h.channelId, next.ledgerId))) return RouteTypes.Reason.DISABLED_EDGE;
        if (registry.isDisabled(Caip.ledgerKey(next.ledgerId))) return RouteTypes.Reason.DISABLED_LEDGER;
        if (registry.isDisabled(Caip.routerKey(next.ledgerId, next.router))) return RouteTypes.Reason.DISABLED_ROUTER;
        return RouteTypes.Reason.NONE;
    }

    /// @notice The edge hops[i] -> hops[i+1] meets the trust floor `floor`: the provider registry labels it with
    ///         a tier of at least `floor`. A floor of zero is always met and never reads the registry; above zero,
    ///         an unlabelled edge fails closed.
    function edgeTrusted(IProviderRegistry registry, RouteTypes.Hop memory h, RouteTypes.Hop memory next, uint32 floor)
        public
        view
        returns (bool)
    {
        if (floor == 0) return true;
        (bool labelled, uint8 tier) = registry.trustTier(Caip.edgeKey(h.channelId, next.ledgerId));
        return labelled && tier >= floor;
    }

    /// @notice Route-safety reason for the ledger holding a message that arrived from `prev`
    ///         (own Router deployment or version disabled; inbound edge, previous ledger or Router disabled).
    function hereSafety(
        IProviderRegistry registry,
        bytes32 selfRouterKey,
        uint32 version,
        string memory here,
        RouteTypes.Hop memory prev
    ) public view returns (RouteTypes.Reason) {
        if (registry.isDisabled(selfRouterKey) || registry.isDisabled(Caip.routerVersionKey(version))) {
            return RouteTypes.Reason.DISABLED_ROUTER;
        }
        if (
            registry.isDisabled(Caip.edgeKey(prev.channelId, here))
                || registry.isDisabled(Caip.ledgerKey(prev.ledgerId))
                || registry.isDisabled(Caip.routerKey(prev.ledgerId, prev.router))
        ) return RouteTypes.Reason.DISABLED_INBOUND;
        return RouteTypes.Reason.NONE;
    }

    /// @notice Checks about the ledger holding a route that arrived from `prev`: route safety ({hereSafety}),
    ///         deadline, blacklist (sender, recipient, destination application). Receipts get route safety only.
    /// @return status Receipt status to stop with (UNSPECIFIED when `reason` is NONE).
    function checkHere(
        IProviderRegistry registry,
        bytes32 selfRouterKey,
        uint32 version,
        string memory here,
        RouteTypes.Envelope memory e
    ) public view returns (RouteTypes.ReceiptStatus status, RouteTypes.Reason reason, bytes32 caseId) {
        reason = hereSafety(registry, selfRouterKey, version, here, e.hops[e.hopIndex - 1]);
        if (reason != RouteTypes.Reason.NONE) return (RouteTypes.ReceiptStatus.FAILED, reason, 0);
        if (e.payloadType == RouteTypes.PayloadType.RECEIPT) return (status, reason, 0);
        if (block.timestamp > e.constraints.deadline) {
            return (RouteTypes.ReceiptStatus.EXPIRED, RouteTypes.Reason.DEADLINE, 0);
        }
        bool listed;
        (listed, caseId) = screen(registry, e.sender, e.recipient, e.destination, "");
        if (listed) return (RouteTypes.ReceiptStatus.QUARANTINED, RouteTypes.Reason.BLACKLIST, caseId);
    }

    /// @notice Checks on the edge leaving hop `idx` of `e` (whose Channel the caller already matched with the next
    ///         ledger): disabled edge, ledger or Router; for routes also filters on the next ledger at the pinned
    ///         registry version, the edge's trust tier against the trust floor, and the fee budget.
    function checkNext(IProviderRegistry registry, RouteTypes.Envelope memory e, uint256 idx)
        public
        view
        returns (RouteTypes.Reason)
    {
        RouteTypes.Hop memory h = e.hops[idx];
        RouteTypes.Hop memory next = e.hops[idx + 1];
        RouteTypes.Reason r = edgeSafety(registry, h, next);
        if (r != RouteTypes.Reason.NONE || e.payloadType == RouteTypes.PayloadType.RECEIPT) return r;
        if (!filtersPass(registry, next.ledgerId, e.constraints, e.filterRegistryVersions)) {
            return RouteTypes.Reason.FILTER;
        }
        if (!edgeTrusted(registry, h, next, e.constraints.trustFloor)) return RouteTypes.Reason.TRUST_FLOOR;
        if (e.constraints.remainingFeeBudget < h.fee) return RouteTypes.Reason.FEE_BUDGET;
        return RouteTypes.Reason.NONE;
    }

    /// @notice Every active filter passes for `ledger` at its pinned registry version.
    /// @dev Unfiltered routes never read the certification registry.
    function filtersPass(
        IProviderRegistry registry,
        string memory ledger,
        RouteTypes.Constraints memory c,
        RouteTypes.RegistryVersion[] memory versions
    ) public view returns (bool) {
        if (c.filters == 0) return true;
        for (uint8 label = 1; label <= 3; label++) {
            uint32 bit = uint32(1) << (label - 1);
            if (c.filters & bit == 0) continue;
            uint64 pinned = type(uint64).max;
            for (uint256 i = 0; i < versions.length; i++) {
                if (versions[i].filter == bit) pinned = versions[i].version;
            }
            // A missing pin, or a registry that has not reached the pinned version, fails closed.
            (bool ok, uint64 emissions) = registry.certificationAt(Caip.certKey(ledger, label), pinned);
            if (!ok) return false;
            if (bit == RouteTypes.FILTER_ENERGY && c.energyCap != 0 && emissions > c.energyCap) return false;
        }
        return true;
    }

    /// @notice Origin-side check of a whole route before any value moves: own Router and ledger, then every
    ///         edge (route safety, trust floor) and every ledger's filters. Returns the first failing (hop, reason), or (0, NONE).
    function checkRoute(IProviderRegistry registry, bytes32 selfRouterKey, uint32 version, RouteTypes.Envelope memory e)
        public
        view
        returns (uint256, RouteTypes.Reason)
    {
        if (registry.isDisabled(selfRouterKey) || registry.isDisabled(Caip.routerVersionKey(version))) {
            return (0, RouteTypes.Reason.DISABLED_ROUTER);
        }
        if (registry.isDisabled(Caip.ledgerKey(e.hops[0].ledgerId))) return (0, RouteTypes.Reason.DISABLED_LEDGER);
        if (!filtersPass(registry, e.hops[0].ledgerId, e.constraints, e.filterRegistryVersions)) {
            return (0, RouteTypes.Reason.FILTER);
        }
        for (uint256 i = 0; i + 1 < e.hops.length; i++) {
            RouteTypes.Reason r = edgeSafety(registry, e.hops[i], e.hops[i + 1]);
            if (r != RouteTypes.Reason.NONE) return (i, r);
            if (!edgeTrusted(registry, e.hops[i], e.hops[i + 1], e.constraints.trustFloor)) {
                return (i, RouteTypes.Reason.TRUST_FLOOR);
            }
            if (!filtersPass(registry, e.hops[i + 1].ledgerId, e.constraints, e.filterRegistryVersions)) {
                return (i, RouteTypes.Reason.FILTER);
            }
        }
        return (0, RouteTypes.Reason.NONE);
    }

    /// @notice Loose re-routing: hops[0..idx) followed by `tail` (tail[0] = this ledger and Router).
    ///         Every Router of the tail must be canonical (checked with the whole structure).
    function splice(
        RouteTypes.Envelope memory e,
        RouteTypes.Hop[] memory tail,
        bytes32 hereHash,
        bytes32 selfHash,
        Canon memory c
    ) public pure returns (RouteTypes.Envelope memory) {
        uint256 idx = e.hopIndex;
        if (
            tail.length == 0 || keccak256(bytes(tail[0].ledgerId)) != hereHash || keccak256(tail[0].router) != selfHash
                || keccak256(bytes(tail[tail.length - 1].ledgerId)) != keccak256(bytes(e.destination.ledgerId))
        ) revert InvalidRoute(RouteTypes.Reason.BAD_ROUTE);
        RouteTypes.Hop[] memory hops = new RouteTypes.Hop[](idx + tail.length);
        for (uint256 i = 0; i < idx; i++) {
            hops[i] = e.hops[i];
        }
        for (uint256 i = 0; i < tail.length; i++) {
            hops[idx + i] = tail[i];
        }
        e.hops = hops;
        validateStructure(e, c);
        return e;
    }

    /// @notice Whether the delivery receipt of `e` (reported by hop `e.hopIndex`) takes the explicit receipt path:
    ///         only for a delivery receipt, and only when the path is well-formed (from this hop to the origin).
    function usesReceiptPath(RouteTypes.Envelope memory e, bool delivered) public pure returns (bool) {
        RouteTypes.Hop[] memory p = e.receiptPath;
        if (!delivered || p.length < 2 || p.length - 1 > RouteTypes.ABSOLUTE_MAX_HOPS) return false;
        RouteTypes.Hop memory here = e.hops[e.hopIndex];
        RouteTypes.Hop memory origin = e.hops[0];
        return keccak256(bytes(p[0].ledgerId)) == keccak256(bytes(here.ledgerId))
            && keccak256(p[0].router) == keccak256(here.router)
            && keccak256(bytes(p[p.length - 1].ledgerId)) == keccak256(bytes(origin.ledgerId))
            && keccak256(p[p.length - 1].router) == keccak256(origin.router);
    }

    /// @notice hops[k], hops[k-1], ..., hops[0], each leaving over the edge it was reached by: p[j] carries the
    ///         ledger and Router of hops[k-j] and the Channel, Connector, fee and fee payee of hops[k-j-1].
    /// @dev Carrying the fee fields lets the origin rebuild hops[0..k) from a receipt that travelled this path.
    function reversePrefix(RouteTypes.Hop[] memory hops, uint256 k) public pure returns (RouteTypes.Hop[] memory p) {
        p = new RouteTypes.Hop[](k + 1);
        for (uint256 j = 0; j <= k; j++) {
            RouteTypes.Hop memory src = hops[k - j];
            p[j].ledgerId = src.ledgerId;
            p[j].router = src.router;
            if (j < k) {
                RouteTypes.Hop memory edge = hops[k - j - 1];
                p[j].channelId = edge.channelId;
                p[j].connectorId = edge.connectorId;
                p[j].fee = edge.fee;
                p[j].feePayee = edge.feePayee;
            }
        }
    }

    // ── Hop-list commitment ─────────────────────────────────────────────────
    //
    // The origin stores one commitment to the route's hops instead of receiving them back in every receipt:
    //   C_n = 0;   C_i = keccak256(abi.encode(nodeDigest_i, keccak256(abi.encode(edgeDigest_i, C_{i+1}))))
    // with nodeDigest_i over (ledgerId, router) and edgeDigest_i over (channel, connector, fee, fee payee). The
    // commitment is C_0. A receipt from hop k carries edgeDigest_k and C_{k+1} (zero at the destination, so a
    // DELIVERED receipt proves it came from the last hop). The origin rebuilds hops[0..k) from the receipt's own
    // reverse path (or an explicit prefix), takes node k from the receipt's origin (the reporting Router) and
    // recomputes C_0: a match proves the hop list, the reporter, and that the receipt came back the exact
    // reverse way.

    function _node(string memory ledgerId, bytes memory router) private pure returns (bytes32) {
        return keccak256(abi.encode(keccak256(bytes(ledgerId)), keccak256(router)));
    }

    /// @notice Digest of a hop's outgoing edge: Channel, Connector, fee and fee payee.
    function edgeDigest(RouteTypes.Hop memory h) public pure returns (bytes32) {
        return keccak256(abi.encode(h.channelId, h.connectorId, h.fee, keccak256(h.feePayee)));
    }

    function _link(bytes32 node, bytes32 edge, bytes32 next) private pure returns (bytes32) {
        return keccak256(abi.encode(node, keccak256(abi.encode(edge, next))));
    }

    /// @notice C_k: the commitment to hops[k..] (zero for k >= hops.length); C_0 is what the origin stores.
    function hopsCommitment(RouteTypes.Hop[] memory hops, uint256 k) public pure returns (bytes32 c) {
        for (uint256 i = hops.length; i > k; i--) {
            RouteTypes.Hop memory h = hops[i - 1];
            c = _link(_node(h.ledgerId, h.router), edgeDigest(h), c);
        }
    }

    /// @notice Build the receipt for route `e` reported by hop `e.hopIndex` (this ledger), as a new routed
    ///         message from this Router back to the origin Router.
    /// @return receiptId Route id of the receipt message.
    /// @return hops The receipt's hops (hops[0] = this ledger).
    /// @return data Encoded receipt envelope, ready for `sendMessage` to hops[1].
    function buildReceipt(
        RouteTypes.Envelope memory e,
        RouteTypes.Receipt memory r,
        string memory here,
        address self,
        uint32 version
    ) public pure returns (bytes16 receiptId, RouteTypes.Hop[] memory hops, bytes memory data) {
        RouteTypes.Envelope memory re;
        uint256 k = e.hopIndex;
        receiptId = bytes16(
            keccak256(
                abi.encode(RECEIPT_TAG, keccak256(bytes(e.hops[0].ledgerId)), keccak256(e.hops[0].router), e.routeId, k)
            )
        );
        re.routeId = receiptId;
        re.origin = RouteTypes.Endpoint({ledgerId: here, application: abi.encodePacked(self)});
        re.destination = e.origin;
        if (usesReceiptPath(e, r.status == RouteTypes.ReceiptStatus.DELIVERED)) {
            re.hops = e.receiptPath;
            // The way back does not follow the route, so the origin needs the hops before this one explicitly.
            r.routePrefix = new RouteTypes.Hop[](k);
            for (uint256 i = 0; i < k; i++) {
                r.routePrefix[i] = e.hops[i];
            }
        } else {
            re.hops = reversePrefix(e.hops, k);
        }
        re.hopIndex = 1;
        re.mode = e.mode;
        re.payloadType = RouteTypes.PayloadType.RECEIPT;
        re.routerVersion = version;
        r.routeEdge = edgeDigest(e.hops[k]);
        r.routeRest = hopsCommitment(e.hops, k + 1);
        r.hopIndex = uint32(k);
        r.ledgerId = here;
        r.routeId = e.routeId;
        re.payload = RouteCodec.encodeReceipt(r);
        hops = re.hops;
        data = RouteCodec.encodeEnvelope(re);
    }

    /// @notice keccak256 of the CAIP-2 id of the peer ledger of `channelId` on `service` (zero if unknown).
    function peerLedgerHash(IClprService service, bytes32 channelId) public returns (bytes32) {
        try service.getChannel(channelId) returns (ClprTypes.Channel memory c) {
            return ledgerHash(c.chainId);
        } catch {
            return bytes32(0);
        }
    }

    /// @notice Send-time checks on a freshly built envelope (structure, origin and destination hops, deadline,
    ///         filter bits, fee totals) and pinning of the current registry version for every active filter.
    function prepareSend(
        RouteTypes.Envelope memory e,
        bytes32 hereHash,
        bytes32 selfHash,
        uint64 registryVersion,
        Canon memory c
    ) public view returns (RouteTypes.Envelope memory) {
        validateStructure(e, c);
        uint256 n = e.hops.length;
        if (
            keccak256(bytes(e.hops[0].ledgerId)) != hereHash || keccak256(e.hops[0].router) != selfHash
                || keccak256(bytes(e.hops[n - 1].ledgerId)) != keccak256(bytes(e.destination.ledgerId))
        ) revert InvalidRoute(RouteTypes.Reason.BAD_ROUTE);
        if (e.constraints.deadline <= block.timestamp) revert InvalidRoute(RouteTypes.Reason.DEADLINE);
        if (e.constraints.filters & ~RouteTypes.FILTER_MASK != 0) revert InvalidRoute(RouteTypes.Reason.FILTER);

        uint256 total;
        for (uint256 i = 0; i + 1 < n; i++) {
            total += e.hops[i].fee;
        }
        if (total > e.constraints.remainingFeeBudget || (e.constraints.maxFee != 0 && total > e.constraints.maxFee)) {
            revert InvalidRoute(RouteTypes.Reason.FEE_BUDGET);
        }

        uint256 nf;
        for (uint32 b = 1; b <= RouteTypes.FILTER_ENERGY; b <<= 1) {
            if (e.constraints.filters & b != 0) nf++;
        }
        e.filterRegistryVersions = new RouteTypes.RegistryVersion[](nf);
        nf = 0;
        for (uint32 b = 1; b <= RouteTypes.FILTER_ENERGY; b <<= 1) {
            if (e.constraints.filters & b != 0) {
                e.filterRegistryVersions[nf++] = RouteTypes.RegistryVersion({filter: b, version: registryVersion});
            }
        }
        return e;
    }

    /// @notice Origin-side authentication of a receipt envelope `re` carrying receipt `r`. Every Router on the
    ///         way is canonical (checked hop by hop) and the reporter is `re.hops[0]` (= `re.origin`, checked on
    ///         arrival); this binds the receipt to the stored route as well.
    /// @param firstHop keccak256(channel of hop 0, router of hop 1) stored at send: a receipt travelling the
    ///        reverse route must arrive from the route's first-hop Router over the route's first Channel.
    /// @param commitment Strict routes: hopsCommitment(hops, 0) (zero = loose: the hops may have changed and,
    ///        since loose routes carry no value, there are no fees to pay).
    /// @param pathHash keccak256(abi.encode(receiptPath)) of a route with an explicit receipt path (else zero):
    ///        a receipt that does not travel the reverse route must be the destination's DELIVERED receipt and
    ///        must have travelled exactly that path (which fixes the Router and Channel it arrives from).
    /// @return ok Whether the receipt is authentic.
    /// @return prefix hops[0..r.hopIndex) of the route, whose fees are due (empty for loose routes).
    function checkReceipt(
        RouteTypes.Envelope memory re,
        RouteTypes.Receipt memory r,
        bytes32 firstHop,
        bytes32 commitment,
        bytes32 pathHash
    ) public pure returns (bool ok, RouteTypes.Hop[] memory prefix) {
        RouteTypes.Hop memory prev = re.hops[re.hopIndex - 1];
        uint256 k = r.hopIndex;
        if (
            r.status == RouteTypes.ReceiptStatus.UNSPECIFIED || k == 0
                || (r.status == RouteTypes.ReceiptStatus.DELIVERED && r.routeRest != bytes32(0))
                || (r.status == RouteTypes.ReceiptStatus.QUARANTINED && r.caseId == bytes32(0))
        ) return (false, prefix);

        bytes32 node = _node(re.hops[0].ledgerId, re.hops[0].router);
        bool viaPath = pathHash != bytes32(0) && keccak256(abi.encode(re.hops)) == pathHash;
        if (viaPath) {
            if (r.status != RouteTypes.ReceiptStatus.DELIVERED) return (false, prefix);
            if (commitment == bytes32(0)) return (true, prefix);
            if (r.routePrefix.length != k) return (false, prefix);
            prefix = r.routePrefix;
        } else {
            if (keccak256(abi.encodePacked(prev.channelId, prev.router)) != firstHop || r.routePrefix.length > 0) {
                return (false, prefix);
            }
            if (commitment == bytes32(0)) return (true, prefix);
            // Rebuild hops[0..k) from the reverse path the receipt travelled; its first hop is the reporter.
            RouteTypes.Hop[] memory p = re.hops;
            if (p.length != k + 1) return (false, prefix);
            prefix = new RouteTypes.Hop[](k);
            for (uint256 i = 0; i < k; i++) {
                RouteTypes.Hop memory n = p[k - i];
                RouteTypes.Hop memory edge = p[k - i - 1];
                prefix[i] =
                    RouteTypes.Hop(n.ledgerId, n.router, edge.channelId, edge.connectorId, edge.fee, edge.feePayee);
            }
        }
        bytes32 c = _link(node, r.routeEdge, r.routeRest);
        for (uint256 i = k; i > 0; i--) {
            RouteTypes.Hop memory h = prefix[i - 1];
            c = _link(_node(h.ledgerId, h.router), edgeDigest(h), c);
        }
        if (c != commitment) return (false, new RouteTypes.Hop[](0));
        ok = true;
    }

    // ── Blacklist ───────────────────────────────────────────────────────────

    /// @notice Blacklist screen of a route on this ledger: the paying sender, the final recipient, the
    ///         destination application (CAIP-10 of `destination`, EVM addresses only) and `extra` (the payee at
    ///         the origin; empty elsewhere). Returns the first listing found.
    function screen(
        IProviderRegistry registry,
        string memory sender,
        string memory recipient,
        RouteTypes.Endpoint memory destination,
        string memory extra
    ) public view returns (bool listed, bytes32 caseId) {
        (listed, caseId) = _listed(registry, sender);
        if (!listed) (listed, caseId) = _listed(registry, recipient);
        if (!listed && destination.application.length == 20) {
            (listed, caseId) =
                _listed(registry, Caip.account(destination.ledgerId, address(bytes20(destination.application))));
        }
        if (!listed) (listed, caseId) = _listed(registry, extra);
    }

    function _listed(IProviderRegistry registry, string memory caip10) private view returns (bool, bytes32) {
        if (bytes(caip10).length == 0) return (false, 0);
        return registry.blacklisted(Caip.accountKey(caip10));
    }
}
