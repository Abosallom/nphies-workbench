/**
 * The advisory panel, and the footer that replaced the leak.
 *
 * Two claims. First, a model's output is rendered as an opinion and nothing more: the panel
 * carries the disclaimer sentence, verdicts are words, and no severity class or glyph appears
 * anywhere inside it — the reserved palette is the checker's alone. Second, the explain
 * footer under a finding hands the model a window of the REDACTED skeleton: the ADT sample's
 * patient name, health id, date of birth and mother's maiden name are in the message and
 * must not be in what the footer renders or would send.
 *
 * The advisories here are built by hand in the `Advisory` shape — no model is consulted and
 * no network is touched. Rendered through Vite's SSR pipeline like `views.test.mjs`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withApp } from "./render.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADT_SAMPLE = path.join(ROOT, "spec-source/golden/HL7 v2.5.1/ADT/ADT_sample03.txt");

/** Patient values as written in ADT_sample03.txt, PID segment. */
const PHI = ["TTT^Test", "TTT", "30511223344557", "19790528", "ربيه", "226785"];

/** The reserved severity vocabulary. None of it may appear inside model output. */
const SEVERITY_CLASSES = [
  "text-error",
  "bg-error",
  "border-l-error",
  "decoration-error",
  "text-warn",
  "bg-warn",
  "border-l-warn",
  "decoration-warn",
  "text-ok",
  "bg-ok",
  "border-l-ok",
  "decoration-ok",
  "text-ignored",
  "bg-ignored",
  "border-l-ignored",
  "text-error-ink",
  "text-warn-ink",
  "text-ok-ink",
];
/** Glyph chips render the letter alone between tags. */
const SEVERITY_GLYPHS = [">E<", ">!<", ">✓<", ">–<"];

/** Analyse the ADT sample for real and assemble the panel's input from it. */
async function realInput(load) {
  const workbench = await load("/src/lib/workbench.ts");
  const { buildSkeleton } = await load("/src/lib/skeleton.ts");
  const { gapsOf } = await load("/src/lib/gaps.ts");
  const { ruleStubsFrom } = await load("/src/lib/ai.ts");
  const text = fs.readFileSync(ADT_SAMPLE, "utf8");
  const golden = await workbench.loadGoldenIndex();
  const sample = (golden.get("adt") ?? []).find((s) => s.fileName === "ADT_sample03.txt");
  assert.ok(sample, "the ADT A03 sample is not in the golden index");
  const structures = await workbench.structuresFor("adt");
  const structure = workbench.structureForSample(structures, sample);
  assert.ok(structure, "no structure for the A03 sample");
  const resolved = await workbench.resolve("adt", structure.variant ?? structure.id);
  const analysis = await workbench.analyse(text, structure, resolved);
  assert.equal(analysis.parse.failure, null, "the ADT sample did not parse");
  const skeleton = buildSkeleton(analysis.parse.tree, resolved.specNodes, { findings: analysis.findings });
  const findings = analysis.findings.filter((f) => f.severity !== "ok" && f.severity !== "ignored");
  return {
    text,
    structure,
    resolved,
    analysis,
    skeleton,
    input: {
      structure,
      findings,
      withheld: analysis.findings.length - findings.length,
      skeleton,
      rules: ruleStubsFrom(resolved.specNodes),
      gaps: gapsOf(analysis.findings, { tree: analysis.parse.tree, structure, specNodes: resolved.specNodes }),
    },
  };
}

/** A verified-looking advisory, in the `Advisory` shape, with no model behind it. */
function advisory(i, over) {
  return {
    source: "model",
    kind: "second-opinion",
    id: `second-opinion:deadbeefcafe:${i}`,
    model: "claude-opus-5",
    about: {},
    claim: `Synthetic claim ${i}`,
    reasoning: `Synthetic reasoning ${i}`,
    modelConfidence: "medium",
    quotes: ["Findings (id | severity | code | line | path | rule):"],
    ruleIds: [],
    inputDigest: "sha256:deadbeefcafe0123456789",
    dropped: 2,
    ...over,
  };
}

