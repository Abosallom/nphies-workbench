/**
 * The runtime glue between the compiled spec (`src/spec/`), the engine
 * (`structure.ts` / `parse` / `emit` / `check.ts`) and the views.
 *
 * Everything here is async-loading and cached, and nothing here imports React. The rule the
 * engine is built on carries through: a confidently WRONG verdict is worse than an
 * acknowledged unknown, so this layer never invents a structure, never guesses an encoding
 * it cannot evidence, and reports a parse it could not complete rather than checking a tree
 * it does not trust.
 */

import {
  loadConstants,
  loadDatatypes,
  loadErrors,
  loadFields,
  loadGolden,
  loadManifest,
  loadSampleDefects,
  loadSpecDefects,
  loadStructures,
  loadValueSet,
  resolveUseCase,
  type ConstantsBundle,
  type DatatypesBundle,
  type FieldBundle,
  type MessageEncoding,
  type MessageStructure,
  type ResolvedUseCase,
  type SpecFamily,
  type SpecManifest,
  type StructureTree,
  type TreeDiagnostic,
  type UseCaseSummary,
  type VariantContext,
} from "./structure";
import {
  check,
  loadCheckInputs,
  summarise,
  type CheckOptions,
  type CheckSummary,
  type Finding,
} from "./check";
import { parseHl7v2, type Hl7Dialect } from "./parse/hl7v2";
import { parseCda, cdaNamespacesFromConstants } from "./parse/cda";
import { parseFhir } from "./parse/fhir";
import { parseXds } from "./parse/xds";
import { parseSaml } from "./parse/saml";
import { emitHl7v2 } from "./emit/hl7v2";
import { emitCda } from "./emit/cda";
import { emitFhir } from "./emit/fhir";
import { emitXds } from "./emit/xds";
import { emitSaml } from "./emit/saml";

/* ========================================================================== *
 * Use-case registry
 * ========================================================================== */

/** The five navigation families the rail groups by. `saml` becomes `sso`. */
export type UiFamily = "hl7v2" | "fhir" | "cda" | "xds" | "sso";

/** Exactly `src/ui/types.ts` `UseCase`, declared structurally so lib stays view-free. */
export interface UiUseCase {
  id: string;
  family: UiFamily;
  code: string;
  label: string;
  status: "ready" | "partial" | "draft" | "missing";
  blurb?: string;
}

export interface UseCaseEntry {
  summary: UseCaseSummary;
  ui: UiUseCase;
}

export interface Registry {
  manifest: SpecManifest;
  entries: UseCaseEntry[];
  byId: Map<string, UseCaseEntry>;
}

function uiFamilyOf(family: UseCaseSummary["family"]): UiFamily {
  switch (family) {
    case "saml":
      return "sso";
    case "hl7v2":
    case "fhir":
    case "cda":
    case "xds":
      return family;
    default:
      return "cda";
  }
}

/**
 * The short monospace code shown in the rail. Taken from the use case's own variants and
 * structures rather than invented: an ADT use case shows `ADT^A01…A50`, a single-shape one
 * shows its own identity.
 */
const CODE_OVERRIDES: Record<string, string> = {
  adt: "ADT",
  "oru-vitals": "ORU^R01",
  "saml-sso": "SAML",
  "xds-iti18": "ITI-18",
  "xds-iti41": "ITI-41",
  "xds-iti43": "ITI-43",
};

function codeOf(summary: UseCaseSummary): string {
  const override = CODE_OVERRIDES[summary.id];
  if (override) return override;
  const title = summary.title.replace(/^(FHIR|CDA|XDS)\s+/, "");
  return title.length <= 26 ? title : summary.id;
}

/**
 * `status` is the compiler's verdict, carried through unchanged in meaning:
 * `complete` -> ready, `partial` -> partial, `missing` -> missing. A use case with a
 * structure but no official sample is `partial`, never `ready` — nothing round-trip
 * verified it.
 */
function statusOf(summary: UseCaseSummary): UiUseCase["status"] {
  if (summary.status === "missing" || !summary.structureIds.length) return "missing";
  if (summary.status === "partial" || summary.goldenSampleCount === 0) return "partial";
  return "ready";
}

