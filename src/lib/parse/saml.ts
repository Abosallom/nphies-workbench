/**
 * SAML 2.0 SSO message parser — `saml-xml` encoding.
 *
 * ## What this is
 *
 * `parseSaml` turns a SAML SSO message (a `samlp:Response` document the EMR/HIS SENDS to
 * NPHIES) into the shared {@link StructureTree}, driven entirely by the compiled
 * {@link MessageStructure}. There is no per-use-case branching anywhere in this file: every
 * element name, attribute name, fixed value, namespace prefix, environment endpoint and
 * signature placement rule is read out of the structure at runtime. Point it at a different
 * `saml-xml` structure and it parses that instead.
 *
 * `emitSaml` (`../emit/saml`) is its exact inverse over the same tree.
 *
 * ## HONESTY NOTICE — this path is NOT verified against a real message
 *
 * `saml-sso` has **no official golden sample**. Every rule in `saml-sso-response` rests on
 * one literal XML skeleton published on Confluence page 7766254 plus the prose around it,
 * and the compiled structure records `confidence: "medium"`, `verifiedAgainstSample: false`.
 * Nothing here has ever been checked against a message NPHIES actually accepted.
 *
 * Two consequences, both deliberate:
 *
 *  1. Every parse emits `SAML_UNVERIFIED_STRUCTURE` as its first diagnostic, and **every**
 *     diagnostic and unknown element carries `confidence` / `verifiedAgainstSample` copied
 *     from the member it is about. A finding from this parser must never look as solid as
 *     one from ADT, which is checked against 62 golden messages.
 *  2. The parser never upgrades its own evidence. A rule the compiler marked `low`
 *     (the `ds:Signature` member, derived from prose) stays `low` in the finding.
 *
 * ## XML SIGNATURE — presence and placement only
 *
 * See {@link SAML_SIGNATURE_DISCLAIMER}. This parser reports whether a `ds:Signature`
 * element exists and where it sits relative to the position the structure models. It does
 * NOT canonicalise, digest, verify or create a signature, and it does not model the
 * signature's internals — NPHIES publishes none, so any check here would be invented.
 *
 * ## Why a hand-written scanner rather than fast-xml-parser
 *
 * Every parsed node MUST carry `{line, startCol, endCol}` or the SplitView cannot highlight
 * and "Check" cannot point at anything, and a parse must never throw on the broken messages
 * hospitals actually paste. fast-xml-parser gives neither source offsets nor partial results.
 * The scanner below is tolerant by construction: malformed input produces diagnostics plus a
 * partial tree, never an exception, and the raw text of every node is preserved so the
 * emitter can reproduce even a malformed message byte-for-byte.
 */

import type {
  Confidence,
  MessageStructure,
  Provenance,
  Severity,
  SourceLocation,
  SpecLocator,
  StructureElement,
  StructureGroup,
  StructureMember,
  StructureTree,
  TreeDiagnostic,
  TreeNode,
  VariantContext,
} from "../structure";
import { membersOf, resolveUsage } from "../structure";

/* ========================================================================== *
 * Public types
 * ========================================================================== */

/**
 * A parse diagnostic. Extends the engine's {@link TreeDiagnostic} with the evidence that
 * governs it, so a finding built from one can never be shown as more certain than the rule
 * behind it. Exported as `Diagnostic` because that is the name the workbench's parsers share.
 */
export interface SamlDiagnostic extends TreeDiagnostic {
  /** Structure member the diagnostic is about, when it is about one. */
  memberId?: string | null;
  /** Confidence of THAT member (or of the structure, for whole-message diagnostics). */
  confidence?: Confidence;
  /** Always false for saml-sso: no official sample exists to check anything against. */
  verifiedAgainstSample?: boolean;
  /** Why the confidence is what it is — verbatim from the compiled spec. */
  confidenceReason?: string | null;
  /** The Confluence page and verbatim quote behind the rule, where there is one. */
  provenance?: Provenance | null;
}

export type Diagnostic = SamlDiagnostic;

/**
 * Something the message contains that the compiled structure does not describe. Never an
 * error and never dropped: the node stays in the tree (so the message still round-trips) and
 * the fact is surfaced here as a finding.
 */
export interface UnknownElement {
  kind: "element" | "attribute" | "namespace-declaration" | "unmodelled-subtree";
  /** Qualified name exactly as written in the message. */
  name: string;
  /** Instance path of the unknown thing, e.g. `/samlp:Response[0]/x:Extra[0]`. */
  path: string;
  /** Instance path of its container. */
  parentPath: string;
  /** Id of the tree node — the content is kept, not discarded. */
  nodeId: string;
  /** Decoded value, for attributes and text-only elements. */
  value: string | null;
  loc: SourceLocation;
  /** How loudly to say it. `info` for namespace plumbing and unmodelled signature internals. */
  severity: Severity;
  reason: string;
  /** Structure member whose children were searched, when the container was recognised. */
  parentMemberId: string | null;
  /** Names the search considered, so an analyst can see the near-misses. */
  expected: string[];
  confidence?: Confidence;
  verifiedAgainstSample?: boolean;
}

/** What environment the message's three environment-dependent values point at. */
export interface SamlEnvironmentDetection {
  /** The variant axis this came from, e.g. `environment`. `null` when the structure has none. */
  axis: string | null;
  /** The single environment every value agreed on, or `null` when they do not agree. */
  value: string | null;
  status: "consistent" | "mixed" | "unrecognised" | "absent" | "no-axis";
  /** Per environment-dependent member: what was found and which environments it matches. */
  members: {
    memberId: string;
    path: string | null;
    actual: string | null;
    matches: string[];
    expected: Record<string, string>;
  }[];
}

export interface ParseOptions {
  /**
   * The environment the caller expects (`ONA` | `ONB` | `PROD`, from
   * `structure.variantAxis.values`). When given, a message pointing elsewhere is diagnosed.
   * When omitted, the environment is still DETECTED and disagreement between the three
   * endpoint values is still reported.
   */
  environment?: string | null;
  /** Forwarded to {@link resolveUsage} for members carrying conditional usage. */
  context?: VariantContext;
  /**
   * Keep whitespace-only text between elements as `text` nodes. Default `true`, and required
   * for byte-identical re-emission: turn it off and indentation is lost.
   */
  keepWhitespace?: boolean;
  /** Safety valve for pathological input. Default 500. */
  maxDiagnostics?: number;
  /** Id recorded on the tree. Defaults to `structure.id`. */
  structureId?: string | null;
}

export interface ParseResult {
  tree: StructureTree;
  diagnostics: Diagnostic[];
  unknown: UnknownElement[];
  /**
   * Which NPHIES environment the message's Destination / Recipient / Audience point at.
   * Extra to the three required fields; destructuring callers are unaffected.
   */
  environment: SamlEnvironmentDetection;
}

