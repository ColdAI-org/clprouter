# Proposal for the CLPR repo: staged sync-committee input for `EthMainnetVerifier` on Hedera

Status: proposal, not applied to `lib/clpr-smart-contracts`. The CLPRouter testnet works around the bootstrap half
with `script/deploy/StagedEthConfigVerifier.sol`; rotation is not covered.

## Problem

Hedera consensus nodes cap the serialized contract trace of a transaction (`contracts.maxSerializedTraceDataBytes`,
default 262,144 bytes: every call frame's input and output, precompile calls included, plus storage reads and writes).
Above the cap the node fails the transaction with `INSUFFICIENT_GAS` after executing it
(`ConversionUtils.throwIfUnsuccessfulCall` in hiero-consensus-node). Any `EthMainnetVerifier` path that receives a full
512-key committee crosses it:

- `completeChannel` → `verifyConfig`: about 302 KB of raw frame data (67 KB on each of the Service call, the
  delegatecall into its logic and the verifier call, plus 257 `BLS12_G1ADD` on-curve checks).
- `submitBundle` → `verifyBundle` with a rotation (payload item 4): the same 67 KB committee through the same frames,
  the same 257 on-curve checks, plus the SSZ root. A Channel on Hedera therefore cannot follow a sync-committee
  rotation and stops verifying at the end of the period it was opened in.

Gas limits, fees, the relay's file-based `callData` and the SDK do not change the trace size.

## Proposed change

1. A committee staging entry point on the verifier (or a small companion contract it reads), as in the CLPRouter
   adapter: `stageChunk(bytes keys)` takes 32 uncompressed keys, runs `ClprBeaconBls.requireOnCurveG1` and records the
   chunk's `ClprCommitteeMerkle` subtree root (32-leaf subtrees are level-5 nodes of the 512-leaf tree).
2. `verifyConfig` accepts, besides the current shape, `[slot, [[chunkRoot × 16], aggregate], gvr, forkVersion,
   ledgerConfiguration, codeHash]`, requires every chunk root staged, folds them into the committee root and builds the
   same 260-byte trust anchor.
3. Rotation in two steps: a staging transaction proves the next committee against an already verified
   state root (the SSZ branch at gindex 87 needs the keys only to rebuild `syncCommitteeRootFromUncompressed`, which
   can be accumulated per chunk), stores `(stateRoot, nextCommitteeMerkleRoot, aggregate)`, and the rotation bundle
   then names that record instead of carrying the keys. The successor anchor is unchanged.

Byte-for-byte parity with the current path is testable as in `test/unit/StagedEthConfigVerifier.t.sol` of CLPRouter.
