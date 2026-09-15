import { useState } from "react";
import { cx } from "./cx";
import type { Provenance } from "./types";

export interface SourceNoteProps {
  source: Provenance;
  /** Start expanded. */
  defaultOpen?: boolean;
  /** Base URL of the Confluence space; the page id is appended. */
  baseUrl?: string;
  className?: string;
}

/**
 * Provenance disclosure. The quote is VERBATIM Confluence text carried through
 * the compiled spec — it is what lets an analyst check any claim this tool
 * makes. Never render a paraphrase here.
 */
export function SourceNote({
  source,
  defaultOpen = false,
  baseUrl,
  className,
}: SourceNoteProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cx("text-xs", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-xs text-ink-3 hover:text-ink-2"
      >
        <span aria-hidden="true" className="font-mono text-2xs">
          {open ? "▾" : "▸"}
        </span>
        Source
        <span className="font-mono text-2xs opacity-70">
          {source.pageId}
          {source.row ? ` · ${source.row}` : ""}
        </span>
      </button>
      {open ? (
        <div className="mt-1 border-l-2 border-line pl-2">
          <div className="text-2xs uppercase tracking-wide text-ink-3">
            {baseUrl ? (
              <a
                href={`${baseUrl.replace(/\/$/, "")}/${source.pageId}`}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-dotted underline-offset-2 hover:text-accent"
              >
                {source.pageTitle}
              </a>
            ) : (
              source.pageTitle
            )}
          </div>
          <blockquote className="mt-0.5 whitespace-pre-wrap font-mono text-xs leading-4 text-ink-2">
            {source.quote}
          </blockquote>
        </div>
      ) : null}
    </div>
  );
}
