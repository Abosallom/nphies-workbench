/**
 * Findings — what the checker says about ONE message, and the rules about saying it.
 *
 * A finding is a claim: "this message is structurally wrong here, and here is why we
 * believe that." Because a confidently WRONG structural verdict sends a hospital chasing a
 * phantom, every constructor in this module refuses to build a claim it cannot evidence:
 *
 *   - {@link makeFinding} returns `null` when the rule behind it carries no Confluence
 *     quote and no official-sample reference. `check()` counts those refusals and reports
 *     the count rather than silently dropping them.
 *   - `independent` is computed, never passed in: it is `true` only when the governing
 *     provenance names a Confluence `pageId`. A rule read off an official sample
 *     (`provenance.sample`, `pageId: null`) is NOT in the published specification, and
 *     {@link provenanceCaveat} appends a sentence saying so to the finding's `detail`.
 *     This is the rule that keeps the SOAP/XDS surface honest, where only 55.0% of the
 *     resolution is independent of the samples (`soapPath` just 32.7%).
 *   - `confidence` and `verifiedAgainstSample` are carried through from the compiled spec
 *     record, never re-derived and never upgraded.
 *
 * Nothing here imports React, touches the network or reads a file. Everything is a pure
 * function over plain data, so a test can construct a finding by hand.
 */

import type {
  Confidence,
  Derivation,
  Provenance,
  Severity,
  SourceLocation,
  UsageRule,
} from "./structure";

/* ========================================================================== *
 * Codes
 * ========================================================================== */

/**
 * The stable machine codes a finding can carry. The catalogue doubles as documentation:
 * `what` is the one-line meaning, and `defaultSeverity` is what the checker emits when the
 * evidence is clean — it may be DEMOTED (never promoted) when the spec is ambiguous, when a
 * recorded spec conflict says "never error", or when the rule is sample-derived.
 */
