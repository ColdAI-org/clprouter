// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RouteTypes} from "./RouteTypes.sol";

/// @title RouteCodec
/// @notice Protobuf (proto3) encoder and decoder for `ClprRouteEnvelope` and `ClprRouteReceipt`
///         as defined in proto/clprouter/v1/route_envelope.proto.
/// @dev Deployed as an external library (public functions) so its bytecode does not count
///      against the Router's EIP-170 limit. Encoding omits default-valued scalar fields and
///      always emits repeated elements (even if empty) so element counts survive a round trip.
///
///      Decoding accepts only the canonical encoding, i.e. exactly the bytes {encodeEnvelope} /
///      {encodeReceipt} produce, so `encode(decode(b)) == b` for every accepted `b` and
///      `decode(encode(x)) == x` for every `x`. Rejected with {MalformedProtobuf}:
///        * fields out of ascending field-number order, a singular field present twice (protobuf would
///          merge or override; we reject instead), or a repeated field split by other fields;
///        * unknown field numbers and known fields with another wire type (every hop runs the same
///          `router_version`, so there is nothing to stay forward compatible with);
///        * explicitly encoded defaults (zero varints, empty strings / bytes / singular messages, all-zero
///          fixed-length ids), `bool` values other than 1, and over-long (non-minimal) varints;
///        * truncated input, fixed-length ids of the wrong size, out-of-range enums and integers.
library RouteCodec {
    /// @notice Input is not the canonical protobuf encoding of the expected message.
    error MalformedProtobuf();

    uint256 private constant WT_VARINT = 0;
    uint256 private constant WT_LEN = 2;

    // ═════════════════════════════════════════════════════════════════════
    // Public API
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Encode an envelope to protobuf bytes.
    function encodeEnvelope(RouteTypes.Envelope memory e) public pure returns (bytes memory out) {
        out = bytes.concat(
            _bytesField(1, e.routeId == bytes16(0) ? bytes("") : abi.encodePacked(e.routeId)),
            _bytesField(2, _encodeEndpoint(e.origin)),
            _bytesField(3, _encodeEndpoint(e.destination)),
            _bytesField(4, bytes(e.sender)),
            _bytesField(5, bytes(e.recipient)),
            _encodeHops(6, e.hops),
            _uintField(7, e.hopIndex),
            _uintField(8, uint256(e.mode))
        );
        out = bytes.concat(
            out,
            _bytesField(9, _encodeConstraints(e.constraints)),
            _uintField(10, uint256(e.payloadType)),
            _bytesField(11, e.payload),
            _encodeHops(12, e.receiptPath),
            _bytesField(13, e.originSignature),
            _encodeVersions(e.filterRegistryVersions),
            _uintField(15, e.routerVersion),
            _bytesField(16, e.isoUetr == bytes16(0) ? bytes("") : abi.encodePacked(e.isoUetr))
        );
    }

    /// @notice Decode the canonical protobuf encoding of an envelope.
    function decodeEnvelope(bytes memory b) public pure returns (RouteTypes.Envelope memory e) {
        // Pass 1: count repeated fields so arrays can be allocated exactly.
        uint256 nHops = _count(b, 6);
        uint256 nReceipt = _count(b, 12);
        uint256 nVersions = _count(b, 14);
        e.hops = new RouteTypes.Hop[](nHops);
        e.receiptPath = new RouteTypes.Hop[](nReceipt);
        e.filterRegistryVersions = new RouteTypes.RegistryVersion[](nVersions);
        nHops = 0;
        nReceipt = 0;
        nVersions = 0;

        uint256 q = 0;
        uint256 last = 0;
        while (q < b.length) {
            uint256 field;
            uint256 wt;
            (field, wt, q) = _readKey(b, q, b.length);
            last = _order(last, field, field == 6 || field == 12 || field == 14);
            if (field == 7 || field == 8 || field == 10 || field == 15) {
                uint256 v;
                (v, q) = _readValue(b, q, b.length, wt);
                if (field == 7) {
                    e.hopIndex = _u32(v);
                } else if (field == 8) {
                    e.mode = RouteTypes.Mode(_enum(v, uint256(type(RouteTypes.Mode).max)));
                } else if (field == 10) {
                    e.payloadType = RouteTypes.PayloadType(_enum(v, uint256(type(RouteTypes.PayloadType).max)));
                } else {
                    e.routerVersion = _u32(v);
                }
            } else {
                uint256 s;
                uint256 end;
                (s, end, q) = _readLen(b, q, b.length, wt);
                bool repeated = field == 6 || field == 12 || field == 14;
                if (!repeated && end == s) revert MalformedProtobuf(); // explicit default
                if (field == 1) e.routeId = _bytes16(b, s, end);
                else if (field == 2) e.origin = _decodeEndpoint(b, s, end);
                else if (field == 3) e.destination = _decodeEndpoint(b, s, end);
                else if (field == 4) e.sender = string(_copy(b, s, end));
                else if (field == 5) e.recipient = string(_copy(b, s, end));
                else if (field == 6) e.hops[nHops++] = _decodeHop(b, s, end);
                else if (field == 9) e.constraints = _decodeConstraints(b, s, end);
                else if (field == 11) e.payload = _copy(b, s, end);
                else if (field == 12) e.receiptPath[nReceipt++] = _decodeHop(b, s, end);
                else if (field == 13) e.originSignature = _copy(b, s, end);
                else if (field == 14) e.filterRegistryVersions[nVersions++] = _decodeVersion(b, s, end);
                else if (field == 16) e.isoUetr = _bytes16(b, s, end);
                else revert MalformedProtobuf(); // unknown field
            }
        }
    }

    /// @notice Encode a receipt to protobuf bytes.
    function encodeReceipt(RouteTypes.Receipt memory r) public pure returns (bytes memory) {
        return bytes.concat(
            _bytesField(1, r.routeId == bytes16(0) ? bytes("") : abi.encodePacked(r.routeId)),
            _uintField(2, uint256(r.status)),
            _uintField(3, r.hopIndex),
            _bytesField(4, bytes(r.ledgerId)),
            _uintField(5, uint256(r.reason)),
            _bytesField(6, _b32(r.caseId)),
            _bytesField(7, bytes(r.contact)),
            _bytesField(8, _b32(r.responseHash)),
            _encodeHops(9, r.routePrefix),
            _bytesField(10, _b32(r.routeEdge)),
            _bytesField(11, _b32(r.routeRest))
        );
    }

    /// @notice Decode the canonical protobuf encoding of a receipt.
    function decodeReceipt(bytes memory b) public pure returns (RouteTypes.Receipt memory r) {
        r.routePrefix = new RouteTypes.Hop[](_count(b, 9));
        uint256 n = 0;
        uint256 q = 0;
        uint256 last = 0;
        while (q < b.length) {
            uint256 field;
            uint256 wt;
            (field, wt, q) = _readKey(b, q, b.length);
            last = _order(last, field, field == 9);
            if (field == 2 || field == 3 || field == 5) {
                uint256 v;
                (v, q) = _readValue(b, q, b.length, wt);
                if (field == 2) {
                    r.status = RouteTypes.ReceiptStatus(_enum(v, uint256(type(RouteTypes.ReceiptStatus).max)));
                } else if (field == 3) {
                    r.hopIndex = _u32(v);
                } else {
                    r.reason = RouteTypes.Reason(_enum(v, uint256(type(RouteTypes.Reason).max)));
                }
            } else {
                uint256 s;
                uint256 end;
                (s, end, q) = _readLen(b, q, b.length, wt);
                if (field != 9 && end == s) revert MalformedProtobuf();
                if (field == 1) r.routeId = _bytes16(b, s, end);
                else if (field == 4) r.ledgerId = string(_copy(b, s, end));
                else if (field == 6) r.caseId = _bytes32(b, s, end);
                else if (field == 7) r.contact = string(_copy(b, s, end));
                else if (field == 8) r.responseHash = _bytes32(b, s, end);
                else if (field == 9) r.routePrefix[n++] = _decodeHop(b, s, end);
                else if (field == 10) r.routeEdge = _bytes32(b, s, end);
                else if (field == 11) r.routeRest = _bytes32(b, s, end);
                else revert MalformedProtobuf();
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // Encoding helpers
    // ═════════════════════════════════════════════════════════════════════

    function _encodeEndpoint(RouteTypes.Endpoint memory ep) private pure returns (bytes memory) {
        return bytes.concat(_bytesField(1, bytes(ep.ledgerId)), _bytesField(2, ep.application));
    }

    function _encodeHop(RouteTypes.Hop memory h) private pure returns (bytes memory) {
        return bytes.concat(
            _bytesField(1, bytes(h.ledgerId)),
            _bytesField(2, h.router),
            _bytesField(3, _b32(h.channelId)),
            _bytesField(4, _b32(h.connectorId)),
            _uintField(5, h.fee),
            _bytesField(6, h.feePayee)
        );
    }

    function _encodeHops(uint256 field, RouteTypes.Hop[] memory hops) private pure returns (bytes memory out) {
        for (uint256 i = 0; i < hops.length; i++) {
            bytes memory h = _encodeHop(hops[i]);
            out = bytes.concat(out, _key(field, WT_LEN), _varint(h.length), h);
        }
    }

    function _encodeConstraints(RouteTypes.Constraints memory c) private pure returns (bytes memory) {
        return bytes.concat(
            _uintField(1, c.filters),
            _uintField(2, c.deadline),
            _uintField(3, c.maxFee),
            _uintField(4, c.remainingFeeBudget),
            _uintField(5, c.trustFloor),
            _uintField(6, c.maxHops),
            _uintField(7, c.loose ? 1 : 0),
            _uintField(8, c.energyCap)
        );
    }

    function _encodeVersions(RouteTypes.RegistryVersion[] memory v) private pure returns (bytes memory out) {
        for (uint256 i = 0; i < v.length; i++) {
            bytes memory m = bytes.concat(_uintField(1, v[i].filter), _uintField(2, v[i].version));
            out = bytes.concat(out, _key(14, WT_LEN), _varint(m.length), m);
        }
    }

    function _b32(bytes32 v) private pure returns (bytes memory) {
        return v == bytes32(0) ? bytes("") : abi.encodePacked(v);
    }

    function _uintField(uint256 field, uint256 v) private pure returns (bytes memory) {
        if (v == 0) return "";
        return bytes.concat(_key(field, WT_VARINT), _varint(v));
    }

    function _bytesField(uint256 field, bytes memory v) private pure returns (bytes memory) {
        if (v.length == 0) return "";
        return bytes.concat(_key(field, WT_LEN), _varint(v.length), v);
    }

    function _key(uint256 field, uint256 wt) private pure returns (bytes memory) {
        return _varint((field << 3) | wt);
    }

    function _varint(uint256 v) private pure returns (bytes memory out) {
        uint256 len = 1;
        for (uint256 t = v >> 7; t != 0; t >>= 7) {
            len++;
        }
        out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            uint256 b7 = v & 0x7f;
            v >>= 7;
            out[i] = bytes1(uint8(i + 1 < len ? (b7 | 0x80) : b7));
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // Decoding helpers
    // ═════════════════════════════════════════════════════════════════════

    /// @dev Field order rule: strictly ascending field numbers, except that a repeated field may continue.
    function _order(uint256 last, uint256 field, bool repeated) private pure returns (uint256) {
        if (field < last || (field == last && !repeated)) revert MalformedProtobuf();
        return field;
    }

    /// @dev Number of elements of repeated field `field` at the top level of `b` (structure only).
    function _count(bytes memory b, uint256 field) private pure returns (uint256 n) {
        uint256 p = 0;
        while (p < b.length) {
            uint256 f;
            uint256 wt;
            (f, wt, p) = _readKey(b, p, b.length);
            if (wt == WT_VARINT) {
                (, p) = _readVarint(b, p, b.length);
            } else {
                (,, p) = _readLen(b, p, b.length, wt);
                if (f == field) n++;
            }
        }
    }

    function _decodeEndpoint(bytes memory b, uint256 p, uint256 end)
        private
        pure
        returns (RouteTypes.Endpoint memory ep)
    {
        uint256 last = 0;
        while (p < end) {
            uint256 field;
            uint256 wt;
            (field, wt, p) = _readKey(b, p, end);
            last = _order(last, field, false);
            uint256 s;
            uint256 e;
            (s, e, p) = _readLen(b, p, end, wt);
            if (e == s) revert MalformedProtobuf();
            if (field == 1) ep.ledgerId = string(_copy(b, s, e));
            else if (field == 2) ep.application = _copy(b, s, e);
            else revert MalformedProtobuf();
        }
    }

    function _decodeHop(bytes memory b, uint256 p, uint256 end) private pure returns (RouteTypes.Hop memory h) {
        uint256 last = 0;
        while (p < end) {
            uint256 field;
            uint256 wt;
            (field, wt, p) = _readKey(b, p, end);
            last = _order(last, field, false);
            if (field == 5) {
                uint256 v;
                (v, p) = _readValue(b, p, end, wt);
                h.fee = uint64(v); // _readVarint bounds v to uint64
            } else {
                uint256 s;
                uint256 e;
                (s, e, p) = _readLen(b, p, end, wt);
                if (e == s) revert MalformedProtobuf();
                if (field == 1) h.ledgerId = string(_copy(b, s, e));
                else if (field == 2) h.router = _copy(b, s, e);
                else if (field == 3) h.channelId = _bytes32(b, s, e);
                else if (field == 4) h.connectorId = _bytes32(b, s, e);
                else if (field == 6) h.feePayee = _copy(b, s, e);
                else revert MalformedProtobuf();
            }
        }
    }

    function _decodeConstraints(bytes memory b, uint256 p, uint256 end)
        private
        pure
        returns (RouteTypes.Constraints memory c)
    {
        uint256 last = 0;
        while (p < end) {
            uint256 field;
            uint256 wt;
            (field, wt, p) = _readKey(b, p, end);
            last = _order(last, field, false);
            uint256 v;
            (v, p) = _readValue(b, p, end, wt);
            if (field == 1) c.filters = _u32(v);
            else if (field == 2) c.deadline = uint64(v);
            else if (field == 3) c.maxFee = uint64(v);
            else if (field == 4) c.remainingFeeBudget = uint64(v);
            else if (field == 5) c.trustFloor = _u32(v);
            else if (field == 6) c.maxHops = _u32(v);
            else if (field == 7 && v == 1) c.loose = true;
            else if (field == 8) c.energyCap = uint64(v);
            else revert MalformedProtobuf(); // unknown field, or a bool other than 1
        }
    }

    function _decodeVersion(bytes memory b, uint256 p, uint256 end)
        private
        pure
        returns (RouteTypes.RegistryVersion memory v)
    {
        uint256 last = 0;
        while (p < end) {
            uint256 field;
            uint256 wt;
            (field, wt, p) = _readKey(b, p, end);
            last = _order(last, field, false);
            uint256 x;
            (x, p) = _readValue(b, p, end, wt);
            if (field == 1) v.filter = _u32(x);
            else if (field == 2) v.version = uint64(x);
            else revert MalformedProtobuf();
        }
    }

    function _readKey(bytes memory b, uint256 p, uint256 end)
        private
        pure
        returns (uint256 field, uint256 wt, uint256 np)
    {
        uint256 k;
        (k, np) = _readVarint(b, p, end);
        field = k >> 3;
        wt = k & 7;
        // Only VARINT and LEN are used by the schema; field numbers are at most 16.
        if (field == 0 || field > 16 || (wt != WT_VARINT && wt != WT_LEN)) revert MalformedProtobuf();
    }

    /// @dev A minimal varint of at most 64 bits.
    function _readVarint(bytes memory b, uint256 p, uint256 end) private pure returns (uint256 v, uint256 np) {
        for (uint256 shift = 0; shift < 70; shift += 7) {
            if (p >= end) revert MalformedProtobuf();
            uint256 c = uint8(b[p++]);
            v |= (c & 0x7f) << shift;
            if (c & 0x80 == 0) {
                // A trailing zero group is an over-long encoding of a shorter varint.
                if ((c == 0 && shift != 0) || v > type(uint64).max) revert MalformedProtobuf();
                return (v, p);
            }
        }
        revert MalformedProtobuf();
    }

    /// @dev A non-default scalar of a VARINT field (proto3 omits zero).
    function _readValue(bytes memory b, uint256 p, uint256 end, uint256 wt)
        private
        pure
        returns (uint256 v, uint256 np)
    {
        if (wt != WT_VARINT) revert MalformedProtobuf();
        (v, np) = _readVarint(b, p, end);
        if (v == 0) revert MalformedProtobuf();
    }

    function _readLen(bytes memory b, uint256 p, uint256 end, uint256 wt)
        private
        pure
        returns (uint256 start, uint256 stop, uint256 np)
    {
        if (wt != WT_LEN) revert MalformedProtobuf();
        uint256 len;
        (len, start) = _readVarint(b, p, end);
        stop = start + len;
        if (stop > end) revert MalformedProtobuf();
        np = stop;
    }

    function _copy(bytes memory b, uint256 s, uint256 e) private pure returns (bytes memory out) {
        uint256 len = e - s;
        out = new bytes(len);
        assembly ("memory-safe") {
            mcopy(add(out, 0x20), add(add(b, 0x20), s), len)
        }
    }

    /// @dev Exactly 32 bytes, not all zero (an all-zero id is the default and must be omitted).
    function _bytes32(bytes memory b, uint256 s, uint256 e) private pure returns (bytes32 v) {
        if (e - s != 32) revert MalformedProtobuf();
        assembly ("memory-safe") {
            v := mload(add(add(b, 0x20), s))
        }
        if (v == bytes32(0)) revert MalformedProtobuf();
    }

    /// @dev Exactly 16 bytes, not all zero.
    function _bytes16(bytes memory b, uint256 s, uint256 e) private pure returns (bytes16 v) {
        if (e - s != 16) revert MalformedProtobuf();
        bytes32 w;
        assembly ("memory-safe") {
            w := mload(add(add(b, 0x20), s))
        }
        v = bytes16(w);
        if (v == bytes16(0)) revert MalformedProtobuf();
    }

    function _u32(uint256 v) private pure returns (uint32) {
        if (v > type(uint32).max) revert MalformedProtobuf();
        return uint32(v);
    }

    function _enum(uint256 v, uint256 max) private pure returns (uint256) {
        if (v > max) revert MalformedProtobuf();
        return v;
    }
}
