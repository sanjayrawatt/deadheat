import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import {
  cString,
  errorFields,
  FrameDecoder,
  GSSENC_REQUEST,
  SSL_REQUEST,
  startupCode,
  startupParams,
  type Frame,
} from "./protocol.js";

export type TxStatus = "I" | "T" | "E"; // idle, in transaction, failed transaction

export interface ConnectionOpenEvent {
  type: "connection-open";
  connectionId: number;
  user?: string;
  database?: string;
  applicationName?: string;
}

export interface QueryEvent {
  type: "query";
  connectionId: number;
  protocol: "simple";
  sql: string;
  /** ms since the proxy started (performance.now()). */
  startedAt: number;
  durationMs: number;
  rows: number;
  /** One CommandComplete tag per statement, e.g. ["INSERT 0 1"]. */
  commandTags: string[];
  error?: { code: string; message: string };
  /** Transaction status reported by ReadyForQuery when the query finished. */
  txStatus: TxStatus;
}

export interface ConnectionCloseEvent {
  type: "connection-close";
  connectionId: number;
  queries: number;
}

export type ProxyEvent = ConnectionOpenEvent | QueryEvent | ConnectionCloseEvent;

export interface ProxyOptions {
  upstream: { host: string; port: number };
  /** Port to listen on. 0 picks a free port. Default 0. */
  port?: number;
  host?: string;
  onEvent?: (event: ProxyEvent) => void;
}

export interface RunningProxy {
  port: number;
  close(): Promise<void>;
}

/**
 * A transparent Postgres proxy. Every byte is forwarded unchanged, message by message, while a
 * tracker decodes the conversation into query events.
 */
export async function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  const emit = options.onEvent ?? (() => {});
  const live = new Set<Socket>();
  let nextId = 1;

  const server = createServer((client) => {
    const connectionId = nextId++;
    const upstream = connect(options.upstream);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    live.add(client).add(upstream);

    const fromClient = new FrameDecoder(true);
    const fromServer = new FrameDecoder(false);
    const tracker = new QueryTracker(connectionId, emit);
    let closed = false;

    const shutdown = () => {
      if (closed) return;
      closed = true;
      client.destroy();
      upstream.destroy();
      live.delete(client);
      live.delete(upstream);
      emit({ type: "connection-close", connectionId, queries: tracker.count });
    };

    client.on("data", (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = fromClient.push(chunk);
      } catch {
        return shutdown();
      }
      for (const frame of frames) {
        if (frame.type === "startup") {
          const code = startupCode(frame);
          if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
            // Refuse encryption so the conversation stays readable. The client then sends
            // a plain StartupMessage, which is untyped again.
            client.write("N");
            fromClient.expectStartup();
            continue;
          }
          const params = startupParams(frame);
          emit({
            type: "connection-open",
            connectionId,
            ...(params.user ? { user: params.user } : {}),
            ...(params.database ? { database: params.database } : {}),
            ...(params.application_name ? { applicationName: params.application_name } : {}),
          });
        } else {
          tracker.frontend(frame);
        }
        upstream.write(frame.raw);
      }
    });

    upstream.on("data", (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = fromServer.push(chunk);
      } catch {
        return shutdown();
      }
      for (const frame of frames) {
        tracker.backend(frame);
        client.write(frame.raw);
      }
    });

    for (const socket of [client, upstream]) {
      socket.on("end", shutdown);
      socket.on("close", shutdown);
      socket.on("error", shutdown);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of live) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

interface Pending {
  sql: string;
  startedAt: number;
  rows: number;
  commandTags: string[];
  error?: { code: string; message: string };
}

/** Follows one connection's messages and emits a QueryEvent per completed simple query. */
class QueryTracker {
  count = 0;
  private pending: Pending | undefined;

  constructor(
    private readonly connectionId: number,
    private readonly emit: (e: ProxyEvent) => void,
  ) {}

  frontend(frame: Frame): void {
    if (frame.type === "Q") {
      this.pending = {
        sql: cString(frame.payload).value,
        startedAt: performance.now(),
        rows: 0,
        commandTags: [],
      };
    }
  }

  backend(frame: Frame): void {
    const q = this.pending;
    switch (frame.type) {
      case "D":
        if (q) q.rows++;
        break;
      case "C":
        q?.commandTags.push(cString(frame.payload).value);
        break;
      case "E":
        if (q) {
          const f = errorFields(frame.payload);
          q.error = { code: f.C ?? "", message: f.M ?? "" };
        }
        break;
      case "Z":
        if (q) {
          this.count++;
          this.emit({
            type: "query",
            connectionId: this.connectionId,
            protocol: "simple",
            sql: q.sql,
            startedAt: q.startedAt,
            durationMs: performance.now() - q.startedAt,
            rows: q.rows,
            commandTags: q.commandTags,
            ...(q.error ? { error: q.error } : {}),
            txStatus: String.fromCharCode(frame.payload[0]!) as TxStatus,
          });
          this.pending = undefined;
        }
        break;
    }
  }
}
