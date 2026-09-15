/* ==========================================================================
 * FIXTURE — placeholder data so the shell compiles and runs before the
 * compiled spec lands.
 *
 * Everything here is shaped exactly like the real thing, so swapping in the
 * compiled spec requires NO component changes: produce `Region[]`, `Token[]`,
 * `StructureNode[]` and `Finding[]` from `src/spec` and hand them to SplitView.
 *
 * PROVENANCE HONESTY: every `quote` below is VERBATIM text extracted from the
 * NPHIES Confluence pages named in the same `source` object (MSH 7766363,
 * EVN 7766378, PID 7766393, PV1 7766425, AL1 7766469, DG1 7766496). The
 * run-together sentences are how the source tables actually read. No quote in
 * this file is paraphrased or invented. The FINDING TITLES are ours; the
 * quotes are theirs.
 * ========================================================================== */

import type {
  Finding,
  Provenance,
  Region,
  Severity,
  StructureNode,
  Token,
  TokenKind,
  UseCase,
  Usage,
} from "./types";

/* --------------------------------------------------------------- message -- */

/**
 * An ADT^A01 shaped after `spec-source/golden/HL7 v2.5.1/ADT/ADT_sample03.txt`,
 * with two deliberate structural defects so every severity is exercised:
 *   - PID-7 Date/Time of Birth is absent      -> error  (usage R)
 *   - PID-3 assigning authority OID ends .9   -> error  (fixed value mismatch)
 *   - MSH-5 universal ID ends .9              -> warn   (optional but pinned)
 */
export const FIXTURE_MESSAGE = [
  "MSH|^~\\&|CW^2.16.840.1.113883.3.3731.1.2.1.15000000112233^ISO|SendO^15000000112233^ISO|CDR^2.16.840.1.113883.3.3731.1.2.9^ISO|nphies^2.16.840.1.113883.3.3731.1.2.2^ISO|20250213125421+0300||ADT^A01|HL7103|P|2.5.1",
  "EVN|A01|20250213125421",
  "PID|1|226785|30511223344557^^^HealthId&2.16.840.1.113883.3.3731.1.1.100.9&ISO||ALSALOOM^Aziz^^|||M|||SAU||0500000000^PRN^CP",
  "PV1|1|I|ME^^^SENDO&15000000112233&ISO|88|||00TEST1980^Test^Test^^^DR.^^^&2.16.840.1.113883.3.3731.1.2.1&ISO",
  "AL1|1|DALG^Drug Allergy^|387207008^Ibuprofen^2.16.840.1.113883.6.96|U^Unkown^2.16.840.1.113883.18.55||20250128",
  "DG1|1|I10|J45.909^Unspecified asthma, uncomplicated^2.16.840.1.113883.6.90||20250213125421|A",
].join("\n");

/* ------------------------------------------------------------ field spec -- */

interface FieldSpec {
  no: number;
  name: string;
  dataType: string;
  usage: Usage;
  maxRpt?: string;
  /** VERBATIM guidance cell, or undefined when the cell is empty in the source. */
  guidance?: string;
  /** Structural value the spec pins. */
  fixedValue?: string;
  /** Forced severity for the fixture's deliberate defects. */
  defect?: { severity: Severity; title: string; detail: string; code: string };
}

interface SegmentSpec {
  id: string;
  name: string;
  pageId: string;
  pageTitle: string;
  /** MSH numbers its fields one higher than the pipe index (MSH-1 IS the separator). */
  msh?: boolean;
  fields: FieldSpec[];
}

