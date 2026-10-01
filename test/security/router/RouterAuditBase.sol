// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ClprTypes} from "@hiero-ledger/clpr/libraries/ClprTypes.sol";
import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprRouter} from "@clprouter/ClprRouter.sol";
import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {QuarantineVault} from "@clprouter/QuarantineVault.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {IQuarantineVault} from "@clprouter/interfaces/IQuarantineVault.sol";
import {IClprRouteApplication, IClprRouteSender} from "@clprouter/interfaces/IClprRouteApplication.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {RouteCodec} from "@clprouter/libraries/RouteCodec.sol";
import {RouteLogic} from "@clprouter/libraries/RouteLogic.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {Committee} from "../../helpers/Committee.sol";

/// @notice CLPR Service stand-in for the Router security suite (docs/audit/router-findings.md). Like
///         test/helpers/MockRouteService, plus: delivery with a caller-chosen gas limit and try/catch (as the
///         reference ClprService dispatches applications), and per-Channel send failures that stand for any
///         transient `sendMessage` revert (ClprQueueFull, ClprQueueQuotaExceeded, a refusing Connector, ...).
contract SecMockService {
    error ReentrancyGuardReentrantCall();

    struct Sent {
        bytes32 channelId;
        bytes32 connectorId;
        bytes target;
        bytes data;
    }

    string public chainId;
    mapping(bytes32 => string) public peerOf;
    mapping(bytes32 => bool) public failChannel;
    bool public guardActive;
    bool private _inDelivery;
    Sent[] private _sent;
    uint64 private _nextId;

    constructor(string memory chainId_) {
        chainId = chainId_;
    }

    function setPeer(bytes32 ch, string calldata peer) external {
        peerOf[ch] = peer;
    }

    function setFailChannel(bytes32 ch, bool v) external {
        failChannel[ch] = v;
    }

    function setGuard(bool v) external {
        guardActive = v;
    }

    function getLedgerConfiguration() external view returns (ClprTypes.LedgerConfiguration memory c) {
        c.chainId = chainId;
    }

    function getChannel(bytes32 ch) external view returns (ClprTypes.Channel memory c) {
        if (bytes(peerOf[ch]).length == 0) revert ClprTypes.ClprChannelNotFound();
        c.channelId = ch;
        c.chainId = peerOf[ch];
    }

    function sendMessage(bytes32 ch, bytes32 conn, bytes calldata target, bytes calldata data)
        external
        returns (uint64)
    {
        if (guardActive && _inDelivery) revert ReentrancyGuardReentrantCall();
        if (failChannel[ch]) revert ClprTypes.ClprQueueFull();
        _sent.push(Sent(ch, conn, target, data));
        return ++_nextId;
    }

    /// @dev Delivery that bubbles reverts (for tests that want to see the Router's own error).
    function deliver(ClprRouter router, bytes32 ch, bytes calldata sender, bytes calldata data)
        external
        returns (bytes memory r)
    {
        _inDelivery = true;
        r = router.onClprMessage(ch, sender, data);
        _inDelivery = false;
    }

    /// @dev Delivery as the reference ClprService does it: `{gas: gasLimit}` inside try/catch.
    function deliverWithGas(ClprRouter router, bytes32 ch, bytes calldata sender, bytes calldata data, uint256 g)
        external
        returns (bool ok, bytes memory r)
    {
        _inDelivery = true;
        try router.onClprMessage{gas: g}(ch, sender, data) returns (bytes memory resp) {
            ok = true;
            r = resp;
        } catch (bytes memory err) {
            r = err;
        }
        _inDelivery = false;
    }

    function respond(ClprRouter router, bytes32 ch, uint64 messageId, uint8 status) external {
        _inDelivery = true;
        router.onClprResponse(ch, messageId, status, "");
        _inDelivery = false;
    }

    function sentCount() external view returns (uint256) {
        return _sent.length;
    }

    function sent(uint256 i) external view returns (Sent memory) {
        return _sent[i];
    }

    function lastId() external view returns (uint64) {
        return _nextId;
    }
}

