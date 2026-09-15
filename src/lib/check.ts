/**
 * The checker: given a parsed {@link StructureTree} and the {@link MessageStructure} it was
 * parsed against, say exactly what is structurally wrong with the message.
 *
 * This is the heart of the product, so it is built around one rule: a confidently WRONG
 * verdict is worse than an acknowledged unknown. Everything below follows from that.
 *
 *   - Every finding is traceable. `check()` never emits a claim whose compiled rule carries
 *     neither a Confluence quote nor an official-sample reference; it counts those instead
 *     and reports the count (`unevidenced-rule-skipped`).
 *   - Sample-derived rules stay sample-derived. `independent: false` plus a sentence in
 *     `detail` saying the rule is not in the published specification. On the SOAP/XDS
 *     surface — only 55.0% independent, `soapPath` 32.7% — that will be most of them.
 *   - Ambiguity is surfaced, not resolved by guessing. Conditional usage that the supplied
 *     {@link VariantContext} does not settle becomes a `conditional-usage-unresolved` WARN
 *     listing every candidate rule, never an error under one arbitrary reading.
 *   - When the checker cannot align the tree with the structure at all, it says so and
 *     SUPPRESSES node-level verdicts rather than emitting a page of phantom errors.
 *   - Severity only ever moves DOWN: `capSeverity`/`demote`, never a promotion.
 *
 * It is a pure function. Every bundle it consults (field tables, datatypes, constants,
 * value sets, sample defects, the compiled spec-conflict corpus, the NPHIES error
 * catalogue) is passed in through {@link CheckOptions}; nothing here reads a file, touches
 * the network, or imports React. {@link loadCheckInputs} is the one convenience wrapper,
 * kept at the bottom and clearly marked, for callers that do want the loaders from
 * `structure.ts` to fetch those bundles for them.
 *
 * The checks, in the order they run:
 *   0. envelope/family sanity + parser diagnostics + structure caveats
 *   1. SEQUENCE / ORDER          (normative segment and CDA header order)
 *   2. REQUIRED                  (M/R error, R2 warn, O silent, conditional resolved first)
 *   3. FORBIDDEN                 (NP error, X warn, I 'ignored', '-' error)
 *   4. CARDINALITY               (repeat counts outside [min..max])
 *   5. COMPOSITE LAYOUT          (HL7 component count and pinned component positions)
 *   6. FIXED VALUES              (OIDs, templateIds, profile URLs, resourceTypes, codes)
 *   7. QUARANTINED OIDs          (placeholder OIDs that are never valid in a submission)
 *   8. VALUE SET MEMBERSHIP      (enumerated sets only; `external` sets emit an explicit
 *                                 "not checked" info — never a pass we did not perform)
 *   9. UNKNOWN ELEMENTS          (info, with the caveat that our spec may be incomplete)
 *  10. BUNDLE FAMILY             (Bundle.type and the first-entry rule)
 *  11. SAMPLE DEFECTS            (the pasted message is a copy of a defective official sample)
 */

import type {
  Cardinality,
  Confidence,
  ConstantsBundle,
  DatatypesBundle,
  Derivation,
  FieldTable,
  MaxOccurs,
  MessageStructure,
  Provenance,
  Severity,
  SpecLocator,
  SpecNode,
  StructureMember,
  StructureTree,
  TreeNode,
  UsageCode,
  UsageRule,
  ValueSet,
  ValueSetBinding,
  VariantContext,
} from "./structure";
import { formatLocator, locatorKey, membersOf, resolveUsage, severityOf } from "./structure";
import type { Finding, FindingCode, FindingInput, FindingMetrics } from "./findings";
import { capSeverity, dedupeFindings, makeFinding, sortFindings } from "./findings";

export type { Finding, FindingCode, FindingMetrics } from "./findings";
export type { CheckSummary } from "./findings";
export { summarise, sortFindings, toUiFinding } from "./findings";

/* ========================================================================== *
 * Inputs the checker consults (shapes of bundles `structure.ts` types loosely)
 * ========================================================================== */

/** One entry of `src/spec/sample-defects.json#defects`. */
export interface SampleDefect {
  sampleFile: string;
  defectType: string;
  severity: "fatal" | "major" | "minor" | string;
  description: string;
  /** Verbatim fragment of the sample the defect was found in. Used to recognise a copy. */
  evidence?: string | null;
  impact?: string | null;
  workaround?: string | null;
  confidence?: string | null;
  useCaseId?: string | null;
  location?: { line?: number; col?: number; charOffset?: number; jsonPath?: string } | null;
}

export interface SampleDefectsBundle {
  defects: SampleDefect[];
  [key: string]: unknown;
}

/**
 * One entry of `src/spec/structures.json#rules.conflicts` — a place where two published
 * NPHIES sources disagree, together with the compiled resolution. The A45/A50 "MRG before
 * PV1" question lives here, as does "never error on a missing DG1 in an A03".
 */
export interface SpecConflict {
  event?: string | null;
  field?: string | null;
  resolution?: string | null;
  rationale?: string | null;
  validatorGuidance?: string | null;
  confidence?: Confidence | string | null;
  sources?: { pageId?: string | null; pageTitle?: string | null; row?: string | null; quote?: string | null; reading?: string | null }[];
}

/** One entry of `src/spec/errors.json#errors`. Used only to name a matching NPHIES error. */
export interface ErrorCatalogueEntry {
  id: string;
  title?: string | null;
  code?: string | null;
  locators?: { kind: string; value: string }[];
}

export interface CheckOptions {
  /**
   * What the caller knows about which conditional rules apply. Defaults to the structure's
   * own `useCaseId`/`variant`. Getting this wrong produces false errors, so when the
   * context does not settle a conditional row the checker warns instead of deciding.
   */
  variantContext?: VariantContext;
  /** Extra condition labels merged into the default context, e.g. `["Report"]`. */
  conditions?: readonly string[];
  /** `SpecNode`s for the field tables this structure cites (`ResolvedUseCase.specNodes`). */
  specNodes?: ReadonlyMap<string, SpecNode>;
  /** Field tables keyed `<pageId>:<tableIndex>` (`ResolvedUseCase.tables`). */
  tables?: ReadonlyMap<string, FieldTable>;
  datatypes?: DatatypesBundle | null;
  constants?: ConstantsBundle | null;
  /** Value sets keyed by id. Only sets supplied here are checked; the rest emit an info. */
  valueSets?: ReadonlyMap<string, ValueSet>;
  sampleDefects?: SampleDefectsBundle | null;
  conflicts?: readonly SpecConflict[] | null;
  errorCatalogue?: readonly ErrorCatalogueEntry[] | null;
  /** Turn individual checks off. Anything switched off is reported in `checksSkipped`. */
  checks?: Partial<Record<CheckId, boolean>>;
  /** Per-code cap on emitted findings; the overflow is reported as one info. */
  caps?: Partial<Record<FindingCode, number>>;
  /** Findings emitted per repeating instance before the rest are collapsed. Default 3. */
  maxInstancesPerRule?: number;
}

export type CheckId =
  | "order"
  | "required"
  | "forbidden"
  | "cardinality"
  | "composite"
  | "fixedValues"
  | "quarantinedOids"
  | "valueSets"
  | "unknownElements"
  | "bundleFamily"
  | "sampleDefects"
  | "parseDiagnostics"
  | "structureCaveats";

const DEFAULT_CAPS: Partial<Record<FindingCode, number>> = {
  "unknown-element": 25,
  "conditional-usage-unresolved": 15,
  "valueset-not-checked": 12,
  "spec-conflict": 6,
  "structure-caveat": 8,
  "ignored-field-present": 40,
};
const GLOBAL_CAP = 400;

/* ========================================================================== *
 * Finding sink — caps, evidence refusals, stable ids
 * ========================================================================== */

interface Sink {
  push: (input: FindingInput) => Finding | null;
  findings: Finding[];
  unevidenced: number;
  /** Compiled rules that were skipped for lack of evidence, by path. */
  unevidencedPaths: string[];
  capped: Map<FindingCode, number>;
}

function createSink(caps: Partial<Record<FindingCode, number>>): Sink {
  const findings: Finding[] = [];
  const counts = new Map<FindingCode, number>();
  const capped = new Map<FindingCode, number>();
  const sink: Sink = {
    findings,
    unevidenced: 0,
    unevidencedPaths: [],
    capped,
    push(input) {
      const used = counts.get(input.code) ?? 0;
      const cap = caps[input.code] ?? GLOBAL_CAP;
      if (used >= cap) {
        capped.set(input.code, (capped.get(input.code) ?? 0) + 1);
        return null;
      }
      const finding = makeFinding(input, findings.length);
      if (!finding) {
        // The rule cannot be evidenced. It is NOT checked, and NOT quietly passed.
        sink.unevidenced++;
        if (sink.unevidencedPaths.length < 40) sink.unevidencedPaths.push(input.path);
        return null;
      }
      counts.set(input.code, used + 1);
      findings.push(finding);
      return finding;
    },
  };
  return sink;
}

/* ========================================================================== *
 * Locator keys — tolerant matching between spec locators and instance locators
 * ========================================================================== */

const stripLeading = (p: string) => p.replace(/^\.?\//, "").replace(/^\.\//, "");
const normPath = (p: string) => stripLeading(p).replace(/\//g, ".").replace(/^\.+/, "");
const withoutPredicates = (p: string) => p.replace(/\[[^\]]*\]/g, "");

/**
 * Every key an instance node or a spec member could reasonably be indexed under, most
 * specific first. Parsers and the compiled spec do not always spell a path the same way
 * (`./meta/profile` vs `Bundle.meta.profile`), so matching walks from the exact canonical
 * key outwards — but never as far as matching on a bare local name, which would collide.
 */
function locatorKeys(locator: SpecLocator): string[] {
  const keys: string[] = [locatorKey(locator)];
  switch (locator.kind) {
    case "hl7Field":
      break;
    case "fhirPath": {
      const base = normPath(locator.path);
      keys.push(`fhir~${base}`);
      if (locator.relativeTo) keys.push(`fhir~${normPath(`${locator.relativeTo}/${locator.path}`)}`);
      const stripped = base.replace(/^(Bundle|entry|resource)\./, "");
      if (stripped !== base) keys.push(`fhir~${stripped}`);
      if (locator.extensionUrl) keys.push(`fhirext~${locator.extensionUrl}`);
      break;
    }
    case "cdaXPath": {
      const full = normPath(locator.path);
      const bare = normPath(withoutPredicates(locator.path));
      const attr = locator.attribute ? `/@${locator.attribute}` : "";
      keys.push(`cda~${full}${attr}`);
      if (bare !== full) keys.push(`cda~${bare}${attr}`);
      if (locator.relativeTo) {
        keys.push(`cda~${normPath(withoutPredicates(`${locator.relativeTo}/${locator.path}`))}${attr}`);
      }
      for (const oid of extractTemplateIds(locator)) keys.push(`tpl~${oid}`);
      break;
    }
    case "xdsSlot":
      keys.push(`xds~${locator.name.toLowerCase()}`);
      break;
    case "xdsScheme":
      keys.push(`scheme~${locator.uuid.toLowerCase()}`);
      break;
  }
  return [...new Set(keys)];
}

function extractTemplateIds(locator: SpecLocator): string[] {
  if (locator.kind !== "cdaXPath") return [];
  const text = `${locator.path} ${locator.predicate ?? ""}`;
  return [...text.matchAll(/(\d+(?:\.\d+){3,})/g)].map((m) => m[1]);
}

/** The XML/JSON local name of a label, e.g. `soap12:Body` -> `Body`. */
function localName(label: string): string {
  const cut = label.lastIndexOf(":");
  return cut >= 0 ? label.slice(cut + 1) : label;
}

/* ========================================================================== *
 * Tree index
 * ========================================================================== */

interface NodeInfo {
  /** Euler-tour entry counter; also the document order of the node. */
  order: number;
  /** Euler-tour exit counter; `order < x < exit` identifies a descendant. */
  exit: number;
  parent: TreeNode | null;
  depth: number;
}

interface TreeIndex {
  info: Map<TreeNode, NodeInfo>;
  byKey: Map<string, TreeNode[]>;
  byMemberId: Map<string, TreeNode[]>;
  bySpecNodeId: Map<string, TreeNode[]>;
  bySegment: Map<string, TreeNode[]>;
  byLabel: Map<string, TreeNode[]>;
  all: TreeNode[];
  presentCount: number;
}

function indexTree(tree: StructureTree): TreeIndex {
  const index: TreeIndex = {
    info: new Map(),
    byKey: new Map(),
    byMemberId: new Map(),
    bySpecNodeId: new Map(),
    bySegment: new Map(),
    byLabel: new Map(),
    all: [],
    presentCount: 0,
  };
  let counter = 0;
  const add = (map: Map<string, TreeNode[]>, key: string, node: TreeNode) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(node);
    else map.set(key, [node]);
  };

  const visit = (node: TreeNode, parent: TreeNode | null, depth: number) => {
    const order = counter++;
    index.all.push(node);
    if (node.present !== false) index.presentCount++;
    if (node.memberId) add(index.byMemberId, node.memberId, node);
    if (node.specNodeId) add(index.bySpecNodeId, node.specNodeId, node);
    if (node.locator) for (const key of locatorKeys(node.locator)) add(index.byKey, key, node);
    if (node.locator?.kind === "hl7Field" && node.kind === "segment") {
      add(index.bySegment, node.locator.segment, node);
    } else if (node.kind === "segment" && node.label) {
      add(index.bySegment, node.label.trim().toUpperCase().slice(0, 3), node);
    }
    if (node.label) {
      add(index.byLabel, node.label, node);
      const local = localName(node.label);
      if (local !== node.label) add(index.byLabel, local, node);
    }
    for (const child of node.children) visit(child, node, depth + 1);
    index.info.set(node, { order, exit: counter++, parent, depth });
  };
  visit(tree.root, null, 0);
  return index;
}