const SEGMENTS: SegmentSpec[] = [
  {
    id: "MSH",
    name: "Message Header",
    pageId: "7766363",
    pageTitle: "MSH",
    msh: true,
    fields: [
      { no: 2, name: "Encoding Characters", dataType: "ST", usage: "R", maxRpt: "1", guidance: "Used as per HL7 v2 standards. Example: ^~\\&" },
      { no: 3, name: "Sending Application", dataType: "HD", usage: "R", maxRpt: "1", guidance: "Universal ID = participant application OID issued e.g.:2.16.840.1.113883.3.3731. XXXX.Y" },
      { no: 4, name: "Sending Facility", dataType: "HD", usage: "R", maxRpt: "1", guidance: "Universal ID = NHIC Organization ID and it cannot exceed 50 characters" },
      {
        no: 5,
        name: "Receiving Application",
        dataType: "HD",
        usage: "O",
        maxRpt: "1",
        guidance: "Universal ID = 2.16.840.1.113883.3.3731.1.2.2",
        fixedValue: "2.16.840.1.113883.3.3731.1.2.2",
        defect: {
          severity: "warn",
          code: "FIXED_VALUE_MISMATCH",
          title: "MSH-5 universal ID does not match the pinned OID",
          detail:
            "Component 2 is 2.16.840.1.113883.3.3731.1.2.9 but the specification pins 2.16.840.1.113883.3.3731.1.2.2. The field is optional, so this does not block submission — but if you send it, send the pinned value.",
        },
      },
      { no: 6, name: "Receiving Facility", dataType: "HD", usage: "I", maxRpt: "1" },
      { no: 7, name: "Date/Time of Message", dataType: "TS", usage: "R", maxRpt: "1", guidance: "The zone offset is required.YYYYMMDDMMHHSS+/-ZZZZ" },
      { no: 8, name: "Security", dataType: "ST", usage: "I", maxRpt: "1" },
      { no: 9, name: "Message Type", dataType: "MSG", usage: "R", maxRpt: "1", guidance: "Type of message being transmitted and the trigger event." },
      { no: 10, name: "Message Control ID", dataType: "ST", usage: "R", maxRpt: "1", guidance: "String that uniquely identifies the message. Must be unique to the sending facility." },
      { no: 11, name: "Processing ID", dataType: "PT", usage: "I", maxRpt: "1" },
      { no: 12, name: "Version ID", dataType: "VID", usage: "R", maxRpt: "1", guidance: "HL7 version used in the message. We recommend and use version 2.5.1 as the default. We also support all live HL7 versions from version 2.1 through to version 2.5.1." },
    ],
  },
  {
    id: "EVN",
    name: "Event Type",
    pageId: "7766378",
    pageTitle: "EVN",
    fields: [
      { no: 1, name: "Event Type Code", dataType: "ID", usage: "I", maxRpt: "1" },
      { no: 2, name: "Recorded Date Time", dataType: "TS", usage: "O", maxRpt: "1", guidance: "The date on and time at which the event was triggered on the sending system. If this field is empty, MSH.7 is used instead.YYYYMMDDHHMMSS" },
    ],
  },
  {
    id: "PID",
    name: "Patient Identification",
    pageId: "7766393",
    pageTitle: "PID",
    fields: [
      { no: 1, name: "Set ID", dataType: "SI", usage: "O", maxRpt: "1" },
      { no: 2, name: "Patient ID", dataType: "CX", usage: "I", maxRpt: "1" },
      {
        no: 3,
        name: "Patient Identifier List",
        dataType: "CX",
        usage: "R",
        maxRpt: "1",
        guidance:
          "Health ID is required and must be the first repeat. If Health ID is not provided the message will be rejected.This ID is obtained from NHIC Patient Registry.Assigning Authority must be 2.16.840.1.113883.3.3731.1.1.100.1Universal ID must be ISO",
        fixedValue: "2.16.840.1.113883.3.3731.1.1.100.1",
        defect: {
          severity: "error",
          code: "FIXED_VALUE_MISMATCH",
          title: "PID-3 assigning authority is not the Health ID authority",
          detail:
            "The assigning authority reads 2.16.840.1.113883.3.3731.1.1.100.9. The specification requires 2.16.840.1.113883.3.3731.1.1.100.1 with universal ID type ISO. NPHIES rejects the message when the Health ID cannot be resolved.",
        },
      },
      { no: 4, name: "Alternate Patient ID – PID", dataType: "CX", usage: "I", maxRpt: "No max", guidance: "Alternative patient identifiers are not supported for nphies." },
      { no: 5, name: "Patient Name", dataType: "XPN", usage: "O", maxRpt: "No max" },
      { no: 6, name: "Mother’s Maiden Name", dataType: "XPN", usage: "I", maxRpt: "No max" },
      {
        no: 7,
        name: "Date/Time of Birth",
        dataType: "TS",
        usage: "R",
        maxRpt: "1",
        guidance:
          "Date time of birth as Gregorian date with format YYYYMMDD. Hours, minutes and seconds are not requirede.g. 20130113",
        defect: {
          severity: "error",
          code: "MISSING_REQUIRED",
          title: "PID-7 Date/Time of Birth is absent",
          detail:
            "Usage is R, so this field must be populated. Send a Gregorian date as YYYYMMDD; hours, minutes and seconds are not required.",
        },
      },
      { no: 8, name: "Administrative Sex", dataType: "IS", usage: "I", maxRpt: "1" },
      { no: 11, name: "Patient Address", dataType: "XAD", usage: "I", maxRpt: "No max" },
      { no: 13, name: "Home Phone Number", dataType: "XTN", usage: "I", maxRpt: "No max" },
    ],
  },
  {
    id: "PV1",
    name: "Patient Visit",
    pageId: "7766425",
    pageTitle: "PV1",
    fields: [
      { no: 1, name: "Set ID", dataType: "SI", usage: "I", maxRpt: "1" },
      { no: 2, name: "Patient Class", dataType: "IS", usage: "R", maxRpt: "1", guidance: "SHALL contain one of the following values out of the “HL7 Patient Class” value-set" },
      { no: 3, name: "Assigned Patient Location", dataType: "PL", usage: "O", maxRpt: "1", guidance: "Valued when admitting inpatient (MSH.9 Message Type is ADT^A01).The following fields are accepted:Table 10.1" },
      { no: 4, name: "Admission Type", dataType: "IS", usage: "R", maxRpt: "1", guidance: "Refer to Method of Admission value-set." },
      { no: 7, name: "Attending Doctor", dataType: "XCN", usage: "O", maxRpt: "No max", guidance: "Valued when admitting inpatient (MSH.9 Message Type is ADT^A01).Multiple repeats can be supplied.Provider Store requires the National Provider ID and Assigning Authority." },
    ],
  },
  {
    id: "AL1",
    name: "Patient Allergy Information",
    pageId: "7766469",
    pageTitle: "AL1",
    fields: [
      { no: 1, name: "Set ID", dataType: "SI", usage: "I", maxRpt: "1" },
      { no: 2, name: "Allergy Type", dataType: "CE", usage: "R", maxRpt: "1", guidance: "If Allergy Type is present, then Identifier is required.The following fields are accepted:“Allergy Type” Value Set" },
      { no: 3, name: "Allergen Code Mnemonic Description", dataType: "CE", usage: "R", maxRpt: "1" },
      { no: 4, name: "Allergy Severity", dataType: "CE", usage: "O", maxRpt: "1" },
      { no: 6, name: "Identification Date", dataType: "DT", usage: "O", maxRpt: "1", guidance: "Date of identificationFormat: YYYY[MM[DD]]" },
    ],
  },
  {
    id: "DG1",
    name: "Diagnosis",
    pageId: "7766496",
    pageTitle: "DG1",
    fields: [
      { no: 1, name: "Set ID", dataType: "SI", usage: "I", maxRpt: "1" },
      { no: 2, name: "Diagnosis Coding Method", dataType: "ID", usage: "I", maxRpt: "1" },
      { no: 3, name: "Diagnosis Code", dataType: "CE", usage: "R", maxRpt: "1", guidance: "The Identifier and Name of Coding System are required.The following fields are accepted:Table 13.1" },
      { no: 5, name: "Diagnosis Date/Time", dataType: "TS", usage: "O", maxRpt: "1" },
      { no: 6, name: "Diagnosis Type", dataType: "IS", usage: "O", maxRpt: "1", guidance: "“Type of Diagnosis”" },
    ],
  },
];

