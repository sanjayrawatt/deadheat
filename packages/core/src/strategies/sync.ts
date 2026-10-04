import { connect, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { RequestSpec, RequestTrace, Strategy } from "../types.js";

const MAX_BODY_CHARS = 2000;
const RESPONSE_TIMEOUT_MS = 30_000;

/**
 * Last-byte synchronization over HTTP/1.1.
 *
 * 1. Open one TCP connection per request and wait until all are connected.
 * 2. Write each request except its final byte, and wait until every write has been handed
 *    to the kernel.
 * 3. Release the final byte on every socket in one synchronous loop.
 *
 * The server can't finish parsing any request until its last byte arrives, so all requests
 * become complete within microseconds of each other. Connection setup and most of the
 * transfer time drop out of the race window. This only works if the server doesn't act on
 * a request before its last byte arrives, which is true for any request with a body (or
 * headers) of at least one byte.
 *
 * `settleMs` waits between priming and release, so the primed bytes have reached the server
 * before the last byte goes out. It's a trade-off (docs/BENCHMARKS.md §2–3):
 * - Direct connection: settle 0 is the most precise. Every millisecond of settle widened
 *   the arrival spread (p50 223µs at 0ms → 665µs at 50ms on localhost).
 * - Through a proxy that opens its upstream connection lazily (Toxiproxy in our tests):
 *   settle 0 dropped the hit rate from 99% to 53%, because the proxy held the primed bytes
 *   while connecting. Settle 50ms restored it.
 * So the default is 0. Pass a settle above the client→server latency when the target sits
 * behind a proxy or load balancer.
 */
export const DEFAULT_SETTLE_MS = 0;

export interface SyncOptions {
  settleMs?: number;
}

export function createSync({ settleMs = DEFAULT_SETTLE_MS }: SyncOptions = {}): Strategy {
  return {
    name: settleMs === DEFAULT_SETTLE_MS ? "sync" : `sync(settle=${settleMs}ms)`,
    fire: (baseUrl, specs) => fireSync(baseUrl, specs, settleMs),
  };
}

export const sync: Strategy = createSync();

async function fireSync(
  baseUrl: string,
  specs: readonly RequestSpec[],
  settleMs: number,
): Promise<RequestTrace[]> {
  const prepared = specs.map((spec) => prepare(baseUrl, spec));

  // A connection that fails becomes an error trace for that request instead of
  // failing the whole trial, the same as the naive strategy.
  const opened = await Promise.allSettled(prepared.map((p) => open(p.host, p.port)));
  const sockets = opened.map((o) => (o.status === "fulfilled" ? o.value : undefined));
  try {
    // Start listening for responses before priming, so an early error response
    // (e.g. 400 on bad headers) isn't missed.
    const pending = opened.map((o) =>
      o.status === "fulfilled"
        ? collect(o.value)
        : Promise.resolve<Collected>({ raw: Buffer.alloc(0), error: errorMessage(o.reason) }),
    );

    await Promise.all(
      sockets.map((s, i) => s && write(s, prepared[i]!.bytes.subarray(0, -1)).catch(() => {})),
    );
    if (settleMs > 0) await sleep(settleMs);

    const t0 = performance.now();
    const sentAt: number[] = [];
    for (let i = 0; i < sockets.length; i++) {
      sentAt.push(performance.now() - t0);
      sockets[i]?.write(prepared[i]!.bytes.subarray(-1));
    }

    const responses = await Promise.all(pending);
    return responses.map((res, index): RequestTrace => {
      const spec = specs[index]!;
      const trace: RequestTrace = {
        index,
        method: spec.method,
        url: spec.url,
        sentAtMs: sentAt[index]!,
      };
      if (res.firstByteAt !== undefined) trace.headersAtMs = res.firstByteAt - t0;
      if (res.error) {
        trace.error = res.error;
        return trace;
      }
      try {
        const parsed = parseResponse(res.raw);
        trace.status = parsed.status;
        trace.body = parsed.body.slice(0, MAX_BODY_CHARS);
      } catch (err) {
        trace.error = errorMessage(err);
      }
      return trace;
    });
  } finally {
    for (const s of sockets) s?.destroy();
  }
}

interface Prepared {
  host: string;
  port: number;
  bytes: Buffer;
}

/** Serialises a request to raw HTTP/1.1 bytes. */
export function prepare(baseUrl: string, spec: RequestSpec): Prepared {
  const url = new URL(spec.url, baseUrl);
  if (url.protocol !== "http:") {
    throw new Error(`sync strategy supports http:// only for now, got ${url.protocol}//`);
  }

  const body =
    spec.body === undefined
      ? Buffer.alloc(0)
      : Buffer.from(typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body));

  const headers: Record<string, string> = {
    host: url.host,
    connection: "close",
    ...(spec.body !== undefined && typeof spec.body !== "string"
      ? { "content-type": "application/json" }
      : {}),
    ...(body.length || spec.method !== "GET" ? { "content-length": String(body.length) } : {}),
  };
  for (const [k, v] of Object.entries(spec.headers ?? {})) headers[k.toLowerCase()] = v;

  const head =
    `${spec.method} ${url.pathname}${url.search} HTTP/1.1\r\n` +
    Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("") +
    "\r\n";

  return {
    host: url.hostname,
    port: Number(url.port || 80),
    bytes: Buffer.concat([Buffer.from(head, "latin1"), body]),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function open(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.setNoDelay(true); // no Nagle: the 1-byte release must go out immediately
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

function write(socket: Socket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (err) => (err ? reject(err) : resolve()));
  });
}