test("the advisory panel renders opinions as opinions — words, no severity, the disclaimer", async () => {
  await withApp(async ({ load, render, h }) => {
    const { ToastProvider } = await load("/src/ui/index.ts");
    const { AdvisoryPanel, DISCLAIMER } = await load("/src/views/AdvisoryPanel.tsx");
    const { payloadParts, redactFinding } = await load("/src/lib/ai.ts");
    const { input } = await realInput(load);

    const errorFinding = input.findings.find((f) => f.severity === "error") ?? input.findings[0];
    const warnFinding = input.findings.find((f) => f.severity === "warn" && f.id !== errorFinding.id) ?? input.findings[1] ?? errorFinding;
    const payload = payloadParts({ structure: input.structure, findings: input.findings.map(redactFinding), skeleton: input.skeleton, rules: input.rules });

    const review = {
      advisories: [
        advisory(0, { about: { findingId: errorFinding.id, line: errorFinding.location?.line ?? null }, verdict: "agree" }),
        advisory(1, { about: { findingId: warnFinding.id, line: null }, verdict: "doubt", modelConfidence: "low" }),
        advisory(2, { about: { findingId: errorFinding.id, line: null }, verdict: "cannot-tell", modelConfidence: "high" }),
        advisory(3, { about: { line: null }, claim: "An additional structural observation", modelConfidence: "low" }),
      ],
      dropped: [
        { reason: "quote-not-verbatim", raw: {}, detail: "not in the payload" },
        { reason: "unknown-rule-id", raw: {}, detail: "rule id not in the closed list" },
      ],
      notReviewed: [],
      usage: { inputTokens: 12345, outputTokens: 678, cacheReadTokens: 9000, cacheWriteTokens: 0 },
      model: "claude-opus-5",
      digest: "sha256:deadbeefcafe0123456789",
      payload,
    };

    // React marks text boundaries with `<!-- -->` in SSR output; strip them so phrases match.
    const html = render(
      h(
        ToastProvider,
        null,
        h(AdvisoryPanel, {
          input,
          open: true,
          onToggle() {},
          review,
          onReview() {},
          gaps: null,
          onGaps() {},
          onRecheck() {},
          declared: null,
          density: "dense",
        }),
      ),
    ).replace(/<!-- -->/g, "");

    assert.ok(html.includes(DISCLAIMER), "the disclaimer sentence is missing");
    assert.ok(html.includes("Model opinion — not a structural verdict"), "the disclaimer wording changed");
    for (const cls of SEVERITY_CLASSES) {
      assert.ok(!html.includes(cls), `severity class "${cls}" appears inside the advisory panel`);
    }
    for (const glyph of SEVERITY_GLYPHS) {
      assert.ok(!html.includes(glyph), `severity glyph ${glyph} appears inside the advisory panel`);
    }
    for (const word of ["Model agrees", "Model doubts", "Model cannot tell"]) {
      assert.ok(html.includes(word), `verdict word "${word}" does not render`);
    }
    assert.match(html, /2 unverifiable claims discarded/, "the dropped count does not render");
    assert.match(html, /4 verified claims/, "the verified count does not render");
    assert.ok(html.includes("about the check as of deadbeefcafe"), "the payload digest is not shown");
    assert.ok(html.includes("claude-opus-5"), "the model id is not shown");
    assert.match(html, /in 12,345 · out 678 · cached 9,000/, "usage is not shown");
    assert.ok(html.includes("Preview what will be sent"), "the preview affordance is missing");
    assert.match(html, /sends ~[\d,]+ tokens/, "the button does not state the payload size");
    assert.ok(html.includes("Questions the checker could not answer ("), "the gaps section is missing");
    // The message never enters the panel — not even through the payload preview text.
    for (const v of PHI) assert.ok(!html.includes(v), `patient value "${v}" appears in the advisory panel`);
    // With no key stored, the panel says why the AI part is inert instead of failing.
    assert.match(html, /No Anthropic API key is set/, "the no-key state is not explained");
  });
});

test("the finding footer sends a redacted window, never the message lines", async () => {
  await withApp(async ({ load, render, h }) => {
    const { ToastProvider } = await load("/src/ui/index.ts");
    const { CheckFindingFooter, CheckView } = await load("/src/views/CheckView.tsx");
    const { skeletonWindow } = await load("/src/lib/skeleton.ts");
    const { text, structure, resolved, analysis, skeleton } = await realInput(load);

    // Pretend a key is stored, so the button (and its copy) renders rather than the hint.
    // Nothing is clicked, so nothing is sent; the harness never reaches the network.
    const { API_KEY_STORAGE_KEY } = await load("/src/ui/index.ts");
    globalThis.localStorage.setItem(API_KEY_STORAGE_KEY, "sk-ant-test");

    const located = analysis.findings.filter((f) => (f.severity === "error" || f.severity === "warn") && f.location);
    assert.ok(located.length > 0, "the ADT sample yields no located error/warn finding to hang a footer on");

    let footers = 0;
    for (const f of located) {
      const html = render(
        h(ToastProvider, null, h(CheckFindingFooter, { finding: f, line: f.location.line, structure, skeleton })),
      ).replace(/<!-- -->/g, "");
      footers++;
      assert.match(html, /redacted excerpt around line \d+ — names, ids and dates already removed/, `footer for ${f.id} does not say what it sends`);
      assert.ok(html.includes("Preview what will be sent"), `footer for ${f.id} offers no preview`);
      for (const v of PHI) assert.ok(!html.includes(v), `patient value "${v}" appears in the footer for ${f.id}`);
      // The exact window the footer hands to the model is clean too.
      const window = skeletonWindow(skeleton, f.location.line, 2);
      for (const v of PHI) assert.ok(!window.includes(v), `patient value "${v}" appears in the skeleton window for ${f.id}`);
    }
    assert.ok(footers > 0);

    // CheckView itself still mounts over the real sample, and before a check there is no panel.
    const view = render(
      h(
        ToastProvider,
        null,
        h(CheckView, {
          structure,
          structures: resolved.structures,
          resolved,
          samples: [],
          text,
          onTextChange() {},
          onStructureChange() {},
          structureIdForSample: () => null,
        }),
      ),
    );
    assert.match(view, /Check structure/, "Check does not offer to check");
    assert.ok(!view.includes("data-advisory-panel"), "the advisory panel is shown before any check");
  });
});
