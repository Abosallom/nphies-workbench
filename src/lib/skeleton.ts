/**
 * The redacted structural skeleton — the ONLY form of a message that ever leaves the browser.
 *
 * Two measured facts decided this module. An 87 KB CDA discharge summary is ~24,700 tokens,
 * so sending documents is not affordable; and every message the workbench handles carries
 * patient names, national ids, dates of birth, addresses and telecoms, so sending documents
 * is not permissible either. The previous "snippet" (±2 raw lines around a finding) leaked all
 * of those at once.
 *
 * The redaction is SPEC-DRIVEN, by construction, not by blacklist. A value survives into the
 * skeleton only when something OTHER than the message says what it may be:
 *
 *   (A) the node's governing {@link SpecNode} pins it (`fixedValues`), binds it to a value set
 *       (`valueSets`), or marks the position structural (`role === "structural"` — resourceType,
 *       MSH-9, MSH-12, MSA-1, meta/profile, …); or
 *   (B) the value is a schema/template/vocabulary identifier the underlying STANDARD fixes —
 *       XML namespace declarations, `xsi:type`, the HL7 v3 RIM "structural attributes"
 *       (classCode, moodCode, typeCode, …), `templateId/@root`, `codeSystem`, the ebRIM
 *       scheme attributes. None of those can hold a datum about a person; all of them are what
 *       makes a CDA section recognisable as, say, the Vital Signs section.
 *
 * Everything else becomes `…`. Narrative `<text>`, `nonXMLBody`, Binary data, OBX-5, names,
 * identifiers, dates, addresses and telecoms are therefore never present — not because they
 * were listed, but because no rule pins them. A new PHI-bearing element the spec has not been
 * compiled for is redacted by default, which is the property a blacklist cannot offer.
 *
 * This file imports nothing but types from the engine and never touches the network; the AI
 * layer (`ai.ts`) consumes what it produces. `tests/skeleton.test.mjs` asserts over every
 * official sample that known patient values never appear.
 */

import type { FixedValueRule, SpecNode, StructureTree, TreeNode } from "./structure";
import type { Finding } from "./findings";

/* ========================================================================== *
 * Public shapes
 * ========================================================================== */

/** One rendered line of the skeleton. */
export interface SkeletonLine {
  /** 1-based source line the node starts on; `null` only for the synthetic header. */
  readonly line: number | null;
  /** Rendered text, already indented. */
  readonly text: string;
  /** Instance path of the node this line stands for (`TreeNode.id`), for cross-referencing. */
  readonly nodeId: string | null;
  /** Set on a collapsed line: the source span it stands for. */
  readonly span?: { readonly from: number; readonly to: number };
}

/** A subtree that was folded into one line, or lines dropped to fit the cap. */
export interface Elision {
  readonly kind: "collapsed" | "truncated";
  readonly label: string;
  readonly from: number;
  readonly to: number;
  /** Element-like nodes the fold hid. */
  readonly count: number;
  readonly reason: string;
}

export interface Skeleton {
  readonly structureId: string | null;
  readonly encoding: StructureTree["encoding"];
  readonly lines: readonly SkeletonLine[];
  /** `lines[].text` joined with newlines — the string that gets sent and quoted against. */
  readonly text: string;
  /** Number of lines in the SOURCE message, so a cited line can be range-checked. */
  readonly sourceLines: number;
  /** Source lines the payload mentions: skeleton lines, collapsed spans, and finding lines. */
  readonly mentionedLines: ReadonlySet<number>;
  readonly elided: readonly Elision[];
  /** chars / 3.6 — the estimator the UI states before the first call. */
  readonly estimatedTokens: number;
  /** How many leaf values survived and how many were replaced by `…`. */
  readonly kept: number;
  readonly redacted: number;
}

export interface SkeletonOptions {
  /** Findings whose lines/paths must stay visible; finding-free subtrees are what get folded. */
  readonly findings?: readonly Finding[];
  /** Token ceiling for `text`. Default 10 000. */
  readonly maxTokens?: number;
  /** Fold finding-free subtrees even when the skeleton already fits. Default: only to fit. */
  readonly collapseAlways?: boolean;
}

export const DEFAULT_SKELETON_TOKENS = 10_000;

/** The estimator shared with `ai.ts`: measured at ~3.6 chars/token on these messages. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

/* ========================================================================== *
 * (B) Standard-defined structural vocabulary
 * ========================================================================== */

