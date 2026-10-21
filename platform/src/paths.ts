// Where runs and caches live. Tests point these at a temp dir with
// EVAL_RESULTS and EVAL_CACHE so they never touch the real results/.
import { join } from "node:path";

export function resultsRoot(): string {
  return process.env.EVAL_RESULTS ?? join(process.cwd(), "results");
}

export function cacheRoot(): string {
  return process.env.EVAL_CACHE ?? join(process.cwd(), ".cache");
}
