import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "ghost" | "danger" | "ai";
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
  /* `ai` marks the ONLY controls that send anything to a model. One hue, a glow, on every one
     of them and on nothing else — the look is the disclosure, before the copy is even read. */
  ai: "ai-glow border-transparent bg-ai text-ai-ink hover:brightness-110 disabled:animate-none",
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
      // Every control that reaches a model is discoverable as such — by tests, and by anyone
      // auditing the page for what can send data out of the browser.
      data-ai={variant === "ai" ? "true" : undefined}
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
