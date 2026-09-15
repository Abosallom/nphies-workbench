/**
 * XDS / SOAP emitter — {@link StructureTree} -> message text.
 *
 * The exact inverse of {@link parseXds}. Two paths, one code path:
 *
 *   message --parseXds--> StructureTree --emitXds--> message      byte-identical
 *   HIS extract --------> StructureTree --emitXds--> message      canonical serialisation
 *
 * A node that came from a parse carries its captured {@link XmlSyntax}: the exact qname,
 * the exact attribute spelling including the whitespace before it, whether the tag was
 * self-closing, the stray space in `<rim:AdhocQuery id="x" >`, the exact end tag, and every
 * comment, processing instruction and run of indentation as its own node. Writing those
 * back reproduces the input character for character — which is the whole point: if Build
 * and Check drift apart, the round-trip test stops passing.
 *
 * A node that a HIS extract built carries no syntax, so it is serialised canonically:
 * indented, double-quoted attributes, children in the order the compiled
 * {@link MessageStructure} lists them. That ordering is the only thing this emitter reads
 * from the structure, and it is generic — there is no per-transaction branching here.
 *
 * ## Repairs are opt-in, never silent
 *
 * Two official ITI-18 response samples spell the document element `<soap:envelope>` with a
 * lower-case e, which is invalid XML. Emitting the corrected `<soap:Envelope>` would break
 * the round trip, so {@link EmitOptions.normalizeEnvelopeCase} defaults to `false`: by
 * default this emitter reproduces what it was given, defects included, and the parser's
 * `xds-element-case` diagnostic is what tells the user. Set the option to apply the repair
 * the compiled spec asks for ("Emit <soap:Envelope>").
 */

import {
  type MessageStructure,
  type SpecLocator,
  type StructureMember,
  type StructureTree,
  type TreeNode,
  membersOf,
} from "../structure";
import {
  type XdsTreeNode,
  type XmlAttrSyntax,
  type XmlElementSyntax,
  type XmlLeafSyntax,
  memberLocalName,
  qualifiedMetadataName,
  xmlSyntaxOf,
} from "../parse/xds";

export interface EmitOptions {
  /**
   * Ignore captured syntax and re-serialise everything canonically. Useful to normalise a
   * parsed message; it does NOT round-trip. Default `false`.
   */
  canonical?: boolean;
  /** Indent unit for canonically serialised nodes. Default one tab, as the samples use. */
  indent?: string;
  /** Line ending for canonically serialised nodes. Default `"\n"`. */
  newline?: string;
  /**
   * XML declaration to prepend when the tree has none. `null` to prepend nothing.
   * Default `<?xml version="1.0" encoding="UTF-8"?>`, matching every golden sample.
   */
  xmlDeclaration?: string | null;
  /**
   * Apply the compiled spec's documented repair to the document element's letter case
   * (`soap:envelope` -> `soap:Envelope`). Default `false` — see the module note: a repair
   * that fires by default would hide the defect and break the round trip.
   */
  normalizeEnvelopeCase?: boolean;
  /**
   * When BUILDING (a node with no captured syntax), write the qualified metadata name into
   * `rim:ExternalIdentifier/rim:Name/rim:LocalizedString/@value` — `XDSDocumentEntry.patientId`,
   * not `patientId` — taking the literal from the compiled scheme map. Default `true`.
   * Never rewrites a value that came from a parse, so it cannot break the round trip.
   */
  qualifyExternalIdentifierNames?: boolean;
}

/* ========================================================================== *
 * Escaping
 * ========================================================================== */

/** Escape character data. `>` is escaped too, so `]]>` can never appear by accident. */
export function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape an attribute value for double quotes. */
export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#9;");
}

/* ========================================================================== *
 * Node classification
 * ========================================================================== */

function elementSyntax(node: TreeNode): XmlElementSyntax | null {
  const syntax = xmlSyntaxOf(node);
  return syntax && "node" in syntax && syntax.node === "element" ? syntax : null;
}

