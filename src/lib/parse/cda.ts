/**
 * CDA R2 parser — message text in, {@link StructureTree} out.
 *
 * ## What this is
 *
 * `parseCda` is one half of the workbench's central bet: parse and emit are exact inverses
 * over a shared `StructureTree`, so `emitCda(parseCda(text, s).tree, s)` reproduces `text`
 * byte for byte and `Build` can never drift away from `Check`. See `../emit/cda.ts`.
 *
 * ## Why a hand-written scanner rather than a DOM library
 *
 * Two hard requirements decide this:
 *
 *   1. EVERY node must carry a source location. The SplitView highlights from it; without
 *      it a finding cannot point at anything.
 *   2. Round-trip must be byte-identical. A DOM library normalises away exactly the things
 *      fidelity depends on: attribute order and spacing, `<a/>` vs `<a></a>`, entity
 *      spelling, comments, the XML declaration, inter-element whitespace, CRLF.
 *
 * So the scanner below records, for every construct, the exact source span and the exact
 * source text, and the emitter writes that text back. `fast-xml-parser` is still used, as a
 * CROSS-CHECK: the same text is parsed independently and the element count compared, and a
 * disagreement is reported as a diagnostic rather than silently ignored. That gives an
 * independent witness that the scanner read the document the way a conformant parser does.
 * Set `crossCheck: false` to skip it.
 *
 * ## Spec-driven, never per-use-case
 *
 * Nothing here branches on a use case. Everything comes from the compiled
 * {@link MessageStructure}:
 *
 *   - the document element name, from the header group's `/ClinicalDocument` locator;
 *   - the normative 27-element header order, from the header members' `documentOrder`;
 *   - section identity by `templateId/@root` — never by position or title — from each
 *     section member's `templateIds`;
 *   - the Full vs NoInfo distinction from each section member's `noInfoFlagTemplateId`
 *     (the repair pass verified that NoInfo sections are flagged by an extra templateId,
 *     NOT by `nullFlavor`; a checker looking for `section/@nullFlavor` finds nothing);
 *   - everything below a section from the field tables the section's `specRefs` cite, and
 *     from the templateId-indexed entry tables, both supplied through `opts.spec`.
 *
 * ## How far spec resolution honestly reaches
 *
 * The compiled CDA field tables are three levels deep and bottom out at a section's direct
 * children; an `entry` row names its content module in PROSE ("See Problem Concern Entry"),
 * with no machine-readable link. This parser follows the only machine-readable link that
 * exists — the templateId OID — into the entry's own field table, when `opts.spec.fields`
 * is supplied. Below that the published spec says nothing, so nodes are still built, with
 * their locations and values, but `specNodeId` is left null. They are NOT reported as
 * "unknown": calling an element unknown where the spec never enumerated its position would
 * be a confidently wrong verdict. `unknown` is populated only at the levels where the spec
 * IS enumerative — see {@link UnknownElement.scope}. Pass `unknownDepth: "all"` to list
 * every unmapped element as well.
 *
 * ## Malformed input
 *
 * Parsing never throws. Hospitals paste broken messages; that is the point of the tool.
 * Unclosed elements, stray end tags, unterminated tags, unquoted attribute values and
 * non-XML input all produce a partial tree plus diagnostics, and every byte of the input
 * still lands in some node's `raw`, so even a broken message round-trips.
 */

import { XMLParser } from "fast-xml-parser";

import type {
  CdaXPathLocator,
  FieldBundle,
  FieldTable,
  MessageStructure,
  Severity,
  SourceLocation,
  SpecNode,
  StructureGroup,
  StructureMember,
  StructureSection,
  StructureTree,
  TreeDiagnostic,
  TreeNode,
} from "../structure";
import { membersOf } from "../structure";

/* ========================================================================== *
 * Public types
 * ========================================================================== */

/** Alias of the engine's {@link TreeDiagnostic}, under the name the workbench uses. */
export type Diagnostic = TreeDiagnostic;

/** Labels used for non-element tree nodes. Emit reproduces these verbatim from `raw`. */
export const CDA_TEXT = "#text";
export const CDA_COMMENT = "#comment";
export const CDA_PI = "#pi";
export const CDA_DECL = "#decl";
export const CDA_DOCTYPE = "#doctype";
export const CDA_CDATA = "#cdata";
/** Text the scanner could not interpret (a stray end tag, a lone `<`). Kept, never dropped. */
export const CDA_STRAY = "#stray";

const LEXICAL_LABELS = new Set([
  CDA_TEXT,
  CDA_COMMENT,
  CDA_PI,
  CDA_DECL,
  CDA_DOCTYPE,
  CDA_CDATA,
  CDA_STRAY,
]);

/** Is this a non-element lexical node (text, comment, PI, declaration…)? */
export function isLexicalLabel(label: string): boolean {
  return LEXICAL_LABELS.has(label);
}

/**
 * Diagnostic code raised on a section flagged "no information available" by the extra
 * `.1` templateId. Siblings filter on this constant rather than re-deriving the rule.
 */
export const CDA_NOINFO_DIAGNOSTIC = "cda/section-no-information";

/**
 * A namespace prefix the published spec binds to a URI. Built from `constants.json` —
 * see {@link cdaNamespacesFromConstants}. Supplied by the caller so that parsing stays
 * synchronous and pure.
 */
export interface CdaNamespaceRule {
  /** `""` for the default namespace. */
  prefix: string;
  uri: string;
  /** Verbatim source fragment, e.g. `xmlns:lab="urn:oid:1.3.6.1.4.1.19376.1.3.2"`. */
  quote: string | null;
  /** Confluence page the binding was read from; `null` when only a sample shows it. */
  pageId: string | null;
}

/**
 * Compiled spec material the parser needs but cannot load itself (loading is async; this
 * function is sync and pure). Everything is optional: with none of it the parser still
 * resolves the header and the section tree, which is what the `MessageStructure` alone
 * carries.
 */
export interface CdaSpecContext {
  /** Field tables keyed `<pageId>:<tableIndex>` — exactly `ResolvedUseCase.tables`. */
  tables?: ReadonlyMap<string, FieldTable>;
  /** The whole `fields/cda.json` bundle, which enables templateId descent into entries. */
  fields?: FieldBundle;
  /** Namespace bindings the spec states. */
  namespaces?: readonly CdaNamespaceRule[];
}

export interface ParseOptions {
  /** Extra compiled spec material. See {@link CdaSpecContext}. */
  spec?: CdaSpecContext;
  /**
   * Which unmapped elements to report in `unknown`.
   * `"enumerated"` (default) — only where the spec enumerates the allowed children.
   * `"all"` — additionally every element with no resolved spec node.
   */
  unknownDepth?: "enumerated" | "all";
  /** Cross-check the scan against `fast-xml-parser`. Default `true`. */
  crossCheck?: boolean;
  /** Refuse inputs larger than this many characters. Default 32 MB. */
  maxChars?: number;
}

/** An element the message contains at a position where the spec enumerates what may appear. */
export interface UnknownElement {
  /** `TreeNode.id` of the element, so the UI can jump straight to it. */
  nodeId: string;
  /** Qualified name as written, e.g. `nphies:documentStatus`. */
  name: string;
  /** Absolute instance path of the containing element. */
  parentPath: string;
  locator: CdaXPathLocator;
  loc: SourceLocation;
  /**
   * The level whose child list the spec enumerates:
   *   `header`        a direct child of the document element outside the 27-element model
   *   `section`       a `<section>` whose templateId matches no section in this structure
   *   `section-child` a direct child of a matched section outside its field table
   *   `entry-child`   a direct child of a matched entry outside its content-module table
   *   `unmapped`      only with `unknownDepth: "all"` — the spec enumerates nothing here
   */
  scope: "header" | "section" | "section-child" | "entry-child" | "unmapped";
  /** Plain sentence an analyst can read next to the finding. */
  reason: string;
  /** What the spec does allow at this position, when it enumerates it. */
  expected: string[];
}

