// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IClprService} from "@hiero-ledger/clpr/interfaces/IClprService.sol";
import {ClprRouter} from "@clprouter/ClprRouter.sol";
import {ClprRouterDeployer} from "@clprouter/ClprRouterDeployer.sol";
import {IClprRouter, IClprRouterDeployer} from "@clprouter/interfaces/IClprRouter.sol";
import {ProviderRegistry} from "@clprouter/ProviderRegistry.sol";
import {QuarantineVault} from "@clprouter/QuarantineVault.sol";
import {IProviderRegistry} from "@clprouter/interfaces/IProviderRegistry.sol";
import {IQuarantineVault} from "@clprouter/interfaces/IQuarantineVault.sol";
import {RouteTypes} from "@clprouter/libraries/RouteTypes.sol";
import {RouteCodec} from "@clprouter/libraries/RouteCodec.sol";
import {RouteLogic} from "@clprouter/libraries/RouteLogic.sol";
import {Caip} from "@clprouter/libraries/Caip.sol";
import {Committee} from "../helpers/Committee.sol";
import {MockRouteService} from "../helpers/MockRouteService.sol";
import {RouterDeploy} from "../helpers/RouterDeploy.sol";

/// @notice Canonical Router deployment (H-02 / M-04 root fix) and CAIP-2 normalisation of bare chain ids.
contract RouterDeployerTest is Committee, RouterDeploy {
    ProviderRegistry internal reg;
    QuarantineVault internal vault;

    function setUp() public {
        vm.warp(1_800_000_000);
        _initCommittee();
        _initRouterDeployer();
        reg = _deployRegistry();
        vault = new QuarantineVault(IProviderRegistry(address(reg)), 3 days, 7 days);
    }

    function _params(MockRouteService s, string memory id) internal view returns (IClprRouterDeployer.Params memory) {
        return IClprRouterDeployer.Params(
            IClprService(address(s)),
            IProviderRegistry(address(reg)),
            IQuarantineVault(address(vault)),
            id,
            1 hours,
            300_000,
            200_000
        );
    }

    function test_routerLandsAtItsCanonicalAddress_andKnowsEveryOther() public {
        MockRouteService s = new MockRouteService("eip155:7");
        address predicted = _routerAddr("eip155:7");
        ClprRouter r = ClprRouter(routerDeployer.deploy(type(ClprRouter).creationCode, _params(s, "eip155:7")));
        assertEq(address(r), predicted);
        assertEq(r.canonicalRouter("eip155:7"), predicted);
        assertEq(r.canonicalRouter("eip155:8"), _routerAddr("eip155:8"));
        assertEq(r.DEPLOYER(), address(routerDeployer));
        // The address is taken for good: no second Router for the same ledger.
        MockRouteService s2 = new MockRouteService("eip155:7");
        vm.expectRevert(ClprRouterDeployer.DeployFailed.selector);
        routerDeployer.deploy(type(ClprRouter).creationCode, _params(s2, "eip155:7"));
    }

    function test_onlyOwner_andOnlyPinnedInitCode() public {
        MockRouteService s = new MockRouteService("eip155:7");
        vm.prank(makeAddr("squatter"));
        vm.expectRevert(ClprRouterDeployer.NotOwner.selector);
        routerDeployer.deploy(type(ClprRouter).creationCode, _params(s, "eip155:7"));
        vm.expectRevert(ClprRouterDeployer.WrongInitCode.selector);
        routerDeployer.deploy(bytes.concat(type(ClprRouter).creationCode, hex"00"), _params(s, "eip155:7"));
    }

    function test_routerCannotBeDeployedOutsideTheDeployer() public {
        // The constructor reads its parameters from msg.sender; anything else fails.
        vm.expectRevert();
        new ClprRouter();
    }

    /// @dev Testnet CLPR Services report bare EIP-155 chain ids ("296"); the Router normalises them to CAIP-2.
    function test_bareChainIds_areNormalisedToCaip2() public {
        MockRouteService s = new MockRouteService("31002");
        s.setPeer(keccak256("AB"), "31001");
        s.setPeer(keccak256("BC"), "eip155:31003");
        ClprRouter r = ClprRouter(routerDeployer.deploy(type(ClprRouter).creationCode, _params(s, "eip155:31002")));
        assertEq(r.ledgerId(), "eip155:31002");
        _approveBoth(reg, keccak256("AB"), "eip155:31001", "eip155:31002", address(s));
        _approveBoth(reg, keccak256("BC"), "eip155:31002", "eip155:31003", address(s));
        vm.warp(block.timestamp + CERT_NOTICE);

        // An envelope from A over a Channel whose peer the Service names "31001" is accepted and forwarded.
        RouteTypes.Envelope memory e;
        e.routeId = bytes16(keccak256("r"));
        e.origin = RouteTypes.Endpoint("eip155:31001", abi.encodePacked(makeAddr("app")));
        e.destination = RouteTypes.Endpoint("eip155:31003", abi.encodePacked(makeAddr("dest")));
        e.hops = new RouteTypes.Hop[](3);
        e.hops[0] = RouteTypes.Hop(
            "eip155:31001", abi.encodePacked(_routerAddr("eip155:31001")), keccak256("AB"), keccak256("c"), 0, ""
        );
        e.hops[1] = RouteTypes.Hop("eip155:31002", abi.encodePacked(address(r)), keccak256("BC"), keccak256("c"), 0, "");
        e.hops[2] = RouteTypes.Hop(
            "eip155:31003", abi.encodePacked(_routerAddr("eip155:31003")), bytes32(0), bytes32(0), 0, ""
        );
        e.hopIndex = 1;
        e.constraints.deadline = uint64(block.timestamp + 1 hours);
        e.routerVersion = 1;
        s.deliver(r, keccak256("AB"), abi.encodePacked(_routerAddr("eip155:31001")), RouteCodec.encodeEnvelope(e));
        assertEq(s.sentCount(), 1, "forwarded");
        assertEq(RouteLogic.ledgerHash("296"), keccak256("eip155:296"));
        assertEq(RouteLogic.ledgerHash("hedera:testnet"), keccak256("hedera:testnet"));
    }

    function test_mismatchedChainId_reverts() public {
        MockRouteService s = new MockRouteService("297");
        vm.expectRevert(); // LedgerMismatch inside CREATE2 -> DeployFailed
        routerDeployer.deploy(type(ClprRouter).creationCode, _params(s, "eip155:296"));
    }
}
