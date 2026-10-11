// The wallet API talks to Postgres through Deadheat's proxy while the scheduler controls the
// order of its queries. Transfers run in transactions and take row locks, so this is where a
// released query waits on a lock held by a request the scheduler is holding back.
import { fileURLToPath } from "node:url";
import { createSync, formatRun, loadScenario, runScenario, type Scenario } from "@deadheat/core";
import { httpQueryLog } from "deadheat/cli";
import {
  QueryStore,
  startControl,
  startProxy,
  type ControlServer,
  type RunningProxy,
} from "@deadheat/proxy";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIRECT = process.env.DATABASE_URL ?? "postgres://deadheat:deadheat@localhost:55432/deadheat";
const scenarioPath = fileURLToPath(
  new URL("../../../scenarios/wallet-overdraft.ts", import.meta.url),
);
const sql = postgres(DIRECT, { max: 2 });
const monitorSql = postgres(DIRECT, { max: 1, onnotice: () => {} });
const store = new QueryStore();
let proxy: RunningProxy;
let control: ControlServer;
let app: FastifyInstance;
let baseUrl: string;
let closePool: () => Promise<void>;
let scenario: Scenario;

beforeAll(async () => {
  const upstream = new URL(DIRECT);
  proxy = await startProxy({
    upstream: { host: upstream.hostname, port: Number(upstream.port) },
    onEvent: (e) => {
      if (e.type === "query") store.add(e);
    },
    monitor: {
      blockers: async (pids) => {
        const rows = await monitorSql<{ pid: number; by: number[] }[]>`
          SELECT pid, pg_blocking_pids(pid) AS by FROM unnest(${pids}::int[]) AS pid`;
        return new Map(rows.map((r) => [r.pid, r.by]));
      },
    },
  });
  control = await startControl({ store, holds: proxy, schedule: proxy });
  const viaProxy = new URL(DIRECT);
  viaProxy.hostname = "127.0.0.1";
  viaProxy.port = String(proxy.port);
  // db.ts reads DATABASE_URL when it's first imported, so set it before importing the app.
  process.env.DATABASE_URL = viaProxy.toString();
  const { applySchema, pool } = await import("../src/db.js");
  const { buildApp } = await import("../src/app.js");
  closePool = () => pool.end();
  await applySchema();
  app = buildApp("naive");
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  const base = await loadScenario(scenarioPath);
  scenario = { ...base, actions: { ...base.actions, concurrency: 4 } };
});

afterAll(async () => {
  await app.close();
  await closePool();
  await sql.end();
  await monitorSql.end();
  await control.close();
  await proxy.close();
});

describe("wallet-api through the scheduling proxy", () => {
  for (const policy of ["random", "barrier"] as const) {
    it(`${policy}: finds the overdraft and explains every blocked step with a lock holder`, async () => {
      const queryLog = await httpQueryLog(`http://127.0.0.1:${control.port}`);
      const run = await runScenario(scenario, {
        strategy: createSync({ settleMs: 5 }),
        sql,
        baseUrl,
        trials: 8,
        queryLog,
        schedule: { seed: 11, policy, quietMs: 20 },
      });

      expect(run.aborted).toBeUndefined();
      expect(run.violations).toBeGreaterThan(0);
      const steps = run.trials.flatMap((t) => t.schedule!);
      const blocked = steps.filter((s) => s.stalled);
      expect(blocked.length).toBeGreaterThan(0); // transfers to account 3 queue on its row lock
      for (const s of blocked) expect(s.blockedBy?.length).toBeGreaterThan(0);
      // Found by pg_blocking_pids within ~10ms each, not the 2s safety timeout.
      expect(run.durationMs).toBeLessThan(8 * 1500);
      if (run.trials.some((t) => !t.passed && t.schedule!.some((s) => s.blockedBy))) {
        expect(formatRun(run)).toContain("Lock waits (request → holder of the lock it waited on)");
      }
    });
  }
});