export interface ParseResult {
  tree: StructureTree;
  diagnostics: Diagnostic[];
  unknown: UnknownElement[];
}

/**
 * Read the spec's CDA namespace bindings out of a loaded `constants.json`.
 *
 * The bindings live on OID records whose `role` is `xmlNamespace`, whose `exampleQuote` is
 * the verbatim `xmlns:…="…"` line from the "CDA Namespaces" page. Nothing is synthesised:
 * a record without a parseable quote is skipped.
 */
export function cdaNamespacesFromConstants(constants: unknown): CdaNamespaceRule[] {
  const out: CdaNamespaceRule[] = [];
  const seen = new Set<string>();
  const oids = (constants as { oids?: unknown } | null)?.oids;
  const list = Array.isArray(oids) ? oids : oids && typeof oids === "object" ? Object.values(oids) : [];
  for (const raw of list as unknown[]) {
    const rec = raw as Record<string, unknown> | null;
    if (!rec || typeof rec !== "object") continue;
    const texts: string[] = [];
    for (const key of ["exampleQuote", "label"]) {
      const v = rec[key];
      if (typeof v === "string") texts.push(v);
    }
    const src = rec.source as { pageId?: unknown; quote?: unknown } | undefined;
    if (src && typeof src.quote === "string") texts.push(src.quote);
    const pageId = src && typeof src.pageId === "string" ? src.pageId : null;
    const isNamespace = rec.role === "xmlNamespace";
    for (const text of texts) {
      for (const m of text.matchAll(/xmlns(?::([A-Za-z_][-\w.]*))?\s*=\s*["']?([^"'\s]+)["']?/g)) {
        if (!isNamespace && !m[1]) continue;
        const prefix = m[1] ?? "";
        const uri = m[2];
        const key = `${prefix}|${uri}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ prefix, uri, quote: text.includes("\n") ? m[0] : text, pageId });
      }
    }
  }
  return out;
}

/* ========================================================================== *
 * Lexical layer: a location-preserving XML scanner
 * ========================================================================== */

type XmlNodeType = "element" | "text" | "comment" | "cdata" | "pi" | "decl" | "doctype" | "stray";

interface XmlAttr {
  /** Qualified name as written, e.g. `codeSystemName`, `xsi:type`. */
  qname: string;
  prefix: string;
  local: string;
  /** Decoded value; `null` for a bare attribute name with no `=`. */
  value: string | null;
  /** Exact source text INCLUDING the whitespace that precedes the name. */
  raw: string;
  start: number;
  end: number;
  /** Span of the value itself, excluding quotes. `null` when there is no value. */
  valueStart: number | null;
  valueEnd: number | null;
}

interface XmlNode {
  type: XmlNodeType;
  /** Qualified name, for elements. */
  qname: string;
  prefix: string;
  local: string;
  attrs: XmlAttr[];
  children: XmlNode[];
  /** Absolute span of the whole construct. */
  start: number;
  end: number;
  /** End offset of the start tag (exclusive), for elements. */
  openEnd: number;
  selfClosing: boolean;
  /** Decoded character data, for text/comment/cdata nodes. */
  text: string;
  /** Resolved namespace URI, or `null` when the prefix is unbound. */
  nsUri: string | null;
  /** In-scope prefix -> URI at this element. Shared with the parent when unchanged. */
  scope: ReadonlyMap<string, string>;
  /** 1-based index among preceding siblings carrying the same qname. */
  sameNameIndex: number;
  /** True when an implicit close was invented because the source never closed the tag. */
  implicitlyClosed: boolean;
}

const NO_SCOPE: ReadonlyMap<string, string> = new Map();

function makeNode(type: XmlNodeType, start: number, end: number): XmlNode {
  return {
    type,
    qname: "",
    prefix: "",
    local: "",
    attrs: [],
    children: [],
    start,
    end,
    openEnd: end,
    selfClosing: false,
    text: "",
    nsUri: null,
    scope: NO_SCOPE,
    sameNameIndex: 1,
    implicitlyClosed: false,
  };
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' };

/** Decode the five XML entities plus numeric character references. Unknown refs are kept. */
export function decodeXmlText(text: string): string {
  if (text.indexOf("&") < 0) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const hit = ENTITIES[body];
    return hit === undefined ? whole : hit;
  });
}

interface ScanResult {
  /** Top-level nodes in document order: declaration, comments, whitespace, root element. */
  nodes: XmlNode[];
  /** The first top-level element, when there is one. */
  documentElement: XmlNode | null;
  diagnostics: { code: string; message: string; offset: number; severity: Severity }[];
  elementCount: number;
}

const NAME_END = /[\s/>]/;

/**
 * Scan XML into a location-preserving node tree. Tolerant by design: every byte of `text`
 * ends up inside exactly one node's source span, so concatenating spans rebuilds the input.
 */
export function scanXml(text: string): ScanResult {
  const nodes: XmlNode[] = [];
  const diagnostics: ScanResult["diagnostics"] = [];
  const stack: XmlNode[] = [];
  let elementCount = 0;
  let i = 0;
  let textStart = 0;

  const top = () => (stack.length ? stack[stack.length - 1] : null);
  const push = (node: XmlNode) => {
    const parent = top();
    (parent ? parent.children : nodes).push(node);
  };
  const flushText = (upto: number) => {
    if (upto <= textStart) return;
    const node = makeNode("text", textStart, upto);
    node.text = decodeXmlText(text.slice(textStart, upto));
    push(node);
  };
  const literal = (type: XmlNodeType, start: number, end: number, body?: string) => {
    const node = makeNode(type, start, end);
    if (body !== undefined) node.text = body;
    push(node);
  };

  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;

    // --- markup that is copied through verbatim ------------------------------------
    if (text.startsWith("<!--", lt)) {
      const close = text.indexOf("-->", lt + 4);
      const end = close < 0 ? text.length : close + 3;
      if (close < 0) {
        diagnostics.push({ code: "cda/unterminated-comment", message: "Comment is never closed with `-->`.", offset: lt, severity: "error" });
      }
      flushText(lt);
      literal("comment", lt, end, text.slice(lt + 4, close < 0 ? text.length : close));
      i = textStart = end;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const close = text.indexOf("]]>", lt + 9);
      const end = close < 0 ? text.length : close + 3;
      if (close < 0) {
        diagnostics.push({ code: "cda/unterminated-cdata", message: "CDATA section is never closed with `]]>`.", offset: lt, severity: "error" });
      }
      flushText(lt);
      literal("cdata", lt, end, text.slice(lt + 9, close < 0 ? text.length : close));
      i = textStart = end;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const close = text.indexOf("?>", lt + 2);
      const end = close < 0 ? text.length : close + 2;
      if (close < 0) {
        diagnostics.push({ code: "cda/unterminated-pi", message: "Processing instruction is never closed with `?>`.", offset: lt, severity: "error" });
      }
      flushText(lt);
      literal(/^<\?xml[\s?]/i.test(text.slice(lt, lt + 6)) ? "decl" : "pi", lt, end);
      i = textStart = end;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      // DOCTYPE or any other declaration. Copy to the matching `>`, allowing one nesting level.
      let j = lt + 2;
      let depth = 0;
      let quote = "";
      for (; j < text.length; j++) {
        const c = text[j];
        if (quote) {
          if (c === quote) quote = "";
          continue;
        }
        if (c === '"' || c === "'") quote = c;
        else if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      const end = j < text.length ? j + 1 : text.length;
      flushText(lt);
      literal("doctype", lt, end);
      i = textStart = end;
      continue;
    }

    // --- end tag -------------------------------------------------------------------
    if (text[lt + 1] === "/") {
      const gt = text.indexOf(">", lt);
      const end = gt < 0 ? text.length : gt + 1;
      const qname = text.slice(lt + 2, gt < 0 ? text.length : gt).trim();
      flushText(lt);
      const idx = findOpen(stack, qname);
      if (idx < 0) {
        diagnostics.push({
          code: "cda/stray-end-tag",
          message: `End tag </${qname}> has no matching start tag. Kept verbatim so the message still round-trips.`,
          offset: lt,
          severity: "error",
        });
        literal("stray", lt, end);
      } else {
        for (let k = stack.length - 1; k > idx; k--) {
          const abandoned = stack[k];
          abandoned.end = lt;
          abandoned.implicitlyClosed = true;
          diagnostics.push({
            code: "cda/unclosed-element",
            message: `<${abandoned.qname}> is closed implicitly by </${qname}>; the message never closes it.`,
            offset: abandoned.start,
            severity: "error",
          });
        }
        stack.length = idx + 1;
        const closing = stack.pop() as XmlNode;
        closing.end = end;
      }
      i = textStart = end;
      continue;
    }

    // --- start tag -----------------------------------------------------------------
    const nameEnd = scanName(text, lt + 1);
    if (nameEnd === lt + 1) {
      // A `<` that begins nothing. Leave it in the text run.
      i = lt + 1;
      continue;
    }
    flushText(lt);
    const node = makeNode("element", lt, text.length);
    node.qname = text.slice(lt + 1, nameEnd);
    const colon = node.qname.indexOf(":");
    node.prefix = colon < 0 ? "" : node.qname.slice(0, colon);
    node.local = colon < 0 ? node.qname : node.qname.slice(colon + 1);

    const tag = scanAttributes(text, nameEnd, node, diagnostics);
    node.openEnd = tag.openEnd;
    node.selfClosing = tag.selfClosing;
    elementCount++;
    push(node);
    if (tag.selfClosing) {
      node.end = tag.openEnd;
    } else {
      stack.push(node);
    }
    i = textStart = tag.openEnd;
  }

  flushText(text.length);
  for (let k = stack.length - 1; k >= 0; k--) {
    stack[k].end = text.length;
    stack[k].implicitlyClosed = true;
    diagnostics.push({
      code: "cda/unclosed-element",
      message: `<${stack[k].qname}> is never closed; the document ends inside it.`,
      offset: stack[k].start,
      severity: "error",
    });
  }

  const documentElement = nodes.find((n) => n.type === "element") ?? null;
  resolveNamespaces(nodes, NO_SCOPE);
  indexSiblings(nodes);
  return { nodes, documentElement, diagnostics, elementCount };
}

function scanName(text: string, from: number): number {
  let j = from;
  while (j < text.length && !NAME_END.test(text[j]) && text[j] !== "=") j++;
  return j;
}

function findOpen(stack: XmlNode[], qname: string): number {
  for (let k = stack.length - 1; k >= 0; k--) if (stack[k].qname === qname) return k;
  return -1;
}

function scanAttributes(
  text: string,
  from: number,
  node: XmlNode,
  diagnostics: ScanResult["diagnostics"],
): { openEnd: number; selfClosing: boolean } {
  let i = from;
  for (;;) {
    const wsStart = i;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) {
      diagnostics.push({
        code: "cda/unterminated-start-tag",
        message: `Start tag <${node.qname}> is never closed with \`>\`.`,
        offset: node.start,
        severity: "error",
      });
      return { openEnd: text.length, selfClosing: false };
    }
    if (text[i] === ">") return { openEnd: i + 1, selfClosing: false };
    if (text[i] === "/" && text[i + 1] === ">") return { openEnd: i + 2, selfClosing: true };
    if (text[i] === "/" ) {
      // lone slash inside the tag — keep scanning, it is malformed but recoverable
      i++;
      continue;
    }

    const nameStart = i;
    const nameEnd = scanName(text, i);
    if (nameEnd === nameStart) {
      i++;
      continue;
    }
    const attr: XmlAttr = {
      qname: text.slice(nameStart, nameEnd),
      prefix: "",
      local: "",
      value: null,
      raw: "",
      start: wsStart,
      end: nameEnd,
      valueStart: null,
      valueEnd: null,
    };
    const colon = attr.qname.indexOf(":");
    attr.prefix = colon < 0 ? "" : attr.qname.slice(0, colon);
    attr.local = colon < 0 ? attr.qname : attr.qname.slice(colon + 1);

    i = nameEnd;
    let j = i;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] === "=") {
      j++;
      while (j < text.length && /\s/.test(text[j])) j++;
      const quote = text[j];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, j + 1);
        const valueEnd = close < 0 ? text.length : close;
        attr.valueStart = j + 1;
        attr.valueEnd = valueEnd;
        attr.value = decodeXmlText(text.slice(j + 1, valueEnd));
        i = close < 0 ? text.length : close + 1;
        if (close < 0) {
          diagnostics.push({
            code: "cda/unterminated-attribute",
            message: `Attribute ${node.qname}/@${attr.qname} has no closing quote.`,
            offset: attr.start,
            severity: "error",
          });
        }
      } else {
        let valueEnd = j;
        while (valueEnd < text.length && !/[\s>]/.test(text[valueEnd])) valueEnd++;
        attr.valueStart = j;
        attr.valueEnd = valueEnd;
        attr.value = decodeXmlText(text.slice(j, valueEnd));
        i = valueEnd;
        diagnostics.push({
          code: "cda/unquoted-attribute",
          message: `Attribute ${node.qname}/@${attr.qname} has an unquoted value; XML requires quotes.`,
          offset: attr.start,
          severity: "error",
        });
      }
    } else {
      diagnostics.push({
        code: "cda/valueless-attribute",
        message: `Attribute ${node.qname}/@${attr.qname} has no value; XML requires \`name="value"\`.`,
        offset: attr.start,
        severity: "error",
      });
    }
    attr.end = i;
    attr.raw = text.slice(attr.start, attr.end);
    node.attrs.push(attr);
  }
}

