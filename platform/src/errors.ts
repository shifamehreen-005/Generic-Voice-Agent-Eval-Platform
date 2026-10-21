// Exit codes a coding agent can branch on. Listed in `eval --help`.
//   0 pass
//   1 the regression gate failed
//   2 a case hard-failed
//   3 bad config or case file
//   4 provider error (key, quota, network) or the cost ceiling

export const EXIT = {
  pass: 0,
  gate: 1,
  hardFail: 2,
  config: 3,
  provider: 4,
} as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export function isProviderMessage(msg: string): boolean {
  return /not set|quota|rate limit|\b429\b|ENOTFOUND|ECONN|ETIMEDOUT|fetch failed|EAI_AGAIN|API key|^OpenAI |^Anthropic |^ElevenLabs /i.test(msg);
}

export function oneLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0];
}

export function exitFor(err: unknown): number {
  if (err instanceof ConfigError) return EXIT.config;
  if (err instanceof ProviderError) return EXIT.provider;
  if (err instanceof Error && isProviderMessage(err.message)) return EXIT.provider;
  return EXIT.gate;
}
