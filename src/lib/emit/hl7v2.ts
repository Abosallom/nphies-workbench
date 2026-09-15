/**
 * HL7 v2.5.1 ER7 (pipe-delimited) EMITTER — the exact inverse of `../parse/hl7v2.ts`.
 *
 *     text --parseHl7v2--> StructureTree --emitHl7v2--> text        (byte-identical)
 *     HIS extract -------> StructureTree --emitHl7v2--> text
 *
 * Both directions run over the same {@link StructureTree}, which is why Build and Check cannot
 * drift apart: a message the workbench builds is serialised by the same code that reproduces a
 * message it parsed, and the round-trip test proves the two agree.
 *
 * ## It RECONSTRUCTS; it does not replay
 *
 * The cheap way to make a round trip byte-identical is to hand back `tree.text`, or to print
 * each segment's `raw` and call it a day. That proves nothing. This emitter assembles every
 * segment from its field nodes, every field from its repetitions and components, and every
 * component from its subcomponents, inserting delimiters itself. `raw` is consulted only at
 * LEAVES, and only while it still agrees with `value`:
 *
 *   - leaf with `raw` that still decodes to `value`  -> `raw` verbatim (nothing is rewritten,
 *     so escape sequences this workbench chose not to decode survive untouched);
 *   - leaf whose `value` was edited, or that never had `raw` -> `value`, re-escaped;
 *   - any node WITH children -> assembled from those children, `raw` ignored.
 *
 * So editing one component and re-emitting changes exactly that component, and a tree built
 * from scratch by the Build screen emits with no `raw` anywhere.
 *
 * ## Trailing empty fields
 *
 * The official ADT samples do NOT truncate trailing empty fields: MSH ends `|2.5|||||` and PV1
 * ends `|||||||`. There is therefore no "rule" to apply — the message says how many fields it
 * carries, and the parser creates one node per field actually present. This emitter writes
 * exactly the fields the tree holds, from 1 to the highest field number present, so the
 * truncation (or lack of it) is reproduced rather than reimposed.
 *
 * ## MSH
 *
 * MSH-1 IS the field separator and MSH-2 IS the encoding characters, so MSH is written as
 * `MSH` + MSH-1 + join(MSH-2 … MSH-N, MSH-1). Neither is ever escaped: they declare the
 * delimiters, so escaping them would be circular.
 *
 * No per-use-case branching lives here. Segment order comes from the tree (which the parser
 * built from the compiled {@link MessageStructure}); the terminator and delimiters come from
 * the dialect, the tree text or `structure.envelope`, in that order.
 *
 * ## What does NOT come back byte-identical, and why
 *
 * Measured, not asserted. All three golden ADT samples and a constructed ORU^R01 round-trip
 * byte for byte. Three classes of input deliberately do not, because the text they lose is not
 * HL7 content and the parser says so with a diagnostic:
 *
 *   1. BLANK LINES between segments (`blank-line`, info) are not written back. HL7 v2 has no
 *      blank segment, so there is no node to hold one.
 *   2. MIXED segment terminators (`mixed-segment-terminators`, warn) are normalised to the one
 *      the message used most. A message that switches terminators mid-stream cannot be both
 *      reproduced and made sense of; the diagnostic names the terminator that will be written.
 *   3. WHITESPACE-ONLY input emits the empty string — it contains no segment.
 *
 * Separately, `useRaw: false` re-escapes every leaf from its decoded value, so a message
 * carrying escape sequences this workbench does not decode comes back changed: ADT_sample03
 * and ADT_sample04 end every segment with an unterminated `\`, which re-escapes to `\E\`.
 * That is the correct HL7 encoding of what those files literally contain — it is the samples
 * that are wrong (src/spec/sample-defects.json, `invalid-wire-encoding`) — which is exactly
 * why `useRaw` defaults to `true` and nothing is rewritten unless someone edited it.
 */

import type { DatatypesBundle, MessageStructure, StructureTree, TreeNode } from "../structure";
import {
  type Hl7Dialect,
  decodeHl7,
  encodeHl7,
  hl7v2Datatypes,
  makeDialect,
  normaliseTerminator,
} from "../parse/hl7v2";

