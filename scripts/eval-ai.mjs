#!/usr/bin/env node
/**
 * eval-ai — does the advisory layer help, and what does it cost?
 *
 * OPT-IN. Requires ANTHROPIC_API_KEY, spends real money, and is NEVER part of `npm test`: the
 * deterministic scores (round trips, unaccounted errors, the mutation floors) must not depend
 * on a remote service, and nothing here touches them. It reuses the engine harness and the
 * mutation engine so the questions are asked about exactly the messages and defects the
 * deterministic suite already measures.
 *
 * Three numbers, never averaged:
 *
 *   rescue rate      for mutations the checker did NOT locate or classify, does a review's
 *                    `additional` observation name the mutated element within ±2 lines?
 *                    (Also reported: by name, when the claim mentions the element.)
 *   false-alarm rate on the official (clean) samples, every `additional` observation that is
 *                    not within ±2 lines of a catalogued known-sample-defect is a false alarm.
 *                    Reported per document.
 *   undermining rate for mutations the checker got RIGHT (classified and located), how often
 *                    the model says `doubt` on the finding that was right.
 *
 * "BETTER" — the bar the layer must clear to be worth showing to a hospital:
 *
 *     rescue-location >= 50%   AND   false alarms <= 1 per 10 clean documents   AND
 *     undermining <= 5%
 *
 * A layer that rescues nothing is not worth its cost; one that cries wolf on clean official
 * messages, or talks engineers out of correct findings, is worse than none.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=… npm run eval:ai -- [--limit N] [--only clean|mutations]
 *
 * `--limit N` caps the number of model calls per measurement (clean docs, rescue candidates,
 * undermining candidates), so a smoke run costs cents rather than dollars.
 */

// The harness stubs globalThis.fetch to throw for every engine suite. That is the right
// default — no test may reach the network — but this script must, so the real fetch is saved
// BEFORE the harness is imported (dynamic import below) and restored before any SDK call.
const realFetch = globalThis.fetch;

import path from "node:path";
import { createJiti } from "jiti";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("eval-ai: ANTHROPIC_API_KEY is not set. This evaluation calls the Anthropic API and is opt-in.");
  process.exit(2);
}

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const LIMIT = flag("--limit") ? Number(flag("--limit")) : Infinity;
const ONLY = flag("--only") ?? "all";

const { loadEngine, readGolden, goldenExists, ROOT } = await import("../tests/harness.mjs");
const { mutationsFor } = await import("../tests/mutate.mjs");
globalThis.fetch = realFetch; // the SDK may now reach api.anthropic.com

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: true });
const ai = await jiti.import(path.join(ROOT, "src/lib/ai.ts"));
const { buildSkeleton } = await jiti.import(path.join(ROOT, "src/lib/skeleton.ts"));

const { workbench, structure: S } = await loadEngine();
const golden = await workbench.loadGoldenIndex();

/* -------------------------------------------------------------------------- *
 * Cost — Claude Opus 5 list prices per million tokens
 * -------------------------------------------------------------------------- */

const PRICE = { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 };
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0, dropped: 0 };

function account(outcome) {
  usage.calls++;
  usage.inputTokens += outcome.usage.inputTokens;
  usage.outputTokens += outcome.usage.outputTokens;
  usage.cacheReadTokens += outcome.usage.cacheReadTokens;
  usage.cacheWriteTokens += outcome.usage.cacheWriteTokens;
  usage.dropped += outcome.dropped.length;
}

function dollars() {
  return (
    (usage.inputTokens * PRICE.input +
      usage.outputTokens * PRICE.output +
      usage.cacheReadTokens * PRICE.cacheRead +
      usage.cacheWriteTokens * PRICE.cacheWrite) /
    1_000_000
  );
}

/* -------------------------------------------------------------------------- *
 * One review call over an analysed message
 * -------------------------------------------------------------------------- */

const REVIEWABLE = (f) => f.code !== "readiness-coverage";

async function review(structure, resolved, analysis) {
  const skeleton = buildSkeleton(analysis.parse.tree, resolved.specNodes, { findings: analysis.findings });
  const findings = analysis.findings.filter(REVIEWABLE).map(ai.redactFinding);
  const rules = ai.ruleStubsFrom(resolved.specNodes);
  const outcome = await ai.reviewFindings(apiKey, { structure, findings, skeleton, rules });
  account(outcome);
  return { outcome, skeleton };
}

