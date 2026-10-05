import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Relative base so the same build serves from a Worker at "/" and from GitHub Pages at "/<repo>/".
export default defineConfig({
  base: "./",
  resolve: {
    alias: { "@sdk": fileURLToPath(new URL("../sdk/src", import.meta.url)) },
  },
  server: { fs: { allow: [".."] } },
  build: { target: "es2022", outDir: "dist", assetsInlineLimit: 0, chunkSizeWarningLimit: 400 },
});
