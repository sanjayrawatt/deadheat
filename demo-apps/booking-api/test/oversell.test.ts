// End-to-end: Deadheat's core runner + the real scenario file against the real booking API
// and Postgres. Needs `docker compose up -d` locally; CI provides a Postgres service.
import { fileURLToPath } from "node:url";
import { loadScenario, naive, runScenario, type Scenario } from "@deadheat/core";
import { EXIT_VIOLATION, main } from "deadheat/cli";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { applySchema, DEFAULT_DATABASE_URL, pool } from "../src/db.js";

const scenarioPath = fileURLToPath(
  new URL("../../../scenarios/booking-oversell.ts", import.meta.url),
);
const sql = postgres(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, { max: 2 });
let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  await applySchema();
  app = buildApp("naive");
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await sql.end();
});

describe("booking-oversell scenario", () => {
  it("finds the oversell in the naive variant", async () => {
    const scenario = await loadScenario(scenarioPath);
    const run = await runScenario(scenario, { strategy: naive, sql, baseUrl, trials: 20 });

    expect(run.aborted).toBeUndefined();
    expect(run.trials).toHaveLength(20);
    // The naive baseline violates in ~99% of trials (docs/BENCHMARKS.md), so 20 trials
    // with zero violations would mean the runner is broken.
    expect(run.violations).toBeGreaterThan(0);

    const failed = run.trials.find((t) => !t.passed);
    expect(failed?.violation).toMatch(/^bookings = \d+, capacity = 1$/);
    expect(failed?.requests.filter((r) => r.status === 201).length).toBeGreaterThan(1);
  });

  it("reports no violation when requests don't overlap (no false positives)", async () => {
    const scenario = await loadScenario(scenarioPath);
    const oneAtATime: Scenario = { ...scenario, actions: { ...scenario.actions, concurrency: 1 } };
    const run = await runScenario(oneAtATime, { strategy: naive, sql, baseUrl, trials: 5 });
    expect(run.violations).toBe(0);
  });

  it("works end to end through the CLI and exits 1 on a violation", async () => {
    const out: string[] = [];
    const code = await main(
      ["run", scenarioPath, "--base-url", baseUrl, "--trials", "10", "--settle", "5", "--no-save"],
      {
        out: (t) => void out.push(t),
        err: () => {},
        cwd: process.cwd(),
        env: { DEADHEAT_DATABASE_URL: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL },
      },
    );
    expect(code).toBe(EXIT_VIOLATION);
    expect(out.join("")).toMatch(
      /✗ slot is never oversold: \d+\/10 trials violated .*strategy=sync\(settle=5ms\)/,
    );
  });
});
