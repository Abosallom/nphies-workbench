import { useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  CATEGORY_VAR,
  CopyButton,
  Donut,
  EmptyState,
  ProportionBar,
  SEV_DOT,
  SEVERITY_GLYPH,
  SourceNote,
  Toolbar,
  ToolbarTitle,
  Tooltip,
  UsageBadge,
  useToast,
  type DensityChoice,
  type Segment,
  type Usage,
} from "../ui";
import type { MessageStructure } from "../lib/structure";
import type { GoldenSample, ResolvedUseCase } from "../lib/workbench";
import {
  buildProfile,
  OBLIGATION_HINT,
  OBLIGATION_LABEL,
  parseProfile,
  profileToCsv,
  profileToJson,
  profileToMarkdown,
  reconcileProfile,
  sortByObligation,
  type Obligation,
  type Profile,
  type ProfileDiff,
  type ProfileRow,
} from "../lib/profile";

/* ========================================================================== *
 * Build — what the HIS has to produce, and what it must not waste time on.
 *
 * The workbench will not fabricate a message: a generated skeleton full of invented
 * identifiers is a liability, and the official samples already exist for reference. What a
 * hospital actually lacks is a precise, citable statement of the required surface — so that
 * is what this produces, in a form a HIS vendor can work from directly.
 *
 * The chart exists because the biggest number here is the one nobody reads: of 725 compiled
 * HL7 positions, 522 are accepted and discarded by NPHIES. Six integers inside filter chips
 * do not say that; one bar with a 72% grey segment does.
 * ========================================================================== */

const GROUPS: Obligation[] = ["must", "ifKnown", "forbidden", "optional", "unstated", "ignored"];

const TONE: Record<Obligation, "error" | "warn" | "neutral" | "ignored" | "accent"> = {
  must: "error",
  ifKnown: "warn",
  forbidden: "error",
  optional: "neutral",
  unstated: "neutral",
  ignored: "ignored",
};

/**
 * How each obligation is coloured in the chart — decided here, deliberately.
 *
 * Obligation IS verdict semantics. "Must build" means the validator raises E when the
 * position is missing; "send if known" raises !; "do not build" is the position NPHIES
 * discards (–); "must not send" raises E when it is present. Those four therefore wear the
 * reserved severity tones, each with its glyph, painted exactly as the validator would paint
 * the finding. Must and must-not-send SHARE the error tone on purpose: they are the same
 * verdict, and a second red to tell them apart would claim a severity difference that does
 * not exist. Their labels, the 2px gap and the legend keep them distinct.
 *
 * "Optional" and "no rule stated" are NOT verdicts — the validator raises nothing either
 * way — so a severity tone would invent one. Nor can they be a flat grey: --nw-ink-3 is the
 * same hex as --nw-ignored, and a grey segment would read as "ignored", the one verdict they
 * are most often confused with. They take the first two categorical slots, in the fixed order
 * the slots are always assigned in.
 *
 * Mixing the two tone families in ONE bar was weighed against splitting into "what NPHIES
 * judges" and "what it leaves to you". One bar wins: the whole point of the surface is a
 * single denominator ("522 of 725"), and two bars would hide the ratio the reader came for.
 * The categorical slots were chosen in the hue space the severity palette leaves free
 * precisely so they can share a surface with it; the legend then carries the distinction in
 * words, and the categorical chips say "no verdict" where the severity chips show a glyph.
 */
const SEGMENT_TONE: Record<Obligation, Segment["tone"]> = {
  must: { kind: "severity", severity: "error" },
  ifKnown: { kind: "severity", severity: "warn" },
  forbidden: { kind: "severity", severity: "error" },
  optional: { kind: "category", slot: 1 },
  unstated: { kind: "category", slot: 2 },
  ignored: { kind: "severity", severity: "ignored" },
};

const NO_VERDICT = "No verdict either way: NPHIES leaves this position to you.";

const INT = new Intl.NumberFormat("en-US");

/* ------------------------------------------------------------------ import */

