/**
 * NPHIES message STRUCTURE engine — types and pure helpers.
 *
 * This module is the contract every parser, emitter and checker in the workbench builds
 * against. It has three layers:
 *
 *   1. `SpecNode`        — one node type for an HL7 field, a FHIR element, a CDA element or
 *                          an XDS slot. They differ only in their LOCATOR, so the locator is
 *                          a discriminated union. This is the SPEC: what NPHIES says.
 *   2. `MessageStructure`— the ordered, nestable, repeatable shape of a whole message:
 *                          ADT's flat segment list, ORU's repeating { OBR {OBX}* }* group,
 *                          a CDA section tree, a FHIR bundle entry list, a SOAP envelope.
 *   3. `StructureTree`   — the runtime INSTANCE. A parser produces it from message text; an
 *                          emitter consumes it to produce message text. Because both sides
 *                          use the same tree, parse and emit are exact inverses: every node
 *                          instance carries its value, its source location for the UI, and a
 *                          link back to the `SpecNode` that governs it.
 *
 * Everything here is loaded from `src/spec/**`, which `scripts/compile-spec.mjs` generates
 * from `spec-build/*.json`. Every compiled rule carries `provenance { pageId, pageTitle,
 * row, quote }` where `quote` is VERBATIM Confluence text, so the UI can show an analyst
 * the exact sentence behind any claim. Nothing in the bundle is synthesised; where a rule
 * could not be sourced the compiler recorded a warning instead of guessing, and those
 * warnings are readable at `SpecManifest.warnings`.
 *
 * Correspondence with `src/ui/types.ts`: the UI's presentational `StructureNode`, `Region`
 * and `Severity` are deliberately NOT imported here — the engine must not depend on the
 * view layer. `SourceLocation` uses the same geometry as the UI's `Region` (1-based line,
 * 0-based inclusive `startCol`, 0-based EXCLUSIVE `endCol`), and {@link severityOf} emits
 * the UI's severity vocabulary, so the adapter between the two is mechanical.
 */

/* ========================================================================== *
 * Provenance
 * ========================================================================== */

/** Where a rule came from. `quote` is verbatim source text — never synthesised. */
export interface Provenance {
  /** Confluence page id, e.g. "7766393". `null` for rules derived from golden samples. */
  pageId: string | null;
  pageTitle: string | null;
  /** Row identifier within the page's table, e.g. "PID.3", "1.4", "Table 2 row 1 (MSH)". */
  row: string | null;
  /** VERBATIM text of the source row or sentence. */
  quote: string | null;
}

/** How much the compiler trusts a record. */
export type Confidence = "high" | "medium" | "low";

/* ========================================================================== *
 * Usage and cardinality
 * ========================================================================== */

/**
 * NPHIES usage legend (page 171278410), cross-tabbed against the cardinality column.
 *
 *   R  required · R2 required if known · O optional · I ignored (accepted then discarded)
 *   M  mandatory · X not used · NP SHALL NOT be present · `-` not present in this message
 */
export type UsageCode = "M" | "R" | "R2" | "O" | "I" | "X" | "NP" | "-";

/** What a validator does about a node carrying this usage. */
export type ValidatorVerdict =
  | "error-if-missing"
  | "warn-if-missing"
  | "ok"
  | "ignored"
  | "warn-if-present"
  | "error-if-present"
  | "unknown";

export interface UsageSemantics {
  meaning: string;
  validator: ValidatorVerdict;
}

/**
 * The authoritative legend, mirrored byte-for-byte in `scripts/compile-spec.mjs`.
 * {@link loadManifest} compares the two and records a mismatch rather than silently
 * preferring one — a disagreement means the bundle and the engine drifted apart.
 */
export const USAGE_SEMANTICS: Readonly<Record<UsageCode, UsageSemantics>> = {
  M: { meaning: "mandatory", validator: "error-if-missing" },
  R: { meaning: "required", validator: "error-if-missing" },
  R2: { meaning: "required if known", validator: "warn-if-missing" },
  O: { meaning: "optional", validator: "ok" },
  I: { meaning: "ignored (accepted then discarded by NPHIES)", validator: "ignored" },
  X: { meaning: "not used", validator: "warn-if-present" },
  NP: { meaning: "SHALL NOT be present", validator: "error-if-present" },
  "-": { meaning: "segment is not present in this message", validator: "error-if-present" },
};

/**
 * Upper bound of a cardinality. `'*'` is unbounded; `null` means the source stated no
 * maximum at all — which is NOT the same thing and must not be collapsed into `'*'`.
 */
export type MaxOccurs = number | "*" | null;

export interface Cardinality {
  min: number | null;
  max: MaxOccurs;
}

/**
 * One usage rule. Usage is always a LIST on a node, never a scalar: roughly 60 spec rows
 * carry conditional usage such as `"M\n(Report)\nNP\n(Order)"` with a positionally
 * parallel Max Rpt cell, and collapsing that to one value loses a real structural rule.
 */
export interface UsageRule extends Cardinality {
  /** `null` when the source cell held something the extractor could not map to a code. */
  usage: UsageCode | null;
  /** The condition this rule applies under, e.g. "Report", "For Height and Weight". */
  condition: string | null;
  validator: ValidatorVerdict;
  /** Verbatim cells, so the UI can show what was actually written. */
  raw: { usage: string | null; cardinality: string | null };
}

/** Severity vocabulary shared with the UI layer. */
export type Severity = "error" | "warn" | "ok" | "ignored" | "info";

/**
 * Map a verdict plus observed presence to a severity.
 * `present` is whether the node actually appears in the message being judged.
 */
export function severityOf(verdict: ValidatorVerdict, present: boolean): Severity {
  switch (verdict) {
    case "error-if-missing":
      return present ? "ok" : "error";
    case "warn-if-missing":
      return present ? "ok" : "warn";
    case "warn-if-present":
      return present ? "warn" : "ok";
    case "error-if-present":
      return present ? "error" : "ok";
    case "ignored":
      return "ignored";
    case "ok":
      return "ok";
    default:
      return "info";
  }
}

/* ========================================================================== *
 * Locators — the only thing that differs between the four families
 * ========================================================================== */

