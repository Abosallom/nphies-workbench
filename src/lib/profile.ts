/**
 * The integration profile: what a hospital's HIS actually has to build for one message, and
 * — just as usefully — what it does NOT.
 *
 * Of 725 compiled HL7 field rows, 522 are ignored by NPHIES outright and only 35 are truly
 * mandatory. Telling a HIS vendor which 35 those are, in a form they can paste into a
 * backlog, removes more onboarding time than any amount of validation after the fact.
 *
 * Exports are plain text/JSON on purpose: a vendor reuses one profile across hospitals, and
 * nothing here needs the workbench to open it.
 */

import { adaptStructure, type SpecDetail } from "./adapt";
import { USAGE_SEMANTICS, type FieldTable, type MessageStructure, type UsageCode } from "./structure";

export type Obligation = "must" | "ifKnown" | "optional" | "ignored" | "forbidden" | "unstated";

export interface ProfileRow {
  id: string;
  /** `PID-3`, `./entry/resource`, `/ClinicalDocument/recordTarget`. */
  locator: string | null;
  label: string;
  path: string;
  depth: number;
  obligation: Obligation;
  usage: UsageCode[];
  cardinality: string | null;
  /** The condition a conditional rule applies under, e.g. "Report". */
  conditions: string[];
  datatype: string | null;
  fixedValue: string | null;
  valueSet: string | null;
  valueSetExternal: boolean;
  guidance: string | null;
  /** `null` means the rule is not in the published specification. */
  pageId: string | null;
  quote: string | null;
}

export interface Profile {
  structureId: string;
  title: string;
  encoding: string;
  generatedAt: string;
  rows: ProfileRow[];
  counts: Record<Obligation, number>;
  /** Rules resting only on an official sample, not on a published page. */
  sampleDerived: number;
  notes: string[];
}

const ORDER: Record<Obligation, number> = {
  must: 0,
  ifKnown: 1,
  optional: 2,
  unstated: 3,
  ignored: 4,
  forbidden: 5,
};

export const OBLIGATION_LABEL: Record<Obligation, string> = {
  must: "Must build",
  ifKnown: "Send if known",
  optional: "Optional",
  unstated: "No rule stated",
  ignored: "Do not build",
  forbidden: "Must not send",
};

export const OBLIGATION_HINT: Record<Obligation, string> = {
  must: "Usage M or R. The message is rejected without it.",
  ifKnown: "Usage R2. Send it when your system holds the value; it never blocks submission.",
  optional: "Usage O. Neither required nor discouraged.",
  unstated: "The specification states no usage here, so the workbench enforces nothing.",
  ignored: "Usage I. NPHIES accepts it and then discards it — building it is wasted work.",
  forbidden: "Usage NP or X. Sending it is a defect.",
};

/**
 * Collapse a row's usage list to one obligation.
 *
 * Conditional rows carry several usages at once ("M (Report) / NP (Order)"), and the honest
 * summary of that is the STRICTEST reading — a vendor who builds for it is never caught out
 * — with the conditions carried alongside so the reader can see why.
 */
function obligationOf(usages: readonly UsageCode[]): Obligation {
  if (!usages.length) return "unstated";
  if (usages.includes("M") || usages.includes("R")) return "must";
  if (usages.includes("R2")) return "ifKnown";
  if (usages.includes("NP") || usages.includes("X")) return "forbidden";
  if (usages.includes("O")) return "optional";
  if (usages.includes("I")) return "ignored";
  return "unstated";
}

