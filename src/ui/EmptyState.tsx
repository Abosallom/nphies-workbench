import type { ReactNode } from "react";
import { cx } from "./cx";

export interface EmptyStateProps {
  title: string;
  /** One or two sentences. Say what to do next, not just what is absent. */
  description?: ReactNode;
  action?: ReactNode;
  /** Monospace glyph or tiny SVG. Restrained — no illustrations. */
  glyph?: ReactNode;
  /** Fills its container and centres. */
  fill?: boolean;
  className?: string;
}

export function EmptyState({
  title,
  description,
  action,
  glyph,
  fill = true,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cx(
        "flex flex-col items-center justify-center gap-2 px-6 py-10 text-center",
        fill && "h-full w-full",
        className,
      )}
    >
      {glyph ? (
        <div
          aria-hidden="true"
          className="font-mono text-2xl leading-none text-ink-3 opacity-60"
        >
          {glyph}
        </div>
      ) : null}
      <div className="text-lg font-semibold text-ink">{title}</div>
      {description ? (
        <div className="max-w-md text-sm leading-5 text-ink-2">{description}</div>
      ) : null}
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}
