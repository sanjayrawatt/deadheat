import type { RequestSpec, RequestTrace, Strategy } from "../types.js";

const MAX_BODY_CHARS = 2000;

/**
 * Fires every request at once with Promise.all + fetch. That's what most developers would
 * write by hand, and it's the baseline the other strategies are measured against. It has no
 * control over when bytes reach the server.
 */
export const naive: Strategy = {
  name: "naive",
  async fire(baseUrl, specs) {
    const t0 = performance.now();
    return Promise.all(specs.map((spec, index) => send(baseUrl, spec, index, t0)));
  },
};

export async function send(
  baseUrl: string,
  spec: RequestSpec,
  index: number,
  t0: number,
): Promise<RequestTrace> {
  const trace: RequestTrace = {
    index,
    method: spec.method,
    url: spec.url,
    sentAtMs: performance.now() - t0,
  };
  try {
    const isString = typeof spec.body === "string";
    const res = await fetch(new URL(spec.url, baseUrl), {
      method: spec.method,
      headers: {
        ...(spec.body !== undefined && !isString ? { "content-type": "application/json" } : {}),
        ...spec.headers,
      },
      ...(spec.body !== undefined
        ? { body: isString ? (spec.body as string) : JSON.stringify(spec.body) }
        : {}),
    });
    trace.headersAtMs = performance.now() - t0;
    trace.status = res.status;
    trace.body = (await res.text()).slice(0, MAX_BODY_CHARS);
  } catch (err) {
    trace.error = err instanceof Error ? err.message : String(err);
  }
  return trace;
}