function leafSyntax(node: TreeNode): XmlLeafSyntax | null {
  const syntax = xmlSyntaxOf(node);
  return syntax && "node" in syntax && syntax.node !== "element" ? (syntax as XmlLeafSyntax) : null;
}

function attrSyntax(node: TreeNode): XmlAttrSyntax | null {
  const syntax = xmlSyntaxOf(node);
  return syntax && !("node" in syntax) ? syntax : null;
}

const isAttribute = (node: TreeNode) => node.kind === "attribute";
const isLeafText = (node: TreeNode) => node.kind === "text";
const isElement = (node: TreeNode) => !isAttribute(node) && !isLeafText(node) && node.kind !== "message";

/** The qname to write for an element node: the captured one, else its label. */
function qnameOf(node: TreeNode): string {
  const syntax = elementSyntax(node);
  if (syntax) return syntax.qname;
  return (node.label ?? "").trim() || "element";
}

/* ========================================================================== *
 * Spec-driven ordering (build path only)
 * ========================================================================== */

/**
 * Order children by the position of their member in the compiled structure. Applied only to
 * nodes being serialised canonically — a parsed tree keeps whatever order the wire had,
 * because ebRIM does not constrain `RegistryObjectList` child order and the compiled spec
 * says so explicitly.
 */
function orderedChildren(children: XdsTreeNode[], member: StructureMember | null): XdsTreeNode[] {
  if (!member) return children;
  const order = new Map<string, number>();
  membersOf(member).forEach((child, index) => order.set(child.id, index));
  if (!order.size) return children;
  if (!children.every((c) => !isElement(c) || (c.memberId && order.has(c.memberId)))) return children;
  return [...children].sort((a, b) => {
    if (!isElement(a) || !isElement(b)) return 0;
    return (order.get(a.memberId as string) ?? 0) - (order.get(b.memberId as string) ?? 0);
  });
}

function memberById(structure: MessageStructure, id: string | null | undefined): StructureMember | null {
  if (!id) return null;
  let found: StructureMember | null = null;
  const step = (member: StructureMember) => {
    if (found) return;
    if (member.id === id) {
      found = member;
      return;
    }
    for (const child of membersOf(member)) step(child);
  };
  step(structure.root);
  return found;
}

/* ========================================================================== *
 * emitXds
 * ========================================================================== */

/**
 * Serialise a {@link StructureTree} back to SOAP/ebXML text.
 *
 * Never throws: a tree with missing labels or unexpected node kinds still produces text,
 * because refusing to render is worse than rendering something an integrator can look at.
 */
