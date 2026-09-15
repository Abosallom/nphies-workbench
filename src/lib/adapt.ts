/**
 * Adapters: engine shapes -> the presentational shapes `src/ui` takes.
 *
 * `src/ui` knows nothing about HL7, CDA, FHIR or SOAP, and the engine knows nothing about
 * React. This module is the only place the two meet, and it is mechanical by design — it
 * moves fields across, it does not decide anything. In particular it never upgrades a node
 * to `ok`: a node is green only where the checker positively verified it and said so.
 */

import {
  formatLocator,
  isIgnored,
  locatorKey,
  membersOf,
  walkTree,
  type Confidence,
  type Derivation,
  type FieldTable,
  type MessageStructure,
  type Provenance,
  type SpecNode,
  type SpecRole,
  type StructureMember,
  type StructureTree,
  type TreeNode,
  type UsageRule,
} from "./structure";
import { toUiFinding, type Finding } from "./check";
import type { Finding as UiFinding, Region, Severity, StructureNode, UsageRule as UiUsageRule } from "../ui/types";

/* ---------------------------------------------------------------- severity */

const RANK: Record<Severity, number> = { error: 0, warn: 1, ok: 2, ignored: 3, info: 4 };

function worst(a: Severity, b: Severity): Severity {
  return RANK[a] <= RANK[b] ? a : b;
}

/* ------------------------------------------------------------------ paths */

/** A readable structural path for a node, e.g. `ClinicalDocument/recordTarget/patientRole`. */
function pathOf(node: TreeNode, ancestors: TreeNode[]): string {
  const parts = [...ancestors.slice(1), node].map((n) => n.label).filter(Boolean);
  return parts.join("/") || node.id;
}

/* ================================================================== regions */

export interface AdaptedMessage {
  regions: Region[];
  tree: StructureNode[];
  findings: UiFinding[];
  /** Nodes the tree holds, for the status bar. */
  nodeCount: number;
}

interface Indexed {
  node: TreeNode;
  path: string;
  depth: number;
  /** Id of the enclosing node, or `null` for a top-level one. Taken from the walk itself. */
  parentId: string | null;
}

function indexTree(tree: StructureTree): Indexed[] {
  const out: Indexed[] = [];
  walkTree(tree, (node, ancestors) => {
    // The synthetic message root is the pane itself, never a row.
    if (!ancestors.length) return;
    const parent = ancestors[ancestors.length - 1];
    out.push({
      node,
      path: pathOf(node, ancestors),
      depth: ancestors.length - 1,
      parentId: ancestors.length > 1 ? parent.id : null,
    });
  });
  return out;
}

function locKey(line: number, startCol: number, endCol: number): string {
  return `${line}:${startCol}:${endCol}`;
}

/**
 * Map every finding onto the node it is about.
 *
 * Location is tried first and exactly, because it is the parser's own geometry; a finding
 * with no location (`this should exist and does not`) falls back to its `specNodeId`, and
 * one that matches nothing stays unattached — it still shows in the findings pane, it just
 * has nothing to underline. Nothing is attached by guessing at a path.
 */
function attachFindings(
  findings: readonly Finding[],
  indexed: Indexed[],
): { byNode: Map<string, Finding[]>; regionOf: Map<string, string> } {
  const byLoc = new Map<string, TreeNode>();
  const bySpecNode = new Map<string, TreeNode>();
  for (const { node } of indexed) {
    if (node.loc) {
      const key = locKey(node.loc.line, node.loc.startCol, node.loc.endCol);
      // The innermost node wins: the first writer is the outermost in document order.
      byLoc.set(key, node);
    }
    if (node.specNodeId && !bySpecNode.has(node.specNodeId)) bySpecNode.set(node.specNodeId, node);
  }

  const byNode = new Map<string, Finding[]>();
  const regionOf = new Map<string, string>();
  for (const f of findings) {
    let node: TreeNode | undefined;
    if (f.location) node = byLoc.get(locKey(f.location.line, f.location.startCol, f.location.endCol));
    if (!node && f.specNodeId) node = bySpecNode.get(f.specNodeId);
    if (!node) continue;
    const list = byNode.get(node.id);
    if (list) list.push(f);
    else byNode.set(node.id, [f]);
    if (node.loc) regionOf.set(f.id, node.id);
  }
  return { byNode, regionOf };
}

