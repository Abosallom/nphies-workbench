/**
 * CDA R2 emitter — {@link StructureTree} in, message text out.
 *
 * ## The inverse guarantee
 *
 * `emitCda` is the exact inverse of `parseCda` (`../parse/cda.ts`):
 *
 *     emitCda(parseCda(text, structure).tree, structure) === text
 *
 * byte for byte, for every official golden sample. That is what stops Build and Check from
 * drifting apart, and it is what the round-trip test proves.
 *
 * It holds because the emitter reconstructs the document from the tree NODE BY NODE and
 * uses each node's `raw` only for the lexical detail the tree cannot otherwise carry —
 * attribute spacing and quoting, `<a/>` versus `<a></a>`, entity spelling, the exact bytes
 * of comments and of the XML declaration. It never simply echoes `tree.text`: that would
 * make the round-trip test meaningless. Change any node's `value`, add or remove a child,
 * and the affected shell is rebuilt from the tree while its untouched neighbours keep their
 * original bytes.
 *
 * ## Building without a parse
 *
 * The second path — `HIS extract -> StructureTree -> emit` — has no `raw` anywhere. Every
 * node is then synthesised: `<qname attr="value">children</qname>`, self-closing when
 * empty, with values escaped. `indent` and `newline` control layout for that path only;
 * with `raw` present the original layout wins, because the original layout IS the answer.
 *
 * ## Spec-driven, never per-use-case
 *
 * The only thing the emitter reads from the {@link MessageStructure} is the normative
 * header element order (each header member's `documentOrder`), and only when
 * `enforceHeaderOrder` is set. Nothing branches on a use case: a use case is data.
 */

import type { CdaXPathLocator, MessageStructure, StructureGroup, StructureMember, StructureTree, TreeDiagnostic, TreeNode } from "../structure";
import { membersOf } from "../structure";
import { CDA_CDATA, CDA_COMMENT, CDA_DECL, CDA_DOCTYPE, CDA_PI, CDA_STRAY, CDA_TEXT, decodeXmlText, isLexicalLabel } from "../parse/cda";

/* ========================================================================== *
 * Options
 * ========================================================================== */

export interface EmitOptions {
  /**
   * Reorder the document element's children into the normative 27-element header order
   * before writing. OFF by default, because reordering breaks the inverse guarantee: emit
   * must reproduce the tree it was given. Turn it on for the Build path, where the tree was
   * assembled from a HIS extract and its order is arbitrary.
   *
   * Reordering is skipped, with a warning, when any element child of the document element
   * carries no header `memberId` — moving an element the structure does not describe would
   * be a guess.
   */
  enforceHeaderOrder?: boolean;
  /** How to write an element with no children and no `raw`. Default `"self-closing"`. */
  emptyElement?: "self-closing" | "paired";
  /** Indent unit for synthesised nodes. Default one tab, matching the official samples. */
  indent?: string;
  /** Line ending for synthesised nodes. Default `"\r\n"`, matching the official samples. */
  newline?: string;
  /**
   * Pretty-print synthesised subtrees. Default `true`. Has no effect where `raw` survives:
   * original bytes always win over generated layout.
   */
  pretty?: boolean;
  /** Called for anything the emitter had to decide rather than reproduce. */
  onWarning?: (diagnostic: TreeDiagnostic) => void;
}

interface Ctx {
  emptyElement: "self-closing" | "paired";
  indent: string;
  newline: string;
  pretty: boolean;
  warn: (code: string, message: string, node: TreeNode | null) => void;
}

/* ========================================================================== *
 * Escaping — the inverse of the parser's decoder
 * ========================================================================== */

/** Escape character data. `>` is escaped too, so `]]>` can never appear by accident. */
export function escapeXmlText(value: string): string {
  return value.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

/** Escape an attribute value for double-quoted delimiters. */
export function escapeXmlAttr(value: string): string {
  return value.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

/* ========================================================================== *
 * Lexical helpers over `raw`
 * ========================================================================== */

/** The qualified element name, taken from the instance locator's last step. */
function qnameOf(node: TreeNode): string {
  const locator = node.locator;
  if (locator && locator.kind === "cdaXPath" && locator.path) {
    const path = locator.path;
    let depth = 0;
    let cut = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      const c = path[i];
      if (c === "]") depth++;
      else if (c === "[") depth--;
      else if (c === "/" && depth === 0) {
        cut = i;
        break;
      }
    }
    const last = (cut < 0 ? path : path.slice(cut + 1)).replace(/\[.*$/, "");
    if (last) return last;
  }
  return node.label;
}

/** The attribute's qualified name. */
function attrNameOf(node: TreeNode): string {
  const locator = node.locator;
  if (locator && locator.kind === "cdaXPath" && locator.attribute) return locator.attribute;
  return node.label;
}

/** Slice the start tag out of an element's `raw`, respecting quoted attribute values. */
function openTagOf(raw: string): string | null {
  if (raw.charCodeAt(0) !== 60 /* < */) return null;
  let quote = "";
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === ">") return raw.slice(0, i + 1);
  }
  return null;
}

