import type { ReactNode } from "react";
import { cx } from "./cx";
import { SEV_CHIP } from "./severity";
import {
  SEVERITY_GLYPH,
  SEVERITY_LABEL,
  USAGE_MEANING,
  type Severity,
  type Usage,
  type UsageRule,
} from "./types";
import { Tooltip } from "./Tooltip";

/* ------------------------------------------------------------------ Badge -- */

export interface BadgeProps {
  children: ReactNode;
  /** Neutral by default; `tone` opts into the reserved severity palette. */
  tone?: Severity | "neutral" | "accent";
  mono?: boolean;
  title?: string;
  className?: string;
}

const TONE: Record<string, string> = {
  neutral: "bg-inset text-ink-2 border-line",
  accent: "bg-accent-soft text-accent border-transparent",
  error: SEV_CHIP.error + " border-transparent",
  warn: SEV_CHIP.warn + " border-transparent",
  ok: SEV_CHIP.ok + " border-transparent",
  ignored: SEV_CHIP.ignored + " border-transparent",
  info: SEV_CHIP.info + " border-line",
};

export function Badge({
  children,
  tone = "neutral",
  mono,
  title,
  className,
}: BadgeProps) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 rounded-xs border px-1.5 py-px text-2xs font-medium",
        "whitespace-nowrap uppercase tracking-wide",
        mono && "font-mono tracking-normal normal-case",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------ SeverityTag -- */

export interface SeverityTagProps {
  severity: Severity;
  /** Show the word as well as the glyph. */
  withLabel?: boolean;
  className?: string;
}

/**
 * Severity always ships with its glyph, so colour is never the only carrier.
 */
export function SeverityTag({
  severity,
  withLabel,
  className,
}: SeverityTagProps) {
  return (
    <Badge tone={severity} className={className} title={SEVERITY_LABEL[severity]}>
      <span aria-hidden="true" className="font-mono">
        {SEVERITY_GLYPH[severity]}
      </span>
      {withLabel ? (
        <span>{SEVERITY_LABEL[severity]}</span>
      ) : (
        <span className="sr-only">{SEVERITY_LABEL[severity]}</span>
      )}
    </Badge>
  );
}

/* ------------------------------------------------------------- UsageBadge -- */

export interface UsageBadgeProps {
  usage: Usage;
  /** Verbatim cardinality cell from the spec, e.g. "1..1". */
  cardinality?: string;
  /** The condition this usage applies under, e.g. "Report". */
  condition?: string;
  className?: string;
}

/** `I` is the only usage rendered recessed — it maps to the IGNORED state. */
const USAGE_TONE: Record<Usage, BadgeProps["tone"]> = {
  M: "error",
  R: "error",
  R2: "warn",
  O: "neutral",
  I: "ignored",
  X: "warn",
  NP: "error",
};

export function UsageBadge({
  usage,
  cardinality,
  condition,
  className,
}: UsageBadgeProps) {
  const meaning = USAGE_MEANING[usage];
  return (
    <Tooltip
      wide
      content={
        <span className="block space-y-1">
          <span className="block font-medium text-ink">
            {usage} &mdash; {meaning.title}
          </span>
          <span className="block">{meaning.validator}</span>
          {cardinality ? (
            <span className="block font-mono text-ink-3">
              cardinality {cardinality}
            </span>
          ) : null}
          {condition ? (
            <span className="block text-ink-3">applies when: {condition}</span>
          ) : null}
        </span>
      }
    >
      <span
        className={cx(
          "inline-flex cursor-help items-center gap-1 rounded-xs border border-transparent px-1 py-px",
          "font-mono text-2xs font-semibold leading-4",
          usage === "I" ? "bg-ignored-bg text-ignored-ink opacity-75" : "",
          usage !== "I" ? TONE[USAGE_TONE[usage] ?? "neutral"] : "",
          className,
        )}
      >
        {usage}
        {cardinality ? (
          <span className="font-normal opacity-70">{cardinality}</span>
        ) : null}
        {condition ? (
          <span className="font-normal opacity-70">({condition})</span>
        ) : null}
        <span className="sr-only">
          {" "}
          {meaning.title}. {meaning.validator}
        </span>
      </span>
    </Tooltip>
  );
}

/* ------------------------------------------------------- UsageRuleList ---- */

export interface UsageRuleListProps {
  /** A LIST, because ~60 spec rows carry conditional usage. */
  rules: UsageRule[];
  className?: string;
}

export function UsageRuleList({ rules, className }: UsageRuleListProps) {
  if (rules.length === 0) return null;
  return (
    <span className={cx("inline-flex flex-wrap items-center gap-1", className)}>
      {rules.map((r, i) => (
        <UsageBadge
          key={i}
          usage={r.usage}
          cardinality={r.cardinality}
          condition={r.condition}
        />
      ))}
    </span>
  );
}
