/**
 * XDS / SOAP parser — message text -> {@link StructureTree}.
 *
 * Covers the five compiled SOAP structures: `xds-iti41`, `xds-iti18-request`,
 * `xds-iti18-response`, `xds-iti43-request`, `xds-iti43-response`. It is FORMAT-level and
 * SPEC-driven: the only thing it knows about a use case is what the supplied
 * {@link MessageStructure} says. There is no per-transaction branching anywhere below.
 *
 * ## Three honesty rules this parser is built around
 *
 * 1. **Never throw.** Hospitals paste half a message, a truncated envelope, a file their
 *    middleware mangled. Every malformed construct produces a {@link Diagnostic} and the
 *    parse continues, so `Check` can still point at the part that IS readable.
 * 2. **Never drop.** Anything in the text that the compiled spec does not describe becomes
 *    an {@link UnknownElement} — a finding, not an error, and never a silent omission.
 *    Namespace declarations, comments, processing instructions and whitespace all stay in
 *    the tree, which is what makes {@link emitXds} an exact inverse.
 * 3. **Never launder provenance.** This is the weakest part of the compiled bundle: only
 *    55.0% of SOAP/XDS identifiers resolve against a rule that did not itself come from
 *    these same golden samples, and for SOAP element paths it is 32.7%. Every node this
 *    parser maps carries an {@link XdsEvidence} record saying which kind of rule matched it,
 *    so a checker cannot accidentally present a sample-derived rule as published NPHIES.
 *
 * ## How matching works
 *
 * An ebRIM metadata attribute is identified by its `classificationScheme` /
 * `identificationScheme` UUID, NOT by element position, so `rim:Classification` and
 * `rim:ExternalIdentifier` are resolved through the compiled scheme map on the structure
 * member ({@link StructureElement.xdsSchemes}), and `rim:Slot` through its `@name`.
 * Every other element is matched by LOCAL NAME against the structure's element tree: the
 * compiled members are written with canonical prefixes (`soap12:`, `wsa:`, `xdsb:`) while
 * the official samples use `soap:`, `addressing:` and a default namespace, so a
 * prefix-sensitive match would reject every real message.
 *
 * ## MTOM / XOP
 *
 * ITI-41 (and ITI-43 responses) carry the document as an `xop:Include` referencing a MIME
 * part. This parser models the REFERENCE — the `xop:Include` element and its `@href` — and
 * records {@link MTOM_LIMITATION} as a diagnostic. It does not assemble multipart MIME, so
 * nothing here can confirm the part exists or that its bytes match `hash` / `size`.
 */

import {
  type Confidence,
  type Derivation,
  type FieldBundle,
  type MessageStructure,
  type Provenance,
  type Severity,
  type SourceLocation,
  type SpecLocator,
  type SpecNode,
  type StructureElement,
  type StructureMember,
  type StructureTree,
  type TreeDiagnostic,
  type TreeNode,
  type XdsSchemeLocator,
  type XdsSchemeRule,
  locatorKey,
  membersOf,
} from "../structure";

/* ========================================================================== *
 * Public result types
 * ========================================================================== */

/**
 * A problem with the TEXT (or with mapping it onto the spec). Conformance findings are the
 * checker's job; these are the parser's. Extends {@link TreeDiagnostic} so the same array
 * can be handed straight to `StructureTree.diagnostics`.
 */
export interface Diagnostic extends TreeDiagnostic {
  /** Instance path the diagnostic is about, when there is one. */
  path?: string | null;
  /** Evidence behind the rule that produced it, when a compiled rule was involved. */
  evidence?: XdsEvidence | null;
  /** Verbatim source fragment, so the UI can quote the message back. */
  excerpt?: string | null;
}

/**
 * An element (or attribute) present in the message that the compiled spec does not
 * describe. NOT an error: the spec is incomplete in exactly this area, so an unknown
 * element is as likely to be a gap in the bundle as a mistake by the hospital. Only the
 * TOP-MOST unmapped element of a subtree is reported — `descendants` says how much hangs
 * off it — otherwise one stray wrapper would produce a hundred findings.
 */
export interface UnknownElement {
  /** Id of the {@link TreeNode} in the parsed tree. */
  nodeId: string;
  /** Instance path, e.g. `Envelope/Body[0]/AdhocQueryRequest[0]/Extra[0]`. */
  path: string;
  kind: "element" | "attribute";
  /** Name as written on the wire, prefix included. */
  qname: string;
  localName: string;
  /** The namespace prefix as written, `null` when unprefixed. */
  prefix: string | null;
  loc: SourceLocation;
  /** Verbatim start tag / attribute text. */
  excerpt: string;
  /** Id of the structure member whose children were searched. `null` at the document root. */
  parentMemberId: string | null;
  /** Local names the spec DOES allow at this position — the useful half of the finding. */
  expectedSiblings: string[];
  /** Number of nodes below this one that are therefore also unmapped. */
  descendants: number;
  reason: string;
  severity: Severity;
}

export interface ParseOptions {
  /**
   * Compiled {@link SpecNode}s, keyed by node id — e.g. the map `resolveUseCase()` returns.
   * Used to attach the governing spec node to slots and ebRIM attributes.
   */
  specNodes?: ReadonlyMap<string, SpecNode>;
  /**
   * The whole `src/spec/fields/xds.json` bundle. Richer than `specNodes` for XDS, because
   * the SOAP structures cite no field tables at all: the slot vocabulary lives in 24
   * per-document-type tables which `resolveUseCase()` does not pull in. Supply this and
   * `rim:Slot/@name`, `@id`-style attributes and scheme UUIDs resolve to real spec rows.
   */
  xdsFields?: FieldBundle;
  /** Path/label of the message being parsed, echoed into diagnostics. */
  sourceName?: string;
  /** Stop recording diagnostics past this many (the parse still completes). Default 500. */
  maxDiagnostics?: number;
  /**
   * Also report attributes the spec does not describe as {@link UnknownElement}s.
   * Default `false`: the compiled bundle describes only a handful of ebRIM attributes, so
   * turning this on reports mostly bundle gaps. Unknown attributes are never dropped from
   * the tree either way.
   */
  reportUnknownAttributes?: boolean;
}

export interface ParseResult {
  tree: StructureTree;
  diagnostics: Diagnostic[];
  unknown: UnknownElement[];
}

/* ========================================================================== *
 * Evidence — why a node was mapped, and how far to trust it
 * ========================================================================== */

