// SPDX-License-Identifier: MIT
import type { Address, Hex } from "viem";
import { isLocalRpc } from "../../src/config.js";
import { redactUrl } from "../../src/log.js";
import type { Logger } from "../../src/log.js";
import { BUNDLE_ENCODER_ABI, CLPR_SERVICE_ABI } from "./abi.js";
import type { Ledger } from "./clients.js";
import { sendTx } from "./clients.js";

/** One end of a CLPR Channel: a ledger and its CLPR Service. */
export interface RelayEnd {
  ledger: Ledger;
  clprService: Address;
}

export interface RelayResult {
  /** True if a bundle was submitted. */
  submitted: boolean;
  messages: number;
}

/**
 * Moves CLPR messages of one Channel from `src` to `dst`. Production implementations build the proof the
 * destination's verifier expects for that source ledger (not part of this service). The Connector only needs the
 * order book on Hedera to learn about deposits and deliveries; anyone may relay.
 */
export interface ProofRelay {
  readonly kind: string;
  relay(src: RelayEnd, dst: RelayEnd, channelId: Hex): Promise<RelayResult>;
}

/** Relays nothing: some other party submits the proofs. */
export class NoRelay implements ProofRelay {
  readonly kind = "none";
  async relay(): Promise<RelayResult> {
    return { submitted: false, messages: 0 };
  }
}

export class RelayRefused extends Error {
  override name = "RelayRefused";
}

/** ClprTypes.QueueMetadata. */
export interface QueueMetadata {
  nextMessageId: bigint;
  sentRunningHash: Hex;
  receivedMessageId: bigint;
  receivedRunningHash: Hex;
  state: number;
  endpointManifestVersion: bigint;
}

interface ChannelView {
  status: number;
  nextMessageId: bigint;
  ackedMessageId: bigint;
  receivedMessageId: bigint;
  sentRunningHash: Hex;
  receivedRunningHash: Hex;
  endpointManifestVersion: bigint;
}

/** Which message ids to carry from `src` to `dst`, and whether there is anything to relay at all. */
/// `maxMessages` caps one bundle: on Hedera a bundle's call trace must stay well under the consensus node's
/// `contracts.maxSerializedTraceDataBytes` (262,144 B); one deposit message adds about 12 KB (docs/settle-on-hedera.md).
export function relayPlan(
  src: Pick<ChannelView, "nextMessageId" | "receivedMessageId">,
  dst: Pick<ChannelView, "receivedMessageId" | "ackedMessageId">,
  maxMessages: bigint = DEFAULT_MAX_MESSAGES_PER_BUNDLE,
): { from: bigint; count: bigint; needed: boolean; partial: boolean } {
  const from = dst.receivedMessageId + 1n;
  const pending = src.nextMessageId > from ? src.nextMessageId - from : 0n;
  const count = pending > maxMessages ? maxMessages : pending;
  return { from, count, needed: count > 0n || src.receivedMessageId > dst.ackedMessageId, partial: count < pending };
}

export const DEFAULT_MAX_MESSAGES_PER_BUNDLE = 12n;

/**
 * TEST ONLY. Relays CLPR bundles with no proof at all, which only the CLPR repository's `E2EVerifier` accepts. It
 * reads the source Channel's queue, encodes the bundle with the CLPR test contract `BundleEncoderHelper` (eth_call)
 * and submits it on the destination. It refuses to run against any RPC that is not local.
 */
export class E2ETestOnlyRelay implements ProofRelay {
  readonly kind = "e2e-test-only";

  constructor(
    private readonly encoder: { ledger: Ledger; address: Address },
    private readonly log: Logger,
    private readonly maxMessages: bigint = DEFAULT_MAX_MESSAGES_PER_BUNDLE,
  ) {
    E2ETestOnlyRelay.assertLocal(encoder.ledger.rpcUrl);
  }

  static assertLocal(url: string): void {
    if (!isLocalRpc(url)) throw new RelayRefused(`e2e-test-only relay: ${redactUrl(url)} is not a local RPC; this relay is for local test networks only`);
  }

  async relay(src: RelayEnd, dst: RelayEnd, channelId: Hex): Promise<RelayResult> {
    E2ETestOnlyRelay.assertLocal(src.ledger.rpcUrl);
    E2ETestOnlyRelay.assertLocal(dst.ledger.rpcUrl);
    const s = (await src.ledger.public.readContract({ address: src.clprService, abi: CLPR_SERVICE_ABI, functionName: "getChannel", args: [channelId] })) as unknown as ChannelView;
    const d = (await dst.ledger.public.readContract({ address: dst.clprService, abi: CLPR_SERVICE_ABI, functionName: "getChannel", args: [channelId] })) as unknown as ChannelView;
    const plan = relayPlan(s, d, this.maxMessages);
    if (!plan.needed) return { submitted: false, messages: 0 };
    const payloads: Hex[] = [];
    let lastHash = s.sentRunningHash;
    for (let i = 0n; i < plan.count; i++) {
      const m = await src.ledger.public.readContract({ address: src.clprService, abi: CLPR_SERVICE_ABI, functionName: "getMessage", args: [channelId, plan.from + i] });
      payloads.push(m.payload);
      lastHash = m.runningHashAfterProcessing;
    }
    // A partial bundle describes the queue as of its last message; the rest goes in the next bundle.
    const metadata: QueueMetadata = {
      nextMessageId: plan.partial ? plan.from + plan.count : s.nextMessageId,
      sentRunningHash: plan.partial ? lastHash : s.sentRunningHash,
      receivedMessageId: s.receivedMessageId,
      receivedRunningHash: s.receivedRunningHash,
      state: s.status,
      endpointManifestVersion: s.endpointManifestVersion,
    };
    const bundle = await this.encoder.ledger.public.readContract({ address: this.encoder.address, abi: BUNDLE_ENCODER_ABI, functionName: "encode", args: [metadata, payloads] });
    await sendTx(dst.ledger, { address: dst.clprService, abi: CLPR_SERVICE_ABI, functionName: "submitBundle", args: [channelId, bundle] });
    this.log.info("bundle relayed (test only)", { from: src.ledger.ledgerId, to: dst.ledger.ledgerId, messages: payloads.length });
    return { submitted: true, messages: payloads.length };
  }
}