/**
 * Attributes whose values the STANDARD fixes to a closed vocabulary that describes the
 * document's shape, never its subject. HL7 v3 calls the first group "structural attributes"
 * (RIM §3.1); the second is XML infrastructure; the third is ebRIM/XDS metadata typing.
 * This is a whitelist: an attribute not named here is redacted.
 */
const STRUCTURAL_ATTRIBUTES: ReadonlySet<string> = new Set([
  // HL7 v3 RIM structural attributes
  "classCode",
  "moodCode",
  "typeCode",
  "determinerCode",
  "nullFlavor",
  "negationInd",
  "inversionInd",
  "contextConductionInd",
  "contextControlCode",
  "mediaType",
  "representation",
  "codeSystem",
  "codeSystemName",
  // XML infrastructure
  "xmlns",
  "xsi:type",
  "xsi:schemaLocation",
  // ebRIM / XDS metadata typing
  "objectType",
  "status",
  "associationType",
  "classificationScheme",
  "classificationNode",
  "identificationScheme",
  "nodeRepresentation",
  "mimeType",
  "name", // rim:Slot/@name names the metadata attribute the slot carries
  // SOAP / WS-Addressing plumbing
  "mustUnderstand",
]);

/** `<templateId root=…>` and `<typeId root=… extension=…>`: template identifiers by definition. */
const TEMPLATE_ELEMENTS: ReadonlySet<string> = new Set(["templateId", "typeId"]);

/** FHIR JSON keys whose value identifies a profile, system or extension — never a person. */
const FHIR_STRUCTURAL_KEYS: ReadonlySet<string> = new Set(["resourceType", "profile", "system", "url"]);

/* ========================================================================== *
 * Value policy
 * ========================================================================== */

const REDACTED = "…";

interface Ctx {
  readonly specNodes: ReadonlyMap<string, SpecNode>;
  readonly encoding: StructureTree["encoding"];
  kept: number;
  redacted: number;
}

function specOf(ctx: Ctx, node: TreeNode | null | undefined): SpecNode | null {
  if (!node) return null;
  if (node.spec) return node.spec;
  return node.specNodeId ? (ctx.specNodes.get(node.specNodeId) ?? null) : null;
}

/** A spec node that can vouch for a value on its own: pinned, bound, or structural. */
function specPinsValue(spec: SpecNode | null): boolean {
  if (!spec) return false;
  return spec.fixedValues.length > 0 || spec.valueSets.length > 0 || spec.role === "structural";
}

/** Does a fixed-value rule address this attribute/component by name? */
function ruleTargets(rule: FixedValueRule, name: string, index?: number): boolean {
  const bare = name.replace(/^@/, "");
  if (rule.attribute && rule.attribute.replace(/^@/, "") === bare) return true;
  if (rule.target && rule.target.replace(/^@/, "") === bare) return true;
  if (index !== undefined && rule.component !== null && rule.component !== undefined) {
    return String(rule.component) === String(index);
  }
  return false;
}

/**
 * Decide whether an XML attribute's value may appear.
 *
 * The owner element's spec node governs an attribute (CDA attributes carry no spec node of
 * their own), but a pinned `@root` on `<id>` must not drag `@extension` — the patient's
 * national id — along with it. So a spec node vouches for one attribute only when a rule
 * NAMES that attribute, or the attribute is a code-carrying one (`code`, `root`, `value`,
 * `extension` on a template) on a pinned/bound/structural element.
 */
function keepAttribute(ctx: Ctx, attr: TreeNode, owner: TreeNode | null): boolean {
  const name = attr.label;
  if (STRUCTURAL_ATTRIBUTES.has(name) || name.startsWith("xmlns:")) return true;
  const ownerName = owner ? localName(owner.label) : "";
  if (TEMPLATE_ELEMENTS.has(ownerName) && (name === "root" || name === "extension")) return true;

  const spec = specOf(ctx, attr) ?? specOf(ctx, owner);
  if (!spec) return false;
  if (spec.fixedValues.some((r) => ruleTargets(r, name))) return true;
  if (name === "code" || name === "root" || name === "codeSystemVersion") return specPinsValue(spec);
  return false;
}

/**
 * HL7 v2 components and subcomponents share the FIELD's spec node, so the same care applies:
 * `PID-3` may pin its assigning authority (component 4) and still carry the health id in
 * component 1. Component rules in the compiled spec name the component by its datatype
 * component NAME ("Universal ID", "Identifier"), which is exactly the node's label.
 */