/**
 * The provenance of the RULE that mapped one instance node, carried on the node itself so
 * that no finding downstream can be produced without it.
 *
 * `independentOfSamples` is the number that matters: it is true only when the compiled rule
 * cites a Confluence page id. A rule whose provenance names only a golden sample resolved
 * this message against a rule read off that same family of messages — which is not
 * confirmation of anything. The UI must be able to say so.
 */
export interface XdsEvidence {
  /** How the node was matched: by local name, by slot name, by scheme UUID, or not at all. */
  via: "element-name" | "element-name-case-insensitive" | "slot-name" | "scheme-uuid" | "attribute-name" | "unmapped";
  derivation: Derivation | null;
  confidence: Confidence | null;
  verifiedAgainstSample: boolean | null;
  confidenceReason: string | null;
  provenance: Provenance | null;
  /** TRUE only when `provenance.pageId` is set — i.e. a published page states the rule. */
  independentOfSamples: boolean;
  /**
   * Set when `derivation` claims Confluence but the stored provenance cites only a sample.
   * The compiled XDS scheme rules do this: `derivation: "confluence+sample"` with
   * `provenance.pageId: null`. We report the disagreement rather than believing either side.
   */
  derivationDisagreesWithProvenance: boolean;
  /** Golden samples the compiled rule cites, relative to `spec-source/`. */
  samples: string[];
  /** Spec node ids that could govern this node when more than one table defines it. */
  specNodeCandidates?: string[];
  /** One line, ready to render beside a finding. Never omitted for a mapped node. */
  note: string;
}

/**
 * Verbatim from the compiled-spec gate report
 * (`spec-build/gate-report.json` → `independence.headline`). Quote it, do not paraphrase it.
 */
export const XDS_INDEPENDENCE_HEADLINE =
  "SOAP/XDS resolves 100.0% overall, but only 55.0% against rules that did NOT come from " +
  "these same samples. The second number is the honest one.";

/** Per-element-kind independence, same source (`independence.byElementKind`). */
export const XDS_INDEPENDENCE = {
  soapPath: { found: 648, independent: 212, share: 0.3272 },
  xdsSlot: { found: 196, independent: 172, share: 0.8776 },
  xdsClassificationScheme: { found: 118, independent: 118, share: 1 },
  xdsIdentificationScheme: { found: 59, independent: 59, share: 1 },
  overall: { found: 1023, independent: 563, share: 0.5503 },
} as const;

/** What this parser can and cannot say about an MTOM/XOP attachment. */
export const MTOM_LIMITATION =
  "The document payload is an MTOM/XOP attachment referenced by xop:Include/@href (a cid: " +
  "URI). This workbench models the reference only — it does not assemble MIME multipart, so " +
  "it cannot confirm the part exists, nor check DocumentEntry hash/size against its bytes.";

const NOTE_SAMPLE_DERIVED =
  "This rule was read off the official golden samples; no published NPHIES page states it. " +
  "Resolving a message against it is not independent confirmation.";
const NOTE_CONFLUENCE = "A published NPHIES page states this rule; the quote is in provenance.";
const NOTE_UNSOURCED =
  "The compiled bundle carries no provenance for this rule. Treat any finding from it as unverified.";

/* ========================================================================== *
 * Syntax capture — what makes parse and emit exact inverses
 * ========================================================================== */

/** A source span that also remembers which line it ended on. */
export interface XdsSourceLocation extends SourceLocation {
  /** 1-based line the span ends on. Equal to `line` for a single-line span. */
  endLine?: number;
}

/** Exact XML syntax of one attribute, so it can be written back character for character. */
export interface XmlAttrSyntax {
  /** Whitespace between the previous token and this attribute name. */
  lead: string;
  qname: string;
  prefix: string | null;
  local: string;
  /** `=` with any surrounding whitespace. `null` for a valueless (malformed) attribute. */
  eq: string | null;
  /** `"` or `'`, or `""` when the value was unquoted (malformed). */
  quote: string;
  /** Value exactly as written, entities NOT resolved. */
  rawValue: string;
  /**
   * False when the opening quote was never closed (a truncated message). The emitter then
   * writes no closing quote either, so even a truncated paste round-trips unchanged.
   */
  closed: boolean;
  /** True for `xmlns` / `xmlns:*`. Namespace machinery, never a spec finding. */
  isNamespace: boolean;
}

/**
 * Exact XML syntax of one element. Present on every node a parse produced; absent on nodes
 * a HIS-extract built, which {@link emitXds} then serialises canonically.
 */
export interface XmlElementSyntax {
  node: "element";
  /** Name as written, prefix included. */
  qname: string;
  prefix: string | null;
  local: string;
  selfClosing: boolean;
  /** False when the start tag ran off the end of the text: no `>` was ever written. */
  startTagClosed: boolean;
  /** Text between the last attribute and `>` / `/>`, e.g. the space in `<rim:AdhocQuery id="x" >`. */
  beforeGt: string;
  /** Exact end tag, e.g. `</rim:Slot>`. `null` when the element was never closed. */
  endTag: string | null;
  /** Whole-element span, start tag through end tag. */
  span: XdsSourceLocation;
}

/** Exact syntax of a non-element leaf: character data, a comment, a PI, CDATA, a doctype. */
export interface XmlLeafSyntax {
  node: "text" | "comment" | "pi" | "cdata" | "doctype" | "stray";
  raw: string;
}

export type XmlSyntax = XmlElementSyntax | XmlLeafSyntax | XmlAttrSyntax;

/**
 * A {@link TreeNode} with the two XDS-specific side-cars. Extra properties only — anything
 * that consumes a plain `TreeNode` keeps working, and {@link emitXds} reproduces the input
 * byte for byte when they are present.
 */
export interface XdsTreeNode extends TreeNode {
  xml?: XmlSyntax;
  evidence?: XdsEvidence;
  /** The structure member this node was matched to, when one matched. */
  member?: StructureMember | null;
  children: XdsTreeNode[];
}

/** Narrow a {@link TreeNode} to one carrying captured XML syntax. */
export function xmlSyntaxOf(node: TreeNode): XmlSyntax | null {
  return (node as XdsTreeNode).xml ?? null;
}

/** The evidence behind a node's mapping, when the parser established one. */
export function xdsEvidenceOf(node: TreeNode): XdsEvidence | null {
  return (node as XdsTreeNode).evidence ?? null;
}

/** True when the node is an XML element (rather than an attribute, text or the document). */
export function isElementNode(node: TreeNode): boolean {
  const syntax = xmlSyntaxOf(node);
  if (syntax) return "node" in syntax && syntax.node === "element";
  return node.kind !== "attribute" && node.kind !== "text" && node.kind !== "message";
}

/* ========================================================================== *
 * Low-level XML scan — defensive, position-exact, never throws
 * ========================================================================== */

