/**
 * Test harness: run the REAL engine (`src/lib/**.ts`) under Node.
 *
 * `jiti` compiles the TypeScript on the fly, and `setSpecResolver` replaces Vite's
 * `import.meta.glob` bundle loader with plain file reads, so the code under test is byte
 * for byte the code the app ships — no reimplementation, which is the whole point: a test
 * that re-derives the rules cannot catch the engine getting them wrong.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SPEC_DIR = path.join(ROOT, "src", "spec");
export const GOLDEN_DIR = path.join(ROOT, "spec-source");

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: true });

let engine = null;

/**
 * No suite that uses this harness may reach the network.
 *
 * Every score the product publishes — round trips, unaccounted-for errors, the mutation
 * floors — must depend on the compiled specification alone. The AI layer lives beside the
 * engine, never inside it, and this is the mechanical guarantee: a test that accidentally
 * called a model would throw here instead of quietly producing a number that varies with a
 * remote service. Browser and SSR suites use their own drivers and are unaffected.
 */
globalThis.fetch = async (input) => {
  throw new Error(
    `network access is disabled under the engine test harness (attempted ${String(
      typeof input === "string" ? input : (input && input.url) || input,
    )})`,
  );
};

/** Load the engine once, wired to read `src/spec/` from disk. */
export async function loadEngine() {
  if (engine) return engine;
  const structure = await jiti.import(path.join(ROOT, "src/lib/structure.ts"));
  structure.setSpecResolver(async (rel) => {
    const file = path.join(SPEC_DIR, rel);
    return JSON.parse(await fs.promises.readFile(file, "utf8"));
  });
  const [check, workbench, adapt] = await Promise.all([
    jiti.import(path.join(ROOT, "src/lib/check.ts")),
    jiti.import(path.join(ROOT, "src/lib/workbench.ts")),
    jiti.import(path.join(ROOT, "src/lib/adapt.ts")),
  ]);
  engine = { structure, check, workbench, adapt };
  return engine;
}

/** Read an official sample by its manifest-relative path (`golden/CDA/…`). */
export function readGolden(rel) {
  return fs.readFileSync(path.join(GOLDEN_DIR, rel), "utf8");
}

export function goldenExists(rel) {
  return fs.existsSync(path.join(GOLDEN_DIR, rel));
}
