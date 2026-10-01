// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title Caip
/// @notice Helpers for CAIP-2 ledger ids and CAIP-10 account ids, and the registry keys built from them.
/// @dev All keys are ledger-independent so one committee decision means the same thing on every ledger.
library Caip {
    /// @notice CAIP-10 id of an EVM account on `ledgerId`: "<ledgerId>:0x<lower-case hex>".
    function account(string memory ledgerId, address a) internal pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory s = new bytes(42);
        s[0] = "0";
        s[1] = "x";
        uint160 v = uint160(a);
        for (uint256 i = 41; i > 1; i--) {
            s[i] = hexChars[v & 0xf];
            v >>= 4;
        }
        return string.concat(ledgerId, ":", string(s));
    }

    /// @notice ASCII lower-casing; CAIP-10 ids are compared case-insensitively by the blacklist.
    function lower(string memory s) internal pure returns (bytes memory out) {
        bytes memory b = bytes(s);
        out = new bytes(b.length);
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            out[i] = (c >= "A" && c <= "Z") ? bytes1(uint8(c) + 32) : c;
        }
    }

    /// @notice Blacklist key of a CAIP-10 account.
    function accountKey(string memory caip10) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("account", lower(caip10)));
    }

    /// @notice Disable key of a whole ledger.
    function ledgerKey(string memory ledgerId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("ledger", ledgerId));
    }

    /// @notice Disable key of one Channel direction: the edge of `channelId` that delivers into `toLedgerId`.
    /// @dev A Channel joins exactly two ledgers, so the receiving ledger fixes the direction.
    function edgeKey(bytes32 channelId, string memory toLedgerId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("edge", channelId, toLedgerId));
    }

    /// @notice Disable key of one Router deployment.
    function routerKey(string memory ledgerId, bytes memory router) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("router", ledgerId, ":", router));
    }

    /// @notice Disable key of a Router code version on every ledger.
    function routerVersionKey(uint32 version) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("router-version", version));
    }

    /// @notice Certification key of (ledger, label).
    function certKey(string memory ledgerId, uint8 label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("cert", label, ledgerId));
    }
}