function orderOf(index: TreeIndex, node: TreeNode): number {
  return index.info.get(node)?.order ?? Number.MAX_SAFE_INTEGER;
}

function isWithin(index: TreeIndex, node: TreeNode, scope: TreeNode): boolean {
  const a = index.info.get(node);
  const b = index.info.get(scope);
  if (!a || !b) return false;
  return a.order > b.order && a.order < b.exit;
}

function descendantsOf(scope: TreeNode): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (node: TreeNode) => {
    for (const child of node.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(scope);
  return out;
}

/* ========================================================================== *
 * Instance resolution
 * ========================================================================== */

function memberLocator(member: StructureMember): SpecLocator | null {
  if (member.kind === "segment") {
    return { kind: "hl7Field", segment: member.segment, field: 0 };
  }
  if ("locator" in member && member.locator) return member.locator;
  return null;
}

function memberKeys(member: StructureMember): string[] {
  const keys: string[] = [];
  if (member.kind === "segment") return keys; // handled by bySegment
  const locator = memberLocator(member);
  if (locator) keys.push(...locatorKeys(locator));
  if (member.kind === "section") {
    for (const oid of member.templateIds) keys.push(`tpl~${oid}`);
  }
  return keys;
}

/** How the instances for a member were found — reported when confidence depends on it. */
type MatchVia = "memberId" | "locator" | "segment" | "label" | "resourceType" | "none";

interface Matched {
  instances: TreeNode[];
  via: MatchVia;
  /**
   * The checker could not tell WHICH nodes this member governs, so no presence verdict may
   * be drawn from `instances` being empty. Set for a `Bundle.entry` slot whose resource
   * type the compiled structure never states: every entry shares the locator `./entry`, so
   * matching on the locator would make one member match all eleven entries — and calling it
   * "missing" would be a false error either way.
   */
  undecidable?: boolean;
}

function matchInstances(index: TreeIndex, member: StructureMember, scope: TreeNode[] | null): Matched {
  const inScope = (nodes: TreeNode[]): TreeNode[] => {
    const present = nodes.filter((n) => n.present !== false);
    if (!scope) return present;
    return present.filter((n) => scope.some((s) => s === n || isWithin(index, n, s)));
  };

  const byMember = index.byMemberId.get(member.id);
  if (byMember?.length) {
    const hit = inScope(byMember);
    if (hit.length) return { instances: hit, via: "memberId" };
  }

  if (member.kind === "segment") {
    const hit = inScope(index.bySegment.get(member.segment) ?? []);
    if (hit.length) return { instances: hit, via: "segment" };
  }

  // A bundle entry is identified by the resource it carries, never by its locator: all
  // entries share `./entry`, so a locator match would resolve one member to every entry.
  if (member.kind === "entry") {
    const entries = inScope(index.all.filter((n) => n.kind === "entry"));
    if (!member.resourceType) return { instances: [], via: "none", undecidable: entries.length > 0 };
    const typed = entries.filter((e) => resourceTypeOf(e) === member.resourceType);
    if (typed.length) return { instances: typed, via: "resourceType" };
    // Entries exist but none carries this resource type: genuinely absent, not undecidable —
    // unless the tree never exposes a resource type at all, in which case we cannot tell.
    const anyTyped = entries.some((e) => resourceTypeOf(e) !== null);
    return { instances: [], via: "none", undecidable: entries.length > 0 && !anyTyped };
  }

  for (const key of memberKeys(member)) {
    const hit = inScope(index.byKey.get(key) ?? []);
    if (hit.length) return { instances: hit, via: "locator" };
  }

  if (member.label) {
    for (const label of [member.label, localName(member.label)]) {
      const hit = inScope(index.byLabel.get(label) ?? []);
      if (hit.length) return { instances: hit, via: "label" };
    }
  }
  return { instances: [], via: "none" };
}

function matchSpecNode(index: TreeIndex, node: SpecNode, scope: TreeNode[] | null): TreeNode[] {
  const inScope = (nodes: TreeNode[]): TreeNode[] => {
    const present = nodes.filter((n) => n.present !== false);
    if (!scope) return present;
    return present.filter((n) => scope.some((s) => s === n || isWithin(index, n, s)));
  };
  const byId = index.bySpecNodeId.get(node.id);
  if (byId?.length) {
    const hit = inScope(byId);
    if (hit.length) return hit;
  }
  const locators = [node.locator, ...(node.altLocators ?? [])].filter((l): l is SpecLocator => Boolean(l));
  for (const locator of locators) {
    for (const key of locatorKeys(locator)) {
      const hit = inScope(index.byKey.get(key) ?? []);
      if (hit.length) return hit;
    }
  }
  return [];
}

/* ========================================================================== *
 * Values
 * ========================================================================== */

function valueOf(node: TreeNode): string | null {
  if (node.value !== null && node.value !== undefined) return node.value;
  if (typeof node.raw === "string") return node.raw;
  return null;
}

/** Present in the message but carrying nothing — HL7's `||`, an empty XML element. */
function isEmptyInstance(node: TreeNode): boolean {
  if (node.children.length > 0) return false;
  const v = valueOf(node);
  return v === null || v.trim() === "";
}

function attributeValue(node: TreeNode, attribute: string): TreeNode | null {
  const want = attribute.toLowerCase();
  for (const child of node.children) {
    if (child.kind !== "attribute") continue;
    const label = child.label.replace(/^@/, "").toLowerCase();
    if (label === want) return child;
    if (child.locator?.kind === "cdaXPath" && child.locator.attribute?.toLowerCase() === want) return child;
  }
  return null;
}

/**
 * The components of an HL7 composite instance. Prefers real component child nodes (what a
 * parser produces); falls back to splitting the raw text on the component separator, which
 * is only correct for the default `^` encoding characters — so callers demote when they had
 * to fall back.
 */
function componentsOf(node: TreeNode, separator: string): { values: (string | null)[]; exact: boolean } {
  const children = node.children.filter((c) => c.kind === "component");
  if (children.length) {
    const values: (string | null)[] = [];
    for (const child of children) {
      const at = child.occurrence >= 0 ? child.occurrence : values.length;
      values[at] = valueOf(child);
    }
    return { values, exact: true };
  }
  const raw = valueOf(node);
  if (raw === null) return { values: [], exact: false };
  return { values: raw.split(separator), exact: false };
}

function componentSeparator(datatypes: DatatypesBundle | null | undefined): string {
  const delims = datatypes?.delimiters as Record<string, { char?: string }> | undefined;
  return delims?.componentSeparator?.char ?? "^";
}

/* ========================================================================== *
 * Provenance / evidence helpers
 * ========================================================================== */

interface Evidence {
  provenance: Provenance | null;
  confidence: Confidence;
  derivation?: Derivation;
  verifiedAgainstSample?: boolean;
}

function evidenceOfMember(member: StructureMember): Evidence {
  return {
    provenance: member.provenance,
    confidence: member.confidence ?? "medium",
    derivation: member.derivation,
    verifiedAgainstSample: member.verifiedAgainstSample,
  };
}

function evidenceOfSpecNode(node: SpecNode): Evidence {
  return {
    provenance: node.provenance,
    confidence: node.confidence ?? "medium",
    derivation: node.derivation,
    verifiedAgainstSample: node.verifiedAgainstSample,
  };
}

/**
 * The severity ceiling a piece of evidence earns.
 *
 *   sample-derived rule  -> warn   (not in the published spec; never block on it alone)
 *   low confidence       -> warn
 *   otherwise            -> error  (no cap)
 *
 * This is the single place the "prefer warn whenever the spec is ambiguous" rule lives.
 */
function ceilingFor(evidence: Evidence): Severity {
  if (!evidence.provenance?.pageId) return "warn";
  if (evidence.confidence === "low") return "warn";
  return "error";
}

function ceilingReason(evidence: Evidence): string | null {
  if (!evidence.provenance?.pageId) {
    return "Reported as a warning rather than an error because the rule is not stated in the published specification.";
  }
  if (evidence.confidence === "low") {
    return `Reported as a warning rather than an error because the compiled rule is low confidence${
      evidence.provenance?.quote ? "" : ""
    }.`;
  }
  return null;
}

/* ========================================================================== *
 * Usage resolution
 * ========================================================================== */

interface UsageVerdict {
  /** The single usage code in force, or `null` when the context does not settle it. */
  usage: UsageCode | null;
  rules: UsageRule[];
  cardinality: Cardinality;
  certain: boolean;
  /** `true` when every candidate rule agrees on what a validator does. */
  unanimous: boolean;
  explanation: string;
}

function usageVerdictFor(node: { usage: UsageRule[] }, ctx: VariantContext): UsageVerdict {
  const resolution = resolveUsage(node, ctx);
  if (resolution.status === "resolved" && resolution.rule) {
    const rule = resolution.rule;
    return {
      usage: rule.usage,
      rules: resolution.candidates,
      cardinality: { min: rule.min, max: rule.max },
      certain: resolution.confidence === "high",
      unanimous: true,
      explanation: resolution.explanation,
    };
  }
  const candidates = resolution.candidates;
  if (candidates.length === 0) {
    return {
      usage: null,
      rules: [],
      cardinality: { min: null, max: null },
      certain: false,
      unanimous: false,
      explanation: resolution.explanation,
    };
  }
  // Ambiguous. If every candidate leads a validator to the same action, the ambiguity does
  // not matter for THIS message and we can still speak — otherwise we must not pick one.
  const verdicts = new Set(candidates.map((r) => r.validator));
  const usages = new Set(candidates.map((r) => r.usage));
  let min: number | null = null;
  let max: MaxOccurs = null;
  for (const rule of candidates) {
    if (rule.min !== null) min = min === null ? rule.min : Math.min(min, rule.min);
    if (rule.max === "*") max = "*";
    else if (typeof rule.max === "number" && max !== "*") max = max === null ? rule.max : Math.max(max, rule.max);
  }
  return {
    usage: verdicts.size === 1 && usages.size === 1 ? (candidates[0].usage ?? null) : null,
    rules: candidates,
    cardinality: { min, max },
    certain: false,
    unanimous: verdicts.size === 1,
    explanation: resolution.explanation,
  };
}

const USAGE_LABEL: Record<string, string> = {
  M: "M (mandatory)",
  R: "R (required)",
  R2: "R2 (required if known)",
  O: "O (optional)",
  I: "I (ignored — accepted then discarded)",
  X: "X (not used)",
  NP: "NP (SHALL NOT be present)",
  "-": "- (not part of this message)",
};

function describeUsage(usage: UsageCode | null): string {
  return usage ? (USAGE_LABEL[usage] ?? usage) : "no usage stated";
}

function describeCardinality(c: Cardinality): string {
  const min = c.min ?? 0;
  const max = c.max === null ? "*" : String(c.max);
  return `[${min}..${max}]`;
}

/* ========================================================================== *
 * Spec conflicts (structures.json#rules.conflicts)
 * ========================================================================== */

interface ConflictRule {
  conflict: SpecConflict;
  /** Segment / field token the conflict is about, upper-cased. */
  token: string;
  /** True when the compiled resolution tells a validator not to error. */
  neverError: boolean;
}

function conflictsForStructure(structure: MessageStructure, conflicts: readonly SpecConflict[] | null | undefined): ConflictRule[] {
  if (!conflicts?.length) return [];
  const variant = (structure.variant ?? "").toUpperCase();
  const out: ConflictRule[] = [];
  for (const conflict of conflicts) {
    const events = (conflict.event ?? "")
      .split(/[,/]/)
      .map((e) => e.trim().toUpperCase())
      .filter(Boolean);
    if (events.length && variant && !events.includes(variant)) continue;
    if (events.length && !variant) continue;
    const token = (conflict.field ?? "").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
    const guidance = `${conflict.validatorGuidance ?? ""} ${conflict.resolution ?? ""}`.toLowerCase();
    const neverError = /never error|do not raise an error|never raise|at most warn|do not error/.test(guidance);
    out.push({ conflict, token, neverError });
  }
  return out;
}

function conflictFor(rules: ConflictRule[], member: StructureMember): ConflictRule | null {
  const tokens = new Set<string>();
  if (member.kind === "segment") tokens.add(member.segment.toUpperCase());
  tokens.add(member.label.toUpperCase());
  for (const rule of rules) {
    if (rule.token && tokens.has(rule.token)) return rule;
  }
  return null;
}

/* ========================================================================== *
 * Error catalogue linkage
 * ========================================================================== */

function buildErrorIndex(entries: readonly ErrorCatalogueEntry[] | null | undefined): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!entries?.length) return map;
  for (const entry of entries) {
    for (const locator of entry.locators ?? []) {
      const value = (locator.value ?? "").trim();
      if (!value) continue;
      const key = value.toUpperCase().replace(/[-]/g, ".");
      const bucket = map.get(key);
      if (bucket) bucket.push(entry.id);
      else map.set(key, [entry.id]);
    }
  }
  return map;
}