/**
 * An HL7 v2 position. `field` is the 1-based field number within the segment; `component`
 * and `subcomponent` are the HL7 v2.5.1 indexes (a NPHIES "accepted components" table is a
 * SELECTION of those indexes, never a re-numbering).
 */
export interface Hl7FieldLocator {
  kind: "hl7Field";
  segment: string;
  field: number;
  component?: number;
  subcomponent?: number;
}

/** A FHIR element. `path` is as written in the spec, e.g. `Bundle`, `./meta/profile`. */
export interface FhirPathLocator {
  kind: "fhirPath";
  path: string;
  /** The absolute path `path` is relative to, when `path` starts with `./`. */
  relativeTo?: string;
  /** Set when the element is an extension pinned to a canonical URL. */
  extensionUrl?: string;
}

/** A CDA element or attribute, addressed by XPath as the spec writes it. */
export interface CdaXPathLocator {
  kind: "cdaXPath";
  /** e.g. `./component/section[templateId='2.16.840.1.113883.3.3731.1.210.100.1']`. */
  path: string;
  relativeTo?: string;
  /** Set when the rule targets an attribute, e.g. `root`, `code`, `codeSystem`. */
  attribute?: string;
  /** Verbatim predicate text from inside `[...]`, usually a templateId constraint. */
  predicate?: string;
}

/** An XDS / ebRIM submission-metadata attribute or slot, addressed by name. */
export interface XdsSlotLocator {
  kind: "xdsSlot";
  name: string;
}

export type SpecLocator = Hl7FieldLocator | FhirPathLocator | CdaXPathLocator | XdsSlotLocator;

/** Canonical, stable string form of a locator — safe as a Map key. */
export function locatorKey(locator: SpecLocator): string {
  switch (locator.kind) {
    case "hl7Field": {
      const parts = [locator.segment, String(locator.field)];
      if (locator.component !== undefined) parts.push(String(locator.component));
      if (locator.subcomponent !== undefined) parts.push(String(locator.subcomponent));
      return `hl7:${parts.join(".")}`;
    }
    case "fhirPath":
      return `fhir:${locator.relativeTo ? `${locator.relativeTo}|` : ""}${locator.path}`;
    case "cdaXPath":
      return `cda:${locator.relativeTo ? `${locator.relativeTo}|` : ""}${locator.path}${
        locator.attribute ? `/@${locator.attribute}` : ""
      }`;
    case "xdsSlot":
      return `xds:${locator.name}`;
  }
}

/** Short human form for labels and findings, e.g. `PID-3`, `./meta/profile`. */
export function formatLocator(locator: SpecLocator): string {
  switch (locator.kind) {
    case "hl7Field": {
      let out = `${locator.segment}-${locator.field}`;
      if (locator.component !== undefined) out += `.${locator.component}`;
      if (locator.subcomponent !== undefined) out += `.${locator.subcomponent}`;
      return out;
    }
    case "fhirPath":
      return locator.path;
    case "cdaXPath":
      return locator.attribute ? `${locator.path}/@${locator.attribute}` : locator.path;
    case "xdsSlot":
      return locator.name;
  }
}

/** The family a locator belongs to. */
export function familyOfLocator(locator: SpecLocator): SpecFamily {
  switch (locator.kind) {
    case "hl7Field":
      return "hl7v2";
    case "fhirPath":
      return "fhir";
    case "cdaXPath":
      return "cda";
    case "xdsSlot":
      return "xds";
  }
}

/* ========================================================================== *
 * SpecNode
 * ========================================================================== */

export type SpecFamily = "hl7v2" | "fhir" | "cda" | "xds";

/**
 * What a node is FOR. This drives the workbench's central question — "what must I
 * actually build?".
 *
 *   `data`       carries clinical or administrative content the HIS must supply
 *   `structural` exists to hold the shape: a fixed OID, templateId, profile URL, set id
 *   `container`  groups children and carries no value of its own
 *   `omit`       NPHIES ignores or forbids it; building it is wasted effort
 */
export type SpecRole = "data" | "structural" | "container" | "omit";

/** A value the spec pins, e.g. an OID, a templateId, a profile URL, a fixed code. */
export interface FixedValueRule {
  value: string | null;
  /** What the statement targets: an attribute name, a component index, an element path. */
  target: string | null;
  /** e.g. `fixedValue`, `fixedUrl`, `attributeFixedValue`, `componentFixedValue`, `prohibited`. */
  statementType: string | null;
  /** `wholeField` | `attribute` | `component`. */
  scope: string | null;
  elementPath: string | null;
  attribute: string | null;
  component: string | number | null;
  provenance: Provenance | null;
}

/** A binding from a node to a NPHIES value set. */
export interface ValueSetBinding {
  /** `null` when the cited text is not an enumerated value set (e.g. an OID authority). */
  valueSetId: string | null;
  title: string | null;
  /** The text the page actually cited, e.g. "KSA Drug Allergy". */
  referenceText: string | null;
  /** Which column the reference was read from: `codeSet` or `guidance`. */
  column: string | null;
  /** How the id was resolved: `exact-title`, `previousName-alias`, `fuzzy`, … */
  resolvedVia: string | null;
  confidence: string | null;
  external: boolean | null;
  note: string | null;
  provenance: Provenance | null;
}

/** Length constraint as the spec wrote it. `max` is `null` when the cell said "No max". */
export interface LengthConstraint {
  raw: string | null;
  max: number | null;
}

/**
 * ONE node type for every family. HL7 fields, FHIR elements, CDA elements and XDS slots
 * differ only in their `locator`.
 */
