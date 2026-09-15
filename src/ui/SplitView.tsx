import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cx } from "./cx";
import { SEV_DOT, SEV_CHIP, IGNORED_EXPLANATION } from "./severity";
import {
  SEVERITY_GLYPH,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  type Finding,
  type Region,
  type Severity,
  type StructureNode,
  type Token,
  type TokenKind,
} from "./types";
import { StructureTree } from "./StructureTree";
import { FindingRow } from "./FindingRow";
import { UsageRuleList } from "./Badge";
import { SourceNote } from "./SourceNote";
import { CopyButton } from "./CopyButton";
import { EmptyState } from "./EmptyState";
import { Tooltip } from "./Tooltip";
import { useVirtualRows } from "./useVirtualRows";

/* ========================================================================== */
/*  SplitView — the workbench's signature surface.                            */
/*                                                                            */
/*  Left  : the message, monospace, line-numbered, syntax-highlighted, with    */
/*          a clickable hit region per structural token.                      */
/*  Right : the structure tree + the findings for whatever is selected.       */
/*                                                                            */
/*  Selecting on either side highlights the corresponding thing on the other.  */
/*                                                                            */
/*  It is FORMAT-AGNOSTIC by construction: it receives geometry (regions,      */
/*  tokens) and a node tree, and contains no knowledge of HL7, XML, JSON or    */
/*  SOAP. The adapters that turn a parsed message into these shapes live       */
/*  outside src/ui.                                                            */
/*                                                                            */
/*  Both panes are windowed, so an 89KB CDA renders ~60 rows per pane rather   */
/*  than several thousand.                                                     */
/* ========================================================================== */

export const CODE_LINE_HEIGHT = 20;

export type SelectionOrigin = "code" | "tree" | "finding" | "external";

export interface SplitSelection {
  /** Region id in the message pane, when the selection maps to one. */
  regionId: string | null;
  /** Node id in the structure tree, when the selection maps to one. */
  nodeId: string | null;
  origin: SelectionOrigin;
}

export interface SplitViewProps {
  /** The raw wire message, exactly as it will be transmitted. */
  text: string;
  /** Flat (or shallowly nested) list of hit regions. Nested children are flattened internally. */
  regions: Region[];
  /** The structure tree for the right pane. Nodes link back via `regionId`. */
  tree: StructureNode[];
  /** Findings for the whole message; the right pane filters them by selection. */
  findings?: Finding[];
  /** Optional cosmetic syntax tokens. Supplied by the caller so SplitView stays format-agnostic. */
  tokens?: Token[];

  /** Controlled selection. Omit to let SplitView own it. */
  selection?: SplitSelection | null;
  defaultSelection?: SplitSelection | null;
  onSelectionChange?: (next: SplitSelection) => void;

  /** Label above the left pane, e.g. "ADT^A01 · outbound". */
  codeTitle?: ReactNode;
  /** Extra controls in the left pane header. */
  codeActions?: ReactNode;
  /** Label above the right pane. */
  structureTitle?: ReactNode;
  /** Confluence base URL for provenance links. */
  baseUrl?: string;

  lineHeight?: number;
  overscan?: number;
  /** Start with `ignored` nodes/findings hidden. */
  hideIgnoredByDefault?: boolean;
  /** Initial left-pane width as a fraction of the container. */
  defaultRatio?: number;
  className?: string;
}

/* -------------------------------------------------------------- indexing -- */

function flattenRegions(regions: Region[]): Region[] {
  const out: Region[] = [];
  const walk = (list: Region[]) => {
    for (const r of list) {
      out.push(r);
      if (r.children?.length) walk(r.children);
    }
  };
  walk(regions);
  return out;
}

