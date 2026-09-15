/**
 * FHIR R4 JSON parser for the NPHIES workbench.
 *
 * This module turns FHIR JSON text into the shared {@link StructureTree} that
 * `src/lib/emit/fhir.ts` turns back into text. The two are exact inverses: every lexical
 * detail the text carries — indentation, key order, the exact spelling of every token, even
 * the `//` comments four official NPHIES samples illegally contain — is recorded on the
 * tree, so `emitFhir(parseFhir(text).tree)` reproduces `text` byte for byte.
 *
 * Three rules govern everything here:
 *
 *  1. SPEC-DRIVEN, FORMAT-LEVEL. Nothing in this file knows what a prescription or a lab
 *     report is. It knows JSON, it knows the FHIR rule that an object carrying a
 *     `resourceType` string is a resource, and it knows how to read a compiled
 *     {@link MessageStructure}. A use case is data.
 *  2. NEVER THROW. Hospitals paste broken messages; that is the point of the tool. Every
 *     syntax error becomes a {@link Diagnostic} and the parser recovers and keeps going,
 *     returning whatever tree it could build.
 *  3. NEVER ASSERT WHAT CANNOT BE EVIDENCED. An element the compiled spec does not describe
 *     goes to `unknown` — it is a finding, not an error, and never silently dropped. Where
 *     the compiled spec offers two different rules for one path, this parser links NEITHER
 *     and records the candidates, because a confidently wrong structural verdict is worse
 *     than an acknowledged unknown.
 *
 * WHAT IS AND IS NOT CLAIMED HERE
 *  - Bundle family (`Bundle.type` + first entry) is checked against the structure's
 *    `bundleFamilyRule`, which carries verbatim Confluence quotes. The quote is put in the
 *    diagnostic message so the UI can show it. The family is NEVER inferred from the use
 *    case id.
 *  - Entry identity is `resourceType` + `meta.profile`, as the compiled entry lists define
 *    it. A row label is never treated as a resource type.
 *  - `unknown` is raised only where the compiled spec genuinely enumerates the level in
 *    question: bundle entries, top-level elements of a resource whose field table we have,
 *    and resources whose type has no field table at all. Sub-elements below the depth the
 *    tables reach are NOT called unknown, because the tables do not claim to enumerate them.
 *
 * SOURCE LOCATIONS. Every node carries `loc`. `line`/`startCol`/`endCol` use the UI's
 * single-line `Region` geometry (1-based line, 0-based inclusive start, 0-based exclusive
 * end); for a node spanning several lines `endCol` is the end of its FIRST line, and the
 * exact full span is always available as `offset`/`endOffset`.
 */

import type {
  MessageStructure,
  Provenance,
  SourceLocation,
  SpecLocator,
  SpecNode,
  StructureEntry,
  StructureMember,
  StructureTree,
  TreeDiagnostic,
  TreeNode,
  TreeNodeKind,
} from "../structure";
import { walkStructure } from "../structure";

/* ========================================================================== *
 * Public types
 * ========================================================================== */

/** A parser diagnostic. Deliberately the engine's shared type, not a parallel one. */
export type Diagnostic = TreeDiagnostic;

/** JSON value type of a tree node, needed to re-serialise a tree that never was text. */
export type JsonType = "object" | "array" | "string" | "number" | "boolean" | "null";

/**
 * Lexical detail of one node, recorded so emit can reproduce the source byte for byte.
 *
 * The pieces concatenate, in this order, to the exact source text of an object member:
 *
 *     sep + pre + keyRaw + preColon + colon + postColon + <value>
 *
 * an array item is `sep + pre + <value>`, and a container's value is
 *
 *     open + <children> + close + closeRaw
 *
 * `sep` is the trivia AND the comma that separated this member from the previous one (""
 * for the first). `close` is the trivia (plus any trailing comma) before the closing
 * bracket. `closeRaw` is "" when the input never closed the container — the malformed
 * official sample is reproduced as given, and the defect is reported as a diagnostic.
 * Trivia includes comments, so a `//`-commented sample also round-trips.
 */
export interface FhirFormat {
  sep: string;
  pre: string;
  keyRaw?: string;
  preColon?: string;
  /** The colon token as the source had it — `""` when the message omitted it. */
  colon?: string;
  postColon?: string;
  open?: string;
  close?: string;
  closeRaw?: string;
  /** Exact scalar token text, e.g. `"message"` (quotes included) or `1.5`. */
  tokenRaw?: string;
  /** Trailing document trivia. Root node only. */
  post?: string;
}

/**
 * A {@link TreeNode} with the FHIR-specific extras. Assignable to `TreeNode` everywhere, so
 * checkers and the UI need know nothing about it; emit uses `fmt` when it is there and
 * falls back to canonical serialisation when it is not (a tree built from a HIS extract).
 */
export interface FhirTreeNode extends TreeNode {
  fmt?: FhirFormat;
  jsonType?: JsonType;
  /**
   * Spec node ids that could govern this element when the compiled spec carries more than
   * one rule for the path AND those rules disagree. `specNodeId` is then null: picking one
   * would be a guess. Show these instead.
   */
  specCandidates?: string[];
  /** The resource type this node's path is relative to, e.g. `Bundle`, `MedicationRequest`. */
  resourceRoot?: string | null;
  children: FhirTreeNode[];
}

/** Something the message contains that the compiled spec does not describe. */
export interface UnknownElement {
  /** Instance path, e.g. `Bundle.entry[7].resource.extraField`. */
  path: string;
  /** Id of the tree node, so the UI can select it. */
  nodeId: string;
  label: string;
  /** What level this sits at — this is what says how strong the finding is. */
  kind: "entry" | "resource" | "element";
  locator: SpecLocator | null;
  loc: SourceLocation | null;
  /** The resource type the element belongs to. `null` at bundle level. */
  resourceType: string | null;
  /** Why it is unknown, in words safe to render in a finding row. */
  reason: string;
  /** First ~80 characters of the value, for the finding row. */
  valuePreview: string | null;
}

export interface ParseOptions {
  /**
   * Tolerate `//` and `/* *​/` comments. Comments are NOT valid JSON (RFC 8259) and four
   * official NPHIES medication samples carry them. Either way the parser skips them and
   * reports them: with this flag the report is a warning, without it an error. Nothing is
   * ever accepted silently.
   */
  allowComments?: boolean;
  /** Same treatment for a trailing comma before `}` or `]`. */
  allowTrailingCommas?: boolean;
  /**
   * Spec nodes to resolve element identity against — normally
   * `resolveUseCase(...).specNodes`, optionally widened with the resource field tables for
   * the use case's pages. A flat map is read in insertion order, which is the order
   * `indexSpecNodes` produced, because a row like `./id` states its resource only by
   * following the row that names it.
   */
  specNodes?: ReadonlyMap<string, SpecNode> | Iterable<SpecNode>;
  /** Cap on reported unknown elements (default 500). Truncation is itself a diagnostic. */
  maxUnknown?: number;
  /** Name of the file/paste, used in diagnostic text only. */
  sourceName?: string | null;
}

export interface ParseResult {
  tree: StructureTree;
  diagnostics: Diagnostic[];
  unknown: UnknownElement[];
}

/* ========================================================================== *
 * Shapes the compiler ships that `structure.ts` does not yet type
 * ========================================================================== */

