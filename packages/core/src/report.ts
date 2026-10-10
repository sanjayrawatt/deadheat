import type { QueryRecord, RequestTrace, RunResult, TrialResult } from "./types.js";
import { staleReadPattern } from "./widen.js";

export interface ReportOptions {
  /** How many violating trials to show in detail. */
  maxViolations?: number;
  /** How many requests to list per violating trial. */
  maxRequests?: number;
}

/** Plain-text run report, in the format from DESIGN.md §6. */
export function formatRun(run: RunResult, options: ReportOptions = {}): string {
  const { maxViolations = 3, maxRequests = 5 } = options;
  const total = run.trials.length;
  const lines: string[] = [];

  if (run.aborted) {
    lines.push(`! ${run.scenario}: run aborted`, `  ${run.aborted}`);
    return lines.join("\n");
  }

  const rate = total ? ((run.violations / total) * 100).toFixed(1) : "0.0";
  const mark = run.violations ? "✗" : "✓";
  lines.push(
    `${mark} ${run.scenario}: ${run.violations}/${total} trials violated (${rate}%), strategy=${run.strategy}, ${run.runId}`,
  );

  if (run.widen) {
    lines.push(
      `  Widened: held the results of ${run.widen.fingerprints.length} decision read(s) for ${run.widen.holdMs}ms`,
      ...run.widen.fingerprints.map((f) => `    ${oneLine(f)}`),
    );
  }

  const failed = run.trials.filter((t) => !t.passed);
  for (const trial of failed.slice(0, maxViolations)) {
    lines.push("", ...formatTrial(trial, maxRequests));
  }
  if (failed.length > maxViolations) {
    lines.push("", `  … ${failed.length - maxViolations} more violating trials`);
  }

  const spreads = run.trials.map((t) => sendSpread(t.requests)).sort((a, b) => a - b);
  if (spreads.length) {
    lines.push(
      "",
      `  Send spread (last − first request sent, client side): p50 ${ms(percentile(spreads, 50))}, p99 ${ms(percentile(spreads, 99))}`,
    );
  }
  lines.push(`  Duration: ${(run.durationMs / 1000).toFixed(1)}s`);
  return lines.join("\n");
}

/** One trial in full: every request and the whole SQL interleaving, passed or not. */
export function formatTrialDetail(trial: TrialResult): string {
  return formatTrial(trial, Infinity).join("\n");
}

function formatTrial(trial: TrialResult, maxRequests: number): string[] {
  // Successful requests first: they're the ones that slipped past the check.
  const ordered = [...trial.requests].sort(
    (a, b) => rank(a) - rank(b) || (a.headersAtMs ?? Infinity) - (b.headersAtMs ?? Infinity),
  );
  const lines = [`  Trial ${trial.trial}: ${trial.violation ?? "passed"}`];
  for (const r of ordered.slice(0, maxRequests)) {
    const outcome = r.error ? `ERR ${r.error}` : String(r.status);
    const headers = r.headersAtMs === undefined ? "" : `  response +${ms(r.headersAtMs)}`;
    lines.push(
      `    Request #${String(r.index).padEnd(3)} ${r.method} ${r.url}  ${outcome}  sent +${ms(r.sentAtMs)}${headers}`,
    );
  }
  if (ordered.length > maxRequests) {
    lines.push(`    … ${ordered.length - maxRequests} more requests`);
  }
  lines.push(...formatInterleaving(ordered.slice(0, maxRequests)));
  const stale = staleReadPattern(trial);
  if (stale) {
    lines.push(
      "    Pattern: check-then-act. Several requests read this before any of them wrote:",
      `      ${oneLine(stale)}`,
      "    Likely fixes: SELECT … FOR UPDATE on the row being checked, a conditional write that",
      "                  re-checks in the same statement (+ affected-rows check), a constraint,",
      "                  or SERIALIZABLE with retry.",
    );
  }
  return lines;
}

/**
 * The SQL of the listed requests, merged by start time. This is the interleaving that broke
 * the invariant, e.g. two COUNTs that both see 0 before either INSERT.
 */
function formatInterleaving(requests: readonly RequestTrace[]): string[] {
  const steps = requests
    .flatMap((r) => (r.queries ?? []).map((q) => ({ r, q })))
    .sort((a, b) => a.q.startedAt - b.q.startedAt);
  if (!steps.length) return [];
  const lines = ["    SQL, in the order it ran:"];
  for (const { r, q } of steps) {
    const held = q.heldMs ? `  (held ${q.heldMs}ms)` : "";
    lines.push(
      `      #${String(r.index).padEnd(3)} ${oneLine(q.sql)}${paramList(q)} → ${queryOutcome(q)}${held}`,
    );
  }
  return lines;
}

function oneLine(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
}

function paramList(q: QueryRecord): string {
  if (!q.params?.length) return "";
  return `  [${q.params.map((p) => (p === null ? "null" : p)).join(", ")}]`;
}

function queryOutcome(q: QueryRecord): string {
  if (q.error) return `ERROR ${q.error.code} ${q.error.message}`;
  if (q.firstRow) {
    const values = q.firstRow.map((v) => (v === null ? "null" : v));
    return values.length === 1 ? values[0]! : `(${values.join(", ")})`;
  }
  return q.commandTags.join(", ") || "ok";
}

function rank(r: RequestTrace): number {
  if (r.status !== undefined && r.status >= 200 && r.status < 300) return 0;
  return r.error ? 2 : 1;
}

export function sendSpread(requests: readonly RequestTrace[]): number {
  if (!requests.length) return 0;
  const sent = requests.map((r) => r.sentAtMs);
  return Math.max(...sent) - Math.min(...sent);
}

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function ms(value: number): string {
  return `${value.toFixed(2)}ms`;
}
