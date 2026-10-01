# Testnet deployments

CLPRouter on two public testnets, Ethereum Sepolia (`eip155:11155111`) and Hedera testnet (`eip155:296`),
next to the reference CLPR Service that is deployed at the same address on both
(`0xa6db474e3047c3d43b10a4ff7abad547d89982b9`). The planned route, Sepolia → Hedera verified on Hedera by the CLPR
repo's `EthMainnetVerifier` (a sync-committee light client), has **not** run yet: the Hedera half of its Channel could
not be opened (see Result). This file is the narrative; the
machine-readable record, with every address, code hash, transaction hash, gas figure and cost, is in
[`sepolia.json`](sepolia.json) and [`hedera-testnet.json`](hedera-testnet.json).

**Testnet only.** The provider committee is a TEST committee of throwaway keys ([`test-committee.json`](test-committee.json),
public addresses only; the private keys never leave a git-excluded local file). The Sepolia side of the Channel uses
`TestOnlyStubVerifier`, which is insecure by design and accepts no bundles (see below).

**Status: pre-audit (re-audit in progress).** Deployed from `e74a3f4` (registry/vault fixes RV-01..RV-10, Router and
codec fixes). Do not route value through it.

## Result

| | Sepolia | Hedera testnet |
| --- | --- | --- |
| CLPR Service bring-up (`initialize`, `setClprEnabled`) | done | done |
| CLPRouter stack (registry, vault, deployer, canonical Router, 5 libraries) | deployed, checks passed | deployed, checks passed |
| Sources | verified on Sourcify (all 11) | verified on Sourcify / HashScan (all 11) |
| Channel `0x8a15fe9f…4145e0` | open, `TestOnlyStubVerifier` | **not open**: `completeChannel` fails, see below |
| Connector `0xed6c8cc0…51d3` | registered | not registered (needs the Channel) |
| Route Sepolia → Hedera | **not sent** | — |
| Spent | 0.024528180281146720 ETH (balance 0.032949 → 0.008421) | 53.08606479 HBAR (balance 575.743 → 522.657) |

**The route did not run.** The Hedera half of the Channel needs `completeChannel` with the EthMainnetVerifier
bootstrap config: the 512 Sepolia sync-committee keys as uncompressed EIP-2537 points, 67,365 bytes of calldata. On
Hedera testnet that transaction ends `INSUFFICIENT_GAS` at every gas limit tried (5.6M, 12.9M, 6M, 6M, 15M; through
the JSON-RPC relay and through the Hedera SDK with a 21 HBAR max fee), always with 4,062,470 gas reported used and
about 9.62 HBAR charged. The same call succeeds in the relay's `eth_estimateGas` (4,404,267) and on an anvil fork of
Hedera testnet (4,062,470 gas), which points to a consensus-side rule for jumbo transactions of this size rather than
to the contracts; that is not confirmed. The run stopped after five attempts (about 48 HBAR in fees). Without that Channel a Sepolia message can never be
delivered, so `Router.send` was not broadcast. Options: find the Hedera rule (or a node or relay setting) that rejects
the transaction; bootstrap the EthMainnetVerifier Channel in two smaller transactions (needs a CLPR change, out of
scope here); or route over a Channel whose bootstrap is small.

The receipt direction (Hedera → Sepolia) has no real proof source in any case. The Sepolia Channel uses
`TestOnlyStubVerifier` (`script/deploy/TestnetFixtures.sol`): **TEST ONLY, INSECURE as a config source** (the Hedera
peer configuration is set by the deployer, not proven) and it **never accepts a bundle** (`verifyBundle` always
reverts). A route sent from Sepolia would end at delivery on Hedera and settle on Sepolia only through `reclaim`.

### Addresses

Same address on both networks (canonical CREATE2 inputs through the deterministic-deployment proxy
`0x4e59b44847b379578588920ca78fbf26c0b4956c`):

