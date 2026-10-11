import type { Scenario } from "./types.js";

/** The scenario with only these requests (original indexes), each keeping its own body. */
export function withRequests(scenario: Scenario, indexes: readonly number[]): Scenario {
  return {
    ...scenario,
    actions: {
      concurrency: indexes.length,
      request: (j) => scenario.actions.request(indexes[j]!),
    },
  };
}

export interface ShrinkStep {
  /** The candidate set that was tried (original request indexes). */
  tried: number[];
  violated: boolean;
}

/**
 * Finds a small subset of `all` for which `violates` still returns true, ddmin-style over
 * complements: split the current set into n chunks and try dropping each one. A success keeps
 * the smaller set (and n = max(n - 1, 2)); if no chunk can go, n doubles, until chunks are
 * single requests. The result is 1-minimal: dropping any one request makes it pass.
 *
 * `violates` is usually several attempts of a real, flaky run, so the result is "minimal as
 * far as the attempts could tell". Returns undefined if `all` itself doesn't violate.
 */
export async function shrinkRequests(
  all: readonly number[],
  violates: (subset: number[]) => Promise<boolean>,
  onStep: (step: ShrinkStep) => void = () => {},
): Promise<number[] | undefined> {
  const check = async (subset: number[]) => {
    const violated = await violates(subset);
    onStep({ tried: subset, violated });
    return violated;
  };
  let current = [...all];
  if (!(await check(current))) return undefined;

  let n = 2;
  while (current.length >= 2) {
    const chunks = split(current, Math.min(n, current.length));
    let reduced = false;
    for (const chunk of chunks) {
      const drop = new Set(chunk);
      const rest = current.filter((i) => !drop.has(i));
      if (rest.length && (await check(rest))) {
        current = rest;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(n * 2, current.length);
    }
  }
  return current;
}

function split<T>(items: T[], parts: number): T[][] {
  const out: T[][] = [];
  const size = items.length / parts;
  for (let p = 0; p < parts; p++) {
    out.push(items.slice(Math.round(p * size), Math.round((p + 1) * size)));
  }
  return out.filter((c) => c.length);
}
