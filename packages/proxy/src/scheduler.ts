import type { ScheduleStep, TrialSchedule as ScheduleConfig } from "@deadheat/core";

export type { ScheduleConfig, ScheduleStep };

export const DEFAULT_QUIET_MS = 15;
export const DEFAULT_START_TIMEOUT_MS = 250;
export const DEFAULT_STEP_TIMEOUT_MS = 100;
// With a lock probe, the timeout only guards against "slow", so it can be long.
export const DEFAULT_SLOW_TIMEOUT_MS = 2000;
const PROBE_AFTER_MS = 5;
const PROBE_EVERY_MS = 10;
export const DEFAULT_FORCE_TIMEOUT_MS = 2000;
export const DEFAULT_PCT_DEPTH = 3;

interface Running {
  step: ScheduleStep;
  at: number;
}

export interface SchedulerHooks {
  /**
   * Asks the database which of these running requests wait on a lock, and on whose. Returns
   * only the blocked ones: request id → ids of the requests holding the lock.
   */
  probe?(requestIds: string[]): Promise<Map<string, string[]>>;
}

/**
 * Decides when each held query batch of a trial is released.
 *
 * The proxy offers each held batch with a `release` callback and reports when the released
 * batch's ReadyForQuery arrives. Policies:
 * - `random`: one batch at a time, a seeded PRNG picks among the waiting requests.
 * - `pct`: one at a time, the waiting request with the highest priority goes; priorities are
 *   seeded, and `depth - 1` change points demote the request that just ran (PCT, ASPLOS 2010).
 * - `barrier`: all waiting batches are released together, phase by phase.
 * - `forced`: the recorded `order` of request indexes (replay); an array entry is a barrier
 *   phase, released together once all its requests wait.
 * Choices only depend on the seed and the set of waiting requests (sorted by index), so the
 * same seed reproduces the same schedule.
 *
 * A released step that doesn't finish may be waiting on a row lock held by a request this
 * scheduler is holding back. With a `probe`, such steps are found within ~10ms and marked
 * with who blocks them; without one, a step timeout is the only signal.
 */
export class Scheduler {
  readonly order: ScheduleStep[] = [];
  private readonly waiting = new Map<string, (() => void)[]>();
  private readonly running = new Map<string, Running>();
  private readonly seen = new Set<string>();
  private readonly startedAt = performance.now();
  private readonly stalled = new Set<string>();
  private readonly random: () => number;
  private readonly quietMs: number;
  private readonly stepTimeoutMs: number;
  private readonly policy: NonNullable<ScheduleConfig["policy"]>;
  // What decides now: the policy, or for `forced` the fallback once the recording runs out.
  private mode: NonNullable<ScheduleConfig["policy"]>;
  private readonly priority = new Map<number, number>();
  private readonly changePoints = new Map<number, number>();
  private forcedAt = 0;
  private phase = 0;
  private lastActivity = performance.now();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private probing = false;
  private lastProbe = -Infinity;

  constructor(
    readonly config: ScheduleConfig,
    private readonly hooks: SchedulerHooks = {},
  ) {
    this.random = mulberry32(config.seed);
    this.quietMs = config.quietMs ?? DEFAULT_QUIET_MS;
    this.stepTimeoutMs =
      config.stepTimeoutMs ?? (hooks.probe ? DEFAULT_SLOW_TIMEOUT_MS : DEFAULT_STEP_TIMEOUT_MS);
    this.policy = config.policy ?? "random";
    this.mode = this.policy;
    const pct = this.policy === "pct" || (this.policy === "forced" && config.fallback === "pct");
    if (pct) this.initPct(config.depth ?? DEFAULT_PCT_DEPTH);
  }

  matches(requestId: string | undefined): requestId is string {
    return !this.stopped && !!requestId && requestId.startsWith(this.config.prefix);
  }

  offer(requestId: string, release: () => void): void {
    if (this.stopped) return release();
    const queue = this.waiting.get(requestId) ?? [];
    queue.push(release);
    this.waiting.set(requestId, queue);
    this.seen.add(requestId);
    this.lastActivity = performance.now();
    this.decide();
  }

  /** The released batch of this request got its ReadyForQuery. */
  finished(requestId: string): void {
    if (!this.running.delete(requestId)) this.stalled.delete(requestId);
    this.lastActivity = performance.now();
    this.decide();
  }

