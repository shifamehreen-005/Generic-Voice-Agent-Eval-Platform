// ============================================================================
// reportHtml.ts — turn a saved run into ONE self-contained report.html.
//
// Reads results/<id>/ and bakes the data straight into the HTML, so it opens
// with a double-click (no server, no internet). Lean by design: the numbers and
// the one-line fix are up top, the transcript is tucked behind a toggle, and the
// "what the labels mean" reference sits at the bottom.
// ============================================================================
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function read(p: string): any { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const fill = (v: number) => v >= 0.999 ? "#2f8f57" : v >= 0.5 ? "#c08a2b" : "#cf4b3f";
// "reply_facts" -> "Reply facts": a metric key shown as a friendly bar label.
function humanize(k: string): string {
  const s = k.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function bar(label: string, v: number | null | undefined): string {
  if (v == null) return "";
  const p = Math.round(v * 100);
  return `<div class="bar"><span class="blab">${label}</span>
    <span class="btrack"><span class="bfill" style="width:${p}%;background:${fill(v)}"></span></span>
    <span class="bval">${p}%</span></div>`;
}

export function buildHtml(dir: string): string {
  const run = read(join(dir, "run.json")) ?? {};
  const rep = read(join(dir, "report.json")) ?? { cases: [], totals: {} };
  const gate = read(join(dir, "gate.json")) ?? { passed: true, reasons: [], baseline: null };
  const mean = rep.totals.meanComposite ?? 0;
  const failed = rep.cases.filter((r: any) => r.composite < 0.999).length;
  const anyReply = rep.cases.some((r: any) => r.reply != null);

  const cards = rep.cases.map((row: any) => {
    const cdir = join(dir, "cases", row.id);
    const events = read(join(cdir, "events.json")) ?? [];
    const segments = read(join(cdir, "segments.json")) ?? [];
    const transcript = segments.map((s: any) => s.text).join(" ") || "(none)";
    const replyEv = events.find((e: any) => e.kind === "assistant_text");
    const ok = row.composite >= 0.999;
    const badReply = (row.mismatchClasses?.UNSUPPORTED ?? 0) + (row.mismatchClasses?.GRAMMAR ?? 0) > 0;

    // trace: Input → tools → Reply/Result
    const tools = events.filter((e: any) => e.kind === "tool_call");
    const shown = tools.slice(0, 4);
    const nodes = [
      `<div class="node">${replyEv ? "Caller" : "Input"}</div>`,
      ...shown.map((e: any) => `<span class="arr">&rarr;</span><div class="node tool mono" title="${esc(JSON.stringify(e.args ?? {}))}">${esc(e.name)}</div>`),
      tools.length > shown.length ? `<span class="arr">&rarr;</span><div class="node mono">&hellip;&times;${tools.length - shown.length}</div>` : "",
      `<span class="arr">&rarr;</span><div class="node ${replyEv && badReply ? "bad" : "end"}">${replyEv ? "Reply" + (badReply ? " &#9888;" : "") : "Result"}</div>`,
    ].join("");

    return `
    <div class="card case">
      <div class="crow">
        <span class="mono cid">${esc(row.id)}</span>
        <span class="pill" style="margin-left:auto;background:${ok ? "#e7f4ec" : "#fbf0de"};color:${ok ? "#2f8f57" : "#c08a2b"}">${Math.round(row.composite * 100)}%</span>
      </div>
      <div class="what" style="background:${ok ? "#eef7f1" : "#fff4f2"}">
        <b style="color:${ok ? "#2f8f57" : "#cf4b3f"}">${ok ? "What happened:" : "Fix this:"}</b>
        <span>${esc(row.explanation || "Matched the answer key.")}</span>
      </div>
      <div class="split">
        <div class="bars">
          ${bar("Heard the words", row.layer1Wer)}
          ${bar("Right tools", row.trajectory)}
          ${(row.metrics ?? []).length
            ? (row.metrics as any[]).map((m) => bar(humanize(m.key) + (m.weight ? ` (${Math.round(m.weight * 100)}%)` : ""), m.value)).join("")
            : bar("Result correct", row.correct)}
          ${bar("Spoken reply", row.reply)}
        </div>
        <div class="tracebox">
          <div class="eyebrow">Trace &mdash; steps it took</div>
          <div class="flow">${nodes}</div>
        </div>
      </div>
      <details>
        <summary>Transcript${replyEv ? " &amp; reply" : ""} &amp; raw score</summary>
        <div class="trow">
          <div><span class="eyebrow">Heard</span>${esc(transcript)}</div>
          ${replyEv ? `<div><span class="eyebrow">Agent said</span>${esc(replyEv.data)}</div>` : ""}
        </div>
        <div class="jsonlink"><a href="cases/${esc(row.id)}/score.json">results/${esc(run.runId)}/cases/${esc(row.id)}/score.json</a></div>
      </details>
    </div>`;
  }).join("");

  const gateBox = gate.passed
    ? `<div class="card gate pass"><div class="gh">✓ Passed</div>
        <div>${esc((gate.reasons ?? [])[0] ?? `No worse than ${gate.baseline ?? "the baseline"}.`)}</div></div>`
    : `<div class="card gate fail"><div class="gh">✗ Blocked — this run got worse</div>
        <div>Compared against your previous run <b class="mono">${esc(gate.baseline ?? "?")}</b>. It scored lower, so the change is blocked from shipping.</div>
        <ul>${(gate.reasons ?? []).map((r: string) => `<li>${esc(r)}</li>`).join("")}</ul></div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(run.label ?? "eval report")}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
  :root{--bg:#f4f6f7;--card:#fff;--line:#e6e9eb;--ink:#1c252b;--dim:#71808a;--ok:#2f8f57;--warn:#c08a2b;--bad:#cf4b3f;--teal:#0f7d70}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 "IBM Plex Sans",system-ui,sans-serif}
  .mono{font-family:"IBM Plex Mono",ui-monospace,monospace}
  .wrap{max-width:900px;margin:0 auto;padding:26px 18px 60px;display:flex;flex-direction:column;gap:16px}
  .eyebrow{font-family:"IBM Plex Mono";font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px}
  .top{padding:22px 24px;display:flex;align-items:center;gap:20px}
  .top h1{margin:5px 0 0;font-size:24px;font-weight:600}
  .top .sub{color:var(--dim);font-size:13px;margin-top:3px}
  .big{margin-left:auto;text-align:right;font-size:42px;font-weight:600;line-height:1}
  .big small{display:block;font-size:12px;font-weight:400;color:var(--dim);margin-top:2px}
  .pill{font-weight:600;font-size:13px;padding:4px 12px;border-radius:999px}
  .gate{padding:16px 20px} .gate .gh{font-size:17px;font-weight:600;margin-bottom:5px}
  .gate.pass{background:#f0f8f3;border-color:#cfe9da} .gate.pass .gh{color:var(--ok)}
  .gate.fail{background:#fff5f4;border-color:#f3d6d2;color:#8a3b33} .gate.fail .gh{color:var(--bad)}
  .gate ul{margin:8px 0 0;padding-left:18px;font-size:13.5px} .gate li{margin:2px 0}
  .h2{font-size:18px;font-weight:600;margin:6px 0 -4px}
  .case{padding:18px 22px}
  .crow{display:flex;align-items:center;gap:12px} .cid{font-size:15px;font-weight:500}
  .what{border-radius:10px;padding:11px 14px;margin:12px 0;font-size:14px} .what b{font-size:12.5px}
  .split{display:flex;gap:28px} @media(max-width:640px){.split{flex-direction:column;gap:14px}}
  .bars{flex:1} .tracebox{flex:1}
  .bar{display:flex;align-items:center;gap:10px;font-size:13px;margin:5px 0}
  .blab{width:130px;color:#5b6871} .bval{width:40px;text-align:right;color:#5b6871}
  .btrack{flex:1;height:9px;background:#eef1f2;border-radius:999px;overflow:hidden}
  .bfill{display:block;height:100%;border-radius:999px}
  .flow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:7px}
  .node{padding:7px 10px;border-radius:9px;font-size:12.5px;border:1px solid var(--line);background:#f3f6f7}
  .node.tool{background:#e7f3f1;border-color:#bfe3dc;color:#0b5f55}
  .node.bad{background:#fbe9e7;border-color:#e9b7b1;color:#a3392f}
  .node.end{background:#e7f4ec;border-color:#bfe0cb;color:#256b41}
  .arr{color:#9aa7ae}
  details{margin-top:12px;border-top:1px solid #eef1f2;padding-top:10px}
  summary{cursor:pointer;color:var(--teal);font-size:13px;list-style:none}
  summary::-webkit-details-marker{display:none} summary::before{content:"\\25B8  ";color:#9aa7ae}
  details[open] summary::before{content:"\\25BE  "}
  .trow{display:flex;gap:20px;margin-top:10px;font-size:13px;color:#5b6871} .trow>div{flex:1}
  .trow .eyebrow{display:block;margin-bottom:3px}
  .jsonlink{margin-top:10px;font-size:12.5px} a{color:var(--teal)}
  .ref{display:flex;gap:16px} @media(max-width:640px){.ref{flex-direction:column}}
  .ref .card{flex:1;padding:14px 18px} .ref .eyebrow{margin-bottom:8px}
  .ref .body{font-size:12.5px;color:#5b6871;line-height:1.7}
</style></head><body><div class="wrap">

  <div class="card top">
    <div>
      <div class="eyebrow">Voice agent eval &middot; ${esc(run.cases?.[0]?.split("-")[0] ?? run.label)}</div>
      <h1>Run &ldquo;${esc(run.label ?? "")}&rdquo;</h1>
      <div class="sub">${rep.cases.length} test cases &middot; ${failed ? failed + " failed" : "all passed"} &middot; agent: ${esc(run.agent ?? "?")}</div>
    </div>
    <div class="big" style="color:${fill(mean)}">${Math.round(mean * 100)}%<small>average score</small></div>
    <span class="pill" style="background:${gate.passed ? "#e7f4ec" : "#fbe9e7"};color:${gate.passed ? "#2f8f57" : "#cf4b3f"}">${gate.passed ? "✓ PASSED" : "✗ FAILED"}</span>
  </div>

  ${gateBox}

  <div class="h2">Results by test case</div>
  ${cards}

  <div class="ref">
    <div class="card">
      <div class="eyebrow">How each case is scored</div>
      <div class="body"><b style="color:var(--ink)">1</b> run agent &rarr; <b style="color:var(--ink)">2</b> read result &rarr; <b style="color:var(--ink)">3</b> score vs answer key &rarr; <b style="color:${anyReply ? "var(--ink)" : "#aab4ba"}">4 judge reply${anyReply ? "" : " — no spoken reply here"}</b> &rarr; <b style="color:var(--ink)">5</b> pass/fail gate</div>
      ${anyReply ? "" : `<div style="margin-top:6px;font-size:12px;color:#aab4ba">Step 4 only runs when the agent speaks a reply. This agent just performs actions (e.g. charting), so there is nothing to read back — that's expected, not a failure.</div>`}
    </div>
    <div class="card">
      <div class="eyebrow">What the labels mean</div>
      <div class="body"><b class="mono" style="color:var(--ink)">${esc(run.label)}</b> = your run name. The <span class="mono">name-01/02</span> rows are different test scenarios. Green matched, amber partly off, red wrong. Open a case&rsquo;s <span class="mono">score.json</span> for the raw numbers.</div>
    </div>
  </div>

  <footer style="color:var(--dim);font-size:12.5px;text-align:center">Written automatically after the run &middot; results/${esc(run.runId ?? "")}/report.html</footer>
</div></body></html>`;
}

export function writeHtml(dir: string): string {
  const out = join(dir, "report.html");
  writeFileSync(out, buildHtml(dir));
  return out;
}
export function htmlExists(dir: string): boolean { return existsSync(join(dir, "run.json")); }
