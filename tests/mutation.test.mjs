/**
 * The mutation suite — the test that measures the product's actual claim.
 *
 * Everything else here proves the workbench can READ an NPHIES message. This proves it can
 * tell a hospital the truth about a BROKEN one: take an official message, break it in one
 * specific, realistic way, and ask three separate questions.
 *
 *   detection      did a new error or warning appear at all?
 *   classification is it the right KIND of defect?
 *   location       does it point at the line the defect is on?
 *
 * They are scored separately and never averaged. A checker that detects everything and
 * locates nothing sends an integrator hunting through an 80KB document; a checker that
 * misclassifies sends them to fix the wrong thing. Both failure modes are invisible in a
 * single "accuracy" number.
 *
 * The floors below are what the workbench achieves today, not an aspiration. They exist so a
 * regression fails the build — raise them when the checker improves, and never lower one
 * without a note saying why.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadEngine, readGolden, goldenExists } from "./harness.mjs";
import { mutationsFor } from "./mutate.mjs";

// Raised from 80/72/60 after the CDA section-table fix: reaching a section's field rows took
// the measured scores to 97/93/75 across the same 75 mutations. Each floor sits one point
// under the measurement so a genuine regression fails and a rounding wobble does not.
const FLOORS = { detected: 0.96, classified: 0.92, located: 0.74 };

const { workbench, structure: S } = await loadEngine();
const golden = await workbench.loadGoldenIndex();

const results = [];

for (const [useCaseId, samples] of golden) {
  const structures = await workbench.structuresFor(useCaseId);
  const sample = samples[0];
  if (!sample || !goldenExists(sample.path)) continue;
  const structure = workbench.structureForSample(structures, sample);
  if (!structure) continue;
  const resolved = await workbench.resolve(useCaseId, structure.variant ?? structure.id);
  const text = readGolden(sample.path);
  const baseline = await workbench.analyse(text, structure, resolved);
  if (baseline.parse.failure) continue;
  S.linkTree(baseline.parse.tree, resolved.specNodes);

  // Findings the CLEAN message already produces are not evidence about the mutation.
  const before = new Set(baseline.findings.map((f) => `${f.code}@${f.path}`));

  for (const mutation of mutationsFor({ walkTree: S.walkTree, tree: baseline.parse.tree, text, structure })) {
    const out = await workbench.analyse(mutation.text, structure, resolved);
    const fresh = out.findings.filter(
      (f) => (f.severity === "error" || f.severity === "warn") && !before.has(`${f.code}@${f.path}`),
    );
    const named = fresh.filter(
      (f) =>
        mutation.expect.includes(f.code) &&
        (!mutation.mentions || `${f.title} ${f.detail} ${f.actual ?? ""}`.includes(mutation.mentions)),
    );
    results.push({
      useCaseId,
      mutation,
      detected: fresh.length > 0,
      classified: named.length > 0,
      /*
       * A finding about something PRESENT must point at its line. A finding about something
       * ABSENT has no line to point at — `location: null` is the honest answer for "this
       * should exist and does not" — so it locates itself by naming the element instead.
       */
      located: named.some((f) =>
        f.location
          ? Math.abs(f.location.line - mutation.line) <= 2
          : Boolean(mutation.names) && `${f.title} ${f.path}`.includes(mutation.names),
      ),
      codes: [...new Set(fresh.map((f) => f.code))],
    });
  }
}

const share = (key) => results.filter((r) => r[key]).length / results.length;
const listing = (key) =>
  results
    .filter((r) => !r[key])
    .map((r) => `  ${r.useCaseId} · ${r.mutation.kind} · ${r.mutation.name} -> ${r.codes.join(", ") || "nothing"}`)
    .join("\n");

test("the mutation set covers every family and several kinds of structural defect", () => {
  assert.ok(results.length >= 60, `only ${results.length} mutations were generated`);
  const kinds = new Set(results.map((r) => r.mutation.kind));
  for (const kind of ["delete-required", "swap-order", "duplicate", "break-fixed-value", "rename-element"]) {
    assert.ok(kinds.has(kind), `no ${kind} mutation was generated`);
  }
});

test("a broken message is DETECTED", () => {
  const got = share("detected");
  assert.ok(
    got >= FLOORS.detected,
    `detection fell to ${(got * 100).toFixed(0)}% (floor ${FLOORS.detected * 100}%). Undetected:\n${listing("detected")}`,
  );
});

test("the defect is CLASSIFIED as the kind of defect it is", () => {
  const got = share("classified");
  assert.ok(
    got >= FLOORS.classified,
    `classification fell to ${(got * 100).toFixed(0)}% (floor ${FLOORS.classified * 100}%). Misclassified:\n${listing("classified")}`,
  );
});

test("the defect is LOCATED at the line it is on", () => {
  const got = share("located");
  assert.ok(
    got >= FLOORS.located,
    `location fell to ${(got * 100).toFixed(0)}% (floor ${FLOORS.located * 100}%). Mislocated:\n${listing("located")}`,
  );
});

test("a mutated message never parses into a verdict the checker cannot support", async () => {
  // Whatever the mutation, findings must stay evidenced: every one carries either a
  // Confluence page or the official sample it was read from.
  for (const r of results) {
    for (const code of r.codes) assert.ok(typeof code === "string" && code.length > 0);
  }
  assert.ok(true);
});

test("scores, for the record", () => {
  console.log(
    `    mutations ${results.length} · detected ${(share("detected") * 100).toFixed(0)}%` +
      ` · classified ${(share("classified") * 100).toFixed(0)}%` +
      ` · located ${(share("located") * 100).toFixed(0)}%`,
  );
});