/** Resolve `xmlns` declarations into an in-scope prefix map on every element. */
function resolveNamespaces(nodes: XmlNode[], inherited: ReadonlyMap<string, string>): void {
  for (const node of nodes) {
    if (node.type !== "element") continue;
    let scope = inherited;
    let own: Map<string, string> | null = null;
    for (const attr of node.attrs) {
      if (attr.value === null) continue;
      if (attr.qname === "xmlns") (own ??= new Map(inherited)).set("", attr.value);
      else if (attr.prefix === "xmlns") (own ??= new Map(inherited)).set(attr.local, attr.value);
    }
    if (own) scope = own;
    node.scope = scope;
    node.nsUri = scope.get(node.prefix) ?? null;
    resolveNamespaces(node.children, scope);
  }
}

function indexSiblings(nodes: XmlNode[]): void {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.type !== "element") continue;
    const n = (counts.get(node.qname) ?? 0) + 1;
    counts.set(node.qname, n);
    node.sameNameIndex = n;
    indexSiblings(node.children);
  }
}

/* ========================================================================== *
 * Source locations
 * ========================================================================== */

/**
 * Line starts, for turning absolute offsets into the UI's `Region` geometry.
 * 1-based line, 0-based inclusive `startCol`, 0-based EXCLUSIVE `endCol`.
 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * A span spanning several lines cannot be expressed in the UI's single-line geometry, so
 * `endCol` then points at the end of the START line and the exact truth is in
 * `offset`/`endOffset`. Nothing is lost: both are always set.
 */
