import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { cx } from "./cx";
import { SEV_DOT, IGNORED_EXPLANATION } from "./severity";
import { SEVERITY_GLYPH, SEVERITY_LABEL, type StructureNode } from "./types";
import { UsageRuleList } from "./Badge";
import { Tooltip } from "./Tooltip";
import { useVirtualRows } from "./useVirtualRows";

export const TREE_ROW_HEIGHT = 22;

interface FlatRow {
  node: StructureNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  /** Index of this node's parent row, or -1. */
  parent: number;
}

export interface StructureTreeProps {
  nodes: StructureNode[];
  /** Currently selected node id. */
  selectedId?: string | null;
  onSelect?: (node: StructureNode) => void;
  /** Depth auto-expanded on first render. */
  defaultExpandedDepth?: number;
  /** Hide nodes whose severity is "ignored" (the "what must I build?" view). */
  hideIgnored?: boolean;
  /** Controlled expansion, if the caller wants to drive it. */
  expandedIds?: ReadonlySet<string>;
  onExpandedChange?: (next: Set<string>) => void;
  rowHeight?: number;
  emptyLabel?: string;
  className?: string;
  "aria-label"?: string;
}

function collectExpandable(
  nodes: StructureNode[],
  depth: number,
  maxDepth: number,
  out: Set<string>,
) {
  for (const n of nodes) {
    if (n.children?.length && depth < maxDepth) {
      out.add(n.id);
      collectExpandable(n.children, depth + 1, maxDepth, out);
    }
  }
}

/** parentId lookup, so a selection arriving from the code pane can reveal itself. */
function buildParents(
  nodes: StructureNode[],
  parentId: string | null,
  out: Map<string, string | null>,
) {
  for (const n of nodes) {
    out.set(n.id, parentId);
    if (n.children?.length) buildParents(n.children, n.id, out);
  }
}