function severityOfNode(node: TreeNode, findings: Finding[] | undefined): Severity {
  let sev: Severity | null = null;
  for (const f of findings ?? []) sev = sev === null ? f.severity : worst(sev, f.severity);
  if (sev) return sev;
  if (node.spec && isIgnored(node.spec)) return "ignored";
  return "info";
}

function rulesOf(spec: SpecNode | null | undefined): UiUsageRule[] | undefined {
  if (!spec?.usage?.length) return undefined;
  return spec.usage
    .filter((r: UsageRule) => r.usage && r.usage !== "-")
    .map((r) => {
      const out: UiUsageRule = { usage: r.usage as UiUsageRule["usage"] };
      if (r.raw?.cardinality) out.cardinality = r.raw.cardinality;
      if (r.condition) out.condition = r.condition;
      return out;
    });
}

function ignoredReasonOf(spec: SpecNode | null | undefined): string | undefined {
  if (!spec) return undefined;
  const rule = spec.usage.find((r) => r.usage === "I");
  if (!rule) return undefined;
  return (
    `NPHIES marks ${spec.label || "this field"} as Ignored: it is accepted and then discarded. ` +
    `You do not need your HIS to populate it.`
  );
}

function fixedOf(spec: SpecNode | null | undefined): string | undefined {
  if (!spec) return undefined;
  const whole = spec.fixedValues.filter((f) => f.scope === "wholeField" && f.value);
  return whole.length === 1 ? (whole[0].value ?? undefined) : undefined;
}

/**
 * Turn a parsed tree plus its findings into everything `SplitView` needs.
 *
 * Both panes mirror the same node list, so a click on either side resolves on the other
 * without any further lookup: `Region.id`, `StructureNode.id` and `StructureNode.regionId`
 * are all the `TreeNode.id`.
 */
export function adaptMessage(tree: StructureTree, findings: readonly Finding[]): AdaptedMessage {
  const indexed = indexTree(tree);
  const { byNode, regionOf } = attachFindings(findings, indexed);

  const regions: Region[] = [];
  const nodeById = new Map<string, StructureNode>();
  const roots: StructureNode[] = [];
  const childrenOf = new Map<string, StructureNode[]>();

  for (const { node, path, parentId } of indexed) {
    const sev = severityOfNode(node, byNode.get(node.id));
    if (node.loc && node.loc.endCol > node.loc.startCol) {
      regions.push({
        id: node.id,
        line: node.loc.line,
        startCol: node.loc.startCol,
        endCol: node.loc.endCol,
        label: node.spec?.label ? `${node.label} ${node.spec.label}` : node.label,
        path,
        severity: sev,
      });
    }
    const ui: StructureNode = {
      id: node.id,
      label: node.label,
      path,
      severity: sev,
    };
    if (node.spec?.label && node.spec.label !== node.label) ui.name = node.spec.label;
    const rules = rulesOf(node.spec);
    if (rules?.length) ui.rules = rules;
    if (node.spec?.datatype) ui.dataType = node.spec.datatype;
    const fixed = fixedOf(node.spec);
    if (fixed) ui.fixedValue = fixed;
    if (node.loc) ui.regionId = node.id;
    if (sev === "ignored") {
      const why = ignoredReasonOf(node.spec);
      if (why) ui.ignoredReason = why;
    }
    const p = node.spec?.provenance;
    if (p?.pageId && p.quote) {
      ui.source = {
        pageId: p.pageId,
        pageTitle: p.pageTitle ?? "",
        quote: p.quote,
        ...(p.row ? { row: p.row } : {}),
      };
    }
    nodeById.set(node.id, ui);

    if (!parentId) roots.push(ui);
    else {
      const list = childrenOf.get(parentId);
      if (list) list.push(ui);
      else childrenOf.set(parentId, [ui]);
    }
  }

  for (const [id, kids] of childrenOf) {
    const parent = nodeById.get(id);
    if (parent) parent.children = kids;
  }

  // Only ever cite a region the code pane actually drew: a zero-width location (an empty HL7
  // field is still a position) has no region, and a finding pointing at one that does not
  // exist would make "reveal in message" a dead end.
  const drawn = new Set(regions.map((r) => r.id));
  const ui = findings.map((f) => {
    const regionId = regionOf.get(f.id);
    return toUiFinding(f, regionId && drawn.has(regionId) ? regionId : undefined) as UiFinding;
  });
  return { regions, tree: roots, findings: ui, nodeCount: indexed.length };
}


