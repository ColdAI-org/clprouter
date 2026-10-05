// Animated walkthroughs: a token moves between actors, one step at a time, with a caption per step.
import { esc } from "./ui";

interface Actor {
  id: string;
  label: string;
  sub: string;
  x: number;
  y: number;
  tone?: "hub" | "chain" | "app" | "off";
}

interface Step {
  from: string;
  to: string;
  text: string;
  /** Dashed: a proof or receipt crossing ledgers. */
  kind?: "call" | "msg" | "receipt" | "self";
}

interface Story {
  title: string;
  w: number;
  h: number;
  actors: Actor[];
  steps: Step[];
}

const ROUTED: Story = {
  title: "A routed message, Ledger A → Hiero → Ledger B",
  w: 720,
  h: 300,
  actors: [
    { id: "s", label: "Sender app", sub: "Ledger A", x: 80, y: 70, tone: "app" },
    { id: "ra", label: "CLPRouter", sub: "Ledger A", x: 80, y: 220, tone: "chain" },
    { id: "rh", label: "CLPRouter", sub: "Hiero (hub)", x: 360, y: 220, tone: "hub" },
    { id: "rb", label: "CLPRouter", sub: "Ledger B", x: 640, y: 220, tone: "chain" },
    { id: "d", label: "Receiving app", sub: "Ledger B", x: 640, y: 70, tone: "app" },
  ],
  steps: [
    { from: "s", to: "ra", kind: "call", text: "The sender calls send(route, mode, filters, deadline) and escrows the payment and fee budget." },
    { from: "ra", to: "ra", kind: "self", text: "Router A checks the filters, the trust floor, the blacklist and route safety before anything leaves." },
    { from: "ra", to: "rh", kind: "msg", text: "Hop 1 travels as a CLPR message over Channel 1; Hiero verifies Ledger A's state proof directly, with no bridge." },
    { from: "rh", to: "rh", kind: "self", text: "The Hiero Router re-checks every rule of the sender and takes its hop fee." },
    { from: "rh", to: "rb", kind: "msg", text: "Hop 2 travels over Channel 2 to Ledger B, verified the same way." },
    { from: "rb", to: "d", kind: "call", text: "Router B delivers the payload to the receiving app." },
    { from: "rb", to: "rh", kind: "receipt", text: "The result returns as an end-to-end receipt, hop by hop." },
    { from: "rh", to: "ra", kind: "receipt", text: "Back at the origin, Router A settles: payee and hop fees paid. Failed, expired or disabled routes are refunded." },
  ],
};

const SETTLE: Story = {
  title: "Settle on Hedera: pay on chain Y, be paid on chain X",
  w: 720,
  h: 320,
  actors: [
    { id: "u", label: "User wallet", sub: "chains X and Y", x: 90, y: 60, tone: "app" },
    { id: "c", label: "Connector", sub: "bonded, off-chain", x: 630, y: 60, tone: "off" },
    { id: "dy", label: "SettleDeposit", sub: "chain Y", x: 90, y: 250, tone: "chain" },
    { id: "b", label: "SettleOrderBook", sub: "Hedera", x: 360, y: 160, tone: "hub" },
    { id: "dx", label: "SettleDelivery", sub: "chain X", x: 630, y: 250, tone: "chain" },
  ],
  steps: [
    { from: "u", to: "c", kind: "call", text: "The wallet asks the Connector for a quote; the Connector signs it (EIP-712). Its digest is the order id." },
    { from: "u", to: "b", kind: "call", text: "The wallet reads the order book: Connector signer, free bond, active sources." },
    { from: "u", to: "dy", kind: "call", text: "The user deposits on chain Y. SettleDeposit pays the Connector and holds no funds." },
    { from: "dy", to: "b", kind: "msg", text: "A DEPOSIT message is proven to Hedera over CLPR. The order opens and reserves cover plus penalty from the bond." },
    { from: "c", to: "dx", kind: "call", text: "The Connector delivers on chain X; SettleDelivery pays the recipient and measures what arrived." },
    { from: "dx", to: "b", kind: "msg", text: "A DELIVERY message is proven to Hedera. It matches the order: DELIVERED, reservation freed." },
    { from: "b", to: "u", kind: "receipt", text: "Missed deadline? Anyone calls claimDefault and the user is paid cover plus penalty from the bond, on Hedera." },
  ],
};

export function initHow(): void {
  mount("#story-route", ROUTED);
  mount("#story-settle", SETTLE);
}

