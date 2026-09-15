/** Tiny class-name joiner. No dependency, no variants engine. */
export function cx(
  ...parts: Array<string | false | null | undefined>
): string {
  let out = "";
  for (const p of parts) {
    if (!p) continue;
    out = out ? out + " " + p : p;
  }
  return out;
}
