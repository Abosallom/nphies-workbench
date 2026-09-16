/**
 * The detection suite: can the workbench tell which compiled structure a message claims to be,
 * from the message alone, and does it say so HONESTLY?
 *
 * Four claims, each of which would be a product defect if it broke:
 *
 *  1. Every official sample detects its own use case as the top candidate, and — outside a
 *     pinned list of three samples the official corpus itself makes ambiguous — its own
 *     structure, alone, with the outcome `identified`.
 *  2. Every piece of evidence is the message's own text: the fragment sits at the offset the
 *     candidate cites. An analyst must be able to check the claim; a fragment that is not in
 *     the message is a fabricated one.
 *  3. Where fingerprints collide (the four ACK structures, the two LOINC codes shared across
 *     use cases, the medication bundle profile shared by the uncontrolled and Raqeeb flows,
 *     the radiology Composition profile the official structured sample gets wrong) every
 *     sharer comes back, ranked, with the reason it could not be separated. Never the first.
 *  4. Nonsense produces no candidate and a stated reason, not a guess.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { loadEngine, readGolden, goldenExists, ROOT } from "./harness.mjs";

const { workbench, structure: S } = await loadEngine();
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: true });
const { detect } = await jiti.import(path.join(ROOT, "src/lib/detect.ts"));

// The pure form, fed the bundles the harness already loaded, so this suite does not depend on
// a second module instance sharing the harness's spec resolver.
const inputs = { manifest: await S.loadManifest(), structures: await S.loadStructures() };
const run = (text) => detect(text, inputs);

const golden = await workbench.loadGoldenIndex();

/** Every official sample, paired with the structure the manifest says it belongs to. */
const cases = [];
for (const [useCaseId, samples] of golden) {
  const structures = await workbench.structuresFor(useCaseId);
  for (const sample of samples) {
    if (!goldenExists(sample.path)) continue;
    const structure = workbench.structureForSample(structures, sample);
    assert.ok(structure, `no structure resolves for ${sample.fileName}`);
    cases.push({ useCaseId, sample, structure, text: readGolden(sample.path) });
  }
}

/**
 * Official samples the detector must NOT claim to identify alone, because the official corpus
 * itself leaves them ambiguous. Each has been read; each is a statement about the samples and
 * the pages, not about the detector. A new entry must fail the suite rather than be added
 * quietly — the number of messages the workbench cannot settle is a fact to be watched.
 */
const KNOWN_AMBIGUOUS = new Map([
  // The uncontrolled and Raqeeb dispense pages pin the SAME Bundle.meta.profile and the same
  // eight fixed values; only a Raqeeb dispense carries anything (the SecureCode tag extension)
  // that names its flow. An uncontrolled dispense is therefore identified by absence alone,
  // which is not identification.
  ["MedicationDispenseBundle-UncontrolledMed_22052025.json", /pinned by both the uncontrolled and the Raqeeb structure/],
  ["MedicationDispenseBundle_Compound-UncontrolledMed_22052025.json", /pinned by both the uncontrolled and the Raqeeb structure/],
  // The official STRUCTURED radiology report carries the Embedded-PDF Composition profile over
  // structured-only entries (Procedure, Binary). The compiler recorded it as
  // rad-report-structured-composition-profile; the two witnesses disagree.
  ["RadiologyReportBundle_AuthorPerson_Structured_2xServiceRequests_2xProcedures_2xImagingStudies_09022026.json", /two witnesses disagree/],
]);

/** Every fragment a candidate cites must sit in the message at the offset it cites. */
function assertEvidenceIsVerbatim(text, result, label) {
  for (const c of result.candidates) {
    assert.ok(c.evidence.length > 0, `${label}: candidate ${c.structureId} carries no evidence`);
    for (const e of c.evidence) {
      assert.equal(
        text.slice(e.offset, e.offset + e.fragment.length),
        e.fragment,
        `${label}: ${c.structureId} cites ${JSON.stringify(e.fragment)} at offset ${e.offset}, which is not what the message holds there`,
      );
      assert.ok(e.line >= 1, `${label}: evidence line ${e.line}`);
      assert.ok(e.expected.length > 0, `${label}: evidence with an empty expectation`);
    }
  }
}