function rowOf(detail: SpecDetail): ProfileRow {
  const usage = detail.usage.map((u) => u.usage).filter((u): u is UsageCode => Boolean(u) && u !== "-");
  const first = detail.usage[0];
  const binding = detail.valueSets.find((v) => v.valueSetId || v.title);
  const fixed = detail.fixedValues.find((f) => f.scope === "wholeField" && f.value) ?? detail.fixedValues.find((f) => f.value);
  return {
    id: detail.id,
    locator: detail.locator,
    label: detail.label.replace(/\s+/g, " ").trim(),
    path: detail.path,
    depth: detail.depth,
    obligation: obligationOf(usage),
    usage,
    cardinality: first?.raw?.cardinality ?? cardinality(first?.min ?? null, first?.max ?? null),
    conditions: detail.usage.map((u) => u.condition).filter((c): c is string => Boolean(c)),
    datatype: detail.datatype,
    fixedValue: fixed?.value ?? null,
    valueSet: binding ? (binding.title ?? binding.valueSetId) : null,
    valueSetExternal: Boolean(binding?.external),
    guidance: detail.guidance ? detail.guidance.replace(/\s+/g, " ").trim() : null,
    pageId: detail.provenance?.pageId ?? null,
    quote: detail.provenance?.quote ?? null,
  };
}

function cardinality(min: number | null, max: number | "*" | null): string | null {
  if (min === null && max === null) return null;
  return `${min ?? 0}..${max ?? "*"}`;
}

/** Build the profile for one message structure. */
export function buildProfile(
  structure: MessageStructure,
  tables: ReadonlyMap<string, FieldTable> | undefined,
): Profile {
  const adapted = adaptStructure(structure, tables);
  const rows = [...adapted.details.values()].map(rowOf);
  const counts: Record<Obligation, number> = {
    must: 0,
    ifKnown: 0,
    optional: 0,
    unstated: 0,
    ignored: 0,
    forbidden: 0,
  };
  for (const row of rows) counts[row.obligation]++;
  return {
    structureId: structure.id,
    title: structure.title,
    encoding: structure.encoding,
    generatedAt: new Date().toISOString(),
    rows,
    counts,
    sampleDerived: adapted.sampleDerived,
    notes: structure.notes,
  };
}

/** Rows in the order a vendor reads them: what must be built first. */
export function sortByObligation(rows: readonly ProfileRow[]): ProfileRow[] {
  return [...rows].sort((a, b) => ORDER[a.obligation] - ORDER[b.obligation] || a.path.localeCompare(b.path));
}

/* ------------------------------------------------------------------ exports */

