/**
 * NEGATIVE fixture — this file MUST NOT compile.
 *
 * `tests/advisory.test.mjs` runs tsc over it and asserts failure. An Advisory has no
 * severity, code, provenance, location or path, so every finding-consuming function rejects
 * it at compile time. If this file ever compiles, a model's output has become admissible as a
 * verdict and the boundary the product rests on is gone.
 */
import { sortFindings, summarise } from "../../src/lib/findings";
import type { Advisory } from "../../src/lib/advisory";

declare const advisory: Advisory;

export const summary = summarise([advisory]);
export const sorted = sortFindings([advisory]);