  /** Releases everything still held and stops scheduling. */
  stop(): ScheduleStep[] {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const queue of this.waiting.values()) for (const release of queue) release();
    this.waiting.clear();
    return this.order;
  }

  private decide(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || !this.waiting.size) return;

    const now = performance.now();
    let nextTimeout = Infinity;
    for (const [id, r] of this.running) {
      if (now - r.at >= this.stepTimeoutMs) {
        r.step.stalled = true;
        this.stalled.add(id);
        this.running.delete(id);
      } else {
        nextTimeout = Math.min(nextTimeout, r.at + this.stepTimeoutMs - now);
      }
    }
    if (this.running.size) {
      if (this.hooks.probe && !this.probing) {
        const due = [...this.running].filter(([, r]) => now - r.at >= PROBE_AFTER_MS);
        const slot = this.lastProbe + PROBE_EVERY_MS;
        if (due.length && now >= slot) {
          this.runProbe(
            due.map(([id]) => id),
            now,
          );
        } else {
          const firstDue = Math.min(
            ...[...this.running.values()].map((r) => r.at + PROBE_AFTER_MS),
          );
          nextTimeout = Math.min(nextTimeout, Math.max(firstDue, slot) - now);
        }
      }
      return this.wake(nextTimeout);
    }

    if (this.mode === "forced" && this.forcedAt >= (this.config.order?.length ?? 0)) {
      this.mode = this.config.fallback ?? "random";
    }
    if (this.mode === "forced") {
      const entry = this.config.order![this.forcedAt]!;
      const phased = Array.isArray(entry);
      const ids = (phased ? entry : [entry]).map((want) =>
        [...this.waiting.keys()].find((k) => indexOf(k) === want),
      );
      if (ids.every((id) => id !== undefined)) {
        this.forcedAt++;
        if (phased) this.phase++;
        for (const id of ids) this.release(id, now, false, phased);
        return this.decide();
      }
      const giveUp = this.lastActivity + (this.config.forceTimeoutMs ?? DEFAULT_FORCE_TIMEOUT_MS);
      if (now < giveUp) return this.wake(giveUp - now);
      this.mode = this.config.fallback ?? "random";
    }

    // A request that hasn't sent anything yet is probably still on its way (slow first
    // connection), so the first decisions wait for all of them, up to startTimeoutMs. Later,
    // silence means a request is done or busy elsewhere, so quietMs is enough.
    const everyoneWaits = this.waiting.size + this.stalled.size >= this.config.requests;
    if (!everyoneWaits) {
      const startDeadline =
        this.startedAt + (this.config.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
      if (this.seen.size < this.config.requests && now < startDeadline) {
        return this.wake(startDeadline - now);
      }
      const quietFor = now - this.lastActivity;
      if (quietFor < this.quietMs) return this.wake(this.quietMs - quietFor);
    }

    const ids = [...this.waiting.keys()].sort(byIndex);
    if (this.mode === "barrier") {
      this.phase++;
      for (const id of shuffle(ids, this.random)) this.release(id, now);
    } else if (this.mode === "pct") {
      const id = ids.reduce((a, b) => (this.prio(b) > this.prio(a) ? b : a));
      this.release(id, now);
      const demoteTo = this.changePoints.get(this.order.length);
      if (demoteTo !== undefined) this.priority.set(indexOf(id), demoteTo);
    } else {
      this.release(ids[Math.floor(this.random() * ids.length)]!, now);
    }
    this.decide();
  }

  private release(
    requestId: string,
    now: number,
    unforced = this.policy === "forced",
    phased = this.mode === "barrier",
  ): void {
    const queue = this.waiting.get(requestId)!;
    const release = queue.shift()!;
    if (!queue.length) this.waiting.delete(requestId);
    const step: ScheduleStep = { requestId };
    if (phased) step.phase = this.phase;
    if (unforced) step.unforced = true;
    this.order.push(step);
    this.running.set(requestId, { step, at: now });
    this.lastActivity = now;
    release();
  }

  private runProbe(requestIds: string[], now: number): void {
    this.probing = true;
    this.lastProbe = now;
    this.hooks.probe!(requestIds).then(
      (blocked) => {
        this.probing = false;
        if (this.stopped) return;
        for (const [id, by] of blocked) {
          const r = this.running.get(id);
          if (!r) continue;
          r.step.stalled = true;
          r.step.blockedBy = by;
          this.stalled.add(id);
          this.running.delete(id);
        }
        this.decide();
      },
      () => {
        this.probing = false;
        if (!this.stopped) this.decide();
      },
    );
  }

  private wake(ms: number): void {
    this.timer = setTimeout(() => this.decide(), Math.max(0, ms));
  }

  // Initial priorities depth..depth+n-1 in a seeded random order; change point j (of depth-1,
  // drawn among the first requests*4 steps) demotes the request that just ran to depth-j.
  private initPct(depth: number): void {
    const n = this.config.requests;
    shuffle(
      Array.from({ length: n }, (_, i) => i),
      this.random,
    ).forEach((index, rank) => this.priority.set(index, depth + rank));
    const horizon = Math.max(n * 4, depth);
    const steps = shuffle(
      Array.from({ length: horizon }, (_, i) => i + 1),
      this.random,
    ).slice(0, depth - 1);
    steps.forEach((step, j) => this.changePoints.set(step, depth - 1 - j));
  }

  private prio(requestId: string): number {
    return this.priority.get(indexOf(requestId)) ?? -1;
  }
}

function indexOf(requestId: string): number {
  return Number(requestId.slice(requestId.lastIndexOf(".") + 1));
}

function byIndex(a: string, b: string): number {
  return indexOf(a) - indexOf(b) || (a < b ? -1 : a > b ? 1 : 0);
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
