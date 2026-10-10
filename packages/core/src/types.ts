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

/** One SQL query the app ran while serving a request (seen by the proxy). */
export interface QueryRecord {
  sql: string;
  params?: (string | null)[];
  rows: number;
  /** Values of the first result row, as text. */
  firstRow?: (string | null)[];
  commandTags: string[];
  error?: { code: string; message: string };
  /** Proxy clock (performance.now() in the proxy process). Only comparable to other queries. */
  startedAt: number;
  durationMs: number;
  /** Transaction status after the query: idle, in transaction, failed. */
  txStatus: "I" | "T" | "E";
  /** How long the proxy held this query's result back (race-window widening). */
  heldMs?: number;
  /** The proxy's id for the app's database connection. Replay keeps per-connection order. */
  connectionId?: number;
  protocol?: "simple" | "extended";
}

/** Where the runner gets each request's queries from (e.g. a running `deadheat proxy`). */
export interface QueryLog {
  /** Returns, and forgets, the queries recorded for these request ids. */
  take(requestIds: readonly string[]): Promise<Record<string, QueryRecord[]>>;
  /** Asks the proxy to hold the results of these reads (`null` clears all holds). */
  setHolds?(holds: HoldRules | null): Promise<void>;
}

/** Reads whose results the proxy delays, to widen race windows. */
export interface HoldRules {
  holdMs: number;
  /** Fingerprints (see `fingerprint()`) of the decision reads to hold. */
  fingerprints: string[];
}

/** Header carrying the request id; the agent puts it into the app's SQL. */
export const REQUEST_ID_HEADER = "x-deadheat-rid";

/** What happened to one request in a trial. Times are ms since the trial's fire started. */
export interface RequestTrace {
  index: number;
  /** `<runId>.<trial>.<index>`, sent as the x-deadheat-rid header. */
  requestId?: string;
  method: string;
  url: string;
  sentAtMs: number;
  /** When response headers arrived. Undefined if the request failed before that. */
  headersAtMs?: number;
  status?: number;
  /** Response body, truncated. */
  body?: string;
  error?: string;
  /** The app's SQL for this request, in order. Present when a query log is attached. */
  queries?: QueryRecord[];
}

export interface TrialResult {
  trial: number;
  passed: boolean;
  violation?: string;
  durationMs: number;
  requests: RequestTrace[];
}

/** Bumped whenever the saved run format changes incompatibly. */
export const RUN_FORMAT_VERSION = 1;

/** What a run was started with, so a saved run can be understood (and later replayed). */
export interface RunConfig {
  /** Scenario file, relative to where `deadheat run` was started. Set by the CLI. */
  scenarioFile?: string;
  baseUrl: string;
  concurrency: number;
  trials: number;
  widenMs?: number;
}

export interface RunResult {
  formatVersion: typeof RUN_FORMAT_VERSION;
  runId: string;
  scenario: string;
  strategy: string;
  config: RunConfig;
  startedAt: string;
  durationMs: number;
  trials: TrialResult[];
  violations: number;
  /** Set when the run stopped early, e.g. when setup leaves the invariant already broken. */
  aborted?: string;
  /** Race-window widening that was active, if any (learned from the run's own trials). */
  widen?: HoldRules;
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