function keepComponent(ctx: Ctx, node: TreeNode, field: TreeNode | null): boolean {
  const spec = specOf(ctx, node) ?? specOf(ctx, field);
  if (!spec) return false;
  const index = componentIndex(node);
  if (spec.fixedValues.some((r) => ruleTargets(r, node.label, index))) return true;
  if (spec.role === "structural") return true;
  // A bound coded field (CE/CWE/CNE): the code (1) and coding-system (3) components are what
  // the value set speaks to; the display text (2) is free text the spec does not bind.
  if (spec.valueSets.length > 0) return index === 1 || index === 3;
  return false;
}

/** Element text content in XML. Kept only when the spec pins or binds it — never on role alone. */
function keepText(ctx: Ctx, owner: TreeNode | null): boolean {
  const spec = specOf(ctx, owner);
  if (!spec) return false;
  // Role alone is not enough here: in the XDS tables every metadata attribute (patientId,
  // sourcePatientInfo, creationTime, …) is "structural", and their rim:Value text IS the
  // identifier. Attributes and JSON scalars are a different matter (see keepAttribute).
  return spec.fixedValues.some((r) => r.scope !== "attribute" && r.scope !== "component") || spec.valueSets.length > 0;
}

/** Scalar leaves: HL7 whole fields, FHIR JSON values, XDS element values. */
function keepScalar(ctx: Ctx, node: TreeNode, parent: TreeNode | null): boolean {
  if (ctx.encoding === "fhir-json") {
    const key = jsonKey(node, parent);
    if (FHIR_STRUCTURAL_KEYS.has(key)) return true;
  }
  return specPinsValue(specOf(ctx, node));
}

function componentIndex(node: TreeNode): number | undefined {
  const loc = node.locator;
  if (loc && loc.kind === "hl7Field") {
    return node.kind === "subcomponent" ? loc.subcomponent : loc.component;
  }
  const m = /\.(\d+)$/.exec(node.id);
  return m ? Number(m[1]) : undefined;
}

function localName(qname: string): string {
  const i = qname.indexOf(":");
  return i >= 0 ? qname.slice(i + 1) : qname;
}

/** The JSON key a FHIR node was read from: the label, or the parent's for array items. */
function jsonKey(node: TreeNode, parent: TreeNode | null): string {
  if (node.kind === "repetition" && parent) return parent.label;
  return node.label;
}

function value(ctx: Ctx, keep: boolean, v: string | null): string {
  if (v === null) return "";
  if (keep) {
    ctx.kept++;
    return v;
  }
  ctx.redacted++;
  return v === "" ? "" : REDACTED;
}

/* ========================================================================== *
 * Rendering
 * ========================================================================== */

/** An intermediate: one node's own line plus its rendered children, for collapsing. */
interface Rendered {
  line: number | null;
  text: string;
  nodeId: string | null;
  label: string;
  /** Identity worth keeping on a collapsed line: a templateId root, a code, a title. */
  identity: string;
  depth: number;
  from: number;
  to: number;
  /** Element-like descendants, for the "N elements" count. */
  count: number;
  hasFinding: boolean;
  children: Rendered[];
}

const isLexical = (node: TreeNode) => node.kind === "text" || node.label.startsWith("#");

/**
 * Does any finding line fall inside [from, to]? A finding can sit on a line no node starts on
 * — a known sample defect flagged on a closing `],` — so containment is by span, not by
 * node line; otherwise the fold would hide exactly the line the finding is about.
 */
function findingWithin(findingLines: ReadonlySet<number>, from: number, to: number): boolean {
  if (from <= 0) return false;
  for (const l of findingLines) if (l >= from && l <= to) return true;
  return false;
}

function lineOf(node: TreeNode): number | null {
  return node.loc ? node.loc.line : null;
}

/** Source line span of a node, from its own loc and its descendants'. */
function spanOf(node: TreeNode): { from: number; to: number } {
  let from = Infinity;
  let to = -Infinity;
  const visit = (n: TreeNode) => {
    if (n.present === false) return;
    if (n.loc) {
      from = Math.min(from, n.loc.line);
      to = Math.max(to, n.loc.line);
    }
    for (const c of n.children) visit(c);
  };
  visit(node);
  if (from === Infinity) return { from: 0, to: 0 };
  return { from, to };
}

function q(v: string): string {
  return `"${v.replace(/\s+/g, " ").slice(0, 80)}"`;
}

