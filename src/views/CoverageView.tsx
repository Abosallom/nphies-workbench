import { useMemo, useState } from "react";
import { Badge, EmptyState, SourceNote, Tabs, Toolbar, ToolbarTitle, Tooltip } from "../ui";
import { loadDefects, type Registry } from "../lib/workbench";
import { XDS_INDEPENDENCE, XDS_INDEPENDENCE_HEADLINE, MTOM_LIMITATION } from "../lib/parse/xds";
import { useAsyncValue } from "./useAsyncValue";

/* ========================================================================== *
 * Coverage — what the workbench does NOT know.
 *
 * A structural verdict is only worth as much as the spec behind it, so the limits are a
 * first-class surface rather than a footnote: where the published specification contradicts
 * itself, where the official samples are themselves broken, and where a rule was recovered
 * from a sample rather than published. An analyst who can see this can judge a finding; one
 * who cannot has to take it on faith.
 * ========================================================================== */

type Pane = "spec" | "samples" | "soap";

export interface CoverageViewProps {
  registry: Registry | null;
  baseUrl?: string;
}

interface DefectRecord {
  id?: string;
  kind?: string;
  whatItIs?: string;
  action?: string;
  confluenceSpelling?: string;
  wireSpelling?: string;
  wireWins?: boolean;
  confidence?: string;
  affectedPages?: { pageId?: string; title?: string; row?: string }[];
  provenance?: { pageId?: string | null; pageTitle?: string | null; row?: string | null; quote?: string | null } | null;
}

interface SampleDefectRecord {
  sampleFile?: string;
  defectType?: string;
  severity?: string;
  description?: string;
  impact?: string;
  workaround?: string;
  evidence?: string;
}

