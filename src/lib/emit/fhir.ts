/**
 * FHIR R4 JSON emitter for the NPHIES workbench — the exact inverse of
 * `src/lib/parse/fhir.ts`.
 *
 *     message --parseFhir--> StructureTree --emitFhir--> message      (byte-identical)
 *     HIS extract ---------> StructureTree --emitFhir--> message      (canonical)
 *
 * Both directions read the same {@link StructureTree}, which is why Build and Check cannot
 * drift apart: a bug in either shows up as a round-trip failure on the 22 official FHIR
 * samples.
 *
 * TWO MODES
 *
 *   "source"    (default)  Replay the lexical detail the parser recorded on each node —
 *                          indentation, key order, token spelling, and the trivia between
 *                          tokens, comments included. A parsed message comes back byte for
 *                          byte, INCLUDING its defects: the four official samples that carry
 *                          `//` comments and the one that never closes an object are
 *                          reproduced as given, because a tool that silently repaired them
 *                          would hide the very defect a hospital needs to see. Any node
 *                          without recorded formatting (one a Build screen added) is written
 *                          canonically in place, so an edited tree still emits cleanly.
 *
 *   "canonical"            Pretty-print from the tree's values alone. Used by Build, and by
 *                          anyone who wants a normalised copy to diff. `keyOrder: "spec"`
 *                          orders each resource's elements the way the compiled field table
 *                          lists them — that ordering is the spec's own, not this module's
 *                          invention — with anything the tables do not mention kept in
 *                          source order after the elements they do.
 *
 * WHAT THIS MODULE WILL NOT DO. It never adds an element the tree does not contain, never
 * drops one it does, and never "fixes" a value. Emitting is a serialisation step; every
 * structural judgement belongs to the checker, where it can be shown with its evidence.
 * Like the parser, it never throws: on an internal failure it returns the best text it has
 * built so far.
 */

import type { MessageStructure, StructureEntry, StructureTree, TreeNode } from "../structure";
import { walkStructure } from "../structure";
import type { FhirFormat, FhirTreeNode, JsonType } from "../parse/fhir";
import { normalizeFhirPath } from "../parse/fhir";

export interface EmitOptions {
  /**
   * `"source"` (default) reproduces the parsed text exactly; `"canonical"` pretty-prints.
   * A tree with no recorded formatting emits canonically whichever mode is asked for.
   */
  mode?: "source" | "canonical";
  /** Canonical mode: indent width (default 2) or the literal indent string. */
  indent?: number | string;
  /** Canonical mode: line ending (default `"\n"`). */
  newline?: string;
  /**
   * Canonical mode key order. `"source"` (default) keeps the order the tree carries;
   * `"spec"` orders each resource's top-level elements as the compiled field table lists
   * them, which requires `specOrder` to have been supplied.
   */
  keyOrder?: "source" | "spec";
  /**
   * Per-resource element order, as produced by `buildFhirSpecIndex(specNodes).order`.
   * Required for `keyOrder: "spec"`; without it that option falls back to source order.
   */
  specOrder?: ReadonlyMap<string, string[]>;
  /**
   * Canonical mode: reorder `Bundle.entry` into the order the compiled structure lists its
   * entry members (which is what makes the first entry the one the two-family rule
   * demands). Default false — reordering a hospital's message is not something to do
   * unasked. Entries matching no member keep their relative order at the end.
   */
  orderEntriesBySpec?: boolean;
  /** Canonical mode: final newline at the end of the document. Default false. */
  trailingNewline?: boolean;
}

/** What `emitFhir` had to fall back on, for callers that want to report it. */
export interface EmitReport {
  text: string;
  mode: "source" | "canonical";
  /** Nodes emitted canonically inside a source-mode emit because they carried no format. */
  synthesised: number;
  /** True when the tree carried no lexical detail at all. */
  canonicalFallback: boolean;
  errors: string[];
}

/* ========================================================================== *
 * Scalar serialisation
 * ========================================================================== */

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function typeOf(node: FhirTreeNode): JsonType {
  if (node.jsonType) return node.jsonType;
  if (node.children.length > 0) {
    // No recorded type: children that carry no object key are array items.
    const first = node.children[0];
    if (first.kind === "repetition" || first.kind === "entry") return "array";
    if (first.fmt && !first.fmt.keyRaw) return "array";
    return "object";
  }
  if (node.value === null) return node.present ? "null" : "null";
  if (node.value === "true" || node.value === "false") return "boolean";
  return "string";
}

/** Serialise a leaf. Values are held as decoded text, so strings are re-escaped here. */
function scalarText(node: FhirTreeNode): string {
  const type = typeOf(node);
  const value = node.value;
  switch (type) {
    case "null":
      return "null";
    case "boolean":
      return value === "true" ? "true" : "false";
    case "number":
      if (value !== null && JSON_NUMBER.test(value.trim())) return value.trim();
      // Not a JSON number: emit it as the string it actually is rather than produce
      // something no parser would accept.
      return JSON.stringify(value ?? "");
    case "string":
    default:
      return JSON.stringify(value ?? "");
  }
}

