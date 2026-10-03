import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The services consume the planner SDK from source (sibling package, no build step needed).
    alias: { "@clprouter/sdk": fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts", "connector/test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // The integration test owns a single anvil; never run test files in parallel against it.
    fileParallelism: false,
  },
});
