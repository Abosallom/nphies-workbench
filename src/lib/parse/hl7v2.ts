/**
 * HL7 v2.5.1 ER7 (pipe-delimited) PARSER.
 *
 * Produces the shared {@link StructureTree} from `../structure`. Its exact inverse lives in
 * `../emit/hl7v2.ts`:
 *
 *     text --parseHl7v2--> StructureTree --emitHl7v2--> text        (byte-identical)
 *
 * Three rules govern everything below.
 *
 *  1. SPEC-DRIVEN, FORMAT-LEVEL. There is no per-use-case branching anywhere in this file.
 *     Segment order, repetition and nesting come from the compiled {@link MessageStructure};
 *     field meaning comes from the compiled `FieldTable`s; composite layouts, delimiters and
 *     escape sequences come from `src/spec/datatypes.json`. Nothing about ADT or ORU is
 *     hardcoded — an ORU message parses into its repeating group because `structures.json`
 *     says the group repeats, not because this file knows what an OBR is.
 *
 *  2. NEVER THROW. Hospitals paste broken messages; that is the whole point of the tool. Every
 *     malformation becomes a {@link Diagnostic} and parsing continues on a best-effort basis.
 *     A partial tree with honest diagnostics beats an exception.
 *
 *  3. NEVER DROP ANYTHING SILENTLY. Content the compiled spec does not describe is reported in
 *     {@link ParseResult.unknown} — an unknown element is a finding, not an error. Every node
 *     carries a {@link SourceLocation} so the SplitView can highlight it and "Check" can point
 *     at it.
 *
 * ## Delimiters are read from the message, never assumed
 *
 * MSH-1 IS the field separator character and MSH-2 IS the encoding characters. They are read
 * off the message being parsed. `src/spec/datatypes.json` supplies only (a) the ROLE of each
 * encoding character position, (b) the escape-sequence letters, (c) the composite component
 * layouts. Where no datatypes bundle is supplied, {@link FALLBACK_DELIMITER_CHARS} and
 * {@link FALLBACK_ESCAPE_LETTERS} — verbatim copies of that file's `delimiters` and `escapes`
 * blocks — stand in, and the parse records an `info` diagnostic saying so.
 *
 * ## The MSH offset, i.e. the classic HL7 parser bug
 *
 * Splitting an MSH segment on the field separator yields `["MSH", <encoding chars>, <MSH-3>,…]`
 * because MSH-1 is the separator itself and is therefore consumed by the split. This parser
 * makes MSH-1 an explicit one-character node at offset 3 and numbers the split parts from 2.
 * MSH-1 and MSH-2 are never split into components and never unescaped — they declare the
 * delimiters, so there is nothing to split them on.
 *
 * ## Known defects in the official ADT samples (src/spec/sample-defects.json)
 *
 * `ADT_sample03.txt` and `ADT_sample04.txt` are escaped-string dumps, not wire format:
 * MSH-2 reads `^~\\&` (a doubled escape character, five characters) and every segment ends
 * with the literal two characters `\` `r` before the real CRLF. This parser detects both,
 * records them as diagnostics (`msh2-duplicate-delimiter`, `unterminated-escape-sequence`)
 * and recovers rather than mis-parsing the whole message — it does not "fix" the samples, and
 * emitting the resulting tree reproduces them byte for byte.
 */

import {
  componentLayout,
  type DatatypeComponent,
  type DatatypesBundle,
  type FieldTable,
  type MessageStructure,
  type Severity,
  type SourceLocation,
  type SpecNode,
  type StructureGroup,
  type StructureMember,
  type StructureSegment,
  type StructureTree,
  type TreeDiagnostic,
  type TreeNode,
} from "../structure";

/* ========================================================================== *
 * Public types
 * ========================================================================== */

/** A problem with the TEXT (not with spec conformance). Alias of the engine's own type. */
export type Diagnostic = TreeDiagnostic;

/** The five HL7 delimiters actually in force for one message, read from MSH-1 / MSH-2. */
export interface Hl7Delimiters {
  /** MSH-1. */
  field: string;
  /** MSH-2 position 1. */
  component: string;
  /** MSH-2 position 2. */
  repetition: string;
  /** MSH-2 position 3. */
  escape: string;
  /** MSH-2 position 4. */
  subcomponent: string;
  /** MSH-2 position 5. Optional in v2.5.1; NPHIES samples send four characters. */
  truncation: string | null;
  /** Verbatim MSH-2 text, exactly as the message wrote it (defects included). */
  encodingCharactersRaw: string;
}

/**
 * Everything an emitter needs to reproduce the message it came from: the delimiters in force,
 * the escape-sequence letters they map to, and the segment terminator actually observed.
 *
 * HL7 v2 fixes the segment terminator at `\r`, but real files arrive with `\r\n` (both NPHIES
 * ADT samples do) or `\n`. The observed terminator is carried here rather than normalised
 * away, so `parse -> emit` is byte-identical without the emitter having to guess.
 */
export interface Hl7Dialect {
  delimiters: Hl7Delimiters;
  /** Escape-sequence letter (`F`, `S`, `T`, `R`, `E`) -> the character it stands for. */
  escapes: Record<string, string>;
  /** The terminator observed BETWEEN segments, e.g. `"\r\n"`. */
  segmentTerminator: string;
  /** Terminator text after the LAST segment; `""` when the message does not end with one. */
  trailingTerminator: string;
}

/** Content present in the message that the compiled spec does not describe. */
export interface UnknownElement {
  kind: "segment" | "field" | "component" | "subcomponent";
  /** Id of the {@link TreeNode} that holds it, so the UI can select it. */
  nodeId: string;
  /** Human address, e.g. `ZZZ`, `PID-41`, `PID-3.11`. */
  label: string;
  /** HL7 address of the content, when one could be formed. */
  locator: { segment: string; field: number; component?: number; subcomponent?: number } | null;
  /** Exact source text. */
  raw: string;
  /** Why the compiled spec does not cover it. Safe to show verbatim. */
  reason: string;
  loc: SourceLocation | null;
}

export interface ParseResult {
  tree: StructureTree;
  diagnostics: Diagnostic[];
  unknown: UnknownElement[];
  /**
   * The delimiters, escape letters and terminator this message actually used. Hand it back to
   * {@link emitHl7v2} as `EmitOptions.dialect` for a byte-identical round trip.
   */
  dialect: Hl7Dialect;
}