export interface EmitOptions {
  /**
   * The delimiters, escape letters and terminator to write with. Hand back
   * `ParseResult.dialect` for a byte-identical round trip. Without it the dialect is recovered
   * from the tree's own MSH-1 / MSH-2 nodes, then from `tree.text`, then from
   * `structure.envelope.segmentTerminator`.
   */
  dialect?: Hl7Dialect;
  /** `src/spec/datatypes.json`, for the escape-sequence letters. */
  datatypes?: DatatypesBundle;
  /**
   * Use a leaf's `raw` text when it still agrees with `value` (default `true`). Set `false` to
   * force every leaf through {@link encodeHl7} — useful for checking that the tree's decoded
   * values alone can reproduce the message.
   */
  useRaw?: boolean;
  /** Override the segment terminator (HL7 v2 fixes it at `\r`; files often carry `\r\n`). */
  segmentTerminator?: string;
  /** Text to write after the last segment. Default: whatever the dialect observed. */
  trailingTerminator?: string;
}

/* ========================================================================== *
 * Entry point
 * ========================================================================== */

export function emitHl7v2(tree: StructureTree, structure: MessageStructure, opts?: EmitOptions): string {
  const bundle = opts?.datatypes ?? hl7v2Datatypes() ?? null;
  const dialect = resolveDialect(tree, structure, bundle, opts);
  const useRaw = opts?.useRaw ?? true;

  const segments = collectSegments(tree?.root ?? null);
  const lines: string[] = [];
  for (const node of segments) lines.push(emitSegment(node, dialect, useRaw));

  return lines.join(dialect.segmentTerminator) + (lines.length ? dialect.trailingTerminator : "");
}

/* ========================================================================== *
 * Dialect
 * ========================================================================== */

function resolveDialect(
  tree: StructureTree | null,
  structure: MessageStructure | null | undefined,
  bundle: DatatypesBundle | null,
  opts: EmitOptions | undefined,
): Hl7Dialect {
  const text = tree?.text ?? "";
  const between = /\r\n|\r|\n/.exec(text);
  const tail = /(?:\r\n|\r|\n)+$/.exec(text);

  const segmentTerminator =
    opts?.segmentTerminator ??
    opts?.dialect?.segmentTerminator ??
    (between ? between[0] : null) ??
    normaliseTerminator(structure?.envelope?.kind === "hl7v2Message" ? structure.envelope.segmentTerminator : null) ??
    "\r";

  const trailingTerminator =
    opts?.trailingTerminator ?? opts?.dialect?.trailingTerminator ?? (tail ? tail[0] : "");

  if (opts?.dialect) {
    return { ...opts.dialect, segmentTerminator, trailingTerminator };
  }

  // Recover MSH-1 and MSH-2 from the tree itself — the same two nodes a parser read them from.
  const msh = collectSegments(tree?.root ?? null).find((n) => segmentIdOf(n) === "MSH") ?? null;
  const fieldSeparator = msh ? leafText(fieldNode(msh, 1)) : null;
  const encodingCharacters = msh ? leafText(fieldNode(msh, 2)) : null;

  return makeDialect({ fieldSeparator, encodingCharacters, bundle, segmentTerminator, trailingTerminator });
}

function leafText(node: TreeNode | null): string | null {
  if (!node) return null;
  if (typeof node.raw === "string" && node.raw.length) return node.raw;
  return node.value;
}

/* ========================================================================== *
 * Walking the tree
 * ========================================================================== */

/**
 * Every segment node, in the order it must be written.
 *
 * Document order is the order the nodes sit in the tree, EXCEPT that a parser appends segments
 * it could not place (out of order, or not in the structure at all) at the end so they are not
 * lost. When every segment carries a source offset, sorting by offset restores the order the
 * message actually had, so nothing is silently reordered on the way back out.
 */
