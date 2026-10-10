import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { deriveSeed, runScenario } from "./runner.js";
import type { RequestTrace, Scenario, ScheduleStep, Strategy, TrialSchedule } from "./types.js";

// The fake scenarios below never touch the DB, so an empty object stands in for the client.
const sql = {} as Sql;

/** A strategy that "sends" instantly and makes the invariant fail on the listed trials. */
function fakeStrategy(state: { trial: number }): Strategy {
  return {
    name: "fake",
    async fire(_baseUrl, specs) {
      state.trial++;
      return specs.map((s, index): RequestTrace => ({
        index,
        method: s.method,
        url: s.url,
        sentAtMs: index,
        status: 201,
      }));
    },
  };
}

function makeScenario(failOn: number[], state: { trial: number }, extra: Partial<Scenario> = {}) {
  return {
    name: "fake",
    baseUrl: "http://127.0.0.1:1",
    actions: { concurrency: 3, request: (i: number) => ({ method: "POST", url: `/x/${i}` }) },
    invariant: async ({ responses }) =>
      responses.length === 0 || !failOn.includes(state.trial) || `broke on trial ${state.trial}`,
    trials: 5,
    ...extra,
  } satisfies Scenario;
}

describe("runScenario", () => {
  it("counts violations and records each trial", async () => {
    const state = { trial: 0 };
    const onTrial = vi.fn();
    const run = await runScenario(makeScenario([2, 4], state), {
      strategy: fakeStrategy(state),
      sql,
      onTrial,
    });

    expect(run.trials).toHaveLength(5);
    expect(run.violations).toBe(2);
    expect(run.trials.filter((t) => !t.passed).map((t) => t.trial)).toEqual([2, 4]);
    expect(run.trials[1]?.violation).toBe("broke on trial 2");
    expect(run.trials[0]?.requests).toHaveLength(3);
    expect(onTrial).toHaveBeenCalledTimes(5);
    expect(run.strategy).toBe("fake");
    expect(run.runId).toMatch(/^run-\d{8}T\d{6}-[0-9a-f]{4}$/);
    expect(run.formatVersion).toBe(1);
    expect(run.config).toEqual({ baseUrl: "http://127.0.0.1:1", concurrency: 3, trials: 5 });
  });

  it("lets options.trials override scenario.trials", async () => {
    const state = { trial: 0 };
    const run = await runScenario(makeScenario([], state), {
      strategy: fakeStrategy(state),
      sql,
      trials: 2,
    });
    expect(run.trials).toHaveLength(2);
  });

  it("runs setup before every trial", async () => {
    const state = { trial: 0 };
    const setup = vi.fn(async () => {});
    await runScenario(makeScenario([], state, { setup, trials: 3 }), {
      strategy: fakeStrategy(state),
      sql,
    });
    expect(setup).toHaveBeenCalledTimes(3);
  });

  it("aborts instead of passing when no request reaches the app", async () => {
    const state = { trial: 0 };
    const unreachable: Strategy = {
      name: "fake",
      fire: async (_baseUrl, specs) =>
        specs.map((s, index) => ({
          index,
          method: s.method,
          url: s.url,
          sentAtMs: 0,
          error: "connect ECONNREFUSED 127.0.0.1:4100",
        })),
    };
    const run = await runScenario(makeScenario([], state), { strategy: unreachable, sql });
    expect(run.aborted).toMatch(/none of the 3 requests got a response .*ECONNREFUSED/);
    expect(run.aborted).toContain("http://127.0.0.1:1");
    expect(run.trials).toHaveLength(0);
  });

  it("aborts instead of reporting a race when the invariant fails before any request", async () => {
    const state = { trial: 0 };
    const fire = vi.fn();
    const run = await runScenario(
      makeScenario([], state, { invariant: async () => "already broken" }),
      { strategy: { name: "fake", fire }, sql },
    );
    expect(run.aborted).toContain("already broken");
    expect(run.trials).toHaveLength(0);
    expect(run.violations).toBe(0);
    expect(fire).not.toHaveBeenCalled();
  });

  it("sends a request id header and attaches each request's queries from the query log", async () => {
    const state = { trial: 0 };
    const seenHeaders: string[] = [];
    const strategy: Strategy = {
      name: "fake",
      async fire(_b, specs) {
        state.trial++;
        return specs.map((s, index) => {
          seenHeaders.push(s.headers?.["x-deadheat-rid"] ?? "");
          return { index, method: s.method, url: s.url, sentAtMs: 0, status: 201 };
        });
      },
    };
    const asked: string[][] = [];
    const queryLog = {
      take: async (ids: readonly string[]) => {
        asked.push([...ids]);
        return {
          [ids[0]!]: [
            {
              sql: "SELECT 1",
              rows: 1,
              commandTags: ["SELECT 1"],
              startedAt: 1,
              durationMs: 1,
              txStatus: "I" as const,
            },
          ],
        };
      },
    };
    const run = await runScenario(makeScenario([], state, { trials: 2 }), {
      strategy,
      sql,
      queryLog,
    });

    const id = (trial: number, i: number) => `${run.runId}.${trial}.${i}`;
    expect(seenHeaders).toEqual([id(1, 0), id(1, 1), id(1, 2), id(2, 0), id(2, 1), id(2, 2)]);
    expect(asked).toEqual([
      [id(1, 0), id(1, 1), id(1, 2)],
      [id(2, 0), id(2, 1), id(2, 2)],
    ]);
    const [first, second] = run.trials[0]!.requests;
    expect(first?.requestId).toBe(id(1, 0));
    expect(first?.queries?.map((q) => q.sql)).toEqual(["SELECT 1"]);
    expect(second?.queries).toEqual([]);
  });

  it("schedules each trial with a derived seed and records the release order", async () => {
    const state = { trial: 0 };
    const calls: string[] = [];
    const started: TrialSchedule[] = [];
    const queryLog = {
      take: async () => ({}),
      startSchedule: async (c: TrialSchedule) => {
        calls.push("start");
        started.push(c);
      },
      stopSchedule: async (): Promise<ScheduleStep[]> => {
        calls.push("stop");
        return [{ requestId: `${started.at(-1)!.prefix}1` }];
      },
    };
    const strategy = fakeStrategy(state);
    const fire = strategy.fire;
    strategy.fire = async (b, specs) => {
      calls.push("fire");
      return fire(b, specs);
    };
    const run = await runScenario(makeScenario([], state, { trials: 2 }), {
      strategy,
      sql,
      queryLog,
      schedule: { seed: 42, quietMs: 5 },
    });

    expect(calls).toEqual(["start", "fire", "stop", "start", "fire", "stop"]);
    expect(started.map((c) => c.prefix)).toEqual([`${run.runId}.1.`, `${run.runId}.2.`]);
    expect(started.map((c) => c.seed)).toEqual([deriveSeed(42, 1), deriveSeed(42, 2)]);
    expect(started[0]).toMatchObject({ requests: 3, quietMs: 5 });
    expect(run.seed).toBe(42);
    expect(run.config.schedule).toBe("random");
    expect(run.trials[1]).toMatchObject({
      seed: deriveSeed(42, 2),
      schedule: [{ requestId: `${run.runId}.2.1` }],
    });
  });

  it("refuses to schedule without a capable query log, or together with widening", async () => {
    const state = { trial: 0 };
    const options = { strategy: fakeStrategy(state), sql, schedule: { seed: 1 } };
    await expect(runScenario(makeScenario([], state), options)).rejects.toThrow(/deadheat proxy/);
    const queryLog = {
      take: async () => ({}),
      setHolds: async () => {},
      startSchedule: async () => {},
      stopSchedule: async () => [],
    };
    await expect(
      runScenario(makeScenario([], state), { ...options, queryLog, widen: { holdMs: 10 } }),
    ).rejects.toThrow(/not both/);
  });

  it("derives different, stable per-trial seeds", () => {
    expect(deriveSeed(7, 1)).toBe(deriveSeed(7, 1));
    expect(new Set([1, 2, 3, 4].map((t) => deriveSeed(7, t))).size).toBe(4);
    expect(deriveSeed(7, 1)).not.toBe(deriveSeed(8, 1));
    expect(Number.isInteger(deriveSeed(-5, 3)) && deriveSeed(-5, 3) >= 0).toBe(true);
  });
});