test("the official samples are present", () => {
  assert.ok(cases.length >= 60, `expected at least 60 official samples, found ${cases.length}`);
  for (const name of KNOWN_AMBIGUOUS.keys()) {
    assert.ok(cases.some((c) => c.sample.fileName === name), `the pinned ambiguous sample ${name} is no longer in the corpus`);
  }
});

test("every official sample detects its own use case as the top candidate", () => {
  const failures = [];
  for (const c of cases) {
    const r = run(c.text);
    const top = r.candidates[0];
    if (!top) failures.push(`${c.sample.fileName}: no candidate — ${r.reason}`);
    else if (top.useCaseId !== c.useCaseId) {
      failures.push(`${c.sample.fileName}: top candidate is ${top.structureId} (${top.useCaseId}), sample belongs to ${c.useCaseId}`);
    }
  }
  assert.deepEqual(failures, [], `samples whose use case was not the top candidate:\n${failures.join("\n")}`);
});

test("outside the pinned ambiguities, every official sample is identified as its own structure, alone", () => {
  const failures = [];
  let identifiedAlone = 0;
  for (const c of cases) {
    if (KNOWN_AMBIGUOUS.has(c.sample.fileName)) continue;
    const r = run(c.text);
    const top = r.candidates[0];
    if (r.outcome !== "identified") {
      failures.push(
        `${c.sample.fileName}: outcome ${r.outcome} [${r.candidates.map((x) => `${x.structureId}:${x.grade}`).join(", ")}]${r.reason ? ` — ${r.reason}` : ""}`,
      );
      continue;
    }
    if (top.structureId !== c.structure.id) {
      failures.push(`${c.sample.fileName}: identified as ${top.structureId}, sample is ${c.structure.id}`);
      continue;
    }
    identifiedAlone++;
  }
  assert.deepEqual(failures, [], `samples not identified as their own structure:\n${failures.join("\n")}`);
  assert.equal(identifiedAlone, cases.length - KNOWN_AMBIGUOUS.size);
});

test("the pinned ambiguities come back as ambiguities, the sample's own structure first, with the reason", () => {
  for (const [name, reason] of KNOWN_AMBIGUOUS) {
    const c = cases.find((x) => x.sample.fileName === name);
    const r = run(c.text);
    assert.equal(r.outcome, "ambiguous", `${name}: expected ambiguous, got ${r.outcome} [${r.candidates.map((x) => x.structureId).join(", ")}]`);
    assert.ok(r.candidates.length >= 2, `${name}: an ambiguity with one candidate`);
    assert.equal(r.candidates[0].structureId, c.structure.id, `${name}: the sample's own structure is not ranked first`);
    assert.equal(r.candidates[0].grade, r.candidates[1].grade, `${name}: the top two candidates do not share a grade`);
    for (const cand of r.candidates) {
      assert.ok(cand.caveats.some((k) => reason.test(k)), `${name}: ${cand.structureId} does not state why it is ambiguous (${reason})`);
    }
  }
});

test("every fragment of evidence is the message's own text at the cited offset", () => {
  for (const c of cases) assertEvidenceIsVerbatim(c.text, run(c.text), c.sample.fileName);
});

/*
 * `certain` means an identifier the SPEC pins matched verbatim. A candidate whose evidence
 * rests only on a value read off an official sample (a document templateId no page states)
 * or on an HL7 table (MSA-1) has not earned it.
 */
