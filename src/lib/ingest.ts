/**
 * HIS spreadsheet ingest: read a hospital extract, map its columns onto spec positions, and
 * fill an existing message with one row's values.
 *
 * Three steps, each honest about what it did not do:
 *
 *   1. {@link readSheet} / {@link readCsv}   a workbook or CSV becomes columns and string rows.
 *   2. {@link autoMapByName}                  a DETERMINISTIC first pass pairs column names with
 *                                             profile rows by exact (normalised) name. Nothing
 *                                             is inferred; a name that matches two positions is
 *                                             left unmapped rather than guessed. A model may
 *                                             later PROPOSE more pairs, and those enter through
 *                                             {@link mergeModelProposal} as `confirmed: false`,
 *                                             which {@link generateFromTemplate} refuses to
 *                                             apply — so a model's output cannot reach a message
 *                                             until a human has confirmed it.
 *   3. {@link generateFromTemplate}           an official sample (or a message the hospital
 *                                             already sends) is parsed, the mapped leaves are
 *                                             overwritten with the row's cells, and the same
 *                                             emitter that round-trips the golden samples writes
 *                                             it back out. Nothing is added, nothing is removed,
 *                                             no repeating group is expanded: the generator
 *                                             changes VALUES at positions the template already
 *                                             has, and records every position it could not
 *                                             change in `skipped` with the reason.
 *
 * The output is then re-parsed and every edit checked against the tree, because the five
 * emitters keep their recorded source text in different places (`raw`, a FHIR `fmt.tokenRaw`,
 * an XDS `xml` side-car) and "the emitter should have honoured that" is not a claim this
 * module is willing to make without looking. An edit that did not land is reported, not
 * counted.
 *
 * `xlsx` is 7.2 MB on disk and imported by nothing else, so it is loaded with a dynamic
 * `import()` inside {@link readSheet} — exactly as `ai.ts` loads the SDK — and an analyst who
 * never uploads a workbook never downloads it. {@link readCsv} needs no dependency at all.
 */

import {
  formatLocator,
  locatorKey,
  walkTree,
  type Hl7FieldLocator,
  type MessageEncoding,
  type MessageStructure,
  type ResolvedUseCase,
  type TreeNode,
} from "./structure";
import { OBLIGATION_LABEL, type Profile } from "./profile";
import { detectEncoding, emitMessage, ENCODING_LABEL, parseMessage, type ParseOutcome } from "./workbench";
import type { FhirTreeNode } from "./parse/fhir";
import type { XdsTreeNode } from "./parse/xds";

/* ========================================================================== *
 * 1. Reading a sheet
 * ========================================================================== */

export interface SheetColumn {
  /** Header text, trimmed. Blank headers become `Column N`; duplicates get ` (2)`, ` (3)`. */
  name: string;
  /** The first three distinct non-empty values, for display only — never a rule. */
  sampleValues: string[];
  nonEmpty: number;
  distinct: number;
}

export interface Sheet {
  /** Worksheet name, or `null` for a CSV. */
  name: string | null;
  columns: SheetColumn[];
  /** One record per data row, keyed by column name. Every cell is a string; blanks are `""`. */
  rows: Record<string, string>[];
  /** True when `maxRows` cut the sheet short — the row count shown is then not the file's. */
  truncated: boolean;
}

export interface ReadOptions {
  /** Keep at most this many data rows. Default: all of them. */
  maxRows?: number;
}

/**
 * Turn a grid of cells into a {@link Sheet}. Shared by both readers so a CSV and a workbook
 * of the same data produce the same columns and rows.
 *
 * Leading blank rows are skipped and the first non-blank row is the header. Cells are kept as
 * written apart from stringification — trimming a value would silently change what the
 * hospital's system actually holds, which is exactly what an analyst is here to see.
 */