/** Stated in every signature-related finding, and in generated output. */
export const SAML_SIGNATURE_DISCLAIMER =
  "This tool checks only that a ds:Signature element is PRESENT and WHERE it sits. It performs no " +
  "canonicalisation, digest, certificate or cryptographic verification, and it never creates a signature. " +
  'NPHIES page 7766254 states only "Sign the Assertion way" and hands signing to an external tool ' +
  "(https://www.samltool.com/sign_response.php); no canonicalization method, digest method, transform, " +
  "reference URI convention or KeyInfo rule is published anywhere, so a signature check here would be " +
  "invented rather than evidenced — which is worse than no check at all.";

/* ========================================================================== *
 * XML text helpers — shared with the emitter so the two can never drift
 * ========================================================================== */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Resolve XML entity references. Unknown entities are left verbatim, never guessed at. */
export function decodeXmlText(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9._-]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const hit = NAMED_ENTITIES[body];
    return hit === undefined ? match : hit;
  });
}

/** Escape character data. */
export function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape an attribute value for the given quote character. */
export function escapeXmlAttribute(value: string, quote: '"' | "'" = '"'): string {
  const base = escapeXmlText(value).replace(/\r/g, "&#13;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
  return quote === '"' ? base.replace(/"/g, "&quot;") : base.replace(/'/g, "&apos;");
}

/* ========================================================================== *
 * Structure introspection — all of it data-driven
 * ========================================================================== */

/** The `attribute` of any locator kind that carries one (`cdaXPath` today). */
function locatorAttribute(locator: SpecLocator | null | undefined): string | null {
  if (!locator) return null;
  return "attribute" in locator && typeof locator.attribute === "string" ? locator.attribute : null;
}

function locatorPath(locator: SpecLocator | null | undefined): string | null {
  if (!locator) return null;
  return "path" in locator && typeof locator.path === "string" ? locator.path : null;
}

/** A structure member that addresses an XML attribute rather than an element. */
export function isAttributeMember(member: StructureMember): boolean {
  const locator = memberLocator(member);
  if (locatorAttribute(locator)) return true;
  return locator === null && member.label.startsWith("@");
}

function memberLocator(member: StructureMember): SpecLocator | null {
  if (member.kind === "group") return member.locator ?? null;
  if (member.kind === "segment") return null;
  return (member as StructureElement).locator ?? null;
}

/** `saml:Attribute[@Name="Organization-Id"]` -> name plus the predicates that pick it out. */
export function parseElementPath(path: string): { name: string; predicates: { attribute: string; value: string }[] } {
  const cleaned = path.replace(/^\.?\//, "").trim();
  const bracket = cleaned.indexOf("[");
  const name = (bracket === -1 ? cleaned : cleaned.slice(0, bracket)).trim();
  const predicates: { attribute: string; value: string }[] = [];
  if (bracket !== -1) {
    const re = /\[\s*@([A-Za-z_:][\w.:-]*)\s*=\s*(['"])(.*?)\2\s*\]/g;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(cleaned)) !== null) predicates.push({ attribute: hit[1], value: hit[3] });
  }
  return { name, predicates };
}

/** The qualified element name a member addresses, as the spec writes it. */
export function memberElementName(member: StructureMember): string | null {
  if (isAttributeMember(member)) return null;
  const path = locatorPath(memberLocator(member));
  if (path) return parseElementPath(path).name;
  return member.label.startsWith("@") ? null : parseElementPath(member.label).name;
}

/** The qualified attribute name a member addresses. */
export function memberAttributeName(member: StructureMember): string | null {
  if (!isAttributeMember(member)) return null;
  return locatorAttribute(memberLocator(member)) ?? member.label.replace(/^@/, "");
}

export function elementMembersOf(member: StructureMember | StructureGroup): StructureMember[] {
  return membersOf(member as StructureMember).filter((m) => !isAttributeMember(m));
}

export function attributeMembersOf(member: StructureMember | StructureGroup): StructureMember[] {
  return membersOf(member as StructureMember).filter(isAttributeMember);
}

/** The single pinned value on a member, or `null`. `environmentDependent` rules pin nothing. */
export function wholeFixedValue(member: StructureMember): string | null {
  const rules = (member as StructureElement).fixedValues ?? [];
  const valued = rules.filter((r) => r.value !== null && r.value !== undefined);
  return valued.length === 1 ? (valued[0].value as string) : null;
}

/** The variable-slot name a member fills, e.g. `Issuer name`. Extra field on the compiled member. */
export function variableSlotOf(member: StructureMember): string | null {
  const slot = (member as { variableSlot?: unknown }).variableSlot;
  return typeof slot === "string" ? slot : null;
}

/**
 * A member whose CONTENTS the spec deliberately does not model — today only `ds:Signature`,
 * which the compiled structure tags with `signaturePlacement`. Its children are parsed and
 * preserved but are not reported as unknown: NPHIES publishes no signature internals, so
 * calling them "unknown" would blame the hospital for the spec's silence.
 */
export function isOpaqueMember(member: StructureMember): boolean {
  return Boolean((member as { signaturePlacement?: unknown }).signaturePlacement);
}

/** Evidence attached to one member, for a finding to carry. */
export interface SamlEvidence {
  memberId: string | null;
  confidence: Confidence;
  verifiedAgainstSample: boolean;
  confidenceReason: string | null;
  provenance: Provenance | null;
  /** `literal-skeleton` or `prose` — which tier of the published page the rule came from. */
  sourceTier: string | null;
}

/** Evidence for a member id, falling back to the structure's own (always unverified) evidence. */
export function evidenceForMember(structure: MessageStructure, memberId: string | null): SamlEvidence {
  const fallback: SamlEvidence = {
    memberId,
    confidence: structure.confidence,
    verifiedAgainstSample: structure.verifiedAgainstSample === true,
    confidenceReason: structure.confidenceReason ?? null,
    provenance: null,
    sourceTier: null,
  };
  if (!memberId) return fallback;
  const member = indexMembers(structure).get(memberId)?.member;
  if (!member) return fallback;
  return {
    memberId,
    confidence: member.confidence ?? structure.confidence,
    verifiedAgainstSample: member.verifiedAgainstSample === true,
    confidenceReason: member.confidenceReason ?? null,
    provenance: member.provenance ?? null,
    sourceTier: typeof (member as { sourceTier?: unknown }).sourceTier === "string"
      ? ((member as { sourceTier?: string }).sourceTier as string)
      : null,
  };
}

interface MemberEntry {
  member: StructureMember;
  parent: StructureMember | StructureGroup;
  parentId: string;
  index: number;
}

const memberIndexCache = new WeakMap<MessageStructure, Map<string, MemberEntry>>();

/** id -> {member, parent, position}. Cached per structure; the bundle is immutable. */
export function indexMembers(structure: MessageStructure): Map<string, MemberEntry> {
  const hit = memberIndexCache.get(structure);
  if (hit) return hit;
  const map = new Map<string, MemberEntry>();
  const step = (parent: StructureMember | StructureGroup, parentId: string) => {
    const kids = membersOf(parent as StructureMember);
    kids.forEach((child, index) => {
      map.set(child.id, { member: child, parent, parentId, index });
      step(child, child.id);
    });
  };
  step(structure.root, structure.root.id);
  memberIndexCache.set(structure, map);
  return map;
}

/** The member the structure tags with `signaturePlacement`, if any. */
export function signatureMemberOf(structure: MessageStructure): MemberEntry | null {
  for (const entry of indexMembers(structure).values()) {
    if (isOpaqueMember(entry.member)) return entry;
  }
  return null;
}

/** Per-environment value for one member, from `structure.variantAxis`. */
export function environmentValueFor(
  structure: MessageStructure,
  memberId: string,
  environment: string | null | undefined,
): string | null {
  if (!environment) return null;
  const byMember = structure.variantAxis?.valuesByMember?.[environment];
  const hit = byMember?.[memberId];
  return hit && typeof hit.value === "string" ? hit.value : null;
}

/* ========================================================================== *
 * Source locations
 * ========================================================================== */

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
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
 * A span, in the geometry the UI's `Region` uses. `line`/`startCol`/`endCol` describe the
 * FIRST line of the span (a multi-line element highlights its opening line); `offset` and
 * `endOffset` carry the true, authoritative extent.
 */
function makeLoc(text: string, starts: number[], start: number, end: number): SourceLocation {
  const clampedStart = Math.max(0, Math.min(start, text.length));
  const clampedEnd = Math.max(clampedStart, Math.min(end, text.length));
  const li = lineOf(starts, clampedStart);
  const lineStart = starts[li];
  let lineEnd = li + 1 < starts.length ? starts[li + 1] - 1 : text.length;
  if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;
  const endOnLine = Math.min(clampedEnd, lineEnd);
  return {
    line: li + 1,
    startCol: clampedStart - lineStart,
    endCol: Math.max(clampedStart - lineStart, endOnLine - lineStart),
    offset: clampedStart,
    endOffset: clampedEnd,
  };
}

/* ========================================================================== *
 * Tolerant XML scanner
 * ========================================================================== */

interface RawAttr {
  name: string;
  rawValue: string;
  quote: '"' | "'" | "";
  raw: string;
  start: number;
  end: number;
  malformed: string | null;
}

type RawKind = "element" | "text" | "comment" | "pi" | "cdata" | "doctype";

interface RawNode {
  type: RawKind;
  name: string;
  attrs: RawAttr[];
  children: RawNode[];
  start: number;
  end: number;
  /** Offset just past the `>` of the open tag (elements only). */
  openEnd: number;
  /** Offset of the `<` of the close tag, or `null` when the element was never closed. */
  closeStart: number | null;
  selfClosing: boolean;
}

interface ScanDiagnostic {
  severity: Severity;
  code: string;
  message: string;
  start: number;
  end: number;
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-]/;

function scanName(text: string, i: number): number {
  if (i >= text.length || !NAME_START.test(text[i])) return i;
  let j = i + 1;
  while (j < text.length && NAME_CHAR.test(text[j])) j++;
  return j;
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

interface OpenTagScan {
  name: string;
  attrs: RawAttr[];
  /** Length of the open tag, from `<` through `>` / `/>`. */
  length: number;
  selfClosing: boolean;
  terminated: boolean;
}

/**
 * Scan one start tag beginning at `start` (which must point at `<`). Offsets in the returned
 * attributes are absolute. Exported because the emitter re-scans a node's own `raw` to
 * recover the exact open tag — including the author's inter-attribute whitespace — without
 * needing the original document.
 */
export function scanOpenTag(text: string, start = 0, report?: (d: ScanDiagnostic) => void): OpenTagScan {
  const nameEnd = scanName(text, start + 1);
  const name = text.slice(start + 1, nameEnd);
  const attrs: RawAttr[] = [];
  let i = nameEnd;
  let selfClosing = false;
  let terminated = false;
  let end = text.length;

  while (i < text.length) {
    while (i < text.length && isSpace(text[i])) i++;
    if (i >= text.length) break;
    if (text[i] === ">") {
      end = i + 1;
      terminated = true;
      break;
    }
    if (text[i] === "/" && text[i + 1] === ">") {
      selfClosing = true;
      end = i + 2;
      terminated = true;
      break;
    }
    if (text[i] === "<") break; // a new tag started: this one was never terminated

    const attrStart = i;
    const attrNameEnd = scanName(text, i);
    if (attrNameEnd === i) {
      report?.({
        severity: "error",
        code: "XML_UNEXPECTED_CHARACTER",
        message: `Unexpected "${text[i]}" inside the start tag <${name}>.`,
        start: i,
        end: i + 1,
      });
      i++;
      continue;
    }
    const attrName = text.slice(i, attrNameEnd);
    i = attrNameEnd;
    let j = i;
    while (j < text.length && isSpace(text[j])) j++;
    if (text[j] === "=") {
      j++;
      while (j < text.length && isSpace(text[j])) j++;
      const quote = text[j];
      if (quote === '"' || quote === "'") {
        const valueStart = j + 1;
        const valueEnd = text.indexOf(quote, valueStart);
        if (valueEnd === -1) {
          report?.({
            severity: "error",
            code: "XML_UNTERMINATED_ATTRIBUTE",
            message: `Attribute ${attrName} on <${name}> has no closing ${quote}.`,
            start: attrStart,
            end: text.length,
          });
          attrs.push({
            name: attrName,
            rawValue: text.slice(valueStart),
            quote,
            raw: text.slice(attrStart),
            start: attrStart,
            end: text.length,
            malformed: "unterminated value",
          });
          i = text.length;
          break;
        }
        i = valueEnd + 1;
        attrs.push({
          name: attrName,
          rawValue: text.slice(valueStart, valueEnd),
          quote,
          raw: text.slice(attrStart, i),
          start: attrStart,
          end: i,
          malformed: null,
        });
      } else {
        let valueEnd = j;
        while (valueEnd < text.length && !isSpace(text[valueEnd]) && text[valueEnd] !== ">") {
          if (text[valueEnd] === "/" && text[valueEnd + 1] === ">") break;
          valueEnd++;
        }
        report?.({
          severity: "error",
          code: "XML_UNQUOTED_ATTRIBUTE",
          message: `Attribute ${attrName} on <${name}> has an unquoted value; XML requires quotes.`,
          start: attrStart,
          end: valueEnd,
        });
        attrs.push({
          name: attrName,
          rawValue: text.slice(j, valueEnd),
          quote: "",
          raw: text.slice(attrStart, valueEnd),
          start: attrStart,
          end: valueEnd,
          malformed: "unquoted value",
        });
        i = valueEnd;
      }
    } else {
      report?.({
        severity: "error",
        code: "XML_VALUELESS_ATTRIBUTE",
        message: `Attribute ${attrName} on <${name}> has no value; XML has no valueless attributes.`,
        start: attrStart,
        end: attrNameEnd,
      });
      attrs.push({
        name: attrName,
        rawValue: "",
        quote: "",
        raw: attrName,
        start: attrStart,
        end: attrNameEnd,
        malformed: "no value",
      });
    }
  }

  if (!terminated) {
    report?.({
      severity: "error",
      code: "XML_UNTERMINATED_TAG",
      message: `The start tag <${name}> is never closed with ">".`,
      start,
      end: Math.min(i, text.length),
    });
    end = Math.min(i, text.length);
  }
  return { name, attrs, length: end - start, selfClosing, terminated };
}

/**
 * Scan a whole document into a tolerant node list. Never throws: every defect becomes a
 * diagnostic and the scan continues, and every byte of the input lands in exactly one node's
 * span so the emitter can put the document back together unchanged.
 */
function scanDocument(text: string, report: (d: ScanDiagnostic) => void): RawNode[] {
  const roots: RawNode[] = [];
  const stack: RawNode[] = [];
  const add = (node: RawNode) => {
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
  };
  const literal = (type: RawKind, start: number, end: number, name = "") => {
    add({ type, name, attrs: [], children: [], start, end, openEnd: end, closeStart: null, selfClosing: false });
  };

  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      literal("text", i, text.length);
      break;
    }
    if (lt > i) literal("text", i, lt);

    if (text.startsWith("<!--", lt)) {
      const close = text.indexOf("-->", lt + 4);
      const end = close === -1 ? text.length : close + 3;
      if (close === -1) {
        report({ severity: "error", code: "XML_UNTERMINATED_COMMENT", message: "A comment is never closed with -->.", start: lt, end });
      }
      literal("comment", lt, end);
      i = end;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const close = text.indexOf("]]>", lt + 9);
      const end = close === -1 ? text.length : close + 3;
      if (close === -1) {
        report({ severity: "error", code: "XML_UNTERMINATED_CDATA", message: "A CDATA section is never closed with ]]>.", start: lt, end });
      }
      literal("cdata", lt, end);
      i = end;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const close = text.indexOf("?>", lt + 2);
      const end = close === -1 ? text.length : close + 2;
      if (close === -1) {
        report({ severity: "error", code: "XML_UNTERMINATED_PI", message: "A processing instruction is never closed with ?>.", start: lt, end });
      }
      literal("pi", lt, end, text.slice(lt + 2, scanName(text, lt + 2)));
      i = end;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      let j = lt + 2;
      let depth = 0;
      while (j < text.length) {
        if (text[j] === "[") depth++;
        else if (text[j] === "]") depth--;
        else if (text[j] === ">" && depth <= 0) break;
        j++;
      }
      const end = j < text.length ? j + 1 : text.length;
      literal("doctype", lt, end);
      i = end;
      continue;
    }
    if (text.startsWith("</", lt)) {
      const nameEnd = scanName(text, lt + 2);
      const name = text.slice(lt + 2, nameEnd);
      let j = nameEnd;
      while (j < text.length && isSpace(text[j])) j++;
      let end: number;
      if (text[j] === ">") {
        end = j + 1;
      } else {
        const gt = text.indexOf(">", j);
        end = gt === -1 ? text.length : gt + 1;
        report({
          severity: "error",
          code: "XML_MALFORMED_END_TAG",
          message: `The end tag </${name}> is malformed.`,
          start: lt,
          end,
        });
      }

      let index = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name === name) {
          index = k;
          break;
        }
      }
      let caseOnly = false;
      if (index === -1) {
        const lower = name.toLowerCase();
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].name.toLowerCase() === lower) {
            index = k;
            caseOnly = true;
            break;
          }
        }
      }
      if (index === -1) {
        report({
          severity: "error",
          code: "XML_STRAY_END_TAG",
          message: `The end tag </${name}> closes nothing that is open here.`,
          start: lt,
          end,
        });
        literal("text", lt, end);
      } else {
        if (caseOnly) {
          report({
            severity: "error",
            code: "XML_TAG_CASE_MISMATCH",
            message: `</${name}> was matched to <${stack[index].name}>, which differs only in case. XML is case-sensitive, so this message is not well-formed.`,
            start: lt,
            end,
          });
        }
        for (let k = stack.length - 1; k > index; k--) {
          const orphan = stack[k];
          orphan.end = lt;
          orphan.closeStart = null;
          report({
            severity: "error",
            code: "XML_UNCLOSED_ELEMENT",
            message: `<${orphan.name}> is never closed; it was cut short by </${name}>.`,
            start: orphan.start,
            end: lt,
          });
        }
        const el = stack[index];
        el.closeStart = lt;
        el.end = end;
        stack.length = index;
      }
      i = end;
      continue;
    }

    const nameEnd = scanName(text, lt + 1);
    if (nameEnd === lt + 1) {
      report({
        severity: "error",
        code: "XML_STRAY_LT",
        message: 'A "<" that does not begin a tag must be written as &lt;.',
        start: lt,
        end: lt + 1,
      });
      literal("text", lt, lt + 1);
      i = lt + 1;
      continue;
    }
    const tag = scanOpenTag(text, lt, report);
    const node: RawNode = {
      type: "element",
      name: tag.name,
      attrs: tag.attrs,
      children: [],
      start: lt,
      end: lt + tag.length,
      openEnd: lt + tag.length,
      closeStart: null,
      selfClosing: tag.selfClosing,
    };
    add(node);
    if (!tag.selfClosing && tag.terminated) stack.push(node);
    i = lt + Math.max(tag.length, 1);
  }

  while (stack.length) {
    const orphan = stack.pop() as RawNode;
    orphan.end = text.length;
    orphan.closeStart = null;
    report({
      severity: "error",
      code: "XML_UNCLOSED_ELEMENT",
      message: `<${orphan.name}> is never closed.`,
      start: orphan.start,
      end: text.length,
    });
  }
  return roots;
}