function relatedErrors(index: Map<string, string[]>, locator: SpecLocator | null): string[] | undefined {
  if (!locator || index.size === 0) return undefined;
  const key = formatLocator(locator).toUpperCase().replace(/[-]/g, ".");
  return index.get(key);
}

/* ========================================================================== *
 * check()
 * ========================================================================== */

interface RunState {
  tree: StructureTree;
  structure: MessageStructure;
  opts: CheckOptions;
  ctx: VariantContext;
  index: TreeIndex;
  sink: Sink;
  conflicts: ConflictRule[];
  errorIndex: Map<string, string[]>;
  matched: Set<TreeNode>;
  requiredTotal: number;
  requiredSatisfied: number;
  membersConsidered: number;
  membersAligned: number;
  checksSkipped: string[];
  /** Members whose identity in the message could not be established. Reported, not judged. */
  undecidable: StructureMember[];
  suppressNodeVerdicts: boolean;
  valueSetNotice: Set<string>;
  separator: string;
  maxInstances: number;
}

function enabled(opts: CheckOptions, id: CheckId): boolean {
  return opts.checks?.[id] !== false;
}

/**
 * Check one parsed message against one compiled structure.
 *
 * Pure: the same tree, structure and options always produce the same findings, in the same
 * order, with the same ids.
 */
export function check(tree: StructureTree, structure: MessageStructure, opts: CheckOptions = {}): Finding[] {
  const ctx: VariantContext = opts.variantContext ?? {
    useCaseId: structure.useCaseId,
    ...(structure.variant ? { variant: structure.variant } : {}),
    ...(opts.conditions?.length ? { conditions: opts.conditions } : {}),
  };

  const state: RunState = {
    tree,
    structure,
    opts,
    ctx,
    index: indexTree(tree),
    sink: createSink({ ...DEFAULT_CAPS, ...(opts.caps ?? {}) }),
    conflicts: conflictsForStructure(structure, opts.conflicts),
    errorIndex: buildErrorIndex(opts.errorCatalogue),
    matched: new Set(),
    requiredTotal: 0,
    requiredSatisfied: 0,
    membersConsidered: 0,
    membersAligned: 0,
    checksSkipped: [],
    undecidable: [],
    suppressNodeVerdicts: false,
    valueSetNotice: new Set(),
    separator: componentSeparator(opts.datatypes),
    maxInstances: opts.maxInstancesPerRule ?? 3,
  };

  for (const id of [
    "order",
    "required",
    "forbidden",
    "cardinality",
    "composite",
    "fixedValues",
    "quarantinedOids",
    "valueSets",
    "unknownElements",
    "bundleFamily",
    "sampleDefects",
  ] as CheckId[]) {
    if (!enabled(opts, id)) state.checksSkipped.push(`${id}: switched off by the caller`);
  }
  if (!opts.tables?.size) {
    state.checksSkipped.push(
      "field-level checks (usage, fixed values, value sets inside segments/resources): no field tables were supplied",
    );
  }
  if (!opts.constants) state.checksSkipped.push("quarantined placeholder OIDs: constants.json was not supplied");
  if (!opts.sampleDefects) state.checksSkipped.push("known official-sample defects: sample-defects.json was not supplied");
  if (!opts.datatypes) state.checksSkipped.push("HL7 composite layout: datatypes.json was not supplied");

  /* --- 0. envelope sanity, parser diagnostics, compiled caveats ------------ */
  checkTreeAgainstStructure(state);
  if (enabled(opts, "parseDiagnostics")) carryParseDiagnostics(state);
  if (enabled(opts, "structureCaveats")) surfaceStructureCaveats(state);
  if (enabled(opts, "sampleDefects")) checkSampleDefects(state);

  /* --- alignment gate ----------------------------------------------------- */
  // Walk once to see whether this tree indexes the way we match at all. If a substantial
  // message aligns with NOTHING, the fault is in the alignment, not in the message: say so
  // and suppress node-level verdicts instead of emitting a page of phantom errors.
  const fatalParse = (tree.diagnostics ?? []).some((d) => d.severity === "error");
  if (state.index.presentCount <= 1 && (tree.text ?? "").trim().length > 0) {
    // The parser produced no content from a non-empty message. Every structural rule would
    // report "missing", which says nothing true about the HIS: the message never parsed.
    state.suppressNodeVerdicts = true;
    state.checksSkipped.push("all node-level verdicts: the message could not be parsed into any structure");
    state.sink.push({
      code: "alignment-failed",
      severity: "info",
      title: "The message could not be parsed, so no structural verdicts were produced",
      detail:
        (fatalParse
          ? "The parser reported a fatal problem with the message text (see the parse finding above). "
          : "The parser produced no content from this message. ") +
        "Nothing below claims the message satisfies or violates any specification rule — fix the text first, then re-run the check.",
      path: structure.id,
      provenance: { pageId: null, pageTitle: null, row: null, quote: `structure ${structure.id}` },
      caveat: null,
      confidence: "high",
    });
  }

  const probe = state.suppressNodeVerdicts ? { considered: 0, aligned: 0 } : probeAlignment(state);
  if (probe.considered > 0 && probe.aligned === 0 && state.index.presentCount >= 10) {
    state.suppressNodeVerdicts = true;
    state.checksSkipped.push("all node-level verdicts: the parsed tree could not be aligned with this structure");
    state.sink.push({
      code: "alignment-failed",
      severity: "info",
      title: "Could not align this message with the compiled structure",
      detail:
        `The message contains ${state.index.presentCount} parsed nodes, but none of the ${probe.considered} ` +
        `members of structure "${structure.id}" could be matched to any of them. Rather than report every ` +
        `member as missing — which would be ${probe.considered} false errors — no required, forbidden or ` +
        `cardinality verdict was produced. Check that the message was parsed against this structure.`,
      path: structure.root.label || structure.id,
      provenance: { pageId: null, pageTitle: null, row: null, quote: `structure ${structure.id}` },
      caveat: "This is a limitation of the checker on this input, not a statement about the message.",
      confidence: "high",
    });
  }

  /* --- 1..10 the structural walk ------------------------------------------ */
  walkMembers(state, structure.root.members, null, structure.root.label || structure.id, true);

  if (enabled(opts, "quarantinedOids")) checkQuarantinedOids(state);
  if (enabled(opts, "bundleFamily")) checkBundleFamily(state);
  if (enabled(opts, "unknownElements")) checkUnknownElements(state);
  reportConflicts(state);

  /* --- bookkeeping -------------------------------------------------------- */
  if (state.undecidable.length > 0) {
    state.checksSkipped.push(
      `presence of ${state.undecidable.length} member(s) whose identity in the message could not be established`,
    );
    state.sink.push({
      code: "structure-caveat",
      severity: "info",
      title: `${state.undecidable.length} structure member(s) could not be located and were NOT judged`,
      detail:
        `The compiled structure does not say how to recognise ${state.undecidable
          .slice(0, 6)
          .map((m) => m.label)
          .join(", ")}${state.undecidable.length > 6 ? ", …" : ""} in a message (for a Bundle.entry, the resource type is ` +
        "not stated). Reporting them as missing would be a guess, so their presence was neither confirmed nor denied.",
      path: structure.id,
      provenance: { pageId: null, pageTitle: null, row: null, quote: `structure ${structure.id}` },
      caveat: null,
      confidence: "high",
    });
  }

  if (state.sink.unevidenced > 0) {
    state.sink.push({
      code: "unevidenced-rule-skipped",
      severity: "info",
      title: `${state.sink.unevidenced} compiled rule(s) carry no evidence and were NOT checked`,
      detail:
        "These rows have neither a Confluence quote nor an official-sample reference, so the workbench " +
        "cannot say what they require. They are listed here rather than silently passed: " +
        `${state.sink.unevidencedPaths.slice(0, 8).join(", ")}${state.sink.unevidencedPaths.length > 8 ? ", …" : ""}.`,
      path: structure.id,
      provenance: { pageId: null, pageTitle: null, row: null, quote: `structure ${structure.id}` },
      caveat: "This is a gap in the compiled specification, not a defect in the message.",
      confidence: "high",
    });
  }
  for (const [code, dropped] of state.sink.capped) {
    state.sink.push({
      code: "structure-caveat",
      severity: "info",
      title: `${dropped} further "${code}" finding(s) not listed`,
      detail: `The list was capped to keep it readable. Fix the ones shown and re-run to see the rest.`,
      path: structure.id,
      provenance: { pageId: null, pageTitle: null, row: null, quote: `cap on ${code}` },
      caveat: null,
      confidence: "high",
    });
  }

  const metrics: FindingMetrics = {
    requiredTotal: state.requiredTotal,
    requiredSatisfied: state.requiredSatisfied,
    membersAligned: state.membersAligned,
    membersConsidered: state.membersConsidered,
    rulesWithoutEvidence: state.sink.unevidenced,
    checksSkipped: state.checksSkipped,
  };
  state.sink.push({
    code: "readiness-coverage",
    severity: "info",
    title: `${state.requiredSatisfied} of ${state.requiredTotal} required element(s) present`,
    detail:
      `Counted over every node whose usage resolved to M or R and which the checker actually evaluated ` +
      `(${state.membersAligned} of ${state.membersConsidered} structure members were matched in the message). ` +
      (state.checksSkipped.length ? `Checks not run: ${state.checksSkipped.join("; ")}.` : "Every check ran."),
    path: structure.id,
    provenance: { pageId: null, pageTitle: null, row: null, quote: `structure ${structure.id}` },
    caveat: null,
    confidence: "high",
    metrics,
  });

  return sortFindings(dedupeFindings(state.sink.findings));
}

