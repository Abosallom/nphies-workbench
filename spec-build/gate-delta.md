# Golden gate — before / after the six repairs

Measured by `scripts/gate-golden.mjs` against `src/spec/` as recompiled.
Full data: `spec-build/gate-report.json`. Run is deterministic (two consecutive
runs are byte-identical apart from `generatedAt`).

---

## READ THIS FIRST — the headline number is not the honest number

SOAP/XDS now resolves **100.0%**. That figure is **45% self-confirming**.

The ITI-41/18/43 structures were themselves derived from the same golden
samples the gate measures them against, so resolving those samples proves
nothing about them. The compiled structures say so in their own notes:

> "Because these members were derived from the golden samples, resolving a
> golden sample against them is not independent confirmation of the spec."
> — `src/spec/structures.json`, `xds-iti41.notes`

| SOAP/XDS | resolved | of 1023 | rate |
|---|---:|---:|---:|
| Overall (what the gate reports) | 1023 | 1023 | **100.0%** |
| Against **independently-sourced** rules only | 563 | 1023 | **55.0%** |
| Against rules read off these same samples (circular) | 460 | 1023 | 45.0% |

**55.0% is the honest SOAP/XDS number.** Circularity by element kind:

| kind | found | independent | circular | independent share |
|---|---:|---:|---:|---:|
| `soapPath` | 648 | 212 | 436 | **32.7%** |
| `xdsSlot` | 196 | 172 | 24 | 87.8% |
| `xdsStoredQueryId` | 2 | 2 | 0 | 100% |
| `xdsClassificationScheme` | 118 | 118 | 0 | 100% |
| `xdsIdentificationScheme` | 59 | 59 | 0 | 100% |

Per structure, share of members with no Confluence source:

| structure | members | sample-derived | share |
|---|---:|---:|---:|
| `xds-iti41` | 51 | 36 | 70.6% |
| `xds-iti18-response` | 25 | 17 | 68.0% |
| `xds-iti18-request` | 13 | 3 | 23.1% |
| `xds-iti43-response` | 15 | 1 | 6.7% |
| `xds-iti43-request` | 11 | 0 | 0% |

The element **tree** is the circular part. The XDS metadata **attributes**
(slot names, scheme UUIDs) come from Confluence metadata-optionality pages and
are genuinely independent — the XDS repair did not deepen circularity there, it
closed a real gap. It did deepen it under `soapPath`, which is now the weakest
kind in the whole bundle at 32.7% independent.

Provenance is tagged for SOAP/XDS only. CDA, FHIR and HL7 v2 compile from
Confluence tables rather than from the samples and are not circular in the same
way, but **this gate has not proved that rule by rule** — read no independence
figure into those formats.

---

## Before / after, identical methodology

`elementsFound` is unchanged at 2906 and no resolution rule was loosened, so
these columns are directly comparable.

| format | samples | before | after | Δ |
|---|---:|---|---|---|
| hl7v2 | 3 | 100% (162/162) | 100% (162/162) | — |
| cda | 16 | 97.9% (1297/1325) | **99.9% (1324/1325)** | +27 |
| fhir | 22 | 92.9% (368/396) | **100% (396/396)** | +28 |
| soap-xds | 19 | 35.3% (361/1023) | **100% (1023/1023)** | +662 |
| **overall** | **60** | **75.3% (2188/2906)** | **99.97% (2905/2906)** | **+717** |

| | before | after |
|---|---|---|
| samples fully resolved | 15/60 | **59/60** |
| structural mismatches (baseline checks) | 101 | **17** |
| unresolved (per-sample distinct, summed) | 718 | **1** |
| resolved only after normalisation | not recorded | 0 |

The baseline summary preserved for this pass carries per-format totals only, so
"718" is `2906 − 2188`, the same quantity the "after" column reports as 1. The
baseline's own `distinctUnresolvedIdentifiers` and its mismatch breakdown by
code were not preserved and are not reconstructed here.

Per element kind, after (baseline scope):

| kind | after | note |
|---|---|---|
| `cdaTemplateId` | 870/871 (99.9%) | the one remaining unresolved identifier |
| `cdaHeaderElement` | 289/289 | |
| `cdaSection` | 165/165 | |
| `fhirResourceType` | 198/198 | |
| `fhirProfile` | 177/177 | |
| `fhirBundleProfile` | 21/21 | |
| `hl7Segment` / `hl7Field` | 17/17, 145/145 | |
| `soapPath` | 648/648 | **only 32.7% independently sourced** |
| `xdsSlot` | 196/196 | 87.8% independent |
| `xdsClassificationScheme` | 118/118 | was 0/118 |
| `xdsIdentificationScheme` | 59/59 | was 0/59 |
| `xdsStoredQueryId` | 2/2 | |

