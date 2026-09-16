import { useState, type ReactNode } from "react";
import { cx } from "../cx";
import {
  ChartTip,
  SegmentLegend,
  SegmentTip,
  estimateTextWidth,
  fmtInt,
  fmtPct,
  toneFill,
  type TipAnchor,
} from "./ProportionBar";
import type { Segment } from "./types";

export interface DonutProps {
  segments: Segment[];
  /** The hero number in the hole. Pre-formatted by the caller when it is not an integer. */
  centerValue: ReactNode;
  centerCaption?: ReactNode;
  /** Outer diameter of the ring, in px. Labels sit in a gutter outside it. */
  size?: number;
  onSelect?: (id: string) => void;
  selectedId?: string | null;
  className?: string;
  "aria-label"?: string;
}

const RING = 14;
const GAP = 2;
/** Horizontal room outside the ring for direct labels and their leader ticks. */
const GUTTER = 84;
const LABEL_PX = 11;
const MAX_DIRECT_LABELS = 4;
/** Below this share an outside label collides with its neighbours; legend + tooltip carry it. */
const MIN_LABEL_SHARE = 0.06;
/** Narrowest arc sweep, in radians, so a sliver is still visible and hittable. */
const MIN_SWEEP = 0.05;

interface Arc {
  segment: Segment;
  a0: number;
  a1: number;
}

const polar = (cx: number, cy: number, r: number, a: number) => ({
  x: cx + r * Math.cos(a),
  y: cy + r * Math.sin(a),
});

/** Annular sector path between angles a0 and a1 (radians, clockwise from 12 o'clock). */
function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p0 = polar(cx, cy, r1, a0);
  const p1 = polar(cx, cy, r1, a1);
  const q1 = polar(cx, cy, r0, a1);
  const q0 = polar(cx, cy, r0, a0);
  return [
    `M ${p0.x} ${p0.y}`,
    `A ${r1} ${r1} 0 ${large} 1 ${p1.x} ${p1.y}`,
    `L ${q1.x} ${q1.y}`,
    `A ${r0} ${r0} 0 ${large} 0 ${q0.x} ${q0.y}`,
    "Z",
  ].join(" ");
}

/**
 * Sweep each live segment proportionally, leaving a 2px surface gap between arcs.
 * The gap is built into the geometry (a pad angle at the outer radius) rather than
 * drawn as a stroke, so no mark carries a border.
 */
function layoutArcs(segments: Segment[], total: number, r1: number): Arc[] {
  const live = segments.filter((s) => s.value > 0);
  if (live.length === 0 || total <= 0) return [];
  const sum = live.reduce((a, s) => a + s.value, 0);
  const pad = live.length > 1 ? GAP / r1 : 0;
  const sweepable = Math.PI * 2 * Math.min(1, sum / total) - pad * live.length;
  if (sweepable <= 0) return [];
  const sweeps = live.map((s) => Math.max(MIN_SWEEP, (s.value / sum) * sweepable));
  let excess = sweeps.reduce((a, w) => a + w, 0) - sweepable;
  while (excess > 1e-4) {
    let big = 0;
    for (let i = 1; i < sweeps.length; i++) if (sweeps[i] > sweeps[big]) big = i;
    const room = sweeps[big] - MIN_SWEEP;
    if (room <= 0) break;
    const take = Math.min(room, excess);
    sweeps[big] -= take;
    excess -= take;
  }
  const out: Arc[] = [];
  let a = -Math.PI / 2;
  live.forEach((segment, i) => {
    out.push({ segment, a0: a, a1: a + sweeps[i] });
    a += sweeps[i] + pad;
  });
  return out;
}

