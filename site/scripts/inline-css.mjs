#!/usr/bin/env node
// Inlines the built stylesheet into dist/index.html so first paint needs no extra request.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dist = new URL("../dist/", import.meta.url).pathname;
let html = readFileSync(join(dist, "index.html"), "utf8");
html = html.replace(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"[^>]*>/, (_, href) => {
  const css = readFileSync(join(dist, href), "utf8");
  rmSync(join(dist, href));
  return `<style>${css}</style>`;
});
writeFileSync(join(dist, "index.html"), html);
