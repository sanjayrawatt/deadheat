import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { mulberry32, Scheduler, type ScheduleConfig } from "./scheduler.js";

function harness(config: Partial<ScheduleConfig> = {}) {
  const s = new Scheduler({ prefix: "r.1.", requests: 3, seed: 7, quietMs: 30, ...config });
  const released: string[] = [];
  const offer = (id: string) => s.offer(id, () => released.push(id));
  return { s, released, offer };
}

describe("Scheduler", () => {
  it("only matches its own trial's request ids", () => {
    const { s } = harness();
    expect(s.matches("r.1.0")).toBe(true);
    expect(s.matches("r.2.0")).toBe(false);
    expect(s.matches(undefined)).toBe(false);
  });

  it("decides as soon as every request waits, and runs one step at a time", () => {
    const { s, released, offer } = harness();
    offer("r.1.0");
    offer("r.1.1");
    expect(released).toEqual([]);
    offer("r.1.2");
    expect(released).toHaveLength(1);
    s.finished(released[0]!);
    expect(released).toHaveLength(1); // the finished request may send its next query
    offer(released[0]!);
    expect(released).toHaveLength(2);
    s.stop();
  });

  it("gives the same order for the same seed, and a different one for another seed", async () => {
    const ids = ["r.1.0", "r.1.1", "r.1.2"];
    const run = async (seed: number) => {
      const s = new Scheduler({ prefix: "r.1.", requests: 3, seed, quietMs: 5 });
      const left = new Map(ids.map((id) => [id, 2]));
      const released: string[] = [];
      const offer = (id: string): void =>
        s.offer(id, () => {
          released.push(id);
          queueMicrotask(() => {
            s.finished(id);
            left.set(id, left.get(id)! - 1);
            if (left.get(id)! > 0) offer(id);
          });
        });
      ids.forEach(offer);
      while (released.length < 6) await sleep(5);
      s.stop();
      return released.join(",");
    };
    const orders = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6]) orders.add(await run(seed));
    expect(await run(7)).toBe(await run(7));
    expect(orders.size).toBeGreaterThan(1);
  });

  it("at the start, waits for every request's first batch up to startTimeoutMs", async () => {
    const { s, released, offer } = harness({ quietMs: 5, startTimeoutMs: 60 });
    offer("r.1.0");
    await sleep(30);
    expect(released).toEqual([]); // quiet for 30ms, but r.1.1 and r.1.2 haven't shown up yet
    offer("r.1.1");
    offer("r.1.2");
    expect(released).toHaveLength(1);
    s.stop();
  });

  it("decides anyway after quietMs when some requests never send a query", async () => {
    const { s, released, offer } = harness({ quietMs: 20, startTimeoutMs: 0 });
    offer("r.1.0");
    await sleep(5);
    expect(released).toEqual([]);
    await sleep(40);
    expect(released).toEqual(["r.1.0"]);
    s.stop();
  });

  it("treats a step that doesn't finish as blocked and releases the next one", async () => {
    const { s, released, offer } = harness({ requests: 2, stepTimeoutMs: 20 });
    offer("r.1.0");
    offer("r.1.1");
    expect(released).toHaveLength(1);
    await sleep(50);
    expect(released).toHaveLength(2);
    expect(s.order[0]).toMatchObject({ requestId: released[0], stalled: true });
    s.stop();
  });

  it("releases everything still held when stopped, and passes later offers through", () => {
    const { s, released, offer } = harness();
    offer("r.1.0");
    offer("r.1.1");
    s.stop();
    expect(released.sort()).toEqual(["r.1.0", "r.1.1"]);
    offer("r.1.2");
    expect(released).toContain("r.1.2");
  });

  it("barrier: releases every waiting batch together, then waits for the whole phase", () => {
    const { s, released, offer } = harness({ policy: "barrier" });
    offer("r.1.0");
    offer("r.1.1");
    expect(released).toEqual([]);
    offer("r.1.2");
    expect(released.sort()).toEqual(["r.1.0", "r.1.1", "r.1.2"]);
    expect(s.order.every((st) => st.phase === 1)).toBe(true);
    s.finished("r.1.0");
    offer("r.1.0");
    expect(released).toHaveLength(3); // phase 1 isn't over yet
    s.finished("r.1.1");
    s.finished("r.1.2");
    offer("r.1.1");
    offer("r.1.2");
    expect(released).toHaveLength(6);
    expect(s.order.slice(3).every((st) => st.phase === 2)).toBe(true);
    s.stop();
  });

  it("pct: runs the highest-priority request until a change point demotes it", () => {
    const { s, released, offer } = harness({ policy: "pct", depth: 1 });
    for (const id of ["r.1.0", "r.1.1", "r.1.2"]) offer(id);
    const first = released[0]!;
    // depth 1 has no change points: the top request keeps winning whenever it waits
    for (let i = 0; i < 3; i++) {
      s.finished(first);
      offer(first);
    }
    expect(released).toEqual([first, first, first, first]);
    s.stop();
  });

  it("pct: the same seed gives the same priorities", () => {
    const pick = (seed: number) => {
      const { s, released, offer } = harness({ policy: "pct", seed });
      for (const id of ["r.1.0", "r.1.1", "r.1.2"]) offer(id);
      s.stop();
      return released[0];
    };
    expect(pick(3)).toBe(pick(3));
    expect(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(pick)).size).toBeGreaterThan(1);
  });

  it("forced: follows the recorded order, whatever arrives first", () => {
    const { s, released, offer } = harness({ policy: "forced", order: [2, 0, 2] });
    offer("r.1.0");
    offer("r.1.1");
    expect(released).toEqual([]);
    offer("r.1.2");
    expect(released).toEqual(["r.1.2"]);
    s.finished("r.1.2");
    expect(released).toEqual(["r.1.2", "r.1.0"]);
    s.finished("r.1.0");
    offer("r.1.2");
    expect(released).toEqual(["r.1.2", "r.1.0", "r.1.2"]);
    expect(s.order.some((st) => st.unforced)).toBe(false);
    s.stop();
  });

  it("forced: replays a barrier phase together once all its requests wait", () => {
    const { s, released, offer } = harness({ policy: "forced", order: [[0, 2], 1] });
    offer("r.1.0");
    offer("r.1.1");
    expect(released).toEqual([]);
    offer("r.1.2");
    expect(released).toEqual(["r.1.0", "r.1.2"]);
    expect(s.order.map((st) => st.phase)).toEqual([1, 1]);
    s.finished("r.1.0");
    expect(released).toHaveLength(2); // the phase isn't over until r.1.2 is done too
    s.finished("r.1.2");
    expect(released).toEqual(["r.1.0", "r.1.2", "r.1.1"]);
    s.stop();
  });

  it("forced: continues with the fallback policy after the recording", () => {
    const { s, released, offer } = harness({ policy: "forced", order: [1], fallback: "barrier" });
    for (const id of ["r.1.0", "r.1.1", "r.1.2"]) offer(id);
    expect(released).toEqual(["r.1.1"]);
    s.finished("r.1.1");
    offer("r.1.1");
    expect(released.slice(1).sort()).toEqual(["r.1.0", "r.1.1", "r.1.2"]); // one barrier phase
    expect(s.order.slice(1).every((st) => st.unforced && st.phase === 1)).toBe(true);
    s.stop();
  });

  it("forced: gives up when the expected request never comes, and marks the rest", async () => {
    const { s, released, offer } = harness({
      policy: "forced",
      order: [1, 0],
      forceTimeoutMs: 20,
      quietMs: 5,
      startTimeoutMs: 0,
    });
    offer("r.1.0");
    await sleep(50);
    expect(released).toEqual(["r.1.0"]);
    expect(s.order[0]).toMatchObject({ requestId: "r.1.0", unforced: true });
    s.stop();
  });

  it("with a probe: a step blocked on a lock is marked within ~10ms, naming the blocker", async () => {
    const asked: string[][] = [];
    const s = new Scheduler(
      { prefix: "r.1.", requests: 2, seed: 7, policy: "forced", order: [0, 1, 0] },
      {
        probe: async (ids) => {
          asked.push(ids);
          return new Map(ids.filter((id) => id === "r.1.1").map((id) => [id, ["r.1.0"]]));
        },
      },
    );
    const released: string[] = [];
    const offer = (id: string) => s.offer(id, () => released.push(id));
    offer("r.1.0");
    offer("r.1.1");
    s.finished("r.1.0");
    offer("r.1.0"); // r.1.0 holds the lock and wants to commit
    expect(released).toEqual(["r.1.0", "r.1.1"]); // r.1.1 now waits on r.1.0's lock
    const t = performance.now();
    while (released.length < 3 && performance.now() - t < 500) await sleep(2);
    expect(released).toEqual(["r.1.0", "r.1.1", "r.1.0"]);
    expect(performance.now() - t).toBeLessThan(80); // not the 2s slow timeout
    expect(s.order[1]).toMatchObject({ requestId: "r.1.1", stalled: true, blockedBy: ["r.1.0"] });
    expect(asked[0]).toEqual(["r.1.1"]);
    s.stop();
  });

  it("with a probe: a slow step that isn't blocked keeps its turn", async () => {
    const s = new Scheduler(
      { prefix: "r.1.", requests: 2, seed: 7, policy: "forced", order: [0, 1] },
      { probe: async () => new Map() },
    );
    const released: string[] = [];
    s.offer("r.1.0", () => released.push("r.1.0"));
    s.offer("r.1.1", () => released.push("r.1.1"));
    await sleep(150); // past the no-probe 100ms timeout
    expect(released).toEqual(["r.1.0"]);
    expect(s.order[0]!.stalled).toBeUndefined();
    s.stop();
  });

  it("mulberry32 is deterministic and in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 100 }, () => a());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});
