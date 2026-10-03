# Testnet deployments

CLPRouter on two public testnets, Ethereum Sepolia (`eip155:11155111`) and Hedera testnet (`eip155:296`),
next to the reference CLPR Service that is deployed at the same address on both
(`0xa6db474e3047c3d43b10a4ff7abad547d89982b9`). The planned route, Sepolia → Hedera verified on Hedera by the CLPR
repo's `EthMainnetVerifier` (a sync-committee light client), has run once: sent on Sepolia, proven and delivered on
Hedera. The Hedera half of its Channel first failed to open; why, and the staged bootstrap that opened it, are under
Result. This file is the narrative; the
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
| Channel `0x8a15fe9f…4145e0` | open, `TestOnlyStubVerifier` | open, `StagedEthConfigVerifier` → `EthMainnetVerifier` (see below) |
| Connector `0xed6c8cc0…51d3` | registered | registered, funded 3 HBAR for inbound execution |
| Route `0x03c51452…baa110` Sepolia → Hedera | sent; origin PENDING (receipt unprovable, see below) | **delivered** to `TestnetRouteApp` |
| Spent | 0.025689116 ETH (balance 0.032949 → 0.007260) | 62.79886750 HBAR (balance 575.743 → 512.944; 9.71 HBAR of it for the Channel fix and the route) |

**First run: the Hedera Channel did not open.** `completeChannel` with the EthMainnetVerifier bootstrap config (the
512 Sepolia sync-committee keys as uncompressed EIP-2537 points, 67,365 bytes of calldata) ended `INSUFFICIENT_GAS` on
Hedera testnet at every gas limit tried (5.6M, 12.9M, 6M, 6M, 15M; through the JSON-RPC relay and through the Hedera
SDK), always with 4,062,470 gas reported used and about 9.62 HBAR charged, while the relay's `eth_estimateGas` and an
anvil fork succeeded. About 48 HBAR went on those five attempts.

**Cause: Hedera's contract trace-size limit, not gas.** After a contract call executes, the consensus node checks the
size of the trace it records for the transaction (the `ContractActions` sidecar, every call frame's input and output
including precompile calls, plus `ContractStateChanges`) against `contracts.maxSerializedTraceDataBytes` (default
262,144 bytes); above it, `ConversionUtils.throwIfUnsuccessfulCall` throws `INSUFFICIENT_GAS` and rolls the
transaction back (`hiero-consensus-node`, `TraceDataSizeLimiter`; present in v0.77.2, the version testnet runs). That is
why the gas used equals the fork's full execution gas whatever the limit, and why the mirror node shows the failed
transactions with no actions and no state changes. Neither `eth_estimateGas` (mirror-node EVM) nor anvil applies the
limit. The trace of the failed call on a fork, frame by frame: the Service call (67,364 bytes in), the delegatecall
into its logic (67,364), the `verifyConfig` call (67,012 in, 1,248 out), ecrecover (160) and 257 `BLS12_G1ADD` on-curve
checks (65,792 in, 32,896 out): 301,836 bytes of raw input and output before any protobuf framing, over the limit.
No gas limit, fee, relay or SDK setting changes it, and the `ethereumData` file path only moves the calldata, not the
trace.