/// @notice Destination application that needs `burn` gas to accept a message (well inside APP_GAS).
contract GasHungryApp is IClprRouteApplication {
    address public router;
    uint256 public burn;
    uint256 public accepted;

    constructor(address r, uint256 b) {
        router = r;
        burn = b;
    }

    function onRouteMessage(bytes16, string calldata, bytes calldata, string calldata, uint8, bytes calldata)
        external
        returns (bytes memory)
    {
        require(msg.sender == router, "untrusted router");
        uint256 stop = gasleft() - burn;
        while (gasleft() > stop) {}
        accepted++;
        return "ok";
    }

    function onRouteNotice(bytes16, bytes32, string calldata) external {}
}

/// @notice Payment receiver whose `receive` returns as much data as 30,000 gas allows (a return bomb).
contract ReturnBomb {
    uint256 public immutable SIZE;

    constructor(uint256 size) {
        SIZE = size;
    }

    receive() external payable {
        uint256 n = SIZE;
        assembly {
            return(0, n)
        }
    }

    /// @dev Origin-side sender: sends a route from this contract (so refunds come back here).
    function sendRoute(ClprRouter r, ClprRouter.SendRequest calldata req) external payable returns (bytes16) {
        return r.send{value: msg.value}(req);
    }
}

/// @notice Contract that rejects plain payments (exercises the Router's `owed` pull-payment path).
contract RejectingReceiver {
    function withdrawFrom(ClprRouter r) external {
        r.withdraw();
    }
}

/// @notice Any application on a ledger peered with a Router's ledger: sends raw CLPR messages.
contract ClprMessenger {
    function send(IClprService s, bytes32 ch, bytes32 conn, bytes calldata target, bytes calldata data)
        external
        returns (uint64)
    {
        return s.sendMessage(ch, conn, target, data);
    }

    function onClprResponse(bytes32, uint64, uint8, bytes calldata) external {}
}

/// @notice A "Router" deployment on an intermediate ledger controlled by the route's sender: forwards the
///         envelope exactly like a real Router (so the destination delivers), then reports FAILED to the origin.
contract FakeRouter {
    IClprService public immutable SERVICE;
    string public ledgerId;
    bytes public held;

    constructor(IClprService s, string memory id) {
        SERVICE = s;
        ledgerId = id;
    }

    function onClprMessage(bytes32, bytes calldata, bytes calldata data) external returns (bytes memory) {
        held = data; // the reference ClprService forbids sendMessage inside delivery; pump() later
        return abi.encodePacked(uint8(1), uint8(0));
    }

    function onClprResponse(bytes32, uint64, uint8, bytes calldata) external {}

    function pump() external {
        RouteTypes.Envelope memory e = RouteCodec.decodeEnvelope(held);
        uint256 k = e.hopIndex;
        RouteTypes.Hop memory h = e.hops[k];
        // 1. Honest-looking forward to the next Router.
        e.constraints.remainingFeeBudget -= h.fee;
        e.hopIndex = uint32(k + 1);
        SERVICE.sendMessage(h.channelId, h.connectorId, e.hops[k + 1].router, RouteCodec.encodeEnvelope(e));
        // 2. A FAILED receipt "from this hop" back to the origin.
        e.hopIndex = uint32(k);
        RouteTypes.Receipt memory r;
        r.status = RouteTypes.ReceiptStatus.FAILED;
        r.reason = RouteTypes.Reason.NEXT_HOP_ERROR;
        (, RouteTypes.Hop[] memory back, bytes memory data) = RouteLogic.buildReceipt(e, r, ledgerId, address(this), 1);
        SERVICE.sendMessage(back[0].channelId, back[0].connectorId, back[1].router, data);
    }
}

