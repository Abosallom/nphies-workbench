/**
 * Shared presentational types for the NPHIES Workbench design system.
 *
 * NOTHING here knows about HL7, FHIR, CDA or SOAP. Every component in `src/ui`
 * takes data through these shapes, so the compiled spec (produced by sibling
 * agents) can be adapted into them without touching a single component.
 */

/* -------------------------------------------------------------- severity -- */

/**
 * Validator severity. Derived from NPHIES usage + cardinality:
 *   M / R missing        -> "error"   (blocks submission)
 *   R2 missing           -> "warn"    (required if known; never blocks)
 *   present & valid      -> "ok"
 *   I (ignored)          -> "ignored" (accepted then discarded by NPHIES)
 *   X present            -> "warn"
 *   NP present           -> "error"
 * "info" is for structural notes that carry no verdict.
 */
export type Severity = "error" | "warn" | "ok" | "ignored" | "info";

export const SEVERITY_ORDER: Record<Severity, number> = {
  error: 0,
  warn: 1,
  ok: 2,
  ignored: 3,
  info: 4,
};

/** Letter paired with every severity colour, so colour is never load-bearing alone. */
export const SEVERITY_GLYPH: Record<Severity, string> = {
  error: "E",
  warn: "!",
  ok: "✓",
  ignored: "–",
  info: "i",
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  error: "Error",
  warn: "Warning",
  ok: "Valid",
  ignored: "Ignored by NPHIES",
  info: "Note",
};

/* ----------------------------------------------------------------- usage -- */

/** NPHIES usage legend, page 171278410, cross-tabbed against cardinality. */
export type Usage = "M" | "R" | "R2" | "O" | "I" | "X" | "NP";

export interface UsageMeaning {
  /** Expansion of the letter, verbatim from the legend where one exists. */
  title: string;
  /** What the validator does with it. */
  validator: string;
  severityIfViolated: Severity;
}

export const USAGE_MEANING: Record<Usage, UsageMeaning> = {
  M: {
    title: "Mandatory",
    validator: "Error if missing. Blocks submission.",
    severityIfViolated: "error",
  },
  R: {
    title: "Required",
    validator: "Error if missing. Blocks submission.",
    severityIfViolated: "error",
  },
  R2: {
    title: "Required if known",
    validator:
      "Warning if missing. Send it when your system holds the value; never blocks submission.",
    severityIfViolated: "warn",
  },
  O: {
    title: "Optional",
    validator: "No finding either way.",
    severityIfViolated: "info",
  },
  I: {
    title: "Ignored",
    validator:
      "Accepted then discarded by NPHIES. Sending it is harmless; you do not need to build it.",
    severityIfViolated: "ignored",
  },
  X: {
    title: "Not used",
    validator: "Warning if present.",
    severityIfViolated: "warn",
  },
  NP: {
    title: "SHALL NOT be present",
    validator: "Error if present. Blocks submission.",
    severityIfViolated: "error",
  },
};

/**
 * Usage and cardinality are LISTS, never scalars: ~60 spec rows carry
 * conditional usage such as "M (Report) / NP (Order)" with a positionally
 * parallel maxRpt cell.
 */
export interface UsageRule {
  usage: Usage;
  /** Verbatim cardinality cell, e.g. "1..1", "0..*", "[1..1]". */
  cardinality?: string;
  /** The condition this usage applies under, e.g. "Report". */
  condition?: string;
}

/* ------------------------------------------------------------ provenance -- */

/** Every claim the UI renders can be traced back to a Confluence page. */
export interface Provenance {
  pageId: string;
  pageTitle: string;
  /** Row identifier within the page's table, e.g. "PID-5" or "1.4.2". */
  row?: string;
  /** VERBATIM Confluence text. Never synthesised. */
  quote: string;
}

/* ------------------------------------------------------- code-pane model -- */

/**
 * A hit region in the message text. Purely geometric: SplitView does not care
 * whether it covers an HL7 field, an XML attribute or a JSON member.
 */
export interface Region {
  id: string;
  /** 1-based line number. */
  line: number;
  /** 0-based inclusive column within that line. */
  startCol: number;
  /** 0-based EXCLUSIVE column within that line. */
  endCol: number;
  /** Short human label, e.g. "PID-5 Patient Name". */
  label: string;
  /** Canonical structural path, e.g. "ADT^A01/PID/PID-5" or "ClinicalDocument/recordTarget". */
  path: string;
  severity: Severity;
  /** Optional nested regions (components inside a field). Flattened internally. */
  children?: Region[];
}

/** Cosmetic syntax token. Supplied by the caller, so SplitView stays format-agnostic. */
export type TokenKind =
  | "punct"
  | "name"
  | "key"
  | "value"
  | "string"
  | "number"
  | "meta"
  | "comment";

export interface Token {
  line: number;
  startCol: number;
  endCol: number;
  kind: TokenKind;
}

/* ------------------------------------------------------- tree/finding model */

/** A node in the structure tree. */
export interface StructureNode {
  id: string;
  /** Display label, e.g. "PID-5" or "recordTarget". */
  label: string;
  /** Secondary label shown next to the primary, e.g. the field name. */
  name?: string;
  path: string;
  severity: Severity;
  /** Usage/cardinality rules; a list because usage can be conditional. */
  rules?: UsageRule[];
  /** Data type / structural type, e.g. "XPN", "CX", "Bundle.entry". */
  dataType?: string;
  /** Fixed structural value the spec pins: OID, templateId, profile URL. */
  fixedValue?: string;
  /** Links this node to a Region in the message text. */
  regionId?: string;
  /** Why this node is ignored — shown in the tooltip on the recessed state. */
  ignoredReason?: string;
  source?: Provenance;
  children?: StructureNode[];
}

/** A structural finding about the message. */
export interface Finding {
  id: string;
  severity: Severity;
  /** Stable machine code, e.g. "MISSING_REQUIRED". */
  code?: string;
  /** One-line statement of the defect. */
  title: string;
  /** Longer explanation / how to fix. */
  detail?: string;
  path: string;
  /** Links the finding to a Region (and therefore a line) in the message. */
  regionId?: string;
  line?: number;
  rules?: UsageRule[];
  source?: Provenance;
}

/* -------------------------------------------------------- navigation model */

export type Family = "hl7v2" | "fhir" | "cda" | "xds" | "sso";

export interface FamilyMeta {
  id: Family;
  label: string;
  /** Two-or-three letter monospace sigil shown in the rail. */
  sigil: string;
}

export const FAMILIES: FamilyMeta[] = [
  { id: "hl7v2", label: "HL7 v2.5.1", sigil: "V2" },
  { id: "fhir", label: "FHIR R4", sigil: "FH" },
  { id: "cda", label: "CDA R2", sigil: "CDA" },
  { id: "xds", label: "XDS / SOAP", sigil: "XDS" },
  { id: "sso", label: "SSO", sigil: "SSO" },
];

/** Readiness of the compiled spec behind a use case — drives the rail status dot. */
export type UseCaseStatus = "ready" | "partial" | "draft" | "missing";

export interface UseCase {
  id: string;
  family: Family;
  /** Short code shown monospace, e.g. "ADT^A01", "ITI-41". */
  code: string;
  label: string;
  status: UseCaseStatus;
  /** Optional one-line description for the rail tooltip / empty state. */
  blurb?: string;
}

export type WorkflowTab = "build" | "check" | "explain";
export type GlobalView = "readiness" | "decoder";
export type ActiveView =
  | { kind: "usecase"; useCaseId: string; tab: WorkflowTab }
  | { kind: "global"; view: GlobalView };