/** The compiled two-family rule. Carries verbatim Confluence quotes. */
export interface BundleFamilyRule {
  bundleType?: string | null;
  firstEntryResourceType?: string | null;
  family?: string | null;
  evidenceStrength?: string | null;
  samplesChecked?: number | null;
  samplesConforming?: number | null;
  sources?: Provenance[] | null;
}

/** A resource that is CONTAINED or referenced rather than carried as a `Bundle.entry`. */
export interface NotEntryRule {
  resourceType?: string | null;
  reason?: string | null;
  confidence?: string | null;
  verifiedAgainstSample?: boolean;
  provenance?: Provenance | null;
}

export type FhirMessageStructure = MessageStructure & {
  bundleFamilyRule?: BundleFamilyRule | null;
  notEntries?: NotEntryRule[] | null;
};

/* ========================================================================== *
 * Path normalisation and the spec index
 * ========================================================================== */

/**
 * Canonical form of a FHIR element path, used as the key that joins an instance node to a
 * compiled {@link SpecNode}.
 *
 * The compiled spec writes paths several ways — `./meta/profile`, `./collection.bodySite`,
 * `./extension/url='http://…'` — and an instance path carries repetition indexes. This
 * folds all of that into one shape: no leading `./`, `/` separators, no `[n]`, and a
 * predicate value trimmed inside its quotes (two compiled rows carry a leading space there).
 * Text inside single quotes is never touched otherwise: a URL's dots are part of the URL.
 */
export function normalizeFhirPath(path: string): string {
  let s = String(path ?? "").trim();
  if (s.startsWith("./")) s = s.slice(2);
  else if (s.startsWith(".")) s = s.slice(1);

  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) {
        out += s.slice(i);
        i = s.length;
      } else {
        out += `'${s.slice(i + 1, end).trim()}'`;
        i = end + 1;
      }
      continue;
    }
    if (ch === "[") {
      const end = s.indexOf("]", i);
      if (end > i && /^\d*$/.test(s.slice(i + 1, end))) {
        i = end + 1;
        continue;
      }
    }
    out += ch === "." ? "/" : ch;
    i += 1;
  }
  return out.replace(/\/+/g, "/").replace(/^\/|\/$/g, "").trim();
}

/** True for a path that names a resource outright (`Bundle`), not an element (`./type`). */
function isResourcePath(path: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*$/.test(path.trim());
}

/**
 * The element paths one compiled location cell actually states.
 *
 * Two shapes in the compiled FHIR tables are not single paths: a trailing annotation the
 * spec author wrote beside the path (`./valueQuantity (DT = Qty)`) and two paths in one
 * cell (`./referenceRange/low ./referenceRange/high`). A FHIR element name contains no
 * space or parenthesis, so both are safe to split off — and neither is a rule being
 * changed, only a cell being read. A cell carrying a quoted predicate is never split,
 * because two compiled rows quote a URL with a space in it.
 */
function expandSpecPaths(raw: string): string[] {
  let s = String(raw ?? "").trim();
  if (!s) return [];
  s = s.replace(/\s*\([^()]*\)\s*$/, "").trim();
  if (!s) return [];
  const parts = s.includes("'") ? [s] : s.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const norm = normalizeFhirPath(part);
    if (norm && !/\s/.test(norm)) out.push(norm);
  }
  return out;
}

/** One key of the spec index: every compiled rule that claims this (resource, path). */
export interface FhirSpecIndexEntry {
  root: string;
  path: string;
  nodes: SpecNode[];
  /** False when the candidates state different rules — then nothing may be linked. */
  agree: boolean;
}

export interface FhirSpecIndex {
  /** `<resourceRoot>||<normalised path>` -> candidates. */
  byKey: Map<string, FhirSpecIndexEntry>;
  /** Lower-cased key -> canonical key, to catch a spelling defect rather than hide it. */
  byLowerKey: Map<string, string>;
  /**
   * Keys that are only ever an ANCESTOR of a compiled path — `Patient||meta` exists here
   * because the tables address `./meta/profile`. The container itself carries no rule, but
   * it is plainly described by the spec, so it must not be reported as unknown.
   */
  prefixes: Set<string>;
  /** Resource roots the supplied spec nodes actually describe. */
  roots: Set<string>;
  /** Top-level element order per resource root, as the field table lists it. */
  order: Map<string, string[]>;
  size: number;
}

/** The rule a node states, so two candidates can be compared without guessing. */
function ruleSignature(node: SpecNode): string {
  return JSON.stringify({
    u: (node.usage ?? []).map((r) => [r.usage, r.min, r.max, r.condition, r.validator]),
    r: node.role,
    f: (node.fixedValues ?? []).map((f) => [f.scope, f.target, f.value]),
    v: (node.valueSets ?? []).map((v) => v.valueSetId),
  });
}

function specNodeList(input: ParseOptions["specNodes"]): SpecNode[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: SpecNode[] = [];
  const push = (node: SpecNode) => {
    if (!node || seen.has(node.id)) return;
    seen.add(node.id);
    out.push(node);
    for (const child of node.children ?? []) push(child);
  };
  const iterable: Iterable<SpecNode> =
    input instanceof Map ? (input.values() as Iterable<SpecNode>) : (input as Iterable<SpecNode>);
  for (const node of iterable) push(node);
  return out;
}

/**
 * Index compiled FHIR spec nodes by (resource root, element path).
 *
 * Root resolution mirrors how the tables are written: a node states `relativeTo` when it
 * has one; otherwise the root is the last row that named a resource outright, because the
 * compiled tables list `Bundle` and then `./type`, `./entry` as its siblings.
 */
export function buildFhirSpecIndex(input: ParseOptions["specNodes"]): FhirSpecIndex {
  const byKey = new Map<string, FhirSpecIndexEntry>();
  const byLowerKey = new Map<string, string>();
  const prefixes = new Set<string>();
  const roots = new Set<string>();
  const order = new Map<string, string[]>();
  let currentRoot: string | null = null;

  for (const node of specNodeList(input)) {
    const locator = node.locator;
    if (!locator || locator.kind !== "fhirPath") continue;
    const rawPath = String(locator.path ?? "").trim();
    if (!rawPath) continue;

    if (!locator.relativeTo && isResourcePath(rawPath)) {
      currentRoot = rawPath;
      roots.add(currentRoot);
      if (!order.has(currentRoot)) order.set(currentRoot, []);
      const rootKey = `${currentRoot}||`;
      const existing = byKey.get(rootKey);
      if (existing) {
        if (!existing.nodes.some((x) => x.id === node.id)) {
          existing.nodes.push(node);
          existing.agree = new Set(existing.nodes.map(ruleSignature)).size === 1;
        }
      } else {
        byKey.set(rootKey, { root: currentRoot, path: "", nodes: [node], agree: true });
      }
      continue;
    }
    const root = locator.relativeTo ?? currentRoot;
    if (!root) continue;
    roots.add(root);
    if (!order.has(root)) order.set(root, []);

    const paths = expandSpecPaths(rawPath);
    for (const alt of node.altLocators ?? []) {
      if (alt.kind === "fhirPath" && alt.path) paths.push(...expandSpecPaths(alt.path));
    }
    for (const path of paths) {
      if (!path) continue;
      const key = `${root}||${path}`;
      const entry = byKey.get(key);
      if (entry) {
        if (!entry.nodes.some((n) => n.id === node.id)) {
          entry.nodes.push(node);
          entry.agree = new Set(entry.nodes.map(ruleSignature)).size === 1;
        }
      } else {
        byKey.set(key, { root, path, nodes: [node], agree: true });
      }
      const lower = key.toLowerCase();
      if (!byLowerKey.has(lower)) byLowerKey.set(lower, key);
      if (path && !path.includes("/")) {
        const list = order.get(root) as string[];
        if (!list.includes(path)) list.push(path);
      }
      const segments = path.split("/");
      for (let i = 1; i < segments.length; i++) prefixes.add(`${root}||${segments.slice(0, i).join("/")}`);
      if (segments.length > 1) {
        const list = order.get(root) as string[];
        if (!list.includes(segments[0])) list.push(segments[0]);
      }
    }
  }
  return { byKey, byLowerKey, prefixes, roots, order, size: byKey.size };
}