function blurbOf(summary: UseCaseSummary): string {
  const bits: string[] = [summary.title];
  if (summary.variants.length > 1) bits.push(`${summary.variants.length} variants`);
  bits.push(
    summary.goldenSampleCount
      ? `${summary.goldenSampleCount} official sample${summary.goldenSampleCount === 1 ? "" : "s"}`
      : (summary.goldenMissing?.reason ?? "no official sample"),
  );
  return bits.join(" · ");
}

let registryPromise: Promise<Registry> | null = null;

/** The use-case registry, derived from the compiled bundle manifest. Cached. */
export function loadRegistry(): Promise<Registry> {
  if (!registryPromise) {
    registryPromise = (async () => {
      const manifest = await loadManifest();
      const entries: UseCaseEntry[] = manifest.useCases.map((summary) => ({
        summary,
        ui: {
          id: summary.id,
          family: uiFamilyOf(summary.family),
          code: codeOf(summary),
          label: summary.title,
          status: statusOf(summary),
          blurb: blurbOf(summary),
        },
      }));
      const byId = new Map(entries.map((e) => [e.summary.id, e]));
      return { manifest, entries, byId };
    })();
  }
  return registryPromise;
}

/* ========================================================================== *
 * Resolution — one use case, one variant
 * ========================================================================== */

const resolvedCache = new Map<string, Promise<ResolvedUseCase | null>>();

/** `resolveUseCase`, cached per `useCaseId|variant`. */
export function resolve(useCaseId: string, variant?: string): Promise<ResolvedUseCase | null> {
  const key = `${useCaseId}|${variant ?? ""}`;
  let hit = resolvedCache.get(key);
  if (!hit) {
    hit = resolveUseCase(useCaseId, variant);
    resolvedCache.set(key, hit);
  }
  return hit;
}

/** Every structure for a use case, request variants first. */
export async function structuresFor(useCaseId: string): Promise<MessageStructure[]> {
  const resolved = await resolve(useCaseId);
  if (!resolved) return [];
  return [...resolved.structures].sort((a, b) => {
    const da = (a.direction ?? "request") === "request" ? 0 : 1;
    const db = (b.direction ?? "request") === "request" ? 0 : 1;
    return da - db;
  });
}

/* ========================================================================== *
 * Shared bundles the parsers need
 * ========================================================================== */

interface ParseBundles {
  datatypes: DatatypesBundle;
  constants: ConstantsBundle;
  cdaFields: FieldBundle | null;
  xdsFields: FieldBundle | null;
}

let bundlesPromise: Promise<ParseBundles> | null = null;

function loadParseBundles(): Promise<ParseBundles> {
  if (!bundlesPromise) {
    bundlesPromise = (async () => {
      const [datatypes, constants, cdaFields, xdsFields] = await Promise.all([
        loadDatatypes(),
        loadConstants(),
        loadFields("cda").catch(() => null),
        loadFields("xds").catch(() => null),
      ]);
      return { datatypes, constants, cdaFields, xdsFields };
    })();
  }
  return bundlesPromise;
}

/* ========================================================================== *
 * Encoding detection
 * ========================================================================== */

export interface EncodingGuess {
  encoding: MessageEncoding;
  /** Why we think so, shown in the UI rather than asserted silently. */
  because: string;
}

/**
 * Guess how a pasted message is encoded from its first non-blank characters only.
 *
 * Used to warn when a paste plainly does not match the selected use case — never to
 * override the use case's own compiled encoding.
 */
export function detectEncoding(text: string): EncodingGuess {
  const head = text.trimStart().slice(0, 4096);
  if (!head) return { encoding: "unknown", because: "the message is empty" };
  if (head.startsWith("MSH|")) {
    return { encoding: "hl7v2-er7", because: "it starts with an MSH segment" };
  }
  if (head.startsWith("{") || head.startsWith("[")) {
    return { encoding: "fhir-json", because: "it starts with a JSON object" };
  }
  if (/^<\?xml|^</.test(head)) {
    if (/<(\w+:)?(Envelope|envelope)[\s>]/.test(head)) {
      return { encoding: "soap-xml", because: "the document element is a SOAP Envelope" };
    }
    if (/<(\w+:)?(Response|Assertion)[\s>]/.test(head) && /urn:oasis:names:tc:SAML/.test(head)) {
      return { encoding: "saml-xml", because: "it declares a SAML 2.0 namespace" };
    }
    if (/<ClinicalDocument[\s>]/.test(head)) {
      return { encoding: "cda-xml", because: "the document element is a ClinicalDocument" };
    }
    return { encoding: "cda-xml", because: "it is XML, and no SOAP or SAML root was found" };
  }
  return { encoding: "unknown", because: "it matches no format the workbench knows" };
}

