import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cx } from "../cx";
import { SEV_DOT } from "../severity";
import { SEVERITY_LABEL, type Severity } from "../types";
import { CATEGORY_VAR, type Segment } from "./types";

/* ============================================================================
   Shared kit for the chart primitives.

   It lives in this file rather than a `shared.ts` because the primitives were
   built as a fixed set of files; ProportionBar is the simplest of them and the
   first to need every piece, so the others import from here. Nothing in this
   block is re-exported through the barrel.
   ========================================================================== */

/**
 * Severity fill for a mark. These are the RESERVED tokens: a segment or block wears
 * them only when the category IS a verdict (see `Segment.tone`). `info` carries no
 * verdict, so it takes a neutral ink, the same choice `SEV_DOT` makes.
 */
export const SEV_FILL: Record<Severity, string> = {
  error: "var(--color-error)",
  warn: "var(--color-warn)",
  ok: "var(--color-ok)",
  ignored: "var(--color-ignored)",
  info: "var(--color-ink-3)",
};

export function toneFill(tone: Segment["tone"]): string {
  return tone.kind === "severity" ? SEV_FILL[tone.severity] : CATEGORY_VAR[tone.slot];
}

/**
 * Text set INSIDE a coloured fill is the one place text does not wear an ink token.
 * `--color-accent-ink` is already "the ink that sits on a saturated fill" in both
 * themes (white on light, near-black on dark), which tracks how the severity and
 * category fills flip lightness between themes.
 */
export const ON_FILL_INK: CSSProperties = { fill: "var(--color-accent-ink)" };

const INT = new Intl.NumberFormat("en-US");
export const fmtInt = (n: number) => INT.format(n);

/** Share as a whole percent; a non-zero sliver reads "<1%" rather than the lie "0%". */
export function fmtPct(frac: number): string {
  if (!Number.isFinite(frac) || frac <= 0) return "0%";
  if (frac < 0.01) return "<1%";
  return `${Math.round(frac * 100)}%`;
}

/**
 * Approximate advance width of a label, so an inline label is only drawn where it
 * fits. Measuring real glyphs needs a DOM; this runs on the server too, so it stays a
 * conservative estimate and the tooltip carries whatever gets skipped.
 */
export const estimateTextWidth = (s: string, fontPx: number) => s.length * fontPx * 0.58;

/**
 * Pixel width of the chart's wrapper. Geometry here is real pixels (2px gaps, 4px
 * corners, minimum widths a pointer can hit), which a percentage-based viewBox would
 * distort. Falls back to `initial` on the server and before the first layout.
 */
export function useMeasuredWidth<T extends HTMLElement>(initial = 480) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const w = Math.floor(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/* --------------------------------------------------------------- tooltip -- */

export interface TipAnchor {
  /** Horizontal centre of the hovered mark, in wrapper pixels. */
  x: number;
  /** Top edge of the hovered mark, in wrapper pixels. */
  y: number;
  body: ReactNode;
}

/**
 * Hover/focus readout, anchored to the MARK rather than the pointer so a keyboard
 * focus shows exactly what a hover does, and so pointer movement inside a mark never
 * re-renders the chart. It is `aria-hidden`: every mark already carries the same
 * readout in its `aria-label`, so the tooltip is a sighted convenience, never a gate.
 */
export function ChartTip({ anchor, width }: { anchor: TipAnchor | null; width: number }) {
  if (!anchor) return null;
  const half = 96;
  const left = Math.max(half, Math.min(width - half, anchor.x));
  return (
    <div
      aria-hidden="true"
      className={cx(
        "pointer-events-none absolute z-50 w-max max-w-48 -translate-x-1/2 -translate-y-full rounded-sm",
        "border border-line-strong bg-surface px-2 py-1.5 text-xs leading-4 text-ink-2",
        "shadow-[0_2px_8px_rgba(0,0,0,0.18)]",
      )}
      style={{ left, top: anchor.y - 6 }}
    >
      {anchor.body}
    </div>
  );
}

/** Value leads, label follows: the reader has the mark and wants the number. */
export function SegmentTip({
  segment,
  total,
}: {
  segment: Segment;
  total: number;
}) {
  return (
    <span className="block">
      <span className="block font-medium tabular-nums text-ink">
        {fmtInt(segment.value)}
        <span className="ml-1 font-normal text-ink-3">{fmtPct(segment.value / total)}</span>
      </span>
      <span className="block">{segment.label}</span>
      {segment.detail ? <span className="block text-ink-3">{segment.detail}</span> : null}
    </span>
  );
}

/** Dot + glyph + count, the `SeverityCount` idiom, sized for a tooltip line. */
export function SeverityCountsLine({ counts }: { counts: Record<Severity, number> }) {
  const order: Severity[] = ["error", "warn", "ok", "ignored", "info"];
  const present = order.filter((s) => counts[s] > 0);
  if (present.length === 0) return <span className="block text-ink-3">No findings</span>;
  return (
    <span className="flex flex-wrap gap-x-2 tabular-nums">
      {present.map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <span className={cx("inline-block h-1.5 w-1.5 rounded-full", SEV_DOT[s])} />
          <span className="text-ink">{fmtInt(counts[s])}</span>
          <span className="text-ink-3">{SEVERITY_LABEL[s].toLowerCase()}</span>
        </span>
      ))}
    </span>
  );
}

