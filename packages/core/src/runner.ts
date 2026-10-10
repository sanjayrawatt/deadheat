import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { learnDecisionReads } from "./widen.js";
import {
  REQUEST_ID_HEADER,
  RUN_FORMAT_VERSION,
  type QueryLog,
  type RequestSpec,
  type ScheduleStep,
  type RunResult,
  type Scenario,
  type Strategy,
  type TrialResult,
} from "./types.js";

export interface RunOptions {
  strategy: Strategy;
  sql: Sql;
  /** Overrides `scenario.trials`. */
  trials?: number;
  /** Overrides `scenario.baseUrl`, e.g. when the app under test runs on another port. */
  baseUrl?: string;
  /** Attaches the app's SQL to each request trace (needs the agent in the app). */
  queryLog?: QueryLog;
  /**
   * Race-window widening (needs a queryLog that supports holds, i.e. `deadheat proxy`).
   * Trial 1 runs as-is and teaches the runner which reads each request acts on; from then on
   * the proxy holds those reads' results for `holdMs`.
   */
  widen?: { holdMs: number };
  /**
   * Controlled interleaving (needs `deadheat proxy`): the proxy holds each request's queries
   * and releases one step at a time, choosing with a PRNG seeded from `seed` and the trial.
   */
  schedule?: { seed: number; quietMs?: number; stepTimeoutMs?: number };
  /** Called after every trial, e.g. to print progress. */
  onTrial?: (result: TrialResult) => void;
}

export const DEFAULT_TRIALS = 100;

export function newRunId(): string {
  return `run-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(2).toString("hex")}`;
}

/**
 * Runs the scenario's trials one after another: setup → pre-flight invariant check → fire
 * all requests concurrently → invariant check.
 *
 * The pre-flight check guards against false positives. If the invariant already fails before
 * any request is sent, the setup (or the invariant) is broken, not the app, so the run stops
 * instead of reporting a race.
 */
export async function runScenario(scenario: Scenario, options: RunOptions): Promise<RunResult> {
  const { strategy, sql } = options;
  const total = options.trials ?? scenario.trials ?? DEFAULT_TRIALS;
  const specs: RequestSpec[] = Array.from({ length: scenario.actions.concurrency }, (_, i) =>
    scenario.actions.request(i),
  );

  const baseUrl = options.baseUrl ?? scenario.baseUrl;
  const result: RunResult = {
    formatVersion: RUN_FORMAT_VERSION,
    runId: newRunId(),
    scenario: scenario.name,
    strategy: strategy.name,
    config: {
      baseUrl,
      concurrency: scenario.actions.concurrency,
      trials: total,
      ...(options.widen ? { widenMs: options.widen.holdMs } : {}),
      ...(options.schedule ? { schedule: "random" as const } : {}),
    },
    startedAt: new Date().toISOString(),
    durationMs: 0,
    trials: [],
    violations: 0,
    ...(options.schedule ? { seed: options.schedule.seed } : {}),
  };
  const runStart = performance.now();

  const { queryLog, widen, schedule } = options;
  if (widen && !queryLog?.setHolds) {
    throw new Error("widening needs a query log that can hold reads (deadheat proxy)");
  }
  if (schedule && (!queryLog?.startSchedule || !queryLog.stopSchedule)) {
    throw new Error("scheduling needs a query log that can schedule queries (deadheat proxy)");
  }
  if (schedule && widen) throw new Error("use either widening or scheduling, not both");
  let scheduling = false;
  const learned = new Set<string>();

  try {
    for (let trial = 1; trial <= total; trial++) {
      const trialStart = performance.now();
      await scenario.setup?.({ sql });

      const before = await scenario.invariant({ sql, responses: [] });
      if (before !== true) {
        result.aborted = `Trial ${trial}: the invariant already fails after setup, before any request was sent ("${before}"). Fix the scenario's setup or invariant.`;
        break;
      }

      const ids = specs.map((_, i) => `${result.runId}.${trial}.${i}`);
      const tagged = specs.map((spec, i) => ({
        ...spec,
        headers: { ...spec.headers, [REQUEST_ID_HEADER]: ids[i]! },
      }));
      let trialSeed: number | undefined;
      if (schedule) {
        trialSeed = deriveSeed(schedule.seed, trial);
        await queryLog!.startSchedule!({
          prefix: `${result.runId}.${trial}.`,
          requests: specs.length,
          seed: trialSeed,
          ...(schedule.quietMs !== undefined ? { quietMs: schedule.quietMs } : {}),
          ...(schedule.stepTimeoutMs !== undefined
            ? { stepTimeoutMs: schedule.stepTimeoutMs }
            : {}),
        });
        scheduling = true;
      }
      const requests = await strategy.fire(baseUrl, tagged);
      requests.forEach((r) => (r.requestId = ids[r.index]!));
      let order: ScheduleStep[] | undefined;
      if (schedule) {
        order = await queryLog!.stopSchedule!();
        scheduling = false;
      }

      // If nothing reached the app, the invariant trivially holds, and a green result would
      // be a lie (e.g. a wrong port in CI). Stop instead.
      if (requests.length && requests.every((r) => r.error !== undefined)) {
        result.aborted = `Trial ${trial}: none of the ${requests.length} requests got a response (first error: ${requests[0]!.error}). Is the app running at ${baseUrl}?`;
        break;
      }
      if (queryLog) {
        const byId = await queryLog.take(ids);
        for (const r of requests) r.queries = byId[r.requestId!] ?? [];
      }
      const verdict = await scenario.invariant({ sql, responses: requests });

      const trialResult: TrialResult = {
        trial,
        passed: verdict === true,
        ...(verdict === true ? {} : { violation: verdict }),
        durationMs: performance.now() - trialStart,
        requests,
        ...(order ? { schedule: order, seed: trialSeed! } : {}),
      };
      if (!trialResult.passed) result.violations++;
      result.trials.push(trialResult);
      options.onTrial?.(trialResult);

      if (widen) {
        const before = learned.size;
        for (const f of learnDecisionReads(trialResult)) learned.add(f);
        if (learned.size > before) {
          result.widen = { holdMs: widen.holdMs, fingerprints: [...learned] };
          await queryLog!.setHolds!(result.widen);
        }
      }
    }
  } finally {
    if (widen) await queryLog!.setHolds!(null);
    if (scheduling) await queryLog!.stopSchedule!();
  }

  result.durationMs = performance.now() - runStart;
  return result;
}

/** A per-trial seed: the same run seed and trial always give the same value. */
export function deriveSeed(seed: number, trial: number): number {
  let h = Math.imul((seed ^ 0x9e3779b9) >>> 0, 0x85ebca6b) ^ Math.imul(trial, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  return (h ^ (h >>> 15)) >>> 0;
}