interface RawAttr {
  lead: string;
  qname: string;
  prefix: string | null;
  local: string;
  eq: string | null;
  quote: string;
  rawValue: string;
  closed: boolean;
  value: string;
  start: number;
  end: number;
}

interface RawElement {
  kind: "element";
  qname: string;
  prefix: string | null;
  local: string;
  attrs: RawAttr[];
  selfClosing: boolean;
  startTagClosed: boolean;
  beforeGt: string;
  start: number;
  startTagEnd: number;
  end: number;
  endTag: string | null;
  children: RawNode[];
}

interface RawLeaf {
  kind: "text" | "comment" | "pi" | "cdata" | "doctype" | "stray";
  raw: string;
  start: number;
  end: number;
}

type RawNode = RawElement | RawLeaf;

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9_.:]/;
const WS = /\s/;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Resolve XML entity references. Unknown references are LEFT AS WRITTEN and reported. */
function decodeEntities(raw: string, onUnknown?: (entity: string, offsetInRaw: number) => void): string {
  if (!raw.includes("&")) return raw;
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf("&", i);
    if (amp < 0) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, amp);
    const semi = raw.indexOf(";", amp + 1);
    if (semi < 0 || semi - amp > 32) {
      out += "&";
      i = amp + 1;
      continue;
    }
    const body = raw.slice(amp + 1, semi);
    let decoded: string | null = null;
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) decoded = String.fromCodePoint(code);
    } else if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) decoded = String.fromCodePoint(code);
    } else if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) {
      decoded = NAMED_ENTITIES[body];
    }
    if (decoded === null) {
      onUnknown?.(raw.slice(amp, semi + 1), amp);
      out += raw.slice(amp, semi + 1);
    } else {
      out += decoded;
    }
    i = semi + 1;
  }
  return out;
}

function splitQName(qname: string): { prefix: string | null; local: string } {
  const colon = qname.indexOf(":");
  if (colon <= 0 || colon === qname.length - 1) return { prefix: null, local: qname };
  return { prefix: qname.slice(0, colon), local: qname.slice(colon + 1) };
}

interface ScanResult {
  nodes: RawNode[];
  problems: { code: string; message: string; start: number; end: number; severity: Severity }[];
}

/**
 * Scan XML into a raw tree with exact offsets. Tolerates: unclosed elements, stray end
 * tags, unquoted attribute values, several document elements, junk before the prolog, and
 * a truncated tail. None of these throw; each becomes a problem record.
 */