export const FINDING_CODES = {
  "required-field-missing": {
    defaultSeverity: "error",
    what: "A node whose resolved usage is M or R is absent from the message.",
  },
  "recommended-field-missing": {
    defaultSeverity: "warn",
    what: "A node whose resolved usage is R2 (required if known) is absent. Never blocks.",
  },
  "forbidden-field-present": {
    defaultSeverity: "error",
    what: "A node whose resolved usage is NP (SHALL NOT be present) is present.",
  },
  "unused-field-present": {
    defaultSeverity: "warn",
    what: "A node whose resolved usage is X (not used) is present.",
  },
  "ignored-field-present": {
    defaultSeverity: "ignored",
    what: "Usage I: NPHIES accepts this and discards it. Informational, never a failure.",
  },
  "segment-not-in-this-event": {
    defaultSeverity: "error",
    what: "Usage '-': the segment is not part of this message/event but was sent.",
  },
  "sequence-out-of-order": {
    defaultSeverity: "error",
    what: "Segments or elements appear in an order the normative sequence forbids.",
  },
  "cardinality-too-few": {
    defaultSeverity: "error",
    what: "Fewer repeats than the stated minimum.",
  },
  "cardinality-too-many": {
    defaultSeverity: "error",
    what: "More repeats than the stated maximum.",
  },
  "composite-component-missing": {
    defaultSeverity: "error",
    what: "An HL7 composite is missing a component the spec pins a value for (e.g. a bare id where a CX with an assigning authority is required).",
  },
  "composite-too-many-components": {
    defaultSeverity: "error",
    what: "An HL7 composite carries more components than its datatype defines.",
  },
  "fixed-value-mismatch": {
    defaultSeverity: "error",
    what: "An OID, templateId, profile URL, resourceType or fixed code does not match the pinned value.",
  },
  "quarantined-oid": {
    defaultSeverity: "error",
    what: "A placeholder OID from the compiled quarantine list appears in the message. Sample data, never valid in a real submission.",
  },
  "valueset-code-unknown": {
    defaultSeverity: "error",
    what: "A coded value is not a member of the value set bound to that node.",
  },
  "valueset-code-case": {
    defaultSeverity: "warn",
    what: "A coded value matches a concept only when case is ignored.",
  },
  "valueset-not-checked": {
    defaultSeverity: "info",
    what: "Membership could NOT be checked (external value set, or the set was not supplied). No pass is being claimed.",
  },
  "unknown-element": {
    defaultSeverity: "info",
    what: "Content present in the message that the compiled spec does not describe. Our spec may be incomplete rather than the message wrong.",
  },
  "bundle-type-mismatch": {
    defaultSeverity: "error",
    what: "Bundle.type does not equal the value the bundle family fixes.",
  },
  "bundle-first-entry": {
    defaultSeverity: "error",
    what: "The first Bundle.entry is not the resource the bundle family requires.",
  },
  "bundle-entry-resource-mismatch": {
    defaultSeverity: "error",
    what: "A Bundle.entry carries a different resourceType than the structure states for that position.",
  },
  "known-sample-defect": {
    defaultSeverity: "error",
    what: "The message matches a KNOWN defect in an official NPHIES sample. The hospital did not cause it.",
  },
  "conditional-usage-unresolved": {
    defaultSeverity: "warn",
    what: "The row carries conditional usage and the supplied context does not say which rule applies, so no verdict was reached.",
  },
  "spec-conflict": {
    defaultSeverity: "info",
    what: "Two published sources disagree about this node. The compiled resolution is shown with both quotes.",
  },
  "structure-mismatch": {
    defaultSeverity: "warn",
    what: "The tree was parsed against a different structure/family than the one being checked against.",
  },
  "alignment-failed": {
    defaultSeverity: "info",
    what: "The checker could not align the parsed tree with the structure, so node-level verdicts were SUPPRESSED rather than guessed.",
  },
  "parse-diagnostic": {
    defaultSeverity: "warn",
    what: "A problem the parser reported about the text itself, carried through so it is not lost.",
  },
  "structure-caveat": {
    defaultSeverity: "info",
    what: "A caveat the compiled spec records about this structure (no golden sample, sample-derived envelope, unresolved templateId, …).",
  },
  "unevidenced-rule-skipped": {
    defaultSeverity: "info",
    what: "One or more compiled rules carry no quote and no sample reference, so they were NOT checked. Surfaced rather than hidden.",
  },
  "readiness-coverage": {
    defaultSeverity: "info",
    what: "How many required (M/R) nodes the checker evaluated and how many were satisfied. Carries the metrics summarise() scores from.",
  },
} as const satisfies Record<string, { defaultSeverity: Severity; what: string }>;

export type FindingCode = keyof typeof FINDING_CODES;

/** Explanation of a code, for a tooltip or an "explain this finding" pane. */
export function explainCode(code: FindingCode): string {
  return FINDING_CODES[code].what;
}

/* ========================================================================== *
 * Finding
 * ========================================================================== */

/** Where in the message text the finding sits. Same geometry as the UI's `Region`. */
export interface FindingLocation {
  /** 1-based. */
  line: number;
  /** 0-based inclusive. */
  startCol: number;
  /** 0-based EXCLUSIVE. */
  endCol: number;
}

/** Counters `summarise()` scores readiness from. Emitted on the `readiness-coverage` finding. */
export interface FindingMetrics {
  /** Nodes whose resolved usage was M or R and which the checker actually evaluated. */
  requiredTotal: number;
  /** Of those, how many were present at least the stated minimum number of times. */
  requiredSatisfied: number;
  /** Structure members the checker matched to at least one node in the message. */
  membersAligned: number;
  /** Structure members the checker looked for. */
  membersConsidered: number;
  /** Rules skipped because they carry no quote and no sample reference. */
  rulesWithoutEvidence: number;
  /** Named checks that did not run, and why. */
  checksSkipped: string[];
}