/* ========================================================================== *
 * 0. Envelope sanity, diagnostics, caveats
 * ========================================================================== */

function checkTreeAgainstStructure(state: RunState): void {
  const { tree, structure, sink } = state;
  if (tree.structureId && tree.structureId !== structure.id) {
    sink.push({
      code: "structure-mismatch",
      severity: "warn",
      title: `Message was parsed as "${tree.structureId}" but checked against "${structure.id}"`,
      detail:
        "Usage, cardinality and ordering differ between structures, so some findings below may not apply. " +
        "Re-run the check against the structure the message was parsed as.",
      path: structure.id,
      expected: structure.id,
      actual: tree.structureId,
      provenance: { pageId: null, pageTitle: null, row: null, quote: `parsed as ${tree.structureId}` },
      caveat: null,
      confidence: "high",
    });
  }
  if (tree.encoding !== "unknown" && structure.encoding !== tree.encoding) {
    sink.push({
      code: "structure-mismatch",
      severity: "warn",
      title: `Message encoding "${tree.encoding}" does not match the structure's "${structure.encoding}"`,
      detail: "The checker compared them anyway; treat the findings below with that in mind.",
      path: structure.id,
      expected: structure.encoding,
      actual: tree.encoding,
      provenance: { pageId: null, pageTitle: null, row: null, quote: `encoding ${structure.encoding}` },
      caveat: null,
      confidence: "high",
    });
  }
}

function carryParseDiagnostics(state: RunState): void {
  for (const diagnostic of state.tree.diagnostics ?? []) {
    state.sink.push({
      code: "parse-diagnostic",
      severity: diagnostic.severity,
      title: diagnostic.message,
      detail: "Reported by the parser about the message text itself, before any specification rule was applied.",
      path: `${state.structure.id}${diagnostic.nodeId ? `/${diagnostic.nodeId}` : ""}`,
      location: diagnostic.loc ?? null,
      provenance: { pageId: null, pageTitle: null, row: null, quote: diagnostic.message },
      caveat: null,
      confidence: "high",
    });
  }
}

/**
 * Caveats the compiled spec records about this structure — "no golden sample exists", "this
 * envelope is derived from the samples, not from Confluence", "this templateId appears in
 * no Confluence page". `structure.notes` exists precisely so a checker surfaces these
 * rather than hiding them, so they are shown on every check, clean message or not.
 */
function surfaceStructureCaveats(state: RunState): void {
  const { structure, sink } = state;
  for (const note of structure.notes ?? []) {
    sink.push({
      code: "structure-caveat",
      severity: "info",
      title: "Caveat on this message structure",
      detail: note,
      path: structure.id,
      provenance: { pageId: null, pageTitle: null, row: null, quote: note },
      caveat: null,
      confidence: structure.confidence,
      verifiedAgainstSample: structure.verifiedAgainstSample,
    });
  }
  if (structure.verifiedAgainstSample === false || structure.confidence === "low") {
    sink.push({
      code: "structure-caveat",
      severity: "info",
      title: `Structure "${structure.id}" is ${structure.confidence} confidence`,
      detail:
        structure.confidenceReason ??
        "No official sample was available to verify this structure, so the checks below rest on the published tables alone.",
      path: structure.id,
      provenance: {
        pageId: null,
        pageTitle: null,
        row: null,
        quote: structure.confidenceReason ?? `confidence: ${structure.confidence}`,
      },
      caveat: null,
      confidence: structure.confidence,
      verifiedAgainstSample: structure.verifiedAgainstSample,
    });
  }
}

/* ========================================================================== *
 * 11. Known defects in the OFFICIAL samples
 * ========================================================================== */

/**
 * Did the hospital paste a copy of an official sample that is itself defective? Four
 * medication bundles carry `//` comments and are not valid JSON; two ITI-18 responses use a
 * lower-case `<soap:envelope>`. A hospital whose message was rejected after copying one of
 * those needs to be told the sample was wrong — they did not cause it.
 *
 * Matching is on the verbatim `evidence` fragment recorded for each defect, and only for
 * fragments long enough to be distinctive (short ones would match innocent messages).
 */
function checkSampleDefects(state: RunState): void {
  const defects = state.opts.sampleDefects?.defects;
  if (!defects?.length) return;
  const text = state.tree.text ?? "";
  if (!text) return;

  // Group by the DEFECT, not by the file: the same faulty construct occurs in several
  // published samples, and naming one of them would tell the hospital they copied a file
  // they may never have opened. What is true, and useful, is that the construct in their
  // message is one NPHIES's own audit records as wrong.
  const byDefect = new Map<string, { defects: SampleDefect[]; files: Set<string> }>();
  for (const defect of defects) {
    const evidence = (defect.evidence ?? "").trim();
    if (evidence.length < 16) continue; // shorter fragments are not distinctive enough to claim a match
    if (!text.includes(evidence)) continue;
    const key = `${defect.defectType}|${defect.description}`;
    const bucket = byDefect.get(key);
    if (bucket) {
      bucket.defects.push(defect);
      bucket.files.add(defect.sampleFile);
    } else {
      byDefect.set(key, { defects: [defect], files: new Set([defect.sampleFile]) });
    }
  }

  for (const { defects: matched, files } of byDefect.values()) {
    const first = matched[0];
    const severity: Severity =
      first.severity === "fatal" ? "error" : first.severity === "major" ? "warn" : "info";
    const fileList = [...files];
    const workaround = matched.map((d) => d.workaround).find(Boolean) ?? undefined;
    state.sink.push({
      code: "known-sample-defect",
      severity,
      title: `Known defect in the official NPHIES samples: ${first.defectType}`,
      detail:
        `This message contains text recorded verbatim in NPHIES's own sample audit as a ${first.severity} defect ` +
        `(${first.description}) ` +
        `The same fault is present in ${fileList.length} official sample(s): ${fileList
          .slice(0, 3)
          .map((f) => f.split("/").pop())
          .join(", ")}${fileList.length > 3 ? `, +${fileList.length - 3} more` : ""}. ` +
        "If this message was built from one of those samples, YOU DID NOT CAUSE THIS — the published sample is wrong. " +
        (first.impact ? `Impact: ${first.impact}` : ""),
      path: `${state.structure.id}#sample-defect`,
      location: first.location?.line ? { line: first.location.line, startCol: 0, endCol: 0 } : null,
      provenance: {
        pageId: null,
        pageTitle: null,
        row: first.location?.jsonPath ?? null,
        quote: first.evidence ?? null,
        sample: fileList[0],
      },
      caveat:
        "This finding is an audit of the published sample files, not a rule from the specification: the samples " +
        "are wrong, and a message copied from one of them can fail before any NPHIES validation runs.",
      confidence: (first.confidence as Confidence) ?? "medium",
      fix: workaround,
      actual: first.evidence ?? undefined,
    });
  }
}

/* ========================================================================== *
 * The structural walk: order, required, forbidden, cardinality, per-node checks
 * ========================================================================== */

function probeAlignment(state: RunState): { considered: number; aligned: number } {
  let considered = 0;
  let aligned = 0;
  const step = (members: readonly StructureMember[], scope: TreeNode[] | null) => {
    for (const member of members) {
      considered++;
      const { instances } = matchInstances(state.index, member, scope);
      if (instances.length) {
        aligned++;
        step(membersOf(member), instances);
      }
    }
  };
  step(state.structure.root.members, null);
  return { considered, aligned };
}

function pathFor(prefix: string, member: StructureMember): string {
  const locator = member.kind === "segment" ? member.segment : memberLocator(member);
  const label = member.kind === "segment" ? member.segment : locator ? formatLocator(locator as SpecLocator) : member.label;
  return `${prefix}/${typeof label === "string" ? label : member.label}`;
}

function walkMembers(
  state: RunState,
  members: readonly StructureMember[],
  scope: TreeNode[] | null,
  pathPrefix: string,
  parentPresent: boolean,
): void {
  const observed: { member: StructureMember; order: number; path: string }[] = [];

  for (const member of members) {
    const path = pathFor(pathPrefix, member);
    const { instances, undecidable } = matchInstances(state.index, member, scope);
    state.membersConsidered++;
    if (undecidable) state.undecidable.push(member);
    if (instances.length) {
      state.membersAligned++;
      for (const instance of instances) state.matched.add(instance);
      observed.push({ member, order: orderOf(state.index, instances[0]), path });
    }

    if (parentPresent && !state.suppressNodeVerdicts && !undecidable) {
      judgeMember(state, member, instances, path);
    }

    // Field-level detail, only inside a parent that is actually there.
    if (instances.length && !state.suppressNodeVerdicts) {
      checkSpecTablesFor(state, member, instances, path);
    }

    const children = membersOf(member);
    if (children.length) {
      walkMembers(state, children, instances.length ? instances : scope, path, parentPresent && instances.length > 0);
    }
  }

  if (enabled(state.opts, "order") && !state.suppressNodeVerdicts) {
    checkOrder(state, members, observed, pathPrefix);
  }
}

/* ------------------------------------------------- 2/3/4 usage + cardinality */