function tabulate(grid: readonly (readonly unknown[])[], name: string | null, opts?: ReadOptions): Sheet {
  const isBlank = (cells: readonly unknown[]) => cells.every((c) => cellText(c).trim() === "");
  let start = 0;
  while (start < grid.length && isBlank(grid[start])) start++;
  if (start >= grid.length) return { name, columns: [], rows: [], truncated: false };

  const header = grid[start];
  const width = grid.slice(start).reduce((w, r) => Math.max(w, r.length), header.length);
  const names: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < width; i++) {
    const base = cellText(header[i]).trim() || `Column ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    names.push(n === 1 ? base : `${base} (${n})`);
  }

  const rows: Record<string, string>[] = [];
  let truncated = false;
  for (let r = start + 1; r < grid.length; r++) {
    const cells = grid[r];
    if (isBlank(cells)) continue;
    if (opts?.maxRows !== undefined && rows.length >= opts.maxRows) {
      truncated = true;
      break;
    }
    const record: Record<string, string> = {};
    for (let i = 0; i < width; i++) record[names[i]] = cellText(cells[i]);
    rows.push(record);
  }

  const columns: SheetColumn[] = names.map((column) => {
    const distinct = new Set<string>();
    let nonEmpty = 0;
    for (const row of rows) {
      const v = row[column];
      if (v.trim() === "") continue;
      nonEmpty++;
      distinct.add(v);
    }
    return { name: column, sampleValues: [...distinct].slice(0, 3), nonEmpty, distinct: distinct.size };
  });

  return { name, columns, rows, truncated };
}

function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string") return cell;
  if (cell instanceof Date) return cell.toISOString();
  return String(cell);
}

/**
 * Read the FIRST worksheet of an .xlsx / .xls / .ods file.
 *
 * Cells come back as the text the spreadsheet DISPLAYS (`raw: false`), not the stored
 * number: a date column shows `2025-02-13` or `13/02/2025` as the hospital formatted it,
 * not the serial `45701`. That is what the analyst will map, so it is what they should see.
 */
export async function readSheet(file: ArrayBuffer | Uint8Array, opts?: ReadOptions): Promise<Sheet> {
  const xlsx = await import("xlsx");
  const data = file instanceof Uint8Array ? file : new Uint8Array(file);
  const workbook = xlsx.read(data, { type: "array", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (sheetName === undefined) return { name: null, columns: [], rows: [], truncated: false };
  const worksheet = workbook.Sheets[sheetName];
  const grid = xlsx.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  });
  return tabulate(grid, sheetName, opts);
}

/**
 * Read CSV text with no dependency. RFC 4180 quoting (`"a ""b"", c"`), CRLF or LF line
 * ends, a UTF-8 BOM, and a delimiter detected from the header line (`,` `;` or tab).
 */
export function readCsv(text: string, opts?: ReadOptions & { delimiter?: string }): Sheet {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = opts?.delimiter ?? detectDelimiter(src);
  const grid: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      grid.push(row);
      row = [];
      cell = "";
    } else {
      cell += c;
    }
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    grid.push(row);
  }
  return tabulate(grid, null, opts);
}

/** The delimiter that occurs most on the header line, outside quotes. Ties go to the comma. */
function detectDelimiter(src: string): string {
  const end = src.search(/\r|\n/);
  const line = end === -1 ? src : src.slice(0, end);
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && c in counts) counts[c]++;
  }
  let best = ",";
  for (const d of [";", "\t"]) if (counts[d] > counts[best]) best = d;
  return best;
}

/* ========================================================================== *
 * 2. The mapping model
 * ========================================================================== */

/**
 * How a pair was arrived at.
 *
 *   `exact-name`  the column name equals a profile row's label or locator, ignoring case and
 *                 punctuation. Deterministic, so it starts confirmed; the analyst can revoke.
 *   `analyst`     a human chose it. Confirmed by definition.
 *   `model`       a model proposed it. NEVER confirmed until a human says so, and
 *                 {@link generateFromTemplate} will not apply it before then.
 */
export type MappingVia = "analyst" | "model" | "exact-name";

export interface MappingEntry {
  column: string;
  /** A `ProfileRow.locator`, e.g. `PID-3`, or a finer position the tree has, e.g. `PID-3.1`. */
  locator: string;
  confirmed: boolean;
  via: MappingVia;
}

export interface ColumnMapping {
  structureId: string;
  entries: MappingEntry[];
  /** Columns with no entry. */
  unmapped: string[];
  /** Why a column that looked mappable was left alone. Deterministic; safe to show. */
  notes: string[];
}

/** Case- and punctuation-insensitive form used for name matching. */
export function normaliseName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Positions a column may be mapped onto: every profile row with a locator, except rows the
 * spec forbids. Pre-arranging hospital data into a position that SHALL NOT be present would
 * manufacture a defect, so those are never offered — to the name matcher or to a model.
 */
export function mappingCandidates(profile: Profile): { locator: string; label: string; usage: string }[] {
  const out: { locator: string; label: string; usage: string }[] = [];
  const seen = new Set<string>();
  for (const row of profile.rows) {
    if (!row.locator || row.obligation === "forbidden" || seen.has(row.locator)) continue;
    seen.add(row.locator);
    out.push({ locator: row.locator, label: row.label, usage: row.usage.join("/") || OBLIGATION_LABEL[row.obligation] });
  }
  return out;
}

/**
 * The deterministic first pass.
 *
 * A column maps when its normalised name equals exactly one candidate's normalised label or
 * locator. Two candidates with the same name ("Set ID" on two segments) leave the column
 * unmapped with a note; two columns claiming one position keep the first and note the second.
 * Same input, same output, every time — this is the part of the mapping nobody needs to
 * review for hallucination.
 */
export function autoMapByName(sheet: Pick<Sheet, "columns">, profile: Profile): ColumnMapping {
  const byName = new Map<string, Set<string>>();
  const add = (name: string, locator: string) => {
    const key = normaliseName(name);
    if (!key) return;
    const set = byName.get(key) ?? new Set<string>();
    set.add(locator);
    byName.set(key, set);
  };
  for (const c of mappingCandidates(profile)) {
    add(c.label, c.locator);
    add(c.locator, c.locator);
  }

  const entries: MappingEntry[] = [];
  const unmapped: string[] = [];
  const notes: string[] = [];
  const claimed = new Map<string, string>();
  for (const column of sheet.columns) {
    const hits = byName.get(normaliseName(column.name));
    if (!hits || hits.size === 0) {
      unmapped.push(column.name);
      continue;
    }
    if (hits.size > 1) {
      unmapped.push(column.name);
      notes.push(`"${column.name}" names ${[...hits].sort().join(" and ")}; left unmapped rather than guess between them.`);
      continue;
    }
    const locator = [...hits][0];
    const earlier = claimed.get(locator);
    if (earlier !== undefined) {
      unmapped.push(column.name);
      notes.push(`"${column.name}" also names ${locator}, already taken by "${earlier}"; left unmapped.`);
      continue;
    }
    claimed.set(locator, column.name);
    entries.push({ column: column.name, locator, confirmed: true, via: "exact-name" });
  }
  return { structureId: profile.structureId, entries, unmapped, notes };
}

/**
 * The shape of a model's proposal, declared structurally so this module never imports the AI
 * layer (tests/boundary.test.mjs asserts that). `ai.ts`'s `ColumnMapping` satisfies it.
 */
export interface ModelProposal {
  mappings: readonly { column: string; locator: string | null }[];
}

/**
 * Fold a model's proposal into a mapping as UNCONFIRMED entries.
 *
 * Three refusals, each recorded in `notes`: a column that already has an entry keeps it (a
 * human's or the exact-name pass's choice is never overwritten by a model); a locator not in
 * the profile is dropped (the candidate list is closed — a model naming a position the spec
 * does not have is the failure mode this product exists to catch); a column the sheet does
 * not have is dropped.
 */
export function mergeModelProposal(mapping: ColumnMapping, proposal: ModelProposal, profile: Profile): ColumnMapping {
  const allowed = new Set(mappingCandidates(profile).map((c) => c.locator));
  const known = new Set([...mapping.entries.map((e) => e.column), ...mapping.unmapped]);
  const entries = [...mapping.entries];
  const notes = [...mapping.notes];
  const taken = new Set(entries.map((e) => e.column));
  for (const p of proposal.mappings) {
    if (p.locator === null) continue;
    if (!known.has(p.column)) {
      notes.push(`The model proposed a mapping for "${p.column}", which the sheet does not have; dropped.`);
      continue;
    }
    if (taken.has(p.column)) {
      notes.push(`The model proposed ${p.locator} for "${p.column}", which is already mapped; the existing entry stands.`);
      continue;
    }
    if (!allowed.has(p.locator)) {
      notes.push(`The model proposed ${p.locator} for "${p.column}", which is not a position in this profile; dropped.`);
      continue;
    }
    taken.add(p.column);
    entries.push({ column: p.column, locator: p.locator, confirmed: false, via: "model" });
  }
  return {
    structureId: mapping.structureId,
    entries,
    unmapped: mapping.unmapped.filter((c) => !taken.has(c)),
    notes,
  };
}

/**
 * Record an analyst's decision for one column: a locator (confirmed, via `analyst`), or
 * `null` to remove the column's entry. Any locator string is accepted here — the analyst may
 * name a component such as `PID-3.1` that the profile lists only as `PID-3` — and
 * {@link generateFromTemplate} reports whether the template actually has it.
 */
export function setAnalystChoice(mapping: ColumnMapping, column: string, locator: string | null): ColumnMapping {
  const entries = mapping.entries.filter((e) => e.column !== column);
  const unmapped = mapping.unmapped.filter((c) => c !== column);
  if (locator === null) unmapped.push(column);
  else entries.push({ column, locator: locator.trim(), confirmed: true, via: "analyst" });
  return { ...mapping, entries, unmapped };
}

/** Flip one entry's confirmation. Used for a model proposal the analyst has reviewed. */
export function confirmEntry(mapping: ColumnMapping, column: string, confirmed: boolean): ColumnMapping {
  return {
    ...mapping,
    entries: mapping.entries.map((e) => (e.column === column ? { ...e, confirmed } : e)),
  };
}

/* ========================================================================== *
 * 3. Generation by template
 * ========================================================================== */

export interface GenerateResult {
  text: string;
  /** Locators whose value was written AND verified present in the re-parsed output. */
  applied: string[];
  /** Every mapped position that was not written, and why. Never empty when something was not. */
  skipped: { locator: string; column: string; why: string }[];
}

const HL7_LOCATOR = /^\s*([A-Z][A-Z0-9]{2})[-.](\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/i;

/** `PID-3.1` -> a locator, or `null` when the text is not an HL7 position. */
export function parseHl7Locator(text: string): Hl7FieldLocator | null {
  const m = HL7_LOCATOR.exec(text);
  if (!m) return null;
  const locator: Hl7FieldLocator = { kind: "hl7Field", segment: m[1].toUpperCase(), field: Number(m[2]) };
  if (m[3] !== undefined) locator.component = Number(m[3]);
  if (m[4] !== undefined) locator.subcomponent = Number(m[4]);
  return locator;
}

/**
 * A predicate for "this tree node sits at the mapped position", or `null` when the text
 * cannot be a position in this encoding.
 *
 * HL7 compares canonical {@link locatorKey}s, so `PID-3.1`, `pid-3.1` and `PID.3.1` all find
 * the same component. The XML and JSON families compare the profile's own display form
 * ({@link formatLocator}), because that string is what the profile row hands the analyst.
 */
function matcherFor(locator: string, encoding: MessageEncoding): ((node: TreeNode) => boolean) | null {
  if (encoding === "hl7v2-er7") {
    const target = parseHl7Locator(locator);
    if (!target) return null;
    const key = locatorKey(target);
    return (node) => node.locator !== null && locatorKey(node.locator) === key;
  }
  const want = locator.trim();
  if (!want) return null;
  return (node) => node.locator !== null && formatLocator(node.locator) === want;
}

function firstNode(tree: ParseOutcome["tree"], matches: (node: TreeNode) => boolean): TreeNode | null {
  let found: TreeNode | null = null;
  walkTree(tree, (node) => {
    if (found) return false;
    if (node.present !== false && matches(node)) {
      found = node;
      return false;
    }
  });
  return found;
}

/** Node kinds that carry a value of their own. Everything else holds shape, not content. */
const VALUE_KINDS = new Set<TreeNode["kind"]>(["field", "repetition", "component", "subcomponent", "element", "attribute", "slot", "text"]);

/**
 * Make an emitter serialise `value` instead of the text the parser recorded. Each family
 * remembers its source text somewhere different, and clearing only `raw` would leave the
 * FHIR and XDS emitters replaying the template — silently, which is why the result is
 * re-parsed afterwards rather than trusted.
 */
function forgetSourceText(node: TreeNode): void {
  node.raw = null;
  const fmt = (node as FhirTreeNode).fmt;
  if (fmt) delete fmt.tokenRaw;
  delete (node as XdsTreeNode).xml;
}

/**
 * Fill a template with one row.
 *
 * `templateText` is an official golden sample or a message the hospital already sends; it
 * must parse against `structure`, or this throws — filling a tree the parser could not build
 * would produce a message nobody has evidence for. Every entry in `mapping` is then either
 * written or listed in `skipped` with a reason; nothing is quietly dropped.
 *
 * Out of scope, by design and recorded as skipped: adding a node the template lacks,
 * expanding a repeating group, writing a composite field as one string, and rewriting
 * MSH-1/MSH-2 (they declare the delimiters the rest of the message is written with).
 */
export async function generateFromTemplate(
  templateText: string,
  structure: MessageStructure,
  resolved: ResolvedUseCase,
  mapping: ColumnMapping,
  row: Readonly<Record<string, string>>,
): Promise<GenerateResult> {
  if (mapping.structureId !== structure.id) {
    throw new Error(`the mapping was built for ${mapping.structureId}, not for ${structure.id}.`);
  }
  // No parser reports failure on text of the wrong kind — each builds what it can and says
  // the rest in diagnostics — so a JSON bundle handed to the ADT structure would come back as
  // one unplaceable segment and every mapped position "not in the template". The encoding
  // sniff `analyse` uses is the evidence that stops that before anything is written.
  const guess = detectEncoding(templateText);
  if (guess.encoding !== "unknown" && guess.encoding !== structure.encoding) {
    throw new Error(
      `the template looks like ${ENCODING_LABEL[guess.encoding]} — ${guess.because} — but ${structure.title} is ${ENCODING_LABEL[structure.encoding]}.`,
    );
  }
  const parsed = await parseMessage(templateText, structure, resolved);
  if (parsed.failure) {
    throw new Error(`the template does not parse as ${structure.title}: ${parsed.failure}`);
  }

  const skipped: GenerateResult["skipped"] = [];
  const written: { locator: string; column: string; value: string; matches: (node: TreeNode) => boolean }[] = [];
  const claimed = new Map<string, string>();

  for (const entry of mapping.entries) {
    const skip = (why: string) => skipped.push({ locator: entry.locator, column: entry.column, why });
    if (!entry.confirmed) {
      skip(`proposed via ${entry.via} and not confirmed by an analyst; unconfirmed entries are never written.`);
      continue;
    }
    const value = row[entry.column];
    if (value === undefined) {
      skip(`the row has no column "${entry.column}".`);
      continue;
    }
    const matches = matcherFor(entry.locator, structure.encoding);
    if (!matches) {
      skip(`"${entry.locator}" is not a position in a ${structure.encoding} message.`);
      continue;
    }
    if (structure.encoding === "hl7v2-er7") {
      const hl7 = parseHl7Locator(entry.locator);
      if (hl7 && hl7.segment === "MSH" && (hl7.field === 1 || hl7.field === 2)) {
        skip(`${formatLocator(hl7)} declares the message's delimiters; rewriting it would change how every other field is read.`);
        continue;
      }
    }
    const node = firstNode(parsed.tree, matches);
    if (!node) {
      skip(`the template has no ${entry.locator}; adding a node is out of scope, so choose a template that carries one.`);
      continue;
    }
    const canonical = node.locator ? locatorKey(node.locator) : entry.locator;
    const earlier = claimed.get(canonical);
    if (earlier !== undefined) {
      skip(`already written from column "${earlier}".`);
      continue;
    }
    if (!VALUE_KINDS.has(node.kind)) {
      skip(`${entry.locator} is a ${node.kind} in the template and carries no value of its own.`);
      continue;
    }
    if (node.children.length > 0) {
      const first = node.children[0];
      if (first.kind === "repetition") {
        skip(`${entry.locator} repeats ${node.children.length} times in the template; repeating groups are out of scope.`);
      } else {
        // XML text children carry their parent's locator, so a hint must name a child that is
        // actually addressable on its own — or say nothing.
        const own = node.locator ? formatLocator(node.locator) : null;
        const part = node.children.find((c) => c.locator && formatLocator(c.locator) !== own);
        const hint = part?.locator ? formatLocator(part.locator) : null;
        skip(
          `${entry.locator} is composite in the template (${node.children.length} parts); writing it as one string would ` +
            `destroy that structure. Map the column to a part${hint ? ` such as ${hint}` : ""} instead.`,
        );
      }
      continue;
    }
    claimed.set(canonical, entry.column);
    node.value = value;
    forgetSourceText(node);
    written.push({ locator: entry.locator, column: entry.column, value, matches });
  }

  const text = emitMessage(parsed.tree, structure, parsed);

  // Verify, do not trust: the only evidence that an edit reached the wire is the wire.
  const check = await parseMessage(text, structure, resolved);
  if (check.failure) {
    throw new Error(
      `the generated message no longer parses as ${structure.title} (${check.failure}); ` +
        `a cell value probably breaks the encoding. Columns written: ${written.map((w) => w.column).join(", ")}.`,
    );
  }
  const applied: string[] = [];
  for (const w of written) {
    const node = firstNode(check.tree, w.matches);
    if (node && node.value === w.value) {
      applied.push(w.locator);
    } else {
      skipped.push({
        locator: w.locator,
        column: w.column,
        why: node
          ? `the ${structure.encoding} emitter wrote ${JSON.stringify(node.value)} where ${JSON.stringify(w.value)} was asked for; the template's text at ${w.locator} was not replaced.`
          : `${w.locator} is no longer found after re-parsing the generated message.`,
      });
    }
  }
  return { text, applied, skipped };
}
