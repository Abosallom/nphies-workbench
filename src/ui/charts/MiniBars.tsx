import { useCallback, useState } from "react";
import { cx } from "../cx";
import {
  ChartTip,
  fmtInt,
  fmtPct,
  toneFill,
  useMeasuredWidth,
  type TipAnchor,
} from "./ProportionBar";
import type { Segment } from "./types";

export interface MiniBarRow {
  id: string;
  label: string;
  value: number;
  /** Denominator, e.g. the 648 in "212 of 648". */
  of: number;
  tone: Segment["tone"];
  /** Shown in the hover tooltip under the label. */
  detail?: string;
}

export interface MiniBarsProps {
  rows: MiniBarRow[];
  onSelect?: (id: string) => void;
  selectedId?: string | null;
  /** Bar thickness in px. Kept thin; the row's leftover is air. */
  barHeight?: number;
  className?: string;
  "aria-label"?: string;
}

const RADIUS = 4;
const MIN_SLIVER = 3;

/** Bar rounded at the data end only; square at the baseline, as a bar should be. */
function barPath(w: number, h: number) {
  const r = Math.min(RADIUS, w, h / 2);
  return `M 0 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H 0 Z`;
}

interface Hover {
  id: string;
  tip: TipAnchor;
}

/**
 * Part-of-whole rows. Each row is one bar over a shared track width, with the
 * value and denominator set as text beside it, so the number is readable with no
 * hover at all. One tone per row is legitimate here because each row is its own
 * series; the rows are not a ranked value ramp.
 */
export function MiniBars({
  rows,
  onSelect,
  selectedId,
  barHeight = 8,
  className,
  "aria-label": ariaLabel = "Part of whole",
}: MiniBarsProps) {
  /* The bar column is one grid track, so measuring the first row's cell sizes every bar. */
  const { ref: trackRef, width } = useMeasuredWidth<HTMLSpanElement>(240);
  const { ref: hostRef, width: hostWidth } = useMeasuredWidth<HTMLDivElement>(480);
  const [hover, setHover] = useState<Hover | null>(null);
  const interactive = Boolean(onSelect);

  const hide = useCallback(() => setHover(null), []);
  /* Anchor to the hovered row's bar cell, in host coordinates, so the tip sits over that row. */
  const show = useCallback(
    (row: MiniBarRow, i: number, w: number, frac: number) => {
      const host = hostRef.current?.getBoundingClientRect();
      const cell = hostRef.current
        ?.querySelector<HTMLElement>(`[data-minibar="${i}"]`)
        ?.getBoundingClientRect();
      const dx = host && cell ? cell.left - host.left : 0;
      const dy = host && cell ? cell.top - host.top : 0;
      setHover({
        id: row.id,
        tip: {
          x: dx + Math.max(w, MIN_SLIVER) / 2,
          y: dy - 2,
          body: (
            <span className="block">
              <span className="block font-medium tabular-nums text-ink">
                {fmtInt(row.value)}
                <span className="font-normal text-ink-3"> of {fmtInt(row.of)}</span>
                <span className="ml-1 font-normal text-ink-3">{fmtPct(frac)}</span>
              </span>
              <span className="block">{row.label}</span>
              {row.detail ? <span className="block text-ink-3">{row.detail}</span> : null}
            </span>
          ),
        },
      });
    },
    [hostRef],
  );

  if (rows.length === 0) return null;

  return (
    <div
      ref={hostRef}
      role={interactive ? "listbox" : "list"}
      aria-label={ariaLabel}
      className={cx(
        "relative grid grid-cols-[minmax(0,auto)_1fr_auto] items-center gap-x-3 gap-y-1.5 text-xs",
        className,
      )}
    >
      <ChartTip anchor={hover?.tip ?? null} width={hostWidth} />
      {rows.map((row, i) => {
        const frac = row.of > 0 ? Math.min(1, row.value / row.of) : 0;
        const w = row.value > 0 ? Math.max(MIN_SLIVER, frac * width) : 0;
        const selected = row.id === selectedId;
        const hovered = hover?.id === row.id;
        const name = `${row.label}: ${fmtInt(row.value)} of ${fmtInt(row.of)} (${fmtPct(frac)})`;
        const enter = () => show(row, i, w, frac);
        return (
          <div
            key={row.id}
            role={interactive ? "option" : "listitem"}
            aria-selected={interactive ? selected : undefined}
            aria-label={name}
            tabIndex={interactive ? 0 : undefined}
            onClick={() => onSelect?.(row.id)}
            onKeyDown={(e) => {
              if (!interactive) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect?.(row.id);
              }
            }}
            onPointerEnter={enter}
            onPointerLeave={hide}
            onFocus={enter}
            onBlur={hide}
            className={cx(
              "col-span-3 grid grid-cols-subgrid items-center rounded-xs outline-none",
              "-mx-1 px-1 focus-visible:outline-2 focus-visible:outline-focus",
              interactive && "cursor-pointer hover:bg-inset",
              selected && "bg-sel",
            )}
          >
            <span className={cx("truncate", selected ? "text-ink" : "text-ink-2")}>
              {row.label}
            </span>
            <span
              ref={i === 0 ? trackRef : undefined}
              data-minibar={i}
              className="relative block min-w-0"
              style={{ height: barHeight }}
            >
              <svg
                aria-hidden="true"
                width={width}
                height={barHeight}
                className="absolute inset-0 block overflow-visible"
              >
                <rect
                  x={0}
                  y={0}
                  width={width}
                  height={barHeight}
                  rx={RADIUS}
                  ry={RADIUS}
                  style={{ fill: "var(--color-inset)" }}
                />
                {w > 0 ? (
                  <path
                    d={barPath(w, barHeight)}
                    opacity={hovered ? 0.8 : 1}
                    style={{ fill: toneFill(row.tone) }}
                  />
                ) : null}
                {selected ? (
                  <rect
                    x={-1}
                    y={-1}
                    width={Math.max(w, MIN_SLIVER) + 2}
                    height={barHeight + 2}
                    rx={2}
                    fill="none"
                    strokeWidth={2}
                    style={{ stroke: "var(--color-accent)" }}
                  />
                ) : null}
              </svg>
            </span>
            <span className="whitespace-nowrap tabular-nums text-ink-2">
              <span className="font-medium text-ink">{fmtInt(row.value)}</span>
              <span className="text-ink-3"> of </span>
              {fmtInt(row.of)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
