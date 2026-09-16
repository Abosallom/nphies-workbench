import { useCallback, useMemo, useState } from "react";
import { Badge, Button, CopyButton, useApiKey, type DensityChoice } from "../ui";
import type { Finding as EngineFinding } from "../lib/check";
import type { MessageStructure } from "../lib/structure";
import type { Skeleton } from "../lib/skeleton";
import type { Gap } from "../lib/gaps";
import type { Advisory } from "../lib/advisory";
import {
  describeAiError,
  payloadParts,
  proposeGapResolutions,
  redactFinding,
  reviewFindings,
  type AiUsage,
  type GapInput,
  type GapOutcome,
  type PayloadParts,
  type ReviewInput,
  type ReviewOutcome,
  type RuleStub,
} from "../lib/ai";

/* ========================================================================== *
 * AdvisoryPanel — where a model may speak, and the one place it may.
 *
 * It sits BELOW the split view, closed until the analyst opens it, and everything in it is
 * an {@link Advisory}: a type with no severity, no code and no provenance, which cannot be
 * put into the findings list even by mistake. So the panel draws no severity glyph and no
 * severity colour anywhere — a "doubt" is a word in plain ink, and the finding it doubts is
 * rendered upstairs exactly as before. The only thing a click here can change is the
 * checker's INPUT (a declared condition), after which the checker re-runs and decides for
 * itself.
 *
 * Before either call, the button states the payload size and the exact text is one click
 * away: the skeleton is redacted by construction, but the analyst should not have to take
 * that on trust.
 * ========================================================================== */

/** Everything both calls are built from. Assembled once per check by the host. */
export interface AdvisoryInput {
  readonly structure: MessageStructure;
  /** The engine findings the review is about (the host decides which severities go). */
  readonly findings: readonly EngineFinding[];
  /** How many findings the host held back, so the copy can say so. */
  readonly withheld: number;
  readonly skeleton: Skeleton;
  readonly rules: readonly RuleStub[];
  readonly gaps: readonly Gap[];
}

export interface DeclaredConditions {
  readonly conditions: readonly string[];
  /** Where the click came from. Today only the panel offers one, but the note must stay honest if that changes. */
  readonly via: "advisory";
}

export interface AdvisoryPanelProps {
  /** `null` until a check has completed; the panel then says why it is inert. */
  input: AdvisoryInput | null;
  /** Owned by the host so a footer link upstairs can open the panel. */
  open: boolean;
  onToggle: () => void;
  review: ReviewOutcome | null;
  onReview: (outcome: ReviewOutcome) => void;
  gaps: GapOutcome | null;
  onGaps: (outcome: GapOutcome) => void;
  /** Select a finding in the split view. The host ignores ids with no region to reveal. */
  onSelectFinding?: (findingId: string) => void;
  /** The analyst declares a condition: the host calls `run({ conditions: [c] })`. */
  onRecheck: (condition: string) => void;
  /** What the verdict on screen was checked under, for the note beside the re-check buttons. */
  declared: DeclaredConditions | null;
  density?: DensityChoice;
}

/**
 * Anthropic list price for `claude-opus-5` input, USD per million tokens (checked 2026-06).
 * A rough figure is all the button needs; the reply is billed on top and is not estimated.
 */
const INPUT_USD_PER_MTOK = 5;

function roughCost(tokens: number): string {
  const usd = (tokens / 1_000_000) * INPUT_USD_PER_MTOK;
  return usd < 0.01 ? "under $0.01" : `about $${usd.toFixed(2)}`;
}

const CONFIDENCE_WORD: Record<Advisory["modelConfidence"], string> = {
  high: "high",
  medium: "medium",
  low: "low",
};

const VERDICT_WORD: Record<NonNullable<Advisory["verdict"]>, string> = {
  agree: "agrees",
  doubt: "doubts",
  "cannot-tell": "cannot tell",
};

/** `sha256:ab12…` -> `ab12cd34ef56`, enough to tell two checks apart by eye. */
function shortDigest(digest: string): string {
  return digest.replace(/^[a-z0-9]+:/, "").slice(0, 12);
}

export const DISCLAIMER = "Model opinion — not a structural verdict. Nothing here changes the findings.";