/* ========================================================================== *
 * Parse
 * ========================================================================== */

export interface ParseOutcome {
  tree: StructureTree;
  diagnostics: TreeDiagnostic[];
  /** Elements present in the message the compiled spec does not describe. */
  unknownCount: number;
  /** Non-null only when the parser could not produce a tree at all. */
  failure: string | null;
  /** How the message was actually parsed. */
  encoding: MessageEncoding;
  /**
   * The delimiters, escape letters and terminator an HL7 message actually used. Handing this
   * back to the emitter is what makes the round trip byte-identical rather than merely
   * equivalent — and a round trip that is only "equivalent" cannot prove parse and emit are
   * inverses.
   */
  dialect?: Hl7Dialect;
}

/**
 * Parse one message against one structure, dispatching on the structure's own encoding.
 *
 * The parsers are pure and synchronous; the only async work is loading the bundles they
 * consult, which are cached after the first call.
 */
export async function parseMessage(
  text: string,
  structure: MessageStructure,
  resolved: ResolvedUseCase,
): Promise<ParseOutcome> {
  const bundles = await loadParseBundles();
  const encoding = structure.encoding;
  try {
    switch (encoding) {
      case "hl7v2-er7": {
        const r = parseHl7v2(text, structure, {
          datatypes: bundles.datatypes,
          fieldTables: resolved.tables,
          specNodes: resolved.specNodes,
        });
        return {
          tree: r.tree,
          diagnostics: r.diagnostics,
          unknownCount: r.unknown.length,
          failure: null,
          encoding,
          dialect: r.dialect,
        };
      }
      case "cda-xml": {
        const r = parseCda(text, structure, {
          spec: {
            tables: resolved.tables,
            ...(bundles.cdaFields ? { fields: bundles.cdaFields } : {}),
            namespaces: cdaNamespacesFromConstants(bundles.constants),
          },
        });
        return { tree: r.tree, diagnostics: r.diagnostics, unknownCount: r.unknown.length, failure: null, encoding };
      }
      case "fhir-json": {
        const r = parseFhir(text, structure, {
          specNodes: resolved.specNodes,
          allowComments: true,
          allowTrailingCommas: true,
        });
        return { tree: r.tree, diagnostics: r.diagnostics, unknownCount: r.unknown.length, failure: null, encoding };
      }
      case "soap-xml": {
        const r = parseXds(text, structure, {
          specNodes: resolved.specNodes,
          ...(bundles.xdsFields ? { xdsFields: bundles.xdsFields } : {}),
        });
        return { tree: r.tree, diagnostics: r.diagnostics, unknownCount: r.unknown.length, failure: null, encoding };
      }
      case "saml-xml": {
        const r = parseSaml(text, structure, {
          context: { useCaseId: structure.useCaseId, ...(structure.variant ? { variant: structure.variant } : {}) },
        });
        return { tree: r.tree, diagnostics: r.diagnostics, unknownCount: r.unknown.length, failure: null, encoding };
      }
      default:
        return {
          tree: emptyTree(text, structure),
          diagnostics: [],
          unknownCount: 0,
          failure: `The compiled structure for ${structure.id} states no encoding, so the workbench will not guess one.`,
          encoding,
        };
    }
  } catch (err) {
    return {
      tree: emptyTree(text, structure),
      diagnostics: [],
      unknownCount: 0,
      failure: err instanceof Error ? err.message : String(err),
      encoding,
    };
  }
}

function emptyTree(text: string, structure: MessageStructure): StructureTree {
  return {
    structureId: structure.id,
    useCaseId: structure.useCaseId,
    family: structure.family === "saml" ? null : structure.family,
    encoding: structure.encoding,
    text,
    root: {
      id: structure.root.id,
      kind: "message",
      label: structure.root.label,
      locator: null,
      specNodeId: null,
      occurrence: 0,
      value: null,
      present: false,
      loc: null,
      children: [],
    },
    diagnostics: [],
  };
}

