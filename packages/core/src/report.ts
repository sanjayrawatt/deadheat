import type { RequestTrace, RunResult, TrialResult } from "./types.js";

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

function formatTrial(trial: TrialResult, maxRequests: number): string[] {
  // Successful requests first: they're the ones that slipped past the check.
  const ordered = [...trial.requests].sort(
    (a, b) => rank(a) - rank(b) || (a.headersAtMs ?? Infinity) - (b.headersAtMs ?? Infinity),
  );
  const lines = [`  Trial ${trial.trial}: ${trial.violation}`];
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
  return lines;
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
