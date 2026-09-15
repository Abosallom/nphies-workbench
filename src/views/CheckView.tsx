import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  SeverityCount,
  SplitView,
  Toolbar,
  ToolbarTitle,
  Tooltip,
  type Finding as UiFinding,
  type Region,
  type Severity,
  type SplitSelection,
  type StructureNode,
} from "../ui";
import type { MessageStructure } from "../lib/structure";
import type { ResolvedUseCase } from "../lib/workbench";
import type { Finding as EngineFinding } from "../lib/check";
import { ENCODING_LABEL, fetchGolden, type GoldenSample } from "../lib/workbench";
import { adaptMessage } from "../lib/adapt";
import { highlight } from "../lib/highlight";
import { useAnalysis } from "./useSpec";
import { AiExplain } from "./AiExplain";
import type { SessionResult } from "./ReadinessView";

/* ========================================================================== *
 * Check — the loop-closer.
 *
 * Paste what the HIS produced, get every structural deviation located and explained.
 * Build without Check just moves the guessing earlier, so this is the surface the whole
 * workbench is arranged around.
 * ========================================================================== */

export interface CheckViewProps {
  structure: MessageStructure | null;
  structures: MessageStructure[];
  resolved: ResolvedUseCase | null;
  samples: GoldenSample[];
  text: string;
  onTextChange: (text: string) => void;
  /** Selecting an official sample also selects the structure it belongs to. */
  onStructureChange: (structureId: string) => void;
  structureIdForSample: (sample: GoldenSample) => string | null;
  /** Reported after every completed check, so Readiness can say what has been verified. */
  onResult?: (result: SessionResult) => void;
  baseUrl?: string;
  useCaseCode?: string;
}

