/**
 * HIS spreadsheet ingest: what the Build-from-extract path must be able to promise.
 *
 *  1. A CSV and a workbook of the same cells produce the same columns and rows, and the
 *     7 MB `xlsx` package is never loaded until a workbook is actually read.
 *  2. Name matching is deterministic: same headers, same mapping, every time; a header that
 *     names two positions is left unmapped rather than guessed; a model's proposal can only
 *     ever enter as unconfirmed.
 *  3. Filling an official sample changes exactly the mapped values and nothing else — the
 *     result parses against the same structure with no more findings than the template —
 *     and every position that could not be written is listed with a reason.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { loadEngine, readGolden, ROOT } from "./harness.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: true });
const { workbench, structure: S } = await loadEngine();
const { buildProfile } = await jiti.import(path.join(ROOT, "src/lib/profile.ts"));
const ingest = await jiti.import(path.join(ROOT, "src/lib/ingest.ts"));

/** The A01 official sample and everything needed to parse, check and profile it. */
async function adtA01() {
  const samples = (await workbench.loadGoldenIndex()).get("adt");
  const sample = samples.find((s) => s.variantTags.includes("A01"));
  assert.ok(sample, "the ADT use case has no A01 official sample");
  const structure = workbench.structureForSample(await workbench.structuresFor("adt"), sample);
  const resolved = await workbench.resolve("adt", structure.variant ?? structure.id);
  return { structure, resolved, text: readGolden(sample.path), profile: buildProfile(structure, resolved.tables) };
}

/* ------------------------------------------------------------------ reading */

const CSV = [
  "Patient Health ID,MRN,Name,Note",
  '30511223344557,226785,"Doe, Jane","She said ""hi"""',
  "",
  '30511223344558,226786,"Roe, John","multi',
  'line"',
  ",226787,,",
].join("\r\n");

test("readCsv handles quoting, embedded delimiters and newlines, blank lines and CRLF", () => {
  const sheet = ingest.readCsv(CSV);
  assert.deepEqual(
    sheet.columns.map((c) => c.name),
    ["Patient Health ID", "MRN", "Name", "Note"],
  );
  assert.equal(sheet.rows.length, 3, "the blank line is not a row; the row with only an MRN is");
  assert.deepEqual(sheet.rows[0], {
    "Patient Health ID": "30511223344557",
    MRN: "226785",
    Name: "Doe, Jane",
    Note: 'She said "hi"',
  });
  assert.equal(sheet.rows[1].Note, "multi\r\nline");
  assert.deepEqual(sheet.rows[2], { "Patient Health ID": "", MRN: "226787", Name: "", Note: "" });

  const hid = sheet.columns[0];
  assert.equal(hid.nonEmpty, 2);
  assert.equal(hid.distinct, 2);
  assert.deepEqual(hid.sampleValues, ["30511223344557", "30511223344558"]);
  assert.equal(sheet.columns[1].nonEmpty, 3);
  assert.equal(sheet.truncated, false);
});

test("readCsv detects a semicolon delimiter, strips a BOM, names blank and duplicate headers", () => {
  const sheet = ingest.readCsv("﻿a;;a;b\n1;2;3;4\n");
  assert.deepEqual(
    sheet.columns.map((c) => c.name),
    ["a", "Column 2", "a (2)", "b"],
  );
  assert.deepEqual(sheet.rows, [{ a: "1", "Column 2": "2", "a (2)": "3", b: "4" }]);
});

test("readCsv honours maxRows and says so", () => {
  const sheet = ingest.readCsv("h\n1\n2\n3\n", { maxRows: 2 });
  assert.equal(sheet.rows.length, 2);
  assert.equal(sheet.truncated, true);
});

test("xlsx is only ever loaded on demand", () => {
  // A static import would put 7 MB in the main bundle for every analyst, most of whom never
  // upload a sheet. Only a dynamic `import("xlsx")` inside readSheet is acceptable.
  const source = fs.readFileSync(path.join(ROOT, "src/lib/ingest.ts"), "utf8");
  const staticImports = source.match(/^import\s+[^;]*["']xlsx["'];?$/gm) ?? [];
  assert.deepEqual(staticImports, []);
  assert.match(source, /await import\("xlsx"\)/);
});

test("readSheet reads the first worksheet into the same shape readCsv produces", async () => {
  // jiti resolves `xlsx` cleanly under Node, so the real reader is exercised against a
  // workbook built here rather than mocked.
  const xlsx = await import("xlsx");
  const csvSheet = ingest.readCsv(CSV);
  const aoa = [csvSheet.columns.map((c) => c.name), ...csvSheet.rows.map((r) => csvSheet.columns.map((c) => r[c.name]))];
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(aoa), "Extract");
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([["ignored"], ["x"]]), "Second");
  const buffer = xlsx.write(wb, { type: "array", bookType: "xlsx" });

  const fromBuffer = await ingest.readSheet(buffer);
  assert.equal(fromBuffer.name, "Extract");
  assert.deepEqual(
    fromBuffer.columns.map((c) => c.name),
    csvSheet.columns.map((c) => c.name),
  );
  assert.deepEqual(fromBuffer.rows, csvSheet.rows);
  assert.deepEqual(fromBuffer.columns, csvSheet.columns);

  const fromBytes = await ingest.readSheet(new Uint8Array(buffer));
  assert.deepEqual(fromBytes.rows, csvSheet.rows);
});

