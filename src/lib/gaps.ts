/**
 * Gaps — the places where the checker deliberately gave up, enumerated so a model can be
 * asked about them WITHOUT being asked to judge anything.
 *
 * `check()` never guesses: a conditional row the context does not settle becomes a warn, an
 * element the spec does not describe becomes an info, an undecidable structure member is
 * "neither confirmed nor denied". Each of those is a real question with a CLOSED set of
 * answers — the condition strings the row itself carries, the compiled siblings an unknown
 * element might have been, the codes the checker itself listed as near misses. A proposal
 * can only pick from that list, and picking is not deciding: a `declare-condition` choice
 * becomes a verdict only when the view re-runs `analyse(text, structure, resolved,
 * { conditions: [c] })` and `check()` emits the finding under its own evidence.
 *
 * Pure and deterministic over the findings (plus optional engine context); imports types only.
 */

import type { Finding } from "./findings";
import type { MessageStructure, SpecNode, StructureMember, StructureTree, TreeNode, UsageCode, ValueSet } from "./structure";
import type { AdvisoryAction } from "./advisory";

export type GapKind = "conditional-usage-unresolved" | "unknown-element" | "structure-caveat" | "valueset-code-unknown";

/** One answer the gap admits. `rule` names a compiled node the content might belong to. */
export type GapOption =
  | { readonly type: "declare-condition"; readonly condition: string; readonly usage: UsageCode | null; readonly cardinality: string }
  | { readonly type: "rule"; readonly ruleId: string; readonly label: string }
  | { readonly type: "copy-code"; readonly code: string; readonly display: string | null };

export interface Gap {
  /** Deterministic: `gap:<kind>:<n>:<findingId>`. */
  readonly id: string;
  readonly kind: GapKind;
  readonly findingId: string;
  readonly path: string;
  readonly line: number | null;
  readonly specNodeId: string | null;
  readonly memberId: string | null;
  /** One sentence for the model and the UI, free of message values. */
  readonly question: string;
  /** The closed list a proposal may choose from. Empty means "we can only ask for reasoning". */
  readonly options: readonly GapOption[];
  /** Kind-specific facts the proposal may rest on. Never a message value except a code. */
  readonly facts: Readonly<Record<string, string | readonly string[] | null>>;
}

export interface GapContext {
  /** The parsed tree, for an unknown element's compiled siblings. */
  readonly tree?: StructureTree | null;
  /** The structure, for the members an undecidable caveat names. */
  readonly structure?: MessageStructure | null;
  /** `ResolvedUseCase.specNodes`, for the bound value set behind a code finding. */
  readonly specNodes?: ReadonlyMap<string, SpecNode> | null;
  /** Loaded value sets by id, for near-miss codes; without them the checker's own list is used. */
  readonly valueSets?: ReadonlyMap<string, ValueSet> | null;
}

/** The advisory actions a gap's options translate to — what `validateAdvisories` checks against. */
export function actionsOf(gap: Gap): AdvisoryAction[] {
  const out: AdvisoryAction[] = [];
  for (const o of gap.options) {
    if (o.type === "declare-condition") out.push({ type: "declare-condition", condition: o.condition });
    else if (o.type === "copy-code") out.push({ type: "copy-code", code: o.code });
  }
  return out;
}

/* ========================================================================== *
 * Enumeration
 * ========================================================================== */

/**
 * Enumerate the gaps in one check run.
 *
 * Order follows the findings list, ids are positional per kind, and nothing depends on time
 * or randomness, so the same findings always yield the same gaps.
 */
