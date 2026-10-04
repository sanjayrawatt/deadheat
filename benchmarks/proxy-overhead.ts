// Proxy overhead: query latency straight to Postgres vs through `deadheat proxy`.
// The proxy runs in its own process (the real CLI), so it doesn't share the client's event loop.
//
// Needs: docker compose up -d, and a build (`corepack pnpm build`).
// Usage: corepack pnpm proxy-overhead [--queries 2000] [--port 55499] [--log]
// By default the proxy runs with --quiet (no per-query log line), as under `deadheat run --proxy`.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { percentile } from "@deadheat/core";
import pg from "pg";

const { values } = parseArgs({
  options: {
    queries: { type: "string", default: "2000" },
    port: { type: "string", default: "55499" },
    log: { type: "boolean", default: false },
  },
});
const N = Number(values.queries);
const DIRECT = process.env.DATABASE_URL ?? "postgres://deadheat:deadheat@localhost:55432/deadheat";
const upstream = new URL(DIRECT);

const proxyProcess = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("../packages/cli/dist/bin.js", import.meta.url)),
    "proxy",
    "--upstream",
    `${upstream.hostname}:${upstream.port}`,
    "--port",
    values.port,
    "--control-port",
    "0",
    ...(values.log ? [] : ["--quiet"]),
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
await new Promise<void>((resolve, reject) => {
  proxyProcess.stderr.on("data", (d: Buffer) => d.toString().includes("Ctrl-C") && resolve());
  proxyProcess.once("exit", (code) => reject(new Error(`proxy exited (${code})`)));
});
const viaProxy = new URL(DIRECT);
viaProxy.hostname = "127.0.0.1";
viaProxy.port = values.port;

/** Sequential round trips on one connection; returns per-query latencies in µs, sorted. */
async function latencies(url: string, query: (c: pg.Client) => Promise<unknown>) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (let i = 0; i < 200; i++) await query(client); // warm-up
    const out: number[] = [];
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      await query(client);
      out.push((performance.now() - t) * 1000);
    }
    return out.sort((a, b) => a - b);
  } finally {
    await client.end();
  }
}

/** Queries per second with 10 connections in parallel. */
async function throughput(url: string): Promise<number> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  try {
    await Promise.all(Array.from({ length: 10 }, () => pool.query("SELECT 1")));
    const t = performance.now();
    await Promise.all(Array.from({ length: N * 2 }, (_, i) => pool.query("SELECT $1::int", [i])));
    return (N * 2) / ((performance.now() - t) / 1000);
  } finally {
    await pool.end();
  }
}

try {
  const cases: [string, (c: pg.Client) => Promise<unknown>][] = [
    ["simple   SELECT 1", (c) => c.query("SELECT 1")],
    ["extended SELECT $1", (c) => c.query("SELECT $1::int", [1])],
  ];
  console.log(
    `proxy overhead: ${N} sequential queries per row, after 200 warm-up, proxy ${values.log ? "logging" : "--quiet"}\n`,
  );
  console.log("query                 path      p50 µs   p90 µs   p99 µs");
  for (const [name, q] of cases) {
    for (const [path, url] of [
      ["direct", DIRECT],
      ["proxy", viaProxy.toString()],
    ] as const) {
      const l = await latencies(url, q);
      const cols = [50, 90, 99].map((p) => percentile(l, p).toFixed(0).padStart(8));
      console.log(`${name.padEnd(21)} ${path.padEnd(7)} ${cols.join(" ")}`);
    }
  }
  const direct = await throughput(DIRECT);
  const proxied = await throughput(viaProxy.toString());
  console.log(
    `\nthroughput (10 connections, ${N * 2} extended queries): direct ${direct.toFixed(0)} q/s, proxy ${proxied.toFixed(0)} q/s (${((proxied / direct) * 100).toFixed(0)}%)`,
  );
} finally {
  proxyProcess.kill("SIGTERM");
}