export interface SpecNode {
  /** Stable id: `<pageId>:<tableIndex>:<rowIndex>`. */
  id: string;
  family: SpecFamily;
  /** Human label from the spec's Field / Resource / Section column. */
  label: string;
  /** Hierarchy number from the table's leading numbering column, e.g. "1.4.2". */
  number: string | null;
  /** `null` when the source row gave no parseable location. Never invented. */
  locator: SpecLocator | null;
  /** Further locations listed in the same cell (some rows cite two paths). */
  altLocators?: SpecLocator[];
  /** Verbatim contents of the location cell. */
  locatorRaw: string | null;
  role: SpecRole;
  /** True when the source row carried no role and the compiler inferred one from the tree. */
  roleInferred: boolean;
  roleConfidence: string | null;
  /** ALWAYS a list — conditional usage is real. See {@link resolveUsage}. */
  usage: UsageRule[];
  /** HL7 datatype (`CX`, `XPN`, …) or `null` outside HL7 v2. See {@link componentLayout}. */
  datatype: string | null;
  length: LengthConstraint | null;
  /** Verbatim Code Set column text, when the table has one. */
  codeSet: string | null;
  /** Verbatim guidance prose. */
  guidance: string | null;
  fixedValues: FixedValueRule[];
  valueSets: ValueSetBinding[];
  /** CDA templateId OIDs extracted from the locator predicate. */
  templateIds: string[];
  /** A note row that immediately preceded this row in the table. */
  noteBefore?: string;
  children: SpecNode[];
  provenance: Provenance | null;
}

/** Convenience: the single whole-field fixed value, when there is exactly one. */
export function fixedValueOf(node: SpecNode): string | null {
  const whole = node.fixedValues.filter((f) => f.scope === "wholeField" && f.value !== null);
  return whole.length === 1 ? whole[0].value : null;
}

/* ========================================================================== *
 * MessageStructure
 * ========================================================================== */

export type MessageEncoding = "hl7v2-er7" | "fhir-json" | "cda-xml" | "soap-xml" | "saml-xml" | "unknown";

/** A reference from a structure member to the field table that details it. */
export interface SpecRef {
  family: SpecFamily;
  pageId: string;
  tableIndex: number;
  /** `<pageId>:<tableIndex>` — the key used by {@link findTable}. */
  ref: string;
}

interface StructureMemberBase {
  /** Stable id, unique within its MessageStructure. */
  id: string;
  label: string;
  /** May the member appear more than once at this position? */
  repeats: boolean;
  usage: UsageRule[];
  provenance: Provenance | null;
  /** Field tables that detail this member's contents. */
  specRefs?: SpecRef[];
  guidance?: string | null;
}

/**
 * An explicit group. Groups are how repetition and nesting are modelled: ORU's
 * `{ OBR [NTE] { OBX [NTE] } }*` is a group with `repeats: true` whose members include a
 * nested group, and a CDA body is a group of sections.
 */
export interface StructureGroup extends StructureMemberBase {
  kind: "group";
  locator?: SpecLocator;
  members: StructureMember[];
}

/** One HL7 v2 segment at a position in the message. */
export interface StructureSegment extends StructureMemberBase {
  kind: "segment";
  /** Segment id, or a spec label such as `OBR-NTE` (an NTE that follows an OBR). */
  segment: string;
  /** Every source row that contributed, when a rule was cross-checked across tables. */
  sources?: Provenance[];
  agreesAcrossTables?: boolean | null;
  usageInStructureTable?: string | null;
  usageInEventMatrix?: string | null;
}

/** One `Bundle.entry` slot in a FHIR bundle. */
export interface StructureEntry extends StructureMemberBase {
  kind: "entry";
  position: number;
  /** `null` when no quotable sentence named the resource type; never guessed. */
  resourceType: string | null;
  /** `stated` (the rule names it) or `guidance-quote` (lifted from a quoted sentence). */
  resourceTypeSource: "stated" | "guidance-quote" | null;
  locator: FhirPathLocator;
  orderingConstraint?: string | null;
}

/** One CDA section (or sub-section) at a position in the document body. */
export interface StructureSection extends StructureMemberBase {
  kind: "section";
  position: number;
  number: string | null;
  /** templateId OIDs that identify this section. */
  templateIds: string[];
  locator: CdaXPathLocator | null;
  members: StructureMember[];
}

/** Any other addressed element: a bundle metadata field, a SOAP envelope element, a slot. */
export interface StructureElement extends StructureMemberBase {
  kind: "element";
  number?: string | null;
  locator: SpecLocator | null;
  fixedValues?: FixedValueRule[];
  valueSets?: ValueSetBinding[];
  /** Verbatim constraint cell where the source is a by-document-type matrix, not a rule. */
  constraint?: { kind: string; attribute: string; value: string; documentTypeColumn?: string };
  /** Parenthetical note carried on the source line. */
  note?: string | null;
  members?: StructureMember[];
}

export type StructureMember =
  | StructureGroup
  | StructureSegment
  | StructureEntry
  | StructureSection
  | StructureElement;

/** The members of any member that can have them. */
export function membersOf(member: StructureMember): StructureMember[] {
  if (member.kind === "group" || member.kind === "section") return member.members;
  if (member.kind === "element") return member.members ?? [];
  return [];
}

/** Envelope / document shape. Discriminated by `kind`. */
export type EnvelopeSpec =
  | {
      kind: "hl7v2Message";
      messageType: string | null;
      /** Always `\r`. Never configurable. */
      segmentTerminator: string;
      structureTable?: string | null;
      derivedShape?: string | null;
    }
  | {
      kind: "fhirBundle";
      /** `message` (MessageHeader first) or `document` (Composition first). */
      bundleType: string | null;
      bundleTypeRule: unknown;
      firstEntryRule: unknown;
      specPage: { pageId: string; pageTitle: string | null } | null;
    }
  | {
      kind: "cdaDocument";
      documentTemplateId: string | null;
      typeCode: string | null;
      typeCodeDisplay: string | null;
      typeCodeSystem: string | null;
      classCode: string | null;
      formatCode: string | null;
      mimeType: string | null;
      specPage: { pageId: string; pageTitle: string | null } | null;
    }
  | {
      kind: "soapEnvelope";
      soapVersion: string | null;
      wsAddressingAction: string | null;
      derivedFrom: string | null;
      serviceName: string | null;
    };

/**
 * The full shape of one message: one use case, optionally one variant of it
 * (an ADT event, a CDA rendering, a SOAP request vs response).
 */
export interface MessageStructure {
  /** e.g. `adt-a01`, `oru-r01`, `fhir-med-prescribe`, `xds-iti43-response`. */
  id: string;
  useCaseId: string;
  /** e.g. `A01`, `structured`, `request`. `null` when the use case has one shape. */
  variant: string | null;
  variantLabel: string | null;
  family: SpecFamily;
  encoding: MessageEncoding;
  title: string;
  /** `request` (what a hospital sends) or `response` (what NPHIES returns). */
  direction?: "request" | "response";
  confidence: Confidence;
  envelope: EnvelopeSpec | null;
  specRefs?: SpecRef[];
  /** The message itself, as a non-repeating root group. */
  root: StructureGroup;
  /** Caveats a checker must surface rather than hide, e.g. "no golden sample exists". */
  notes: string[];
}