/* ========================================================================== *
 * Emit
 * ========================================================================== */

/**
 * Re-serialise a parsed tree.
 *
 * Pass the {@link ParseOutcome} the tree came from and the output is byte-identical to the
 * input: HL7 needs the delimiters the message itself declared, which only the parse knows.
 */
export function emitMessage(
  tree: StructureTree,
  structure: MessageStructure,
  parse?: ParseOutcome,
): string {
  switch (structure.encoding) {
    case "hl7v2-er7":
      return emitHl7v2(tree, structure, parse?.dialect ? { dialect: parse.dialect } : undefined);
    case "cda-xml":
      return emitCda(tree, structure);
    case "fhir-json":
      return emitFhir(tree, structure);
    case "soap-xml":
      return emitXds(tree, structure);
    case "saml-xml":
      return emitSaml(tree, structure);
    default:
      throw new Error(`no emitter for encoding "${structure.encoding}"`);
  }
}

/* ========================================================================== *
 * Check
 * ========================================================================== */

const checkOptionsCache = new Map<string, Promise<CheckOptions>>();

/** `loadCheckInputs` for one structure, cached by structure id. */
export function checkOptionsFor(
  structure: MessageStructure,
  resolved: ResolvedUseCase,
): Promise<CheckOptions> {
  let hit = checkOptionsCache.get(structure.id);
  if (!hit) {
    hit = loadCheckInputs(structure, resolved.specNodes, {
      loadDatatypes,
      loadConstants,
      loadSampleDefects,
      loadStructures: async () => {
        const bundle = await loadStructures();
        return { rules: (bundle as unknown as { rules?: Record<string, unknown> | null }).rules ?? null };
      },
      loadErrors,
      loadValueSet,
    }).then((opts) => ({ ...opts, tables: resolved.tables }));
    checkOptionsCache.set(structure.id, hit);
  }
  return hit;
}

export interface Analysis {
  structure: MessageStructure;
  parse: ParseOutcome;
  findings: Finding[];
  summary: CheckSummary;
  /** Set when the pasted message's shape disagrees with the use case's encoding. */
  encodingMismatch: string | null;
}

/**
 * The whole Check pipeline for one pasted message: parse, then check, then summarise.
 *
 * A parse failure short-circuits the check — running the checker over a tree the parser
 * could not build would produce a page of phantom errors, which is exactly the
 * confidently-wrong verdict the product exists to avoid.
 */
export async function analyse(
  text: string,
  structure: MessageStructure,
  resolved: ResolvedUseCase,
  extra?: { conditions?: readonly string[]; variantContext?: VariantContext },
): Promise<Analysis> {
  const guess = detectEncoding(text);
  const encodingMismatch =
    guess.encoding !== "unknown" && guess.encoding !== structure.encoding
      ? `This looks like ${ENCODING_LABEL[guess.encoding]} — ${guess.because} — but ${structure.title} is ${ENCODING_LABEL[structure.encoding]}.`
      : null;

  const parse = await parseMessage(text, structure, resolved);
  if (parse.failure) {
    return {
      structure,
      parse,
      findings: [],
      summary: summarise([]),
      encodingMismatch,
    };
  }

  const base = await checkOptionsFor(structure, resolved);
  const opts: CheckOptions = {
    ...base,
    ...(extra?.variantContext ? { variantContext: extra.variantContext } : {}),
    ...(extra?.conditions ? { conditions: extra.conditions } : {}),
  };
  const findings = check(parse.tree, structure, opts);
  return { structure, parse, findings, summary: summarise(findings), encodingMismatch };
}

export const ENCODING_LABEL: Record<MessageEncoding, string> = {
  "hl7v2-er7": "HL7 v2.5.1 pipe-delimited",
  "fhir-json": "FHIR R4 JSON",
  "cda-xml": "CDA R2 XML",
  "soap-xml": "SOAP 1.2 XML",
  "saml-xml": "SAML 2.0 XML",
  unknown: "an unknown format",
};

/* ========================================================================== *
 * Golden samples
 * ========================================================================== */

