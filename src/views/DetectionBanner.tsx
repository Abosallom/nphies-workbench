import { Button } from "../ui";
import type { MessageStructure } from "../lib/structure";
import type { DetectCandidate, DetectEvidence, DetectGrade, DetectResult } from "../lib/detect";

/* ========================================================================== *
 * DetectionBanner — what the message says it is, next to what the analyst picked.
 *
 * The rail asks for one of 55 structures by hand, and checking an A03 against the A01 rules
 * prints a page of plausible, confidently wrong findings. The detector reads the message's
 * own fingerprint; this banner puts that reading beside the selection and lets the ANALYST
 * act on it. Nothing here switches anything on its own: a wrong automatic switch would be
 * the same confidently wrong verdict, arrived at faster.
 * ========================================================================== */

export interface DetectionBannerProps {
  result: DetectResult;
  currentUseCaseId: string;
  currentStructureId: string;
  /** The current use case's structures, so a sibling candidate can be named the way the variant picker names it. */
  structures: readonly MessageStructure[];
  /** Collapsed to one muted line after [Keep]. Owned by the host, keyed to the text it was kept for. */
  kept: boolean;
  onKeep: () => void;
  onShow: () => void;
  onSwitchStructure: (structureId: string) => void;
  /** Absent when the host cannot cross use cases; the candidate is then named but not actionable. */
  onSwitchUseCase?: (useCaseId: string, structureId: string | null) => void;
}

/** Grades are words. A percentage would claim a precision the detector does not have. */
const GRADE_WORD: Record<DetectGrade, string> = {
  certain: "certain",
  probable: "probable",
  possible: "possible",
};

/** "MSH-9 Message Type vs envelope.hl7v2Message.messageType" -> "MSH-9 Message Type". */
function fieldName(e: DetectEvidence): string {
  const i = e.field.indexOf(" vs ");
  return i > 0 ? e.field.slice(0, i) : e.field;
}

/**
 * The sample-derived caveat is spelled out on the evidence itself, not folded into the grade:
 * an analyst who sees "probable" needs to know WHY it is not certain, and "an official sample
 * says so, the published page does not" is a fact about the spec they can act on.
 */
function basisNote(e: DetectEvidence): string | null {
  switch (e.basis) {
    case "sample":
      return "sample-derived — stated only by an official sample, not in the published spec";
    case "standard":
      return "from the base standard, not an NPHIES page";
    default:
      return null;
  }
}

function EvidenceLine({ e }: { e: DetectEvidence }) {
  const note = basisNote(e);
  return (
    <span className="block">
      <span className="text-ink-2">{fieldName(e)}</span> reads{" "}
      <code className="rounded-xs bg-inset px-1 font-mono text-ink">{e.fragment}</code> at line{" "}
      {e.line}
      {e.expected !== e.fragment ? (
        <>
          {" "}
          — expected <code className="font-mono text-ink-2">{e.expected}</code>
        </>
      ) : null}
      {note ? <span className="text-ink-3"> ({note})</span> : null}
    </span>
  );
}

/**
 * The short wire name ("A03", "ACK-positive"), the way the message itself says it, so the
 * banner reads "reads ADT^A03 … you have A01 selected" and a button says "Switch to A03". The
 * prose label ("Discharge/end visit") is shown beside it where there is room.
 */
function labelFor(c: Pick<DetectCandidate, "structureId" | "variant" | "title">, structures: readonly MessageStructure[]): string {
  const s = structures.find((x) => x.id === c.structureId);
  if (s) return s.variant ?? s.variantLabel ?? s.title;
  return c.variant ?? c.title;
}

/** Use case first for a candidate outside the current one: two ACK sharers are both "ACK-positive". */
function qualifiedLabel(c: DetectCandidate, currentUseCaseId: string, structures: readonly MessageStructure[]): string {
  const label = labelFor(c, structures);
  return c.useCaseId === currentUseCaseId ? label : `${c.useCaseId} · ${label}`;
}

function primaryEvidence(c: DetectCandidate): DetectEvidence | undefined {
  return c.evidence[0];
}

