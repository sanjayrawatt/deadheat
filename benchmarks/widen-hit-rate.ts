// Hit rate with race-window widening: burst-only vs burst + the proxy holding decision reads.
//
//   client ──(jitter proxy: latency ± jitter)──► booking-api ──► deadheat proxy ──► Postgres
//
// The jitter proxy runs in this process rather than Toxiproxy in Docker: see jitter-proxy.ts.
// Needs: docker compose up -d (Postgres) and `corepack pnpm build`.
// Usage: corepack pnpm widen-hit-rate [--trials 100] [--concurrency 2,20] [--jitters 0,10]
//                                     [--hold 200] [--variant naive]
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createSync, loadScenario, naive, runScenario, type Scenario } from "@deadheat/core";
import { httpQueryLog } from "deadheat/cli";
import postgres from "postgres";
import { startJitterProxy, type JitterProxy } from "./jitter-proxy.js";

const { values } = parseArgs({
  options: {
    trials: { type: "string", default: "100" },
    concurrency: { type: "string", default: "2,20" },
    jitters: { type: "string", default: "0,10" },
    latency: { type: "string", default: "10" },
    hold: { type: "string", default: "200" },
    variant: { type: "string", default: "naive" },
  },
});
const trials = Number(values.trials);
const holdMs = Number(values.hold);
const DB = process.env.DATABASE_URL ?? "postgres://deadheat:deadheat@localhost:55432/deadheat";
const PROXY_PORT = 55443;
const CONTROL_PORT = 55444;
const API_PORT = 4100;
const JITTER_PORT = 4101;
const children: ChildProcess[] = [];

function start(cmd: string, args: string[], ready: string, opts: object = {}): Promise<void> {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  children.push(child);
  return new Promise((resolve, reject) => {
    const check = (d: Buffer) => d.toString().includes(ready) && resolve();
    child.stdout!.on("data", check);
    child.stderr!.on("data", check);
    child.once("exit", (code) => reject(new Error(`${cmd} ${args.join(" ")} exited (${code})`)));
  });
}

const upstream = new URL(DB);
const viaProxy = new URL(DB);
viaProxy.hostname = "127.0.0.1";
viaProxy.port = String(PROXY_PORT);

const sql = postgres(DB, { max: 2 });
let jitterProxy: JitterProxy | undefined;
try {
  await start(
    process.execPath,
    [
      fileURLToPath(new URL("../packages/cli/dist/bin.js", import.meta.url)),
      "proxy",
      "--quiet",
      "--upstream",
      `${upstream.hostname}:${upstream.port}`,
      "--port",
      String(PROXY_PORT),
      "--control-port",
      String(CONTROL_PORT),
    ],
    "Ctrl-C",
  );
  await start("corepack", ["pnpm", "-s", "start"], "listening", {
    cwd: fileURLToPath(new URL("../demo-apps/booking-api/", import.meta.url)),
    env: {
      ...process.env,
      BOOKING_VARIANT: values.variant,
      PORT: String(API_PORT),
      DATABASE_URL: viaProxy.toString(),
    },
  });
  jitterProxy = await startJitterProxy(JITTER_PORT, API_PORT);

  const queryLog = await httpQueryLog(`http://127.0.0.1:${CONTROL_PORT}`);
  const base = await loadScenario(
    fileURLToPath(new URL("../scenarios/booking-oversell.ts", import.meta.url)),
  );
  const sync50 = createSync({ settleMs: 50 });
  const columns = [
    { name: "naive", run: { strategy: naive } },
    { name: "sync", run: { strategy: sync50 } },
    { name: `sync+widen ${holdMs}ms`, run: { strategy: sync50, widen: { holdMs } } },
  ];

  console.log(
    `widening: variant=${values.variant}, ${trials} trials per cell, client→API latency ${values.latency}ms ± jitter (in-process jitter proxy), sync settle 50ms\n`,
  );
  console.log(`N   jitter   ${columns.map((c) => c.name.padStart(20)).join("")}`);
  for (const n of values.concurrency.split(",").map(Number)) {
    const scenario: Scenario = { ...base, actions: { ...base.actions, concurrency: n } };
    for (const jitter of values.jitters.split(",").map(Number)) {
      jitterProxy.setLatency(Number(values.latency), jitter);
      const cells: string[] = [];
      for (const c of columns) {
        const run = await runScenario(scenario, {
          sql,
          trials,
          queryLog,
          baseUrl: `http://127.0.0.1:${JITTER_PORT}`,
          ...c.run,
        });
        if (run.aborted) throw new Error(`${c.name}, N=${n}, jitter ${jitter}ms: ${run.aborted}`);
        cells.push(`${((run.violations / run.trials.length) * 100).toFixed(0)}%`.padStart(20));
      }
      console.log(`${String(n).padEnd(3)} ${`${jitter}ms`.padEnd(8)} ${cells.join("")}`);
    }
  }
} finally {
  await jitterProxy?.close();
  await sql.end();
  for (const c of children) c.kill("SIGTERM");
}
