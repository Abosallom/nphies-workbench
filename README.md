# ISIT

**NPHIES message structure workbench.**

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
| **Ingest** | "Here is a spreadsheet from my HIS — map its columns and fill an official message with my rows." |
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
| The built app, driven in a real browser | onboarding → sample → detector → check → anatomy → presentation mode → every surface |
| Official samples that parse | **60 / 60** |
| Byte-for-byte round trips (parse → emit) | **60 / 60** |
| Official samples whose use case the detector identifies | **60 / 60** (57 to the exact structure; 3 genuine ties reported as ties) |
| Unaccounted-for errors on official messages | **0** |
| Required rules judged across the official samples | **1,594** (was 790 before the CDA section fix) |
| Structural mutations detected | **97%** |
| …classified as the right kind of defect | **93%** |
| …located at the right line | **75%** |

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
- **Six places where a published rule contradicts a published sample** are reported rather
  than resolved; they are pinned in `tests/golden.test.mjs` so a seventh cannot appear
  unnoticed. Two of them only became visible once the checker reached CDA section rows.
- **Three official samples are genuinely ambiguous from the message alone** — the uncontrolled
  and Raqeeb dispense bundles pin identical fixed values, and the structured radiology report
  carries the embedded-PDF Composition profile. The detector returns both candidates with the
  evidence; it never guesses, and a model is never allowed to guess for it.

## Two layouts

The dense **instrument** is the working surface for an analyst. **Presentation** mode — the
second toggle in the header — rescales the whole app through CSS tokens (type, spacing, radii,
a warmer paper in light mode) and adds the charts: the message anatomy above every check, the
build-vs-skip donut, the coverage and provenance bars. Severity colours are identical in both;
a verdict never looks softer because the room got bigger.

Colour is spoken for. Red, amber, green and grey mean error, warning, valid and ignored, and
nothing else. The four chart hues that encode *identity* were computed against both surfaces
and pass colour-blind separation, chroma and contrast checks — two candidates that looked fine
by eye failed and were cut.

## Optional AI

Structural checking never uses a model, and a model's output can never become a verdict —
`Advisory` is a different type with no severity, provenance or code, so the functions that
score a message reject it at compile time. With your own Anthropic API key (stored in your
browser, sent only to Anthropic) the Check surface offers, beside the findings:

- a **second opinion** on the findings, each claim quoting the fragment it rests on, with
  unverifiable claims dropped and counted;
- **answers to the questions the checker could not settle** — a conditional rule, an unknown
  element, an unmapped code — as proposals with one deterministic action each ("Re-check as
  *Report*"), so the analyst's click, not the model, produces the verdict;
- **column and terminology mapping** on the Ingest surface.

Nothing sends the document. The model sees a spec-driven **skeleton** in which a value survives
only where a rule pins it, binds it to a value set, or marks it structural — an 87 KB discharge
summary becomes 9.7k tokens with no name, identifier, date or address in it, and a test over
every official sample asserts exactly that. Every button states what it will send and offers to
show the exact text first.

`npm run eval:ai` (key required, never part of `npm test`) measures whether the second opinion
helps — rescue rate on mutations the checker missed, false alarms on clean official messages,
and how often it undermines a correct verdict — without any of it touching the scores above.

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
    detect.ts      which use case and variant a pasted message is, with the evidence
    skeleton.ts    spec-driven redaction — the only message-derived text a model ever sees
    advisory.ts    the model's output type; structurally incapable of being a Finding
    gaps.ts        where the checker gave up, as closed-option questions
    ingest.ts      spreadsheets → column mapping → messages filled from an official template
    ai.ts          optional, bring-your-own-key
  ui/          design system — presentational only, knows nothing of HL7/FHIR/CDA/SOAP
    charts/    hand-written SVG: ProportionBar · Donut · MiniBars · AnatomyMap
  views/       Build · Check · Explain · Ingest · Readiness · Error Decoder · Coverage · Welcome
tests/         golden round-trip · structural mutation · detector · boundary · skeleton ·
               view mount · a real browser driven end to end
```

Parse and emit are inverses over one shared structure tree, so Build and Check cannot drift
apart — the same compiled rules drive both. That is the central technical bet, and the
round-trip test is what proves it.
