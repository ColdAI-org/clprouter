// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title IProviderRegistry
/// @notice Read interface of the CLPRouter provider registry used by Routers and the quarantine vault.
interface IProviderRegistry {
    /// @notice A committee decision as signed off-chain and relayed by anyone.
    /// @param action One of ProviderRegistry.Action.
    /// @param payload ABI-encoded action arguments (see ProviderRegistry).
    /// @param evidenceHash Hash of the published evidence document; never zero.
    /// @param nonce Free-form uniqueness value chosen by the committee.
    /// @param effectiveAt Earliest effective time the committee asks for (notice periods still apply).
    /// @param validUntil Last timestamp at which the decision may be relayed.
    /// @param epoch Committee epoch whose members signed.
    struct Decision {
        uint8 action;
        bytes payload;
        bytes32 evidenceHash;
        uint64 nonce;
        uint64 effectiveAt;
        uint64 validUntil;
        uint64 epoch;
    }

    /// @notice True if the edge, ledger, Router deployment or Router version keyed by `key` is disabled now.
    function isDisabled(bytes32 key) external view returns (bool);

    /// @notice Whether the CAIP-10 account keyed by `accountKey` is blacklisted now, and under which case.
    function blacklisted(bytes32 accountKey) external view returns (bool listed, bytes32 caseId);

    /// @notice Certification of `certKey` as of registry version `atVersion` (entries applied later are
    ///         ignored), counting only entries whose notice period has passed and whose expiry has not.
    /// @dev Returns (false, 0) if this registry has not reached `atVersion` yet.
    /// @return certified Whether the label holds.
    /// @return emissionsUg ENERGY only: certified emissions in µgCO2e per transaction.
    function certificationAt(bytes32 certKey, uint64 atVersion)
        external
        view
        returns (bool certified, uint64 emissionsUg);

    /// @notice Registry version: number of committee decisions applied so far (monotonically increasing).
    function version() external view returns (uint64);

    /// @notice Provider contact address quoted in quarantine notices.
    function contact() external view returns (string memory);

    /// @notice Current committee epoch.
    function epoch() external view returns (uint64);

    /// @notice Signatures a decision of `action` needs under the current committee.
    function requiredSignatures(uint8 action) external view returns (uint256);

    /// @notice Ledger-independent digest committee members sign for `d`.
    function decisionDigest(Decision calldata d) external pure returns (bytes32);

    /// @notice Reverts unless `sigs` carry at least `required` distinct valid signatures over `digest`
    ///         from members of the current epoch `decisionEpoch`.
    function checkApproval(bytes32 digest, uint64 decisionEpoch, bytes[] calldata sigs, uint256 required) external view;

    /// @notice True if `account` has ever been a committee member (the provider's own accounts).
    function isProviderAccount(address account) external view returns (bool);
}