export interface ParseOptions {
  /**
   * `src/spec/datatypes.json`. Supplies delimiter roles, escape letters and the composite
   * component layouts that turn `30511223344557^^^HealthId&2.16…&ISO` into a named tree.
   * When omitted, the module cache set by {@link setHl7v2Datatypes} is used, then the cache
   * `primeSpecHelpers()` warms, then the documented fallbacks.
   */
  datatypes?: DatatypesBundle;
  /** `ResolvedUseCase.tables` — field tables keyed by `<pageId>:<tableIndex>`. Preferred. */
  fieldTables?: ReadonlyMap<string, FieldTable>;
  /** `ResolvedUseCase.specNodes` — used when `fieldTables` is not supplied. */
  specNodes?: ReadonlyMap<string, SpecNode>;
  /** Force the delimiters instead of reading MSH-1 / MSH-2. Rarely wanted. */
  dialect?: Hl7Dialect;
  /** Guard against a pathological paste. Default 20000. */
  maxSegments?: number;
}

/* ========================================================================== *
 * Datatype bundle access (the parser is synchronous; the bundle loader is not)
 * ========================================================================== */

let moduleDatatypes: DatatypesBundle | null = null;

/**
 * Give the synchronous parser and emitter the datatypes bundle once, at app start:
 * `setHl7v2Datatypes(await loadDatatypes())`. Optional — `ParseOptions.datatypes` wins, and
 * without either the parser degrades honestly (generic component labels, a diagnostic).
 */
export function setHl7v2Datatypes(bundle: DatatypesBundle | null): void {
  moduleDatatypes = bundle;
}

/** The bundle this module will use, or `null`. */
export function hl7v2Datatypes(opts?: ParseOptions): DatatypesBundle | null {
  return opts?.datatypes ?? moduleDatatypes ?? null;
}

/**
 * Verbatim copy of `src/spec/datatypes.json` -> `delimiters.*.char`. Used ONLY as a last
 * resort, and only for positions MSH-2 does not supply; a parse that falls back says so.
 */
export const FALLBACK_DELIMITER_CHARS = {
  field: "|",
  component: "^",
  repetition: "~",
  escape: "\\",
  subcomponent: "&",
} as const;

/**
 * Verbatim copy of `src/spec/datatypes.json` -> `escapes.mustEscapeInData`, as
 * letter -> delimiter role. These letters are fixed by HL7 v2.5.1 itself (derivation
 * `standard`), not by NPHIES.
 */
export const FALLBACK_ESCAPE_LETTERS: Readonly<Record<string, keyof typeof FALLBACK_DELIMITER_CHARS>> = {
  F: "field",
  S: "component",
  T: "subcomponent",
  R: "repetition",
  E: "escape",
};

/* ========================================================================== *
 * Small helpers
 * ========================================================================== */

const SEGMENT_ID = /^[A-Z][A-Z0-9]{2}$/;

function diag(
  severity: Severity,
  code: string,
  message: string,
  loc: SourceLocation | null,
  nodeId?: string | null,
): Diagnostic {
  return { severity, code, message, loc, nodeId: nodeId ?? null };
}

/** Bundle values such as `"\\r"` are ESCAPE NOTATION, not a control character. Normalise. */
export function normaliseTerminator(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw === "\\r\\n") return "\r\n";
  if (raw === "\\r") return "\r";
  if (raw === "\\n") return "\n";
  if (raw === "\r\n" || raw === "\r" || raw === "\n") return raw;
  return null;
}

interface DelimiterDefaults {
  field: string;
  component: string;
  repetition: string;
  escape: string;
  subcomponent: string;
}

function delimiterDefaults(bundle: DatatypesBundle | null): DelimiterDefaults {
  const d = (bundle?.delimiters ?? {}) as Record<string, { char?: string } | undefined>;
  const pick = (key: string, fallback: string) => {
    const char = d[key]?.char;
    return typeof char === "string" && char.length === 1 ? char : fallback;
  };
  return {
    field: pick("fieldSeparator", FALLBACK_DELIMITER_CHARS.field),
    component: pick("componentSeparator", FALLBACK_DELIMITER_CHARS.component),
    repetition: pick("repetitionSeparator", FALLBACK_DELIMITER_CHARS.repetition),
    escape: pick("escapeCharacter", FALLBACK_DELIMITER_CHARS.escape),
    subcomponent: pick("subcomponentSeparator", FALLBACK_DELIMITER_CHARS.subcomponent),
  };
}

/**
 * Escape-sequence letter -> the character it stands for, for THIS message's delimiters.
 *
 * The bundle states the mapping by DEFAULT character (`{ raw: "|", sequence: "\\F\\" }`), so
 * the role is recovered by matching `raw` against the bundle's own default delimiter chars —
 * never by parsing the English `meaning` text.
 */
export function buildEscapeMap(delims: Hl7Delimiters, bundle: DatatypesBundle | null): Record<string, string> {
  const defaults = delimiterDefaults(bundle);
  const roleOf = new Map<string, keyof DelimiterDefaults>([
    [defaults.field, "field"],
    [defaults.component, "component"],
    [defaults.repetition, "repetition"],
    [defaults.escape, "escape"],
    [defaults.subcomponent, "subcomponent"],
  ]);
  const out: Record<string, string> = {};
  const rows = (bundle?.escapes as { mustEscapeInData?: { raw?: string; sequence?: string }[] } | undefined)
    ?.mustEscapeInData;
  for (const row of rows ?? []) {
    const seq = row?.sequence;
    const raw = row?.raw;
    if (typeof seq !== "string" || seq.length !== 3 || typeof raw !== "string") continue;
    const role = roleOf.get(raw);
    if (!role) continue;
    out[seq[1]] = delims[role];
  }
  for (const [letter, role] of Object.entries(FALLBACK_ESCAPE_LETTERS)) {
    if (!(letter in out)) out[letter] = delims[role];
  }
  return out;
}

/* ------------------------------------------------------------- escaping --- */

export interface DecodeNote {
  /** `unterminated-escape-sequence` | `escape-sequence-not-decoded`. */
  code: string;
  message: string;
  /** Offset of the sequence within the raw text. */
  at: number;
  length: number;
}

/**
 * Resolve `\F\ \S\ \T\ \R\ \E\` to their characters.
 *
 * Any OTHER escape sequence (`\X0D\`, `\.br\`, `\Zxx\`) is left in the value VERBATIM with a
 * note, and an unterminated sequence (a lone `\`, as the two defective ADT samples carry at
 * the end of every segment) is likewise left verbatim with a note. Decoding them would make
 * re-escaping lossy, and silently rewriting a hospital's data is exactly the failure mode this
 * workbench exists to avoid.
 */
