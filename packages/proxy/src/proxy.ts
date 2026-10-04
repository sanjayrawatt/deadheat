import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import {
  FrameDecoder,
  GSSENC_REQUEST,
  SSL_REQUEST,
  startupCode,
  startupParams,
  type Frame,
} from "./protocol.js";
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