**Fix: stage the committee.** [`StagedEthConfigVerifier`](../script/deploy/StagedEthConfigVerifier.sol) is a testnet
adapter in front of the unchanged, byte-identical `EthMainnetVerifier`. `stageChunk` takes 32 keys at a time (4 KB,
under Hedera's 6 KB non-jumbo transaction size), runs the same `ClprBeaconBls.requireOnCurveG1` check and records the
chunk's keccak Merkle subtree root; the config then names the 16 chunk roots instead of the 512 keys, and
`verifyConfig` folds them into the same `ClprCommitteeMerkle` root and returns exactly what `EthMainnetVerifier`
returns for the full config (same 260-byte trust anchor, period id, channel context, uninitialized manifest; parity
test in [`test/unit/StagedEthConfigVerifier.t.sol`](../test/unit/StagedEthConfigVerifier.t.sol)). `verifyBundle`
forwards to `EthMainnetVerifier`, so every bundle is verified by the CLPR repo's verifier. Trust is as before: the
config committee is the Channel operator's input in either case. Rehearsed on a Hedera-testnet fork first, with
[`trace-size.mjs`](../script/deploy/trace-size.mjs) estimating each transaction's trace: about 12.6 KB per
`stageChunk`, 11.9 KB for `completeChannel`, 120 KB for `submitBundle`.

The rehearsal also showed that the Hedera `TestnetConnector` had no balance, so the Service answered the message
`CONNECTOR_UNDERFUNDED` instead of delivering it; `route-fixtures-hedera` now tops the Connector up to
`econ.hedera.connectorFunding` (3 HBAR) in `config/route.json`.

**Second run.** Staged verifier deployed, 16 chunks staged, Channel opened with the period-1376 Sepolia committee,
Connector registered and funded, `Router.send` on Sepolia, and `submitBundle` on Hedera (attested slot 11274704,
participation 499/512, 14,829-byte proof, 2,755,892 gas) delivered route `0x03c51452a41f4867d5bd8f5774baa110` to
`TestnetRouteApp`; the Router's DELIVERED receipt was flushed into the Hedera → Sepolia queue. 9.71 HBAR in all
(balance 522.657 → 512.944), of which 2.29 HBAR still sits in the Connector.

**Limit that remains.** A rotation bundle carries the next committee's 512 keys through the same frames and would
hit the same trace limit, so this Channel works until the end of sync-committee period 1376 (about 27 h from its
start), after which it needs a new Channel or a staged rotation, which belongs in the CLPR verifier.

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
| StagedEthConfigVerifier (Hedera only, in front of EthMainnetVerifier) | `0x298DcbBD5229B9E055c4e6a574A05c591Cf1aae1` |

Router init-code hash `0x4999057976d9a9a644ccd2820d40383bb3e46fdfec7a5d71197a4010ee699459` (no constructor arguments; per-ledger parameters come from the
deployer). Router parameters: `RECLAIM_GRACE` 3600 s, `APP_GAS` 300,000, `MIN_SEND_GAS` 1,500,000 (gas that must be
left before a hop calls `sendMessage`; below it a permissionless `forward` reverts and a send inside delivery stays
pending, so nobody can fail a hop by under-funding the transaction; 1.5M is above the largest `sendMessage` leg
measured in the e2e runs). Registry: TEST committee, k = 3 of 5, notices 7 d / 72 h / 7 d, lapses 7 d / 30 d,
committee notice 7 d. Vault: recovery notice 72 h, challenge window 7 d. Optimizer: solc 0.8.30, via-IR, 200 runs
(the deploy scripts' compile unit includes ClprRouter, so it uses the `small` profile), `osaka`, no CBOR metadata.

### Transactions

Gas is the receipt's `gasUsed`. Cost on Sepolia is `gasUsed × effectiveGasPrice`; on Hedera it is the mirror node's
`charged_tx_fee`. The Hedera per-transaction fees add up to 76.17037266 HBAR, more than the balance difference
(62.79886750 HBAR), which is the figure to trust; the cause of the gap was not established.

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
| Sepolia | send | ClprRouter send | [`0x8a08f19922…`](https://sepolia.etherscan.io/tx/0x8a08f19922f6a265f2900b218db01510c4dc21e50ed80b68ae8756faddff0d6c) | 1,131,414 | 0.001160935 ETH | success |
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
| Hedera testnet | staged-verifier | StagedEthConfigVerifier CREATE2 deploy | [`0xbe983a69f5…`](https://hashscan.io/testnet/transaction/0xbe983a69f55dbfcefaf996852f692aa3825ef07d7d94c37e8d203dd5de1cce3a) | 1,665,439 | 1.38231437 HBAR | success |
| Hedera testnet | channel-hedera-stage | StagedEthConfigVerifier stageChunk | [`0xdf341d4864…`](https://hashscan.io/testnet/transaction/0xdf341d4864af1506c95e52dde2aeb9659b9c06fc61e716b0d8be3cd0cb102ccd) | 171,716 | 0.14252428 HBAR | success |
| Hedera testnet | channel-hedera-stage | StagedEthConfigVerifier stageChunk | [`0xde38944dae…`](https://hashscan.io/testnet/transaction/0xde38944dae4f6c67701b246fd6e5aff6045ad467ba08c1a5e7f164f690022a38) | 171,740 | 0.14254420 HBAR | success |
| Hedera testnet | channel-hedera-stage | StagedEthConfigVerifier stageChunk | [`0x07962929e9…`](https://hashscan.io/testnet/transaction/0x07962929e93064719980e78f895924ac119dfb4d5dce1de82a6d78b204b03b64) | 171,692 | 0.14250436 HBAR | success |
| Hedera testnet | channel-hedera-stage | StagedEthConfigVerifier stageChunk | [`0xe73b950846…`](https://hashscan.io/testnet/transaction/0xe73b950846e50efc06ebfe8529c7f0fe49b16be625a7f028e111c76b9f0298f6) | 171,620 | 0.14244460 HBAR | success |
| Hedera testnet | channel-hedera-stage | StagedEthConfigVerifier stageChunk | [`0xf1ff08bdc3…`](https://hashscan.io/testnet/transaction/0xf1ff08bdc3b50396328eef05a8b2359dce8827b7ef7d81532b4f0fb24da4378e) | 171,668 | 0.14248444 HBAR | success |
| Hedera testnet | channel-hedera-stage | StagedEthConfigVerifier stageChunk | [`0x9c07bba246…`](https://hashscan.io/testnet/transaction/0x9c07bba24649d42eb589d5c398023cd47592566305cd72d9c059ec8b4eb5b687) | 171,620 | 0.14244460 HBAR | success |
| Hedera testnet | channel-hedera-stage | StagedEthConfigVerifier stageChunk | [`0x7cba3c98d2…`](https://hashscan.io/testnet/transaction/0x7cba3c98d27130f634b0485c0304882375004bdcc34c42b8225a2ea3190399ce) | 171,680 | 0.14249440 HBAR | success |
| Hedera testnet | channel-hedera-stage | StagedEthConfigVerifier stageChunk | [`0x8dcc04f668…`](https://hashscan.io/testnet/transaction/0x8dcc04f668477b0af76c3df7a95d543cb56d508541d5b7f7ce0abb5fe2860843) | 171,584 | 0.14241472 HBAR | success |
| Hedera testnet | channel-hedera-stage | StagedEthConfigVerifier stageChunk | [`0x0c085c3b2e…`](https://hashscan.io/testnet/transaction/0x0c085c3b2ee27bcec56f26aab7fde185ebe5d1ee0eb6a16641d3a5871bcc6483) | 171,584 | 0.14241472 HBAR | success |
| Hedera testnet | channel-hedera-stage | StagedEthConfigVerifier stageChunk | [`0xacd61e2cb2…`](https://hashscan.io/testnet/transaction/0xacd61e2cb20c3c4d76452c12b9d6260e86ae7ad55e3ba032f9382f1cd2afd94f) | 171,608 | 0.14243464 HBAR | success |
| Hedera testnet | channel-hedera-stage | StagedEthConfigVerifier stageChunk | [`0xfdd45071e9…`](https://hashscan.io/testnet/transaction/0xfdd45071e92d6ad01f98e1db42b72f36db3592b1d83385587a81b1c84d282758) | 171,680 | 0.14249440 HBAR | success |
| Hedera testnet | channel-hedera-stage | StagedEthConfigVerifier stageChunk | [`0xb7787a6c41…`](https://hashscan.io/testnet/transaction/0xb7787a6c418645edc27a3f7082c1ebd04b6ce3d0251b62e2fc1bf633fe76ba5f) | 171,692 | 0.14250436 HBAR | success |
| Hedera testnet | channel-hedera-stage | StagedEthConfigVerifier stageChunk | [`0xd3ba082013…`](https://hashscan.io/testnet/transaction/0xd3ba082013b79ed8a8bae9b211c934c13e4a6912533dfb0e3cb96866eda3fca3) | 171,596 | 0.14242468 HBAR | success |
| Hedera testnet | channel-hedera-stage | StagedEthConfigVerifier stageChunk | [`0xee71f5018d…`](https://hashscan.io/testnet/transaction/0xee71f5018d60ad88658132e645c8fc14e80b051bfcd2da0df20b25eb6f925261) | 171,704 | 0.14251432 HBAR | success |
| Hedera testnet | channel-hedera-stage | StagedEthConfigVerifier stageChunk | [`0x219f0e4b2b…`](https://hashscan.io/testnet/transaction/0x219f0e4b2bd36ba7d5b33a56cf006d1de624cb823cb6d6b9bca0c6824a3203b3) | 171,716 | 0.14252428 HBAR | success |
| Hedera testnet | channel-hedera-stage | StagedEthConfigVerifier stageChunk | [`0x1018b01188…`](https://hashscan.io/testnet/transaction/0x1018b0118891dbd9bb766b2ba84f08c6bbdd11394776b476da24986804ec4a19) | 171,620 | 0.14244460 HBAR | success |
| Hedera testnet | channel-hedera | ClprService registerChannel | [`0xea2a470e3e…`](https://hashscan.io/testnet/transaction/0xea2a470e3e52da7273faa8ff19f81836fd7b048b1d627c90245471d8eb69ee59) | 35,523 | 0.02948409 HBAR | success |
| Hedera testnet | channel-hedera | ClprService completeChannel | [`0x285565114a…`](https://hashscan.io/testnet/transaction/0x285565114acef4b37592e9ac115460bbfcabd547936e44fd515ed9919132a3d9) | 788,546 | 0.65449318 HBAR | success |
| Hedera testnet | connector-hedera | ClprService registerConnector | [`0x5b2ae815aa…`](https://hashscan.io/testnet/transaction/0x5b2ae815aa5357b88be64901deebdfce1ef2707e4bb3f17a4ce62106afa9106a) | 51,920 | 0.04309360 HBAR | success |
| Hedera testnet | connector-hedera | ClprService completeConnector | [`0xab9d8bf2a1…`](https://hashscan.io/testnet/transaction/0xab9d8bf2a1f897bdf69531986cdf0ec24ddaf02017366e62e38cc4a9d86d844d) | 177,746 | 0.14752918 HBAR | success |
| Hedera testnet | route-fixtures-hedera | TestnetConnector transfer (top-up) | [`0x44ce6947c9…`](https://hashscan.io/testnet/transaction/0x44ce6947c9bbd9db3ac1130d1effaf67791baf2d1171b80f740b3ff13ae14bb6) | 21,067 | 3.01748561 HBAR | success |
| Hedera testnet | deliver | ClprService submitBundle | [`0x1249ca9040…`](https://hashscan.io/testnet/transaction/0x1249ca9040fb4c1f02e99ee656823393b223bf9f2bcba9d2a6cdb36344e1989b) | 2,755,892 | 2.28739036 HBAR | success |
| Hedera testnet | deliver | ClprRouter flush | [`0xc843d6d4f6…`](https://hashscan.io/testnet/transaction/0xc843d6d4f6199b934fdf221a9192a69df015d1ada9d5c6b847dde61c37d4a7bb) | 705,711 | 0.58574013 HBAR | success |


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
script/deploy/route.sh staged-verifier --broadcast    # StagedEthConfigVerifier in front of it

# CLPRouter: registry, vault, deployer, canonical Router (simulate first by leaving out --broadcast)
script/deploy/deploy.sh sepolia --broadcast
script/deploy/deploy.sh hedera-testnet --broadcast
script/deploy/route.sh route-fixtures-sepolia --broadcast   # allow the Router on the Connector
script/deploy/route.sh route-fixtures-hedera --broadcast    # same, plus the destination app and the Connector top-up

# Just in time (same Sepolia sync-committee period, about 27 h):
script/deploy/route.sh channel-hedera --broadcast     # stage the current Sepolia committee (16 txs), open the Channel
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
| `script/deploy/StagedEthConfigVerifier.sol` | Testnet adapter: bootstrap committee staged in 32-key chunks, bundles forwarded to `EthMainnetVerifier` |
| `script/deploy/trace-size.mjs` | Estimates a rehearsed transaction's Hedera trace size against `contracts.maxSerializedTraceDataBytes` |
| `script/deploy/TestnetFixtures.sol` | `TestOnlyStubVerifier`, `TestnetConnector`, `TestnetRouteApp` |
| `script/deploy/relay/` | Sepolia beacon/execution proof builder (`eth-config.ts`, `eth-bundle.ts`; `vendor/` is copied unchanged from the CLPR repo apart from three added `export`s); `hedera-submit.ts` submits one large transaction through the Hedera SDK with a higher max fee (no longer needed for the Channel) |
| `script/deploy/verify.sh` | Sourcify source verification of every deployed contract |
| `deployments/<network>.json` | Addresses, code hashes, constructor arguments, transactions, gas, cost |
| `deployments/test-committee.json` | TEST committee: public addresses, k |