/** Depth-first walk over a structure's members. Return `false` to skip a subtree. */
export function walkStructure(
  structure: MessageStructure | StructureGroup,
  visit: (member: StructureMember, path: StructureMember[]) => boolean | void,
): void {
  const root = "root" in structure ? structure.root : structure;
  const step = (member: StructureMember, path: StructureMember[]) => {
    if (visit(member, path) === false) return;
    const next = path.concat(member);
    for (const child of membersOf(member)) step(child, next);
  };
  for (const member of root.members) step(member, [root]);
}

/** Find one member by id. */
export function findMember(structure: MessageStructure, id: string): StructureMember | null {
  let found: StructureMember | null = null;
  walkStructure(structure, (member) => {
    if (found) return false;
    if (member.id === id) {
      found = member;
      return false;
    }
  });
  return found;
}

/* ========================================================================== *
 * StructureTree — the runtime instance
 * ========================================================================== */

/**
 * A span in the message text. Geometry matches the UI's `Region`:
 * 1-based `line`, 0-based inclusive `startCol`, 0-based EXCLUSIVE `endCol`.
 * `offset`/`endOffset` are absolute character offsets when the parser can supply them.
 */
export interface SourceLocation {
  line: number;
  startCol: number;
  endCol: number;
  offset?: number;
  endOffset?: number;
}

/**
 * What an instance node is, structurally, in the serialised message. Deliberately finer
 * than `SpecNode.role`: an emitter needs to know it is writing a component, not a field.
 */
export type TreeNodeKind =
  | "message"
  | "group"
  | "segment"
  | "field"
  | "repetition"
  | "component"
  | "subcomponent"
  | "entry"
  | "resource"
  | "element"
  | "attribute"
  | "slot"
  | "text";

/**
 * One node of the runtime tree.
 *
 * The invariant that makes parse and emit exact inverses: a node's `raw` is the exact text
 * the parser consumed at `loc`, and an emitter that writes `raw` for every node with one,
 * and serialises `value` for the rest, reproduces the input byte-for-byte. `present`
 * distinguishes "the message contains this, empty" from "the message omits this".
 */
export interface TreeNode {
  /** Instance path, unique in the tree, e.g. `PID[0].3[1].4.2` or `Bundle.entry[3]`. */
  id: string;
  kind: TreeNodeKind;
  label: string;
  /** Concrete locator for THIS instance (indexes resolved). `null` for unmapped content. */
  locator: SpecLocator | null;
  /** Id of the governing {@link SpecNode}. `null` when the message has content the spec
   *  does not describe — which is itself a finding, not something to hide. */
  specNodeId: string | null;
  /** Resolved spec node, filled in by {@link linkTree}. */
  spec?: SpecNode | null;
  /** Id of the {@link StructureMember} this node instantiates, when it is a top-level one. */
  memberId?: string | null;
  /** 0-based repetition index among siblings with the same locator. */
  occurrence: number;
  /** Leaf value, decoded (escape sequences resolved). `null` for containers. */
  value: string | null;
  /** Exact source text at `loc`, undecoded. Present when the node came from a parse. */
  raw?: string | null;
  /** Whether the message actually contains this node. */
  present: boolean;
  /** Where it sits in the message text; `null` for nodes an emitter is about to create. */
  loc: SourceLocation | null;
  children: TreeNode[];
}

/** A problem the parser hit that is about the text, not about spec conformance. */
export interface TreeDiagnostic {
  severity: Severity;
  code: string;
  message: string;
  loc: SourceLocation | null;
  /** Node id when the diagnostic is attributable to one. */
  nodeId?: string | null;
}

/**
 * The shared intermediate. A parser produces one from message text; an emitter consumes
 * one to produce message text; a checker walks one against a {@link MessageStructure}.
 */
export interface StructureTree {
  /** Id of the {@link MessageStructure} this tree was parsed against, if one was chosen. */
  structureId: string | null;
  useCaseId: string | null;
  family: SpecFamily | null;
  encoding: MessageEncoding;
  /** Original message text, so emitters can diff and the UI can render the code pane. */
  text: string;
  root: TreeNode;
  diagnostics: TreeDiagnostic[];
}

/** Depth-first walk. Return `false` to skip a subtree. */
export function walkTree(
  tree: StructureTree | TreeNode,
  visit: (node: TreeNode, path: TreeNode[]) => boolean | void,
): void {
  const root = "root" in tree ? tree.root : tree;
  const step = (node: TreeNode, path: TreeNode[]) => {
    if (visit(node, path) === false) return;
    const next = path.concat(node);
    for (const child of node.children) step(child, next);
  };
  step(root, []);
}

/** Every instance node governed by a given spec node. */
export function instancesOf(tree: StructureTree, specNodeId: string): TreeNode[] {
  const out: TreeNode[] = [];
  walkTree(tree, (node) => {
    if (node.specNodeId === specNodeId) out.push(node);
  });
  return out;
}

/** Every instance node at a locator. */
export function instancesAt(tree: StructureTree, locator: SpecLocator): TreeNode[] {
  const key = locatorKey(locator);
  const out: TreeNode[] = [];
  walkTree(tree, (node) => {
    if (node.locator && locatorKey(node.locator) === key) out.push(node);
  });
  return out;
}

/** Attach resolved {@link SpecNode}s to a tree in place, using an id -> node map. */
export function linkTree(tree: StructureTree, specNodes: ReadonlyMap<string, SpecNode>): StructureTree {
  walkTree(tree, (node) => {
    node.spec = node.specNodeId ? (specNodes.get(node.specNodeId) ?? null) : null;
  });
  return tree;
}

/* ========================================================================== *
 * Conditional usage resolution
 * ========================================================================== */

/**
 * What a caller knows about the message being judged, used to pick between conditional
 * usage rules. Nothing is inferred from the message itself here — the caller supplies it.
 */
