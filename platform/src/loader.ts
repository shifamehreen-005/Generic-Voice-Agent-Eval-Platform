// ============================================================================
// loader.ts — case loading + the two load-bearing conventions from spec §4.
//
//  1. Any JSON key starting with "_" is a human annotation; strip it before
//     anything else touches the data, so notes can never break parsing.
//  2. Exactly one entry point (audioFile | segmentsFile | transcriptText) must
//     be present.
// ============================================================================
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { Case } from "./types.ts";

/** Recursively drop every key that starts with "_". */
export function stripUnderscores<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUnderscores) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith("_")) continue;              // human annotation — ignored
      out[k] = stripUnderscores(v);
    }
    return out as T;
  }
  return value;
}

export function loadCaseFile(path: string): Case {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const c = stripUnderscores(raw) as Case;

  const entries = [c.audioFile, c.segmentsFile, c.transcriptText]
    .filter((x) => x != null);
  if (entries.length !== 1) {
    throw new Error(
      `${basename(path)}: exactly one of audioFile/segmentsFile/transcriptText required, got ${entries.length}`,
    );
  }
  if (!c.adapter) throw new Error(`${basename(path)}: missing "adapter"`);
  if (!c.provenance) c.provenance = { kind: "silver" };  // unmarked drafts are silver
  return c;
}

/** Load a glob-ish set: a directory, or a comma-separated list of files. */
export function loadCases(spec: string): Case[] {
  const paths: string[] = [];
  for (const part of spec.split(",").map((s) => s.trim())) {
    try {
      const stat = readdirSync(part);            // directory
      for (const f of stat.filter((f) => f.endsWith(".json")).sort()) {
        paths.push(join(part, f));
      }
    } catch {
      paths.push(part);                          // single file
    }
  }
  return paths.map(loadCaseFile);
}

// ---- minimal JSON-Schema validator (spec §3 groundTruthSchema) -------------
// Just enough of JSON Schema to catch real authoring bugs: type, required,
// properties, items, enum. Returns a list of human-readable errors.
export function validateSchema(data: unknown, schema: any, path = "$"): string[] {
  if (!schema) return [];
  const errs: string[] = [];
  const t = schema.type as string | undefined;

  if (t === "object") {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return [`${path}: expected object`];
    }
    for (const req of schema.required ?? []) {
      if (!(req in (data as object))) errs.push(`${path}.${req}: required`);
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in (data as object)) {
        errs.push(...validateSchema((data as any)[k], sub, `${path}.${k}`));
      }
    }
  } else if (t === "array") {
    if (!Array.isArray(data)) return [`${path}: expected array`];
    if (schema.items) {
      data.forEach((el, i) => errs.push(...validateSchema(el, schema.items, `${path}[${i}]`)));
    }
  } else if (t === "number" || t === "integer") {
    if (typeof data !== "number") errs.push(`${path}: expected ${t}`);
  } else if (t === "string") {
    if (typeof data !== "string") errs.push(`${path}: expected string`);
  }

  if (schema.enum && !schema.enum.includes(data)) {
    errs.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  return errs;
}
