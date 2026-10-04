// End-to-end: the wallet scenario against both buggy variants, through the sync strategy.
// Needs `docker compose up -d` locally; CI provides a Postgres service.
import { fileURLToPath } from "node:url";
import { createSync, loadScenario, runScenario, type Scenario } from "@deadheat/core";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { applySchema, DEFAULT_DATABASE_URL, pool } from "../src/db.js";
import type { VariantName } from "../src/variants.js";

const scenarioPath = fileURLToPath(
  new URL("../../../scenarios/wallet-overdraft.ts", import.meta.url),
);
const sql = postgres(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, { max: 2 });
const strategy = createSync({ settleMs: 5 }); // localhost needs no long settle
let scenario: Scenario;

beforeAll(async () => {
  await applySchema();
  scenario = await loadScenario(scenarioPath);
});

afterAll(async () => {
  await pool.end();
  await sql.end();
});

async function withApp<T>(variant: VariantName, fn: (baseUrl: string) => Promise<T>) {
  const app: FastifyInstance = buildApp(variant);
  try {
    return await fn(await app.listen({ port: 0, host: "127.0.0.1" }));
  } finally {
    await app.close();
  }
}

describe("wallet-overdraft scenario", () => {
  it("catches the overdraft in the naive variant", async () => {
    const run = await withApp("naive", (baseUrl) =>
      runScenario(scenario, { strategy, sql, baseUrl, trials: 10 }),
    );
    expect(run.aborted).toBeUndefined();
    expect(run.violations).toBeGreaterThan(0);
    expect(run.trials.find((t) => !t.passed)?.violation).toMatch(/^overdraft: account [12] = -\d+/);
  });

  it("catches the lost update (a credit overwritten) in the lost-update variant", async () => {
    const run = await withApp("lost-update", (baseUrl) =>
      runScenario(scenario, { strategy, sql, baseUrl, trials: 10 }),
    );
    expect(run.violations).toBeGreaterThan(0);
    expect(run.trials.find((t) => !t.passed)?.violation).toMatch(
      /^money not conserved: total = 100, expected 200$/,
    );
  });

  it.each(["naive", "lost-update"] as const)(
    "reports no violation for %s when requests don't overlap (no false positives)",
    async (variant) => {
      const oneAtATime: Scenario = {
        ...scenario,
        actions: { ...scenario.actions, concurrency: 1 },
      };
      const run = await withApp(variant, (baseUrl) =>
        runScenario(oneAtATime, { strategy, sql, baseUrl, trials: 5 }),
      );
      expect(run.violations).toBe(0);
      expect(run.trials.every((t) => t.requests[0]?.status === 201)).toBe(true);
    },
  );
});