/**
 * The end tag inside an element's `raw`. Safe: character data may not contain `<`, and the
 * end tag is the last thing in the span, so the final `</` is always its start.
 */
function closeTagOf(raw: string): string | null {
  const at = raw.lastIndexOf("</");
  return at < 0 ? null : raw.slice(at);
}

/** The decoded value inside an attribute's `raw` (` name="value"`). */
function attrValueOfRaw(raw: string): string | null {
  const eq = raw.indexOf("=");
  if (eq < 0) return null;
  let i = eq + 1;
  while (i < raw.length && /\s/.test(raw[i])) i++;
  const quote = raw[i];
  if (quote === '"' || quote === "'") {
    const close = raw.indexOf(quote, i + 1);
    return decodeXmlText(raw.slice(i + 1, close < 0 ? raw.length : close));
  }
  return decodeXmlText(raw.slice(i).trim());
}

function attrNameOfRaw(raw: string): string {
  const eq = raw.indexOf("=");
  return (eq < 0 ? raw : raw.slice(0, eq)).trim();
}

/** Is this attribute node's `raw` still an exact rendering of its current value and name? */
function attrRawIsCurrent(node: TreeNode): boolean {
  if (node.raw == null) return false;
  if (attrNameOfRaw(node.raw) !== attrNameOf(node)) return false;
  return attrValueOfRaw(node.raw) === node.value;
}

/* ========================================================================== *
 * Node writers
 * ========================================================================== */

function writeAttr(node: TreeNode): string {
  if (attrRawIsCurrent(node)) return node.raw as string;
  const name = attrNameOf(node);
  if (node.value === null) return ` ${name}`;
  return ` ${name}="${escapeXmlAttr(node.value)}"`;
}

function writeLexical(ctx: Ctx, node: TreeNode): string {
  const value = node.value ?? "";
  switch (node.label) {
    case CDA_COMMENT:
      if (node.raw != null && decodeXmlText(node.raw.slice(4, -3)) === value) return node.raw;
      return `<!--${value}-->`;
    case CDA_CDATA:
      if (node.raw != null && node.raw.slice(9, -3) === value) return node.raw;
      return `<![CDATA[${value}]]>`;
    case CDA_PI:
    case CDA_DECL:
    case CDA_DOCTYPE:
    case CDA_STRAY:
      // These carry no model of their own; the source bytes are the only truth there is.
      if (node.raw != null) return node.raw;
      ctx.warn(
        "cda/lexical-without-raw",
        `A ${node.label} node has no source text, so it cannot be written back. It is omitted.`,
        node,
      );
      return "";
    case CDA_TEXT:
    default:
      if (node.raw != null && decodeXmlText(node.raw) === value) return node.raw;
      return escapeXmlText(value);
  }
}

function isElement(node: TreeNode): boolean {
  return node.kind === "element";
}

