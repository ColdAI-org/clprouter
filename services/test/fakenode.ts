// SPDX-License-Identifier: MIT
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { toHex } from "viem";
import { MockChain } from "./helpers.js";

export interface Fault {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Never answer (timeout). */
  hang?: boolean;
}

/**
 * A minimal EVM JSON-RPC node over a {@link MockChain}: eth_chainId, eth_blockNumber, eth_getBlockByNumber,
 * eth_getLogs; eth_call reverts. Faults can be queued (rate limits, 5xx, hangs) to test client resilience.
 */
export class FakeNode {
  server!: Server;
  url = "";
  readonly faults: Fault[] = [];
  readonly calls: string[] = [];
  /** Methods answered with a fault every time. */
  readonly failMethods = new Map<string, Fault>();

  constructor(
    readonly chain = new MockChain(),
    public chainId = 31337,
  ) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
    this.calls.push(body.method);
    const fault = this.failMethods.get(body.method) ?? this.faults.shift();
    if (fault) {
      if (fault.hang) return; // let the client time out
      res.writeHead(fault.status ?? 200, { "content-type": "application/json", ...(fault.headers ?? {}) });
      res.end(JSON.stringify(fault.body ?? { jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "fault" } }));
      return;
    }
    const reply = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    };
    const error = (code: number, message: string, data?: string) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code, message, ...(data ? { data } : {}) } }));
    };
    const c = this.chain;
    switch (body.method) {
      case "eth_chainId":
        return reply(toHex(this.chainId));
      case "eth_blockNumber":
        return reply(toHex(c.head));
      case "eth_getBlockByNumber": {
        const tag = body.params[0] as string;
        const n = tag === "latest" ? c.head : Number(BigInt(tag));
        const b = c.blocks[n];
        if (!b) return reply(null);
        return reply({
          number: toHex(n),
          hash: b.hash,
          parentHash: n > 0 ? c.blocks[n - 1]!.hash : `0x${"0".repeat(64)}`,
          timestamp: toHex(b.timestamp),
          gasLimit: "0x1c9c380",
          gasUsed: "0x0",
          transactions: [],
          uncles: [],
          logsBloom: `0x${"0".repeat(512)}`,
          miner: `0x${"0".repeat(40)}`,
          difficulty: "0x0",
          extraData: "0x",
          nonce: "0x0000000000000000",
          size: "0x0",
          stateRoot: `0x${"0".repeat(64)}`,
          receiptsRoot: `0x${"0".repeat(64)}`,
          transactionsRoot: `0x${"0".repeat(64)}`,
          sha3Uncles: `0x${"0".repeat(64)}`,
          mixHash: `0x${"0".repeat(64)}`,
        });
      }
      case "eth_getLogs": {
        const f = body.params[0] as { address: string[]; fromBlock: string; toBlock: string };
        const logs = await c.getLogs({ address: f.address as never, fromBlock: BigInt(f.fromBlock), toBlock: BigInt(f.toBlock) });
        return reply(
          logs.map((l) => ({
            address: l.address,
            topics: l.topics,
            data: l.data,
            blockNumber: toHex(l.blockNumber!),
            blockHash: l.blockHash,
            transactionHash: l.transactionHash,
            transactionIndex: "0x0",
            logIndex: toHex(l.logIndex!),
            removed: false,
          })),
        );
      }
      case "eth_call":
        return error(3, "execution reverted", "0x");
      default:
        return error(-32601, `method ${body.method} not supported`);
    }
  }
}
