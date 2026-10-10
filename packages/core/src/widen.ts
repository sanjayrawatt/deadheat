import type { QueryRecord, TrialResult } from "./types.js";

/**
 * A stable identity for "the same query", whatever its literal values:
 * whitespace collapsed, numbers and quoted strings replaced by `?`. `$1`-style placeholders
 * are already stable, and the agent's tag is stripped by the proxy before we see the SQL.
 */
export function fingerprint(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/(?<![\w$])-?\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}

const WRITE = /^\s*(insert|update|delete|merge)\b/i;
const READ = /^\s*(select|with)\b/i;

/** A query that changes data. `WITH … INSERT` counts as a write when it contains one. */
export function isWrite(sql: string): boolean {
  return WRITE.test(sql) || (/^\s*with\b/i.test(sql) && /\b(insert|update|delete)\b/i.test(sql));
}

export function isRead(sql: string): boolean {
  return READ.test(sql) && !isWrite(sql);
}

/**
 * Decision reads: reads that a request later acts on with a write. These are the reads whose
 * results check-then-act code trusts, so holding them back widens the race window.
 */
export function decisionReads(queries: readonly QueryRecord[]): string[] {
  const found = new Set<string>();
  queries.forEach((q, i) => {
    if (q.error || !isRead(q.sql)) return;
    if (queries.slice(i + 1).some((later) => !later.error && isWrite(later.sql))) {
      found.add(fingerprint(q.sql));
    }
  });
  return [...found];
}

/** Decision-read fingerprints across every request of a trial. */
export function learnDecisionReads(trial: TrialResult): string[] {
  const found = new Set<string>();
  for (const r of trial.requests) for (const f of decisionReads(r.queries ?? [])) found.add(f);
  return [...found];
}

/**
 * Check-then-act evidence in one trial: at least two requests that succeeded ran the same
 * decision read, and every one of those reads started before the first of their writes.
 * So each request decided on a value another request was about to change.
 */
export function staleReadPattern(trial: TrialResult): string | undefined {
  const ok = trial.requests.filter(
    (r) => r.status !== undefined && r.status >= 200 && r.status < 300 && r.queries?.length,
  );
  const byRead = new Map<string, { readAt: number; firstWriteAt: number }[]>();
  for (const r of ok) {
    const qs = r.queries!;
    const firstWrite = qs.find((q) => isWrite(q.sql));
    if (!firstWrite) continue;
    for (const f of decisionReads(qs)) {
      const read = qs.find((q) => fingerprint(q.sql) === f)!;
      const list = byRead.get(f) ?? [];
      list.push({ readAt: read.startedAt, firstWriteAt: firstWrite.startedAt });
      byRead.set(f, list);
    }
  }
  for (const [f, list] of byRead) {
    if (list.length < 2) continue;
    const lastRead = Math.max(...list.map((x) => x.readAt));
    const firstWrite = Math.min(...list.map((x) => x.firstWriteAt));
    if (lastRead < firstWrite) return f;
  }
  return undefined;
}