export function decodeHl7(raw: string, dialect: Hl7Dialect): { value: string; notes: DecodeNote[] } {
  const esc = dialect.delimiters.escape;
  if (!esc || raw.indexOf(esc) === -1) return { value: raw, notes: [] };

  const notes: DecodeNote[] = [];
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== esc) {
      out += ch;
      i += 1;
      continue;
    }
    const close = raw.indexOf(esc, i + 1);
    if (close === -1) {
      notes.push({
        code: "unterminated-escape-sequence",
        message:
          `The escape character "${esc}" at offset ${i} is never closed, so this is not a valid HL7 escape ` +
          `sequence. The text is kept verbatim rather than guessed at.`,
        at: i,
        length: raw.length - i,
      });
      out += raw.slice(i);
      break;
    }
    const seq = raw.slice(i + 1, close);
    const mapped = seq.length === 1 ? dialect.escapes[seq] : undefined;
    if (mapped !== undefined) {
      out += mapped;
    } else {
      notes.push({
        code: "escape-sequence-not-decoded",
        message:
          `"${esc}${seq}${esc}" is not one of the five delimiter escapes (${Object.keys(dialect.escapes)
            .map((l) => `${esc}${l}${esc}`)
            .join(", ")}). It is kept verbatim so re-emitting cannot corrupt it.`,
        at: i,
        length: close - i + 1,
      });
      out += raw.slice(i, close + 1);
    }
    i = close + 1;
  }
  return { value: out, notes };
}

/**
 * The inverse of {@link decodeHl7}: escape the five delimiters in a leaf VALUE.
 * Order matters — the escape character goes first, as `datatypes.json.escapes.emitterOrder`
 * requires, otherwise the escapes introduced for `|^&~` would themselves be escaped.
 */
export function encodeHl7(value: string, dialect: Hl7Dialect): string {
  const { escape, field, component, subcomponent, repetition } = dialect.delimiters;
  const letterFor = (char: string): string | null => {
    for (const [letter, mapped] of Object.entries(dialect.escapes)) if (mapped === char) return letter;
    return null;
  };
  let out = value;
  const order: string[] = [escape, field, component, subcomponent, repetition];
  const seen = new Set<string>();
  for (const char of order) {
    if (!char || seen.has(char)) continue;
    seen.add(char);
    const letter = letterFor(char);
    if (!letter) continue;
    out = out.split(char).join(`${escape}${letter}${escape}`);
  }
  return out;
}

/* ========================================================================== *
 * Segment splitting
 * ========================================================================== */

interface RawLine {
  /** 1-based physical line number. */
  line: number;
  /** Absolute offset of the first character of the line. */
  start: number;
  text: string;
  /** The terminator that followed this line, `""` at end of input. */
  terminator: string;
}

function splitLines(text: string): RawLine[] {
  const lines: RawLine[] = [];
  const re = /\r\n|\r|\n/g;
  let pos = 0;
  let line = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    lines.push({ line, start: pos, text: text.slice(pos, m.index), terminator: m[0] });
    pos = m.index + m[0].length;
    line += 1;
  }
  if (pos <= text.length) {
    lines.push({ line, start: pos, text: text.slice(pos), terminator: "" });
  }
  return lines;
}

/* ========================================================================== *
 * Spec index — field tables, keyed the way a parser needs them
 * ========================================================================== */

interface SpecIndex {
  byRef: Map<string, Map<number, SpecNode>>;
  bySegment: Map<string, Map<number, SpecNode>>;
  /** Segment ids for which a field table was supplied at all. */
  tabled: Set<string>;
  any: boolean;
}

function addNode(index: SpecIndex, ref: string | null, node: SpecNode): void {
  const loc = node.locator;
  if (!loc || loc.kind !== "hl7Field") return;
  // Component-level rows, if a future repair pass adds them, are not field rows.
  if (loc.component !== undefined) return;
  index.tabled.add(loc.segment);
  if (ref) {
    let byField = index.byRef.get(ref);
    if (!byField) index.byRef.set(ref, (byField = new Map()));
    if (!byField.has(loc.field)) byField.set(loc.field, node);
  }
  let bySeg = index.bySegment.get(loc.segment);
  if (!bySeg) index.bySegment.set(loc.segment, (bySeg = new Map()));
  if (!bySeg.has(loc.field)) bySeg.set(loc.field, node);
  index.any = true;
}

function buildSpecIndex(opts: ParseOptions | undefined): SpecIndex {
  const index: SpecIndex = { byRef: new Map(), bySegment: new Map(), tabled: new Set(), any: false };
  const walk = (ref: string | null, nodes: SpecNode[]) => {
    for (const node of nodes) {
      addNode(index, ref, node);
      if (node.children?.length) walk(ref, node.children);
    }
  };
  if (opts?.fieldTables) {
    for (const [ref, table] of opts.fieldTables) walk(ref, table.nodes ?? []);
  }
  if (opts?.specNodes) {
    for (const [id, node] of opts.specNodes) {
      // Node ids are `<pageId>:<tableIndex>:<rowIndex>`; the table ref is the first two parts.
      const parts = id.split(":");
      const ref = parts.length >= 2 ? `${parts[0]}:${parts[1]}` : null;
      addNode(index, ref, node);
    }
  }
  return index;
}

/** Field number -> SpecNode for one segment member, honouring its `specRefs` order. */
function fieldsForMember(index: SpecIndex, member: StructureSegment | null, segment: string): Map<number, SpecNode> {
  const out = new Map<number, SpecNode>();
  for (const ref of member?.specRefs ?? []) {
    if (ref.family !== "hl7v2") continue;
    const byField = index.byRef.get(ref.ref);
    if (!byField) continue;
    for (const [field, node] of byField) if (!out.has(field)) out.set(field, node);
  }
  if (out.size === 0) {
    const bySeg = index.bySegment.get(segment);
    if (bySeg) for (const [field, node] of bySeg) out.set(field, node);
  }
  return out;
}

/* ========================================================================== *
 * Structure plan — segment order, repetition and nesting, straight from the spec
 * ========================================================================== */

/**
 * The wire segment id a structure member addresses.
 *
 * The compiled spec labels some members with a CONTEXT, e.g. `OBR-NTE` is "the NTE that
 * follows an OBR". The wire still carries `NTE`, so the trailing three-character segment id is
 * what a parser matches on. Members whose id carries a compiler suffix (`ERR:absent`) already
 * expose the plain id in `.segment`.
 */
export function wireSegmentId(member: StructureSegment): string {
  const raw = (member.segment ?? "").trim();
  if (SEGMENT_ID.test(raw)) return raw;
  const m = raw.match(/([A-Z][A-Z0-9]{2})\s*$/);
  return m ? m[1] : raw;
}

function isRequired(member: StructureMember): boolean {
  return (member.usage ?? []).some((u) => u.usage === "M" || u.usage === "R");
}

/**
 * The segment ids that can OPEN a group: every leading member up to and including the first
 * required one. A group repetition starts when one of these turns up.
 */