/* --------------------------------------------------------------- helpers -- */

const ROOT_PATH = "ADT^A01";

function provenance(seg: SegmentSpec, f?: FieldSpec): Provenance | undefined {
  if (!f) {
    return {
      pageId: seg.pageId,
      pageTitle: seg.pageTitle,
      row: seg.id,
      quote: `${seg.id} — ${seg.name}`,
    };
  }
  if (!f.guidance) return undefined;
  return {
    pageId: seg.pageId,
    pageTitle: seg.pageTitle,
    row: `${seg.id}.${f.no}`,
    quote: f.guidance,
  };
}

function severityFor(f: FieldSpec | undefined, present: boolean): Severity {
  if (f?.defect) return f.defect.severity;
  if (!f) return "info";
  if (f.usage === "I") return "ignored";
  if (f.usage === "R" || f.usage === "M") return present ? "ok" : "error";
  if (f.usage === "R2") return present ? "ok" : "warn";
  if (f.usage === "NP") return present ? "error" : "ok";
  if (f.usage === "X") return present ? "warn" : "ok";
  return present ? "ok" : "info";
}

const IGNORED_REASON =
  "The NPHIES segment table marks this field usage I: it is parsed, accepted and then discarded. Populating it costs you build effort and buys nothing.";

/* --------------------------------------------------- tokenizer (HL7-ish) -- */

