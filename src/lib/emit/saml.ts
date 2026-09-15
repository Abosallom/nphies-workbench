/**
 * SAML 2.0 SSO message emitter — the exact inverse of `../parse/saml`.
 *
 * ## The invariant
 *
 *     message --parseSaml--> StructureTree --emitSaml--> message      (byte-identical)
 *     HIS extract ---------> StructureTree --emitSaml--> message      (generated)
 *
 * The first line is a real test, not a copy: `emitSaml` never echoes the original document.
 * `StructureTree.text` is not read at all in reproduce mode. Every element is rebuilt from
 * its own node — open tag, attributes, character data, children, close tag — so a
 * byte-identical result proves the tree captured every byte of the message, including the
 * whitespace between elements, comments, the XML declaration, and the exact damage in a
 * malformed one.
 *
 * The only formatting a node takes from its own `raw` is the whitespace INSIDE its open tag
 * (between attributes), which belongs to that node's span. Edit any attribute on a node and
 * that node's open tag is re-serialised with single spaces; every other node is untouched.
 *
 * ## Two modes, chosen automatically
 *
 *  * **reproduce** — the tree came from a parse (some node carries `raw`). Output follows
 *    the tree exactly, including anything the structure does not describe.
 *  * **generate** — the tree carries values but no source text (a HIS extract, or an empty
 *    tree plus `slots`). Output is built by walking the compiled {@link MessageStructure}:
 *    member order, fixed values, namespace declarations and indentation all come from the
 *    spec. Generating from the published sample values reproduces the Confluence skeleton
 *    byte-for-byte, which is the only check available for this path.
 *
 * ## What this emitter will not do
 *
 * It does not sign, and it never fabricates a `ds:Signature`. NPHIES publishes no signature
 * internals (see {@link SAML_SIGNATURE_DISCLAIMER}), so generated output carries a comment
 * where the signature belongs, saying in the document itself that it is unsigned and that
 * the structure it was built from has never been checked against a real NPHIES message.
 */

import type { MessageStructure, StructureMember, StructureTree, TreeNode } from "../structure";
import { resolveUsage } from "../structure";
import {
  SAML_SIGNATURE_DISCLAIMER,
  attributeMembersOf,
  decodeXmlText,
  elementMembersOf,
  environmentValueFor,
  escapeXmlAttribute,
  escapeXmlText,
  isOpaqueMember,
  memberAttributeName,
  memberElementName,
  scanOpenTag,
  variableSlotOf,
  wholeFixedValue,
} from "../parse/saml";

export interface EmitOptions {
  /**
   * `auto` (default) reproduces a parsed tree and generates from a value-only one.
   * Force `generate` to re-render a parsed message in the published skeleton's layout.
   */
  mode?: "auto" | "reproduce" | "generate";
  /**
   * Retarget the message at a NPHIES environment (`ONA` | `ONB` | `PROD`, from
   * `structure.variantAxis.values`). In reproduce mode this rewrites the three endpoint
   * values and therefore breaks byte-identity on purpose. Omit it to leave them alone.
   */
  environment?: string | null;
  /** Values by variable-slot name, e.g. `{"Health ID": "10000300236625"}`. */
  slots?: Record<string, string>;
  /** Values by structure member id. Wins over `slots`. */
  values?: Record<string, string>;
  /** Indent unit for generated output. Default two spaces, as the published skeleton uses. */
  indent?: string;
  /** Line ending for generated output. Default `"\n"`. */
  newline?: "\n" | "\r\n";
  /** Emit an XML declaration in generate mode. `true` uses the standard one. Default off. */
  xmlDeclaration?: boolean | string;
  /**
   * Write the provenance / unsigned / unverified comments into generated output.
   * Default `true` in generate mode, always `false` in reproduce mode.
   */
  annotate?: boolean;
  /** End generated output with a newline. Default `true`. */
  trailingNewline?: boolean;
}

interface EmitContext {
  structure: MessageStructure;
  options: EmitOptions;
  /** memberId -> replacement value, from `values`, `slots` and `environment`. */
  overrides: Map<string, string>;
  indent: string;
  newline: string;
  annotate: boolean;
}

/* ========================================================================== *
 * Entry point
 * ========================================================================== */

/**
 * Serialise a {@link StructureTree} back to a SAML SSO message.
 *
 * With no options and a tree straight from {@link parseSaml}, the output is the input,
 * byte for byte.
 */
export function emitSaml(tree: StructureTree, structure: MessageStructure, opts?: EmitOptions): string {
  const options = opts ?? {};
  const mode = options.mode && options.mode !== "auto" ? options.mode : detectMode(tree);
  const ctx: EmitContext = {
    structure,
    options,
    overrides: buildOverrides(structure, options),
    indent: options.indent ?? "  ",
    newline: options.newline ?? "\n",
    annotate: mode === "generate" ? options.annotate !== false : false,
  };
  return mode === "reproduce" ? emitNode(tree.root, ctx) : generate(tree, ctx);
}