/* ========================================================================== *
 * Lexical layer: a JSON reader that records every byte and never throws
 * ========================================================================== */

interface JNode {
  type: JsonType | "missing";
  /** Start of the value token. */
  start: number;
  end: number;
  /** Start of the member's key token; equals `start` for array items and the root. */
  memberStart: number;
  key: string | null;
  fmt: FhirFormat;
  raw: string | null;
  value: string | null;
  children: JNode[];
  /** 0-based index among siblings that repeat the same key (duplicate keys are legal JSON). */
  occurrence: number;
}

const isWs = (c: string): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c === "﻿";

/** 0-based offsets of the first character of each line. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") starts.push(i + 1);
    else if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

function makeLocator(offsetToLine: (offset: number) => number, starts: number[], textLen: number, text: string) {
  return (start: number, end: number): SourceLocation => {
    const s = Math.max(0, Math.min(start, textLen));
    const e = Math.max(s, Math.min(end, textLen));
    const line = offsetToLine(s);
    const lineStart = starts[line - 1] ?? 0;
    const endLine = offsetToLine(e);
    let endCol: number;
    if (endLine === line) {
      endCol = e - lineStart;
    } else {
      // Region geometry is single-line: highlight to the end of the first line and let
      // offset/endOffset carry the true span.
      let stop = lineStart;
      while (stop < textLen && text[stop] !== "\n" && text[stop] !== "\r") stop++;
      endCol = stop - lineStart;
    }
    return { line, startCol: s - lineStart, endCol, offset: s, endOffset: e };
  };
}

interface LexResult {
  root: JNode | null;
  commentCount: number;
  firstComment: number | null;
  trailingCommaCount: number;
}

/**
 * Read JSON text into a lexical tree. Recovers from every malformation it can name, and
 * records enough detail that emit reproduces the input exactly — including the bytes it
 * complained about.
 */