/**
 * One structural claim about the message.
 *
 * `location: null` is meaningful: it means "this should exist and does not", so the UI has
 * nothing to underline. A finding about something that IS in the text always carries a
 * location when the parser gave the node one.
 */
export interface Finding {
  /** Stable within one `check()` run: `<code>#<n>@<path>`. */
  id: string;
  severity: Severity;
  code: FindingCode;
  title: string;
  detail: string;
  location: FindingLocation | null;
  /** Governing `SpecNode.id`, when the rule came from a field table. */
  specNodeId: string | null;
  /** Canonical structural path, e.g. `ADT^A45/PID/PID-3` or `Bundle/entry[0]/MessageHeader`. */
  path: string;
  /** Governing `StructureMember.id`, when the rule came from the message structure. */
  memberId?: string | null;
  expected?: string;
  actual?: string;
  /** WHY we believe this rule. `{sample, pageId: null}` = not in the published spec. */
  provenance: Provenance;
  confidence: Confidence;
  /** Computed: `true` only when `provenance.pageId` is set. Never passed in. */
  independent: boolean;
  derivation?: Derivation;
  /** Carried through from the compiled rule; never re-derived here. */
  verifiedAgainstSample?: boolean;
  /** The usage rules that were in play, so the UI can show M/R2/NP and the condition. */
  rules?: UsageRule[];
  /** What to change in the HIS, when we can say it concretely. */
  fix?: string;
  /** Ids in the NPHIES error catalogue whose locator matches this node exactly. */
  relatedErrorIds?: string[];
  /** Present only on the `readiness-coverage` finding. */
  metrics?: FindingMetrics;
  /** Position of the node in the message, used to sort within a severity. */
  documentOrder?: number;
}

/* ========================================================================== *
 * Provenance helpers
 * ========================================================================== */

/**
 * Is this rule in the PUBLISHED specification?
 *
 * Only a Confluence `pageId` makes a rule independent. A rule whose evidence is an official
 * message (`sample` set, `pageId` null) is a rule NPHIES never wrote down — it may still be
 * right, and 13 samples agreeing may make it high-confidence, but it is not normative and
 * must never be laundered into one that is.
 */
export function isIndependentProvenance(p: Provenance | null | undefined): boolean {
  return Boolean(p && p.pageId);
}

/** True when there is anything at all to show an analyst: a quote, a page, or a sample. */
export function hasEvidence(p: Provenance | null | undefined): boolean {
  if (!p) return false;
  return Boolean(p.pageId || p.sample || p.quote);
}

/** One sentence naming the source, safe to render next to a finding. */
export function describeProvenance(p: Provenance): string {
  if (p.pageId) {
    const where = p.pageTitle ? `"${p.pageTitle}" (page ${p.pageId})` : `Confluence page ${p.pageId}`;
    return p.row ? `${where}, row ${p.row}` : where;
  }
  if (p.sample) return `the official sample ${p.sample}`;
  return "the compiled structure record";
}

/**
 * The sentence appended to `detail` when a rule is not independent. This is the product:
 * the hospital must be able to tell "NPHIES published this" from "we read this off a
 * sample message" before spending a day changing their HIS.
 */
export function provenanceCaveat(p: Provenance): string | null {
  if (isIndependentProvenance(p)) return null;
  if (p.sample) {
    return (
      `This rule is NOT in the published specification: it was read off the official sample ` +
      `${p.sample}. Treat it as how NPHIES's own messages are built, not as a published requirement.`
    );
  }
  return (
    "This rule carries no Confluence page reference — it comes from the compiled structure " +
    "record rather than a quoted specification page."
  );
}

/** Narrow a `SourceLocation` to the three fields a finding carries. */
export function locationOf(loc: SourceLocation | null | undefined): FindingLocation | null {
  if (!loc) return null;
  return { line: loc.line, startCol: loc.startCol, endCol: loc.endCol };
}