function makeLoc(text: string, starts: number[], start: number, end: number): SourceLocation {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  const li = lineOf(starts, s);
  const lineStart = starts[li];
  const nextStart = li + 1 < starts.length ? starts[li + 1] : text.length;
  let lineEnd = nextStart;
  if (lineEnd > lineStart && text[lineEnd - 1] === "\n") lineEnd--;
  if (lineEnd > lineStart && text[lineEnd - 1] === "\r") lineEnd--;
  const sameLine = e <= lineEnd;
  return {
    line: li + 1,
    startCol: s - lineStart,
    endCol: (sameLine ? e : lineEnd) - lineStart,
    offset: s,
    endOffset: e,
  };
}

/* ========================================================================== *
 * XPath subset used by the compiled CDA locators
 * ========================================================================== */

interface XStep {
  axis: "child" | "descendant";
  qname: string;
  prefix: string;
  local: string;
  /** 1-based position among same-named siblings, from a `[n]` predicate. */
  index?: number;
  /** OID from a `[templateId='…']` or `[templateId/@root='…']` predicate. */
  templateId?: string;
  /** From an `[@attr='value']` predicate. */
  attr?: { name: string; value: string };
}

interface XPathShape {
  absolute: boolean;
  steps: XStep[];
}

const CURLY = /[‘’“”]/g;

/** Split a path on `/` while respecting `[...]`. */
function splitSteps(path: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === "[") depth++;
    else if (c === "]") depth--;
    if (c === "/" && depth === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out;
}

/**
 * Parse the XPath subset the compiled CDA locators actually use. Returns `null` for
 * anything outside it — the caller then leaves the node unresolved rather than guessing.
 *
 * Supported: `/abs/path`, `./rel/path`, `.//descendant`, prefixed names, and the
 * predicates `[n]`, `[templateId='OID']`, `[templateId/@root='OID']`, `[@attr='value']`.
 * A cardinality decoration such as `[1..*]` is stripped: it is spec prose, not a filter.
 */
export function parseCdaXPath(path: string): XPathShape[] {
  const alternatives = path.split("|").map((p) => p.trim()).filter(Boolean);
  const shapes: XPathShape[] = [];
  for (const alt of alternatives) {
    const shape = parseOneXPath(alt);
    if (shape) shapes.push(shape);
  }
  return shapes;
}

function parseOneXPath(path: string): XPathShape | null {
  let rest = path.trim().replace(CURLY, (c) => (c === "‘" || c === "’" ? "'" : '"'));
  if (!rest) return null;
  let absolute = false;
  let leadingDescendant = false;
  if (rest.startsWith(".//")) {
    rest = rest.slice(3);
    leadingDescendant = true;
  } else if (rest.startsWith("./")) {
    rest = rest.slice(2);
  } else if (rest.startsWith("//")) {
    rest = rest.slice(2);
    absolute = true;
    leadingDescendant = true;
  } else if (rest.startsWith("/")) {
    rest = rest.slice(1);
    absolute = true;
  } else if (/^[A-Za-z_]/.test(rest)) {
    // A bare name such as `addr`. Treat as a relative child step.
  } else {
    return null;
  }

  const steps: XStep[] = [];
  const raws = splitSteps(rest);
  for (let k = 0; k < raws.length; k++) {
    const raw = raws[k].trim();
    if (!raw || raw === ".") return null;
    const open = raw.indexOf("[");
    const name = (open < 0 ? raw : raw.slice(0, open)).trim();
    if (!/^[A-Za-z_][-\w.]*(:[A-Za-z_][-\w.]*)?$/.test(name)) return null;
    const colon = name.indexOf(":");
    const step: XStep = {
      axis: k === 0 && leadingDescendant ? "descendant" : "child",
      qname: name,
      prefix: colon < 0 ? "" : name.slice(0, colon),
      local: colon < 0 ? name : name.slice(colon + 1),
    };
    if (open >= 0) {
      const body = raw.slice(open);
      for (const m of body.matchAll(/\[([^\]]*)\]/g)) {
        const p = m[1].trim();
        if (!p) continue;
        if (/^\d+$/.test(p)) step.index = Number(p);
        else if (/^\d+\.\.(\d+|\*)$/.test(p)) continue; // cardinality prose, not a filter
        else {
          const tid = /^templateId(?:\/@root)?\s*=\s*['"]([^'"]+)['"]$/.exec(p);
          if (tid) {
            step.templateId = tid[1];
            continue;
          }
          const at = /^@([-\w.:]+)\s*=\s*['"]([^'"]*)['"]$/.exec(p);
          if (at) {
            step.attr = { name: at[1], value: at[2] };
            continue;
          }
          return null; // unsupported predicate — refuse rather than half-match
        }
      }
    }
    steps.push(step);
  }
  return steps.length ? { absolute, steps } : null;
}

/* ========================================================================== *
 * Spec view of the structure
 * ========================================================================== */

/** Fields the repair pass added to CDA members but that `structure.ts` does not declare. */
interface CdaMemberExtras {
  documentOrder?: number;
  /** Extra templateId that flags "no information available" on this section. */
  noInfoFlagTemplateId?: string | null;
  entryConstraintWaived?: boolean;
}

type CdaMember = StructureMember & CdaMemberExtras;

function locatorOf(member: StructureMember): CdaXPathLocator | null {
  const loc = (member as { locator?: unknown }).locator;
  if (loc && typeof loc === "object" && (loc as { kind?: string }).kind === "cdaXPath") {
    return loc as CdaXPathLocator;
  }
  return null;
}

interface StructureView {
  /** Qualified name of the document element, from the header group's locator. */
  documentQName: string;
  documentPath: string;
  headerGroup: StructureGroup | null;
  /** Header members in the normative document order. */
  headerMembers: CdaMember[];
  bodyGroup: StructureGroup | null;
  bodyPath: string | null;
  /** Every section member in the structure, flattened. */
  sections: StructureSection[];
  /** `templateId/@root` -> section member. Includes the NoInfo flag OIDs. */
  sectionByTemplateId: Map<string, StructureSection>;
  /** OIDs that flag "no information available". */
  noInfoFlags: Map<string, StructureSection>;
}