function lexJson(
  text: string,
  opts: ParseOptions,
  diags: Diagnostic[],
  loc: (start: number, end: number) => SourceLocation,
): LexResult {
  const n = text.length;
  let p = 0;
  let commentCount = 0;
  let firstComment: number | null = null;
  let trailingCommaCount = 0;
  let recoveries = 0;
  const MAX_RECOVERY_DIAGNOSTICS = 50;

  const diag = (severity: Diagnostic["severity"], code: string, message: string, start: number, end: number) => {
    if (severity !== "error" && severity !== "warn") {
      diags.push({ severity, code, message, loc: loc(start, end) });
      return;
    }
    if (recoveries >= MAX_RECOVERY_DIAGNOSTICS) return;
    recoveries += 1;
    diags.push({ severity, code, message, loc: loc(start, end) });
    if (recoveries === MAX_RECOVERY_DIAGNOSTICS) {
      diags.push({
        severity: "info",
        code: "json/diagnostics-truncated",
        message: `More than ${MAX_RECOVERY_DIAGNOSTICS} JSON syntax problems; further ones are not listed. Fix these first and parse again.`,
        loc: loc(end, end),
      });
    }
  };

  /** Whitespace and comments. Comments are counted, never silently consumed. */
  const trivia = (): string => {
    const start = p;
    for (;;) {
      while (p < n && isWs(text[p])) p++;
      if (p + 1 < n && text[p] === "/" && (text[p + 1] === "/" || text[p + 1] === "*")) {
        const cstart = p;
        if (text[p + 1] === "/") {
          p += 2;
          while (p < n && text[p] !== "\n" && text[p] !== "\r") p++;
        } else {
          p += 2;
          const close = text.indexOf("*/", p);
          if (close < 0) {
            diag("error", "json/unterminated-comment", "Block comment is never closed.", cstart, n);
            p = n;
          } else {
            p = close + 2;
          }
        }
        commentCount += 1;
        if (firstComment === null) firstComment = cstart;
        continue;
      }
      break;
    }
    return text.slice(start, p);
  };

  const newNode = (type: JNode["type"], start: number): JNode => ({
    type,
    start,
    end: start,
    memberStart: start,
    key: null,
    fmt: { sep: "", pre: "" },
    raw: null,
    value: null,
    children: [],
    occurrence: 0,
  });

  const decodeString = (raw: string, at: number): string => {
    // `raw` includes the surrounding quotes when the string was terminated.
    let body = raw;
    if (body.startsWith('"')) body = body.slice(1);
    if (body.endsWith('"') && raw.length > 1) body = body.slice(0, -1);
    let out = "";
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c !== "\\") {
        out += c;
        continue;
      }
      const next = body[++i];
      switch (next) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = body.slice(i + 1, i + 5);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else {
            diag("error", "json/bad-unicode-escape", `Malformed \\u escape "\\u${hex}".`, at, at + raw.length);
            out += `\\u`;
          }
          break;
        }
        case undefined:
          diag("error", "json/trailing-backslash", "String ends with a lone backslash.", at, at + raw.length);
          out += "\\";
          break;
        default:
          diag("error", "json/bad-escape", `"\\${next}" is not a JSON escape sequence.`, at, at + raw.length);
          out += `\\${next}`;
      }
    }
    return out;
  };

  /** Consume a string token, tolerating an unterminated one. */
  const readStringToken = (): { raw: string; value: string; start: number; end: number } => {
    const start = p;
    p += 1; // opening quote
    let terminated = false;
    while (p < n) {
      const c = text[p];
      if (c === "\\") {
        p += 2;
        continue;
      }
      if (c === '"') {
        p += 1;
        terminated = true;
        break;
      }
      if (c === "\n" || c === "\r") break;
      p += 1;
    }
    if (p > n) p = n;
    if (!terminated) {
      diag("error", "json/unterminated-string", "String literal is not closed before the end of the line.", start, p);
    }
    const raw = text.slice(start, p);
    return { raw, value: decodeString(raw, start), start, end: p };
  };

  const parseString = (): JNode => {
    const token = readStringToken();
    const node = newNode("string", token.start);
    node.end = token.end;
    node.memberStart = token.start;
    node.raw = token.raw;
    node.value = token.value;
    node.fmt.tokenRaw = token.raw;
    return node;
  };

  const parseNumber = (): JNode => {
    const start = p;
    const re = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    re.lastIndex = p;
    const m = re.exec(text);
    let raw: string;
    if (m && m.index === p && m[0].length > 0) {
      raw = m[0];
      p += raw.length;
      // A number immediately followed by more number-ish characters (0x1F, 1.2.3, 007).
      while (p < n && /[0-9a-zA-Z.+_-]/.test(text[p])) p++;
      if (p > start + raw.length) {
        raw = text.slice(start, p);
        diag("error", "json/invalid-number", `"${raw}" is not a JSON number.`, start, p);
      }
    } else {
      while (p < n && /[0-9a-zA-Z.+_-]/.test(text[p])) p++;
      raw = text.slice(start, p);
      diag("error", "json/invalid-number", `"${raw}" is not a JSON number.`, start, p);
    }
    const node = newNode("number", start);
    node.end = p;
    node.raw = raw;
    node.value = raw;
    node.fmt.tokenRaw = raw;
    return node;
  };

  const parseLiteral = (): JNode => {
    const start = p;
    const rest = text.slice(p, p + 5);
    let type: JsonType = "null";
    let raw = "null";
    if (rest.startsWith("true")) {
      type = "boolean";
      raw = "true";
    } else if (rest.startsWith("false")) {
      type = "boolean";
      raw = "false";
    }
    p += raw.length;
    const node = newNode(type, start);
    node.end = p;
    node.raw = raw;
    node.value = type === "null" ? null : raw;
    node.fmt.tokenRaw = raw;
    return node;
  };

  /** Anything that cannot start a JSON value. Kept verbatim so the text still round-trips. */
  const parseGarbage = (): JNode => {
    const start = p;
    while (p < n && text[p] !== "," && text[p] !== "}" && text[p] !== "]" && text[p] !== "\n" && text[p] !== "\r") p++;
    if (p === start) p += 1;
    const raw = text.slice(start, p);
    diag("error", "json/unexpected-token", `Expected a JSON value, found ${JSON.stringify(raw.trim() || raw)}.`, start, p);
    const node = newNode("missing", start);
    node.end = p;
    node.raw = raw;
    node.value = raw;
    node.fmt.tokenRaw = raw;
    return node;
  };

  const parseValue = (): JNode => {
    if (p >= n) {
      diag("error", "json/unexpected-eof", "Message ends where a JSON value was expected.", n, n);
      const node = newNode("missing", n);
      node.raw = "";
      node.value = "";
      node.fmt.tokenRaw = "";
      return node;
    }
    const c = text[p];
    if (c === "{") return parseContainer("object");
    if (c === "[") return parseContainer("array");
    if (c === '"') return parseString();
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    if (text.startsWith("true", p) || text.startsWith("false", p) || text.startsWith("null", p)) return parseLiteral();
    return parseGarbage();
  };

  function parseContainer(kind: "object" | "array"): JNode {
    const start = p;
    const openChar = text[p];
    const closeChar = kind === "object" ? "}" : "]";
    const otherClose = kind === "object" ? "]" : "}";
    p += 1;

    const node = newNode(kind, start);
    node.fmt.open = openChar;
    node.fmt.close = "";
    node.fmt.closeRaw = closeChar;

    const seenKeys = new Map<string, number>();
    let sep = "";
    let pending = trivia();
    let expectMember = false;

    for (;;) {
      if (p >= n) {
        diag(
          "error",
          "json/unexpected-eof",
          `${kind === "object" ? "Object" : "Array"} is never closed before the end of the message.`,
          start,
          n,
        );
        node.fmt.close = sep + pending;
        node.fmt.closeRaw = "";
        break;
      }
      const c = text[p];

      if (c === closeChar) {
        if (expectMember) {
          trailingCommaCount += 1;
          diag(
            opts.allowTrailingCommas ? "warn" : "error",
            "json/trailing-comma",
            `Trailing comma before "${closeChar}". A trailing comma is not valid JSON (RFC 8259)${
              opts.allowTrailingCommas ? "; tolerated because allowTrailingCommas is set" : ""
            }.`,
            p - 1,
            p + 1,
          );
        }
        node.fmt.close = sep + pending;
        node.fmt.closeRaw = closeChar;
        p += 1;
        break;
      }

      if (c === otherClose) {
        // e.g. an object closed by "]" — the genuine malformation in one official sample.
        diag(
          "error",
          "json/unclosed-container",
          `${kind === "object" ? "Object" : "Array"} opened here is closed by "${otherClose}"; the "${closeChar}" is missing.`,
          start,
          p + 1,
        );
        node.fmt.close = sep + pending;
        node.fmt.closeRaw = ""; // reproduce the source: there is no token here
        break;
      }

      if (c === ",") {
        diag("error", "json/unexpected-comma", "Unexpected comma.", p, p + 1);
        pending += text[p];
        p += 1;
        pending += trivia();
        continue;
      }

      let child: JNode;
      if (kind === "object") {
        const memberStart = p;
        let keyRaw: string;
        let key: string;
        if (c === '"') {
          const token = readStringToken();
          keyRaw = token.raw;
          key = token.value;
        } else {
          const ks = p;
          while (p < n && text[p] !== ":" && text[p] !== "," && text[p] !== "}" && text[p] !== "\n" && text[p] !== "\r") p++;
          keyRaw = text.slice(ks, p);
          key = keyRaw.trim();
          if (text[p] === ":") {
            diag("error", "json/unquoted-key", `Property name ${JSON.stringify(key)} is not quoted.`, ks, p);
          } else {
            diag("error", "json/expected-key", `Expected a quoted property name, found ${JSON.stringify(keyRaw)}.`, ks, p);
            pending += keyRaw;
            continue;
          }
        }
        const preColon = trivia();
        let postColon = "";
        let colon = ":";
        if (text[p] === ":") {
          p += 1;
          postColon = trivia();
        } else {
          colon = ""; // reproduce the source, which has no colon here
          diag("error", "json/expected-colon", `Expected ":" after property name ${JSON.stringify(key)}.`, p, p + 1);
        }
        child = parseValue();
        child.key = key;
        child.memberStart = memberStart;
        child.fmt.keyRaw = keyRaw;
        child.fmt.preColon = preColon;
        child.fmt.colon = colon;
        child.fmt.postColon = postColon;
        const seen = seenKeys.get(key);
        if (seen === undefined) {
          seenKeys.set(key, 0);
        } else {
          child.occurrence = seen + 1;
          seenKeys.set(key, child.occurrence);
          diag(
            "warn",
            "json/duplicate-key",
            `Property ${JSON.stringify(key)} appears more than once in the same object. JSON permits it; FHIR does not — one of the two values will be ignored by any consumer.`,
            memberStart,
            child.end,
          );
        }
      } else {
        child = parseValue();
        child.occurrence = node.children.length;
        child.memberStart = child.start;
      }

      child.fmt.sep = sep;
      child.fmt.pre = pending;
      node.children.push(child);

      pending = trivia();
      sep = "";
      expectMember = false;
      if (p < n && text[p] === ",") {
        sep = pending + ",";
        pending = "";
        p += 1;
        pending = trivia();
        expectMember = true;
      } else if (p < n && text[p] !== closeChar && text[p] !== otherClose) {
        diag("error", "json/expected-comma", `Expected "," or "${closeChar}" here.`, p, p + 1);
      }
    }

    node.end = p;
    return node;
  }

  const leading = trivia();
  let root: JNode | null = null;
  if (p >= n) {
    diags.push({
      severity: "error",
      code: "json/empty",
      message: "The message is empty — there is nothing to parse.",
      loc: loc(0, n),
    });
  } else {
    root = parseValue();
    root.fmt.sep = "";
    root.fmt.pre = leading;
    const trailing = trivia();
    let extra = "";
    if (p < n) {
      extra = text.slice(p);
      diag(
        "error",
        "json/trailing-content",
        `${extra.trim().length > 40 ? `${extra.trim().slice(0, 40)}…` : extra.trim()} follows the end of the JSON document.`,
        p,
        n,
      );
      p = n;
    }
    root.fmt.post = trailing + extra;
  }

  if (commentCount > 0 && firstComment !== null) {
    diags.push({
      severity: opts.allowComments ? "warn" : "error",
      code: "json/comments",
      message:
        `${commentCount} comment${commentCount === 1 ? "" : "s"} found. Comments are NOT valid JSON (RFC 8259), so this text will be rejected by a strict FHIR parser` +
        (opts.allowComments
          ? "; tolerated here because allowComments is set, and reproduced verbatim on emit."
          : ". They were skipped so the rest of the message could still be checked; pass allowComments to downgrade this to a warning.") +
        " Four official NPHIES medication samples carry exactly this defect (see src/spec/sample-defects.json) — if this message came from one of them, the sample is broken, not your system.",
      loc: loc(firstComment, firstComment + 2),
    });
  }

  return { root, commentCount, firstComment, trailingCommaCount };
}

