/**
 * POSITIVE control for `advisory-is-not-a-finding.ts`: the same call with a real Finding
 * compiles, proving the negative fixture fails for the reason claimed and not because the
 * tsc invocation is broken.
 */
import { sortFindings, summarise } from "../../src/lib/findings";
import type { Finding } from "../../src/lib/findings";

declare const finding: Finding;

export const summary = summarise([finding]);
export const sorted = sortFindings([finding]);
