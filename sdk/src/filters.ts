import type { Certification, FilterLabel, Filters, Ledger, Mode } from "./types.js";

export interface ActiveFilters {
  labels: FilterLabel[];
  energyCapKgPerTx?: number;
}

/** Micrograms per kilogram: the on-chain unit of emissions figures and the Energy cap is µgCO2e per transaction. */
export const UG_PER_KG = 1_000_000_000;

/**
 * kgCO2e → integer µgCO2e, the unit of `ProviderRegistry` emissions figures and of the envelope's `energy_cap`.
 * `up` rounds a cap so it never becomes stricter than asked; `nearest` rounds a certified figure. A relative
 * tolerance absorbs binary floating-point noise (0.0105 kg is 10_500_000 µg, not 10_500_001).
 */
export function kgToUg(kg: number, round: "up" | "nearest" = "nearest"): bigint {
  if (!(kg >= 0) || !Number.isFinite(kg)) throw new Error(`invalid emissions figure ${kg}`);
  const ug = kg * UG_PER_KG;
  if (round === "nearest") return BigInt(Math.round(ug));
  return BigInt(Math.ceil(ug - 1e-9 * Math.max(1, ug)));
}

/** Integer µgCO2e → kgCO2e. */
export function ugToKg(ug: bigint | number): number {
  return Number(ug) / UG_PER_KG;
}

export function activeFilters(f: Filters | undefined): ActiveFilters {
  const labels: FilterLabel[] = [];
  let energyCapKgPerTx: number | undefined;
  if (f?.iso20022) labels.push("ISO20022");
  if (f?.mica) labels.push("MICA");
  if (f?.energy) {
    labels.push("ENERGY");
    if (typeof f.energy === "object") energyCapKgPerTx = f.energy.capKgPerTx;
  }
  return { labels, energyCapKgPerTx };
}

/** A certification is valid if it is not revoked and has not expired at `now`. */
export function certValid(c: Certification | undefined, now: Date): c is Certification {
  if (!c || c.status === "revoked") return false;
  return new Date(c.expiresAt).getTime() > now.getTime();
}

/**
 * Check one ledger against every active filter. Returns the list of reasons it fails (empty = passes).
 *
 * Filters are hard rules on every ledger the route touches, including origin, destination and Hiero.
 */
export function ledgerFilterFailures(ledger: Ledger, filters: ActiveFilters, mode: Mode, now: Date): string[] {
  const fails: string[] = [];
  const certs = ledger.certifications ?? {};
  for (const label of filters.labels) {
    const c = certs[label];
    if (!certValid(c, now)) {
      fails.push(`${label}: ${ledger.id} has no valid ${label} certification`);
      continue;
    }
    if (label === "ISO20022" && !ledger.operatedRouter?.identified) {
      fails.push(`ISO20022: ${ledger.id} has no identified operated Router`);
    }
    if (label === "MICA") {
      if (!ledger.operatedRouter?.caspAuthorised) {
        fails.push(`MICA: ${ledger.id} Router operator is not an authorised CASP`);
      }
      if (mode === "greenest" && c.kgCO2ePerTx === undefined) {
        fails.push(`MICA: ${ledger.id} has no emissions figure from its MiCA disclosure (required by greenest + MiCA)`);
      }
    }
    if (label === "ENERGY") {
      if (c.kgCO2ePerTx === undefined) {
        fails.push(`ENERGY: ${ledger.id} certification carries no emissions figure`);
      } else if (
        filters.energyCapKgPerTx !== undefined &&
        // Same integer comparison as the Router: certified µg figure > cap in µg (rounded up, as in the envelope).
        kgToUg(c.kgCO2ePerTx) > kgToUg(filters.energyCapKgPerTx, "up")
      ) {
        fails.push(
          `ENERGY: ${ledger.id} emits ${c.kgCO2ePerTx} kgCO2e/tx, above the cap of ${filters.energyCapKgPerTx}`,
        );
      }
    }
  }
  return fails;
}
