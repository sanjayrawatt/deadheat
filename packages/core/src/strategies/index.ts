import type { Strategy } from "../types.js";
import { naive } from "./naive.js";
import { createSync, sync } from "./sync.js";

export { naive, sync, createSync };

/** Strategies selectable by name, e.g. from `deadheat run --strategy`. */
export const strategies: Readonly<Record<string, Strategy>> = { naive, sync };
