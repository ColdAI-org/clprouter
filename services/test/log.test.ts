// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { createLogger, loggerFromFn, redactUrl, scrubMessage } from "../src/log.js";

describe("structured logging", () => {
  const capture = (level?: "debug" | "info" | "warn" | "error") => {
    const lines: Record<string, unknown>[] = [];
    const log = createLogger({ level, write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>), clock: () => new Date(0) });
    return { lines, log };
  };

  it("writes one JSON object per line with level, time, msg and fields", () => {
    const { lines, log } = capture();
    log.child({ component: "indexer" }).info("polled", { ledger: "eip155:1", n: 3n });
    expect(lines).toEqual([{ level: "info", time: "1970-01-01T00:00:00.000Z", msg: "polled", component: "indexer", ledger: "eip155:1", n: "3" }]);
  });

  it("filters by level", () => {
    const { lines, log } = capture("warn");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((l) => l.level)).toEqual(["warn", "error"]);
  });

  it("never writes secrets: masked keys, redacted URLs (user info, path keys, query)", () => {
    const { lines, log } = capture();
    log.info("calling https://user:pw@rpc.example/v3/0123456789abcdef0123?apikey=zzz", {
      privateKey: "0xdead",
      authorization: "Bearer t",
      url: "postgres://admin:secret@db:5432/clpr",
      nested: { token: "t", ok: 1 },
    });
    const s = JSON.stringify(lines[0]);
    for (const leak of ["pw", "0123456789abcdef0123", "zzz", "0xdead", "Bearer t", "secret"]) expect(s).not.toContain(leak);
    expect(lines[0]).toMatchObject({ privateKey: "[redacted]", nested: { token: "[redacted]", ok: 1 } });
  });

  it("serialises errors with a scrubbed message and stack", () => {
    const { lines, log } = capture();
    log.error("boom", { err: new Error("fetch https://x.example/v2/abcdefabcdefabcdefabcdef failed") });
    expect((lines[0]!.err as { message: string }).message).toBe("fetch https://x.example/v2/*** failed");
    expect((lines[0]!.err as { stack: string }).stack).not.toContain("abcdefabcdefabcdefabcdef");
  });

  it("redacts URLs and leaves other text alone", () => {
    expect(redactUrl("http://127.0.0.1:8545")).toBe("http://127.0.0.1:8545/");
    expect(redactUrl("not a url")).toBe("not a url");
    expect(scrubMessage("plain text")).toBe("plain text");
  });

  it("adapts legacy (msg) => void callbacks", () => {
    const got: string[] = [];
    const l = loggerFromFn((m) => got.push(m));
    l.info("plain");
    l.child({ a: 1 }).warn("with", { b: 2 });
    expect(got).toEqual(["plain", 'warn: with {"a":1,"b":2}']);
  });
});
