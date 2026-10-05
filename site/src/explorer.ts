// Live testnet explorer: reads Sepolia (public JSON-RPC) and Hedera testnet (JSON-RPC relay + mirror node REST)
// straight from the browser. Every panel loads on its own and fails on its own.
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  stringToHex,
  type Abi,
} from "viem";
import { ORDER_BOOK_ABI, ROUTE_APP_ABI, ROUTER_ABI, SERVICE_ABI } from "./abi";
import {
  CHANNEL_ID,
  CHANNEL_V1_ID,
  CONTRACTS,
  NETS,
  ORDER_BOOK,
  ROUTE_APP,
  ROUTE_DELIVER_TX,
  ROUTE_ID,
  ROUTE_SEND_TX,
  ROUTER,
  SEPOLIA_LEDGER_LABEL,
  SERVICE,
  SETTLE_CLPR_CONNECTOR,
  SETTLE_DELIVERY,
  SETTLE_DEPOSIT,
  TEST_CONNECTOR,
  type Hex,
  type Net,
} from "./config";
import { ethCall, getCode, hederaLogs, rpc, sepoliaLogs, type RawLog } from "./rpc";
import { ago, esc, shortHex, utc } from "./ui";

const CHANNEL_STATUS = ["PENDING", "ACTIVE", "PAUSED", "CLOSING", "DRAINED", "CLOSED"];
const ROUTE_STATUS = ["NONE", "PENDING", "DELIVERED", "FAILED", "EXPIRED", "QUARANTINED"];
const HOP_STATE = ["NONE", "SEEN", "FORWARD_PENDING", "FORWARDED", "NACKED", "DONE"];
const ORDER_STATUS = ["NONE", "OPEN", "DELIVERED", "DEFAULTED", "CANCELLED", "REJECTED"];
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

async function call<T>(net: Net, to: Hex, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const ret = await ethCall(net, to, data);
  return decodeFunctionResult({ abi, functionName, data: ret } as never) as T;
}