/**
 * A tree that came from {@link parseSaml} is reproduced; a tree of values is generated from.
 * The discriminator is source position: a parser gives every node a `loc`, and an emitter is
 * told that `loc` is "null for nodes an emitter is about to create". An empty message
 * therefore re-emits as an empty message rather than sprouting a whole document.
 */
function detectMode(tree: StructureTree): "reproduce" | "generate" {
  if (tree.root.loc !== null) return "reproduce";
  let found = false;
  const step = (node: TreeNode): void => {
    if (found) return;
    if (node.loc !== null || (typeof node.raw === "string" && node.raw.length > 0)) {
      found = true;
      return;
    }
    for (const child of node.children) step(child);
  };
  step(tree.root);
  return found ? "reproduce" : "generate";
}

function buildOverrides(structure: MessageStructure, options: EmitOptions): Map<string, string> {
  const map = new Map<string, string>();
  if (options.environment) {
    const byMember = structure.variantAxis?.valuesByMember?.[options.environment];
    for (const [memberId, hit] of Object.entries(byMember ?? {})) {
      if (hit && typeof hit.value === "string") map.set(memberId, hit.value);
    }
  }
  if (options.slots) {
    walkMembers(structure, (member) => {
      const slot = variableSlotOf(member);
      if (slot && options.slots && slot in options.slots) map.set(member.id, options.slots[slot]);
    });
  }
  for (const [memberId, value] of Object.entries(options.values ?? {})) map.set(memberId, value);
  return map;
}

function walkMembers(structure: MessageStructure, visit: (member: StructureMember) => void): void {
  const step = (members: StructureMember[]): void => {
    for (const member of members) {
      visit(member);
      step(elementMembersOf(member).concat(attributeMembersOf(member)));
    }
  };
  step(structure.root.members);
}

/* ========================================================================== *
 * Reproduce mode — rebuild the message from the tree
 * ========================================================================== */

function effectiveValue(node: TreeNode, ctx: EmitContext): string | null {
  if (node.memberId && ctx.overrides.has(node.memberId)) return ctx.overrides.get(node.memberId) as string;
  return node.value;
}

function emitNode(node: TreeNode, ctx: EmitContext): string {
  switch (node.kind) {
    case "message":
      return node.children.map((child) => emitNode(child, ctx)).join("");
    case "attribute":
      return ""; // carried inside the parent's open tag
    case "element":
      return emitElement(node, ctx);
    case "text":
      return emitTextNode(node, ctx);
    default:
      // Any node kind a future parser adds: preserve its text rather than drop it.
      return node.raw ?? (node.value === null ? "" : escapeXmlText(node.value));
  }
}

function emitTextNode(node: TreeNode, ctx: EmitContext): string {
  const value = effectiveValue(node, ctx);
  if (typeof node.raw === "string") {
    // Comments, CDATA, PIs and the XML declaration are stored verbatim; character data is
    // reused only while it still decodes to the node's value.
    if (node.label !== "#text" || value === null || decodeXmlText(node.raw) === value) return node.raw;
  }
  return value === null ? "" : escapeXmlText(value);
}

function attributeName(node: TreeNode): string {
  const locator = node.locator;
  if (locator && "attribute" in locator && typeof locator.attribute === "string") return locator.attribute;
  return node.label.replace(/^@/, "");
}

