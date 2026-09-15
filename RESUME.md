# Resume notes

The app is complete and running. `npx tsc --noEmit -p tsconfig.app.json` is clean,
`npm run build` succeeds, and `npm test` passes 15 tests — including one that drives the built
bundle in a real browser.

## Run it

```bash
npm run dev      # the whole workbench, against the compiled spec
npm test         # golden round-trip · structural mutation · view mount
```

## What W2/W3 added on top of the earlier engine work

- `src/lib/workbench.ts` — use-case registry from the compiled manifest, encoding detection,
  parse/emit/check pipeline, golden-sample index, sample→variant resolution.
- `src/lib/adapt.ts` — engine shapes → the presentational shapes `src/ui` takes, plus the
  spec-only rule tree the Explain surface walks.
- `src/lib/profile.ts` — the required surface per message, exportable as Markdown/JSON/CSV.
- `src/lib/errors.ts` — the error catalogue plus a decoder that matches a pasted rejection by
  signature, code, or keyword overlap, and labels which of the three it used.
- `src/lib/highlight.ts`, `src/lib/ai.ts` (lazy-loaded SDK, BYO key).
- `src/views/` — Build · Check · Explain · Readiness · Error Decoder · Coverage, wired into
  `Shell.tsx`; the fixture is gone.
- `tests/` — the suites described in the README, run by `npm test`.

## Defects this work found and fixed in the engine

Each was a confidently-wrong verdict or a hang, found by the round-trip or mutation suite:

1. **`check.ts` counted composite parts as repeats** — one `PID-3` looked like eight, so every
   official ADT sample reported five phantom `cardinality-too-many` errors.
2. **Lexical XML nodes counted as element instances** — `structuredBody` with seven whitespace
   children looked like eight `structuredBody`s.
3. **A collection container counted instead of its repetitions** — a conformant 15-entry bundle
   reported fifteen `fullUrl`s at a `[1..1]` position. Cardinality is now judged per position.
4. **`emit/cda.ts` hung forever** on the first attribute of any element (`countAttrsIn` stepped
   back onto the `=` it had just consumed). This would have frozen the browser tab.
5. **Prose members judged as elements** — "CDA header constraints for this document type
   (Table 22)" was reported as a required element missing from five official documents. Such
   members are now transparent: not judged, children still checked.
6. **Relative member locators never matched** (`./text` inside `nonXMLBody`), so an embedded-PDF
   document was told it was missing the text element it plainly had.
7. **`import.meta.glob` guarded by `typeof import.meta.glob === "function"`** — that guard is
   left alone by the compile-time transform and is `false` in a browser, so the built app
   resolved the whole compiled spec to `{}`: no use cases, every surface dead, in dev and in
   the deployed build alike. Nothing caught it because the Node suites install their own
   resolver and the SSR suite runs under Vite's Node transform. `tests/browser.test.mjs` now
   drives the built bundle in headless Chrome so this class of bug cannot return.
8. **`resolveUseCase` threw on `saml-sso`** — the SAML structure cites four Confluence pages
   as `specRefs` marked `resolved: false`, and resolution treated one as a field table, tried
   to load a `fields/saml.json` that by design does not exist, and left the surface saying "no
   compiled structure". Unresolved refs and unshipped families are now skipped, and a test
   resolves EVERY use case rather than only the ones with a golden sample.
9. **Clicking a finding emptied the findings pane** — findings were scoped to the selection by
   path TEXT, but a finding's path is the checker's (`ADT^A03/MSH/MSH-6`) and a node's is built
   from labels (`Message Header/Receiving Facility`), so they never matched and the pane
   reported "nothing to report" about the element that had just reported something. Scoping is
   by node id now, with a path fallback for findings about something absent.
10. **The compiled CDA body locator was hard-coded to `structuredBody`**, so the official
   Radiology Results Embedded PDF sample was told it had no body. Fixed in
   `scripts/compile-spec.mjs`; re-running the compiler changes exactly that one field.

## Not done — pick up here

1. **Create the repo and deploy.** `.github/workflows/deploy.yml` is ready, Vite `base` is
   `/nphies-workbench/` under GitHub Actions, and `public/golden/` is committed so the build
   needs no `spec-source/`. Needs a GitHub repo to push to — ask before creating one.
2. **HIS extract ingest** (`xlsx` is already a dependency): upload a spreadsheet, auto-map its
   columns onto the profile, and generate messages. `suggestColumnMapping` in `ai.ts` is
   written and unused; `profile.ts` already produces the target list it needs.
3. **Mapping-profile import.** Export exists (Build → JSON/CSV/Markdown); reading one back so a
   vendor can reuse it across hospitals does not.
4. **CDA section-level coverage.** For some documents the section member matches but its field
   table is never evaluated — `cda-discharge-summary` judges 30 required rules where the table
   holds more. The count of unlocated members is surfaced on every check, so this under-reports
   rather than misreports, but it is the largest remaining coverage gap.
5. **Raise the mutation floors.** They sit at the measured numbers (80/72/60) in
   `tests/mutation.test.mjs`; each point of classification is a real improvement to Check.

## Known limits to carry forward

- SOAP/XDS is only 55% independently sourced; `soapPath` 33%. Every XDS finding shows that
  provenance rather than presenting it as normative.
- `oru-vitals` and `saml-sso` have no official sample — unverifiable by round-trip.
- `cdaTemplateId 2.16.840.1.113883.3.3731.1.105.1` appears in none of the 617 Confluence pages.
  Left unresolved on purpose.
- Five official NPHIES samples are themselves defective; catalogued in
  `src/spec/sample-defects.json` and reported as such when pasted into Check.
- Three published rules contradict their own published samples. Pinned in
  `tests/golden.test.mjs` so a fourth fails the suite.
- `spec-source/` (617 cached pages + 62 official samples) is gitignored — large and
  re-derivable. It must exist locally for `npm run compile` and the gate to run; the tests and
  the app do not need it.

Plan: `~/.claude/plans/plan-it-using-fable-pure-crayon.md`