const indentString = (opts: EmitOptions): string => {
  const indent = opts.indent ?? 2;
  return typeof indent === "number" ? " ".repeat(Math.max(0, indent)) : indent;
};

/* ========================================================================== *
 * Canonical serialisation
 * ========================================================================== */

interface CanonCtx {
  indent: string;
  nl: string;
  keyOrder: "source" | "spec";
  specOrder: ReadonlyMap<string, string[]> | null;
  entryOrder: Map<string, number> | null;
  errors: string[];
}

/** The object key a node was parsed from. Falls back to the last path segment. */
function keyOf(node: FhirTreeNode): string | null {
  const fmtKey = node.fmt?.keyRaw;
  if (fmtKey) {
    try {
      const decoded = JSON.parse(fmtKey) as unknown;
      if (typeof decoded === "string") return decoded;
    } catch {
      /* fall through to the locator */
    }
  }
  if (node.kind === "repetition" || node.kind === "entry") return null;
  const locator = node.locator;
  if (locator && locator.kind === "fhirPath" && locator.path) {
    const segments = normalizeFhirPath(locator.path).split("/");
    const last = segments[segments.length - 1];
    if (last) return last;
  }
  return node.label || null;
}

function orderChildren(node: FhirTreeNode, ctx: CanonCtx): FhirTreeNode[] {
  const children = node.children;
  if (ctx.keyOrder !== "spec" || !ctx.specOrder) return children;
  const root = node.kind === "resource" || node.kind === "message" ? (node.resourceRoot ?? node.label) : null;
  const order = root ? ctx.specOrder.get(root) : null;
  if (!order || order.length === 0) return children;
  const rank = new Map<string, number>();
  order.forEach((path, i) => rank.set(path, i));
  return children
    .map((child, i) => ({ child, i, r: rank.get(keyOf(child) ?? "") }))
    .sort((a, b) => {
      if (a.r === undefined && b.r === undefined) return a.i - b.i;
      if (a.r === undefined) return 1;
      if (b.r === undefined) return -1;
      return a.r === b.r ? a.i - b.i : a.r - b.r;
    })
    .map((x) => x.child);
}

function canonical(node: FhirTreeNode, depth: number, ctx: CanonCtx): string {
  const type = typeOf(node);
  if (type !== "object" && type !== "array") return scalarText(node);

  let children = node.children;
  if (children.length === 0) return type === "array" ? "[]" : "{}";

  if (type === "array" && ctx.entryOrder && isEntryArray(node)) {
    children = [...children]
      .map((child, i) => ({ child, i, r: ctx.entryOrder?.get(child.memberId ?? "") }))
      .sort((a, b) => {
        if (a.r === undefined && b.r === undefined) return a.i - b.i;
        if (a.r === undefined) return 1;
        if (b.r === undefined) return -1;
        return a.r === b.r ? a.i - b.i : a.r - b.r;
      })
      .map((x) => x.child);
  } else if (type === "object") {
    children = orderChildren(node, ctx);
  }

  const pad = ctx.indent.repeat(depth + 1);
  const closePad = ctx.indent.repeat(depth);
  const parts: string[] = [];
  for (const child of children) {
    const value = canonical(child, depth + 1, ctx);
    if (type === "array") {
      parts.push(pad + value);
    } else {
      const key = keyOf(child);
      if (key === null) {
        ctx.errors.push(`node ${child.id} has no key and cannot be written as an object member`);
        continue;
      }
      parts.push(`${pad}${JSON.stringify(key)}: ${value}`);
    }
  }
  const open = type === "array" ? "[" : "{";
  const close = type === "array" ? "]" : "}";
  return `${open}${ctx.nl}${parts.join(`,${ctx.nl}`)}${ctx.nl}${closePad}${close}`;
}

function isEntryArray(node: FhirTreeNode): boolean {
  const locator = node.locator;
  if (!locator || locator.kind !== "fhirPath") return false;
  return normalizeFhirPath(locator.path) === "entry" && node.children.some((c) => c.kind === "entry");
}

/* ========================================================================== *
 * Source-faithful serialisation
 * ========================================================================== */

interface SourceCtx {
  indent: string;
  nl: string;
  canon: CanonCtx;
  synthesised: number;
  errors: string[];
}

const fmtOf = (node: FhirTreeNode): FhirFormat | null => node.fmt ?? null;

/** The value text of a node, replaying its recorded lexical detail. */
function sourceValue(node: FhirTreeNode, depth: number, ctx: SourceCtx): string {
  const fmt = fmtOf(node);
  const type = typeOf(node);

  if (!fmt) {
    ctx.synthesised += 1;
    return canonical(node, depth, ctx.canon);
  }

  if (type !== "object" && type !== "array") {
    // The exact token, so `1.50`, `+03:00` offsets and escape spellings survive.
    return fmt.tokenRaw ?? scalarText(node);
  }

  const open = fmt.open ?? (type === "array" ? "[" : "{");
  let out = open;
  for (const child of node.children) {
    out += sourceMember(child, depth + 1, ctx, type);
  }
  out += fmt.close ?? "";
  out += fmt.closeRaw ?? (type === "array" ? "]" : "}");
  return out;
}

