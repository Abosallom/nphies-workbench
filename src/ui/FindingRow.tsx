import { cx } from "./cx";
import { SEV_CHIP, SEV_RULE, IGNORED_EXPLANATION } from "./severity";
import { SEVERITY_GLYPH, SEVERITY_LABEL, type Finding } from "./types";
import { UsageRuleList } from "./Badge";
import { SourceNote } from "./SourceNote";
import { Tooltip } from "./Tooltip";

export interface FindingRowProps {
  finding: Finding;
  selected?: boolean;
  onSelect?: (finding: Finding) => void;
  /** "Reveal in message" affordance; omit to hide it. */
  onReveal?: (finding: Finding) => void;
  /** Hide the provenance disclosure (e.g. in a very dense list). */
  hideSource?: boolean;
  baseUrl?: string;
  className?: string;
}

/**
 * One structural finding. Severity is carried by a colour AND a letter glyph,
 * so the row is readable without colour perception.
 */
export function FindingRow({
  finding,
  selected,
  onSelect,
  onReveal,
  hideSource,
  baseUrl,
  className,
}: FindingRowProps) {
  const sev = finding.severity;
  const isIgnored = sev === "ignored";

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect?.(finding)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect?.(finding);
        }
      }}
      className={cx(
        "group w-full cursor-pointer border-b border-l-2 border-b-line px-2.5 py-1.5 text-left",
        "transition-colors hover:bg-inset",
        SEV_RULE[sev],
        selected && "bg-sel-line",
        isIgnored && "opacity-75",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={cx(
            "mt-px inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-xs font-mono text-2xs font-bold",
            SEV_CHIP[sev],
          )}
        >
          {SEVERITY_GLYPH[sev]}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span
              className={cx(
                "min-w-0 flex-1 text-xs font-medium",
                isIgnored ? "text-ignored-ink" : "text-ink",
              )}
            >
              <span className="sr-only">{SEVERITY_LABEL[sev]}: </span>
              {finding.title}
            </span>
            {finding.line != null ? (
              <span className="shrink-0 font-mono text-2xs text-ink-3 tabular-nums">
                L{finding.line}
              </span>
            ) : null}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <code className="truncate font-mono text-2xs text-ink-3">
              {finding.path}
            </code>
            {finding.rules?.length ? (
              <UsageRuleList rules={finding.rules} />
            ) : null}
            {finding.code ? (
              <code className="font-mono text-2xs text-ink-3 opacity-70">
                {finding.code}
              </code>
            ) : null}
            {isIgnored ? (
              <Tooltip wide content={IGNORED_EXPLANATION} side="top">
                <span className="cursor-help font-mono text-2xs text-ignored-ink underline decoration-dotted underline-offset-2">
                  ignored by NPHIES
                </span>
              </Tooltip>
            ) : null}
          </div>

          {finding.detail ? (
            <p
              className={cx(
                "mt-1 text-xs leading-4",
                isIgnored ? "text-ignored-ink" : "text-ink-2",
              )}
            >
              {finding.detail}
            </p>
          ) : null}

          {finding.source && !hideSource ? (
            <div
              className="mt-1"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <SourceNote source={finding.source} baseUrl={baseUrl} />
            </div>
          ) : null}
        </div>

        {onReveal && finding.regionId ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onReveal(finding);
            }}
            aria-label={`Reveal ${finding.path} in the message`}
            className={cx(
              "shrink-0 rounded-xs px-1 py-0.5 font-mono text-2xs text-ink-3",
              "opacity-0 transition-opacity hover:bg-inset hover:text-ink",
              "group-hover:opacity-100 focus-visible:opacity-100",
            )}
          >
            reveal
          </button>
        ) : null}
      </div>
    </div>
  );
}
