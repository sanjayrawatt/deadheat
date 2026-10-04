import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import {
  REQUEST_ID_HEADER,
  type QueryLog,
  type RequestSpec,
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

  const result: RunResult = {
    runId: newRunId(),
    scenario: scenario.name,
    strategy: strategy.name,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    trials: [],
    violations: 0,
  };
  const runStart = performance.now();

  for (let trial = 1; trial <= total; trial++) {
    const trialStart = performance.now();
    await scenario.setup?.({ sql });

    const before = await scenario.invariant({ sql, responses: [] });
    if (before !== true) {
      result.aborted = `Trial ${trial}: the invariant already fails after setup, before any request was sent ("${before}"). Fix the scenario's setup or invariant.`;
      break;
    }

    const baseUrl = options.baseUrl ?? scenario.baseUrl;
    const ids = specs.map((_, i) => `${result.runId}.${trial}.${i}`);
    const tagged = specs.map((spec, i) => ({
      ...spec,
      headers: { ...spec.headers, [REQUEST_ID_HEADER]: ids[i]! },
    }));
    const requests = await strategy.fire(baseUrl, tagged);
    requests.forEach((r) => (r.requestId = ids[r.index]!));

    // If nothing reached the app, the invariant trivially holds, and a green result would
    // be a lie (e.g. a wrong port in CI). Stop instead.
    if (requests.length && requests.every((r) => r.error !== undefined)) {
      result.aborted = `Trial ${trial}: none of the ${requests.length} requests got a response (first error: ${requests[0]!.error}). Is the app running at ${baseUrl}?`;
      break;
    }
    if (options.queryLog) {
      const byId = await options.queryLog.take(ids);
      for (const r of requests) r.queries = byId[r.requestId!] ?? [];
    }
    const verdict = await scenario.invariant({ sql, responses: requests });

    const trialResult: TrialResult = {
      trial,
      passed: verdict === true,
      ...(verdict === true ? {} : { violation: verdict }),
      durationMs: performance.now() - trialStart,
      requests,
    };
    if (!trialResult.passed) result.violations++;
    result.trials.push(trialResult);
    options.onTrial?.(trialResult);
  }

  result.durationMs = performance.now() - runStart;
  return result;
}
