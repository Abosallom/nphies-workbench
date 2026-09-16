import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AnatomyMap,
  Badge,
  Button,
  CopyButton,
  EmptyState,
  ProportionBar,
  SEVERITY_GLYPH,
  SEVERITY_LABEL,
  SeverityCount,
  SplitView,
  Toolbar,
  ToolbarTitle,
  Tooltip,
  type AnatomyBlock,
  type DensityChoice,
  type Finding as UiFinding,
  type Region,
  type Segment,
  type Severity,
  type SplitSelection,
  type StructureNode,
} from "../ui";
import type { MessageStructure } from "../lib/structure";
import type { ResolvedUseCase } from "../lib/workbench";
import type { Finding as EngineFinding } from "../lib/check";
import { ENCODING_LABEL, fetchGolden, type GoldenSample } from "../lib/workbench";
import { adaptAnatomy, adaptMessage } from "../lib/adapt";
import { detectMessage, type DetectResult } from "../lib/detect";
import { highlight } from "../lib/highlight";
import { buildSkeleton, skeletonWindow, type Skeleton } from "../lib/skeleton";
import { gapsOf } from "../lib/gaps";
import { ruleStubsFrom, type GapOutcome, type ReviewOutcome } from "../lib/ai";
import { useAnalysis } from "./useSpec";
import { AiExplain } from "./AiExplain";
import { AdvisoryPanel, type AdvisoryInput, type DeclaredConditions } from "./AdvisoryPanel";
import { DetectionBanner } from "./DetectionBanner";
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
  /**
   * Layout density, from Shell's one `useDensity()`. The CSS tokens rescale everything else;
   * the JS value exists because the virtualised row heights are numbers, and rows positioned
   * for 20px text overlap once the text is 26px tall.
   */
  density?: DensityChoice;
  /**
   * The detector found the message belongs to another use case. Shell carries the paste over,
   * selects that use case (and the structure, when given) and stays on Check.
   */
  onSwitchUseCase?: (useCaseId: string, structureId: string | null) => void;
}

/**
 * Virtualised row heights per density. These MUST track the type scale in index.css: a code
 * line at 14px text in a 20px row is what the dense scale was designed as; the roomy scale
 * lifts text by ~15% and the rows here go with it, or the windowed rows overlap.
 */
const ROW_HEIGHTS: Record<DensityChoice, { line: number; tree: number }> = {
  dense: { line: 20, tree: 22 },
  roomy: { line: 26, tree: 30 },
};