function scanXml(text: string): ScanResult {
  const top: RawNode[] = [];
  const stack: RawElement[] = [];
  const problems: ScanResult["problems"] = [];
  const problem = (code: string, message: string, start: number, end: number, severity: Severity = "error") =>
    problems.push({ code, message, start, end, severity });
  const sink = () => (stack.length ? stack[stack.length - 1].children : top);
  const pushLeaf = (kind: RawLeaf["kind"], start: number, end: number) => {
    if (end <= start) return;
    sink().push({ kind, raw: text.slice(start, end), start, end });
  };

  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      pushLeaf("text", i, text.length);
      break;
    }
    if (lt > i) pushLeaf("text", i, lt);

    // ---- comment / CDATA / doctype / PI -------------------------------------
    if (text.startsWith("<!--", lt)) {
      const close = text.indexOf("-->", lt + 4);
      const end = close < 0 ? text.length : close + 3;
      if (close < 0) problem("xml-unterminated-comment", "Comment is never closed with -->.", lt, end);
      pushLeaf("comment", lt, end);
      i = end;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const close = text.indexOf("]]>", lt + 9);
      const end = close < 0 ? text.length : close + 3;
      if (close < 0) problem("xml-unterminated-cdata", "CDATA section is never closed with ]]>.", lt, end);
      pushLeaf("cdata", lt, end);
      i = end;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      let j = lt + 2;
      let depth = 0;
      while (j < text.length) {
        const ch = text[j];
        if (ch === "[") depth++;
        else if (ch === "]") depth--;
        else if (ch === ">" && depth <= 0) break;
        j++;
      }
      const end = j < text.length ? j + 1 : text.length;
      if (j >= text.length) problem("xml-unterminated-declaration", "Declaration is never closed with >.", lt, end);
      pushLeaf("doctype", lt, end);
      i = end;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const close = text.indexOf("?>", lt + 2);
      const end = close < 0 ? text.length : close + 2;
      if (close < 0) problem("xml-unterminated-pi", "Processing instruction is never closed with ?>.", lt, end);
      pushLeaf("pi", lt, end);
      i = end;
      continue;
    }

    // ---- end tag ------------------------------------------------------------
    if (text.startsWith("</", lt)) {
      let j = lt + 2;
      while (j < text.length && NAME_CHAR.test(text[j])) j++;
      const qname = text.slice(lt + 2, j);
      while (j < text.length && WS.test(text[j])) j++;
      const gt = text.indexOf(">", j);
      const end = gt < 0 ? text.length : gt + 1;
      if (gt < 0) problem("xml-unterminated-end-tag", `End tag </${qname} is never closed with >.`, lt, end);

      let depth = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].qname === qname) {
          depth = k;
          break;
        }
      }
      if (depth < 0) {
        // Case-insensitive rescue: the two official ITI-18 responses close </soap:envelope>.
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].qname.toLowerCase() === qname.toLowerCase()) {
            depth = k;
            break;
          }
        }
      }
      if (depth < 0) {
        problem(
          "xml-unmatched-end-tag",
          `End tag </${qname}> closes nothing that is open here. Kept verbatim so the text round-trips.`,
          lt,
          end,
        );
        pushLeaf("stray", lt, end);
        i = end;
        continue;
      }
      for (let k = stack.length - 1; k > depth; k--) {
        const orphan = stack[k];
        problem(
          "xml-unclosed-element",
          `<${orphan.qname}> is never closed; </${qname}> closed it implicitly.`,
          orphan.start,
          orphan.startTagEnd,
        );
        orphan.end = lt;
        orphan.endTag = null;
      }
      const closed = stack[depth];
      closed.end = end;
      closed.endTag = text.slice(lt, end);
      stack.length = depth;
      i = end;
      continue;
    }

    // ---- start tag ----------------------------------------------------------
    if (lt + 1 >= text.length || !NAME_START.test(text[lt + 1])) {
      problem("xml-stray-lt", "A `<` here does not begin a tag. Kept verbatim.", lt, lt + 1, "warn");
      pushLeaf("text", lt, lt + 1);
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    while (j < text.length && NAME_CHAR.test(text[j])) j++;
    const qname = text.slice(lt + 1, j);
    const attrs: RawAttr[] = [];
    let selfClosing = false;
    let beforeGt = "";
    let closedTag = false;

    while (j < text.length) {
      // Everything that is not an attribute name, `>` or `/>` is junk. Junk is KEPT in the
      // next attribute's `lead` (and reported) so that even a mangled start tag round-trips.
      const leadStart = j;
      let stop: "gt" | "selfClose" | "name" | "eof" = "eof";
      while (j < text.length) {
        const ch = text[j];
        if (WS.test(ch)) {
          j++;
          continue;
        }
        if (ch === ">") {
          stop = "gt";
          break;
        }
        if (ch === "/" && text[j + 1] === ">") {
          stop = "selfClose";
          break;
        }
        if (NAME_START.test(ch)) {
          stop = "name";
          break;
        }
        problem(
          "xml-junk-in-start-tag",
          `Unexpected "${ch}" inside the <${qname}> start tag. Kept verbatim; nothing was rewritten.`,
          j,
          j + 1,
          "error",
        );
        j++;
      }
      const lead = text.slice(leadStart, j);
      if (stop === "gt") {
        beforeGt = lead;
        j++;
        closedTag = true;
        break;
      }
      if (stop === "selfClose") {
        beforeGt = lead;
        selfClosing = true;
        j += 2;
        closedTag = true;
        break;
      }
      if (stop === "eof") {
        beforeGt = lead;
        break;
      }
      const nameStart = j;
      while (j < text.length && NAME_CHAR.test(text[j])) j++;
      const attrName = text.slice(nameStart, j);
      const eqStart = j;
      while (j < text.length && WS.test(text[j])) j++;
      let eq: string | null = null;
      let quote = "";
      let rawValue = "";
      let valueClosed = true;
      if (text[j] === "=") {
        j++;
        while (j < text.length && WS.test(text[j])) j++;
        eq = text.slice(eqStart, j);
        if (text[j] === '"' || text[j] === "'") {
          quote = text[j];
          const valueStart = ++j;
          const close = text.indexOf(quote, valueStart);
          if (close < 0) {
            problem(
              "xml-unterminated-attribute",
              `Attribute ${attrName} on <${qname}> has no closing ${quote}.`,
              valueStart,
              text.length,
            );
            rawValue = text.slice(valueStart);
            valueClosed = false;
            j = text.length;
          } else {
            rawValue = text.slice(valueStart, close);
            j = close + 1;
          }
        } else {
          const valueStart = j;
          while (j < text.length && !WS.test(text[j]) && text[j] !== ">" && text[j] !== "/") j++;
          rawValue = text.slice(valueStart, j);
          problem(
            "xml-unquoted-attribute",
            `Attribute ${attrName} on <${qname}> has an unquoted value. XML requires quotes.`,
            valueStart,
            j,
          );
        }
      } else {
        j = eqStart;
        problem(
          "xml-valueless-attribute",
          `Attribute ${attrName} on <${qname}> has no value. XML has no boolean attributes.`,
          nameStart,
          nameStart + attrName.length,
        );
      }
      const parts = splitQName(attrName);
      attrs.push({
        lead,
        qname: attrName,
        prefix: parts.prefix,
        local: parts.local,
        eq,
        quote,
        rawValue,
        closed: valueClosed,
        value: decodeEntities(rawValue),
        start: nameStart,
        end: j,
      });
    }

    if (!closedTag) {
      problem("xml-unterminated-start-tag", `<${qname} start tag is never closed with > or />.`, lt, text.length);
    }

    const element: RawElement = {
      kind: "element",
      qname,
      ...splitQName(qname),
      attrs,
      selfClosing,
      startTagClosed: closedTag,
      beforeGt,
      start: lt,
      startTagEnd: j,
      end: selfClosing ? j : j,
      endTag: null,
      children: [],
    };
    sink().push(element);
    if (!selfClosing) stack.push(element);
    i = j;
  }

  while (stack.length) {
    const orphan = stack.pop() as RawElement;
    problem(
      "xml-unclosed-element",
      `<${orphan.qname}> is never closed. The message is truncated or a tag is missing.`,
      orphan.start,
      orphan.startTagEnd,
    );
    orphan.end = text.length;
    orphan.endTag = null;
  }

  return { nodes: top, problems };
}

/* ========================================================================== *
 * Spec-side index — built generically from the MessageStructure
 * ========================================================================== */

/** Local name a structure member addresses, prefix stripped. `null` when none is stated. */
export function memberLocalName(member: StructureMember): string | null {
  const locator = "locator" in member ? member.locator : null;
  let raw: string | null = null;
  if (locator && locator.kind === "cdaXPath") raw = locator.path;
  if (!raw) raw = member.label ?? null;
  if (!raw) return null;
  let name = raw.trim();
  const bracket = name.indexOf("[");
  if (bracket >= 0) name = name.slice(0, bracket);
  const slash = name.lastIndexOf("/");
  if (slash >= 0) name = name.slice(slash + 1);
  const colon = name.lastIndexOf(":");
  if (colon >= 0) name = name.slice(colon + 1);
  name = name.trim();
  return name || null;
}

interface MemberIndex {
  byLocal: Map<string, StructureMember[]>;
  byLower: Map<string, StructureMember[]>;
}

function indexMembers(members: StructureMember[]): MemberIndex {
  const byLocal = new Map<string, StructureMember[]>();
  const byLower = new Map<string, StructureMember[]>();
  for (const member of members) {
    const name = memberLocalName(member);
    if (!name) continue;
    const exact = byLocal.get(name);
    if (exact) exact.push(member);
    else byLocal.set(name, [member]);
    const lower = name.toLowerCase();
    const loose = byLower.get(lower);
    if (loose) loose.push(member);
    else byLower.set(lower, [member]);
  }
  return { byLocal, byLower };
}

/** `xdsSchemes` carries a `metadataName` the repair pass added; it is not on the base type. */
interface XdsSchemeRuleWithName extends XdsSchemeRule {
  metadataName?: {
    /** The QUALIFIED literal the wire carries, e.g. `XDSDocumentEntry.patientId`. */
    value: string;
    bareAttribute: string;
    emitPath: string;
    derivation?: Derivation;
    confidence?: Confidence;
    confidenceReason?: string | null;
    verifiedAgainstSample?: boolean;
    provenance?: Provenance | null;
    samples?: string[];
  } | null;
}