/* ========================================================================== *
 * Matching message elements to structure members
 * ========================================================================== */

type MatchQuality = "exact" | "namespace" | "local-name" | "case-insensitive";

interface ElementCandidate {
  member: StructureMember;
  name: string;
  prefix: string | null;
  local: string;
  predicates: { attribute: string; value: string }[];
}

function splitQName(name: string): { prefix: string | null; local: string } {
  const colon = name.indexOf(":");
  return colon === -1 ? { prefix: null, local: name } : { prefix: name.slice(0, colon), local: name.slice(colon + 1) };
}

function predicatesHold(candidate: ElementCandidate, attrs: RawAttr[]): boolean {
  return candidate.predicates.every((p) =>
    attrs.some((a) => a.name === p.attribute && decodeXmlText(a.rawValue) === p.value),
  );
}

/* ========================================================================== *
 * parseSaml
 * ========================================================================== */

interface BuildContext {
  text: string;
  starts: number[];
  structure: MessageStructure;
  options: Required<Pick<ParseOptions, "keepWhitespace" | "maxDiagnostics">> & ParseOptions;
  diagnostics: Diagnostic[];
  unknown: UnknownElement[];
  truncated: boolean;
  /** memberId -> tree nodes, for the environment and signature checks. */
  byMember: Map<string, TreeNode[]>;
  /** Element name -> nodes, used to find a signature the structure did not place. */
  byElementName: Map<string, TreeNode[]>;
  signatureNodes: { node: TreeNode; parentPath: string; parentMemberId: string | null; siblingIndex: number }[];
}