function quoteOf(node: TreeNode): '"' | "'" {
  const hit = node.raw ? /=\s*(['"])/.exec(node.raw) : null;
  return hit && hit[1] === "'" ? "'" : '"';
}

/** `</name>` exactly as the source wrote it, when `raw` ends with this element's end tag. */
function trailingCloseTag(raw: string, name: string): string | null {
  const hit = /<\/([^<>]*)>$/.exec(raw);
  if (!hit) return null;
  return hit[1].trim().toLowerCase() === name.toLowerCase() ? hit[0] : null;
}

/** True when the source open tag still says exactly what the attribute nodes say. */
function openTagUnchanged(
  scanned: ReturnType<typeof scanOpenTag>,
  attributes: TreeNode[],
  ctx: EmitContext,
): boolean {
  if (scanned.attrs.length !== attributes.length) return false;
  for (let i = 0; i < attributes.length; i++) {
    const node = attributes[i];
    const source = scanned.attrs[i];
    if (source.name !== attributeName(node)) return false;
    const value = effectiveValue(node, ctx);
    if (value === null) return false;
    if (decodeXmlText(source.rawValue) !== value) return false;
  }
  return true;
}

function buildOpenTag(name: string, attributes: TreeNode[], ctx: EmitContext, selfClosing: boolean): string {
  let out = `<${name}`;
  for (const node of attributes) {
    const value = effectiveValue(node, ctx);
    if (value === null) continue;
    const quote = quoteOf(node);
    out += ` ${attributeName(node)}=${quote}${escapeXmlAttribute(value, quote)}${quote}`;
  }
  return out + (selfClosing ? "/>" : ">");
}

function emitElement(node: TreeNode, ctx: EmitContext): string {
  const attributes = node.children.filter((child) => child.kind === "attribute");
  const content = node.children.filter((child) => child.kind !== "attribute");
  const name = node.label || "element";
  const raw = typeof node.raw === "string" ? node.raw : null;

  if (raw === null) {
    // A node built rather than parsed: serialise it from its parts.
    const value = effectiveValue(node, ctx);
    if (content.length === 0) {
      if (value === null || value === "") return buildOpenTag(name, attributes, ctx, true);
      return `${buildOpenTag(name, attributes, ctx, false)}${escapeXmlText(value)}</${name}>`;
    }
    return (
      buildOpenTag(name, attributes, ctx, false) +
      content.map((child) => emitNode(child, ctx)).join("") +
      `</${name}>`
    );
  }

  const scanned = scanOpenTag(raw, 0);
  const closeTag = trailingCloseTag(raw, name);
  const reusable = openTagUnchanged(scanned, attributes, ctx);
  const openRaw = raw.slice(0, scanned.length);

  if (content.length === 0) {
    const value = effectiveValue(node, ctx);
    if (scanned.selfClosing) {
      if (value === null || value === "") return reusable ? openRaw : buildOpenTag(name, attributes, ctx, true);
      // A value was added to what the source wrote as an empty element: expand it.
      return `${buildOpenTag(name, attributes, ctx, false)}${escapeXmlText(value)}</${name}>`;
    }
    const contentRaw = raw.slice(scanned.length, raw.length - (closeTag?.length ?? 0));
    const body =
      value !== null && decodeXmlText(contentRaw) === value ? contentRaw : escapeXmlText(value ?? "");
    const open = reusable ? openRaw : buildOpenTag(name, attributes, ctx, false);
    // `closeTag === null` means the source never closed this element. Reproducing that
    // faithfully is the point: the parse said so with a diagnostic, and the emitter must
    // not quietly repair a message the hospital is trying to debug.
    return open + body + (closeTag ?? "");
  }

  const open =
    scanned.selfClosing || !reusable ? buildOpenTag(name, attributes, ctx, false) : openRaw;
  const body = content.map((child) => emitNode(child, ctx)).join("");
  const tail = closeTag ?? (scanned.selfClosing ? `</${name}>` : "");
  return open + body + tail;
}

/* ========================================================================== *
 * Generate mode — build the message from the compiled structure
 * ========================================================================== */

function collectTreeValues(tree: StructureTree): Map<string, string> {
  const map = new Map<string, string>();
  const step = (node: TreeNode): void => {
    if (node.memberId && node.value !== null && !map.has(node.memberId)) map.set(node.memberId, node.value);
    for (const child of node.children) step(child);
  };
  step(tree.root);
  return map;
}

function generate(tree: StructureTree, ctx: EmitContext): string {
  const fromTree = collectTreeValues(tree);
  const structure = ctx.structure;
  const lines: string[] = [];

  if (ctx.options.xmlDeclaration) {
    lines.push(
      typeof ctx.options.xmlDeclaration === "string"
        ? ctx.options.xmlDeclaration
        : '<?xml version="1.0" encoding="UTF-8"?>',
    );
  }

  if (ctx.annotate) {
    lines.push(
      `<!-- Built by the NPHIES workbench from structure "${structure.id}" ` +
        `(confidence: ${structure.confidence}, verifiedAgainstSample: ${structure.verifiedAgainstSample === true}).`,
      "     NO OFFICIAL NPHIES SAMPLE EXISTS for this message. Every element, attribute and fixed value below",
      "     comes from the literal XML skeleton on Confluence page 7766254 and the prose around it; nothing here",
      "     has been checked against a message NPHIES actually accepted.",
      "     THIS DOCUMENT IS UNSIGNED. " + SAML_SIGNATURE_DISCLAIMER.replace(/\s+/g, " "),
      "-->",
    );
  }

  const roots = elementMembersOf(structure.root);
  const rootNamespaces = rootNamespaceDeclarations(structure);
  for (const member of roots) {
    lines.push(...generateMember(member, 0, ctx, fromTree, rootNamespaces));
  }

  const body = lines.join(ctx.newline);
  return ctx.options.trailingNewline === false ? body : body + ctx.newline;
}

/**
 * Namespace declarations the root element must carry: every prefix the structure actually
 * uses in an element or attribute NAME that no member declares with an `xmlns:` attribute.
 * Derived from `envelope.namespaces` — nothing is hard-coded, and prefixes used only inside
 * a subtree the emitter skips (the unsigned signature) are not declared.
 */
function rootNamespaceDeclarations(structure: MessageStructure): { prefix: string; uri: string }[] {
  const envelope = structure.envelope;
  const declared = new Set<string>();
  const used = new Set<string>();

  const prefixOf = (name: string | null): string | null => {
    if (!name) return null;
    const colon = name.indexOf(":");
    return colon === -1 ? null : name.slice(0, colon);
  };

  const step = (members: StructureMember[]): void => {
    for (const member of members) {
      if (isOpaqueMember(member)) continue; // never emitted, so its prefix is never needed
      const elementName = memberElementName(member);
      const prefix = prefixOf(elementName);
      if (prefix) used.add(prefix);
      for (const attribute of attributeMembersOf(member)) {
        const attributeName = memberAttributeName(attribute);
        if (!attributeName) continue;
        if (attributeName === "xmlns") declared.add("");
        else if (attributeName.startsWith("xmlns:")) declared.add(attributeName.slice(6));
        else {
          const attributePrefix = prefixOf(attributeName);
          if (attributePrefix) used.add(attributePrefix);
        }
      }
      step(elementMembersOf(member));
    }
  };
  step(structure.root.members);

  if (!envelope || envelope.kind !== "samlResponse") return [];
  return envelope.namespaces.filter((ns) => used.has(ns.prefix) && !declared.has(ns.prefix));
}

function generateMember(
  member: StructureMember,
  depth: number,
  ctx: EmitContext,
  fromTree: Map<string, string>,
  rootNamespaces: { prefix: string; uri: string }[],
): string[] {
  const pad = ctx.indent.repeat(depth);
  const name = memberElementName(member);
  if (!name) return [];

  if (isOpaqueMember(member)) {
    if (!ctx.annotate) return [];
    const note = (member as { note?: string | null }).note ?? "";
    return [
      `${pad}<!-- <${name}> belongs here. This tool does NOT sign and does NOT verify signatures.`,
      `${pad}     ${note}`,
      `${pad}     Sign this assertion with an external tool before sending it. -->`,
    ];
  }

  // A member the spec forbids at this position is not built.
  if (resolveUsage(member, ctx.options.environment ? { conditions: [ctx.options.environment] } : undefined).rule?.validator === "error-if-present") {
    return [];
  }

  const valueOf = (target: StructureMember): string | null => {
    if (ctx.overrides.has(target.id)) return ctx.overrides.get(target.id) as string;
    const environmentValue = environmentValueFor(ctx.structure, target.id, ctx.options.environment);
    if (environmentValue !== null) return environmentValue;
    const treeValue = fromTree.get(target.id);
    if (treeValue !== undefined) return treeValue;
    return wholeFixedValue(target);
  };

  const notes: string[] = [];
  let attributes = "";
  if (depth === 0) {
    for (const ns of rootNamespaces) {
      attributes += ` ${ns.prefix ? `xmlns:${ns.prefix}` : "xmlns"}="${escapeXmlAttribute(ns.uri)}"`;
    }
  }
  for (const attribute of attributeMembersOf(member)) {
    const attributeName = memberAttributeName(attribute);
    if (!attributeName) continue;
    const value = valueOf(attribute);
    if (value === null) {
      if (resolveUsage(attribute).rule?.validator === "error-if-missing") {
        notes.push(`${pad}<!-- required: ${name}/@${attributeName} — no value supplied -->`);
      }
      continue;
    }
    attributes += ` ${attributeName}="${escapeXmlAttribute(value)}"`;
  }

  const children = elementMembersOf(member);
  const lines: string[] = [];
  if (ctx.annotate) lines.push(...notes);

  if (children.length > 0) {
    const body = children.flatMap((child) => generateMember(child, depth + 1, ctx, fromTree, rootNamespaces));
    lines.push(`${pad}<${name}${attributes}>`, ...body, `${pad}</${name}>`);
    return lines;
  }

  const value = valueOf(member);
  if (value === null) {
    const slot = variableSlotOf(member);
    if (ctx.annotate && slot) lines.push(`${pad}<!-- ${slot}: no value supplied -->`);
    lines.push(`${pad}<${name}${attributes}/>`);
    return lines;
  }
  lines.push(`${pad}<${name}${attributes}>${escapeXmlText(value)}</${name}>`);
  return lines;
}
