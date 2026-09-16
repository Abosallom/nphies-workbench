# Resume notes

The app is complete, redesigned, and deployed from `main`. `npx tsc --noEmit -p tsconfig.app.json`
is clean, `npm run build` succeeds, and `npm test` passes 93 tests — including one that drives
the built bundle through a real Chrome, from first-run onboarding to every surface.

## Run it

```bash
npm run dev      # the whole workbench, against the compiled spec
npm test         # golden round-trip · mutation · detector · boundary · skeleton · views · browser
npm run eval:ai  # opt-in, needs ANTHROPIC_API_KEY, never part of npm test
```

## What this round added

**Two layouts.** The dense instrument is unchanged. Presentation mode (header toggle, persisted as
`isit.density`) rescales the app through tokens alone — `--spacing`, the `--text-*` scale,
`--radius-*`, a warmer paper in light — plus one JS value: the virtualised row heights (20/22 →
26/30), because those are constants feeding `useVirtualRows` and a bigger type scale without
bigger rows overlaps.

**Charts, hand-written SVG, no dependency** (`src/ui/charts/`): `ProportionBar`, `Donut`,
`MiniBars`, `AnatomyMap`. Severity always ships with its glyph; identity uses four categorical
hues (`--nw-cat-1..4`) computed and validated against both surfaces. Anatomy above every check;
obligations on Build; provenance and defect charts on Coverage — which also fixed a pre-existing
misuse of verdict colour for a provenance share.

**Deterministic detection** (`src/lib/detect.ts`): which use case and variant a paste is, from the
compiled envelope fingerprints, graded certain / probable / possible with the verbatim fragment
as evidence. 60/60 official samples identify their own use case; 57 their exact structure; the
three the corpus genuinely cannot separate are returned as ties and pinned by name in
`tests/detect.test.mjs`. The banner in Check names the evidence and OFFERS the switch — never
performs it.

**AI, structurally beside the verdicts.** `Advisory` (`src/lib/advisory.ts`) has no severity,
provenance or code, so `summarise()` rejects it at compile time — `tests/advisory.test.mjs`
compiles a fixture and asserts it FAILS. `tests/boundary.test.mjs` asserts no engine file imports
the AI layer or the SDK; the engine harness stubs `fetch` to throw. The model only ever sees a
spec-driven **skeleton** (`src/lib/skeleton.ts`) — a value survives only where a rule pins it,
binds it, or marks it structural; an 87 KB CDA is 9.7k tokens with no name, id, date or address,
asserted over every sample. Second opinion and gap proposals live in `AdvisoryPanel` below the
split view; a proposal becomes a verdict only when the analyst clicks "Re-check as X" and
`check()` re-runs with that condition declared.

**Ingest** (`src/lib/ingest.ts`, `IngestView`): spreadsheets and CSV (xlsx `import()`ed on demand —
it is 7.2 MB), deterministic name mapping, optional model proposals over column names only, and
message generation by filling an official template's values — never from scratch.

**Profile import** (`profile.ts` `parseProfile` / `reconcileProfile`, on Build): a vendor's profile
diffed against this hospital's compiled structure; the diff is the deliverable, nothing is applied.

**Onboarding** (`Welcome.tsx`): a first-run surface stating what the tool is for and what makes it
trustworthy, with "Check an official sample" as the one-click tour.

## Defects found and fixed this round

1. **`check.ts` never judged a CDA section's field rows.** Every section table opens with a row for
   the section itself, and that row was looked up INSIDE the very node it names, so it never
   matched and `if (node.children.length && instances.length)` skipped every child. Zero CDA
   findings carried a `specNodeId`. Fixed; required rules judged across the golden set went
   790 → 1,594 and mutation scores 83/77/60 → **97/93/75**. Floors raised to 96/92/74.
2. **`adaptStructure` dropped `role: "omit"` rows** — the compiler's name for the 538 HL7 fields
   NPHIES ignores. Explain never showed one; Build's "Do not build" was always empty. ADT^A01 now
   reports 253 rules, 180 ignored.
3. **`AiExplain` sent raw message lines to the API.** Replaced by the skeleton window; its
   severity-toned confidence badge (a verdict colour on a model output) is gone too.
4. **`autoMapByName` normalised locators like labels**, so a column named `PID-3.1` mapped,
   confirmed, onto PID-31. Locators are matched as locators now.
5. **`CoverageView` coloured a provenance share with ok/warn/error.** Replaced with a bar.
6. Reaching CDA section rows surfaced **two more published-rule-vs-published-sample
   contradictions** (a section title typo in both Immunization Summary samples; a Data Processing
   entry nested one level deeper than Table 138 states). Pinned; six in total.

## Not done — pick up here

1. **Run `npm run eval:ai` once with a real key** (`--limit 3` first). It measures rescue rate,
   false alarms on clean samples and undermining; "better" is defined in its header. Nothing has
   yet shown the second opinion helps — only that it cannot hurt a score.
2. **Ingest v2**: repeating groups and adding nodes are out of scope (recorded as `skipped`);
   FHIR relative locators hit the Bundle-level element first; the sheet is per use case.
3. **`explainPayloadPreview` in `ai.ts`** so AiExplain's preview is byte-exact with what is sent.
4. **ACK detection** cannot tell ADT from ORU without a trigger in MSH-9.2; ask NPHIES whether ACKs
   always echo it.
5. **Compiler**: 75 of 142 CDA tables are cited by no member; the header group has no `specRefs`;
   34 section members have no table. Coverage would rise further with those linked.

## Known limits to carry forward

- SOAP/XDS is 55% independently sourced; every XDS finding says which kind of evidence it rests on.
- `oru-vitals` and `saml-sso` have no official sample.
- Five official samples are themselves defective; catalogued and reported as such.
- Three official samples are ambiguous from the message alone (dispense pairs; the structured
  radiology report's Composition profile). Reported as ties, never guessed.
- `spec-source/` is gitignored; `npm run compile` needs it, the app and tests do not.

Plan: `~/.claude/plans/redesign-the-pages-to-groovy-fairy.md`
