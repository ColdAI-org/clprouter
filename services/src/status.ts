import { decodeEnvelope } from "@clprouter/sdk";
import type { Hex } from "viem";
import type { ArgValue, IndexedEvent } from "./events.js";
import type { Cursor, Store } from "./store.js";

export type Outcome = "PENDING" | "DELIVERED" | "FAILED" | "EXPIRED" | "QUARANTINED";

export type HopStatus =
  | "waiting" // planned, nothing seen on this ledger yet
  | "sent" // origin: sent over the first Channel
  | "forward-pending" // could not forward inside CLPR delivery; anyone may call Router.forward
  | "forwarded"
  | "rejected" // next hop rejected at the CLPR level (or the local send failed)
  | "delivered"
  | "stopped"; // the route stopped here (failure, expiry or quarantine receipt sent)

export interface EventRef {
  name: string;
  ledger: string;
  txHash: Hex;
  blockNumber: number;
  logIndex: number;
  timestamp: number;
  args: Record<string, ArgValue>;
}

export interface HopView {
  index: number;
  ledger: string;
  status: HopStatus;
  /** CLPR acknowledgement of the message this hop sent, if seen. */
  ack?: string;
  stop?: { status: string; reason: string };
  /** `ForwardRejected` reason (NEXT_HOP_ERROR or SEND_FAILED). */
  rejectReason?: string;
  firstSeen?: number;
  lastUpdate?: number;
  events: EventRef[];
}

export interface PlannedHop {
  ledger: string;
  router: Hex;
  channelId: Hex;
  connectorId: Hex;
  fee: string;
}

export interface RouteStatusView {
  routeId: Hex;
  found: boolean;
  origin: {
    ledger: string;
    sender: string;
    destinationLedger: string;
    escrow: string;
    feeBudget: string;
    deadline: number;
    messageId: string;
    txHash: Hex;
    timestamp: number;
  } | null;
  /** Full route as carried in the envelope, when an envelope was seen (pending or rejected hops). */
  plannedHops: PlannedHop[] | null;
  hops: HopView[];
  receipts: {
    receiptId: Hex;
    fromLedger: string;
    status: string;
    reason: string;
    txHash: Hex;
    timestamp: number;
    /** Where the receipt travelled (forwards, held or queued hops, requeues). */
    path: EventRef[];
  }[];
  outcome: {
    status: Outcome;
    /** True once the origin settled the route (escrow released, refunded or quarantined). */
    settled: boolean;
    reason?: string;
    caseId?: Hex;
    contact?: string;
    feesPaid?: string;
    settledAt?: number;
    settledTx?: Hex;
    /** Where the route stopped or was last seen. */
    at?: { ledger: string; hopIndex: number };
    deadlinePassed?: boolean;
  };
  /** Set once someone requested a reclaim: the refund can be finalised from this time unless a receipt lands first. */
  reclaimFinalAt?: number;
  /** An authentic receipt that arrived after a reclaim had refunded the route (recorded on-chain, nothing moved). */
  lateReceipt?: { status: string; hopIndex: number; responseHash: Hex; txHash: Hex };
  quarantine: { ledger: string; depositId: number; caseId: Hex; amount: string; txHash: Hex }[];
  notices: { ledger: string; recipient: string; caseId: Hex; contact: string; txHash: Hex; timestamp: number }[];
  /** Confirmed block per ledger the answer was built from. */
  inputs: Record<string, Cursor | null>;
}

const ref = (e: IndexedEvent): EventRef => ({
  name: e.name,
  ledger: e.ledger,
  txHash: e.txHash,
  blockNumber: e.blockNumber,
  logIndex: e.logIndex,
  timestamp: e.timestamp,
  args: e.args,
});

function tryPlannedHops(envelopeHex: unknown): PlannedHop[] | null {
  if (typeof envelopeHex !== "string" || envelopeHex === "0x") return null;
  try {
    const env = decodeEnvelope(envelopeHex as Hex);
    return env.hops.map((h) => ({
      ledger: h.ledger_id,
      router: h.router,
      channelId: h.channel_id,
      connectorId: h.connector_id,
      fee: h.fee.toString(),
    }));
  } catch {
    return null;
  }
}

/** Precedence when several events touch one hop: the furthest state wins. */
const RANK: Record<HopStatus, number> = {
  waiting: 0,
  sent: 1,
  "forward-pending": 2,
  rejected: 3,
  forwarded: 4,
  delivered: 5,
  stopped: 6,
};

