import type { Certification, FilterLabel, Filters, Ledger, Mode } from "./types.js";

export interface ActiveFilters {
  labels: FilterLabel[];
  energyCapKgPerTx?: number;
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
      } else if (filters.energyCapKgPerTx !== undefined && c.kgCO2ePerTx > filters.energyCapKgPerTx) {
        fails.push(
          `ENERGY: ${ledger.id} emits ${c.kgCO2ePerTx} kgCO2e/tx, above the cap of ${filters.energyCapKgPerTx}`,
        );
      }
    }
  }
  return fails;
}
