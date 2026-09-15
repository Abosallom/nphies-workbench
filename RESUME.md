# Resume notes

Stopped mid-W2 on request. Everything below is committed and typechecks clean
(`npx tsc --noEmit -p tsconfig.app.json` → exit 0).

## Run it

```bash
npm run dev      # shell + design system render against src/ui/fixture.ts
```

## Where the build got to

**Done (W1 + W1b + W2 Fix/Engine):**
- `src/spec/` — compiled spec bundle. 3510 SpecNodes, 55 MessageStructures,
  123 value sets / 44,508 concepts, HL7 datatype dictionary, error catalogue,
  OID constants + placeholder quarantine, spec-defects, sample-defects.
- `src/lib/structure.ts` — the contract: one SpecNode over four locator kinds;
  parse and emit share a StructureTree so they stay exact inverses.
- `src/lib/parse/{hl7v2,cda,fhir,xds,saml}.ts` and `src/lib/emit/*` — format
  parsers and emitters, spec-driven, no per-use-case branching.
- `src/lib/check.ts` + `src/lib/findings.ts` — the structural checker.
- `src/ui/` — design system + SplitView.
- `scripts/compile-spec.mjs` (re-runnable) and `scripts/gate-golden.mjs`.

**Golden gate:** 99.97% resolution over 60 official NPHIES samples
(HL7 100% · CDA 99.9% · FHIR 100% · SOAP/XDS 100%, but only **55.0% independent**
— the rest resolves against rules derived from those same samples).

## Not done — pick up here

1. `src/usecases/<id>/index.ts` — 26 modules. Data only (structureId, variants,
   golden sample refs, templateColumns filtered to `role === 'data'`, notes).
   Registry is discovered via `import.meta.glob`, so agents can work in parallel
   with zero conflicts.
2. `src/views/` — Build · Check · Explain · Readiness · ErrorDecoder · Coverage.
   Only `Shell.tsx` and `Placeholder.tsx` exist.
3. `src/lib/ai.ts` — bring-your-own-key Anthropic integration (`claude-opus-5`,
   `messages.parse()` + `zodOutputFormat`, key in localStorage).
4. `src/App.tsx` — wire views into the shell, drop the fixture.
5. `tests/` — golden round-trip + structural mutation testing per format.
   **This is the one that proves the product**: break a golden sample nine ways
   and confirm the checker names the right defect at the right location, scoring
   detection / location / classification separately, plus false positives on
   unmutated samples.
6. Create the GitHub repo and deploy (`.github/workflows/deploy.yml` is ready;
   Vite `base` is `/nphies-workbench/`).

## Known limits to carry forward

- SOAP/XDS is only 55% independently sourced; `soapPath` just 32.7%. Every XDS
  finding must show that provenance rather than presenting it as normative.
- `oru-vitals` and `saml-sso` have no official sample — unverifiable by round-trip.
- `cdaTemplateId 2.16.840.1.113883.3.3731.1.105.1` appears in none of the 617
  Confluence pages. Left unresolved on purpose.
- 5 official NPHIES samples are themselves defective (4 medication bundles carry
  `//` comments and are invalid JSON; one is malformed; 2 ITI-18 responses use
  lowercase `<soap:envelope>`). Catalogued in `src/spec/sample-defects.json`.
- `spec-source/` (617 cached pages + 62 golden samples) is gitignored — large and
  re-derivable. It must exist locally for `compile-spec.mjs` and the gate to run.

Plan: `~/.claude/plans/plan-it-using-fable-pure-crayon.md`
