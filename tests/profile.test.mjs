/**
 * Profile import: a vendor's exported profile must come back as exactly the profile that
 * was exported, and a tampered one must be named as tampered rather than trusted.
 *
 * The risk being guarded is the same one the checker guards: a document that reads as
 * authoritative ("35 positions must be built") while saying something the compiled
 * specification does not. So the round trip is asserted deep-equal over every official use
 * case, `counts` is never taken from the file, and reconciliation is a side-by-side view that
 * cannot change either profile.
 */
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createJiti } from "jiti";
import { loadEngine, ROOT } from "./harness.mjs";

const { workbench } = await loadEngine();
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: true });
const { buildProfile, profileToJson, parseProfile, reconcileProfile } = await jiti.import(
  path.join(ROOT, "src/lib/profile.ts"),
);

/** One compiled profile per structure of every use case in the manifest. */
const profiles = [];
const registry = await workbench.loadRegistry();
for (const entry of registry.entries) {
  const structures = await workbench.structuresFor(entry.summary.id);
  for (const structure of structures) {
    const resolved = await workbench.resolve(entry.summary.id, structure.variant ?? structure.id);
    if (!resolved) continue;
    profiles.push(buildProfile(structure, resolved.tables));
  }
}

const stripDate = ({ generatedAt: _g, ...rest }) => rest;

test("every use case round-trips buildProfile -> profileToJson -> parseProfile unchanged", () => {
  assert.ok(profiles.length >= 10, `expected a broad set of structures, found ${profiles.length}`);
  for (const profile of profiles) {
    const out = parseProfile(profileToJson(profile));
    assert.ok(!("error" in out), `${profile.structureId}: ${out.error}`);
    assert.deepEqual(out.warnings, [], `${profile.structureId} produced warnings on its own export`);
    assert.deepEqual(stripDate(out.profile), stripDate(profile), `${profile.structureId} did not round-trip`);
    // generatedAt is carried, not regenerated: the import should say when the vendor made it.
    assert.equal(out.profile.generatedAt, profile.generatedAt);
  }
});

/** The richest profile is the one most likely to expose a field the validator forgot. */
const sample = profiles.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
const tampered = (mutate) => {
  const copy = JSON.parse(profileToJson(sample));
  mutate(copy);
  return parseProfile(JSON.stringify(copy));
};

test("bad input never throws and every error names what to fix", () => {
  const notJson = parseProfile("{ this is not json");
  assert.match(notJson.error, /not valid JSON/);

  assert.match(parseProfile("[]").error, /JSON object/);
  assert.match(parseProfile("null").error, /JSON object/);

  assert.match(tampered((p) => delete p.structureId).error, /"structureId"/);
  assert.match(tampered((p) => (p.structureId = 42)).error, /"structureId"/);
  assert.match(tampered((p) => (p.structureId = "  ")).error, /"structureId"/);
  assert.match(tampered((p) => (p.title = null)).error, /"title" must be a string/);
  assert.match(tampered((p) => delete p.rows).error, /"rows" must be a list/);
  assert.match(tampered((p) => (p.rows = {})).error, /"rows" must be a list/);
});

test("a row with a missing or mistyped field is refused by field name and index", () => {
  assert.match(tampered((p) => delete p.rows[3].obligation).error, /^rows\[3\]\.obligation must be one of must, ifKnown/);
  assert.match(tampered((p) => (p.rows[0].obligation = "mandatory")).error, /rows\[0\]\.obligation .* got "mandatory"/);
  assert.match(tampered((p) => (p.rows[1].usage = "M")).error, /rows\[1\]\.usage must be a list of strings/);
  // A usage code the specification does not define is a fabricated rule, not a typo to accept.
  assert.match(tampered((p) => (p.rows[1].usage = ["M", "RE"])).error, /rows\[1\]\.usage contains usage code\(s\) .* RE/);
  assert.match(tampered((p) => (p.rows[2].depth = "1")).error, /rows\[2\]\.depth must be a whole number/);
  assert.match(tampered((p) => (p.rows[2].valueSetExternal = "yes")).error, /rows\[2\]\.valueSetExternal must be true or false/);
  assert.match(tampered((p) => (p.rows[4].locator = 12)).error, /rows\[4\]\.locator must be a string or null/);
  assert.match(tampered((p) => (p.rows[5] = "PID-3")).error, /rows\[5\] must be an object/);
});