function judgeMember(state: RunState, member: StructureMember, instances: TreeNode[], path: string): void {
  const verdict = usageVerdictFor(member, state.ctx);
  const evidence = evidenceOfMember(member);
  const present = instances.length > 0;
  const nonEmpty = instances.filter((n) => !isEmptyInstance(n));
  const conflict = conflictFor(state.conflicts, member);
  const first = instances[0] ?? null;
  const locator = memberLocator(member);

  const base = {
    path,
    memberId: member.id,
    specNodeId: null,
    provenance: evidence.provenance,
    confidence: evidence.confidence,
    derivation: evidence.derivation,
    verifiedAgainstSample: evidence.verifiedAgainstSample,
    rules: verdict.rules,
    location: first?.loc ?? null,
    documentOrder: first ? orderOf(state.index, first) : undefined,
    relatedErrorIds: relatedErrors(state.errorIndex, locator),
  } satisfies Partial<FindingInput>;

  let ceiling = ceilingFor(evidence);
  const notes: (string | null)[] = [ceilingReason(evidence)];
  if (conflict?.neverError) {
    ceiling = capSeverity(ceiling, "warn");
    notes.push(
      `Two published sources disagree here; the compiled resolution is: ${conflict.conflict.resolution ?? conflict.conflict.validatorGuidance}`,
    );
  }
  if (!verdict.certain && verdict.unanimous && verdict.rules.length > 1) {
    notes.push(
      `The row carries conditional usage (${verdict.rules
        .map((r) => `${r.usage ?? "?"}${r.condition ? ` when ${r.condition}` : ""}`)
        .join("; ")}), but every reading requires the same thing here.`,
    );
  }

  // --- unresolved conditional usage: warn, never decide ---------------------
  if (verdict.usage === null && verdict.rules.length > 0 && !verdict.unanimous) {
    const wouldMatter = verdict.rules.some((r) => (present ? r.validator.includes("if-present") : r.validator.includes("if-missing")));
    if (wouldMatter) {
      state.sink.push({
        ...base,
        code: "conditional-usage-unresolved",
        severity: capSeverity("warn", ceiling),
        title: `${member.label}: conditional usage could not be resolved`,
        detail: `${verdict.explanation} ${present ? "The element IS present" : "The element is absent"}, and the readings disagree about whether that is correct, so no verdict was reached.`,
        notes,
        fix: "Tell the workbench which variant/condition this message is (Build tab → variant selector) and re-run the check.",
      });
    }
    return;
  }
  if (verdict.usage === null) return; // nothing stated: silence, not a guess

  // --- required ------------------------------------------------------------
  const requiredCodes: UsageCode[] = ["M", "R"];
  if (requiredCodes.includes(verdict.usage)) {
    state.requiredTotal++;
    const min = verdict.cardinality.min ?? 1;
    if (nonEmpty.length >= Math.max(1, min)) state.requiredSatisfied++;
  }

  if (!enabled(state.opts, "required") && ["M", "R", "R2"].includes(verdict.usage)) return;
  if (!enabled(state.opts, "forbidden") && ["NP", "X", "I", "-"].includes(verdict.usage)) return;

  const severity = severityOf(
    verdict.rules.find((r) => r.usage === verdict.usage)?.validator ?? "unknown",
    present && nonEmpty.length > 0,
  );

  if (severity === "error" || severity === "warn") {
    if (!present || nonEmpty.length === 0) {
      const emptyButPresent = present && nonEmpty.length === 0;
      state.sink.push({
        ...base,
        location: emptyButPresent ? (first?.loc ?? null) : null,
        code: verdict.usage === "R2" ? "recommended-field-missing" : "required-field-missing",
        severity: capSeverity(severity, ceiling),
        title: `${member.label} is ${verdict.usage === "R2" ? "recommended" : "required"} but ${emptyButPresent ? "empty" : "missing"}`,
        detail:
          `${describeLabel(member)} has usage ${describeUsage(verdict.usage)} ${describeCardinality(verdict.cardinality)} in ${
            state.structure.title
          }. ` +
          (emptyButPresent
            ? "It appears in the message but carries no value, which NPHIES treats the same as omitting it."
            : "It does not appear in the message."),
        notes,
        expected: `present ${describeCardinality(verdict.cardinality)}`,
        actual: emptyButPresent ? "present but empty" : "absent",
        fix: fixHintFor(member, verdict.usage),
      });
    } else {
      // usage X / NP / '-' present
      state.sink.push({
        ...base,
        code:
          verdict.usage === "NP"
            ? "forbidden-field-present"
            : verdict.usage === "-"
              ? "segment-not-in-this-event"
              : "unused-field-present",
        severity: capSeverity(severity, ceiling),
        title: `${member.label} is present but ${verdict.usage === "NP" ? "SHALL NOT be" : "is not used in this message"}`,
        detail: `${describeLabel(member)} has usage ${describeUsage(verdict.usage)} in ${state.structure.title}, and the message sends it ${instances.length} time(s).`,
        notes,
        expected: "absent",
        actual: `present ${instances.length}×`,
        fix: `Remove ${member.label} from the message.`,
      });
    }
  } else if (severity === "ignored" && present) {
    state.sink.push({
      ...base,
      code: "ignored-field-present",
      severity: "ignored",
      title: `${member.label} is accepted and then discarded`,
      detail: `NPHIES accepts ${describeLabel(member)} and discards it (usage I). Sending it is harmless, and you do not need to build it.`,
      notes,
      expected: "not required",
      actual: `present ${instances.length}×`,
    });
  }

  // --- cardinality ---------------------------------------------------------
  if (enabled(state.opts, "cardinality") && present) {
    checkCardinality(state, { ...base, notes }, verdict, instances.length, member.label, ceiling);
  }
}

function describeLabel(member: StructureMember): string {
  if (member.kind === "segment") return `Segment ${member.segment} (${member.label})`;
  if (member.kind === "entry") return `Bundle entry ${member.position} (${member.label})`;
  if (member.kind === "section") return `Section ${member.label}`;
  return member.label;
}

function fixHintFor(member: StructureMember, usage: UsageCode): string | undefined {
  if (usage === "R2") {
    return `Send ${member.label} whenever your system holds the value. NPHIES will accept the message without it.`;
  }
  if (member.kind === "segment") return `Add the ${member.segment} segment in its position in the message.`;
  if (member.kind === "entry") {
    return member.resourceType
      ? `Add a Bundle.entry carrying a ${member.resourceType} resource${member.profile ? ` conforming to ${member.profile}` : ""}.`
      : undefined;
  }
  return undefined;
}

function checkCardinality(
  state: RunState,
  base: Partial<FindingInput> & { path: string; provenance: Provenance | null; notes?: (string | null)[] },
  verdict: UsageVerdict,
  count: number,
  label: string,
  ceiling: Severity,
): void {
  const { min, max } = verdict.cardinality;
  const uncertain = !verdict.certain;
  const cap = uncertain ? capSeverity("warn", ceiling) : ceiling;
  const uncertainNote = uncertain
    ? "The applicable cardinality was not settled by the supplied context, so the widest reading of the row was used."
    : null;

  if (typeof max === "number" && count > max) {
    state.sink.push({
      ...base,
      code: "cardinality-too-many",
      severity: capSeverity("error", cap),
      title: `${label} repeats ${count} times; at most ${max} allowed`,
      detail: `The spec states ${describeCardinality(verdict.cardinality)} for ${label}.`,
      notes: [...(base.notes ?? []), uncertainNote],
      expected: describeCardinality(verdict.cardinality),
      actual: `${count} occurrence(s)`,
      rules: verdict.rules,
    } as FindingInput);
  }
  if (min !== null && count < min && count > 0) {
    state.sink.push({
      ...base,
      code: "cardinality-too-few",
      severity: capSeverity("error", cap),
      title: `${label} occurs ${count} time(s); at least ${min} required`,
      detail: `The spec states ${describeCardinality(verdict.cardinality)} for ${label}.`,
      notes: [...(base.notes ?? []), uncertainNote],
      expected: describeCardinality(verdict.cardinality),
      actual: `${count} occurrence(s)`,
      rules: verdict.rules,
    } as FindingInput);
  }
}

/* ------------------------------------------------------------- 1. ordering */

/**
 * Order findings.
 *
 * The structure member list IS the normative sequence for HL7 v2 (an ER7 message has no
 * other way to express it) and for the CDA header, where members carry an explicit
 * `documentOrder`. It is NOT normative for FHIR bundle entries beyond the first-entry rule,
 * so entries are excluded here and handled by {@link checkBundleFamily}; and for CDA body
 * sections and SOAP/XDS elements the published sources list an order without stating that
 * it binds, so those are capped at a warning with that caveat attached.
 *
 * The members reported are the ones OUTSIDE the longest run that is already in order — so a
 * single misplaced segment produces one finding, not one per following segment.
 */
function checkOrder(
  state: RunState,
  members: readonly StructureMember[],
  observed: { member: StructureMember; order: number; path: string }[],
  pathPrefix: string,
): void {
  if (observed.length < 2) return;
  const specOrder = new Map<string, number>();
  members.forEach((member, i) => {
    const explicit = (member as { documentOrder?: number }).documentOrder;
    specOrder.set(member.id, typeof explicit === "number" ? explicit : i);
  });

  // Members as they appear in the message, each with the position the spec gives it.
  const sequence = [...observed].sort((a, b) => a.order - b.order);
  const wanted = sequence.map((s) => specOrder.get(s.member.id) ?? 0);
  const keep = longestNonDecreasingRun(wanted);

  for (let i = 0; i < sequence.length; i++) {
    if (keep.has(i)) continue;
    const entry = sequence[i];
    const member = entry.member;
    if (member.kind === "entry") continue; // FHIR entry order is not normative past entry[0]
    const evidence = evidenceOfMember(member);
    const shouldFollow = members.filter((m) => (specOrder.get(m.id) ?? 0) < (specOrder.get(member.id) ?? 0));
    const shouldPrecede = members.filter((m) => (specOrder.get(m.id) ?? 0) > (specOrder.get(member.id) ?? 0));
    const normativeOrder = member.kind === "segment" || typeof (member as { documentOrder?: number }).documentOrder === "number";
    const ceiling = capSeverity(ceilingFor(evidence), normativeOrder ? "error" : "warn");
    const conflict = conflictFor(state.conflicts, member);
    const instance = state.index.byMemberId.get(member.id)?.[0] ?? null;

    state.sink.push({
      code: "sequence-out-of-order",
      severity: capSeverity("error", ceiling),
      title: `${member.label} is out of sequence`,
      detail:
        `The normative sequence for ${state.structure.title} is ${members.map((m) => shortName(m)).join(" → ")}. ` +
        `In this message ${shortName(member)} appears ${
          sequence
            .slice(0, i)
            .map((s) => shortName(s.member))
            .join(", ") || "first"
        }, after content that should follow it.`,
      notes: [
        ceilingReason(evidence),
        normativeOrder
          ? null
          : "The published tables list this order but do not state that it is binding, so this is reported as a warning.",
        conflict
          ? `The published sources conflict about this position. Compiled resolution: ${conflict.conflict.resolution ?? conflict.conflict.validatorGuidance}`
          : null,
        shouldFollow.length ? `It must come after ${shouldFollow.map(shortName).join(", ")}.` : null,
        shouldPrecede.length ? `It must come before ${shouldPrecede.map(shortName).join(", ")}.` : null,
      ],
      path: entry.path,
      memberId: member.id,
      location: instance?.loc ?? null,
      documentOrder: entry.order,
      provenance: evidence.provenance,
      confidence: evidence.confidence,
      derivation: evidence.derivation,
      verifiedAgainstSample: evidence.verifiedAgainstSample,
      expected: members.map(shortName).join(" → "),
      actual: sequence.map((s) => shortName(s.member)).join(" → "),
      fix: `Move ${shortName(member)} so the message reads ${members
        .filter((m) => observed.some((o) => o.member.id === m.id))
        .map(shortName)
        .join(" → ")}. Path: ${pathPrefix}`,
    });
  }
}

function shortName(member: StructureMember): string {
  if (member.kind === "segment") return member.segment;
  if (member.kind === "entry") return member.resourceType ?? member.label;
  return localName(member.label);
}

/** Indices of one longest non-decreasing subsequence — the members already in order. */
function longestNonDecreasingRun(values: number[]): Set<number> {
  const n = values.length;
  const best = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  let bestEnd = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (values[j] <= values[i] && best[j] + 1 > best[i]) {
        best[i] = best[j] + 1;
        prev[i] = j;
      }
    }
    if (best[i] > best[bestEnd]) bestEnd = i;
  }
  const keep = new Set<number>();
  for (let i = n ? bestEnd : -1; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

/* ========================================================================== *
 * Field tables: per-SpecNode usage, fixed values, composites, value sets
 * ========================================================================== */

function specNodesFor(state: RunState, member: StructureMember): SpecNode[] {
  const tables = state.opts.tables;
  if (!tables?.size || !member.specRefs?.length) return [];
  const out: SpecNode[] = [];
  for (const ref of member.specRefs) {
    const table = tables.get(ref.ref);
    if (!table) continue;
    for (const node of table.nodes) out.push(node);
  }
  return out;
}

/**
 * Reconcile spec nodes that describe the SAME location. A segment is routinely tabulated on
 * both its own page and a summary page. When the two agree we check once; when they
 * DISAGREE, that disagreement is itself the finding: we take the mildest reading and say
 * both pages, rather than pick a winner and produce a verdict the hospital cannot defend.
 */
interface ReconciledNode {
  node: SpecNode;
  others: SpecNode[];
  disagrees: boolean;
}

function reconcileByLocation(nodes: SpecNode[], ctx: VariantContext): ReconciledNode[] {
  const groups = new Map<string, SpecNode[]>();
  for (const node of nodes) {
    if (!node.locator) continue;
    const key = locatorKey(node.locator);
    const bucket = groups.get(key);
    if (bucket) bucket.push(node);
    else groups.set(key, [node]);
  }
  const out: ReconciledNode[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push({ node: group[0], others: [], disagrees: false });
      continue;
    }
    const verdicts = group.map((n) => usageVerdictFor(n, ctx).usage);
    const distinct = new Set(verdicts);
    const strength: Record<string, number> = { M: 5, R: 4, R2: 3, O: 2, I: 1, X: 1, NP: 5, "-": 5 };
    // Mildest reading first: never the strictest.
    const sorted = [...group].sort((a, b) => {
      const ua = usageVerdictFor(a, ctx).usage ?? "O";
      const ub = usageVerdictFor(b, ctx).usage ?? "O";
      return (strength[ua] ?? 0) - (strength[ub] ?? 0);
    });
    out.push({ node: sorted[0], others: sorted.slice(1), disagrees: distinct.size > 1 });
  }
  return out;
}

