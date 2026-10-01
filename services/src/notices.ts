import type { Hex } from "viem";
import { keys } from "./registry.js";
import type { Cursor, Store } from "./store.js";

export interface AccountNotices {
  account: string;
  accountKey: Hex;
  /** On-chain notices addressed to the account as the recipient of a held transfer. */
  recipientNotices: {
    routeId: Hex;
    ledger: string;
    caseId: Hex;
    contact: string;
    txHash: Hex;
    timestamp: number;
  }[];
  /** Routes the account sent (EVM origins) that settled QUARANTINED: the sender's receipt. */
  senderReceipts: {
    routeId: Hex;
    ledger: string;
    caseId: Hex | null;
    contact: string;
    txHash: Hex;
    timestamp: number;
  }[];
  /** Blacklist entries for the account seen on any ledger (listings and delistings, newest last). */
  listings: { ledger: string; event: string; caseId: Hex; lapseAt?: number; applied?: boolean; txHash: Hex; timestamp: number }[];
  inputs: Record<string, Cursor | null>;
}

/** Split a CAIP-10 id into its CAIP-2 ledger id and the account address. */
export function parseCaip10(id: string): { ledger: string; address: string } | undefined {
  const i = id.lastIndexOf(":");
  if (i <= 0) return undefined;
  const ledger = id.slice(0, i);
  const address = id.slice(i + 1);
  if (!ledger.includes(":") || !address) return undefined;
  return { ledger, address };
}

export function accountNotices(store: Store, caip10: string, inputs: Record<string, Cursor | null>): AccountNotices {
  const accountKey = keys.account(caip10);
  const byKey = store.eventsByAccountKey(accountKey);
  const out: AccountNotices = { account: caip10, accountKey, recipientNotices: [], senderReceipts: [], listings: [], inputs };

  for (const e of byKey) {
    if (e.name === "QuarantineNotice") {
      out.recipientNotices.push({
        routeId: e.routeId as Hex,
        ledger: e.ledger,
        caseId: e.args.caseId as Hex,
        contact: String(e.args.contact),
        txHash: e.txHash,
        timestamp: e.timestamp,
      });
    } else if (e.name === "AccountBlacklisted" || e.name === "AccountDelisted") {
      out.listings.push({
        ledger: e.ledger,
        event: e.name,
        caseId: e.args.caseId as Hex,
        lapseAt: e.args.lapseAt !== undefined ? Number(e.args.lapseAt) : undefined,
        applied: e.args.applied !== undefined ? Boolean(e.args.applied) : undefined,
        txHash: e.txHash,
        timestamp: e.timestamp,
      });
    }
  }

  const p = parseCaip10(caip10);
  if (p && /^0x[0-9a-fA-F]{40}$/.test(p.address)) {
    const sent = store.routesSentBy(p.ledger, p.address);
    const ids = sent.map((e) => e.routeId as Hex);
    for (const e of store.eventsByRouteIds(ids)) {
      if (e.name !== "RouteSettled" || e.args.statusName !== "QUARANTINED") continue;
      const caseId = e.args.caseId as Hex;
      out.senderReceipts.push({
        routeId: e.routeId as Hex,
        ledger: e.ledger,
        caseId: /^0x0+$/.test(caseId) ? null : caseId,
        contact: String(e.args.contact),
        txHash: e.txHash,
        timestamp: e.timestamp,
      });
    }
  }
  return out;
}
