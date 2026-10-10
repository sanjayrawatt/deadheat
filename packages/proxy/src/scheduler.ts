import type { ScheduleStep, TrialSchedule as ScheduleConfig } from "@deadheat/core";

export type { ScheduleConfig, ScheduleStep };

export const DEFAULT_QUIET_MS = 15;
export const DEFAULT_STEP_TIMEOUT_MS = 100;

/**
 * Decides which waiting request goes next, one step (query batch) at a time.
 *
 * The proxy offers each held batch with a `release` callback and reports when the released
 * batch's ReadyForQuery arrives. The choice among waiting requests uses a seeded PRNG over
 * the request ids sorted by their index, so the same seed and the same set of waiting
 * requests give the same choice.
 */
export class Scheduler {
  readonly order: ScheduleStep[] = [];
  private readonly waiting = new Map<string, (() => void)[]>();
  private readonly stalled = new Set<string>();
  private inFlight: ScheduleStep | undefined;
  private inFlightAt = 0;
  private readonly random: () => number;
  private readonly quietMs: number;
  private readonly stepTimeoutMs: number;
  private lastActivity = performance.now();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(readonly config: ScheduleConfig) {
    this.random = mulberry32(config.seed);
    this.quietMs = config.quietMs ?? DEFAULT_QUIET_MS;
    this.stepTimeoutMs = config.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  }

  matches(requestId: string | undefined): requestId is string {
    return !this.stopped && !!requestId && requestId.startsWith(this.config.prefix);
  }

  offer(requestId: string, release: () => void): void {
    if (this.stopped) return release();
    const queue = this.waiting.get(requestId) ?? [];
    queue.push(release);
    this.waiting.set(requestId, queue);
    this.lastActivity = performance.now();
    this.decide();
  }

  /** The released batch of this request got its ReadyForQuery. */
  finished(requestId: string): void {
    if (this.inFlight?.requestId === requestId) this.inFlight = undefined;
    else this.stalled.delete(requestId);
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
    if (this.inFlight) {
      const wait = this.inFlightAt + this.stepTimeoutMs - now;
      if (wait > 0) {
        this.timer = setTimeout(() => this.decide(), wait);
        return;
      }
      this.inFlight.stalled = true;
      this.stalled.add(this.inFlight.requestId);
      this.inFlight = undefined;
    }

    const everyoneWaits = this.waiting.size + this.stalled.size >= this.config.requests;
    const quietFor = now - this.lastActivity;
    if (!everyoneWaits && quietFor < this.quietMs) {
      this.timer = setTimeout(() => this.decide(), this.quietMs - quietFor);
      return;
    }

    const ids = [...this.waiting.keys()].sort(byIndex);
    const requestId = ids[Math.floor(this.random() * ids.length)]!;
    const queue = this.waiting.get(requestId)!;
    const release = queue.shift()!;
    if (!queue.length) this.waiting.delete(requestId);
    this.inFlight = { requestId };
    this.order.push(this.inFlight);
    this.inFlightAt = now;
    this.lastActivity = now;
    release();
    this.decide();
  }
}

function byIndex(a: string, b: string): number {
  const ia = Number(a.slice(a.lastIndexOf(".") + 1));
  const ib = Number(b.slice(b.lastIndexOf(".") + 1));
  return ia - ib || (a < b ? -1 : a > b ? 1 : 0);
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
