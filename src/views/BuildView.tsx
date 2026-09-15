import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  SourceNote,
  Toolbar,
  ToolbarTitle,
  Tooltip,
  UsageBadge,
  useToast,
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
  type ProfileRow,
} from "../lib/profile";

/* ========================================================================== *
 * Build — what the HIS has to produce, and what it must not waste time on.
 *
 * The workbench will not fabricate a message: a generated skeleton full of invented
 * identifiers is a liability, and the official samples already exist for reference. What a
 * hospital actually lacks is a precise, citable statement of the required surface — so that
 * is what this produces, in a form a HIS vendor can work from directly.
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

export interface BuildViewProps {
  structure: MessageStructure | null;
  structures: MessageStructure[];
  resolved: ResolvedUseCase | null;
  samples: GoldenSample[];
  onStructureChange: (structureId: string) => void;
  /** Hand an official sample to the Check surface. */
  onOpenSample: (sample: GoldenSample) => void;
  baseUrl?: string;
}

export function BuildView({
  structure,
  structures,
  resolved,
  samples,
  onStructureChange,
  onOpenSample,
  baseUrl,
}: BuildViewProps) {
  const [filter, setFilter] = useState<Obligation | "all">("must");
  const [query, setQuery] = useState("");
  const toast = useToast();

  const profile = useMemo(
    () => (structure ? buildProfile(structure, resolved?.tables) : null),
    [structure, resolved],
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

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-surface px-2.5 py-1.5">
        {GROUPS.map((g) => (
          <Tooltip key={g} wide content={OBLIGATION_HINT[g]}>
            <button
              type="button"
              onClick={() => setFilter(g)}
              className={`rounded-xs border px-1.5 py-0.5 text-2xs ${
                filter === g ? "border-accent bg-sel text-ink" : "border-line text-ink-2 hover:bg-inset"
              }`}
            >
              {OBLIGATION_LABEL[g]}{" "}
              <span className="font-mono text-ink-3">{profile.counts[g]}</span>
            </button>
          </Tooltip>
        ))}
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`rounded-xs border px-1.5 py-0.5 text-2xs ${
            filter === "all" ? "border-accent bg-sel text-ink" : "border-line text-ink-2 hover:bg-inset"
          }`}
        >
          All <span className="font-mono text-ink-3">{profile.rows.length}</span>
        </button>
        {profile.sampleDerived ? (
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
        ) : null}
      </div>

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