/* ========================================================================== *
 * Semantic layer: JSON -> StructureTree
 * ========================================================================== */

const fhirLocator = (path: string, relativeTo: string | null): SpecLocator | null =>
  path ? { kind: "fhirPath", path, ...(relativeTo ? { relativeTo } : {}) } : null;

function previewOf(node: JNode): string | null {
  if (node.type === "object") return "{…}";
  if (node.type === "array") return `[${node.children.length}]`;
  const raw = node.raw ?? node.value ?? "";
  return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
}

/** The `resourceType` of an object, when it has one. The one FHIR rule this file relies on. */
function resourceTypeOf(node: JNode): string | null {
  if (node.type !== "object") return null;
  for (const child of node.children) {
    if (child.key === "resourceType" && child.type === "string") return child.value;
  }
  return null;
}

function stringChild(node: JNode, key: string): JNode | null {
  if (node.type !== "object") return null;
  for (const child of node.children) if (child.key === key) return child;
  return null;
}

/** `meta.profile[*]` of a resource object, in source order. */
function profilesOf(resource: JNode): string[] {
  const meta = stringChild(resource, "meta");
  if (!meta || meta.type !== "object") return [];
  const profile = stringChild(meta, "profile");
  if (!profile) return [];
  if (profile.type === "array") {
    return profile.children.filter((c) => c.type === "string" && c.value !== null).map((c) => c.value as string);
  }
  if (profile.type === "string" && profile.value !== null) return [profile.value];
  return [];
}

const canonicalProfile = (url: string): string => url.trim().toLowerCase();
const profileBase = (url: string): string => canonicalProfile(url).split("|")[0];

function quoteOf(sources: Provenance[] | null | undefined): string {
  const first = (sources ?? []).find((s) => s && s.quote);
  if (!first) return "";
  const where = [first.pageId ? `page ${first.pageId}` : null, first.row ?? null].filter(Boolean).join(" ");
  return ` NPHIES: “${first.quote}”${where ? ` (${where})` : ""}.`;
}

interface BuildCtx {
  structure: FhirMessageStructure;
  index: FhirSpecIndex;
  diags: Diagnostic[];
  unknown: UnknownElement[];
  unknownCap: number;
  unknownTruncated: boolean;
  loc: (start: number, end: number) => SourceLocation;
  entryMembers: StructureEntry[];
  entryUse: Map<string, number>;
  elementMembers: Map<string, StructureMember[]>;
  notEntries: Map<string, NotEntryRule>;
  ambiguousReported: Set<string>;
}

function addUnknown(ctx: BuildCtx, item: UnknownElement): void {
  if (ctx.unknown.length >= ctx.unknownCap) {
    if (!ctx.unknownTruncated) {
      ctx.unknownTruncated = true;
      ctx.diags.push({
        severity: "info",
        code: "fhir/unknown-truncated",
        message: `More than ${ctx.unknownCap} elements are not described by the compiled spec; the list was truncated. Raise maxUnknown to see the rest.`,
        loc: item.loc,
      });
    }
    return;
  }
  ctx.unknown.push(item);
}

/** `valueQuantity` -> the compiled `value` row, when such a row exists. */
function choiceBaseKey(ctx: BuildCtx, root: string, normal: string): { key: string; base: string } | null {
  const segments = normal.split("/");
  const last = segments[segments.length - 1];
  const m = /^([a-z][A-Za-z0-9]*?)([A-Z][A-Za-z0-9]*)$/.exec(last);
  if (!m) return null;
  const base = [...segments.slice(0, -1), m[1]].join("/");
  const key = `${root}||${base}`;
  return ctx.index.byKey.has(key) ? { key, base } : null;
}

/** Resolve one instance path against the compiled spec, without ever guessing. */
function resolveSpec(
  ctx: BuildCtx,
  root: string | null,
  path: string,
  node: FhirTreeNode,
): "linked" | "ambiguous" | "container" | "none" | "no-root" {
  if (!root) return "no-root";
  const normal = normalizeFhirPath(path);
  const key = `${root}||${normal}`;
  let entry = ctx.index.byKey.get(key);
  if (!entry) {
    const viaLower = ctx.index.byLowerKey.get(key.toLowerCase());
    if (viaLower && viaLower !== key) {
      entry = ctx.index.byKey.get(viaLower);
      if (entry) {
        ctx.diags.push({
          severity: "info",
          code: "fhir/spelling-differs",
          message: `The message spells this element "${key.split("||")[1]}"; the compiled spec spells it "${entry.path}". Matched case-insensitively — confirm which spelling NPHIES accepts before relying on the rule attached here.`,
          loc: node.loc,
          nodeId: node.id,
        });
      }
    }
  }
  if (!entry) {
    // FHIR choice elements: the tables address `./value`, the wire writes `valueQuantity`.
    // The naming rule is HL7's, not a guess about what NPHIES meant — but say so once.
    const choice = choiceBaseKey(ctx, root, normal);
    if (choice) {
      entry = ctx.index.byKey.get(choice.key);
      if (entry && !ctx.ambiguousReported.has(`choice:${choice.key}`)) {
        ctx.ambiguousReported.add(`choice:${choice.key}`);
        ctx.diags.push({
          severity: "info",
          code: "fhir/choice-element",
          message: `${root} "${normal}" was matched to the compiled row for "${choice.base}". FHIR R4 names a choice element by appending its datatype (value[x] -> valueQuantity); the compiled table states the base path only.`,
          loc: node.loc,
          nodeId: node.id,
        });
      }
    }
  }
  if (!entry) return ctx.index.prefixes.has(key) ? "container" : "none";
  if (!entry.agree) {
    node.specCandidates = entry.nodes.map((s) => s.id);
    if (!ctx.ambiguousReported.has(key)) {
      ctx.ambiguousReported.add(key);
      const pages = [...new Set(entry.nodes.map((s) => s.provenance?.pageId ?? "?"))].join(", ");
      ctx.diags.push({
        severity: "info",
        code: "fhir/spec-mapping-ambiguous",
        message: `The compiled spec carries ${entry.nodes.length} different rules for ${entry.root} ${entry.path} (pages ${pages}) and they disagree. No rule was attached to this element: picking one would be a guess. Candidates: ${entry.nodes
          .map((s) => s.id)
          .join(", ")}.`,
        loc: node.loc,
        nodeId: node.id,
      });
    }
    return "ambiguous";
  }
  node.specNodeId = entry.nodes[0].id;
  node.spec = entry.nodes[0];
  if (entry.nodes.length > 1) node.specCandidates = entry.nodes.map((s) => s.id);
  return "linked";
}