function writeElement(ctx: Ctx, node: TreeNode, depth: number): string {
  const qname = qnameOf(node);
  const attrs = node.children.filter((c) => c.kind === "attribute" && c.present !== false);
  const content = node.children.filter((c) => c.kind !== "attribute" && c.present !== false);

  const raw = node.raw ?? null;
  const rawOpen = raw ? openTagOf(raw) : null;
  const nameStillMatches =
    rawOpen !== null && rawOpen.startsWith(`<${qname}`) && /^[\s/>]/.test(rawOpen.slice(qname.length + 1) || ">");
  const attrsUntouched =
    rawOpen !== null &&
    attrs.length === countAttrsIn(rawOpen) &&
    attrs.every((a) => attrRawIsCurrent(a));

  let open: string;
  let selfClosed: boolean;
  if (rawOpen !== null && nameStillMatches && attrsUntouched) {
    open = rawOpen;
    selfClosed = rawOpen.endsWith("/>");
  } else {
    const body = `<${qname}${attrs.map(writeAttr).join("")}`;
    // An element that was self-closing in the source and is still empty stays self-closing.
    const preferSelfClose = rawOpen !== null ? rawOpen.endsWith("/>") : ctx.emptyElement === "self-closing";
    selfClosed = content.length === 0 && preferSelfClose;
    open = selfClosed ? `${body}/>` : `${body}>`;
  }

  if (content.length === 0) {
    if (selfClosed) return open;
    const rawClose = raw ? closeTagOf(raw) : null;
    return open + (rawClose && rawClose.startsWith(`</${qname}`) ? rawClose : `</${qname}>`);
  }

  if (selfClosed) open = `${open.slice(0, -2)}>`;
  const rawClose = raw ? closeTagOf(raw) : null;
  const close = rawClose && rawClose.startsWith(`</${qname}`) ? rawClose : `</${qname}>`;

  // Layout is only ever invented where the tree carries none: if the element already has
  // whitespace text nodes from a parse, they are its layout and nothing is added.
  const hasOwnLayout = content.some((c) => c.kind === "text" && c.raw != null);
  const needsLayout = ctx.pretty && !hasOwnLayout && content.some(isElement);

  const parts: string[] = [];
  for (const child of content) {
    const text = writeNode(ctx, child, depth + 1);
    if (needsLayout && isElement(child)) parts.push(ctx.newline + ctx.indent.repeat(depth + 1));
    parts.push(text);
  }
  if (needsLayout) parts.push(ctx.newline + ctx.indent.repeat(depth));
  return open + parts.join("") + close;
}

/**
 * How many attributes an open tag spells out, so the emitter can tell whether the tree still
 * agrees with the source text it came from.
 *
 * Every branch advances `i`. An earlier version stepped back onto the `=` it had just
 * consumed and spun forever on the first attribute it met, which hung the CDA emitter — and
 * would have hung the browser tab — on every official document.
 */
function countAttrsIn(openTag: string): number {
  let n = 0;
  let i = 1;
  while (i < openTag.length && !/[\s/>]/.test(openTag[i])) i++; // element name

  while (i < openTag.length) {
    const c = openTag[i];
    if (c === ">" || (c === "/" && openTag[i + 1] === ">")) break;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    n++;
    while (i < openTag.length && !/[\s=/>]/.test(openTag[i])) i++; // the name
    while (i < openTag.length && /\s/.test(openTag[i])) i++;
    if (openTag[i] !== "=") continue; // a bare attribute, XML-invalid but not ours to fix
    i++;
    while (i < openTag.length && /\s/.test(openTag[i])) i++;
    const quote = openTag[i];
    if (quote === '"' || quote === "'") {
      i++;
      while (i < openTag.length && openTag[i] !== quote) i++;
      i++; // past the closing quote
    } else {
      while (i < openTag.length && !/[\s/>]/.test(openTag[i])) i++;
    }
  }
  return n;
}

function writeNode(ctx: Ctx, node: TreeNode, depth: number): string {
  if (node.present === false) return "";
  switch (node.kind) {
    case "message":
    case "group":
      return node.children.filter((c) => c.present !== false).map((c) => writeNode(ctx, c, depth)).join("");
    case "attribute":
      return writeAttr(node);
    case "element":
      return writeElement(ctx, node, depth);
    case "text":
      return writeLexical(ctx, node);
    default:
      // Any other TreeNodeKind reaching a CDA tree is not something this emitter models.
      // Reproduce its source text if it has any, and say so rather than drop it silently.
      if (node.raw != null) return node.raw;
      ctx.warn(
        "cda/unsupported-node-kind",
        `Node ${node.id} has kind "${node.kind}", which the CDA emitter does not model, and no source text. It is omitted.`,
        node,
      );
      return "";
  }
}

/* ========================================================================== *
 * Header order (Build path only)
 * ========================================================================== */

function headerOrderOf(structure: MessageStructure): Map<string, number> {
  const order = new Map<string, number>();
  const groups: StructureGroup[] = [];
  const collect = (members: readonly StructureMember[]) => {
    for (const m of members) {
      if (m.kind === "group") groups.push(m);
      collect(membersOf(m));
    }
  };
  collect(structure.root.members);
  for (const g of groups) {
    for (const m of g.members) {
      const pos = (m as { documentOrder?: number }).documentOrder;
      if (typeof pos === "number") order.set(m.id, pos);
    }
  }
  return order;
}