A per-kind *before* column is not reconstructible from the preserved baseline
summary, which recorded per-format totals only. The two figures quoted as "was
0/118" and "was 0/59" come from `patch-xds-ebrim.json.closes`, which names them
explicitly. Nothing else is claimed.

---

## What each repair actually bought

| repair | claim | verdict |
|---|---|---|
| `patch-xds-ebrim` | close `xdsClassificationScheme` 0/118 and `xdsIdentificationScheme` 0/59, model the RegistryObjectList, fix 4 slot names | **Delivered, and the largest single gain.** Both scheme kinds 0% → 100%, and all 18 scheme UUIDs carry Confluence-backed derivation, so the gain is real and not circular. The ebRIM element tree it added is sample-derived and is what drags `soapPath` independence to 32.7%. |
| `patch-fhir-entries` | re-derive true `Bundle.entry` resourceTypes; the spec had profile names in the resourceType slot | **Delivered.** fhir 92.9% → 100%, and `fhirResourceType` is 198/198. The gate still tests for `phantom-resource-type` and `entry-type-not-in-structure`; neither fires on any sample now. (Whether they fired *before* is not recoverable — the baseline mismatch breakdown was not preserved.) |
| `patch-cda` | header model, section additions, OID collisions, NoInfo variant rule | **Delivered.** cda 97.9% → 99.9%; the ordered header group it added made the new order check possible at all. |
| `patch-literals` | un-mangle stored literals so a validator stops rejecting official values | **Delivered.** `resolvedOnlyAfterNormalisation` is 0 — no identifier now needs whitespace/footnote/case repair to match. |
| `patch-saml` | build the SAML SSO structure | **Cannot be confirmed by this gate.** No sample exists. Reported as unverified, not as passing. See below. |
| `sample-defects` | catalogue faults in the published samples | Not a spec repair; not measured here. The gate independently re-finds several of the same defects (broken JSON ×5, `<soap:envelope>` lower-case root ×2). |

### Did anything regress?

**No resolution regression.** No format, and no element kind, resolves worse
than the baseline; `elementsFound` is unchanged, so nothing was hidden by
narrowing what the gate looks at.

Two things got *worse-looking* because the gate now looks harder, which is not
a regression in the spec:

- structural mismatches read 88 rather than 17 once the new checks are counted.
  All 71 of the extra come from two new checks — 59 `xds-externalidentifier-name-unqualified`
  and 12 `xds-fixedvalue-without-value` — and both are real defects, described below.
- `overall.structuralMismatches` deliberately still counts baseline checks only,
  so the 101 → 17 comparison stays apples-to-apples;
  `structuralMismatchesIncludingExtendedChecks` carries the 88.

---

## Coverage added by this pass

263 new identifiers, 251 resolved (95.4%). Baseline + extended: 99.6% (3156/3169).

Every new check was negative-tested against a deliberately corrupted copy of a
real sample and fired correctly, so none of these are vacuous passes.

| new kind | result | what it proves |
|---|---|---|
| `cdaHeaderOrder` | 16/16 | All 16 CDA samples emit the header in the compiled normative sequence, including the Saudi `nphies:documentStatus` extension between `title` and `effectiveTime`. No sample carries a header element the compiled sequence fails to place. Checked against the spec's own ordered member list, not an invented sequence. |
| `fhirTwoFamilyRule` | 21/21 | All 10 FHIR structures state both `bundleType` and `firstEntryRule`, every pair is self-consistent (document→Composition, message→MessageHeader), and all 21 parseable samples obey it. |
| `xdsEbrimChildOrder` | 24/24 | ebRIM `Slot* Name? Description? Classification* ExternalIdentifier*` holds in every ExtrinsicObject and RegistryPackage. |
| `xdsObjectReference` | 49/49 | `classifiedObject` / `sourceObject` / `targetObject` all resolve in-message, except an RPLC `targetObject`, which points at a registry-resident document **by design** and is exempted rather than flagged. |
| `xdsClassificationNode` | 11/11 | Resolves, but see the conflict below. |
| `xdsObjectType` | 24/24 | Includes the malformed `ebxmlregrep` literal — see below. |
| `xdsExternalIdentifierName` | 59/59 | Resolved, but **0 of 59 exactly** — see below. |
| `xdsDocumentIdBinding` | 11/11 | `xdsb:Document/@id` matches an `ExtrinsicObject/@id` in all 11 ITI-41 samples. |
| `xdsObjectStatus`, `xdsDescription` | 13/13, 23/23 | |
| `xdsAssociationType` | **0/12** | See below — the one genuine failure. |

### `saml-sso-response`: unverified, not passing