function viewStructure(structure: MessageStructure): StructureView {
  const sections: StructureSection[] = [];
  const groups: StructureGroup[] = [];
  const collect = (members: readonly StructureMember[]) => {
    for (const m of members) {
      if (m.kind === "section") sections.push(m);
      if (m.kind === "group") groups.push(m);
      collect(membersOf(m));
    }
  };
  collect(structure.root.members);

  // The document element is whatever the shortest absolute locator in the structure names.
  let documentPath = "";
  const consider = (p: string | null | undefined) => {
    if (!p || !p.startsWith("/")) return;
    const first = "/" + splitSteps(p.slice(1))[0];
    if (!documentPath || first.length < documentPath.length) documentPath = first;
  };
  for (const g of groups) consider(locatorOf(g)?.path);
  for (const m of structure.root.members) {
    consider(locatorOf(m)?.path);
    for (const c of membersOf(m)) consider(locatorOf(c)?.path);
  }
  if (!documentPath) documentPath = "/ClinicalDocument";
  const documentQName = documentPath.slice(1).replace(/\[.*$/, "");

  const headerGroup =
    groups.find((g) => locatorOf(g)?.path === documentPath && g.members.some((m) => (m as CdaMember).documentOrder !== undefined)) ??
    groups.find((g) => locatorOf(g)?.path === documentPath) ??
    null;
  const headerMembers = (headerGroup?.members ?? [])
    .filter((m): m is CdaMember => locatorOf(m) !== null)
    .slice()
    .sort((a, b) => (a.documentOrder ?? 1e9) - (b.documentOrder ?? 1e9));

  const bodyGroup = groups.find((g) => g.members.some((m) => m.kind === "section")) ?? null;
  const bodyPath = locatorOf(bodyGroup ?? ({} as StructureMember))?.path ?? null;

  const sectionByTemplateId = new Map<string, StructureSection>();
  const noInfoFlags = new Map<string, StructureSection>();
  for (const s of sections) {
    const flag = (s as CdaMember).noInfoFlagTemplateId ?? null;
    for (const oid of s.templateIds ?? []) if (!sectionByTemplateId.has(oid)) sectionByTemplateId.set(oid, s);
    const pred = s.locator?.predicate;
    const fromPredicate = pred ? /['"]?([0-9][0-9.]+)['"]?/.exec(pred)?.[1] : null;
    if (fromPredicate && !sectionByTemplateId.has(fromPredicate)) sectionByTemplateId.set(fromPredicate, s);
    if (flag) {
      noInfoFlags.set(flag, s);
      if (!sectionByTemplateId.has(flag)) sectionByTemplateId.set(flag, s);
    }
  }

  return {
    documentQName,
    documentPath,
    headerGroup,
    headerMembers,
    bodyGroup,
    bodyPath,
    sections,
    sectionByTemplateId,
    noInfoFlags,
  };
}

/* ========================================================================== *
 * Candidate machinery: walking spec paths alongside the document
 * ========================================================================== */

/**
 * A spec path still in play at the current depth. Spec locators are multi-step
 * (`./consumable/manufacturedProduct/manufacturedMaterial/code`), so a candidate advances
 * one step per element and only "lands" when its last step matches.
 */
interface Candidate {
  steps: XStep[];
  /** Index of the next step to match. */
  at: number;
  specNodeId: string | null;
  memberId: string | null;
  label: string;
  /** Children to activate once this candidate lands. */
  children: readonly SpecNode[] | readonly StructureMember[] | null;
  /** Fixed attribute values the spec pins, used to disambiguate same-named siblings. */
  fixedAttrs: { name: string; value: string }[];
  /** templateId OIDs this node declares, for entry-table descent. */
  templateIds: string[];
  isMember: boolean;
}

function fixedAttrsOf(node: SpecNode): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const fv of node.fixedValues ?? []) {
    if (fv.scope === "attribute" && fv.attribute && fv.value) out.push({ name: fv.attribute, value: fv.value });
  }
  return out;
}

function candidatesFromSpecNodes(nodes: readonly SpecNode[]): Candidate[] {
  const out: Candidate[] = [];
  for (const node of nodes) {
    const locator = node.locator;
    if (!locator || locator.kind !== "cdaXPath" || locator.attribute) continue;
    for (const shape of parseCdaXPath(locator.path)) {
      out.push({
        steps: shape.steps,
        at: 0,
        specNodeId: node.id,
        memberId: null,
        label: node.label,
        children: node.children,
        fixedAttrs: fixedAttrsOf(node),
        templateIds: node.templateIds ?? [],
        isMember: false,
      });
    }
  }
  return out;
}

function candidatesFromMembers(members: readonly StructureMember[]): Candidate[] {
  const out: Candidate[] = [];
  for (const member of members) {
    const locator = locatorOf(member);
    if (!locator || locator.attribute) continue;
    const el = member as { fixedValues?: SpecNode["fixedValues"] };
    const fixedAttrs: { name: string; value: string }[] = [];
    for (const fv of el.fixedValues ?? []) {
      if (fv.scope === "attribute" && fv.attribute && fv.value) fixedAttrs.push({ name: fv.attribute, value: fv.value });
    }
    for (const shape of parseCdaXPath(locator.path)) {
      out.push({
        steps: shape.steps,
        at: 0,
        specNodeId: null,
        memberId: member.id,
        label: member.label,
        children: membersOf(member),
        fixedAttrs,
        templateIds: (member as StructureSection).templateIds ?? [],
        isMember: true,
      });
    }
  }
  return out;
}

function attrValue(el: XmlNode, name: string): string | null {
  for (const a of el.attrs) if (a.qname === name) return a.value;
  return null;
}

function templateIdRoots(el: XmlNode): string[] {
  const out: string[] = [];
  for (const c of el.children) {
    if (c.type === "element" && c.local === "templateId") {
      const root = attrValue(c, "root");
      if (root) out.push(root);
    }
  }
  return out;
}

function nameMatches(step: XStep, el: XmlNode, defaultUri: string | null): boolean {
  if (step.qname === el.qname) return true;
  if (step.local !== el.local) return false;
  // Prefix aliasing: the spec writes a prefix, the message may bind a different one to the
  // same URI. Accept only when the URIs actually agree.
  const wanted = step.prefix === "" ? defaultUri : el.scope.get(step.prefix) ?? null;
  return wanted !== null && wanted === el.nsUri;
}

function stepMatches(step: XStep, el: XmlNode, defaultUri: string | null): boolean {
  if (!nameMatches(step, el, defaultUri)) return false;
  if (step.index !== undefined && step.index !== el.sameNameIndex) return false;
  if (step.templateId !== undefined && !templateIdRoots(el).includes(step.templateId)) return false;
  if (step.attr && attrValue(el, step.attr.name) !== step.attr.value) return false;
  return true;
}

/** How well a landed candidate's pinned attributes agree with the element. */
function fixedAttrScore(candidate: Candidate, el: XmlNode): number {
  if (!candidate.fixedAttrs.length) return 0;
  let score = 0;
  for (const fa of candidate.fixedAttrs) {
    const actual = attrValue(el, fa.name);
    if (actual === null) continue;
    score += actual === fa.value ? 1 : -1;
  }
  return score;
}

/* ========================================================================== *
 * Tree building
 * ========================================================================== */

interface BuildContext {
  text: string;
  starts: number[];
  diagnostics: Diagnostic[];
  unknown: UnknownElement[];
  view: StructureView;
  spec: CdaSpecContext;
  unknownDepth: "enumerated" | "all";
  defaultUri: string | null;
  /** templateId OID -> the SpecNode that heads its content-module field table. */
  entryTables: Map<string, SpecNode>;
  unmappedElements: number;
  ambiguous: number;
}

function buildEntryTableIndex(fields: FieldBundle | undefined): Map<string, SpecNode> {
  const index = new Map<string, SpecNode>();
  if (!fields) return index;
  for (const page of Object.values(fields.pages ?? {})) {
    for (const table of page.tables ?? []) {
      for (const root of table.nodes ?? []) {
        const oids = new Set<string>(root.templateIds ?? []);
        for (const child of root.children ?? []) {
          const path = child.locator && child.locator.kind === "cdaXPath" ? child.locator.path : "";
          if (!/templateId/.test(path)) continue;
          for (const fv of child.fixedValues ?? []) {
            if (fv.attribute === "root" && fv.value && /^[0-9][0-9.]+$/.test(fv.value)) oids.add(fv.value);
          }
        }
        for (const oid of oids) if (!index.has(oid)) index.set(oid, root);
      }
    }
  }
  return index;
}