function checkSpecTablesFor(state: RunState, member: StructureMember, instances: TreeNode[], path: string): void {
  const nodes = specNodesFor(state, member);
  if (!nodes.length) return;
  const reconciled = reconcileByLocation(nodes, state.ctx);
  const limit = Math.min(instances.length, state.maxInstances);
  for (let i = 0; i < limit; i++) {
    const instance = instances[i];
    const suffix = instances.length > 1 ? `[${i}]` : "";
    checkSpecNodesUnder(state, reconciled, instance, `${path}${suffix}`);
  }
}

function checkSpecNodesUnder(state: RunState, nodes: ReconciledNode[], scope: TreeNode, pathPrefix: string): void {
  for (const { node, others, disagrees } of nodes) {
    if (!node.locator) continue;
    const instances = matchSpecNode(state.index, node, [scope]);
    for (const instance of instances) state.matched.add(instance);
    const path = `${pathPrefix}/${formatLocator(node.locator)}`;
    judgeSpecNode(state, node, others, disagrees, instances, path, scope);
    if (node.children.length && instances.length) {
      const childNodes = reconcileByLocation(node.children, state.ctx);
      checkSpecNodesUnder(state, childNodes, instances[0], path);
    }
  }
}

function judgeSpecNode(
  state: RunState,
  node: SpecNode,
  others: SpecNode[],
  disagrees: boolean,
  instances: TreeNode[],
  path: string,
  scope: TreeNode,
): void {
  const verdict = usageVerdictFor(node, state.ctx);
  const evidence = evidenceOfSpecNode(node);
  const present = instances.length > 0;
  const nonEmpty = instances.filter((n) => !isEmptyInstance(n));
  const first = instances[0] ?? null;

  let ceiling = ceilingFor(evidence);
  const notes: (string | null)[] = [ceilingReason(evidence)];
  if (disagrees) {
    ceiling = capSeverity(ceiling, "warn");
    notes.push(
      `Two published tables disagree about this field: ` +
        [node, ...others]
          .map((n) => `${n.provenance?.pageTitle ?? n.provenance?.pageId ?? "?"} says ${usageVerdictFor(n, state.ctx).usage ?? "?"}`)
          .join("; ") +
        ". The milder reading is applied.",
    );
  }

  const base = {
    path,
    specNodeId: node.id,
    provenance: evidence.provenance,
    confidence: evidence.confidence,
    derivation: evidence.derivation,
    verifiedAgainstSample: evidence.verifiedAgainstSample,
    rules: verdict.rules,
    location: first?.loc ?? null,
    documentOrder: first ? orderOf(state.index, first) : undefined,
    relatedErrorIds: relatedErrors(state.errorIndex, node.locator),
    notes,
  } satisfies Partial<FindingInput>;

  if (verdict.usage === null && verdict.rules.length > 0 && !verdict.unanimous) {
    const wouldMatter = verdict.rules.some((r) => (present ? r.validator.includes("if-present") : r.validator.includes("if-missing")));
    if (wouldMatter) {
      state.sink.push({
        ...base,
        code: "conditional-usage-unresolved",
        severity: capSeverity("warn", ceiling),
        title: `${labelOf(node)}: conditional usage could not be resolved`,
        detail: `${verdict.explanation} ${present ? "The field IS present." : "The field is absent."}`,
        fix: "Select the applicable variant/condition and re-run, or treat the strictest reading as authoritative.",
      });
    }
  } else if (verdict.usage !== null) {
    if (["M", "R"].includes(verdict.usage)) {
      state.requiredTotal++;
      if (nonEmpty.length >= Math.max(1, verdict.cardinality.min ?? 1)) state.requiredSatisfied++;
    }
    const severity = severityOf(
      verdict.rules.find((r) => r.usage === verdict.usage)?.validator ?? "unknown",
      present && nonEmpty.length > 0,
    );
    const allowRequired = enabled(state.opts, "required");
    const allowForbidden = enabled(state.opts, "forbidden");

    if ((severity === "error" || severity === "warn") && (!present || nonEmpty.length === 0)) {
      if (allowRequired) {
        const emptyButPresent = present && nonEmpty.length === 0;
        state.sink.push({
          ...base,
          location: emptyButPresent ? (first?.loc ?? null) : null,
          code: verdict.usage === "R2" ? "recommended-field-missing" : "required-field-missing",
          severity: capSeverity(severity, ceiling),
          title: `${labelOf(node)} is ${verdict.usage === "R2" ? "recommended" : "required"} but ${emptyButPresent ? "empty" : "missing"}`,
          detail:
            `${node.locator ? formatLocator(node.locator) : node.label} carries usage ${describeUsage(verdict.usage)} ` +
            `${describeCardinality(verdict.cardinality)}${node.datatype ? ` (datatype ${node.datatype})` : ""}.` +
            (emptyButPresent ? " It is present in the message but carries no value." : ""),
          expected: `present ${describeCardinality(verdict.cardinality)}`,
          actual: emptyButPresent ? "present but empty" : "absent",
          fix: verdict.usage === "R2" ? "Send it when your system holds the value; NPHIES accepts the message without it." : undefined,
        });
      }
    } else if ((severity === "error" || severity === "warn") && present) {
      if (allowForbidden) {
        state.sink.push({
          ...base,
          code: verdict.usage === "NP" ? "forbidden-field-present" : "unused-field-present",
          severity: capSeverity(severity, ceiling),
          title: `${labelOf(node)} is present but ${describeUsage(verdict.usage)}`,
          detail: `${node.locator ? formatLocator(node.locator) : node.label} must not be sent in this message.`,
          expected: "absent",
          actual: valueOf(first) ?? "present",
          fix: `Remove ${node.locator ? formatLocator(node.locator) : node.label}.`,
        });
      }
    } else if (severity === "ignored" && present && allowForbidden) {
      state.sink.push({
        ...base,
        code: "ignored-field-present",
        severity: "ignored",
        title: `${labelOf(node)} is accepted and discarded`,
        detail: `NPHIES accepts ${node.locator ? formatLocator(node.locator) : node.label} and then discards it. You do not need to build it.`,
        actual: valueOf(first) ?? "present",
      });
    }

    if (enabled(state.opts, "cardinality") && present) {
      checkCardinality(state, base, verdict, instances.length, labelOf(node), ceiling);
    }
  }

  if (!present) return;
  for (const instance of instances.slice(0, state.maxInstances)) {
    if (enabled(state.opts, "fixedValues")) checkFixedValues(state, node, instance, path, ceiling);
    if (enabled(state.opts, "composite")) checkComposite(state, node, instance, path, ceiling);
    if (enabled(state.opts, "valueSets")) checkValueSets(state, node, instance, path, ceiling);
  }
  void scope;
}

function labelOf(node: SpecNode): string {
  const label = node.label.replace(/\s+/g, " ").trim();
  const locator = node.locator ? formatLocator(node.locator) : null;
  return locator ? `${locator} ${label}` : label;
}

/* ------------------------------------------------------- 6. fixed values -- */

/**
 * Fixed values: OIDs, templateIds, profile URLs, resourceTypes, fixed codes. Expected and
 * actual are always shown side by side — the single most actionable thing the workbench can
 * print, because the HIS developer can diff the two strings without reading the spec.
 */
function checkFixedValues(state: RunState, node: SpecNode, instance: TreeNode, path: string, ceiling: Severity): void {
  const evidence = evidenceOfSpecNode(node);
  for (const rule of node.fixedValues) {
    if (rule.value === null) continue;
    const ruleEvidence: Evidence = {
      provenance: rule.provenance ?? evidence.provenance,
      confidence: evidence.confidence,
      derivation: evidence.derivation,
      verifiedAgainstSample: evidence.verifiedAgainstSample,
    };
    const cap = capSeverity(ceilingFor(ruleEvidence), ceiling);
    const scope = rule.scope ?? "wholeField";

    if (scope === "attribute" && rule.attribute) {
      const attr = attributeValue(instance, rule.attribute);
      const actual = attr ? valueOf(attr) : null;
      if (actual === null) continue; // absence is the usage check's business, not this one
      if (actual !== rule.value) {
        state.sink.push({
          code: "fixed-value-mismatch",
          severity: capSeverity("error", cap),
          title: `@${rule.attribute} must be "${rule.value}"`,
          detail: `The specification pins @${rule.attribute} on ${node.locator ? formatLocator(node.locator) : node.label}.`,
          notes: [ceilingReason(ruleEvidence)],
          path: `${path}/@${rule.attribute}`,
          specNodeId: node.id,
          location: attr?.loc ?? instance.loc ?? null,
          documentOrder: attr ? orderOf(state.index, attr) : orderOf(state.index, instance),
          provenance: ruleEvidence.provenance,
          confidence: ruleEvidence.confidence,
          derivation: ruleEvidence.derivation,
          verifiedAgainstSample: ruleEvidence.verifiedAgainstSample,
          expected: rule.value,
          actual,
          fix: `Set @${rule.attribute} to "${rule.value}".`,
        });
      }
      continue;
    }

    if (scope === "component") {
      checkFixedComponent(state, node, instance, rule.target ?? rule.attribute, rule.value, path, cap, ruleEvidence);
      continue;
    }

    const actual = valueOf(instance);
    if (actual === null || actual.trim() === "") continue;
    if (actual !== rule.value) {
      state.sink.push({
        code: "fixed-value-mismatch",
        severity: capSeverity("error", cap),
        title: `${labelOf(node)} must be "${rule.value}"`,
        detail: `The specification pins this value${rule.statementType ? ` (${rule.statementType})` : ""}.`,
        notes: [ceilingReason(ruleEvidence)],
        path,
        specNodeId: node.id,
        location: instance.loc ?? null,
        documentOrder: orderOf(state.index, instance),
        provenance: ruleEvidence.provenance,
        confidence: ruleEvidence.confidence,
        derivation: ruleEvidence.derivation,
        verifiedAgainstSample: ruleEvidence.verifiedAgainstSample,
        expected: rule.value,
        actual,
        fix: `Send exactly "${rule.value}".`,
      });
    }
  }
}

/* ---------------------------------------------------- 5. composite layout -- */

/**
 * A pinned component value, addressed by the component NAME the spec uses ("Assigning
 * Authority", "Name Of Coding System"). The HL7 v2.5.1 layout in `datatypes.json` turns
 * that name into a position, which is how we detect the classic defect: a bare id sent
 * where a CX with an assigning authority is required. Without a layout for the datatype we
 * say nothing — a guessed position would be exactly the confidently-wrong verdict this tool
 * exists to avoid.
 */
