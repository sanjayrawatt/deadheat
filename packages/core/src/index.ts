export const VERSION = "0.0.0";

export * from "./types.js";
export { runScenario, deriveSeed, DEFAULT_TRIALS, type RunOptions } from "./runner.js";
export { loadScenario, validateScenario } from "./loader.js";
export {
  formatRun,
  formatTrialDetail,
  percentile,
  sendSpread,
  type ReportOptions,
} from "./report.js";
export { naive, sync, createSync, strategies } from "./strategies/index.js";
export { DEFAULT_SETTLE_MS, type SyncOptions } from "./strategies/sync.js";
export {
  decisionReads,
  fingerprint,
  isRead,
  isWrite,
  learnDecisionReads,
  staleReadPattern,
} from "./widen.js";
