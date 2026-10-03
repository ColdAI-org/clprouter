// SPDX-License-Identifier: MIT
// ABI subsets of the settle contracts and the CLPR Service used by the Connector, taken from the forge
// artefacts (`forge build`, then `out/<Contract>.sol/<Contract>.json`). Only the functions the Connector calls,
// their events and the custom errors are kept. CLPR Service getters are declared `view` so they read with eth_call.

export const ORDER_BOOK_ABI = [
  {
    "type": "function",
    "name": "DOMAIN_SEPARATOR",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "PENALTY_BPS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "bonds",
    "inputs": [
      {
        "name": "connector",
        "type": "address"
      },
      {
        "name": "asset",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "total",
        "type": "uint256"
      },
      {
        "name": "reserved",
        "type": "uint256"
      },
      {
        "name": "pendingWithdraw",
        "type": "uint256"
      },
      {
        "name": "withdrawReadyAt",
        "type": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "cancelOrder",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "cancelWithdraw",
    "inputs": [
      {
        "name": "asset",
        "type": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "claimDefault",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "closeWithRecordedDelivery",
    "inputs": [
      {
        "name": "ledger",
        "type": "bytes32"
      },
      {
        "name": "d",
        "type": "tuple",
        "components": [
          {
            "name": "orderId",
            "type": "bytes32"
          },
          {
            "name": "asset",
            "type": "bytes32"
          },
          {
            "name": "recipient",
            "type": "bytes32"
          },
          {
            "name": "amount",
            "type": "uint256"
          },
          {
            "name": "deliveredAt",
            "type": "uint64"
          },
          {
            "name": "deliverer",
            "type": "bytes32"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "connectors",
    "inputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "signer",
        "type": "address"
      },
      {
        "name": "prevSigner",
        "type": "address"
      },
      {
        "name": "rotatedAt",
        "type": "uint64"
      },
      {
        "name": "registeredAt",
        "type": "uint64"
      },
      {
        "name": "shortfalls",
        "type": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "deliveryHash",
    "inputs": [
      {
        "name": "ledger",
        "type": "bytes32"
      },
      {
        "name": "d",
        "type": "tuple",
        "components": [
          {
            "name": "orderId",
            "type": "bytes32"
          },
          {
            "name": "asset",
            "type": "bytes32"
          },
          {
            "name": "recipient",
            "type": "bytes32"
          },
          {
            "name": "amount",
            "type": "uint256"
          },
          {
            "name": "deliveredAt",
            "type": "uint64"
          },
          {
            "name": "deliverer",
            "type": "bytes32"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "deliverySeen",
    "inputs": [
      {
        "name": "",
        "type": "bytes32"
      },
      {
        "name": "",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "executeWithdraw",
    "inputs": [
      {
        "name": "asset",
        "type": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "freeCapacity",
    "inputs": [
      {
        "name": "connector",
        "type": "address"
      },
      {
        "name": "asset",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isCoverAsset",
    "inputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "orders",
    "inputs": [
      {
        "name": "orderId",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "connector",
        "type": "address"
      },
      {
        "name": "status",
        "type": "uint8"
      },
      {
        "name": "deadline",
        "type": "uint64"
      },
      {
        "name": "coverAsset",
        "type": "address"
      },
      {
        "name": "openedAt",
        "type": "uint64"
      },
      {
        "name": "refundTo",
        "type": "address"
      },
      {
        "name": "dstLedger",
        "type": "bytes32"
      },
      {
        "name": "assetOut",
        "type": "bytes32"
      },
      {
        "name": "recipient",
        "type": "bytes32"
      },
      {
        "name": "amountOut",
        "type": "uint256"
      },
      {
        "name": "owedOnDefault",
        "type": "uint256"
      },
      {
        "name": "reserved",
        "type": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owedFor",
    "inputs": [
      {
        "name": "coverAmount",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "postBond",
    "inputs": [
      {
        "name": "asset",
        "type": "address"
      },
      {
        "name": "amount",
        "type": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "register",
    "inputs": [
      {
        "name": "signer",
        "type": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "requestWithdraw",
    "inputs": [
      {
        "name": "asset",
        "type": "address"
      },
      {
        "name": "amount",
        "type": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "BondPosted",
    "inputs": [
      {
        "name": "connector",
        "type": "address",
        "indexed": true
      },
      {
        "name": "asset",
        "type": "address",
        "indexed": true
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "total",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ConnectorRegistered",
    "inputs": [
      {
        "name": "connector",
        "type": "address",
        "indexed": true
      },
      {
        "name": "signer",
        "type": "address",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DeliveryRecorded",
    "inputs": [
      {
        "name": "orderId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "deliveryHash",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "ledger",
        "type": "bytes32",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderCancelled",
    "inputs": [
      {
        "name": "orderId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "refundTo",
        "type": "address",
        "indexed": true
      },
      {
        "name": "asset",
        "type": "address",
        "indexed": false
      },
      {
        "name": "paid",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderDefaulted",
    "inputs": [
      {
        "name": "orderId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "refundTo",
        "type": "address",
        "indexed": true
      },
      {
        "name": "asset",
        "type": "address",
        "indexed": false
      },
      {
        "name": "paid",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderDelivered",
    "inputs": [
      {
        "name": "orderId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "deliveryHash",
        "type": "bytes32",
        "indexed": false
      },
      {
        "name": "deliveredAt",
        "type": "uint64",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderOpened",
    "inputs": [
      {
        "name": "orderId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "connector",
        "type": "address",
        "indexed": true
      },
      {
        "name": "refundTo",
        "type": "address",
        "indexed": true
      },
      {
        "name": "srcLedger",
        "type": "bytes32",
        "indexed": false
      },
      {
        "name": "dstLedger",
        "type": "bytes32",
        "indexed": false
      },
      {
        "name": "coverAsset",
        "type": "address",
        "indexed": false
      },
      {
        "name": "owedOnDefault",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "reserved",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "deadline",
        "type": "uint64",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderRejected",
    "inputs": [
      {
        "name": "orderId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "connector",
        "type": "address",
        "indexed": true
      },
      {
        "name": "reason",
        "type": "uint8",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyRegistered",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadParams",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DeadlineNotPassed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InsufficientFree",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoProver",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotConnector",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotCoverAsset",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotMatching",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotOpen",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotRegistered",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingPending",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OnlyAdmin",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OnlyService",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PaymentMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PaymentReplayed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RotationTooSoon",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "SourceExists",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TransferFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnauthorizedSender",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownDelivery",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownSource",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnsupportedMessage",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WithdrawNotReady",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongValue",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroSigner",
    "inputs": []
  }
] as const;

export const DEPOSIT_ABI = [
  {
    "type": "function",
    "name": "DOMAIN_SEPARATOR",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "LEDGER",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ORDER_BOOK",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "deposit",
    "inputs": [
      {
        "name": "q",
        "type": "tuple",
        "components": [
          {
            "name": "connector",
            "type": "address"
          },
          {
            "name": "srcLedger",
            "type": "bytes32"
          },
          {
            "name": "depositApp",
            "type": "bytes32"
          },
          {
            "name": "user",
            "type": "bytes32"
          },
          {
            "name": "payTo",
            "type": "bytes32"
          },
          {
            "name": "assetIn",
            "type": "bytes32"
          },
          {
            "name": "amountIn",
            "type": "uint256"
          },
          {
            "name": "dstLedger",
            "type": "bytes32"
          },
          {
            "name": "assetOut",
            "type": "bytes32"
          },
          {
            "name": "recipient",
            "type": "bytes32"
          },
          {
            "name": "amountOut",
            "type": "uint256"
          },
          {
            "name": "coverAsset",
            "type": "address"
          },
          {
            "name": "coverAmount",
            "type": "uint256"
          },
          {
            "name": "refundTo",
            "type": "address"
          },
          {
            "name": "issuedAt",
            "type": "uint64"
          },
          {
            "name": "expiry",
            "type": "uint64"
          },
          {
            "name": "deadline",
            "type": "uint64"
          },
          {
            "name": "salt",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "sig",
        "type": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "orderId",
        "type": "bytes32"
      },
      {
        "name": "messageId",
        "type": "uint64"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "orderIdOf",
    "inputs": [
      {
        "name": "q",
        "type": "tuple",
        "components": [
          {
            "name": "connector",
            "type": "address"
          },
          {
            "name": "srcLedger",
            "type": "bytes32"
          },
          {
            "name": "depositApp",
            "type": "bytes32"
          },
          {
            "name": "user",
            "type": "bytes32"
          },
          {
            "name": "payTo",
            "type": "bytes32"
          },
          {
            "name": "assetIn",
            "type": "bytes32"
          },
          {
            "name": "amountIn",
            "type": "uint256"
          },
          {
            "name": "dstLedger",
            "type": "bytes32"
          },
          {
            "name": "assetOut",
            "type": "bytes32"
          },
          {
            "name": "recipient",
            "type": "bytes32"
          },
          {
            "name": "amountOut",
            "type": "uint256"
          },
          {
            "name": "coverAsset",
            "type": "address"
          },
          {
            "name": "coverAmount",
            "type": "uint256"
          },
          {
            "name": "refundTo",
            "type": "address"
          },
          {
            "name": "issuedAt",
            "type": "uint64"
          },
          {
            "name": "expiry",
            "type": "uint64"
          },
          {
            "name": "deadline",
            "type": "uint64"
          },
          {
            "name": "salt",
            "type": "bytes32"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "used",
    "inputs": [
      {
        "name": "",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "Deposited",
    "inputs": [
      {
        "name": "orderId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "connector",
        "type": "address",
        "indexed": true
      },
      {
        "name": "user",
        "type": "address",
        "indexed": true
      },
      {
        "name": "signer",
        "type": "address",
        "indexed": false
      },
      {
        "name": "assetIn",
        "type": "bytes32",
        "indexed": false
      },
      {
        "name": "amountIn",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "payTo",
        "type": "bytes32",
        "indexed": false
      },
      {
        "name": "messageId",
        "type": "uint64",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AmountMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadTimes",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAnAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotQuoteUser",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PaymentFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "QuoteExpired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "QuoteUsed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "WrongDepositApp",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongLedger",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongValue",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  }
] as const;

export const DELIVERY_ABI = [
  {
    "type": "function",
    "name": "ORDER_BOOK",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "deliver",
    "inputs": [
      {
        "name": "orderId",
        "type": "bytes32"
      },
      {
        "name": "asset",
        "type": "address"
      },
      {
        "name": "recipient",
        "type": "address"
      },
      {
        "name": "amount",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "messageId",
        "type": "uint64"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "event",
    "name": "Delivered",
    "inputs": [
      {
        "name": "orderId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "deliverer",
        "type": "address",
        "indexed": true
      },
      {
        "name": "recipient",
        "type": "address",
        "indexed": true
      },
      {
        "name": "asset",
        "type": "address",
        "indexed": false
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "messageId",
        "type": "uint64",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "PaymentFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "WrongValue",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroRecipient",
    "inputs": []
  }
] as const;

export const CLPR_SERVICE_ABI = [
  {
    "type": "function",
    "name": "getChannel",
    "inputs": [
      {
        "name": "channelId",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "components": [
          {
            "name": "channelId",
            "type": "bytes32"
          },
          {
            "name": "verifier",
            "type": "address"
          },
          {
            "name": "status",
            "type": "uint8"
          },
          {
            "name": "nextMessageId",
            "type": "uint64"
          },
          {
            "name": "ackedMessageId",
            "type": "uint64"
          },
          {
            "name": "receivedMessageId",
            "type": "uint64"
          },
          {
            "name": "nextExpectedReplyId",
            "type": "uint64"
          },
          {
            "name": "peerConfigTimestamp",
            "type": "uint96"
          },
          {
            "name": "lastConfigTimestamp",
            "type": "uint96"
          },
          {
            "name": "sentRunningHash",
            "type": "bytes32"
          },
          {
            "name": "receivedRunningHash",
            "type": "bytes32"
          },
          {
            "name": "ownershipCommitment",
            "type": "bytes32"
          },
          {
            "name": "salt",
            "type": "bytes32"
          },
          {
            "name": "chainId",
            "type": "string"
          },
          {
            "name": "peerServiceAddress",
            "type": "bytes"
          },
          {
            "name": "peerThrottles",
            "type": "tuple",
            "components": [
              {
                "name": "maxMessagesPerBundle",
                "type": "uint32"
              },
              {
                "name": "maxMessagePayloadBytes",
                "type": "uint64"
              },
              {
                "name": "maxGasPerMessage",
                "type": "uint64"
              },
              {
                "name": "maxQueueDepth",
                "type": "uint32"
              },
              {
                "name": "maxSyncBytes",
                "type": "uint64"
              },
              {
                "name": "maxLocalEndpoints",
                "type": "uint32"
              },
              {
                "name": "maxPeerEndpoints",
                "type": "uint32"
              }
            ]
          },
          {
            "name": "trustAnchor",
            "type": "bytes"
          },
          {
            "name": "lastDataMessageId",
            "type": "uint64"
          },
          {
            "name": "trustAnchorId",
            "type": "bytes"
          },
          {
            "name": "channelContext",
            "type": "bytes"
          },
          {
            "name": "endpointManifestVersion",
            "type": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getMessage",
    "inputs": [
      {
        "name": "channelId",
        "type": "bytes32"
      },
      {
        "name": "messageId",
        "type": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "components": [
          {
            "name": "payload",
            "type": "bytes"
          },
          {
            "name": "runningHashAfterProcessing",
            "type": "bytes32"
          },
          {
            "name": "connectorIdForReply",
            "type": "bytes32"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "submitBundle",
    "inputs": [
      {
        "name": "channelId",
        "type": "bytes32"
      },
      {
        "name": "proofBytes",
        "type": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  }
] as const;

export const BUNDLE_ENCODER_ABI = [
  {
    "type": "function",
    "name": "encode",
    "stateMutability": "pure",
    "inputs": [
      {
        "name": "metadata",
        "type": "tuple",
        "components": [
          {
            "name": "nextMessageId",
            "type": "uint64"
          },
          {
            "name": "sentRunningHash",
            "type": "bytes32"
          },
          {
            "name": "receivedMessageId",
            "type": "uint64"
          },
          {
            "name": "receivedRunningHash",
            "type": "bytes32"
          },
          {
            "name": "state",
            "type": "uint8"
          },
          {
            "name": "endpointManifestVersion",
            "type": "uint64"
          }
        ]
      },
      {
        "name": "messagePayloads",
        "type": "bytes[]"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes"
      }
    ]
  }
] as const;

export const ERC20_ABI = [
  {
    "type": "function",
    "name": "balanceOf",
    "stateMutability": "view",
    "inputs": [
      {
        "name": "a",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "allowance",
    "stateMutability": "view",
    "inputs": [
      {
        "name": "o",
        "type": "address"
      },
      {
        "name": "s",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "approve",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "name": "s",
        "type": "address"
      },
      {
        "name": "v",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ]
  }
] as const;
