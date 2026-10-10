import { randomInt } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createSync,
  DEFAULT_SETTLE_MS,
  formatRun,
  formatTrialDetail,
  loadScenario,
  runScenario,
  RUN_FORMAT_VERSION,
  strategies,
  VERSION,
  type QueryLog,
  type QueryRecord,
  type RunResult,
  type ScheduleStep,
  type Strategy,
} from "@deadheat/core";
import {
  QueryStore,
  startControl,
  startProxy,
  type ProxyEvent,
  type QueryEvent,
} from "@deadheat/proxy";
import postgres from "postgres";

export const EXIT_OK = 0;
export const EXIT_VIOLATION = 1;
export const EXIT_ERROR = 2;

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  cwd: string;
  env: Record<string, string | undefined>;
  /** Stops long-running commands (`deadheat proxy`). Defaults to Ctrl-C / SIGTERM. */
  signal?: AbortSignal;
}

const defaultIo: Io = {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  cwd: process.cwd(),
  env: process.env,
};

export const DEFAULT_PROXY_PORT = 55433;
export const DEFAULT_CONTROL_PORT = 55434;

const HELP = `deadheat ${VERSION}: find the race conditions in your API before your users do

Usage:
  deadheat run <scenario.ts> [options]     attack an API and check the invariant
  deadheat proxy [options]                 sit between an app and Postgres, print every query
  deadheat show [run-id | file.json]       print a saved run again (default: the latest)

Run options:
  --strategy <name>      ${Object.keys(strategies).join(" | ")} (default: sync)
  --trials <n>           number of trials (default: the scenario's \`trials\`, else 100)
  --settle <ms>          sync only: wait between priming and release (default: ${DEFAULT_SETTLE_MS}).
                         Use ~50 when the API sits behind a proxy or load balancer
  --base-url <url>       override the scenario's baseUrl
  --database-url <url>   database for setup/invariant (or env DEADHEAT_DATABASE_URL)
  --proxy <url>          a running \`deadheat proxy\` control URL (e.g. http://127.0.0.1:${DEFAULT_CONTROL_PORT});
                         adds each request's SQL to the report (the app needs @deadheat/agent)
  --widen <ms>           with --proxy: after trial 1, hold the results of the reads each request
                         acts on (decision reads) for <ms>, so concurrent requests all read
                         before any writes. Makes rare races show up on almost every trial
  --schedule random      with --proxy: hold every request's queries and release them one at a
                         time in a seeded random order (controlled interleaving)
  --seed <n>             seed for --schedule (default: random, printed in the report). The same
                         seed gives the same release order
  --no-save              don't write the run to .deadheat/runs/<run-id>.json
  --verbose              list every violating trial in full

Show options:
  --trial <n>            print trial <n> in full: every request and all of its SQL, in order
  --verbose              list every violating trial in full

Proxy options:
  --upstream <host:port> the real Postgres (default: host/port of DEADHEAT_DATABASE_URL)
  --port <n>             port to listen on (default: ${DEFAULT_PROXY_PORT}); point the app's DATABASE_URL here
  --control-port <n>     where \`deadheat run --proxy\` collects queries (default: ${DEFAULT_CONTROL_PORT})
  -q, --quiet            don't print each query

  -h, --help             show this help
  -v, --version          show the version

Exit codes: 0 no violation, 1 invariant violated, 2 error or aborted run.
`;