function pushDiagnostic(ctx: BuildContext, diagnostic: Diagnostic): void {
  if (ctx.diagnostics.length >= ctx.options.maxDiagnostics) {
    if (!ctx.truncated) {
      ctx.truncated = true;
      ctx.diagnostics.push({
        severity: "info",
        code: "PARSE_DIAGNOSTICS_TRUNCATED",
        message: `More than ${ctx.options.maxDiagnostics} diagnostics; the rest were dropped. Fix the ones listed and parse again.`,
        loc: null,
      });
    }
    return;
  }
  ctx.diagnostics.push(diagnostic);
}

function withEvidence(ctx: BuildContext, diagnostic: Diagnostic, memberId: string | null): Diagnostic {
  const evidence = evidenceForMember(ctx.structure, memberId);
  return {
    ...diagnostic,
    memberId,
    confidence: evidence.confidence,
    verifiedAgainstSample: evidence.verifiedAgainstSample,
    confidenceReason: evidence.confidenceReason,
    provenance: evidence.provenance,
  };
}

/**
 * Parse a SAML SSO message against a compiled `saml-xml` {@link MessageStructure}.
 *
 * Never throws. Malformed input yields a partial tree plus diagnostics; content the
 * structure does not describe yields `unknown` entries and stays in the tree.
 */
