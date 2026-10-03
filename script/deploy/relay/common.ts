// SPDX-License-Identifier: MIT
// Shared helpers for the Sepolia -> Hedera testnet relay (EthMainnetVerifier).
import {existsSync, readFileSync, writeFileSync, mkdirSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createPublicClient, http, type Abi, type Hex, type PublicClient} from "viem";
import {
    DEFAULT_BEACON_APIS,
    beaconHeaderRoot,
    type BootstrapJson,
    type FinalityUpdateJson,
    type LightClientUpdateJson,
    type LiveCapture
} from "./vendor/relay/buildEthLiveProof.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../../..");
export const BUILD = path.join(ROOT, "script/deploy/.build");

export function arg(name: string, fallback?: string): string {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
}

export function env(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`missing env ${name}`);
    return v;
}

export function beaconApis(): string[] {
    const own = process.env.SEPOLIA_BEACON_URL;
    return own ? [own.replace(/\/$/, ""), ...DEFAULT_BEACON_APIS] : DEFAULT_BEACON_APIS;
}

export async function getJson<T>(bases: string[], p: string): Promise<{json: T; base: string}> {
    let lastErr: unknown;
    for (const base of bases) {
        try {
            const res = await fetch(base + p, {headers: {accept: "application/json"}});
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            return {json: (await res.json()) as T, base};
        } catch (err) {
            lastErr = err;
        }
    }
    throw new Error(`GET ${p} failed on all beacon APIs: ${String(lastErr)}`);
}

let rpcId = 0;
export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const res = await fetch(url, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: ++rpcId, method, params})
    });
    const j = (await res.json()) as {result?: T; error?: {message: string}};
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result as T;
}

export function client(url: string): PublicClient {
    return createPublicClient({transport: http(url)}) as PublicClient;
}

export function abiOf(contract: string, file = `${contract}.sol`): Abi {
    // A source compiled under several foundry profiles (foundry.toml additional_compiler_profiles) gets one
    // artifact per profile, `<contract>.<profile>.json`; the ABI is the same in each.
    const dir = path.join(BUILD, "out", file);
    const p = [`${contract}.json`, `${contract}.default.json`, `${contract}.small.json`]
        .map((f) => path.join(dir, f))
        .find((f) => existsSync(f));
    if (!p) throw new Error(`no artifact for ${contract} in ${dir} (build the deploy scripts first)`);
    return (JSON.parse(readFileSync(p, "utf8")) as {abi: Abi}).abi;
}

export function writeEnvFile(file: string, vars: Record<string, string>): void {
    mkdirSync(path.dirname(file), {recursive: true});
    writeFileSync(file, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

export async function specAndGenesis(apis: string[]): Promise<{spec: Record<string, string>; gvr: Hex}> {
    const {json: genesis} = await getJson<{data: {genesis_validators_root: string}}>(apis, "/eth/v1/beacon/genesis");
    const {json: specRaw} = await getJson<{data: Record<string, string>}>(apis, "/eth/v1/config/spec");
    const spec: Record<string, string> = {};
    for (const [k, v] of Object.entries(specRaw.data)) {
        if (/_FORK_(VERSION|EPOCH)$/.test(k) || ["CONFIG_NAME", "PRESET_BASE", "SLOTS_PER_EPOCH",
            "EPOCHS_PER_SYNC_COMMITTEE_PERIOD", "SYNC_COMMITTEE_SIZE"].includes(k)) {
            spec[k] = v;
        }
    }
    return {spec, gvr: genesis.data.genesis_validators_root as Hex};
}

/// Beacon side of a capture: the latest finality update, the bootstrap of its finalized header and, when the
/// signature slot is one period past the bootstrap, that period's update (its next_sync_committee signs).
export async function beaconCapture(apis: string[], fu: FinalityUpdateJson, base: string): Promise<
    Pick<LiveCapture, "network" | "genesisValidatorsRoot" | "spec" | "finalityUpdate" | "bootstrap" | "committeeUpdate">
> {
    const order = [base, ...apis.filter((a) => a !== base)];
    const {spec, gvr} = await specAndGenesis(order);
    const finalizedRoot = beaconHeaderRoot(fu.data.finalized_header.beacon);
    const {json: bootstrap} = await getJson<BootstrapJson>(order, `/eth/v1/beacon/light_client/bootstrap/${finalizedRoot}`);
    const spp = BigInt(spec.SLOTS_PER_EPOCH) * BigInt(spec.EPOCHS_PER_SYNC_COMMITTEE_PERIOD);
    const sigPeriod = BigInt(fu.data.signature_slot) / spp;
    const bootPeriod = BigInt(bootstrap.data.header.beacon.slot) / spp;
    let committeeUpdate: LightClientUpdateJson | undefined;
    if (sigPeriod === bootPeriod + 1n) {
        const {json} = await getJson<LightClientUpdateJson[]>(
            order, `/eth/v1/beacon/light_client/updates?start_period=${bootPeriod}&count=1`
        );
        committeeUpdate = json[0];
    }
    return {
        network: spec.CONFIG_NAME ?? "unknown",
        genesisValidatorsRoot: gvr,
        spec,
        finalityUpdate: fu,
        bootstrap,
        committeeUpdate
    };
}

export function hexOf(b: Buffer): Hex {
    return ("0x" + b.toString("hex")) as Hex;
}
