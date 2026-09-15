import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { cx } from "./cx";
import { FAMILIES, type Family, type UseCase } from "./types";
import { UseCaseStatusDot } from "./StatusDot";

export interface UseCaseRailProps {
  useCases: UseCase[];
  selectedId: string | null;
  onSelect: (useCase: UseCase) => void;
  /** Controlled filter text, if the host wants to own it. */
  query?: string;
  onQueryChange?: (q: string) => void;
  className?: string;
}

export interface UseCaseRailHandle {
  /** Focus the filter box (the shell binds "/" to this). */
  focusFilter: () => void;
}

interface Row {
  kind: "group" | "item";
  family: Family;
  useCase?: UseCase;
}

function matches(uc: UseCase, q: string): boolean {
  if (!q) return true;
  const hay = `${uc.code} ${uc.label} ${uc.id}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

/**
 * The left rail: 26 use cases grouped by family, each with a spec-status dot.
 * Groups collapse, the whole list is arrow-key navigable, and typing in the
 * filter narrows it (auto-expanding any group that still has matches).
 */
export const UseCaseRail = forwardRef<UseCaseRailHandle, UseCaseRailProps>(
  function UseCaseRail(
    { useCases, selectedId, onSelect, query, onQueryChange, className },
    ref,
  ) {
    const [localQuery, setLocalQuery] = useState("");
    const q = query ?? localQuery;
    const setQuery = onQueryChange ?? setLocalQuery;

    const [collapsed, setCollapsed] = useState<Set<Family>>(new Set());
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(ref, () => ({
      focusFilter: () => inputRef.current?.focus(),
    }));

    const byFamily = useMemo(() => {
      const m = new Map<Family, UseCase[]>();
      for (const f of FAMILIES) m.set(f.id, []);
      for (const uc of useCases) {
        if (!matches(uc, q)) continue;
        m.get(uc.family)?.push(uc);
      }
      return m;
    }, [useCases, q]);

    /** Flat list of focusable rows, for arrow-key navigation. */
    const rows = useMemo(() => {
      const out: Row[] = [];
      for (const fam of FAMILIES) {
        const items = byFamily.get(fam.id) ?? [];
        if (items.length === 0) continue;
        out.push({ kind: "group", family: fam.id });
        // While filtering, a collapsed group still opens if it has matches.
        if (!collapsed.has(fam.id) || q) {
          for (const uc of items) out.push({ kind: "item", family: fam.id, useCase: uc });
        }
      }
      return out;
    }, [byFamily, collapsed, q]);

    const focusRow = useCallback((i: number) => {
      const els = listRef.current?.querySelectorAll<HTMLElement>("[data-rail-row]");
      if (!els || els.length === 0) return;
      const j = Math.max(0, Math.min(els.length - 1, i));
      els[j].focus();
    }, []);

    const toggle = useCallback((f: Family, open?: boolean) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        const shouldOpen = open ?? next.has(f);
        if (shouldOpen) next.delete(f);
        else next.add(f);
        return next;
      });
    }, []);

    const total = useCases.length;
    const shown = rows.filter((r) => r.kind === "item").length;

    return (
      <nav
        aria-label="Use cases"
        className={cx(
          "flex h-full w-60 shrink-0 flex-col border-r border-line bg-raised",
          className,
        )}
      >
        <div className="shrink-0 border-b border-line p-1.5">
          <label htmlFor="rail-filter" className="sr-only">
            Filter use cases
          </label>
          <input
            id="rail-filter"
            ref={inputRef}
            type="search"
            value={q}
            placeholder={"Filter use cases…"}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                focusRow(0);
              } else if (e.key === "Escape") {
                setQuery("");
              }
            }}
            className="h-6 w-full rounded-sm border border-line bg-surface px-2 text-xs text-ink placeholder:text-ink-3"
          />
        </div>

        <div
          ref={listRef}
          role="tree"
          aria-label="NPHIES use cases"
          className="min-h-0 flex-1 overflow-auto py-1"
          onKeyDown={(e) => {
            const els = listRef.current?.querySelectorAll<HTMLElement>(
              "[data-rail-row]",
            );
            if (!els) return;
            const i = Array.prototype.indexOf.call(els, document.activeElement);
            if (i < 0) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              focusRow(i + 1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              if (i === 0) inputRef.current?.focus();
              else focusRow(i - 1);
            } else if (e.key === "Home") {
              e.preventDefault();
              focusRow(0);
            } else if (e.key === "End") {
              e.preventDefault();
              focusRow(els.length - 1);
            }
          }}
        >
          {rows.length === 0 ? (
            <p className="px-3 py-4 text-xs text-ink-3">
              No use case matches &ldquo;{q}&rdquo;.
            </p>
          ) : null}

          {rows.map((row, i) => {
            if (row.kind === "group") {
              const fam = FAMILIES.find((f) => f.id === row.family)!;
              const count = byFamily.get(row.family)?.length ?? 0;
              const open = !collapsed.has(row.family) || !!q;
              return (
                <button
                  key={`g:${row.family}`}
                  data-rail-row
                  type="button"
                  role="treeitem"
                  aria-expanded={open}
                  aria-level={1}
                  tabIndex={-1}
                  onClick={() => toggle(row.family)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowRight") {
                      e.preventDefault();
                      toggle(row.family, true);
                    } else if (e.key === "ArrowLeft") {
                      e.preventDefault();
                      toggle(row.family, false);
                    } else if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle(row.family);
                    }
                  }}
                  className={cx(
                    "flex w-full items-center gap-1.5 px-2 py-1 text-left",
                    "text-2xs font-semibold uppercase tracking-wider text-ink-3",
                    "hover:bg-inset hover:text-ink-2",
                    i > 0 && "mt-1",
                  )}
                >
                  <span aria-hidden="true" className="font-mono text-2xs">
                    {open ? "▾" : "▸"}
                  </span>
                  <span className="flex-1 truncate">{fam.label}</span>
                  <span className="font-mono tabular-nums opacity-70">
                    {count}
                  </span>
                </button>
              );
            }

            const uc = row.useCase!;
            const active = uc.id === selectedId;
            return (
              <button
                key={uc.id}
                data-rail-row
                type="button"
                role="treeitem"
                aria-level={2}
                aria-selected={active}
                tabIndex={-1}
                title={uc.blurb}
                onClick={() => onSelect(uc)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(uc);
                  }
                }}
                className={cx(
                  "flex w-full items-center gap-2 border-l-2 py-1 pl-4 pr-2 text-left text-xs",
                  active
                    ? "border-l-accent bg-sel text-ink"
                    : "border-l-transparent text-ink-2 hover:bg-inset hover:text-ink",
                )}
              >
                <UseCaseStatusDot status={uc.status} />
                <span className="min-w-0 flex-1 truncate">{uc.label}</span>
                <code className="shrink-0 font-mono text-2xs text-ink-3">
                  {uc.code}
                </code>
              </button>
            );
          })}
        </div>

        <div className="shrink-0 border-t border-line px-2 py-1 text-2xs text-ink-3 tabular-nums">
          {shown === total ? `${total} use cases` : `${shown} of ${total}`}
        </div>
      </nav>
    );
  },
);