/**
 * Cosmetic only, and deliberately OUTSIDE SplitView: SplitView takes tokens as
 * geometry and knows nothing about HL7 delimiters. A FHIR/CDA adapter supplies
 * its own tokenizer of the same shape.
 */
function tokenizeHl7(lines: string[]): Token[] {
  const out: Token[] = [];
  const push = (line: number, startCol: number, endCol: number, kind: TokenKind) => {
    if (endCol > startCol) out.push({ line, startCol, endCol, kind });
  };
  lines.forEach((text, i) => {
    const line = i + 1;
    push(line, 0, 3, "name");
    let run = 3;
    while (run < text.length) {
      const ch = text[run];
      if (ch === "|" || ch === "^" || ch === "~" || ch === "&" || ch === "\\") {
        push(line, run, run + 1, "punct");
        run++;
        continue;
      }
      let j = run;
      while (j < text.length && !"|^~&\\".includes(text[j])) j++;
      const body = text.slice(run, j);
      const kind: TokenKind = /^\d+(\.\d+)+$/.test(body)
        ? "meta"
        : /^[0-9+\-]+$/.test(body)
          ? "number"
          : "value";
      push(line, run, j, kind);
      run = j;
    }
  });
  return out;
}

/* ----------------------------------------------------------- build model -- */

interface BuiltModel {
  regions: Region[];
  tokens: Token[];
  tree: StructureNode[];
  findings: Finding[];
}