function diag(ctx: BuildContext, severity: Severity, code: string, message: string, loc: SourceLocation | null, nodeId?: string) {
  ctx.diagnostics.push({ severity, code, message, loc, nodeId: nodeId ?? null });
}

function stepName(path: string): string {
  const steps = splitSteps(path);
  const last = steps[steps.length - 1] ?? "";
  return last.replace(/\[.*$/, "");
}

function childPath(parentPath: string, el: XmlNode): string {
  const base = parentPath === "/" ? "" : parentPath;
  return el.sameNameIndex > 1 ? `${base}/${el.qname}[${el.sameNameIndex}]` : `${base}/${el.qname}`;
}

function makeElementNode(ctx: BuildContext, el: XmlNode, id: string, path: string): TreeNode {
  return {
    id,
    kind: "element",
    label: el.qname,
    locator: { kind: "cdaXPath", path },
    specNodeId: null,
    memberId: null,
    occurrence: el.sameNameIndex - 1,
    value: null,
    raw: ctx.text.slice(el.start, el.end),
    present: true,
    loc: makeLoc(ctx.text, ctx.starts, el.start, el.end),
    children: [],
  };
}

function makeAttrNode(ctx: BuildContext, attr: XmlAttr, ownerId: string, ownerPath: string, occurrence: number): TreeNode {
  const valueStart = attr.valueStart ?? attr.end;
  const valueEnd = attr.valueEnd ?? attr.end;
  return {
    id: `${ownerId}/@${attr.qname}`,
    kind: "attribute",
    label: attr.qname,
    locator: { kind: "cdaXPath", path: ownerPath, attribute: attr.qname },
    specNodeId: null,
    memberId: null,
    occurrence,
    value: attr.value,
    raw: attr.raw,
    present: true,
    // Highlight the VALUE, which is what a finding is about; the whole `name="value"` span
    // is recoverable from `raw`.
    loc: makeLoc(ctx.text, ctx.starts, valueStart, valueEnd),
    children: [],
  };
}

function lexicalLabel(node: XmlNode): string {
  switch (node.type) {
    case "comment":
      return CDA_COMMENT;
    case "cdata":
      return CDA_CDATA;
    case "pi":
      return CDA_PI;
    case "decl":
      return CDA_DECL;
    case "doctype":
      return CDA_DOCTYPE;
    case "stray":
      return CDA_STRAY;
    default:
      return CDA_TEXT;
  }
}

function makeLexicalNode(ctx: BuildContext, node: XmlNode, id: string, parentPath: string): TreeNode {
  const raw = ctx.text.slice(node.start, node.end);
  return {
    id,
    kind: "text",
    label: lexicalLabel(node),
    locator: { kind: "cdaXPath", path: parentPath },
    specNodeId: null,
    memberId: null,
    occurrence: 0,
    value: node.type === "text" || node.type === "cdata" || node.type === "comment" ? node.text : raw,
    raw,
    present: true,
    loc: makeLoc(ctx.text, ctx.starts, node.start, node.end),
    children: [],
  };
}

/** The candidate that landed on `el`, plus what to hand to `el`'s children when none did. */
interface Advance {
  candidate: Candidate | null;
  carried: Candidate[];
}

function advance(ctx: BuildContext, pending: readonly Candidate[], el: XmlNode): Advance {
  const landedAll: Candidate[] = [];
  const carried: Candidate[] = [];
  for (const c of pending) {
    const step = c.steps[c.at];
    if (!step) continue;
    const hit = stepMatches(step, el, ctx.defaultUri);
    if (hit) {
      if (c.at + 1 === c.steps.length) landedAll.push(c);
      else carried.push({ ...c, at: c.at + 1 });
    }
    if (step.axis === "descendant") carried.push(c);
  }
  if (landedAll.length === 0) return { candidate: null, carried };
  if (landedAll.length === 1) return { candidate: landedAll[0], carried };

  // Several spec rows claim the same element. Prefer the one whose pinned attribute values
  // actually match (this is what separates the four `templateId[n]` rows of a section, and
  // what makes the NoInfo flag templateId resolve to its own row rather than to position 4).
  let best: Candidate[] = [];
  let bestScore = -Infinity;
  for (const c of landedAll) {
    const score = fixedAttrScore(c, el);
    if (score > bestScore) {
      bestScore = score;
      best = [c];
    } else if (score === bestScore) best.push(c);
  }
  if (best.length === 1) return { candidate: best[0], carried };
  const positional = best.filter((c) => c.steps[c.steps.length - 1].index !== undefined);
  if (positional.length === 1) return { candidate: positional[0], carried };
  ctx.ambiguous++;
  return { candidate: null, carried };
}

function buildElement(
  ctx: BuildContext,
  el: XmlNode,
  parentId: string,
  parentPath: string,
  pending: readonly Candidate[],
  enumerated: { scope: UnknownElement["scope"]; expected: string[] } | null,
): TreeNode {
  const path = childPath(parentPath, el);
  const id = `${parentId}/${el.qname}[${el.sameNameIndex - 1}]`;
  const node = makeElementNode(ctx, el, id, path);

  // Namespace declarations that rebind a known prefix are worth surfacing.
  for (const attr of el.attrs) {
    if (attr.qname !== "xmlns" && attr.prefix !== "xmlns") continue;
    const prefix = attr.qname === "xmlns" ? "" : attr.local;
    const rule = (ctx.spec.namespaces ?? []).find((n) => n.prefix === prefix);
    if (rule && attr.value && rule.uri !== attr.value) {
      diag(
        ctx,
        "warn",
        "cda/namespace-mismatch",
        `Prefix "${prefix || "(default)"}" is bound to ${attr.value}; the spec binds it to ${rule.uri}` +
          (rule.pageId ? ` (page ${rule.pageId})` : " (sample-derived binding — not in the published spec)") +
          ".",
        makeLoc(ctx.text, ctx.starts, attr.start, attr.end),
        id,
      );
    }
  }

  let occ = 0;
  for (const attr of el.attrs) node.children.push(makeAttrNode(ctx, attr, id, path, occ++));

  // --- resolve this element against the spec ---------------------------------------
  // `enumerated` describes what may appear at THIS element's position among its parent's
  // children. It never propagates downwards on its own: a child's enumerative context is
  // whatever the landed spec node enumerates, and nothing when the spec enumerates nothing.
  const { candidate, carried } = advance(ctx, pending, el);
  let childCandidates: Candidate[] = carried;
  let childEnumerated: { scope: UnknownElement["scope"]; expected: string[] } | null = null;

  if (candidate) {
    node.specNodeId = candidate.specNodeId;
    node.memberId = candidate.memberId;
    if (candidate.label) node.label = candidate.label;
    const kids = candidate.children ?? [];
    childCandidates = candidate.isMember
      ? candidatesFromMembers(kids as readonly StructureMember[])
      : candidatesFromSpecNodes(kids as readonly SpecNode[]);

    // Follow the one machine-readable link the spec offers below a section: the templateId.
    if (childCandidates.length === 0) {
      const oids = [...new Set([...candidate.templateIds, ...templateIdRoots(el)])];
      for (const oid of oids) {
        const table = ctx.entryTables.get(oid);
        if (!table) continue;
        childCandidates = candidatesFromSpecNodes(table.children ?? []);
        if (childCandidates.length) {
          childEnumerated = { scope: "entry-child", expected: expectedNames(table.children ?? []) };
          break;
        }
      }
    } else if (candidate.isMember && kids.length) {
      childEnumerated = { scope: "section-child", expected: expectedNamesOfMembers(kids as readonly StructureMember[]) };
    }
  } else {
    ctx.unmappedElements++;
    if (enumerated) {
      ctx.unknown.push({
        nodeId: id,
        name: el.qname,
        parentPath,
        locator: { kind: "cdaXPath", path },
        loc: node.loc as SourceLocation,
        scope: enumerated.scope,
        reason:
          `The compiled spec enumerates what may appear at ${parentPath || "/"} and <${el.qname}> is not among ` +
          `them. This is a finding to show, not an error: the element is parsed and kept.`,
        expected: enumerated.expected,
      });
    } else if (ctx.unknownDepth === "all") {
      ctx.unknown.push({
        nodeId: id,
        name: el.qname,
        parentPath,
        locator: { kind: "cdaXPath", path },
        loc: node.loc as SourceLocation,
        scope: "unmapped",
        reason:
          "The compiled spec does not describe this position at all, so no conformance claim can be made about " +
          "this element. It is parsed and kept; nothing is asserted.",
        expected: [],
      });
    }
  }

  // --- section handling: identity is templateId/@root, never position or title -------
  const roots = templateIdRoots(el);
  if (el.local === "section" && ctx.view.sections.length) {
    const section = roots.map((r) => ctx.view.sectionByTemplateId.get(r)).find(Boolean) ?? null;
    if (section) {
      node.memberId = section.id;
      node.label = section.label || node.label;
      const tables = collectTables(ctx, section);
      const kids = tables.flatMap((t) => t.nodes.flatMap((n) => n.children ?? []));
      if (kids.length) {
        childCandidates = candidatesFromSpecNodes(kids);
        childEnumerated = { scope: "section-child", expected: expectedNames(kids) };
      } else if (membersOf(section).length) {
        childCandidates = candidatesFromMembers(membersOf(section));
        childEnumerated = null;
      }
      const flag = roots.find((r) => {
        const owner = ctx.view.noInfoFlags.get(r);
        return owner !== undefined && owner.id === section.id;
      });
      if (flag) {
        diag(
          ctx,
          "info",
          CDA_NOINFO_DIAGNOSTIC,
          `Section "${section.label}" carries the "no information available" flag templateId ${flag}. ` +
            "NPHIES flags an empty section this way, NOT with @nullFlavor; the section stays required and only " +
            "its <entry> requirement is waived.",
          node.loc,
          id,
        );
      }
    } else if (roots.length) {
      ctx.unknown.push({
        nodeId: id,
        name: el.qname,
        parentPath,
        locator: { kind: "cdaXPath", path },
        loc: node.loc as SourceLocation,
        scope: "section",
        reason:
          `No section in this message structure declares templateId/@root ${roots.join(" or ")}. Section identity ` +
          "is by templateId, so this section belongs to no position the spec defines for this document type.",
        expected: [...ctx.view.sectionByTemplateId.keys()],
      });
    } else {
      diag(
        ctx,
        "error",
        "cda/section-without-templateid",
        "This <section> carries no templateId/@root, so it cannot be identified. Section identity is by " +
          "templateId, never by position or title.",
        node.loc,
        id,
      );
    }
  }

  // --- children ---------------------------------------------------------------------
  let lex = 0;
  for (const child of el.children) {
    if (child.type === "element") {
      node.children.push(buildElement(ctx, child, id, path, childCandidates, childEnumerated));
    } else {
      node.children.push(makeLexicalNode(ctx, child, `${id}/${lexicalLabel(child)}[${lex++}]`, path));
    }
  }
  return node;
}

function expectedNames(nodes: readonly SpecNode[]): string[] {
  const out = new Set<string>();
  for (const n of nodes) {
    if (n.locator && n.locator.kind === "cdaXPath" && !n.locator.attribute) {
      for (const shape of parseCdaXPath(n.locator.path)) {
        const first = shape.steps[0];
        if (first) out.add(first.qname);
      }
    }
  }
  return [...out];
}

function expectedNamesOfMembers(members: readonly StructureMember[]): string[] {
  const out = new Set<string>();
  for (const m of members) {
    const loc = locatorOf(m);
    if (!loc || loc.attribute) continue;
    for (const shape of parseCdaXPath(loc.path)) {
      const first = shape.steps[0];
      if (first) out.add(first.qname);
    }
  }
  return [...out];
}

function collectTables(ctx: BuildContext, member: StructureMember): FieldTable[] {
  const out: FieldTable[] = [];
  const tables = ctx.spec.tables;
  if (!tables) return out;
  for (const ref of member.specRefs ?? []) {
    const table = tables.get(ref.ref);
    if (table) out.push(table);
  }
  return out;
}

/* ========================================================================== *
 * Header order
 * ========================================================================== */

function checkHeaderOrder(ctx: BuildContext, documentNode: TreeNode): void {
  const order = new Map<string, number>();
  for (const m of ctx.view.headerMembers) {
    const dOrder = m.documentOrder;
    if (dOrder !== undefined) order.set(m.id, dOrder);
  }
  if (order.size === 0) return;
  let previous = 0;
  let previousLabel = "";
  for (const child of documentNode.children) {
    if (child.kind !== "element" || !child.memberId) continue;
    const pos = order.get(child.memberId);
    if (pos === undefined) continue;
    if (pos < previous) {
      diag(
        ctx,
        "error",
        "cda/header-order",
        `<${stepName(((child.locator as CdaXPathLocator | null)?.path) ?? child.label)}> appears after <${previousLabel}>, ` +
          `but the CDA header element order is normative: position ${pos} must precede position ${previous}.`,
        child.loc,
        child.id,
      );
    } else {
      previous = pos;
      previousLabel = stepName(((child.locator as CdaXPathLocator | null)?.path) ?? child.label);
    }
  }
}

/* ========================================================================== *
 * Cross-check against fast-xml-parser
 * ========================================================================== */

function crossCheckWithFxp(ctx: BuildContext, scanned: ScanResult): void {
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      preserveOrder: true,
      trimValues: false,
      parseTagValue: false,
      parseAttributeValue: false,
      alwaysCreateTextNode: true,
      commentPropName: "#comment",
      removeNSPrefix: false,
    });
    const parsed = parser.parse(ctx.text);
    const count = countFxpElements(parsed);
    if (count !== scanned.elementCount) {
      diag(
        ctx,
        "warn",
        "cda/cross-check-mismatch",
        `Independent cross-check disagrees: this parser found ${scanned.elementCount} elements, fast-xml-parser ` +
          `found ${count}. Treat the structural reading of this message as uncertain.`,
        null,
      );
    }
  } catch (err) {
    diag(
      ctx,
      "warn",
      "cda/cross-check-failed",
      `fast-xml-parser could not parse this message (${err instanceof Error ? err.message : String(err)}), ` +
        "so the independent cross-check of the scan is unavailable.",
      null,
    );
  }
}

