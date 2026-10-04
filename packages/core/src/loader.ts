import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import type { Scenario } from "./types.js";

/** Imports a scenario file (.ts or .js) and checks it has the expected shape. */
export async function loadScenario(path: string): Promise<Scenario> {
  const url = pathToFileURL(resolve(path)).href;
  const mod = (await tsImport(url, import.meta.url)) as { default?: unknown };
  return validateScenario(unwrapDefault(mod.default), path);
}

// When the file is treated as CommonJS (no "type": "module" nearby), ESM interop wraps
// `export default x` once more, as `{ default: x }`.
function unwrapDefault(value: unknown): unknown {
  if (value && typeof value === "object" && "default" in value && !("name" in value)) {
    return (value as { default: unknown }).default;
  }
  return value;
}

export function validateScenario(value: unknown, source = "scenario"): Scenario {
  const problems: string[] = [];
  const s = value as Partial<Scenario> | undefined;

  if (!s || typeof s !== "object") {
    throw new Error(`${source}: no default export. Use \`export default scenario({ ... })\`.`);
  }
  if (typeof s.name !== "string" || !s.name) problems.push("`name` must be a non-empty string");
  if (typeof s.baseUrl !== "string" || !URL.canParse(s.baseUrl)) {
    problems.push("`baseUrl` must be an absolute URL, e.g. http://127.0.0.1:4100");
  }
  if (s.setup !== undefined && typeof s.setup !== "function") {
    problems.push("`setup` must be a function");
  }
  if (typeof s.invariant !== "function") problems.push("`invariant` must be a function");
  if (!s.actions || typeof s.actions !== "object") {
    problems.push("`actions` must be an object with `concurrency` and `request`");
  } else {
    const { concurrency, request } = s.actions;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      problems.push("`actions.concurrency` must be an integer >= 1");
    }
    if (typeof request !== "function") problems.push("`actions.request` must be a function");
  }
  if (s.trials !== undefined && (!Number.isInteger(s.trials) || s.trials < 1)) {
    problems.push("`trials` must be an integer >= 1");
  }

  if (problems.length) {
    throw new Error(`${source}: invalid scenario\n  - ${problems.join("\n  - ")}`);
  }
  return s as Scenario;
}