export interface GoldenSample {
  /** Path under `spec-source/`, exactly as the manifest states it. */
  path: string;
  fileName: string;
  useCaseId: string | null;
  bytes: number | null;
  /**
   * Variant tags the compiler read off the sample itself, e.g. `["A03"]`,
   * `["embeddedPdf", "authorDevice", "noImages"]`. A use case with several shapes has one
   * sample per shape, and checking a sample against the wrong one manufactures errors.
   */
  variantTags: string[];
  /** Public URL the app fetches it from. */
  url: string;
}

/** Where the shipped copies of the official samples live, relative to the app base. */
export const GOLDEN_BASE = `${import.meta.env?.BASE_URL ?? "/"}golden/`;

function goldenUrl(path: string): string {
  // `path` is "golden/CDA/nphies Discharge Summary v4.9beta1.xml" — public/ mirrors it.
  const rel = path.replace(/^golden\//, "");
  return GOLDEN_BASE + rel.split("/").map(encodeURIComponent).join("/");
}

let goldenPromise: Promise<Map<string, GoldenSample[]>> | null = null;

/** The official samples, grouped by use case id. */
export function loadGoldenIndex(): Promise<Map<string, GoldenSample[]>> {
  if (!goldenPromise) {
    goldenPromise = (async () => {
      const [bundle, registry] = await Promise.all([loadGolden(), loadRegistry()]);
      const samples = (bundle as { samples?: unknown[] }).samples ?? [];
      const byPath = new Map<string, { bytes: number | null; variantTags: string[] }>();
      for (const raw of samples) {
        const s = raw as { path?: string; bytes?: number; variant?: unknown };
        if (!s.path) continue;
        byPath.set(s.path, {
          bytes: typeof s.bytes === "number" ? s.bytes : null,
          variantTags: Array.isArray(s.variant) ? s.variant.map(String) : s.variant ? [String(s.variant)] : [],
        });
      }
      const out = new Map<string, GoldenSample[]>();
      for (const entry of registry.entries) {
        const list: GoldenSample[] = entry.summary.goldenSamples.map((path) => ({
          path,
          fileName: path.split("/").pop() ?? path,
          useCaseId: entry.summary.id,
          bytes: byPath.get(path)?.bytes ?? null,
          variantTags: byPath.get(path)?.variantTags ?? [],
          url: goldenUrl(path),
        }));
        if (list.length) out.set(entry.summary.id, list);
      }
      return out;
    })();
  }
  return goldenPromise;
}

const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The structure an official sample should be checked against.
 *
 * `cda-rad-result` has two shapes — a structured report and one wrapping an embedded PDF —
 * and one official sample of each. Checking the PDF sample against the structured shape
 * reports a missing `structuredBody` that is not missing at all, so the variant tag on the
 * sample decides. With no usable tag this returns `null` rather than defaulting to the first
 * structure and inventing findings from the mismatch.
 */
export function structureForSample(
  structures: readonly MessageStructure[],
  sample: Pick<GoldenSample, "variantTags">,
): MessageStructure | null {
  if (structures.length === 1) return structures[0];
  const tags = sample.variantTags.map(norm);
  for (const tag of tags) {
    const hit = structures.find((s) => s.variant && norm(s.variant) === tag);
    if (hit) return hit;
  }
  // A sample tagged only by direction ("request" / "response") still settles a SOAP pair.
  for (const tag of tags) {
    const hit = structures.find((s) => (s.direction ?? "request") === tag);
    if (hit) return hit;
  }
  return tags.length ? null : (structures.find((s) => (s.direction ?? "request") === "request") ?? structures[0]);
}

/** Fetch one shipped golden sample's text. */
export async function fetchGolden(sample: GoldenSample): Promise<string> {
  const res = await fetch(sample.url);
  if (!res.ok) {
    throw new Error(
      `the official sample "${sample.fileName}" is not available in this build (HTTP ${res.status}). ` +
        `Run "npm run samples" to copy spec-source/golden into public/.`,
    );
  }
  return res.text();
}

/* ========================================================================== *
 * Spec defects — surfaced, never silently applied
 * ========================================================================== */

export async function loadDefects(): Promise<{
  spec: Awaited<ReturnType<typeof loadSpecDefects>>;
  samples: Record<string, unknown>;
}> {
  const [spec, samples] = await Promise.all([loadSpecDefects(), loadSampleDefects()]);
  return { spec, samples };
}

export type { Finding, CheckSummary, MessageStructure, ResolvedUseCase, SpecFamily };