interface WalkCtx {
  /** Resource type the path is relative to. */
  root: string | null;
  /** Path segments below that resource, e.g. ["identifier[0]", "value"]. */
  path: string[];
  /** Id prefix for children; also the instance path shown in findings. */
  idPrefix: string;
  /** Depth 0 = a direct child of a resource root: the level the field tables enumerate. */
  depthInResource: number;
  /** Set when this subtree sits under something already reported unknown. */
  suppressed: boolean;
  /** Set when there is no compiled field table for the enclosing resource type. */
  rootUnknown: boolean;
  /** True when this subtree is the Bundle itself (entries live here). */
  inBundleRoot: boolean;
}

function kindFor(json: JNode, isResource: boolean, isEntry: boolean): TreeNodeKind {
  if (isEntry) return "entry";
  if (isResource) return "resource";
  if (json.type === "array") return "element";
  if (json.key === null) return "repetition";
  return "element";
}

function buildNode(ctx: BuildCtx, json: JNode, walk: WalkCtx): FhirTreeNode {
  const isArrayItem = json.key === null && walk.path.length > 0;
  const segment = json.key !== null ? json.key : "";
  const path = json.key !== null ? [...walk.path, segment] : walk.path;
  const declaredType = resourceTypeOf(json);
  const isResource = declaredType !== null && walk.path.length > 0;
  const isEntry =
    walk.inBundleRoot &&
    json.key === null &&
    walk.path.length === 1 &&
    walk.path[0].replace(/\[\d+\]$/, "") === "entry";

  const id = json.key !== null ? `${walk.idPrefix}.${segment}` : `${walk.idPrefix}[${json.occurrence}]`;
  const relPath = path.length ? `./${path.join("/")}` : ".";
  const node: FhirTreeNode = {
    id,
    kind: kindFor(json, isResource, isEntry),
    label: declaredType ?? (json.key !== null ? segment : `[${json.occurrence}]`),
    locator: fhirLocator(relPath, walk.root),
    specNodeId: null,
    memberId: null,
    occurrence: json.occurrence,
    value: json.type === "object" || json.type === "array" ? null : json.value,
    raw: json.type === "object" || json.type === "array" ? null : json.raw,
    present: true,
    loc: ctx.loc(json.memberStart, json.end),
    children: [],
    fmt: json.fmt,
    jsonType: json.type === "missing" ? "string" : json.type,
    resourceRoot: walk.root,
  };

  // --- identity against the compiled spec -------------------------------------------
  let mappingStatus: "linked" | "ambiguous" | "container" | "none" | "no-root" = "no-root";
  if (!isArrayItem || isEntry) {
    mappingStatus = resolveSpec(ctx, walk.root, relPath, node);
  } else {
    // Array items: an extension item is addressed by its `url` in the compiled tables.
    const parentKey = walk.path[walk.path.length - 1]?.replace(/\[\d+\]$/, "") ?? "";
    const url = /extension$/i.test(parentKey) ? stringChild(json, "url") : null;
    if (url && url.type === "string" && url.value) {
      mappingStatus = resolveSpec(ctx, walk.root, `${relPath}/url='${url.value.trim()}'`, node);
    }
    if (mappingStatus !== "linked" && mappingStatus !== "ambiguous") {
      mappingStatus = resolveSpec(ctx, walk.root, relPath, node);
    }
  }

  // Bundle-level structure members (Bundle.type, Bundle.entry, …).
  if (walk.inBundleRoot && json.key !== null) {
    const members = ctx.elementMembers.get(normalizeFhirPath(relPath));
    if (members && members.length === 1) node.memberId = members[0].id;
  }

  // --- entries -----------------------------------------------------------------------
  if (isEntry) {
    linkEntry(ctx, node, json);
  }

  // --- unknown reporting --------------------------------------------------------------
  let suppressed = walk.suppressed;
  let rootUnknown = walk.rootUnknown;

  if (isResource && !isEntry) {
    const resourceKnown = declaredType !== null && ctx.index.roots.has(declaredType);
    if (!resourceKnown && !walk.suppressed && ctx.index.size > 0) {
      rootUnknown = true;
      addUnknown(ctx, {
        path: id,
        nodeId: id,
        label: declaredType ?? "(no resourceType)",
        kind: "resource",
        locator: node.locator,
        loc: node.loc,
        resourceType: declaredType,
        reason: declaredType
          ? `No compiled field table describes resource type "${declaredType}" among the spec nodes supplied for ${ctx.structure.id}. Its elements were parsed but nothing here can say whether they are right.`
          : "This object has no resourceType, so nothing identifies which FHIR resource it is.",
        valuePreview: previewOf(json),
      });
    } else if (resourceKnown) {
      rootUnknown = false;
    }
  }

  if (
    !walk.suppressed &&
    !walk.rootUnknown &&
    !isEntry &&
    json.key !== null &&
    walk.depthInResource === 0 &&
    walk.root !== null &&
    ctx.index.roots.has(walk.root) &&
    mappingStatus === "none" &&
    segment !== "resourceType"
  ) {
    suppressed = true;
    addUnknown(ctx, {
      path: id,
      nodeId: id,
      label: segment,
      kind: "element",
      locator: node.locator,
      loc: node.loc,
      resourceType: walk.root,
      reason: `"${segment}" is not listed in the compiled ${walk.root} field table for ${ctx.structure.id}. It may be legal FHIR that NPHIES does not describe, or a typo — the compiled spec cannot settle it.`,
      valuePreview: previewOf(json),
    });
  }

  // --- children ------------------------------------------------------------------------
  const nextRoot = isResource ? declaredType : walk.root;
  const nextPath = isResource ? [] : path;
  const nextDepth = isResource ? 0 : json.key !== null ? walk.depthInResource + 1 : walk.depthInResource;

  for (const child of json.children) {
    const childPath =
      child.key === null
        ? nextPath.length
          ? [...nextPath.slice(0, -1), `${nextPath[nextPath.length - 1]}[${child.occurrence}]`]
          : []
        : nextPath;
    node.children.push(
      buildNode(ctx, child, {
        root: nextRoot,
        path: childPath,
        idPrefix: id,
        depthInResource: nextDepth,
        suppressed,
        rootUnknown,
        // Entering a nested resource leaves the bundle's own element space.
        inBundleRoot: isResource ? false : walk.inBundleRoot,
      }),
    );
  }

  return node;
}