function renderXmlElement(ctx: Ctx, node: TreeNode, depth: number, findingLines: ReadonlySet<number>, findingPaths: ReadonlySet<string>): Rendered {
  const attrs: string[] = [];
  let text: string | null = null;
  let identity = "";
  const kids: TreeNode[] = [];
  for (const child of node.children) {
    if (child.present === false) continue;
    if (child.kind === "attribute") {
      const keep = keepAttribute(ctx, child, node);
      const v = value(ctx, keep, child.value);
      attrs.push(`@${child.label}=${q(v)}`);
      if (keep && (child.label === "root" || child.label === "code")) identity = identity || `@${child.label}=${q(v)}`;
      continue;
    }
    if (isLexical(child)) {
      if (child.label !== "#text" && child.label !== "#cdata") continue; // comments, PIs, decls: never structure
      if (child.value === null || !child.value.trim()) continue;
      text = value(ctx, keepText(ctx, node), child.value.trim());
      continue;
    }
    kids.push(child);
  }
  const children = kids.map((k) => renderNode(ctx, k, depth + 1, findingLines, findingPaths, node));
  const span = spanOf(node);
  const line = lineOf(node);
  const own = `${"  ".repeat(depth)}${node.label}${attrs.length ? " " + attrs.join(" ") : ""}${text !== null ? ` = ${q(text)}` : ""}`;
  if (!identity && text !== null && text !== REDACTED && localName(node.label) === "title") identity = q(text);
  const hasFinding = findingWithin(findingLines, span.from, span.to) || findingPaths.has(node.id) || children.some((c) => c.hasFinding);
  return {
    line,
    text: own,
    nodeId: node.id,
    label: node.label,
    identity,
    depth,
    from: span.from,
    to: span.to,
    count: 1 + children.reduce((n, c) => n + c.count, 0),
    hasFinding,
    children,
  };
}

/** Components/subcomponents of one HL7 field, joined with the wire separators. */
function renderHl7Field(ctx: Ctx, field: TreeNode): string {
  const reps = field.children.filter((c) => c.kind === "repetition" && c.present !== false);
  const renderRep = (rep: TreeNode): string => {
    const comps = rep.children.filter((c) => c.kind === "component" && c.present !== false);
    if (!comps.length) return value(ctx, keepComponent(ctx, rep, field), rep.value);
    return comps.map((c) => renderComponent(ctx, c, field)).join("^");
  };
  if (reps.length) return reps.map(renderRep).join("~");
  const comps = field.children.filter((c) => c.kind === "component" && c.present !== false);
  if (!comps.length) return value(ctx, specPinsValue(specOf(ctx, field)), field.value);
  return comps.map((c) => renderComponent(ctx, c, field)).join("^");
}

function renderComponent(ctx: Ctx, comp: TreeNode, field: TreeNode): string {
  const subs = comp.children.filter((c) => c.kind === "subcomponent" && c.present !== false);
  if (subs.length) return subs.map((s) => value(ctx, keepComponent(ctx, s, field), s.value ?? s.raw ?? null)).join("&");
  return value(ctx, keepComponent(ctx, comp, field), comp.value ?? comp.raw ?? null);
}

function renderHl7Segment(ctx: Ctx, seg: TreeNode, depth: number, findingLines: ReadonlySet<number>, findingPaths: ReadonlySet<string>): Rendered {
  const line = lineOf(seg);
  const pad = "  ".repeat(depth);
  const children: Rendered[] = [];
  for (const field of seg.children) {
    if (field.present === false || field.kind !== "field") continue;
    const rendered = renderHl7Field(ctx, field);
    // Empty fields are positions, not content; listing forty of them buys nothing.
    if (!rendered.replace(/[\^~&]/g, "")) continue;
    const loc = field.locator;
    const name = loc && loc.kind === "hl7Field" ? `${loc.segment}-${loc.field}` : field.label;
    const spec = specOf(ctx, field);
    const label = spec && spec.label !== name ? ` ${spec.label}` : "";
    const fl = lineOf(field);
    children.push({
      line: fl,
      text: `${pad}  ${name}${label} = ${rendered}`,
      nodeId: field.id,
      label: name,
      identity: "",
      depth: depth + 1,
      from: fl ?? 0,
      to: fl ?? 0,
      count: 1,
      hasFinding: (fl !== null && findingLines.has(fl)) || findingPaths.has(field.id),
      children: [],
    });
  }
  const hasFinding = (line !== null && findingLines.has(line)) || findingPaths.has(seg.id) || children.some((c) => c.hasFinding);
  return {
    line,
    text: `${pad}${seg.label}`,
    nodeId: seg.id,
    label: seg.label,
    identity: "",
    depth,
    from: line ?? 0,
    to: line ?? 0,
    count: 1 + children.length,
    hasFinding,
    children,
  };
}

