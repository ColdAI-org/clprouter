import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";

/** One ledger the services watch. Ledger ids are CAIP-2 (`eip155:296`, ...). */
export interface LedgerConfig {
  id: string;
  rpcUrl: string;
  /**
   * Blocks behind the head before an event is indexed (reorg safety). Pick it per ledger: 0 on instant-finality
   * ledgers (Hedera, local anvil), more on probabilistic ones.
   */
  confirmations: number;
  contracts: {
    router: Address;
    registry: Address;
    vault: Address;
    /** CLPR Service on this ledger; when set, the quote service reads live Channel and Connector state. */
    clprService?: Address;
  };
  /** First block to index (the deployment block). Default 0. */
  startBlock?: number;
  /** Max blocks per `eth_getLogs` call. Default 2000. */
  batchSize?: number;
  /** Poll interval, ms. Default 2000. */
  pollIntervalMs?: number;
}

export interface TriggerConfig {
  enabled: boolean;
  /**
   * Private key of a TEST account used to submit {forward} / {flush}. Read from the env var named here
   * (default `CLPROUTER_TRIGGER_KEY`), never from the config file.
   */
  keyEnv?: string;
  /** Also complete `ForwardRejected` hops with a FAILED receipt so the origin is refunded. Default false. */
  completeRejected?: boolean;
  /** Ledgers the trigger may submit on (default: all). Every one must have a local RPC URL. */
  ledgers?: string[];
}

export interface ServicesConfig {
  ledgers: LedgerConfig[];
  /** SQLite file. Default `clprouter-services.sqlite`. `:memory:` for tests. */
  database?: string;
  http?: { host?: string; port?: number };
  /** Base route graph (measured timing, gas, emissions) the live state is overlaid on. Default: SDK sample graph. */
  graph?: { file?: string };
  /** Ledger whose registry supplies certifications for quotes. Default: the first ledger. */
  registryLedger?: string;
  /** Router versions to check for disables in quotes. Default [1]. */
  routerVersions?: number[];
  trigger?: TriggerConfig;
}

export function loadConfig(path: string): ServicesConfig {
  const cfg = JSON.parse(readFileSync(path, "utf8")) as ServicesConfig;
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: ServicesConfig): void {
  if (!Array.isArray(cfg.ledgers) || cfg.ledgers.length === 0) throw new Error("config: no ledgers");
  const seen = new Set<string>();
  for (const l of cfg.ledgers) {
    if (seen.has(l.id)) throw new Error(`config: duplicate ledger ${l.id}`);
    seen.add(l.id);
    if (!Number.isInteger(l.confirmations) || l.confirmations < 0) {
      throw new Error(`config: ${l.id}: confirmations must be a non-negative integer`);
    }
    for (const k of ["router", "registry", "vault"] as const) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(l.contracts?.[k] ?? "")) throw new Error(`config: ${l.id}: bad ${k} address`);
    }
  }
  if (cfg.registryLedger && !seen.has(cfg.registryLedger)) {
    throw new Error(`config: registryLedger ${cfg.registryLedger} is not a configured ledger`);
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** True if the RPC URL points at a local development node (the only place the trigger may sign). */
export function isLocalRpc(url: string): boolean {
  try {
    const u = new URL(url);
    return LOCAL_HOSTS.has(u.hostname) || u.hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

export function triggerKey(cfg: TriggerConfig, env: NodeJS.ProcessEnv = process.env): Hex | undefined {
  const v = env[cfg.keyEnv ?? "CLPROUTER_TRIGGER_KEY"];
  if (!v) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error("trigger key must be a 32-byte hex private key");
  return v as Hex;
}