/* ========================================================================== *
 * The RULE tree — a structure with no message in front of it
 * ========================================================================== */

/**
 * Everything the Explain surface shows about one node. Kept separate from the presentational
 * `StructureNode` so the detail panel can render the parts a tree row has no space for —
 * value-set bindings, guidance prose, and the verbatim Confluence quote a claim rests on.
 */
export interface SpecDetail {
  id: string;
  label: string;
  path: string;
  /** `member` = a position in the message shape; `spec` = a row in a field table. */
  kind: "member" | "spec";
  /** `data` rows are the ones a HIS actually has to supply a value for. */
  role: SpecRole | null;
  /** Depth in the rule tree, so a flat export can still show the nesting. */
  depth: number;
  locator: string | null;
  usage: UsageRule[];
  datatype: string | null;
  fixedValues: { scope: string | null; value: string | null; attribute: string | null }[];
  valueSets: { valueSetId: string | null; title: string | null; external: boolean; resolvedVia: string | null }[];
  templateIds: string[];
  guidance: string | null;
  codeSet: string | null;
  provenance: Provenance | null;
  derivation: Derivation | null;
  confidence: Confidence | null;
  /** True when an official sample was checked against this rule. */
  verifiedAgainstSample: boolean;
  /** Repeats at this position? */
  repeats: boolean;
  /** Notes the compiler attached — contradictions, gaps, caveats. */
  notes: string[];
}

export interface AdaptedStructure {
  tree: StructureNode[];
  details: Map<string, SpecDetail>;
  /** Rules with no Confluence page behind them — shown as a count, never hidden. */
  sampleDerived: number;
  total: number;
}

function severityOfRule(usage: readonly UsageRule[]): Severity {
  // Explain describes rules, it does not judge a message, so the only colour it carries is
  // the one that is itself a rule: "NPHIES ignores this, you do not have to build it."
  return usage.some((u) => u.usage === "I") && !usage.some((u) => u.usage !== "I") ? "ignored" : "info";
}

function uiRules(usage: readonly UsageRule[]): UiUsageRule[] | undefined {
  const rules = usage
    .filter((r) => r.usage && r.usage !== "-")
    .map((r) => {
      const out: UiUsageRule = { usage: r.usage as UiUsageRule["usage"] };
      if (r.raw?.cardinality) out.cardinality = r.raw.cardinality;
      else if (r.min !== null || r.max !== null) out.cardinality = `${r.min ?? 0}..${r.max ?? "*"}`;
      if (r.condition) out.condition = r.condition;
      return out;
    });
  return rules.length ? rules : undefined;
}

function provenanceToUi(p: Provenance | null | undefined): StructureNode["source"] {
  if (!p?.pageId || !p.quote) return undefined;
  return { pageId: p.pageId, pageTitle: p.pageTitle ?? "", quote: p.quote, ...(p.row ? { row: p.row } : {}) };
}

/**
 * Render a compiled `MessageStructure` as a tree of rules: the message shape from
 * `structure.root`, with each member's field-table rows hung underneath it.
 *
 * This is the Explain surface's whole subject — what the specification requires, with no
 * message in front of it — so it shows rules the way the spec states them, including the
 * ones that are only sample-derived. Those are counted and labelled rather than dropped:
 * a rule the workbench cannot cite is still a rule an integrator will meet on the wire.
 */
