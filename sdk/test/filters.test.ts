import { describe, expect, it } from "vitest";
import { kgToUg, ledgerFilterFailures, ugToKg } from "../src/filters.js";
import type { Ledger } from "../src/index.js";
import { NOW, cert } from "./fixtures.js";

describe("emissions units (registry and envelope use integer µgCO2e)", () => {
  it("converts kg to µg and back", () => {
    expect(kgToUg(0.0024)).toBe(2_400_000n);
    expect(kgToUg(0.0105, "up")).toBe(10_500_000n); // no floating-point overshoot
    expect(kgToUg(2.4e-9, "up")).toBe(3n);
    expect(kgToUg(2.4e-9)).toBe(2n);
    expect(ugToKg(2_400_000n)).toBe(0.0024);
    expect(() => kgToUg(-1)).toThrow(/invalid/);
  });

  it("the Energy cap compares in µg exactly like the Router", () => {
    const ledger = (kg: number): Ledger =>
      ({ id: "test:e", name: "e", certifications: { ENERGY: cert(kg) } }) as unknown as Ledger;
    const f = (cap: number) => ({ labels: ["ENERGY" as const], energyCapKgPerTx: cap });
    expect(ledgerFilterFailures(ledger(0.0105), f(0.0105), "greenest", NOW)).toEqual([]);
    expect(ledgerFilterFailures(ledger(0.0105 + 1e-9), f(0.0105), "greenest", NOW)).toHaveLength(1); // 1 µg over
  });
});
