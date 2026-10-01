// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {ClprRouter} from "@clprouter/ClprRouter.sol";
import {IClprRouter} from "@clprouter/interfaces/IClprRouter.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {ThreeLedgerFixture} from "../helpers/ThreeLedgerFixture.sol";

/// @notice Gas per step of the README's reference route: A → B → C with escrow on the reference ClprService,
///         every deferred hop completed by a separate permissionless call. Run with `-vv` to print the table.
contract GasProfileTest is ThreeLedgerFixture {
    function test_gasProfile_threeHopEscrowRoute() public {
        uint256 g = gasleft();
        bytes16 id = _sendAs(alice, _request(1 ether), 1.1 ether);
        uint256 sendGas = g - gasleft();

        (uint256 submitB, uint256 forwardB) = _step(A, B, chAB);
        (uint256 submitC, uint256 flushC) = _step(B, C, chBC);
        (uint256 submitRB, uint256 forwardRB) = _step(C, B, chBC);
        (uint256 settleA,) = _step(B, A, chAB);

        assertEq(uint8(_routeStatus(id)), uint8(IClprRouter.RouteStatus.DELIVERED));
        console.log("send on A                    ", sendGas);
        console.log("hop B: submitBundle          ", submitB);
        console.log("hop B: forward               ", forwardB);
        console.log("dest C: submitBundle+deliver ", submitC);
        console.log("dest C: flush receipt        ", flushC);
        console.log("receipt at B: submitBundle   ", submitRB);
        console.log("receipt at B: forward        ", forwardRB);
        console.log("settle on A: submitBundle    ", settleA);
    }

    /// @dev One bundle src → dst, then the permissionless completion of whatever the delivery deferred.
    function _step(Ledger memory src, Ledger memory dst, bytes32 ch) internal returns (uint256 submit, uint256 pump) {
        bytes memory bundle = _bundle(src, dst, ch);
        vm.recordLogs();
        uint256 g = gasleft();
        dst.service.submitBundle(ch, bundle);
        submit = g - gasleft();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] == IClprRouter.ForwardPending.selector) {
                (, bytes memory env) = abi.decode(logs[i].data, (uint32, bytes));
                g = gasleft();
                ClprRouter(logs[i].emitter).forward(env, new RouteTypes.Hop[](0));
                pump += g - gasleft();
            } else if (logs[i].topics[0] == IClprRouter.OutboxQueued.selector) {
                (bytes32 c, bytes32 k, bytes memory target, bytes memory data) =
                    abi.decode(logs[i].data, (bytes32, bytes32, bytes, bytes));
                g = gasleft();
                ClprRouter(logs[i].emitter).flush(c, k, target, data);
                pump += g - gasleft();
            }
        }
    }
}
