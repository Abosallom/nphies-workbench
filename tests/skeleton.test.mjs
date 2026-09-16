/**
 * The skeleton suite: what leaves the browser when a model is consulted.
 *
 * The claim under test is the privacy property of `buildSkeleton`: a value survives only when
 * the compiled spec or the underlying standard pins it, so patient data is absent BY
 * CONSTRUCTION. That is asserted empirically here over every official sample — with the
 * actual names, ids, dates, addresses and telecoms read out of the samples themselves — rather
 * than by trusting the rule. A second claim is size: the 89 KB newborn discharge summary is
 * ~24,700 tokens as text and must skeletonise to under the 10k cap, with what was folded
 * recorded rather than hidden.
 *
 * Runs under the engine harness, so `fetch` throws: nothing here can reach a model.
 */
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createJiti } from "jiti";
import { loadEngine, readGolden, goldenExists, ROOT } from "./harness.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: true });
const { buildSkeleton, skeletonWindow, skeletonMentions, estimateTokens, DEFAULT_SKELETON_TOKENS } = await jiti.import(
  path.join(ROOT, "src/lib/skeleton.ts"),
);

const { workbench } = await loadEngine();
const golden = await workbench.loadGoldenIndex();

/** Every official sample, analysed and skeletonised once. */
const cases = [];
for (const [useCaseId, samples] of golden) {
  const structures = await workbench.structuresFor(useCaseId);
  for (const sample of samples) {
    if (!goldenExists(sample.path)) continue;
    const structure = workbench.structureForSample(structures, sample);
    const resolved = await workbench.resolve(useCaseId, structure.variant ?? structure.id);
    const text = readGolden(sample.path);
    const out = await workbench.analyse(text, structure, resolved);
    if (out.parse.failure) continue;
    const skeleton = buildSkeleton(out.parse.tree, resolved.specNodes, { findings: out.findings });
    cases.push({ useCaseId, sample, structure, resolved, text, out, skeleton });
  }
}

/* -------------------------------------------------------------------------- *
 * Patient values, read from the samples themselves
 * -------------------------------------------------------------------------- */

/**
 * Strings that are patient data in the official samples. Read from the files (see
 * `phiIn()`), plus these known ones pinned by hand so a regex regression cannot quietly
 * empty the list: the ADT sample's patient name, health id and date of birth; the CDA
 * discharge summary's patient name, address and health id.
 */
const KNOWN_PHI = [
  // HL7 v2.5.1/ADT/ADT_sample03.txt, PID
  "30511223344557", // PID-3.1 health id
  "19790528", // PID-7 date of birth
  "TTT^Test", // PID-5 name as written
  "ربيه", // PID-6 mother's maiden name
  "226785", // PID-2 patient id
  // CDA/nphies Discharge Summary v4.9beta1.xml, recordTarget
  "ALQAHTANI",
  "YAHYA",
  "SAEED A",
  "2448 Zarga Alyamamah St",
  "30000999999999",
  "19761230",
  "+974.143.47333",
  "1234 Guardian St",
];

/** Values a message carries about a person, extracted by shape. Only strings of 4+ chars. */
function phiIn(text, encoding) {
  const found = new Set();
  const add = (v) => {
    const s = (v ?? "").trim();
    if (s.length >= 4) found.add(s);
  };
  const all = (re, group = 1) => {
    for (const m of text.matchAll(re)) add(m[group]);
  };
  if (encoding === "hl7v2-er7") {
    for (const line of text.split(/\r\n|\r|\n/)) {
      if (!line.startsWith("PID|")) continue;
      const f = line.split("|"); // f[3] = PID-3 … f[n] = PID-n
      const comps = (i) => (f[i] ?? "").split("~").flatMap((r) => r.split("^"));
      add(comps(3)[0]); // health id
      for (const c of comps(5)) add(c); // name
      add(f[6]); // mother's maiden name
      add(f[7]); // date of birth
      for (const c of comps(11)) add(c); // address
      add(comps(13)[0]); // phone
      add(comps(14)[0]);
      add(f[2]); // patient id
      add(comps(19)[0]); // SSN
    }
  } else if (encoding === "fhir-json") {
    all(/"family"\s*:\s*"([^"]+)"/g);
    for (const m of text.matchAll(/"given"\s*:\s*\[([^\]]*)\]/g)) for (const g of m[1].matchAll(/"([^"]+)"/g)) add(g[1]);
    all(/"birthDate"\s*:\s*"([^"]+)"/g);
    for (const m of text.matchAll(/"line"\s*:\s*\[([^\]]*)\]/g)) for (const g of m[1].matchAll(/"([^"]+)"/g)) add(g[1]);
    // Patient identifiers: the value inside a Patient resource's identifier block.
    for (const m of text.matchAll(/"resourceType"\s*:\s*"Patient"[\s\S]{0,600}?"identifier"[\s\S]{0,300}?"value"\s*:\s*"([^"]+)"/g)) add(m[1]);
  } else {
    all(/<family[^>]*>([^<]+)<\/family>/g);
    all(/<given[^>]*>([^<]+)<\/given>/g);
    all(/<streetAddressLine[^>]*>([^<]+)<\/streetAddressLine>/g);
    all(/<birthTime[^>]*value="([^"]+)"/g);
    all(/<telecom[^>]*value="([^"]+)"/g);
    for (const block of text.matchAll(/<patientRole>([\s\S]*?)<\/patientRole>/g)) {
      for (const m of block[1].matchAll(/<id[^>]*extension="([^"]+)"/g)) add(m[1]);
    }
    all(/<guardianPerson>\s*<name>([^<]+)<\/name>/g);
    // XDS: sourcePatientId / sourcePatientInfo slot values, and the patientId external identifier.
    for (const m of text.matchAll(/<rim:Slot name="sourcePatientId">[\s\S]*?<rim:Value>([^<^]+)/g)) add(m[1]);
    for (const m of text.matchAll(/<rim:Slot name="sourcePatientInfo">([\s\S]*?)<\/rim:Slot>/g)) {
      for (const v of m[1].matchAll(/<rim:Value>PID-\d+\|([^<]+)<\/rim:Value>/g)) for (const c of v[1].split(/[\^~|]/)) add(c);
    }
  }
  return [...found];
}

