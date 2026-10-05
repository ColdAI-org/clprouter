// Route planner: the CLPRouter SDK planner running in the browser on the repo's route-graph data.
import { activeFilters, ledgerFilterFailures } from "@sdk/filters";
import { RouteGraph, edgeId } from "@sdk/graph";
import { hopQuote, type HopQuote } from "@sdk/metrics";
import { plan, type PlanResult } from "@sdk/planner";
import { buildRouteQuote, type RouteQuote } from "@sdk/quote";
import { trustRank, type Edge, type Filters, type Mode, type RouteGraphData, type TrustTier } from "@sdk/types";
import { WeightedGraph, yenKShortest } from "@sdk/yen";
import { esc, fmtKg, fmtPct, fmtTime, fmtUsd } from "./ui";

interface ChainChip {
  name: string;
  id: string | null;
  status: string | null;
  family: string | null;
  inGraph: boolean;
}

type Dataset = "measured" | "sample";

const HUB = "hedera:mainnet";
const TIER_LABEL: Record<TrustTier, string> = {
  "validity-proof": "validity proof",
  "light-client": "light client",
  committee: "committee",
  attested: "operator quorum",
};
const TIER_HELP: Record<TrustTier, string> = {
  "validity-proof": "a ZK validity proof of the source chain is verified",
  "light-client": "the source chain's full consensus is verified",
  committee: "a K-of-N committee or sampled validator subset signs",
  attested: "t-of-n operators vouch for the remote state",
};
const MODES: Array<{ id: Mode; label: string; help: string }> = [
  { id: "balanced", label: "Balanced", help: "Weighted cost, time, reliability and carbon" },
  { id: "cheapest", label: "Cheapest", help: "Lowest total fees (USD)" },
  { id: "fastest", label: "Fastest", help: "Lowest p90 time to delivery" },
  { id: "reliable", label: "Most reliable", help: "Highest chance of delivery, with a disjoint fallback" },
  { id: "greenest", label: "Greenest", help: "Lowest kgCO2e per message" },
];
/** What-if direct Channels: illustrative only. */
const WHATIF_SET = [
  "eip155:1",
  "eip155:8453",
  "eip155:42161",
  "eip155:10",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "stellar:pubnet",
  "xrpl:0",
];
const PRESETS: Array<{ label: string; origin: string; dest: string; mode: Mode; filters?: Filters; whatIf?: boolean }> = [
  { label: "Ethereum → Hedera (measured)", origin: "eip155:1", dest: "hedera:mainnet", mode: "balanced" },
  { label: "Ethereum → Solana (projected)", origin: "eip155:1", dest: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", mode: "balanced" },
  { label: "Stellar → XRP Ledger, ISO 20022", origin: "stellar:pubnet", dest: "xrpl:0", mode: "fastest", filters: { iso20022: true } },
  { label: "Bitcoin → Stellar, greenest + Energy", origin: "bip122:000000000019d6689c085ae165831e93", dest: "stellar:pubnet", mode: "greenest", filters: { energy: true } },
  { label: "Base → Stellar, what-if Channels", origin: "eip155:8453", dest: "stellar:pubnet", mode: "cheapest", whatIf: true },
];

interface State {
  dataset: Dataset;
  origin: string;
  dest: string;
  picking: "origin" | "dest";
  mode: Mode;
  iso: boolean;
  mica: boolean;
  energy: boolean;
  energyCap: string;
  maxHops: number;
  k: number;
  projected: boolean;
  whatIf: boolean;
  trustFloor: "" | TrustTier;
  selected: number;
  query: string;
}

const state: State = {
  dataset: "measured",
  origin: "eip155:1",
  dest: HUB,
  picking: "origin",
  mode: "balanced",
  iso: false,
  mica: false,
  energy: false,
  energyCap: "",
  maxHops: 3,
  k: 8,
  projected: true,
  whatIf: false,
  trustFloor: "",
  selected: 0,
  query: "",
};

let graphs: Record<Dataset, RouteGraphData> | undefined;
let chains: ChainChip[] = [];
let root: HTMLElement;

export async function initPlanner(container: HTMLElement): Promise<void> {
  root = container;
  const [m, s, c] = await Promise.all([
    import("./generated/graph-measured.json"),
    import("./generated/graph-sample.json"),
    import("./generated/chains.json"),
  ]);
  graphs = { measured: m.default as unknown as RouteGraphData, sample: s.default as unknown as RouteGraphData };
  chains = (c.default as { chains: ChainChip[] }).chains;
  renderShell();
  run();
}

function currentGraph(): RouteGraphData {
  const base = graphs![state.dataset];
  if (!state.whatIf) return base;
  return withWhatIf(base);
}

/** Adds illustrative direct Channels between a few chains, copying each source's measured verifier figures. */
function withWhatIf(base: RouteGraphData): RouteGraphData {
  const ids = new Set(base.ledgers.map((l) => l.id));
  const set = WHATIF_SET.filter((x) => ids.has(x));
  const hub = base.ledgers.find((l) => l.id === HUB)!;
  const toHub = new Map(base.edges.filter((e) => e.to === HUB && e.status === "active").map((e) => [e.from, e]));
  const extra: Edge[] = [];
  for (const a of set) {
    const src = toHub.get(a);
    if (!src) continue;
    for (const b of set) {
      if (a === b) continue;
      const dst = base.ledgers.find((l) => l.id === b)!;
      // Same verifier, run on the destination; cost pinned to what the bundle costs on Hiero.
      const costNative = (src.bundle.gas * hub.gasPriceNative * hub.nativeUsd) / dst.nativeUsd;
      extra.push({
        ...structuredClone(src),
        id: `whatif:${a}->${b}`,
        from: a,
        to: b,
        channelId: `whatif-${a}-${b}`,
        status: "active",
        bundle: { ...src.bundle, costNative, source: { kind: "synthetic", ref: "what-if Channel" } },
        synthetic: [...(src.synthetic ?? []), "what-if Channel (not deployed)"],
      });
    }
  }
  return { ...base, edges: [...base.edges, ...extra] };
}

function filtersOf(): Filters {
  const cap = Number(state.energyCap);
  return {
    iso20022: state.iso,
    mica: state.mica,
    energy: state.energy ? (state.energyCap && cap > 0 ? { capKgPerTx: cap } : true) : false,
  };
}

function nameOf(id: string): string {
  return graphs?.[state.dataset].ledgers.find((l) => l.id === id)?.name ?? chains.find((c) => c.id === id)?.name ?? id;
}

// ---------------------------------------------------------------------------------------------------------------

function renderShell(): void {
  root.innerHTML = `
  <div class="planner">
    <form class="controls card" id="pl-form" aria-label="Route request">
      <fieldset>
        <legend>Data</legend>
        <div class="seg" role="radiogroup" aria-label="Route graph">
          <label><input type="radio" name="dataset" value="measured" checked> Measured graph (86 chains)</label>
          <label><input type="radio" name="dataset" value="sample"> SDK sample graph</label>
        </div>
        <p class="hint" id="pl-data-note"></p>
      </fieldset>

      <fieldset>
        <legend>Origin and destination</legend>
        <div class="ends">
          <button type="button" class="end" id="pl-end-origin" aria-pressed="true"><span class="end-k">From</span><span class="end-v"></span></button>
          <button type="button" class="swap" id="pl-swap" aria-label="Swap origin and destination" title="Swap">⇄</button>
          <button type="button" class="end" id="pl-end-dest" aria-pressed="false"><span class="end-k">To</span><span class="end-v"></span></button>
        </div>
        <label class="search"><span class="sr-only">Filter chains</span><input id="pl-q" type="search" placeholder="Filter chains…" autocomplete="off"></label>
        <div class="chips" id="pl-chips" role="group" aria-label="Chains"></div>
        <p class="hint">Click a chain to set <strong id="pl-picking">the origin</strong>. Greyed chains have no
          CAIP-2 id or bundle figure yet, so they are not in the route graph.</p>
      </fieldset>

      <fieldset>
        <legend>Mode</legend>
        <div class="seg modes" role="radiogroup" aria-label="Routing mode">
          ${MODES.map((m) => `<label title="${esc(m.help)}"><input type="radio" name="mode" value="${m.id}" ${m.id === state.mode ? "checked" : ""}> ${m.label}</label>`).join("")}
        </div>
      </fieldset>

      <fieldset>
        <legend>Filters <span class="muted">(every ledger on the route must pass)</span></legend>
        <div class="checks">
          <label><input type="checkbox" name="iso"> ISO&nbsp;20022</label>
          <label><input type="checkbox" name="mica"> MiCA</label>
          <label><input type="checkbox" name="energy"> Energy</label>
          <label class="cap">cap <input type="number" name="energyCap" min="0" step="any" inputmode="decimal" placeholder="kgCO2e/tx" aria-label="Energy cap, kgCO2e per transaction"></label>
        </div>
      </fieldset>

      <details class="more">
        <summary>Constraints</summary>
        <div class="grid2">
          <label>Max hops <input type="number" name="maxHops" min="1" max="6" value="3"></label>
          <label>k paths per objective <input type="number" name="k" min="1" max="16" value="8"></label>
          <label>Trust floor
            <select name="trustFloor">
              <option value="">none</option>
              <option value="committee">committee</option>
              <option value="light-client">light client</option>
              <option value="validity-proof">validity proof</option>
            </select>
          </label>
        </div>
        <label class="row"><input type="checkbox" name="projected" checked> Include projected Hiero → chain Channels</label>
        <p class="hint">Chain → Hiero Channels are live-verified or family-covered; every Hiero → chain direction is
          projected until a Hiero state-proof source exists. Without them, only routes that end on Hiero plan.</p>
        <label class="row"><input type="checkbox" name="whatIf"> What-if: direct Channels between ${WHATIF_SET.length} chains</label>
        <p class="hint">Illustrative only: adds Channels that do not exist, reusing each source chain's verifier figures, to
          show how the planner ranks alternatives once the graph is more than a hub.</p>
      </details>

      <div class="presets" aria-label="Examples">
        <span class="muted">Try:</span>
        ${PRESETS.map((p, i) => `<button type="button" class="link-btn" data-preset="${i}">${esc(p.label)}</button>`).join("")}
      </div>
    </form>

    <div class="results" id="pl-results" aria-live="polite"></div>
  </div>`;

  const form = root.querySelector<HTMLFormElement>("#pl-form")!;
  form.addEventListener("submit", (e) => e.preventDefault());
  form.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === "pl-q") {
      state.query = t.value;
      renderChips();
      return;
    }
    readForm(form);
    state.selected = 0;
    run();
  });
  root.querySelector("#pl-end-origin")!.addEventListener("click", () => setPicking("origin"));
  root.querySelector("#pl-end-dest")!.addEventListener("click", () => setPicking("dest"));
  root.querySelector("#pl-swap")!.addEventListener("click", () => {
    [state.origin, state.dest] = [state.dest, state.origin];
    state.selected = 0;
    run();
  });
  root.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) =>
    b.addEventListener("click", () => {
      const p = PRESETS[Number(b.dataset.preset)]!;
      Object.assign(state, {
        dataset: "measured",
        origin: p.origin,
        dest: p.dest,
        mode: p.mode,
        iso: !!p.filters?.iso20022,
        mica: !!p.filters?.mica,
        energy: !!p.filters?.energy,
        energyCap: "",
        whatIf: !!p.whatIf,
        projected: true,
        selected: 0,
      });
      writeForm(form);
      run();
    }),
  );
  root.querySelector("#pl-chips")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-id]");
    if (!b || b.disabled) return;
    const id = b.dataset.id!;
    if (state.picking === "origin") {
      if (id === state.dest) state.dest = state.origin;
      state.origin = id;
      setPicking("dest", false);
    } else {
      if (id === state.origin) state.origin = state.dest;
      state.dest = id;
      setPicking("origin", false);
    }
    state.selected = 0;
    run();
  });
  writeForm(form);
}

