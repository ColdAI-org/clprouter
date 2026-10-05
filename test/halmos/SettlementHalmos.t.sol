// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SymTest} from "halmos-cheatcodes/SymTest.sol";
import {IClprRouter} from "@clprouter/interfaces/IClprRouter.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {IQuarantineVault} from "@clprouter/interfaces/IQuarantineVault.sol";
import {RouteSettlement} from "@clprouter/libraries/RouteSettlement.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {RouteCodec} from "@clprouter/libraries/RouteCodec.sol";
import {RouteLogic} from "@clprouter/libraries/RouteLogic.sol";

/// @dev Registry stand-in for the settlement proofs: blacklist answers come from (symbolic) storage.
contract BlacklistStub {
    mapping(bytes32 => bool) public listed;
    mapping(bytes32 => bytes32) public caseOf;

    function blacklisted(bytes32 key) external view returns (bool, bytes32) {
        return (listed[key], caseOf[key]);
    }

    function contact() external pure returns (string memory) {
        return "c";
    }
}

/// @dev Vault stand-in: accepts and counts what the Router diverts.
contract VaultStub is IQuarantineVault {
    uint256 public received;

    function deposit(bytes16, bytes32, address, address) external payable returns (uint256) {
        received += msg.value;
        return 1;
    }
}

/// @dev A payee whose push always fails (exercises the `owed` pull path).
contract Rejecter {
    receive() external payable {
        revert();
    }
}

/// @dev Holds the Router's settlement state and calls the real RouteSettlement library (DELEGATECALL, as
///      ClprRouter does). `finish` is entered only for a PENDING route, as at every ClprRouter call site.
contract SettlementHarness {
    mapping(bytes16 => IClprRouter.OriginRoute) public routes;
    mapping(address => uint256) public owed;
    RouteSettlement.Ctx internal ctx;

    constructor(IProviderRegistry registry, IQuarantineVault vault) {
        ctx = RouteSettlement.Ctx(registry, vault, "eip155:1", 50_000, 1 hours);
    }

    receive() external payable {}

    function setRoute(bytes16 id, IClprRouter.OriginRoute memory o) external {
        routes[id] = o;
    }

    function finishPending(
        bytes16 id,
        IClprRouter.RouteStatus status,
        RouteTypes.Reason reason,
        bytes32 caseId,
        RouteTypes.Hop[] memory forwarded
    ) external {
        require(routes[id].status == IClprRouter.RouteStatus.PENDING);
        RouteSettlement.finish(routes, owed, ctx, id, status, reason, 1, caseId, bytes32(0), forwarded);
    }

    function reclaim(bytes16 id) external {
        RouteSettlement.reclaim(routes, owed, ctx, id);
    }

    function statusOf(bytes16 id) external view returns (IClprRouter.RouteStatus) {
        return routes[id].status;
    }
}

