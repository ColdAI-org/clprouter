import { decodeEnvelope, encodeEnvelope } from "@clprouter/sdk";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { accountNotices } from "../src/notices.js";
import { keys } from "../src/registry.js";
import { buildRouteStatus, loadRouteStatus } from "../src/status.js";
import { Store } from "../src/store.js";
import { G, R, V, ev, h32, rid } from "./helpers.js";

const A = "eip155:31001";
const B = "eip155:31002";
const C = "eip155:31003";
const ROUTE = rid(0xabc);
const RECEIPT = rid(0xdef);

/** A real envelope A → B → C at hop 1 (as held on B). */
function envelopeABC(): Hex {
  const env = decodeEnvelope("0x");
  env.route_id = ROUTE;
  env.origin = { ledger_id: A, application: "0xa11ce00000000000000000000000000000000001" };
  env.destination = { ledger_id: C, application: "0xc0ffee0000000000000000000000000000000003" };
  env.sender = `${A}:0xa11ce00000000000000000000000000000000001`;
  env.recipient = `${C}:0xc0ffee0000000000000000000000000000000003`;
  const hop = (ledger: string, ch: string) => ({
    ledger_id: ledger,
    router: "0x1000000000000000000000000000000000000001" as Hex,
    channel_id: ch ? h32(ch) : ("0x" as Hex),
    connector_id: ch ? h32(`conn-${ch}`) : ("0x" as Hex),
    fee: ch ? 10n : 0n,
    fee_payee: "0x" as Hex,
  });
  env.hops = [hop(A, "AB"), hop(B, "BC"), hop(C, "")];
  env.hop_index = 1;
  env.constraints.deadline = 1_800_003_600n;
  env.router_version = 1;
  return encodeEnvelope(env);
}

