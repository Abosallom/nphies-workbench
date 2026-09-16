/**
 * The advisory suite: a model's output can be shown, but it can never become a verdict.
 *
 * Three claims:
 *
 *  1. TYPE-LEVEL — `Advisory` is not a `Finding`. `tests/fixtures/advisory-is-not-a-finding.ts`
 *     hands an Advisory to `summarise()` and `sortFindings()`; tsc must REJECT it. The positive
 *     control `finding-is-a-finding.ts` makes the same calls with a Finding and must compile,
 *     so the failure is provably about the type and not about the tsc invocation.
 *  2. VERIFICATION — `validateAdvisories` drops every claim whose quotes are not verbatim in
 *     the payload, whose rule ids are outside the closed list, whose line the skeleton does
 *     not show, or whose action was not offered — and counts what it dropped.
 *  3. TRANSPORT — `redactFinding` and `payloadPreview` never carry message values; gaps are
 *     enumerated deterministically with CLOSED option lists.
 *
 * Runs under the engine harness, so `fetch` throws: nothing here can reach a model.
 */
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createJiti } from "jiti";
import { loadEngine, readGolden, ROOT } from "./harness.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: true });
const advisory = await jiti.import(path.join(ROOT, "src/lib/advisory.ts"));
const gaps = await jiti.import(path.join(ROOT, "src/lib/gaps.ts"));
const skeletonMod = await jiti.import(path.join(ROOT, "src/lib/skeleton.ts"));
const ai = await jiti.import(path.join(ROOT, "src/lib/ai.ts"));

const { validateAdvisories, stableHash, digestOf, isVerbatim } = advisory;
const { gapsOf, actionsOf } = gaps;
const { buildSkeleton } = skeletonMod;
const { redactFinding, ruleStubsFrom, payloadPreview, payloadParts, estimateTokens } = ai;

/* -------------------------------------------------------------------------- *
 * 1. The type boundary, checked with the compiler
 * -------------------------------------------------------------------------- */

const TSC_FLAGS = [
  "--ignoreConfig", // TS 6 refuses a file list while a tsconfig is present unless told to
  "--noEmit",
  "--strict",
  "--target", "es2023",
  "--lib", "es2023,dom",
  "--module", "esnext",
  "--moduleResolution", "bundler",
  "--skipLibCheck",
  "--types", "vite/client",
  "--allowImportingTsExtensions",
  "--verbatimModuleSyntax",
  "--erasableSyntaxOnly",
];