/// @title Symbolic proofs: CLPRouter origin-side escrow settlement (RouteSettlement)
/// @notice Run with `halmos` (see docs/quality.md). For every escrow, fee budget, hop fees, receipt status and
///         blacklist outcome: the escrow plus fee budget leaves the Router exactly once and is split into
///         settled (payee + hop fees), refunded (sender) and quarantined (vault) amounts that add up; a route
///         settles or is refunded at most once.
contract SettlementHalmos is Test, SymTest {
    address internal constant SENDER = address(0xA11CE);
    address internal constant PAYEE = address(0xB0B);
    address internal constant FEE1 = address(0xF1);
    address internal constant FEE2 = address(0xF2);
    bytes16 internal constant ID = bytes16(uint128(1));

    BlacklistStub internal registry;
    VaultStub internal vault;
    SettlementHarness internal h;
    Rejecter internal rejecter;

    function _etchLibrary(bytes memory code, address at) internal {
        address deployed;
        assembly ("memory-safe") {
            deployed := create(0, add(code, 0x20), mload(code))
        }
        require(deployed != address(0));
        vm.etch(at, deployed.code);
    }

    function setUp() public {
        // The halmos profile links the external libraries at these addresses (foundry.toml, [profile.halmos]).
        _etchLibrary(type(RouteCodec).creationCode, address(0xc0dec));
        _etchLibrary(type(RouteLogic).creationCode, address(0x106c));
        _etchLibrary(type(RouteSettlement).creationCode, address(0x5e77));
        registry = new BlacklistStub();
        vault = new VaultStub();
        h = new SettlementHarness(IProviderRegistry(address(registry)), vault);
        rejecter = new Rejecter();
    }

    function _route(address payee, uint256 escrow, uint64 budget)
        internal
        pure
        returns (IClprRouter.OriginRoute memory o)
    {
        o.sender = SENDER;
        o.payee = payee;
        o.status = IClprRouter.RouteStatus.PENDING;
        o.escrow = escrow;
        o.feeBudget = budget;
        o.deadline = 1000;
        o.edges = 2;
    }

    function _hop(uint64 fee, address payee) internal pure returns (RouteTypes.Hop memory hp) {
        hp.fee = fee;
        hp.feePayee = abi.encodePacked(payee);
    }

    /// @notice Escrow conservation for one settlement: escrow + fee budget = hop fees + paid to payee + refunded
    ///         to sender + quarantined, with failed pushes credited to `owed` and nothing else moving.
    function check_finish_conservesEscrow(
        uint128 escrow,
        uint64 budget,
        uint64 fee1,
        uint64 fee2,
        uint8 statusRaw,
        bool payeeRejects,
        uint128 other
    ) public {
        svm.enableSymbolicStorage(address(registry));
        vm.assume(statusRaw >= uint8(IClprRouter.RouteStatus.DELIVERED));
        vm.assume(statusRaw <= uint8(IClprRouter.RouteStatus.QUARANTINED));
        IClprRouter.RouteStatus status = IClprRouter.RouteStatus(statusRaw);
        address payee = payeeRejects ? address(rejecter) : PAYEE;

        h.setRoute(ID, _route(payee, escrow, budget));
        uint256 held = uint256(escrow) + budget + other; // `other`: funds of other routes, must not move
        vm.deal(address(h), held);

        RouteTypes.Hop[] memory fwd = new RouteTypes.Hop[](2);
        fwd[0] = _hop(fee1, FEE1);
        fwd[1] = _hop(fee2, FEE2);

        h.finishPending(ID, status, RouteTypes.Reason.NONE, bytes32(uint256(7)), fwd);

        IClprRouter.RouteStatus fin = h.statusOf(ID);
        uint256 fees = FEE1.balance + FEE2.balance;
        uint256 toPayee = payee.balance + h.owed(payee);
        uint256 toSender = SENDER.balance + h.owed(SENDER);
        uint256 toVault = vault.received();

        // Exactly escrow + budget left the Router's free balance (paid out or credited to `owed`).
        assert(address(h).balance == uint256(other) + h.owed(payee) + h.owed(SENDER));
        assert(fees + toPayee + toSender + toVault == uint256(escrow) + budget);
        assert(fees <= budget);
        // Terminal, and the outcome decides who is paid.
        assert(fin != IClprRouter.RouteStatus.PENDING && fin != IClprRouter.RouteStatus.NONE);
        if (fin == IClprRouter.RouteStatus.DELIVERED) {
            assert(status == IClprRouter.RouteStatus.DELIVERED);
            assert(toPayee == escrow && toSender == budget - fees && toVault == 0);
        } else if (fin == IClprRouter.RouteStatus.QUARANTINED) {
            assert(toVault == uint256(escrow) + budget - fees && toPayee == 0 && toSender == 0);
        } else {
            assert(fin == status);
            assert(toSender == uint256(escrow) + budget - fees && toPayee == 0 && toVault == 0);
        }
    }

    /// @notice A route that is not PENDING is never settled or refunded again: reclaim reverts and moves nothing.
    function check_reclaim_onlyPending(uint8 statusRaw, uint64 reclaimAt, uint8 heldCount, uint64 t) public {
        vm.assume(statusRaw <= uint8(IClprRouter.RouteStatus.QUARANTINED));
        vm.assume(statusRaw != uint8(IClprRouter.RouteStatus.PENDING));
        IClprRouter.OriginRoute memory o = _route(PAYEE, 5 ether, 1 ether);
        o.status = IClprRouter.RouteStatus(statusRaw);
        o.reclaimAt = reclaimAt;
        o.held = heldCount;
        h.setRoute(ID, o);
        vm.deal(address(h), 6 ether);
        vm.warp(t);
        (bool ok,) = address(h).call(abi.encodeCall(h.reclaim, (ID)));
        assert(!ok);
        assert(address(h).balance == 6 ether);
    }

    /// @notice The two-phase reclaim refunds escrow + whole fee budget to the sender exactly once, never before
    ///         the deadline plus the grace per edge, and never while a receipt is held.
    function check_reclaim_refundsOnce(uint128 escrow, uint64 budget, uint64 t1, uint64 t2, uint8 heldCount) public {
        IClprRouter.OriginRoute memory o = _route(PAYEE, escrow, budget);
        o.held = heldCount;
        h.setRoute(ID, o);
        vm.deal(address(h), uint256(escrow) + budget);
        // Timestamps below 2^40 s (year ~36,800); the Router stores times as uint64.
        vm.assume(t1 < 2 ** 40 && t2 < 2 ** 40);

        vm.warp(t1);
        (bool ok1,) = address(h).call(abi.encodeCall(h.reclaim, (ID)));
        if (ok1) assert(heldCount == 0 && uint256(t1) > 1000 + 2 * 1 hours);
        vm.assume(ok1);
        assert(SENDER.balance == 0); // phase 1 only publishes the request
        vm.assume(t2 >= t1);
        vm.warp(t2);
        (bool ok2,) = address(h).call(abi.encodeCall(h.reclaim, (ID)));
        if (ok2) {
            assert(uint256(t2) >= uint256(t1) + 1 hours);
            assert(SENDER.balance == uint256(escrow) + budget);
            assert(h.statusOf(ID) == IClprRouter.RouteStatus.EXPIRED);
            (bool ok3,) = address(h).call(abi.encodeCall(h.reclaim, (ID)));
            assert(!ok3);
            assert(SENDER.balance == uint256(escrow) + budget);
        }
    }
}
