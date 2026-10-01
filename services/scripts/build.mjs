// SPDX-License-Identifier: MIT
// Bundle the services (and the SDK source they import) into one ESM file, dist/main.js, for the container image.
// Only Node built-ins stay external, so the runtime image needs no node_modules.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/main.js", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  legalComments: "linked",
  alias: { "@clprouter/sdk": fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url)) },
  // pg's optional native binding is never used.
  external: ["pg-native"],
  // CommonJS dependencies (pg, prom-client) call require() for built-ins.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
