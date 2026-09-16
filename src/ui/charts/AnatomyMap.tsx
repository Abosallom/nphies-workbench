import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { cx } from "../cx";
import { SEVERITY_GLYPH, SEVERITY_LABEL, type Severity } from "../types";
import {
  ChartTip,
  SEV_FILL,
  SeverityCountsLine,
  estimateTextWidth,
  fmtInt,
  useMeasuredWidth,
  type TipAnchor,
} from "./ProportionBar";
import type { AnatomyBlock } from "./types";

export interface AnatomyMapProps {
  blocks: AnatomyBlock[];
  selectedId?: string | null;
  onSelect?: (block: AnatomyBlock) => void;
  /** Ribbon height in px. */
  height?: number;
  className?: string;
  "aria-label"?: string;
}

const GAP = 2;
const RADIUS = 4;
/** Narrowest block: room for the glyph and a pointer. The ribbon scrolls before a block shrinks below it. */
const MIN_BLOCK = 14;
const GLYPH_PX = 10;
const LABEL_PX = 11;

/**
 * Tinted, not painted: the block wears the severity's `-bg` step and its glyph the
 * `-ink` step, the same pairing `SEV_CHIP` uses, so sixty blocks read as a quiet
 * ribbon and an error still stands out. The full-strength token is a 2px rule along
 * the top, which is where the eye scans a horizontal ribbon.
 */
const BLOCK_BG: Record<Severity, string> = {
  error: "var(--color-error-bg)",
  warn: "var(--color-warn-bg)",
  ok: "var(--color-ok-bg)",
  ignored: "var(--color-ignored-bg)",
  info: "var(--color-inset)",
};
const BLOCK_INK: Record<Severity, string> = {
  error: "var(--color-error-ink)",
  warn: "var(--color-warn-ink)",
  ok: "var(--color-ok-ink)",
  ignored: "var(--color-ignored-ink)",
  info: "var(--color-ink-2)",
};
/** `info` means "no findings", which earns no rule at all. */
const BLOCK_RULE: Record<Severity, string | null> = {
  error: SEV_FILL.error,
  warn: SEV_FILL.warn,
  ok: SEV_FILL.ok,
  ignored: SEV_FILL.ignored,
  info: null,
};

interface Placed {
  block: AnatomyBlock;
  x: number;
  w: number;
}

/**
 * Every block gets its minimum first; what is left is shared in proportion to bytes.
 * When the minimums alone exceed the wrapper, the ribbon grows past it and the wrapper
 * scrolls, so a tiny block is always clickable.
 */
function layoutBlocks(
  blocks: AnatomyBlock[],
  wrapperWidth: number,
): { placed: Placed[]; ribbonWidth: number } {
  const n = blocks.length;
  if (n === 0) return { placed: [], ribbonWidth: 0 };
  const floor = n * MIN_BLOCK + (n - 1) * GAP;
  const ribbonWidth = Math.max(wrapperWidth, floor);
  const spare = ribbonWidth - floor;
  const bytes = blocks.reduce((a, b) => a + Math.max(0, b.bytes), 0);
  const placed: Placed[] = [];
  let x = 0;
  for (const block of blocks) {
    const share = bytes > 0 ? Math.max(0, block.bytes) / bytes : 1 / n;
    const w = MIN_BLOCK + spare * share;
    placed.push({ block, x, w });
    x += w + GAP;
  }
  return { placed, ribbonWidth };
}

function describe(b: AnatomyBlock): string {
  const parts = [
    b.label,
    b.detail,
    `${fmtInt(b.nodeCount)} ${b.nodeCount === 1 ? "node" : "nodes"}`,
    `line ${fmtInt(b.firstLine)}`,
    SEVERITY_LABEL[b.severity],
  ];
  return parts.filter(Boolean).join(", ");
}

/**
 * The message as a ribbon: one block per top-level part in document order, width by
 * source length, tint by the worst finding inside. Roving tabindex like
 * `StructureTree`: one block is in the tab order (the selected one, else the first)
 * and the arrows move between them.
 */