export interface VariantContext {
  useCaseId?: string;
  /** e.g. `A01`, `structured`, `request`. */
  variant?: string;
  /** Free-form condition labels the caller has established, e.g. `["Report"]`. */
  conditions?: readonly string[];
  /** Full override: decide directly whether a condition string applies. */
  match?: (condition: string) => boolean | undefined;
}

export type UsageResolutionStatus =
  /** Exactly one rule applies. */
  | "resolved"
  /** The node carries no usage at all. */
  | "unknown"
  /** More than one rule could apply and the context does not separate them. */
  | "ambiguous";

export interface UsageResolution {
  status: UsageResolutionStatus;
  /** The winning rule, when `status === "resolved"`. */
  rule: UsageRule | null;
  /** How the rule was chosen. `"only"` = the node had a single rule. */
  via: "only" | "unconditional" | "condition-match" | "default-condition" | null;
  /** `exact` when a condition matched a caller-supplied label verbatim. */
  confidence: Confidence;
  /** Every rule that remained in contention. Show these when `ambiguous`. */
  candidates: UsageRule[];
  /** Human explanation, safe to render next to a finding. */
  explanation: string;
}

const normaliseCondition = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
const DEFAULT_CONDITION = /^(other|others|otherwise|default)\)?$/i;

/**
 * Did the caller supply anything at all to decide conditions with? A row reading
 * "M (Prescription Item) / NP (otherwise)" must NOT fall through to the catch-all when the
 * caller told us nothing — that would be a guess dressed as a resolution.
 */
function hasContext(ctx: VariantContext | undefined): boolean {
  return Boolean(ctx && (ctx.match || ctx.variant || ctx.useCaseId || (ctx.conditions && ctx.conditions.length > 0)));
}

function conditionMatches(condition: string, ctx: VariantContext | undefined): "exact" | "loose" | null {
  if (!ctx) return null;
  if (ctx.match) {
    const verdict = ctx.match(condition);
    if (verdict === true) return "exact";
    if (verdict === false) return null;
  }
  const want = normaliseCondition(condition);
  if (!want) return null;
  const labels: string[] = [];
  if (ctx.variant) labels.push(ctx.variant);
  if (ctx.useCaseId) labels.push(ctx.useCaseId);
  for (const c of ctx.conditions ?? []) labels.push(c);
  const norm = labels.map(normaliseCondition).filter(Boolean);
  if (norm.some((l) => l === want)) return "exact";
  if (norm.some((l) => l.includes(want) || want.includes(l))) return "loose";
  return null;
}

/** Anything carrying a usage list: a {@link SpecNode} or a {@link StructureMember}. */
export interface HasUsage {
  usage: UsageRule[];
}

/**
 * Pick the usage rule that applies, WITHOUT guessing.
 *
 * A node with several conditional rules and no context to separate them resolves to
 * `ambiguous` with every candidate listed — a confidently wrong structural rule is worse
 * than an acknowledged unknown, so callers must surface the ambiguity rather than take
 * the first rule.
 */
export function resolveUsage(node: HasUsage, ctx?: VariantContext): UsageResolution {
  const rules = node.usage ?? [];
  if (rules.length === 0) {
    return {
      status: "unknown",
      rule: null,
      via: null,
      confidence: "low",
      candidates: [],
      explanation: "The source row states no usage for this node.",
    };
  }
  if (rules.length === 1) {
    return {
      status: "resolved",
      rule: rules[0],
      via: "only",
      confidence: "high",
      candidates: rules,
      explanation: "The source row states a single, unconditional usage.",
    };
  }

  const conditional = rules.filter((r) => r.condition);
  const unconditional = rules.filter((r) => !r.condition);

  if (conditional.length > 0 && !hasContext(ctx)) {
    return {
      status: "ambiguous",
      rule: null,
      via: null,
      confidence: "low",
      candidates: rules,
      explanation:
        `This row carries conditional usage (` +
        rules.map((r) => `${r.usage ?? "?"}${r.condition ? ` when ${r.condition}` : ""}`).join("; ") +
        "). No variant context was supplied, so no rule was chosen — pass a VariantContext to decide.",
    };
  }

  const exact = conditional.filter((r) => conditionMatches(r.condition as string, ctx) === "exact");
  if (exact.length === 1) {
    return {
      status: "resolved",
      rule: exact[0],
      via: "condition-match",
      confidence: "high",
      candidates: rules,
      explanation: `Condition "${exact[0].condition}" matches the supplied context.`,
    };
  }
  if (exact.length === 0) {
    const loose = conditional.filter((r) => conditionMatches(r.condition as string, ctx) === "loose");
    if (loose.length === 1) {
      return {
        status: "resolved",
        rule: loose[0],
        via: "condition-match",
        confidence: "medium",
        candidates: rules,
        explanation: `Condition "${loose[0].condition}" matches the supplied context approximately; confirm before relying on it.`,
      };
    }
    const fallback = conditional.filter((r) => DEFAULT_CONDITION.test((r.condition as string).trim()));
    if (fallback.length === 1) {
      return {
        status: "resolved",
        rule: fallback[0],
        via: "default-condition",
        confidence: "medium",
        candidates: rules,
        explanation: `No stated condition matched, so the row's catch-all "${fallback[0].condition}" applies.`,
      };
    }
    if (conditional.length === 0 && unconditional.length === 1) {
      return {
        status: "resolved",
        rule: unconditional[0],
        via: "unconditional",
        confidence: "high",
        candidates: rules,
        explanation: "Only one unconditional usage is stated.",
      };
    }
  }

  return {
    status: "ambiguous",
    rule: null,
    via: null,
    confidence: "low",
    candidates: rules,
    explanation:
      `This row carries ${rules.length} conditional usages (` +
      rules.map((r) => `${r.usage ?? "?"}${r.condition ? ` when ${r.condition}` : ""}`).join("; ") +
      "). The supplied context does not say which applies, so no single rule was chosen.",
  };
}

/**
 * Effective cardinality. `certain` is false when usage was ambiguous — the envelope then
 * spans every candidate (widest min..max), which is the only safe summary.
 */