export function adaptStructure(
  structure: MessageStructure,
  tables: ReadonlyMap<string, FieldTable> | undefined,
): AdaptedStructure {
  const details = new Map<string, SpecDetail>();
  let sampleDerived = 0;
  let total = 0;

  const specChild = (node: SpecNode, parentPath: string, depth: number): StructureNode | null => {
    if (node.role === "omit") return null;
    const label = node.locator ? formatLocator(node.locator) : node.label;
    const path = `${parentPath}/${label}`;
    const id = `spec:${node.id}`;
    total++;
    if (!node.provenance?.pageId) sampleDerived++;

    const ui: StructureNode = {
      id,
      label,
      path,
      severity: severityOfRule(node.usage),
    };
    if (node.label && node.label !== label) ui.name = node.label.replace(/\s+/g, " ").trim();
    const rules = uiRules(node.usage);
    if (rules) ui.rules = rules;
    if (node.datatype) ui.dataType = node.datatype;
    const fixed = fixedOf(node);
    if (fixed) ui.fixedValue = fixed;
    if (ui.severity === "ignored") {
      const why = ignoredReasonOf(node);
      if (why) ui.ignoredReason = why;
    }
    const source = provenanceToUi(node.provenance);
    if (source) ui.source = source;

    details.set(id, {
      id,
      label: ui.name ?? label,
      path,
      kind: "spec",
      role: node.role,
      depth,
      locator: node.locator ? formatLocator(node.locator) : null,
      usage: node.usage,
      datatype: node.datatype,
      fixedValues: node.fixedValues.map((f) => ({ scope: f.scope, value: f.value, attribute: f.attribute })),
      valueSets: node.valueSets.map((v) => ({
        valueSetId: v.valueSetId,
        title: v.title ?? v.referenceText ?? null,
        external: Boolean(v.external),
        resolvedVia: v.resolvedVia ?? null,
      })),
      templateIds: node.templateIds,
      guidance: node.guidance,
      codeSet: node.codeSet,
      provenance: node.provenance,
      derivation: node.derivation ?? null,
      confidence: node.confidence ?? null,
      verifiedAgainstSample: Boolean(node.verifiedAgainstSample),
      repeats: node.usage.some((u) => u.max === "*" || (typeof u.max === "number" && u.max > 1)),
      notes: node.noteBefore ? [node.noteBefore] : [],
    });

    const kids = node.children
      .map((c) => specChild(c, path, depth + 1))
      .filter((c): c is StructureNode => Boolean(c));
    if (kids.length) ui.children = kids;
    return ui;
  };

  const memberNode = (member: StructureMember, parentPath: string, depth: number): StructureNode => {
    const locator = "locator" in member && member.locator ? member.locator : null;
    const label =
      member.kind === "segment" ? member.segment : locator ? formatLocator(locator) : member.label;
    const path = `${parentPath}/${label}`;
    const id = `member:${member.id}`;
    total++;
    if (!member.provenance?.pageId) sampleDerived++;

    const ui: StructureNode = { id, label, path, severity: severityOfRule(member.usage) };
    if (member.label && member.label !== label) ui.name = member.label.replace(/\s+/g, " ").trim();
    const rules = uiRules(member.usage);
    if (rules) ui.rules = rules;
    const source = provenanceToUi(member.provenance);
    if (source) ui.source = source;

    details.set(id, {
      id,
      label: member.label,
      path,
      kind: "member",
      role: null,
      depth,
      locator: locator ? formatLocator(locator) : null,
      usage: member.usage,
      datatype: null,
      fixedValues: [],
      valueSets: [],
      templateIds: member.kind === "section" ? member.templateIds : [],
      guidance: member.guidance ?? null,
      codeSet: null,
      provenance: member.provenance,
      derivation: member.derivation ?? null,
      confidence: member.confidence ?? null,
      verifiedAgainstSample: Boolean(member.verifiedAgainstSample),
      repeats: member.repeats,
      notes: [],
    });

    const children: StructureNode[] = membersOf(member).map((m) => memberNode(m, path, depth + 1));

    // Field-table rows for this member: MSH -> its 21 field rows, a section -> its entries.
    const seen = new Set<string>();
    for (const ref of member.specRefs ?? []) {
      const table = tables?.get(ref.ref);
      if (!table) continue;
      for (const node of table.nodes) {
        const key = node.locator ? locatorKey(node.locator) : `#${node.id}`;
        if (seen.has(key)) continue; // two tables describe the same field; show it once
        seen.add(key);
        const child = specChild(node, path, depth + 1);
        if (child) children.push(child);
      }
    }
    if (children.length) ui.children = children;
    return ui;
  };

  const tree = structure.root.members.map((m) => memberNode(m, structure.root.label, 0));
  return { tree, details, sampleDerived, total };
}