function build(): BuiltModel {
  const lines = FIXTURE_MESSAGE.split("\n");
  const regions: Region[] = [];
  const findings: Finding[] = [];
  const segmentNodes: StructureNode[] = [];

  lines.forEach((text, li) => {
    const line = li + 1;
    const segId = text.slice(0, 3);
    const spec = SEGMENTS.find((s) => s.id === segId);
    const parts = text.split("|");

    const segPath = `${ROOT_PATH}/${segId}`;
    const segRegionId = `r:${segId}@${line}`;
    const fieldNodes: StructureNode[] = [];

    regions.push({
      id: segRegionId,
      line,
      startCol: 0,
      endCol: 3,
      label: `${segId} — ${spec?.name ?? "segment"}`,
      path: segPath,
      severity: "info",
    });

    let col = 3;
    for (let i = 1; i < parts.length; i++) {
      const sepCol = col;
      col += 1; // the '|'
      const value = parts[i];
      const start = col;
      const end = col + value.length;
      col = end;

      const fieldNo = spec?.msh ? i + 1 : i;
      const f = spec?.fields.find((x) => x.no === fieldNo);
      const present = value.length > 0;
      const sev = severityFor(f, present);

      // Skip untouched empties that carry no verdict: a 1-char hit region on a
      // bare pipe is noise, not information.
      if (!present && sev !== "error" && sev !== "warn") continue;
      if (!f && !present) continue;

      const id = `r:${segId}-${fieldNo}@${line}`;
      const path = `${segPath}/${segId}-${fieldNo}`;
      const label = f ? `${segId}-${fieldNo} ${f.name}` : `${segId}-${fieldNo}`;

      regions.push({
        id,
        line,
        startCol: present ? start : sepCol,
        endCol: present ? end : sepCol + 1,
        label,
        path,
        severity: sev,
      });

      fieldNodes.push({
        id: `n:${segId}-${fieldNo}`,
        label: `${segId}-${fieldNo}`,
        name: f?.name,
        path,
        severity: sev,
        dataType: f?.dataType,
        fixedValue: f?.fixedValue,
        rules: f ? [{ usage: f.usage, cardinality: f.maxRpt ? `1..${f.maxRpt === "No max" ? "*" : f.maxRpt}` : undefined }] : undefined,
        regionId: id,
        ignoredReason: sev === "ignored" ? IGNORED_REASON : undefined,
        source: spec ? provenance(spec, f) : undefined,
      });

      if (f?.defect) {
        findings.push({
          id: `f:${segId}-${fieldNo}`,
          severity: f.defect.severity,
          code: f.defect.code,
          title: f.defect.title,
          detail: f.defect.detail,
          path,
          regionId: id,
          line,
          rules: [{ usage: f.usage, cardinality: f.maxRpt ? `1..${f.maxRpt === "No max" ? "*" : f.maxRpt}` : undefined }],
          source: spec ? provenance(spec, f) : undefined,
        });
      } else if (sev === "ignored" && present) {
        findings.push({
          id: `f:${segId}-${fieldNo}`,
          severity: "ignored",
          code: "IGNORED_BY_NPHIES",
          title: `${segId}-${fieldNo} ${f?.name ?? ""} is discarded by NPHIES`.trim(),
          detail: IGNORED_REASON,
          path,
          regionId: id,
          line,
          rules: [{ usage: "I" }],
          source: spec ? provenance(spec, f) : undefined,
        });
      } else if (sev === "ok" && (f?.usage === "R" || f?.usage === "M")) {
        findings.push({
          id: `f:${segId}-${fieldNo}`,
          severity: "ok",
          code: "REQUIRED_PRESENT",
          title: `${segId}-${fieldNo} ${f.name} is present`,
          detail: undefined,
          path,
          regionId: id,
          line,
          rules: [{ usage: f.usage, cardinality: f.maxRpt ? `1..${f.maxRpt === "No max" ? "*" : f.maxRpt}` : undefined }],
          source: spec ? provenance(spec, f) : undefined,
        });
      }
    }

    // Missing required fields that never appear on the wire at all.
    if (spec) {
      const maxPresent = spec.msh ? parts.length : parts.length - 1;
      for (const f of spec.fields) {
        const already = fieldNodes.some(
          (n) => n.label === `${segId}-${f.no}`,
        );
        if (already) continue;
        if (f.no <= maxPresent) continue;
        if (f.usage !== "R" && f.usage !== "M" && f.usage !== "R2") continue;
        const path = `${segPath}/${segId}-${f.no}`;
        fieldNodes.push({
          id: `n:${segId}-${f.no}`,
          label: `${segId}-${f.no}`,
          name: f.name,
          path,
          severity: f.usage === "R2" ? "warn" : "error",
          dataType: f.dataType,
          rules: [{ usage: f.usage }],
          source: provenance(spec, f),
        });
        findings.push({
          id: `f:${segId}-${f.no}`,
          severity: f.usage === "R2" ? "warn" : "error",
          code: "MISSING_REQUIRED",
          title: `${segId}-${f.no} ${f.name} is absent from the segment`,
          detail: `The segment ends before ${segId}-${f.no}. Usage is ${f.usage}.`,
          path,
          line,
          rules: [{ usage: f.usage }],
          source: provenance(spec, f),
        });
      }
      fieldNodes.sort(
        (a, b) =>
          Number(a.label.split("-")[1]) - Number(b.label.split("-")[1]),
      );
    }

    const worst = fieldNodes.reduce<Severity>((acc, n) => {
      const rank: Record<Severity, number> = { error: 0, warn: 1, ok: 2, ignored: 3, info: 4 };
      return rank[n.severity] < rank[acc] ? n.severity : acc;
    }, "info");

    segmentNodes.push({
      id: `n:${segId}@${line}`,
      label: segId,
      name: spec?.name ?? "Unmapped segment",
      path: segPath,
      severity: worst,
      regionId: segRegionId,
      rules: [{ usage: "R", cardinality: "1..1" }],
      source: spec ? provenance(spec) : undefined,
      children: fieldNodes,
    });
  });

  const tree: StructureNode[] = [
    {
      id: "n:root",
      label: "ADT^A01",
      name: "Admit / visit notification",
      path: ROOT_PATH,
      severity: segmentNodes.some((s) => s.severity === "error")
        ? "error"
        : "warn",
      children: segmentNodes,
    },
  ];

  return { regions, tokens: tokenizeHl7(lines), tree, findings };
}