export function cardinalityOf(node: HasUsage, ctx?: VariantContext): Cardinality & { certain: boolean } {
  const resolution = resolveUsage(node, ctx);
  if (resolution.status === "resolved" && resolution.rule) {
    return { min: resolution.rule.min, max: resolution.rule.max, certain: true };
  }
  if (resolution.candidates.length === 0) return { min: null, max: null, certain: false };

  let min: number | null = null;
  let max: MaxOccurs = null;
  for (const rule of resolution.candidates) {
    if (rule.min !== null) min = min === null ? rule.min : Math.min(min, rule.min);
    if (rule.max === "*") max = "*";
    else if (typeof rule.max === "number" && max !== "*") max = max === null ? rule.max : Math.max(max, rule.max);
  }
  return { min, max, certain: false };
}

/**
 * True when NPHIES accepts the node and then discards it (usage `I`), or when the spec
 * marks it not-used / shall-not-be-present. These are the nodes a hospital does not need
 * to build — the single most useful thing the workbench can tell an integrator.
 */
export function isIgnored(node: HasUsage | SpecNode, ctx?: VariantContext): boolean {
  if ("role" in node && node.role === "omit") return true;
  const resolution = resolveUsage(node, ctx);
  if (resolution.status === "resolved" && resolution.rule) return resolution.rule.usage === "I";
  // Only call it ignored when EVERY candidate agrees; never on a majority.
  return resolution.candidates.length > 0 && resolution.candidates.every((r) => r.usage === "I");
}

/** The verdict a checker should apply to this node. */
export function verdictOf(node: HasUsage, ctx?: VariantContext): ValidatorVerdict {
  const resolution = resolveUsage(node, ctx);
  if (resolution.status === "resolved" && resolution.rule) return resolution.rule.validator;
  return "unknown";
}

/* ========================================================================== *
 * Bundle shapes (what src/spec/*.json actually contains)
 * ========================================================================== */

export interface SpecInputRecord {
  name: string;
  present: boolean;
  bytes: number;
  sha256: string | null;
  error: string | null;
}

export interface SpecWarning {
  scope: string;
  message: string;
  detail?: unknown;
}

export interface UseCaseVariantRef {
  id: string;
  variant: string;
  label: string;
  direction: "request" | "response";
}

/** Readiness of a use case, as the compiler judged it from the inputs it had. */
export type UseCaseStatus = "complete" | "partial" | "missing";

export interface UseCaseSummary {
  id: string;
  title: string;
  /** `saml` appears here although it is not a `SpecFamily`: it has no field tables. */
  family: SpecFamily | "saml" | "unknown";
  encoding: MessageEncoding;
  /** Confluence interface areas (ancestors[3]) that hold this use case's pages. */
  areas: string[];
  structureIds: string[];
  variants: UseCaseVariantRef[];
  /** Paths of the official golden samples, relative to `spec-source/`. */
  goldenSamples: string[];
  goldenSampleCount: number;
  goldenMissing: { reason: string; note: string | null } | null;
  /** Pages a compiled structure actually cites. Exact. */
  specPages: string[];
  /** Pages in the same Confluence area. A navigation aid, not a structural claim. */
  relatedPages: string[];
  status: UseCaseStatus;
  statusReasons: string[];
}

export interface FamilySummary {
  id: SpecFamily;
  label: string;
  file: string;
  pages: number;
  tables: number;
  nodes: number;
  segments: string[];
  areas: string[];
}

export interface SpecManifest {
  $schema: string;
  bundleVersion: number;
  generatedAt: string;
  generator: string;
  engine: string;
  inputs: SpecInputRecord[];
  missingInputs: string[];
  usageLegend: { source: Provenance; codes: Record<string, UsageSemantics>; note: string };
  files: {
    structures: string;
    datatypes: string;
    constants: string;
    errors: string;
    golden: string;
    fields: Record<SpecFamily, string>;
    valueSetIndex: string;
  };
  families: FamilySummary[];
  useCases: UseCaseSummary[];
  counts: Record<string, number>;
  coverage: {
    useCasesWithStructure: number;
    useCasesWithoutStructure: string[];
    useCasesWithoutGolden: string[];
    partial: string[];
    missing: string[];
  };
  warnings: SpecWarning[];
  files_written: string[];
}

export interface FieldTable {
  tableIndex: number;
  /** `segmentFields` | `resourceFields` | `sectionFields` | `attributeOptionality` | … */
  kind: string | null;
  /** HL7 segment id, for `segmentFields` tables. */
  segment: string | null;
  header: string[];
  columns: string[];
  numberingStyle: string | null;
  notes: { rowId: string; text: string | null; provenance: Provenance | null }[];
  nodes: SpecNode[];
}

export interface FieldPage {
  pageId: string;
  pageTitle: string | null;
  ancestors: string[];
  ancestorIds: string[];
  /** Interface area — `ancestors[3]`, e.g. "ADT", "Clinical Documents". */
  area: string | null;
  tables: FieldTable[];
}

export interface FieldBundle {
  family: SpecFamily;
  label: string;
  pages: Record<string, FieldPage>;
  index: {
    bySegment: Record<string, { ref: string; pageId: string; tableIndex: number; area: string | null; pageTitle: string | null; path: string }[]>;
    byArea: Record<string, string[]>;
  };
  counts: { pages: number; tables: number; nodes: number };
}

export interface StructuresBundle {
  $schema: string;
  usageLegend: unknown;
  usageSemantics: Record<UsageCode, UsageSemantics>;
  messageStructures: Record<string, MessageStructure>;
  structureIds: string[];
  /** The raw structural-rule corpus, preserved verbatim for the "explain" views. */
  rules: Record<string, unknown> | null;
}

export interface DatatypeComponent {
  index: number;
  name: string;
  datatype: string;
  maxLength: number | null;
  provenance: string | null;
}

export interface DatatypesBundle {
  hl7Version: string;
  delimiters: Record<string, unknown>;
  escapes: Record<string, unknown>;
  datatypes: Record<string, unknown>;
  compiledIndex: { componentLayouts: Record<string, DatatypeComponent[]> };
  [key: string]: unknown;
}

export interface QuarantinedOid {
  oid: string;
  reason: string | null;
  confidence: string | null;
  detectionRule: string | null;
  exemptContexts: { context: string; value?: string }[];
  provenance: Provenance | null;
}