const additionalOf = (outcome) => outcome.advisories.filter((a) => a.about.findingId === undefined);
const near = (a, line) => a.about.line !== null && a.about.line !== undefined && Math.abs(a.about.line - line) <= 2;

/* -------------------------------------------------------------------------- *
 * Cases: one sample per use case, as the mutation suite does
 * -------------------------------------------------------------------------- */

const cases = [];
for (const [useCaseId, samples] of golden) {
  const structures = await workbench.structuresFor(useCaseId);
  for (const sample of samples) {
    if (!goldenExists(sample.path)) continue;
    const structure = workbench.structureForSample(structures, sample);
    if (!structure) continue;
    const resolved = await workbench.resolve(useCaseId, structure.variant ?? structure.id);
    const text = readGolden(sample.path);
    const baseline = await workbench.analyse(text, structure, resolved);
    if (baseline.parse.failure) continue;
    cases.push({ useCaseId, sample, structure, resolved, text, baseline });
  }
}

const log = (s) => process.stderr.write(`${s}\n`);

/* -------------------------------------------------------------------------- *
 * (2) False alarms on the clean official samples
 * -------------------------------------------------------------------------- */

const clean = { docs: 0, additional: 0, falseAlarms: 0, perDoc: [] };
if (ONLY === "all" || ONLY === "clean") {
  for (const c of cases.slice(0, LIMIT)) {
    const defectLines = c.baseline.findings.filter((f) => f.code === "known-sample-defect" && f.location).map((f) => f.location.line);
    try {
      const { outcome } = await review(c.structure, c.resolved, c.baseline);
      const extra = additionalOf(outcome);
      const alarms = extra.filter((a) => !defectLines.some((l) => near(a, l)));
      clean.docs++;
      clean.additional += extra.length;
      clean.falseAlarms += alarms.length;
      clean.perDoc.push({ file: c.sample.fileName, alarms: alarms.map((a) => `L${a.about.line ?? "-"} ${a.claim}`) });
      log(`clean  ${c.sample.fileName}: ${extra.length} additional, ${alarms.length} false alarm(s), ${outcome.dropped.length} dropped`);
    } catch (err) {
      log(`clean  ${c.sample.fileName}: call failed — ${err.message}`);
    }
  }
}

/* -------------------------------------------------------------------------- *
 * (1) Rescue and (3) undermining over the mutation set
 * -------------------------------------------------------------------------- */

const rescue = { candidates: 0, byLine: 0, byName: 0, detail: [] };
const undermine = { candidates: 0, doubted: 0, detail: [] };

if (ONLY === "all" || ONLY === "mutations") {
  let rescueCalls = 0;
  let undermineCalls = 0;
  const seen = new Set();
  for (const c of cases) {
    if (seen.has(c.useCaseId)) continue; // one sample per use case, like the mutation suite
    seen.add(c.useCaseId);
    S.linkTree(c.baseline.parse.tree, c.resolved.specNodes);
    const before = new Set(c.baseline.findings.map((f) => `${f.code}@${f.path}`));
    for (const mutation of mutationsFor({ walkTree: S.walkTree, tree: c.baseline.parse.tree, text: c.text, structure: c.structure })) {
      const out = await workbench.analyse(mutation.text, c.structure, c.resolved);
      if (out.parse.failure) continue;
      const fresh = out.findings.filter((f) => (f.severity === "error" || f.severity === "warn") && !before.has(`${f.code}@${f.path}`));
      const named = fresh.filter(
        (f) => mutation.expect.includes(f.code) && (!mutation.mentions || `${f.title} ${f.detail} ${f.actual ?? ""}`.includes(mutation.mentions)),
      );
      const located = named.some((f) =>
        f.location ? Math.abs(f.location.line - mutation.line) <= 2 : Boolean(mutation.names) && `${f.title} ${f.path}`.includes(mutation.names),
      );
      const right = named.length > 0 && located;

      if (!right) {
        if (rescueCalls >= LIMIT) continue;
        rescueCalls++;
        try {
          const { outcome } = await review(c.structure, c.resolved, out);
          const extra = additionalOf(outcome);
          const byLine = extra.some((a) => near(a, mutation.line));
          const byName = Boolean(mutation.names) && extra.some((a) => `${a.claim} ${a.reasoning} ${a.quotes.join(" ")}`.includes(mutation.names));
          rescue.candidates++;
          if (byLine) rescue.byLine++;
          if (byName) rescue.byName++;
          rescue.detail.push(`${c.useCaseId} · ${mutation.kind} · ${mutation.name} (L${mutation.line}) → ${byLine ? "RESCUED by line" : byName ? "named only" : "missed"}`);
          log(`rescue ${c.useCaseId} · ${mutation.name}: ${byLine ? "by line" : byName ? "by name" : "missed"}; ${extra.length} additional, ${outcome.dropped.length} dropped`);
        } catch (err) {
          log(`rescue ${c.useCaseId} · ${mutation.name}: call failed — ${err.message}`);
        }
      } else {
        if (undermineCalls >= LIMIT) continue;
        undermineCalls++;
        try {
          const { outcome } = await review(c.structure, c.resolved, out);
          const namedIds = new Set(named.map((f) => f.id));
          const doubted = outcome.advisories.filter((a) => a.about.findingId && namedIds.has(a.about.findingId) && a.verdict === "doubt");
          undermine.candidates++;
          if (doubted.length) {
            undermine.doubted++;
            undermine.detail.push(`${c.useCaseId} · ${mutation.name}: ${doubted.map((a) => a.claim).join(" | ")}`);
          }
          log(`right  ${c.useCaseId} · ${mutation.name}: ${doubted.length ? "DOUBTED" : "not undermined"}; ${outcome.dropped.length} dropped`);
        } catch (err) {
          log(`right  ${c.useCaseId} · ${mutation.name}: call failed — ${err.message}`);
        }
      }
    }
  }
}