export function parseSaml(text: string, structure: MessageStructure, opts?: ParseOptions): ParseResult {
  const options = {
    keepWhitespace: opts?.keepWhitespace !== false,
    maxDiagnostics: opts?.maxDiagnostics ?? 500,
    ...opts,
  } as BuildContext["options"];

  const starts = computeLineStarts(text);
  const ctx: BuildContext = {
    text,
    starts,
    structure,
    options,
    diagnostics: [],
    unknown: [],
    truncated: false,
    byMember: new Map(),
    byElementName: new Map(),
    signatureNodes: [],
  };

  // 1. The honesty banner. Always first, always present, whatever the message looks like.
  ctx.diagnostics.push({
    severity: "info",
    code: "SAML_UNVERIFIED_STRUCTURE",
    message:
      `Structure "${structure.id}" is confidence: ${structure.confidence}, verifiedAgainstSample: ` +
      `${structure.verifiedAgainstSample === true}. ` +
      (structure.confidenceReason ?? "") +
      (structure.notes.length ? ` Caveats: ${structure.notes.join(" ")}` : ""),
    loc: null,
    memberId: null,
    confidence: structure.confidence,
    verifiedAgainstSample: structure.verifiedAgainstSample === true,
    confidenceReason: structure.confidenceReason ?? null,
    provenance: structure.envelope?.kind === "samlResponse" && structure.envelope.specPage
      ? { pageId: structure.envelope.specPage.pageId, pageTitle: structure.envelope.specPage.pageTitle, row: null, quote: null }
      : null,
  });

  if (structure.encoding !== "saml-xml") {
    pushDiagnostic(ctx, {
      severity: "warn",
      code: "PARSER_ENCODING_MISMATCH",
      message: `parseSaml was given a structure whose encoding is "${structure.encoding}", not "saml-xml". Parsing continued, but the result may be meaningless.`,
      loc: null,
    });
  }

  const scanDiagnostics: ScanDiagnostic[] = [];
  const rawRoots = scanDocument(text, (d) => scanDiagnostics.push(d));
  for (const d of scanDiagnostics) {
    pushDiagnostic(ctx, {
      severity: d.severity,
      code: d.code,
      message: d.message,
      loc: makeLoc(text, starts, d.start, d.end),
    });
  }

  const rootNode: TreeNode = {
    id: "",
    kind: "message",
    label: structure.envelope?.kind === "samlResponse" ? (structure.envelope.rootElement ?? structure.title) : structure.title,
    locator: null,
    specNodeId: null,
    memberId: structure.root.id,
    occurrence: 0,
    value: null,
    // The message node reconstructs itself from its children; it holds no raw of its own,
    // so a round-trip is a real test of the tree rather than a copy of the input.
    raw: null,
    present: true,
    loc: makeLoc(text, starts, 0, text.length),
    children: [],
  };

  rootNode.children = buildChildren(ctx, rawRoots, "", structure.root, null, false);

  // Well-formedness at the document level: exactly one root element.
  const rootElements = rootNode.children.filter((c) => c.kind === "element");
  if (rootElements.length === 0) {
    pushDiagnostic(ctx, {
      severity: text.trim() ? "error" : "warn",
      code: text.trim() ? "XML_NO_ROOT_ELEMENT" : "XML_EMPTY_INPUT",
      message: text.trim() ? "No XML element was found in this message." : "The message is empty.",
      loc: makeLoc(text, starts, 0, Math.min(text.length, 1)),
    });
  } else if (rootElements.length > 1) {
    pushDiagnostic(ctx, {
      severity: "error",
      code: "XML_MULTIPLE_ROOTS",
      message: `An XML document has exactly one root element; this message has ${rootElements.length}.`,
      loc: rootElements[1].loc,
      nodeId: rootElements[1].id,
    });
  }

  const tree: StructureTree = {
    structureId: options.structureId ?? structure.id,
    useCaseId: structure.useCaseId,
    // `saml` is not a SpecFamily; StructureTree.family only admits one, so it stays null
    // rather than being mislabelled `cda` because the locators happen to be cdaXPath.
    family: null,
    encoding: "saml-xml",
    text,
    root: rootNode,
    diagnostics: ctx.diagnostics,
  };

  checkSignature(ctx);
  const environment = checkEnvironment(ctx);

  return { tree, diagnostics: ctx.diagnostics, unknown: ctx.unknown, environment };
}

/* --------------------------------------------------------------- building -- */

