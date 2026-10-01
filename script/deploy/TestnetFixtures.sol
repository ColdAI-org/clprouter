// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IClprVerifier} from "@hiero-ledger/clpr/interfaces/IClprVerifier.sol";
import {IClprConnector} from "@hiero-ledger/clpr/interfaces/IClprConnector.sol";
import {ClprTypes} from "@hiero-ledger/clpr/libraries/ClprTypes.sol";
import {IClprRouteApplication} from "@clprouter/interfaces/IClprRouteApplication.sol";

/// @title TestOnlyStubVerifier
/// @notice TEST ONLY. INSECURE. Deployed on Sepolia solely so that a CLPR Channel to Hedera testnet can exist
///         there, which `sendMessage` (and therefore the Sepolia → Hedera route) needs.
///
///         - `verifyConfig` returns the Hedera peer configuration fixed by the deployer at construction. Nothing
///           is proven: the peer ledger id, service address and throttles are taken on trust. That is the
///           insecure part, and the reason for the name.
///         - `verifyBundle` ALWAYS reverts. No Hiero state-proof source exists yet (see the README section
///           "Where real Hiero verification stops"), so this verifier accepts no bundle at all: nothing can be
///           delivered to Sepolia over a Channel that uses it, and no CLPR acknowledgement or CLPRouter receipt
///           can come back from Hedera. Routes sent from Sepolia over it end at delivery on Hedera and are
///           settled on Sepolia only by `reclaim` after their deadline.
///
///         Never use this contract on a mainnet or for any Channel that should carry inbound messages.
contract TestOnlyStubVerifier is IClprVerifier {
    error TestOnlyStubVerifierAcceptsNoBundles();

    string public constant WARNING =
        "TEST ONLY, INSECURE: peer config is unproven; verifyBundle always reverts (no Hiero proof source)";

    string public peerChainId;
    bytes public peerServiceAddress;
    uint64 public immutable PEER_MAX_MESSAGES_PER_BUNDLE;
    uint64 public immutable PEER_MAX_PAYLOAD_BYTES;
    uint64 public immutable PEER_MAX_GAS_PER_MESSAGE;
    uint64 public immutable PEER_MAX_QUEUE_DEPTH;
    uint64 public immutable PEER_MAX_SYNC_BYTES;

    constructor(string memory peerChainId_, bytes memory peerServiceAddress_, ClprTypes.Throttles memory t) {
        peerChainId = peerChainId_;
        peerServiceAddress = peerServiceAddress_;
        PEER_MAX_MESSAGES_PER_BUNDLE = t.maxMessagesPerBundle;
        PEER_MAX_PAYLOAD_BYTES = t.maxMessagePayloadBytes;
        PEER_MAX_GAS_PER_MESSAGE = t.maxGasPerMessage;
        PEER_MAX_QUEUE_DEPTH = t.maxQueueDepth;
        PEER_MAX_SYNC_BYTES = t.maxSyncBytes;
    }

    /// @inheritdoc IClprVerifier
    function verifyBundle(bytes calldata, bytes calldata, bytes calldata)
        external
        pure
        returns (
            ClprTypes.QueueMetadata memory,
            bytes[] memory,
            bytes memory,
            bytes memory,
            ClprTypes.ClprEndpointManifest memory
        )
    {
        revert TestOnlyStubVerifierAcceptsNoBundles();
    }

    /// @inheritdoc IClprVerifier
    function verifyConfig(bytes calldata, bytes32 channelId, bytes calldata)
        external
        view
        returns (
            bytes memory channelContext,
            string memory chainId,
            bytes memory serviceAddress,
            uint96 peerConfigNanos,
            ClprTypes.Throttles memory throttles,
            bytes memory initialTrustAnchor,
            bytes memory initialTrustAnchorId,
            ClprTypes.ClprEndpointManifest memory endpointManifest
        )
    {
        serviceAddress = peerServiceAddress;
        channelContext = ClprTypes.encodeChannelContext(
            ClprTypes.ChannelContext({channelId: channelId, remoteServiceAddress: serviceAddress})
        );
        chainId = peerChainId;
        peerConfigNanos = 0;
        throttles = ClprTypes.Throttles({
            maxMessagesPerBundle: uint32(PEER_MAX_MESSAGES_PER_BUNDLE),
            maxMessagePayloadBytes: PEER_MAX_PAYLOAD_BYTES,
            maxGasPerMessage: PEER_MAX_GAS_PER_MESSAGE,
            maxQueueDepth: uint32(PEER_MAX_QUEUE_DEPTH),
            maxSyncBytes: PEER_MAX_SYNC_BYTES,
            maxLocalEndpoints: 0,
            maxPeerEndpoints: 0
        });
        initialTrustAnchor = "";
        initialTrustAnchorId = "";
        endpointManifest.serviceAddress = serviceAddress;
    }
}