/** The whole CLI as a function, so tests can run it without spawning a process. */
export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  if (argv[0] === "proxy") return proxyCommand(argv.slice(1), io);
  if (argv[0] === "show") return showCommand(argv.slice(1), io);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        strategy: { type: "string", default: "sync" },
        trials: { type: "string" },
        settle: { type: "string" },
        "base-url": { type: "string" },
        "database-url": { type: "string" },
        proxy: { type: "string" },
        widen: { type: "string" },
        schedule: { type: "string" },
        seed: { type: "string" },
        save: { type: "boolean", default: true },
        verbose: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (err) {
    io.err(`${(err as Error).message}\n\n${HELP}`);
    return EXIT_ERROR;
  }
  const { values, positionals } = parsed;

  if (values.version) {
    io.out(`deadheat ${VERSION}\n`);
    return EXIT_OK;
  }
  const [command, scenarioPath, ...extra] = positionals;
  if (values.help || !command) {
    (values.help ? io.out : io.err)(HELP);
    return values.help ? EXIT_OK : EXIT_ERROR;
  }
  if (command !== "run" || !scenarioPath || extra.length) {
    io.err(`Expected: deadheat run <scenario.ts>\n\n${HELP}`);
    return EXIT_ERROR;
  }

  const fail = (message: string) => {
    io.err(`error: ${message}\n`);
    return EXIT_ERROR;
  };

  const strategy = pickStrategy(values.strategy, values.settle);
  if (typeof strategy === "string") return fail(strategy);

  let trials: number | undefined;
  if (values.trials !== undefined) {
    trials = Number(values.trials);
    if (!Number.isInteger(trials) || trials < 1) return fail("--trials must be an integer >= 1");
  }

  let widenMs: number | undefined;
  if (values.widen !== undefined) {
    widenMs = Number(values.widen);
    if (!values.proxy) return fail("--widen needs --proxy (the proxy is what holds the reads)");
    if (!Number.isInteger(widenMs) || widenMs < 1 || widenMs > 60_000) {
      return fail("--widen must be an integer between 1 and 60000 (ms)");
    }
  }

  let seed: number | undefined;
  if (values.schedule !== undefined) {
    if (values.schedule !== "random") return fail('--schedule must be "random"');
    if (!values.proxy)
      return fail("--schedule needs --proxy (the proxy is what holds the queries)");
    if (widenMs) return fail("use either --widen or --schedule, not both");
    seed = values.seed === undefined ? randomInt(2 ** 31) : Number(values.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) {
      return fail("--seed must be an integer between 0 and 4294967295");
    }
  } else if (values.seed !== undefined) {
    return fail("--seed only applies to --schedule");
  }

  const databaseUrl = values["database-url"] ?? io.env.DEADHEAT_DATABASE_URL;
  if (!databaseUrl) {
    return fail("no database: pass --database-url or set DEADHEAT_DATABASE_URL");
  }

  let queryLog: QueryLog | undefined;
  if (values.proxy) {
    try {
      queryLog = await httpQueryLog(values.proxy);
    } catch (err) {
      return fail(`cannot reach deadheat proxy at ${values.proxy}: ${(err as Error).message}`);
    }
  }

  let scenario;
  try {
    scenario = await loadScenario(resolve(io.cwd, scenarioPath));
  } catch (err) {
    return fail((err as Error).message);
  }

  const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  try {
    const run = await runScenario(scenario, {
      strategy,
      sql,
      ...(trials !== undefined ? { trials } : {}),
      ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
      ...(queryLog ? { queryLog } : {}),
      ...(widenMs ? { widen: { holdMs: widenMs } } : {}),
      ...(seed !== undefined ? { schedule: { seed } } : {}),
      onTrial: (t) => io.err(t.passed ? "." : "x"),
    });
    run.config.scenarioFile = relative(io.cwd, resolve(io.cwd, scenarioPath));
    io.err("\n");
    io.out(`${formatRun(run, values.verbose ? { maxViolations: Infinity } : {})}\n`);

    if (values.save) {
      const dir = join(io.cwd, ".deadheat", "runs");
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${run.runId}.json`);
      await writeFile(file, `${JSON.stringify(run, null, 2)}\n`);
      io.out(`  Saved: ${file}\n`);
    }

    if (run.aborted) return EXIT_ERROR;
    return run.violations ? EXIT_VIOLATION : EXIT_OK;
  } catch (err) {
    return fail((err as Error).message);
  } finally {
    await sql.end();
  }
}

async function showCommand(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        trial: { type: "string" },
        verbose: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    io.err(`${(err as Error).message}\n\n${HELP}`);
    return EXIT_ERROR;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(HELP);
    return EXIT_OK;
  }
  const fail = (message: string) => {
    io.err(`error: ${message}\n`);
    return EXIT_ERROR;
  };
  if (positionals.length > 1) return fail("Expected: deadheat show [run-id | file.json]");

  let trialNo: number | undefined;
  if (values.trial !== undefined) {
    trialNo = Number(values.trial);
    if (!Number.isInteger(trialNo) || trialNo < 1) return fail("--trial must be an integer >= 1");
  }

  const dir = join(io.cwd, ".deadheat", "runs");
  const [target] = positionals;
  let file: string;
  if (!target) {
    const names = (await readdir(dir).catch(() => [] as string[]))
      .filter((n) => n.endsWith(".json"))
      .sort();
    if (!names.length) return fail(`no saved runs in ${dir}`);
    file = join(dir, names.at(-1)!);
  } else {
    file = target.endsWith(".json") ? resolve(io.cwd, target) : join(dir, `${target}.json`);
  }

  let run: RunResult;
  try {
    run = JSON.parse(await readFile(file, "utf8")) as RunResult;
  } catch (err) {
    return fail(`cannot read ${file}: ${(err as Error).message}`);
  }
  if ((run.formatVersion ?? 0) > RUN_FORMAT_VERSION) {
    return fail(
      `${file} uses run format ${run.formatVersion}, newer than this deadheat (${RUN_FORMAT_VERSION}). Upgrade deadheat.`,
    );
  }

  if (trialNo === undefined) {
    io.out(`${formatRun(run, values.verbose ? { maxViolations: Infinity } : {})}\n`);
    return EXIT_OK;
  }
  const trial = run.trials.find((t) => t.trial === trialNo);
  if (!trial) return fail(`${run.runId} has no trial ${trialNo} (it has ${run.trials.length})`);
  io.out(`${run.scenario}, ${run.runId}, strategy=${run.strategy}\n${formatTrialDetail(trial)}\n`);
  return EXIT_OK;
}

function pickStrategy(name: string, settle: string | undefined): Strategy | string {
  if (settle !== undefined) {
    if (name !== "sync") return "--settle only applies to --strategy sync";
    const settleMs = Number(settle);
    if (!Number.isFinite(settleMs) || settleMs < 0) return "--settle must be a number >= 0";
    return createSync({ settleMs });
  }
  return (
    strategies[name] ??
    `unknown strategy "${name}". Use one of: ${Object.keys(strategies).join(", ")}`
  );
}

async function proxyCommand(argv: string[], io: Io): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        upstream: { type: "string" },
        port: { type: "string", default: String(DEFAULT_PROXY_PORT) },
        "control-port": { type: "string", default: String(DEFAULT_CONTROL_PORT) },
        quiet: { type: "boolean", short: "q", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    io.err(`${(err as Error).message}\n\n${HELP}`);
    return EXIT_ERROR;
  }
  if (values.help) {
    io.out(HELP);
    return EXIT_OK;
  }
  const fail = (message: string) => {
    io.err(`error: ${message}\n`);
    return EXIT_ERROR;
  };

  let upstream = values.upstream;
  if (!upstream && io.env.DEADHEAT_DATABASE_URL) {
    const url = new URL(io.env.DEADHEAT_DATABASE_URL);
    upstream = `${url.hostname}:${url.port || 5432}`;
  }
  const match = upstream ? /^(.+):(\d+)$/.exec(upstream) : null;
  if (!match) return fail("pass --upstream host:port (or set DEADHEAT_DATABASE_URL)");
  const port = Number(values.port);
  const controlPort = Number(values["control-port"]);
  for (const [flag, n] of [
    ["--port", port],
    ["--control-port", controlPort],
  ] as const) {
    if (!Number.isInteger(n) || n < 0 || n > 65535) return fail(`${flag} must be 0-65535`);
  }

  const store = new QueryStore();
  let proxy;
  let control;
  try {
    proxy = await startProxy({
      upstream: { host: match[1]!, port: Number(match[2]) },
      port,
      onEvent: (e) => {
        if (e.type === "query") store.add(e);
        if (!values.quiet) io.out(`${formatProxyEvent(e)}\n`);
      },
    });
    control = await startControl({ store, port: controlPort, holds: proxy, schedule: proxy });
  } catch (err) {
    await proxy?.close();
    return fail(`could not listen: ${(err as Error).message}`);
  }
  io.err(
    `deadheat proxy: 127.0.0.1:${proxy.port} → ${upstream}. Point your app's DATABASE_URL at port ${proxy.port}.\n` +
      `control: http://127.0.0.1:${control.port} (use with deadheat run --proxy). Ctrl-C to stop.\n`,
  );

  const signal = io.signal ?? processSignal();
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await control.close();
  await proxy.close();
  return EXIT_OK;
}

