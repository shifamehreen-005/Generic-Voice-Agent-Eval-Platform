#!/usr/bin/env -S npx tsx
// ============================================================================
// gen-audio.ts — DEMO helper. Turns the demo cases' reference transcripts into
// real spoken audio using text-to-speech, so the real speech-to-text path has
// something to listen to. Run it ONCE (needs a key). You can also just drop your
// own .mp3 clips into demo/cases/audio/ instead.
//
//   npx tsx demo/gen-audio.ts            (or: npm run gen-audio)
//
// Writes demo/cases/audio/<audioFile> for every demo case that names one.
// ============================================================================
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadCases } from "../platform/src/loader.ts";
import { ttsOpenAI, ttsElevenLabs } from "../platform/src/providers.ts";
import { loadEnv } from "../platform/src/env.ts";

loadEnv();
const CASES_DIR = join("demo", "cases");
const outDir = join(process.cwd(), "demo", "cases", "audio");
mkdirSync(outDir, { recursive: true });

const hasEleven = !!process.env.ELEVENLABS_API_KEY;
const hasOpenAI = !!process.env.OPENAI_API_KEY;
if (!hasEleven && !hasOpenAI) {
  console.error("gen-audio needs a text-to-speech key in .env: OPENAI_API_KEY (simplest) or ELEVENLABS_API_KEY.");
  process.exit(1);
}
// prefer ElevenLabs (more natural) when its key is set; fall back to OpenAI TTS.
let useEleven = hasEleven;
console.log(`voice: ${useEleven ? "ElevenLabs" : "OpenAI"}${useEleven && hasOpenAI ? "  (falls back to OpenAI if the key is rejected)" : ""}`);

// optional: `gen-audio --adapter dental` only voices that domain's cases
const i = process.argv.indexOf("--adapter");
const only = i >= 0 ? process.argv[i + 1] : null;
const cases = loadCases(CASES_DIR).filter((c) => c.audioFile && (!only || c.adapter === only));
if (!cases.length) { console.log(`no cases with an audioFile${only ? ` for adapter ${only}` : ""}`); process.exit(0); }

const firstLine = (s: string) => s.split("\n")[0].slice(0, 160);

for (const c of cases) {
  const out = join(outDir, c.audioFile!);
  if (existsSync(out)) { console.log(`skip (exists): ${c.audioFile}`); continue; }
  const text = c.referenceTranscript ?? "";
  process.stdout.write(`speaking ${c.audioFile} … `);
  try {
    if (useEleven) await ttsElevenLabs(text, out); else await ttsOpenAI(text, out);
  } catch (err) {
    const msg = firstLine(err instanceof Error ? err.message : String(err));
    // A rejected ElevenLabs key shouldn't stop the demo if we can use OpenAI instead.
    if (useEleven && hasOpenAI) {
      console.log(`\n  ⚠ ElevenLabs failed (${msg}).\n  → switching to OpenAI text-to-speech for this and the rest.`);
      useEleven = false;
      await ttsOpenAI(text, out);
    } else if (useEleven) {
      console.error(`\nerror: ElevenLabs rejected the request — ${msg}`);
      console.error(`hint: ElevenLabs keys start with "sk_" (you may have pasted the key *ID*). Fix ELEVENLABS_API_KEY in .env,`);
      console.error(`      or remove that line to use OpenAI text-to-speech (needs OPENAI_API_KEY).`);
      process.exit(1);
    } else {
      console.error(`\nerror: OpenAI text-to-speech failed — ${msg}`);
      process.exit(1);
    }
  }
  console.log("done");
}
console.log(`\naudio in ${outDir}. Now run e.g.:\n  npm run eval:real:dental\n  npm run eval:real:receptionist`);