export function StructureTree({
  nodes,
  selectedId,
  onSelect,
  defaultExpandedDepth = 2,
  hideIgnored = false,
  expandedIds,
  onExpandedChange,
  rowHeight = TREE_ROW_HEIGHT,
  emptyLabel = "No structure to show.",
  className,
  "aria-label": ariaLabel = "Message structure",
}: StructureTreeProps) {
  const [internal, setInternal] = useState<Set<string>>(() => {
    const s = new Set<string>();
    collectExpandable(nodes, 0, defaultExpandedDepth, s);
    return s;
  });
  const expanded = expandedIds ?? internal;

  const setExpanded = useCallback(
    (next: Set<string>) => {
      if (onExpandedChange) onExpandedChange(next);
      else setInternal(next);
    },
    [onExpandedChange],
  );

  const parents = useMemo(() => {
    const m = new Map<string, string | null>();
    buildParents(nodes, null, m);
    return m;
  }, [nodes]);

  /* Reveal an externally-driven selection (e.g. a click in the message pane). */
  useEffect(() => {
    if (!selectedId) return;
    const need: string[] = [];
    let p = parents.get(selectedId) ?? null;
    while (p) {
      if (!expanded.has(p)) need.push(p);
      p = parents.get(p) ?? null;
    }
    if (need.length) {
      const next = new Set(expanded);
      for (const id of need) next.add(id);
      setExpanded(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, parents]);

  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    const walk = (list: StructureNode[], depth: number, parent: number) => {
      for (const n of list) {
        if (hideIgnored && n.severity === "ignored") continue;
        const kids = n.children ?? [];
        const visibleKids = hideIgnored
          ? kids.filter((k) => k.severity !== "ignored")
          : kids;
        const hasChildren = visibleKids.length > 0;
        const isOpen = hasChildren && expanded.has(n.id);
        const idx = out.length;
        out.push({ node: n, depth, hasChildren, expanded: isOpen, parent });
        if (isOpen) walk(visibleKids, depth + 1, idx);
      }
    };
    walk(nodes, 0, -1);
    return out;
  }, [nodes, expanded, hideIgnored]);

  const indexOfSelected = useMemo(
    () => rows.findIndex((r) => r.node.id === selectedId),
    [rows, selectedId],
  );

  const { ref, window: win, onScroll, scrollToRow } = useVirtualRows({
    count: rows.length,
    rowHeight,
  });

  const lastRevealed = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || indexOfSelected < 0) return;
    if (lastRevealed.current === selectedId) return;
    lastRevealed.current = selectedId;
    scrollToRow(indexOfSelected);
  }, [selectedId, indexOfSelected, scrollToRow]);

  const toggle = useCallback(
    (id: string, open?: boolean) => {
      const next = new Set(expanded);
      const shouldOpen = open ?? !next.has(id);
      if (shouldOpen) next.add(id);
      else next.delete(id);
      setExpanded(next);
    },
    [expanded, setExpanded],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent, i: number) => {
      const row = rows[i];
      if (!row) return;
      const focusRow = (j: number) => {
        const clamped = Math.max(0, Math.min(rows.length - 1, j));
        scrollToRow(clamped, false);
        onSelect?.(rows[clamped].node);
        requestAnimationFrame(() => {
          ref.current
            ?.querySelector<HTMLElement>(`[data-row-index="${clamped}"]`)
            ?.focus();
        });
      };
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          focusRow(i + 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          focusRow(i - 1);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (row.hasChildren && !row.expanded) toggle(row.node.id, true);
          else if (row.hasChildren) focusRow(i + 1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (row.hasChildren && row.expanded) toggle(row.node.id, false);
          else if (row.parent >= 0) focusRow(row.parent);
          break;
        case "Home":
          e.preventDefault();
          focusRow(0);
          break;
        case "End":
          e.preventDefault();
          focusRow(rows.length - 1);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          onSelect?.(row.node);
          if (row.hasChildren) toggle(row.node.id);
          break;
      }
    },
    [rows, toggle, onSelect, scrollToRow, ref],
  );

  if (rows.length === 0) {
    return (
      <div className={cx("p-3 text-xs text-ink-3", className)}>{emptyLabel}</div>
    );
  }

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className={cx("h-full overflow-auto", className)}
    >
      <div
        role="tree"
        aria-label={ariaLabel}
        style={{ height: win.totalHeight, position: "relative" }}
      >
        <div
          style={{
            transform: `translateY(${win.offsetY}px)`,
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
          }}
        >
          {rows.slice(win.start, win.end).map((row, k) => {
            const i = win.start + k;
            return (
              <TreeRow
                key={row.node.id}
                row={row}
                index={i}
                rowHeight={rowHeight}
                selected={row.node.id === selectedId}
                focusable={
                  indexOfSelected >= 0 ? i === indexOfSelected : i === 0
                }
                onToggle={() => toggle(row.node.id)}
                onSelect={() => onSelect?.(row.node)}
                onKeyDown={(e) => onKeyDown(e, i)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TreeRow({
  row,
  index,
  rowHeight,
  selected,
  focusable,
  onToggle,
  onSelect,
  onKeyDown,
}: {
  row: FlatRow;
  index: number;
  rowHeight: number;
  selected: boolean;
  focusable: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
}) {
  const n = row.node;
  const isIgnored = n.severity === "ignored";

  return (
    <div
      role="treeitem"
      data-row-index={index}
      tabIndex={focusable ? 0 : -1}
      aria-level={row.depth + 1}
      aria-selected={selected}
      aria-expanded={row.hasChildren ? row.expanded : undefined}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      title={n.path}
      style={{ height: rowHeight, paddingLeft: 6 + row.depth * 12 }}
      className={cx(
        "flex cursor-pointer select-none items-center gap-1.5 pr-2 text-xs",
        "border-l-2 transition-colors",
        selected
          ? "border-l-accent bg-sel"
          : "border-l-transparent hover:bg-inset",
        isIgnored && "opacity-70",
      )}
    >
      {row.hasChildren ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-xs font-mono text-2xs text-ink-3 hover:bg-line hover:text-ink"
        >
          {row.expanded ? "▾" : "▸"}
        </button>
      ) : (
        <span aria-hidden="true" className="inline-block h-3.5 w-3.5 shrink-0" />
      )}

      <span
        role="img"
        aria-label={SEVERITY_LABEL[n.severity]}
        className={cx(
          "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
          SEV_DOT[n.severity],
        )}
      />
      <span aria-hidden="true" className="sr-only">
        {SEVERITY_GLYPH[n.severity]}
      </span>

      <span
        className={cx(
          "shrink-0 font-mono",
          isIgnored ? "text-ignored-ink" : "text-ink",
        )}
      >
        {n.label}
      </span>

      {n.name ? (
        <span
          className={cx(
            "min-w-0 flex-1 truncate",
            isIgnored ? "text-ignored-ink" : "text-ink-2",
          )}
        >
          {n.name}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}

      {n.dataType ? (
        <span className="shrink-0 font-mono text-2xs text-ink-3">
          {n.dataType}
        </span>
      ) : null}

      {n.fixedValue ? (
        <Tooltip
          wide
          content={
            <span className="block">
              <span className="block font-medium text-ink">Fixed value</span>
              <span className="block font-mono break-all">{n.fixedValue}</span>
              <span className="block text-ink-3">
                The specification pins this exact value. Any other value is a
                structural defect.
              </span>
            </span>
          }
        >
          <span className="shrink-0 cursor-help rounded-xs bg-inset px-1 font-mono text-2xs text-ink-2">
            = {n.fixedValue.length > 18 ? n.fixedValue.slice(0, 16) + "…" : n.fixedValue}
          </span>
        </Tooltip>
      ) : null}

      {isIgnored ? (
        <Tooltip wide side="left" content={n.ignoredReason ?? IGNORED_EXPLANATION}>
          <span className="shrink-0 cursor-help rounded-xs bg-ignored-bg px-1 font-mono text-2xs text-ignored-ink">
            I
          </span>
        </Tooltip>
      ) : n.rules?.length ? (
        <UsageRuleList rules={n.rules} className="shrink-0" />
      ) : null}
    </div>
  );
}