function renderNode(
  ctx: Ctx,
  node: TreeNode,
  depth: number,
  findingLines: ReadonlySet<number>,
  findingPaths: ReadonlySet<string>,
  parent: TreeNode | null,
): Rendered {
  if (node.kind === "segment") return renderHl7Segment(ctx, node, depth, findingLines, findingPaths);
  if (ctx.encoding !== "fhir-json" && ctx.encoding !== "hl7v2-er7") {
    return renderXmlElement(ctx, node, depth, findingLines, findingPaths);
  }
  // FHIR JSON (and HL7 groups): containers list their key; scalars show a value or `…`.
  const line = lineOf(node);
  const pad = "  ".repeat(depth);
  const kids = node.children.filter((c) => c.present !== false && !isLexical(c));
  const children = kids.map((k) => renderNode(ctx, k, depth + 1, findingLines, findingPaths, node));
  const span = spanOf(node);
  let own: string;
  let identity = "";
  if (node.value !== null && kids.length === 0) {
    const keep = keepScalar(ctx, node, parent);
    const v = value(ctx, keep, node.value);
    own = `${pad}${node.label} = ${q(v)}`;
    if (keep && (node.label === "resourceType" || node.label === "type")) identity = q(v);
  } else {
    own = `${pad}${node.label}`;
    const rt = children.find((c) => c.label === "resourceType");
    if (rt) identity = rt.identity;
  }
  const hasFinding = findingWithin(findingLines, span.from, span.to) || findingPaths.has(node.id) || children.some((c) => c.hasFinding);
  return { line, text: own, nodeId: node.id, label: node.label, identity, depth, from: span.from, to: span.to, count: 1 + children.reduce((n, c) => n + c.count, 0), hasFinding, children };
}

/* ========================================================================== *
 * Collapsing to fit the cap
 * ========================================================================== */

function flatten(r: Rendered, out: Rendered[]): void {
  out.push(r);
  for (const c of r.children) flatten(c, out);
}

function collapsedText(r: Rendered): string {
  const pad = "  ".repeat(r.depth);
  const where = r.from === r.to ? `L${r.from}` : `L${r.from}–L${r.to}`;
  return `${pad}${r.label}${r.identity ? " " + r.identity : ""} (${where}, ${r.count} elements, no findings)`;
}

/** A folded subtree becomes one line with no children. */
function collapse(r: Rendered, elided: Elision[]): void {
  elided.push({
    kind: "collapsed",
    label: `${r.label}${r.identity ? " " + r.identity : ""}`,
    from: r.from,
    to: r.to,
    count: r.count,
    reason: "finding-free subtree folded to fit the token cap",
  });
  r.text = collapsedText(r);
  r.children = [];
}

function linesOf(root: Rendered): Rendered[] {
  const out: Rendered[] = [];
  flatten(root, out);
  return out;
}

function sizeOf(root: Rendered): number {
  return estimateTokens(linesOf(root).map((r) => `L${r.line ?? "-"} ${r.text}`).join("\n"));
}

/**
 * Fold finding-free subtrees until the skeleton fits. Largest first, but never a subtree
 * bigger than a quarter of the document in the first pass: folding `structuredBody` in one
 * go would hide every section, which is exactly what a reviewer needs to see. Only when the
 * smaller folds are not enough does the second pass take anything.
 */
function fitToCap(root: Rendered, maxTokens: number, elided: Elision[], always: boolean): void {
  const candidates = (limit: number) =>
    linesOf(root)
      .filter((r) => !r.hasFinding && r.children.length > 0 && r.count >= 4 && r.count <= limit && r !== root)
      .sort((a, b) => b.count - a.count);
  if (always) {
    for (const r of candidates(Infinity)) if (r.children.length) collapse(r, elided);
  }
  if (sizeOf(root) <= maxTokens) return;
  for (const limit of [Math.max(4, Math.floor(root.count / 4)), Infinity]) {
    for (const r of candidates(limit)) {
      if (!r.children.length) continue; // already folded by an ancestor's collapse
      collapse(r, elided);
      if (sizeOf(root) <= maxTokens) return;
    }
  }
}