/* ------------------------------------------------------------------ mapping */

test("autoMapByName maps exact and normalised names against the ADT profile, deterministically", async () => {
  const { profile } = await adtA01();
  const sheet = ingest.readCsv(
    ["Patient Identifier List", "pid_7", "Visit Number", "Date/Time of Birth", "Favourite colour", "MRN", "Patient Health ID"].join(
      ",",
    ) + "\n",
  );
  const mapping = ingest.autoMapByName(sheet, profile);
  assert.equal(mapping.structureId, "adt-a01");
  assert.deepEqual(mapping.entries, [
    { column: "Patient Identifier List", locator: "PID-3", confirmed: true, via: "exact-name" },
    { column: "pid_7", locator: "PID-7", confirmed: true, via: "exact-name" },
    { column: "Visit Number", locator: "PV1-19", confirmed: true, via: "exact-name" },
  ]);
  // "Date/Time of Birth" IS PID-7's label, but pid_7 already claimed it: noted, not guessed.
  assert.deepEqual(mapping.unmapped, ["Date/Time of Birth", "Favourite colour", "MRN", "Patient Health ID"]);
  assert.equal(mapping.notes.length, 1);
  assert.match(mapping.notes[0], /Date\/Time of Birth.*PID-7.*pid_7/);
  assert.deepEqual(ingest.autoMapByName(sheet, profile), mapping, "same sheet, same profile, same mapping");
});

test("a header that names two positions is left unmapped, and forbidden positions are never offered", () => {
  const row = (locator, label, obligation) => ({
    id: locator,
    locator,
    label,
    path: label,
    depth: 1,
    obligation,
    usage: obligation === "forbidden" ? ["NP"] : ["R"],
    cardinality: null,
    conditions: [],
    datatype: null,
    fixedValue: null,
    valueSet: null,
    valueSetExternal: false,
    guidance: null,
    pageId: "1",
    quote: null,
  });
  const profile = {
    structureId: "synthetic",
    title: "synthetic",
    encoding: "hl7v2-er7",
    generatedAt: "",
    rows: [row("PID-1", "Set ID", "optional"), row("PV1-1", "Set ID", "optional"), row("ZZZ-1", "Secret", "forbidden"), row(null, "No position", "must")],
    counts: { must: 1, ifKnown: 0, optional: 2, unstated: 0, ignored: 0, forbidden: 1 },
    sampleDerived: 0,
    notes: [],
  };
  const mapping = ingest.autoMapByName({ columns: [{ name: "Set ID" }, { name: "Secret" }, { name: "No position" }] }, profile);
  assert.deepEqual(mapping.entries, []);
  assert.deepEqual(mapping.unmapped, ["Set ID", "Secret", "No position"]);
  assert.match(mapping.notes[0], /PID-1 and PV1-1/);
  assert.deepEqual(
    ingest.mappingCandidates(profile).map((c) => c.locator),
    ["PID-1", "PV1-1"],
  );
});

test("a model's proposal only ever enters as unconfirmed, inside the closed candidate list", async () => {
  const { profile } = await adtA01();
  const sheet = ingest.readCsv("Patient Identifier List,MRN,Admit\n");
  const base = ingest.autoMapByName(sheet, profile);
  const merged = ingest.mergeModelProposal(
    base,
    {
      mappings: [
        { column: "MRN", locator: "PID-3" }, // fine: unconfirmed proposal
        { column: "Admit", locator: "PV1-44" }, // fine
        { column: "Patient Identifier List", locator: "PV1-19" }, // already mapped by exact name: refused
        { column: "Ghost", locator: "PID-7" }, // column the sheet lacks: refused
        { column: "Admit", locator: "QQQ-9" }, // not a profile position: refused (and Admit already taken above)
      ],
    },
    profile,
  );
  assert.deepEqual(merged.entries, [
    { column: "Patient Identifier List", locator: "PID-3", confirmed: true, via: "exact-name" },
    { column: "MRN", locator: "PID-3", confirmed: false, via: "model" },
    { column: "Admit", locator: "PV1-44", confirmed: false, via: "model" },
  ]);
  assert.deepEqual(merged.unmapped, []);
  assert.equal(merged.notes.length, 3, merged.notes.join("\n"));
  assert.ok(merged.entries.filter((e) => e.via === "model").every((e) => e.confirmed === false));

  const confirmed = ingest.confirmEntry(merged, "Admit", true);
  assert.equal(confirmed.entries.find((e) => e.column === "Admit").confirmed, true);
  const chosen = ingest.setAnalystChoice(merged, "MRN", "PID-3.1");
  assert.deepEqual(chosen.entries.find((e) => e.column === "MRN"), { column: "MRN", locator: "PID-3.1", confirmed: true, via: "analyst" });
  const removed = ingest.setAnalystChoice(merged, "MRN", null);
  assert.equal(removed.entries.some((e) => e.column === "MRN"), false);
  assert.ok(removed.unmapped.includes("MRN"));
});