test("counts are recomputed from the rows, and a file whose counts lie is warned about", () => {
  const lying = tampered((p) => {
    p.counts.must = p.counts.must + 5;
    p.counts.ignored = 0;
  });
  assert.ok(!("error" in lying), lying.error);
  assert.deepEqual(lying.profile.counts, sample.counts, "the file's counts were trusted");
  assert.equal(lying.warnings.length, 1);
  assert.match(lying.warnings[0], /"counts" did not match the rows/);
  assert.match(lying.warnings[0], new RegExp(`must said ${sample.counts.must + 5}, rows hold ${sample.counts.must}`));

  const missing = tampered((p) => delete p.counts);
  assert.ok(!("error" in missing), missing.error);
  assert.deepEqual(missing.profile.counts, sample.counts);
  assert.match(missing.warnings[0], /"counts" was nothing; it was recomputed/);
});

test("derived metadata is repaired with a warning; unknown row fields are dropped with a warning", () => {
  const out = tampered((p) => {
    p.sampleDerived = "many";
    p.notes = "a caveat";
    p.rows[0].reviewedBy = "vendor";
  });
  assert.ok(!("error" in out), out.error);
  assert.equal(out.profile.sampleDerived, 0);
  assert.deepEqual(out.profile.notes, []);
  assert.ok(!("reviewedBy" in out.profile.rows[0]));
  assert.deepEqual(
    out.warnings.map((w) => w.split(" ")[0]),
    ["rows[0]", '"sampleDerived"', '"notes"'],
    out.warnings.join("\n"),
  );
});

test("reconciling a profile against itself is all unchanged", () => {
  for (const profile of profiles) {
    const reread = parseProfile(profileToJson(profile)).profile;
    const diff = reconcileProfile(reread, profile);
    assert.deepEqual(diff.added, [], `${profile.structureId}: rows added`);
    assert.deepEqual(diff.removed, [], `${profile.structureId}: rows removed`);
    assert.deepEqual(diff.changed, [], `${profile.structureId}: rows changed`);
    assert.equal(diff.unchanged, profile.rows.length);
  }
});

test("reconciling against a different structure reports every difference and invents nothing", () => {
  const [a, b] = [profiles[0], profiles.find((p) => p.encoding !== profiles[0].encoding) ?? profiles[1]];
  // Reconcile is read-only: snapshot both sides first so any mutation shows up below.
  const aBefore = profileToJson(a);
  const bBefore = profileToJson(b);
  const diff = reconcileProfile(a, b);
  assert.equal(diff.added.length + diff.changed.length + diff.unchanged, a.rows.length, "every imported row is accounted for once");
  assert.equal(diff.removed.length + diff.changed.length + diff.unchanged, b.rows.length, "every current row is accounted for once");
  assert.ok(diff.added.length + diff.removed.length + diff.changed.length > 0, "two different structures reported no difference");
  assert.equal(profileToJson(a), aBefore, "reconcile mutated the imported profile");
  assert.equal(profileToJson(b), bBefore, "reconcile mutated the current profile");
  for (const row of diff.added) assert.ok(a.rows.includes(row), "an added row is not one of the imported rows");
  for (const row of diff.removed) assert.ok(b.rows.includes(row), "a removed row is not one of the current rows");
});

test("a changed obligation on one position is reported as exactly one change", () => {
  const edited = tampered((p) => {
    const row = p.rows.find((r) => r.obligation === "must") ?? p.rows[0];
    row.obligation = "optional";
    row.usage = ["O"];
  });
  assert.ok(!("error" in edited), edited.error);
  const diff = reconcileProfile(edited.profile, sample);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].before.obligation, "must");
  assert.equal(diff.changed[0].after.obligation, "optional");
  assert.equal(diff.unchanged, sample.rows.length - 1);
  // The compiled profile is untouched by the comparison.
  assert.equal(sample.rows.filter((r) => r.obligation === "must").length, sample.counts.must);
});

test("rows whose locator recurs fall back to path, then id, and are never merged", () => {
  const twin = JSON.parse(profileToJson(sample));
  const [first, second] = twin.rows;
  // Give two distinct positions the same human locator, as a repeated segment in two groups would.
  first.locator = "ZZZ-1";
  second.locator = "ZZZ-1";
  const same = reconcileProfile(twin, twin);
  assert.deepEqual(same.added, []);
  assert.deepEqual(same.removed, []);
  assert.equal(same.unchanged, twin.rows.length);
  // FHIR bundles repeat the path `Bundle/./entry/./entry` for every entry slot; those rows must
  // still each find their own counterpart rather than collapsing onto the first one.
  const fhir = profiles.find((p) => p.encoding === "fhir-json");
  assert.ok(fhir, "no FHIR structure compiled");
  const fhirDiff = reconcileProfile(fhir, fhir);
  assert.deepEqual(fhirDiff.added, []);
  assert.equal(fhirDiff.unchanged, fhir.rows.length);
});
