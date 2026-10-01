import type { Address, Hex } from "viem";
import { encodePacked, keccak256 } from "viem";
import type { IndexedEvent } from "./events.js";
import type { RegistrySnapshot } from "./indexer.js";
import type { Cursor, Store } from "./store.js";

export interface CertEntry {
  certKey: Hex;
  ledgerId: string;
  label: string;
  certified: boolean;
  effectiveFrom: number;
  expiry: number;
  /** ENERGY only: µgCO2e per transaction. */
  emissionsUg: number;
  emissionsSource: string;
  version: number;
  evidenceHash: Hex;
  digest: Hex;
  txHash: Hex;
}

export interface SwitchEntry {
  subject: Hex;
  kind: string;
  /** What the subject key resolves to, when it matches a known ledger, edge, Router or version. */
  target?: string;
  disabledAt: number;
  lapseAt: number;
  reenableAt: number;
  reason: string;
  evidenceHash: Hex;
  txHash: Hex;
}

export interface ListingEntry {
  accountKey: Hex;
  caip10: string;
  caseId: Hex;
  listedAt: number;
  lapseAt: number;
  reason: string;
  evidenceHash: Hex;
  txHash: Hex;
}

export interface Committee {
  epoch: number;
  members: Address[];
  threshold: number;
  /** Signatures a disable, blacklist entry, delisting, recovery naming or Router binding needs (k + 1). */
  disableThreshold: number;
  /** Signatures a committee change or a challenged-recovery override needs: max(k + 1, ceil(2n / 3)). */
  committeeThreshold: number;
  source: "event" | "snapshot";
}

/** A committee change signed but not yet taken over (`ProviderRegistry.pendingCommittee`). */
export interface PendingCommittee {
  epoch: number;
  members: Address[];
  threshold: number;
  /** Earliest take-over time; the new committee takes over with the first decision it signs. */
  activatesAt: number;
}

/** max(k + 1, ceil(2n / 3)), as `ProviderRegistry` requires for committee changes. */
export function supermajority(k: number, n: number): number {
  return Math.max(k + 1, Math.ceil((2 * n) / 3));
}

function committeeOf(epoch: number, members: Address[], threshold: number, source: Committee["source"]): Committee {
  return {
    epoch,
    members,
    threshold,
    disableThreshold: threshold + 1,
    committeeThreshold: supermajority(threshold, members.length),
    source,
  };
}

export interface DepositEntry {
  depositId: number;
  routeId: Hex;
  caseId: Hex;
  depositor: Address;
  sender: Address;
  recipient: Address;
  amount: string;
  released: boolean;
  releasedTo?: Address;
  releaseKind?: string;
  txHash: Hex;
}

/** Registry state of one ledger, folded from its confirmed events. */
export interface LedgerRegistryState {
  ledger: string;
  /** Confirmed block the state is as of. */
  cursor: Cursor | null;
  /** Registry version (decisions applied). */
  version: number;
  /**
   * Head of the decision hash chain after `version` (the digest of the last applied decision); null when only a
   * snapshot is known. Two ledgers at the same version agree on the registry state iff their heads are equal.
   */
  head: Hex | null;
  contact: string | null;
  committee: Committee | null;
  pendingCommittee: PendingCommittee | null;
  /** Full certification log (append-only), oldest first. */
  certificationLog: CertEntry[];
  switches: SwitchEntry[];
  listings: ListingEntry[];
  deposits: DepositEntry[];
  /**
   * Recovery address per case. `challenged` is true when a party of any deposit of the case challenged the current
   * address; `challenges` lists them (a challenge binds only its own deposit and is never cleared by a renaming).
   */
  recoveries: {
    caseId: Hex;
    to: Address;
    releasableAt: number;
    challenged: boolean;
    challenges: { depositId: number; by: Address; to: Address }[];
  }[];
}

const s = (v: unknown) => String(v);
const n = (v: unknown) => Number(v);