export function gapsOf(findings: readonly Finding[], ctx: GapContext = {}): Gap[] {
  const out: Gap[] = [];
  const counters: Record<GapKind, number> = {
    "conditional-usage-unresolved": 0,
    "unknown-element": 0,
    "structure-caveat": 0,
    "valueset-code-unknown": 0,
  };
  const make = (kind: GapKind, f: Finding, rest: Pick<Gap, "question" | "options" | "facts">): Gap => ({
    id: `gap:${kind}:${counters[kind]++}:${f.id}`,
    kind,
    findingId: f.id,
    path: f.path,
    line: f.location?.line ?? null,
    specNodeId: f.specNodeId,
    memberId: f.memberId ?? null,
    ...rest,
  });

  for (const f of findings) {
    switch (f.code) {
      case "conditional-usage-unresolved": {
        const rules = f.rules ?? [];
        const conditions = rules.filter((r) => r.condition && r.condition.trim());
        out.push(
          make("conditional-usage-unresolved", f, {
            question: `Which of the row's conditions does this message satisfy at ${f.path}?`,
            options: conditions.map((r) => ({
              type: "declare-condition",
              condition: r.condition as string,
              usage: r.usage,
              cardinality: `${r.min ?? "?"}..${r.max === null ? "?" : r.max}`,
            })),
            facts: {
              readings: rules.map((r) => `${r.usage ?? "?"}${r.condition ? ` when ${r.condition}` : ""}`),
              rawUsageCell: rules.map((r) => r.raw.usage ?? "").filter(Boolean),
            },
          }),
        );
        break;
      }
      case "unknown-element": {
        const node = ctx.tree ? findNode(ctx.tree, f.path) : null;
        const siblings = node ? compiledSiblings(node.parent, ctx.specNodes ?? null) : [];
        out.push(
          make("unknown-element", f, {
            question: `Is ${nameOf(f)} a misspelling or misplacement of a compiled sibling, legal content the spec omits, or content that should not be here?`,
            options: siblings.map((s) => ({ type: "rule", ruleId: s.id, label: s.label })),
            facts: {
              name: nameOf(f),
              parentPath: node?.parent?.id ?? parentPathOf(f.path),
              compiledSiblings: siblings.map((s) => s.label),
            },
          }),
        );
        break;
      }
      case "structure-caveat": {
        // Only the caveat about UNDECIDABLE members is a question; the others are statements.
        if (!/could not be located/.test(f.title)) break;
        const members = ctx.structure ? undecidableMembers(ctx.structure, f.detail) : [];
        out.push(
          make("structure-caveat", f, {
            question: "Which structure members that the compiled spec cannot recognise in a message does this message nevertheless appear to carry?",
            options: members.map((m) => ({ type: "rule", ruleId: m.id, label: m.label })),
            facts: { members: members.map((m) => m.label) },
          }),
        );
        break;
      }
      case "valueset-code-unknown": {
        const spec = f.specNodeId && ctx.specNodes ? (ctx.specNodes.get(f.specNodeId) ?? null) : null;
        const binding = spec?.valueSets.find((b) => b.valueSetId) ?? spec?.valueSets[0] ?? null;
        const valueSetId = binding?.valueSetId ?? valueSetIdFromTitle(f.title);
        const code = f.actual ?? null;
        const near = nearCodes(code, valueSetId, ctx.valueSets ?? null, f.detail);
        out.push(
          make("valueset-code-unknown", f, {
            question: `"${code ?? "?"}" is not in ${valueSetId ?? "the bound value set"}. Which listed code, if any, was meant?`,
            options: near.map((c) => ({ type: "copy-code", code: c.code, display: c.display })),
            facts: { code, valueSetId, valueSetTitle: binding?.title ?? null, citedAs: binding?.referenceText ?? null },
          }),
        );
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/* ========================================================================== *
 * Helpers
 * ========================================================================== */

/** `unknown-element` titles read "<label> is not described by the compiled specification". */
function nameOf(f: Finding): string {
  const m = /^(.+?) is not described by/.exec(f.title);
  return m ? m[1] : f.path.split(/[/.]/).pop() ?? f.path;
}

function parentPathOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("."));
  return i > 0 ? path.slice(0, i) : path;
}

function findNode(tree: StructureTree, id: string): { node: TreeNode; parent: TreeNode | null } | null {
  let hit: { node: TreeNode; parent: TreeNode | null } | null = null;
  const visit = (node: TreeNode, parent: TreeNode | null): boolean => {
    if (node.id === id) {
      hit = { node, parent };
      return true;
    }
    for (const c of node.children) if (visit(c, node)) return true;
    return false;
  };
  visit(tree.root, null);
  return hit;
}

/** Distinct compiled spec nodes among a parent's children — what the unknown one might have been. */
function compiledSiblings(parent: TreeNode | null, specNodes: ReadonlyMap<string, SpecNode> | null): { id: string; label: string }[] {
  if (!parent) return [];
  const seen = new Map<string, string>();
  for (const c of parent.children) {
    const id = c.specNodeId ?? c.memberId;
    if (!id || seen.has(id)) continue;
    const spec = c.spec ?? (c.specNodeId && specNodes ? specNodes.get(c.specNodeId) : null);
    seen.set(id, spec?.label ?? c.label);
  }
  return [...seen].map(([id, label]) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id));
}

/** Members whose labels the caveat's detail names, in structure order. */
function undecidableMembers(structure: MessageStructure, detail: string): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const visit = (m: StructureMember) => {
    if (m.label && detail.includes(m.label) && !out.some((x) => x.id === m.id)) out.push({ id: m.id, label: m.label });
    for (const c of childrenOf(m)) visit(c);
  };
  for (const m of structure.root.members) visit(m);
  return out;
}

function childrenOf(m: StructureMember): StructureMember[] {
  return (m as { members?: StructureMember[] }).members ?? [];
}

/** `"X" is not in <value set title or id>` */
function valueSetIdFromTitle(title: string): string | null {
  const m = / is not in (.+)$/.exec(title);
  return m ? m[1].trim() : null;
}

/**
 * Near-miss codes. From the loaded value set when supplied (same 2-character prefix rule the
 * checker uses, capped at 8); otherwise parsed out of the checker's own "Codes starting
 * similarly:" sentence. Never anything the model made up — the list is closed either way.
 */
function nearCodes(code: string | null, valueSetId: string | null, sets: ReadonlyMap<string, ValueSet> | null, detail: string): { code: string; display: string | null }[] {
  if (code && valueSetId && sets) {
    const set = sets.get(valueSetId);
    if (set) {
      const prefix = code.slice(0, 2).toLowerCase();
      return set.concepts
        .filter((c) => c.code.toLowerCase().startsWith(prefix))
        .slice(0, 8)
        .map((c) => ({ code: c.code, display: c.display ?? null }));
    }
  }
  const m = /Codes starting similarly: (.+?)\.(?:\s|$)/.exec(detail);
  if (!m) return [];
  return m[1]
    .split(", ")
    .map((entry) => {
      const paren = entry.indexOf(" (");
      return paren >= 0 ? { code: entry.slice(0, paren).trim(), display: entry.slice(paren + 2, -1) } : { code: entry.trim(), display: null };
    })
    .filter((c) => c.code);
}
