// Hit rate under network jitter: naive vs sync, with Toxiproxy adding latency ± jitter on
// the client → API path. On localhost both strategies hit ~99% (BENCHMARKS.md §1), so this
// asks whether sync holds up better once the network adds noise.
//
// Needs: docker compose --profile bench up -d   (Postgres + Toxiproxy)
// Usage: corepack pnpm jitter-hit-rate [--variant single-statement] [--trials 100]
//                                      [--latency 10] [--jitters 0,1,3,10]
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createSync, loadScenario, naive, runScenario, sync } from "@deadheat/core";
import postgres from "postgres";

const { values } = parseArgs({
  options: {
    variant: { type: "string", default: "single-statement" },
    trials: { type: "string", default: "100" },
    latency: { type: "string", default: "10" },
    jitters: { type: "string", default: "0,1,3,10" },
  },
});
const TOXI = "http://127.0.0.1:8474";
const API_PORT = 4100;
const PROXY_PORT = 4101;
const trials = Number(values.trials);
const latency = Number(values.latency);
const jitters = values.jitters.split(",").map(Number);
// sync (settle 0, the default) vs settle 50ms shows what the settle delay buys behind a proxy.
const strategies = [naive, sync, createSync({ settleMs: 50 })];

async function toxi(method: string, path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${TOXI}${path}`, {
    method,
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  if (!res.ok && !(method === "DELETE" && res.status === 404)) {
    throw new Error(`toxiproxy ${method} ${path}: ${res.status} ${await res.text()}`);
  }
}

// Start the booking API with the requested variant.
const api = spawn("corepack", ["pnpm", "-s", "start"], {
  cwd: fileURLToPath(new URL("../demo-apps/booking-api/", import.meta.url)),
  env: { ...process.env, BOOKING_VARIANT: values.variant, PORT: String(API_PORT) },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise<void>((resolve, reject) => {
  api.stdout.on("data", (d: Buffer) => d.toString().includes("listening") && resolve());
  api.once("exit", (code) => reject(new Error(`booking-api exited (${code})`)));
});

const sql = postgres(
  process.env.DATABASE_URL ?? "postgres://deadheat:deadheat@localhost:55432/deadheat",
  { max: 2 },
);
try {
  await toxi("DELETE", "/proxies/booking");
  await toxi("POST", "/proxies", {
    name: "booking",
    listen: `0.0.0.0:${PROXY_PORT}`,
    upstream: `host.docker.internal:${API_PORT}`,
  });

  const scenario = await loadScenario(
    fileURLToPath(new URL("../scenarios/booking-oversell.ts", import.meta.url)),
  );
  console.log(
    `hit rate under jitter: variant=${values.variant}, ${trials} trials × ${scenario.actions.concurrency} requests, latency ${latency}ms on client→API\n`,
  );
  console.log(`jitter ms  ${strategies.map((s) => s.name.padStart(18)).join("")}`);

  // Baseline without Toxiproxy, straight to the API.
  const direct: string[] = [];
  for (const strategy of strategies) {
    const run = await runScenario(scenario, {
      strategy,
      sql,
      trials,
      baseUrl: `http://127.0.0.1:${API_PORT}`,
    });
    if (run.aborted) throw new Error(run.aborted);
    direct.push(`${((run.violations / run.trials.length) * 100).toFixed(0)}%`.padStart(18));
  }
  console.log(`${"direct".padStart(9)}  ${direct.join("")}`);

  for (const jitter of jitters) {
    await toxi("DELETE", "/proxies/booking/toxics/lat");
    await toxi("POST", "/proxies/booking/toxics", {
      name: "lat",
      type: "latency",
      stream: "upstream",
      attributes: { latency, jitter },
    });
    const rates: string[] = [];
    for (const strategy of strategies) {
      const run = await runScenario(scenario, {
        strategy,
        sql,
        trials,
        baseUrl: `http://127.0.0.1:${PROXY_PORT}`,
      });
      if (run.aborted) throw new Error(run.aborted);
      rates.push(`${((run.violations / run.trials.length) * 100).toFixed(0)}%`.padStart(18));
    }
    console.log(`${String(jitter).padStart(9)}  ${rates.join("")}`);
  }
} finally {
  await toxi("DELETE", "/proxies/booking").catch(() => {});
  await sql.end();
  api.kill("SIGTERM");
}