/* -------------------------------------------------------------------------- *
 * Tests
 * -------------------------------------------------------------------------- */

test("every official sample skeletonises", () => {
  assert.ok(cases.length >= 60, `expected at least 60 samples, got ${cases.length}`);
  for (const c of cases) {
    assert.ok(c.skeleton.lines.length > 1, `${c.sample.fileName}: empty skeleton`);
    assert.ok(c.skeleton.text.length > 0);
  }
});

test("no skeleton contains a known patient value from the ADT or CDA samples", () => {
  const leaks = [];
  for (const c of cases) {
    for (const phi of KNOWN_PHI) {
      if (c.skeleton.text.includes(phi)) leaks.push(`${c.sample.fileName}: contains ${JSON.stringify(phi)}`);
    }
  }
  assert.deepEqual(leaks, [], `patient data reached a skeleton:\n${leaks.join("\n")}`);
});

test("no skeleton contains a name, identifier, date of birth, address or telecom read from its own sample", () => {
  const leaks = [];
  let checked = 0;
  for (const c of cases) {
    const values = phiIn(c.text, c.structure.encoding);
    checked += values.length;
    for (const v of values) {
      if (c.skeleton.text.includes(v)) leaks.push(`${c.sample.fileName}: ${JSON.stringify(v)}`);
    }
  }
  assert.ok(checked >= 200, `the extractor found only ${checked} patient values across the samples; it has stopped working`);
  assert.deepEqual(leaks, [], `patient data reached a skeleton:\n${leaks.join("\n")}`);
});

test("the skeleton still shows structural identity — it is a redaction, not a blackout", () => {
  const adt = cases.find((c) => c.useCaseId === "adt");
  assert.ok(adt);
  assert.match(adt.skeleton.text, /MSH-9[^\n]*ADT\^A03/, "MSH-9 (structural) should survive");
  assert.match(adt.skeleton.text, /MSH-12[^\n]*2\.5/, "MSH-12 (structural) should survive");
  assert.match(adt.skeleton.text, /PID-5[^\n]*…/, "PID-5 (data) should be redacted, not omitted");
  const cda = cases.find((c) => c.structure.id === "cda-discharge-summary");
  assert.ok(cda);
  assert.match(cda.skeleton.text, /templateId @root="2\.16\.840\.1\.113883\.3\.3731\.1\.210\.2"/, "the document templateId should survive");
  assert.match(cda.skeleton.text, /@classCode=/, "RIM structural attributes should survive");
  const fhir = cases.find((c) => c.structure.id === "fhir-med-prescribe");
  assert.ok(fhir);
  assert.match(fhir.skeleton.text, /resourceType = "Bundle"/);
  assert.match(fhir.skeleton.text, /resourceType = "Patient"/);
  assert.match(fhir.skeleton.text, /family = "…"/, "the patient name key appears, its value does not");
  assert.match(fhir.skeleton.text, /birthDate = "…"/);
});

