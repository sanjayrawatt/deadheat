import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import {
  cString,
  FrameDecoder,
  GSSENC_REQUEST,
  readParse,
  SSL_REQUEST,
  startupCode,
  startupParams,
  type Frame,
} from "./protocol.js";
import { fingerprint, type HoldRules } from "@deadheat/core";
import { Scheduler, type ScheduleConfig, type ScheduleStep } from "./scheduler.js";
import { QueryTracker, splitRequestTag, type ProxyEvent } from "./tracker.js";

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

export type { HoldRules, ScheduleConfig, ScheduleStep };

export interface RunningProxy {
  port: number;
  /** Start holding (or, with `null`, stop holding) the results of matching reads. */
  setHolds(rules: HoldRules | null): void;
  readonly holds: HoldRules | null;
  /**
   * Start scheduling a trial's queries (replacing any running schedule), or with `null` stop.
   * Returns the release order of the schedule that was stopped.
   */
  setSchedule(config: ScheduleConfig | null): ScheduleStep[];
  readonly schedule: ScheduleConfig | null;
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
  let scheduler: Scheduler | null = null;

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

    // Client→server frames. A batch the scheduler holds (a Q, or Parse … Sync) waits here until
    // it is released, and everything after it on this connection queues behind it.
    interface Segment {
      frames: Frame[];
      ready: boolean;
      owner?: { scheduler: Scheduler; requestId: string };
    }
    const inbox: Segment[] = [];
    let collecting: Segment | undefined;
    // Who is waiting for each ReadyForQuery still to come: one per forwarded Q or Sync.
    const readyOwners: (Segment["owner"] | undefined)[] = [];

    const pump = () => {
      while (inbox[0]?.ready && !closed) {
        const segment = inbox.shift()!;
        for (const frame of segment.frames) {
          tracker.frontend(frame);
          upstream.write(frame.raw);
          if (frame.type === "Q" || frame.type === "S") readyOwners.push(segment.owner);
        }
      }
    };
    const offer = (segment: Segment) => {
      const { scheduler: s, requestId } = segment.owner!;
      s.offer(requestId, () => {
        segment.ready = true;
        pump();
      });
    };
    const fromClientFrame = (frame: Frame) => {
      if (collecting) {
        collecting.frames.push(frame);
        if (frame.type === "S") {
          offer(collecting);
          collecting = undefined;
        }
        return;
      }
      const requestId = frame.type === "Q" || frame.type === "P" ? taggedId(frame) : undefined;
      if (scheduler?.matches(requestId)) {
        const segment: Segment = { frames: [frame], ready: false, owner: { scheduler, requestId } };
        inbox.push(segment);
        if (frame.type === "Q") offer(segment);
        else collecting = segment;
        return;
      }
      inbox.push({ frames: [frame], ready: true });
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
          upstream.write(frame.raw);
        } else {
          fromClientFrame(frame);
        }
      }
      pump();
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
        if (frame.type === "Z") {
          const owner = readyOwners.shift();
          owner?.scheduler.finished(owner.requestId);
        }
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
    setSchedule(config) {
      const order = scheduler?.stop() ?? [];
      scheduler = config ? new Scheduler(config) : null;
      return order;
    },
    get schedule() {
      return scheduler?.config ?? null;
    },
    close: () =>
      new Promise<void>((resolve) => {
        scheduler?.stop();
        for (const socket of live) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function taggedId(frame: Frame): string | undefined {
  const sql = frame.type === "Q" ? cString(frame.payload).value : readParse(frame.payload).sql;
  return splitRequestTag(sql).requestId;
}
