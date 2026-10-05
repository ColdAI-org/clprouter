#!/usr/bin/env node
/**
 * Loads the demo (default: the local preview), clicks through the planner and the testnet explorer, and writes
 * screenshots to screenshots/. Exits non-zero if a check fails.
 *
 *   node scripts/screenshots.mjs [url]
 */
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const URL_ = process.argv[2] ?? "http://localhost:4173/";
const OUT = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "screenshots");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const errors = [];
const check = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) errors.push(msg);
};

async function desktop(scheme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: scheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(URL_, { waitUntil: "networkidle" });
  await page.screenshot({ path: join(OUT, `01-hero-${scheme}.png`) });

  // Planner: default route.
  await page.locator("#planner").scrollIntoViewIfNeeded();
  await page.waitForSelector(".res-title");
  check((await page.locator(".res-title").first().textContent()).includes("Ethereum"), `${scheme}: planner shows a route from Ethereum`);
  await page.locator("#planner").screenshot({ path: join(OUT, `02-planner-${scheme}.png`) });
  if (scheme === "dark") {
    await ctx.close();
    return;
  }

  // ISO 20022 filter on Ethereum -> Solana: no compliant route, with reasons.
  await page.getByLabel("ISO 20022").check();
  await page.waitForSelector("text=No compliant route");
  check(await page.locator(".reasons li").count() > 0, "ISO 20022 filter explains the exclusion");
  await page.locator("#planner").screenshot({ path: join(OUT, `03-planner-filter-excluded.png`) });
  await page.getByLabel("ISO 20022").uncheck();

  // Preset: Stellar -> XRPL, ISO 20022.
  await page.getByRole("button", { name: "Stellar → XRP Ledger, ISO 20022" }).click();
  await page.waitForSelector(".stats");
  check((await page.locator(".res-title").first().textContent()).includes("Stellar"), "ISO 20022 preset plans Stellar → XRP Ledger");
  await page.locator("#planner").screenshot({ path: join(OUT, `04-planner-iso20022.png`) });

  // What-if preset shows several candidates; select the second.
  await page.getByRole("button", { name: "Base → Stellar, what-if Channels" }).click();
  await page.waitForSelector("[data-route='1']");
  check(await page.locator("[data-route]").count() > 1, "what-if Channels give several candidate routes");
  await page.locator("[data-route='1']").click();
  await page.locator(".res-head .badge", { hasText: "Alternative" }).waitFor();
  await page.locator("#planner").screenshot({ path: join(OUT, `05-planner-whatif.png`) });

  // Chip picking: Bitcoin as origin.
  await page.getByRole("button", { name: /^From / }).click();
  await page.locator("#pl-q").fill("bitc");
  await page.locator(".chip", { hasText: /^Bitcoin$/ }).click();
  await page.locator("#pl-q").fill("");
  await page.waitForFunction(() => document.querySelector(".res-title")?.textContent?.includes("Bitcoin"));
  check(true, "chain chips set the origin");

  // Explorer.
  await page.goto(`${URL_}#testnet`, { waitUntil: "load" });
  await page.waitForFunction(
    () => document.querySelectorAll("#explorer-root [aria-busy]").length === 0 && document.querySelector("#ex-ct table"),
    null,
    { timeout: 60000 },
  );
  const channel = await page.locator("#ex-ch").textContent();
  check(/ACTIVE/.test(channel), "explorer: Channel status read live (ACTIVE)");
  const codeOk = await page.locator("#ex-ct .badge.ok").count();
  check(codeOk >= 10, `explorer: contract code present (${codeOk} badges)`);
  const ev = await page.locator("#ex-ev tbody tr").count();
  check(ev > 0, `explorer: ${ev} recent events decoded`);
  const ob = await page.locator("#ex-ob").textContent();
  check(/HBAR/.test(ob), "explorer: order book bond read live");
  await page.locator("#testnet").screenshot({ path: join(OUT, `06-testnet.png`) });

  await page.goto(`${URL_}#how`, { waitUntil: "load" });
  await page.waitForTimeout(3500);
  await page.locator("#how").screenshot({ path: join(OUT, `07-how-it-works.png`) });
  await ctx.close();
}

async function mobile() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(URL_, { waitUntil: "networkidle" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `mobile: no horizontal page scroll (${overflow}px)`);
  await page.screenshot({ path: join(OUT, "08-mobile-hero.png") });
  await page.locator("#planner").scrollIntoViewIfNeeded();
  await page.waitForSelector(".stats");
  await page.locator(".results").screenshot({ path: join(OUT, "09-mobile-planner.png") });
  await ctx.close();
}

await desktop("light");
await desktop("dark");
await mobile();
await browser.close();
if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`\nscreenshots in ${OUT}`);