/** A handover document for a HIS vendor: obligations first, evidence attached. */
export function profileToMarkdown(profile: Profile): string {
  const out: string[] = [];
  out.push(`# ${profile.title} — integration profile`);
  out.push("");
  out.push(`Structure \`${profile.structureId}\` · encoding \`${profile.encoding}\``);
  out.push(`Generated ${profile.generatedAt} by the NPHIES Message Structure Workbench.`);
  out.push("");
  out.push(
    `**${profile.counts.must} positions must be built.** ${profile.counts.ifKnown} more should be sent when known. ` +
      `${profile.counts.ignored} are accepted and discarded by NPHIES — building them is wasted work.`,
  );
  if (profile.sampleDerived) {
    out.push("");
    out.push(
      `> ${profile.sampleDerived} of these rules are not in the published specification. They were read off the ` +
        `official sample messages and are marked \`sample\` below: they describe what NPHIES sends, not what NPHIES requires.`,
    );
  }
  if (profile.notes.length) {
    out.push("");
    out.push("## Caveats recorded while compiling this structure");
    for (const n of profile.notes) out.push(`- ${n}`);
  }

  for (const obligation of ["must", "ifKnown", "forbidden", "optional", "unstated", "ignored"] as Obligation[]) {
    const rows = profile.rows.filter((r) => r.obligation === obligation);
    if (!rows.length) continue;
    out.push("");
    out.push(`## ${OBLIGATION_LABEL[obligation]} (${rows.length})`);
    out.push("");
    out.push(`_${OBLIGATION_HINT[obligation]}_`);
    out.push("");
    out.push("| Position | Field | Usage | Card. | Type | Fixed value | Source |");
    out.push("|---|---|---|---|---|---|---|");
    for (const r of rows) {
      out.push(
        `| \`${r.locator ?? r.path}\` | ${escapeCell(r.label)} | ${r.usage.join(" / ") || "—"} | ${
          r.cardinality ?? "—"
        } | ${r.datatype ?? "—"} | ${r.fixedValue ? `\`${escapeCell(r.fixedValue)}\`` : "—"} | ${
          r.pageId ? `page ${r.pageId}` : "sample"
        } |`,
      );
    }
  }
  return out.join("\n");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Portable JSON, so a vendor can reuse one profile across hospitals. */
export function profileToJson(profile: Profile): string {
  return JSON.stringify(profile, null, 2);
}

export function profileToCsv(profile: Profile): string {
  const head = [
    "obligation",
    "locator",
    "label",
    "usage",
    "cardinality",
    "datatype",
    "fixedValue",
    "valueSet",
    "pageId",
    "path",
  ];
  const cell = (v: string | null) => `"${(v ?? "").replace(/"/g, '""')}"`;
  const lines = [head.join(",")];
  for (const r of profile.rows) {
    lines.push(
      [
        cell(OBLIGATION_LABEL[r.obligation]),
        cell(r.locator),
        cell(r.label),
        cell(r.usage.join(" / ")),
        cell(r.cardinality),
        cell(r.datatype),
        cell(r.fixedValue),
        cell(r.valueSet),
        cell(r.pageId),
        cell(r.path),
      ].join(","),
    );
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ import */

export type ParsedProfile = { profile: Profile; warnings: string[] } | { error: string };

const OBLIGATIONS = Object.keys(ORDER) as Obligation[];
const USAGE_CODES = new Set<string>(Object.keys(USAGE_SEMANTICS));

/**
 * Field-by-field validators for a row. Kept as a table so a bad row is reported by the
 * FIELD that is wrong ("rows[12].obligation is 'mandatory'"), which is what someone hand-
 * editing a vendor's file needs to fix it; a single schema-failed message is not.
 */
type FieldCheck = (v: unknown) => string | null;
const isString: FieldCheck = (v) => (typeof v === "string" ? null : `must be a string, got ${describe(v)}`);
const isNullableString: FieldCheck = (v) => (v === null || typeof v === "string" ? null : `must be a string or null, got ${describe(v)}`);
const isBoolean: FieldCheck = (v) => (typeof v === "boolean" ? null : `must be true or false, got ${describe(v)}`);
const isInteger: FieldCheck = (v) => (Number.isInteger(v) ? null : `must be a whole number, got ${describe(v)}`);
const isStringArray: FieldCheck = (v) =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? null : `must be a list of strings, got ${describe(v)}`;

const ROW_FIELDS: Record<keyof ProfileRow, FieldCheck> = {
  id: isString,
  locator: isNullableString,
  label: isString,
  path: isString,
  depth: isInteger,
  obligation: (v) =>
    typeof v === "string" && (OBLIGATIONS as string[]).includes(v)
      ? null
      : `must be one of ${OBLIGATIONS.join(", ")}, got ${describe(v)}`,
  usage: (v) => {
    const listErr = isStringArray(v);
    if (listErr) return listErr;
    const bad = (v as string[]).filter((u) => !USAGE_CODES.has(u));
    return bad.length ? `contains usage code(s) the specification does not define: ${bad.join(", ")}` : null;
  },
  cardinality: isNullableString,
  conditions: isStringArray,
  datatype: isNullableString,
  fixedValue: isNullableString,
  valueSet: isNullableString,
  valueSetExternal: isBoolean,
  guidance: isNullableString,
  pageId: isNullableString,
  quote: isNullableString,
};

function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "nothing";
  if (Array.isArray(v)) return "a list";
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v);
  return typeof v === "object" ? "an object" : String(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function countObligations(rows: readonly ProfileRow[]): Record<Obligation, number> {
  const counts = { must: 0, ifKnown: 0, optional: 0, unstated: 0, ignored: 0, forbidden: 0 };
  for (const row of rows) counts[row.obligation]++;
  return counts;
}

/**
 * Read a profile written by `profileToJson`, so one hospital's (or a vendor's) profile can be
 * laid beside another's.
 *
 * Two rules govern what comes back. First, nothing in the file is trusted where it can be
 * recomputed: `counts` is rebuilt from the rows and a mismatch is reported, because a file
 * that says "35 must be built" over 40 mandatory rows is exactly the kind of document a
 * vendor would build a backlog from. Second, an imported row is still just a claim about what
 * some OTHER compilation of the specification said — it carries its own `pageId`/`quote`
 * evidence and never overrides this workbench's compiled rules; `reconcileProfile` only
 * shows the two side by side.
 *
 * Never throws: a person pasting a file they were handed gets one sentence naming what to fix.
 */
export function parseProfile(text: string): ParsedProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: `The file is not valid JSON (${(err as Error).message}). Export the profile again from the workbench.` };
  }
  if (!isRecord(raw)) return { error: `A profile is a JSON object, but the file holds ${describe(raw)}.` };

  if (typeof raw.structureId !== "string" || !raw.structureId.trim()) {
    return { error: `The profile has no "structureId" naming the message structure it describes, so it cannot be matched to one.` };
  }
  for (const key of ["title", "encoding", "generatedAt"] as const) {
    if (typeof raw[key] !== "string") return { error: `"${key}" must be a string, got ${describe(raw[key])}.` };
  }
  if (!Array.isArray(raw.rows)) return { error: `"rows" must be a list of field rows, got ${describe(raw.rows)}.` };

  const warnings: string[] = [];
  const rows: ProfileRow[] = [];
  const seenIds = new Set<string>();
  const known = Object.keys(ROW_FIELDS);
  for (let i = 0; i < raw.rows.length; i++) {
    const r: unknown = raw.rows[i];
    if (!isRecord(r)) return { error: `rows[${i}] must be an object, got ${describe(r)}.` };
    const row: Record<string, unknown> = {};
    for (const key of known) {
      const problem = ROW_FIELDS[key as keyof ProfileRow](r[key]);
      if (problem) return { error: `rows[${i}].${key} ${problem}.` };
      row[key] = r[key];
    }
    // Extra keys are dropped, not rejected: a newer workbench may write fields this one does
    // not know, and refusing the whole file over them would strand the rows it does understand.
    const extra = Object.keys(r).filter((k) => !known.includes(k));
    if (extra.length) warnings.push(`rows[${i}] carried field(s) this version does not know and ignored them: ${extra.join(", ")}.`);
    const parsed = row as unknown as ProfileRow;
    if (seenIds.has(parsed.id)) warnings.push(`rows[${i}] repeats the id "${parsed.id}"; rows are matched by locator, not id, so both were kept.`);
    seenIds.add(parsed.id);
    rows.push(parsed);
  }

  const counts = countObligations(rows);
  if (!isRecord(raw.counts)) {
    warnings.push(`"counts" was ${describe(raw.counts)}; it was recomputed from the rows.`);
  } else {
    const lies = OBLIGATIONS.filter((o) => raw.counts && (raw.counts as Record<string, unknown>)[o] !== counts[o]);
    if (lies.length) {
      warnings.push(
        `"counts" did not match the rows and was recomputed: ${lies
          .map((o) => `${o} said ${describe((raw.counts as Record<string, unknown>)[o])}, rows hold ${counts[o]}`)
          .join("; ")}.`,
      );
    }
  }

  let sampleDerived = 0;
  if (Number.isInteger(raw.sampleDerived) && (raw.sampleDerived as number) >= 0) sampleDerived = raw.sampleDerived as number;
  else warnings.push(`"sampleDerived" must be a non-negative whole number, got ${describe(raw.sampleDerived)}; treated as 0.`);

  let notes: string[] = [];
  if (isStringArray(raw.notes) === null) notes = raw.notes as string[];
  else warnings.push(`"notes" must be a list of strings, got ${describe(raw.notes)}; the caveats were dropped.`);

  return {
    profile: {
      structureId: raw.structureId,
      title: raw.title as string,
      encoding: raw.encoding as string,
      generatedAt: raw.generatedAt as string,
      rows,
      counts,
      sampleDerived,
      notes,
    },
    warnings,
  };
}

