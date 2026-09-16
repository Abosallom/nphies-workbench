import { useMemo, useState } from "react";
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
  profileToCsv,
  profileToJson,
  profileToMarkdown,
  sortByObligation,
  type Obligation,
  type Profile,
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
}: BuildViewProps) {
  const [filter, setFilter] = useState<Obligation | "all">("must");
  const [query, setQuery] = useState("");
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
