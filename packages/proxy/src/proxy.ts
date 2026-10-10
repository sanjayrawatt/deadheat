import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import {
  FrameDecoder,
  GSSENC_REQUEST,
  SSL_REQUEST,
  startupCode,
  startupParams,
  type Frame,
} from "./protocol.js";
import { fingerprint, type HoldRules } from "@deadheat/core";
import { QueryTracker, type ProxyEvent } from "./tracker.js";

export type {
  ConnectionCloseEvent,
  ConnectionOpenEvent,
  ProxyEvent,
  QueryEvent,
  TxStatus,
} from "./tracker.js";

export interface ProxyOptions {
  upstream: { host: string; port: number };
  /** Port to listen on. 0 picks a free port. Default 0. */
  port?: number;
  host?: string;
  onEvent?: (event: ProxyEvent) => void;
}

export type { HoldRules };

export interface RunningProxy {
  port: number;
  /** Start holding (or, with `null`, stop holding) the results of matching reads. */
  setHolds(rules: HoldRules | null): void;
  readonly holds: HoldRules | null;
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
  let holds: { rules: HoldRules; set: Set<string> } | null = null;

  // Only queries tagged by the agent are held, so other traffic through the proxy isn't slowed.
  const holdFor = (sql: string, requestId: string | undefined): number =>
    holds && requestId && holds.set.has(fingerprint(sql)) ? holds.rules.holdMs : 0;

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

    // Server→client frames go through this queue. A hold pauses it; frames that arrive in the
    // meantime wait behind the held ones, so order is always kept.
    const outbox: Buffer[] = [];
    let pausedUntil = 0;
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      timer = undefined;
      const wait = pausedUntil - performance.now();
      if (wait > 0) {
        timer = setTimeout(flush, wait);
        return;
      }
      if (outbox.length && !closed) client.write(Buffer.concat(outbox.splice(0)));
    };
    const toClient = (raw: Buffer) => {
      if (outbox.length || performance.now() < pausedUntil) {
        outbox.push(raw);
        timer ??= setTimeout(flush, Math.max(0, pausedUntil - performance.now()));
      } else {
        client.write(raw);
      }
    };

    const shutdown = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
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
        const holdMs = tracker.responding()?.decide(holdFor) ?? 0;
        if (holdMs > 0) pausedUntil = Math.max(pausedUntil, performance.now() + holdMs);
        tracker.backend(frame);
        toClient(frame.raw);
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
    setHolds(rules) {
      holds = rules ? { rules, set: new Set(rules.fingerprints) } : null;
    },
    get holds() {
      return holds?.rules ?? null;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of live) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