export interface ConstantsBundle {
  oids?: unknown;
  identityOids?: unknown;
  fixedValues?: unknown[];
  fhirProfiles?: unknown;
  resourceTypes?: unknown;
  saml?: unknown;
  hl7Encoding?: unknown;
  compiledIndex: { quarantinedOids: string[]; quarantined: QuarantinedOid[] };
  [key: string]: unknown;
}

export interface ValueSetIndexEntry {
  title: string | null;
  aliases: string[];
  conceptCount: number;
  external: boolean;
  validation: string | null;
  pageId: string | null;
  file: string;
}

export interface ValueSetIndex {
  count: number;
  totalConcepts: number;
  valueSets: Record<string, ValueSetIndexEntry>;
  aliasIndex: Record<string, string>;
  aliasOrigin: Record<string, string>;
  unresolved: unknown[];
  bindingCount: number;
  [key: string]: unknown;
}

export interface ValueSetConcept {
  code: string;
  display: string | null;
  extra?: Record<string, unknown>;
}

export interface ValueSet {
  id: string;
  title: string | null;
  previousName: string | null;
  aliases: string[];
  version: string | null;
  definition: string | null;
  valueSetOid: string | null;
  codeSystemOid: string | null;
  scope: string | null;
  external: boolean;
  validation: string | null;
  columns: string[];
  conceptSource: string | null;
  conceptCount: number;
  concepts: ValueSetConcept[];
  provenance: Provenance | null;
}

/* ========================================================================== *
 * Loading
 * ========================================================================== */

/**
 * Resolves a bundle path such as `"index.json"` or `"valuesets/ksa-organism.json"` to its
 * parsed contents. The default implementation uses Vite's `import.meta.glob`, so every
 * bundle file becomes its own lazily fetched chunk — the 37k-concept value set is never
 * pulled into the main bundle. Override it for Node, tests or a different host.
 */
export type SpecResolver = (path: string) => Promise<unknown>;

const SPEC_PREFIX = "../spec/";

const globbed: Record<string, () => Promise<unknown>> =
  typeof import.meta.glob === "function"
    ? (import.meta.glob("../spec/**/*.json") as Record<string, () => Promise<unknown>>)
    : {};

function unwrapModule(mod: unknown): unknown {
  if (mod && typeof mod === "object" && "default" in (mod as Record<string, unknown>)) {
    return (mod as { default: unknown }).default;
  }
  return mod;
}

const defaultResolver: SpecResolver = async (path) => {
  const loader = globbed[`${SPEC_PREFIX}${path}`];
  if (!loader) {
    throw new Error(
      `spec bundle file "${path}" is not available. Run "node scripts/compile-spec.mjs" to build src/spec/, ` +
        `or call setSpecResolver() to supply your own loader (this happens outside Vite, e.g. in a plain Node script).`,
    );
  }
  return unwrapModule(await loader());
};

let resolver: SpecResolver = defaultResolver;
const cache = new Map<string, Promise<unknown>>();

/** Replace the loader. Clears the cache so the next read goes through the new resolver. */
export function setSpecResolver(next: SpecResolver): void {
  resolver = next;
  cache.clear();
}

/** Drop every cached bundle file. */
export function clearSpecCache(): void {
  cache.clear();
}

/** Bundle file paths this build can serve, relative to `src/spec/`. */
export function availableSpecFiles(): string[] {
  return Object.keys(globbed)
    .map((k) => k.slice(SPEC_PREFIX.length))
    .sort();
}

function loadFile<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit) return hit as Promise<T>;
  const pending = resolver(path).catch((err) => {
    cache.delete(path);
    throw err;
  });
  cache.set(path, pending);
  return pending as Promise<T>;
}

let manifestChecked = false;

/** The bundle manifest: use cases, families, counts, warnings, what is missing. */
export async function loadManifest(): Promise<SpecManifest> {
  const manifest = await loadFile<SpecManifest>("index.json");
  if (!manifestChecked) {
    manifestChecked = true;
    const codes = manifest.usageLegend?.codes ?? {};
    for (const code of Object.keys(USAGE_SEMANTICS) as UsageCode[]) {
      const shipped = codes[code];
      if (shipped && shipped.validator !== USAGE_SEMANTICS[code].validator) {
        // Do not silently prefer either side: the drift itself is the finding.
        console.warn(
          `[structure] usage legend drift for "${code}": bundle says "${shipped.validator}", engine says "${USAGE_SEMANTICS[code].validator}".`,
        );
      }
    }
  }
  return manifest;
}

/** Field tables (SpecNode trees) for one family. One file per family, code-split. */
export function loadFields(family: SpecFamily): Promise<FieldBundle> {
  return loadFile<FieldBundle>(`fields/${family}.json`);
}

export function loadStructures(): Promise<StructuresBundle> {
  return loadFile<StructuresBundle>("structures.json");
}

export function loadDatatypes(): Promise<DatatypesBundle> {
  return loadFile<DatatypesBundle>("datatypes.json");
}

export function loadConstants(): Promise<ConstantsBundle> {
  return loadFile<ConstantsBundle>("constants.json");
}

export function loadErrors(): Promise<Record<string, unknown>> {
  return loadFile<Record<string, unknown>>("errors.json");
}

export function loadGolden(): Promise<Record<string, unknown>> {
  return loadFile<Record<string, unknown>>("golden.json");
}

export function loadValueSetIndex(): Promise<ValueSetIndex> {
  return loadFile<ValueSetIndex>("valuesets/index.json");
}

/** One value set, by id or by any alias the spec used for it. */
export async function loadValueSet(idOrAlias: string): Promise<ValueSet | null> {
  const index = await loadValueSetIndex();
  let id = idOrAlias;
  if (!index.valueSets[id]) {
    const alias = index.aliasIndex[idOrAlias.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()];
    if (!alias) return null;
    id = alias;
  }
  const entry = index.valueSets[id];
  if (!entry) return null;
  return loadFile<ValueSet>(entry.file);
}

/* ------------------------------------------------------------- resolution -- */

