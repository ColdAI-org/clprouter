// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EthMainnetVerifier} from "@hiero-ledger/clpr/verifiers/evm/ethereum/EthMainnetVerifier.sol";

/// @notice Deploy the CLPR repo's EthMainnetVerifier (lib/clpr-smart-contracts, unchanged) on Hedera testnet with
///         CREATE2, or reuse an existing deployment whose runtime code is byte-identical to this build.
///         Kept in its own file so it compiles with the default profile (optimizer runs 2000, like the CLPR repo),
///         not the Router's size profile.
///
///         Env: CLPR_TESTNET_PRIVATE_KEY, ETH_VERIFIER_SALT (string), ETH_VERIFIER_REUSE (optional address).
contract DeployEthVerifier is Script {
    function run() external {
        bytes memory init = type(EthMainnetVerifier).creationCode;
        bytes memory runtime = type(EthMainnetVerifier).runtimeCode;
        console.log("BUILD_RUNTIME_SIZE", runtime.length);
        console.log("BUILD_RUNTIME_HASH");
        console.logBytes32(keccak256(runtime));

        address reuse = vm.envOr("ETH_VERIFIER_REUSE", address(0));
        if (reuse != address(0)) {
            console.log("CANDIDATE", reuse);
            console.log("CANDIDATE_SIZE", reuse.code.length);
            console.logBytes32(reuse.codehash);
            if (reuse.codehash == keccak256(runtime)) {
                console.log("REUSED EthMainnetVerifier", reuse);
                return;
            }
            console.log("candidate differs from this build; deploying a new one");
        }

        bytes32 salt = keccak256(bytes(vm.envString("ETH_VERIFIER_SALT")));
        address a = vm.computeCreate2Address(salt, keccak256(init), CREATE2_FACTORY);
        if (a.code.length == 0) {
            vm.startBroadcast(vm.envUint("CLPR_TESTNET_PRIVATE_KEY"));
            (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(salt, init));
            vm.stopBroadcast();
            require(ok && a.code.length > 0, "EthMainnetVerifier: CREATE2 failed");
            console.log("DEPLOYED EthMainnetVerifier", a);
        } else {
            console.log("EXISTS EthMainnetVerifier", a);
        }
        require(a.codehash == keccak256(runtime), "EthMainnetVerifier: runtime code hash mismatch");
        console.log("CODEHASH EthMainnetVerifier");
        console.logBytes32(a.codehash);
    }
}
