/** Split a transcript into sentences, keeping the punctuation on each piece. */
export function splitUtterances(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length) return parts;
  const trimmed = text.trim();
  return trimmed ? [trimmed] : [];
}
