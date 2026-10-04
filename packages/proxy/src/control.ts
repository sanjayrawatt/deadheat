import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { QueryEvent } from "./tracker.js";

/**
 * Holds the queries of tagged requests until the runner collects them. Entries are dropped
 * after `ttlMs`, or oldest-first beyond `maxQueries`, so an app running without a runner
 * attached can't make the proxy grow forever.
 */
export class QueryStore {
  private readonly byRequest = new Map<string, QueryEvent[]>();
  private readonly order: { at: number; requestId: string }[] = [];
  private total = 0;

  constructor(
    private readonly ttlMs = 120_000,
    private readonly maxQueries = 200_000,
  ) {}

  add(event: QueryEvent): void {
    if (!event.requestId) return;
    let list = this.byRequest.get(event.requestId);
    if (!list) {
      list = [];
      this.byRequest.set(event.requestId, list);
      this.order.push({ at: Date.now(), requestId: event.requestId });
    }
    list.push(event);
    this.total++;
    this.prune();
  }

  /** Returns and forgets the queries of these requests. */
  take(requestIds: readonly string[]): Record<string, QueryEvent[]> {
    const out: Record<string, QueryEvent[]> = {};
    for (const id of requestIds) {
      const list = this.byRequest.get(id);
      if (!list) continue;
      out[id] = list;
      this.byRequest.delete(id);
      this.total -= list.length;
    }
    return out;
  }

  get size(): number {
    return this.total;
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    while (this.order.length && (this.order[0]!.at < cutoff || this.total > this.maxQueries)) {
      const { requestId } = this.order.shift()!;
      const list = this.byRequest.get(requestId);
      if (list) {
        this.total -= list.length;
        this.byRequest.delete(requestId);
      }
    }
  }
}

export interface ControlServer {
  port: number;
  close(): Promise<void>;
}

/**
 * The runner's channel to a running proxy (localhost only):
 *   GET  /health                       → { ok: true, queries }
 *   POST /take  { requestIds: [...] }  → { queries: { [requestId]: QueryEvent[] } }
 */
export async function startControl(options: {
  store: QueryStore;
  port?: number;
  host?: string;
}): Promise<ControlServer> {
  const { store } = options;
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/health") {
        return send(200, { ok: true, queries: store.size });
      }
      if (req.method === "POST" && req.url === "/take") {
        const body = JSON.parse(await readBody(req)) as { requestIds?: unknown };
        if (
          !Array.isArray(body.requestIds) ||
          !body.requestIds.every((x) => typeof x === "string")
        ) {
          return send(400, { error: "requestIds must be an array of strings" });
        }
        return send(200, { queries: store.take(body.requestIds) });
      }
      send(404, { error: "not found" });
    } catch (err) {
      send(400, { error: (err as Error).message });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
