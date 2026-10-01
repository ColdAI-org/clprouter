// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Pulls the reference CLPR logic modules into the build so `vm.getCode` (ClprDeployHelper) and the
// e2e deploy script can deploy the unchanged reference ClprService.
import {ChannelLogic} from "@hiero-ledger/clpr/logic/ChannelLogic.sol";
import {MessagingLogic} from "@hiero-ledger/clpr/logic/MessagingLogic.sol";
import {BundleLogic} from "@hiero-ledger/clpr/logic/BundleLogic.sol";
import {ConnectorLogic} from "@hiero-ledger/clpr/logic/ConnectorLogic.sol";
import {AdminLogic} from "@hiero-ledger/clpr/logic/AdminLogic.sol";
import {BundleDecodeHelper} from "@hiero-ledger/clpr/libraries/codec/BundleDecodeHelper.sol";
import {ClprService} from "@hiero-ledger/clpr/ClprService.sol";
import {E2EVerifier} from "@test/E2EVerifier.sol";
import {MockClprConnector} from "@test/mocks/MockClprConnector.sol";
import {BundleEncoderHelper} from "@test/BundleEncoderHelper.sol";