export function emitXds(tree: StructureTree, structure: MessageStructure, opts: EmitOptions = {}): string {
  const canonical = opts.canonical ?? false;
  const indentUnit = opts.indent ?? "\t";
  const newline = opts.newline ?? "\n";
  const qualifyNames = opts.qualifyExternalIdentifierNames ?? true;
  const normalizeCase = opts.normalizeEnvelopeCase ?? false;

  const root = tree.root as XdsTreeNode;
  const expectedRootLocal = (() => {
    const members = membersOf(structure.root);
    return members.length ? memberLocalName(members[0]) : null;
  })();

  /**
   * Document-element case repair, applied only when asked for — and to BOTH tags, because a
   * `<soap:Envelope> … </soap:envelope>` pair would be worse than the defect it replaced.
   */
  const repairQName = (qname: string, depth: number): string => {
    if (!normalizeCase || depth !== 0 || !expectedRootLocal) return qname;
    const colon = qname.indexOf(":");
    const prefix = colon > 0 ? qname.slice(0, colon + 1) : "";
    const local = colon > 0 ? qname.slice(colon + 1) : qname;
    if (local !== expectedRootLocal && local.toLowerCase() === expectedRootLocal.toLowerCase()) {
      return prefix + expectedRootLocal;
    }
    return qname;
  };
  const repairEndTag = (endTag: string, qname: string, depth: number): string => {
    if (!normalizeCase || depth !== 0) return endTag;
    const match = /^<\/([^\s>]+)(\s*)>$/.exec(endTag);
    if (!match) return endTag;
    return `</${repairQName(match[1], depth) === match[1] ? match[1] : qname}${match[2]}>`;
  };

  /* ---- attributes -------------------------------------------------------- */
  const emitAttribute = (node: XdsTreeNode, parent: XdsTreeNode): string => {
    const syntax = attrSyntax(node);
    if (syntax && !canonical) {
      // `lead` is written verbatim, junk included: reproducing a mangled start tag exactly is
      // what lets the UI point at the mangling instead of at a silently repaired version.
      const lead = syntax.lead;
      if (syntax.eq === null) return `${lead}${syntax.qname}`;
      if (!syntax.quote) return `${lead}${syntax.qname}${syntax.eq}${syntax.rawValue}`;
      const close = syntax.closed === false ? "" : syntax.quote;
      return `${lead}${syntax.qname}${syntax.eq}${syntax.quote}${syntax.rawValue}${close}`;
    }
    const name = syntax?.qname ?? node.label ?? "attr";
    const value = buildAttributeValue(node, parent) ?? node.value ?? "";
    return ` ${name}="${escapeXmlAttr(value)}"`;
  };

  /**
   * The one place the emitter applies a compiled FIX rather than echoing: the qualified
   * `XDSDocumentEntry.patientId` form of a `rim:ExternalIdentifier`'s name. It fires only on
   * a node with no captured syntax, i.e. one being built rather than round-tripped.
   */
  const buildAttributeValue = (node: XdsTreeNode, parent: XdsTreeNode): string | null => {
    if (!qualifyNames) return null;
    if ((node.label ?? "") !== "value") return null;
    if (attrSyntax(node) && !canonical) return null;
    // parent must be rim:LocalizedString inside rim:Name inside rim:ExternalIdentifier
    const localOf = (n: XdsTreeNode | null) => {
      if (!n) return null;
      const syntax = elementSyntax(n);
      const qname = syntax?.qname ?? n.label ?? "";
      const colon = qname.indexOf(":");
      return colon > 0 ? qname.slice(colon + 1) : qname;
    };
    if (localOf(parent) !== "LocalizedString") return null;
    const chain = parentChain.get(parent);
    const nameEl = chain?.[chain.length - 1] ?? null;
    if (localOf(nameEl) !== "Name") return null;
    const extId = chain && chain.length >= 2 ? chain[chain.length - 2] : null;
    if (localOf(extId) !== "ExternalIdentifier") return null;
    const locator: SpecLocator | null = extId?.locator ?? null;
    if (!locator || locator.kind !== "xdsScheme") return null;
    const member = extId?.member ?? memberById(structure, extId?.memberId);
    const qualified = qualifiedMetadataName(member, locator.uuid);
    return qualified ? qualified.value : null;
  };

  /* ---- element / text ---------------------------------------------------- */
  const parentChain = new Map<XdsTreeNode, XdsTreeNode[]>();

  const emitNode = (node: XdsTreeNode, depth: number, chain: XdsTreeNode[]): string => {
    parentChain.set(node, chain);

    if (node.kind === "message") {
      return node.children.map((child) => emitNode(child, depth, [...chain, node])).join("");
    }

    if (isLeafText(node)) {
      const syntax = leafSyntax(node);
      if (syntax && !canonical) return syntax.raw;
      if (node.raw != null && !canonical) return node.raw;
      if (syntax && syntax.node !== "text") return syntax.raw;
      if (canonical && syntax && syntax.node === "text" && !(node.value ?? "").trim()) return "";
      return escapeXmlText(node.value ?? "");
    }

    if (isAttribute(node)) return "";

    const syntax = elementSyntax(node);
    const qname = repairQName(qnameOf(node), depth);
    const nextChain = [...chain, node];

    const attrs = node.children.filter(isAttribute) as XdsTreeNode[];
    const content = node.children.filter((c) => !isAttribute(c)) as XdsTreeNode[];
    const head = `<${qname}${attrs.map((a) => emitAttribute(a, node)).join("")}`;

    /* -- exact reproduction ------------------------------------------------ */
    if (syntax && !canonical) {
      // A start tag the text never closed stays unclosed, and an element the text never
      // closed gets no invented end tag. Emitting a repair here would quietly "fix" a
      // truncated paste, and the hospital would never see that their message was cut short —
      // the parser's xml-unclosed-element diagnostic is what tells them.
      if (syntax.startTagClosed === false) return `${head}${syntax.beforeGt}`;
      if (syntax.selfClosing) return `${head}${syntax.beforeGt}/>`;
      const inner = content.map((c) => emitNode(c, depth + 1, nextChain)).join("");
      const tail = syntax.endTag === null ? "" : repairEndTag(syntax.endTag, qname, depth);
      return `${head}${syntax.beforeGt}>${inner}${tail}`;
    }

    /* -- canonical serialisation ------------------------------------------- */
    const member = node.member ?? memberById(structure, node.memberId);
    const elements = orderedChildren(
      content.filter((c) => isElement(c)),
      member,
    );
    const texts = content.filter((c) => isLeafText(c) && leafSyntax(c)?.node !== "text");
    const value = node.value;

    if (!elements.length && !texts.length && (value === null || value === "")) {
      return `${head}/>`;
    }
    if (!elements.length && !texts.length) {
      return `${head}>${escapeXmlText(value ?? "")}</${qname}>`;
    }
    const pad = indentUnit.repeat(depth + 1);
    const inner = [...texts, ...elements]
      .map((c) => `${newline}${pad}${emitNode(c, depth + 1, nextChain)}`)
      .join("");
    return `${head}>${inner}${newline}${indentUnit.repeat(depth)}</${qname}>`;
  };

  let out = emitNode(root, 0, []);

  /* ---- XML declaration --------------------------------------------------- */
  // Only BUILT trees get a declaration added. A parsed tree gets back exactly what it had:
  // the 11 official ITI-41 envelopes carry no declaration at all, and inventing one would
  // break the round trip — the one property that proves Build and Check cannot drift apart.
  const cameFromParse = typeof tree.text === "string" && tree.text.length > 0;
  const declaration =
    opts.xmlDeclaration !== undefined
      ? opts.xmlDeclaration
      : cameFromParse
        ? null
        : '<?xml version="1.0" encoding="UTF-8"?>';
  if (declaration && out.length > 0 && !out.trimStart().startsWith("<?xml")) {
    out = `${declaration}${newline}${out}`;
  }

  return out;
}

