/**
 * Chart primitives. Hand-written inline SVG, no chart library.
 *
 * Presentational only: they render `Segment[]` and `AnatomyBlock[]` from `./types` and
 * know nothing about where those came from. Colour is reserved the same way it is
 * everywhere else in `src/ui`: severity tokens encode a verdict, the accent means
 * "selected", and identity otherwise comes from the four categorical slots.
 */

export * from "./types";

export { ProportionBar } from "./ProportionBar";
export type { ProportionBarProps } from "./ProportionBar";

export { Donut } from "./Donut";
export type { DonutProps } from "./Donut";

export { MiniBars } from "./MiniBars";
export type { MiniBarsProps, MiniBarRow } from "./MiniBars";

export { AnatomyMap } from "./AnatomyMap";
export type { AnatomyMapProps } from "./AnatomyMap";
