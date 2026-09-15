/**
 * The golden-sample suite: what the workbench must be able to say about the OFFICIAL NPHIES
 * messages themselves.
 *
 * Three claims, each of which would be a product defect if it broke:
 *
 *  1. Every official sample parses against its own compiled structure.
 *  2. Parse and emit are exact inverses — re-emitting a parsed sample reproduces it BYTE FOR
 *     BYTE. This is the central technical bet: Build and Check run on one shared structure
 *     tree, so if the two directions ever disagree the round trip is where it shows.
 *  3. Checking an official message produces no error the workbench cannot account for. An
 *     error on a reference message is either a real defect in that message (NPHIES published
 *     five broken ones, catalogued) or a false positive — and a false positive here is the
 *     failure mode that makes the whole tool untrustworthy.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadEngine, readGolden, goldenExists } from "./harness.mjs";

const { workbench, structure: S } = await loadEngine();
const golden = await workbench.loadGoldenIndex();

/** Every official sample, already paired with the structure variant it belongs to. */
const cases = [];
for (const [useCaseId, samples] of golden) {
  const structures = await workbench.structuresFor(useCaseId);
  for (const sample of samples) {
    if (!goldenExists(sample.path)) continue;
    const structure = workbench.structureForSample(structures, sample);
    assert.ok(structure, `no structure resolves for ${sample.fileName} (tags: ${sample.variantTags.join(", ")})`);
    const resolved = await workbench.resolve(useCaseId, structure.variant ?? structure.id);
    assert.ok(resolved, `use case ${useCaseId} does not resolve`);
    cases.push({ useCaseId, sample, structure, resolved, text: readGolden(sample.path) });
  }
}

test("the official samples are present and each resolves to one structure", () => {
  assert.ok(cases.length >= 60, `expected at least 60 official samples, found ${cases.length}`);
});

test("every official sample parses against its compiled structure", async () => {
  const failures = [];
  for (const c of cases) {
    const parse = await workbench.parseMessage(c.text, c.structure, c.resolved);
    if (parse.failure) failures.push(`${c.sample.fileName}: ${parse.failure}`);
  }
  assert.deepEqual(failures, [], `samples the parser could not read:\n${failures.join("\n")}`);
});

test("parse and emit are exact inverses over every official sample", async () => {
  const failures = [];
  for (const c of cases) {
    const parse = await workbench.parseMessage(c.text, c.structure, c.resolved);
    if (parse.failure) continue;
    let out;
    try {
      out = workbench.emitMessage(parse.tree, c.structure, parse);
    } catch (err) {
      failures.push(`${c.sample.fileName}: emit threw ${err.message}`);
      continue;
    }
    if (out === c.text) continue;
    let i = 0;
    while (i < Math.min(out.length, c.text.length) && out[i] === c.text[i]) i++;
    failures.push(
      `${c.sample.fileName}: first difference at offset ${i} — expected ${JSON.stringify(
        c.text.slice(i, i + 40),
      )}, emitted ${JSON.stringify(out.slice(i, i + 40))}`,
    );
  }
  assert.deepEqual(failures, [], `samples that did not round-trip byte for byte:\n${failures.join("\n")}`);
});

/**
 * Error classes an official message may legitimately produce.
 *
 * `known-sample-defect` and `parse-diagnostic` are the workbench recognising a published
 * sample that is genuinely broken; `quarantined-oid` is it recognising sample placeholder
 * identifiers, which is exactly what should happen when one is pasted into Check.
 * `required-field-missing` is allowed ONLY on the radiology-report bundles, where the
 * published rule and the published sample contradict each other — see the assertion below,
 * which pins that to the two known cases so a new one cannot slip in unnoticed.
 */
const EXPECTED_ERROR_CODES = new Set([
  "known-sample-defect",
  "parse-diagnostic",
  "quarantined-oid",
  "required-field-missing",
]);

test("checking an official sample produces no unaccounted-for error", async () => {
  const unexpected = [];
  const specVsSample = [];
  for (const c of cases) {
    const out = await workbench.analyse(c.text, c.structure, c.resolved);
    for (const f of out.findings) {
      if (f.severity !== "error") continue;
      if (!EXPECTED_ERROR_CODES.has(f.code)) {
        unexpected.push(`${c.sample.fileName}: [${f.code}] ${f.title}`);
      } else if (f.code === "required-field-missing") {
        // Counted per RULE, not per sample: two samples of the same structure hitting the
        // same contradiction is one contradiction.
        const key = `${c.structure.id}: ${f.title}`;
        if (!specVsSample.includes(key)) specVsSample.push(key);
      }
    }
  }
  assert.deepEqual(unexpected, [], `errors on official messages that are not accounted for:\n${unexpected.join("\n")}`);
  // Where a published RULE contradicts a published SAMPLE, the workbench reports it rather
  // than quietly siding with one. That inventory is pinned here: it is small, each entry has
  // been read, and a new one must fail this test rather than pass as "expected noise".
  assert.deepEqual(
    specVsSample.sort(),
    [
      // The NoInfo rendering of the immunization card exists precisely to say the patient has
      // no immunization record, yet the compiled section rule marks the section required.
      "cda-immunization-card-noinfo: Immunization Recommendations is required but missing",
      // The published radiology-report bundles require entries their own official samples do
      // not carry — the PDF sample is named "NoImages" and carries no ImagingStudy, and the
      // structured sample carries no DiagnosticReport at all.
      "fhir-rad-report-embedded-pdf: Bundle entry(s) for Imaging Study is required but missing",
      "fhir-rad-report-structured: Bundle entry for Diagnostic Report is required but missing",
    ].sort(),
    "the set of places where the published rules contradict the published samples has changed",
  );
});

test("the adapters turn every parsed sample into a renderable model", async () => {
  const { adaptMessage } = (await loadEngine()).adapt;
  for (const c of cases) {
    const out = await workbench.analyse(c.text, c.structure, c.resolved);
    if (out.parse.failure) continue;
    const model = adaptMessage(out.parse.tree, out.findings);
    assert.ok(model.nodeCount > 0, `${c.sample.fileName} produced an empty tree`);
    assert.ok(model.tree.length > 0, `${c.sample.fileName} produced no structure rows`);
    for (const region of model.regions) {
      assert.ok(region.line >= 1, `${c.sample.fileName}: region on line ${region.line}`);
      assert.ok(region.endCol >= region.startCol, `${c.sample.fileName}: inverted region ${region.id}`);
    }
    // Every finding that points at a region must point at one that exists.
    const ids = new Set(model.regions.map((r) => r.id));
    for (const f of model.findings) {
      if (f.regionId) assert.ok(ids.has(f.regionId), `${c.sample.fileName}: finding ${f.id} cites a missing region`);
    }
  }
});

void S;
