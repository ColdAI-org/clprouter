// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

describe("container build files", () => {
  const dockerfile = read("Dockerfile");

  it("pins every base image by digest", () => {
    const arg = dockerfile.match(/^ARG NODE_IMAGE=(\S+)$/m)?.[1];
    expect(arg).toMatch(/^node:[\w.-]+@sha256:[0-9a-f]{64}$/);
    for (const m of dockerfile.matchAll(/^FROM\s+(\S+)/gm)) expect(m[1]).toBe("${NODE_IMAGE}");
    const compose = read("docker-compose.yml");
    for (const m of compose.matchAll(/^\s+image:\s+(\S+)$/gm)) {
      if (m[1]!.startsWith("clprouter-services")) continue;
      expect(m[1]).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it("is multi-stage and runs as a non-root user without a package manager", () => {
    expect(dockerfile.match(/^FROM /gm)).toHaveLength(2);
    const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
    expect(runtime).toMatch(/^USER node:node$/m);
    expect(runtime).not.toMatch(/pnpm|npm install|corepack/);
    expect(runtime).toMatch(/HEALTHCHECK .*\n.*\/healthz/);
    expect(runtime).toMatch(/STOPSIGNAL SIGTERM/);
  });

  it("installs from the lockfiles only", () => {
    expect(dockerfile).toMatch(/pnpm install --frozen-lockfile/);
    expect(dockerfile).not.toMatch(/pnpm install(?! --frozen-lockfile)/);
  });

  it("keeps secrets out of the compose file", () => {
    const compose = read("docker-compose.yml");
    expect(compose).not.toMatch(/0x[0-9a-fA-F]{64}/); // no private keys
    expect(compose).toMatch(/CLPROUTER_TRIGGER_KEY: \$\{CLPROUTER_TRIGGER_KEY:-\}/);
    expect(compose).toMatch(/read_only: true/);
    expect(compose).toMatch(/cap_drop: \["ALL"\]/);
  });
});