/* ========================================================================== *
 * Entry points
 * ========================================================================== */

/**
 * Build the skeleton of a parsed message.
 *
 * `specNodes` is `ResolvedUseCase.specNodes`; nodes already carrying `spec` (after
 * `linkTree`) are honoured without the lookup. Findings decide what must stay visible.
 */
export function buildSkeleton(tree: StructureTree, specNodes: ReadonlyMap<string, SpecNode>, opts: SkeletonOptions = {}): Skeleton {
  const ctx: Ctx = { specNodes, encoding: tree.encoding, kept: 0, redacted: 0 };
  const maxTokens = opts.maxTokens ?? DEFAULT_SKELETON_TOKENS;
  const findingLines = new Set<number>();
  const findingPaths = new Set<string>();
  for (const f of opts.findings ?? []) {
    if (f.location) findingLines.add(f.location.line);
    findingPaths.add(f.path);
  }
  const sourceLines = tree.text.length ? tree.text.split(/\r\n|\r|\n/).length : 0;

  const root = renderNode(ctx, tree.root, 0, findingLines, findingPaths, null);
  root.text = `${tree.root.label} [${tree.structureId ?? "no structure"}, ${tree.encoding}, ${sourceLines} source lines]`;
  root.line = null;

  const elided: Elision[] = [];
  fitToCap(root, maxTokens, elided, opts.collapseAlways ?? false);

  // Last resort: hard truncation, recorded rather than hidden.
  const rendered = linesOf(root);
  const lines: SkeletonLine[] = [];
  let chars = 0;
  const budget = maxTokens * 3.6;
  for (let i = 0; i < rendered.length; i++) {
    const r = rendered[i];
    const text = r.line === null ? r.text : `L${r.line} ${r.text}`;
    if (chars + text.length + 1 > budget && i < rendered.length - 1) {
      const rest = rendered.slice(i);
      const from = rest.find((x) => x.line !== null)?.line ?? 0;
      const to = Math.max(...rest.map((x) => x.to));
      elided.push({ kind: "truncated", label: `${rest.length} further lines`, from, to, count: rest.length, reason: "token cap reached" });
      lines.push({ line: null, text: `… ${rest.length} further lines (L${from}–L${to}) not shown: token cap reached`, nodeId: null, span: { from, to } });
      break;
    }
    chars += text.length + 1;
    lines.push(r.children.length === 0 && r.count > 1 && !r.hasFinding && r.from !== r.to ? { line: r.line, text, nodeId: r.nodeId, span: { from: r.from, to: r.to } } : { line: r.line, text, nodeId: r.nodeId });
  }

  // Finding lines are cited in the findings block of the payload, so they are citable even
  // when no node starts on them (a defect flagged on a closing bracket).
  const mentioned = new Set<number>();
  for (const l of findingLines) if (l >= 1 && l <= sourceLines) mentioned.add(l);
  for (const l of lines) {
    if (l.line !== null) mentioned.add(l.line);
    if (l.span) for (let n = l.span.from; n <= l.span.to; n++) mentioned.add(n);
  }
  const text = lines.map((l) => l.text).join("\n");
  return {
    structureId: tree.structureId,
    encoding: tree.encoding,
    lines,
    text,
    sourceLines,
    mentionedLines: mentioned,
    elided,
    estimatedTokens: estimateTokens(text),
    kept: ctx.kept,
    redacted: ctx.redacted,
  };
}

/**
 * The skeleton lines around one source line — what `AiExplain` sends instead of raw text.
 *
 * A collapsed line whose span covers the window is included, so a finding inside a folded
 * section still shows which section it sits in.
 */
export function skeletonWindow(skeleton: Skeleton, line: number, radius = 2): string {
  const lo = line - radius;
  const hi = line + radius;
  const out = skeleton.lines.filter((l) => (l.line !== null && l.line >= lo && l.line <= hi) || (l.span !== undefined && l.span.from <= hi && l.span.to >= lo));
  return out.map((l) => l.text).join("\n");
}

/** Is a line number one the skeleton actually shows? Used to reject fabricated citations. */
export function skeletonMentions(skeleton: Skeleton, line: number): boolean {
  return Number.isInteger(line) && line >= 1 && line <= skeleton.sourceLines && skeleton.mentionedLines.has(line);
}