function setPicking(p: "origin" | "dest", rerender = true): void {
  state.picking = p;
  if (rerender) renderEnds();
}

function readForm(f: HTMLFormElement): void {
  const fd = new FormData(f);
  state.dataset = (fd.get("dataset") as Dataset) ?? "measured";
  state.mode = (fd.get("mode") as Mode) ?? "balanced";
  state.iso = fd.has("iso");
  state.mica = fd.has("mica");
  state.energy = fd.has("energy");
  state.energyCap = String(fd.get("energyCap") ?? "");
  state.maxHops = clamp(Number(fd.get("maxHops")) || 3, 1, 6);
  state.k = clamp(Number(fd.get("k")) || 8, 1, 16);
  state.trustFloor = (fd.get("trustFloor") as State["trustFloor"]) ?? "";
  state.projected = fd.has("projected");
  state.whatIf = fd.has("whatIf");
  const ids = new Set(graphs![state.dataset].ledgers.map((l) => l.id));
  if (!ids.has(state.origin)) state.origin = "eip155:1";
  if (!ids.has(state.dest)) state.dest = HUB;
}

function writeForm(f: HTMLFormElement): void {
  const set = (name: string, v: boolean | string) => {
    f.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`).forEach((i) => {
      if (i instanceof HTMLInputElement && (i.type === "radio" || i.type === "checkbox")) {
        i.checked = i.type === "radio" ? i.value === v : Boolean(v);
      } else i.value = String(v);
    });
  };
  set("dataset", state.dataset);
  set("mode", state.mode);
  set("iso", state.iso);
  set("mica", state.mica);
  set("energy", state.energy);
  set("energyCap", state.energyCap);
  set("maxHops", String(state.maxHops));
  set("k", String(state.k));
  set("trustFloor", state.trustFloor);
  set("projected", state.projected);
  set("whatIf", state.whatIf);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function renderEnds(): void {
  const o = root.querySelector<HTMLButtonElement>("#pl-end-origin")!;
  const d = root.querySelector<HTMLButtonElement>("#pl-end-dest")!;
  o.querySelector(".end-v")!.textContent = nameOf(state.origin);
  d.querySelector(".end-v")!.textContent = nameOf(state.dest);
  o.setAttribute("aria-pressed", String(state.picking === "origin"));
  d.setAttribute("aria-pressed", String(state.picking === "dest"));
  o.setAttribute("aria-label", `From ${nameOf(state.origin)}: pick the origin`);
  d.setAttribute("aria-label", `To ${nameOf(state.dest)}: pick the destination`);
  root.querySelector("#pl-picking")!.textContent = state.picking === "origin" ? "the origin" : "the destination";
  renderChips();
}

function renderChips(): void {
  const g = graphs![state.dataset];
  const inThis = new Set(g.ledgers.map((l) => l.id));
  const list: ChainChip[] =
    state.dataset === "measured"
      ? [{ name: "Hedera (Hiero)", id: HUB, status: "hub", family: null, inGraph: true }, ...chains]
      : g.ledgers.map((l) => ({ name: l.name, id: l.id, status: null, family: null, inGraph: true }));
  const q = state.query.trim().toLowerCase();
  const html = list
    .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.id ?? "").toLowerCase().includes(q))
    .sort((a, b) => (a.id === HUB ? -1 : b.id === HUB ? 1 : a.name.localeCompare(b.name)))
    .map((c) => {
      const ok = !!c.id && inThis.has(c.id);
      const role = c.id === state.origin ? "origin" : c.id === state.dest ? "dest" : "";
      const tip = ok ? `${c.name} (${c.id})${c.status && c.status !== "hub" ? `, ${c.status}` : ""}` : `${c.name}: not in the route graph${c.status ? ` (${c.status})` : ""}`;
      return `<button type="button" class="chip ${role}" ${ok ? `data-id="${esc(c.id!)}"` : "disabled"} title="${esc(tip)}" aria-pressed="${role ? "true" : "false"}">${role === "origin" ? '<span aria-hidden="true">●</span> ' : role === "dest" ? '<span aria-hidden="true">◆</span> ' : ""}${esc(c.name)}${role ? `<span class="sr-only"> (${role === "origin" ? "origin" : "destination"})</span>` : ""}</button>`;
    })
    .join("");
  root.querySelector("#pl-chips")!.innerHTML = html || `<p class="muted">No chain matches “${esc(state.query)}”.</p>`;
}

// ---------------------------------------------------------------------------------------------------------------

function run(): void {
  renderEnds();
  const g = currentGraph();
  const note = root.querySelector("#pl-data-note")!;
  const active = g.edges.filter((e) => e.status === "active").length;
  note.innerHTML =
    state.dataset === "measured"
      ? `Repo data <code>sdk/data/edges.json</code> (as of ${esc(g.asOf ?? "")}): ${g.ledgers.length} ledgers in the graph, ${g.edges.length} Channel directions (${active} active).
         Bundle gas and calldata are measured by the CLPR verifier work; prices, Connectors, history and certifications are placeholders.`
      : `SDK sample graph <code>sdk/src/data/sample-graph.json</code>: ${g.ledgers.length} ledgers with provisional certifications. Sample data, not measurements.`;

  const t0 = performance.now();
  const req = {
    origin: state.origin,
    destination: state.dest,
    mode: state.mode,
    filters: filtersOf(),
    k: state.k,
    constraints: {
      maxHops: state.maxHops,
      allowProjected: state.projected,
      ...(state.trustFloor ? { trustFloor: state.trustFloor } : {}),
    },
  };
  let res: PlanResult;
  try {
    res = plan(g, req);
  } catch (e) {
    root.querySelector("#pl-results")!.innerHTML = `<div class="card error">Planner error: ${esc(String((e as Error).message))}</div>`;
    return;
  }
  const ms = performance.now() - t0;
  renderResults(g, res, ms);
}

function renderResults(g: RouteGraphData, res: PlanResult, ms: number): void {
  const out = root.querySelector<HTMLElement>("#pl-results")!;
  const excl = exclusions(g);
  const unfiltered = state.iso || state.mica || state.energy ? unfilteredBest(g) : undefined;

  if (!res.ok) {
    out.innerHTML = `
      <div class="card">
        <h3 class="res-title">${res.reason === "no-compliant-route" ? "No compliant route" : "No route"}</h3>
        <p class="muted">${esc(nameOf(state.origin))} → ${esc(nameOf(state.dest))}, ${esc(state.mode)}${activeFilters(filtersOf()).labels.length ? ` + ${activeFilters(filtersOf()).labels.join(" + ")}` : ""}. Planned in ${ms.toFixed(1)} ms.</p>
        <ul class="reasons">${res.details.slice(0, 12).map((d) => `<li>${esc(d)}</li>`).join("")}${res.details.length > 12 ? `<li class="muted">… and ${res.details.length - 12} more</li>` : ""}</ul>
        ${!state.projected && state.dest !== HUB ? `<p class="hint">Tip: enable “Include projected Hiero → chain Channels” under Constraints.</p>` : ""}
      </div>
      ${unfiltered ? explainExclusion(unfiltered, g) : ""}
      ${hubMap(g, undefined)}`;
    return;
  }

  const routes = kShortest(g, res.route);
  const paretoKeys = new Set(res.pareto.map((r) => r.key));
  const sel = routes[Math.min(state.selected, routes.length - 1)]!;
  const filt = res.filters.length ? ` + ${res.filters.map(filterName).join(" + ")}` : "";
  out.innerHTML = `
    <div class="card">
      <div class="res-head">
        <div>
          <h3 class="res-title">${esc(nameOf(state.origin))} → ${esc(nameOf(state.dest))}</h3>
          <p class="muted">${esc(MODES.find((m) => m.id === res.mode)!.label)}${esc(filt)} · ${res.candidates} candidate path${res.candidates === 1 ? "" : "s"} · Pareto set ${res.pareto.length} · planned in ${ms.toFixed(1)} ms by the SDK in your browser</p>
        </div>
        ${sel.key === res.route.key ? `<span class="badge accent">Planner's pick</span>` : `<span class="badge">Alternative</span>`}
      </div>
      ${totals(sel)}
      ${hopPath(sel)}
      ${hopTable(sel)}
      ${res.fallback && sel.key === res.route.key ? `<p class="hint">Disjoint fallback (${res.fallback.disjointness}-disjoint): ${res.fallback.route.ledgers.map((l) => esc(nameOf(l))).join(" → ")}</p>` : ""}
      ${provenance(sel)}
      ${res.warnings.length ? `<ul class="warn">${res.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
    </div>

    <div class="card">
      <h3 class="card-title">k-shortest routes by the mode's objective</h3>
      ${routes.length === 1 ? `<p class="hint">One path: every live Channel today runs to Hiero, so the measured graph is a hub and any two chains meet there. Turn on the what-if Channels to see the planner rank alternatives.</p>` : ""}
      <div class="table-wrap"><table class="routes">
        <thead><tr><th scope="col">Route</th><th scope="col">Fee</th><th scope="col">p90 time</th><th scope="col">kgCO2e</th><th scope="col">Success</th><th scope="col">Trust</th></tr></thead>
        <tbody>${routes
          .map(
            (r, i) => `<tr class="${i === state.selected ? "sel" : ""}">
              <td><button type="button" class="link-btn" data-route="${i}" aria-pressed="${i === state.selected}">${r.ledgers.map((l) => esc(short(nameOf(l)))).join(" → ")}</button>${r.key === res.route.key ? ' <span class="badge accent sm">pick</span>' : ""}${paretoKeys.has(r.key) ? ' <span class="badge sm" title="not dominated on fee, time, reliability and carbon">Pareto</span>' : ""}</td>
              <td>${fmtUsd(r.totals.costUsd)}</td><td>${fmtTime(r.totals.timeP90S)}</td><td>${fmtKg(r.totals.kgCO2e)}</td><td>${fmtPct(r.totals.successProbability)}</td><td>${tierBadge(r.effectiveTrustTier)}</td></tr>`,
          )
          .join("")}</tbody>
      </table></div>
    </div>

    ${unfiltered ? explainExclusion(unfiltered, g, res.route) : ""}
    ${excl.length ? exclusionList(excl) : ""}
    ${hubMap(g, sel)}`;

  out.querySelectorAll<HTMLButtonElement>("[data-route]").forEach((b) =>
    b.addEventListener("click", () => {
      state.selected = Number(b.dataset.route);
      renderResults(g, res, ms);
      out.querySelector<HTMLButtonElement>(`[data-route="${state.selected}"]`)?.focus();
    }),
  );
}

/**
 * The k shortest simple paths for the mode's objective, built from the SDK's own pieces (hop quotes, Yen's algorithm,
 * route quotes) with the same filters and constraints as plan(). The planner's pick is listed first.
 */
function kShortest(g: RouteGraphData, pick: RouteQuote): RouteQuote[] {
  const graph = new RouteGraph(g);
  const now = new Date();
  const filters = activeFilters(filtersOf());
  const ctx = { graph, filters, mode: state.mode, now, defaultKgPerTx: graph.maxCertifiedKgPerTx(now) };
  const bad = new Set(graph.ledgers().filter((l) => l.disabled || ledgerFilterFailures(l, filters, state.mode, now).length).map((l) => l.id));
  const quotes = new Map<string, HopQuote>();
  for (const e of graph.edges()) {
    if (e.disabled || bad.has(e.from) || bad.has(e.to)) continue;
    if (!(e.status === "active" || (e.status === "projected" && state.projected))) continue;
    if (state.trustFloor && trustRank(e.trustTier) < trustRank(state.trustFloor)) continue;
    const q = hopQuote(e, ctx);
    if (q) quotes.set(edgeId(e), q);
  }
  const weight = (q: HopQuote): number => {
    switch (state.mode) {
      case "fastest":
        return q.timeP90S;
      case "reliable":
        return -Math.log(Math.max(q.successProbability, 1e-12));
      case "greenest":
        return q.carbon.totalKg;
      default:
        return q.cost.totalUsd;
    }
  };
  const wg = new WeightedGraph([...quotes.values()].map((q) => ({ id: q.edgeId, from: q.from, to: q.to, weight: weight(q) })));
  const out: RouteQuote[] = [pick];
  let seen = 0;
  for (const p of yenKShortest(wg, state.origin, state.dest)) {
    if (++seen > 500 || out.length >= state.k) break;
    if (p.edges.length > state.maxHops) continue;
    const r = buildRouteQuote(p.edges.map((e) => quotes.get(e.id)!));
    if (r.key !== pick.key) out.push(r);
  }
  return out;
}

function filterName(f: string): string {
  return f === "ISO20022" ? "ISO 20022" : f === "MICA" ? "MiCA" : "Energy";
}

function short(n: string): string {
  return n.replace(" (Hiero)", "").replace(" C-Chain", "").replace(" Smart Chain", "");
}

function tierBadge(t: TrustTier): string {
  return `<span class="tier tier-${t}" title="${esc(TIER_HELP[t])}">${TIER_LABEL[t]}</span>`;
}

function totals(r: RouteQuote): string {
  const stat = (k: string, v: string, sub = "") => `<div class="stat"><div class="stat-k">${k}</div><div class="stat-v">${v}</div>${sub ? `<div class="stat-s">${sub}</div>` : ""}</div>`;
  return `<div class="stats">
    ${stat("Fee", fmtUsd(r.totals.costUsd), "USD, all hops")}
    ${stat("Time", fmtTime(r.totals.timeP90S), "p90 to delivery")}
    ${stat("Carbon", fmtKg(r.totals.kgCO2e), "kgCO2e per message")}
    ${stat("Success", fmtPct(r.totals.successProbability), "on-time delivery")}
    ${stat("Trust", TIER_LABEL[r.effectiveTrustTier], "weakest hop")}
  </div>`;
}

function hopPath(r: RouteQuote): string {
  const n = r.ledgers.length;
  const w = 640;
  const pad = 70;
  const step = n > 1 ? (w - 2 * pad) / (n - 1) : 0;
  const y = 54;
  const xs = r.ledgers.map((_, i) => pad + i * step);
  const segs = r.hops
    .map((h, i) => {
      const x1 = xs[i]! + 22;
      const x2 = xs[i + 1]! - 22;
      const proj = h.edgeId.startsWith("whatif:") || isProjected(h.edgeId);
      return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" class="hop-line${proj ? " proj" : ""}" marker-end="url(#arrow)"/>
        <text x="${(x1 + x2) / 2}" y="${y - 14}" class="hop-lbl">${esc(h.verifierFamily)}</text>
        <text x="${(x1 + x2) / 2}" y="${y + 24}" class="hop-sub">${TIER_LABEL[h.trustTier]}${proj ? " · projected" : ""}</text>`;
    })
    .join("");
  const nodes = r.ledgers
    .map((l, i) => {
      const cls = i === 0 ? "origin" : i === n - 1 ? "dest" : l === HUB ? "hub" : "mid";
      return `<g class="node ${cls}"><circle cx="${xs[i]}" cy="${y}" r="18"/><text x="${xs[i]}" y="${y + 50}" class="node-lbl">${esc(short(nameOf(l)))}</text></g>`;
    })
    .join("");
  return `<figure class="hops-fig">
    <svg viewBox="0 0 ${w} 120" role="img" aria-label="Route: ${esc(r.ledgers.map((l) => nameOf(l)).join(", then "))}">
      <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow-head"/></marker></defs>
      ${segs}${nodes}
      <circle r="5" class="token"><animateMotion dur="${1.6 * r.hops.length}s" repeatCount="indefinite" path="M${xs[0]},${y} L${xs[n - 1]},${y}"/></circle>
    </svg>
  </figure>`;
}

let projectedIds = new Set<string>();
function isProjected(edgeId: string): boolean {
  return projectedIds.has(edgeId);
}

function hopTable(r: RouteQuote): string {
  const g = currentGraph();
  projectedIds = new Set(g.edges.filter((e) => e.status === "projected").map((e) => e.id ?? `${e.channelId}:${e.from}->${e.to}`));
  return `<div class="table-wrap"><table class="hops">
    <caption class="sr-only">Hops of the selected route</caption>
    <thead><tr><th scope="col">Hop</th><th scope="col">Verifier</th><th scope="col">Trust</th><th scope="col">Fee</th><th scope="col">p90</th><th scope="col">kgCO2e</th><th scope="col">Bundle data</th></tr></thead>
    <tbody>${r.hops
      .map((h) => {
        const e = g.edges.find((x) => (x.id ?? `${x.channelId}:${x.from}->${x.to}`) === h.edgeId);
        const kind = e?.bundle.source?.kind ?? "synthetic";
        const status = e?.status === "projected" ? ' <span class="badge sm">projected</span>' : h.edgeId.startsWith("whatif:") ? ' <span class="badge sm">what-if</span>' : "";
        return `<tr><td>${esc(short(nameOf(h.from)))} → ${esc(short(nameOf(h.to)))}${status}</td><td><code>${esc(h.verifierFamily)}</code></td><td>${tierBadge(h.trustTier)}</td>
          <td>${fmtUsd(h.cost.totalUsd)}</td><td>${fmtTime(h.timeP90S)}</td><td>${fmtKg(h.carbon.totalKg)}</td>
          <td>${kind === "measured" ? `<span class="badge ok sm" title="${esc(e?.bundle.source?.ref ?? "")}">measured</span> ${e ? `${(e.bundle.gas / 1e6).toFixed(2)}M gas` : ""}` : `<span class="badge sm" title="${esc(e?.bundle.source?.ref ?? "")}">${esc(kind)}</span>`}</td></tr>`;
      })
      .join("")}</tbody></table></div>`;
}

function provenance(r: RouteQuote): string {
  const n = r.synthetic.length;
  return `<p class="hint prov">Figures are the repo's ${state.dataset === "measured" ? "measured/sample route data" : "sample data"}: ${n} placeholder field${n === 1 ? "" : "s"} on this route (Connector margins, prices, history, timing where unstated). Hover a badge for its source.</p>`;
}

interface Excl {
  id: string;
  reasons: string[];
}

function exclusions(g: RouteGraphData): Excl[] {
  const f = activeFilters(filtersOf());
  if (!f.labels.length) return [];
  const graph = new RouteGraph(g);
  const now = new Date();
  return graph
    .ledgers()
    .map((l) => ({ id: l.id, reasons: ledgerFilterFailures(l, f, state.mode, now) }))
    .filter((x) => x.reasons.length);
}

function exclusionList(ex: Excl[]): string {
  const total = graphs![state.dataset].ledgers.length;
  return `<details class="card excl">
    <summary><strong>${ex.length} of ${total} ledgers excluded by the filters</strong> <span class="muted">(why)</span></summary>
    <ul class="reasons">${ex.map((x) => `<li><strong>${esc(nameOf(x.id))}</strong>: ${x.reasons.map((r) => esc(r.replace(/^[A-Z0-9]+: /, ""))).join("; ")}</li>`).join("")}</ul>
  </details>`;
}

function unfilteredBest(g: RouteGraphData): RouteQuote | undefined {
  const r = plan(g, {
    origin: state.origin,
    destination: state.dest,
    mode: state.mode,
    k: state.k,
    constraints: { maxHops: state.maxHops, allowProjected: state.projected, ...(state.trustFloor ? { trustFloor: state.trustFloor } : {}) },
  });
  return r.ok ? r.route : undefined;
}

function explainExclusion(best: RouteQuote, g: RouteGraphData, chosen?: RouteQuote): string {
  if (chosen && chosen.key === best.key) {
    return `<div class="card note"><p><strong>Filters did not change the pick.</strong> The unfiltered ${esc(state.mode)} route is already compliant: every ledger on it passes.</p></div>`;
  }
  const f = activeFilters(filtersOf());
  const graph = new RouteGraph(g);
  const now = new Date();
  const fails = best.ledgers
    .map((l) => ({ l, r: ledgerFilterFailures(graph.ledger(l), f, state.mode, now) }))
    .filter((x) => x.r.length);
  return `<div class="card note">
    <h3 class="card-title">Why the unfiltered route is excluded</h3>
    <p>Without filters the ${esc(state.mode)} route would be <strong>${best.ledgers.map((l) => esc(nameOf(l))).join(" → ")}</strong> (${fmtUsd(best.totals.costUsd)}, ${fmtTime(best.totals.timeP90S)}).</p>
    <ul class="reasons">${fails.map((x) => `<li><strong>${esc(nameOf(x.l))}</strong>: ${x.r.map(esc).join("; ")}</li>`).join("")}</ul>
  </div>`;
}

/** Radial overview: Hiero in the centre, every ledger on a ring, the selected route highlighted. */
function hubMap(g: RouteGraphData, r: RouteQuote | undefined): string {
  const others = g.ledgers.filter((l) => l.id !== HUB);
  const size = 420;
  const c = size / 2;
  const R = 170;
  const pos = new Map<string, [number, number]>([[HUB, [c, c]]]);
  others.forEach((l, i) => {
    const a = (i / others.length) * Math.PI * 2 - Math.PI / 2;
    pos.set(l.id, [c + R * Math.cos(a), c + R * Math.sin(a)]);
  });
  const live = new Set(g.edges.filter((e) => e.status === "active" && e.to === HUB).map((e) => e.from));
  const spokes = others
    .map((l) => {
      const [x, y] = pos.get(l.id)!;
      return `<line x1="${c}" y1="${c}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="spoke${live.has(l.id) ? " live" : ""}"/>`;
    })
    .join("");
  const onRoute = new Set(r?.ledgers ?? []);
  const dots = others
    .map((l) => {
      const [x, y] = pos.get(l.id)!;
      const cls = l.id === state.origin ? "origin" : l.id === state.dest ? "dest" : onRoute.has(l.id) ? "mid" : live.has(l.id) ? "live" : "";
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${cls && cls !== "live" ? 7 : 4}" class="dot ${cls}"><title>${esc(l.name)}${live.has(l.id) ? " (live chain → Hiero Channel)" : " (projected)"}</title></circle>`;
    })
    .join("");
  const path = r
    ? `<polyline points="${r.ledgers.map((l) => pos.get(l)!.map((v) => v.toFixed(1)).join(",")).join(" ")}" class="route-line"/>`
    : "";
  const label = (id: string, cls: string) => {
    const p = pos.get(id);
    if (!p || id === HUB) return "";
    const [x, y] = p;
    const anchor = x < c - 10 ? "end" : x > c + 10 ? "start" : "middle";
    const dx = anchor === "end" ? -12 : anchor === "start" ? 12 : 0;
    const dy = y < c ? -10 : 18;
    return `<text x="${(x + dx).toFixed(1)}" y="${(y + dy).toFixed(1)}" text-anchor="${anchor}" class="map-lbl ${cls}">${esc(short(nameOf(id)))}</text>`;
  };
  return `<div class="card">
    <h3 class="card-title">The graph today</h3>
    <figure class="hubmap">
      <svg viewBox="-70 -10 ${size + 140} ${size + 20}" role="img" aria-label="Hub diagram: ${others.length} ledgers around Hiero; ${live.size} have a live chain to Hiero Channel">
        ${spokes}${path}${dots}
        <circle cx="${c}" cy="${c}" r="20" class="dot hub"/><text x="${c}" y="${c + 4}" text-anchor="middle" class="hub-lbl">Hiero</text>
        ${label(state.origin, "origin")}${label(state.dest, "dest")}
      </svg>
      <figcaption>${others.length} ledgers around the Hiero hub. Solid spokes: chain → Hiero Channels with a verifier (${live.size}); faint: projected. Orange: the selected route.</figcaption>
    </figure>
  </div>`;
}

