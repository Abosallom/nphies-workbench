import { useMemo, useState } from "react";
import {
  Badge,
  EmptyState,
  MiniBars,
  ProportionBar,
  SourceNote,
  Tabs,
  Toolbar,
  ToolbarTitle,
  Tooltip,
  type CategorySlot,
  type DensityChoice,
  type MiniBarRow,
  type Segment,
} from "../ui";
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
 *
 * The charts here are inventory, not verdicts. The one place the severity palette appears
 * (the sample-defect severity bar) is the compiler's own fatal/major/minor grading, which is
 * a verdict on the sample. Everything else — provenance shares, defect kinds — is identity
 * or magnitude and wears the categorical slots or neutral ink.
 * ========================================================================== */

type Pane = "spec" | "samples" | "soap";

export interface CoverageViewProps {
  registry: Registry | null;
  baseUrl?: string;
  /** From Shell's one useDensity(); only the chart geometry needs the JS value. */
  density?: DensityChoice;
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

/**
 * Chart geometry per density. Type and spacing rescale through CSS tokens, but an SVG bar's
 * height is a pixel prop, so a roomy page with dense bars reads as hairlines from the back
 * of a room — the same reason the virtualised row heights need the JS value.
 */
const CHART_SIZE: Record<DensityChoice, { bar: number; proportion: number }> = {
  dense: { bar: 8, proportion: 12 },
  roomy: { bar: 12, proportion: 18 },
};

/** The sample compiler's own grading, in the order it means. Anything else is unspecified. */
const SAMPLE_SEVERITIES: { id: string; label: string; tone: Segment["tone"] }[] = [
  { id: "fatal", label: "fatal", tone: { kind: "severity", severity: "error" } },
  { id: "major", label: "major", tone: { kind: "severity", severity: "warn" } },
  { id: "minor", label: "minor", tone: { kind: "severity", severity: "info" } },
];

/**
 * Tone for the rest-of-list bucket. `info` is not a verdict — `SEV_FILL` gives it the neutral
 * ink for exactly that reason — so "other" wears grey without borrowing a fifth hue, which
 * the palette does not have and must not invent.
 */
const OTHER_TONE: Segment["tone"] = { kind: "severity", severity: "info" };
const TOP_N = 4;

/**
 * Count records by a key and lay them out as part-of-whole rows: the top four kinds get the
 * categorical slots in fixed order, the remainder folds into "other". Kinds are ordered by
 * count, which is legitimate here because the slot follows the KIND, not the rank — the
 * bundle is static, so a kind never changes colour between two renders.
 */
function countRows<T>(records: T[], key: (r: T) => string | undefined, otherLabel = "other"): MiniBarRow[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    const k = key(r) ?? "unspecified";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = records.length;
  const head = sorted.slice(0, TOP_N);
  const tail = sorted.slice(TOP_N);
  const rows: MiniBarRow[] = head.map(([k, n], i) => ({
    id: k,
    label: k,
    value: n,
    of: total,
    tone: { kind: "category", slot: (i + 1) as CategorySlot },
  }));
  if (tail.length > 0) {
    rows.push({
      id: "__other",
      label: `${otherLabel} (${tail.length} kinds)`,
      value: tail.reduce((a, [, n]) => a + n, 0),
      of: total,
      tone: OTHER_TONE,
      detail: tail.map(([k, n]) => `${k} ${n}`).join(" · "),
    });
  }
  return rows;
}

export function CoverageView({ registry, baseUrl, density = "dense" }: CoverageViewProps) {
  const defects = useAsyncValue(loadDefects);
  const [pane, setPane] = useState<Pane>("spec");
  const size = CHART_SIZE[density];

  const specDefects = useMemo(
    () => ((defects.data?.spec as unknown as { defects?: DefectRecord[] })?.defects ?? []),
    [defects.data],
  );
  const sampleDefects = useMemo(
    () => ((defects.data?.samples as unknown as { defects?: SampleDefectRecord[] })?.defects ?? []),
    [defects.data],
  );

  const specByKind = useMemo(() => countRows(specDefects, (d) => d.kind), [specDefects]);
  const sampleByType = useMemo(() => countRows(sampleDefects, (d) => d.defectType), [sampleDefects]);
  const sampleBySeverity = useMemo<Segment[]>(() => {
    const counts = new Map<string, number>();
    for (const d of sampleDefects) {
      const k = d.severity ?? "unspecified";
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const segments: Segment[] = SAMPLE_SEVERITIES.map((s) => ({
      id: s.id,
      label: s.label,
      value: counts.get(s.id) ?? 0,
      tone: s.tone,
    }));
    /* A grading the compiler does not use today is still shown if it ever appears: silently
       dropping it would make the bar sum to less than the list. */
    for (const [k, n] of counts) {
      if (!SAMPLE_SEVERITIES.some((s) => s.id === k)) {
        segments.push({ id: k, label: k, value: n, tone: OTHER_TONE });
      }
    }
    return segments;
  }, [sampleDefects]);

  /* Provenance share is ONE measure across element kinds — a single categorical slot, not a
     tone per row and never the severity palette: 33% independent is not a warning, it is a
     fact about where the rule came from. `overall` is the total, so it stays in the table
     (and the headline) rather than being drawn as a peer of its own parts. */
  const independenceRows = useMemo<MiniBarRow[]>(
    () =>
      Object.entries(XDS_INDEPENDENCE)
        .filter(([kind]) => kind !== "overall")
        .map(([kind, v]) => ({
          id: kind,
          label: kind,
          value: v.independent,
          of: v.found,
          tone: { kind: "category", slot: 1 },
          detail: "rules not derived from these same samples",
        })),
    [],
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
                <Stat density={density} label="Use cases with a structure" value={`${coverage?.useCasesWithStructure ?? 0}`} />
                <Stat density={density} label="Without an official sample" value={`${coverage?.useCasesWithoutGolden.length ?? 0}`} />
                <Stat density={density} label="Quarantined placeholder OIDs" value={`${counts.quarantinedOids ?? 0}`} />
                <Stat density={density} label="Structures verified against a sample" value={`${counts.structuresVerifiedAgainstSample ?? 0}`} />
              </div>
            ) : null}
            {defects.loading ? <EmptyState title="Loading…" /> : null}
            {specByKind.length > 0 ? (
              <ChartCard title="Spec defects by kind" note={`${specDefects.length} catalogued`}>
                <MiniBars
                  rows={specByKind}
                  barHeight={size.bar}
                  aria-label="Spec defects by kind"
                />
              </ChartCard>
            ) : null}
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
            {defects.loading ? <EmptyState title="Loading…" /> : null}
            {sampleDefects.length > 0 ? (
              <div className="grid gap-2 md:grid-cols-2">
                <ChartCard
                  title="By severity"
                  note={`${sampleDefects.length} defects · the sample compiler's own grading`}
                >
                  <ProportionBar
                    segments={sampleBySeverity}
                    height={size.proportion}
                    aria-label="Sample defects by severity"
                  />
                </ChartCard>
                <ChartCard title="By defect type" note={`top ${TOP_N}; the rest folded into other`}>
                  <MiniBars
                    rows={sampleByType}
                    barHeight={size.bar}
                    aria-label="Sample defects by type"
                  />
                </ChartCard>
              </div>
            ) : null}
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
            <ChartCard
              title="Independently sourced, by element kind"
              note="rules stated on a published page, as a share of rules found"
            >
              <MiniBars
                rows={independenceRows}
                barHeight={size.bar}
                aria-label="Independently sourced rules by element kind"
              />
            </ChartCard>
            {/* The accessible twin of the bars, and the only place `overall` and the exact
                share are set as text. Share is a number here, not a coloured badge. */}
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
                  <tr
                    key={kind}
                    className={kind === "overall" ? "border-t border-line-strong font-medium" : "border-b border-line/60"}
                  >
                    <td className="py-1 font-mono text-ink">{kind}</td>
                    <td className="py-1 text-right tabular-nums text-ink-2">{v.found}</td>
                    <td className="py-1 text-right tabular-nums text-ink-2">{v.independent}</td>
                    <td className="py-1 text-right font-mono tabular-nums text-ink">{(v.share * 100).toFixed(1)}%</td>
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

/**
 * Stat tile. The figure leads and the label sits under it in muted ink. The step up in
 * roomy mode is deliberate over and above the token rescale: a tile is read from across a
 * room where a paragraph is not.
 */
function Stat({ label, value, density }: { label: string; value: string; density: DensityChoice }) {
  return (
    <div className="rounded-sm border border-line bg-surface px-2.5 py-2">
      <div className={`font-mono tabular-nums text-ink ${density === "roomy" ? "text-2xl" : "text-xl"}`}>{value}</div>
      <div className="mt-0.5 text-2xs text-ink-3">{label}</div>
    </div>
  );
}

/** Bordered surface for a chart: title, an optional note, the chart. Text is ink; no colour. */
function ChartCard({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <figure className="rounded-sm border border-line bg-surface p-2.5 text-xs">
      <figcaption className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold text-ink">{title}</span>
        {note ? <span className="text-2xs text-ink-3">{note}</span> : null}
      </figcaption>
      {children}
    </figure>
  );
}