export function AdvisoryPanel({
  input,
  open,
  onToggle,
  review,
  onReview,
  gaps,
  onGaps,
  onSelectFinding,
  onRecheck,
  declared,
  density = "dense",
}: AdvisoryPanelProps) {
  const { key } = useApiKey();
  const roomy = density === "roomy";

  const reviewInput = useMemo<ReviewInput | null>(
    () =>
      input
        ? {
            structure: input.structure,
            findings: input.findings.map(redactFinding),
            skeleton: input.skeleton,
            rules: input.rules,
          }
        : null,
    [input],
  );
  const gapInput = useMemo<GapInput | null>(
    () => (input && input.gaps.length ? { structure: input.structure, gaps: input.gaps, skeleton: input.skeleton, rules: input.rules } : null),
    [input],
  );
  const reviewParts = useMemo(() => (reviewInput ? payloadParts(reviewInput) : null), [reviewInput]);
  const gapParts = useMemo(() => (gapInput ? payloadParts(gapInput) : null), [gapInput]);

  const findingsById = useMemo(() => new Map((input?.findings ?? []).map((f) => [f.id, f])), [input]);

  /* A result about a different payload than the one on screen is stale, and says so rather
   * than being hidden: the analyst may still want to read what was said about the last check. */
  const reviewStale = review !== null && reviewParts !== null && review.payload.text !== reviewParts.text;
  const gapsStale = gaps !== null && gapParts !== null && gaps.payload.text !== gapParts.text;

  const doubtCount = review?.advisories.filter((a) => a.verdict === "doubt").length ?? 0;
  const summary = !input
    ? "after a check"
    : [
        review ? `${review.advisories.length} claims${doubtCount ? `, ${doubtCount} doubted` : ""}` : null,
        `${input.gaps.length} open ${input.gaps.length === 1 ? "question" : "questions"}`,
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <section
      className="shrink-0 border-t border-dashed border-line-strong bg-surface"
      data-advisory-panel
      aria-label="Model advisory"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex w-full items-center gap-2 px-3 text-left hover:bg-inset ${roomy ? "py-2" : "py-1"}`}
      >
        <span aria-hidden="true" className="font-mono text-2xs text-ink-3">
          {open ? "▾" : "▸"}
        </span>
        <Badge mono>Model</Badge>
        <span className="text-xs font-medium text-ink">Second opinion and open questions</span>
        <span className="text-2xs text-ink-3">{summary}</span>
        <span className="ml-auto text-2xs text-ink-3">{DISCLAIMER}</span>
      </button>

      {open ? (
        <div className={`overflow-auto border-t border-line px-3 ${roomy ? "max-h-[55vh] space-y-4 py-3" : "max-h-[40vh] space-y-3 py-2"}`}>
          <p className="text-2xs text-ink-2">
            {DISCLAIMER} Every claim below was checked against what was actually sent — a quote
            that is not verbatim, a rule id that was not in the list, or a line the skeleton does
            not show is discarded and counted, never shown as fact.
          </p>

          {!key ? (
            <p className="rounded-sm border border-line bg-inset px-2 py-1 text-2xs text-ink-2">
              No Anthropic API key is set in the header, so the two buttons below are inert. The
              questions, the closed option lists and the payload previews work without one — nothing
              is sent until you add a key and click.
            </p>
          ) : null}

          {!input ? (
            <p className="text-2xs text-ink-3">Run a check first. The panel is about a completed check and nothing else.</p>
          ) : (
            <>
              <SecondOpinion
                input={input}
                reviewInput={reviewInput as ReviewInput}
                parts={reviewParts as PayloadParts}
                apiKey={key}
                review={review}
                stale={reviewStale}
                onReview={onReview}
                findingsById={findingsById}
                onSelectFinding={onSelectFinding}
                roomy={roomy}
              />
              <OpenQuestions
                input={input}
                gapInput={gapInput}
                parts={gapParts}
                apiKey={key}
                outcome={gaps}
                stale={gapsStale}
                onGaps={onGaps}
                findingsById={findingsById}
                onRecheck={onRecheck}
                onSelectFinding={onSelectFinding}
                declared={declared}
                roomy={roomy}
              />
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

/* ========================================================================== *
 * Shared bits
 * ========================================================================== */

/** The button that states its price, and the toggle that shows the exact text. */
function SendControls({
  label,
  busy,
  disabled,
  parts,
  onRun,
  note,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  parts: PayloadParts;
  onRun: () => void;
  note: string;
}) {
  const [previewing, setPreviewing] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="xs" onClick={onRun} disabled={disabled || busy}>
          {busy ? "Asking…" : label}
        </Button>
        <span className="text-2xs text-ink-3">
          sends ~{parts.estimatedTokens.toLocaleString()} tokens ({roughCost(parts.estimatedTokens)} of input at list price; the reply is billed on top) — {note}
        </span>
        <button
          type="button"
          className="text-2xs text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink"
          onClick={() => setPreviewing((p) => !p)}
          aria-expanded={previewing}
        >
          {previewing ? "Hide preview" : "Preview what will be sent"}
        </button>
      </div>
      {previewing ? (
        <pre
          className="max-h-64 overflow-auto rounded-sm border border-line bg-inset p-2 font-mono text-2xs leading-4 whitespace-pre-wrap text-ink-2"
          aria-label="Exact text that will be sent"
        >
          {parts.text}
        </pre>
      ) : null}
    </div>
  );
}

function Quotes({ quotes }: { quotes: readonly string[] }) {
  if (!quotes.length) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {quotes.map((q, i) => (
        <li key={i} className="border-l-2 border-line-strong pl-2 font-mono text-2xs whitespace-pre-wrap text-ink-2">
          {q}
        </li>
      ))}
    </ul>
  );
}

function AboutFinding({
  findingId,
  findingsById,
  onSelectFinding,
}: {
  findingId: string | undefined;
  findingsById: ReadonlyMap<string, EngineFinding>;
  onSelectFinding?: (id: string) => void;
}) {
  if (!findingId) return null;
  const f = findingsById.get(findingId);
  const label = f ? f.title : findingId;
  return (
    <div className="mt-1 text-2xs text-ink-3">
      about finding{" "}
      {onSelectFinding && f?.location ? (
        <button
          type="button"
          className="text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink"
          onClick={() => onSelectFinding(findingId)}
        >
          {label}
        </button>
      ) : (
        <span className="text-ink-2">{label}</span>
      )}
      {f?.location ? <span className="font-mono"> · L{f.location.line}</span> : null}
    </div>
  );
}

function ResultFooter({ model, usage, digest, stale }: { model: string; usage: AiUsage; digest: string; stale: boolean }) {
  return (
    <p className="mt-2 flex flex-wrap gap-x-3 font-mono text-2xs text-ink-3" data-advisory-footer>
      <span>{model}</span>
      <span>
        in {usage.inputTokens.toLocaleString()} · out {usage.outputTokens.toLocaleString()}
        {usage.cacheReadTokens ? ` · cached ${usage.cacheReadTokens.toLocaleString()}` : ""}
        {usage.cacheWriteTokens ? ` · cache write ${usage.cacheWriteTokens.toLocaleString()}` : ""}
      </span>
      <span>about the check as of {shortDigest(digest)}</span>
      {stale ? <span className="text-ink-2">stale — the check has changed since; ask again</span> : null}
    </p>
  );
}

/* ========================================================================== *
 * a. Second opinion
 * ========================================================================== */

function SecondOpinion({
  input,
  reviewInput,
  parts,
  apiKey,
  review,
  stale,
  onReview,
  findingsById,
  onSelectFinding,
  roomy,
}: {
  input: AdvisoryInput;
  reviewInput: ReviewInput;
  parts: PayloadParts;
  apiKey: string;
  review: ReviewOutcome | null;
  stale: boolean;
  onReview: (o: ReviewOutcome) => void;
  findingsById: ReadonlyMap<string, EngineFinding>;
  onSelectFinding?: (id: string) => void;
  roomy: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      onReview(await reviewFindings(apiKey, reviewInput));
    } catch (err) {
      setError(describeAiError(err));
    } finally {
      setBusy(false);
    }
  }, [apiKey, reviewInput, onReview]);

  const reviews = review?.advisories.filter((a) => a.about.findingId !== undefined) ?? [];
  const additional = review?.advisories.filter((a) => a.about.findingId === undefined) ?? [];

  return (
    <div data-advisory-section="second-opinion">
      <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-3">Second opinion</h3>
      <SendControls
        label={review ? "Ask again" : "Ask for a second opinion"}
        busy={busy}
        disabled={!apiKey}
        parts={parts}
        onRun={run}
        note={`${input.findings.length} redacted ${input.findings.length === 1 ? "finding" : "findings"}${input.withheld ? ` (${input.withheld} positive ones held back)` : ""}, the redacted skeleton and the rule list; never the message`}
      />
      {error ? <p className="mt-1 text-2xs text-ink-2">Not answered: {error}</p> : null}

      {review ? (
        <div className={roomy ? "mt-3 space-y-3" : "mt-2 space-y-2"}>
          <p className="text-2xs text-ink-3">
            {review.advisories.length} verified {review.advisories.length === 1 ? "claim" : "claims"}
            {review.dropped.length ? ` · ${review.dropped.length} unverifiable ${review.dropped.length === 1 ? "claim" : "claims"} discarded` : " · 0 unverifiable claims discarded"}
            {review.notReviewed.length ? ` · ${review.notReviewed.length} not reviewed` : ""}
          </p>
          {reviews.map((a) => (
            <AdvisoryCard key={a.id} advisory={a} findingsById={findingsById} onSelectFinding={onSelectFinding} />
          ))}
          {additional.length ? (
            <>
              <p className="text-2xs text-ink-3">Additional observations the model offers — not findings, and not counted anywhere:</p>
              {additional.map((a) => (
                <AdvisoryCard key={a.id} advisory={a} findingsById={findingsById} onSelectFinding={onSelectFinding} />
              ))}
            </>
          ) : null}
          {review.notReviewed.length ? (
            <p className="text-2xs text-ink-3">
              Not assessed by the model: {review.notReviewed.map((id) => findingsById.get(id)?.title ?? id).join("; ")}
            </p>
          ) : null}
          <ResultFooter model={review.model} usage={review.usage} digest={review.digest} stale={stale} />
        </div>
      ) : null}
    </div>
  );
}

function AdvisoryCard({
  advisory: a,
  findingsById,
  onSelectFinding,
}: {
  advisory: Advisory;
  findingsById: ReadonlyMap<string, EngineFinding>;
  onSelectFinding?: (id: string) => void;
}) {
  const head = a.verdict ? `Model ${VERDICT_WORD[a.verdict]}` : "Model observes";
  return (
    <article className="rounded-sm border border-dashed border-line-strong bg-raised p-2 text-xs" data-advisory-card data-verdict={a.verdict ?? "observation"}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-ink">{head}</span>
        <span className="text-2xs text-ink-3">model confidence: {CONFIDENCE_WORD[a.modelConfidence]}</span>
        {a.about.line !== null && a.about.line !== undefined ? <span className="font-mono text-2xs text-ink-3">L{a.about.line}</span> : null}
      </div>
      <p className="mt-0.5 text-ink">{a.claim}</p>
      {a.reasoning && a.reasoning !== a.claim ? <p className="mt-0.5 text-ink-2">{a.reasoning}</p> : null}
      <Quotes quotes={a.quotes} />
      {a.ruleIds.length ? <p className="mt-1 font-mono text-2xs text-ink-3">rests on {a.ruleIds.join(", ")}</p> : null}
      <AboutFinding findingId={a.about.findingId} findingsById={findingsById} onSelectFinding={onSelectFinding} />
    </article>
  );
}

/* ========================================================================== *
 * b. Questions the checker could not answer
 * ========================================================================== */

function optionLabel(o: Gap["options"][number]): string {
  switch (o.type) {
    case "declare-condition":
      return `${o.condition} (${o.usage ?? "?"} ${o.cardinality})`;
    case "rule":
      return o.label;
    case "copy-code":
      return o.display ? `${o.code} — ${o.display}` : o.code;
  }
}

function OpenQuestions({
  input,
  gapInput,
  parts,
  apiKey,
  outcome,
  stale,
  onGaps,
  findingsById,
  onRecheck,
  onSelectFinding,
  declared,
  roomy,
}: {
  input: AdvisoryInput;
  gapInput: GapInput | null;
  parts: PayloadParts | null;
  apiKey: string;
  outcome: GapOutcome | null;
  stale: boolean;
  onGaps: (o: GapOutcome) => void;
  findingsById: ReadonlyMap<string, EngineFinding>;
  onRecheck: (condition: string) => void;
  onSelectFinding?: (id: string) => void;
  declared: DeclaredConditions | null;
  roomy: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!gapInput) return;
    setBusy(true);
    setError(null);
    try {
      onGaps(await proposeGapResolutions(apiKey, gapInput));
    } catch (err) {
      setError(describeAiError(err));
    } finally {
      setBusy(false);
    }
  }, [apiKey, gapInput, onGaps]);

  const byGap = useMemo(() => {
    const m = new Map<string, Advisory[]>();
    for (const a of outcome?.advisories ?? []) {
      const id = a.about.gapId ?? "";
      const list = m.get(id) ?? [];
      list.push(a);
      m.set(id, list);
    }
    return m;
  }, [outcome]);

  return (
    <div data-advisory-section="open-questions">
      <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-3">
        Questions the checker could not answer ({input.gaps.length})
      </h3>
      {!input.gaps.length ? (
        <p className="text-2xs text-ink-3">None. Every rule the checker applied was settled by the message and the spec.</p>
      ) : (
        <>
          <p className="mb-1 text-2xs text-ink-2">
            Each question comes with the closed list of answers the spec admits. A model may propose one;
            only your click declares it, and the checker then re-runs and decides for itself.
          </p>
          {parts && gapInput ? (
            <SendControls
              label={outcome ? "Ask again" : "Ask which answer the skeleton supports"}
              busy={busy}
              disabled={!apiKey}
              parts={parts}
              onRun={run}
              note="the questions, their closed option lists, the redacted skeleton and the rule list; never the message"
            />
          ) : null}
          {error ? <p className="mt-1 text-2xs text-ink-2">Not answered: {error}</p> : null}
          {declared ? (
            <p className="mt-1 text-2xs text-ink-2" data-declared-note>
              Checked as {declared.conditions.join(", ")} — condition declared by analyst, suggested by model.
            </p>
          ) : null}

          <ul className={roomy ? "mt-3 space-y-3" : "mt-2 space-y-2"}>
            {input.gaps.map((g) => (
              <li key={g.id} className="rounded-sm border border-line bg-raised p-2 text-xs" data-gap>
                <p className="text-ink">{g.question}</p>
                <p className="mt-0.5 text-2xs text-ink-3">
                  <span className="font-mono">{g.path}</span>
                  {g.line !== null ? <span className="font-mono"> · L{g.line}</span> : null}
                  {" · "}
                  {g.options.length ? `chosen from: ${g.options.map(optionLabel).join(" · ")}` : "no listed answers — reasoning only"}
                </p>
                {(byGap.get(g.id) ?? []).map((a) => (
                  <Proposal key={a.id} advisory={a} gap={g} findingsById={findingsById} onRecheck={onRecheck} onSelectFinding={onSelectFinding} />
                ))}
              </li>
            ))}
          </ul>

          {outcome ? (
            <div className="mt-2">
              <p className="text-2xs text-ink-3">
                {outcome.advisories.length} verified {outcome.advisories.length === 1 ? "proposal" : "proposals"} ·{" "}
                {outcome.dropped.length} unverifiable {outcome.dropped.length === 1 ? "claim" : "claims"} discarded
                {outcome.unresolved.length ? ` · ${outcome.unresolved.length} left unresolved by the model` : ""}
              </p>
              <ResultFooter model={outcome.model} usage={outcome.usage} digest={outcome.digest} stale={stale} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * One proposal, with ONE action whose label is its deterministic consequence. "Re-check as
 * Report" runs the checker with that condition declared — the model never sets it, the
 * click does. "Copy code" copies; a rule suggestion is text.
 */
function Proposal({
  advisory: a,
  gap,
  findingsById,
  onRecheck,
  onSelectFinding,
}: {
  advisory: Advisory;
  gap: Gap;
  findingsById: ReadonlyMap<string, EngineFinding>;
  onRecheck: (condition: string) => void;
  onSelectFinding?: (id: string) => void;
}) {
  const rule = a.ruleIds[0] ? gap.options.find((o) => o.type === "rule" && o.ruleId === a.ruleIds[0]) : undefined;
  const action = a.action;
  return (
    <div className="mt-1.5 rounded-sm border border-dashed border-line-strong bg-surface p-2" data-advisory-card>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <Badge mono>Model</Badge>
        <span className="text-2xs text-ink-3">model confidence: {CONFIDENCE_WORD[a.modelConfidence]}</span>
      </div>
      <p className="mt-0.5 text-ink">{a.reasoning || a.claim}</p>
      <Quotes quotes={a.quotes} />
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {action?.type === "declare-condition" ? (
          <Button size="xs" onClick={() => onRecheck(action.condition)}>
            Re-check as {action.condition}
          </Button>
        ) : action?.type === "copy-code" ? (
          <CopyButton size="xs" variant="default" value={action.code} label={`Copy code ${action.code}`} copiedLabel="Copied" what={`code ${action.code}`} />
        ) : rule && rule.type === "rule" ? (
          <span className="text-2xs text-ink-2">
            Suggests it belongs to <span className="font-mono">{rule.ruleId}</span> ({rule.label}) — nothing to apply; correct the HIS output if so.
          </span>
        ) : (
          <span className="text-2xs text-ink-3">No listed answer chosen.</span>
        )}
      </div>
      <AboutFinding findingId={a.about.findingId} findingsById={findingsById} onSelectFinding={onSelectFinding} />
    </div>
  );
}
