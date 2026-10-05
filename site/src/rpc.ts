import { MIRROR, NETS, type Hex, type Net } from "./config";

export class EndpointError extends Error {}

async function fetchJson(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    if (!r.ok) throw new EndpointError(`${new URL(url).host} answered HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e instanceof EndpointError) throw e;
    const host = new URL(url).host;
    throw new EndpointError(ctl.signal.aborted ? `${host} did not answer within ${timeoutMs / 1000} s` : `${host} unreachable`);
  } finally {
    clearTimeout(t);
  }
}

let rpcId = 0;

/** JSON-RPC call against a network's public endpoints, falling back to the next one on failure. */
export async function rpc<T>(net: Net, method: string, params: unknown[], timeoutMs = 9000): Promise<T> {
  let last: Error | undefined;
  for (const url of NETS[net].rpc) {
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
      const res = (await fetchJson(url, { method: "POST", headers: { "content-type": "application/json" }, body }, timeoutMs)) as {
        result?: T;
        error?: { message?: string };
      };
      if (res.error) throw new EndpointError(`${new URL(url).host}: ${res.error.message ?? "RPC error"}`);
      return res.result as T;
    } catch (e) {
      last = e as Error;
    }
  }
  throw last ?? new EndpointError("no endpoint");
}

export async function ethCall(net: Net, to: Hex, data: Hex): Promise<Hex> {
  try {
    return await rpc<Hex>(net, "eth_call", [{ to, data }, "latest"]);
  } catch (e) {
    if (net !== "hedera") throw e;
    // Fallback: the mirror node's EVM simulation endpoint.
    const res = (await fetchJson(
      `${MIRROR}/api/v1/contracts/call`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to, data, block: "latest" }) },
      9000,
    )) as { result: Hex };
    return res.result;
  }
}

export function getCode(net: Net, address: Hex): Promise<Hex> {
  return rpc<Hex>(net, "eth_getCode", [address, "latest"]);
}

export function mirror<T>(path: string, timeoutMs = 9000): Promise<T> {
  return fetchJson(`${MIRROR}${path}`, undefined, timeoutMs) as Promise<T>;
}

export interface RawLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  blockNumber: bigint;
  /** Unix seconds, when the endpoint reports it. */
  timestamp?: number;
}

interface RpcLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  blockNumber: Hex;
  blockTimestamp?: Hex;
}

/** Sepolia logs for some addresses since the deployment, newest first. Splits the range if the endpoint refuses it. */
export async function sepoliaLogs(addresses: Hex[]): Promise<RawLog[]> {
  const latest = BigInt(await rpc<Hex>("sepolia", "eth_blockNumber", []));
  const from = NETS.sepolia.fromBlock;
  const ranges: Array<[bigint, bigint]> = [];
  let span = latest - from + 1n;
  try {
    const all = await rpc<RpcLog[]>("sepolia", "eth_getLogs", [
      { address: addresses, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${latest.toString(16)}` },
    ], 12000);
    return toRaw(all);
  } catch {
    span = 10_000n;
    for (let hi = latest; hi >= from && ranges.length < 8; hi -= span) {
      const lo = hi - span + 1n > from ? hi - span + 1n : from;
      ranges.push([lo, hi]);
    }
  }
  const parts = await Promise.allSettled(
    ranges.map(([lo, hi]) =>
      rpc<RpcLog[]>("sepolia", "eth_getLogs", [{ address: addresses, fromBlock: `0x${lo.toString(16)}`, toBlock: `0x${hi.toString(16)}` }], 12000),
    ),
  );
  const ok = parts.flatMap((p) => (p.status === "fulfilled" ? p.value : []));
  if (!ok.length && parts.every((p) => p.status === "rejected")) throw (parts[0] as PromiseRejectedResult).reason;
  return toRaw(ok);
}

function toRaw(logs: RpcLog[]): RawLog[] {
  return logs
    .map((l) => ({
      address: l.address,
      topics: l.topics,
      data: l.data,
      transactionHash: l.transactionHash,
      blockNumber: BigInt(l.blockNumber),
      timestamp: l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) : undefined,
    }))
    .sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : -1));
}

interface MirrorLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  transaction_hash: Hex;
  block_number: number;
  timestamp: string;
}

/** Hedera logs of one contract from the mirror node, newest first. */
export async function hederaLogs(address: Hex, limit = 50): Promise<RawLog[]> {
  const res = await mirror<{ logs: MirrorLog[] }>(`/api/v1/contracts/${address}/results/logs?order=desc&limit=${limit}`);
  return res.logs.map((l) => ({
    address: l.address,
    topics: l.topics,
    data: l.data,
    transactionHash: l.transaction_hash,
    blockNumber: BigInt(l.block_number),
    timestamp: Math.floor(Number(l.timestamp)),
  }));
}