/** Fold the confirmed registry and vault events of one ledger into its current registry state. */
export function foldRegistry(
  ledger: string,
  registryEvents: IndexedEvent[],
  vaultEvents: IndexedEvent[],
  snapshot?: RegistrySnapshot,
  cursor: Cursor | null = null,
  resolve: (subject: Hex) => string | undefined = () => undefined,
): LedgerRegistryState {
  const st: LedgerRegistryState = {
    ledger,
    cursor,
    version: snapshot?.version ?? 0,
    head: null,
    contact: snapshot?.contact ?? null,
    committee: snapshot ? committeeOf(snapshot.epoch, snapshot.members, snapshot.threshold, "snapshot") : null,
    pendingCommittee: null,
    certificationLog: [],
    switches: [],
    listings: [],
    deposits: [],
    recoveries: [],
  };
  const switches = new Map<string, SwitchEntry>();
  const listings = new Map<string, ListingEntry>();
  let versionFromEvents = 0;

  for (const e of registryEvents) {
    const a = e.args;
    switch (e.name) {
      case "DecisionApplied":
        if (n(a.version) >= versionFromEvents) {
          versionFromEvents = n(a.version);
          st.head = (a.digest as Hex) ?? null; // the digest of decision N is the head after N
        }
        break;
      case "CertificationScheduled":
        st.certificationLog.push({
          certKey: a.certKey as Hex,
          ledgerId: s(a.ledgerId),
          label: s(a.labelName),
          certified: Boolean(a.certified),
          effectiveFrom: n(a.effectiveFrom),
          expiry: n(a.expiry),
          emissionsUg: n(a.emissionsUg),
          emissionsSource: s(a.emissionsSource),
          version: n(a.version),
          evidenceHash: a.evidenceHash as Hex,
          digest: a.digest as Hex,
          txHash: e.txHash,
        });
        break;
      case "RouteDisabled": {
        const subject = s(a.subject).toLowerCase() as Hex;
        const prev = switches.get(subject);
        const renewed = Boolean(a.renewed);
        switches.set(subject, {
          subject,
          kind: s(a.kindName),
          target: resolve(subject),
          disabledAt: renewed && prev ? prev.disabledAt : e.timestamp,
          lapseAt: n(a.lapseAt),
          reenableAt: 0,
          reason: s(a.reason),
          evidenceHash: a.evidenceHash as Hex,
          txHash: e.txHash,
        });
        break;
      }
      case "RouteReenableScheduled": {
        const sw = switches.get(s(a.subject).toLowerCase());
        if (sw && n(a.reenableAt) > 0) sw.reenableAt = n(a.reenableAt);
        break;
      }
      case "AccountBlacklisted": {
        const key = s(a.accountKey).toLowerCase();
        const prev = listings.get(key);
        const renewed = Boolean(a.renewed);
        listings.set(key, {
          accountKey: key as Hex,
          caip10: s(a.caip10),
          caseId: a.caseId as Hex,
          listedAt: renewed && prev ? prev.listedAt : e.timestamp,
          lapseAt: n(a.lapseAt),
          reason: s(a.reason),
          evidenceHash: a.evidenceHash as Hex,
          txHash: e.txHash,
        });
        break;
      }
      case "AccountDelisted": {
        const l = listings.get(s(a.accountKey).toLowerCase());
        if (l && Boolean(a.applied)) l.lapseAt = e.timestamp;
        break;
      }
      case "CommitteeScheduled":
        // A later schedule replaces an earlier one that has not taken over.
        st.pendingCommittee = {
          epoch: n(a.epoch),
          members: a.members as Address[],
          threshold: n(a.threshold),
          activatesAt: n(a.activatesAt),
        };
        break;
      case "CommitteeChanged": {
        const epoch = n(a.epoch);
        if (!st.committee || epoch >= st.committee.epoch) {
          st.committee = committeeOf(epoch, a.members as Address[], n(a.threshold), "event");
        }
        if (st.pendingCommittee && st.pendingCommittee.epoch <= epoch) st.pendingCommittee = null;
        break;
      }
      case "ContactChanged":
        // The snapshot is read at the head; an event at or below it is older unless no snapshot exists.
        if (!snapshot || e.blockNumber > snapshot.blockNumber) st.contact = s(a.contact);
        break;
    }
  }
  st.version = Math.max(st.version, versionFromEvents);
  st.switches = [...switches.values()];
  st.listings = [...listings.values()];

  const deposits = new Map<number, DepositEntry>();
  const recoveries = new Map<string, LedgerRegistryState["recoveries"][number]>();
  const challenges = new Map<string, { depositId: number; by: Address; to: Address }[]>();
  for (const e of vaultEvents) {
    const a = e.args;
    if (e.name === "Deposited") {
      deposits.set(n(a.depositId), {
        depositId: n(a.depositId),
        routeId: a.routeId as Hex,
        caseId: a.caseId as Hex,
        depositor: a.depositor as Address,
        sender: a.sender as Address,
        recipient: a.recipient as Address,
        amount: s(a.amount),
        released: false,
        txHash: e.txHash,
      });
    } else if (e.name === "Released") {
      const d = deposits.get(n(a.depositId));
      if (d) {
        d.released = true;
        d.releasedTo = a.to as Address;
        d.releaseKind = s(a.kindName);
      }
    } else if (e.name === "RecoveryNamed") {
      recoveries.set(s(a.caseId), {
        caseId: a.caseId as Hex,
        to: a.to as Address,
        releasableAt: n(a.releasableAt),
        challenged: false,
        challenges: [],
      });
    } else if (e.name === "RecoveryChallenged") {
      const list = challenges.get(s(a.caseId)) ?? [];
      // Older vaults emitted (caseId, by, evidenceHash) only: the challenge then applies to the named address.
      const to = (a.to as Address | undefined) ?? recoveries.get(s(a.caseId))?.to;
      if (to) list.push({ depositId: a.depositId === undefined ? 0 : n(a.depositId), by: a.by as Address, to });
      challenges.set(s(a.caseId), list);
    }
  }
  st.deposits = [...deposits.values()];
  for (const r of recoveries.values()) {
    const lower = r.to.toLowerCase();
    r.challenges = (challenges.get(r.caseId) ?? []).filter((c) => c.to.toLowerCase() === lower);
    r.challenged = r.challenges.length > 0;
  }
  st.recoveries = [...recoveries.values()];
  return st;
}

