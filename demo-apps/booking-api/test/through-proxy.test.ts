// The booking API talks to Postgres *through* Deadheat's proxy: the app must behave exactly as
// before (v1 requirement: the proxy is transparent), and the oversell must still be found.
// The scenario's own setup/invariant queries go straight to Postgres, so they aren't observed.
import { fileURLToPath } from "node:url";
import { formatRun, loadScenario, naive, runScenario } from "@deadheat/core";
import { httpQueryLog } from "deadheat/cli";
import {
  QueryStore,
  startControl,
  startProxy,
  type ControlServer,
  type ProxyEvent,
  type RunningProxy,
} from "@deadheat/proxy";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIRECT = process.env.DATABASE_URL ?? "postgres://deadheat:deadheat@localhost:55432/deadheat";
const scenarioPath = fileURLToPath(
  new URL("../../../scenarios/booking-oversell.ts", import.meta.url),
);
const events: ProxyEvent[] = [];
const sql = postgres(DIRECT, { max: 2 });
let proxy: RunningProxy;
let control: ControlServer;
const store = new QueryStore();
let app: FastifyInstance;
let baseUrl: string;
let closePool: () => Promise<void>;
let buildAppFn: typeof import("../src/app.js").buildApp;

beforeAll(async () => {
  const upstream = new URL(DIRECT);
  proxy = await startProxy({
    upstream: { host: upstream.hostname, port: Number(upstream.port) },
    onEvent: (e) => {
      events.push(e);
      if (e.type === "query") store.add(e);
    },
  });
  control = await startControl({ store, holds: proxy });
  const viaProxy = new URL(DIRECT);
  viaProxy.hostname = "127.0.0.1";
  viaProxy.port = String(proxy.port);
  // db.ts reads DATABASE_URL when it's first imported, so set it before importing the app.
  // Vitest runs each test file in its own worker, so this doesn't leak into other files.
  process.env.DATABASE_URL = viaProxy.toString();
  const { applySchema, pool } = await import("../src/db.js");
  const { buildApp } = await import("../src/app.js");
  buildAppFn = buildApp;
  closePool = () => pool.end();
  await applySchema();
  app = buildApp("naive");
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app.close();
  await closePool();
  await sql.end();
  await control.close();
  await proxy.close();
});

describe("booking-api through the proxy", () => {
  it("still works, and the oversell is still found", async () => {
    const scenario = await loadScenario(scenarioPath);
    const run = await runScenario(scenario, { strategy: naive, sql, baseUrl, trials: 10 });

    expect(run.aborted).toBeUndefined();
    expect(run.violations).toBeGreaterThan(0);
    // Every request got a real answer (201 or 409), so nothing was lost or mangled in transit.
    const statuses = run.trials.flatMap((t) => t.requests.map((r) => r.status));
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);

    const opened = events.filter((e) => e.type === "connection-open");
    expect(opened.length).toBeGreaterThan(1); // the app's pool, all through the proxy
    expect(opened.every((e) => e.type === "connection-open" && e.user === "deadheat")).toBe(true);
  });

  it("puts each request's SQL under it, in order, and shows the interleaving", async () => {
    const scenario = await loadScenario(scenarioPath);
    const queryLog = await httpQueryLog(`http://127.0.0.1:${control.port}`);
    const run = await runScenario(scenario, {
      strategy: naive,
      sql,
      baseUrl,
      trials: 10,
      queryLog,
    });

    const shape = (sqls: string[]) => sqls.map((s) => s.split(" ")[0]);
    for (const t of run.trials) {
      for (const r of t.requests) {
        const steps = shape(r.queries!.map((q) => q.sql));
        // Every request reads capacity and counts; only the winners insert.
        expect(steps).toEqual(
          r.status === 201 ? ["SELECT", "SELECT", "INSERT"] : ["SELECT", "SELECT"],
        );
        expect(r.queries![0]!.params).toEqual(["1"]);
      }
    }

    // The evidence of the race: in a violating trial, several requests counted 0 bookings.
    const failed = run.trials.find((t) => !t.passed)!;
    const zeroCounts = failed.requests.filter((r) => r.queries![1]!.firstRow?.[0] === "0");
    expect(zeroCounts.length).toBeGreaterThan(1);

    expect(formatRun(run)).toMatch(
      /SQL, in the order it ran:\n {6}#\d+ +SELECT capacity FROM slots WHERE id = \$1 {2}\[1\] → 1/,
    );
    // The runner collected (and so removed) every query of this run from the proxy's store.
    const ids = run.trials.flatMap((t) => t.requests.map((r) => r.requestId!));
    expect(store.take(ids)).toEqual({});
  });

  it("widens: learns the decision reads in trial 1, then holds them", async () => {
    const scenario = await loadScenario(scenarioPath);
    const queryLog = await httpQueryLog(`http://127.0.0.1:${control.port}`);
    const run = await runScenario(scenario, {
      strategy: naive,
      sql,
      baseUrl,
      trials: 4,
      queryLog,
      widen: { holdMs: 100 },
    });

    expect(run.widen?.fingerprints.sort()).toEqual([
      "SELECT COUNT(*)::int AS count FROM bookings WHERE slot_id = $1",
      "SELECT capacity FROM slots WHERE id = $1",
    ]);
    const held = (t: number) =>
      run.trials[t]!.requests.flatMap((r) => r.queries!).filter((q) => q.heldMs === 100);
    expect(held(0)).toHaveLength(0); // trial 1 learns, unwidened
    expect(held(1).length).toBe(20 * 2); // then both reads of every request are held
    expect(run.violations).toBeGreaterThan(0);
    expect(proxy.holds).toBeNull(); // cleared at the end of the run

    const report = formatRun(run);
    expect(report).toContain("Widened: held the results of 2 decision read(s) for 100ms");
    expect(report).toContain("Pattern: check-then-act");
    expect(report).toMatch(/→ 0 {2}\(held 100ms\)/);
  });

  it("learns nothing from the single-statement variant: no separate read to hold", async () => {
    const single = buildAppFn("single-statement");
    const singleUrl = await single.listen({ port: 0, host: "127.0.0.1" });
    try {
      const scenario = await loadScenario(scenarioPath);
      const queryLog = await httpQueryLog(`http://127.0.0.1:${control.port}`);
      const run = await runScenario(scenario, {
        strategy: naive,
        sql,
        baseUrl: singleUrl,
        trials: 3,
        queryLog,
        widen: { holdMs: 100 },
      });
      expect(run.widen).toBeUndefined();
      expect(
        run.trials.flatMap((t) => t.requests.flatMap((r) => r.queries!)).some((q) => q.heldMs),
      ).toBe(false);
    } finally {
      await single.close();
    }
  });
});
