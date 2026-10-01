// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {RouteTypes} from "./RouteTypes.sol";

/// @title RouteCodec
/// @notice Protobuf (proto3) encoder and decoder for `ClprRouteEnvelope` and `ClprRouteReceipt`
///         as defined in proto/clprouter/v1/route_envelope.proto.
/// @dev Deployed as an external library (public functions) so its bytecode does not count
///      against the Router's EIP-170 limit. Encoding omits default-valued scalar fields and
///      always emits repeated elements (even if empty) so element counts survive a round trip.
///      Decoding skips unknown fields and rejects malformed input with {MalformedProtobuf}.
library RouteCodec {
    /// @notice Input is not valid protobuf for the expected message, or a fixed-length field has the wrong size.
    error MalformedProtobuf();

    uint256 private constant WT_VARINT = 0;
    uint256 private constant WT_I64 = 1;
    uint256 private constant WT_LEN = 2;
    uint256 private constant WT_I32 = 5;

    // ═════════════════════════════════════════════════════════════════════
    // Public API
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Encode an envelope to protobuf bytes.
    function encodeEnvelope(RouteTypes.Envelope memory e) public pure returns (bytes memory out) {
        out = bytes.concat(
            _bytesField(1, e.routeId == bytes16(0) ? bytes("") : abi.encodePacked(e.routeId)),
            _msgField(2, _encodeEndpoint(e.origin)),
            _msgField(3, _encodeEndpoint(e.destination)),
            _bytesField(4, bytes(e.sender)),
            _bytesField(5, bytes(e.recipient)),
            _encodeHops(6, e.hops),
            _uintField(7, e.hopIndex),
            _uintField(8, uint256(e.mode))
        );
        out = bytes.concat(
            out,
            _msgField(9, _encodeConstraints(e.constraints)),
            _uintField(10, uint256(e.payloadType)),
            _bytesField(11, e.payload),
            _encodeHops(12, e.receiptPath),
            _bytesField(13, e.originSignature),
            _encodeVersions(e.filterRegistryVersions),
            _uintField(15, e.routerVersion)
        );
    }

    /// @notice Decode protobuf bytes into an envelope.
    function decodeEnvelope(bytes memory b) public pure returns (RouteTypes.Envelope memory e) {
        uint256 nHops;
        uint256 nReceipt;
        uint256 nVersions;
        // Pass 1: count repeated fields so arrays can be allocated exactly.
        {
            uint256 p = 0;
            while (p < b.length) {
                uint256 field;
                uint256 wt;
                (field, wt, p) = _readKey(b, p, b.length);
                if (wt == WT_LEN && field == 6) nHops++;
                else if (wt == WT_LEN && field == 12) nReceipt++;
                else if (wt == WT_LEN && field == 14) nVersions++;
                p = _skip(b, p, b.length, wt);
            }
        }
        e.hops = new RouteTypes.Hop[](nHops);
        e.receiptPath = new RouteTypes.Hop[](nReceipt);
        e.filterRegistryVersions = new RouteTypes.RegistryVersion[](nVersions);
        nHops = 0;
        nReceipt = 0;
        nVersions = 0;

        uint256 q = 0;
        while (q < b.length) {
            uint256 field;
            uint256 wt;
            (field, wt, q) = _readKey(b, q, b.length);
            if (wt == WT_VARINT) {
                uint256 v;
                (v, q) = _readVarint(b, q, b.length);
                if (field == 7) e.hopIndex = _u32(v);
                else if (field == 8) e.mode = _mode(v);
                else if (field == 10) e.payloadType = _payloadType(v);
                else if (field == 15) e.routerVersion = _u32(v);
            } else if (wt == WT_LEN) {
                uint256 s;
                uint256 end;
                (s, end, q) = _readLen(b, q, b.length);
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
            } else {
                q = _skip(b, q, b.length, wt);
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

    /// @notice Decode protobuf bytes into a receipt.
    function decodeReceipt(bytes memory b) public pure returns (RouteTypes.Receipt memory r) {
        uint256 n;
        {
            uint256 p = 0;
            while (p < b.length) {
                uint256 field;
                uint256 wt;
                (field, wt, p) = _readKey(b, p, b.length);
                if (wt == WT_LEN && field == 9) n++;
                p = _skip(b, p, b.length, wt);
            }
        }
        r.routePrefix = new RouteTypes.Hop[](n);
        n = 0;
        uint256 q = 0;
        while (q < b.length) {
            uint256 field;
            uint256 wt;
            (field, wt, q) = _readKey(b, q, b.length);
            if (wt == WT_VARINT) {
                uint256 v;
                (v, q) = _readVarint(b, q, b.length);
                if (field == 2) r.status = _status(v);
                else if (field == 3) r.hopIndex = _u32(v);
                else if (field == 5) r.reason = _reason(v);
            } else if (wt == WT_LEN) {
                uint256 s;
                uint256 end;
                (s, end, q) = _readLen(b, q, b.length);
                if (field == 1) r.routeId = _bytes16(b, s, end);
                else if (field == 4) r.ledgerId = string(_copy(b, s, end));
                else if (field == 6) r.caseId = _bytes32(b, s, end);
                else if (field == 7) r.contact = string(_copy(b, s, end));
                else if (field == 8) r.responseHash = _bytes32(b, s, end);
                else if (field == 9) r.routePrefix[n++] = _decodeHop(b, s, end);
                else if (field == 10) r.routeEdge = _bytes32(b, s, end);
                else if (field == 11) r.routeRest = _bytes32(b, s, end);
            } else {
                q = _skip(b, q, b.length, wt);
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

    function _msgField(uint256 field, bytes memory v) private pure returns (bytes memory) {
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

    function _decodeEndpoint(bytes memory b, uint256 p, uint256 end)
        private
        pure
        returns (RouteTypes.Endpoint memory ep)
    {
        while (p < end) {
            uint256 field;
            uint256 wt;
            (field, wt, p) = _readKey(b, p, end);
            if (wt == WT_LEN && (field == 1 || field == 2)) {
                uint256 s;
                uint256 e;
                (s, e, p) = _readLen(b, p, end);
                if (field == 1) ep.ledgerId = string(_copy(b, s, e));
                else ep.application = _copy(b, s, e);
            } else {
                p = _skip(b, p, end, wt);
            }
        }
    }

    function _decodeHop(bytes memory b, uint256 p, uint256 end) private pure returns (RouteTypes.Hop memory h) {
        while (p < end) {
            uint256 field;
            uint256 wt;
            (field, wt, p) = _readKey(b, p, end);
            if (wt == WT_VARINT && field == 5) {
                uint256 v;
                (v, p) = _readVarint(b, p, end);
                h.fee = _u64(v);
            } else if (wt == WT_LEN && field >= 1 && field <= 6 && field != 5) {
                uint256 s;
                uint256 e;
                (s, e, p) = _readLen(b, p, end);
                if (field == 1) h.ledgerId = string(_copy(b, s, e));
                else if (field == 2) h.router = _copy(b, s, e);
                else if (field == 3) h.channelId = _bytes32(b, s, e);
                else if (field == 4) h.connectorId = _bytes32(b, s, e);
                else h.feePayee = _copy(b, s, e);
            } else {
                p = _skip(b, p, end, wt);
            }
        }
    }

    function _decodeConstraints(bytes memory b, uint256 p, uint256 end)
        private
        pure
        returns (RouteTypes.Constraints memory c)
    {
        while (p < end) {
            uint256 field;
            uint256 wt;
            (field, wt, p) = _readKey(b, p, end);
            if (wt != WT_VARINT) {
                p = _skip(b, p, end, wt);
                continue;
            }
            uint256 v;
            (v, p) = _readVarint(b, p, end);
            if (field == 1) c.filters = _u32(v);
            else if (field == 2) c.deadline = _u64(v);
            else if (field == 3) c.maxFee = _u64(v);
            else if (field == 4) c.remainingFeeBudget = _u64(v);
            else if (field == 5) c.trustFloor = _u32(v);
            else if (field == 6) c.maxHops = _u32(v);
            else if (field == 7) c.loose = v != 0;
            else if (field == 8) c.energyCap = _u64(v);
        }
    }

    function _decodeVersion(bytes memory b, uint256 p, uint256 end)
        private
        pure
        returns (RouteTypes.RegistryVersion memory v)
    {
        while (p < end) {
            uint256 field;
            uint256 wt;
            (field, wt, p) = _readKey(b, p, end);
            if (wt != WT_VARINT) {
                p = _skip(b, p, end, wt);
                continue;
            }
            uint256 x;
            (x, p) = _readVarint(b, p, end);
            if (field == 1) v.filter = _u32(x);
            else if (field == 2) v.version = _u64(x);
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
        if (field == 0) revert MalformedProtobuf();
    }

    function _readVarint(bytes memory b, uint256 p, uint256 end) private pure returns (uint256 v, uint256 np) {
        for (uint256 shift = 0; shift < 70; shift += 7) {
            if (p >= end) revert MalformedProtobuf();
            uint256 c = uint8(b[p++]);
            v |= (c & 0x7f) << shift;
            if (c & 0x80 == 0) {
                if (v > type(uint64).max) revert MalformedProtobuf();
                return (v, p);
            }
        }
        revert MalformedProtobuf();
    }

    function _readLen(bytes memory b, uint256 p, uint256 end)
        private
        pure
        returns (uint256 start, uint256 stop, uint256 np)
    {
        uint256 len;
        (len, start) = _readVarint(b, p, end);
        stop = start + len;
        if (stop > end) revert MalformedProtobuf();
        np = stop;
    }

    function _skip(bytes memory b, uint256 p, uint256 end, uint256 wt) private pure returns (uint256) {
        if (wt == WT_VARINT) {
            (, p) = _readVarint(b, p, end);
        } else if (wt == WT_LEN) {
            (,, p) = _readLen(b, p, end);
        } else if (wt == WT_I64) {
            p += 8;
        } else if (wt == WT_I32) {
            p += 4;
        } else {
            revert MalformedProtobuf();
        }
        if (p > end) revert MalformedProtobuf();
        return p;
    }

    function _copy(bytes memory b, uint256 s, uint256 e) private pure returns (bytes memory out) {
        uint256 len = e - s;
        out = new bytes(len);
        assembly ("memory-safe") {
            mcopy(add(out, 0x20), add(add(b, 0x20), s), len)
        }
    }

    function _bytes32(bytes memory b, uint256 s, uint256 e) private pure returns (bytes32 v) {
        if (e == s) return bytes32(0);
        if (e - s != 32) revert MalformedProtobuf();
        assembly ("memory-safe") {
            v := mload(add(add(b, 0x20), s))
        }
    }

    function _bytes16(bytes memory b, uint256 s, uint256 e) private pure returns (bytes16 v) {
        if (e == s) return bytes16(0);
        if (e - s != 16) revert MalformedProtobuf();
        bytes32 w;
        assembly ("memory-safe") {
            w := mload(add(add(b, 0x20), s))
        }
        v = bytes16(w);
    }

    function _u32(uint256 v) private pure returns (uint32) {
        if (v > type(uint32).max) revert MalformedProtobuf();
        return uint32(v);
    }

    function _u64(uint256 v) private pure returns (uint64) {
        return uint64(v); // _readVarint already bounds v to uint64
    }

    function _mode(uint256 v) private pure returns (RouteTypes.Mode) {
        if (v > uint256(type(RouteTypes.Mode).max)) revert MalformedProtobuf();
        return RouteTypes.Mode(v);
    }

    function _payloadType(uint256 v) private pure returns (RouteTypes.PayloadType) {
        if (v > uint256(type(RouteTypes.PayloadType).max)) revert MalformedProtobuf();
        return RouteTypes.PayloadType(v);
    }

    function _status(uint256 v) private pure returns (RouteTypes.ReceiptStatus) {
        if (v > uint256(type(RouteTypes.ReceiptStatus).max)) revert MalformedProtobuf();
        return RouteTypes.ReceiptStatus(v);
    }

    function _reason(uint256 v) private pure returns (RouteTypes.Reason) {
        if (v > uint256(type(RouteTypes.Reason).max)) revert MalformedProtobuf();
        return RouteTypes.Reason(v);
    }
}
