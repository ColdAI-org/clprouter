import { describe, expect, it } from "vitest";
import { foldRegistry, keys, registryView, subjectIndex } from "../src/registry.js";
import { G, V, ev, h32, rid } from "./helpers.js";

const L = "eip155:31001";
const M1 = "0x00000000000000000000000000000000000000A1" as const;
const M2 = "0x00000000000000000000000000000000000000A2" as const;
const M3 = "0x00000000000000000000000000000000000000A3" as const;

describe("registry fold", () => {
  const certKey = h32("cert-hedera-iso");
  const edge = keys.edge(h32("AB"), "eip155:31002");
  const ledgerKey = keys.ledger("eip155:31003");
  const acct = "eip155:31001:0xBAD0000000000000000000000000000000000001";
  const caseId = h32("case-1");

  const events = [
    ev(L, G.applied(1, 1), { block: 1, log: 1 }),
    ev(L, G.cert({ certKey, ledgerId: "hedera:mainnet", label: 1, certified: true, effectiveFrom: 1000, expiry: 5000, version: 1 }), { block: 1, log: 0 }),
    ev(L, G.cert({ certKey, ledgerId: "hedera:mainnet", label: 1, certified: false, effectiveFrom: 3000, expiry: 0, version: 2 }), { block: 2 }),
    ev(L, G.disabled(1, edge, 2000), { block: 3, ts: 1100 }),
    ev(L, G.disabled(1, edge, 2600, true), { block: 4, ts: 1500 }), // renewal keeps disabledAt
    ev(L, G.disabled(2, ledgerKey, 9000), { block: 5, ts: 1500 }),
    ev(L, G.reenable(2, ledgerKey, 2500), { block: 6 }),
    ev(L, G.listed(keys.account(acct), acct, caseId, 4000), { block: 7, ts: 1200 }),
    ev(L, G.committee(1, [M1, M2, M3], 2), { block: 8 }),
    ev(L, G.contact("mailto:new@provider.example"), { block: 9 }),
    ev(L, G.applied(9, 8), { block: 9, log: 1 }),
  ];
  const vault = [
    ev(L, V.deposited(1, rid(1), caseId, 100n), { block: 10 }),
    ev(L, V.deposited(2, rid(2), caseId, 50n), { block: 11 }),
    ev(L, V.released(1, caseId, M1, 1), { block: 12 }),
  ];
  const snapshot = { blockNumber: 0, version: 0, epoch: 0, threshold: 3, members: [M1], contact: "mailto:old@provider.example" };
  const st = foldRegistry(L, events, vault, snapshot, null, (s) => subjectIndex({ ledgers: [{ id: "eip155:31003" }] }).get(s));

  it("tracks version, committee (k and k+1) and contact", () => {
    expect(st.version).toBe(9);
    expect(st.committee).toMatchObject({ epoch: 1, members: [M1, M2, M3], threshold: 2, disableThreshold: 3, source: "event" });
    expect(st.contact).toBe("mailto:new@provider.example");
  });

  it("applies certifications by effective time and keeps the full log", () => {
    expect(st.certificationLog).toHaveLength(2);
    const at = (t: number) => registryView(st, t).certifications;
    expect(at(500)).toEqual([]); // still in its notice period
    expect(registryView(st, 500).scheduledCertifications).toHaveLength(2);
    expect(at(1500)[0]).toMatchObject({ label: "ISO20022", certified: true, valid: true });
    expect(at(3500)[0]).toMatchObject({ certified: false, valid: false });
  });

  it("disables lapse and re-enable after notice", () => {
    const view = (t: number) => registryView(st, t).disabled.map((d) => d.kind);
    expect(view(1550)).toEqual(["EDGE", "LEDGER"]);
    const sw = registryView(st, 1550).disabled.find((d) => d.kind === "EDGE")!;
    expect(sw.disabledAt).toBe(1100); // renewed, not restarted
    expect(registryView(st, 1550).disabled.find((d) => d.kind === "LEDGER")!.target).toBe("ledger eip155:31003");
    expect(view(2550)).toEqual(["EDGE"]); // ledger re-enabled at 2500
    expect(view(2700)).toEqual([]); // edge lapsed at 2600
  });

  it("lists blacklist entries with case ids until they lapse or are delisted", () => {
    expect(registryView(st, 3000).blacklist).toEqual([expect.objectContaining({ caip10: acct, caseId, listedAt: 1200 })]);
    expect(registryView(st, 4000).blacklist).toEqual([]);
    const delisted = foldRegistry(L, [...events, ev(L, G.delisted(keys.account(acct), acct, caseId), { block: 20, ts: 1300 })], []);
    expect(registryView(delisted, 1250).blacklist).toHaveLength(1);
    expect(registryView(delisted, 1300).blacklist).toHaveLength(0);
  });

  it("accounts for quarantine vault holdings per case", () => {
    const q = registryView(st, 0).quarantine;
    expect(q.deposits.map((d) => [d.depositId, d.released, d.releaseKind ?? null])).toEqual([
      [1, true, "RECIPIENT"],
      [2, false, null],
    ]);
    expect(q.heldByCase).toEqual({ [caseId]: "50" });
  });

  it("falls back to the constructor snapshot for the committee", () => {
    const s = foldRegistry(L, [], [], snapshot);
    expect(s.committee).toMatchObject({ members: [M1], threshold: 3, disableThreshold: 4, source: "snapshot" });
    expect(s.contact).toBe("mailto:old@provider.example");
  });

  it("derives account keys case-insensitively like Caip.accountKey", () => {
    expect(keys.account("eip155:1:0xABC")).toBe(keys.account("eip155:1:0xabc"));
  });
});