export function CheckView({
  structure,
  structures,
  resolved,
  samples,
  text,
  onTextChange,
  onStructureChange,
  structureIdForSample,
  onResult,
  baseUrl,
  useCaseCode,
}: CheckViewProps) {
  const [selection, setSelection] = useState<SplitSelection | null>(null);
  const [editing, setEditing] = useState(true);
  const [loadingSample, setLoadingSample] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const analysis = useAnalysis(text, structure, resolved);

  const { run } = analysis;
  const check = useCallback(() => {
    setEditing(false);
    run();
  }, [run]);

  /* The verdict belongs to the text it was computed from: editing returns to the box. */
  useEffect(() => {
    if (!text.trim()) setEditing(true);
  }, [text]);

  const model = useMemo(() => {
    if (!analysis.data || analysis.data.parse.failure) return null;
    const adapted = adaptMessage(analysis.data.parse.tree, analysis.data.findings);
    return {
      regions: adapted.regions as Region[],
      tree: adapted.tree as StructureNode[],
      findings: adapted.findings as UiFinding[],
      nodeCount: adapted.nodeCount,
      tokens: highlight(text, analysis.data.parse.encoding),
    };
  }, [analysis.data, text]);

  /* Every completed check is reported once, keyed by the structure it judged. */
  const reported = useRef<string | null>(null);
  useEffect(() => {
    const data = analysis.data;
    if (!data || data.parse.failure || !onResult) return;
    const stamp = `${data.structure.id}:${text.length}:${data.summary.errors}:${data.summary.warns}`;
    if (reported.current === stamp) return;
    reported.current = stamp;
    onResult({
      structureId: data.structure.id,
      errors: data.summary.errors,
      warns: data.summary.warns,
      readinessScore: data.summary.readinessScore,
      readinessBasis: data.summary.readinessBasis,
      requiredSatisfied: data.summary.requiredSatisfied,
      requiredTotal: data.summary.requiredTotal,
      at: Date.now(),
    });
  }, [analysis.data, onResult, text.length]);

  const counts = useMemo(() => {
    const c: Record<Severity, number> = { error: 0, warn: 0, ok: 0, ignored: 0, info: 0 };
    for (const f of model?.findings ?? []) c[f.severity]++;
    return c;
  }, [model]);

  /* The engine findings, by id, so the AI action can be given the full one rather than the
   * presentational projection the pane renders. */
  const engineFindings = useMemo(() => {
    const map = new Map<string, EngineFinding>();
    for (const f of analysis.data?.findings ?? []) map.set(f.id, f);
    return map;
  }, [analysis.data]);

  const lines = useMemo(() => text.split(/\r\n|\r|\n/), [text]);

  const findingFooter = useCallback(
    (finding: { id: string; line?: number }) => {
      const engine = engineFindings.get(finding.id);
      if (!engine || !structure) return null;
      // Only offer it where a model can add something: a positive or informational finding
      // is already as actionable as it gets.
      if (engine.severity !== "error" && engine.severity !== "warn") return null;
      const at = finding.line ?? engine.location?.line;
      const snippet = at
        ? lines
            .slice(Math.max(0, at - 3), at + 2)
            .map((l, i) => `${Math.max(1, at - 2) + i}: ${l}`)
            .join("\n")
        : undefined;
      return <AiExplain finding={engine} structure={structure} snippet={snippet} />;
    },
    [engineFindings, structure, lines],
  );

  const loadSample = useCallback(
    async (sample: GoldenSample) => {
      setLoadingSample(sample.path);
      setSampleError(null);
      try {
        const body = await fetchGolden(sample);
        const structureId = structureIdForSample(sample);
        if (structureId) onStructureChange(structureId);
        onTextChange(body);
        setEditing(true);
      } catch (err) {
        setSampleError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingSample(null);
      }
    },
    [onStructureChange, onTextChange, structureIdForSample],
  );

  const onFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      file.text().then((body) => {
        onTextChange(body);
        setEditing(true);
      });
    },
    [onTextChange],
  );

  if (!structure) {
    return (
      <EmptyState
        fill
        glyph="⎔"
        title="No compiled structure"
        description="The spec bundle holds no message structure for this use case, so there is nothing to check a message against."
      />
    );
  }

  const summary = analysis.data?.summary;

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <Toolbar
        dense
        aria-label="Check"
        end={
          <div className="flex items-center gap-1.5">
            {text.trim() ? (
              <CopyButton value={text} what="the message" size="xs" />
            ) : null}
            {!editing ? (
              <Button size="xs" onClick={() => setEditing(true)}>
                Edit message
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="primary"
              onClick={check}
              disabled={!text.trim() || analysis.loading}
            >
              {analysis.loading ? "Checking…" : "Check structure"}
            </Button>
          </div>
        }
      >
        <ToolbarTitle>Check</ToolbarTitle>
        {structures.length > 1 ? (
          <label className="flex items-center gap-1 text-2xs text-ink-3">
            <span className="sr-only">Variant</span>
            <select
              className="rounded-xs border border-line bg-surface px-1 py-0.5 font-mono text-2xs text-ink"
              value={structure.id}
              onChange={(e) => onStructureChange(e.target.value)}
            >
              {structures.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.variantLabel ?? s.variant ?? s.title}
                  {(s.direction ?? "request") === "response" ? " (response)" : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <Badge mono title={`Messages for this use case are ${ENCODING_LABEL[structure.encoding]}`}>
          {structure.encoding}
        </Badge>
        {summary ? (
          <span className="ml-1 flex items-center gap-2">
            <SeverityCount severity="error" count={counts.error} />
            <SeverityCount severity="warn" count={counts.warn} />
            <SeverityCount severity="ok" count={counts.ok} />
            <SeverityCount severity="ignored" count={counts.ignored} />
            <Tooltip
              wide
              content={
                summary.readinessBasis === "measured"
                  ? `${summary.requiredSatisfied} of ${summary.requiredTotal} required elements the checker evaluated are present.`
                  : "No required elements were evaluated, so no readiness figure is claimed."
              }
            >
              <span className="text-2xs text-ink-3">
                required{" "}
                {summary.readinessBasis === "measured"
                  ? `${summary.requiredSatisfied}/${summary.requiredTotal}`
                  : "—"}
              </span>
            </Tooltip>
          </span>
        ) : null}
      </Toolbar>

      {/* ------------------------------------------------------------ banners */}
      {analysis.data?.encodingMismatch ? (
        <Banner tone="warn">{analysis.data.encodingMismatch}</Banner>
      ) : null}
      {analysis.data?.parse.failure ? (
        <Banner tone="error">
          <strong className="font-semibold">The message could not be parsed.</strong>{" "}
          {analysis.data.parse.failure} Nothing was checked — reporting structural findings
          against a tree the parser could not build would be guesswork.
        </Banner>
      ) : null}
      {analysis.error ? <Banner tone="error">{analysis.error}</Banner> : null}
      {sampleError ? <Banner tone="warn">{sampleError}</Banner> : null}

      {/* -------------------------------------------------------------- body */}
      <div className="min-h-0 flex-1">
        {editing || !model ? (
          <div className="flex h-full min-h-0 flex-col gap-2 p-3">
            <textarea
              className="min-h-0 flex-1 resize-none rounded-sm border border-line bg-surface p-2.5 font-mono text-xs leading-5 text-ink outline-none placeholder:text-ink-3 focus:border-accent"
              placeholder={`Paste the ${ENCODING_LABEL[structure.encoding]} message your HIS produced…`}
              value={text}
              spellCheck={false}
              onChange={(e) => onTextChange(e.target.value)}
              onDrop={(e) => {
                e.preventDefault();
                onFile(e.dataTransfer.files[0]);
              }}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                onChange={(e) => onFile(e.target.files?.[0])}
              />
              <Button size="xs" onClick={() => fileRef.current?.click()}>
                Open file…
              </Button>
              {text.trim() ? (
                <Button size="xs" variant="ghost" onClick={() => onTextChange("")}>
                  Clear
                </Button>
              ) : null}
              <span className="ml-auto text-2xs text-ink-3">
                {text ? `${text.length.toLocaleString()} characters` : "Nothing pasted yet"}
              </span>
            </div>
            {samples.length ? (
              <div className="rounded-sm border border-line bg-surface p-2">
                <div className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-3">
                  Official NPHIES samples
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {samples.map((s) => (
                    <Button
                      key={s.path}
                      size="xs"
                      onClick={() => loadSample(s)}
                      disabled={loadingSample === s.path}
                      title={`${s.path}${s.variantTags.length ? ` · ${s.variantTags.join(", ")}` : ""}`}
                    >
                      {loadingSample === s.path ? "Loading…" : shortName(s.fileName)}
                    </Button>
                  ))}
                </div>
                <p className="mt-1.5 text-2xs text-ink-3">
                  These are the reference messages NPHIES publishes. They are the ground truth
                  the structural rules were verified against — and five of them are themselves
                  defective, which the checker will tell you about.
                </p>
              </div>
            ) : null}
          </div>
        ) : (
          <SplitView
            text={text}
            regions={model.regions}
            tree={model.tree}
            findings={model.findings}
            tokens={model.tokens}
            selection={selection}
            onSelectionChange={setSelection}
            baseUrl={baseUrl}
            codeTitle={
              <span className="flex items-center gap-1.5">
                {useCaseCode ?? structure.title}
                <span className="font-normal normal-case tracking-normal text-ink-3">
                  {model.nodeCount.toLocaleString()} nodes
                </span>
              </span>
            }
            structureTitle="Structure"
            renderFindingFooter={findingFooter}
          />
        )}
      </div>
    </div>
  );
}

function shortName(fileName: string): string {
  return fileName.replace(/\.(xml|json|txt)$/i, "").replace(/^\d+\s+/, "").slice(0, 46);
}

function Banner({ tone, children }: { tone: "error" | "warn" | "info"; children: React.ReactNode }) {
  const cls =
    tone === "error"
      ? "border-error bg-error-bg text-error-ink"
      : tone === "warn"
        ? "border-warn bg-warn-bg text-warn-ink"
        : "border-line bg-surface text-ink-2";
  return (
    <div className={`shrink-0 border-b px-3 py-1.5 text-2xs leading-relaxed ${cls}`}>{children}</div>
  );
}