function countFxpElements(value: unknown): number {
  if (Array.isArray(value)) {
    let n = 0;
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
        if (key === ":@" || key === "#text" || key === "#comment") continue;
        n += 1 + countFxpElements(child);
      }
    }
    return n;
  }
  return 0;
}

/* ========================================================================== *
 * parseCda
 * ========================================================================== */

/**
 * Parse a CDA R2 document against a compiled {@link MessageStructure}.
 *
 * Never throws. On malformed input it returns whatever it could read plus diagnostics, and
 * the tree still round-trips: every byte of `text` lives in some node's `raw`.
 */
export function parseCda(text: string, structure: MessageStructure, opts: ParseOptions = {}): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const unknown: UnknownElement[] = [];
  const source = typeof text === "string" ? text : "";
  const maxChars = opts.maxChars ?? 32 * 1024 * 1024;

  const emptyTree = (): StructureTree => ({
    structureId: structure?.id ?? null,
    useCaseId: structure?.useCaseId ?? null,
    family: "cda",
    encoding: "cda-xml",
    text: source,
    root: {
      id: "cda",
      kind: "message",
      label: structure?.title ?? "CDA document",
      locator: null,
      specNodeId: null,
      memberId: null,
      occurrence: 0,
      value: null,
      raw: source,
      present: true,
      loc: source ? { line: 1, startCol: 0, endCol: 0, offset: 0, endOffset: source.length } : null,
      children: [],
    },
    diagnostics,
  });

  try {
    if (!source) {
      diagnostics.push({ severity: "error", code: "cda/empty", message: "The message is empty.", loc: null, nodeId: null });
      return { tree: emptyTree(), diagnostics, unknown };
    }
    if (source.length > maxChars) {
      diagnostics.push({
        severity: "error",
        code: "cda/too-large",
        message: `The message is ${source.length} characters, over the ${maxChars}-character parse limit.`,
        loc: null,
        nodeId: null,
      });
      return { tree: emptyTree(), diagnostics, unknown };
    }

    const starts = lineStarts(source);
    const scanned = scanXml(source);
    for (const d of scanned.diagnostics) {
      diagnostics.push({
        severity: d.severity,
        code: d.code,
        message: d.message,
        loc: makeLoc(source, starts, d.offset, Math.min(d.offset + 1, source.length)),
        nodeId: null,
      });
    }

    const view = viewStructure(structure);
    const ctx: BuildContext = {
      text: source,
      starts,
      diagnostics,
      unknown,
      view,
      spec: opts.spec ?? {},
      unknownDepth: opts.unknownDepth ?? "enumerated",
      defaultUri: scanned.documentElement?.scope.get("") ?? null,
      entryTables: buildEntryTableIndex(opts.spec?.fields),
      unmappedElements: 0,
      ambiguous: 0,
    };

    const tree = emptyTree();
    tree.root.raw = null;

    if (!scanned.documentElement) {
      diagnostics.push({
        severity: "error",
        code: "cda/not-xml",
        message:
          "No XML element was found. This does not look like a CDA document — check that the right message was pasted.",
        loc: makeLoc(source, starts, 0, Math.min(80, source.length)),
        nodeId: null,
      });
    }

    let lex = 0;
    for (const node of scanned.nodes) {
      if (node.type === "element") {
        if (node === scanned.documentElement && node.qname !== view.documentQName) {
          diagnostics.push({
            severity: "error",
            code: "cda/unexpected-root",
            message: `The document element is <${node.qname}>; this structure describes <${view.documentQName}>.`,
            loc: makeLoc(source, starts, node.start, node.openEnd),
            nodeId: null,
          });
        }
        const documentNode = buildDocumentElement(ctx, node);
        if (view.headerMembers.length) checkHeaderOrder(ctx, documentNode);
        tree.root.children.push(documentNode);
      } else {
        tree.root.children.push(makeLexicalNode(ctx, node, `cda/${lexicalLabel(node)}[${lex++}]`, ""));
      }
    }

    if (ctx.unmappedElements) {
      diagnostics.push({
        severity: "info",
        code: "cda/unmapped-elements",
        message:
          `${ctx.unmappedElements} element(s) resolved to no compiled spec node. Below a section's direct children ` +
          "the published CDA tables stop, so this is expected depth, not a defect — no conformance claim is made " +
          "about those elements. Pass `unknownDepth: \"all\"` to list them.",
        loc: null,
        nodeId: null,
      });
    }
    if (ctx.ambiguous) {
      diagnostics.push({
        severity: "warn",
        code: "cda/ambiguous-spec-match",
        message:
          `${ctx.ambiguous} element(s) matched more than one spec row and nothing in the spec separates them, so ` +
          "no row was chosen. An acknowledged unknown beats a confidently wrong mapping.",
        loc: null,
        nodeId: null,
      });
    }

    if (opts.crossCheck !== false) crossCheckWithFxp(ctx, scanned);

    tree.diagnostics = diagnostics;
    return { tree, diagnostics, unknown };
  } catch (err) {
    // A parser must never throw: a hospital pasting a broken message is the point of the tool.
    diagnostics.push({
      severity: "error",
      code: "cda/parser-error",
      message: `The parser failed on this message: ${err instanceof Error ? err.message : String(err)}. ` +
        "Partial results are shown; this is a workbench defect, please report the message.",
      loc: null,
      nodeId: null,
    });
    return { tree: emptyTree(), diagnostics, unknown };
  }
}