function firstSet(group: StructureGroup, seen = new Set<string>()): Set<string> {
  const ids = new Set<string>();
  if (seen.has(group.id)) return ids;
  seen.add(group.id);
  for (const member of group.members ?? []) {
    if (member.kind === "segment") {
      ids.add(wireSegmentId(member));
    } else if (member.kind === "group") {
      for (const id of firstSet(member, seen)) ids.add(id);
    } else {
      continue;
    }
    if (isRequired(member)) break;
  }
  return ids;
}

/** Every segment member anywhere in the structure, for out-of-order recovery. */
function collectSegmentMembers(group: StructureGroup, into: Map<string, StructureSegment[]>): void {
  for (const member of group.members ?? []) {
    if (member.kind === "segment") {
      const id = wireSegmentId(member);
      const list = into.get(id);
      if (list) list.push(member);
      else into.set(id, [member]);
    } else if (member.kind === "group") {
      collectSegmentMembers(member, into);
    }
  }
}

/* ========================================================================== *
 * The parse
 * ========================================================================== */

interface SegRecord {
  id: string;
  line: RawLine;
  /** Absolute offset of the start of the segment text. */
  start: number;
  /** Absolute offset one past the end of the segment text. */
  end: number;
  text: string;
  /** Index in document order. */
  index: number;
}

export function parseHl7v2(text: string, structure: MessageStructure, opts?: ParseOptions): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const unknown: UnknownElement[] = [];
  const bundle = hl7v2Datatypes(opts);
  const maxSegments = opts?.maxSegments ?? 20000;

  const source = typeof text === "string" ? text : "";

  if (!bundle) {
    diagnostics.push(
      diag(
        "info",
        "datatypes-bundle-absent",
        "src/spec/datatypes.json was not supplied, so composite fields are split positionally with " +
          "generic component labels and the built-in copies of the delimiter roles and escape letters " +
          "are used. Call setHl7v2Datatypes(await loadDatatypes()) to get named components.",
        null,
      ),
    );
  }

  /* ------------------------------------------------ 1. segments ---------- */

  const lines = splitLines(source);
  const segments: SegRecord[] = [];
  const terminatorCounts = new Map<string, number>();

  for (const line of lines) {
    if (line.terminator) {
      terminatorCounts.set(line.terminator, (terminatorCounts.get(line.terminator) ?? 0) + 1);
    }
    const lineLoc: SourceLocation = {
      line: line.line,
      startCol: 0,
      endCol: line.text.length,
      offset: line.start,
      endOffset: line.start + line.text.length,
    };
    // Segment text is kept VERBATIM, whitespace included: trimming it would silently rewrite a
    // hospital's bytes and break the round trip.
    if (line.text.trim() === "") {
      if (line.terminator) {
        diagnostics.push(diag("info", "blank-line", "A blank line between segments. It carries no HL7 content.", lineLoc));
      }
      continue;
    }
    if (segments.length >= maxSegments) {
      diagnostics.push(
        diag("error", "too-many-segments", `Stopped after ${maxSegments} segments. The rest of the input was not parsed.`, lineLoc),
      );
      break;
    }
    if (line.text !== line.text.trimStart()) {
      diagnostics.push(
        diag(
          "warn",
          "leading-whitespace",
          "This segment starts with whitespace, so its first three characters are not a segment id. " +
            "The text is kept verbatim; nothing is trimmed.",
          lineLoc,
        ),
      );
    }
    segments.push({
      id: "",
      line,
      start: line.start,
      end: line.start + line.text.length,
      text: line.text,
      index: segments.length,
    });
  }

  // Segment ids can only be cut once the field separator is known, and the field separator is
  // MSH-1 — a character of the message, never an assumption.
  const mshLine = segments.find((s) => s.text.startsWith("MSH") && s.text.length > 3);
  const cutter = mshLine ? mshLine.text[3] : delimiterDefaults(bundle).field;
  for (const seg of segments) {
    const at = seg.text.indexOf(cutter);
    seg.id = at === -1 ? seg.text.slice(0, 3) : seg.text.slice(0, at);
  }

  // The terminator an emitter should reproduce: the one this message used most.
  let observedTerminator = "\r";
  let best = 0;
  for (const [t, n] of terminatorCounts) {
    if (n > best) {
      best = n;
      observedTerminator = t;
    }
  }
  if (terminatorCounts.size === 0) {
    observedTerminator =
      normaliseTerminator(structure?.envelope?.kind === "hl7v2Message" ? structure.envelope.segmentTerminator : null) ??
      "\r";
  }
  // Everything after the last segment: usually one terminator, occasionally several.
  const lastSeg = segments.length ? segments[segments.length - 1] : null;
  const trailingTerminator = lastSeg ? source.slice(lastSeg.end) : "";
  if (terminatorCounts.size > 1) {
    diagnostics.push(
      diag(
        "warn",
        "mixed-segment-terminators",
        `The message mixes segment terminators (${[...terminatorCounts.keys()]
          .map((t) => JSON.stringify(t))
          .join(", ")}). HL7 v2 fixes the terminator at a bare CR; ` +
          `${JSON.stringify(observedTerminator)} is the most common here and is what a re-emit will use.`,
        null,
      ),
    );
  } else if (observedTerminator !== "\r" && segments.length > 0) {
    diagnostics.push(
      diag(
        "info",
        "non-cr-segment-terminator",
        `Segments are separated by ${JSON.stringify(observedTerminator)}. HL7 v2 uses a bare CR (0x0D); ` +
          "the extra LF is not part of the message. Both official NPHIES ADT samples do this " +
          "(src/spec/sample-defects.json, defectType segment-terminator, severity minor). " +
          "It is preserved here so a re-emit reproduces the file byte for byte.",
        null,
      ),
    );
  }

  /* ------------------------------------------------ 2. delimiters -------- */

  const dialect = opts?.dialect
    ? { ...opts.dialect, segmentTerminator: observedTerminator, trailingTerminator }
    : readDialect(segments, bundle, observedTerminator, trailingTerminator, diagnostics);

  /* ------------------------------------------------ 3. spec index -------- */

  const specIndex = buildSpecIndex(opts);
  if (!specIndex.any) {
    diagnostics.push(
      diag(
        "info",
        "field-tables-absent",
        "No compiled field tables were supplied, so no field carries a spec node and every field is " +
          "reported as undescribed. Pass ResolvedUseCase.tables as ParseOptions.fieldTables.",
        null,
      ),
    );
  }

  /* ------------------------------------------------ 4. build the tree ---- */

  const ctx: BuildContext = { dialect, bundle, specIndex, diagnostics, unknown, counters: new Map() };
  const rootGroup: StructureGroup | null = structure?.root ?? null;

  let children: TreeNode[] = [];
  const state = { i: 0 };
  if (rootGroup) {
    children = matchMembers(rootGroup.members ?? [], segments, state, ctx, rootGroup.id);
  }

  // Anything the structure's order did not account for. Never dropped.
  if (state.i < segments.length) {
    const anywhere = new Map<string, StructureSegment[]>();
    if (rootGroup) collectSegmentMembers(rootGroup, anywhere);
    for (let k = state.i; k < segments.length; k++) {
      const seg = segments[k];
      const candidates = anywhere.get(seg.id);
      const member = candidates && candidates.length ? candidates[0] : null;
      const node = buildSegmentNode(seg, member, nextOccurrence(ctx, `seg:${seg.id}`), ctx);
      if (member) {
        ctx.diagnostics.push(
          diag(
            "warn",
            "segment-out-of-order",
            `${seg.id} appears at a position the compiled structure does not allow. ` +
              `"${structure?.id ?? "the structure"}" places it as ${member.id}. It is kept in the tree at the ` +
              "end so nothing is lost, but its position is wrong.",
            node.loc,
            node.id,
          ),
        );
      } else {
        ctx.diagnostics.push(
          diag(
            "warn",
            "unknown-segment",
            `${seg.id || "(unnamed segment)"} is not part of "${structure?.id ?? "the structure"}". ` +
              "It is reported as unknown content rather than dropped.",
            node.loc,
            node.id,
          ),
        );
        ctx.unknown.push({
          kind: "segment",
          nodeId: node.id,
          label: seg.id || "(unnamed segment)",
          locator: SEGMENT_ID.test(seg.id) ? { segment: seg.id, field: 0 } : null,
          raw: seg.text,
          reason: `No member of "${structure?.id ?? "the structure"}" admits a ${seg.id || "nameless"} segment.`,
          loc: node.loc,
        });
      }
      children.push(node);
    }
    state.i = segments.length;
  }

  if (segments.length === 0) {
    diagnostics.push(
      diag("error", "empty-message", "The input contains no segments.", null),
    );
  }

  const firstLineLength = lines.length ? lines[0].text.length : 0;
  const root: TreeNode = {
    id: structure?.id ?? "message",
    kind: "message",
    label: envelopeLabel(structure),
    locator: null,
    specNodeId: null,
    memberId: rootGroup?.id ?? null,
    occurrence: 0,
    value: null,
    present: segments.length > 0,
    // Anchored at line 1; `offset`/`endOffset` span the whole message.
    loc: { line: 1, startCol: 0, endCol: firstLineLength, offset: 0, endOffset: source.length },
    children,
  };

  const tree: StructureTree = {
    structureId: structure?.id ?? null,
    useCaseId: structure?.useCaseId ?? null,
    family: "hl7v2",
    encoding: "hl7v2-er7",
    text: source,
    root,
    diagnostics,
  };

  return { tree, diagnostics, unknown, dialect };
}