// ── Point-in-time views (mirror the contract's view functions) ────────────

/** `ProviderRegistry.isDisabled` at `now`. */
export function switchActive(sw: SwitchEntry, now: number): boolean {
  if (now >= sw.lapseAt) return false;
  return sw.reenableAt === 0 || now < sw.reenableAt;
}

/** `ProviderRegistry.blacklisted` at `now`. */
export function listingActive(l: ListingEntry, now: number): boolean {
  return now < l.lapseAt;
}

/** Certification in effect at `now` for each (ledger, label): the newest entry whose notice period has passed. */
export function certificationsInEffect(
  log: CertEntry[],
  now: number,
): (CertEntry & { valid: boolean })[] {
  const latest = new Map<string, CertEntry>();
  for (const c of log) {
    if (c.effectiveFrom > now) continue;
    latest.set(c.certKey, c); // log is in version order: the newest entry already in effect wins, as on-chain
  }
  return [...latest.values()].map((c) => ({ ...c, valid: c.certified && now < c.expiry }));
}

/** Entries appended but not yet effective (still in their notice period). */
export function scheduledCertifications(log: CertEntry[], now: number): CertEntry[] {
  return log.filter((c) => c.effectiveFrom > now);
}

// ── Registry keys (mirror Caip.sol) ───────────────────────────────────────

export const keys = {
  ledger: (ledgerId: string): Hex => keccak256(encodePacked(["string", "string"], ["ledger", ledgerId])),
  edge: (channelId: Hex, toLedgerId: string): Hex =>
    keccak256(encodePacked(["string", "bytes32", "string"], ["edge", channelId, toLedgerId])),
  router: (ledgerId: string, router: Address): Hex =>
    keccak256(encodePacked(["string", "string", "string", "bytes"], ["router", ledgerId, ":", router])),
  routerVersion: (v: number): Hex => keccak256(encodePacked(["string", "uint32"], ["router-version", v])),
  account: (caip10: string): Hex => keccak256(encodePacked(["string", "string"], ["account", asciiLower(caip10)])),
};

/** ASCII-only lower-casing, exactly like `Caip.lower` (non-ASCII bytes are left alone). */
export function asciiLower(x: string): string {
  return x.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Map of registry subject keys to readable targets, for the ledgers, edges and Routers a deployment knows. */
export function subjectIndex(input: {
  ledgers: { id: string; router?: Address }[];
  edges?: { channelId: string; from: string; to: string }[];
  routerVersions?: number[];
}): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of input.ledgers) {
    m.set(keys.ledger(l.id), `ledger ${l.id}`);
    if (l.router) m.set(keys.router(l.id, l.router), `router ${l.id}:${l.router.toLowerCase()}`);
  }
  for (const e of input.edges ?? []) {
    if (/^0x[0-9a-fA-F]{64}$/.test(e.channelId)) m.set(keys.edge(e.channelId as Hex, e.to), `edge ${e.from}->${e.to} (${e.channelId})`);
  }
  for (const v of input.routerVersions ?? []) m.set(keys.routerVersion(v), `router version ${v}`);
  return m;
}

/** Load and fold one ledger's registry from the store. */
export function loadRegistry(
  store: Store,
  ledger: string,
  resolve?: (subject: Hex) => string | undefined,
): LedgerRegistryState {
  return foldRegistry(
    ledger,
    store.eventsByContract("registry", ledger),
    store.eventsByContract("vault", ledger),
    store.getKv<RegistrySnapshot>(ledger, "registrySnapshot"),
    store.getCursor(ledger) ?? null,
    resolve,
  );
}

/** The `/registry` view at `now`: current certifications, active disables and listings, committee. */
export function registryView(st: LedgerRegistryState, now: number) {
  return {
    ledger: st.ledger,
    asOf: st.cursor,
    version: st.version,
    head: st.head,
    contact: st.contact,
    committee: st.committee,
    pendingCommittee: st.pendingCommittee,
    certifications: certificationsInEffect(st.certificationLog, now),
    scheduledCertifications: scheduledCertifications(st.certificationLog, now),
    disabled: st.switches.filter((x) => switchActive(x, now)),
    reenableScheduled: st.switches.filter((x) => switchActive(x, now) && x.reenableAt > 0),
    blacklist: st.listings.filter((x) => listingActive(x, now)),
    quarantine: {
      deposits: st.deposits,
      heldByCase: holdingsByCase(st.deposits),
      recoveries: st.recoveries,
    },
  };
}

function holdingsByCase(ds: DepositEntry[]): Record<string, string> {
  const out: Record<string, bigint> = {};
  for (const d of ds) if (!d.released) out[d.caseId] = (out[d.caseId] ?? 0n) + BigInt(d.amount);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.toString()]));
}
