// ============================================================================
// env.ts — tiny .env loader (no dependency).
//
// API keys NEVER live in code or in the repo. Put them in a local `.env` file
// (which .gitignore excludes) as:
//   OPENAI_API_KEY=sk-...
//   ANTHROPIC_API_KEY=sk-ant-...
// This reads that file once and populates process.env. Missing file = fine,
// you just can't use the real providers until a key is set.
// ============================================================================
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const path = join(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const val = m[2].replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}

export function requireKey(name: string): string {
  loadEnv();
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. Put it in a local .env file (see .env.example). ` +
      `Never hard-code a key or commit it.`,
    );
  }
  return v;
}
