import type { Severity } from "./types";

/**
 * Literal class strings per severity. Written out in full (never concatenated)
 * so Tailwind's source scanner can see every class.
 *
 * These four palettes are RESERVED for validator severity. Do not reuse them.
 */

/** Text colour only. */
export const SEV_TEXT: Record<Severity, string> = {
  error: "text-error",
  warn: "text-warn",
  ok: "text-ok",
  ignored: "text-ignored-ink",
  info: "text-ink-2",
};

/** Tinted chip: background + ink. */
export const SEV_CHIP: Record<Severity, string> = {
  error: "bg-error-bg text-error-ink",
  warn: "bg-warn-bg text-warn-ink",
  ok: "bg-ok-bg text-ok-ink",
  ignored: "bg-ignored-bg text-ignored-ink",
  info: "bg-inset text-ink-2",
};

/** Left rule used on finding rows and tree rows. */
export const SEV_RULE: Record<Severity, string> = {
  error: "border-l-error",
  warn: "border-l-warn",
  ok: "border-l-ok",
  ignored: "border-l-line-strong",
  info: "border-l-line",
};

/** Underline treatment for a hit region inside the monospace message pane. */
export const SEV_UNDERLINE: Record<Severity, string> = {
  error: "decoration-error",
  warn: "decoration-warn",
  ok: "decoration-ok",
  ignored: "decoration-ignored",
  info: "decoration-line-strong",
};

/** Dot fill. */
export const SEV_DOT: Record<Severity, string> = {
  error: "bg-error",
  warn: "bg-warn",
  ok: "bg-ok",
  ignored: "bg-ignored",
  info: "bg-ink-3",
};

/**
 * The canonical explanation of the IGNORED state. Ignored is a first-class
 * designed state, not an absence: ~71% of HL7 segment fields are ignored and
 * telling a hospital what it does NOT have to build is a major accelerator.
 */
export const IGNORED_EXPLANATION =
  "NPHIES accepts this element and then discards it. It is not stored, not forwarded and never validated — you do not need to populate it. Sending it is harmless.";
