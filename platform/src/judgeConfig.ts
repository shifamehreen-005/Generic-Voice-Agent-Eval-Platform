// Judge model and provider live in config/judge.json. --judge-model overrides.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface JudgeConfig {
  provider?: string;
  model?: string;
}

const DEFAULTS: Record<string, string> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-5",
};

export function loadJudgeConfig(path = join(process.cwd(), "config", "judge.json")): JudgeConfig {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")) as JudgeConfig; }
  catch { return {}; }
}

/** The model name a judge call will use. File, then override, then the built-in default. */
export function resolveJudgeModel(provider: string, override?: string, path?: string): string {
  if (override) return override;
  const fromFile = loadJudgeConfig(path).model;
  if (fromFile) return fromFile;
  return DEFAULTS[provider] ?? DEFAULTS.openai;
}