describe("route status", () => {
  it("follows a delivered route hop by hop, including the fallback forward and the receipt", () => {
    const envelope = envelopeABC();
    const events = [
      ev(A, R.sent(ROUTE), { block: 10, ts: 100 }),
      ev(B, R.pending(ROUTE, 1, envelope), { block: 20, ts: 110 }),
      ev(B, R.forwarded(ROUTE, 1), { block: 21, ts: 120 }),
      ev(C, R.delivered(ROUTE), { block: 30, ts: 130, log: 0 }),
      ev(C, R.receiptSent(RECEIPT, ROUTE, 1), { block: 30, ts: 130, log: 1 }),
      ev(A, R.settled(ROUTE, 2, 0, 2), { block: 15, ts: 150 }),
    ];
    const receiptEvents = [ev(B, R.forwarded(RECEIPT, 1, h32("BA")), { block: 25, ts: 140 })];
    const v = buildRouteStatus(ROUTE, events, receiptEvents, {}, 200);

    expect(v.found).toBe(true);
    expect(v.origin).toMatchObject({ ledger: A, destinationLedger: C, deadline: 1_800_003_600 });
    expect(v.plannedHops?.map((h) => h.ledger)).toEqual([A, B, C]);
    expect(v.hops.map((h) => [h.index, h.ledger, h.status])).toEqual([
      [0, A, "sent"],
      [1, B, "forwarded"],
      [2, C, "delivered"],
    ]);
    // Per-ledger tx hashes and timestamps.
    expect(v.hops[1]!.events.map((e) => e.name)).toEqual(["ForwardPending", "RouteForwarded"]);
    expect(v.hops[1]!.firstSeen).toBe(110);
    expect(v.hops[2]!.events[0]!.txHash).toMatch(/^0x/);
    expect(v.receipts).toHaveLength(1);
    expect(v.receipts[0]).toMatchObject({ receiptId: RECEIPT, fromLedger: C, status: "DELIVERED" });
    expect(v.receipts[0]!.path.map((e) => [e.ledger, e.name])).toEqual([[B, "RouteForwarded"]]);
    expect(v.outcome).toMatchObject({ status: "DELIVERED", settled: true, reason: "NONE", feesPaid: "30" });
  });

  it("shows a hop waiting for the public forward trigger", () => {
    const v = buildRouteStatus(ROUTE, [
      ev(A, R.sent(ROUTE), { block: 10, ts: 100 }),
      ev(B, R.pending(ROUTE, 1, envelopeABC()), { block: 20, ts: 110 }),
    ]);
    expect(v.hops.map((h) => h.status)).toEqual(["sent", "forward-pending", "waiting"]);
    expect(v.outcome).toMatchObject({ status: "PENDING", settled: false, at: { ledger: B, hopIndex: 1 } });
  });

  it("reports a failure where it stopped, then the origin's settlement", () => {
    const base = [
      ev(A, R.sent(ROUTE), { block: 10, ts: 100 }),
      ev(B, R.stopped(ROUTE, 1, 2, 3), { block: 20, ts: 110, log: 0 }), // FAILED, DISABLED_EDGE
      ev(B, R.receiptSent(RECEIPT, ROUTE, 2, 3), { block: 20, ts: 110, log: 1 }),
    ];
    let v = buildRouteStatus(ROUTE, base);
    expect(v.hops[1]).toMatchObject({ ledger: B, status: "stopped", stop: { status: "FAILED", reason: "DISABLED_EDGE" } });
    expect(v.outcome).toMatchObject({ status: "FAILED", settled: false, reason: "DISABLED_EDGE", at: { ledger: B, hopIndex: 1 } });

    v = buildRouteStatus(ROUTE, [...base, ev(A, R.settled(ROUTE, 3, 3, 1), { block: 12, ts: 130 })]);
    expect(v.outcome).toMatchObject({ status: "FAILED", settled: true, reason: "DISABLED_EDGE", at: { hopIndex: 1 } });
  });

  it("reports expiry", () => {
    const v = buildRouteStatus(ROUTE, [
      ev(A, R.sent(ROUTE, { deadline: 105n }), { block: 10, ts: 100 }),
      ev(B, R.stopped(ROUTE, 1, 3, 2), { block: 20, ts: 110 }),
    ], [], {}, 120);
    expect(v.outcome).toMatchObject({ status: "EXPIRED", reason: "DEADLINE", deadlinePassed: true });
  });

  it("reports a quarantine with its case id, notice and vault deposit", () => {
    const caseId = h32("case-7");
    const recipient = `${C}:0xc0ffee0000000000000000000000000000000003`;
    const v = buildRouteStatus(ROUTE, [
      ev(A, R.sent(ROUTE, { messageId: 0n }), { block: 10, ts: 100, log: 0 }),
      ev(A, R.notice(ROUTE, recipient, keys.account(recipient), caseId), { block: 10, ts: 100, log: 1 }),
      ev(A, V.deposited(1, ROUTE, caseId, 40n), { block: 10, ts: 100, log: 2 }),
      ev(A, R.settled(ROUTE, 5, 9, 0, caseId), { block: 10, ts: 100, log: 3 }),
    ]);
    expect(v.outcome).toMatchObject({ status: "QUARANTINED", settled: true, reason: "BLACKLIST", caseId, contact: "mailto:incident@provider.example" });
    expect(v.notices).toHaveLength(1);
    expect(v.quarantine).toEqual([{ ledger: A, depositId: 1, caseId, amount: "40", txHash: expect.any(String) }]);
  });

  it("returns found=false for an unknown route", () => {
    expect(buildRouteStatus(ROUTE, []).found).toBe(false);
  });
});

describe("account notices", () => {
  it("collects recipient notices, sender receipts and listings for a CAIP-10 account", () => {
    const store = new Store();
    const caseId = h32("case-9");
    const sender = "0xa11ce00000000000000000000000000000000001";
    const recipient = `${C}:0xC0FFEE0000000000000000000000000000000003`; // mixed case: keys are case-insensitive
    const events = [
      ev(A, R.sent(ROUTE, { sender }), { block: 1, log: 0 }),
      ev(A, R.notice(ROUTE, recipient, keys.account(recipient), caseId), { block: 1, log: 1 }),
      ev(A, R.settled(ROUTE, 5, 9, 0, caseId), { block: 1, log: 2 }),
      ev(A, G.listed(keys.account(recipient), recipient, caseId, 999), { block: 1, log: 3 }),
    ];
    store.applyRange(A, events, { blockNumber: 1, blockHash: h32("b1") }, []);

    const r = accountNotices(store, recipient.toLowerCase(), {});
    expect(r.recipientNotices).toEqual([expect.objectContaining({ routeId: ROUTE, caseId, ledger: A })]);
    expect(r.listings).toEqual([expect.objectContaining({ event: "AccountBlacklisted", caseId, lapseAt: 999 })]);

    const s = accountNotices(store, `${A}:${sender}`, {});
    expect(s.senderReceipts).toEqual([expect.objectContaining({ routeId: ROUTE, caseId })]);
    expect(s.recipientNotices).toHaveLength(0);

    // loadRouteStatus goes through the store, receipts included.
    expect(loadRouteStatus(store, ROUTE, {}).outcome.status).toBe("QUARANTINED");
  });
});