function checkFixedComponent(
  state: RunState,
  node: SpecNode,
  instance: TreeNode,
  componentName: string | null,
  expected: string,
  path: string,
  ceiling: Severity,
  evidence: Evidence,
): void {
  if (!componentName || !node.datatype) return;
  const layout = state.opts.datatypes?.compiledIndex?.componentLayouts?.[node.datatype];
  if (!layout?.length) return;
  const want = componentName.trim().toLowerCase();
  const slot = layout.find((c) => c.name.trim().toLowerCase() === want);
  if (!slot) return;

  const { values, exact } = componentsOf(instance, state.separator);
  const cap = exact ? ceiling : capSeverity(ceiling, "warn");
  const actual = values[slot.index - 1] ?? null;
  const shown = `${path}.${slot.index}`;

  if (actual === null || actual.trim() === "") {
    state.sink.push({
      code: "composite-component-missing",
      severity: capSeverity("error", cap),
      title: `${node.datatype} component ${slot.index} (${slot.name}) is missing`,
      detail:
        `${labelOf(node)} is a ${node.datatype}; the specification pins component ${slot.index} "${slot.name}" to ` +
        `"${expected}", but the message sends ${values.length} component(s)${values.length ? ` ("${values.join(state.separator)}")` : ""}. ` +
        `A bare value where a ${node.datatype} with ${slot.name} is required is one of the most common NPHIES rejections.`,
      notes: [
        ceilingReason(evidence),
        exact ? null : "Components were read by splitting the raw text, not from parsed component nodes.",
      ],
      path: shown,
      specNodeId: node.id,
      location: instance.loc ?? null,
      documentOrder: orderOf(state.index, instance),
      provenance: evidence.provenance,
      confidence: evidence.confidence,
      derivation: evidence.derivation,
      verifiedAgainstSample: evidence.verifiedAgainstSample,
      expected: `${node.datatype} with component ${slot.index} = "${expected}"`,
      actual: valueOf(instance) ?? "(empty)",
      fix: `Send ${formatLocator(node.locator ?? { kind: "xdsSlot", name: node.label })} as a full ${node.datatype}, with component ${slot.index} (${slot.name}) set to "${expected}".`,
    });
    return;
  }
  if (actual !== expected) {
    state.sink.push({
      code: "fixed-value-mismatch",
      severity: capSeverity("error", cap),
      title: `${node.datatype} component ${slot.index} (${slot.name}) must be "${expected}"`,
      detail: `${labelOf(node)} pins component ${slot.index} of its ${node.datatype}.`,
      notes: [ceilingReason(evidence), exact ? null : "Components were read by splitting the raw text."],
      path: shown,
      specNodeId: node.id,
      location: instance.loc ?? null,
      documentOrder: orderOf(state.index, instance),
      provenance: evidence.provenance,
      confidence: evidence.confidence,
      derivation: evidence.derivation,
      verifiedAgainstSample: evidence.verifiedAgainstSample,
      expected,
      actual,
      fix: `Set component ${slot.index} (${slot.name}) to "${expected}".`,
    });
  }
}

/** More components than the datatype defines — the message cannot mean what it says. */
function checkComposite(state: RunState, node: SpecNode, instance: TreeNode, path: string, ceiling: Severity): void {
  if (!node.datatype) return;
  const layout = state.opts.datatypes?.compiledIndex?.componentLayouts?.[node.datatype];
  if (!layout?.length) return;
  const { values, exact } = componentsOf(instance, state.separator);
  const used = values.length;
  if (used <= layout.length) return;
  const evidence = evidenceOfSpecNode(node);
  state.sink.push({
    code: "composite-too-many-components",
    severity: capSeverity("error", capSeverity(ceiling, exact ? "error" : "warn")),
    title: `${labelOf(node)} carries ${used} components; ${node.datatype} defines ${layout.length}`,
    detail:
      `HL7 v2.5.1 defines ${layout.length} components for ${node.datatype} ` +
      `(${layout.map((c) => `${c.index} ${c.name}`).join(", ")}). Anything beyond that cannot be interpreted.`,
    notes: [ceilingReason(evidence), exact ? null : "Components were read by splitting the raw text."],
    path,
    specNodeId: node.id,
    location: instance.loc ?? null,
    documentOrder: orderOf(state.index, instance),
    provenance: evidence.provenance,
    confidence: evidence.confidence,
    derivation: evidence.derivation,
    verifiedAgainstSample: evidence.verifiedAgainstSample,
    expected: `at most ${layout.length} components`,
    actual: `${used} components`,
    fix: `Check the delimiters: a stray "${state.separator}" inside a value must be escaped.`,
  });
}

/* ------------------------------------------------ 8. value set membership -- */

function codeCandidates(state: RunState, node: SpecNode, instance: TreeNode): { value: string; at: TreeNode }[] {
  const out: { value: string; at: TreeNode }[] = [];
  const codeAttr = attributeValue(instance, "code");
  if (codeAttr) {
    const v = valueOf(codeAttr);
    if (v && v.trim()) out.push({ value: v.trim(), at: codeAttr });
    return out;
  }
  const codeChild = instance.children.find((c) => localName(c.label).toLowerCase() === "code" && c.kind !== "attribute");
  if (codeChild) {
    const v = valueOf(codeChild);
    if (v && v.trim()) {
      out.push({ value: v.trim(), at: codeChild });
      return out;
    }
  }
  if (node.datatype && state.opts.datatypes?.compiledIndex?.componentLayouts?.[node.datatype]) {
    const { values } = componentsOf(instance, state.separator);
    const first = values[0];
    if (first && first.trim()) out.push({ value: first.trim(), at: instance });
    return out;
  }
  const v = valueOf(instance);
  if (v && v.trim()) out.push({ value: v.trim(), at: instance });
  return out;
}

function checkValueSets(state: RunState, node: SpecNode, instance: TreeNode, path: string, ceiling: Severity): void {
  for (const binding of node.valueSets) {
    if (!binding.valueSetId) continue;
    const set = state.opts.valueSets?.get(binding.valueSetId);

    // NEVER report a pass we did not perform.
    if (!set || binding.external || set.external || set.validation !== "enumerated" || !set.concepts?.length) {
      noticeValueSetNotChecked(state, node, binding, set ?? null, path);
      continue;
    }

    const candidates = codeCandidates(state, node, instance);
    if (!candidates.length) continue;
    const evidence: Evidence = {
      provenance: binding.provenance ?? node.provenance,
      confidence: (binding.confidence as Confidence) ?? node.confidence ?? "medium",
      derivation: node.derivation,
      verifiedAgainstSample: node.verifiedAgainstSample,
    };
    // A fuzzily-resolved binding is not a rule we can defend as an error.
    const fuzzy = binding.resolvedVia === "fuzzy" || evidence.confidence === "low";
    const cap = capSeverity(capSeverity(ceilingFor(evidence), ceiling), fuzzy ? "warn" : "error");

    for (const { value, at } of candidates) {
      const exact = set.concepts.some((c) => c.code === value);
      if (exact) continue;
      const insensitive = set.concepts.find((c) => c.code.toLowerCase() === value.toLowerCase());
      if (insensitive) {
        state.sink.push({
          code: "valueset-code-case",
          severity: capSeverity("warn", cap),
          title: `"${value}" matches ${set.title ?? binding.valueSetId} only if case is ignored`,
          detail: `The value set lists the code as "${insensitive.code}". NPHIES code comparison is case-sensitive.`,
          notes: [ceilingReason(evidence)],
          path,
          specNodeId: node.id,
          location: at.loc ?? null,
          documentOrder: orderOf(state.index, at),
          provenance: evidence.provenance,
          confidence: evidence.confidence,
          expected: insensitive.code,
          actual: value,
          fix: `Send "${insensitive.code}".`,
        });
        continue;
      }
      const near = set.concepts
        .filter((c) => c.code.toLowerCase().startsWith(value.slice(0, 2).toLowerCase()))
        .slice(0, 3)
        .map((c) => `${c.code}${c.display ? ` (${c.display})` : ""}`);
      state.sink.push({
        code: "valueset-code-unknown",
        severity: capSeverity("error", cap),
        title: `"${value}" is not in ${set.title ?? binding.valueSetId}`,
        detail:
          `${labelOf(node)} is bound to the value set "${set.title ?? binding.valueSetId}" ` +
          `(${set.conceptCount} concepts${binding.referenceText ? `, cited as "${binding.referenceText}"` : ""}), and "${value}" is not one of them.` +
          (near.length ? ` Codes starting similarly: ${near.join(", ")}.` : ""),
        notes: [
          ceilingReason(evidence),
          fuzzy ? `The binding to this value set was resolved by ${binding.resolvedVia}, so it is reported as a warning.` : null,
        ],
        path,
        specNodeId: node.id,
        location: at.loc ?? null,
        documentOrder: orderOf(state.index, at),
        provenance: evidence.provenance,
        confidence: evidence.confidence,
        expected: `a code from ${set.title ?? binding.valueSetId}`,
        actual: value,
      });
    }
  }
}

function noticeValueSetNotChecked(
  state: RunState,
  node: SpecNode,
  binding: ValueSetBinding,
  set: ValueSet | null,
  path: string,
): void {
  const key = binding.valueSetId ?? "?";
  if (state.valueSetNotice.has(key)) return;
  state.valueSetNotice.add(key);
  const external = binding.external || set?.external;
  state.sink.push({
    code: "valueset-not-checked",
    severity: "info",
    title: `Codes against "${binding.title ?? set?.title ?? key}" were NOT checked`,
    detail: external
      ? `This value set is maintained outside NPHIES (${set?.validation ?? "external"}), so the workbench cannot verify membership. ` +
        "No pass is being claimed for codes bound to it — verify them against the owning terminology."
      : set
        ? `The compiled set carries no enumerated concepts (validation: ${set.validation ?? "unknown"}), so membership could not be verified.`
        : "The value set was not supplied to the checker, so membership could not be verified.",
    path,
    specNodeId: node.id,
    provenance: binding.provenance ?? node.provenance,
    caveat: null,
    confidence: "high",
  });
}

/* ------------------------------------------------------ 7. quarantined OIDs */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Placeholder OIDs. `constants.json` quarantines 11 of them — runs of identical digits, the
 * `15000000…` sample-organisation fragment, OIDs only ever shown after "Example:". They are
 * sample data and are never valid in a real submission.
 *
 * Some carry `exemptContexts`, where the value IS normative — the CDA `xmlns:nphies`
 * namespace declaration is the important one, and flagging that would be a false error on
 * every conformant CDA document. Where the node's position confirms an exemption we stay
 * silent; where the OID appears somewhere we cannot place, we warn rather than error and
 * name the position the quarantine exempts.
 */
function checkQuarantinedOids(state: RunState): void {
  const quarantined = state.opts.constants?.compiledIndex?.quarantined;
  if (!quarantined?.length) return;

  for (const entry of quarantined) {
    const pattern = new RegExp(`(^|[^0-9.])${escapeRegExp(entry.oid)}($|[^0-9.])`);
    const hints = (entry.exemptContexts ?? []).map((ctx) => ({
      ctx,
      tokens: (ctx.context ?? "")
        .split(/[\s(),]+/)
        .filter((t) => t.includes(":") || t.includes("@") || t.includes("/"))
        .flatMap((t) => t.split("/").map((part) => part.replace(/^@/, "")))
        .filter((t) => t.length > 3),
    }));

    // A segment, its field and its component all contain the same OID text. Report the
    // INNERMOST node only: three findings for one placeholder is noise, and the deepest
    // node is the one the HIS developer has to change.
    const hits = state.index.all.filter((node) => {
      if (node.present === false) return false;
      const value = valueOf(node);
      return Boolean(value && pattern.test(value));
    });
    const innermost = hits.filter((node) => !hits.some((other) => other !== node && isWithin(state.index, other, node)));

    for (const node of innermost) {
      const value = valueOf(node) as string;
      const where = `${node.id} ${node.label} ${node.locator ? locatorKey(node.locator) : ""}`.toLowerCase();
      const exempt = hints.find((h) => h.tokens.some((t) => where.includes(t.toLowerCase())));
      if (exempt) continue; // normative in THIS position; the quarantine does not apply

      const unplaceable = hints.length > 0;
      state.sink.push({
        code: "quarantined-oid",
        severity: unplaceable ? "warn" : "error",
        title: `Placeholder OID ${entry.oid} in ${node.label}`,
        detail:
          `${entry.oid} is a placeholder from the published examples (${entry.reason ?? "quarantined by the spec compiler"}). ` +
          "It is sample data and is never valid in a real submission — a message carrying it identifies a fictional organisation." +
          (unplaceable
            ? ` This OID IS legitimate in one position: ${entry.exemptContexts.map((c) => c.context).join("; ")}. The checker could not confirm that this node is that position, so this is a warning rather than an error.`
            : ""),
        path: node.id,
        location: node.loc ?? null,
        documentOrder: orderOf(state.index, node),
        specNodeId: node.specNodeId,
        provenance: entry.provenance,
        confidence: (entry.confidence as Confidence) ?? "high",
        expected: "your organisation's real OID",
        actual: value,
        fix: "Replace it with the OID NPHIES issued to your organisation.",
      });
    }
  }
}

