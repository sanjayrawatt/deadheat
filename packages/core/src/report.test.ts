import { describe, expect, it } from "vitest";
import { formatRun, percentile, sendSpread } from "./report.js";
import type { RunResult, TrialResult } from "./types.js";

function trial(n: number, passed: boolean): TrialResult {
  return {
    trial: n,
    passed,
    ...(passed ? {} : { violation: "bookings = 2, capacity = 1" }),
    durationMs: 5,
    requests: [
      { index: 0, method: "POST", url: "/bookings", sentAtMs: 0, headersAtMs: 4, status: 409 },
      { index: 1, method: "POST", url: "/bookings", sentAtMs: 0.1, headersAtMs: 3, status: 201 },
      { index: 2, method: "POST", url: "/bookings", sentAtMs: 0.2, headersAtMs: 3.5, status: 201 },
    ],
  };
}

const base: RunResult = {
  runId: "run-1",
  scenario: "slot is never oversold",
  strategy: "naive",
  startedAt: "2026-10-04T00:00:00Z",
  durationMs: 1234,
  trials: [trial(1, true), trial(2, false)],
  violations: 1,
};

describe("formatRun", () => {
  it("summarises violations and lists the successful requests of a violating trial first", () => {
    const text = formatRun(base);
    expect(text).toContain("✗ slot is never oversold: 1/2 trials violated (50.0%), strategy=naive");
    expect(text).toContain("Trial 2: bookings = 2, capacity = 1");
    const lines = text.split("\n").filter((l) => l.includes("Request #"));
    expect(lines.map((l) => l.match(/ (\d{3}) /)?.[1])).toEqual(["201", "201", "409"]);
    expect(text).toMatch(/Send spread .* p50 0\.20ms/);
  });

  it("marks a clean run with a tick", () => {
    expect(formatRun({ ...base, trials: [trial(1, true)], violations: 0 })).toMatch(/^✓ /);
  });

  it("shows why a run was aborted", () => {
    expect(formatRun({ ...base, aborted: "setup is broken" })).toContain("setup is broken");
  });

  it("truncates long request lists", () => {
    expect(formatRun(base, { maxRequests: 1 })).toContain("… 2 more requests");
  });
});

describe("helpers", () => {
  it("percentile uses nearest rank", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 99)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });

  it("sendSpread is last minus first send time", () => {
    expect(sendSpread(trial(1, true).requests)).toBeCloseTo(0.2);
    expect(sendSpread([])).toBe(0);
  });
});