/** Match one parsed `Bundle.entry` to a compiled entry member by resourceType + profile. */
function linkEntry(ctx: BuildCtx, node: FhirTreeNode, json: JNode): void {
  const resourceNode = stringChild(json, "resource");
  const resource = resourceNode && resourceNode.type === "object" ? resourceNode : null;
  const rt = resource ? resourceTypeOf(resource) : null;
  const profiles = resource ? profilesOf(resource) : [];
  node.label = rt ? `entry → ${rt}` : "entry";

  if (!resource) {
    addUnknown(ctx, {
      path: node.id,
      nodeId: node.id,
      label: "entry",
      kind: "entry",
      locator: node.locator,
      loc: node.loc,
      resourceType: null,
      reason: "This bundle entry carries no `resource` object, so nothing identifies what it is.",
      valuePreview: previewOf(json),
    });
    return;
  }
  if (!rt) {
    addUnknown(ctx, {
      path: node.id,
      nodeId: node.id,
      label: "entry",
      kind: "entry",
      locator: node.locator,
      loc: node.loc,
      resourceType: null,
      reason: "The entry's resource has no `resourceType`, so its identity cannot be established.",
      valuePreview: previewOf(json),
    });
    return;
  }

  const byType = ctx.entryMembers.filter((m) => m.resourceType === rt);
  const byTypeLoose =
    byType.length > 0 ? byType : ctx.entryMembers.filter((m) => (m.resourceType ?? "").toLowerCase() === rt.toLowerCase());

  if (byTypeLoose.length === 0) {
    const notEntry = ctx.notEntries.get(rt) ?? ctx.notEntries.get(rt.toLowerCase());
    addUnknown(ctx, {
      path: node.id,
      nodeId: node.id,
      label: rt,
      kind: "entry",
      locator: node.locator,
      loc: node.loc,
      resourceType: rt,
      reason: notEntry
        ? `"${rt}" is listed by the compiled structure as NOT a bundle entry: ${notEntry.reason ?? "carried as a contained/referenced resource."}`
        : `The compiled structure for ${ctx.structure.id} lists no entry of type "${rt}"${
            profiles.length ? ` (profile ${profiles.join(", ")})` : ""
          }.`,
      valuePreview: previewOf(json),
    });
    return;
  }

  const profileHit = (m: StructureEntry): "exact" | "base" | null => {
    const pinned = m.profile ? canonicalProfile(m.profile) : null;
    if (!pinned) return null;
    for (const p of profiles) {
      if (canonicalProfile(p) === pinned) return "exact";
    }
    for (const p of profiles) {
      if (profileBase(p) === profileBase(pinned)) return "base";
    }
    return null;
  };

  const exact = byTypeLoose.filter((m) => profileHit(m) === "exact");
  const base = byTypeLoose.filter((m) => profileHit(m) === "base");
  let chosen: StructureEntry | null = null;

  if (exact.length === 1) {
    chosen = exact[0];
  } else if (exact.length > 1) {
    chosen = pickUnused(ctx, exact);
  } else if (base.length === 1) {
    chosen = base[0];
    ctx.diags.push({
      severity: "warn",
      code: "fhir/entry-profile-version",
      message: `Entry resource ${rt} declares profile ${profiles.join(", ") || "(none)"}; the compiled structure pins ${chosen.profile}. Matched on the base URL only — the version suffix differs.`,
      loc: node.loc,
      nodeId: node.id,
    });
  } else if (byTypeLoose.length === 1) {
    chosen = byTypeLoose[0];
    if (chosen.profile) {
      ctx.diags.push({
        severity: profiles.length ? "warn" : "info",
        code: "fhir/entry-profile-mismatch",
        message: profiles.length
          ? `Entry resource ${rt} declares profile ${profiles.join(", ")}; the compiled structure pins ${chosen.profile}. Matched by resourceType alone.`
          : `Entry resource ${rt} declares no meta.profile; the compiled structure pins ${chosen.profile}. Matched by resourceType alone.`,
        loc: node.loc,
        nodeId: node.id,
      });
    }
  } else {
    chosen = pickUnused(ctx, byTypeLoose);
    ctx.diags.push({
      severity: "info",
      code: "fhir/entry-match-ambiguous",
      message: `${byTypeLoose.length} compiled entries have resourceType ${rt} and none of their profiles matches ${
        profiles.length ? profiles.join(", ") : "the entry's (absent) meta.profile"
      }. Linked to ${chosen.id} by position; treat the link as provisional.`,
      loc: node.loc,
      nodeId: node.id,
    });
  }

  if (byType.length === 0 && byTypeLoose.length > 0) {
    ctx.diags.push({
      severity: "warn",
      code: "fhir/resourcetype-case",
      message: `The message spells the resource type "${rt}"; the compiled structure spells it "${byTypeLoose[0].resourceType}". FHIR resource type names are case-sensitive.`,
      loc: node.loc,
      nodeId: node.id,
    });
  }

  node.memberId = chosen.id;
  node.occurrence = ctx.entryUse.get(chosen.id) ?? 0;
  ctx.entryUse.set(chosen.id, node.occurrence + 1);
  node.label = `entry → ${rt}`;
}

function pickUnused(ctx: BuildCtx, candidates: StructureEntry[]): StructureEntry {
  for (const c of candidates) {
    if ((ctx.entryUse.get(c.id) ?? 0) === 0) return c;
  }
  return candidates[0];
}

/* ========================================================================== *
 * parseFhir
 * ========================================================================== */

/**
 * Parse FHIR R4 JSON against a compiled {@link MessageStructure}.
 *
 * Never throws. On malformed input it returns the partial tree it managed to build plus
 * diagnostics describing every defect it found, because pinpointing the defect in a broken
 * message is the whole job.
 */
