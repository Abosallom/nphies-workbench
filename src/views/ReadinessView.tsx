import { useMemo, useState } from "react";
import {
  Badge,
  EmptyState,
  SeverityCount,
  StatusDot,
  Toolbar,
  ToolbarTitle,
  Tooltip,
  UseCaseStatusDot,
  type UseCase,
} from "../ui";
import type { Registry, UseCaseEntry } from "../lib/workbench";

/* ========================================================================== *
 * Readiness — which use cases this hospital can actually submit.
 *
 * Two different things are on this page and they are never blended: what the WORKBENCH
 * knows about a use case (compiled structure, official sample), and what the HOSPITAL has
 * shown it can produce (a message checked in this session). A use case nobody has pasted a
 * message for is "not checked", never "ready".
 * ========================================================================== */

export interface SessionResult {
  structureId: string;
  errors: number;
  warns: number;
  readinessScore: number;
  readinessBasis: "measured" | "nothing-required" | "no-metrics";
  requiredSatisfied: number;
  requiredTotal: number;
  at: number;
}

export interface ReadinessViewProps {
  registry: Registry | null;
  results: Record<string, SessionResult>;
  onOpen: (useCaseId: string) => void;
}

export function ReadinessView({ registry, results, onOpen }: ReadinessViewProps) {
  const [family, setFamily] = useState<string>("all");

  const entries = useMemo(() => {
    const list = registry?.entries ?? [];
    return family === "all" ? list : list.filter((e) => e.ui.family === family);
  }, [registry, family]);

  const checked = Object.keys(results).length;
  const clean = Object.values(results).filter((r) => r.errors === 0).length;

  if (!registry) return <EmptyState fill title="Loading the compiled spec…" />;

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <Toolbar dense aria-label="Readiness">
        <ToolbarTitle>Readiness</ToolbarTitle>
        <Badge mono>{registry.entries.length} use cases</Badge>
        <Badge mono tone={checked ? "accent" : "neutral"}>
          {checked} checked this session
        </Badge>
        {checked ? (
          <Badge mono tone={clean === checked ? "ok" : "warn"}>
            {clean} submitted clean
          </Badge>
        ) : null}
        <select
          className="ml-2 rounded-xs border border-line bg-surface px-1 py-0.5 text-2xs text-ink"
          value={family}
          onChange={(e) => setFamily(e.target.value)}
          aria-label="Family"
        >
          <option value="all">All families</option>
          <option value="hl7v2">HL7 v2.5.1</option>
          <option value="fhir">FHIR R4</option>
          <option value="cda">CDA R2</option>
          <option value="xds">XDS / SOAP</option>
          <option value="sso">SSO</option>
        </select>
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-surface text-2xs uppercase tracking-wide text-ink-3">
            {/* The rule is a box-shadow on the cells, not a border on the row: under
                border-collapse a sticky header leaves its border behind when it scrolls. */}
            <tr className="[&>th]:shadow-[inset_0_-1px_0_var(--nw-line)]">
              <th className="px-3 py-1.5 text-left font-semibold">Use case</th>
              <th className="px-2 py-1.5 text-left font-semibold">Spec</th>
              <th className="px-2 py-1.5 text-left font-semibold whitespace-nowrap">Official sample</th>
              <th className="px-2 py-1.5 text-left font-semibold">Variants</th>
              <th className="px-2 py-1.5 text-left font-semibold whitespace-nowrap">Your message</th>
              <th className="px-2 py-1.5 text-left font-semibold whitespace-nowrap">Required covered</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <Row
                key={entry.summary.id}
                entry={entry}
                result={results[entry.summary.id]}
                onOpen={() => onOpen(entry.summary.id)}
              />
            ))}
          </tbody>
        </table>

        <p className="border-t border-line px-3 py-2 text-2xs leading-relaxed text-ink-3">
          “Spec” is what the workbench compiled from the published pages; “Your message” is what
          the checker found in a message you pasted in this session. A use case with a complete
          spec and no pasted message is <strong className="font-semibold">not checked</strong> —
          the workbench cannot tell you your HIS is ready for something it has never seen.
        </p>
      </div>
    </div>
  );
}

function Row({
  entry,
  result,
  onOpen,
}: {
  entry: UseCaseEntry;
  result: SessionResult | undefined;
  onOpen: () => void;
}) {
  const ui: UseCase = entry.ui;
  const summary = entry.summary;
  return (
    <tr className="cursor-pointer border-b border-line/60 align-middle hover:bg-inset" onClick={onOpen}>
      <td className="px-3 py-1.5">
        {/* The label wraps rather than truncating: in an auto-width table `truncate` never
            fires, it only forces nowrap and pushes the table into a horizontal scroll once
            the presentation scale makes the labels wider than the pane. */}
        <div className="flex items-center gap-1.5">
          <UseCaseStatusDot status={ui.status} />
          <code className="shrink-0 whitespace-nowrap font-mono text-ink">{ui.code}</code>
          <span className="min-w-0 text-ink-2">{ui.label}</span>
        </div>
      </td>
      <td className="px-2 py-1.5">
        <Tooltip wide content={summary.statusReasons.join(" ") || "Compiled from the published specification pages."}>
          <span className="cursor-help">
            <Badge tone={summary.status === "complete" ? "ok" : summary.status === "partial" ? "warn" : "error"}>
              {summary.status}
            </Badge>
          </span>
        </Tooltip>
      </td>
      <td className="px-2 py-1.5 text-ink-2">
        {summary.goldenSampleCount ? (
          `${summary.goldenSampleCount}`
        ) : (
          <Tooltip wide content={summary.goldenMissing?.note ?? summary.goldenMissing?.reason ?? "No official sample is published."}>
            <span className="cursor-help text-warn">none</span>
          </Tooltip>
        )}
      </td>
      <td className="px-2 py-1.5 font-mono text-2xs text-ink-3">{summary.structureIds.length}</td>
      <td className="px-2 py-1.5">
        {result ? (
          <span className="flex flex-wrap items-center gap-2">
            <SeverityCount severity="error" count={result.errors} />
            <SeverityCount severity="warn" count={result.warns} />
            {result.errors === 0 ? (
              <Badge tone="ok">would be accepted</Badge>
            ) : (
              <Badge tone="error">would be rejected</Badge>
            )}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 whitespace-nowrap text-ink-3">
            <StatusDot severity="info" hollow label="Not checked" />
            not checked
          </span>
        )}
      </td>
      <td className="px-2 py-1.5 text-ink-2">
        {result?.readinessBasis === "measured" ? (
          <span className="font-mono">
            {result.requiredSatisfied}/{result.requiredTotal}
          </span>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </td>
    </tr>
  );
}