function flattenNodes(nodes: StructureNode[]): StructureNode[] {
  const out: StructureNode[] = [];
  const walk = (list: StructureNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function worse(a: Severity | undefined, b: Severity): Severity {
  if (!a) return b;
  return SEVERITY_ORDER[b] < SEVERITY_ORDER[a] ? b : a;
}

const TOKEN_CLASS: Record<TokenKind, string> = {
  punct: "text-syn-punct",
  name: "text-syn-name",
  key: "text-syn-key",
  value: "text-syn-value",
  string: "text-syn-string",
  number: "text-syn-number",
  meta: "text-syn-meta",
  comment: "text-syn-comment",
};

/** Region tint inside the code pane. Reserved severity palette, low-contrast fills. */
const REGION_CLASS: Record<Severity, string> = {
  error: "underline decoration-error decoration-wavy underline-offset-[3px]",
  warn: "underline decoration-warn decoration-wavy underline-offset-[3px]",
  ok: "underline decoration-ok/40 decoration-dotted underline-offset-[3px]",
  ignored: "opacity-45",
  info: "",
};

/* ============================================================== component */

export function SplitView({
  text,
  regions,
  tree,
  findings = [],
  tokens,
  selection: controlled,
  defaultSelection = null,
  onSelectionChange,
  codeTitle = "Message",
  codeActions,
  structureTitle = "Structure",
  baseUrl,
  lineHeight = CODE_LINE_HEIGHT,
  overscan = 14,
  hideIgnoredByDefault = false,
  defaultRatio = 0.56,
  className,
}: SplitViewProps) {
  /* ---- selection (controlled or not) ---------------------------------- */
  const [uncontrolled, setUncontrolled] = useState<SplitSelection | null>(
    defaultSelection,
  );
  const selection = controlled !== undefined ? controlled : uncontrolled;

  const flatRegions = useMemo(() => flattenRegions(regions), [regions]);
  const flatNodes = useMemo(() => flattenNodes(tree), [tree]);

  const regionById = useMemo(() => {
    const m = new Map<string, Region>();
    for (const r of flatRegions) m.set(r.id, r);
    return m;
  }, [flatRegions]);

  const nodeById = useMemo(() => {
    const m = new Map<string, StructureNode>();
    for (const n of flatNodes) m.set(n.id, n);
    return m;
  }, [flatNodes]);

  /** regionId -> nodeId, so a click in the message reveals the tree row. */
  const nodeByRegion = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of flatNodes) {
      if (n.regionId && !m.has(n.regionId)) m.set(n.regionId, n.id);
    }
    return m;
  }, [flatNodes]);

  const select = useCallback(
    (next: SplitSelection) => {
      if (controlled === undefined) setUncontrolled(next);
      onSelectionChange?.(next);
    },
    [controlled, onSelectionChange],
  );

  const selectRegion = useCallback(
    (regionId: string | null, origin: SelectionOrigin) => {
      select({
        regionId,
        nodeId: regionId ? (nodeByRegion.get(regionId) ?? null) : null,
        origin,
      });
    },
    [select, nodeByRegion],
  );

  const selectNode = useCallback(
    (node: StructureNode, origin: SelectionOrigin) => {
      select({ regionId: node.regionId ?? null, nodeId: node.id, origin });
    },
    [select],
  );

  /* ---- code model ------------------------------------------------------ */
  const lines = useMemo(() => text.split(/\r\n|\r|\n/), [text]);

  const regionsByLine = useMemo(() => {
    const m = new Map<number, Region[]>();
    for (const r of flatRegions) {
      const arr = m.get(r.line);
      if (arr) arr.push(r);
      else m.set(r.line, [r]);
    }
    for (const arr of m.values())
      arr.sort((a, b) => a.startCol - b.startCol || b.endCol - a.endCol);
    return m;
  }, [flatRegions]);

  const tokensByLine = useMemo(() => {
    const m = new Map<number, Token[]>();
    if (!tokens) return m;
    for (const t of tokens) {
      const arr = m.get(t.line);
      if (arr) arr.push(t);
      else m.set(t.line, [t]);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.startCol - b.startCol);
    return m;
  }, [tokens]);

  /** Worst severity present on each line — drives the gutter marker. */
  const severityByLine = useMemo(() => {
    const m = new Map<number, Severity>();
    for (const r of flatRegions) {
      if (r.severity === "ok" || r.severity === "info") continue;
      m.set(r.line, worse(m.get(r.line), r.severity));
    }
    for (const f of findings) {
      const line = f.line ?? (f.regionId ? regionById.get(f.regionId)?.line : undefined);
      if (line == null) continue;
      if (f.severity === "ok" || f.severity === "info") continue;
      m.set(line, worse(m.get(line), f.severity));
    }
    return m;
  }, [flatRegions, findings, regionById]);

  const gutterWidth = useMemo(
    () => Math.max(3, String(lines.length).length) * 8 + 26,
    [lines.length],
  );

  const code = useVirtualRows({
    count: lines.length,
    rowHeight: lineHeight,
    overscan,
  });

  const selectedRegion = selection?.regionId
    ? (regionById.get(selection.regionId) ?? null)
    : null;
  const selectedNode = selection?.nodeId
    ? (nodeById.get(selection.nodeId) ?? null)
    : null;

  /* Reveal in the code pane when the selection came from elsewhere. */
  const lastCodeReveal = useRef<string | null>(null);
  useEffect(() => {
    if (!selection || selection.origin === "code") return;
    if (!selectedRegion) return;
    if (lastCodeReveal.current === selectedRegion.id) return;
    lastCodeReveal.current = selectedRegion.id;
    code.scrollToRow(selectedRegion.line - 1);
  }, [selection, selectedRegion, code.scrollToRow]);

  /* ---- right pane filters --------------------------------------------- */
  const [hideIgnored, setHideIgnored] = useState(hideIgnoredByDefault);

  /** Findings scoped to the selection: exact path, or descendants of it. */
  const scopedFindings = useMemo(() => {
    const path = selectedNode?.path ?? selectedRegion?.path ?? null;
    const list = hideIgnored
      ? findings.filter((f) => f.severity !== "ignored")
      : findings;
    const scoped = path
      ? list.filter((f) => f.path === path || f.path.startsWith(path + "/"))
      : list;
    return [...scoped].sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        (a.line ?? 0) - (b.line ?? 0),
    );
  }, [findings, selectedNode, selectedRegion, hideIgnored]);

  const counts = useMemo(() => {
    const c: Record<Severity, number> = {
      error: 0,
      warn: 0,
      ok: 0,
      ignored: 0,
      info: 0,
    };
    for (const f of findings) c[f.severity]++;
    return c;
  }, [findings]);

  /* ---- resizable divider ---------------------------------------------- */
  const wrapRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(defaultRatio);
  const dragging = useRef(false);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current || !wrapRef.current) return;
      const box = wrapRef.current.getBoundingClientRect();
      const r = (e.clientX - box.left) / box.width;
      setRatio(Math.min(0.85, Math.max(0.2, r)));
    }
    function onUp() {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const path = selectedNode?.path ?? selectedRegion?.path ?? null;

  return (
    <div
      ref={wrapRef}
      className={cx("flex h-full min-h-0 w-full bg-surface", className)}
    >
      {/* ================================================== LEFT: message == */}
      <section
        className="flex min-w-0 flex-col border-r border-line"
        style={{ width: `${ratio * 100}%` }}
        aria-label="Message"
      >
        <header className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-raised px-2">
          <span className="truncate text-xs font-semibold uppercase tracking-wider text-ink-3">
            {codeTitle}
          </span>
          <span className="font-mono text-2xs text-ink-3 tabular-nums">
            {lines.length} lines
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <SeverityLegend counts={counts} />
            {codeActions}
            <CopyButton value={text} what="the message" toast size="xs" />
          </div>
        </header>

        <div
          ref={code.ref}
          onScroll={code.onScroll}
          className="relative min-h-0 flex-1 overflow-auto bg-surface"
        >
          <div
            style={{ height: code.window.totalHeight, position: "relative" }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                transform: `translateY(${code.window.offsetY}px)`,
                width: "max-content",
                minWidth: "100%",
              }}
            >
              {lines
                .slice(code.window.start, code.window.end)
                .map((lineText, k) => {
                  const lineNo = code.window.start + k + 1;
                  return (
                    <CodeLine
                      key={lineNo}
                      lineNo={lineNo}
                      text={lineText}
                      height={lineHeight}
                      gutterWidth={gutterWidth}
                      regions={regionsByLine.get(lineNo)}
                      tokens={tokensByLine.get(lineNo)}
                      lineSeverity={severityByLine.get(lineNo)}
                      selectedRegionId={selection?.regionId ?? null}
                      isSelectedLine={selectedRegion?.line === lineNo}
                      onPick={(id) => selectRegion(id, "code")}
                    />
                  );
                })}
            </div>
          </div>
        </div>
      </section>

      {/* ============================================== divider ============ */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={20}
        aria-valuemax={85}
        tabIndex={0}
        onMouseDown={() => {
          dragging.current = true;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            setRatio((r) => Math.max(0.2, r - 0.02));
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            setRatio((r) => Math.min(0.85, r + 0.02));
          }
        }}
        className="w-1 shrink-0 cursor-col-resize bg-line hover:bg-accent/40"
      />

      {/* =========================================== RIGHT: structure ====== */}
      <section
        className="flex min-w-0 flex-1 flex-col"
        aria-label="Structure and findings"
      >
        <header className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-raised px-2">
          <span className="shrink-0 text-xs font-semibold uppercase tracking-wider text-ink-3">
            {structureTitle}
          </span>
          <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 text-2xs text-ink-2">
            <input
              type="checkbox"
              checked={hideIgnored}
              onChange={(e) => setHideIgnored(e.target.checked)}
              className="h-3 w-3 accent-[var(--nw-accent)]"
            />
            Hide ignored
          </label>
        </header>

        {/* selected-path strip */}
        <div className="flex h-6 shrink-0 items-center gap-2 border-b border-line bg-surface px-2">
          {path ? (
            <>
              <code className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-2">
                {path}
              </code>
              {selectedNode?.rules?.length ? (
                <UsageRuleList rules={selectedNode.rules} className="shrink-0" />
              ) : null}
              <CopyButton value={path} what="the path" size="xs" label="path" />
              <button
                type="button"
                onClick={() => select({ regionId: null, nodeId: null, origin: "external" })}
                className="shrink-0 rounded-xs px-1 text-2xs text-ink-3 hover:bg-inset hover:text-ink"
              >
                clear
              </button>
            </>
          ) : (
            <span className="text-2xs text-ink-3">
              Nothing selected &mdash; click a token in the message or a row in
              the tree.
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1">
          <StructureTree
            nodes={tree}
            hideIgnored={hideIgnored}
            selectedId={selection?.nodeId ?? null}
            onSelect={(n) => selectNode(n, "tree")}
          />
        </div>

        {selectedNode?.severity === "ignored" ? (
          <div className="shrink-0 border-t border-line bg-ignored-bg px-2.5 py-1.5 text-2xs leading-4 text-ignored-ink">
            <strong className="font-semibold">Ignored by NPHIES.</strong>{" "}
            {selectedNode.ignoredReason ?? IGNORED_EXPLANATION}
          </div>
        ) : null}

        {selectedNode?.source ? (
          <div className="shrink-0 border-t border-line bg-raised px-2.5 py-1.5">
            <SourceNote source={selectedNode.source} baseUrl={baseUrl} defaultOpen />
          </div>
        ) : null}

        {/* findings */}
        <div className="flex h-[38%] min-h-24 shrink-0 flex-col border-t border-line">
          <div className="flex h-6 shrink-0 items-center gap-2 border-b border-line bg-raised px-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-ink-3">
              Findings
            </span>
            <span className="font-mono text-2xs text-ink-3 tabular-nums">
              {scopedFindings.length}
              {path ? " in selection" : ""}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {scopedFindings.length === 0 ? (
              <EmptyState
                glyph={"✓"}
                title="No findings here"
                description={
                  path
                    ? "Nothing to report for the selected element."
                    : "This message matches the compiled structural rules."
                }
              />
            ) : (
              scopedFindings.map((f) => (
                <FindingRow
                  key={f.id}
                  finding={f}
                  baseUrl={baseUrl}
                  selected={
                    !!f.regionId && f.regionId === selection?.regionId
                  }
                  onSelect={(x) =>
                    x.regionId
                      ? selectRegion(x.regionId, "finding")
                      : undefined
                  }
                  onReveal={(x) =>
                    x.regionId ? selectRegion(x.regionId, "finding") : undefined
                  }
                />
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------- code line -- */

interface Seg {
  start: number;
  end: number;
  region: Region | null;
  kind: TokenKind | null;
}

/** Innermost region covering `col` (smallest width wins). */
function regionAt(list: Region[] | undefined, col: number): Region | null {
  if (!list) return null;
  let best: Region | null = null;
  for (const r of list) {
    if (col >= r.startCol && col < r.endCol) {
      if (!best || r.endCol - r.startCol < best.endCol - best.startCol) best = r;
    }
  }
  return best;
}

function tokenAt(list: Token[] | undefined, col: number): TokenKind | null {
  if (!list) return null;
  for (const t of list) {
    if (col >= t.startCol && col < t.endCol) return t.kind;
  }
  return null;
}

function segment(
  text: string,
  regions: Region[] | undefined,
  tokens: Token[] | undefined,
): Seg[] {
  const len = text.length;
  if (len === 0) return [];
  const bounds = new Set<number>([0, len]);
  if (regions)
    for (const r of regions) {
      if (r.startCol > 0 && r.startCol < len) bounds.add(r.startCol);
      if (r.endCol > 0 && r.endCol < len) bounds.add(r.endCol);
    }
  if (tokens)
    for (const t of tokens) {
      if (t.startCol > 0 && t.startCol < len) bounds.add(t.startCol);
      if (t.endCol > 0 && t.endCol < len) bounds.add(t.endCol);
    }
  const cuts = [...bounds].sort((a, b) => a - b);
  const out: Seg[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    if (b <= a) continue;
    out.push({
      start: a,
      end: b,
      region: regionAt(regions, a),
      kind: tokenAt(tokens, a),
    });
  }
  return out;
}

function CodeLine({
  lineNo,
  text,
  height,
  gutterWidth,
  regions,
  tokens,
  lineSeverity,
  selectedRegionId,
  isSelectedLine,
  onPick,
}: {
  lineNo: number;
  text: string;
  height: number;
  gutterWidth: number;
  regions?: Region[];
  tokens?: Token[];
  lineSeverity?: Severity;
  selectedRegionId: string | null;
  isSelectedLine: boolean;
  onPick: (regionId: string) => void;
}) {
  const segs = useMemo(
    () => segment(text, regions, tokens),
    [text, regions, tokens],
  );

  return (
    <div
      style={{ height }}
      className={cx(
        "flex items-center font-mono text-sm leading-none whitespace-pre",
        isSelectedLine && "bg-sel-line",
      )}
    >
      <span
        aria-hidden="true"
        style={{ width: gutterWidth, height }}
        className={cx(
          "sticky left-0 z-10 flex shrink-0 items-center justify-end gap-1 border-r border-line pr-1.5",
          "select-none text-2xs text-ink-3 tabular-nums",
          isSelectedLine ? "bg-sel-line" : "bg-raised",
        )}
      >
        {lineSeverity ? (
          <span
            className={cx(
              "inline-block h-1.5 w-1.5 rounded-full",
              SEV_DOT[lineSeverity],
            )}
          />
        ) : (
          <span className="inline-block h-1.5 w-1.5" />
        )}
        {lineNo}
      </span>

      <span className="pl-2 pr-6">
        {segs.length === 0 ? (
          <span className="text-ink-3">{" "}</span>
        ) : (
          segs.map((s, i) => {
            const body = text.slice(s.start, s.end);
            const cls = s.kind ? TOKEN_CLASS[s.kind] : "text-ink";
            if (!s.region) {
              return (
                <span key={i} className={cls}>
                  {body}
                </span>
              );
            }
            const r = s.region;
            const isSel = r.id === selectedRegionId;
            return (
              <span
                key={i}
                role="button"
                tabIndex={-1}
                data-region-id={r.id}
                title={`${r.label} — ${r.path} — ${
                  r.severity === "ignored"
                    ? "ignored by NPHIES"
                    : SEVERITY_LABEL[r.severity]
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  onPick(r.id);
                }}
                className={cx(
                  "cursor-pointer rounded-[2px]",
                  cls,
                  REGION_CLASS[r.severity],
                  isSel
                    ? "bg-sel outline outline-1 outline-accent"
                    : "hover:bg-inset",
                )}
              >
                {body}
              </span>
            );
          })
        )}
      </span>
    </div>
  );
}

/* ----------------------------------------------------------- mini legend -- */

function SeverityLegend({ counts }: { counts: Record<Severity, number> }) {
  const order: Severity[] = ["error", "warn", "ok", "ignored"];
  return (
    <span className="flex items-center gap-1.5">
      {order.map((s) => (
        <Tooltip
          key={s}
          wide={s === "ignored"}
          content={
            s === "ignored" ? (
              <span className="block">
                <span className="block font-medium text-ink">
                  Ignored by NPHIES
                </span>
                <span className="block">{IGNORED_EXPLANATION}</span>
              </span>
            ) : (
              SEVERITY_LABEL[s]
            )
          }
        >
          <span
            className={cx(
              "inline-flex cursor-help items-center gap-1 rounded-xs px-1 font-mono text-2xs tabular-nums",
              SEV_CHIP[s],
              counts[s] === 0 && "opacity-40",
            )}
          >
            <span aria-hidden="true">{SEVERITY_GLYPH[s]}</span>
            {counts[s]}
            <span className="sr-only">
              {" "}
              {SEVERITY_LABEL[s]}: {counts[s]}
            </span>
          </span>
        </Tooltip>
      ))}
    </span>
  );
}