export function parseFhir(text: string, structure: MessageStructure, opts: ParseOptions = {}): ParseResult {
  const source = String(text ?? "");
  const diagnostics: Diagnostic[] = [];
  const unknown: UnknownElement[] = [];
  const struct = structure as FhirMessageStructure;

  const starts = lineStarts(source);
  const offsetToLine = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const loc = makeLocator(offsetToLine, starts, source.length, source);

  const emptyRoot = (): FhirTreeNode => ({
    id: "Bundle",
    kind: "message",
    label: structure?.title ?? "Bundle",
    locator: { kind: "fhirPath", path: "Bundle" },
    specNodeId: null,
    memberId: structure?.root?.id ?? null,
    occurrence: 0,
    value: null,
    raw: null,
    present: false,
    loc: loc(0, source.length),
    children: [],
    jsonType: "object",
  });

  const tree: StructureTree = {
    structureId: structure?.id ?? null,
    useCaseId: structure?.useCaseId ?? null,
    family: "fhir",
    encoding: "fhir-json",
    text: source,
    root: emptyRoot(),
    diagnostics,
  };

  try {
    const lexed = lexJson(source, opts, diagnostics, loc);
    if (!lexed.root) {
      // Nothing parseable. The root still stands for the whole text, so an emit of this
      // tree returns exactly what was pasted rather than inventing an empty object.
      (tree.root as FhirTreeNode).fmt = { sep: "", pre: source, open: "", close: "", closeRaw: "", post: "" };
      return { tree, diagnostics, unknown };
    }

    const index = buildFhirSpecIndex(opts.specNodes);
    if (index.size === 0) {
      diagnostics.push({
        severity: "info",
        code: "fhir/no-spec-nodes",
        message:
          "No compiled spec nodes were supplied, so element-level identity was not resolved and no element is reported as unknown. Entry-level checks still ran against the compiled structure.",
        loc: null,
      });
    }

    const entryMembers: StructureEntry[] = [];
    const elementMembers = new Map<string, StructureMember[]>();
    if (structure) {
      walkStructure(structure, (member) => {
        if (member.kind === "entry") {
          entryMembers.push(member);
          return;
        }
        const locator = "locator" in member ? member.locator : null;
        if (locator && locator.kind === "fhirPath" && locator.path) {
          const key = normalizeFhirPath(locator.path);
          const list = elementMembers.get(key);
          if (list) list.push(member);
          else elementMembers.set(key, [member]);
        }
      });
    }

    const notEntries = new Map<string, NotEntryRule>();
    for (const rule of struct.notEntries ?? []) {
      if (rule?.resourceType) {
        notEntries.set(rule.resourceType, rule);
        notEntries.set(rule.resourceType.toLowerCase(), rule);
      }
    }

    const ctx: BuildCtx = {
      structure: struct,
      index,
      diags: diagnostics,
      unknown,
      unknownCap: opts.maxUnknown ?? 500,
      unknownTruncated: false,
      loc,
      entryMembers,
      entryUse: new Map(),
      elementMembers,
      notEntries,
      ambiguousReported: new Set(),
    };

    const rootJson = lexed.root;
    const rootType = resourceTypeOf(rootJson);

    if (rootJson.type !== "object") {
      diagnostics.push({
        severity: "error",
        code: "fhir/root-not-object",
        message: `A FHIR JSON message must be a JSON object; this message's root is a ${rootJson.type}.`,
        loc: loc(rootJson.start, rootJson.end),
      });
    } else if (!rootType) {
      diagnostics.push({
        severity: "error",
        code: "fhir/root-no-resourcetype",
        message:
          "The root object has no `resourceType`. Nothing identifies this as a FHIR Bundle, so no element could be located against the compiled spec.",
        loc: loc(rootJson.start, Math.min(rootJson.end, rootJson.start + 1)),
      });
    }

    const root: FhirTreeNode = {
      id: rootType ?? "(root)",
      kind: "message",
      label: rootType ?? "(no resourceType)",
      locator: rootType ? { kind: "fhirPath", path: rootType } : null,
      specNodeId: null,
      memberId: structure?.root?.id ?? null,
      occurrence: 0,
      value: rootJson.type === "object" || rootJson.type === "array" ? null : rootJson.value,
      raw: rootJson.type === "object" || rootJson.type === "array" ? null : rootJson.raw,
      present: true,
      loc: loc(rootJson.start, rootJson.end),
      children: [],
      fmt: rootJson.fmt,
      jsonType: rootJson.type === "missing" ? "string" : rootJson.type,
      resourceRoot: rootType,
    };
    if (rootType) resolveSpec(ctx, rootType, ".", root);

    const rootHasTable = rootType !== null && index.roots.has(rootType);
    if (rootType !== null && index.size > 0 && !rootHasTable) {
      unknown.push({
        path: root.id,
        nodeId: root.id,
        label: rootType,
        kind: "resource",
        locator: root.locator,
        loc: root.loc,
        resourceType: rootType,
        reason: `No compiled field table describes resource type "${rootType}" among the spec nodes supplied for ${struct.id}. Its elements were parsed but nothing here can say whether they are right.`,
        valuePreview: previewOf(rootJson),
      });
    }

    const inBundleRoot = rootType === "Bundle";
    for (const child of rootJson.children) {
      root.children.push(
        buildNode(ctx, child, {
          root: rootType,
          path: [],
          idPrefix: root.id,
          depthInResource: 0,
          suppressed: false,
          rootUnknown: rootType !== null && index.size > 0 ? !rootHasTable : false,
          inBundleRoot,
        }),
      );
    }
    tree.root = root;

    checkBundleFamily(ctx, root, rootJson, rootType);
  } catch (err) {
    // A parser that throws is useless to a hospital with a broken message in the box.
    diagnostics.push({
      severity: "error",
      code: "parser/internal-error",
      message: `The parser hit an internal error and returned the partial result it had: ${
        err instanceof Error ? err.message : String(err)
      }. This is a workbench bug — the message itself may be fine.`,
      loc: null,
    });
  }

  return { tree, diagnostics, unknown };
}

/**
 * The two-family rule: medications bundles are `type: "message"` with MessageHeader first,
 * lab/rad bundles are `type: "document"` with Composition first. Read off the structure's
 * compiled `bundleFamilyRule`, quote and all. Never inferred from the use case id.
 */
function checkBundleFamily(ctx: BuildCtx, root: FhirTreeNode, rootJson: JNode, rootType: string | null): void {
  const rule = ctx.structure.bundleFamilyRule ?? null;
  const envelope = ctx.structure.envelope;
  const expectedType = rule?.bundleType ?? (envelope && envelope.kind === "fhirBundle" ? envelope.bundleType : null);
  const expectedFirst = rule?.firstEntryResourceType ?? null;
  const quote = quoteOf(rule?.sources);

  if (rootType !== null && rootType !== "Bundle") {
    ctx.diags.push({
      severity: "error",
      code: "fhir/not-a-bundle",
      message: `The compiled structure ${ctx.structure.id} describes a FHIR Bundle; this message's root resource is ${rootType}.`,
      loc: root.loc,
      nodeId: root.id,
    });
    return;
  }

  const typeNode = stringChild(rootJson, "type");
  if (expectedType) {
    if (!typeNode) {
      ctx.diags.push({
        severity: "error",
        code: "fhir/bundle-type-missing",
        message: `Bundle.type is absent. ${ctx.structure.id} is a "${expectedType}" bundle.${quote}`,
        loc: root.loc,
        nodeId: root.id,
      });
    } else if (typeNode.value !== expectedType) {
      ctx.diags.push({
        severity: "error",
        code: "fhir/bundle-type-mismatch",
        message: `Bundle.type is "${typeNode.value}"; ${ctx.structure.id} is a "${expectedType}" bundle${
          rule?.family ? ` (${rule.family} family)` : ""
        }.${quote}`,
        loc: ctx.loc(typeNode.memberStart, typeNode.end),
        nodeId: `${root.id}.type`,
      });
    }
  }

  if (!expectedFirst) return;
  const entries = root.children.find((c) => c.locator?.kind === "fhirPath" && normalizeFhirPath(c.locator.path) === "entry");
  const first = entries?.children[0];
  if (!first) {
    ctx.diags.push({
      severity: "error",
      code: "fhir/first-entry-missing",
      message: `The bundle has no entries. The first entry SHALL be ${expectedFirst}.${quote}`,
      loc: root.loc,
      nodeId: root.id,
    });
    return;
  }
  const firstResource = first.children.find((c) => c.kind === "resource");
  const firstType =
    firstResource?.label ?? (first.label.startsWith("entry → ") ? first.label.slice("entry → ".length) : null);
  if (firstType !== expectedFirst) {
    ctx.diags.push({
      severity: "error",
      code: "fhir/first-entry-mismatch",
      message: `The first bundle entry is ${firstType ?? "unidentifiable"}; it SHALL be ${expectedFirst}${
        rule?.family ? ` for the ${rule.family} family` : ""
      }.${quote}`,
      loc: first.loc,
      nodeId: first.id,
    });
  }
}

/* ========================================================================== *
 * Small helpers other modules need
 * ========================================================================== */

/** True when the node came from a parse and carries the lexical detail emit needs. */
export function hasSourceFormat(node: TreeNode): boolean {
  return Boolean((node as FhirTreeNode).fmt);
}

/** Every entry node of a parsed bundle, in source order. */
export function bundleEntries(tree: StructureTree): FhirTreeNode[] {
  const entries = (tree.root as FhirTreeNode).children.find(
    (c) => c.locator?.kind === "fhirPath" && normalizeFhirPath(c.locator.path) === "entry",
  );
  return entries ? entries.children : [];
}
