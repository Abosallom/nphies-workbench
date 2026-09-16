import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  Toolbar,
  ToolbarTitle,
  cx,
  useApiKey,
  useToast,
  type DensityChoice,
} from "../ui";
import type { MessageStructure } from "../lib/structure";
import { ENCODING_LABEL, fetchGolden, structureForSample, type GoldenSample, type ResolvedUseCase } from "../lib/workbench";
import { buildProfile, OBLIGATION_LABEL, type Obligation, type Profile } from "../lib/profile";
import {
  autoMapByName,
  confirmEntry,
  generateFromTemplate,
  mappingCandidates,
  mergeModelProposal,
  readCsv,
  readSheet,
  setAnalystChoice,
  type ColumnMapping,
  type GenerateResult,
  type MappingEntry,
  type Sheet,
} from "../lib/ingest";
import { describeAiError, estimateTokens, suggestColumnMapping, type ColumnMapping as ModelProposalOutput } from "../lib/ai";

/* ========================================================================== *
 * Ingest — a hospital extract becomes a message, one row at a time.
 *
 * Three panels, read left to right: upload a sheet, map its columns onto positions the
 * compiled profile actually has, fill an official sample with one row. Each panel is only as
 * confident as the library underneath it: the name matcher pairs nothing it cannot pair
 * exactly, a model's proposal enters unconfirmed and is refused by the generator until a
 * human ticks it, and the generator lists every position it would not write and why.
 *
 * Nothing here judges the result. The generated message is handed to Check, which is where
 * a verdict — with its evidence — belongs. Cell data never leaves the browser; when a model
 * is asked, it sees column NAMES and the profile's candidate list, and the exact text is
 * shown before the first call.
 * ========================================================================== */

export interface IngestViewProps {
  structure: MessageStructure | null;
  structures: MessageStructure[];
  resolved: ResolvedUseCase | null;
  samples: GoldenSample[];
  /** Owned by Shell; the JS value only decides panel widths and leading. Tokens do the rest. */
  density: DensityChoice;
  /** Hand the generated text to the Check tab, where it is judged. */
  onOpenInCheck: (text: string) => void;
  /** When several variants exist, the mapping is built for one of them; this picks which. */
  onStructureChange?: (structureId: string) => void;
  /**
   * A sheet to start from instead of an upload. Exists so the surface can be mounted with a
   * known extract under SSR, where there is no file input to drive; the app never passes it.
   */
  initialSheet?: Sheet;
}

/** The order the target picker lists its groups in: what must be built first. */
const CANDIDATE_GROUPS: Obligation[] = ["must", "ifKnown", "optional", "unstated", "ignored"];

/** The `<select>` value that reveals the free-text position input. */
const CUSTOM = "__custom__";

const PRIVACY_SENTENCE =
  "Cell data stays in this browser. Only column names are ever sent to a model, and only when you ask.";

interface LoadedSheet {
  sheet: Sheet;
  fileName: string;
}

/** What a model said about its own proposal. React state only; never a finding. */
interface ModelOpinion {
  mappings: ModelProposalOutput["mappings"];
  unmapped: string[];
  sentColumns: number;
}