/**
 * One file a person handed the workbench, as far as it got. The diff is NOT stored here: it
 * is recomputed against whatever structure is on screen, so switching variant after an import
 * never leaves a comparison that was made against a different specification.
 */
export type ProfileImport =
  | { source: string; error: string }
  | { source: string; imported: Profile; warnings: string[] };

/**
 * Read a vendor's exported profile. The library's sentences are written for the person who
 * has to fix the file, so they are carried through untouched and shown verbatim.
 */
export function readProfileFile(text: string, source: string): ProfileImport {
  const out = parseProfile(text);
  return "error" in out ? { source, error: out.error } : { source, imported: out.profile, warnings: out.warnings };
}

/** The four rule fields a vendor builds against, in the order a changed row shows them. */
const RULE_FIELDS = ["obligation", "usage", "cardinality", "fixedValue"] as const;
type RuleField = (typeof RULE_FIELDS)[number];

const RULE_LABEL: Record<RuleField, string> = {
  obligation: "Obligation",
  usage: "Usage",
  cardinality: "Cardinality",
  fixedValue: "Fixed value",
};

function ruleText(row: ProfileRow, field: RuleField): string | null {
  switch (field) {
    case "obligation":
      return OBLIGATION_LABEL[row.obligation];
    case "usage":
      return row.usage.length ? row.usage.join(" / ") : null;
    default:
      return row[field];
  }
}

/**
 * Which of a changed pair's fields actually differ. `reconcileProfile` compares the whole
 * rule, so a pair may differ only in guidance or the quoted evidence; those are named as
 * "other" so the row never looks like it changed for no reason.
 */
