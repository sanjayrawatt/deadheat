import { describe, expect, it } from "vitest";
import { shrinkRequests, withRequests } from "./shrink.js";
import type { Scenario } from "./types.js";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("shrinkRequests", () => {
  it("finds the two requests that race out of twenty", async () => {
    const tried: number[][] = [];
    const result = await shrinkRequests(
      range(20),
      async (s) => s.includes(4) && s.includes(13),
      (step) => tried.push(step.tried),
    );
    expect(result).toEqual([4, 13]);
    expect(tried[0]).toEqual(range(20));
    expect(tried.length).toBeLessThan(40);
  });

  it("finds any two when any pair of requests breaks the invariant", async () => {
    const result = await shrinkRequests(range(10), async (s) => s.length >= 2);
    expect(result).toHaveLength(2);
  });

  it("keeps three when the bug needs three", async () => {
    const result = await shrinkRequests(range(12), async (s) => s.length >= 3);
    expect(result).toHaveLength(3);
  });

  it("is 1-minimal: dropping any request from the result passes", async () => {
    const needs = (s: number[]) => s.includes(2) && s.includes(7) && s.includes(9);
    const result = (await shrinkRequests(range(16), async (s) => needs(s)))!;
    for (const i of result) expect(needs(result.filter((x) => x !== i))).toBe(false);
  });

  it("returns undefined when the full set doesn't violate", async () => {
    expect(await shrinkRequests(range(5), async () => false)).toBeUndefined();
  });

  it("withRequests keeps each chosen request's own body", () => {
    const scenario = {
      name: "s",
      baseUrl: "http://x",
      actions: { concurrency: 20, request: (i: number) => ({ method: "POST", url: `/r/${i}` }) },
      invariant: async () => true as const,
    } satisfies Scenario;
    const small = withRequests(scenario, [4, 13]);
    expect(small.actions.concurrency).toBe(2);
    expect([0, 1].map((j) => small.actions.request(j).url)).toEqual(["/r/4", "/r/13"]);
  });
});
