# NPHIES Message Structure Workbench

**Make hospitals onboarding their HIS to NPHIES faster, by getting the message structure right
the first time.**

Onboarding stalls in one loop: submit, get rejected, guess which part of the message was
wrong, resubmit. Almost all of that is *structure* — a segment in the wrong order, a mandatory
field absent, a composite built with the wrong components, a missing `templateId`, a FHIR
bundle of the wrong type. This tool makes structural correctness verifiable **before** a
hospital ever submits, and pinpoints the exact defect when NPHIES rejects something.

It is a static, client-side page. **Nothing you paste ever leaves your browser.**

---

## What it does

| Surface | What it answers |
|---|---|
| **Check** ★ | "Here is what my HIS produced — what is structurally wrong with it, and where?" |
| **Build** | "What must my HIS actually populate for this message — and what can it skip?" |
| **Explain** | "What governs this position, and where in the specification does that come from?" |
| **Readiness** | "Which use cases have I verified, and which have I never checked?" |
| **Error Decoder** | "NPHIES returned this rejection — which part of my message caused it?" |
| **Coverage** | "Where is this tool's own knowledge incomplete or contradicted?" |

★ Check is the loop-closer. Build without Check just moves the guessing earlier.

**Telling a hospital what *not* to build matters as much as the rest.** 522 of 725 compiled
HL7 field rows are ignored by NPHIES outright; only 35 are truly mandatory. "Ignored" is a
designed state throughout the UI, not an absence.

## Covered

26 use cases across five families, compiled from 289 published NPHIES specification pages:

- **HL7 v2.5.1** — ADT (17 events + ACK/NACK), Vital Signs ORU^R01
- **FHIR R4** — medication prescription & dispense (incl. Raqeeb controlled), laboratory
  orders & reports, radiology orders & reports
- **CDA R2** — discharge, maternal & newborn discharge, operative notes, outpatient encounter,
  laboratory orders & results, radiology orders & results, and the on-demand iEHR /
  immunization documents
- **IHE XDS.b / SOAP** — ITI-41, ITI-18, ITI-43
- **SSO** — the SAML assertion

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # golden round-trip, structural mutation, and view suites
npm run build    # typecheck + production bundle into dist/
```

`npm run compile` rebuilds `src/spec/` from the raw Confluence scrape in `spec-source/`
(gitignored, large, re-derivable). The compiled bundle and the 62 official sample messages are
both committed, so the app and the tests run without it.

## How far to trust it

The engineering rule throughout is that **a confidently wrong structural verdict is worse for
a hospital than no tool at all**, so the workbench is built to say what it does not know:

- Every finding cites the Confluence page and the verbatim quote it rests on. A rule that was
  recovered from an official sample rather than published says so, and never gets laundered
  into a normative one.
- Rules with no evidence at all are counted and reported as *not checked*, never silently
  passed.
- Where two published pages disagree, both quotes and the applied resolution are shown.
- Value sets hosted by NHIC are not shipped; membership for those is reported as **not
  checked** rather than as a pass.

Measured, and enforced by `npm test`:

| | |
|---|---|
| Official samples that parse | **60 / 60** |
| Byte-for-byte round trips (parse → emit) | **60 / 60** |
| Unaccounted-for errors on official messages | **0** |
| Structural mutations detected | **83%** |
| …classified as the right kind of defect | **77%** |
| …located at the right line | **60%** |

The mutation suite is the one that measures the product's actual claim: it breaks an official
message in a specific, realistic way and asks whether the checker names the right defect at the
right place. Detection, classification and location are scored separately and never averaged —
a checker that detects everything and locates nothing sends an integrator hunting through an
80KB document.

### Known limits

- **SOAP/XDS is only 55% independently sourced** (`soapPath` just 33%): most of it was
  recovered from the official samples rather than published. Every XDS finding carries that
  provenance. See the Coverage surface.
- **`oru-vitals` and `saml-sso` have no official sample**, so nothing round-trip verifies them.
- **Five official NPHIES samples are themselves defective** — four medication bundles carry
  `//` comments and are not valid JSON, two ITI-18 responses use a lowercase
  `<soap:envelope>`. Catalogued, so the workbench blames the sample and not your HIS.
- **Three places where a published rule contradicts a published sample** are reported rather
  than resolved; they are pinned in `tests/golden.test.mjs` so a fourth cannot appear unnoticed.
- CDA section-level field rules are evaluated only where the section itself could be located;
  the count of members that could not be located is reported on every check.

## Optional AI

Structural checking never uses a model. With your own Anthropic API key (stored in your
browser's `localStorage`, sent only to Anthropic), the Check surface can additionally turn a
finding into a HIS-side fix. Every call is triggered by a click that states what will be sent.

## Layout

```
src/
  spec/        GENERATED — 3,515 compiled rules, 55 message structures, 123 value sets,
               the HL7 datatype dictionary, the error catalogue, OID quarantine, defect lists
  lib/
    structure.ts   the engine: one SpecNode over four locator kinds
    parse/ emit/   message ⇄ structure tree, exact inverses
    check.ts       parsed tree vs compiled structure → located findings
    workbench.ts   registry, parse/check pipeline, golden samples
    adapt.ts       engine shapes → presentational shapes
    profile.ts     the required surface, exportable for a HIS vendor
    errors.ts      the NPHIES error catalogue and its decoder
    ai.ts          optional, bring-your-own-key
  ui/          design system — presentational only, knows nothing of HL7/FHIR/CDA/SOAP
  views/       Build · Check · Explain · Readiness · Error Decoder · Coverage
tests/         golden round-trip · structural mutation · view mount
```

Parse and emit are inverses over one shared structure tree, so Build and Check cannot drift
apart — the same compiled rules drive both. That is the central technical bet, and the
round-trip test is what proves it.