/// @title TestnetConnector
/// @notice Minimal CLPR Connector for the testnet deployment. Authorizes outbound messages only when called by the
///         local CLPR Service and only from the one sender the owner allowed (the local ClprRouter, set after the
///         Router is deployed, so this contract's CREATE2 address does not depend on the Router's); pays execution
///         costs only to the Service; the owner can withdraw its balance. Holds no route funds.
contract TestnetConnector is IClprConnector {
    address public immutable SERVICE;
    address public immutable OWNER;
    address public allowedSender;

    error NotService();
    error NotOwner();

    event AllowedSender(address sender);
    event Inbound(bytes32 indexed channelId, uint64 messageId, bytes sender, bytes targetApplication);

    constructor(address service, address owner) {
        SERVICE = service;
        OWNER = owner;
    }

    function setAllowedSender(address sender) external {
        if (msg.sender != OWNER) revert NotOwner();
        allowedSender = sender;
        emit AllowedSender(sender);
    }

    function authorizeOutboundMessage(bytes32, bytes calldata, bytes calldata sender, bytes calldata)
        external
        view
        returns (bool)
    {
        if (msg.sender != SERVICE) revert NotService();
        return allowedSender != address(0) && keccak256(sender) == keccak256(abi.encodePacked(allowedSender));
    }

    function payForExecution(uint256 amount) external {
        if (msg.sender != SERVICE) revert NotService();
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "pay failed");
    }

    function onInboundMessage(
        bytes32 channelId,
        uint64 messageId,
        bytes calldata sender,
        bytes calldata targetApplication,
        bytes calldata
    ) external {
        if (msg.sender != SERVICE) revert NotService();
        emit Inbound(channelId, messageId, sender, targetApplication);
    }

    function withdraw(address payable to, uint256 amount) external {
        if (msg.sender != OWNER) revert NotOwner();
        (bool ok,) = to.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    receive() external payable {}
}

/// @title TestnetRouteApp
/// @notice Destination application for the testnet route: accepts messages only from its (immutable) Router and
///         records them.
contract TestnetRouteApp is IClprRouteApplication {
    struct Delivered {
        bytes16 routeId;
        string originLedger;
        bytes originApplication;
        string sender;
        uint8 payloadType;
        bytes payload;
    }

    address public immutable ROUTER;
    Delivered[] public delivered;

    event RouteMessage(bytes16 indexed routeId, string originLedger, string sender, bytes payload);

    constructor(address router) {
        ROUTER = router;
    }

    function onRouteMessage(
        bytes16 routeId,
        string calldata originLedger,
        bytes calldata originApplication,
        string calldata sender,
        uint8 payloadType,
        bytes calldata payload
    ) external returns (bytes memory) {
        require(msg.sender == ROUTER, "untrusted router");
        delivered.push(Delivered(routeId, originLedger, originApplication, sender, payloadType, payload));
        emit RouteMessage(routeId, originLedger, sender, payload);
        return "ack";
    }

    function onRouteNotice(bytes16, bytes32, string calldata) external view {
        require(msg.sender == ROUTER, "untrusted router");
    }

    function deliveredCount() external view returns (uint256) {
        return delivered.length;
    }
}