export function AnatomyMap({
  blocks,
  selectedId,
  onSelect,
  height = 36,
  className,
  "aria-label": ariaLabel = "Message anatomy",
}: AnatomyMapProps) {
  const clipId = useId();
  const { ref, width } = useMeasuredWidth<HTMLDivElement>(640);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<{ id: string; tip: TipAnchor } | null>(null);

  const { placed, ribbonWidth } = useMemo(() => layoutBlocks(blocks, width), [blocks, width]);
  const indexOfSelected = useMemo(
    () => placed.findIndex((p) => p.block.id === selectedId),
    [placed, selectedId],
  );

  const svgHeight = height + 4; // selection ring above and below

  const show = useCallback(
    (p: Placed) => {
      const b = p.block;
      /* The tip lives OUTSIDE the scrolling wrapper (so it is neither clipped nor scrolled
         away), so the anchor is the block's centre in viewport-of-the-ribbon coordinates. */
      const scrollLeft = ref.current?.scrollLeft ?? 0;
      setHover({
        id: b.id,
        tip: {
        x: p.x + p.w / 2 - scrollLeft,
        y: 2,
        body: (
          <span className="block">
            <span className="block font-medium text-ink">
              <span className="font-mono">{b.label}</span>
              {b.detail ? <span className="ml-1.5 font-normal text-ink-2">{b.detail}</span> : null}
            </span>
            <span className="block tabular-nums text-ink-3">
              {fmtInt(b.nodeCount)} {b.nodeCount === 1 ? "node" : "nodes"} · {fmtInt(b.bytes)} chars ·
              line {fmtInt(b.firstLine)}
            </span>
            <span className="mt-1 block">
              <SeverityCountsLine counts={b.counts} />
            </span>
          </span>
        ),
        },
      });
    },
    [ref],
  );
  const hide = useCallback(() => setHover(null), []);

  const focusBlock = useCallback(
    (j: number) => {
      if (placed.length === 0) return;
      const clamped = Math.max(0, Math.min(placed.length - 1, j));
      onSelect?.(placed[clamped].block);
      requestAnimationFrame(() => {
        svgRef.current
          ?.querySelector<SVGGElement>(`[data-block-index="${clamped}"]`)
          ?.focus();
      });
    },
    [placed, onSelect],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent, i: number) => {
      switch (e.key) {
        case "ArrowRight":
          e.preventDefault();
          focusBlock(i + 1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          focusBlock(i - 1);
          break;
        case "Home":
          e.preventDefault();
          focusBlock(0);
          break;
        case "End":
          e.preventDefault();
          focusBlock(placed.length - 1);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          onSelect?.(placed[i].block);
          break;
      }
    },
    [focusBlock, onSelect, placed],
  );

  if (blocks.length === 0) return null;

  return (
    <div className={cx("relative w-full", className)}>
      <ChartTip anchor={hover?.tip ?? null} width={width} />
      <div
        ref={ref}
        className="w-full overflow-x-auto overflow-y-hidden"
        onScroll={hide}
      >
      <svg
        ref={svgRef}
        role="listbox"
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        width={ribbonWidth}
        height={svgHeight}
        className="block"
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={0} y={2} width={ribbonWidth} height={height} rx={RADIUS} ry={RADIUS} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          {placed.map((p) => {
            const rule = BLOCK_RULE[p.block.severity];
            const showGlyph = p.w >= MIN_BLOCK;
            const labelFits =
              p.w >= GLYPH_PX + 10 + estimateTextWidth(p.block.label, LABEL_PX) + 8;
            return (
              <g
                key={p.block.id}
                className="pointer-events-none select-none"
                opacity={hover?.id === p.block.id ? 0.8 : 1}
              >
                <rect
                  x={p.x}
                  y={2}
                  width={p.w}
                  height={height}
                  style={{ fill: BLOCK_BG[p.block.severity] }}
                />
                {rule ? (
                  <rect x={p.x} y={2} width={p.w} height={2} style={{ fill: rule }} />
                ) : null}
                {showGlyph ? (
                  <text
                    x={labelFits ? p.x + 6 : p.x + p.w / 2}
                    y={2 + height / 2}
                    textAnchor={labelFits ? "start" : "middle"}
                    dominantBaseline="central"
                    fontSize={GLYPH_PX}
                    className="font-mono font-medium"
                    style={{ fill: BLOCK_INK[p.block.severity] }}
                  >
                    {SEVERITY_GLYPH[p.block.severity]}
                  </text>
                ) : null}
                {labelFits ? (
                  <text
                    x={p.x + 6 + GLYPH_PX + 4}
                    y={2 + height / 2}
                    dominantBaseline="central"
                    fontSize={LABEL_PX}
                    className="fill-ink font-mono"
                  >
                    {p.block.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
        {indexOfSelected >= 0 ? (
          <rect
            x={placed[indexOfSelected].x - 1}
            y={1}
            width={placed[indexOfSelected].w + 2}
            height={height + 2}
            rx={2}
            fill="none"
            strokeWidth={2}
            className="pointer-events-none"
            style={{ stroke: "var(--color-accent)" }}
          />
        ) : null}
        {/* Hit layer: one focusable group per block, on top, roving tabindex. */}
        {placed.map((p, i) => {
          const selected = i === indexOfSelected;
          const focusable = indexOfSelected >= 0 ? selected : i === 0;
          return (
            <g
              key={`hit-${p.block.id}`}
              role="option"
              data-block-index={i}
              tabIndex={focusable ? 0 : -1}
              aria-selected={selected}
              aria-label={describe(p.block)}
              className="cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-focus"
              onPointerEnter={() => show(p)}
              onPointerLeave={hide}
              onFocus={() => show(p)}
              onBlur={hide}
              onClick={() => onSelect?.(p.block)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              <rect
                x={p.x}
                y={0}
                width={p.w + (i < placed.length - 1 ? GAP : 0)}
                height={svgHeight}
                fill="transparent"
              />
            </g>
          );
        })}
      </svg>
      </div>
    </div>
  );
}