/**
 * Hop-by-hop status of a route from its confirmed events on every ledger. `routeEvents` are the events whose
 * route id is `routeId`; `receiptEvents` are those of its receipt ids (see {@link loadRouteStatus}).
 */
export function buildRouteStatus(
  routeId: Hex,
  routeEvents: IndexedEvent[],
  receiptEvents: IndexedEvent[] = [],
  inputs: Record<string, Cursor | null> = {},
  now: number = Math.floor(Date.now() / 1000),
): RouteStatusView {
  const view: RouteStatusView = {
    routeId,
    found: routeEvents.length > 0,
    origin: null,
    plannedHops: null,
    hops: [],
    receipts: [],
    outcome: { status: "PENDING", settled: false },
    quarantine: [],
    notices: [],
    inputs,
  };
  const evs = [...routeEvents].sort((a, b) => a.timestamp - b.timestamp || a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  // Planned route, if any envelope was seen.
  for (const e of evs) {
    if (e.name === "ForwardPending" || e.name === "ForwardRejected" || e.name === "RouteForwarded") {
      // RouteForwarded carries the held envelope as `data` (empty for receipts); the others as `envelope`.
      view.plannedHops ??= tryPlannedHops(e.args.envelope ?? e.args.data);
    }
  }

  // Ledger → hop index, from events that carry an index, then the planned route.
  const indexOf = new Map<string, number>();
  const sent = evs.find((e) => e.name === "RouteSent");
  if (sent) indexOf.set(sent.ledger, 0);
  for (const e of evs) {
    if (e.name === "RouteForwarded" || e.name === "ForwardPending" || e.name === "RouteStopped") {
      if (!indexOf.has(e.ledger)) indexOf.set(e.ledger, Number(e.args.hopIndex));
    }
  }
  view.plannedHops?.forEach((h, i) => {
    if (!indexOf.has(h.ledger)) indexOf.set(h.ledger, i);
  });
  const nextIndex = () => (indexOf.size === 0 ? 0 : Math.max(...indexOf.values()) + 1);

  const hops = new Map<number, HopView>();
  const hop = (ledger: string, idx?: number): HopView => {
    let i = idx ?? indexOf.get(ledger);
    if (i === undefined) {
      i = nextIndex();
      indexOf.set(ledger, i);
    }
    let h = hops.get(i);
    if (!h) {
      h = { index: i, ledger, status: "waiting", events: [] };
      hops.set(i, h);
    }
    return h;
  };
  const touch = (h: HopView, e: IndexedEvent, status?: HopStatus) => {
    h.events.push(ref(e));
    h.firstSeen ??= e.timestamp;
    h.lastUpdate = e.timestamp;
    if (status && RANK[status] >= RANK[h.status]) h.status = status;
  };

  for (const e of evs) {
    const a = e.args;
    switch (e.name) {
      case "RouteSent":
        view.origin = {
          ledger: e.ledger,
          sender: String(a.sender),
          destinationLedger: String(a.destinationLedger),
          escrow: String(a.escrow),
          feeBudget: String(a.feeBudget),
          deadline: Number(a.deadline),
          messageId: String(a.messageId),
          txHash: e.txHash,
          timestamp: e.timestamp,
        };
        touch(hop(e.ledger, 0), e, String(a.messageId) === "0" ? undefined : "sent");
        break;
      case "RouteForwarded":
        touch(hop(e.ledger, Number(a.hopIndex)), e, "forwarded");
        break;
      case "ForwardPending":
        touch(hop(e.ledger, Number(a.hopIndex)), e, "forward-pending");
        break;
      case "ForwardRejected": {
        const h = hop(e.ledger, a.hopIndex !== undefined ? Number(a.hopIndex) : undefined);
        touch(h, e);
        // A rejection after a forward downgrades the hop: the next ledger never processed the envelope.
        h.status = "rejected";
        h.ack = String(a.statusName);
        if (a.reasonName !== undefined) h.rejectReason = String(a.reasonName);
        break;
      }
      case "HopResponse": {
        const h = hop(e.ledger);
        touch(h, e);
        h.ack = String(a.statusName);
        break;
      }
      case "RouteDelivered": {
        const last = view.plannedHops ? view.plannedHops.length - 1 : undefined;
        touch(hop(e.ledger, indexOf.get(e.ledger) ?? last), e, "delivered");
        break;
      }
      case "RouteStopped": {
        const h = hop(e.ledger, Number(a.hopIndex));
        touch(h, e, "stopped");
        h.stop = { status: String(a.statusName), reason: String(a.reasonName) };
        break;
      }
      case "QuarantineNotice":
        touch(hop(e.ledger), e);
        view.notices.push({
          ledger: e.ledger,
          recipient: String(a.recipient),
          caseId: a.caseId as Hex,
          contact: String(a.contact),
          txHash: e.txHash,
          timestamp: e.timestamp,
        });
        break;
      case "Deposited":
        touch(hop(e.ledger), e);
        view.quarantine.push({
          ledger: e.ledger,
          depositId: Number(a.depositId),
          caseId: a.caseId as Hex,
          amount: String(a.amount),
          txHash: e.txHash,
        });
        break;
      case "ReceiptSent":
        touch(hop(e.ledger), e);
        view.receipts.push({
          receiptId: a.receiptId as Hex,
          fromLedger: e.ledger,
          status: String(a.statusName),
          reason: String(a.reasonName),
          txHash: e.txHash,
          timestamp: e.timestamp,
          path: [],
        });
        break;
      case "RouteSettled":
        view.outcome = {
          status: String(a.statusName) as Outcome,
          settled: true,
          reason: String(a.reasonName),
          caseId: (a.caseId as Hex) !== `0x${"0".repeat(64)}` ? (a.caseId as Hex) : undefined,
          contact: a.contact ? String(a.contact) : undefined,
          feesPaid: String(a.feesPaid),
          settledAt: e.timestamp,
          settledTx: e.txHash,
          at: { ledger: e.ledger, hopIndex: Number(a.hopIndex) },
        };
        break;
      case "ReceiptIgnored":
        // On the route id: the receipt could not be authenticated (or the route was settled already).
        touch(hop(e.ledger), e);
        break;
      case "ReclaimRequested":
        touch(hop(e.ledger, 0), e);
        view.reclaimFinalAt = Number(a.finalAt);
        break;
      case "LateReceipt":
        // An authentic receipt after a reclaim refunded the route: recorded on-chain, nothing moved.
        touch(hop(e.ledger, 0), e);
        view.lateReceipt = { status: String(a.statusName), hopIndex: Number(a.hopIndex), responseHash: a.responseHash as Hex, txHash: e.txHash };
        break;
      default:
        touch(hop(e.ledger), e);
    }
  }

  // Receipt journeys (events keyed by the receipt id).
  const byReceipt = new Map(view.receipts.map((r) => [r.receiptId.toLowerCase(), r]));
  for (const e of [...receiptEvents].sort((a, b) => a.timestamp - b.timestamp || a.logIndex - b.logIndex)) {
    const r = byReceipt.get((e.routeId ?? "").toLowerCase());
    if (r) r.path.push(ref(e));
  }

  // Placeholders for planned hops not reached yet.
  view.plannedHops?.forEach((p, i) => {
    if (!hops.has(i)) hops.set(i, { index: i, ledger: p.ledger, status: "waiting", events: [] });
  });
  view.hops = [...hops.values()].sort((a, b) => a.index - b.index);

  if (!view.outcome.settled) {
    const stopped = view.hops.find((h) => h.status === "stopped");
    const delivered = view.hops.find((h) => h.status === "delivered");
    if (stopped?.stop) {
      const st = stopped.stop.status;
      view.outcome = {
        status: (["FAILED", "EXPIRED", "QUARANTINED"].includes(st) ? st : "FAILED") as Outcome,
        settled: false,
        reason: stopped.stop.reason,
        caseId: view.notices[0]?.caseId,
        contact: view.notices[0]?.contact,
        at: { ledger: stopped.ledger, hopIndex: stopped.index },
      };
    } else if (delivered) {
      view.outcome = { status: "DELIVERED", settled: false, at: { ledger: delivered.ledger, hopIndex: delivered.index } };
    } else {
      const reached = [...view.hops].reverse().find((h) => h.status !== "waiting");
      view.outcome = {
        status: "PENDING",
        settled: false,
        at: reached ? { ledger: reached.ledger, hopIndex: reached.index } : undefined,
      };
    }
    if (view.origin) view.outcome.deadlinePassed = now > view.origin.deadline;
  }
  return view;
}

/** Load a route's status from the store: its own events, then those of every receipt it produced. */
export function loadRouteStatus(store: Store, routeId: Hex, inputs: Record<string, Cursor | null>, now?: number): RouteStatusView {
  const routeEvents = store.eventsByRouteIds([routeId]);
  const receiptIds = routeEvents.filter((e) => e.name === "ReceiptSent").map((e) => String(e.args.receiptId));
  const receiptEvents = store.eventsByRouteIds(receiptIds);
  return buildRouteStatus(routeId, routeEvents, receiptEvents, inputs, now);
}