export function DetectionBanner({
  result,
  currentUseCaseId,
  currentStructureId,
  structures,
  kept,
  onKeep,
  onShow,
  onSwitchStructure,
  onSwitchUseCase,
}: DetectionBannerProps) {
  const top = result.candidates[0];

  /* ------------------------------------------------------------- nothing -- */
  if (!top) {
    return (
      <Strip tone="muted" role="status">
        <span className="font-medium text-ink-2">Not identified.</span> {result.reason}
      </Strip>
    );
  }

  const matches = (c: DetectCandidate) =>
    c.useCaseId === currentUseCaseId && c.structureId === currentStructureId;

  const currentLabel = labelFor({ structureId: currentStructureId, variant: null, title: currentStructureId }, structures);

  /* ------------------------------------------------------------ matches -- */
  if (result.outcome === "identified" && matches(top)) {
    const e = primaryEvidence(top);
    return (
      <Strip tone="muted" role="status">
        Detected{" "}
        <code className="rounded-xs bg-inset px-1 font-mono text-ink">{e?.fragment ?? top.structureId}</code>
        {e ? ` from ${fieldName(e)} at line ${e.line}` : ""} — matches your selection
        <span className="text-ink-3"> ({GRADE_WORD[top.grade]})</span>
        {e && basisNote(e) ? <span className="text-ink-3"> · {basisNote(e)}</span> : null}
      </Strip>
    );
  }

  /* ------------------------------------------------------------- kept ---- */
  if (kept) {
    const e = primaryEvidence(top);
    return (
      <Strip tone="muted" role="status">
        Kept {currentLabel}.{" "}
        {result.outcome === "ambiguous"
          ? `The detector listed ${result.candidates.length} candidates it could not separate`
          : `The message reads ${e?.fragment ?? top.structureId}, which is ${qualifiedLabel(top, currentUseCaseId, structures)}`}
        .{" "}
        <button type="button" onClick={onShow} className="underline decoration-dotted hover:text-ink">
          show
        </button>
      </Strip>
    );
  }

  const actFor = (c: DetectCandidate) => {
    if (c.useCaseId === currentUseCaseId) return () => onSwitchStructure(c.structureId);
    if (onSwitchUseCase) return () => onSwitchUseCase(c.useCaseId, c.structureId);
    return null;
  };

  /* ------------------------------------------------------------- a tie ---- */
  if (result.outcome === "ambiguous") {
    return (
      <Strip tone="attention" role="status">
        <div className="font-medium">
          The message could be {result.candidates.length} compiled structures — the detector could not
          separate them; you pick.
        </div>
        <ul className="mt-1 flex flex-col gap-1">
          {result.candidates.map((c) => {
            const act = actFor(c);
            const isCurrent = matches(c);
            return (
              <li key={c.structureId} className="flex flex-wrap items-start gap-x-2 gap-y-0.5">
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-ink">
                    {qualifiedLabel(c, currentUseCaseId, structures)}
                    <span className="font-normal text-ink-3"> — {c.title}</span>
                    {isCurrent ? <span className="font-normal text-ink-3"> · your selection</span> : null}
                  </span>
                  <span className="text-ink-3"> — {GRADE_WORD[c.grade]}</span>
                  {c.evidence.map((e, i) => (
                    <EvidenceLine key={i} e={e} />
                  ))}
                  {c.caveats.map((t, i) => (
                    <span key={i} className="block text-ink-3">
                      {t}
                    </span>
                  ))}
                </span>
                {!isCurrent && act ? (
                  <Button size="xs" onClick={act}>
                    Select {qualifiedLabel(c, currentUseCaseId, structures)}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="mt-1">
          <Button size="xs" variant="ghost" onClick={onKeep}>
            Keep {currentLabel}
          </Button>
        </div>
      </Strip>
    );
  }

  /* ------------------------------------------- a different structure ------ */
  const e = primaryEvidence(top);
  const act = actFor(top);
  const crossUseCase = top.useCaseId !== currentUseCaseId;
  const targetLabel = qualifiedLabel(top, currentUseCaseId, structures);
  return (
    <Strip tone="attention" role="status">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 flex-1">
          {e ? (
            <>
              <span className="font-medium">{fieldName(e)}</span> reads{" "}
              <code className="rounded-xs bg-inset px-1 font-mono text-ink">{e.fragment}</code> at line{" "}
              {e.line} —{" "}
            </>
          ) : null}
          the compiled {e?.fragment ?? top.title} structure is{" "}
          <code className="font-mono">{top.structureId}</code>
          {crossUseCase ? (
            <>
              {" "}
              in use case <code className="font-mono">{top.useCaseId}</code>
            </>
          ) : null}
          ; you have {currentLabel} selected.
          <span className="text-ink-3"> ({GRADE_WORD[top.grade]} match)</span>
          {e && basisNote(e) ? <span className="block text-ink-3">{basisNote(e)}</span> : null}
          {top.caveats.map((t, i) => (
            <span key={i} className="block text-ink-3">
              {t}
            </span>
          ))}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {act ? (
            <Button size="xs" variant="primary" onClick={act}>
              Switch to {targetLabel}
            </Button>
          ) : null}
          <Button size="xs" onClick={onKeep}>
            Keep
          </Button>
        </span>
      </div>
    </Strip>
  );
}

/**
 * Not the severity palette: detection is a fact about which rules to apply, not a verdict
 * about the message, so the attention tone is the accent surface. The severity strips in
 * CheckView stay reserved for the checker.
 */
function Strip({
  tone,
  role,
  children,
}: {
  tone: "muted" | "attention";
  role?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role={role}
      data-detection={tone}
      className={
        tone === "attention"
          ? "shrink-0 border-b border-accent/40 bg-accent-soft px-3 py-1.5 text-2xs leading-relaxed text-ink"
          : "shrink-0 border-b border-line bg-surface px-3 py-1 text-2xs leading-relaxed text-ink-3"
      }
    >
      {children}
    </div>
  );
}