function buildChildren(
  ctx: BuildContext,
  raws: RawNode[],
  parentPath: string,
  parentMember: StructureMember | StructureGroup | null,
  parentMemberId: string | null,
  unmodelled: boolean,
): TreeNode[] {
  const out: TreeNode[] = [];
  const counters = new Map<string, number>();
  const usedMembers = new Map<string, number>();
  let lastMemberIndex = -1;

  const candidates: ElementCandidate[] = parentMember && !unmodelled
    ? elementMembersOf(parentMember).flatMap((member) => {
        const name = memberElementName(member);
        if (!name) return [];
        const path = locatorPath(memberLocator(member)) ?? member.label;
        const { predicates } = parseElementPath(path);
        const { prefix, local } = splitQName(name);
        return [{ member, name, prefix, local, predicates }];
      })
    : [];

  for (const raw of raws) {
    if (raw.type === "text") {
      const value = ctx.text.slice(raw.start, raw.end);
      if (!ctx.options.keepWhitespace && value.trim() === "") continue;
      out.push(makeLiteralNode(ctx, raw, parentPath, counters, "#text"));
      continue;
    }
    if (raw.type !== "element") {
      const label =
        raw.type === "comment"
          ? "#comment"
          : raw.type === "cdata"
            ? "#cdata"
            : raw.type === "doctype"
              ? "#doctype"
              : "#processing-instruction";
      out.push(makeLiteralNode(ctx, raw, parentPath, counters, label));
      continue;
    }

    const occurrence = counters.get(raw.name) ?? 0;
    counters.set(raw.name, occurrence + 1);
    const path = `${parentPath}/${raw.name}[${occurrence}]`;

    const match = matchElement(raw, candidates);
    if (match && match.quality !== "exact") reportNameMismatch(ctx, raw, match, path);
    if (!match && !unmodelled && parentMember) {
      ctx.unknown.push({
        kind: "element",
        name: raw.name,
        path,
        parentPath: parentPath || "/",
        nodeId: path,
        value: null,
        loc: makeLoc(ctx.text, ctx.starts, raw.start, raw.end),
        severity: "warn",
        reason:
          `<${raw.name}> is not described by structure "${ctx.structure.id}" at this position. It is kept in the tree ` +
          `and re-emitted unchanged, but nothing in the compiled spec governs it.`,
        parentMemberId,
        expected: candidates.map((c) => c.name),
        confidence: ctx.structure.confidence,
        verifiedAgainstSample: ctx.structure.verifiedAgainstSample === true,
      });
    }

    const member = match?.candidate.member ?? null;
    const memberId = member?.id ?? null;
    if (member) {
      const entry = indexMembers(ctx.structure).get(member.id);
      const used = usedMembers.get(member.id) ?? 0;
      usedMembers.set(member.id, used + 1);
      if (used > 0 && member.repeats === false) {
        pushDiagnostic(
          ctx,
          withEvidence(
            ctx,
            {
              severity: "error",
              code: "SAML_UNEXPECTED_REPEAT",
              message: `<${raw.name}> appears ${used + 1} times here; the structure allows one.`,
              loc: makeLoc(ctx.text, ctx.starts, raw.start, raw.end),
              nodeId: path,
            },
            member.id,
          ),
        );
      }
      if (entry) {
        if (entry.index < lastMemberIndex) {
          pushDiagnostic(
            ctx,
            withEvidence(
              ctx,
              {
                severity: "warn",
                code: "SAML_ELEMENT_OUT_OF_ORDER",
                message:
                  `<${raw.name}> appears after an element the published skeleton puts later. ` +
                  `The order comes from the literal skeleton on page 7766254, which is the only statement of it.`,
                loc: makeLoc(ctx.text, ctx.starts, raw.start, raw.end),
                nodeId: path,
              },
              member.id,
            ),
          );
        } else {
          lastMemberIndex = entry.index;
        }
      }
    }

    const opaque = member ? isOpaqueMember(member) : false;
    const childUnmodelled = unmodelled || opaque || !member;

    const node: TreeNode = {
      id: path,
      kind: "element",
      label: raw.name,
      locator: member
        ? memberLocator(member)
        : { kind: "cdaXPath", path: raw.name, relativeTo: parentPath || "/" },
      specNodeId: null, // saml-sso has no field tables, therefore no SpecNodes.
      memberId,
      occurrence,
      value: null,
      raw: ctx.text.slice(raw.start, raw.end),
      present: true,
      loc: makeLoc(ctx.text, ctx.starts, raw.start, raw.end),
      children: [],
    };

    node.children = buildAttributes(ctx, raw, node, member, memberId, childUnmodelled);

    const hasStructuredChildren = raw.children.some((c) => c.type !== "text");
    if (!hasStructuredChildren) {
      // Text-only element: the value lives on the element, with no #text child to duplicate
      // it. The emitter recovers the exact content span from `raw`.
      const contentStart = raw.closeStart ?? raw.end;
      // A self-closing element carries no character data at all, which is not the same
      // thing as carrying empty character data: `null` vs `""`.
      node.value = raw.selfClosing
        ? null
        : decodeXmlText(ctx.text.slice(raw.openEnd, Math.max(raw.openEnd, contentStart)));
    } else {
      node.children.push(...buildChildren(ctx, raw.children, path, member, memberId, childUnmodelled));
    }

    if (memberId) {
      const list = ctx.byMember.get(memberId) ?? [];
      list.push(node);
      ctx.byMember.set(memberId, list);
    }
    const byName = ctx.byElementName.get(raw.name) ?? [];
    byName.push(node);
    ctx.byElementName.set(raw.name, byName);

    if (opaque && member) {
      ctx.signatureNodes.push({ node, parentPath, parentMemberId, siblingIndex: out.length });
      ctx.unknown.push({
        kind: "unmodelled-subtree",
        name: raw.name,
        path,
        parentPath: parentPath || "/",
        nodeId: path,
        value: null,
        loc: makeLoc(ctx.text, ctx.starts, raw.start, raw.end),
        severity: "info",
        reason:
          `The contents of <${raw.name}> are deliberately NOT modelled: NPHIES publishes no signature internals. ` +
          SAML_SIGNATURE_DISCLAIMER,
        parentMemberId: member.id,
        expected: [],
        confidence: member.confidence ?? ctx.structure.confidence,
        verifiedAgainstSample: member.verifiedAgainstSample === true,
      });
    }

    out.push(node);
  }

  return out;
}

function makeLiteralNode(
  ctx: BuildContext,
  raw: RawNode,
  parentPath: string,
  counters: Map<string, number>,
  label: string,
): TreeNode {
  const occurrence = counters.get(label) ?? 0;
  counters.set(label, occurrence + 1);
  const text = ctx.text.slice(raw.start, raw.end);
  return {
    id: `${parentPath}/${label}[${occurrence}]`,
    kind: "text",
    label,
    locator: null,
    specNodeId: null,
    memberId: null,
    occurrence,
    value: label === "#text" ? decodeXmlText(text) : text,
    raw: text,
    present: true,
    loc: makeLoc(ctx.text, ctx.starts, raw.start, raw.end),
    children: [],
  };
}