/* ------------------------------------------------------------------ reconcile */

export interface ProfileDiff {
  /** In the imported profile, absent from the current one. */
  added: ProfileRow[];
  /** In the current profile, absent from the imported one. */
  removed: ProfileRow[];
  /** Same position, different rule. `before` is the current row, `after` the imported one. */
  changed: { before: ProfileRow; after: ProfileRow }[];
  unchanged: number;
}

/**
 * The key two rows must share to be "the same position".
 *
 * Locators are what people quote ("PID-3"), so they win — but a locator can legitimately
 * recur (a segment inside two groups), and a recurring one cannot say WHICH row it is. Such
 * rows fall back to the path, and — because a FHIR bundle's seven entry slots all share the
 * path `Bundle/./entry/./entry` — a recurring path falls back to the compiled row id. Each
 * level's uniqueness is judged over both profiles at once so a row keys the same way on
 * either side; an id-keyed row across two compilations is only as stable as the compiler,
 * which the row's label makes visible in the diff.
 */
function rowKeys(a: readonly ProfileRow[], b: readonly ProfileRow[]): (row: ProfileRow) => string {
  const levels: { name: string; of: (r: ProfileRow) => string | null }[] = [
    { name: "locator", of: (r) => r.locator },
    { name: "path", of: (r) => r.path },
  ];
  const ambiguous = levels.map(() => new Set<string>());
  for (const rows of [a, b]) {
    levels.forEach((level, i) => {
      const seen = new Set<string>();
      for (const r of rows) {
        const v = level.of(r);
        if (v === null) continue;
        if (seen.has(v)) ambiguous[i].add(v);
        seen.add(v);
      }
    });
  }
  return (row) => {
    for (let i = 0; i < levels.length; i++) {
      const v = levels[i].of(row);
      if (v !== null && !ambiguous[i].has(v)) return `${levels[i].name}:${v}`;
    }
    return `id:${row.id}`;
  };
}