/* ========================================================================== *
 * Construction
 * ========================================================================== */

/** Everything a caller supplies; `id`, `independent` and the caveat are computed. */
export interface FindingInput {
  code: FindingCode;
  severity: Severity;
  title: string;
  detail: string;
  path: string;
  provenance: Provenance | null | undefined;
  confidence?: Confidence;
  location?: SourceLocation | FindingLocation | null;
  specNodeId?: string | null;
  memberId?: string | null;
  expected?: string | null;
  actual?: string | null;
  derivation?: Derivation;
  verifiedAgainstSample?: boolean;
  rules?: UsageRule[];
  fix?: string | null;
  relatedErrorIds?: string[];
  metrics?: FindingMetrics;
  documentOrder?: number;
  /** Extra sentences appended to `detail` before the provenance caveat. */
  notes?: (string | null | undefined)[];
  /**
   * Replaces the computed provenance caveat; `null` means "no caveat sentence".
   *
   * Legitimate ONLY where the evidence IS the message or the parser — a parse diagnostic, a
   * match against a known defect in an official sample — because the standard wording
   * ("this rule is not in the published specification") would misdescribe those. It never
   * touches `independent`, so nothing can be laundered into normative through this field.
   */
  caveat?: string | null;
}

function asLocation(loc: FindingInput["location"]): FindingLocation | null {
  if (!loc) return null;
  return { line: loc.line, startCol: loc.startCol, endCol: loc.endCol };
}

/**
 * Build a finding, or return `null` when the rule behind it cannot be evidenced.
 *
 * Returning `null` rather than throwing is deliberate: the checker walks thousands of
 * compiled rows, a handful of which (the `cdaTemplateId 2.16.840.1.113883.3.3731.1.105.1`
 * document templateId, for one) resolve to nothing at all. Those must stay VISIBLE as a
 * count of unchecked rules, not crash the check and not become a silent pass.
 */
export function makeFinding(input: FindingInput, seq: number): Finding | null {
  const p = input.provenance;
  if (!hasEvidence(p)) return null;
  const provenance = p as Provenance;

  const independent = isIndependentProvenance(provenance);
  const caveat = input.caveat !== undefined ? input.caveat : provenanceCaveat(provenance);
  const detail = [input.detail, ...(input.notes ?? []), caveat]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join(" ");

  const finding: Finding = {
    id: `${input.code}#${seq}@${input.path}`,
    severity: input.severity,
    code: input.code,
    title: input.title,
    detail,
    location: asLocation(input.location),
    specNodeId: input.specNodeId ?? null,
    path: input.path,
    provenance,
    confidence: input.confidence ?? "medium",
    independent,
  };
  if (input.memberId != null) finding.memberId = input.memberId;
  if (input.expected != null) finding.expected = input.expected;
  if (input.actual != null) finding.actual = input.actual;
  if (input.derivation) finding.derivation = input.derivation;
  if (input.verifiedAgainstSample !== undefined) {
    finding.verifiedAgainstSample = input.verifiedAgainstSample;
  }
  if (input.rules && input.rules.length) finding.rules = input.rules;
  if (input.fix) finding.fix = input.fix;
  if (input.relatedErrorIds && input.relatedErrorIds.length) {
    finding.relatedErrorIds = input.relatedErrorIds;
  }
  if (input.metrics) finding.metrics = input.metrics;
  if (input.documentOrder !== undefined) finding.documentOrder = input.documentOrder;
  return finding;
}

/* ========================================================================== *
 * Severity arithmetic
 * ========================================================================== */

/** Same ranking the UI uses (`src/ui/types.ts` SEVERITY_ORDER), so the two never drift. */
export const SEVERITY_RANK: Record<Severity, number> = {
  error: 0,
  warn: 1,
  ok: 2,
  ignored: 3,
  info: 4,
};

/** How severe a severity is as a VERDICT — used to cap, never to raise. */
const STRENGTH: Record<Severity, number> = { error: 4, warn: 3, ok: 2, ignored: 1, info: 0 };