/** Anatomy ribbon height per density: a strip on the instrument, a readable band on a projector. */
const ANATOMY_HEIGHT: Record<DensityChoice, number> = { dense: 24, roomy: 44 };

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
  density = "dense",
  onSwitchUseCase,
}: CheckViewProps) {
  const [selection, setSelection] = useState<SplitSelection | null>(null);
  const [editing, setEditing] = useState(true);
  const [loadingSample, setLoadingSample] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const analysis = useAnalysis(text, structure, resolved);

  /* ---- detection: what the message says it is ------------------------- *
   * Runs when a paste SETTLES (blur, Check, a sample landing), never per keystroke: the
   * detector reads the whole text, and a verdict about a half-pasted message is a verdict
   * about a message nobody sent. The result is stamped with the text it was read from and
   * shown only while that text is still the text in the box. */
  const [detection, setDetection] = useState<{ forText: string; result: DetectResult } | null>(null);
  /** The text whose detector banner the analyst collapsed with [Keep]. */
  const [keptFor, setKeptFor] = useState<string | null>(null);
  const detectSeq = useRef(0);
  const runDetect = useCallback((body: string) => {
    const trimmed = body.trim();
    if (!trimmed) {
      setDetection(null);
      return;
    }
    const mine = ++detectSeq.current;
    detectMessage(body).then(
      (result) => {
        if (detectSeq.current === mine) setDetection({ forText: body, result });
      },
      () => {
        // A detector failure is not a finding; the banner simply does not appear.
        if (detectSeq.current === mine) setDetection(null);
      },
    );
  }, []);
  const liveDetection = detection && detection.forText === text ? detection.result : null;

  const { run } = analysis;
  const check = useCallback(() => {
    setEditing(false);
    run();
    runDetect(text);
  }, [run, runDetect, text]);

  /* The verdict belongs to the text it was computed from: editing returns to the box. */
  useEffect(() => {
    if (!text.trim()) setEditing(true);
  }, [text]);

  const model = useMemo(() => {
    if (!analysis.data || analysis.data.parse.failure) return null;
    const adapted = adaptMessage(analysis.data.parse.tree, analysis.data.findings);
    const anatomy = adaptAnatomy(analysis.data.parse.tree, analysis.data.findings);
    const tree = adapted.tree as StructureNode[];

    // nodeId -> the block that contains it, for the reverse link (selection -> tile). Every
    // id in `regions`, `tree` and `blocks` is the same TreeNode id, so one walk of the adapted
    // tree suffices. The trailing "+N more" fold points at a CONTAINER the drawn blocks also
    // sit under, so it is filled last and never overwrites a real block's descendants.
    const byId = new Map<string, StructureNode>();
    const index = (nodes: StructureNode[]) => {
      for (const n of nodes) {
        byId.set(n.id, n);
        if (n.children?.length) index(n.children);
      }
    };
    index(tree);
    const blockByNode = new Map<string, string>();
    const claim = (node: StructureNode | undefined, blockId: string) => {
      if (!node) return;
      if (!blockByNode.has(node.id)) blockByNode.set(node.id, blockId);
      for (const c of node.children ?? []) claim(c, blockId);
    };
    const drawn = anatomy.folded ? anatomy.blocks.slice(0, -1) : anatomy.blocks;
    for (const b of drawn) claim(byId.get(b.id), b.id);
    if (anatomy.folded) {
      const fold = anatomy.blocks[anatomy.blocks.length - 1];
      claim(byId.get(fold.id), fold.id);
    }

    return {
      regions: adapted.regions as Region[],
      tree,
      findings: adapted.findings as UiFinding[],
      nodeCount: adapted.nodeCount,
      tokens: highlight(text, analysis.data.parse.encoding),
      anatomy,
      blockByNode,
    };
  }, [analysis.data, text]);

  const selectedBlockId = useMemo(() => {
    if (!model || !selection) return null;
    const id = selection.nodeId ?? selection.regionId;
    return id ? (model.blockByNode.get(id) ?? null) : null;
  }, [model, selection]);

  const onBlockSelect = useCallback((block: AnatomyBlock) => {
    // "external" so SplitView reveals both the code line and the tree row.
    setSelection({ regionId: block.regionId ?? null, nodeId: block.id, origin: "external" });
  }, []);

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

  /* The verdict as part-of-whole, for presentation mode. Severity tone is the one legitimate
   * use of verdict colour in a chart — each segment IS a verdict bucket — and every segment's
   * label carries its glyph, so no bucket is colour alone. */
  const verdictSegments = useMemo<Segment[]>(() => {
    const order: Severity[] = ["error", "warn", "ok", "ignored"];
    return order.map((s) => ({
      id: s,
      label: `${SEVERITY_GLYPH[s]} ${counts[s]}`,
      value: counts[s],
      tone: { kind: "severity", severity: s },
      detail: SEVERITY_LABEL[s],
    }));
  }, [counts]);

  /* The engine findings, by id, so the AI action can be given the full one rather than the
   * presentational projection the pane renders. */
  const engineFindings = useMemo(() => {
    const map = new Map<string, EngineFinding>();
    for (const f of analysis.data?.findings ?? []) map.set(f.id, f);
    return map;
  }, [analysis.data]);

  /* ---- what may leave the browser ------------------------------------- *
   * The redacted skeleton, built once per verdict. It is the ONLY message-derived text any
   * AI action here is handed: the explain footer gets a window of it, the advisory panel
   * gets the whole of it. The raw `text` never reaches either. */
  const skeleton = useMemo<Skeleton | null>(() => {
    if (!analysis.data || analysis.data.parse.failure || !resolved) return null;
    return buildSkeleton(analysis.data.parse.tree, resolved.specNodes, { findings: analysis.data.findings });
  }, [analysis.data, resolved]);

  /* ---- the advisory panel's state -------------------------------------- *
   * Advisories live HERE and in the panel, in React state, and nowhere else: not in
   * `analysis.data.findings`, not in `model`, not in what `onResult` reports. The panel is
   * closed until asked for, and a new verdict clears what a model said about the old one. */
  const [panelOpen, setPanelOpen] = useState(false);
  /* Each outcome is stored WITH the input it was asked about, and read back only while that
   * input is the one on screen: a new check has a new payload digest, and what a model said
   * about the previous payload is dropped rather than read against this one. */
  const [reviewFor, setReviewFor] = useState<{ input: AdvisoryInput; outcome: ReviewOutcome } | null>(null);
  const [gapsFor, setGapsFor] = useState<{ input: AdvisoryInput; outcome: GapOutcome } | null>(null);
  /** Set by the panel's "Re-check as <condition>" click, and only by it. */
  const [declaredFor, setDeclaredFor] = useState<DeclaredConditions | null>(null);

  const advisoryInput = useMemo<AdvisoryInput | null>(() => {
    if (!analysis.data || analysis.data.parse.failure || !skeleton || !resolved || !structure) return null;
    // Positive findings are the bulk of a clean message and give a reviewer nothing to
    // doubt, so they stay home; the panel says how many did.
    const findings = analysis.data.findings.filter((f) => f.severity !== "ok" && f.severity !== "ignored");
    return {
      structure,
      findings,
      withheld: analysis.data.findings.length - findings.length,
      skeleton,
      rules: ruleStubsFrom(resolved.specNodes),
      gaps: gapsOf(analysis.data.findings, { tree: analysis.data.parse.tree, structure, specNodes: resolved.specNodes }),
    };
  }, [analysis.data, skeleton, resolved, structure]);

  const review = reviewFor && reviewFor.input === advisoryInput ? reviewFor.outcome : null;
  const gapOutcome = gapsFor && gapsFor.input === advisoryInput ? gapsFor.outcome : null;
  // An outcome that lands after the check it was asked about has gone is stored against
  // that old input, and therefore never shown.
  const onReview = useCallback((outcome: ReviewOutcome) => advisoryInput && setReviewFor({ input: advisoryInput, outcome }), [advisoryInput]);
  const onGaps = useCallback((outcome: GapOutcome) => advisoryInput && setGapsFor({ input: advisoryInput, outcome }), [advisoryInput]);

  // The declared-condition note describes the verdict on screen; once that verdict is gone
  // (new text, new structure, a plain re-check) `analysis.conditions` is empty and so is the note.
  const declared = analysis.conditions.length ? declaredFor : null;

  const recheckAs = useCallback(
    (condition: string) => {
      setDeclaredFor({ conditions: [condition], via: "advisory" });
      run({ conditions: [condition] });
    },
    [run],
  );

  const selectFinding = useCallback(
    (findingId: string) => {
      const ui = model?.findings.find((f) => f.id === findingId);
      if (!ui?.regionId) return;
      // `adaptMessage` gives a region the id of the node it was drawn for, so the same id
      // reveals the code line and the tree row; "external" makes SplitView scroll to both.
      setSelection({ regionId: ui.regionId, nodeId: ui.regionId, origin: "external" });
    },
    [model],
  );

  /* Finding ids the model doubted. Used for ONE thing: a one-line text link in the row's
   * footer. The row itself — severity, glyph, colour, order — is untouched. */
  const doubted = useMemo(() => {
    const ids = new Set<string>();
    for (const a of review?.advisories ?? []) if (a.verdict === "doubt" && a.about.findingId) ids.add(a.about.findingId);
    return ids;
  }, [review]);

  const openPanel = useCallback(() => setPanelOpen(true), []);

  const findingFooter = useCallback(
    (finding: { id: string; line?: number }) => {
      const engine = engineFindings.get(finding.id);
      if (!engine || !structure) return null;
      return (
        <CheckFindingFooter
          finding={engine}
          line={finding.line ?? engine.location?.line}
          structure={structure}
          skeleton={skeleton}
          doubted={doubted.has(engine.id)}
          onShowDoubt={openPanel}
        />
      );
    },
    [engineFindings, structure, skeleton, doubted, openPanel],
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
        runDetect(body);
      } catch (err) {
        setSampleError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingSample(null);
      }
    },
    [onStructureChange, onTextChange, structureIdForSample, runDetect],
  );

  const onFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      file.text().then((body) => {
        onTextChange(body);
        setEditing(true);
        runDetect(body);
      });
    },
    [onTextChange, runDetect],
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
  const rows = ROW_HEIGHTS[density];
  const roomy = density === "roomy";
  const showResult = !editing && model !== null;

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
        {summary && roomy && showResult ? (
          <span className="ml-1 flex min-w-0 items-center gap-3">
            <span className="w-56 shrink-0" data-verdict-bar>
              <ProportionBar
                segments={verdictSegments}
                showLegend={false}
                height={12}
                aria-label={`Findings: ${verdictSegments
                  .map((s) => `${counts[s.id as Severity]} ${SEVERITY_LABEL[s.id as Severity].toLowerCase()}`)
                  .join(", ")}`}
              />
            </span>
            {/* The legend, as text: the bar's direct labels are drawn only where they fit,
                and a three-finding sliver must still say what it is. Ink, not colour. */}
            <span className="font-mono text-2xs tabular-nums text-ink-2">
              {(["error", "warn", "ok", "ignored"] as Severity[]).map((s, i) => (
                <span key={s} title={SEVERITY_LABEL[s]}>
                  {i ? " · " : ""}
                  {SEVERITY_GLYPH[s]}
                  {counts[s]}
                </span>
              ))}
            </span>
            <Tooltip
              wide
              content={
                summary.readinessBasis === "measured"
                  ? `${summary.requiredSatisfied} of ${summary.requiredTotal} required elements the checker evaluated are present.`
                  : "No required elements were evaluated, so no readiness figure is claimed."
              }
            >
              <span
                data-stat-tile
                className="inline-flex items-baseline gap-1.5 rounded-xs border border-line bg-raised px-1.5 py-px"
              >
                <span className="text-2xs text-ink-3">required</span>
                <span className="text-xs font-semibold text-ink">
                  {summary.readinessBasis === "measured"
                    ? `${summary.requiredSatisfied}/${summary.requiredTotal}`
                    : "—"}
                </span>
              </span>
            </Tooltip>
          </span>
        ) : summary ? (
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
      {analysis.conditions.length && showResult ? (
        <Banner tone="info">
          Checked as <strong className="font-semibold">{analysis.conditions.join(", ")}</strong>
          {declared ? " — condition declared by analyst, suggested by model." : "."}{" "}
          <button type="button" className="underline decoration-dotted hover:text-ink" onClick={() => run()}>
            Re-check without it
          </button>
        </Banner>
      ) : null}
      {sampleError ? <Banner tone="warn">{sampleError}</Banner> : null}
      {liveDetection ? (
        <DetectionBanner
          result={liveDetection}
          currentUseCaseId={structure.useCaseId}
          currentStructureId={structure.id}
          structures={structures}
          kept={keptFor === text}
          onKeep={() => setKeptFor(text)}
          onShow={() => setKeptFor(null)}
          onSwitchStructure={onStructureChange}
          onSwitchUseCase={onSwitchUseCase}
        />
      ) : null}

      {/* ------------------------------------------------------------ anatomy */}
      {showResult && model.anatomy.blocks.length ? (
        <div
          className="shrink-0 border-b border-line bg-surface px-3 py-1.5"
          data-anatomy={density}
        >
          <AnatomyMap
            blocks={model.anatomy.blocks}
            selectedId={selectedBlockId}
            onSelect={onBlockSelect}
            height={ANATOMY_HEIGHT[density]}
            aria-label="Message anatomy — one block per top-level part, tinted by its worst finding"
          />
          {model.anatomy.unplaced > 0 || model.anatomy.folded > 0 ? (
            <p className="mt-1 text-2xs text-ink-3">
              {model.anatomy.folded > 0
                ? `${model.anatomy.folded} further blocks are folded into the last tile. `
                : ""}
              {model.anatomy.unplaced > 0
                ? `${model.anatomy.unplaced} ${model.anatomy.unplaced === 1 ? "finding sits" : "findings sit"} outside these blocks (on the message itself or on nothing present) and ${model.anatomy.unplaced === 1 ? "is" : "are"} not shown here.`
                : ""}
            </p>
          ) : null}
        </div>
      ) : null}

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
              onBlur={() => runDetect(text)}
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
            lineHeight={rows.line}
            treeRowHeight={rows.tree}
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

      {/* ----------------------------------------------------------- advisory */}
      {showResult ? (
        <AdvisoryPanel
          input={advisoryInput}
          open={panelOpen}
          onToggle={() => setPanelOpen((o) => !o)}
          review={review}
          onReview={onReview}
          gaps={gapOutcome}
          onGaps={onGaps}
          onSelectFinding={selectFinding}
          onRecheck={recheckAs}
          declared={declared}
          density={density}
        />
      ) : null}
    </div>
  );
}

