import { useId, useState, type ReactNode } from "react";
import { cx } from "./cx";

export interface TooltipProps {
  /** Tooltip body. Keep it to a sentence or two. */
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "right" | "left";
  /** Widen for explanatory copy (e.g. the IGNORED rationale). */
  wide?: boolean;
  className?: string;
}

/**
 * Hover + focus tooltip. Dependency-free, wired with aria-describedby so the
 * explanation reaches assistive tech rather than only sighted mouse users.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  wide,
  className,
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);

  const pos =
    side === "top"
      ? "bottom-full left-1/2 -translate-x-1/2 mb-1.5"
      : side === "bottom"
        ? "top-full left-1/2 -translate-x-1/2 mt-1.5"
        : side === "right"
          ? "left-full top-1/2 -translate-y-1/2 ml-1.5"
          : "right-full top-1/2 -translate-y-1/2 mr-1.5";

  return (
    <span
      className={cx("relative inline-flex shrink-0", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined} className="inline-flex">
        {children}
      </span>
      <span
        role="tooltip"
        id={id}
        hidden={!open}
        className={cx(
          "pointer-events-none absolute z-50 rounded-sm border border-line-strong bg-surface px-2 py-1.5",
          "text-xs leading-4 text-ink-2 shadow-[0_2px_8px_rgba(0,0,0,0.18)]",
          wide ? "w-64" : "w-max max-w-xs",
          pos,
        )}
      >
        {content}
      </span>
    </span>
  );
}
