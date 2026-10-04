import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryStore, startControl, type ControlServer } from "./control.js";
import type { QueryEvent } from "./tracker.js";

const q = (requestId: string | undefined, sql = "SELECT 1"): QueryEvent => ({
  type: "query",
  connectionId: 1,
  protocol: "extended",
  sql,
  ...(requestId ? { requestId } : {}),
  startedAt: 0,
  durationMs: 1,
  rows: 1,
  commandTags: ["SELECT 1"],
  txStatus: "I",
});

describe("QueryStore", () => {
  it("groups by request id, ignores untagged queries, and forgets what it hands out", () => {
    const store = new QueryStore();
    store.add(q("a", "one"));
    store.add(q(undefined));
    store.add(q("a", "two"));
    store.add(q("b"));
    expect(store.size).toBe(3);
    expect(Object.keys(store.take(["a", "zzz"]))).toEqual(["a"]);
    expect(store.size).toBe(1);
    expect(store.take(["a"])).toEqual({});
  });

  it("drops the oldest requests beyond the limit and after the ttl", () => {
    const capped = new QueryStore(60_000, 2);
    capped.add(q("a"));
    capped.add(q("b"));
    capped.add(q("c"));
    expect(Object.keys(capped.take(["a", "b", "c"]))).toEqual(["b", "c"]);

    vi.useFakeTimers();
    try {
      const short = new QueryStore(1000);
      short.add(q("old"));
      vi.advanceTimersByTime(2000);
      short.add(q("new"));
      expect(Object.keys(short.take(["old", "new"]))).toEqual(["new"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("control server", () => {
  let control: ControlServer | undefined;
  afterEach(() => control?.close());

  it("serves /health and /take", async () => {
    const store = new QueryStore();
    store.add(q("r1"));
    control = await startControl({ store });
    const base = `http://127.0.0.1:${control.port}`;

    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, queries: 1 });
    const res = await fetch(`${base}/take`, {
      method: "POST",
      body: JSON.stringify({ requestIds: ["r1"] }),
    });
    const body = (await res.json()) as { queries: Record<string, QueryEvent[]> };
    expect(body.queries.r1?.[0]?.sql).toBe("SELECT 1");

    const bad = await fetch(`${base}/take`, { method: "POST", body: "{}" });
    expect(bad.status).toBe(400);
  });
});