function envelopeLabel(structure: MessageStructure | undefined | null): string {
  if (!structure) return "HL7 v2 message";
  if (structure.envelope?.kind === "hl7v2Message" && structure.envelope.messageType) {
    return structure.envelope.messageType;
  }
  return structure.root?.label ?? structure.title ?? structure.id;
}

/* ------------------------------------------------------- MSH-1 / MSH-2 --- */

/**
 * MSH-2 positions, with the one recovery this parser makes.
 *
 * HL7 v2.5.1 orders them component, repetition, escape, subcomponent, [truncation]. When
 * positions 3 and 4 hold the SAME character the message is self-contradictory — that is the
 * doubled-backslash defect in ADT_sample03/04 — and the duplicate is dropped so the rest of
 * the message can be split. Nothing else is repaired.
 */
function normaliseEncodingChars(enc: string): { chars: string[]; duplicateDropped: boolean } {
  const chars = [...enc];
  if (chars.length >= 5 && chars[2] === chars[3]) {
    return { chars: [chars[0], chars[1], chars[2], ...chars.slice(4)], duplicateDropped: true };
  }
  return { chars, duplicateDropped: false };
}

/**
 * Build a {@link Hl7Dialect} from an MSH-1 character and an MSH-2 string, without a message to
 * read them from. The emitter uses it to recover the delimiters from a tree; a Build screen
 * uses it to pin the delimiters a generated message will declare.
 */
export function makeDialect(init: {
  fieldSeparator?: string | null;
  encodingCharacters?: string | null;
  bundle?: DatatypesBundle | null;
  segmentTerminator?: string;
  trailingTerminator?: string;
}): Hl7Dialect {
  const bundle = init.bundle ?? null;
  const defaults = delimiterDefaults(bundle);
  const { chars } = normaliseEncodingChars(init.encodingCharacters ?? "");
  const delimiters: Hl7Delimiters = {
    field: init.fieldSeparator && init.fieldSeparator.length ? init.fieldSeparator[0] : defaults.field,
    component: chars[0] ?? defaults.component,
    repetition: chars[1] ?? defaults.repetition,
    escape: chars[2] ?? defaults.escape,
    subcomponent: chars[3] ?? defaults.subcomponent,
    truncation: chars[4] ?? null,
    encodingCharactersRaw:
      init.encodingCharacters ??
      `${defaults.component}${defaults.repetition}${defaults.escape}${defaults.subcomponent}`,
  };
  return {
    delimiters,
    escapes: buildEscapeMap(delimiters, bundle),
    segmentTerminator: init.segmentTerminator ?? "\r",
    trailingTerminator: init.trailingTerminator ?? "",
  };
}

