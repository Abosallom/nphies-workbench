import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "ghost" | "danger";
  size?: "xs" | "sm";
  /** Leading glyph. Keep it a character or a tiny inline SVG. */
  icon?: ReactNode;
  children?: ReactNode;
}

const VARIANT: Record<string, string> = {
  default:
    "border-line bg-surface text-ink hover:bg-inset active:bg-inset disabled:hover:bg-surface",
  primary:
    "border-transparent bg-accent text-accent-ink hover:opacity-90 active:opacity-80",
  ghost:
    "border-transparent bg-transparent text-ink-2 hover:bg-inset hover:text-ink",
  /* `danger` uses the error hue for a DESTRUCTIVE ACTION, which is the one
     non-validator use we allow; it never appears next to a finding. */
  danger: "border-line bg-surface text-error hover:bg-error-bg",
};

export function Button({
  variant = "default",
  size = "sm",
  icon,
  children,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-sm border font-medium",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        size === "xs" ? "h-5 px-1.5 text-2xs" : "h-6 px-2 text-xs",
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {icon ? (
        <span aria-hidden="true" className="inline-flex shrink-0">
          {icon}
        </span>
      ) : null}
      {children}
    </button>
  );
}