/** A use case plus everything needed to parse, emit and check one of its messages. */
export interface ResolvedUseCase {
  useCase: UseCaseSummary;
  /** The chosen structure. */
  structure: MessageStructure;
  /** All structures for the use case, including responses and other variants. */
  structures: MessageStructure[];
  /** Every SpecNode any member of `structure` points at, keyed by node id. */
  specNodes: Map<string, SpecNode>;
  /** The field tables those nodes came from, keyed by `<pageId>:<tableIndex>`. */
  tables: Map<string, FieldTable>;
}

/** Load one MessageStructure by id, e.g. `adt-a01`. */
export async function loadMessageStructure(structureId: string): Promise<MessageStructure | null> {
  const bundle = await loadStructures();
  return bundle.messageStructures[structureId] ?? null;
}

/** Flatten a field table's node trees into an id -> node map. */
export function indexSpecNodes(table: FieldTable, into?: Map<string, SpecNode>): Map<string, SpecNode> {
  const map = into ?? new Map<string, SpecNode>();
  const step = (nodes: SpecNode[]) => {
    for (const node of nodes) {
      map.set(node.id, node);
      step(node.children);
    }
  };
  step(table.nodes);
  return map;
}

/** Look one field table up in a loaded family bundle by its `<pageId>:<tableIndex>` ref. */
export function findTable(bundle: FieldBundle, ref: string): FieldTable | null {
  const [pageId, tableIndex] = ref.split(":");
  const page = bundle.pages[pageId];
  if (!page) return null;
  return page.tables.find((t) => t.tableIndex === Number(tableIndex)) ?? null;
}

/**
 * Resolve a use case to the structure a parser/emitter should work against, pulling in the
 * field tables it cites.
 *
 * `variant` picks between an ADT event (`"A01"`), a CDA rendering (`"structured"`) or a
 * SOAP direction (`"request"`). With no variant, the first REQUEST structure wins; a use
 * case whose only structures are responses resolves to the first of those.
 */
export async function resolveUseCase(useCaseId: string, variant?: string): Promise<ResolvedUseCase | null> {
  const [manifest, structuresBundle] = await Promise.all([loadManifest(), loadStructures()]);
  const useCase = manifest.useCases.find((u) => u.id === useCaseId);
  if (!useCase) return null;

  const structures = useCase.structureIds
    .map((id) => structuresBundle.messageStructures[id])
    .filter((s): s is MessageStructure => Boolean(s));
  if (!structures.length) return null;

  let structure: MessageStructure | undefined;
  if (variant) {
    structure = structures.find((s) => s.variant === variant || s.id === variant);
    if (!structure) return null;
  } else {
    structure = structures.find((s) => (s.direction ?? "request") === "request") ?? structures[0];
  }

  const refs = new Set<string>();
  const collect = (list: SpecRef[] | undefined) => {
    for (const ref of list ?? []) refs.add(`${ref.family}|${ref.ref}`);
  };
  collect(structure.specRefs);
  walkStructure(structure, (member) => collect(member.specRefs));

  const tables = new Map<string, FieldTable>();
  const specNodes = new Map<string, SpecNode>();
  const families = new Set<SpecFamily>();
  for (const key of refs) families.add(key.split("|")[0] as SpecFamily);
  const loaded = new Map<SpecFamily, FieldBundle>();
  await Promise.all(
    [...families].map(async (family) => {
      loaded.set(family, await loadFields(family));
    }),
  );
  for (const key of refs) {
    const [family, ref] = key.split("|") as [SpecFamily, string];
    const bundle = loaded.get(family);
    if (!bundle) continue;
    const table = findTable(bundle, ref);
    if (!table) continue;
    tables.set(ref, table);
    indexSpecNodes(table, specNodes);
  }

  return { useCase, structure, structures, specNodes, tables };
}

/* ========================================================================== *
 * Datatype and OID helpers
 * ========================================================================== */

let datatypesCache: DatatypesBundle | null = null;
let constantsCache: ConstantsBundle | null = null;

/** Warm the caches the synchronous helpers below read from. */
export async function primeSpecHelpers(): Promise<void> {
  const [dt, consts] = await Promise.all([loadDatatypes(), loadConstants()]);
  datatypesCache = dt;
  constantsCache = consts;
}

/**
 * HL7 v2.5.1 component layout for a composite datatype, e.g. `CX` ->
 * `[{1 ID Number ST}, …, {4 Assigning Authority HD}, …]`.
 *
 * Pure: pass `bundle` explicitly, or rely on the cache warmed by
 * {@link primeSpecHelpers} / {@link loadDatatypes}. Returns `null` when the datatype is
 * unknown or nothing has been loaded yet — never a partially-guessed layout.
 */
export function componentLayout(datatype: string, bundle?: DatatypesBundle): DatatypeComponent[] | null {
  const source = bundle ?? datatypesCache;
  if (!source) return null;
  return source.compiledIndex?.componentLayouts?.[datatype] ?? null;
}

/** Async convenience over {@link componentLayout}. */
export async function getComponentLayout(datatype: string): Promise<DatatypeComponent[] | null> {
  const bundle = datatypesCache ?? (await loadDatatypes());
  datatypesCache = bundle;
  return componentLayout(datatype, bundle);
}

/**
 * OIDs the constants extractor quarantined as sample data (a run of four or more identical
 * digits, `123456`, the `15000000` sample-organisation fragment, the reserved sample arc,
 * or an OID only ever shown inside an "Example:" marker).
 *
 * A generator must never emit one; a checker should flag one it sees in a real message.
 * Some carry `exemptContexts` — e.g. the nphies XML namespace declaration legitimately
 * uses a quarantined OID — so check the context before raising a finding.
 */
export function quarantinedOids(bundle?: ConstantsBundle): QuarantinedOid[] {
  const source = bundle ?? constantsCache;
  if (!source) return [];
  return source.compiledIndex?.quarantined ?? [];
}

/** Async convenience over {@link quarantinedOids}. */
export async function getQuarantinedOids(): Promise<QuarantinedOid[]> {
  const bundle = constantsCache ?? (await loadConstants());
  constantsCache = bundle;
  return quarantinedOids(bundle);
}

/** Is this OID one of the quarantined sample values? */
export function isQuarantinedOid(oid: string, bundle?: ConstantsBundle): boolean {
  return quarantinedOids(bundle).some((q) => q.oid === oid);
}