/* -------------------------------------------------------------------------- *
 * Report
 * -------------------------------------------------------------------------- */

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : "n/a");
const rescueRate = rescue.candidates ? rescue.byLine / rescue.candidates : null;
const alarmsPerTen = clean.docs ? (10 * clean.falseAlarms) / clean.docs : null;
const underminingRate = undermine.candidates ? undermine.doubted / undermine.candidates : null;

console.log("");
console.log("eval-ai — advisory layer over the deterministic checker");
console.log("========================================================");
console.log(`rescue (location, ±2 lines)  ${pct(rescue.byLine, rescue.candidates)}  (${rescue.byLine}/${rescue.candidates}; by name ${pct(rescue.byName, rescue.candidates)})`);
console.log(`false alarms on clean docs   ${clean.falseAlarms} over ${clean.docs} docs = ${alarmsPerTen === null ? "n/a" : alarmsPerTen.toFixed(2)} per 10 docs (${clean.additional} additional observations in total)`);
console.log(`undermining                  ${pct(undermine.doubted, undermine.candidates)}  (${undermine.doubted}/${undermine.candidates} correct findings doubted)`);
console.log(`claims dropped by validation ${usage.dropped}`);
console.log("");
console.log(`calls ${usage.calls} · input ${usage.inputTokens} · output ${usage.outputTokens} · cache read ${usage.cacheReadTokens} · cache write ${usage.cacheWriteTokens}`);
console.log(`cost  $${dollars().toFixed(4)} at $${PRICE.input}/$${PRICE.output} per MTok (cache read $${PRICE.cacheRead}, write $${PRICE.cacheWrite})`);
console.log("");

const verdicts = [
  ["rescue-location >= 50%", rescueRate === null ? null : rescueRate >= 0.5],
  ["false alarms <= 1 per 10 clean docs", alarmsPerTen === null ? null : alarmsPerTen <= 1],
  ["undermining <= 5%", underminingRate === null ? null : underminingRate <= 0.05],
];
for (const [label, ok] of verdicts) console.log(`  ${ok === null ? "  n/a " : ok ? "  PASS" : "  FAIL"}  ${label}`);
const measured = verdicts.filter(([, ok]) => ok !== null);
console.log("");
console.log(
  measured.length === 0
    ? "no measurement was taken"
    : measured.every(([, ok]) => ok)
      ? "BETTER: the advisory layer clears every bar it was measured against"
      : "NOT BETTER: at least one bar was missed — see the details below",
);

if (rescue.detail.length) console.log(`\nrescue candidates:\n  ${rescue.detail.join("\n  ")}`);
if (undermine.detail.length) console.log(`\nundermined findings:\n  ${undermine.detail.join("\n  ")}`);
const alarmed = clean.perDoc.filter((d) => d.alarms.length);
if (alarmed.length) console.log(`\nfalse alarms:\n  ${alarmed.map((d) => `${d.file}\n    ${d.alarms.join("\n    ")}`).join("\n  ")}`);