function mount(sel: string, story: Story): void {
  const host = document.querySelector<HTMLElement>(sel);
  if (!host) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pos = new Map(story.actors.map((a) => [a.id, a]));
  const edges = story.steps
    .map((s, i) => {
      const a = pos.get(s.from)!;
      const b = pos.get(s.to)!;
      if (s.kind === "self") return `<circle cx="${a.x}" cy="${a.y}" r="46" class="st-ring" data-i="${i}"/>`;
      return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="st-edge ${s.kind ?? "call"}" data-i="${i}"/>`;
    })
    .join("");
  const nodes = story.actors
    .map(
      (a) => `<g class="st-node ${a.tone ?? ""}" data-id="${a.id}">
        <rect x="${a.x - 74}" y="${a.y - 26}" width="148" height="52" rx="10"/>
        <text x="${a.x}" y="${a.y - 3}" class="st-l">${esc(a.label)}</text>
        <text x="${a.x}" y="${a.y + 15}" class="st-s">${esc(a.sub)}</text></g>`,
    )
    .join("");
  host.innerHTML = `
    <figure class="story">
      <svg viewBox="0 0 ${story.w} ${story.h}" role="img" aria-label="${esc(story.title)}">
        ${edges}${nodes}<circle r="9" class="st-token" cx="${story.actors[0]!.x}" cy="${story.actors[0]!.y}"/>
      </svg>
      <figcaption>
        <div class="st-ctrl">
          <button type="button" class="btn-ghost st-prev" aria-label="Previous step">◀</button>
          <button type="button" class="btn-ghost st-play" aria-pressed="false">Play</button>
          <button type="button" class="btn-ghost st-next" aria-label="Next step">▶</button>
          <span class="st-count muted" aria-hidden="true"></span>
        </div>
        <p class="st-text" aria-live="polite"></p>
      </figcaption>
      <ol class="st-list">${story.steps.map((s) => `<li>${esc(s.text)}</li>`).join("")}</ol>
    </figure>`;

  const svg = host.querySelector("svg")!;
  const token = host.querySelector<SVGCircleElement>(".st-token")!;
  const text = host.querySelector<HTMLElement>(".st-text")!;
  const count = host.querySelector<HTMLElement>(".st-count")!;
  const play = host.querySelector<HTMLButtonElement>(".st-play")!;
  const items = [...host.querySelectorAll<HTMLLIElement>(".st-list li")];
  let i = 0;
  let timer: number | undefined;
  let anim: number | undefined;

  const show = (n: number, animate: boolean) => {
    i = (n + story.steps.length) % story.steps.length;
    const s = story.steps[i]!;
    const a = pos.get(s.from)!;
    const b = pos.get(s.to)!;
    svg.querySelectorAll(".active").forEach((e) => e.classList.remove("active"));
    svg.querySelector(`[data-i="${i}"]`)?.classList.add("active");
    svg.querySelector(`[data-id="${s.from}"]`)?.classList.add("active");
    svg.querySelector(`[data-id="${s.to}"]`)?.classList.add("active");
    items.forEach((li, k) => li.classList.toggle("cur", k === i));
    text.textContent = `${i + 1}. ${s.text}`;
    count.textContent = `${i + 1} / ${story.steps.length}`;
    if (anim) cancelAnimationFrame(anim);
    if (!animate || reduce) {
      token.setAttribute("cx", String(b.x));
      token.setAttribute("cy", String(b.y));
      return;
    }
    const t0 = performance.now();
    const dur = 1100;
    const frame = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      let x = a.x + (b.x - a.x) * e;
      let y = a.y + (b.y - a.y) * e;
      if (s.kind === "self") {
        const ang = e * Math.PI * 2 - Math.PI / 2;
        x = a.x + 46 * Math.cos(ang);
        y = a.y + 46 * Math.sin(ang);
      }
      token.setAttribute("cx", x.toFixed(1));
      token.setAttribute("cy", y.toFixed(1));
      token.setAttribute("class", `st-token ${s.kind ?? "call"}`);
      if (p < 1) anim = requestAnimationFrame(frame);
    };
    anim = requestAnimationFrame(frame);
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    play.textContent = "Play";
    play.setAttribute("aria-pressed", "false");
  };
  const start = () => {
    stop();
    play.textContent = "Pause";
    play.setAttribute("aria-pressed", "true");
    show(i + 1, true);
    timer = window.setInterval(() => show(i + 1, true), 2600);
  };
  play.addEventListener("click", () => (timer ? stop() : start()));
  host.querySelector(".st-prev")!.addEventListener("click", () => {
    stop();
    show(i - 1, true);
  });
  host.querySelector(".st-next")!.addEventListener("click", () => {
    stop();
    show(i + 1, true);
  });
  show(0, false);

  // Autoplay while visible (not for reduced motion).
  if (!reduce && "IntersectionObserver" in window) {
    let user = false;
    host.addEventListener("click", () => (user = true), { capture: true });
    new IntersectionObserver((es) => {
      for (const e of es) {
        if (e.isIntersecting && !timer && !user) start();
        if (!e.isIntersecting && timer) stop();
      }
    }, { threshold: 0.4 }).observe(host);
  }
}
