import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { runScenario } from "./runner.js";
import type { RequestTrace, Scenario, Strategy } from "./types.js";

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
});
