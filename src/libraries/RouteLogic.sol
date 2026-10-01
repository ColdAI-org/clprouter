// SPDX-License-Identifier: Apache-2.0
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

    /// @notice At least one edge, at most min(max_hops, ABSOLUTE_MAX_HOPS) edges, and no ledger twice.
    function validateStructure(RouteTypes.Envelope memory e) public pure {
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
    ///         edge and every ledger's filters. Returns the first failing (hop, reason), or (0, NONE).
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
            if (!filtersPass(registry, e.hops[i + 1].ledgerId, e.constraints, e.filterRegistryVersions)) {
                return (i, RouteTypes.Reason.FILTER);
            }
        }
        return (0, RouteTypes.Reason.NONE);
    }

    /// @notice Loose re-routing: hops[0..idx) followed by `tail` (tail[0] = this ledger and Router).
    function splice(RouteTypes.Envelope memory e, RouteTypes.Hop[] memory tail, bytes32 ledgerHash, bytes32 selfHash)
        public
        pure
        returns (RouteTypes.Envelope memory)
    {
        uint256 idx = e.hopIndex;
        if (
            tail.length == 0 || keccak256(bytes(tail[0].ledgerId)) != ledgerHash
                || keccak256(tail[0].router) != selfHash
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
        validateStructure(e);
        return e;
    }

    /// @notice The hops a receipt from hop `idx` travels: the explicit receipt path for a delivery receipt when
    ///         it is well-formed (from this hop to the origin), otherwise the reverse of hops[0..idx].
    function receiptHops(RouteTypes.Envelope memory e, bool delivered) public pure returns (RouteTypes.Hop[] memory) {
        uint256 idx = e.hopIndex;
        RouteTypes.Hop[] memory p = e.receiptPath;
        if (delivered && p.length >= 2 && p.length - 1 <= RouteTypes.ABSOLUTE_MAX_HOPS) {
            RouteTypes.Hop memory here = e.hops[idx];
            RouteTypes.Hop memory origin = e.hops[0];
            if (
                keccak256(bytes(p[0].ledgerId)) == keccak256(bytes(here.ledgerId))
                    && keccak256(p[0].router) == keccak256(here.router)
                    && keccak256(bytes(p[p.length - 1].ledgerId)) == keccak256(bytes(origin.ledgerId))
                    && keccak256(p[p.length - 1].router) == keccak256(origin.router)
            ) return p;
        }
        return reversePrefix(e.hops, idx);
    }

    /// @notice hops[k], hops[k-1], ..., hops[0], each leaving over the Channel it was reached by.
    function reversePrefix(RouteTypes.Hop[] memory hops, uint256 k) public pure returns (RouteTypes.Hop[] memory p) {
        p = new RouteTypes.Hop[](k + 1);
        for (uint256 j = 0; j <= k; j++) {
            RouteTypes.Hop memory src = hops[k - j];
            p[j].ledgerId = src.ledgerId;
            p[j].router = src.router;
            if (j < k) {
                p[j].channelId = hops[k - j - 1].channelId;
                p[j].connectorId = hops[k - j - 1].connectorId;
            }
        }
    }

    /// @notice The receipt envelope `re` travelled exactly the reverse of the route up to the reporting hop,
    ///         and was issued by the Router the route names for that hop.
    function isReversePrefix(RouteTypes.Envelope memory re, RouteTypes.Receipt memory r) public pure returns (bool) {
        RouteTypes.Hop[] memory expect = reversePrefix(r.routeHops, r.hopIndex);
        if (expect.length != re.hops.length) return false;
        for (uint256 i = 0; i < expect.length; i++) {
            if (
                keccak256(bytes(expect[i].ledgerId)) != keccak256(bytes(re.hops[i].ledgerId))
                    || keccak256(expect[i].router) != keccak256(re.hops[i].router)
                    || expect[i].channelId != re.hops[i].channelId || expect[i].connectorId != re.hops[i].connectorId
            ) return false;
        }
        return keccak256(re.origin.application) == keccak256(r.routeHops[r.hopIndex].router);
    }

    /// @notice keccak256 of the CAIP-2 id of the peer ledger of `channelId` on `service` (zero if unknown).
    function peerLedgerHash(IClprService service, bytes32 channelId) public returns (bytes32) {
        try service.getChannel(channelId) returns (ClprTypes.Channel memory c) {
            return keccak256(bytes(c.chainId));
        } catch {
            return bytes32(0);
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
        receiptId = bytes16(keccak256(abi.encodePacked(e.routeId, "receipt", e.hopIndex)));
        re.routeId = receiptId;
        re.origin = RouteTypes.Endpoint({ledgerId: here, application: abi.encodePacked(self)});
        re.destination = e.origin;
        re.hops = receiptHops(e, r.status == RouteTypes.ReceiptStatus.DELIVERED);
        re.hopIndex = 1;
        re.mode = e.mode;
        re.payloadType = RouteTypes.PayloadType.RECEIPT;
        re.routerVersion = version;
        r.routeHops = e.hops;
        r.hopIndex = e.hopIndex;
        r.ledgerId = here;
        r.routeId = e.routeId;
        re.payload = RouteCodec.encodeReceipt(r);
        hops = re.hops;
        data = RouteCodec.encodeEnvelope(re);
    }

    /// @notice Send-time checks on a freshly built envelope (structure, origin and destination hops, deadline,
    ///         filter bits, fee totals) and pinning of the current registry version for every active filter.
    function prepareSend(RouteTypes.Envelope memory e, bytes32 ledgerHash, bytes32 selfHash, uint64 registryVersion)
        public
        view
        returns (RouteTypes.Envelope memory)
    {
        validateStructure(e);
        uint256 n = e.hops.length;
        if (
            keccak256(bytes(e.hops[0].ledgerId)) != ledgerHash || keccak256(e.hops[0].router) != selfHash
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

    /// @notice Origin-side authentication of a receipt envelope `re` carrying receipt `r`.
    /// @param firstHop keccak256(channel of hop 0, router of hop 1) stored at send: the receipt must arrive
    ///        from the route's first-hop Router over the route's first Channel.
    /// @param hopsHash Strict routes: hash of the route's hops, which the receipt must carry unchanged (zero = loose).
    /// @param verifyPath Strict routes without an explicit receipt path: the receipt must have travelled the
    ///        exact reverse of the route and been issued by the Router the route names for the reporting hop.
    function receiptValid(
        RouteTypes.Envelope memory re,
        RouteTypes.Receipt memory r,
        bytes32 firstHop,
        bytes32 hopsHash,
        bool verifyPath
    ) public pure returns (bool) {
        RouteTypes.Hop memory prev = re.hops[re.hopIndex - 1];
        if (keccak256(abi.encodePacked(prev.channelId, prev.router)) != firstHop) return false;
        if (r.status == RouteTypes.ReceiptStatus.UNSPECIFIED || r.routeHops.length < 2) return false;
        if (r.hopIndex == 0 || r.hopIndex >= r.routeHops.length) return false;
        if (hopsHash != bytes32(0) && RouteCodec.hashHops(r.routeHops) != hopsHash) return false;
        if (r.status == RouteTypes.ReceiptStatus.DELIVERED && r.hopIndex != r.routeHops.length - 1) return false;
        if (r.status == RouteTypes.ReceiptStatus.QUARANTINED && r.caseId == bytes32(0)) return false;
        return !verifyPath || isReversePrefix(re, r);
    }
}