function readDialect(
  segments: SegRecord[],
  bundle: DatatypesBundle | null,
  segmentTerminator: string,
  trailingTerminator: string,
  diagnostics: Diagnostic[],
): Hl7Dialect {
  const defaults = delimiterDefaults(bundle);
  const msh = segments.find((s) => s.text.startsWith("MSH"));
  const delims: Hl7Delimiters = {
    field: defaults.field,
    component: defaults.component,
    repetition: defaults.repetition,
    escape: defaults.escape,
    subcomponent: defaults.subcomponent,
    truncation: null,
    encodingCharactersRaw: `${defaults.component}${defaults.repetition}${defaults.escape}${defaults.subcomponent}`,
  };

  if (!msh) {
    diagnostics.push(
      diag(
        "error",
        "msh-missing",
        "No MSH segment, so MSH-1 and MSH-2 could not be read. HL7 v2 requires MSH first; every " +
          "delimiter below is the recommended default from src/spec/datatypes.json, not something " +
          "this message stated.",
        segments.length ? locOf(segments[0], segments[0].start, segments[0].end) : null,
      ),
    );
    return { delimiters: delims, escapes: buildEscapeMap(delims, bundle), segmentTerminator, trailingTerminator };
  }

  if (msh.index !== 0) {
    diagnostics.push(
      diag(
        "error",
        "msh-not-first",
        `MSH is segment ${msh.index + 1}, not the first segment.`,
        locOf(msh, msh.start, msh.start + 3),
      ),
    );
  }

  // MSH-1 IS the character at offset 3 — the separator, not a field delimited by one.
  if (msh.text.length < 4) {
    diagnostics.push(
      diag("error", "msh1-missing", "MSH is too short to carry a field separator at MSH-1.", locOf(msh, msh.start, msh.end)),
    );
    return { delimiters: delims, escapes: buildEscapeMap(delims, bundle), segmentTerminator, trailingTerminator };
  }
  delims.field = msh.text[3];

  const rest = msh.text.slice(4);
  const sep = rest.indexOf(delims.field);
  const enc = sep === -1 ? rest : rest.slice(0, sep);
  delims.encodingCharactersRaw = enc;
  const encLoc = locOf(msh, msh.start + 4, msh.start + 4 + enc.length);

  const normalised = normaliseEncodingChars(enc);
  const chars = normalised.chars;
  if ([...enc].length < 4) {
    diagnostics.push(
      diag(
        "error",
        "msh2-too-short",
        `MSH-2 carries ${[...enc].length} character(s); HL7 v2.5.1 needs four (component, repetition, escape, ` +
          "subcomponent) with an optional fifth truncation character. The missing positions fall back to the " +
          "recommended values in src/spec/datatypes.json.",
        encLoc,
      ),
    );
  } else if (chars.length > 5) {
    diagnostics.push(
      diag(
        "error",
        "msh2-too-long",
        `MSH-2 carries ${[...enc].length} characters; HL7 v2.5.1 allows four or five. Positions beyond the fifth ` +
          "are ignored for delimiter purposes and preserved verbatim in the node's raw text.",
        encLoc,
      ),
    );
  }

  // The ADT_sample03 / ADT_sample04 defect: MSH-2 reads `^~\\&`, so position 3 (escape) and
  // position 4 (subcomponent) are the SAME character. That is structurally impossible — it
  // would make `&` ordinary data and corrupt every composite field in the message. Recover by
  // dropping the duplicate, exactly as src/spec/sample-defects.json prescribes, and say so.
  if (normalised.duplicateDropped) {
    diagnostics.push(
      diag(
        "error",
        "msh2-duplicate-delimiter",
        `MSH-2 repeats "${chars[2]}" at positions 3 and 4, so the escape character and the subcomponent ` +
          "separator would be the same character. This is the known defect in the official samples " +
          "ADT_sample03.txt and ADT_sample04.txt (src/spec/sample-defects.json, defectType " +
          "invalid-wire-encoding, severity fatal: \"MSH-2 reads ^~\\\\& with a doubled backslash (five " +
          "characters) instead of the four-character ^~\\&\"). The duplicate is dropped so the rest of the " +
          "message parses; MSH-2 is still reported verbatim and a re-emit reproduces it unchanged.",
        encLoc,
      ),
    );
  }

  if (chars[0]) delims.component = chars[0];
  if (chars[1]) delims.repetition = chars[1];
  if (chars[2]) delims.escape = chars[2];
  if (chars[3]) delims.subcomponent = chars[3];
  delims.truncation = chars[4] ?? null;

  const roles: [string, string][] = [
    ["MSH-1 field separator", delims.field],
    ["MSH-2.1 component separator", delims.component],
    ["MSH-2.2 repetition separator", delims.repetition],
    ["MSH-2.3 escape character", delims.escape],
    ["MSH-2.4 subcomponent separator", delims.subcomponent],
  ];
  for (let a = 0; a < roles.length; a++) {
    for (let b = a + 1; b < roles.length; b++) {
      if (roles[a][1] === roles[b][1]) {
        diagnostics.push(
          diag(
            "error",
            "delimiter-collision",
            `${roles[a][0]} and ${roles[b][0]} are both "${roles[a][1]}". The message cannot be split ` +
              "unambiguously; everything parsed below this point is a best effort.",
            encLoc,
          ),
        );
      }
    }
  }

  return { delimiters: delims, escapes: buildEscapeMap(delims, bundle), segmentTerminator, trailingTerminator };
}

/* ========================================================================== *
 * Matching the segment stream against the compiled structure
 * ========================================================================== */

interface BuildContext {
  dialect: Hl7Dialect;
  bundle: DatatypesBundle | null;
  specIndex: SpecIndex;
  diagnostics: Diagnostic[];
  unknown: UnknownElement[];
  /** memberId / segment id -> occurrences built so far, for stable node ids. */
  counters: Map<string, number>;
}

function nextOccurrence(ctx: BuildContext, key: string): number {
  const n = ctx.counters.get(key) ?? 0;
  ctx.counters.set(key, n + 1);
  return n;
}

function canAccept(member: StructureMember, seg: SegRecord, used: number): boolean {
  if (used > 0 && !member.repeats) return false;
  if (member.kind === "segment") return wireSegmentId(member) === seg.id;
  if (member.kind === "group") return firstSet(member).has(seg.id);
  return false;
}

/**
 * Walk the member list and the segment stream together.
 *
 * Generic, and driven only by `members`, `repeats` and each group's first set:
 *
 *   - a member is tried at or after the current cursor; the cursor only moves forward past a
 *     member that cannot repeat;
 *   - a repeating member already passed may be REWOUND to, so `OBR NTE OBX NTE OBX NTE` keeps
 *     every OBX and its NTE inside one group repetition instead of spilling out;
 *   - a repeating GROUP starts a new repetition when a segment in its first set arrives;
 *   - a group repetition that consumes nothing breaks the loop, so malformed input cannot spin.
 */
