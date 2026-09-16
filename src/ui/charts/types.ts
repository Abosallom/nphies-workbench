/**
 * Shapes the chart primitives take.
 *
 * Declared here, ahead of the components and ahead of the transform that feeds them, so the
 * two sides cannot drift: `src/lib/adapt.ts` produces these and `src/ui/charts/*` renders
 * them, and neither knows anything about the other's domain.
 *
 * NOTHING here knows about HL7, FHIR, CDA or SOAP.
 */

import type { Severity } from "../types";

/* ------------------------------------------------------------ categorical -- */

/**
 * The four categorical slots, assigned in FIXED ORDER and never cycled.
 *
 * They exist because the severity palette is reserved: red/amber/green/grey encode a
 * validator verdict and nothing else, and the accent blue means "selected". These four were
 * chosen in the remaining hue space and validated against both surfaces — lightness band,
 * chroma floor, colour-blind separation, normal-vision separation and contrast all pass.
 * A fifth series folds into "other"; it never gets a generated hue.
 */
export type CategorySlot = 1 | 2 | 3 | 4;

export const CATEGORY_VAR: Record<CategorySlot, string> = {
  1: "var(--color-cat-1)",
  2: "var(--color-cat-2)",
  3: "var(--color-cat-3)",
  4: "var(--color-cat-4)",
};

/* --------------------------------------------------------------- segments -- */

/** One slice of a proportion bar or donut. */
export interface Segment {
  id: string;
  label: string;
  value: number;
  /**
   * How this slice is coloured. `severity` is legitimate ONLY where the category IS a
   * verdict — an obligation such as "must build" literally means "error if missing". Anything
   * else takes a categorical slot.
   */
  tone: { kind: "severity"; severity: Severity } | { kind: "category"; slot: CategorySlot };
  /** Shown in the hover tooltip under the label. */
  detail?: string;
}

/* ---------------------------------------------------------------- anatomy -- */

/**
 * One block of a message's anatomy — a segment, a header element, a bundle entry, a SOAP part.
 * Which of those it is depends on the family, and that decision is made in `src/lib`, not here.
 */
export interface AnatomyBlock {
  /** The `TreeNode` id. Doubles as the id to select, so a click needs no lookup table. */
  id: string;
  /** Short wire label, e.g. `PID`, `recordTarget`, `entry[3]`. */
  label: string;
  /** Secondary label from the spec, e.g. "Patient Identification". */
  detail?: string;
  /** Descendants including itself — drives the block's size. */
  nodeCount: number;
  /** Length of the block's source span in characters. */
  bytes: number;
  /** 1-based line the block starts on. */
  firstLine: number;
  /** Worst severity among the findings inside this block; `info` when it has none. */
  severity: Severity;
  /** Region to select in the code pane, when the block has one. */
  regionId?: string;
  /** How many findings of each severity sit inside the block. */
  counts: Record<Severity, number>;
}