/* ========================================================================== *
 * Round-trip support
 * ========================================================================== */

export interface Difference {
  /** Absolute character offset of the first difference, or `null` when the texts match. */
  offset: number | null;
  /** 1-based line and 0-based column of that offset in the ORIGINAL text. */
  line: number;
  column: number;
  expected: string;
  actual: string;
  /** ~60 characters either side, from each text. */
  expectedContext: string;
  actualContext: string;
}

/**
 * First point at which two texts differ, with context. The round-trip test reports from
 * this; so does the workbench when it wants to show an integrator exactly where a rebuilt
 * message diverged from the one they pasted.
 */
export function firstDifference(expected: string, actual: string, window = 60): Difference {
  const limit = Math.min(expected.length, actual.length);
  let i = 0;
  while (i < limit && expected[i] === actual[i]) i++;
  if (i === limit && expected.length === actual.length) {
    return {
      offset: null,
      line: 0,
      column: 0,
      expected: "",
      actual: "",
      expectedContext: "",
      actualContext: "",
    };
  }
  let line = 1;
  let lineStart = 0;
  for (let k = 0; k < i; k++) {
    if (expected.charCodeAt(k) === 10) {
      line++;
      lineStart = k + 1;
    }
  }
  return {
    offset: i,
    line,
    column: i - lineStart,
    expected: expected.slice(i, i + 1),
    actual: actual.slice(i, i + 1),
    expectedContext: expected.slice(Math.max(0, i - window), i + window),
    actualContext: actual.slice(Math.max(0, i - window), i + window),
  };
}

/** True when emitting the tree reproduces the text it was parsed from, byte for byte. */
export function roundTrips(tree: StructureTree, structure: MessageStructure, opts?: EmitOptions): boolean {
  return emitXds(tree, structure, opts) === tree.text;
}
