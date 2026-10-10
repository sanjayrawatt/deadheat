import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { runScenario } from "./runner.js";
import type { HoldRules, QueryRecord, RequestTrace, Scenario, TrialResult } from "./types.js";
import {
  decisionReads,
  fingerprint,
  isRead,
  isWrite,
  learnDecisionReads,
  staleReadPattern,
} from "./widen.js";

const q = (sql: string, startedAt = 0): QueryRecord => ({
  sql,
  rows: 1,
  commandTags: [],
  startedAt,
  durationMs: 1,
  txStatus: "I",
});

const COUNT = "SELECT COUNT(*) FROM bookings WHERE slot_id = $1";
const CAP = "SELECT capacity FROM slots WHERE id = $1";
const INSERT = "INSERT INTO bookings (slot_id, user_id) VALUES ($1, $2)";

describe("fingerprint", () => {
  it("ignores literal values and whitespace, keeps placeholders", () => {
    expect(fingerprint("SELECT *  FROM t\n WHERE id = 42 AND name = 'O''Brien'")).toBe(
      "SELECT * FROM t WHERE id = ? AND name = ?",
    );
    expect(fingerprint("SELECT * FROM t WHERE id = $1")).toBe("SELECT * FROM t WHERE id = $1");
    expect(fingerprint("SELECT col2 FROM t1")).toBe("SELECT col2 FROM t1");
  });
});

describe("read/write classification", () => {
  it.each([
    [COUNT, true, false],
    [INSERT, false, true],
    ["  update accounts set balance = 1", false, true],
    ["WITH x AS (SELECT 1) SELECT * FROM x", true, false],
    ["WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x", false, true],
    ["BEGIN", false, false],
  ])("%s → read %s, write %s", (sql, read, write) => {
    expect(isRead(sql)).toBe(read);
    expect(isWrite(sql)).toBe(write);
  });
});

describe("decisionReads", () => {
  it("returns the reads that a later write in the same request depends on", () => {
    expect(decisionReads([q("BEGIN"), q(CAP), q(COUNT), q(INSERT), q("SELECT 1")])).toEqual([
      CAP,
      COUNT,
    ]);
  });

  it("returns nothing for a request that only reads (e.g. it got a 409)", () => {
    expect(decisionReads([q(CAP), q(COUNT)])).toEqual([]);
  });

  it("learns across all requests of a trial, without duplicates", () => {
    const trial = {
      requests: [
        { queries: [q(CAP), q(COUNT), q(INSERT)] },
        { queries: [q(CAP), q(COUNT)] },
        { queries: [q(CAP), q(COUNT), q(INSERT)] },
      ],
    } as unknown as TrialResult;
    expect(learnDecisionReads(trial)).toEqual([CAP, COUNT]);
  });
});

describe("staleReadPattern", () => {
  const req = (status: number, queries: QueryRecord[]) =>
    ({ index: 0, method: "POST", url: "/b", sentAtMs: 0, status, queries }) as RequestTrace;

  it("flags two successful requests that both read before either wrote", () => {
    const trial = {
      requests: [req(201, [q(COUNT, 1), q(INSERT, 3)]), req(201, [q(COUNT, 2), q(INSERT, 4)])],
    } as TrialResult;
    expect(staleReadPattern(trial)).toBe(COUNT);
  });

  it("stays quiet when the second read came after the first write (serialised)", () => {
    const trial = {
      requests: [req(201, [q(COUNT, 1), q(INSERT, 2)]), req(201, [q(COUNT, 3), q(INSERT, 4)])],
    } as TrialResult;
    expect(staleReadPattern(trial)).toBeUndefined();
  });
});

describe("runScenario with widen", () => {
  const sql = {} as Sql;

  function setup() {
    const holds: (HoldRules | null)[] = [];
    let trial = 0;
    const scenario: Scenario = {
      name: "w",
      baseUrl: "http://127.0.0.1:1",
      actions: { concurrency: 2, request: () => ({ method: "POST", url: "/b" }) },
      invariant: async () => true,
      trials: 3,
    };
    const strategy = {
      name: "fake",
      fire: async (_b: string, specs: readonly unknown[]) => {
        trial++;
        return specs.map((_, index) => ({
          index,
          method: "POST",
          url: "/b",
          sentAtMs: 0,
          status: 201,
        }));
      },
    };
    const queryLog = {
      take: async (ids: readonly string[]) =>
        Object.fromEntries(ids.map((id) => [id, [q(COUNT, trial), q(INSERT, trial + 1)]])),
      setHolds: async (h: HoldRules | null) => void holds.push(h),
    };
    return { holds, scenario, strategy, queryLog };
  }

  it("learns after trial 1, holds from then on, and always clears at the end", async () => {
    const { holds, scenario, strategy, queryLog } = setup();
    const run = await runScenario(scenario, { strategy, sql, queryLog, widen: { holdMs: 150 } });
    expect(holds).toEqual([{ holdMs: 150, fingerprints: [COUNT] }, null]);
    expect(run.widen).toEqual({ holdMs: 150, fingerprints: [COUNT] });
  });

  it("clears holds even when a trial throws", async () => {
    const { holds, scenario, strategy, queryLog } = setup();
    let calls = 0;
    const failing = {
      ...strategy,
      fire: async (b: string, s: readonly unknown[]) => {
        if (++calls === 2) throw new Error("boom");
        return strategy.fire(b, s);
      },
    };
    await expect(
      runScenario(scenario, { strategy: failing, sql, queryLog, widen: { holdMs: 1 } }),
    ).rejects.toThrow("boom");
    expect(holds.at(-1)).toBeNull();
  });

  it("refuses to widen without a proxy that can hold reads", async () => {
    const { scenario, strategy } = setup();
    await expect(runScenario(scenario, { strategy, sql, widen: { holdMs: 1 } })).rejects.toThrow(
      /widening needs/,
    );
  });
});