function matchMembers(
  members: StructureMember[],
  segs: SegRecord[],
  state: { i: number },
  ctx: BuildContext,
  parentId: string,
): TreeNode[] {
  const nodes: TreeNode[] = [];
  const used = new Map<string, number>();
  let cursor = 0;

  while (state.i < segs.length && cursor < members.length) {
    const seg = segs[state.i];
    let hit = -1;
    for (let k = cursor; k < members.length; k++) {
      if (canAccept(members[k], seg, used.get(members[k].id) ?? 0)) {
        hit = k;
        break;
      }
    }
    if (hit === -1) {
      // Rewind to an earlier REPEATING member (never past the group's anchor at index 0).
      for (let k = cursor - 1; k >= 1; k--) {
        if (members[k].repeats && canAccept(members[k], seg, 0)) {
          hit = k;
          break;
        }
      }
    }
    if (hit === -1) break;

    cursor = hit;
    const member = members[hit];
    const seen = used.get(member.id) ?? 0;

    if (member.kind === "segment") {
      // Keyed by the WIRE id, not the member id: `OBR-NTE` and `OBX-NTE` are both NTE on the
      // wire, so counting per member would mint two nodes called `NTE[0]` and break the
      // "unique in the tree" contract on TreeNode.id.
      nodes.push(buildSegmentNode(seg, member, nextOccurrence(ctx, `seg:${seg.id}`), ctx));
      state.i += 1;
      used.set(member.id, seen + 1);
    } else if (member.kind === "group") {
      const before = state.i;
      const kids = matchMembers(member.members ?? [], segs, state, ctx, `${parentId}/${member.id}`);
      if (state.i === before) break;
      const occ = nextOccurrence(ctx, member.id);
      nodes.push({
        id: `${member.id}[${occ}]`,
        kind: "group",
        label: member.label ?? member.id,
        locator: null,
        specNodeId: null,
        memberId: member.id,
        occurrence: occ,
        value: null,
        present: true,
        loc: spanOf(kids),
        children: kids,
      });
      used.set(member.id, seen + 1);
    } else {
      cursor = hit + 1;
      continue;
    }
    if (!member.repeats) cursor = hit + 1;
  }
  return nodes;
}

function spanOf(nodes: TreeNode[]): SourceLocation | null {
  const located = nodes.map((n) => n.loc).filter((l): l is SourceLocation => Boolean(l));
  if (!located.length) return null;
  const first = located[0];
  const last = located[located.length - 1];
  return {
    line: first.line,
    startCol: first.startCol,
    endCol: last.endCol,
    offset: first.offset,
    endOffset: last.endOffset,
  };
}

/* ========================================================================== *
 * Segment -> fields -> repetitions -> components -> subcomponents
 * ========================================================================== */

function locOf(seg: SegRecord, start: number, end: number): SourceLocation {
  return {
    line: seg.line.line,
    startCol: start - seg.line.start,
    endCol: end - seg.line.start,
    offset: start,
    endOffset: end,
  };
}

interface Piece {
  text: string;
  start: number;
  end: number;
}

function splitPieces(text: string, absStart: number, sep: string): Piece[] {
  const out: Piece[] = [];
  if (!sep) return [{ text, start: absStart, end: absStart + text.length }];
  let from = 0;
  for (;;) {
    const at = text.indexOf(sep, from);
    if (at === -1) {
      out.push({ text: text.slice(from), start: absStart + from, end: absStart + text.length });
      return out;
    }
    out.push({ text: text.slice(from, at), start: absStart + from, end: absStart + at });
    from = at + sep.length;
  }
}

function buildSegmentNode(
  seg: SegRecord,
  member: StructureSegment | null,
  occurrence: number,
  ctx: BuildContext,
): TreeNode {
  const { dialect, specIndex } = ctx;
  const fs = dialect.delimiters.field;
  const segId = seg.id;
  const nodeId = `${segId || "???"}[${occurrence}]`;

  if (!SEGMENT_ID.test(segId)) {
    ctx.diagnostics.push(
      diag(
        "error",
        "bad-segment-id",
        `"${segId}" is not a valid HL7 segment id (three characters: a letter then two letters or digits). ` +
          "The line is kept in the tree so nothing is lost.",
        locOf(seg, seg.start, seg.start + Math.max(segId.length, 1)),
        nodeId,
      ),
    );
  }

  const isMsh = segId === "MSH";
  const specFields = fieldsForMember(specIndex, member, segId);
  const hasTable = specFields.size > 0;
  if (!hasTable && specIndex.any) {
    ctx.diagnostics.push(
      diag(
        "info",
        "no-field-table",
        `No compiled field table describes ${segId}, so its fields carry no spec node. They are parsed ` +
          "structurally and left unmapped rather than guessed at.",
        locOf(seg, seg.start, seg.end),
        nodeId,
      ),
    );
  }

  const children: TreeNode[] = [];

  if (isMsh) {
    // MSH-1 is the separator character itself, sitting at offset 3 of the segment.
    if (seg.text.length > 3) {
      children.push(
        literalField(seg, segId, nodeId, 1, seg.start + 3, seg.start + 4, specFields.get(1) ?? null, "Field Separator"),
      );
    }
    const restStart = seg.start + 4;
    const rest = seg.text.slice(4);
    const parts = seg.text.length > 4 ? splitPieces(rest, restStart, fs) : [];
    parts.forEach((piece, k) => {
      const fieldNo = k + 2; // parts[0] is MSH-2: the split ate MSH-1.
      if (fieldNo === 2) {
        children.push(
          literalField(seg, segId, nodeId, 2, piece.start, piece.end, specFields.get(2) ?? null, "Encoding Characters"),
        );
        return;
      }
      children.push(buildFieldNode(seg, segId, nodeId, fieldNo, piece, specFields.get(fieldNo) ?? null, hasTable, ctx));
    });
  } else {
    const parts = splitPieces(seg.text, seg.start, fs);
    if (parts.length <= 1) {
      ctx.diagnostics.push(
        diag(
          "warn",
          "segment-has-no-fields",
          `${segId} carries no field separator ("${fs}"), so it has no fields.`,
          locOf(seg, seg.start, seg.end),
          nodeId,
        ),
      );
    }
    for (let k = 1; k < parts.length; k++) {
      children.push(buildFieldNode(seg, segId, nodeId, k, parts[k], specFields.get(k) ?? null, hasTable, ctx));
    }
  }

  return {
    id: nodeId,
    kind: "segment",
    label: member?.label ?? segId,
    // Field 0 addresses the segment itself; HL7 numbers real fields from 1.
    locator: SEGMENT_ID.test(segId) ? { kind: "hl7Field", segment: segId, field: 0 } : null,
    specNodeId: null,
    memberId: member?.id ?? null,
    occurrence,
    value: null,
    raw: seg.text,
    present: true,
    loc: locOf(seg, seg.start, seg.end),
    children,
  };
}

/** MSH-1 and MSH-2: literal, never split, never unescaped — they DECLARE the delimiters. */
function literalField(
  seg: SegRecord,
  segId: string,
  segNodeId: string,
  fieldNo: number,
  start: number,
  end: number,
  spec: SpecNode | null,
  fallbackLabel: string,
): TreeNode {
  const raw = seg.line.text.slice(start - seg.line.start, end - seg.line.start);
  return {
    id: `${segNodeId}.${fieldNo}`,
    kind: "field",
    label: spec?.label ?? fallbackLabel,
    locator: { kind: "hl7Field", segment: segId, field: fieldNo },
    specNodeId: spec?.id ?? null,
    occurrence: 0,
    value: raw,
    raw,
    present: true,
    loc: locOf(seg, start, end),
    children: [],
  };
}

