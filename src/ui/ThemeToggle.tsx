import { cx } from "./cx";
import type { ThemeChoice } from "./useTheme";

const OPTIONS: Array<{ id: ThemeChoice; label: string; glyph: string }> = [
  { id: "system", label: "Match system", glyph: "◑" },
  { id: "light", label: "Light", glyph: "☀" },
  { id: "dark", label: "Dark", glyph: "☾" },
];

export interface ThemeToggleProps {
  theme: ThemeChoice;
  onChange: (t: ThemeChoice) => void;
  className?: string;
}

/** Three-way segmented control: system / light / dark. */
export function ThemeToggle({ theme, onChange, className }: ThemeToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cx(
        "inline-flex items-center rounded-sm border border-line bg-surface p-px",
        className,
      )}
    >
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={theme === o.id}
          aria-label={o.label}
          title={o.label}
          onClick={() => onChange(o.id)}
          className={cx(
            "inline-flex h-5 w-6 items-center justify-center rounded-xs text-xs transition-colors",
            theme === o.id
              ? "bg-accent-soft text-accent"
              : "text-ink-3 hover:text-ink",
          )}
        >
          <span aria-hidden="true">{o.glyph}</span>
        </button>
      ))}
    </div>
  );
}
