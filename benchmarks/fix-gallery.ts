// The fix gallery: every variant of both demo apps against every attack Deadheat has.
// Buggy variants should break; fixes should show 0 violations and 0 failed requests.
//
//   client ──► demo app (one variant at a time) ──► deadheat proxy (+ lock monitor) ──► Postgres
//
// Needs: docker compose up -d (Postgres) and `corepack pnpm build`.
// Usage: corepack pnpm fix-gallery [--trials 50] [--scheduled-trials 20] [--apps booking,wallet]
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createSync, loadScenario, runScenario, type RunOptions } from "@deadheat/core";
import { httpQueryLog } from "deadheat/cli";
import postgres from "postgres";

const { values } = parseArgs({
  options: {
    trials: { type: "string", default: "50" },
    "scheduled-trials": { type: "string", default: "20" },
    apps: { type: "string", default: "booking,wallet" },
  },
});
const DB = process.env.DATABASE_URL ?? "postgres://deadheat:deadheat@localhost:55432/deadheat";
const PROXY_PORT = 55443;
const CONTROL_PORT = 55444;
const children = new Set<ChildProcess>();

const apps = {
  booking: {
    dir: "../demo-apps/booking-api/",
    env: "BOOKING_VARIANT",
    port: 4100,
    scenario: "../scenarios/booking-oversell.ts",
    variants: ["naive", "single-statement", "for-update", "conditional", "serializable"],
  },
  wallet: {
    dir: "../demo-apps/wallet-api/",
    env: "WALLET_VARIANT",
    port: 4200,
    scenario: "../scenarios/wallet-overdraft.ts",
    variants: ["naive", "lost-update", "for-update", "conditional", "serializable"],
  },
};

function start(cmd: string, args: string[], ready: string, opts: object = {}) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return new Promise<ChildProcess>((resolve, reject) => {
    const check = (d: Buffer) => d.toString().includes(ready) && resolve(child);
    child.stdout!.on("data", check);
    child.stderr!.on("data", check);
    child.once("exit", (code) => reject(new Error(`${cmd} ${args.join(" ")} exited (${code})`)));
  });
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

const upstream = new URL(DB);
const viaProxy = new URL(DB);
viaProxy.hostname = "127.0.0.1";
viaProxy.port = String(PROXY_PORT);
const sql = postgres(DB, { max: 2, onnotice: () => {} });
const trials = Number(values.trials);
const scheduledTrials = Number(values["scheduled-trials"]);
const sync50 = createSync({ settleMs: 50 });
const attacks: { name: string; trials: number; run: Partial<RunOptions> }[] = [
  { name: "sync burst", trials, run: {} },
  { name: "widen 200ms", trials, run: { widen: { holdMs: 200 } } },
  { name: "random", trials: scheduledTrials, run: { schedule: { seed: 1, policy: "random" } } },
  { name: "pct(3)", trials: scheduledTrials, run: { schedule: { seed: 1, policy: "pct" } } },
  { name: "barrier", trials: scheduledTrials, run: { schedule: { seed: 1, policy: "barrier" } } },
];

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
      "--monitor-url",
      DB,
    ],
    "Ctrl-C",
  );
  const queryLog = await httpQueryLog(`http://127.0.0.1:${CONTROL_PORT}`);
  console.log(
    `fix gallery: ${trials} trials per burst/widen cell, ${scheduledTrials} per scheduled cell; cells show violated trials %, then failed requests (5xx or no response) if any\n`,
  );

  for (const name of values.apps.split(",") as (keyof typeof apps)[]) {
    const app = apps[name];
    const scenario = await loadScenario(fileURLToPath(new URL(app.scenario, import.meta.url)));
    console.log(`${name} (N=${scenario.actions.concurrency})`);
    console.log(`${"variant".padEnd(18)}${attacks.map((a) => a.name.padStart(16)).join("")}`);
    for (const variant of app.variants) {
      const server = await start("corepack", ["pnpm", "-s", "start"], "listening", {
        cwd: fileURLToPath(new URL(app.dir, import.meta.url)),
        env: {
          ...process.env,
          [app.env]: variant,
          PORT: String(app.port),
          DATABASE_URL: viaProxy.toString(),
        },
      });
      const cells: string[] = [];
      for (const attack of attacks) {
        const run = await runScenario(scenario, {
          strategy: sync50,
          sql,
          trials: attack.trials,
          queryLog,
          baseUrl: `http://127.0.0.1:${app.port}`,
          ...attack.run,
        });
        if (run.aborted) throw new Error(`${name}/${variant}/${attack.name}: ${run.aborted}`);
        const failed = run.trials
          .flatMap((t) => t.requests)
          .filter((r) => r.error || (r.status ?? 0) >= 500).length;
        const rate = `${((run.violations / run.trials.length) * 100).toFixed(0)}%`;
        cells.push((failed ? `${rate} (${failed} err)` : rate).padStart(16));
      }
      console.log(`${variant.padEnd(18)}${cells.join("")}`);
      await stop(server);
    }
    console.log("");
  }
} finally {
  await sql.end();
  await Promise.all([...children].map(stop));
}
