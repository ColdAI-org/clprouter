// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title IQuarantineVault
/// @notice Deposit interface of the per-ledger quarantine vault, as used by CLPRouter.
interface IQuarantineVault {
    function deposit(bytes16 routeId, bytes32 caseId, address sender, address recipient)
        external
        payable
        returns (uint256 depositId);
}
