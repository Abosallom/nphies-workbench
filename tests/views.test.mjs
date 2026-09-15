/**
 * Every surface mounts, against the real compiled spec.
 *
 * Rendered through Vite's own SSR pipeline, so this is the app as it ships — same JSX
 * transform, same `import.meta.glob` bundle loading. It is a smoke test, not a visual one:
 * it catches a view that throws on first render, and it asserts that each surface puts its
 * own subject on the page rather than an empty shell.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { withApp } from "./render.mjs";

test("every view mounts and renders its own subject", async () => {
  await withApp(async ({ load, render, h }) => {
    const { ToastProvider } = await load("/src/ui/index.ts");
    const wrap = (el) => render(h(ToastProvider, null, el));

    const { Shell } = await load("/src/views/Shell.tsx");
    const shell = wrap(h(Shell));
    for (const probe of ["NPHIES Workbench", "Check", "Explain", "Readiness", "Error Decoder", "Coverage"]) {
      assert.ok(shell.includes(probe), `the shell does not render "${probe}"`);
    }

    const workbench = await load("/src/lib/workbench.ts");
    const registry = await workbench.loadRegistry();
    const resolved = await workbench.resolve("adt", "A01");
    assert.ok(resolved, "adt/A01 does not resolve");

    const common = {
      structure: resolved.structure,
      structures: resolved.structures,
      resolved,
      samples: [],
      text: "",
      onTextChange() {},
      onStructureChange() {},
      onOpenSample() {},
      structureIdForSample: () => null,
    };

    const { CheckView } = await load("/src/views/CheckView.tsx");
    const check = wrap(h(CheckView, common));
    assert.match(check, /Paste the HL7 v2\.5\.1 pipe-delimited message/, "Check does not invite a paste");

    const { ExplainView } = await load("/src/views/ExplainView.tsx");
    const explain = wrap(h(ExplainView, common));
    assert.match(explain, /rules/, "Explain does not report a rule count");
    assert.match(explain, /MSH/, "Explain does not show the message's own segments");

    const { BuildView } = await load("/src/views/BuildView.tsx");
    const build = wrap(h(BuildView, common));
    assert.match(build, /Must build/, "Build does not state the required surface");
    assert.match(build, /Do not build/, "Build does not state what NPHIES ignores");

    const { ReadinessView } = await load("/src/views/ReadinessView.tsx");
    const readiness = wrap(h(ReadinessView, { registry, results: {}, onOpen() {} }));
    assert.match(readiness, /not checked/, "Readiness claims a verdict for an unchecked use case");
    assert.ok(
      registry.entries.every((e) => readiness.includes(e.ui.code)),
      "Readiness omits a use case",
    );

    const { CoverageView } = await load("/src/views/CoverageView.tsx");
    const coverage = wrap(h(CoverageView, { registry }));
    assert.match(coverage, /rules/, "Coverage does not report what the bundle holds");

    const { DecoderView } = await load("/src/views/DecoderView.tsx");
    const decoder = wrap(h(DecoderView, {}));
    assert.match(decoder, /Paste the rejection/, "the decoder does not invite a rejection");
  });
});

test("the error decoder identifies a real NPHIES rejection", async () => {
  await withApp(async ({ load }) => {
    const { loadErrorCatalogue, decodeRejection } = await load("/src/lib/errors.ts");
    const catalogue = await loadErrorCatalogue();
    assert.ok(catalogue.entries.length >= 30, "the error catalogue is missing entries");

    // Verbatim from the Error Handling Guide's own sample column.
    const matches = decodeRejection(
      "Required field missing PID/PatientIdentifierList[0]/IDNumber",
      catalogue,
    );
    assert.ok(matches.length > 0, "a catalogued rejection was not recognised at all");
    const best = matches[0];
    assert.ok(best.score >= 0.5, `the best match scored only ${best.score}`);
    assert.ok(
      (best.entry.locators ?? []).some((l) => l.value.includes("PID")),
      "the match does not point at the PID field the rejection names",
    );

    // Nonsense must not be forced into a match.
    const nothing = decodeRejection("qqq zzz", catalogue);
    assert.equal(nothing.length, 0, "the decoder invented a match for nonsense");
  });
});
