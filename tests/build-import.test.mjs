/**
 * Profile import on the Build surface, rendered through Vite's SSR pipeline over the real
 * compiled spec.
 *
 * What is guarded: the panel must never look more certain than the library is. A file that
 * round-trips must read as agreement; a broken file must show the library's own sentence
 * (written for the person who has to fix it) and no diff; a repaired file must show the
 * repair; and a file from another structure must be shown as differences, never applied.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { withApp } from "./render.mjs";

/** React escapes text the same way; matching a sentence verbatim needs the same escaping. */
const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const count = (html, key) => {
  const m = html.match(new RegExp(`data-diff="${key}"[^>]*>([\\d,]+)<`));
  assert.ok(m, `no "${key}" count on the page`);
  return Number(m[1].replace(/,/g, ""));
};

test("the Build surface lays an imported profile beside the compiled structure", async () => {
  await withApp(async ({ load, render, h }) => {
    const { ToastProvider } = await load("/src/ui/index.ts");
    const { BuildView, readProfileFile } = await load("/src/views/BuildView.tsx");
    const { buildProfile, profileToJson, parseProfile } = await load("/src/lib/profile.ts");
    const workbench = await load("/src/lib/workbench.ts");

    const resolved = await workbench.resolve("adt", "A01");
    assert.ok(resolved, "adt/A01 does not resolve");
    const profile = buildProfile(resolved.structure, resolved.tables);

    const mount = (importedProfile, density = "dense") =>
      render(
        h(
          ToastProvider,
          null,
          h(BuildView, {
            structure: resolved.structure,
            structures: resolved.structures,
            resolved,
            samples: [],
            onStructureChange() {},
            onOpenSample() {},
            density,
            importedProfile,
          }),
        ),
      );

    // Without an import the button is offered and the panel is absent.
    const bare = mount(null);
    assert.match(bare, /Import profile…/);
    assert.doesNotMatch(bare, /Vendor profile vs this compiled structure/);

    // 1. The surface's own export, re-imported, is agreement — in both densities.
    for (const density of ["dense", "roomy"]) {
      const html = mount(readProfileFile(profileToJson(profile), "adt-a01-profile.json"), density);
      assert.match(html, /Vendor profile vs this compiled structure/);
      assert.match(html, /The compiled structure is the specification/, "does not say which side is authoritative");
      assert.equal(count(html, "unchanged"), profile.rows.length, `${density}: not every row is unchanged`);
      assert.equal(count(html, "changed"), 0);
      assert.equal(count(html, "added"), 0);
      assert.equal(count(html, "removed"), 0);
      assert.match(html, /agrees with the compiled structure/);
      assert.doesNotMatch(html, /Repaired on import/, `${density}: a clean round trip produced a warning`);
    }

    // 2. A tampered file shows the library's sentence verbatim and no diff at all.
    const broken = "{ this is not json";
    const expected = parseProfile(broken);
    assert.ok("error" in expected);
    const errHtml = mount(readProfileFile(broken, "broken.json"));
    assert.ok(errHtml.includes(escapeHtml(expected.error)), "the library's error sentence is not shown verbatim");
    assert.match(errHtml, /Could not read the file/);
    assert.doesNotMatch(errHtml, /data-diff=/, "an unreadable file must not render counts");

    // 3. A repaired file shows the repair, and a softened rule shows before -> after.
    const tampered = JSON.parse(profileToJson(profile));
    tampered.counts.must = "thirty-five";
    const must = tampered.rows.find((r) => r.obligation === "must");
    must.obligation = "optional";
    must.usage = ["O"];
    const parsed = parseProfile(JSON.stringify(tampered));
    assert.ok(!("error" in parsed) && parsed.warnings.length >= 1);
    const repHtml = mount(readProfileFile(JSON.stringify(tampered), "vendor.json"));
    assert.match(repHtml, /Repaired on import/);
    for (const w of parsed.warnings) assert.ok(repHtml.includes(escapeHtml(w)), `warning not shown verbatim: ${w}`);
    assert.equal(count(repHtml, "changed"), 1);
    assert.equal(count(repHtml, "unchanged"), profile.rows.length - 1);
    assert.match(repHtml, /Must build[\s\S]*?→[\s\S]*?Optional/, "the changed row does not show before -> after");
    assert.ok(repHtml.includes(escapeHtml(must.label)), "the changed row does not carry its label");
    // The compiled table is untouched: the vendor's softening changed no count in the chips.
    assert.match(
      repHtml,
      new RegExp(`Must build(<!-- -->)? <span[^>]*>${profile.counts.must}</span>`),
      "the compiled must count changed",
    );

    // 4. A profile from a different structure renders as added and removed positions.
    const other = resolved.structures.find((s) => s.id !== resolved.structure.id) ?? null;
    const otherResolved = other
      ? await workbench.resolve(other.useCaseId, other.variant ?? other.id)
      : await workbench.resolve("claim", undefined);
    assert.ok(otherResolved && otherResolved.structure.id !== resolved.structure.id, "no second structure to compare");
    const foreign = buildProfile(otherResolved.structure, otherResolved.tables);
    const forHtml = mount(readProfileFile(profileToJson(foreign), "other.json"));
    assert.ok(count(forHtml, "added") > 0, "a foreign profile adds nothing?");
    assert.ok(count(forHtml, "removed") > 0, "a foreign profile removes nothing?");
    assert.match(forHtml, /The file describes/, "does not note the structure mismatch");
    assert.match(forHtml, /Compiled structure \(specification\)/);
    assert.match(forHtml, /Vendor&#x27;s file \(claim\)/);
  });
});