export function IngestView({
  structure,
  structures,
  resolved,
  samples,
  density,
  onOpenInCheck,
  onStructureChange,
  initialSheet,
}: IngestViewProps) {
  const roomy = density === "roomy";
  const { key } = useApiKey();
  const toast = useToast();

  const profile = useMemo(
    () => (structure ? buildProfile(structure, resolved?.tables) : null),
    [structure, resolved],
  );

  /* ---- 1. upload ------------------------------------------------------- */
  const [loaded, setLoaded] = useState<LoadedSheet | null>(() =>
    initialSheet ? { sheet: initialSheet, fileName: initialSheet.name ?? "sheet" } : null,
  );
  const [reading, setReading] = useState<"idle" | "csv" | "workbook">("idle");
  const [readError, setReadError] = useState<string | null>(null);

  /* ---- 2. map ---------------------------------------------------------- */
  const [mapping, setMapping] = useState<ColumnMapping | null>(() =>
    initialSheet && profile ? autoMapByName(initialSheet, profile) : null,
  );
  const [opinion, setOpinion] = useState<ModelOpinion | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const candidates = useMemo(() => (profile ? mappingCandidates(profile) : []), [profile]);
  const candidateGroups = useMemo(() => groupCandidates(candidates, profile), [candidates, profile]);

  const startMapping = useCallback(
    (sheet: Sheet) => {
      if (!profile) return;
      setMapping(autoMapByName(sheet, profile));
      setOpinion(null);
      setAskError(null);
    },
    [profile],
  );

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setReadError(null);
      const isCsv = /\.csv$/i.test(file.name) || file.type === "text/csv";
      setReading(isCsv ? "csv" : "workbook");
      try {
        const sheet = isCsv ? readCsv(await file.text()) : await readSheet(await file.arrayBuffer());
        setLoaded({ sheet, fileName: file.name });
        startMapping(sheet);
      } catch (err) {
        setReadError(err instanceof Error ? err.message : String(err));
      } finally {
        setReading("idle");
      }
    },
    [startMapping],
  );

  const columnsToAsk = useMemo(() => mapping?.unmapped ?? [], [mapping]);
  const askPayload = useMemo(() => mappingRequestData(columnsToAsk, candidates), [columnsToAsk, candidates]);

  const ask = useCallback(async () => {
    if (!mapping || !profile || !key) return;
    setAsking(true);
    setAskError(null);
    try {
      const out = await suggestColumnMapping(key, columnsToAsk, candidates);
      setMapping((m) => (m ? mergeModelProposal(m, out, profile) : m));
      setOpinion({ mappings: out.mappings, unmapped: out.unmapped, sentColumns: columnsToAsk.length });
    } catch (err) {
      setAskError(describeAiError(err));
    } finally {
      setAsking(false);
    }
  }, [mapping, profile, key, columnsToAsk, candidates]);

  const exportMapping = useCallback(() => {
    if (!mapping) return;
    const body = JSON.stringify({ ...mapping, exportedAt: new Date().toISOString() }, null, 2);
    const name = `${mapping.structureId}-column-mapping.json`;
    const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    toast.push({ title: `Saved ${name}`, tone: "neutral" });
  }, [mapping, toast]);

  /* ---- 3. generate ----------------------------------------------------- */
  /* `null` until the analyst chooses: the samples arrive asynchronously, so a default fixed
   * at mount could lock "paste my own" in before the official sample is even known about. */
  const [templateChoice, setTemplateChoice] = useState<"sample" | "own" | null>(null);
  const templateSource: "sample" | "own" = templateChoice ?? (samples.length ? "sample" : "own");
  const [samplePath, setSamplePath] = useState<string | null>(null);
  /* One record per fetched sample, written only when the fetch settles, so a change of
   * selection shows "loading" by derivation rather than by a synchronous reset. */
  const [sampleLoad, setSampleLoad] = useState<{ path: string; text: string | null; error: string | null } | null>(null);
  const [ownTemplate, setOwnTemplate] = useState("");
  const [rowIndex, setRowIndex] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<{ result: GenerateResult; row: number } | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

  /* The sample whose variant tag matches the selected structure, else the first: filling an
   * A03 sample while the A01 rules are selected is a mismatch the panel names rather than
   * hides, but it should not be the default. */
  const defaultSample = useMemo(() => {
    if (!samples.length) return null;
    return samples.find((s) => structure && structureForSample(structures, s)?.id === structure.id) ?? samples[0];
  }, [samples, structures, structure]);
  const selectedSample = samples.find((s) => s.path === samplePath) ?? defaultSample;

  useEffect(() => {
    if (templateSource !== "sample" || !selectedSample) return;
    if (sampleLoad?.path === selectedSample.path) return;
    let live = true;
    const path = selectedSample.path;
    fetchGolden(selectedSample).then(
      (text) => live && setSampleLoad({ path, text, error: null }),
      (err) => live && setSampleLoad({ path, text: null, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [templateSource, selectedSample, sampleLoad?.path]);

  const currentLoad = sampleLoad && sampleLoad.path === selectedSample?.path ? sampleLoad : null;
  const sampleError = currentLoad?.error ?? null;
  const templateText = templateSource === "own" ? ownTemplate : (currentLoad?.text ?? "");
  const sampleVariantMismatch =
    templateSource === "sample" && selectedSample && structure
      ? (() => {
          const belongs = structureForSample(structures, selectedSample);
          return belongs && belongs.id !== structure.id ? belongs : null;
        })()
      : null;

  const sheet = loaded?.sheet ?? null;
  const rows = sheet?.rows ?? [];
  const row = rows[Math.min(rowIndex, Math.max(0, rows.length - 1))];
  const mappingIsStale = Boolean(mapping && structure && mapping.structureId !== structure.id);
  const confirmedCount = mapping?.entries.filter((e) => e.confirmed).length ?? 0;
  const canGenerate = Boolean(
    structure && resolved && mapping && !mappingIsStale && row && templateText.trim() && !generating,
  );

  const generate = useCallback(async () => {
    if (!structure || !resolved || !mapping || !row) return;
    setGenerating(true);
    setGenerateError(null);
    setGenerated(null);
    try {
      const result = await generateFromTemplate(templateText, structure, resolved, mapping, row);
      setGenerated({ result, row: rowIndex });
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }, [structure, resolved, mapping, row, rowIndex, templateText]);

  if (!structure || !profile) {
    return (
      <EmptyState
        fill
        glyph="⇥"
        title="No compiled structure"
        description="Nothing was extracted for this use case, so there are no positions to map a spreadsheet onto."
      />
    );
  }

  const panelWidth = roomy ? "min-w-[26rem]" : "min-w-[22rem]";

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <Toolbar
        dense
        aria-label="Ingest"
        end={
          mapping ? (
            <Button size="xs" onClick={exportMapping} title="Download the mapping as JSON, tagged with the structure it was built for">
              Export mapping JSON
            </Button>
          ) : null
        }
      >
        <ToolbarTitle>Ingest</ToolbarTitle>
        {structures.length > 1 && onStructureChange ? (
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
        <Badge mono title={`Messages for this use case are ${ENCODING_LABEL[structure.encoding]}`}>
          {structure.encoding}
        </Badge>
        <span className="hidden truncate text-2xs text-ink-3 lg:inline">{PRIVACY_SENTENCE}</span>
      </Toolbar>

      <div className="flex min-h-0 flex-1 overflow-x-auto">
        {/* ------------------------------------------------------- 1. upload */}
        <Panel step={1} title="Upload" className={panelWidth} roomy={roomy}>
          <DropZone onFile={onFile} reading={reading} roomy={roomy} />
          <p className={cx("text-2xs text-ink-3", roomy && "leading-relaxed")}>
            {PRIVACY_SENTENCE} A CSV is read here with no dependency; an .xlsx / .xls / .ods workbook
            loads the spreadsheet library (7 MB) only at that moment, and only its first worksheet is
            read.
          </p>
          {readError ? <Notice label="Could not read the file">{readError}</Notice> : null}
          {sheet ? (
            <>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink">
                <span className="truncate font-medium">{loaded?.fileName}</span>
                <Badge mono>
                  {sheet.columns.length} columns
                </Badge>
                <Badge mono>
                  {sheet.rows.length} rows{sheet.truncated ? " (truncated)" : ""}
                </Badge>
                {sheet.name ? <Badge mono>sheet {sheet.name}</Badge> : null}
              </div>
              {sheet.columns.length ? (
                <table className="w-full border-collapse text-xs">
                  <thead className="text-2xs uppercase tracking-wide text-ink-3">
                    <tr className="border-b border-line">
                      <th className="py-1 pr-2 text-left font-semibold">Column</th>
                      <th className="px-1 py-1 text-right font-semibold" title="Cells with a non-blank value">
                        filled
                      </th>
                      <th className="px-1 py-1 text-right font-semibold" title="Distinct non-blank values">
                        distinct
                      </th>
                      <th className="py-1 pl-2 text-left font-semibold">First values</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.columns.map((c) => (
                      <tr key={c.name} className="border-b border-line/60 align-top">
                        <td className="py-1 pr-2 font-mono text-ink">{c.name}</td>
                        <td className="px-1 py-1 text-right font-mono tabular-nums text-ink-2">{c.nonEmpty}</td>
                        <td className="px-1 py-1 text-right font-mono tabular-nums text-ink-2">{c.distinct}</td>
                        <td className="py-1 pl-2 font-mono text-2xs text-ink-3">
                          {c.sampleValues.length ? c.sampleValues.map(truncate).join(" · ") : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Notice label="The sheet is empty">No header row was found, so there is nothing to map.</Notice>
              )}
            </>
          ) : null}
        </Panel>

        {/* ---------------------------------------------------------- 2. map */}
        <Panel step={2} title="Map" className={roomy ? "min-w-[34rem]" : "min-w-[28rem]"} roomy={roomy}>
          {!sheet || !mapping ? (
            <p className="text-xs text-ink-3">Upload a sheet first. Its column names are matched against the {profile.title} profile by exact name; nothing is guessed.</p>
          ) : (
            <>
              <p className={cx("text-2xs text-ink-2", roomy && "leading-relaxed")}>
                <strong className="font-semibold text-ink">{mapping.entries.length}</strong> of {sheet.columns.length} columns
                mapped, {confirmedCount} confirmed.{" "}
                {mapping.unmapped.length
                  ? `${mapping.unmapped.length} unmapped: ${mapping.unmapped.map((c) => `"${c}"`).join(", ")}.`
                  : "Every column has a target."}{" "}
                Only confirmed entries are ever written.
              </p>

              {mappingIsStale ? (
                <Notice label="Built for another variant">
                  This mapping was built for <code className="font-mono">{mapping.structureId}</code>; the selected variant is{" "}
                  <code className="font-mono">{structure.id}</code>. The generator will refuse it. Rebuilding by name starts
                  over from the exact-name pass and drops your choices.
                  <div className="mt-1.5">
                    <Button size="xs" onClick={() => startMapping(sheet)}>
                      Rebuild by name for {structure.variantLabel ?? structure.variant ?? structure.id}
                    </Button>
                  </div>
                </Notice>
              ) : null}

              <table className="w-full border-collapse text-xs">
                <thead className="text-2xs uppercase tracking-wide text-ink-3">
                  <tr className="border-b border-line">
                    <th className="py-1 pr-2 text-left font-semibold">Column</th>
                    <th className="px-1 py-1 text-left font-semibold">Target position</th>
                    <th className="px-1 py-1 text-left font-semibold">via</th>
                    <th className="py-1 pl-1 text-left font-semibold">Confirmed</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.columns.map((c) => {
                    const entry = mapping.entries.find((e) => e.column === c.name);
                    return (
                      <MappingRow
                        key={c.name}
                        column={c.name}
                        entry={entry}
                        groups={candidateGroups}
                        knownLocators={candidates.map((k) => k.locator)}
                        onChoose={(locator) => setMapping((m) => (m ? setAnalystChoice(m, c.name, locator) : m))}
                        onConfirm={(confirmed) => setMapping((m) => (m ? confirmEntry(m, c.name, confirmed) : m))}
                      />
                    );
                  })}
                </tbody>
              </table>

              {mapping.notes.length ? (
                <div>
                  <h4 className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">Why some columns were left alone</h4>
                  <ul className="list-disc space-y-0.5 pl-4 text-2xs text-ink-2">
                    {mapping.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* ------------------------------------------------ the model */}
              <section
                aria-label="Model proposal"
                className={cx("rounded-sm border border-dashed border-line-strong p-2", roomy ? "space-y-2" : "space-y-1.5")}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge>Model</Badge>
                  <span className="text-2xs text-ink-2">Model opinion — not a structural verdict. Nothing here changes the findings.</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    size="xs"
                    onClick={ask}
                    disabled={!key || asking || !columnsToAsk.length || mappingIsStale}
                  >
                    {asking ? "Asking…" : "Ask the model to propose the rest"}
                  </Button>
                  {!key ? (
                    <span className="text-2xs text-ink-3">
                      Inert: no Anthropic API key is stored in this browser. Set one in the header to enable it; the name
                      matcher, the table above and the generator do not need it.
                    </span>
                  ) : !columnsToAsk.length ? (
                    <span className="text-2xs text-ink-3">Nothing left to propose: every column has a target.</span>
                  ) : (
                    <span className="text-2xs text-ink-3">
                      Sends only the {columnsToAsk.length} unmapped column name{columnsToAsk.length === 1 ? "" : "s"} and the{" "}
                      {candidates.length}-position candidate list to Anthropic — ≈{askPayload.tokens.toLocaleString()} tokens of
                      your data, plus the workbench&rsquo;s fixed instructions, which carry nothing from the sheet. No cell
                      values.
                    </span>
                  )}
                </div>
                {columnsToAsk.length ? (
                  <div>
                    <button
                      type="button"
                      className="font-mono text-2xs text-ink-3 hover:text-ink"
                      onClick={() => setPreviewOpen((v) => !v)}
                      aria-expanded={previewOpen}
                    >
                      {previewOpen ? "Hide what will be sent" : "Preview what will be sent"}
                    </button>
                    {previewOpen ? (
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-xs border border-line bg-inset p-2 font-mono text-2xs leading-4 text-ink-2">
                        {askPayload.text}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
                {askError ? <Notice label="The model call failed">{askError}</Notice> : null}
                {opinion ? (
                  <div className={cx("text-2xs text-ink-2", roomy && "leading-relaxed")}>
                    <p>
                      The model was shown {opinion.sentColumns} column name{opinion.sentColumns === 1 ? "" : "s"}. Its proposals
                      entered the table above as <span className="font-mono">model</span> entries, unconfirmed: tick one only
                      after checking it, or it will be skipped at generation. Its reasons, verbatim:
                    </p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {opinion.mappings.map((m, i) => (
                        <li key={i}>
                          <span className="font-mono text-ink">{m.column}</span>
                          {" → "}
                          <span className="font-mono text-ink">{m.locator ?? "nothing"}</span>
                          <span className="text-ink-3"> (model confidence {m.confidence})</span>
                          {m.why ? <> — {m.why}</> : null}
                        </li>
                      ))}
                      {opinion.unmapped.map((c) => (
                        <li key={`u-${c}`}>
                          <span className="font-mono text-ink">{c}</span> — the model found no defensible target.
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            </>
          )}
        </Panel>

        {/* ----------------------------------------------------- 3. generate */}
        <Panel step={3} title="Generate" className={roomy ? "min-w-[34rem]" : "min-w-[28rem]"} roomy={roomy} last>
          <div className="flex flex-wrap items-center gap-3 text-xs text-ink-2">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="ingest-template"
                checked={templateSource === "sample"}
                disabled={!samples.length}
                onChange={() => setTemplateChoice("sample")}
              />
              Official sample
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" name="ingest-template" checked={templateSource === "own"} onChange={() => setTemplateChoice("own")} />
              Paste my own template
            </label>
          </div>
          {!samples.length ? (
            <p className="text-2xs text-ink-3">
              No official sample is shipped for this use case, so a template has to be pasted: a message your HIS already sends
              is the usual choice.
            </p>
          ) : null}

          {templateSource === "sample" ? (
            <div className="space-y-1">
              {samples.length > 1 ? (
                <select
                  className="max-w-full rounded-xs border border-line bg-surface px-1 py-0.5 font-mono text-2xs text-ink"
                  value={selectedSample?.path ?? ""}
                  onChange={(e) => setSamplePath(e.target.value)}
                  aria-label="Official sample"
                >
                  {samples.map((s) => (
                    <option key={s.path} value={s.path}>
                      {s.fileName}
                      {s.variantTags.length ? ` · ${s.variantTags.join(", ")}` : ""}
                    </option>
                  ))}
                </select>
              ) : selectedSample ? (
                <div className="font-mono text-2xs text-ink-2">{selectedSample.fileName}</div>
              ) : null}
              {sampleError ? <Notice label="The sample could not be loaded">{sampleError}</Notice> : null}
              {sampleVariantMismatch ? (
                <Notice label="Sample and variant disagree">
                  This sample is tagged for{" "}
                  <code className="font-mono">{sampleVariantMismatch.variantLabel ?? sampleVariantMismatch.variant ?? sampleVariantMismatch.id}</code>, the
                  selected variant is <code className="font-mono">{structure.variantLabel ?? structure.variant ?? structure.id}</code>.
                  Pick the matching sample or switch the variant; filling this one would produce a message of the other type.
                </Notice>
              ) : null}
              {templateText ? (
                <p className="text-2xs text-ink-3">
                  Template loaded: {templateText.length.toLocaleString()} characters. Only positions this template already has can be
                  written; nothing is added or removed.
                </p>
              ) : !sampleError ? (
                <p className="text-2xs text-ink-3">Loading the sample…</p>
              ) : null}
            </div>
          ) : (
            <textarea
              className="h-28 w-full resize-y rounded-sm border border-line bg-surface p-2 font-mono text-2xs leading-4 text-ink outline-none placeholder:text-ink-3 focus:border-accent"
              placeholder={`Paste a ${ENCODING_LABEL[structure.encoding]} message to use as the template…`}
              value={ownTemplate}
              spellCheck={false}
              onChange={(e) => setOwnTemplate(e.target.value)}
            />
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <label className="flex items-center gap-1 text-2xs text-ink-2">
              Row
              <select
                className="max-w-64 rounded-xs border border-line bg-surface px-1 py-0.5 font-mono text-2xs text-ink"
                value={rows.length ? Math.min(rowIndex, rows.length - 1) : ""}
                disabled={!rows.length}
                onChange={(e) => setRowIndex(Number(e.target.value))}
                aria-label="Sheet row"
              >
                {rows.length ? (
                  rows.map((r, i) => (
                    <option key={i} value={i}>
                      {rowLabel(r, i, sheet)}
                    </option>
                  ))
                ) : (
                  <option value="">no rows</option>
                )}
              </select>
            </label>
            <Button size="xs" variant="primary" onClick={generate} disabled={!canGenerate}>
              {generating ? "Generating…" : "Generate from this row"}
            </Button>
          </div>
          <p className={cx("text-2xs text-ink-3", roomy && "leading-relaxed")}>
            An empty cell is written as an empty value on purpose: the message then shows what the extract actually holds, and
            the checker reports the truth about it rather than a placeholder hiding it. Unconfirmed entries are skipped, not
            written.
          </p>

          {generateError ? <Notice label="Could not generate">{generateError}</Notice> : null}

          {generated ? (
            <GeneratedOutput
              result={generated.result}
              rowNumber={generated.row + 1}
              roomy={roomy}
              onOpenInCheck={() => onOpenInCheck(generated.result.text)}
            />
          ) : null}
        </Panel>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Panel({
  step,
  title,
  className,
  roomy,
  last,
  children,
}: {
  step: number;
  title: string;
  className?: string;
  roomy: boolean;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={cx("flex min-h-0 flex-1 flex-col", !last && "border-r border-line", className)}
    >
      <header className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line bg-surface px-2.5">
        <span
          aria-hidden="true"
          className="inline-flex h-4 w-4 items-center justify-center rounded-xs border border-line font-mono text-2xs text-ink-2"
        >
          {step}
        </span>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">{title}</h3>
      </header>
      <div className={cx("min-h-0 flex-1 overflow-auto p-2.5", roomy ? "space-y-3" : "space-y-2")}>{children}</div>
    </section>
  );
}

/** A statement that something did not happen and why. Ink only: it is not a verdict. */
function Notice({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-sm border border-line-strong bg-inset px-2 py-1.5 text-2xs leading-4 text-ink-2">
      <strong className="font-semibold text-ink">{label}.</strong> {children}
    </div>
  );
}

function DropZone({
  onFile,
  reading,
  roomy,
}: {
  onFile: (file: File | undefined) => void;
  reading: "idle" | "csv" | "workbook";
  roomy: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={cx(
        "flex flex-col items-center justify-center gap-1.5 rounded-sm border border-dashed text-center",
        roomy ? "px-4 py-6" : "px-3 py-4",
        over ? "border-accent bg-sel" : "border-line-strong bg-surface",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFile(e.dataTransfer.files[0]);
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls,.ods,.csv,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <span className="text-xs text-ink-2">Drop a HIS extract here</span>
      <span className="font-mono text-2xs text-ink-3">.xlsx · .xls · .ods · .csv</span>
      <Button size="xs" onClick={() => fileRef.current?.click()} disabled={reading !== "idle"}>
        {reading === "workbook" ? "Loading the spreadsheet library…" : reading === "csv" ? "Reading…" : "Choose a file…"}
      </Button>
    </div>
  );
}

interface CandidateGroup {
  obligation: Obligation;
  items: { locator: string; label: string; usage: string }[];
}

/**
 * The picker's groups. `mappingCandidates` already drops forbidden positions; the obligation
 * of each remaining locator comes from the first profile row that carries it, which is also
 * the row the exact-name pass matched against.
 */
function groupCandidates(candidates: ReturnType<typeof mappingCandidates>, profile: Profile | null): CandidateGroup[] {
  if (!profile) return [];
  const obligationOf = new Map<string, Obligation>();
  for (const r of profile.rows) if (r.locator && !obligationOf.has(r.locator)) obligationOf.set(r.locator, r.obligation);
  return CANDIDATE_GROUPS.map((obligation) => ({
    obligation,
    items: candidates.filter((c) => (obligationOf.get(c.locator) ?? "unstated") === obligation),
  })).filter((g) => g.items.length);
}

function MappingRow({
  column,
  entry,
  groups,
  knownLocators,
  onChoose,
  onConfirm,
}: {
  column: string;
  entry: MappingEntry | undefined;
  groups: CandidateGroup[];
  knownLocators: string[];
  onChoose: (locator: string | null) => void;
  onConfirm: (confirmed: boolean) => void;
}) {
  const custom = Boolean(entry && !knownLocators.includes(entry.locator));
  const [editingCustom, setEditingCustom] = useState(false);
  const [draft, setDraft] = useState(entry && custom ? entry.locator : "");
  const showInput = editingCustom || custom;
  const selectValue = showInput ? CUSTOM : (entry?.locator ?? "");

  const commit = () => {
    const v = draft.trim();
    if (v) onChoose(v);
    setEditingCustom(false);
  };

  return (
    <tr className="border-b border-line/60 align-top">
      <td className="py-1 pr-2 font-mono text-ink">{column}</td>
      <td className="px-1 py-1">
        <select
          className="max-w-56 rounded-xs border border-line bg-surface px-1 py-0.5 font-mono text-2xs text-ink"
          value={selectValue}
          aria-label={`Target position for ${column}`}
          onChange={(e) => {
            const v = e.target.value;
            if (v === CUSTOM) {
              setEditingCustom(true);
              return;
            }
            setEditingCustom(false);
            onChoose(v === "" ? null : v);
          }}
        >
          <option value="">— unmapped —</option>
          {groups.map((g) => (
            <optgroup key={g.obligation} label={OBLIGATION_LABEL[g.obligation]}>
              {g.items.map((c) => (
                <option key={c.locator} value={c.locator}>
                  {c.locator} — {c.label} [{c.usage}]
                </option>
              ))}
            </optgroup>
          ))}
          <option value={CUSTOM}>Other position (e.g. a component such as PID-3.1)…</option>
        </select>
        {showInput ? (
          <input
            className="mt-1 w-40 rounded-xs border border-line bg-surface px-1 py-0.5 font-mono text-2xs text-ink outline-none focus:border-accent"
            value={draft}
            placeholder="PID-3.1"
            aria-label={`Custom position for ${column}`}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
          />
        ) : null}
      </td>
      <td className="px-1 py-1">{entry ? <Badge mono>{entry.via}</Badge> : <span className="text-ink-3">—</span>}</td>
      <td className="py-1 pl-1">
        {entry ? (
          <label className="flex items-center gap-1 text-2xs text-ink-2">
            <input type="checkbox" checked={entry.confirmed} onChange={(e) => onConfirm(e.target.checked)} />
            {entry.confirmed ? "yes" : "no"}
          </label>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </td>
    </tr>
  );
}

function GeneratedOutput({
  result,
  rowNumber,
  roomy,
  onOpenInCheck,
}: {
  result: GenerateResult;
  rowNumber: number;
  roomy: boolean;
  onOpenInCheck: () => void;
}) {
  return (
    <div className={roomy ? "space-y-2.5" : "space-y-2"}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-ink">Generated from row {rowNumber}</span>
        <Badge mono>{result.applied.length} written</Badge>
        <Badge mono>{result.skipped.length} skipped</Badge>
        <span className="ml-auto flex items-center gap-1.5">
          <CopyButton size="xs" value={result.text} what="the generated message" />
          <Button size="xs" variant="primary" onClick={onOpenInCheck}>
            Check this message
          </Button>
        </span>
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-line bg-surface p-2 font-mono text-2xs leading-4 text-ink">
        {result.text}
      </pre>
      {result.applied.length ? (
        <p className="text-2xs text-ink-2">
          Written and verified present after re-parsing:{" "}
          {result.applied.map((l, i) => (
            <span key={l}>
              {i ? ", " : ""}
              <code className="font-mono text-ink">{l}</code>
            </span>
          ))}
          .
        </p>
      ) : (
        <p className="text-2xs text-ink-2">Nothing was written; the template came back unchanged.</p>
      )}
      {result.skipped.length ? (
        <div>
          <h4 className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">Not written, and why</h4>
          <ul className="space-y-1 text-2xs text-ink-2">
            {result.skipped.map((s, i) => (
              <li key={i}>
                <code className="font-mono text-ink">{s.locator}</code>
                <span className="text-ink-3"> ← "{s.column}": </span>
                {s.why}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-2xs text-ink-3">
        Nothing here is a verdict. Check judges the message against the compiled rules and shows its evidence.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The data a mapping request carries, laid out as the request lists it: one line of column
 * names and one candidate per line. The surrounding instruction text is fixed and carries
 * nothing from the sheet, so the preview shows the part that is the analyst's to release.
 */
function mappingRequestData(columns: readonly string[], candidates: readonly { locator: string; label: string; usage: string }[]) {
  const text = [
    `Columns: ${columns.join(", ")}`,
    "",
    "Candidates:",
    ...candidates.map((c) => `  ${c.locator} — ${c.label} [${c.usage}]`),
  ].join("\n");
  return { text, tokens: estimateTokens(text) };
}

function truncate(v: string): string {
  return v.length > 24 ? `${v.slice(0, 24)}…` : v;
}

function rowLabel(row: Record<string, string>, index: number, sheet: Sheet | null): string {
  const cells = (sheet?.columns ?? [])
    .map((c) => row[c.name])
    .filter((v) => v && v.trim())
    .slice(0, 2)
    .map(truncate);
  return `Row ${index + 1}${cells.length ? ` — ${cells.join(" · ")}` : " — (all cells empty)"}`;
}