export function Donut({
  segments,
  centerValue,
  centerCaption,
  size = 160,
  onSelect,
  selectedId,
  className,
  "aria-label": ariaLabel = "Proportion",
}: DonutProps) {
  const [hover, setHover] = useState<{ id: string; tip: TipAnchor } | null>(null);

  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  const r1 = size / 2;
  const r0 = r1 - RING;
  const arcs = layoutArcs(segments, total, r1);

  const labelled = new Set(
    [...arcs]
      .sort((a, b) => b.segment.value - a.segment.value)
      .slice(0, MAX_DIRECT_LABELS)
      .filter((a) => a.segment.value / total >= MIN_LABEL_SHARE)
      .map((a) => a.segment.id),
  );
  const hasLabels = labelled.size > 0;
  const gutter = hasLabels ? GUTTER : 4;
  const width = size + gutter * 2;
  const height = size + 8;
  const cx0 = width / 2;
  const cy0 = height / 2;

  const show = (arc: Arc) => {
    const mid = (arc.a0 + arc.a1) / 2;
    const p = polar(cx0, cy0, r1 - RING / 2, mid);
    setHover({
      id: arc.segment.id,
      tip: {
        x: p.x,
        y: p.y - RING / 2,
        body: <SegmentTip segment={arc.segment} total={total} />,
      },
    });
  };
  const hide = () => setHover(null);

  const interactive = Boolean(onSelect);

  return (
    <div className={cx("flex flex-col items-center gap-2", className)}>
      <div className="relative" style={{ width, height }}>
        <ChartTip anchor={hover?.tip ?? null} width={width} />
        <svg
          role="img"
          aria-label={ariaLabel}
          width={width}
          height={height}
          className="block overflow-visible"
        >
          {/* Empty track when there is nothing to paint, so the hero number still has a ring. */}
          {arcs.length === 0 ? (
            <circle
              cx={cx0}
              cy={cy0}
              r={r1 - RING / 2}
              fill="none"
              strokeWidth={RING}
              style={{ stroke: "var(--color-inset)" }}
            />
          ) : null}
          {arcs.map((arc) => (
            <path
              key={arc.segment.id}
              d={arcPath(cx0, cy0, r0, r1, arc.a0, arc.a1)}
              opacity={hover?.id === arc.segment.id ? 0.8 : 1}
              style={{ fill: toneFill(arc.segment.tone) }}
            />
          ))}
          {arcs
            .filter((arc) => arc.segment.id === selectedId)
            .map((arc) => (
              <path
                key={`sel-${arc.segment.id}`}
                d={arcPath(cx0, cy0, r0 - 1, r1 + 1, arc.a0, arc.a1)}
                fill="none"
                strokeWidth={2}
                strokeLinejoin="round"
                style={{ stroke: "var(--color-accent)" }}
              />
            ))}
          {arcs.map((arc) => {
            if (!labelled.has(arc.segment.id)) return null;
            const mid = (arc.a0 + arc.a1) / 2;
            const right = Math.cos(mid) >= 0;
            const from = polar(cx0, cy0, r1 + 2, mid);
            const to = polar(cx0, cy0, r1 + 10, mid);
            const tx = to.x + (right ? 4 : -4);
            const label = arc.segment.label;
            const fits = estimateTextWidth(label, LABEL_PX) <= gutter - 14;
            return (
              <g key={`label-${arc.segment.id}`} className="pointer-events-none select-none">
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  strokeWidth={1}
                  style={{ stroke: "var(--color-line-strong)" }}
                />
                <text
                  x={tx}
                  y={to.y}
                  textAnchor={right ? "start" : "end"}
                  dominantBaseline="central"
                  fontSize={LABEL_PX}
                  className="fill-ink-2"
                >
                  {fits ? label : fmtPct(arc.segment.value / total)}
                </text>
              </g>
            );
          })}
          {/* Hit layer: the full ring thickness plus 6px either side, on top of the marks. */}
          {arcs.map((arc) => {
            const name = `${arc.segment.label}: ${fmtInt(arc.segment.value)} (${fmtPct(
              arc.segment.value / total,
            )})`;
            return (
              <path
                key={`hit-${arc.segment.id}`}
                d={arcPath(cx0, cy0, Math.max(0, r0 - 6), r1 + 6, arc.a0, arc.a1 + (arcs.length > 1 ? GAP / r1 : 0))}
                fill="transparent"
                role={interactive ? "button" : undefined}
                tabIndex={interactive ? 0 : undefined}
                aria-label={name}
                aria-pressed={interactive ? arc.segment.id === selectedId : undefined}
                className={cx(
                  "outline-none focus-visible:outline-2 focus-visible:outline-focus",
                  interactive ? "cursor-pointer" : "cursor-default",
                )}
                onPointerEnter={() => show(arc)}
                onPointerLeave={hide}
                onFocus={() => show(arc)}
                onBlur={hide}
                onClick={() => onSelect?.(arc.segment.id)}
                onKeyDown={(e) => {
                  if (!interactive) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect?.(arc.segment.id);
                  }
                }}
              />
            );
          })}
        </svg>
        {/* The hero number is HTML so it takes the type scale; proportional figures on purpose. */}
        <div
          className="pointer-events-none absolute flex flex-col items-center justify-center text-center"
          style={{ left: cx0 - r0, top: cy0 - r0, width: r0 * 2, height: r0 * 2 }}
        >
          <span className="text-2xl font-semibold leading-none text-ink">{centerValue}</span>
          {centerCaption ? (
            <span className="mt-1 max-w-full truncate px-2 text-2xs text-ink-3">
              {centerCaption}
            </span>
          ) : null}
        </div>
      </div>
      <SegmentLegend
        segments={segments}
        total={total}
        selectedId={selectedId}
        onSelect={onSelect}
        className="justify-center"
      />
    </div>
  );
}