/**
 * Cap a severity at `ceiling`, returning the weaker of the two. There is no "promote":
 * where the spec is ambiguous or confidence is low the checker moves DOWN, because a false
 * error is the expensive failure.
 */
export function capSeverity(severity: Severity, ceiling: Severity): Severity {
  return STRENGTH[severity] <= STRENGTH[ceiling] ? severity : ceiling;
}

/** Demote a finding, recording why in its detail. Returns a new object. */
export function demote(finding: Finding, ceiling: Severity, why: string): Finding {
  const severity = capSeverity(finding.severity, ceiling);
  if (severity === finding.severity) return finding;
  return {
    ...finding,
    severity,
    detail: `${finding.detail} ${why}`.trim(),
    confidence: finding.confidence === "high" ? "medium" : finding.confidence,
  };
}

/* ========================================================================== *
 * Ordering
 * ========================================================================== */

function positionOf(f: Finding): number {
  if (f.documentOrder !== undefined) return f.documentOrder;
  if (f.location) return f.location.line * 10_000 + f.location.startCol;
  // "Should exist but does not" has no position; keep it after the located findings of the
  // same severity rather than pretending it sits at line 0.
  return Number.MAX_SAFE_INTEGER;
}

/** Errors first, then warns, then ok/ignored/info; within a severity, by document order. */
export function compareFindings(a: Finding, b: Finding): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  const byPosition = positionOf(a) - positionOf(b);
  if (byPosition !== 0) return byPosition;
  const byPath = a.path.localeCompare(b.path);
  if (byPath !== 0) return byPath;
  return a.id.localeCompare(b.id);
}