function collectSegments(root: TreeNode | null): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (node: TreeNode) => {
    if (node.kind === "segment") {
      out.push(node);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  if (root) walk(root);

  const placed = out.map((node) => ({ node, offset: node.loc?.offset }));
  const located = placed.filter((p): p is { node: TreeNode; offset: number } => typeof p.offset === "number");
  if (out.length > 1 && located.length === out.length && new Set(located.map((p) => p.offset)).size === out.length) {
    return located.slice().sort((a, b) => a.offset - b.offset).map((p) => p.node);
  }
  return out;
}

/** `PID[0]` -> `PID`. Prefers the locator, which the parser always sets for a valid id. */
function segmentIdOf(node: TreeNode): string {
  if (node.locator && node.locator.kind === "hl7Field") return node.locator.segment;
  const bracket = node.id.indexOf("[");
  const head = bracket === -1 ? node.id : node.id.slice(0, bracket);
  return head || node.label;
}

function fieldNumberOf(node: TreeNode): number | null {
  if (node.locator && node.locator.kind === "hl7Field" && node.locator.component === undefined) {
    return node.locator.field;
  }
  const m = node.id.match(/\.(\d+)$/);
  return m ? Number(m[1]) : null;
}

function fieldNode(segment: TreeNode, field: number): TreeNode | null {
  for (const child of segment.children ?? []) {
    if (child.kind === "field" && fieldNumberOf(child) === field) return child;
  }
  return null;
}

/* ========================================================================== *
 * Serialisation
 * ========================================================================== */

function emitSegment(node: TreeNode, dialect: Hl7Dialect, useRaw: boolean): string {
  const segId = segmentIdOf(node);

  const fields = new Map<number, TreeNode>();
  let highest = 0;
  for (const child of node.children ?? []) {
    if (child.kind !== "field") continue;
    const n = fieldNumberOf(child);
    if (n === null || n < 1) continue;
    fields.set(n, child);
    if (n > highest) highest = n;
  }

  // A segment with no field children at all can only be reproduced from its raw text.
  if (highest === 0) {
    if (useRaw && typeof node.raw === "string") return node.raw;
    return segId;
  }

  const isMsh = segId === "MSH";
  const separator = isMsh ? (leafText(fields.get(1) ?? null) ?? dialect.delimiters.field) : dialect.delimiters.field;

  const parts: string[] = [];
  // MSH-1 IS the separator, so it is written by the join rather than as a field of its own.
  for (let n = isMsh ? 2 : 1; n <= highest; n++) {
    const field = fields.get(n);
    parts.push(field ? emitField(field, segId, n, dialect, useRaw) : "");
  }

  return `${segId}${separator}${parts.join(separator)}`;
}

function emitField(node: TreeNode, segId: string, field: number, dialect: Hl7Dialect, useRaw: boolean): string {
  // MSH-1 and MSH-2 declare the delimiters. They are literal: never split, never escaped.
  if (segId === "MSH" && field <= 2) {
    return (useRaw ? leafText(node) : node.value) ?? node.value ?? "";
  }

  const children = node.children ?? [];
  if (children.length === 0) return emitLeaf(node, dialect, useRaw);

  if (children[0].kind === "repetition") {
    return children.map((rep) => emitRepetition(rep, dialect, useRaw)).join(dialect.delimiters.repetition);
  }
  return emitRepetition(node, dialect, useRaw);
}

/** One repetition of a field: its components, or its own leaf value. */
function emitRepetition(node: TreeNode, dialect: Hl7Dialect, useRaw: boolean): string {
  const children = node.children ?? [];
  if (children.length === 0) return emitLeaf(node, dialect, useRaw);
  return children.map((component) => emitComponent(component, dialect, useRaw)).join(dialect.delimiters.component);
}

function emitComponent(node: TreeNode, dialect: Hl7Dialect, useRaw: boolean): string {
  const children = node.children ?? [];
  if (children.length === 0) return emitLeaf(node, dialect, useRaw);
  return children.map((sub) => emitLeaf(sub, dialect, useRaw)).join(dialect.delimiters.subcomponent);
}

/**
 * A leaf.
 *
 * `raw` wins only while it still decodes to `value` — that is what makes an edit take effect
 * and an untouched value survive byte for byte, including the escape sequences the parser
 * deliberately left undecoded (`\X0D\`, and the unterminated `\` the two defective ADT samples
 * carry at the end of every segment).
 */
function emitLeaf(node: TreeNode, dialect: Hl7Dialect, useRaw: boolean): string {
  const value = node.value ?? "";
  if (useRaw && typeof node.raw === "string") {
    if (decodeHl7(node.raw, dialect).value === value) return node.raw;
  }
  return encodeHl7(value, dialect);
}
