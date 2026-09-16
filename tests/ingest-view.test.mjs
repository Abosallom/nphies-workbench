/**
 * The Ingest surface mounts over a real extract and the real ADT profile.
 *
 * Rendered through Vite's own SSR pipeline, like tests/views.test.mjs, so this is the view as
 * it ships. It asserts the promises the surface makes before any file is uploaded or any
 * model is asked: the sheet's columns are on the page, the deterministic exact-name pass is
 * labelled as such, the model button is inert without a key and says why, and the privacy
 * sentence is present. Workbooks are not read here: `xlsx` is a browser-side dynamic import
 * and `readSheet` has its own engine test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { withApp } from "./render.mjs";

const CSV = [
  "Patient Identifier List,pid_7,Visit Number,MRN,Favourite colour",
  "30511223344557,19790528,V-1001,226785,blue",
  ",19800101,V-1002,226786,",
].join("\n");

test("Ingest renders the sheet, labels exact-name pairs, and keeps the model inert without a key", async () => {
  await withApp(async ({ load, render, h }) => {
    const { ToastProvider } = await load("/src/ui/index.ts");
    const workbench = await load("/src/lib/workbench.ts");
    const { readCsv, autoMapByName } = await load("/src/lib/ingest.ts");
    const { buildProfile } = await load("/src/lib/profile.ts");
    const { IngestView } = await load("/src/views/IngestView.tsx");

    const resolved = await workbench.resolve("adt", "A01");
    assert.ok(resolved, "adt/A01 does not resolve");
    const sheet = readCsv(CSV);
    assert.equal(sheet.columns.length, 5);

    // The same pass the view runs on mount, so the assertions below are about what the
    // library decided, not about the view's own opinion.
    const mapping = autoMapByName(sheet, buildProfile(resolved.structure, resolved.tables));
    assert.equal(mapping.entries.length, 3, mapping.notes.join("\n"));
    assert.ok(mapping.entries.every((e) => e.via === "exact-name"));

    const props = {
      structure: resolved.structure,
      structures: resolved.structures,
      resolved,
      samples: [],
      onOpenInCheck() {},
      initialSheet: sheet,
    };

    for (const density of ["dense", "roomy"]) {
      const html = render(h(ToastProvider, null, h(IngestView, { ...props, density })));

      for (const c of sheet.columns) {
        assert.ok(html.includes(c.name), `${density}: column "${c.name}" is not rendered`);
      }
      // Filled/distinct counts and the first values are shown, never a rule.
      assert.match(html, /30511223344557/, `${density}: the first sample value is not shown`);

      // The exact-name pass: each pair carries its `via`, and the count is the library's.
      const exact = html.match(/exact-name/g) ?? [];
      assert.equal(exact.length, mapping.entries.length, `${density}: expected ${mapping.entries.length} exact-name badges`);
      for (const e of mapping.entries) {
        assert.ok(html.includes(e.locator), `${density}: mapped position ${e.locator} is not shown`);
      }
      assert.match(html, /2 unmapped/, `${density}: the unmapped count is not stated`);
      assert.match(html, /Favourite colour/, `${density}: the unmapped column is not listed`);

      // The model: its region, its disclaimer, and an inert button that says why.
      assert.match(html, /Ask the model to propose the rest/, `${density}: the model button is missing`);
      assert.match(html, /<button[^>]*disabled[^>]*>Ask the model to propose the rest/, `${density}: the model button is not inert`);
      assert.match(html, /no Anthropic API key is stored in this browser/, `${density}: the button does not say why it is inert`);
      assert.match(html, /Model opinion — not a structural verdict\. Nothing here changes the findings\./, `${density}: the advisory sentence is missing`);
      assert.match(html, /border-dashed/, `${density}: the model region is not set apart`);

      // Privacy, stated on the page rather than assumed.
      assert.match(html, /Cell data stays in this browser\. Only column names are ever sent to a model/, `${density}: the privacy sentence is missing`);

      // No sample shipped -> the template must be pasted, and the page says so.
      assert.match(html, /No official sample is shipped for this use case, so a template has to be pasted/, `${density}: the no-sample path is silent`);
      assert.match(html, /An empty cell is written as an empty value on purpose/, `${density}: empty-cell behaviour is not stated`);

      // No severity colour: the view never paints a verdict.
      for (const cls of ["text-error", "text-warn", "text-ok", "bg-error-bg", "bg-warn-bg", "bg-ok-bg"]) {
        assert.ok(!html.includes(cls), `${density}: severity class ${cls} appears on the Ingest surface`);
      }
    }
  });
});

test("Ingest without a compiled structure says so instead of rendering an empty flow", async () => {
  await withApp(async ({ load, render, h }) => {
    const { ToastProvider } = await load("/src/ui/index.ts");
    const { IngestView } = await load("/src/views/IngestView.tsx");
    const html = render(
      h(ToastProvider, null, h(IngestView, { structure: null, structures: [], resolved: null, samples: [], density: "dense", onOpenInCheck() {} })),
    );
    assert.match(html, /No compiled structure/);
  });
});