/** Non-mutating sort. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(compareFindings);
}

/**
 * Drop findings that say the same thing about the same place. Two compiled rows can
 * describe one node (a segment's fields are tabulated on both the segment page and the
 * summary page), and the hospital should see one finding, not two.
 */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.code}|${f.path}|${f.expected ?? ""}|${f.actual ?? ""}|${f.location ? `${f.location.line}:${f.location.startCol}` : "-"}`;
    const prior = seen.get(key);
    // Keep the WEAKER of two duplicates: if one reading of the spec is milder, that is the
    // reading we can defend.
    if (!prior || STRENGTH[f.severity] < STRENGTH[prior.severity]) seen.set(key, f);
  }
  return [...seen.values()];
}

/* ========================================================================== *
 * Summary
 * ========================================================================== */

export interface CheckSummary {
  errors: number;
  warns: number;
  infos: number;
  ignored: number;
  /** `ok` findings — nodes the checker positively verified. */
  oks: number;
  /** True when at least one error is present: the message will be rejected as it stands. */
  blocking: boolean;
  /**
   * Fraction in [0, 1] of REQUIRED (usage M or R) nodes that are satisfied.
   *
   * COMPUTATION. `check()` counts, while it walks, every node whose usage resolved to M or
   * R *and which it actually evaluated* — a node inside an absent parent is not counted,
   * because its requirement is not yet in play and counting it would punish a message twice
   * for one missing segment. A required node is SATISFIED when it is present at least `min`
   * times. The score is `requiredSatisfied / requiredTotal`.
   *
   * Those two counters travel on the `readiness-coverage` finding `check()` always emits,
   * so `summarise()` stays a pure function of the finding list. When that finding is absent
   * (a hand-built list, or findings filtered by the UI) the score falls back to counting
   * distinct `required-field-missing` findings against a denominator of those same
   * findings, which can only ever yield 0 — `readinessBasis` says which happened, so the UI
   * never presents a fallback as a measurement.
   *
   * A structure with nothing required scores 1 with `readinessBasis: "nothing-required"`.
   */
  readinessScore: number;
  readinessBasis: "measured" | "nothing-required" | "no-metrics";
  requiredTotal: number;
  requiredSatisfied: number;
  /** Counts per code, for the Check tab's filter chips. */
  byCode: Record<string, number>;
  /** How many findings rest on a rule that is not in the published spec. */
  sampleDerived: number;
  /** Named checks that did not run, and why. Never hidden. */
  checksSkipped: string[];
}

/** Roll a finding list up into the numbers the UI puts on the Check tab. */
export function summarise(findings: readonly Finding[]): CheckSummary {
  let errors = 0;
  let warns = 0;
  let infos = 0;
  let ignored = 0;
  let oks = 0;
  let sampleDerived = 0;
  const byCode: Record<string, number> = {};
  let metrics: FindingMetrics | null = null;

  for (const f of findings) {
    switch (f.severity) {
      case "error":
        errors++;
        break;
      case "warn":
        warns++;
        break;
      case "info":
        infos++;
        break;
      case "ignored":
        ignored++;
        break;
      case "ok":
        oks++;
        break;
    }
    byCode[f.code] = (byCode[f.code] ?? 0) + 1;
    if (!f.independent) sampleDerived++;
    if (f.code === "readiness-coverage" && f.metrics) metrics = f.metrics;
  }

  let readinessScore = 0;
  let readinessBasis: CheckSummary["readinessBasis"] = "no-metrics";
  let requiredTotal = 0;
  let requiredSatisfied = 0;
  if (metrics) {
    requiredTotal = metrics.requiredTotal;
    requiredSatisfied = metrics.requiredSatisfied;
    if (requiredTotal === 0) {
      readinessScore = 1;
      readinessBasis = "nothing-required";
    } else {
      readinessScore = requiredSatisfied / requiredTotal;
      readinessBasis = "measured";
    }
  }

  return {
    errors,
    warns,
    infos,
    ignored,
    oks,
    blocking: errors > 0,
    readinessScore,
    readinessBasis,
    requiredTotal,
    requiredSatisfied,
    byCode,
    sampleDerived,
    checksSkipped: metrics?.checksSkipped ?? [],
  };
}

/* ========================================================================== *
 * Adapter to the presentational layer
 * ========================================================================== */

/**
 * The shape `src/ui/types.ts` `Finding` has. Declared structurally rather than imported so
 * the engine keeps its independence from the view layer (see the note at the top of
 * `structure.ts`); the UI can assign the result straight to its own type.
 */
export interface UiFinding {
  id: string;
  severity: Severity;
  code?: string;
  title: string;
  detail?: string;
  path: string;
  regionId?: string;
  line?: number;
  rules?: { usage: string; cardinality?: string; condition?: string }[];
  source?: { pageId: string; pageTitle: string; row?: string; quote: string };
}

/**
 * Mechanical projection onto the UI's finding shape. `source` is emitted ONLY when a
 * quotable Confluence page exists — a sample-derived rule has no `source` to show, which is
 * exactly the signal the analyst needs; the caveat sentence is already in `detail`.
 */
export function toUiFinding(f: Finding, regionId?: string): UiFinding {
  const out: UiFinding = {
    id: f.id,
    severity: f.severity,
    code: f.code,
    title: f.title,
    detail: f.detail,
    path: f.path,
  };
  if (regionId) out.regionId = regionId;
  if (f.location) out.line = f.location.line;
  if (f.rules?.length) {
    out.rules = f.rules
      .filter((r) => r.usage)
      .map((r) => {
        const rule: { usage: string; cardinality?: string; condition?: string } = {
          usage: r.usage as string,
        };
        if (r.raw?.cardinality) rule.cardinality = r.raw.cardinality;
        if (r.condition) rule.condition = r.condition;
        return rule;
      });
  }
  const p = f.provenance;
  if (p.pageId && p.quote) {
    out.source = {
      pageId: p.pageId,
      pageTitle: p.pageTitle ?? "",
      quote: p.quote,
    };
    if (p.row) out.source.row = p.row;
  }
  return out;
}