/* --------------------------------------------------------------- generation */

test("generateFromTemplate over the A01 sample changes exactly the mapped values", async () => {
  const { structure, resolved, text } = await adtA01();
  assert.equal(text.split("30511223344557").length - 1, 1, "the probe value occurs once in the template");
  const mapping = {
    structureId: structure.id,
    entries: [
      { column: "Patient Health ID", locator: "PID-3.1", confirmed: true, via: "analyst" },
      { column: "Mother", locator: "PID-6", confirmed: true, via: "analyst" },
    ],
    unmapped: [],
    notes: [],
  };
  const row = { "Patient Health ID": "9990001112223", Mother: "A^B|C~D\\E&F" };
  const out = await ingest.generateFromTemplate(text, structure, resolved, mapping, row);

  assert.deepEqual(out.applied, ["PID-3.1", "PID-6"]);
  assert.deepEqual(out.skipped, []);
  // (a) The output differs from the template only at those two values — the delimiter
  //     characters in the second one re-escaped exactly as HL7 requires.
  const expected = text.replace("30511223344557", "9990001112223").replace("ربيه", "A\\S\\B\\F\\C\\R\\D\\E\\E\\T\\F");
  assert.equal(out.text, expected);
  // (b) It still parses against the same structure, the written leaves read back decoded,
  //     and the check reports no more findings than the template did.
  const before = await workbench.analyse(text, structure, resolved);
  const after = await workbench.analyse(out.text, structure, resolved);
  assert.equal(after.parse.failure, null);
  assert.equal(S.instancesAt(after.parse.tree, ingest.parseHl7Locator("PID-3.1"))[0].value, "9990001112223");
  assert.equal(S.instancesAt(after.parse.tree, ingest.parseHl7Locator("PID-6"))[0].value, "A^B|C~D\\E&F");
  assert.ok(after.findings.length <= before.findings.length, `${after.findings.length} findings after, ${before.findings.length} before`);
});

test("generateFromTemplate records every position it will not write, and then writes nothing", async () => {
  const { structure, resolved, text } = await adtA01();
  const mapping = {
    structureId: structure.id,
    entries: [
      { column: "pid3", locator: "PID-3", confirmed: true, via: "analyst" },
      { column: "msh1", locator: "MSH-1", confirmed: true, via: "analyst" },
      { column: "model", locator: "PID-7", confirmed: false, via: "model" },
      { column: "missing", locator: "PID-8", confirmed: true, via: "analyst" },
      { column: "absent", locator: "ZZZ-9", confirmed: true, via: "analyst" },
      { column: "seg", locator: "PID-0", confirmed: true, via: "analyst" },
      { column: "name", locator: "Patient Name", confirmed: true, via: "analyst" },
    ],
    unmapped: [],
    notes: [],
  };
  const row = { pid3: "x", msh1: "#", model: "19800101", absent: "q", seg: "s", name: "n" };
  const out = await ingest.generateFromTemplate(text, structure, resolved, mapping, row);
  assert.deepEqual(out.applied, []);
  assert.equal(out.text, text, "nothing was written, so the template comes back byte for byte");
  const why = Object.fromEntries(out.skipped.map((s) => [s.locator, s.why]));
  assert.deepEqual(Object.keys(why).sort(), ["MSH-1", "PID-0", "PID-3", "PID-7", "PID-8", "Patient Name", "ZZZ-9"]);
  assert.match(why["PID-3"], /composite.*4 parts.*such as PID-3\.1/);
  assert.match(why["MSH-1"], /delimiters/);
  assert.match(why["PID-7"], /via model.*not confirmed/);
  assert.match(why["PID-8"], /no column "missing"/);
  assert.match(why["ZZZ-9"], /template has no ZZZ-9.*out of scope/);
  assert.match(why["PID-0"], /segment.*no value of its own/);
  assert.match(why["Patient Name"], /not a position/);
});