/** Every scheme rule on a member, keyed by lower-cased UUID. */
function schemeIndexOf(member: StructureMember | null): Map<string, XdsSchemeRuleWithName> {
  const out = new Map<string, XdsSchemeRuleWithName>();
  if (!member || member.kind !== "element") return out;
  for (const rule of (member as StructureElement).xdsSchemes ?? []) {
    out.set(rule.locator.uuid.trim().toLowerCase(), rule as XdsSchemeRuleWithName);
  }
  return out;
}

/**
 * The XDS slot / scheme vocabulary, indexed by {@link locatorKey}. Built from whatever the
 * caller supplied — a `specNodes` map, a whole `fields/xds.json` bundle, or both.
 */
export interface XdsSpecIndex {
  byLocator: Map<string, SpecNode[]>;
  byId: Map<string, SpecNode>;
  size: number;
}

/** Build the slot/scheme index. Cheap and pure; callers may cache it. */
export function buildXdsSpecIndex(opts?: Pick<ParseOptions, "specNodes" | "xdsFields">): XdsSpecIndex {
  const byLocator = new Map<string, SpecNode[]>();
  const byId = new Map<string, SpecNode>();
  const add = (node: SpecNode) => {
    if (byId.has(node.id)) return;
    byId.set(node.id, node);
    if (node.locator) {
      const key = locatorKey(node.locator);
      const bucket = byLocator.get(key);
      if (bucket) bucket.push(node);
      else byLocator.set(key, [node]);
    }
    for (const child of node.children ?? []) add(child);
  };
  for (const node of opts?.specNodes?.values() ?? []) add(node);
  const bundle = opts?.xdsFields;
  if (bundle) {
    for (const page of Object.values(bundle.pages ?? {})) {
      for (const table of page.tables ?? []) {
        for (const node of table.nodes ?? []) add(node);
      }
    }
  }
  return { byLocator, byId, size: byId.size };
}

/* ========================================================================== *
 * Evidence construction
 * ========================================================================== */

interface EvidenceSource {
  derivation?: Derivation;
  confidence?: Confidence;
  verifiedAgainstSample?: boolean;
  confidenceReason?: string | null;
  provenance?: Provenance | null;
  samples?: string[];
}

function makeEvidence(via: XdsEvidence["via"], source: EvidenceSource | null, extra?: Partial<XdsEvidence>): XdsEvidence {
  const provenance = source?.provenance ?? null;
  const derivation = source?.derivation ?? null;
  const hasPage = Boolean(provenance?.pageId);
  const citesSample = Boolean(provenance?.sample);
  const claimsConfluence = derivation === "confluence" || derivation === "confluence+sample";
  const note = hasPage
    ? NOTE_CONFLUENCE
    : citesSample
      ? NOTE_SAMPLE_DERIVED
      : derivation === "standard"
        ? "Fixed by HL7/IHE/OASIS rather than by NPHIES; no NPHIES page states it."
        : NOTE_UNSOURCED;
  return {
    via,
    derivation,
    confidence: source?.confidence ?? null,
    verifiedAgainstSample: source?.verifiedAgainstSample ?? null,
    confidenceReason: source?.confidenceReason ?? null,
    provenance,
    independentOfSamples: hasPage,
    derivationDisagreesWithProvenance: claimsConfluence && !hasPage,
    samples: source?.samples ?? [],
    note: extra?.specNodeCandidates?.length
      ? `${note} ${extra.specNodeCandidates.length} compiled spec rows define this name (the ` +
        "per-document-type metadata tables each restate it); none was chosen, because picking one " +
        "would assert a rule the message itself does not settle. The candidates are listed."
      : note,
    ...extra,
  };
}

const UNMAPPED_EVIDENCE: XdsEvidence = {
  via: "unmapped",
  derivation: null,
  confidence: null,
  verifiedAgainstSample: null,
  confidenceReason: null,
  provenance: null,
  independentOfSamples: false,
  derivationDisagreesWithProvenance: false,
  samples: [],
  note: "No compiled XDS rule describes this position, so nothing here can be asserted about it.",
};

/* ========================================================================== *
 * parseXds
 * ========================================================================== */

/**
 * Parse a SOAP/ebXML message against a compiled {@link MessageStructure}.
 *
 * Never throws. On input that is not XML at all, the result is a tree holding the text as a
 * single text node plus a diagnostic saying so — which is still enough for the UI to render
 * the message pane and say why nothing was recognised.
 */