test("no candidate is `certain` without spec-basis evidence", () => {
  const failures = [];
  for (const c of cases) {
    for (const cand of run(c.text).candidates) {
      if (cand.grade === "certain" && !cand.evidence.some((e) => e.basis === "spec")) {
        failures.push(`${c.sample.fileName}: ${cand.structureId} is certain on ${cand.evidence.map((e) => e.basis).join("/")} evidence only`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

/* ------------------------------------------------------------------------ *
 * Collisions
 * ------------------------------------------------------------------------ */

const CR = "\r";
const ack = (msh9, ...rest) =>
  [`MSH|^~\\&|NPHIES|NPHIES|HIS|HOSP|20240101120000||${msh9}|MSG0001|P|2.5.1`, ...rest].join(CR) + CR;

test("an ACK without a trigger event is not tied to ADT or ORU; both acknowledgments come back", () => {
  const r = run(ack("ACK", "MSA|AA|MSG0000"));
  assert.equal(r.outcome, "ambiguous");
  assert.deepEqual(r.candidates.map((c) => c.structureId).sort(), ["adt-ack", "oru-ack"]);
  for (const c of r.candidates) {
    assert.equal(c.grade, "possible");
    assert.ok(c.caveats.some((k) => /cannot be tied to ADT or ORU/.test(k)), `${c.structureId}: ${c.caveats}`);
    assert.ok(c.evidence.some((e) => /MSA-1/.test(e.field) && e.fragment === "AA"), "MSA-1 is cited as evidence");
  }
});

test("an ACK with neither trigger nor MSA returns all four acknowledgment structures", () => {
  const r = run(ack("ACK"));
  assert.equal(r.outcome, "ambiguous");
  assert.deepEqual(r.candidates.map((c) => c.structureId).sort(), ["adt-ack", "adt-nack", "oru-ack", "oru-nack"]);
  for (const c of r.candidates) assert.ok(c.caveats.some((k) => /No MSA segment/.test(k)));
});

test("MSH-9.2 and MSA-1 together settle the ACK cluster, at `probable`", () => {
  const positive = run(ack("ACK^A01", "MSA|AA|MSG0000"));
  assert.equal(positive.outcome, "identified");
  assert.equal(positive.candidates[0].structureId, "adt-ack");
  assert.equal(positive.candidates[0].grade, "probable");

  const negative = run(ack("ACK^A01", "MSA|AE|MSG0000", "ERR||MSH^1^9|100|E"));
  assert.equal(negative.outcome, "identified");
  assert.equal(negative.candidates[0].structureId, "adt-nack");
  assert.ok(negative.candidates[0].evidence.some((e) => /ERR segment/.test(e.field)), "the ERR segment is cited");

  const oru = run(ack("ACK^R01", "MSA|AR|MSG0000"));
  assert.equal(oru.outcome, "identified");
  assert.equal(oru.candidates[0].structureId, "oru-nack");

  // MSA-1 accepts but an ERR segment is present: both shapes are kept rather than one guessed.
  const contradictory = run(ack("ACK^A01", "MSA|AA|MSG0000", "ERR||MSH^1^9|100|E"));
  assert.deepEqual(contradictory.candidates.map((c) => c.structureId).sort(), ["adt-ack", "adt-nack"]);
});

test("a trigger-bearing HL7 v2 type is unique and `certain`", () => {
  const r = run(ack("ADT^A45^ADT_A45", "EVN|A45|20240101120000"));
  assert.equal(r.outcome, "identified");
  assert.equal(r.candidates[0].structureId, "adt-a45");
  assert.equal(r.candidates[0].grade, "certain");
  assert.equal(r.candidates[0].evidence[0].fragment, "ADT^A45^ADT_A45");
});

/** A CDA sample with its document-level templateId removed, so only the LOINC code remains. */
const withoutDocTemplateId = (rel) => {
  const text = readGolden(rel);
  const stripped = text.replace(/<templateId root="2\.16\.840\.1\.113883\.3\.3731\.1\.(?:210\.\d+|105\.1|204\.\d+)"\/>/, "");
  assert.notEqual(stripped, text, `${rel}: no document templateId to strip`);
  return stripped;
};

test("LOINC 11369-6 without a document templateId returns immunization card AND summary", () => {
  const text = withoutDocTemplateId("golden/CDA/On-demand documents as response/nphies Immunization Card v4.9beta1 Full.xml");
  const r = run(text);
  assert.equal(r.outcome, "ambiguous");
  const ids = r.candidates.map((c) => c.structureId);
  assert.ok(ids.includes("cda-immunization-card-full"), ids.join(", "));
  assert.ok(ids.includes("cda-immunization-summary-full"), ids.join(", "));
  assert.ok(new Set(r.candidates.map((c) => c.useCaseId)).size === 2, "both use cases are named");
  for (const c of r.candidates) {
    assert.equal(c.grade, "possible");
    assert.ok(c.caveats.some((k) => /shared by/.test(k) && /11369-6/.test(k)), c.caveats.join(" | "));
  }
  assertEvidenceIsVerbatim(text, r, "11369-6 collision");
});

test("LOINC 11369-6 is settled by a section templateId only one document type compiles, and the loser stays listed", () => {
  const text = withoutDocTemplateId("golden/CDA/On-demand documents as response/nphies Immunization Summary v4.9beta1 NoInfo.xml");
  const r = run(text);
  assert.equal(r.outcome, "identified");
  assert.equal(r.candidates[0].structureId, "cda-immunization-summary-noinfo");
  assert.equal(r.candidates[0].grade, "probable");
  assert.ok(r.candidates[0].evidence.some((e) => /section\/templateId/.test(e.field)), "a section templateId is cited");
  assert.ok(r.candidates.some((c) => c.useCaseId === "cda-immunization-card"), "the immunization card is still returned, ranked below");
  assertEvidenceIsVerbatim(text, r, "11369-6 settled");
});

test("LOINC 57832-8 without a document templateId returns lab order AND radiology order, ranked by section templateIds", () => {
  for (const [rel, winner, loser] of [
    ["golden/CDA/nphies Laboratory Order v4.9beta1.xml", "cda-lab-order", "cda-rad-order"],
    ["golden/CDA/nphies Radiology Order v4.9beta1.xml", "cda-rad-order", "cda-lab-order"],
  ]) {
    const text = withoutDocTemplateId(rel);
    const r = run(text);
    const ids = r.candidates.map((c) => c.structureId);
    assert.deepEqual(ids, [winner, loser], `${rel}: ${ids.join(", ")}`);
    assert.equal(r.candidates[0].grade, "probable");
    assert.equal(r.candidates[1].grade, "possible");
    assert.ok(r.candidates[1].caveats.some((k) => /57832-8/.test(k) && /shared by/.test(k)));
    assertEvidenceIsVerbatim(text, r, rel);
  }
});

test("the CDA Full / NoInfo variants are settled by the NoInfo section templateIds, and Full is `probable` by absence", () => {
  const full = run(readGolden("golden/CDA/On-demand documents as response/nphies iEHR Summary v4.9beta1 Full.xml"));
  assert.equal(full.candidates[0].structureId, "cda-iehr-summary-full");
  assert.equal(full.candidates[0].grade, "probable");
  assert.ok(full.candidates[0].caveats.some((k) => /none of the \d+ sections carries a templateId compiled only for NoInfo/.test(k)));

  const noInfo = run(readGolden("golden/CDA/On-demand documents as response/nphies iEHR Summary v4.9beta1 NoInfo.xml"));
  assert.equal(noInfo.candidates[0].structureId, "cda-iehr-summary-noinfo");
  assert.equal(noInfo.candidates[0].grade, "certain");
  assert.ok(noInfo.candidates[0].evidence.filter((e) => /compiled only for this variant/.test(e.field)).length >= 1);
});

test("the CDA radiology result variants are settled by body kind, and the body tag is cited", () => {
  const pdf = run(readGolden("golden/CDA/nphies Radiology Results Embedded PDF v4.9beta1.xml"));
  assert.equal(pdf.candidates[0].structureId, "cda-rad-result-embedded-pdf");
  assert.ok(pdf.candidates[0].evidence.some((e) => e.fragment === "<nonXMLBody>"));
  const structured = run(readGolden("golden/CDA/nphies Radiology Results Structured v4.9beta1.xml"));
  assert.equal(structured.candidates[0].structureId, "cda-rad-result-structured");
  assert.ok(structured.candidates[0].evidence.some((e) => e.fragment === "<structuredBody>"));
});

test("the shared medication bundle profile returns both flows, ranked by the sample-derived marker", () => {
  const raqeebDispense = run(
    readGolden("golden/FHIR/Raqeeb (Controlled,Narcotic & Restricted Meds)/MedicationDispenseBundle_Raqeeb_NormalDosing_CodeAuthenticated_18052025.json"),
  );
  assert.deepEqual(
    raqeebDispense.candidates.map((c) => `${c.structureId}:${c.grade}`),
    ["fhir-med-raqeeb-dispense:probable", "fhir-med-dispense:possible"],
  );
  assert.ok(raqeebDispense.candidates[0].evidence.some((e) => /SecureCode/.test(e.field)));
  // The dispense bundles' profile is the wire value the samples send, not the one the page pins,
  // and the candidate says so rather than matching silently.
  assert.ok(raqeebDispense.candidates[0].evidence.some((e) => e.basis === "sample" && /medicationdispensed/.test(e.fragment)));
  assert.ok(raqeebDispense.candidates[0].caveats.some((k) => /bundleDispense\|1\.0/.test(k) && /medicationdispensed\|1\.0/.test(k)));

  const uncontrolled = run(readGolden("golden/FHIR/Nphies (Uncontrolled Meds)/MedicationRequestBundle_NarrativeDosing-UncontrolledMed_22052025.json"));
  assert.deepEqual(
    uncontrolled.candidates.map((c) => `${c.structureId}:${c.grade}`),
    ["fhir-med-prescribe:probable", "fhir-med-raqeeb-prescribe:possible"],
  );
  assert.ok(uncontrolled.candidates[0].evidence.some((e) => e.basis === "sample" && e.fragment === '"U"'));
});

test("a malformed official sample is still named from its raw text, at no better than `probable`, and says so", () => {
  const r = run(readGolden("golden/FHIR/Raqeeb (Controlled,Narcotic & Restricted Meds)/MedicationRequestBundle_Raqeeb_SplitDosing_19052025.json"));
  assert.equal(r.candidates[0].structureId, "fhir-med-raqeeb-prescribe");
  for (const c of r.candidates) {
    assert.notEqual(c.grade, "certain");
    assert.ok(c.caveats.some((k) => /does not parse/.test(k) && /line 598/.test(k)), c.caveats.join(" | "));
  }
});

/* ------------------------------------------------------------------------ *
 * No match
 * ------------------------------------------------------------------------ */

test("nonsense yields no candidate and a reason", () => {
  for (const [text, reason] of [
    ["hello world, this is not a message at all", /no format the workbench knows/],
    ["   ", /empty/],
    ['{"resourceType":"Patient","id":"x"}', /resourceType is "Patient"/],
    ['{"resourceType":"Bundle","type":"message","entry":[]}', /Bundle\.meta\.profile is absent/],
    ["{ this is not json", /does not parse/],
    [ack("SIU^S12"), /"SIU\^S12", which none of the \d+ compiled HL7 v2 structures declares/],
    ['<?xml version="1.0"?><foo><bar/></foo>', /not ClinicalDocument/],
    ['<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Header/><s:Body/></s:Envelope>', /no WS-Addressing Action/],
    [
      '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing"><s:Header><a:Action>urn:example:nothing</a:Action></s:Header><s:Body/></s:Envelope>',
      /"urn:example:nothing", which none of the \d+ compiled SOAP structures declares/,
    ],
  ]) {
    const r = run(text);
    assert.equal(r.outcome, "none", `${JSON.stringify(text.slice(0, 40))}: ${r.outcome} [${r.candidates.map((c) => c.structureId).join(", ")}]`);
    assert.deepEqual(r.candidates, []);
    assert.match(r.reason, reason);
  }
});
