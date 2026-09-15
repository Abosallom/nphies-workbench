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
import type { FieldTable, MessageStructure, UsageCode } from "./structure";

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