/// @notice One origin Router (ledger A) on {SecMockService}, with helpers that play the rest of the route.
abstract contract OriginHarness is Committee {
    string internal constant ID_A = "eip155:31001";
    string internal constant ID_B = "eip155:31002";
    string internal constant ID_C = "eip155:31003";
    bytes32 internal constant CH_AB = keccak256("AB");
    bytes32 internal constant CH_BC = keccak256("BC");
    bytes32 internal constant CONN = keccak256("connector");
    uint64 internal constant GRACE = 1 hours;
    uint64 internal constant APP_GAS_ = 300_000;
    uint64 internal constant MIN_SEND_GAS_ = 200_000;

    SecMockService internal svcA;
    ProviderRegistry internal regA;
    QuarantineVault internal vaultA;
    ClprRouter internal routerA;
    address internal routerB = makeAddr("router-B");
    address internal routerC = makeAddr("router-C");
    address internal destApp = makeAddr("dest-app");

    function _deployOrigin() internal {
        _initCommittee();
        svcA = new SecMockService(ID_A);
        svcA.setPeer(CH_AB, ID_B);
        regA = _deployRegistry();
        vaultA = new QuarantineVault(IProviderRegistry(address(regA)), 3 days, 7 days);
        routerA = new ClprRouter(
            IClprService(address(svcA)),
            IProviderRegistry(address(regA)),
            IQuarantineVault(address(vaultA)),
            ID_A,
            GRACE,
            APP_GAS_,
            MIN_SEND_GAS_
        );
    }

    function _hop(string memory id, address router, bytes32 ch, uint64 fee, address payee_)
        internal
        pure
        returns (RouteTypes.Hop memory)
    {
        return RouteTypes.Hop({
            ledgerId: id,
            router: abi.encodePacked(router),
            channelId: ch,
            connectorId: ch == bytes32(0) ? bytes32(0) : CONN,
            fee: fee,
            feePayee: payee_ == address(0) ? bytes("") : abi.encodePacked(payee_)
        });
    }

    /// @dev A -> B -> C request; fee0/fee1 to feePayee0/feePayee1.
    function _req(uint256 escrow, address payee_, uint64 fee0, address p0, uint64 fee1, address p1)
        internal
        view
        returns (ClprRouter.SendRequest memory req)
    {
        req.destination = RouteTypes.Endpoint(ID_C, abi.encodePacked(destApp));
        req.recipient = Caip.account(ID_C, destApp);
        req.hops = new RouteTypes.Hop[](3);
        req.hops[0] = _hop(ID_A, address(routerA), CH_AB, fee0, p0);
        req.hops[1] = _hop(ID_B, routerB, CH_BC, fee1, p1);
        req.hops[2] = _hop(ID_C, routerC, bytes32(0), 0, address(0));
        req.constraints.deadline = uint64(block.timestamp + 1 hours);
        req.payload = "pay";
        req.escrow = escrow;
        req.payee = payee_;
    }

    /// @dev The receipt hop `k` of the envelope `sent` (as the origin put it on the wire) would send, as it
    ///      arrives at the origin after travelling the reverse route.
    function _receiptAtOrigin(
        RouteTypes.Envelope memory sent,
        uint256 k,
        RouteTypes.ReceiptStatus status,
        RouteTypes.Reason reason,
        bytes32 caseId
    ) internal pure returns (bytes memory) {
        sent.hopIndex = uint32(k);
        RouteTypes.Receipt memory r;
        r.status = status;
        r.reason = reason;
        r.caseId = caseId;
        if (status == RouteTypes.ReceiptStatus.QUARANTINED) r.contact = "mailto:x";
        (,, bytes memory data) =
            RouteLogic.buildReceipt(sent, r, sent.hops[k].ledgerId, address(bytes20(sent.hops[k].router)), 1);
        RouteTypes.Envelope memory re = RouteCodec.decodeEnvelope(data);
        re.hopIndex = uint32(re.hops.length - 1);
        return RouteCodec.encodeEnvelope(re);
    }

    function _status(bytes16 id) internal view returns (ClprRouter.RouteStatus s) {
        (,, s,,,,,,,) = routerA.routes(id);
    }
}