function buildAttributes(
  ctx: BuildContext,
  raw: RawNode,
  element: TreeNode,
  member: StructureMember | null,
  memberId: string | null,
  unmodelled: boolean,
): TreeNode[] {
  const out: TreeNode[] = [];
  const attrMembers = member && !unmodelled ? attributeMembersOf(member) : [];
  const declared = new Map<string, string>();
  const envelopeNamespaces =
    ctx.structure.envelope?.kind === "samlResponse" ? ctx.structure.envelope.namespaces : [];
  for (const ns of envelopeNamespaces) declared.set(ns.prefix, ns.uri);

  const seen = new Map<string, number>();
  for (const attr of raw.attrs) {
    const occurrence = seen.get(attr.name) ?? 0;
    seen.set(attr.name, occurrence + 1);
    if (occurrence > 0) {
      pushDiagnostic(ctx, {
        severity: "error",
        code: "XML_DUPLICATE_ATTRIBUTE",
        message: `<${raw.name}> carries ${attr.name} more than once.`,
        loc: makeLoc(ctx.text, ctx.starts, attr.start, attr.end),
        nodeId: element.id,
      });
    }
    const id = occurrence === 0 ? `${element.id}/@${attr.name}` : `${element.id}/@${attr.name}[${occurrence}]`;
    const value = decodeXmlText(attr.rawValue);
    const loc = makeLoc(ctx.text, ctx.starts, attr.start, attr.end);

    let matched: StructureMember | null = null;
    let quality: MatchQuality | null = null;
    for (const candidate of attrMembers) {
      const name = memberAttributeName(candidate);
      if (!name) continue;
      if (name === attr.name) {
        matched = candidate;
        quality = "exact";
        break;
      }
      if (!matched && splitQName(name).local === splitQName(attr.name).local) {
        matched = candidate;
        quality = "local-name";
      }
      if (!matched && name.toLowerCase() === attr.name.toLowerCase()) {
        matched = candidate;
        quality = "case-insensitive";
      }
    }

    const node: TreeNode = {
      id,
      kind: "attribute",
      label: `@${attr.name}`,
      locator: matched
        ? memberLocator(matched)
        : { kind: "cdaXPath", path: raw.name, relativeTo: element.id, attribute: attr.name },
      specNodeId: null,
      memberId: matched?.id ?? null,
      occurrence,
      value,
      raw: attr.raw,
      present: true,
      loc,
      children: [],
    };
    out.push(node);

    if (matched) {
      const list = ctx.byMember.get(matched.id) ?? [];
      list.push(node);
      ctx.byMember.set(matched.id, list);
      if (quality && quality !== "exact") {
        pushDiagnostic(
          ctx,
          withEvidence(
            ctx,
            {
              severity: quality === "case-insensitive" ? "error" : "warn",
              code: quality === "case-insensitive" ? "SAML_ATTRIBUTE_CASE" : "SAML_ATTRIBUTE_PREFIX",
              message:
                quality === "case-insensitive"
                  ? `Attribute ${attr.name} differs from the published ${memberAttributeName(matched)} only in case. XML is case-sensitive.`
                  : `Attribute ${attr.name} was matched to ${memberAttributeName(matched)} by local name; the prefix differs from the published skeleton.`,
              loc: node.loc,
              nodeId: id,
            },
            matched.id,
          ),
        );
      }
      // A fixed value that does not hold is a structural defect worth naming here, because
      // it is the difference between "you built the envelope" and "you built something else".
      const fixed = wholeFixedValue(matched);
      if (fixed !== null && value !== fixed) {
        pushDiagnostic(
          ctx,
          withEvidence(
            ctx,
            {
              severity: "error",
              code: "SAML_FIXED_VALUE_MISMATCH",
              message: `${attr.name} is "${value}"; the published skeleton pins it to "${fixed}".`,
              loc: node.loc,
              nodeId: id,
            },
            matched.id,
          ),
        );
      }
      continue;
    }

    if (attr.name === "xmlns" || attr.name.startsWith("xmlns:")) {
      const prefix = attr.name === "xmlns" ? "" : attr.name.slice(6);
      const known = [...declared.entries()].find(([p, uri]) => p === prefix && uri === value);
      ctx.unknown.push({
        kind: "namespace-declaration",
        name: attr.name,
        path: id,
        parentPath: element.id,
        nodeId: id,
        value,
        loc,
        severity: known ? "info" : "warn",
        reason: known
          ? `Namespace declaration for the prefix "${prefix}", which the envelope declares with this same URI. The structure does not model it as a member at this position, so no rule governs it.`
          : `Namespace declaration for the prefix "${prefix}" bound to "${value}", which is not one of the ${envelopeNamespaces.length} namespaces the compiled envelope names. It is kept and re-emitted, but nothing in the spec covers it.`,
        parentMemberId: memberId,
        expected: envelopeNamespaces.map((ns) => (ns.prefix ? `xmlns:${ns.prefix}` : "xmlns")),
        confidence: ctx.structure.confidence,
        verifiedAgainstSample: ctx.structure.verifiedAgainstSample === true,
      });
      continue;
    }

    if (!unmodelled && member) {
      ctx.unknown.push({
        kind: "attribute",
        name: attr.name,
        path: id,
        parentPath: element.id,
        nodeId: id,
        value,
        loc,
        severity: "warn",
        reason: `<${raw.name}> carries an attribute ${attr.name} that structure "${ctx.structure.id}" does not describe.`,
        parentMemberId: memberId,
        expected: attrMembers.map((m) => memberAttributeName(m) ?? m.label),
        confidence: ctx.structure.confidence,
        verifiedAgainstSample: ctx.structure.verifiedAgainstSample === true,
      });
    }
  }
  return out;
}

function matchElement(
  raw: RawNode,
  candidates: ElementCandidate[],
): { candidate: ElementCandidate; quality: MatchQuality } | null {
  const { prefix, local } = splitQName(raw.name);
  const order: MatchQuality[] = ["exact", "namespace", "local-name", "case-insensitive"];
  const buckets = new Map<MatchQuality, ElementCandidate[]>();
  for (const candidate of candidates) {
    let quality: MatchQuality | null = null;
    if (candidate.name === raw.name) quality = "exact";
    else if (candidate.local === local && candidate.prefix !== prefix) quality = "local-name";
    else if (candidate.name.toLowerCase() === raw.name.toLowerCase()) quality = "case-insensitive";
    if (!quality) continue;
    if (!predicatesHold(candidate, raw.attrs)) continue;
    const list = buckets.get(quality) ?? [];
    list.push(candidate);
    buckets.set(quality, list);
  }
  for (const quality of order) {
    const list = buckets.get(quality);
    if (list && list.length) return { candidate: list[0], quality };
  }
  // Second pass: a name match whose predicates do NOT hold is still the right member to
  // report against — otherwise a wrong @Name value looks like an entirely unknown element.
  for (const candidate of candidates) {
    if (candidate.name === raw.name && candidate.predicates.length) {
      return { candidate, quality: "exact" };
    }
  }
  return null;
}

function reportNameMismatch(
  ctx: BuildContext,
  raw: RawNode,
  match: { candidate: ElementCandidate; quality: MatchQuality },
  path: string,
): void {
  const { quality, candidate } = match;
  if (quality === "case-insensitive") {
    pushDiagnostic(
      ctx,
      withEvidence(
        ctx,
        {
          severity: "error",
          code: "SAML_ELEMENT_CASE",
          message: `<${raw.name}> differs from the published <${candidate.name}> only in case. XML is case-sensitive, so NPHIES will not see this element.`,
          loc: makeLoc(ctx.text, ctx.starts, raw.start, raw.end),
          nodeId: path,
        },
        candidate.member.id,
      ),
    );
    return;
  }
  pushDiagnostic(
    ctx,
    withEvidence(
      ctx,
      {
        severity: "warn",
        code: "SAML_ELEMENT_PREFIX",
        message:
          `<${raw.name}> was matched to <${candidate.name}> by local name. A different prefix bound to the same ` +
          `namespace URI is legal XML, but the published skeleton on page 7766254 uses "${candidate.prefix ?? "(none)"}" ` +
          `— and since no official NPHIES sample exists, there is no evidence that their endpoint tolerates a different one.`,
        loc: makeLoc(ctx.text, ctx.starts, raw.start, raw.end),
        nodeId: path,
      },
      candidate.member.id,
    ),
  );
}