test("every line number the skeleton cites is within the source", () => {
  for (const c of cases) {
    const total = c.skeleton.sourceLines;
    assert.equal(total, c.text.split(/\r\n|\r|\n/).length, `${c.sample.fileName}: sourceLines`);
    for (const l of c.skeleton.lines) {
      if (l.line !== null) assert.ok(l.line >= 1 && l.line <= total, `${c.sample.fileName}: L${l.line} of ${total}`);
      if (l.span) {
        assert.ok(l.span.from >= 1 && l.span.to <= total && l.span.from <= l.span.to, `${c.sample.fileName}: span ${JSON.stringify(l.span)}`);
      }
      const cited = /^L(\d+) /.exec(l.text);
      if (cited) assert.equal(Number(cited[1]), l.line, `${c.sample.fileName}: rendered line prefix disagrees with the record`);
    }
    for (const n of c.skeleton.mentionedLines) assert.ok(n >= 1 && n <= total);
    for (const e of c.skeleton.elided) assert.ok(e.from >= 1 && e.to <= total, `${c.sample.fileName}: elision ${JSON.stringify(e)}`);
  }
});

test("the token estimate stays under the cap, including for the 89 KB CDA", () => {
  for (const c of cases) {
    assert.equal(c.skeleton.estimatedTokens, estimateTokens(c.skeleton.text));
    assert.equal(estimateTokens(c.skeleton.text), Math.ceil(c.skeleton.text.length / 3.6));
    assert.ok(
      c.skeleton.estimatedTokens <= DEFAULT_SKELETON_TOKENS,
      `${c.sample.fileName}: ${c.skeleton.estimatedTokens} tokens exceeds the ${DEFAULT_SKELETON_TOKENS} cap`,
    );
  }
  // The two CDA discharge summaries over 80 KB. (The 83 KB radiology PDF sample is mostly
  // base64 inside one element, so it needs no folding and is not a test of the fold.)
  const big = cases.filter((c) => c.structure.id === "cda-maternal-discharge" || c.structure.id === "cda-newborn-discharge");
  assert.equal(big.length, 2, "expected the maternal and newborn discharge summaries");
  for (const c of big) {
    assert.ok(estimateTokens(c.text) > 20_000, `${c.sample.fileName} as text should be >20k tokens (measured ~24.7k)`);
    assert.ok(c.skeleton.estimatedTokens <= DEFAULT_SKELETON_TOKENS);
    assert.ok(c.skeleton.elided.length > 0, `${c.sample.fileName}: folding was needed to fit and must be recorded`);
    assert.ok(c.skeleton.lines.length > 50, `${c.sample.fileName}: too little structure survived (${c.skeleton.lines.length} lines)`);
  }
});

test("folding keeps finding lines visible and records what it hid", () => {
  for (const c of cases) {
    for (const f of c.out.findings) {
      if (!f.location) continue;
      assert.ok(skeletonMentions(c.skeleton, f.location.line), `${c.sample.fileName}: finding ${f.id} at L${f.location.line} is not mentioned`);
    }
    for (const e of c.skeleton.elided) {
      assert.match(e.reason, /finding-free|token cap/);
      assert.ok(e.count >= 1);
    }
  }
});

test("skeletonWindow returns the redacted lines around a finding", () => {
  const cda = cases.find((c) => c.structure.id === "cda-discharge-summary");
  const located = cda.out.findings.filter((f) => f.location);
  assert.ok(located.length > 0);
  for (const f of located) {
    const win = skeletonWindow(cda.skeleton, f.location.line, 2);
    assert.ok(win.length > 0, `empty window at L${f.location.line}`);
    for (const phi of KNOWN_PHI) assert.ok(!win.includes(phi));
    // Every line in the window is one of the skeleton's own lines, never raw text.
    for (const line of win.split("\n")) assert.ok(cda.skeleton.text.includes(line));
  }
  assert.equal(skeletonWindow(cda.skeleton, 10_000_000, 2), "");
});

test("a smaller cap folds more and never breaks the range invariant", () => {
  const cda = cases.find((c) => c.structure.id === "cda-newborn-discharge");
  const tight = buildSkeleton(cda.out.parse.tree, cda.resolved.specNodes, { findings: cda.out.findings, maxTokens: 2000 });
  assert.ok(tight.estimatedTokens <= 2000, `tight skeleton is ${tight.estimatedTokens} tokens`);
  assert.ok(tight.elided.length >= cda.skeleton.elided.length);
  for (const l of tight.lines) if (l.line !== null) assert.ok(l.line >= 1 && l.line <= tight.sourceLines);
});

test("sizes, for the record", () => {
  const rows = cases
    .filter((c) => c.text.length > 40_000 || c.useCaseId === "adt")
    .map((c) => `    ${c.sample.fileName}: text ~${estimateTokens(c.text)} tok → skeleton ${c.skeleton.estimatedTokens} tok, ${c.skeleton.lines.length} lines, ${c.skeleton.elided.length} folds, kept ${c.skeleton.kept} / redacted ${c.skeleton.redacted}`);
  console.log(rows.join("\n"));
});
