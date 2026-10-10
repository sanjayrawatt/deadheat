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

  it("decides anyway after quietMs when some requests never send a query", async () => {
    const { s, released, offer } = harness({ quietMs: 20 });
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

  it("mulberry32 is deterministic and in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 100 }, () => a());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});