/** Everything about a row except its internal id, which says nothing about the rule. */
function ruleOf(row: ProfileRow): string {
  const { id: _id, ...rule } = row;
  return JSON.stringify(rule);
}

/**
 * Lay an imported profile beside the one this workbench compiled.
 *
 * Purely a comparison: it neither merges nor picks a winner. A vendor's file saying a
 * position is optional where the compiled specification says mandatory is a difference to
 * show, with both rows' evidence, not a reason to soften the compiled rule.
 */
export function reconcileProfile(imported: Profile, current: Profile): ProfileDiff {
  const key = rowKeys(imported.rows, current.rows);
  const currentByKey = new Map<string, ProfileRow>();
  for (const row of current.rows) currentByKey.set(key(row), row);

  const diff: ProfileDiff = { added: [], removed: [], changed: [], unchanged: 0 };
  const matched = new Set<string>();
  for (const row of imported.rows) {
    const k = key(row);
    const before = currentByKey.get(k);
    if (!before || matched.has(k)) {
      diff.added.push(row);
      continue;
    }
    matched.add(k);
    if (ruleOf(before) === ruleOf(row)) diff.unchanged++;
    else diff.changed.push({ before, after: row });
  }
  for (const row of current.rows) if (!matched.has(key(row))) diff.removed.push(row);
  return diff;
}