function buildFieldNode(
  seg: SegRecord,
  segId: string,
  segNodeId: string,
  fieldNo: number,
  piece: Piece,
  spec: SpecNode | null,
  hasTable: boolean,
  ctx: BuildContext,
): TreeNode {
  const { dialect } = ctx;
  const id = `${segNodeId}.${fieldNo}`;
  const label = spec?.label ?? `${segId}-${fieldNo}`;
  const datatype = spec?.datatype ?? null;
  const loc = locOf(seg, piece.start, piece.end);

  if (!spec && hasTable && piece.text !== "") {
    ctx.unknown.push({
      kind: "field",
      nodeId: id,
      label: `${segId}-${fieldNo}`,
      locator: { segment: segId, field: fieldNo },
      raw: piece.text,
      reason: `The compiled ${segId} field table stops before field ${fieldNo}; no NPHIES row describes it.`,
      loc,
    });
  }

  const node: TreeNode = {
    id,
    kind: "field",
    label,
    locator: { kind: "hl7Field", segment: segId, field: fieldNo },
    specNodeId: spec?.id ?? null,
    occurrence: 0,
    value: null,
    raw: piece.text,
    present: true,
    loc,
    children: [],
  };

  const rep = dialect.delimiters.repetition;
  if (rep && piece.text.indexOf(rep) !== -1) {
    const reps = splitPieces(piece.text, piece.start, rep);
    node.children = reps.map((r, k) => {
      const repNode: TreeNode = {
        id: `${id}[${k}]`,
        kind: "repetition",
        label: `${label} (repeat ${k + 1})`,
        locator: { kind: "hl7Field", segment: segId, field: fieldNo },
        specNodeId: spec?.id ?? null,
        occurrence: k,
        value: null,
        raw: r.text,
        present: true,
        loc: locOf(seg, r.start, r.end),
        children: [],
      };
      fillComponents(repNode, seg, segId, `${id}[${k}]`, fieldNo, r, datatype, spec, ctx);
      return repNode;
    });
    return node;
  }

  fillComponents(node, seg, segId, `${id}[0]`, fieldNo, piece, datatype, spec, ctx);
  return node;
}

/**
 * Split one repetition into components (and subcomponents), naming each from the composite
 * layout in `datatypes.json`. A field with no component separator stays a leaf — the tree only
 * grows a level where the message actually has one, so re-joining it is exact.
 */
function fillComponents(
  node: TreeNode,
  seg: SegRecord,
  segId: string,
  idBase: string,
  fieldNo: number,
  piece: Piece,
  datatype: string | null,
  spec: SpecNode | null,
  ctx: BuildContext,
): void {
  const { dialect, bundle } = ctx;
  const cs = dialect.delimiters.component;

  if (!cs || piece.text.indexOf(cs) === -1) {
    const decoded = decodeHl7(piece.text, dialect);
    node.value = decoded.value;
    noteDecode(decoded.notes, node, seg, piece.start, ctx);
    return;
  }

  const layout = datatype ? (componentLayout(datatype, bundle ?? undefined) ?? null) : null;
  const comps = splitPieces(piece.text, piece.start, cs);
  node.value = null;
  node.children = comps.map((c, k) => {
    const index = k + 1;
    const def: DatatypeComponent | undefined = layout ? layout[k] : undefined;
    const compNode: TreeNode = {
      id: `${idBase}.${index}`,
      kind: "component",
      label: def?.name ?? `Component ${index}`,
      locator: { kind: "hl7Field", segment: segId, field: fieldNo, component: index },
      specNodeId: spec?.id ?? null,
      occurrence: 0,
      value: null,
      raw: c.text,
      present: true,
      loc: locOf(seg, c.start, c.end),
      children: [],
    };
    if (layout && !def && c.text !== "") {
      ctx.unknown.push({
        kind: "component",
        nodeId: compNode.id,
        label: `${segId}-${fieldNo}.${index}`,
        locator: { segment: segId, field: fieldNo, component: index },
        raw: c.text,
        reason: `HL7 v2.5.1 datatype ${datatype} has ${layout.length} components; this message sends a ${index}th.`,
        loc: compNode.loc,
      });
    }
    fillSubcomponents(compNode, seg, segId, fieldNo, index, c, def?.datatype ?? null, spec, ctx);
    return compNode;
  });
}

function fillSubcomponents(
  node: TreeNode,
  seg: SegRecord,
  segId: string,
  fieldNo: number,
  component: number,
  piece: Piece,
  datatype: string | null,
  spec: SpecNode | null,
  ctx: BuildContext,
): void {
  const { dialect, bundle } = ctx;
  const sub = dialect.delimiters.subcomponent;

  if (!sub || piece.text.indexOf(sub) === -1) {
    const decoded = decodeHl7(piece.text, dialect);
    node.value = decoded.value;
    noteDecode(decoded.notes, node, seg, piece.start, ctx);
    return;
  }

  const layout = datatype ? (componentLayout(datatype, bundle ?? undefined) ?? null) : null;
  const parts = splitPieces(piece.text, piece.start, sub);
  node.value = null;
  node.children = parts.map((p, k) => {
    const index = k + 1;
    const def: DatatypeComponent | undefined = layout ? layout[k] : undefined;
    const subNode: TreeNode = {
      id: `${node.id}.${index}`,
      kind: "subcomponent",
      label: def?.name ?? `Subcomponent ${index}`,
      locator: {
        kind: "hl7Field",
        segment: segId,
        field: fieldNo,
        component,
        subcomponent: index,
      },
      specNodeId: spec?.id ?? null,
      occurrence: 0,
      value: null,
      raw: p.text,
      present: true,
      loc: locOf(seg, p.start, p.end),
      children: [],
    };
    if (layout && !def && p.text !== "") {
      ctx.unknown.push({
        kind: "subcomponent",
        nodeId: subNode.id,
        label: `${segId}-${fieldNo}.${component}.${index}`,
        locator: { segment: segId, field: fieldNo, component, subcomponent: index },
        raw: p.text,
        reason: `HL7 v2.5.1 datatype ${datatype} has ${layout.length} components; this message sends a ${index}th subcomponent.`,
        loc: subNode.loc,
      });
    }
    const decoded = decodeHl7(p.text, dialect);
    subNode.value = decoded.value;
    noteDecode(decoded.notes, subNode, seg, p.start, ctx);
    return subNode;
  });
}

function noteDecode(notes: DecodeNote[], node: TreeNode, seg: SegRecord, absStart: number, ctx: BuildContext): void {
  for (const note of notes) {
    ctx.diagnostics.push(
      diag(
        note.code === "unterminated-escape-sequence" ? "warn" : "info",
        note.code,
        `${node.label} (${node.id}): ${note.message}`,
        locOf(seg, absStart + note.at, absStart + note.at + note.length),
        node.id,
      ),
    );
  }
}