/* ---------------------------------------------------------------- legend -- */

/**
 * The dependable identity channel. Always rendered for two or more segments; the
 * direct labels on the marks supplement it and never replace it. Text is ink, the
 * swatch alone carries the colour.
 */
export function SegmentLegend({
  segments,
  total,
  selectedId,
  onSelect,
  className,
}: {
  segments: Segment[];
  total: number;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  className?: string;
}) {
  if (segments.length < 2) return null;
  return (
    <ul className={cx("flex flex-wrap gap-x-3 gap-y-1 text-xs", className)}>
      {segments.map((s) => {
        const selected = s.id === selectedId;
        const inner = (
          <>
            <span
              aria-hidden="true"
              className={cx(
                "inline-block h-2 w-2 shrink-0 rounded-xs",
                selected && "ring-2 ring-accent ring-offset-1 ring-offset-surface",
              )}
              style={{ background: toneFill(s.tone) }}
            />
            <span className={selected ? "text-ink" : "text-ink-2"}>{s.label}</span>
            <span className="tabular-nums text-ink-3">
              {fmtInt(s.value)} · {fmtPct(s.value / total)}
            </span>
          </>
        );
        return (
          <li key={s.id} className="inline-flex items-center">
            {onSelect ? (
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(s.id)}
                className="inline-flex items-center gap-1.5 rounded-xs px-0.5 hover:bg-inset focus-visible:outline-2 focus-visible:outline-focus"
              >
                {inner}
              </button>
            ) : (
              <span className="inline-flex items-center gap-1.5">{inner}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ============================================================================
   ProportionBar
   ========================================================================== */

export interface ProportionBarProps {
  segments: Segment[];
  /**
   * Denominator. Defaults to the sum of the segments; pass a larger number and the
   * remainder shows as an empty track, which is how "212 of 648" reads as part-of-whole.
   */
  total?: number;
  height?: number;
  showLegend?: boolean;
  onSelect?: (id: string) => void;
  selectedId?: string | null;
  className?: string;
  "aria-label"?: string;
}

const GAP = 2;
const RADIUS = 4;
/** Narrowest painted sliver: still a visible mark, never a "0%" that hides a value. */
const MIN_SLIVER = 3;
/** Narrowest pointer/focus target around a mark, wider than the mark it serves. */
const MIN_HIT = 14;
const LABEL_PX = 11;
/** Direct-label at most this many, largest first; the legend and tooltip carry the rest. */
const MAX_DIRECT_LABELS = 4;

interface Placed {
  segment: Segment;
  x: number;
  w: number;
}

/**
 * Lay the segments out in order, each proportional to its share of `total` with a
 * 2px surface gap between neighbours. Non-zero segments are widened to a visible
 * sliver and the excess is taken from the widest segment, so the bar still sums to
 * the track width.
 */
export function layoutSegments(
  segments: Segment[],
  total: number,
  trackWidth: number,
  minWidth = MIN_SLIVER,
  gap = GAP,
): Placed[] {
  const live = segments.filter((s) => s.value > 0);
  if (live.length === 0 || total <= 0) return [];
  const sum = live.reduce((a, s) => a + s.value, 0);
  const share = Math.min(1, sum / total);
  const paintable = trackWidth * share - gap * (live.length - 1);
  if (paintable <= 0) return [];
  const widths = live.map((s) => Math.max(minWidth, (s.value / sum) * paintable));
  let excess = widths.reduce((a, w) => a + w, 0) - paintable;
  while (excess > 0.5) {
    let big = 0;
    for (let i = 1; i < widths.length; i++) if (widths[i] > widths[big]) big = i;
    const room = widths[big] - minWidth;
    if (room <= 0) break;
    const take = Math.min(room, excess);
    widths[big] -= take;
    excess -= take;
  }
  const out: Placed[] = [];
  let x = 0;
  live.forEach((segment, i) => {
    out.push({ segment, x, w: widths[i] });
    x += widths[i] + gap;
  });
  return out;
}

export function ProportionBar({
  segments,
  total,
  height = 12,
  showLegend = true,
  onSelect,
  selectedId,
  className,
  "aria-label": ariaLabel = "Proportion",
}: ProportionBarProps) {
  const clipId = useId();
  const { ref, width } = useMeasuredWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ id: string; tip: TipAnchor } | null>(null);

  const sum = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  const denom = total && total > 0 ? Math.max(total, sum) : sum;
  const placed = layoutSegments(segments, denom, width);

  /* Largest first; a label is drawn only where it fits with padding on both sides. */
  const labelled = new Set(
    [...placed]
      .sort((a, b) => b.segment.value - a.segment.value)
      .slice(0, MAX_DIRECT_LABELS)
      .filter((p) => estimateTextWidth(p.segment.label, LABEL_PX) + 12 <= p.w)
      .map((p) => p.segment.id),
  );

  const show = (p: Placed) =>
    setHover({
      id: p.segment.id,
      tip: {
        x: p.x + p.w / 2,
        y: 0,
        body: <SegmentTip segment={p.segment} total={denom} />,
      },
    });
  const hide = () => setHover(null);

  const interactive = Boolean(onSelect);
  const svgHeight = height + 2; // room for the selection ring above and below the track

  return (
    <div className={cx("flex flex-col gap-2", className)}>
      <div ref={ref} className="relative w-full">
        <ChartTip anchor={hover?.tip ?? null} width={width} />
        <svg
          role="img"
          aria-label={ariaLabel}
          width={width}
          height={svgHeight}
          className="block overflow-visible"
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={0} y={1} width={width} height={height} rx={RADIUS} ry={RADIUS} />
            </clipPath>
          </defs>
          {/* Track: the unfilled remainder when `total` exceeds the segments. */}
          <rect
            x={0}
            y={1}
            width={width}
            height={height}
            rx={RADIUS}
            ry={RADIUS}
            style={{ fill: "var(--color-inset)" }}
          />
          <g clipPath={`url(#${clipId})`}>
            {placed.map((p) => (
              <rect
                key={p.segment.id}
                x={p.x}
                y={1}
                width={p.w}
                height={height}
                opacity={hover?.id === p.segment.id ? 0.8 : 1}
                style={{ fill: toneFill(p.segment.tone) }}
              />
            ))}
          </g>
          {placed.map((p) =>
            labelled.has(p.segment.id) ? (
              <text
                key={`label-${p.segment.id}`}
                x={p.x + p.w / 2}
                y={1 + height / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={LABEL_PX}
                className="pointer-events-none select-none font-medium"
                style={ON_FILL_INK}
              >
                {p.segment.label}
              </text>
            ) : null,
          )}
          {/* Selection ring, drawn outside the clip so it is not cropped at the ends. */}
          {placed
            .filter((p) => p.segment.id === selectedId)
            .map((p) => (
              <rect
                key={`sel-${p.segment.id}`}
                x={p.x - 1}
                y={0}
                width={p.w + 2}
                height={height + 2}
                rx={2}
                fill="none"
                strokeWidth={2}
                style={{ stroke: "var(--color-accent)" }}
              />
            ))}
          {/* Hit layer: wider than the sliver it serves, on top of everything. */}
          {placed.map((p) => {
            const hitW = Math.max(MIN_HIT, p.w);
            const hitX = p.x + p.w / 2 - hitW / 2;
            const name = `${p.segment.label}: ${fmtInt(p.segment.value)} (${fmtPct(
              p.segment.value / denom,
            )})`;
            return (
              <rect
                key={`hit-${p.segment.id}`}
                x={hitX}
                y={-4}
                width={hitW}
                height={height + 10}
                fill="transparent"
                role={interactive ? "button" : undefined}
                tabIndex={interactive ? 0 : undefined}
                aria-label={name}
                aria-pressed={interactive ? p.segment.id === selectedId : undefined}
                className={cx(
                  "outline-none focus-visible:outline-2 focus-visible:outline-focus",
                  interactive ? "cursor-pointer" : "cursor-default",
                )}
                onPointerEnter={() => show(p)}
                onPointerLeave={hide}
                onFocus={() => show(p)}
                onBlur={hide}
                onClick={() => onSelect?.(p.segment.id)}
                onKeyDown={(e) => {
                  if (!interactive) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect?.(p.segment.id);
                  }
                }}
              />
            );
          })}
        </svg>
      </div>
      {showLegend ? (
        <SegmentLegend
          segments={segments}
          total={denom}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ) : null}
    </div>
  );
}
