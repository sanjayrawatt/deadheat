export const VERSION = "0.0.0";

export * from "./types.js";
export { runScenario, DEFAULT_TRIALS, type RunOptions } from "./runner.js";
export { loadScenario, validateScenario } from "./loader.js";
export { formatRun, percentile, sendSpread, type ReportOptions } from "./report.js";
export { naive } from "./strategies/naive.js";