export function CoverageView({ registry, baseUrl }: CoverageViewProps) {
  const defects = useAsyncValue(loadDefects);
  const [pane, setPane] = useState<Pane>("spec");

  const specDefects = useMemo(
    () => ((defects.data?.spec as unknown as { defects?: DefectRecord[] })?.defects ?? []),
    [defects.data],
  );
  const sampleDefects = useMemo(
    () => ((defects.data?.samples as unknown as { defects?: SampleDefectRecord[] })?.defects ?? []),
    [defects.data],
  );

  const counts = registry?.manifest.counts ?? {};
  const coverage = registry?.manifest.coverage;

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <Toolbar
        dense
        aria-label="Coverage"
        end={
          <Tabs
            aria-label="Coverage pane"
            activeId={pane}
            onChange={(id) => setPane(id as Pane)}
            items={[
              { id: "spec", label: `Spec defects (${specDefects.length})` },
              { id: "samples", label: `Sample defects (${sampleDefects.length})` },
              { id: "soap", label: "SOAP provenance" },
            ]}
          />
        }
      >
        <ToolbarTitle>Coverage</ToolbarTitle>
        <Badge mono>{Number(counts.specNodes ?? 0).toLocaleString()} rules</Badge>
        <Badge mono>{Number(counts.messageStructures ?? 0)} structures</Badge>
        <Badge mono>{Number(counts.valueSetConcepts ?? 0).toLocaleString()} concepts</Badge>
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {pane === "spec" ? (
          <section className="space-y-3">
            <Intro>
              Places the <strong className="font-semibold">published specification</strong> is wrong
              or contradicts itself. The Confluence wording is kept verbatim and the conflict is
              shown — the workbench never silently rewrites either side, because an integrator
              hitting the contradiction needs to know it exists.
            </Intro>
            {registry ? (
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <Stat label="Use cases with a structure" value={`${coverage?.useCasesWithStructure ?? 0}`} />
                <Stat label="Without an official sample" value={`${coverage?.useCasesWithoutGolden.length ?? 0}`} />
                <Stat label="Quarantined placeholder OIDs" value={`${counts.quarantinedOids ?? 0}`} />
                <Stat label="Structures verified against a sample" value={`${counts.structuresVerifiedAgainstSample ?? 0}`} />
              </div>
            ) : null}
            {defects.loading ? <EmptyState title="Loading…" /> : null}
            <ul className="space-y-2">
              {specDefects.map((d, i) => (
                <li key={d.id ?? i} className="rounded-sm border border-line bg-surface p-2.5 text-xs">
                  <header className="mb-1 flex flex-wrap items-center gap-1.5">
                    {d.kind ? <Badge mono>{d.kind}</Badge> : null}
                    {d.confidence ? <Badge tone={d.confidence === "high" ? "ok" : "warn"}>{d.confidence}</Badge> : null}
                    {d.wireWins ? (
                      <Tooltip wide content="The wire format disagrees with the published page, and the wire is what NPHIES actually accepts.">
                        <span className="cursor-help">
                          <Badge tone="warn">the wire wins</Badge>
                        </span>
                      </Tooltip>
                    ) : null}
                  </header>
                  {d.whatItIs ? <p className="text-ink-2">{d.whatItIs}</p> : null}
                  {d.confluenceSpelling && d.wireSpelling ? (
                    <p className="mt-1 font-mono text-2xs">
                      <span className="text-ink-3">Confluence</span> <span className="text-ink">{d.confluenceSpelling}</span>
                      {"  ·  "}
                      <span className="text-ink-3">wire</span> <span className="text-ink">{d.wireSpelling}</span>
                    </p>
                  ) : null}
                  {d.action ? (
                    <p className="mt-1 text-ink-2">
                      <span className="text-2xs font-semibold uppercase tracking-wide text-ink-3">Do this: </span>
                      {d.action}
                    </p>
                  ) : null}
                  {d.provenance?.pageId && d.provenance.quote ? (
                    <div className="mt-1.5">
                      <SourceNote
                        source={{
                          pageId: d.provenance.pageId,
                          pageTitle: d.provenance.pageTitle ?? "",
                          quote: d.provenance.quote,
                          ...(d.provenance.row ? { row: d.provenance.row } : {}),
                        }}
                        baseUrl={baseUrl}
                      />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : pane === "samples" ? (
          <section className="space-y-3">
            <Intro>
              Defects in the <strong className="font-semibold">official NPHIES sample messages</strong>{" "}
              themselves. They are catalogued so the workbench never copies a sample's mistake into
              a rule, and so that pasting one into Check tells you the sample is broken instead of
              blaming your HIS.
            </Intro>
            <ul className="space-y-2">
              {sampleDefects.map((d, i) => (
                <li key={i} className="rounded-sm border border-line bg-surface p-2.5 text-xs">
                  <header className="mb-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone={d.severity === "fatal" ? "error" : d.severity === "major" ? "warn" : "neutral"}>
                      {d.severity ?? "defect"}
                    </Badge>
                    {d.defectType ? <Badge mono>{d.defectType}</Badge> : null}
                    <span className="truncate font-mono text-2xs text-ink-3">{d.sampleFile}</span>
                  </header>
                  {d.description ? <p className="text-ink-2">{d.description}</p> : null}
                  {d.evidence ? (
                    <pre className="mt-1 overflow-x-auto rounded-xs bg-inset p-1.5 font-mono text-2xs text-ink-2">
                      {d.evidence}
                    </pre>
                  ) : null}
                  {d.impact ? <p className="mt-1 text-2xs text-ink-3">{d.impact}</p> : null}
                  {d.workaround ? <p className="mt-1 text-2xs text-ink-2">Workaround: {d.workaround}</p> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <section className="space-y-3 text-xs">
            <Intro>{XDS_INDEPENDENCE_HEADLINE}</Intro>
            <table className="w-full border-collapse">
              <thead className="text-2xs uppercase tracking-wide text-ink-3">
                <tr className="border-b border-line">
                  <th className="py-1 text-left font-semibold">Element kind</th>
                  <th className="py-1 text-right font-semibold">Found</th>
                  <th className="py-1 text-right font-semibold">Independently sourced</th>
                  <th className="py-1 text-right font-semibold">Share</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(XDS_INDEPENDENCE).map(([kind, v]) => (
                  <tr key={kind} className="border-b border-line/60">
                    <td className="py-1 font-mono text-ink">{kind}</td>
                    <td className="py-1 text-right text-ink-2">{v.found}</td>
                    <td className="py-1 text-right text-ink-2">{v.independent}</td>
                    <td className="py-1 text-right">
                      <Badge tone={v.share >= 0.8 ? "ok" : v.share >= 0.5 ? "warn" : "error"} mono>
                        {(v.share * 100).toFixed(1)}%
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-ink-2">
              A rule that is only sample-derived may still be right — thirteen samples agreeing is
              strong evidence — but it is not normative, and every SOAP/XDS finding says which kind
              it rests on rather than presenting both as the specification.
            </p>
            <Intro>{MTOM_LIMITATION}</Intro>
          </section>
        )}
      </div>
    </div>
  );
}

function Intro({ children }: { children: React.ReactNode }) {
  return (
    <p className="max-w-prose rounded-sm border border-line bg-surface p-2.5 text-xs leading-relaxed text-ink-2">
      {children}
    </p>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-line bg-surface p-2">
      <div className="font-mono text-base text-ink">{value}</div>
      <div className="text-2xs text-ink-3">{label}</div>
    </div>
  );
}
