import { useRef, type ReactNode } from "react";
import { cx } from "./cx";

export interface TabItem {
  id: string;
  label: string;
  /** Shown after the label, e.g. a finding count. */
  badge?: ReactNode;
  disabled?: boolean;
  /** Rendered with a divider before it — used for the two GLOBAL entries. */
  startsGroup?: boolean;
  title?: string;
}

export interface TabsProps {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  "aria-label": string;
  className?: string;
}

/**
 * Roving-tabindex tablist. Arrow keys move, Home/End jump, Enter/Space select.
 * Panels are rendered by the caller; wire them with id/aria-controls if needed.
 */
export function Tabs({
  items,
  activeId,
  onChange,
  "aria-label": ariaLabel,
  className,
}: TabsProps) {
  const ref = useRef<HTMLDivElement>(null);

  function move(delta: number, from: number) {
    const n = items.length;
    for (let step = 1; step <= n; step++) {
      const i = (((from + delta * step) % n) + n) % n;
      if (!items[i].disabled) {
        onChange(items[i].id);
        const el = ref.current?.querySelectorAll<HTMLButtonElement>(
          '[role="tab"]',
        )[i];
        el?.focus();
        return;
      }
    }
  }

  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      className={cx("flex items-stretch gap-0.5", className)}
    >
      {items.map((it, i) => {
        const active = it.id === activeId;
        return (
          <div key={it.id} className="flex items-center">
            {it.startsGroup ? (
              <span aria-hidden="true" className="mx-1.5 h-4 w-px bg-line" />
            ) : null}
            <button
              type="button"
              role="tab"
              title={it.title}
              aria-selected={active}
              aria-disabled={it.disabled || undefined}
              tabIndex={active ? 0 : -1}
              disabled={it.disabled}
              onClick={() => !it.disabled && onChange(it.id)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight") {
                  e.preventDefault();
                  move(1, i);
                } else if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  move(-1, i);
                } else if (e.key === "Home") {
                  e.preventDefault();
                  move(1, -1);
                } else if (e.key === "End") {
                  e.preventDefault();
                  move(-1, 0);
                }
              }}
              className={cx(
                "relative inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium",
                "transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                active
                  ? "bg-accent-soft text-accent"
                  : "text-ink-2 hover:bg-inset hover:text-ink",
              )}
            >
              {it.label}
              {it.badge}
            </button>
          </div>
        );
      })}
    </div>
  );
}
