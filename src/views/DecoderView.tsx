import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  SourceNote,
  Toolbar,
  ToolbarTitle,
  Tooltip,
} from "../ui";
import {
  decodeRejection,
  loadErrorCatalogue,
  searchCatalogue,
  type ErrorCatalogue,
  type ErrorEntry,
  type ErrorMatch,
} from "../lib/errors";
import { useAsyncValue } from "./useAsyncValue";

/* ========================================================================== *
 * Error Decoder — paste the rejection, find the position that caused it.
 *
 * Built from the Error Handling Guide's 38 tables. A match says HOW it was made: an exact
 * signature from the guide, a literal error code, or overlapping keywords — which is a lead,
 * not an identification, and is labelled as one.
 * ========================================================================== */

const MATCH_LABEL: Record<ErrorMatch["kind"], string> = {
  signature: "exact wording from the guide",
  code: "error code",
  keywords: "keyword overlap — a lead, not an identification",
};

export interface DecoderViewProps {
  baseUrl?: string;
}

export function DecoderView({ baseUrl }: DecoderViewProps) {
  const catalogue = useAsyncValue<ErrorCatalogue>(loadErrorCatalogue);
  const [text, setText] = useState("");
  const [browse, setBrowse] = useState("");

  const matches = useMemo(
    () => (catalogue.data && text.trim() ? decodeRejection(text, catalogue.data) : []),
    [catalogue.data, text],
  );

  const browsed = useMemo(
    () => (catalogue.data ? searchCatalogue(browse, catalogue.data) : []),
    [catalogue.data, browse],
  );

  if (catalogue.error) {
    return <EmptyState fill title="The error catalogue could not be loaded" description={catalogue.error} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <Toolbar dense aria-label="Error Decoder">
        <ToolbarTitle>Error Decoder</ToolbarTitle>
        <Badge mono>{catalogue.data ? catalogue.data.entries.length + catalogue.data.xds.length : "…"} catalogued</Badge>
        <span className="text-2xs text-ink-3">Error Handling Guide · 38 tables</span>
      </Toolbar>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-r border-line">
          <div className="shrink-0 p-3">
            <label className="mb-1 block text-2xs font-semibold uppercase tracking-wide text-ink-3">
              Paste the rejection NPHIES returned
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              rows={5}
              placeholder="Required field missing PID/PatientIdentifierList[0]/IDNumber"
              className="w-full resize-y rounded-sm border border-line bg-surface p-2 font-mono text-xs leading-5 text-ink outline-none placeholder:text-ink-3 focus:border-accent"
            />
            {text.trim() ? (
              <div className="mt-1.5 flex items-center gap-2">
                <Button size="xs" variant="ghost" onClick={() => setText("")}>
                  Clear
                </Button>
                <span className="text-2xs text-ink-3">
                  {matches.length} catalogue {matches.length === 1 ? "entry" : "entries"} matched
                </span>
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
            {text.trim() ? (
              matches.length ? (
                <ul className="space-y-2">
                  {matches.map((m) => (
                    <li key={m.entry.id}>
                      <EntryCard entry={m.entry} match={m} baseUrl={baseUrl} />
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  title="No catalogue entry matches"
                  description="The Error Handling Guide does not describe this wording. Check the message structurally instead — most rejections are structural, and the Check surface locates those precisely."
                />
              )
            ) : (
              <EmptyState
                glyph="⊘"
                title="Paste a rejection"
                description="The decoder matches it against the published error catalogue and tells you which position in the message the error is about."
              />
            )}
          </div>
        </div>

        {/* No density prop reaches this view; the presentation width is keyed off the
            <html data-density> attribute in CSS, the same way the tokens are. */}
        <aside className="flex w-[24rem] shrink-0 flex-col [[data-density=roomy]_&]:w-[28rem]">
          <div className="shrink-0 border-b border-line p-2">
            <input
              value={browse}
              onChange={(e) => setBrowse(e.target.value)}
              placeholder="Browse the catalogue…"
              className="w-full rounded-xs border border-line bg-surface px-1.5 py-1 text-xs text-ink outline-none placeholder:text-ink-3 focus:border-accent"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <ul className="space-y-1.5">
              {browsed.map((e) => (
                <li key={e.id}>
                  <EntrySummary entry={e} onPick={() => setText(e.sample ?? e.description ?? e.condition ?? "")} />
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function EntryCard({
  entry,
  match,
  baseUrl,
}: {
  entry: ErrorEntry;
  match: ErrorMatch;
  baseUrl?: string;
}) {
  return (
    <article className="rounded-sm border border-line bg-surface p-2.5 text-xs [[data-density=roomy]_&]:p-3 [[data-density=roomy]_&]:leading-relaxed">
      <header className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <Badge tone={match.kind === "keywords" ? "warn" : "accent"} mono>
          {Math.round(match.score * 100)}%
        </Badge>
        <span className="font-mono text-ink">{entry.code ?? entry.id}</span>
        {entry.family ? <Badge mono>{entry.family}</Badge> : null}
        {entry.chapter ? <span className="text-2xs text-ink-3">{entry.chapter}</span> : null}
      </header>

      <Tooltip wide content={MATCH_LABEL[match.kind]}>
        {/* Evidence can be a whole rejection line; it wraps and breaks inside long tokens so
            the card never scrolls sideways, and the line loosens at presentation scale. */}
        <p className="mb-1.5 cursor-help text-2xs text-ink-3 [[data-density=roomy]_&]:mb-2 [[data-density=roomy]_&]:leading-relaxed">
          matched on {MATCH_LABEL[match.kind]}:{" "}
          <code className="break-words rounded-xs bg-inset px-1 font-mono text-ink-2 [[data-density=roomy]_&]:px-1.5">
            {match.evidence}
          </code>
        </p>
      </Tooltip>

      {entry.title ? <p className="mb-1 font-medium text-ink">{entry.title}</p> : null}
      {entry.description ? <p className="mb-1 text-ink-2">{entry.description}</p> : null}
      {entry.condition ? <p className="mb-1 text-ink-2">{entry.condition}</p> : null}

      {entry.possibleCause ? (
        <Field label="Likely cause">{entry.possibleCause}</Field>
      ) : null}
      {entry.recommendation ? <Field label="What to change">{entry.recommendation}</Field> : null}

      {entry.locators?.length ? (
        <Field label="Position in the message">
          <span className="flex flex-wrap gap-1">
            {entry.locators.map((l, i) => (
              <Badge key={i} mono title={l.kind}>
                {l.value}
              </Badge>
            ))}
          </span>
        </Field>
      ) : null}

      {entry.codeSpellingNote ? (
        <p className="mt-1 text-2xs text-warn">{entry.codeSpellingNote}</p>
      ) : null}
      {entry.note ? <p className="mt-1 text-2xs text-ink-3">{entry.note}</p> : null}

      {entry.source?.pageId && entry.source.quote ? (
        <div className="mt-1.5">
          <SourceNote
            source={{
              pageId: entry.source.pageId,
              pageTitle: entry.source.pageTitle ?? "",
              quote: entry.source.quote,
              ...(entry.source.row ? { row: entry.source.row } : {}),
            }}
            baseUrl={baseUrl}
          />
        </div>
      ) : null}
    </article>
  );
}

function EntrySummary({ entry, onPick }: { entry: ErrorEntry; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="w-full rounded-xs border border-line bg-surface px-2 py-1.5 text-left text-2xs hover:bg-inset"
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-ink">{entry.code ?? entry.ref ?? entry.id.slice(0, 18)}</span>
        {entry.family ? <span className="text-ink-3">{entry.family}</span> : null}
      </div>
      <div className="mt-0.5 line-clamp-2 text-ink-2">
        {entry.sample ?? entry.description ?? entry.condition ?? entry.title ?? ""}
      </div>
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-1">
      <span className="text-2xs font-semibold uppercase tracking-wide text-ink-3">{label}</span>
      <div className="whitespace-pre-wrap text-ink-2">{children}</div>
    </div>
  );
}