/** A QueryLog backed by a running proxy's control server. Fails fast if it isn't there. */
export async function httpQueryLog(controlUrl: string): Promise<QueryLog> {
  const base = controlUrl.replace(/\/+$/, "");
  const health = await fetch(`${base}/health`);
  if (!health.ok) throw new Error(`/health returned ${health.status}`);
  return {
    async take(requestIds) {
      const res = await fetch(`${base}/take`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestIds }),
      });
      if (!res.ok) throw new Error(`deadheat proxy /take returned ${res.status}`);
      const { queries } = (await res.json()) as { queries: Record<string, QueryEvent[]> };
      const out: Record<string, QueryRecord[]> = {};
      for (const [id, events] of Object.entries(queries)) out[id] = events.map(toRecord);
      return out;
    },
    async setHolds(holds) {
      const res = await fetch(`${base}/holds`, {
        method: holds ? "PUT" : "DELETE",
        headers: { "content-type": "application/json" },
        ...(holds ? { body: JSON.stringify(holds) } : {}),
      });
      if (!res.ok) throw new Error(`deadheat proxy /holds returned ${res.status}`);
    },
    async startSchedule(config) {
      const res = await fetch(`${base}/schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!res.ok) throw new Error(`deadheat proxy /schedule returned ${res.status}`);
    },
    async stopSchedule() {
      const res = await fetch(`${base}/schedule`, { method: "DELETE" });
      if (!res.ok) throw new Error(`deadheat proxy /schedule returned ${res.status}`);
      return ((await res.json()) as { order: ScheduleStep[] }).order;
    },
  };
}

function toRecord(e: QueryEvent): QueryRecord {
  return {
    sql: e.sql,
    ...(e.params ? { params: e.params } : {}),
    rows: e.rows,
    ...(e.firstRow ? { firstRow: e.firstRow } : {}),
    commandTags: e.commandTags,
    ...(e.error ? { error: e.error } : {}),
    startedAt: e.startedAt,
    durationMs: e.durationMs,
    txStatus: e.txStatus,
    ...(e.heldMs ? { heldMs: e.heldMs } : {}),
    connectionId: e.connectionId,
    protocol: e.protocol,
  };
}

function processSignal(): AbortSignal {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return controller.signal;
}

/** One log line per proxy event. */
export function formatProxyEvent(e: ProxyEvent): string {
  const id = `#${e.connectionId}`.padEnd(4);
  switch (e.type) {
    case "connection-open":
      return `${id} connected  user=${e.user ?? "?"} db=${e.database ?? "?"}${e.applicationName ? ` app=${e.applicationName}` : ""}`;
    case "connection-close":
      return `${id} closed after ${e.queries} ${e.queries === 1 ? "query" : "queries"}`;
    case "query": {
      const sql = e.sql.replace(/\s+/g, " ").trim();
      const shown = sql.length > 100 ? `${sql.slice(0, 99)}…` : sql;
      const outcome = e.error
        ? `ERROR ${e.error.code} ${e.error.message}`
        : `${e.commandTags.join(", ")}${e.rows ? ` (${e.rows} ${e.rows === 1 ? "row" : "rows"})` : ""}`;
      const rid = e.requestId ? ` {${e.requestId}}` : "";
      const held = e.heldMs ? ` (held ${e.heldMs}ms)` : "";
      return `${id} ${e.durationMs.toFixed(1).padStart(7)}ms [${e.txStatus}] ${shown} → ${outcome}${held}${rid}`;
    }
  }
}