export function parseXds(text: string, structure: MessageStructure, opts: ParseOptions = {}): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const unknown: UnknownElement[] = [];
  const maxDiagnostics = opts.maxDiagnostics ?? 500;
  let suppressed = 0;

  /* ---- source geometry --------------------------------------------------- */
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const locOf = (start: number, end: number): XdsSourceLocation => {
    const clampedStart = Math.max(0, Math.min(start, text.length));
    const clampedEnd = Math.max(clampedStart, Math.min(end, text.length));
    const line = lineOf(clampedStart);
    const endLine = lineOf(clampedEnd);
    return {
      line,
      startCol: clampedStart - lineStarts[line - 1],
      endCol: clampedEnd - lineStarts[endLine - 1],
      endLine,
      offset: clampedStart,
      endOffset: clampedEnd,
    };
  };
  const excerpt = (start: number, end: number, cap = 160): string => {
    const slice = text.slice(start, Math.min(end, start + cap));
    return end - start > cap ? `${slice}…` : slice;
  };
  const report = (d: Diagnostic) => {
    if (diagnostics.length >= maxDiagnostics) {
      suppressed++;
      return;
    }
    diagnostics.push(d);
  };

  /* ---- scan -------------------------------------------------------------- */
  const scan = scanXml(text);
  for (const problem of scan.problems) {
    report({
      severity: problem.severity,
      code: problem.code,
      message: problem.message,
      loc: locOf(problem.start, problem.end),
      excerpt: excerpt(problem.start, problem.end),
    });
  }

  const specIndex = buildXdsSpecIndex(opts);

  /* ---- tree root --------------------------------------------------------- */
  const rootMembers = membersOf(structure.root);
  const rootIndex = indexMembers(rootMembers);
  const root: XdsTreeNode = {
    id: structure.id,
    kind: "message",
    label: structure.title || structure.id,
    locator: null,
    specNodeId: null,
    memberId: structure.root.id,
    member: structure.root,
    occurrence: 0,
    value: null,
    present: true,
    loc: locOf(0, text.length),
    children: [],
    evidence: makeEvidence("element-name", structure.root as EvidenceSource),
  };

  let elementCount = 0;
  let attributeCount = 0;
  let mappedElements = 0;
  let independentElements = 0;

  const countNodes = (raw: RawNode): number => {
    if (raw.kind !== "element") return 1;
    let n = 1 + raw.attrs.length;
    for (const child of raw.children) n += countNodes(child);
    return n;
  };

  /**
   * Convert one raw node, resolving it against `member` (the structure member governing its
   * PARENT). `unmappedAncestor` is true once some ancestor already failed to map, which
   * keeps one stray wrapper from producing a finding per descendant.
   */
  const convert = (
    raw: RawNode,
    parentMember: StructureMember | null,
    parentIndex: MemberIndex | null,
    parentPath: string,
    parentId: string,
    occurrence: number,
    unmappedAncestor: boolean,
  ): XdsTreeNode => {
    if (raw.kind !== "element") {
      const label =
        raw.kind === "text" ? "#text" : raw.kind === "stray" ? "#stray" : `#${raw.kind}`;
      const id = `${parentId}/${label}[${occurrence}]`;
      const value = raw.kind === "text" ? decodeEntities(raw.raw) : raw.raw;
      return {
        id,
        kind: "text",
        label,
        locator: null,
        specNodeId: null,
        memberId: null,
        member: null,
        occurrence,
        value,
        raw: raw.raw,
        present: true,
        loc: locOf(raw.start, raw.end),
        children: [],
        xml: { node: raw.kind, raw: raw.raw },
      };
    }

    elementCount++;
    const path = `${parentPath}/${raw.local}[${occurrence}]`;
    const id = `${parentId}/${raw.local}[${occurrence}]`;

    /* -- resolve the member ------------------------------------------------ */
    let member: StructureMember | null = null;
    let via: XdsEvidence["via"] = "unmapped";
    let caseMismatch = false;
    if (parentIndex) {
      const exact = parentIndex.byLocal.get(raw.local);
      if (exact && exact.length) {
        member = exact[0];
        via = "element-name";
        if (exact.length > 1) {
          report({
            severity: "info",
            code: "xds-ambiguous-member",
            message:
              `The compiled structure offers ${exact.length} members named "${raw.local}" at this ` +
              `position (${exact.map((m) => m.id).join(", ")}). The first was used; a checker must ` +
              `not treat either as settled.`,
            loc: locOf(raw.start, raw.startTagEnd),
            nodeId: id,
            path,
          });
        }
      } else {
        const loose = parentIndex.byLower.get(raw.local.toLowerCase());
        if (loose && loose.length) {
          member = loose[0];
          via = "element-name-case-insensitive";
          caseMismatch = true;
        }
      }
    }
    if (caseMismatch && member) {
      report({
        severity: "error",
        code: "xds-element-case",
        message:
          `<${raw.qname}> differs only in letter case from the expected "${memberLocalName(member)}". ` +
          "XML element names are case sensitive, so this is a defect in the message. It was matched " +
          "anyway so the rest of the message could be checked. (Two official NPHIES ITI-18 response " +
          "samples carry exactly this defect: <soap:envelope> with a lower-case e.)",
        loc: locOf(raw.start, raw.startTagEnd),
        nodeId: id,
        path,
        excerpt: excerpt(raw.start, raw.startTagEnd),
      });
    }

    /* -- ebRIM identity: slot name and scheme UUID beat element position ---- */
    const attrByLocal = new Map<string, RawAttr>();
    for (const attr of raw.attrs) if (!attrByLocal.has(attr.local)) attrByLocal.set(attr.local, attr);

    let locator: SpecLocator | null = null;
    let schemeRule: XdsSchemeRuleWithName | null = null;
    let nodeKind: TreeNode["kind"] = "element";

    if (raw.local === "Slot") {
      const nameAttr = attrByLocal.get("name");
      nodeKind = "slot";
      if (nameAttr && nameAttr.value) {
        locator = { kind: "xdsSlot", name: nameAttr.value };
        via = "slot-name";
      } else {
        report({
          severity: "error",
          code: "xds-slot-without-name",
          message:
            "A rim:Slot carries no @name. The slot name is the only thing that says which XDS " +
            "metadata attribute this is, so nothing can be checked about it.",
          loc: locOf(raw.start, raw.startTagEnd),
          nodeId: id,
          path,
          excerpt: excerpt(raw.start, raw.startTagEnd),
        });
      }
    } else if (raw.local === "Classification" || raw.local === "ExternalIdentifier") {
      const schemeAttr =
        attrByLocal.get("classificationScheme") ??
        attrByLocal.get("identificationScheme") ??
        attrByLocal.get("classificationNode");
      const schemeKind: XdsSchemeLocator["scheme"] = attrByLocal.has("identificationScheme")
        ? "identification"
        : attrByLocal.has("classificationNode") && !attrByLocal.has("classificationScheme")
          ? "classificationNode"
          : "classification";
      if (schemeAttr && schemeAttr.value) {
        const uuid = schemeAttr.value.trim();
        const rules = schemeIndexOf(member);
        schemeRule = rules.get(uuid.toLowerCase()) ?? null;
        locator = {
          kind: "xdsScheme",
          scheme: schemeKind,
          uuid,
          attribute: schemeRule?.locator.attribute ?? "(unknown)",
          ...(schemeRule?.locator.appliesTo ? { appliesTo: schemeRule.locator.appliesTo } : {}),
        };
        if (schemeRule) {
          via = "scheme-uuid";
        } else {
          report({
            severity: "warn",
            code: "xds-unknown-scheme-uuid",
            message:
              `<${raw.qname}> carries ${schemeAttr.qname}="${uuid}", which is not one of the ` +
              `${rules.size} scheme UUID(s) the compiled spec knows at this position. The UUID — not ` +
              "the element name — is what says which metadata attribute this is, so the attribute " +
              "could not be identified. Expected one of: " +
              ([...rules.values()].map((r) => `${r.locator.uuid} (${r.locator.attribute})`).join(", ") ||
                "none compiled here") +
              ".",
            loc: locOf(schemeAttr.start, schemeAttr.end),
            nodeId: id,
            path,
            excerpt: excerpt(raw.start, raw.startTagEnd),
          });
        }
      } else if (member) {
        report({
          severity: "error",
          code: "xds-scheme-missing",
          message:
            `<${raw.qname}> carries no classificationScheme / identificationScheme / classificationNode. ` +
            "An ebRIM metadata attribute is identified by its scheme UUID, never by element position.",
          loc: locOf(raw.start, raw.startTagEnd),
          nodeId: id,
          path,
          excerpt: excerpt(raw.start, raw.startTagEnd),
        });
      }
    } else if (member && "locator" in member && member.locator) {
      locator = member.locator;
    }

    /* -- MTOM / XOP: model the reference, never the bytes ------------------ */
    if (raw.local === "Include" && (raw.prefix === "xop" || raw.qname === "Include")) {
      const href = attrByLocal.get("href");
      report({
        severity: "info",
        code: "xds-mtom-xop-include",
        message:
          (href ? `xop:Include references MIME part "${href.value}". ` : "xop:Include carries no @href. ") +
          MTOM_LIMITATION,
        loc: locOf(raw.start, raw.startTagEnd),
        nodeId: id,
        path,
        excerpt: excerpt(raw.start, raw.startTagEnd),
      });
    }

    /* -- resolve the governing SpecNode ------------------------------------ */
    let specNodeId: string | null = null;
    let candidates: string[] | undefined;
    if (locator && (locator.kind === "xdsSlot" || locator.kind === "xdsScheme")) {
      const hits = specIndex.byLocator.get(locatorKey(locator)) ?? [];
      if (hits.length === 1) {
        specNodeId = hits[0].id;
      } else if (hits.length > 1) {
        candidates = hits.map((n) => n.id).sort();
      }
    }

    const evidenceSource: EvidenceSource | null = schemeRule
      ? (schemeRule as EvidenceSource)
      : member
        ? (member as EvidenceSource)
        : null;
    const evidence = member || schemeRule
      ? makeEvidence(via, evidenceSource, candidates ? { specNodeCandidates: candidates } : undefined)
      : { ...UNMAPPED_EVIDENCE };
    if (member) {
      mappedElements++;
      if (evidence.independentOfSamples) independentElements++;
    }

    const node: XdsTreeNode = {
      id,
      kind: nodeKind,
      label: raw.qname,
      locator,
      specNodeId,
      memberId: member?.id ?? null,
      member,
      occurrence,
      value: null,
      raw: text.slice(raw.start, raw.startTagEnd),
      present: true,
      loc: locOf(raw.start, raw.startTagEnd),
      children: [],
      evidence,
      xml: {
        node: "element",
        qname: raw.qname,
        prefix: raw.prefix,
        local: raw.local,
        selfClosing: raw.selfClosing,
        startTagClosed: raw.startTagClosed,
        beforeGt: raw.beforeGt,
        endTag: raw.endTag,
        span: locOf(raw.start, raw.end),
      },
    };

    /* -- unknown element reporting ---------------------------------------- */
    if (!member && !unmappedAncestor) {
      const expected = parentIndex ? [...parentIndex.byLocal.keys()].sort() : [];
      unknown.push({
        nodeId: id,
        path,
        kind: "element",
        qname: raw.qname,
        localName: raw.local,
        prefix: raw.prefix,
        loc: node.loc as SourceLocation,
        excerpt: excerpt(raw.start, raw.startTagEnd),
        parentMemberId: parentMember?.id ?? null,
        expectedSiblings: expected,
        descendants: countNodes(raw) - 1 - raw.attrs.length,
        reason: parentIndex
          ? `The compiled ${structure.id} structure describes no <${raw.local}> at this position. ` +
            "That may be a gap in the compiled spec rather than a defect in the message: only 55.0% " +
            "of SOAP/XDS rules are independently sourced."
          : "No compiled member governs this position, so nothing can be said about its contents.",
        severity: "info",
      });
    }

    /* -- attributes -------------------------------------------------------- */
    let attrOccurrence = 0;
    for (const attr of raw.attrs) {
      attributeCount++;
      const isNamespace = attr.qname === "xmlns" || attr.prefix === "xmlns";
      const attrId = `${id}/@${attr.qname}`;
      const attrLocatorName = member ? `${memberLocalName(member) ?? raw.local}/@${attr.local}` : null;
      let attrSpecNodeId: string | null = null;
      let attrLocator: SpecLocator | null = null;
      let attrCandidates: string[] | undefined;
      if (attrLocatorName && !isNamespace) {
        const key = locatorKey({ kind: "xdsSlot", name: attrLocatorName });
        const hits = specIndex.byLocator.get(key) ?? [];
        if (hits.length) {
          attrLocator = { kind: "xdsSlot", name: attrLocatorName };
          if (hits.length === 1) attrSpecNodeId = hits[0].id;
          else attrCandidates = hits.map((n) => n.id).sort();
        }
      }
      const attrEvidence = attrLocator
        ? makeEvidence(
            "attribute-name",
            (specIndex.byId.get(attrSpecNodeId ?? "") ?? null) as EvidenceSource | null,
            attrCandidates ? { specNodeCandidates: attrCandidates } : undefined,
          )
        : isNamespace
          ? {
              ...UNMAPPED_EVIDENCE,
              via: "attribute-name" as const,
              note:
                "An XML namespace declaration. Infrastructure the serialisation needs; the compiled " +
                "NPHIES spec states no rule about it, and none is asserted here.",
            }
          : { ...UNMAPPED_EVIDENCE, via: "attribute-name" as const };
      node.children.push({
        id: attrId,
        kind: "attribute",
        label: attr.qname,
        locator: attrLocator,
        specNodeId: attrSpecNodeId,
        memberId: null,
        member: null,
        occurrence: attrOccurrence++,
        value: attr.value,
        raw: text.slice(attr.start, attr.end),
        present: true,
        loc: locOf(attr.start, attr.end),
        children: [],
        evidence: attrEvidence,
        xml: {
          lead: attr.lead,
          qname: attr.qname,
          prefix: attr.prefix,
          local: attr.local,
          eq: attr.eq,
          quote: attr.quote,
          rawValue: attr.rawValue,
          closed: attr.closed,
          isNamespace,
        },
      });
      if (opts.reportUnknownAttributes && !attrLocator && !isNamespace && !unmappedAncestor) {
        unknown.push({
          nodeId: attrId,
          path: `${path}/@${attr.qname}`,
          kind: "attribute",
          qname: attr.qname,
          localName: attr.local,
          prefix: attr.prefix,
          loc: locOf(attr.start, attr.end),
          excerpt: excerpt(attr.start, attr.end),
          parentMemberId: member?.id ?? null,
          expectedSiblings: [],
          descendants: 0,
          reason: `The compiled spec states no rule for @${attr.local} on <${raw.local}>.`,
          severity: "info",
        });
      }
    }

    /* -- children ---------------------------------------------------------- */
    const childIndex = member ? indexMembers(membersOf(member)) : null;
    const seen = new Map<string, number>();
    for (const child of raw.children) {
      const key = child.kind === "element" ? child.local : `#${child.kind}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      node.children.push(
        convert(child, member, childIndex, path, id, n, unmappedAncestor || !member),
      );
    }

    /* -- leaf value -------------------------------------------------------- */
    const textChildren = raw.children.filter((c) => c.kind === "text" || c.kind === "cdata");
    const hasElementChild = raw.children.some((c) => c.kind === "element");
    if (!hasElementChild && textChildren.length) {
      const joined = textChildren
        .map((c) =>
          c.kind === "cdata"
            ? (c as RawLeaf).raw.slice(9, Math.max(9, (c as RawLeaf).raw.length - 3))
            : decodeEntities((c as RawLeaf).raw, (entity, at) =>
                report({
                  severity: "warn",
                  code: "xml-unknown-entity",
                  message: `Unknown entity reference ${entity}. Left as written; nothing was guessed.`,
                  loc: locOf((c as RawLeaf).start + at, (c as RawLeaf).start + at + entity.length),
                  nodeId: id,
                  path,
                }),
              ),
        )
        .join("");
      node.value = joined;
    }

    return node;
  };

  /* ---- document children ------------------------------------------------- */
  const documentElements = scan.nodes.filter((n): n is RawElement => n.kind === "element");
  if (documentElements.length === 0) {
    report({
      severity: "error",
      code: "xds-no-document-element",
      message:
        "No XML element was found. This does not look like a SOAP message — check that the whole " +
        "envelope was pasted and that the file is not base64 or a MIME part.",
      loc: locOf(0, Math.min(text.length, 200)),
    });
  } else if (documentElements.length > 1) {
    report({
      severity: "error",
      code: "xml-multiple-root-elements",
      message: `An XML document has exactly one root element; this text has ${documentElements.length}.`,
      loc: locOf(documentElements[1].start, documentElements[1].startTagEnd),
    });
  }

  const seenTop = new Map<string, number>();
  for (const child of scan.nodes) {
    const key = child.kind === "element" ? child.local : `#${child.kind}`;
    const n = seenTop.get(key) ?? 0;
    seenTop.set(key, n + 1);
    const isRootElement = child.kind === "element" && child === documentElements[0];
    root.children.push(
      convert(child, structure.root, isRootElement ? rootIndex : null, "", structure.id, n, !isRootElement),
    );
  }

  /* ---- envelope-level checks (generic: read off the compiled envelope) ---- */
  const envelope = structure.envelope;
  if (envelope && envelope.kind === "soapEnvelope" && documentElements.length) {
    const expectedRoot = rootMembers.length ? memberLocalName(rootMembers[0]) : null;
    const actualRoot = documentElements[0].local;
    if (expectedRoot && actualRoot !== expectedRoot && actualRoot.toLowerCase() !== expectedRoot.toLowerCase()) {
      report({
        severity: "error",
        code: "xds-wrong-document-element",
        message:
          `The document element is <${documentElements[0].qname}>, but ${structure.id} expects ` +
          `<${expectedRoot}>. Either the wrong structure was chosen for this message, or this is not ` +
          "the transaction it claims to be.",
        loc: locOf(documentElements[0].start, documentElements[0].startTagEnd),
      });
    }
  }

  /* ---- provenance caveat, always attached -------------------------------- */
  const sampleDerivedStructure = (structure.notes ?? []).some((n) =>
    n.includes("derived from the official golden"),
  );
  report({
    severity: "info",
    code: "xds-provenance-caveat",
    message:
      `${XDS_INDEPENDENCE_HEADLINE} SOAP element paths specifically are only ` +
      `${(XDS_INDEPENDENCE.soapPath.share * 100).toFixed(1)}% independent ` +
      `(${XDS_INDEPENDENCE.soapPath.independent} of ${XDS_INDEPENDENCE.soapPath.found}). ` +
      (sampleDerivedStructure
        ? `The ${structure.id} envelope shape itself was derived from the official samples, not from a ` +
          "published page, so matching a golden sample against it confirms nothing. "
        : "") +
      `${opts.sourceName ? `${opts.sourceName}: ` : ""}this message mapped ${mappedElements} of ` +
      `${elementCount} elements (and carries ${attributeCount} attributes), ` +
      `${independentElements} of them against a rule a Confluence page actually states.`,
    loc: null,
    evidence: {
      ...UNMAPPED_EVIDENCE,
      via: "unmapped",
      note: "Bundle-level caveat from spec-build/gate-report.json#independence.",
    },
  });

  for (const note of structure.notes ?? []) {
    report({
      severity: "info",
      code: "xds-structure-note",
      message: note,
      loc: null,
    });
  }

  if (suppressed > 0) {
    diagnostics.push({
      severity: "warn",
      code: "xds-diagnostics-truncated",
      message: `${suppressed} further diagnostic(s) were suppressed at the ${maxDiagnostics} limit.`,
      loc: null,
    });
  }

  const tree: StructureTree = {
    structureId: structure.id,
    useCaseId: structure.useCaseId,
    family: "xds",
    encoding: "soap-xml",
    text,
    root,
    diagnostics,
  };

  return { tree, diagnostics, unknown };
}

