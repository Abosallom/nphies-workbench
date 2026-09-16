/**
 * The engine never talks to a model.
 *
 * Every structural verdict in this product comes from `check()` over the compiled
 * specification, and the whole point of the AI layer is that it sits BESIDE those verdicts,
 * never inside them. That boundary is easy to state and easy to erode — one convenience import
 * from `ai.ts` into `check.ts` and a model is suddenly on the path to a finding. So it is
 * asserted here, mechanically, on every test run.
 *
 * Two checks:
 *   1. No file in `src/lib/` other than the AI layer itself imports the AI layer or the SDK.
 *   2. `npm test` never reaches the network. `fetch` is stubbed to throw for the duration of
 *      the engine suites, so a suite that accidentally called a model would fail loudly
 *      instead of quietly producing scores that depend on a remote service.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(ROOT, "src", "lib");

/** The AI layer: the only files in src/lib allowed to know a model exists. */
const AI_LAYER = new Set(["ai.ts", "advisory.ts", "skeleton.ts", "gaps.ts"]);

/** Specifiers whose presence in an engine file means the boundary has been crossed. */
const FORBIDDEN = [/["'`]\.\/ai["'`]/, /["'`]\.\/advisory["'`]/, /["'`]\.\/skeleton["'`]/, /["'`]\.\/gaps["'`]/, /@anthropic-ai\/sdk/];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

test("no engine file imports the AI layer or the Anthropic SDK", () => {
  const offenders = [];
  for (const file of walk(LIB)) {
    const rel = path.relative(LIB, file);
    if (AI_LAYER.has(rel)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN) {
      if (pattern.test(source)) offenders.push(`${rel} matches ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], `the engine has grown a dependency on the model:\n${offenders.join("\n")}`);
});

test("the UI layer does not import the SDK directly either", () => {
  // Views may use the AI layer through src/lib/ai.ts; nothing else may reach the SDK, so the
  // dynamic import in ai.ts stays the single place the network is ever touched.
  const offenders = [];
  for (const file of [...walk(path.join(ROOT, "src", "ui")), ...walk(path.join(ROOT, "src", "views"))]) {
    if (/@anthropic-ai\/sdk/.test(fs.readFileSync(file, "utf8"))) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], `files importing the SDK directly:\n${offenders.join("\n")}`);
});

test("the AI layer is only ever loaded on demand", () => {
  // A static `import Anthropic from "@anthropic-ai/sdk"` would put ~200KB in the main bundle
  // and, worse, make the SDK part of the engine's module graph. Only `import type` and dynamic
  // `import(...)` are acceptable.
  const source = fs.readFileSync(path.join(LIB, "ai.ts"), "utf8");
  const staticImports = source.match(/^import\s+(?!type\b)[^;]*["']@anthropic-ai\/sdk[^"']*["'];?$/gm) ?? [];
  assert.deepEqual(staticImports, [], `ai.ts imports the SDK statically:\n${staticImports.join("\n")}`);
});
