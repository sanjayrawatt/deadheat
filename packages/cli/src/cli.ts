import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createSync,
  DEFAULT_SETTLE_MS,
  formatRun,
  loadScenario,
  runScenario,
  strategies,
  VERSION,
  type Strategy,
} from "@deadheat/core";
import postgres from "postgres";

export const EXIT_OK = 0;
export const EXIT_VIOLATION = 1;
export const EXIT_ERROR = 2;

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  cwd: string;
  env: Record<string, string | undefined>;
}

const defaultIo: Io = {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  cwd: process.cwd(),
  env: process.env,
};

const HELP = `deadheat ${VERSION}: find the race conditions in your API before your users do

Usage:
  deadheat run <scenario.ts> [options]

Options:
  --strategy <name>      ${Object.keys(strategies).join(" | ")} (default: sync)
  --trials <n>           number of trials (default: the scenario's \`trials\`, else 100)
  --settle <ms>          sync only: wait between priming and release (default: ${DEFAULT_SETTLE_MS}).
                         Use ~50 when the API sits behind a proxy or load balancer
  --base-url <url>       override the scenario's baseUrl
  --database-url <url>   database for setup/invariant (or env DEADHEAT_DATABASE_URL)
  --no-save              don't write the run to .deadheat/runs/<run-id>.json
  --verbose              list every violating trial in full
  -h, --help             show this help
  -v, --version          show the version

Exit codes: 0 no violation, 1 invariant violated, 2 error or aborted run.
`;

/** The whole CLI as a function, so tests can run it without spawning a process. */
export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
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

  const databaseUrl = values["database-url"] ?? io.env.DEADHEAT_DATABASE_URL;
  if (!databaseUrl) {
    return fail("no database: pass --database-url or set DEADHEAT_DATABASE_URL");
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
      onTrial: (t) => io.err(t.passed ? "." : "x"),
    });
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