interface Collected {
  raw: Buffer;
  firstByteAt?: number;
  error?: string;
}

/** Reads until the server closes the connection (we always send `Connection: close`). */
function collect(socket: Socket): Promise<Collected> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let firstByteAt: number | undefined;
    const done = (error?: string) => {
      clearTimeout(timer);
      resolve({
        raw: Buffer.concat(chunks),
        ...(firstByteAt !== undefined ? { firstByteAt } : {}),
        ...(error ? { error } : {}),
      });
    };
    const timer = setTimeout(() => {
      socket.destroy();
      done(`no complete response within ${RESPONSE_TIMEOUT_MS}ms`);
    }, RESPONSE_TIMEOUT_MS);

    socket.on("data", (chunk: Buffer) => {
      firstByteAt ??= performance.now();
      chunks.push(chunk);
    });
    socket.once("end", () => done());
    socket.once("error", (err) => done(chunks.length ? undefined : err.message));
  });
}

/** Minimal HTTP/1.1 response parser: status line, headers, content-length or chunked body. */
export function parseResponse(raw: Buffer): { status: number; body: string } {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd === -1) throw new Error("incomplete HTTP response (no end of headers)");

  const [statusLine = "", ...headerLines] = raw
    .subarray(0, headerEnd)
    .toString("latin1")
    .split("\r\n");
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
  if (!match) throw new Error(`bad HTTP status line: ${statusLine}`);

  const headers = new Map(
    headerLines.map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()] as const;
    }),
  );
  let body = raw.subarray(headerEnd + 4);

  if (headers.get("transfer-encoding")?.toLowerCase().includes("chunked")) {
    body = decodeChunked(body);
  } else if (headers.has("content-length")) {
    body = body.subarray(0, Number(headers.get("content-length")));
  }
  return { status: Number(match[1]), body: body.toString("utf8") };
}

function decodeChunked(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  let pos = 0;
  while (pos < data.length) {
    const lineEnd = data.indexOf("\r\n", pos);
    if (lineEnd === -1) break;
    const size = parseInt(data.subarray(pos, lineEnd).toString("latin1"), 16);
    if (!size) break;
    parts.push(data.subarray(lineEnd + 2, lineEnd + 2 + size));
    pos = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}
