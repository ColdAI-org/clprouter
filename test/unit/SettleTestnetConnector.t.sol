// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SettleTestnetConnector} from "../../script/deploy/SettleFixtures.sol";

contract SettleTestnetConnectorTest is Test {
    address internal constant SERVICE = address(0x5e);
    address internal constant OWNER = address(0x0e);
    address internal constant DEPOSIT = address(0xd1);
    address internal constant DELIVERY = address(0xe2);
    SettleTestnetConnector internal c;

    function setUp() public {
        c = new SettleTestnetConnector(SERVICE, OWNER);
        vm.startPrank(OWNER);
        c.setAllowed(DEPOSIT, true);
        c.setAllowed(DELIVERY, true);
        vm.stopPrank();
    }

    function test_authorizesEachAllowedSenderOnlyForTheService() public {
        vm.startPrank(SERVICE);
        assertTrue(c.authorizeOutboundMessage(bytes32(0), "", abi.encodePacked(DEPOSIT), ""));
        assertTrue(c.authorizeOutboundMessage(bytes32(0), "", abi.encodePacked(DELIVERY), ""));
        assertFalse(c.authorizeOutboundMessage(bytes32(0), "", abi.encodePacked(address(0xbad)), ""));
        // Not a 20-byte sender: refused.
        assertFalse(c.authorizeOutboundMessage(bytes32(0), "", abi.encode(DEPOSIT), ""));
        vm.stopPrank();
        vm.expectRevert(SettleTestnetConnector.NotService.selector);
        c.authorizeOutboundMessage(bytes32(0), "", abi.encodePacked(DEPOSIT), "");
    }

    function test_onlyOwnerChangesSendersAndWithdraws() public {
        vm.expectRevert(SettleTestnetConnector.NotOwner.selector);
        c.setAllowed(address(0xbad), true);
        vm.deal(address(c), 1 ether);
        vm.expectRevert(SettleTestnetConnector.NotOwner.selector);
        c.withdraw(payable(address(this)), 1);
        vm.prank(OWNER);
        c.setAllowed(DEPOSIT, false);
        vm.prank(SERVICE);
        assertFalse(c.authorizeOutboundMessage(bytes32(0), "", abi.encodePacked(DEPOSIT), ""));
    }

    function test_paysExecutionOnlyToTheService() public {
        vm.deal(address(c), 1 ether);
        vm.expectRevert(SettleTestnetConnector.NotService.selector);
        c.payForExecution(1);
        vm.prank(SERVICE);
        c.payForExecution(0.25 ether);
        assertEq(SERVICE.balance, 0.25 ether);
    }
}