const MODEL = build();

export const FIXTURE_REGIONS: Region[] = MODEL.regions;
export const FIXTURE_TOKENS: Token[] = MODEL.tokens;
export const FIXTURE_TREE: StructureNode[] = MODEL.tree;
export const FIXTURE_FINDINGS: Finding[] = MODEL.findings;

/** Confluence base for provenance links; replace with the real space URL. */
export const CONFLUENCE_BASE = "";

/* ------------------------------------------------------------ use cases -- */

/**
 * The 26 NPHIES use cases, grouped into the five families the rail renders.
 * `status` reflects SPEC readiness, not message validity — sibling agents set
 * it as their extractions land.
 */
export const USE_CASES: UseCase[] = [
  // --- HL7 v2.5.1 -----------------------------------------------------------
  { id: "adt-a01", family: "hl7v2", code: "ADT^A01", label: "Admit / visit notification", status: "ready", blurb: "Inpatient admission published to NPHIES." },
  { id: "adt-a03", family: "hl7v2", code: "ADT^A03", label: "Discharge / end visit", status: "ready" },
  { id: "adt-a04", family: "hl7v2", code: "ADT^A04", label: "Register a patient", status: "ready" },
  { id: "adt-a08", family: "hl7v2", code: "ADT^A08", label: "Update patient information", status: "partial" },
  { id: "adt-a40", family: "hl7v2", code: "ADT^A40", label: "Merge patient identifier list", status: "partial" },
  { id: "adt-ack", family: "hl7v2", code: "ACK", label: "Acknowledgement / error response", status: "draft" },

  // --- FHIR R4 --------------------------------------------------------------
  { id: "fhir-lab-order", family: "fhir", code: "Bundle", label: "Laboratory order bundle", status: "ready" },
  { id: "fhir-lab-report", family: "fhir", code: "Bundle", label: "Laboratory report bundle", status: "ready" },
  { id: "fhir-rad-order", family: "fhir", code: "Bundle", label: "Radiology order bundle", status: "partial" },
  { id: "fhir-rad-report", family: "fhir", code: "Bundle", label: "Radiology report bundle", status: "partial" },
  { id: "fhir-med-request", family: "fhir", code: "Bundle", label: "Medication request (prescription)", status: "ready" },
  { id: "fhir-med-dispense", family: "fhir", code: "Bundle", label: "Medication dispense", status: "draft" },

  // --- CDA R2 ---------------------------------------------------------------
  { id: "cda-discharge", family: "cda", code: "CDA", label: "Discharge summary", status: "ready" },
  { id: "cda-maternal", family: "cda", code: "CDA", label: "Maternal discharge summary", status: "partial" },
  { id: "cda-newborn", family: "cda", code: "CDA", label: "Newborn discharge summary", status: "partial" },
  { id: "cda-outpatient", family: "cda", code: "CDA", label: "Outpatient encounter summary", status: "ready" },
  { id: "cda-operative", family: "cda", code: "CDA", label: "Operative notes", status: "draft" },
  { id: "cda-lab-results", family: "cda", code: "CDA", label: "Laboratory results report", status: "ready" },
  { id: "cda-rad-results", family: "cda", code: "CDA", label: "Radiology results report", status: "draft" },
  { id: "cda-iehr", family: "cda", code: "CDA", label: "iEHR summary (on-demand)", status: "missing" },

  // --- XDS / SOAP -----------------------------------------------------------
  { id: "iti-41", family: "xds", code: "ITI-41", label: "Provide and register document set-b", status: "ready" },
  { id: "iti-18", family: "xds", code: "ITI-18", label: "Registry stored query", status: "partial" },
  { id: "iti-43", family: "xds", code: "ITI-43", label: "Retrieve document set", status: "partial" },
  { id: "xds-metadata", family: "xds", code: "DocEntry", label: "Document metadata attributes", status: "draft" },

  // --- SSO ------------------------------------------------------------------
  { id: "sso-authn", family: "sso", code: "SAML", label: "Authentication request", status: "draft" },
  { id: "sso-metadata", family: "sso", code: "SAML", label: "Attributes & metadata synchronisation", status: "missing" },
];
