import { useCallback, useMemo, useState } from "react";
import { Badge, Button, Tooltip, useApiKey } from "../ui";
import type { Finding } from "../lib/check";
import type { MessageStructure } from "../lib/structure";
import { describeAiError, estimateTokens, explainFinding, redactFinding, type Explanation } from "../lib/ai";

/* ========================================================================== *
 * One finding -> a HIS-side fix, from a model.
 *
 * It is attached to a finding the deterministic checker has ALREADY made, and it says —
 * before anything is sent — exactly what leaves the browser: the redacted finding and a few
 * lines of the redacted skeleton. Never the message. Nothing here can change a verdict: if
 * the request fails, the finding is unaffected and the error is shown verbatim, and what
 * comes back is a model opinion rendered as one, with no severity glyph or colour.
 * ========================================================================== */

export interface AiExplainProps {
  finding: Finding;
  structure: MessageStructure;
  /**
   * `skeletonWindow(skeleton, line, 2)` — the REDACTED skeleton lines around the finding.
   * Named for what it must be so that a raw `lines.slice(...)` cannot be passed here by
   * accident again: the previous "snippet" carried the patient's name, id and date of birth
   * to the API with every click.
   */
  skeletonWindow?: string;
  /** The source line the window is centred on, for the copy that says what is sent. */
  windowLine?: number;
}

/** The redacted finding as the request states it — the fields, not the prompt's framing. */
function previewOf(finding: Finding, structure: MessageStructure, skeletonWindow: string | undefined): string {
  const f = redactFinding(finding);
  return [
    `Message type: ${structure.title} (${structure.id}, ${structure.encoding}).`,
    "",
    "Finding (redacted):",
    `  id:       ${f.id}`,
    `  severity: ${f.severity}`,
    `  code:     ${f.code}`,
    `  title:    ${f.title}`,
    `  detail:   ${f.detail}`,
    `  path:     ${f.path}`,
    f.line !== null ? `  line:     L${f.line}` : "",
    f.expected !== undefined ? `  expected: ${f.expected}` : "",
    f.actual !== undefined ? `  actual:   ${f.actual}` : "",
    f.conditions.length ? `  conditions in play: ${f.conditions.join(" | ")}` : "",
    f.quote ? `  specification says, verbatim: "${f.quote}"` : "  (no published quote; sample-derived rule)",
    skeletonWindow ? `\nRedacted skeleton around that position (… = value not pinned by any rule):\n${skeletonWindow}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function AiExplain({ finding, structure, skeletonWindow, windowLine }: AiExplainProps) {
  const { key } = useApiKey();
  const [state, setState] = useState<{
    loading: boolean;
    error: string | null;
    result: Explanation | null;
  }>({ loading: false, error: null, result: null });
  const [previewing, setPreviewing] = useState(false);

  const preview = useMemo(() => previewOf(finding, structure, skeletonWindow), [finding, structure, skeletonWindow]);
  const tokens = useMemo(() => estimateTokens(preview), [preview]);

  const run = useCallback(async () => {
    setState({ loading: true, error: null, result: null });
    try {
      const result = await explainFinding(key, finding, structure, skeletonWindow);
      setState({ loading: false, error: null, result });
    } catch (err) {
      setState({ loading: false, error: describeAiError(err), result: null });
    }
  }, [key, finding, structure, skeletonWindow]);

  const sends = skeletonWindow
    ? `sends this finding and a redacted excerpt around line ${windowLine ?? finding.location?.line ?? "?"} — names, ids and dates already removed — to Anthropic (~${tokens.toLocaleString()} tokens)`
    : `sends this finding, redacted, to Anthropic (~${tokens.toLocaleString()} tokens); no message lines`;

  if (!key) {
    return (
      <Tooltip
        wide
        content="Set an Anthropic API key in the header to have a model turn this finding into a HIS-side fix. The structural verdict above does not use it, and nothing is sent without a key."
      >
        <span className="cursor-help font-mono text-2xs text-ink-3">
          AI explanation needs a key
        </span>
      </Tooltip>
    );
  }

  if (state.result) {
    const r = state.result;
    return (
      <div className="rounded-sm border border-dashed border-ai/50 bg-inset p-2 text-xs" data-advisory>
        <div className="mb-1 flex items-center gap-1.5">
          <Badge mono tone="ai">Model</Badge>
          <span className="text-2xs text-ink-3">model confidence: {r.confidence}</span>
          <button
            type="button"
            onClick={() => setState({ loading: false, error: null, result: null })}
            className="ml-auto font-mono text-2xs text-ink-3 hover:text-ink"
          >
            dismiss
          </button>
        </div>
        <p className="text-ink">{r.plainLanguage}</p>
        <p className="mt-1 text-ink-2">
          <span className="text-2xs uppercase tracking-wide text-ink-3">Usually caused by: </span>
          {r.hisSideCause}
        </p>
        <p className="mt-1 text-ink-2">
          <span className="text-2xs uppercase tracking-wide text-ink-3">Fix: </span>
          {r.fix}
        </p>
        {r.unresolved.length ? (
          <ul className="mt-1 list-disc pl-4 text-2xs text-ink-2">
            {r.unresolved.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        ) : null}
        <p className="mt-1.5 text-2xs text-ink-3">
          Model opinion — not a structural verdict. Nothing here changes the findings. The verdict
          above came from the compiled specification, not from this.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="xs" variant="ai" onClick={run} disabled={state.loading}>
          {state.loading ? "Asking…" : "Explain for my HIS team"}
        </Button>
        <span className="text-2xs text-ink-3">{sends}</span>
        <button
          type="button"
          className="text-2xs text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink"
          onClick={() => setPreviewing((p) => !p)}
          aria-expanded={previewing}
        >
          {previewing ? "Hide preview" : "Preview what will be sent"}
        </button>
        {state.error ? <span className="text-2xs text-ink-2">Not answered: {state.error}</span> : null}
      </div>
      {previewing ? (
        <pre className="max-h-48 overflow-auto rounded-sm border border-line bg-surface p-2 font-mono text-2xs leading-4 whitespace-pre-wrap text-ink-2">
          {preview}
        </pre>
      ) : null}
    </div>
  );
}
