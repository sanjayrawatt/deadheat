import type { Sql } from "postgres";

/** One HTTP request a scenario fires. `url` is resolved against the scenario's `baseUrl`. */
export interface RequestSpec {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** Sent as JSON when it isn't a string. */
  body?: unknown;
}

/** What setup and invariant functions get. `sql` points at the app's database. */
export interface ScenarioContext {
  sql: Sql;
}

export interface InvariantContext extends ScenarioContext {
  /** Responses from the trial just fired. Empty during the pre-flight check. */
  responses: readonly RequestTrace[];
}

/** `true` when the rule holds, or a message describing the violation. */
export type InvariantResult = true | string;

export interface Scenario {
  name: string;
  baseUrl: string;
  setup?: (ctx: ScenarioContext) => Promise<void>;
  actions: {
    concurrency: number;
    request: (index: number) => RequestSpec;
  };
  invariant: (ctx: InvariantContext) => Promise<InvariantResult>;
  /** Default number of trials. The CLI can override it. */
  trials?: number;
}

/** What happened to one request in a trial. Times are ms since the trial's fire started. */
export interface RequestTrace {
  index: number;
  method: string;
  url: string;
  sentAtMs: number;
  /** When response headers arrived. Undefined if the request failed before that. */
  headersAtMs?: number;
  status?: number;
  /** Response body, truncated. */
  body?: string;
  error?: string;
}

export interface TrialResult {
  trial: number;
  passed: boolean;
  violation?: string;
  durationMs: number;
  requests: RequestTrace[];
}

export interface RunResult {
  runId: string;
  scenario: string;
  strategy: string;
  startedAt: string;
  durationMs: number;
  trials: TrialResult[];
  violations: number;
  /** Set when the run stopped early, e.g. when setup leaves the invariant already broken. */
  aborted?: string;
}

/** How a trial's requests are released. `naive` now; `sync` in Week 3; proxy-driven ones later. */
export interface Strategy {
  name: string;
  fire(baseUrl: string, specs: readonly RequestSpec[]): Promise<RequestTrace[]>;
}

/** Identity helper: gives scenario files type checking and editor autocomplete. */
export function scenario(definition: Scenario): Scenario {
  return definition;
}