| Contract | Address |
| --- | --- |
| ProviderRegistry (deployment id `0xdf6da137810aa7d046c74d408bd42bd5e9e5407469a5e36530ce5d250fa1a0a7`) | `0x6D8a65a9E85C423ACe3E0C4074508a9AcD63958c` |
| QuarantineVault | `0x6f7756640C2cf1db14d2789F33966D0eB0960b4a` |
| ClprRouterDeployer | `0xAb349c0D13f1d46ca5e16C3c1bf7211abBf9b29E` |
| RouteCodec / RouteLogic / RouteOrigin / RouteReceipts / RouteSettlement | `0xF51eD266068C956D7fCDB2a21B89a1ECd68d7b62` / `0x2Ca8e2aFeAAea07b9FD5Df60d44D0606169a8d50` / `0x295C624f75D1DA951e3aDF6d6580160810f17e17` / `0xd7A3F6FB49d171f755043EcCb01bcd4e69B02a38` / `0xc6ab1ED6A833Df9fBfe213f6e52aecA6734632A4` |
| TestnetConnector | `0xe8cb0088BBDf16F256F854485B34117412992816` |
| ClprRouter, Sepolia (`eip155:11155111`) | `0x3Ec8a28f6AD20FE1070819f56B29be120700A653` |
| ClprRouter, Hedera testnet (`eip155:296`) | `0xF398F961088af7aF74bff8fc409a535023913E5F` |
| TestOnlyStubVerifier (Sepolia only) | `0xad0216795c8d30E510c6B7Cc61621A52bA36aE7A` |
| TestnetRouteApp (Hedera only) | `0xDbB0EbcBf8fa0cE4886fbe8Ae0C24C6D68B8bC69` |
| EthMainnetVerifier (Hedera, reused, byte-identical to the submodule build) | `0x92646d66a66e93411d6f679f4b4befebdb3371bd` |