/* ========================================================================== *
 * The finding footer
 * ========================================================================== */

export interface CheckFindingFooterProps {
  finding: EngineFinding;
  /** The line the row points at, when it has one. */
  line?: number;
  structure: MessageStructure;
  /** The verdict's skeleton; `null` only while there is no verdict, in which case no window is sent. */
  skeleton: Skeleton | null;
  /** A second opinion doubted this finding. Produces a text link and nothing else. */
  doubted?: boolean;
  onShowDoubt?: () => void;
}

/**
 * What sits under a finding row: the explain action, and — when a model doubted the finding
 * — a one-line link to where that doubt is shown. The AI action gets a WINDOW of the
 * redacted skeleton, never the message lines; `skeletonWindow` is the only excerpt function
 * this file calls.
 */
export function CheckFindingFooter({ finding, line, structure, skeleton, doubted, onShowDoubt }: CheckFindingFooterProps) {
  // Only offer the explanation where a model can add something: a positive or informational
  // finding is already as actionable as it gets.
  const explainable = finding.severity === "error" || finding.severity === "warn";
  if (!explainable && !doubted) return null;
  const excerpt = skeleton && line ? skeletonWindow(skeleton, line, 2) : "";
  return (
    <div className="flex flex-col gap-1">
      {explainable ? <AiExplain finding={finding} structure={structure} skeletonWindow={excerpt || undefined} windowLine={line} /> : null}
      {doubted ? (
        <button
          type="button"
          onClick={onShowDoubt}
          className="self-start text-2xs text-ink-2 underline decoration-dotted underline-offset-2 hover:text-ink"
          data-model-doubt
        >
          model doubts this — see below
        </button>
      ) : null}
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