function tsc(file) {
  const res = spawnSync(process.execPath, [path.join(ROOT, "node_modules/typescript/bin/tsc"), ...TSC_FLAGS, path.join(ROOT, file)], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

test("an Advisory does NOT type-check where a Finding is required", () => {
  const negative = tsc("tests/fixtures/advisory-is-not-a-finding.ts");
  assert.notEqual(negative.status, 0, "the negative fixture compiled: a model's output has become admissible as a Finding");
  assert.match(negative.out, /advisory-is-not-a-finding\.ts/, `errors should be in the fixture itself:\n${negative.out}`);
  // TS2740 "missing the following properties", or the argument/assignment variants.
  assert.match(negative.out, /TS2740|TS2345|TS2322/, `expected a type-mismatch error, got:\n${negative.out}`);
  // Every missing property tsc names is one an Advisory must never gain.
  assert.match(negative.out, /severity|provenance|code|path|location/);
});

test("the positive control compiles, so the negative result is about the type", () => {
  const positive = tsc("tests/fixtures/finding-is-a-finding.ts");
  assert.equal(positive.status, 0, `the control fixture failed to compile:\n${positive.out}`);
});

/* -------------------------------------------------------------------------- *
 * 2. Verification
 * -------------------------------------------------------------------------- */

const PAYLOAD = [
  "Compiled rules:",
  "7766393:1:4 | PID-3 | Patient Identifier List | R | \"PID-3 SHALL carry the Health ID\"",
  "Findings:",
  "required-field-missing#1@ADT^A03/PID/PID-3 | error | required-field-missing | L3",
  "Skeleton:",
  "L1 MSH",
  "L3 PID",
  "L3   PID-3 Patient Identifier List = …^^^…&…&…",
].join("\n");

function sent(extra = {}) {
  return {
    payload: PAYLOAD,
    model: "claude-opus-5",
    digest: "fnv:test",
    ruleIds: new Set(["7766393:1:4"]),
    lines: new Set([1, 3]),
    findingIds: new Set(["required-field-missing#1@ADT^A03/PID/PID-3"]),
    ...extra,
  };
}

const good = {
  kind: "second-opinion",
  about: { findingId: "required-field-missing#1@ADT^A03/PID/PID-3", line: 3 },
  verdict: "agree",
  claim: "PID-3 is required and the skeleton shows it redacted, not absent.",
  reasoning: "The rule quote requires it.",
  modelConfidence: "medium",
  quotes: ["PID-3 SHALL carry the Health ID", "L3   PID-3 Patient Identifier List"],
  ruleIds: ["7766393:1:4"],
};

test("a fully verified claim survives with the batch's drop count stamped on it", () => {
  const { advisories, dropped } = validateAdvisories([good], sent());
  assert.equal(dropped.length, 0);
  assert.equal(advisories.length, 1);
  const a = advisories[0];
  assert.equal(a.source, "model");
  assert.equal(a.model, "claude-opus-5");
  assert.equal(a.inputDigest, "fnv:test");
  assert.equal(a.dropped, 0);
  assert.equal(a.verdict, "agree");
  // The shape that makes it un-Finding-able: none of these keys may ever appear.
  for (const key of ["severity", "provenance", "code", "location", "path", "confidence"]) {
    assert.ok(!(key in a), `an Advisory must not carry "${key}"`);
  }
});

test("a paraphrased quote is dropped", () => {
  const { advisories, dropped } = validateAdvisories([{ ...good, quotes: ["PID-3 shall carry the health id"] }], sent());
  assert.equal(advisories.length, 0);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, "quote-not-verbatim");
});

test("a claim with no quote is dropped", () => {
  const { dropped } = validateAdvisories([{ ...good, quotes: [] }], sent());
  assert.equal(dropped[0]?.reason, "no-quote");
});

test("a rule id outside the closed list is dropped", () => {
  const { dropped } = validateAdvisories([{ ...good, ruleIds: ["7766393:1:99"] }], sent());
  assert.equal(dropped[0]?.reason, "unknown-rule-id");
});

test("a line the skeleton does not show is dropped; null line is fine", () => {
  const { dropped } = validateAdvisories([{ ...good, about: { ...good.about, line: 2 } }], sent());
  assert.equal(dropped[0]?.reason, "line-not-in-skeleton");
  const far = validateAdvisories([{ ...good, about: { ...good.about, line: 9999 } }], sent());
  assert.equal(far.dropped[0]?.reason, "line-not-in-skeleton");
  const none = validateAdvisories([{ ...good, about: { ...good.about, line: null } }], sent());
  assert.equal(none.advisories.length, 1);
});

test("a finding id that was not sent is dropped", () => {
  const { dropped } = validateAdvisories([{ ...good, about: { findingId: "made-up#9@X", line: null } }], sent());
  assert.equal(dropped[0]?.reason, "unknown-finding-id");
});

test("an action must be one the gap offered — the closed list is enforced", () => {
  const proposal = {
    kind: "gap-proposal",
    about: { gapId: "gap:conditional-usage-unresolved:0:f1", line: null },
    claim: "Report",
    reasoning: "The skeleton shows an OBR segment.",
    modelConfidence: "medium",
    quotes: ["L3 PID"],
    ruleIds: [],
    action: { type: "declare-condition", condition: "Report" },
  };
  const offered = new Map([[proposal.about.gapId, [{ type: "declare-condition", condition: "Report" }, { type: "declare-condition", condition: "Order" }]]]);
  const ok = validateAdvisories([proposal], sent({ offeredActions: offered, findingIds: undefined }));
  assert.equal(ok.advisories.length, 1);
  assert.deepEqual(ok.advisories[0].action, { type: "declare-condition", condition: "Report" });

  const invented = validateAdvisories(
    [{ ...proposal, action: { type: "declare-condition", condition: "Whenever convenient" } }],
    sent({ offeredActions: offered, findingIds: undefined }),
  );
  assert.equal(invented.dropped[0]?.reason, "action-not-offered");

  const unknownGap = validateAdvisories([{ ...proposal, about: { gapId: "gap:nope", line: null } }], sent({ offeredActions: offered, findingIds: undefined }));
  assert.equal(unknownGap.dropped[0]?.reason, "unknown-gap-id");

  const strayRule = validateAdvisories(
    [{ ...proposal, action: undefined, ruleIds: ["7766393:1:4"] }],
    sent({ offeredActions: offered, offeredRuleIds: new Map([[proposal.about.gapId, new Set()]]), findingIds: undefined }),
  );
  assert.equal(strayRule.dropped[0]?.reason, "rule-not-offered");
});

test("drops are counted on every surviving sibling", () => {
  const { advisories, dropped } = validateAdvisories(
    [good, { ...good, quotes: ["nope"] }, { ...good, ruleIds: ["x"] }, { ...good, claim: "  " }],
    sent(),
  );
  assert.equal(advisories.length, 1);
  assert.equal(dropped.length, 3);
  assert.equal(advisories[0].dropped, 3);
  assert.deepEqual(
    dropped.map((d) => d.reason).sort(),
    ["empty-claim", "quote-not-verbatim", "unknown-rule-id"],
  );
});

test("verbatim means verbatim, up to newline style", () => {
  assert.ok(isVerbatim("a\r\nb", "a\nb"));
  assert.ok(!isVerbatim("a  b", "a b"));
  assert.ok(!isVerbatim("abc", "   "));
});

test("the digest is deterministic and never uses the clock", async () => {
  assert.equal(stableHash("hello"), stableHash("hello"));
  assert.notEqual(stableHash("hello"), stableHash("hello!"));
  assert.match(stableHash(""), /^[0-9a-f]{16}$/);
  const a = await digestOf(PAYLOAD);
  const b = await digestOf(PAYLOAD);
  assert.equal(a, b);
  assert.match(a, /^(sha256:[0-9a-f]{64}|fnv:[0-9a-f]{16})$/);
  assert.notEqual(a, await digestOf(PAYLOAD + " "));
});

/* -------------------------------------------------------------------------- *
 * 3. Transport: redaction, gaps, preview — over a real sample
 * -------------------------------------------------------------------------- */

const { workbench } = await loadEngine();
const golden = await workbench.loadGoldenIndex();

async function analysed(useCaseId) {
  const structures = await workbench.structuresFor(useCaseId);
  const sample = golden.get(useCaseId)[0];
  const structure = workbench.structureForSample(structures, sample);
  const resolved = await workbench.resolve(useCaseId, structure.variant ?? structure.id);
  const text = readGolden(sample.path);
  const out = await workbench.analyse(text, structure, resolved);
  return { structure, resolved, text, out };
}

const adt = await analysed("adt");
const cda = await analysed("cda-discharge-summary");
const fhir = await analysed("fhir-med-prescribe");

const ADT_PHI = ["30511223344557", "19790528", "TTT", "ربيه", "226785", "0000000000"];
const CDA_PHI = ["ALQAHTANI", "YAHYA", "SAEED A", "2448 Zarga Alyamamah St", "30000999999999", "19761230", "+974.143.47333"];

test("redactFinding strips message values from non-structural findings and keeps structural ones", () => {
  const unknown = cda.out.findings.filter((f) => f.code === "unknown-element");
  assert.ok(unknown.length > 0);
  for (const f of unknown) {
    const r = redactFinding(f);
    assert.ok(!/ = "[^…"]/.test(r.detail), `unknown-element detail still carries a value: ${r.detail}`);
    assert.equal(r.actual, undefined);
    assert.equal(r.line, f.location?.line ?? null);
  }
  const vs = adt.out.findings.find((f) => f.code === "valueset-code-unknown");
  assert.ok(vs, "the ADT sample carries a valueset-code-unknown finding");
  const r = redactFinding(vs);
  assert.equal(r.actual, vs.actual, "a code is a structural value and stays");
  assert.equal(r.quote, vs.provenance.quote);
  const diag = adt.out.findings.find((f) => f.code === "parse-diagnostic" && /"/.test(f.title));
  assert.ok(diag, "the ADT sample carries a parser diagnostic that quotes message text");
  const quoted = redactFinding(diag).title.match(/"[^"]*"/g) ?? [];
  assert.ok(quoted.length > 0 && quoted.every((q) => q === '"…"'), `quoted fragments in a parser message are blanked: ${redactFinding(diag).title}`);
  // A sample-derived rule's "quote" is a fragment of the sample itself; it must not travel.
  const defect = fhir.out.findings.find((f) => f.code === "known-sample-defect");
  assert.ok(defect);
  assert.equal(redactFinding(defect).quote, null);
});

test("gapsOf is deterministic, closed, and finds the checker's own near-miss codes", () => {
  const ctx = { tree: cda.out.parse.tree, structure: cda.structure, specNodes: cda.resolved.specNodes };
  const once = gapsOf(cda.out.findings, ctx);
  const twice = gapsOf(cda.out.findings, ctx);
  assert.deepEqual(once, twice);
  const unknown = once.filter((g) => g.kind === "unknown-element");
  assert.ok(unknown.length > 0);
  for (const g of unknown) {
    assert.match(g.id, /^gap:unknown-element:\d+:unknown-element#/);
    assert.equal(typeof g.facts.name, "string");
    assert.ok(Array.isArray(g.facts.compiledSiblings));
    for (const o of g.options) assert.equal(o.type, "rule");
    for (const phi of CDA_PHI) assert.ok(!JSON.stringify(g).includes(phi), `gap carries ${phi}`);
  }
  const adtGaps = gapsOf(adt.out.findings, { specNodes: adt.resolved.specNodes });
  const vs = adtGaps.filter((g) => g.kind === "valueset-code-unknown");
  assert.equal(vs.length, 2);
  assert.equal(vs[0].facts.code, "2.16.840.1.113883.18.55");
  assert.equal(typeof vs[0].facts.valueSetId, "string");
  for (const o of vs[0].options) assert.equal(o.type, "copy-code");
  assert.deepEqual(actionsOf(vs[0]), vs[0].options.map((o) => ({ type: "copy-code", code: o.code })));
  // Only the undecidable-members caveat is a gap; statements are not questions.
  for (const g of adtGaps.filter((x) => x.kind === "structure-caveat")) assert.match(g.question, /cannot recognise/);
});

test("a conditional-usage gap offers exactly the row's conditions, as a closed list", () => {
  const f = {
    id: "conditional-usage-unresolved#1@ORU^R01/OBX/OBX-5",
    severity: "warn",
    code: "conditional-usage-unresolved",
    title: "Observation Value: conditional usage could not be resolved",
    detail: "Two readings.",
    location: { line: 9, startCol: 0, endCol: 4 },
    specNodeId: "1:1:5",
    path: "ORU^R01/OBX/OBX-5",
    provenance: { pageId: "1", pageTitle: null, row: "5", quote: "M (Report) NP (Order)" },
    confidence: "medium",
    independent: true,
    rules: [
      { usage: "M", condition: "Report", min: 1, max: 1, validator: "error-if-missing", raw: { usage: "M\n(Report)", cardinality: "1" } },
      { usage: "NP", condition: "Order", min: 0, max: 0, validator: "error-if-present", raw: { usage: "NP\n(Order)", cardinality: "0" } },
    ],
  };
  const [g] = gapsOf([f]);
  assert.equal(g.kind, "conditional-usage-unresolved");
  assert.equal(g.findingId, f.id);
  assert.equal(g.line, 9);
  assert.deepEqual(actionsOf(g), [
    { type: "declare-condition", condition: "Report" },
    { type: "declare-condition", condition: "Order" },
  ]);
  assert.deepEqual(g.facts.readings, ["M when Report", "NP when Order"]);
});

test("payloadPreview is the exact text that would be sent, and carries no patient data", () => {
  for (const { c, phi } of [
    { c: adt, phi: ADT_PHI },
    { c: cda, phi: CDA_PHI },
    { c: fhir, phi: ["ALQAHTANI", "YAHYA", "1976-12-30", "30000999999999", "+974.143.2345678", "1234 Guardian St"] },
  ]) {
    const skeleton = buildSkeleton(c.out.parse.tree, c.resolved.specNodes, { findings: c.out.findings });
    const rules = ruleStubsFrom(c.resolved.specNodes);
    const findings = c.out.findings.map(redactFinding);
    const input = { structure: c.structure, findings, skeleton, rules };
    const preview = payloadPreview(input);
    const parts = payloadParts(input);
    assert.equal(preview, parts.text);
    assert.equal(parts.text, `${parts.system}\n\n${parts.rules}\n\n${parts.user}`);
    assert.equal(parts.estimatedTokens, estimateTokens(parts.text));
    for (const p of phi) assert.ok(!preview.includes(p), `${c.structure.id}: payload carries ${JSON.stringify(p)}`);
    assert.ok(!preview.includes(c.text.slice(0, 200)), "the payload must not contain the document");
    // Everything the model is told it may cite is in the payload.
    for (const f of findings) assert.ok(preview.includes(f.id));
    for (const r of rules.slice(0, 20)) assert.ok(preview.includes(r.id));
    assert.match(parts.system, /never the full message|REDACTED structural skeleton/);
    assert.match(parts.system, /only reference rule ids and line numbers/);
    assert.match(parts.system, /quote the fragment/);
    // The rules block is stable across calls — it carries cache_control.
    assert.equal(parts.rules, payloadParts(input).rules);
  }
});

test("a gap payload lists each gap with its closed choices", () => {
  const skeleton = buildSkeleton(adt.out.parse.tree, adt.resolved.specNodes, { findings: adt.out.findings });
  const gapList = gapsOf(adt.out.findings, { specNodes: adt.resolved.specNodes, tree: adt.out.parse.tree, structure: adt.structure });
  assert.ok(gapList.length > 0);
  const preview = payloadPreview({ structure: adt.structure, gaps: gapList, skeleton, rules: ruleStubsFrom(adt.resolved.specNodes) });
  for (const g of gapList) assert.ok(preview.includes(g.id));
  assert.match(preview, /choices: /);
  for (const p of ADT_PHI) assert.ok(!preview.includes(p));
});

test("rule stubs are sorted by id and capped, so the cached block is byte-stable", () => {
  const a = ruleStubsFrom(adt.resolved.specNodes);
  const b = ruleStubsFrom(adt.resolved.specNodes);
  assert.deepEqual(a, b);
  for (let i = 1; i < a.length; i++) assert.ok(a[i - 1].id.localeCompare(a[i].id) <= 0);
  assert.ok(ruleStubsFrom(adt.resolved.specNodes, 5).length <= 5);
  for (const s of a) assert.ok(!s.quote || s.quote.length <= 160);
});
