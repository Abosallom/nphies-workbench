import { cx } from "./cx";
import { SEV_DOT } from "./severity";
import { SEVERITY_GLYPH, SEVERITY_LABEL, type Severity } from "./types";
import type { UseCaseStatus } from "./types";
import { Tooltip } from "./Tooltip";

/* -------------------------------------------------------------- severity -- */

export interface StatusDotProps {
  severity: Severity;
  /** Hollow ring instead of a solid fill — used for "nothing checked yet". */
  hollow?: boolean;
  /** Accessible name; defaults to the severity label. */
  label?: string;
  size?: "sm" | "md";
  className?: string;
}

export function StatusDot({
  severity,
  hollow,
  label,
  size = "sm",
  className,
}: StatusDotProps) {
  const name = label ?? SEVERITY_LABEL[severity];
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className={cx(
        "inline-block shrink-0 rounded-full",
        size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2",
        hollow
          ? "border border-line-strong bg-transparent"
          : SEV_DOT[severity],
        className,
      )}
    />
  );
}

/* ------------------------------------------------------- use-case status -- */

/** Spec-readiness of a use case, not message validity. Deliberately neutral hues. */
export const USE_CASE_STATUS_META: Record<
  UseCaseStatus,
  { label: string; blurb: string; dot: string; glyph: string }
> = {
  ready: {
    label: "Spec compiled",
    blurb: "Structural rules extracted and cross-checked against a golden sample.",
    dot: "bg-accent",
    glyph: "●",
  },
  partial: {
    label: "Partial",
    blurb: "Some tables compiled; sections still unverified. Treat gaps as unknown, not as “not required”.",
    dot: "bg-ink-3",
    glyph: "◐",
  },
  draft: {
    label: "Draft",
    blurb: "Extracted but not yet reconciled with a golden sample. Verify before relying on it.",
    dot: "border border-line-strong bg-transparent",
    glyph: "○",
  },
  missing: {
    label: "Not compiled",
    blurb: "No structural rules available for this use case yet.",
    dot: "border border-dashed border-line-strong bg-transparent",
    glyph: "◌",
  },
};

export interface UseCaseStatusDotProps {
  status: UseCaseStatus;
  className?: string;
}

export function UseCaseStatusDot({ status, className }: UseCaseStatusDotProps) {
  const meta = USE_CASE_STATUS_META[status];
  return (
    <Tooltip
      side="right"
      wide
      content={
        <span className="block">
          <span className="block font-medium text-ink">{meta.label}</span>
          <span className="block">{meta.blurb}</span>
        </span>
      }
    >
      <span
        role="img"
        aria-label={`Spec status: ${meta.label}`}
        className={cx(
          "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
          meta.dot,
          className,
        )}
      />
    </Tooltip>
  );
}

/* --------------------------------------------------------- severity count -- */

export interface SeverityCountProps {
  severity: Severity;
  count: number;
  className?: string;
}

/** Compact "3 errors" pill for rail rows and toolbars. Glyph + colour, never colour alone. */
export function SeverityCount({
  severity,
  count,
  className,
}: SeverityCountProps) {
  if (count <= 0) return null;
  return (
    <span
      className={cx("inline-flex items-center gap-1 tabular-nums", className)}
      title={`${count} ${SEVERITY_LABEL[severity].toLowerCase()}`}
    >
      <StatusDot severity={severity} />
      <span aria-hidden="true" className="font-mono text-2xs">
        {SEVERITY_GLYPH[severity]}
        {count}
      </span>
      <span className="sr-only">
        {count} {SEVERITY_LABEL[severity]}
      </span>
    </span>
  );
}