const link = (href: string, text: string) => `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;
const addrLink = (net: Net, a: string, label?: string) =>
  link(NETS[net].addressUrl(a), `<code>${esc(label ?? shortHex(a))}</code>`);
const txLink = (net: Net, h: string) => link(NETS[net].txUrl(h), `<code>${esc(shortHex(h, 5))}</code>`);

/** Renders a panel: loading state, then content, or an error with a Retry button. */
function panel(host: HTMLElement, load: () => Promise<string>): void {
  const go = async () => {
    host.setAttribute("aria-busy", "true");
    host.innerHTML = `<div class="loading"><span class="spinner" aria-hidden="true"></span> Reading the chain…</div>`;
    try {
      host.innerHTML = await load();
    } catch (e) {
      host.innerHTML = `<div class="error">Could not read this right now: ${esc((e as Error).message ?? String(e))}. Public endpoints can be slow.
        <button type="button" class="btn-ghost retry">Retry</button></div>`;
      host.querySelector(".retry")?.addEventListener("click", go);
    } finally {
      host.removeAttribute("aria-busy");
    }
  };
  void go();
}

export function initExplorer(root: HTMLElement): void {
  root.innerHTML = `
    <div class="ex-grid">
      <section class="card" aria-labelledby="ex-net-h"><h3 class="card-title" id="ex-net-h">Endpoints</h3><div id="ex-net"></div></section>
      <section class="card" aria-labelledby="ex-ch-h"><h3 class="card-title" id="ex-ch-h">The Channel (v2) <code class="muted">${shortHex(CHANNEL_ID)}</code></h3><div id="ex-ch"></div></section>
      <section class="card" aria-labelledby="ex-rt-h"><h3 class="card-title" id="ex-rt-h">Route <code class="muted">${shortHex(ROUTE_ID, 4)}</code>: Sepolia → Hedera</h3>
        <p class="hint">Delivered over the first Channel <code>${shortHex(CHANNEL_V1_ID)}</code>, before the v2 Channel replaced it.</p><div id="ex-rt"></div></section>
      <section class="card" aria-labelledby="ex-ob-h"><h3 class="card-title" id="ex-ob-h">Settle on Hedera: order book (v2)</h3><div id="ex-ob"></div></section>
    </div>
    <section class="card" aria-labelledby="ex-ct-h"><h3 class="card-title" id="ex-ct-h">Canonical contracts</h3>
      <p class="hint">Code read live with <code>eth_getCode</code>; where the deployment record has a runtime code hash, the hash is checked too.
      Same CREATE2 address on both networks except the Router, whose per-ledger parameters come from the deployer.</p>
      <div id="ex-ct"></div></section>
    <section class="card" aria-labelledby="ex-ev-h"><h3 class="card-title" id="ex-ev-h">Recent CLPR and CLPRouter activity</h3>
      <p class="hint">Events of the CLPR Service, the Routers and the settle contracts since the deployment, decoded in the browser.</p>
      <div id="ex-ev"></div></section>`;

  const $ = (id: string) => root.querySelector<HTMLElement>(id)!;
  panel($("#ex-net"), loadNetworks);
  panel($("#ex-ch"), loadChannel);
  panel($("#ex-rt"), loadRoute);
  panel($("#ex-ob"), loadOrderBook);
  panel($("#ex-ct"), loadContracts);
  panel($("#ex-ev"), loadEvents);
}

async function loadNetworks(): Promise<string> {
  const row = async (net: Net) => {
    const t0 = performance.now();
    try {
      const b = BigInt(await rpc<Hex>(net, "eth_blockNumber", []));
      const ms = Math.round(performance.now() - t0);
      return `<tr><th scope="row">${NETS[net].name}</th><td>${b.toLocaleString("en-US")}</td><td>${ms} ms</td><td><span class="dotok" aria-hidden="true"></span> live</td></tr>`;
    } catch (e) {
      return `<tr><th scope="row">${NETS[net].name}</th><td>–</td><td>–</td><td class="err">${esc((e as Error).message)}</td></tr>`;
    }
  };
  const rows = await Promise.all([row("sepolia"), row("hedera")]);
  return `<div class="table-wrap"><table><thead><tr><th scope="col">Network</th><th scope="col">Latest block</th><th scope="col">Round trip</th><th scope="col">Status</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
    <p class="hint">Sepolia via <code>${new URL(NETS.sepolia.rpc[0]!).host}</code>; Hedera via the <code>${new URL(NETS.hedera.rpc[0]!).host}</code> relay and the mirror node.</p>`;
}

interface ChannelView {
  verifier: Hex;
  status: number;
  nextMessageId: bigint;
  ackedMessageId: bigint;
  receivedMessageId: bigint;
  chainId: string;
}

async function loadChannel(): Promise<string> {
  const side = async (net: Net) => {
    const c = await call<ChannelView>(net, SERVICE, SERVICE_ABI as Abi, "getChannel", [CHANNEL_ID]);
    const st = CHANNEL_STATUS[c.status] ?? String(c.status);
    const sent = c.nextMessageId > 0n ? c.nextMessageId - 1n : 0n;
    return `<div class="side">
      <div class="side-h">${NETS[net].name} <span class="badge ${st === "ACTIVE" ? "ok" : ""}">${st}</span></div>
      <dl class="kv">
        <dt>Peer ledger</dt><dd><code>${esc(c.chainId)}</code></dd>
        <dt>Messages sent</dt><dd>${sent.toString()}</dd>
        <dt>Messages received</dt><dd>${c.receivedMessageId.toString()}</dd>
        <dt>Acknowledged</dt><dd>${c.ackedMessageId.toString()}</dd>
        <dt>Verifier</dt><dd>${addrLink(net, c.verifier)}</dd>
      </dl></div>`;
  };
  const [s, h] = await Promise.allSettled([side("sepolia"), side("hedera")]);
  const show = (r: PromiseSettledResult<string>, net: Net) =>
    r.status === "fulfilled" ? r.value : `<div class="side"><div class="side-h">${NETS[net].name}</div><p class="error">${esc((r.reason as Error).message)}</p></div>`;
  return `<div class="sides">${show(s, "sepolia")}${show(h, "hedera")}</div>
    <p class="hint">One CLPR Channel joins exactly two ledgers. v2 replaced the first Channel <code>${shortHex(CHANNEL_V1_ID)}</code> (superseded) with a staged committee rotation; settle runs on v2. Read live with <code>getChannel</code> on the CLPR Service ${addrLink("sepolia", SERVICE)}.</p>`;
}

interface OriginRoute {
  sender: Hex;
  deadline: bigint;
  status: number;
  escrow: bigint;
  reclaimAt: bigint;
}

async function loadRoute(): Promise<string> {
  const key = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes16" }],
      [keccak256(stringToHex(SEPOLIA_LEDGER_LABEL)), keccak256(encodePacked(["address"], [ROUTER.sepolia])), ROUTE_ID],
    ),
  );
  const [origin, hop, delivered] = await Promise.allSettled([
    call<readonly unknown[]>("sepolia", ROUTER.sepolia, ROUTER_ABI as Abi, "routes", [ROUTE_ID]),
    call<number>("hedera", ROUTER.hedera, ROUTER_ABI as Abi, "hopState", [key]),
    call<bigint>("hedera", ROUTE_APP, ROUTE_APP_ABI as Abi, "deliveredCount"),
  ]);
  let o: OriginRoute | undefined;
  if (origin.status === "fulfilled") {
    const v = origin.value;
    o = { sender: v[0] as Hex, deadline: v[1] as bigint, status: Number(v[2]), escrow: v[10] as bigint, reclaimAt: v[9] as bigint };
  }
  const hs = hop.status === "fulfilled" ? HOP_STATE[Number(hop.value)] ?? String(hop.value) : undefined;
  const steps = [
    { done: !!o && o.status >= 1, t: "Sent on Sepolia", d: `${txLink("sepolia", ROUTE_SEND_TX)} · <code>Router.send</code> with escrow` },
    { done: hs === "DONE" || hs === "FORWARDED", t: "Proven and delivered on Hedera", d: `${txLink("hedera", ROUTE_DELIVER_TX)} · CLPR bundle verified on Hedera, Router hop ${hs ?? "?"}` },
    {
      done: delivered.status === "fulfilled" && delivered.value > 0n,
      t: "Destination app called",
      d: `${addrLink("hedera", ROUTE_APP, "TestnetRouteApp")} · delivered count ${delivered.status === "fulfilled" ? delivered.value.toString() : "?"}`,
    },
    {
      done: !!o && o.status >= 2,
      t: "Receipt back on Sepolia",
      d: `origin status <strong>${o ? ROUTE_STATUS[o.status] : "?"}</strong>. The Hiero → Sepolia leg waits on a Hiero state-proof source, so on testnet the origin settles through <code>reclaim</code> after the deadline${o ? ` (${utc(Number(o.deadline))})` : ""}.`,
    },
  ];
  return `<ol class="timeline">${steps
    .map((s) => `<li class="${s.done ? "done" : "wait"}"><span class="tl-dot" aria-hidden="true"></span><div><div class="tl-t">${s.t} <span class="sr-only">${s.done ? "(done)" : "(waiting)"}</span></div><div class="tl-d">${s.d}</div></div></li>`)
    .join("")}</ol>
    <p class="hint">Read live: <code>routes(routeId)</code> on the Sepolia Router, <code>hopState</code> on the Hedera Router, <code>deliveredCount()</code> on the app.</p>`;
}

interface ConnectorView {
  signer: Hex;
  registeredAt: bigint;
  shortfalls: number;
}

async function loadOrderBook(): Promise<string> {
  const ob = ORDER_BOOK_ABI as Abi;
  const n = <T,>(fn: string, args: unknown[] = []) => call<T>("hedera", ORDER_BOOK, ob, fn, args);
  const [penalty, withdrawDelay, grace, ttl, conn, bond, free, source, logs] = await Promise.allSettled([
    n<number>("PENALTY_BPS"),
    n<bigint>("WITHDRAW_DELAY"),
    n<bigint>("PROOF_GRACE"),
    n<bigint>("MAX_QUOTE_TTL"),
    n<readonly [Hex, Hex, bigint, bigint, number]>("connectors", [TEST_CONNECTOR]),
    n<readonly [bigint, bigint, bigint, bigint]>("bonds", [TEST_CONNECTOR, ZERO]),
    n<bigint>("freeCapacity", [TEST_CONNECTOR, ZERO]),
    n<readonly [Hex, Hex, Hex, bigint]>("sources", [CHANNEL_ID]),
    hederaLogs(ORDER_BOOK, 100),
  ]);
  if ([penalty, conn, bond].every((r) => r.status === "rejected")) throw (penalty as PromiseRejectedResult).reason;
  const v = <T,>(r: PromiseSettledResult<T>, f: (x: T) => string) => (r.status === "fulfilled" ? f(r.value) : "–");
  const hbar = (tinybar: bigint) => `${(Number(tinybar) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 4 })} HBAR`;
  const dur = (s: bigint) => (s >= 86400n ? `${Number(s) / 86400} d` : s >= 3600n ? `${Number(s) / 3600} h` : `${Number(s) / 60} min`);
  const c: ConnectorView | undefined =
    conn.status === "fulfilled" ? { signer: conn.value[0], registeredAt: conn.value[3], shortfalls: conn.value[4] } : undefined;

  const decoded = logs.status === "fulfilled" ? decodeAll(logs.value, "hedera") : [];
  const orders = decoded.filter((d) => d.name === "OrderOpened");
  let orderRows = "";
  if (orders.length) {
    const states = await Promise.allSettled(
      orders.slice(0, 10).map((o) => n<readonly unknown[]>("orders", [o.args.orderId])),
    );
    orderRows = orders
      .slice(0, 10)
      .map((o, i) => {
        const s = states[i]!;
        const st = s.status === "fulfilled" ? ORDER_STATUS[Number(s.value[1])] : "?";
        return `<tr><td><code>${shortHex(String(o.args.orderId))}</code></td><td>${st}</td><td>${hbar(o.args.owedOnDefault as bigint)}</td><td>${txLink("hedera", o.tx)}</td></tr>`;
      })
      .join("");
  }
  const activeAt = source.status === "fulfilled" ? Number(source.value[3]) : 0;
  const now = Date.now() / 1000;
  const srcState = !activeAt ? "not proposed" : activeAt > now ? `proposed, active from ${utc(activeAt)} (${Math.ceil((activeAt - now) / 3600)} h)` : `active since ${utc(activeAt)}`;

  return `<dl class="kv">
      <dt>Contract</dt><dd>${addrLink("hedera", ORDER_BOOK, "SettleOrderBook")}</dd>
      <dt>Parameters</dt><dd>penalty ${v(penalty, (x) => `${Number(x) / 100}%`)} · withdraw delay ${v(withdrawDelay, dur)} · proof grace ${v(grace, dur)} · max quote TTL ${v(ttl, dur)}</dd>
      <dt>Sepolia source</dt><dd>${srcState}</dd>
      <dt>Test Connector</dt><dd>${addrLink("hedera", TEST_CONNECTOR)} ${c && c.registeredAt > 0n ? `<span class="badge ok sm">registered</span> ${ago(Number(c.registeredAt))}` : ""}</dd>
      <dt>Bond (HBAR)</dt><dd>${v(bond, (b) => `total ${hbar(b[0])} · reserved ${hbar(b[1])} · pending withdraw ${hbar(b[2])}`)}</dd>
      <dt>Free capacity</dt><dd>${v(free, hbar)}${c ? ` · shortfalls ${c.shortfalls}` : ""}</dd>
      <dt>Deposit / Delivery</dt><dd>${addrLink("sepolia", SETTLE_DEPOSIT, "SettleDeposit")} · ${addrLink("sepolia", SETTLE_DELIVERY, "SettleDelivery")} (Sepolia)</dd>
    </dl>
    ${
      orders.length
        ? `<div class="table-wrap"><table><thead><tr><th scope="col">Order</th><th scope="col">Status</th><th scope="col">Owed on default</th><th scope="col">Opened</th></tr></thead><tbody>${orderRows}</tbody></table></div>`
        : `<p class="hint"><strong>Orders: none yet.</strong> The book is deployed and a Connector is bonded; the settle CLPR connector is registered on the v2 Channel on both networks, and the first order can open once the Sepolia source is active.</p>`
    }`;
}

async function loadContracts(): Promise<string> {
  const cells = await Promise.all(
    CONTRACTS.map(async (c) => {
      const one = async (net: Net, a?: Hex) => {
        if (!a) return `<td class="muted">–</td>`;
        try {
          const code = await getCode(net, a);
          const size = (code.length - 2) / 2;
          if (!size) return `<td><span class="badge warn sm">no code</span> ${addrLink(net, a)}</td>`;
          const match = c.codeHash ? keccak256(code) === c.codeHash : undefined;
          const tag = match === true ? `<span class="badge ok sm" title="runtime code hash matches the deployment record">code ✓ hash ✓</span>` : match === false ? `<span class="badge sm" title="code present; hash differs from the record">code ✓</span>` : `<span class="badge ok sm">code ✓</span>`;
          return `<td>${tag} ${addrLink(net, a)} <span class="muted">${size.toLocaleString("en-US")} B</span></td>`;
        } catch (e) {
          return `<td><span class="badge sm" title="${esc((e as Error).message)}">unreachable</span> ${addrLink(net, a)}</td>`;
        }
      };
      const [s, h] = await Promise.all([one("sepolia", c.sepolia), one("hedera", c.hedera)]);
      return `<tr${c.superseded ? ' class="superseded"' : ""}><th scope="row"><div>${esc(c.name)}${c.superseded ? ` <span class="badge sm" title="superseded ${esc(c.superseded)}">superseded</span>` : ""}</div><div class="muted small">${esc(c.group)}: ${esc(c.what)}</div></th>${s}${h}</tr>`;
    }),
  );
  return `<div class="table-wrap"><table class="contracts"><thead><tr><th scope="col">Contract</th><th scope="col">Sepolia (Etherscan)</th><th scope="col">Hedera testnet (HashScan)</th></tr></thead><tbody>${cells.join("")}</tbody></table></div>`;
}

interface Decoded {
  net: Net;
  name: string;
  args: Record<string, unknown>;
  tx: Hex;
  block: bigint;
  ts?: number;
  contract: string;
}

const ABIS: Array<[string, Abi]> = [
  ["Router", ROUTER_ABI as Abi],
  ["Order book", ORDER_BOOK_ABI as Abi],
  ["CLPR Service", SERVICE_ABI as Abi],
];

function contractName(a: string): string {
  const x = a.toLowerCase();
  if (x === SERVICE.toLowerCase()) return "CLPR Service";
  if (x === ROUTER.sepolia.toLowerCase() || x === ROUTER.hedera.toLowerCase()) return "ClprRouter";
  const c = CONTRACTS.find((k) => k.sepolia?.toLowerCase() === x || k.hedera?.toLowerCase() === x);
  return c?.name ?? shortHex(a);
}

function decodeAll(logs: RawLog[], net: Net): Decoded[] {
  const out: Decoded[] = [];
  for (const l of logs) {
    for (const [, abi] of ABIS) {
      try {
        const d = decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as { eventName: string; args: Record<string, unknown> };
        out.push({ net, name: d.eventName, args: d.args ?? {}, tx: l.transactionHash, block: l.blockNumber, ts: l.timestamp, contract: contractName(l.address) });
        break;
      } catch {
        /* next ABI */
      }
    }
  }
  return out;
}

/** One-line plain summary of an event, without payload bytes. */
function summary(d: Decoded): string {
  const a = d.args;
  const s = (k: string) => (a[k] === undefined ? "" : String(a[k]));
  switch (d.name) {
    case "RouteSent":
      return `route ${shortHex(s("routeId"), 4)} to <code>${esc(s("destinationLedger"))}</code>, message ${s("messageId")}`;
    case "RouteDelivered":
      return `route ${shortHex(s("routeId"), 4)} delivered to ${shortHex(s("application"), 4)}`;
    case "RouteForwarded":
      return `route ${shortHex(s("routeId"), 4)} hop ${s("hopIndex")}, message ${s("messageId")}`;
    case "ReceiptSent":
      return `receipt for route ${shortHex(s("routeId"), 4)}`;
    case "MessageQueued":
    case "MessageDispatched":
      return `message ${s("messageId") || s("id")}`;
    case "BundleProcessed":
      return `bundle on Channel ${shortHex(s("channelId"), 4)}`;
    case "ChannelRegistered":
    case "ChannelCompleted":
    case "ChannelStatusChanged":
      return `Channel ${shortHex(s("channelId"), 4)}${a.chainId ? ` with <code>${esc(s("chainId"))}</code>` : ""}`;
    case "ConnectorRegistered":
    case "BondPosted":
      return a.amount !== undefined ? `${(Number(a.amount as bigint) / 1e8).toLocaleString("en-US")} HBAR` : `connector ${shortHex(s("connectorId") || s("connector"), 4)}`;
    case "SourceProposed":
      return `active from ${utc(Number(a.activeAt as bigint))}`;
    case "OrderOpened":
      return `order ${shortHex(s("orderId"), 4)}`;
    default:
      return "";
  }
}

async function loadEvents(): Promise<string> {
  const [sep, hr, hs, ho] = await Promise.allSettled([
    sepoliaLogs([ROUTER.sepolia, SERVICE, SETTLE_DEPOSIT, SETTLE_DELIVERY, SETTLE_CLPR_CONNECTOR]),
    hederaLogs(ROUTER.hedera, 25),
    hederaLogs(SERVICE, 50),
    hederaLogs(ORDER_BOOK, 25),
  ]);
  const ok = <T,>(r: PromiseSettledResult<T[]>) => (r.status === "fulfilled" ? r.value : []);
  const events = [...decodeAll(ok(sep), "sepolia"), ...decodeAll([...ok(hr), ...ok(hs), ...ok(ho)], "hedera")]
    .filter((d) => !["OwnershipTransferred", "EconomicConfigurationUpdated", "LedgerConfigurationUpdated"].includes(d.name))
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  const failed = [sep, hr, hs, ho].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  if (!events.length && failed.length) throw failed[0]!.reason;
  const rows = events
    .slice(0, 40)
    .map(
      (d) => `<tr><td>${d.net === "sepolia" ? "Sepolia" : "Hedera"}</td><td><strong>${esc(d.name)}</strong><div class="muted small">${summary(d)}</div></td><td>${esc(d.contract)}</td><td>${d.ts ? `<time datetime="${new Date(d.ts * 1000).toISOString()}" title="${utc(d.ts)}">${ago(d.ts)}</time>` : d.block.toString()}</td><td>${txLink(d.net, d.tx)}</td></tr>`,
    )
    .join("");
  return `${failed.length ? `<p class="hint">Some sources did not answer (${failed.map((f) => esc((f.reason as Error).message)).join("; ")}); showing the rest.</p>` : ""}
    <div class="table-wrap"><table class="events"><thead><tr><th scope="col">Network</th><th scope="col">Event</th><th scope="col">Contract</th><th scope="col">When</th><th scope="col">Tx</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="hint">${events.length} events; newest 40 shown.</p>`;
}