function differences(before: ProfileRow, after: ProfileRow): { rule: RuleField[]; other: string[] } {
  const rule = RULE_FIELDS.filter((f) => ruleText(before, f) !== ruleText(after, f));
  const other = (Object.keys(before) as (keyof ProfileRow)[]).filter(
    (k) => k !== "id" && !(RULE_FIELDS as readonly string[]).includes(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  return { rule, other };
}

export interface BuildViewProps {
  structure: MessageStructure | null;
  structures: MessageStructure[];
  resolved: ResolvedUseCase | null;
  samples: GoldenSample[];
  onStructureChange: (structureId: string) => void;
  /** Hand an official sample to the Check surface. */
  onOpenSample: (sample: GoldenSample) => void;
  baseUrl?: string;
  /**
   * Shell owns the one `useDensity()` and passes the value down. Tokens already rescale the
   * type; the JS value only decides whether the summary panel is mounted at all.
   */
  density?: DensityChoice;
  /**
   * A profile already read from a file, so a caller (or an SSR test) can mount the surface
   * mid-comparison. The file input replaces it; it is never merged.
   */
  importedProfile?: ProfileImport | null;
}

export function BuildView({
  structure,
  structures,
  resolved,
  samples,
  onStructureChange,
  onOpenSample,
  baseUrl,
  density = "dense",
  importedProfile = null,
}: BuildViewProps) {
  const [filter, setFilter] = useState<Obligation | "all">("must");
  const [query, setQuery] = useState("");
  const [imported, setImported] = useState<ProfileImport | null>(importedProfile);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const profile = useMemo(
    () => (structure ? buildProfile(structure, resolved?.tables) : null),
    [structure, resolved],
  );

  const segments = useMemo<Segment[]>(
    () =>
      profile
        ? GROUPS.map((g) => ({
            id: g,
            label: OBLIGATION_LABEL[g],
            value: profile.counts[g],
            tone: SEGMENT_TONE[g],
            detail: OBLIGATION_HINT[g],
          }))
        : [],
    [profile],
  );

  const diff = useMemo<ProfileDiff | null>(
    () => (profile && imported && "imported" in imported ? reconcileProfile(imported.imported, profile) : null),
    [profile, imported],
  );

  const rows = useMemo(() => {
    if (!profile) return [];
    const q = query.trim().toLowerCase();
    return sortByObligation(profile.rows).filter((r) => {
      if (filter !== "all" && r.obligation !== filter) return false;
      if (!q) return true;
      return (
        r.label.toLowerCase().includes(q) ||
        (r.locator ?? "").toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q)
      );
    });
  }, [profile, filter, query]);

  if (!structure || !profile) {
    return (
      <EmptyState
        fill
        title="No compiled structure"
        description="Nothing was extracted for this use case, so there is no required surface to state."
      />
    );
  }

  const download = (name: string, body: string, type: string) => {
    const url = URL.createObjectURL(new Blob([body], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    toast.push({ title: `Saved ${name}`, tone: "neutral" });
  };

  /* A bar segment and its chip are the same control: the segment id IS the obligation. */
  const selectSegment = (id: string) => setFilter(id as Obligation);
  const selectedId = filter === "all" ? null : filter;
  const total = profile.rows.length;

  const sampleBadge = profile.sampleDerived ? (
    <Tooltip
      wide
      content="Rules with no Confluence page behind them. They came from the official sample messages, so they describe what NPHIES sends rather than what it requires."
    >
      <span className="ml-auto cursor-help">
        <Badge tone="warn" mono>
          {profile.sampleDerived} sample-derived
        </Badge>
      </span>
    </Tooltip>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <Toolbar
        dense
        aria-label="Build"
        end={
          <div className="flex items-center gap-1.5">
            <CopyButton
              size="xs"
              value={() => profileToMarkdown(profile)}
              label="Copy for vendor"
              what="the integration profile"
              toast
            />
            <Button
              size="xs"
              onClick={() => download(`${profile.structureId}-profile.json`, profileToJson(profile), "application/json")}
            >
              JSON
            </Button>
            <Button
              size="xs"
              onClick={() => download(`${profile.structureId}-profile.csv`, profileToCsv(profile), "text/csv")}
            >
              CSV
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Reset so choosing the same file again (after fixing it) fires onChange.
                e.target.value = "";
                if (!file) return;
                file.text().then((text) => setImported(readProfileFile(text, file.name)));
              }}
            />
            <Tooltip
              wide
              content="Lay a vendor's exported profile (the JSON this surface writes) beside the compiled structure. The file is read here in the browser and changes nothing."
            >
              <Button size="xs" onClick={() => fileRef.current?.click()}>
                Import profile…
              </Button>
            </Tooltip>
          </div>
        }
      >
        <ToolbarTitle>Build</ToolbarTitle>
        {structures.length > 1 ? (
          <select
            className="rounded-xs border border-line bg-surface px-1 py-0.5 font-mono text-2xs text-ink"
            value={structure.id}
            onChange={(e) => onStructureChange(e.target.value)}
            aria-label="Variant"
          >
            {structures.map((s) => (
              <option key={s.id} value={s.id}>
                {s.variantLabel ?? s.variant ?? s.title}
                {(s.direction ?? "request") === "response" ? " (response)" : ""}
              </option>
            ))}
          </select>
        ) : null}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter positions…"
          className="w-44 rounded-xs border border-line bg-surface px-1.5 py-0.5 text-2xs text-ink outline-none placeholder:text-ink-3 focus:border-accent"
        />
      </Toolbar>

      {density === "roomy" ? (
        <section
          aria-label="Build summary"
          className="shrink-0 border-b border-line bg-surface px-4 py-3"
        >
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            {/*
              The chips below are this chart's legend AND its filter. Donut always draws its
              own legend and has no prop to suppress it, so two legends would appear for one
              filter; hiding the Donut's is the lesser evil until the primitive grows a
              `showLegend`. Every arc still carries its readout in its own aria-label.
            */}
            <div className="shrink-0 [&_ul]:hidden">
              <Donut
                segments={segments}
                size={132}
                centerValue={INT.format(profile.counts.must)}
                centerCaption="must build"
                onSelect={selectSegment}
                selectedId={selectedId}
                aria-label={`Obligations across ${INT.format(total)} positions`}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2.5">
              <p className="max-w-prose text-sm leading-relaxed text-ink">
                <strong className="font-semibold">{INT.format(profile.counts.must)}</strong> of{" "}
                {INT.format(total)} positions must be built.{" "}
                {profile.counts.ignored > 0 ? (
                  <>
                    <strong className="font-semibold">{INT.format(profile.counts.ignored)}</strong> of{" "}
                    {INT.format(total)} are accepted and discarded by NPHIES — building them is
                    wasted work.
                  </>
                ) : (
                  <>NPHIES discards none of them: there is no ignored surface to skip here.</>
                )}{" "}
                <span className="text-ink-2">
                  Optional and unstated positions carry no verdict either way; NPHIES leaves
                  them to you.
                </span>
              </p>
              <ProportionBar
                segments={segments}
                height={14}
                showLegend={false}
                onSelect={selectSegment}
                selectedId={selectedId}
                aria-label={`Obligations across ${INT.format(total)} positions`}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <ObligationChips profile={profile} filter={filter} onFilter={setFilter} />
                {sampleBadge}
              </div>
            </div>
          </div>
        </section>
      ) : (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-surface px-2.5 py-1.5">
          <div className="w-44 shrink-0">
            <ProportionBar
              segments={segments}
              height={10}
              showLegend={false}
              onSelect={selectSegment}
              selectedId={selectedId}
              aria-label={`Obligations across ${INT.format(total)} positions`}
            />
          </div>
          <ObligationChips profile={profile} filter={filter} onFilter={setFilter} />
          {sampleBadge}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {imported ? (
          <ImportPanel
            imported={imported}
            diff={diff}
            current={profile}
            density={density}
            onDismiss={() => setImported(null)}
          />
        ) : null}
        <p className="border-b border-line px-3 py-2 text-2xs leading-relaxed text-ink-2">
          {OBLIGATION_HINT[filter === "all" ? "must" : filter]}{" "}
          {filter === "ignored" ? (
            <strong className="font-semibold text-ink">
              This list is the fastest saving available: none of it needs building.
            </strong>
          ) : null}
        </p>
        {rows.length ? (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-surface text-2xs uppercase tracking-wide text-ink-3">
              <tr className="border-b border-line">
                <th className="px-3 py-1 text-left font-semibold">Position</th>
                <th className="px-3 py-1 text-left font-semibold">Field</th>
                <th className="px-2 py-1 text-left font-semibold">Usage</th>
                <th className="px-2 py-1 text-left font-semibold">Type</th>
                <th className="px-2 py-1 text-left font-semibold">Fixed / value set</th>
                <th className="px-2 py-1 text-left font-semibold">Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row key={r.id} row={r} baseUrl={baseUrl} showObligation={filter === "all"} />
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title="Nothing in this group"
            description={
              query ? "No position matches the filter." : "The compiled structure has no position with this obligation."
            }
          />
        )}
      </div>

      {samples.length ? (
        <footer className="shrink-0 border-t border-line bg-surface px-3 py-2">
          <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-3">
            Reference: the official NPHIES message
          </div>
          <div className="flex flex-wrap gap-1.5">
            {samples.map((s) => (
              <Button key={s.path} size="xs" onClick={() => onOpenSample(s)}>
                {s.fileName.replace(/\.(xml|json|txt)$/i, "").slice(0, 44)}
              </Button>
            ))}
          </div>
        </footer>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ import panel */

/**
 * The vendor's file laid beside the compiled structure.
 *
 * Nothing here is applied, because there is nothing to apply: the compiled structure IS the
 * specification, and the file is one party's claim about it. A vendor whose file says
 * "optional" where the specification says "must build" has found a defect in their backlog,
 * not a reason to soften the rule — so the diff is the whole deliverable, and the panel says
 * so in words rather than leaving the reader to guess which column wins. Obligation badges
 * keep the TONE map: that is verdict semantics, decided above.
 */
function ImportPanel({
  imported,
  diff,
  current,
  density,
  onDismiss,
}: {
  imported: ProfileImport;
  diff: ProfileDiff | null;
  current: Profile;
  density: DensityChoice;
  onDismiss: () => void;
}) {
  const pad = density === "roomy" ? "px-4 py-3" : "px-3 py-2";
  const heading = (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <h2 className="text-xs font-semibold text-ink">Vendor profile vs this compiled structure</h2>
      <span className="font-mono text-2xs text-ink-3">{imported.source}</span>
      <Button size="xs" variant="ghost" className="ml-auto" onClick={onDismiss}>
        Clear import
      </Button>
    </div>
  );

  if ("error" in imported) {
    return (
      <section aria-label="Profile import" className={`border-b border-line bg-surface ${pad}`}>
        {heading}
        <p role="alert" className="mt-1.5 max-w-prose text-2xs leading-relaxed text-ink">
          <strong className="font-semibold">Could not read the file.</strong> {imported.error}
        </p>
      </section>
    );
  }
  if (!diff) return null;

  const { imported: vendor, warnings } = imported;
  const total = diff.unchanged + diff.changed.length + diff.added.length + diff.removed.length;
  const differs = diff.changed.length + diff.added.length + diff.removed.length;
  const otherStructure = vendor.structureId !== current.structureId;

  const stat = (key: keyof ProfileDiff, label: string, value: number, hint: string) => (
    <div className="min-w-24 flex-1">
      <dt className="text-2xs uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className="font-mono text-base leading-tight text-ink" data-diff={key}>
        {INT.format(value)}
      </dd>
      <dd className="text-2xs leading-snug text-ink-3">{hint}</dd>
    </div>
  );

  return (
    <section aria-label="Profile import" className={`border-b border-line bg-surface ${pad}`}>
      {heading}
      <p className="mt-1.5 max-w-prose text-2xs leading-relaxed text-ink-2">
        The compiled structure is the specification. The file is the vendor&apos;s claim about it —{" "}
        <span className="font-mono text-ink">{vendor.title}</span> (<code>{vendor.structureId}</code>, generated{" "}
        {vendor.generatedAt}). Nothing in it is applied to the table below; the differences are the deliverable.
      </p>
      {otherStructure ? (
        <p className="mt-1 max-w-prose text-2xs leading-relaxed text-ink-2">
          The file describes <code>{vendor.structureId}</code>, but this surface has compiled{" "}
          <code>{current.structureId}</code>. Every difference below may be nothing more than that.
        </p>
      ) : null}
      {warnings.length ? (
        <div className="mt-2 max-w-prose text-2xs leading-relaxed">
          <div className="font-semibold text-ink">Repaired on import — read before trusting the file:</div>
          <ul className="mt-0.5 list-disc pl-4 text-ink-2">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
        {stat("unchanged", "Unchanged", diff.unchanged, "Both sides state the same rule.")}
        {stat("changed", "Changed", diff.changed.length, "Same position, different rule.")}
        {stat("added", "Added", diff.added.length, "In the vendor's file only.")}
        {stat("removed", "Removed", diff.removed.length, "In the compiled structure only.")}
      </dl>

      {differs === 0 ? (
        <p className="mt-2 max-w-prose text-2xs leading-relaxed text-ink">
          Every one of {INT.format(total)} positions matches: the vendor&apos;s file agrees with the compiled
          structure.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead className="text-2xs uppercase tracking-wide text-ink-3">
              <tr className="border-b border-line">
                <th className="py-1 pr-2 text-left font-semibold">Difference</th>
                <th className="py-1 pr-2 text-left font-semibold">Position</th>
                <th className="py-1 pr-2 text-left font-semibold">Field</th>
                <th className="py-1 pr-2 text-left font-semibold">Compiled structure (specification)</th>
                <th className="py-1 text-left font-semibold">Vendor&apos;s file (claim)</th>
              </tr>
            </thead>
            <tbody>
              {diff.changed.map(({ before, after }) => (
                <DiffRow key={`c:${before.id}`} kind="Changed" before={before} after={after} />
              ))}
              {diff.removed.map((r) => (
                <DiffRow key={`r:${r.id}`} kind="Removed" before={r} after={null} />
              ))}
              {diff.added.map((r) => (
                <DiffRow key={`a:${r.id}`} kind="Added" before={null} after={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * The label rides beside the locator because a locator is not always a row: seven FHIR
 * bundle slots share `./entry`, and "Removed: ./entry" alone would not say which one.
 */
function Position({ row }: { row: ProfileRow }) {
  return (
    <>
      <div className="font-mono text-ink">{row.locator ?? row.path}</div>
      {row.locator && row.locator !== row.path ? (
        <div className="max-w-64 truncate font-mono text-2xs text-ink-3" title={row.path}>
          {row.path}
        </div>
      ) : null}
    </>
  );
}

function RuleSummary({ row }: { row: ProfileRow }) {
  return (
    <div className="flex flex-col gap-0.5">
      <Badge tone={TONE[row.obligation]} className="self-start">
        {OBLIGATION_LABEL[row.obligation]}
      </Badge>
      <span className="text-2xs text-ink-2">
        {ruleText(row, "usage") ?? "—"} · {row.cardinality ?? "—"}
        {row.fixedValue ? (
          <>
            {" · "}
            <code className="break-all font-mono text-ink">{row.fixedValue}</code>
          </>
        ) : null}
      </span>
    </div>
  );
}

function DiffRow({
  kind,
  before,
  after,
}: {
  kind: "Changed" | "Added" | "Removed";
  before: ProfileRow | null;
  after: ProfileRow | null;
}) {
  const row = (before ?? after) as ProfileRow;
  const changed = before && after ? differences(before, after) : null;
  const value = (r: ProfileRow, f: RuleField) =>
    f === "obligation" ? (
      <Badge tone={TONE[r.obligation]}>{OBLIGATION_LABEL[r.obligation]}</Badge>
    ) : f === "fixedValue" && r.fixedValue ? (
      <code className="break-all font-mono text-ink">{r.fixedValue}</code>
    ) : (
      <span className="text-ink">{ruleText(r, f) ?? "—"}</span>
    );
  return (
    <tr className="border-b border-line/60 align-top">
      <td className="py-1 pr-2">
        <Badge>{kind}</Badge>
      </td>
      <td className="py-1 pr-2">
        <Position row={row} />
      </td>
      <td className="py-1 pr-2 text-ink-2">
        {row.label}
        {after && before && after.label !== before.label ? (
          <div className="text-2xs text-ink-3">file says: {after.label}</div>
        ) : null}
      </td>
      {changed ? (
        <td className="py-1 pr-2" colSpan={2}>
          {changed.rule.length ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-2xs">
              {changed.rule.map((f) => (
                <div key={f} className="contents">
                  <dt className="text-ink-3">{RULE_LABEL[f]}</dt>
                  <dd className="flex flex-wrap items-center gap-1.5">
                    {value(before as ProfileRow, f)}
                    <span aria-label="becomes, in the vendor's file" className="text-ink-3">
                      →
                    </span>
                    {value(after as ProfileRow, f)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {changed.other.length ? (
            <div className="mt-0.5 text-2xs text-ink-3">
              Also differs in {changed.other.join(", ")} — the rule itself is the same.
            </div>
          ) : null}
        </td>
      ) : (
        <>
          <td className="py-1 pr-2">{before ? <RuleSummary row={before} /> : <span className="text-ink-3">—</span>}</td>
          <td className="py-1">{after ? <RuleSummary row={after} /> : <span className="text-ink-3">—</span>}</td>
        </>
      )}
    </tr>
  );
}

/**
 * The legend and the filter, as one row of chips. Each chip wears the swatch its bar
 * segment wears, and a severity-toned chip also shows the glyph — so a reader who cannot
 * see the colour still knows which verdict the segment stands for. A categorical chip shows
 * no glyph on purpose: giving it one would dress a non-verdict as a verdict.
 */
function ObligationChips({
  profile,
  filter,
  onFilter,
}: {
  profile: Profile;
  filter: Obligation | "all";
  onFilter: (f: Obligation | "all") => void;
}) {
  const chip = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-xs border px-1.5 py-0.5 text-2xs ${
      active ? "border-accent bg-sel text-ink" : "border-line text-ink-2 hover:bg-inset"
    }`;
  return (
    <>
      {GROUPS.map((g) => {
        const tone = SEGMENT_TONE[g];
        const hint = tone.kind === "category" ? `${OBLIGATION_HINT[g]} ${NO_VERDICT}` : OBLIGATION_HINT[g];
        return (
          <Tooltip key={g} wide content={hint}>
            <button
              type="button"
              onClick={() => onFilter(g)}
              aria-pressed={filter === g}
              className={chip(filter === g)}
            >
              <span
                aria-hidden="true"
                className={`inline-block h-2 w-2 shrink-0 rounded-xs ${
                  tone.kind === "severity" ? SEV_DOT[tone.severity] : ""
                }`}
                style={tone.kind === "category" ? { background: CATEGORY_VAR[tone.slot] } : undefined}
              />
              {tone.kind === "severity" ? (
                <span aria-hidden="true" className="font-mono">
                  {SEVERITY_GLYPH[tone.severity]}
                </span>
              ) : null}
              <span>
                {OBLIGATION_LABEL[g]}{" "}
                <span className="font-mono text-ink-3">{profile.counts[g]}</span>
              </span>
            </button>
          </Tooltip>
        );
      })}
      <button
        type="button"
        onClick={() => onFilter("all")}
        aria-pressed={filter === "all"}
        className={chip(filter === "all")}
      >
        All <span className="font-mono text-ink-3">{profile.rows.length}</span>
      </button>
    </>
  );
}

function Row({
  row,
  baseUrl,
  showObligation,
}: {
  row: ProfileRow;
  baseUrl?: string;
  showObligation: boolean;
}) {
  return (
    <tr className="border-b border-line/60 align-top hover:bg-inset">
      <td className="px-3 py-1 font-mono text-ink">
        {showObligation ? (
          <Badge tone={TONE[row.obligation]} className="mr-1.5">
            {OBLIGATION_LABEL[row.obligation]}
          </Badge>
        ) : null}
        {row.locator ?? row.path}
      </td>
      <td className="px-3 py-1 text-ink-2">
        {row.label}
        {row.guidance ? (
          <div className="mt-0.5 max-w-prose text-2xs text-ink-3">{row.guidance}</div>
        ) : null}
      </td>
      <td className="px-2 py-1">
        <div className="flex flex-wrap gap-1">
          {row.usage.length ? (
            row.usage.map((u, i) => (
              <UsageBadge
                key={i}
                usage={u as Usage}
                cardinality={row.cardinality ?? undefined}
                condition={row.conditions[i]}
              />
            ))
          ) : (
            <span className="text-ink-3">—</span>
          )}
        </div>
      </td>
      <td className="px-2 py-1 font-mono text-2xs text-ink-3">{row.datatype ?? "—"}</td>
      <td className="px-2 py-1 text-2xs">
        {row.fixedValue ? (
          <code className="break-all font-mono text-ink">{row.fixedValue}</code>
        ) : row.valueSet ? (
          <span className="text-ink-2">
            {row.valueSet}
            {row.valueSetExternal ? <Badge tone="warn" className="ml-1">NHIC</Badge> : null}
          </span>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </td>
      <td className="px-2 py-1 text-2xs">
        {row.pageId && row.quote ? (
          <SourceNote
            source={{ pageId: row.pageId, pageTitle: "", quote: row.quote }}
            baseUrl={baseUrl}
          />
        ) : (
          <Tooltip
            wide
            content="No Confluence page states this rule. It was read off an official sample message, so it is real but not normative."
          >
            <span className="cursor-help text-warn">sample</span>
          </Tooltip>
        )}
      </td>
    </tr>
  );
}