/* --------------------------------------------------------- 10. bundle family */

function findByKeys(index: TreeIndex, keys: string[]): TreeNode | null {
  for (const key of keys) {
    const hit = (index.byKey.get(key) ?? []).find((n) => n.present !== false);
    if (hit) return hit;
  }
  return null;
}

function resourceTypeOf(entry: TreeNode): string | null {
  const resource = entry.children.find((c) => c.kind === "resource");
  if (resource) {
    const typed = resource.children.find((c) => localName(c.label) === "resourceType");
    const v = typed ? valueOf(typed) : null;
    if (v) return v;
    if (resource.label) return localName(resource.label);
  }
  for (const node of descendantsOf(entry)) {
    if (localName(node.label) === "resourceType") {
      const v = valueOf(node);
      if (v) return v;
    }
  }
  return null;
}

/**
 * The FHIR bundle family rules: `Bundle.type` is fixed per family, and the first entry is
 * fixed (MessageHeader for the medications family, Composition for lab/rad documents). Both
 * rules are quoted in the compiled envelope, so both are checkable; when the tree does not
 * expose `Bundle.type` at all we say we could not check it rather than pass it.
 */
function checkBundleFamily(state: RunState): void {
  const envelope = state.structure.envelope;
  if (!envelope || envelope.kind !== "fhirBundle") return;

  const typeRule = envelope.bundleTypeRule as
    | { value?: string | null; provenance?: Provenance | null; source?: Provenance | null }
    | null
    | undefined;
  const firstRule = envelope.firstEntryRule as
    | { resourceType?: string | null; provenance?: Provenance | null; source?: Provenance | null }
    | null
    | undefined;

  if (typeRule?.value) {
    const typeNode = findByKeys(state.index, ["fhir~type", "fhir~Bundle.type"]) ?? findLabel(state.index, "type", 2);
    const actual = typeNode ? valueOf(typeNode) : null;
    const provenance = typeRule.provenance ?? typeRule.source ?? null;
    if (!typeNode || actual === null) {
      state.sink.push({
        code: "valueset-not-checked",
        severity: "info",
        title: "Bundle.type could not be located in the parsed message",
        detail: `This bundle family fixes Bundle.type to "${typeRule.value}". The checker could not find that element in the parsed tree, so it is NOT reporting it as correct.`,
        path: `${state.structure.id}/Bundle.type`,
        provenance,
        caveat: null,
        confidence: "medium",
      });
    } else if (actual !== typeRule.value) {
      state.sink.push({
        code: "bundle-type-mismatch",
        severity: "error",
        title: `Bundle.type must be "${typeRule.value}"`,
        detail: `${state.structure.title} is a ${typeRule.value} bundle; this message declares "${actual}". NPHIES routes the bundle on this value, so the whole message is rejected.`,
        path: `${state.structure.id}/Bundle.type`,
        location: typeNode.loc ?? null,
        documentOrder: orderOf(state.index, typeNode),
        provenance,
        confidence: "high",
        expected: typeRule.value,
        actual,
        fix: `Set Bundle.type to "${typeRule.value}".`,
      });
    }
  }

  if (firstRule?.resourceType) {
    const entries = state.index.all
      .filter((n) => n.kind === "entry" && n.present !== false)
      .sort((a, b) => orderOf(state.index, a) - orderOf(state.index, b));
    if (entries.length) {
      const actual = resourceTypeOf(entries[0]);
      const provenance = firstRule.provenance ?? firstRule.source ?? null;
      if (actual && actual !== firstRule.resourceType) {
        state.sink.push({
          code: "bundle-first-entry",
          severity: "error",
          title: `The first Bundle.entry must be a ${firstRule.resourceType}`,
          detail: `This message puts a ${actual} first. For ${state.structure.title}, NPHIES requires ${firstRule.resourceType} in entry[0].`,
          path: `${state.structure.id}/Bundle.entry[0]`,
          location: entries[0].loc ?? null,
          documentOrder: orderOf(state.index, entries[0]),
          provenance,
          confidence: "high",
          expected: firstRule.resourceType,
          actual,
          fix: `Move the ${firstRule.resourceType} resource to the first entry of the bundle.`,
        });
      }

      // Positional resourceType check, ONLY when the entry list aligns exactly — a bundle
      // with content variants shifts positions, and a shifted comparison is a false error.
      const entryMembers: StructureMember[] = [];
      const collect = (members: readonly StructureMember[]) => {
        for (const member of members) {
          if (member.kind === "entry") entryMembers.push(member);
          collect(membersOf(member));
        }
      };
      collect(state.structure.root.members);
      const hasVariants = entryMembers.some((m) => m.kind === "entry" && (m.variants?.length ?? 0) > 0);
      if (!hasVariants && entryMembers.length === entries.length) {
        for (let i = 0; i < entries.length; i++) {
          const member = entryMembers[i];
          if (member.kind !== "entry" || !member.resourceType) continue;
          const actualType = resourceTypeOf(entries[i]);
          if (!actualType || actualType === member.resourceType) continue;
          const evidence = evidenceOfMember(member);
          state.sink.push({
            code: "bundle-entry-resource-mismatch",
            severity: capSeverity("error", ceilingFor(evidence)),
            title: `entry[${i}] should carry a ${member.resourceType}`,
            detail: `${member.label}: the structure places a ${member.resourceType} at this position${
              member.resourceTypeSource ? ` (resource type established by ${member.resourceTypeSource})` : ""
            }; the message carries a ${actualType}.`,
            notes: [ceilingReason(evidence)],
            path: `${state.structure.id}/Bundle.entry[${i}]`,
            memberId: member.id,
            location: entries[i].loc ?? null,
            documentOrder: orderOf(state.index, entries[i]),
            provenance: evidence.provenance,
            confidence: evidence.confidence,
            derivation: evidence.derivation,
            verifiedAgainstSample: evidence.verifiedAgainstSample,
            expected: member.resourceType,
            actual: actualType,
          });
        }
      }
    }
  }
}

function findLabel(index: TreeIndex, label: string, maxDepth: number): TreeNode | null {
  for (const node of index.byLabel.get(label) ?? []) {
    const info = index.info.get(node);
    if (node.present !== false && info && info.depth <= maxDepth) return node;
  }
  return null;
}

/* ----------------------------------------------------- 9. unknown elements -- */

/**
 * Content in the message that no compiled rule describes. This is an INFO, never an error:
 * the compiled spec covers 3510 nodes but is not complete, so the honest reading is "we do
 * not know about this", not "this is wrong". Only the outermost unknown node in a subtree is
 * reported, so one unexpected resource does not produce forty findings.
 */
function checkUnknownElements(state: RunState): void {
  const interesting = new Set(["segment", "field", "entry", "element", "slot", "resource", "section"]);
  for (const node of state.index.all) {
    if (node.present === false) continue;
    if (!interesting.has(node.kind)) continue;
    if (state.matched.has(node)) continue;
    if (node.specNodeId || node.memberId) continue;
    const info = state.index.info.get(node);
    const parent = info?.parent ?? null;
    // Only the outermost unknown: if the parent is also unknown, it is already reported.
    if (parent && !state.matched.has(parent) && !parent.specNodeId && !parent.memberId && interesting.has(parent.kind)) {
      continue;
    }
    const value = valueOf(node);
    state.sink.push({
      code: "unknown-element",
      severity: "info",
      title: `${node.label} is not described by the compiled specification`,
      detail:
        `The message carries ${node.label}${value ? ` = "${truncate(value, 60)}"` : ""} at this position, and no rule in ` +
        `the compiled structure "${state.structure.id}" covers it. That may mean the element is not allowed here — or that ` +
        "the workbench's compiled specification is incomplete for this message. It is NOT being reported as an error.",
      path: node.id,
      location: node.loc ?? null,
      documentOrder: orderOf(state.index, node),
      provenance: { pageId: null, pageTitle: null, row: null, quote: `${node.label}${value ? `: ${truncate(value, 40)}` : ""}` },
      caveat: "Our specification may be incomplete rather than the message wrong; confirm with NPHIES before removing content.",
      confidence: "low",
    });
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/* ---------------------------------------------------- recorded spec conflicts */

/**
 * Surface the places the published spec disagrees with itself for THIS message, even when
 * the message is clean. An integrator who has read the same two pages needs to know which
 * reading the workbench applied and why.
 */
function reportConflicts(state: RunState): void {
  for (const rule of state.conflicts) {
    const source = rule.conflict.sources?.find((s) => s.pageId && s.quote) ?? rule.conflict.sources?.[0];
    state.sink.push({
      code: "spec-conflict",
      severity: "info",
      title: `Published sources disagree about ${rule.conflict.field ?? "this message"}${rule.conflict.event ? ` (${rule.conflict.event})` : ""}`,
      detail:
        `${(rule.conflict.sources ?? [])
          .map((s) => `${s.pageTitle ?? s.pageId}: "${s.quote}"${s.reading ? ` — read as ${s.reading}` : ""}`)
          .join(" vs ")}. Applied resolution: ${rule.conflict.resolution ?? rule.conflict.validatorGuidance ?? "none recorded"}.`,
      path: `${state.structure.id}#conflict`,
      provenance: source
        ? {
            pageId: source.pageId ?? null,
            pageTitle: source.pageTitle ?? null,
            row: source.row ?? null,
            quote: source.quote ?? null,
          }
        : null,
      caveat: null,
      confidence: (rule.conflict.confidence as Confidence) ?? "medium",
    });
  }
}

/* ========================================================================== *
 * Convenience loader — the ONLY function here that performs I/O
 * ========================================================================== */

/**
 * Fetch the bundles `check()` needs for one structure, using the loaders in
 * `structure.ts`. Kept separate from {@link check} so the checker itself stays pure and
 * trivially testable; a caller that already has the bundles (a test, a Node script, the
 * app's spec store) should build {@link CheckOptions} directly and never call this.
 *
 * Only the value sets actually bound by the supplied spec nodes are loaded — the full set
 * is 44,508 concepts and no message needs all of it.
 */
export async function loadCheckInputs(
  structure: MessageStructure,
  specNodes: ReadonlyMap<string, SpecNode>,
  loaders: {
    loadDatatypes: () => Promise<DatatypesBundle>;
    loadConstants: () => Promise<ConstantsBundle>;
    loadSampleDefects: () => Promise<unknown>;
    loadStructures: () => Promise<{ rules: Record<string, unknown> | null }>;
    loadErrors: () => Promise<Record<string, unknown>>;
    loadValueSet: (id: string) => Promise<ValueSet | null>;
  },
): Promise<CheckOptions> {
  const wanted = new Set<string>();
  for (const node of specNodes.values()) {
    for (const binding of node.valueSets) {
      if (binding.valueSetId && !binding.external) wanted.add(binding.valueSetId);
    }
  }
  const [datatypes, constants, sampleDefectsRaw, structuresBundle, errorsRaw, sets] = await Promise.all([
    loaders.loadDatatypes(),
    loaders.loadConstants(),
    loaders.loadSampleDefects(),
    loaders.loadStructures(),
    loaders.loadErrors(),
    Promise.all([...wanted].map(async (id) => [id, await loaders.loadValueSet(id)] as const)),
  ]);

  const valueSets = new Map<string, ValueSet>();
  for (const [id, set] of sets) if (set) valueSets.set(id, set);

  const rules = structuresBundle.rules as { conflicts?: SpecConflict[] } | null;
  const errors = (errorsRaw as { errors?: ErrorCatalogueEntry[] }).errors ?? null;

  return {
    variantContext: {
      useCaseId: structure.useCaseId,
      ...(structure.variant ? { variant: structure.variant } : {}),
    },
    specNodes,
    datatypes,
    constants,
    valueSets,
    sampleDefects: (sampleDefectsRaw as SampleDefectsBundle | null) ?? null,
    conflicts: rules?.conflicts ?? null,
    errorCatalogue: errors,
  };
}
