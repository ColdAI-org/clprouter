import "./styles.css";
import { initHow } from "./how";
import { initPlanner } from "./planner";

// Theme: system by default, a manual choice is remembered on this device.
const THEME_KEY = "clprouter-theme";
const html = document.documentElement;
const toggle = document.querySelector<HTMLButtonElement>("#theme-toggle")!;
function applyTheme(t: string | null): void {
  if (t === "light" || t === "dark") html.dataset.theme = t;
  else delete html.dataset.theme;
  const dark = t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  toggle.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  toggle.textContent = dark ? "☀" : "☾";
}
let saved: string | null = null;
try {
  saved = localStorage.getItem(THEME_KEY);
} catch {
  /* storage blocked */
}
applyTheme(saved);
toggle.addEventListener("click", () => {
  const dark = html.dataset.theme ? html.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore */
  }
});

// Current-section highlight in the nav.
const links = [...document.querySelectorAll<HTMLAnchorElement>(".nav a[href^='#']")];
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (es) => {
      for (const e of es) {
        if (!e.isIntersecting) continue;
        links.forEach((a) => a.toggleAttribute("aria-current", a.hash === `#${e.target.id}`));
      }
    },
    { rootMargin: "-40% 0px -55% 0px" },
  );
  document.querySelectorAll("main > section[id]").forEach((s) => io.observe(s));
}

void initPlanner(document.querySelector<HTMLElement>("#planner-root")!);
initHow();

// The explorer (and viem) load when the section comes near, or when the browser is idle.
let explorerLoaded = false;
function loadExplorer(): void {
  if (explorerLoaded) return;
  explorerLoaded = true;
  void import("./explorer").then((m) => m.initExplorer(document.querySelector<HTMLElement>("#explorer-root")!));
}
const exSection = document.querySelector("#testnet")!;
if ("IntersectionObserver" in window) {
  new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && loadExplorer(), { rootMargin: "600px" }).observe(exSection);
}
if (location.hash === "#testnet") loadExplorer();
const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
setTimeout(() => (idle ? idle(loadExplorer, { timeout: 4000 }) : loadExplorer()), 2500);
