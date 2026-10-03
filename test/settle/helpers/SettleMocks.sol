// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ISettlePaymentProver} from "@clprouter/settle/interfaces/ISettlePaymentProver.sol";

/// @notice ERC-20 with configurable decimals (USDC-like, or the ERC-20 facade of an HTS token in tests).
contract MockToken is ERC20 {
    uint8 internal immutable DEC;

    constructor(string memory name_, uint8 dec) ERC20(name_, name_) {
        DEC = dec;
    }

    function decimals() public view override returns (uint8) {
        return DEC;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Takes 1% of every transfer (fee-on-transfer token).
contract FeeToken is MockToken {
    constructor() MockToken("FEE", 18) {}

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xdead), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// @notice A token whose transfers to `blocked` fail (an HTS token the recipient is not associated with).
contract BlockingToken is MockToken {
    mapping(address => bool) public blocked;

    constructor() MockToken("USDC", 6) {}

    function setBlocked(address a, bool b) external {
        blocked[a] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "not associated");
        super._update(from, to, value);
    }
}

/// @notice Records `sendMessage` calls (stands in for a chain's ClprService in Deposit / Delivery unit tests).
contract MockSendService {
    struct Sent {
        bytes32 channelId;
        bytes32 connectorId;
        bytes target;
        bytes data;
        address sender;
    }

    Sent[] internal _sent;
    bool public fail;

    function setFail(bool f) external {
        fail = f;
    }

    function sendMessage(bytes32 channelId, bytes32 connectorId, bytes calldata target, bytes calldata data)
        external
        returns (uint64)
    {
        require(!fail, "send failed");
        _sent.push(Sent(channelId, connectorId, target, data, msg.sender));
        return uint64(_sent.length);
    }

    function count() external view returns (uint256) {
        return _sent.length;
    }

    function last() external view returns (Sent memory) {
        return _sent[_sent.length - 1];
    }
}

/// @notice A receiver that rejects native value.
contract Rejecter {
    receive() external payable {
        revert("no");
    }
}

/// @notice A receiver that burns more than the order book's push stipend.
contract GasHog {
    uint256 public n;

    receive() external payable {
        for (uint256 i = 0; i < 100; i++) {
            n += i;
        }
    }
}

/// @notice TEST ONLY payment prover: returns whatever payment the test registered for a proof blob. A real prover
///         checks the payment against its chain's finality and inclusion rules.
contract TestPaymentProver is ISettlePaymentProver {
    mapping(bytes32 => Payment) internal _p;

    function set(bytes calldata proof, Payment calldata p) external {
        _p[keccak256(proof)] = p;
    }

    function provePayment(bytes calldata proof) external view returns (Payment memory p) {
        p = _p[keccak256(proof)];
        require(p.ledger != bytes32(0), "unproven");
    }
}