/**
 * Reorder the document element's element children into the normative header order, keeping
 * each element's preceding whitespace and comments attached to it. Refuses (and warns) if
 * any element child is not a known header member.
 */
function reorderHeader(ctx: Ctx, documentNode: TreeNode, order: Map<string, number>): void {
  if (order.size === 0) return;
  const attrs = documentNode.children.filter((c) => c.kind === "attribute");
  const content = documentNode.children.filter((c) => c.kind !== "attribute");

  const blocks: { pos: number; nodes: TreeNode[] }[] = [];
  let pending: TreeNode[] = [];
  let tail: TreeNode[] = [];
  for (const child of content) {
    pending.push(child);
    if (!isElement(child)) continue;
    const pos = child.memberId ? order.get(child.memberId) : undefined;
    if (pos === undefined) {
      ctx.warn(
        "cda/header-order-not-enforced",
        `<${qnameOf(child)}> maps to no header member of this structure, so the header was left in its existing ` +
          "order. Moving an element the spec does not describe would be a guess.",
        child,
      );
      return;
    }
    blocks.push({ pos, nodes: pending });
    pending = [];
  }
  tail = pending;

  const sorted = blocks.map((b, i) => ({ ...b, i })).sort((a, b) => a.pos - b.pos || a.i - b.i);
  documentNode.children = [...attrs, ...sorted.flatMap((b) => b.nodes), ...tail];
}

/* ========================================================================== *
 * emitCda
 * ========================================================================== */

/**
 * Serialise a {@link StructureTree} back to CDA R2 XML.
 *
 * With a tree that came from {@link parseCda} and default options the output is byte-identical
 * to the parsed text. With a tree assembled by hand, every node is synthesised.
 */
export function emitCda(tree: StructureTree, structure: MessageStructure, opts: EmitOptions = {}): string {
  const warnings: TreeDiagnostic[] = [];
  const ctx: Ctx = {
    emptyElement: opts.emptyElement ?? "self-closing",
    indent: opts.indent ?? "\t",
    newline: opts.newline ?? "\r\n",
    pretty: opts.pretty !== false,
    warn: (code, message, node) => {
      const diagnostic: TreeDiagnostic = { severity: "warn", code, message, loc: node?.loc ?? null, nodeId: node?.id ?? null };
      warnings.push(diagnostic);
      opts.onWarning?.(diagnostic);
    },
  };

  try {
    if (!tree || !tree.root) return "";

    if (opts.enforceHeaderOrder) {
      const order = headerOrderOf(structure);
      for (const child of tree.root.children) {
        if (isElement(child)) reorderHeader(ctx, child, order);
      }
    }

    return writeNode(ctx, tree.root, 0);
  } catch (err) {
    // Emitting must not throw either: the Build pane has to show something and say why.
    const diagnostic: TreeDiagnostic = {
      severity: "error",
      code: "cda/emitter-error",
      message: `The emitter failed on this tree: ${err instanceof Error ? err.message : String(err)}.`,
      loc: null,
      nodeId: null,
    };
    opts.onWarning?.(diagnostic);
    return "";
  }
}

/**
 * Convenience for the round-trip test and for the UI's "is this still the same message?"
 * check. Returns `null` when the two strings are identical, otherwise the first differing
 * offset with context either side — which is the only useful thing to show an analyst.
 */
export function firstDifference(
  a: string,
  b: string,
  context = 60,
): { offset: number; line: number; expected: string; actual: string } | null {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  if (i === n && a.length === b.length) return null;
  let line = 1;
  for (let k = 0; k < i; k++) if (a[k] === "\n") line++;
  const from = Math.max(0, i - context);
  return {
    offset: i,
    line,
    expected: a.slice(from, i + context),
    actual: b.slice(from, i + context),
  };
}

/** Node locator helper shared with callers that need the element path of a tree node. */
export function cdaPathOf(node: TreeNode): string | null {
  const locator = node.locator as CdaXPathLocator | null;
  if (!locator || locator.kind !== "cdaXPath") return null;
  return locator.attribute ? `${locator.path}/@${locator.attribute}` : locator.path;
}

/** Re-exported so callers can tell an element node from a comment/text node. */
export { isLexicalLabel };