/* ========================================================================== *
 * Small helpers other passes need
 * ========================================================================== */

/** Count of elements, attributes, text nodes and mapped elements in a parsed tree. */
export function xdsTreeStats(tree: StructureTree): {
  elements: number;
  attributes: number;
  text: number;
  mapped: number;
  independent: number;
  slots: number;
  schemes: number;
} {
  let elements = 0;
  let attributes = 0;
  let textNodes = 0;
  let mapped = 0;
  let independent = 0;
  let slots = 0;
  let schemes = 0;
  const step = (node: XdsTreeNode) => {
    if (node.kind === "attribute") attributes++;
    else if (node.kind === "text") textNodes++;
    else if (node.kind !== "message") {
      elements++;
      if (node.memberId) mapped++;
      if (node.evidence?.independentOfSamples) independent++;
      if (node.locator?.kind === "xdsSlot") slots++;
      if (node.locator?.kind === "xdsScheme") schemes++;
    }
    for (const child of node.children) step(child);
  };
  step(tree.root as XdsTreeNode);
  return { elements, attributes, text: textNodes, mapped, independent, slots, schemes };
}

/**
 * The qualified metadata name a `rim:ExternalIdentifier` must carry in
 * `rim:Name/rim:LocalizedString/@value` — `XDSDocumentEntry.patientId`, not `patientId`.
 * Returns `null` when the compiled spec does not settle it; never guesses a qualification.
 */
export function qualifiedMetadataName(
  member: StructureMember | null,
  uuid: string,
): { value: string; evidence: XdsEvidence } | null {
  const rule = schemeIndexOf(member).get(uuid.trim().toLowerCase());
  const name = rule?.metadataName;
  if (!name || !name.value) return null;
  return { value: name.value, evidence: makeEvidence("scheme-uuid", name as EvidenceSource) };
}