Router init-code hash `0x4999057976d9a9a644ccd2820d40383bb3e46fdfec7a5d71197a4010ee699459` (no constructor arguments; per-ledger parameters come from the
deployer). Router parameters: `RECLAIM_GRACE` 3600 s, `APP_GAS` 300,000, `MIN_SEND_GAS` 1,500,000 (gas that must be
left before a hop calls `sendMessage`; below it a permissionless `forward` reverts and a send inside delivery stays
pending, so nobody can fail a hop by under-funding the transaction; 1.5M is above the largest `sendMessage` leg
measured in the e2e runs). Registry: TEST committee, k = 3 of 5, notices 7 d / 72 h / 7 d, lapses 7 d / 30 d,
committee notice 7 d. Vault: recovery notice 72 h, challenge window 7 d. Optimizer: solc 0.8.30, via-IR, 200 runs
(the deploy scripts' compile unit includes ClprRouter, so it uses the `small` profile), `osaka`, no CBOR metadata.

### Transactions

Gas is the receipt's `gasUsed`. Cost on Sepolia is `gasUsed × effectiveGasPrice`; on Hedera it is the mirror node's
`charged_tx_fee`. The Hedera per-transaction fees add up to 65.74323054 HBAR, more than the balance difference
(53.08606479 HBAR), which is the figure to trust; the cause of the gap was not established.

| Network | Step | Contract / call | Tx | Gas | Cost | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Sepolia | init-sepolia | ClprService initialize | [`0xd28ab8705c…`](https://sepolia.etherscan.io/tx/0xd28ab8705c4555cb341443484fd79d9bd41133f22c986cfafedda6f11f92d637) | 267,304 | 0.000268004 ETH | success |
| Sepolia | init-sepolia | ClprService setClprEnabled | [`0x17b1436337…`](https://sepolia.etherscan.io/tx/0x17b1436337eff5ac75b1e108f99624838640b8938fec328bb8c05db7dcb67af7) | 35,049 | 0.000038114 ETH | success |
| Sepolia | fixtures-sepolia | TestnetConnector (CREATE2) | [`0xef6fc56ca6…`](https://sepolia.etherscan.io/tx/0xef6fc56ca6fe5c4dc1071be5b418662e5da607e4f256e0c619edc033c186a1c4) | 400,767 | 0.000443877 ETH | success |
| Sepolia | fixtures-sepolia | TestOnlyStubVerifier (CREATE2) | [`0xbbcdb95dac…`](https://sepolia.etherscan.io/tx/0xbbcdb95dac143352481b460b2339ae5eba28bee91300c7ad9a90e320b4f7d80a) | 665,017 | 0.000708037 ETH | success |
| Sepolia | channel-sepolia | ClprService registerChannel | [`0x200d45d0bc…`](https://sepolia.etherscan.io/tx/0x200d45d0bcc3282d4cd9e0f5fabb57cecdfef58680cc77e22635c6d112debdaf) | 75,502 | 0.000081722 ETH | success |
| Sepolia | channel-sepolia | ClprService completeChannel | [`0x381a6fc937…`](https://sepolia.etherscan.io/tx/0x381a6fc937d6eeae1d57818aeebc404358674d970c6d3abdf453c51d8d0734b6) | 418,526 | 0.000455450 ETH | success |
| Sepolia | connector-sepolia | ClprService registerConnector | [`0xbbb0c1d052…`](https://sepolia.etherscan.io/tx/0xbbb0c1d05224daf219b11f61b1943b0f4a354dcfe84481ddd53b9a823101f4b1) | 51,920 | 0.000056664 ETH | success |
| Sepolia | connector-sepolia | ClprService completeConnector | [`0x81af640ad2…`](https://sepolia.etherscan.io/tx/0x81af640ad2669d3449cb0bab1f7bfd40c8264f5ca13212660024e11d26974150) | 197,646 | 0.000713895 ETH | success |
| Sepolia | deploy-router | RouteCodec (CREATE2) | [`0xef7916bcf8…`](https://sepolia.etherscan.io/tx/0xef7916bcf8eadd2303b859ba4ed71ae63a00d67e860b6499a53ba6b7337f16ce) | 2,283,175 | 0.002307100 ETH | success |
| Sepolia | deploy-router | RouteLogic (CREATE2) | [`0x89514d4f5f…`](https://sepolia.etherscan.io/tx/0x89514d4f5fcf84105bc243d86fd446a257b713d724ccd939a0d1aceee48478a2) | 3,381,070 | 0.003607193 ETH | success |
| Sepolia | deploy-router | RouteSettlement (CREATE2) | [`0x5bc0544d60…`](https://sepolia.etherscan.io/tx/0x5bc0544d60481125bd3bdca3534c22bc3669ff65ade4e1a16d383ab5cc81e1fd) | 1,706,137 | 0.001794772 ETH | success |
| Sepolia | deploy-router | RouteOrigin (CREATE2) | [`0x1f7ad3bfae…`](https://sepolia.etherscan.io/tx/0x1f7ad3bfae453a7632ad553ed8021ab0f72c492823bb8c196f0bac27ebcb7ef8) | 1,444,227 | 0.001590873 ETH | success |
| Sepolia | deploy-router | RouteReceipts (CREATE2) | [`0x995630de5e…`](https://sepolia.etherscan.io/tx/0x995630de5e56402fd4790d81572db44ac59b54f94ec6abcf1e3a41557d7b1da8) | 1,225,078 | 0.001368390 ETH | success |
| Sepolia | deploy-router | ProviderRegistry (CREATE2) | [`0x153db661da…`](https://sepolia.etherscan.io/tx/0x153db661daa6891dcb1d1030eb3a5ab3605192dab847c6592041f1b50c2cdeee) | 3,456,786 | 0.003632669 ETH | success |
| Sepolia | deploy-router | QuarantineVault (CREATE2) | [`0x7820f24984…`](https://sepolia.etherscan.io/tx/0x7820f24984697fa40f4f21e820b30a90268506305edd1757cfffad2bb91b1970) | 1,524,548 | 0.001561778 ETH | success |
| Sepolia | deploy-router | ClprRouterDeployer (CREATE2) | [`0x884e3eb485…`](https://sepolia.etherscan.io/tx/0x884e3eb48574f75f567b2afb0cd884ee8ce5324ec8e19f20ff1d83cff00a772c) | 583,066 | 0.000626212 ETH | success |
| Sepolia | deploy-router | ClprRouterDeployer deploy | [`0x9bb34fe0a1…`](https://sepolia.etherscan.io/tx/0x9bb34fe0a1a782c6c1eb4035cc8e388c340aa3fea615016746a5c7e51324adaa) | 5,021,426 | 0.005226875 ETH | success |
| Sepolia | route-fixtures-sepolia | TestnetConnector setAllowedSender | [`0x97987f6ee6…`](https://sepolia.etherscan.io/tx/0x97987f6ee65d4ab02fa35cdd1944919b275077c1ba5407a41e4d8c33ef957724) | 44,865 | 0.000046557 ETH | success |
| Hedera testnet | init-hedera | ClprService initialize | [`0xdb4ca39331…`](https://hashscan.io/testnet/transaction/0xdb4ca39331da066de3b4906d30a0a8c56ac330eb01ce23212b0e4bd7ceb89a29) | 207,412 | 0.16592960 HBAR | success |
| Hedera testnet | init-hedera | ClprService setClprEnabled | [`0x341f23a8ec…`](https://hashscan.io/testnet/transaction/0x341f23a8ec809413626464a2783ce130faf38c5959402b3de3ccda614683e492) | 35,049 | 0.02803920 HBAR | success |
| Hedera testnet | fixtures-hedera | TestnetConnector (CREATE2) | [`0xfeac952c66…`](https://hashscan.io/testnet/transaction/0xfeac952c667ea15a1aa00278527cb9990e1e452f84b63dd810c477a3044bda88) | 400,767 | 0.32061360 HBAR | success |
| Hedera testnet | deploy-router | RouteCodec (CREATE2) | [`0xf7bb38cf2b…`](https://hashscan.io/testnet/transaction/0xf7bb38cf2b70f69d531098544a4ea962ec7f41534e98440782221711c1cb6868) | 2,283,175 | 1.82654000 HBAR | success |
| Hedera testnet | deploy-router | RouteLogic (CREATE2) | [`0x497adb5731…`](https://hashscan.io/testnet/transaction/0x497adb5731b55af1c8a4a7138132d10577c14171d8db0621227481ac73f73580) | 3,381,070 | 2.70485600 HBAR | success |
| Hedera testnet | deploy-router | RouteSettlement (CREATE2) | [`0x38b242e64d…`](https://hashscan.io/testnet/transaction/0x38b242e64d34889af60c0c3d50e6a18d39e9bc41c96dd21ae8af901e8f4be44d) | 1,706,137 | 1.36490960 HBAR | success |
| Hedera testnet | deploy-router | RouteOrigin (CREATE2) | [`0xf1ecdbf465…`](https://hashscan.io/testnet/transaction/0xf1ecdbf465c52c45b0ebd11657d12e36f2bc670cb272ec8456b83af096766ded) | 1,444,227 | 1.15538160 HBAR | success |
| Hedera testnet | deploy-router | RouteReceipts (CREATE2) | [`0x7ba666c766…`](https://hashscan.io/testnet/transaction/0x7ba666c76625d9890f49264cfd2b7e579fb2b6e95d13337de927851cdad287c3) | 1,225,078 | 0.98006240 HBAR | success |
| Hedera testnet | deploy-router | ProviderRegistry (CREATE2) | [`0x14b168ef2f…`](https://hashscan.io/testnet/transaction/0x14b168ef2ffaffd457ebe131a5d0eb233d40ea36dc143d68d1d491dd7078b010) | 3,456,786 | 2.76542880 HBAR | success |
| Hedera testnet | deploy-router | QuarantineVault (CREATE2) | [`0xe732e770e9…`](https://hashscan.io/testnet/transaction/0xe732e770e92fd5750042e6d6741b832632ce0629ad139089bd435aaf5c4287c9) | 1,524,548 | 1.21963840 HBAR | success |
| Hedera testnet | deploy-router | ClprRouterDeployer (CREATE2) | [`0x0d2fa693e6…`](https://hashscan.io/testnet/transaction/0x0d2fa693e6fa03601e3a5c5cd50a3083138dd42bbb31af9c390037d6eb9700d4) | 583,066 | 0.46645280 HBAR | success |
| Hedera testnet | deploy-router | ClprRouterDeployer deploy | [`0xb36e281bd7…`](https://hashscan.io/testnet/transaction/0xb36e281bd777d16965efd362fcd92e8639ee8e0765e02625a95fcd20ad6cdae2) | 5,019,811 | 4.01584880 HBAR | success |
| Hedera testnet | route-fixtures-hedera | TestnetRouteApp (CREATE2) | [`0x48b2fc6710…`](https://hashscan.io/testnet/transaction/0x48b2fc6710c8f25436a1057f1453b3590efd8f761faa740f86e060494ea45b50) | 632,279 | 0.50582320 HBAR | success |
| Hedera testnet | route-fixtures-hedera | TestnetConnector setAllowedSender | [`0x1d2469137c…`](https://hashscan.io/testnet/transaction/0x1d2469137cd21cb3bfc0f39f5d18bcea7f2fe5961a67bb4ca1821fd1f1970eec) | 44,877 | 0.03590160 HBAR | success |
| Hedera testnet | channel-hedera | ClprService registerChannel | [`0x86303b9e5e…`](https://hashscan.io/testnet/transaction/0x86303b9e5e72039728a19d8fa2f142f34c355c9b01811735d3216a4a0f957b6a) | 75,502 | 0.06115662 HBAR | success |
| Hedera testnet | channel-hedera-failed-attempt | ClprService completeChannel | [`0x6f0285ff22…`](https://hashscan.io/testnet/transaction/0x6f0285ff22c877035165e025a01350fc7077fffe8bbb2a0f9d7fbebaed99781e) | 4,062,470 | 9.61923130 HBAR | failed (INSUFFICIENT_GAS) |
| Hedera testnet | channel-hedera-failed-attempt | ClprService completeChannel | [`0x7dc546cdba…`](https://hashscan.io/testnet/transaction/0x7dc546cdba0c66c0c0a5bb18014c60786071c69045489a4a2e8256826542cdf3) | 4,062,470 | 9.61989948 HBAR | failed (INSUFFICIENT_GAS) |
| Hedera testnet | channel-hedera-failed-attempt | ClprService completeChannel | [`0xa289c0b9ce…`](https://hashscan.io/testnet/transaction/0xa289c0b9ce2665fea2bceab8ad87c2a8ca21031b2d4a243a5f5c610e3379d0c7) | 4,062,470 | 9.61980403 HBAR | failed (INSUFFICIENT_GAS) |
| Hedera testnet | channel-hedera-failed-attempt | ClprService completeChannel | [`0xed92841b6b…`](https://hashscan.io/testnet/transaction/0xed92841b6bae53ef5da7c25d9f0412a1d397decbe6a2709f6d07292c46efec90) | 4,062,470 | 9.61980403 HBAR | failed (INSUFFICIENT_GAS) |
| Hedera testnet | channel-hedera-failed-attempt | ClprService completeChannel | [`0x4b95f023fc…`](https://hashscan.io/testnet/transaction/0x4b95f023fca443c71c9ed892be2dcd2aaf4ee247f819a7b91ff74c11b86d9643) | 4,062,470 | 9.61913585 HBAR | failed (INSUFFICIENT_GAS) |
| Hedera testnet | channel-hedera-retry | ClprService registerChannel | [`0xfd77962e7d…`](https://hashscan.io/testnet/transaction/0xfd77962e7d3001d384cf821f5690e69ee9d0fb7efd016ea4bc353ee1666106f4) | 35,523 | 0.02877363 HBAR | success |


## How to reproduce

Requirements: Foundry 1.5.1, Node 22+, `~/clpr/.env` with `CLPR_TESTNET_PRIVATE_KEY`, `CLPR_TESTNET_ADDRESS`,
`SEPOLIA_RPC_URL` (must serve `eth_getProof` for recent blocks), `HEDERA_TESTNET_RPC_URL`,
`HEDERA_TESTNET_MIRROR_URL` and optionally `SEPOLIA_BEACON_URL` (`CLPR_ENV_FILE` points elsewhere). The throwaway
Channel and Connector keys are read from `deployments/.local/testnet-keys.secret.json` (git-excluded; generate your
own with `cast wallet new --number 7 --json` and the layout in `script/deploy/route.sh`).

```sh
cd script/deploy && npm ci && cd ../..

# CLPR Service bring-up and the Router-independent half of the Channel
script/deploy/route.sh init-sepolia --broadcast       # initialize + enable the Service (owner, once)
script/deploy/route.sh fixtures-sepolia --broadcast   # TestnetConnector, TestOnlyStubVerifier
script/deploy/route.sh channel-sepolia --broadcast
script/deploy/route.sh connector-sepolia --broadcast
script/deploy/route.sh init-hedera --broadcast
script/deploy/route.sh fixtures-hedera --broadcast    # TestnetConnector
script/deploy/route.sh eth-verifier --broadcast       # reuse the byte-identical EthMainnetVerifier, or deploy it

# CLPRouter: registry, vault, deployer, canonical Router (simulate first by leaving out --broadcast)
script/deploy/deploy.sh sepolia --broadcast
script/deploy/deploy.sh hedera-testnet --broadcast
script/deploy/route.sh route-fixtures-sepolia --broadcast   # allow the Router on the Connector
script/deploy/route.sh route-fixtures-hedera --broadcast    # same, plus the destination app

# Just in time (same Sepolia sync-committee period, about 27 h):
script/deploy/route.sh channel-hedera --broadcast     # Channel on Hedera with the current Sepolia committee
script/deploy/route.sh connector-hedera --broadcast
script/deploy/route.sh send --broadcast               # Router.send on Sepolia
script/deploy/route.sh deliver --broadcast            # wait for a signed header, build and submit the proof
script/deploy/route.sh status-sepolia; script/deploy/route.sh status-hedera
```

Every step is idempotent (whatever exists on-chain is skipped and re-checked), broadcasts to one chain, refuses to
run once the recorded spend reaches the budget (`BUDGET_HBAR`, default 150; `BUDGET_ETH`, default 0.5), and appends
its transactions to `deployments/<network>.json` (`script/deploy/record.mjs`). Without `--broadcast` a step only
simulates against a fork of the live chain. `DEPLOYMENTS_DIR` and `CLPR_ENV_FILE` redirect a full rehearsal to two
local anvil forks.

## Files

| Path | What |
| --- | --- |
| `script/deploy/config/canonical.json` | Every constructor input shared by all networks (CLPR Service, salt, deployment id seed, registry notices, vault windows, Router parameters incl. `MIN_SEND_GAS`, deployer owner, ledger list) |
| `script/deploy/config/<network>.json` | Per network: chain id, CAIP-2 ledger id, RPC variable, explorer, transaction settings |
| `script/deploy/config/route.json` | Channel salt, CLPR Service throttles and economics per ledger, the route |
| `script/deploy/DeployRouter.s.sol` | Registry, vault, `ClprRouterDeployer`, canonical Router; post-deploy checks |
| `script/deploy/SetupRoute.s.sol` | Service bring-up, fixtures, Channel, Connector, `send`, `deliver`, `status` |
| `script/deploy/DeployEthVerifier.s.sol` | Reuses or deploys `EthMainnetVerifier` (byte-identical check) |
| `script/deploy/TestnetFixtures.sol` | `TestOnlyStubVerifier`, `TestnetConnector`, `TestnetRouteApp` |
| `script/deploy/relay/` | Sepolia beacon/execution proof builder (`eth-config.ts`, `eth-bundle.ts`; `vendor/` is copied unchanged from the CLPR repo apart from three added `export`s); `hedera-submit.ts` submits one large transaction through the Hedera SDK with a higher max fee |
| `script/deploy/verify.sh` | Sourcify source verification of every deployed contract |
| `deployments/<network>.json` | Addresses, code hashes, constructor arguments, transactions, gas, cost |
| `deployments/test-committee.json` | TEST committee: public addresses, k |