test("generateFromTemplate refuses a mapping built for another structure and a template of another encoding", async () => {
  const { structure, resolved, text } = await adtA01();
  const mapping = { structureId: "adt-a03", entries: [], unmapped: [], notes: [] };
  await assert.rejects(() => ingest.generateFromTemplate(text, structure, resolved, mapping, {}), /built for adt-a03, not for adt-a01/);
  // No parser reports failure on text of the wrong kind, so this has to be caught by the
  // same encoding sniff `analyse` uses — before anything is written.
  const fhir = (await workbench.structuresFor("fhir-lab-order"))[0];
  const fhirResolved = await workbench.resolve("fhir-lab-order", fhir.variant ?? fhir.id);
  await assert.rejects(
    () => ingest.generateFromTemplate(text, fhir, fhirResolved, { structureId: fhir.id, entries: [], unmapped: [], notes: [] }, {}),
    /looks like HL7 v2\.5\.1 pipe-delimited.*is FHIR R4 JSON/,
  );
});

/** First leaf node at a display locator, or null. */
async function leafAt(useCaseId, locator) {
  const samples = (await workbench.loadGoldenIndex()).get(useCaseId);
  const structure = workbench.structureForSample(await workbench.structuresFor(useCaseId), samples[0]);
  const resolved = await workbench.resolve(useCaseId, structure.variant ?? structure.id);
  const text = readGolden(samples[0].path);
  const parsed = await workbench.parseMessage(text, structure, resolved);
  let leaf = null;
  S.walkTree(parsed.tree, (n) => {
    if (!leaf && n.locator && n.children.length === 0 && S.formatLocator(n.locator) === locator) leaf = n;
  });
  return { structure, resolved, text, leaf };
}

/**
 * The same promise across the XML and JSON families, where each emitter keeps its recorded
 * source text somewhere other than `raw`. One data leaf per family, taken from the official
 * sample itself; the edit must land, be verified, and change nothing else.
 */
for (const [useCaseId, locator] of [
  ["cda-discharge-summary", "/ClinicalDocument/recordTarget/patientRole/id/@extension"],
  ["xds-iti41", "ExtrinsicObject/@id"],
  ["fhir-lab-order", "./timestamp"],
]) {
  test(`generateFromTemplate edits one leaf of the ${useCaseId} official sample and nothing else`, async () => {
    const { structure, resolved, text, leaf } = await leafAt(useCaseId, locator);
    assert.ok(leaf && typeof leaf.raw === "string" && leaf.value, `${useCaseId}: the sample has no leaf at ${locator}`);

    const mapping = { structureId: structure.id, entries: [{ column: "c", locator, confirmed: true, via: "analyst" }], unmapped: [], notes: [] };
    const out = await ingest.generateFromTemplate(text, structure, resolved, mapping, { c: "ZZTEST" });
    assert.deepEqual(out.applied, [locator]);
    assert.deepEqual(out.skipped, []);
    // Exactly one contiguous substitution, of the leaf's old value for the new one, on the
    // leaf's own line. (The old value recurs elsewhere in these samples — a UUID every
    // Association cites, a timestamp every resource repeats — so a plain replace would not
    // prove the right occurrence changed.)
    let i = 0;
    while (i < text.length && text[i] === out.text[i]) i++;
    let j = 0;
    while (j < text.length - i && text[text.length - 1 - j] === out.text[out.text.length - 1 - j]) j++;
    assert.equal(text.slice(i, text.length - j), leaf.value);
    assert.equal(out.text.slice(i, out.text.length - j), "ZZTEST");
    assert.equal(text.slice(0, i).split(/\r\n|\r|\n/).length, leaf.loc.line);
    const before = await workbench.analyse(text, structure, resolved);
    const after = await workbench.analyse(out.text, structure, resolved);
    assert.equal(after.parse.failure, null);
    assert.ok(after.findings.length <= before.findings.length, `${after.findings.length} findings after, ${before.findings.length} before`);
  });
}

test("the generator never judges: a bad value is written, and it is the checker that reports it", async () => {
  // `Bundle.resourceType` is a fixed structural value. Writing "ZZTEST" there is wrong, and the
  // generator does it anyway — deciding what is conformant belongs to `check()`, where the
  // verdict comes with its evidence. The findings rise; the generator's report stays a
  // plain record of what it wrote.
  const { structure, resolved, text, leaf } = await leafAt("fhir-lab-order", "./resourceType");
  assert.ok(leaf && leaf.value === "Bundle");
  const mapping = { structureId: structure.id, entries: [{ column: "c", locator: "./resourceType", confirmed: true, via: "analyst" }], unmapped: [], notes: [] };
  const out = await ingest.generateFromTemplate(text, structure, resolved, mapping, { c: "ZZTEST" });
  assert.deepEqual(out.applied, ["./resourceType"]);
  const before = await workbench.analyse(text, structure, resolved);
  const after = await workbench.analyse(out.text, structure, resolved);
  assert.ok(after.findings.length > before.findings.length, "the checker must be the one to notice");
});