No golden sample exists, so it is reported in `unverifiedStructures` and
contributes **nothing** to any resolution rate. Internal consistency only:
52 members, **0 errors, 0 warnings**. Root element agrees with
`envelope.rootElement`; all five declared namespace prefixes are used and no
label uses an undeclared one; every member carries provenance (all from page
7766254); no orphan attributes; no incoherent cardinalities; `signatureLevel:
"assertion"` is matched by a `ds:Signature` member inside `saml:Assertion`; no
duplicate siblings. **Internally consistent is not verified** — every one of
those 52 members rests on a single published XML skeleton that no accepted
message has ever been checked against.

Three HL7 v2 structures are likewise unexercised: `oru-r01`, `oru-ack`,
`oru-nack`. `oru-r01` carries one warning (two children of "Vital Signs Segment
Group" share the label "Notes and comments").

---

## Unresolved, ranked by frequency

### Baseline scope — one identifier left

| samples | kind | identifier | reason |
|---:|---|---|---|
| 1 | `cdaTemplateId` | `2.16.840.1.113883.3.3731.1.105.1` | OID not present in the compiled OID index |

### Extended scope — 12, all one root cause

| samples | kind | identifier |
|---:|---|---|
| 11 | `xdsAssociationType` | `HasMember` |
| 1 | `xdsAssociationType` | `urn:ihe:iti:2007:AssociationType:RPLC` |

**`rim:Association/@associationType` is a repair that did not fully land.** The
compiled node has correct provenance (page 17694743), a `derivation` of
`confluence+sample`, and a detailed `confidenceReason` documenting the
bare-token-vs-URN conflict on `HasMember`. It also has three `fixedValues` rows
— and **every one has a null `value`**. The rule records what the values *mean*
and how many samples carry them, but never what any of them *is*. The compiled
spec therefore cannot confirm or reject the `associationType` an HIS emits.
Re-extract the value column from page 17694743.

### Resolved, but flagged — read these before trusting the 100%

1. **`XDSDocumentEntry.patientId` and friends: 59/59 resolved, 0 exact.** Every
   `rim:ExternalIdentifier/rim:Name` matched only after stripping the IHE object
   qualifier. The compiled spec stores the bare attribute name (`patientId`,
   `uniqueId`, `sourceId`); the qualified literal the samples emit appears only
   inside guidance prose, never as a locator or fixed value. An HIS generating
   `rim:Name` from the compiled label emits the wrong name in every submission.
   Five distinct names affected: `XDSDocumentEntry.patientId`,
   `XDSDocumentEntry.uniqueId`, `XDSSubmissionSet.patientId`,
   `XDSSubmissionSet.sourceId`, `XDSSubmissionSet.uniqueId`.

2. **`RegistryPackage/@objectType` is `urn:oasis:names:tc:ebxmlregrep:...`** —
   no hyphen in `ebxml-regrep`, in all 11 ITI-41 samples, while `@status` in the
   *same files* spells it correctly. The compiled spec captures the typo as a
   sample-derived fixed value at `confidence: medium` and flags it rather than
   asserting it. This is a defect in the published samples, not in the spec.

3. **`XDSSubmissionSet` classification node
   `urn:uuid:a54d6aa5-d40d-43f9-88c5-b4633d873bdd`** differs by one character
   from the IHE constant `...bd1` and is one character from the samples' own
   `addressing:MessageID` `...bdc`. The compiled spec marks it
   `confidence: low` with `conflict.action: "flag for a human; do not
   auto-correct"`. The gate resolves it and raises `xds-uuid-conflict`. Needs
   NPHIES clarification; nothing in the 617 cached pages states it either way.

### Methodology weakness found and closed

The baseline gate resolved XDS UUIDs by regexing whole JSON blobs, so a UUID
appearing only inside a provenance quote, a `guidance` sentence or a
`confidenceReason` counted as spec knowledge — including one quoted inside a
sentence explaining that it is *wrong*. UUIDs are now classified by where they
sit (`locator.uuid` / `fixedValue` / prose-only). **Effect on the numbers: zero
— `prose-mention` resolutions are 0.** The loophole was real but nothing
depended on it.

---

## Ranked next actions

1. Trace `xds-iti41` (36/51 members) and `xds-iti18-response` (17/25) to cached
   Confluence pages, or mark them permanently sample-derived. Until then quote
   SOAP/XDS as 55.0%, not 100%.
2. Re-extract the `value` column for `rim:Association/@associationType`.
3. Store the object-qualified `XDSDocumentEntry.*` / `XDSSubmissionSet.*` names
   as structural literals, not prose.
4. Resolve or escalate the `a54d6aa5-...bdd` classification-node conflict.
5. Add `2.16.840.1.113883.3.3731.1.105.1` to the OID index.