/* ----------------------------------------------------------- signature --- */

function checkSignature(ctx: BuildContext): void {
  const entry = signatureMemberOf(ctx.structure);
  if (!entry) return;
  const memberName = memberElementName(entry.member);
  const evidence = evidenceForMember(ctx.structure, entry.member.id);

  pushDiagnostic(
    ctx,
    withEvidence(
      ctx,
      {
        severity: "info",
        code: "SAML_SIGNATURE_NOT_VERIFIED",
        message: SAML_SIGNATURE_DISCLAIMER,
        loc: null,
      },
      entry.member.id,
    ),
  );

  const placed = ctx.signatureNodes;
  const byName = memberName ? (ctx.byElementName.get(memberName) ?? []) : [];
  const strays = byName.filter((n) => !placed.some((p) => p.node === n));

  if (!placed.length && !strays.length) {
    const usage = resolveUsage(entry.member, ctx.options.context);
    pushDiagnostic(
      ctx,
      withEvidence(
        ctx,
        {
          severity: "warn",
          code: "SAML_SIGNATURE_ABSENT",
          message:
            `No <${memberName ?? "ds:Signature"}> element is present. NPHIES requires a signed assertion ` +
            `(page 7766210: "Oracle IAM validate SAML signature"), but note the evidence: this member is ` +
            `confidence ${evidence.confidence}, derived from prose rather than the published skeleton — the skeleton ` +
            `itself is published "without signature tag". Usage resolution: ${usage.status}. ` +
            SAML_SIGNATURE_DISCLAIMER,
          loc: null,
        },
        entry.member.id,
      ),
    );
    return;
  }

  for (const stray of strays) {
    pushDiagnostic(
      ctx,
      withEvidence(
        ctx,
        {
          severity: "warn",
          code: "SAML_SIGNATURE_PLACEMENT",
          message:
            `<${stray.label}> sits at ${stray.id}, not inside the element the structure signs ` +
            `(${locatorPath(memberLocator(entry.member)) ?? "ds:Signature"} under ` +
            `"${(memberLocator(entry.member) as { relativeTo?: string } | null)?.relativeTo ?? "?"}"). ` +
            `Page 7766254 states only "Sign the Assertion way". ` +
            SAML_SIGNATURE_DISCLAIMER,
          loc: stray.loc,
          nodeId: stray.id,
        },
        entry.member.id,
      ),
    );
  }

  // Position INSIDE the signed element is explicitly not stated by NPHIES: the member's own
  // note says so. Report it as info, never as a violation.
  const note = (entry.member as StructureElement).note;
  for (const hit of placed) {
    if (note) {
      pushDiagnostic(
        ctx,
        withEvidence(
          ctx,
          {
            severity: "info",
            code: "SAML_SIGNATURE_POSITION_UNSTATED",
            message: `<${hit.node.label}> found at ${hit.node.id}. ${note}`,
            loc: hit.node.loc,
            nodeId: hit.node.id,
          },
          entry.member.id,
        ),
      );
    }
  }
}

/* --------------------------------------------------------- environment --- */

function checkEnvironment(ctx: BuildContext): SamlEnvironmentDetection {
  const axis = ctx.structure.variantAxis;
  if (!axis) return { axis: null, value: null, status: "no-axis", members: [] };

  const memberIds = new Set<string>();
  for (const value of axis.values) {
    for (const id of Object.keys(axis.valuesByMember[value] ?? {})) memberIds.add(id);
  }

  const members: SamlEnvironmentDetection["members"] = [];
  const perEnvironment = new Map<string, number>();
  let present = 0;

  for (const memberId of memberIds) {
    const expected: Record<string, string> = {};
    for (const value of axis.values) {
      const hit = axis.valuesByMember[value]?.[memberId];
      if (hit) expected[value] = hit.value;
    }
    const nodes = ctx.byMember.get(memberId) ?? [];
    const node = nodes[0] ?? null;
    const actual = node ? node.value : null;
    const matches = actual === null ? [] : Object.keys(expected).filter((env) => expected[env] === actual);
    if (node) present++;
    for (const env of matches) perEnvironment.set(env, (perEnvironment.get(env) ?? 0) + 1);
    members.push({ memberId, path: node?.id ?? null, actual, matches, expected });

    if (node && matches.length === 0) {
      pushDiagnostic(
        ctx,
        withEvidence(
          ctx,
          {
            severity: "warn",
            code: "SAML_ENVIRONMENT_UNRECOGNISED",
            message:
              `"${actual}" is not one of the ${axis.label} values NPHIES publishes ` +
              `(${Object.entries(expected).map(([k, v]) => `${k}: ${v}`).join("; ")}). ` +
              (axis.note ?? ""),
            loc: node.loc,
            nodeId: node.id,
          },
          memberId,
        ),
      );
    }
  }

  let status: SamlEnvironmentDetection["status"];
  let value: string | null = null;
  if (present === 0) status = "absent";
  else {
    const full = [...perEnvironment.entries()].filter(([, count]) => count === present);
    if (full.length === 1) {
      status = "consistent";
      value = full[0][0];
    } else if (perEnvironment.size === 0) {
      status = "unrecognised";
    } else {
      status = "mixed";
    }
  }

  if (status === "mixed") {
    pushDiagnostic(ctx, {
      severity: "error",
      code: "SAML_ENVIRONMENT_MIXED",
      message:
        `The ${axis.label} values do not agree: ` +
        members
          .filter((m) => m.actual !== null)
          .map((m) => `${m.memberId} -> ${m.actual} (${m.matches.join("/") || "no published environment"})`)
          .join("; ") +
        ". A message must point every one of these at the same environment.",
      loc: null,
      confidence: ctx.structure.confidence,
      verifiedAgainstSample: ctx.structure.verifiedAgainstSample === true,
      provenance: axis.provenance ?? null,
    });
  }

  const wanted = ctx.options.environment;
  if (wanted && value && wanted !== value) {
    pushDiagnostic(ctx, {
      severity: "error",
      code: "SAML_ENVIRONMENT_MISMATCH",
      message: `This message is addressed to the ${value} environment; the caller expected ${wanted}.`,
      loc: null,
      confidence: ctx.structure.confidence,
      verifiedAgainstSample: ctx.structure.verifiedAgainstSample === true,
      provenance: axis.provenance ?? null,
    });
  }

  return { axis: axis.axis, value, status, members };
}
