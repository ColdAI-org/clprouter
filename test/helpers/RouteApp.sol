// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IClprRouteApplication, IClprRouteSender} from "@clprouter/interfaces/IClprRouteApplication.sol";
import {ClprRouter} from "@clprouter/ClprRouter.sol";

/// @notice Test application: origin sender (receives receipts) and destination receiver (records messages).
contract RouteApp is IClprRouteApplication, IClprRouteSender {
    struct Delivered {
        bytes16 routeId;
        string originLedger;
        bytes originApplication;
        string sender;
        uint8 payloadType;
        bytes payload;
    }

    struct ReceiptSeen {
        bytes16 routeId;
        uint8 status;
        uint8 reason;
        bytes32 caseId;
        bytes32 responseHash;
    }

    address public router;
    bool public shouldRevert;
    bytes public response = "ack";

    Delivered[] public delivered;
    ReceiptSeen[] public receipts;
    bytes16 public lastNoticeRoute;
    bytes32 public lastNoticeCase;
    string public lastNoticeContact;

    function setRouter(address r) external {
        router = r;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function sendRoute(ClprRouter r, ClprRouter.SendRequest calldata req) external payable returns (bytes16) {
        return r.send{value: msg.value}(req);
    }

    function onRouteMessage(
        bytes16 routeId,
        string calldata originLedger,
        bytes calldata originApplication,
        string calldata sender,
        uint8 payloadType,
        bytes calldata payload
    ) external returns (bytes memory) {
        require(msg.sender == router, "untrusted router");
        require(!shouldRevert, "app says no");
        delivered.push(Delivered(routeId, originLedger, originApplication, sender, payloadType, payload));
        return response;
    }

    function onRouteNotice(bytes16 routeId, bytes32 caseId, string calldata contact) external {
        require(msg.sender == router, "untrusted router");
        lastNoticeRoute = routeId;
        lastNoticeCase = caseId;
        lastNoticeContact = contact;
    }

    function onRouteReceipt(bytes16 routeId, uint8 status, uint8 reason, bytes32 caseId, bytes32 responseHash)
        external
    {
        receipts.push(ReceiptSeen(routeId, status, reason, caseId, responseHash));
    }

    function deliveredCount() external view returns (uint256) {
        return delivered.length;
    }

    function receiptCount() external view returns (uint256) {
        return receipts.length;
    }

    receive() external payable {}
}