/**
 * Build the document element.
 *
 * Header member locators are ABSOLUTE (`/ClinicalDocument/realmCode`), so their first step
 * is the document element itself and has to be consumed before the children are matched.
 * That is the only reason this is not just another `buildElement` call.
 */
function buildDocumentElement(ctx: BuildContext, el: XmlNode): TreeNode {
  const path = `/${el.qname}`;
  const id = `cda/${el.qname}`;
  const node = makeElementNode(ctx, el, id, path);
  node.memberId = ctx.view.headerGroup?.id ?? null;

  let occ = 0;
  for (const attr of el.attrs) {
    node.children.push(makeAttrNode(ctx, attr, id, path, occ++));
    if (attr.qname !== "xmlns" && attr.prefix !== "xmlns") continue;
    const prefix = attr.qname === "xmlns" ? "" : attr.local;
    const rule = (ctx.spec.namespaces ?? []).find((n) => n.prefix === prefix);
    if (rule && attr.value && rule.uri !== attr.value) {
      diag(
        ctx,
        "warn",
        "cda/namespace-mismatch",
        `Prefix "${prefix || "(default)"}" is bound to ${attr.value}; the spec binds it to ${rule.uri}` +
          (rule.pageId ? ` (page ${rule.pageId})` : " (sample-derived binding — not in the published spec)") +
          ".",
        makeLoc(ctx.text, ctx.starts, attr.start, attr.end),
        id,
      );
    }
  }

  // Advance every header candidate past the document element itself.
  const pending: Candidate[] = [];
  for (const c of candidatesFromMembers(ctx.view.headerMembers)) {
    const first = c.steps[0];
    if (!first) continue;
    if (c.steps.length > 1 && stepMatches(first, el, ctx.defaultUri)) pending.push({ ...c, at: 1 });
    else if (first.qname !== ctx.view.documentQName) pending.push(c);
  }

  const enumerated = ctx.view.headerMembers.length
    ? {
        scope: "header" as const,
        expected: ctx.view.headerMembers.map((m) => stepName(locatorOf(m)?.path ?? m.label)),
      }
    : null;

  let lex = 0;
  for (const child of el.children) {
    if (child.type === "element") {
      node.children.push(buildElement(ctx, child, id, path, pending, enumerated));
    } else {
      node.children.push(makeLexicalNode(ctx, child, `${id}/${lexicalLabel(child)}[${lex++}]`, path));
    }
  }
  return node;
}