/** One member of a container, with its separator, trivia and (for objects) its key. */
function sourceMember(node: FhirTreeNode, depth: number, ctx: SourceCtx, container: JsonType): string {
  const fmt = fmtOf(node);
  const value = sourceValue(node, depth, ctx);

  if (!fmt) {
    // A node added to a parsed tree: give it a plausible line of its own.
    const pad = ctx.indent.repeat(depth);
    const sep = ",";
    if (container === "array") return `${sep}${ctx.nl}${pad}${value}`;
    const key = keyOf(node);
    if (key === null) {
      ctx.errors.push(`node ${node.id} has no key and cannot be written as an object member`);
      return "";
    }
    return `${sep}${ctx.nl}${pad}${JSON.stringify(key)}: ${value}`;
  }

  let out = fmt.sep + fmt.pre;
  if (container === "object") {
    const key = keyOf(node);
    out += fmt.keyRaw ?? JSON.stringify(key ?? node.label);
    out += fmt.preColon ?? "";
    out += fmt.colon ?? ":";
    out += fmt.postColon ?? (fmt.colon === "" ? "" : " ");
  }
  return out + value;
}

/* ========================================================================== *
 * emitFhir
 * ========================================================================== */

/**
 * Serialise a {@link StructureTree} as FHIR R4 JSON.
 *
 * Exact inverse of {@link parseFhir} in `"source"` mode: for every one of the official
 * golden samples, `emitFhir(parseFhir(text, structure).tree, structure)` returns `text`.
 */
export function emitFhir(tree: StructureTree, structure: MessageStructure, opts: EmitOptions = {}): string {
  return emitFhirReport(tree, structure, opts).text;
}

/** {@link emitFhir} plus what it had to synthesise. Same work, more to report. */
export function emitFhirReport(
  tree: StructureTree,
  structure: MessageStructure,
  opts: EmitOptions = {},
): EmitReport {
  const errors: string[] = [];
  const indent = indentString(opts);
  const nl = opts.newline ?? "\n";
  const root = (tree?.root ?? null) as FhirTreeNode | null;

  const specOrder = opts.specOrder ?? null;
  const canon: CanonCtx = {
    indent,
    nl,
    keyOrder: opts.keyOrder === "spec" && specOrder ? "spec" : "source",
    specOrder,
    entryOrder: null,
    errors,
  };
  if (opts.keyOrder === "spec" && !specOrder) {
    errors.push(
      'keyOrder "spec" needs specOrder (buildFhirSpecIndex(specNodes).order); emitted in source key order instead',
    );
  }

  if (opts.orderEntriesBySpec && structure) {
    const order = new Map<string, number>();
    let i = 0;
    walkStructure(structure, (member) => {
      if (member.kind === "entry") order.set((member as StructureEntry).id, i++);
    });
    canon.entryOrder = order;
  }

  if (!root) {
    return { text: "", mode: opts.mode === "canonical" ? "canonical" : "source", synthesised: 0, canonicalFallback: true, errors: [...errors, "the tree has no root node"] };
  }

  const wantSource = opts.mode !== "canonical";
  const hasFormat = Boolean(root.fmt);

  try {
    if (wantSource && hasFormat) {
      const ctx: SourceCtx = { indent, nl, canon, synthesised: 0, errors };
      const fmt = root.fmt as FhirFormat;
      const text = (fmt.pre ?? "") + sourceValue(root, 0, ctx) + (fmt.post ?? "");
      return { text, mode: "source", synthesised: ctx.synthesised, canonicalFallback: false, errors };
    }
    const body = canonical(root, 0, canon);
    const text = opts.trailingNewline ? body + nl : body;
    return {
      text,
      mode: "canonical",
      synthesised: 0,
      canonicalFallback: wantSource && !hasFormat,
      errors,
    };
  } catch (err) {
    errors.push(
      `emitter internal error: ${err instanceof Error ? err.message : String(err)} — this is a workbench bug`,
    );
    return { text: tree.text ?? "", mode: wantSource ? "source" : "canonical", synthesised: 0, canonicalFallback: false, errors };
  }
}

/**
 * Convenience for Build: emit a tree the UI assembled, with no source text behind it.
 * Identical to `emitFhir(tree, structure, { mode: "canonical", ... })`.
 */
export function emitFhirCanonical(
  tree: StructureTree,
  structure: MessageStructure,
  opts: Omit<EmitOptions, "mode"> = {},
): string {
  return emitFhir(tree, structure, { ...opts, mode: "canonical" });
}

/** True when this tree can be emitted byte-identically (it came from a parse). */
export function canEmitSource(tree: StructureTree): boolean {
  const root = tree?.root as TreeNode | undefined;
  return Boolean(root && (root as FhirTreeNode).fmt);
}
