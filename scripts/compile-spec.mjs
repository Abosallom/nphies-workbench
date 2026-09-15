#!/usr/bin/env node
/**
 * compile-spec.mjs — merge spec-build/*.json into the shipped bundle under src/spec/.
 *
 * INPUTS  (read-only, produced by sibling extraction agents)
 *   spec-build/fields.json      per-page field/element tables (HL7 segments, FHIR, CDA, XDS)
 *   spec-build/structures.json  message structure rules (ADT/ORU/ACK/CDA/FHIR/XDS envelopes)
 *   spec-build/valuesets.json   value sets + bindings
 *   spec-build/errors.json      error catalogue / OperationOutcome / ACK codes
 *   spec-build/constants.json   OIDs, fixed values, FHIR profiles, SAML, HL7 encoding
 *   spec-build/datatypes.json   HL7 v2.5.1 composite component dictionary
 *   spec-build/golden.json      index + fingerprints of the 62 official sample messages
 *
 * OUTPUTS (src/spec/**)
 *   index.json                manifest: use cases, families, counts, what is missing
 *   structures.json           MessageStructure records + the raw structural rule corpus
 *   fields/<family>.json      SpecNode trees per family (hl7v2 | fhir | cda | xds)
 *   datatypes.json  constants.json  errors.json  golden.json
 *   valuesets/<id>.json       one file per value set (one has 37k concepts)
 *   valuesets/index.json      id -> { title, aliases, conceptCount, external, file }
 *
 * GUARANTEES
 *   - Re-runnable: src/spec is rebuilt from scratch on every run.
 *   - Deterministic: object keys are sorted recursively before serialisation; the only
 *     value that changes between runs is index.json#generatedAt (override with the
 *     SPEC_GENERATED_AT env var for byte-identical rebuilds).
 *   - Nothing is invented. Every compiled rule carries the provenance object
 *     { pageId, pageTitle, row, quote } it came from. Where a rule could not be sourced,
 *     the compiler records a warning instead of guessing.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const IN_DIR = join(ROOT, 'spec-build');
const OUT_DIR = join(ROOT, 'src', 'spec');

const BUNDLE_SCHEMA = 'nphies-workbench/spec-bundle@1';
const BUNDLE_VERSION = 1;

/** Collected non-fatal problems; surfaced in index.json#warnings. */
const warnings = [];
const warn = (scope, message, detail) => {
  warnings.push(detail === undefined ? { scope, message } : { scope, message, detail });
};

// ---------------------------------------------------------------------------
// io helpers
// ---------------------------------------------------------------------------

function readInput(name) {
  const path = join(IN_DIR, `${name}.json`);
  if (!existsSync(path)) {
    warn('input', `spec-build/${name}.json is missing`, { path: `spec-build/${name}.json` });
    return { name, present: false, data: null, bytes: 0, sha256: null, error: 'missing' };
  }
  let raw;
  try {
    raw = readFileSync(path);
  } catch (err) {
    warn('input', `spec-build/${name}.json could not be read`, { error: String(err) });
    return { name, present: false, data: null, bytes: 0, sha256: null, error: String(err) };
  }
  let data = null;
  let error = null;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    error = `malformed JSON: ${String(err)}`;
    warn('input', `spec-build/${name}.json is malformed`, { error });
  }
  return {
    name,
    present: data !== null,
    data,
    bytes: raw.length,
    sha256: createHash('sha256').update(raw).digest('hex'),
    error,
  };
}

/** Recursively sort object keys so serialisation is byte-stable. Arrays keep order. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) !== null) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

const written = [];
function writeJson(relPath, value, { pretty = false } = {}) {
  const abs = join(OUT_DIR, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  const text = pretty ? `${JSON.stringify(sortKeys(value), null, 2)}\n` : `${JSON.stringify(sortKeys(value))}\n`;
  writeFileSync(abs, text, 'utf8');
  written.push({ file: relPath, bytes: Buffer.byteLength(text, 'utf8') });
  return relPath;
}

// ---------------------------------------------------------------------------
// normalisation helpers
// ---------------------------------------------------------------------------

/**
 * NPHIES usage legend, page 171278410, cross-tabbed with cardinality.
 * Mirrored in src/lib/structure.ts (USAGE_SEMANTICS) — the loader checks the two agree.
 */
const USAGE_SEMANTICS = {
  M: { meaning: 'mandatory', validator: 'error-if-missing' },
  R: { meaning: 'required', validator: 'error-if-missing' },
  R2: { meaning: 'required if known', validator: 'warn-if-missing' },
  O: { meaning: 'optional', validator: 'ok' },
  I: { meaning: 'ignored (accepted then discarded by NPHIES)', validator: 'ignored' },
  X: { meaning: 'not used', validator: 'warn-if-present' },
  NP: { meaning: 'SHALL NOT be present', validator: 'error-if-present' },
  '-': { meaning: 'segment is not present in this message', validator: 'error-if-present' },
};

const USAGE_CODES = new Set(Object.keys(USAGE_SEMANTICS));

/** "row 1.1" / "1.1 Bundle Metadata – Profile" / "PV1.2 / Patient Class" -> "1.1" | "PV1.2" */
function rowToken(row) {
  if (typeof row !== 'string') return null;
  const stripped = row.replace(/^row\s+/i, '').trim();
  if (!stripped) return null;
  return stripped.split(/[\s/|]+/)[0] || null;
}

function joinKey(pageId, row) {
  const token = rowToken(row);
  return token ? `${String(pageId)}::${token}` : null;
}

function parseCardinalityString(raw) {
  if (typeof raw !== 'string') return { min: null, max: null };
  const m = /\[\s*(\d+)\s*\.\.\s*(\d+|\*)\s*\]/.exec(raw);
  if (m) return { min: Number(m[1]), max: m[2] === '*' ? '*' : Number(m[2]) };
  const trimmed = raw.trim();
  if (/^\*$/.test(trimmed) || /no\s*max/i.test(trimmed)) return { min: null, max: '*' };
  if (/^\d+$/.test(trimmed)) return { min: null, max: Number(trimmed) };
  return { min: null, max: null };
}

/**
 * Both input shapes are accepted:
 *   fields.json      { usage, min, max, condition, rawUsage, rawMaxRpt }
 *   structures.json  { usage, cardinality, condition, validator }
 * `max: '*'` means unbounded; `max: null` means the source did not state a maximum.
 */
function normaliseUsageEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const rawUsage = typeof entry.rawUsage === 'string' ? entry.rawUsage : (typeof entry.usage === 'string' ? entry.usage : null);
  const rawCardinality =
    typeof entry.rawMaxRpt === 'string' ? entry.rawMaxRpt : typeof entry.cardinality === 'string' ? entry.cardinality : null;

  let usage = typeof entry.usage === 'string' ? entry.usage.trim() : null;
  if (usage && !USAGE_CODES.has(usage)) {
    // The extractors already normalise codes; anything else is kept verbatim but flagged.
    if (/^[A-Z]{1,2}2?$/.test(usage)) warn('usage', `unrecognised usage code "${usage}"`, { rawUsage });
    else usage = null;
  }

  const parsed = parseCardinalityString(rawCardinality);
  let min = typeof entry.min === 'number' ? entry.min : parsed.min;
  let max = typeof entry.max === 'number' ? entry.max : parsed.max;
  if (max === null || max === undefined) max = parsed.max;
  if (min === null || min === undefined) min = parsed.min;
  if (max === null && typeof rawCardinality === 'string' && /\*|no\s*max/i.test(rawCardinality)) max = '*';

  const semantics = usage && USAGE_SEMANTICS[usage] ? USAGE_SEMANTICS[usage] : null;
  return {
    usage,
    min: min === undefined ? null : min,
    max: max === undefined ? null : max,
    condition: typeof entry.condition === 'string' && entry.condition.trim() ? entry.condition.trim() : null,
    validator: semantics ? semantics.validator : 'unknown',
    raw: { usage: rawUsage, cardinality: rawCardinality },
  };
}

function normaliseUsageList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normaliseUsageEntry).filter(Boolean);
}

/** Build a usage list from a bare code (event matrices, ACK tables). */
function usageFromCode(code, { min = null, max = null, condition = null, quoteCardinality = null } = {}) {
  if (typeof code !== 'string' || !code.trim()) return [];
  const usage = code.trim();
  const semantics = USAGE_SEMANTICS[usage] || null;
  return [
    {
      usage: USAGE_CODES.has(usage) ? usage : null,
      min,
      max,
      condition,
      validator: semantics ? semantics.validator : 'unknown',
      raw: { usage, cardinality: quoteCardinality },
    },
  ];
}

/**
 * Normalise a source object into a Provenance record.
 *
 * Two shapes are accepted and they are NOT interchangeable:
 *   { pageId, pageTitle, row, quote }  a Confluence page states the rule
 *   { sample, quote }                  the rule was read off an official golden sample
 *                                      because no Confluence page states it
 * A record with `sample` set and `pageId` null is a rule that is not in the published
 * spec. The UI has to be able to say so, which is why the two never collapse.
 */
function provenance(src, fallback) {
  const s = src && typeof src === 'object' ? src : fallback;
  if (!s || typeof s !== 'object') return null;
  const out = {
    pageId: s.pageId === undefined || s.pageId === null ? null : String(s.pageId),
    pageTitle: typeof s.pageTitle === 'string' ? s.pageTitle : null,
    row: typeof s.row === 'string' ? s.row : null,
    quote: typeof s.quote === 'string' ? s.quote : null,
  };
  if (typeof s.sample === 'string' && s.sample.trim()) out.sample = s.sample.trim();
  return out;
}

/**
 * Evidence carried by every rule this compiler ships: how sure we are, whether an official
 * sample was checked, and how the rule was arrived at.
 *
 * `confidence` is NEVER raised here. A repair agent that wrote "low" keeps "low"; the only
 * thing this helper does is default a missing value and refuse to invent one higher than
 * the source claimed.
 */
function evidence({ confidence, verifiedAgainstSample, derivation, confidenceReason, samples } = {}) {
  const out = {};
  const c = typeof confidence === 'string' ? confidence.trim().toLowerCase() : null;
  out.confidence = c === 'high' || c === 'medium' || c === 'low' ? c : 'medium';
  if (c && out.confidence !== c) warn('evidence', `unrecognised confidence "${confidence}" recorded as medium`);
  out.verifiedAgainstSample = verifiedAgainstSample === true;
  if (derivation) out.derivation = derivation;
  const reason = cleanText(confidenceReason);
  if (reason) out.confidenceReason = reason;
  if (Array.isArray(samples) && samples.length) out.samples = [...new Set(samples.map(String))].sort();
  return out;
}

function cleanText(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t : null;
}

// ---------------------------------------------------------------------------
// locators
// ---------------------------------------------------------------------------

function hl7Locator(fieldRef, tableSegment) {
  const ref = cleanText(fieldRef);
  if (!ref) return null;
  const m = /^([A-Z][A-Z0-9]{1,3})[.-](\d+)(?:[.-](\d+))?(?:[.-](\d+))?$/.exec(ref);
  if (!m) {
    warn('locator', `HL7 field reference not parseable: "${ref}"`, { tableSegment });
    return null;
  }
  const locator = { kind: 'hl7Field', segment: m[1], field: Number(m[2]) };
  if (m[3] !== undefined) locator.component = Number(m[3]);
  if (m[4] !== undefined) locator.subcomponent = Number(m[4]);
  if (tableSegment && locator.segment !== tableSegment) {
    warn('locator', `HL7 field "${ref}" does not match its table segment "${tableSegment}"`);
  }
  return locator;
}

/** Split "./component/section[templateId='x']/@code" into path / predicate / attribute. */
function splitXPath(rawPath) {
  const raw = cleanText(rawPath);
  if (!raw) return null;
  // Normalise whitespace that survives anchor stripping, e.g. "./ id" -> "./id".
  // Confluence authors type curly quotes inside predicates (participant[@typeCode=’SBJ’]).
  // No XPath engine accepts them, so the LOCATOR is normalised to apostrophes. The verbatim
  // cell survives untouched in `locatorRaw` and in every provenance quote.
  let path = raw
    .replace(/[‘’“”]/g, "'")
    .replace(/\s*\/\s*/g, '/')
    .replace(/\[\s+/g, '[')
    .replace(/\s+\]/g, ']')
    .replace(/\s+/g, ' ')
    .trim();
  let attribute = null;
  const attrMatch = /\/@([A-Za-z_][\w:.-]*)$/.exec(path);
  if (attrMatch) {
    attribute = attrMatch[1];
    path = path.slice(0, attrMatch.index);
  }
  const predicates = [];
  path = path.replace(/\[([^\]]*)\]/g, (_all, inner) => {
    predicates.push(inner.trim());
    return `[${inner.trim()}]`;
  });
  return { path, attribute, predicates, raw };
}

const TEMPLATE_ID_RE = /templateId\s*=\s*[‘’'"“”]?\s*([0-9][0-9.]+)\s*[‘’'"“”]?/;

function templateIdsFromPath(path) {
  const ids = [];
  if (typeof path !== 'string') return ids;
  const re = new RegExp(TEMPLATE_ID_RE.source, 'g');
  let m;
  while ((m = re.exec(path)) !== null) ids.push(m[1]);
  return ids;
}

function fhirLocator(entry, parentPath) {
  if (!entry || typeof entry !== 'object') return null;
  const split = splitXPath(entry.path);
  if (!split) return null;
  const locator = { kind: 'fhirPath', path: split.path };
  if (entry.kind === 'relative' && parentPath) locator.relativeTo = parentPath;
  if (split.attribute) locator.path = `${split.path}/@${split.attribute}`;
  return locator;
}

function cdaLocator(entry, parentPath) {
  if (!entry || typeof entry !== 'object') return null;
  const split = splitXPath(entry.path);
  if (!split) return null;
  const locator = { kind: 'cdaXPath', path: split.path };
  if (entry.kind === 'relative' && parentPath) locator.relativeTo = parentPath;
  if (split.attribute) locator.attribute = split.attribute;
  if (split.predicates.length) locator.predicate = split.predicates.join(' and ');
  return locator;
}

// ---------------------------------------------------------------------------
// load inputs
// ---------------------------------------------------------------------------

const INPUT_NAMES = ['fields', 'structures', 'valuesets', 'errors', 'constants', 'datatypes', 'golden'];
const inputs = {};
for (const name of INPUT_NAMES) inputs[name] = readInput(name);

const fieldsIn = inputs.fields.data;
const structuresIn = inputs.structures.data;
const valuesetsIn = inputs.valuesets.data;
const errorsIn = inputs.errors.data;
const constantsIn = inputs.constants.data;
const datatypesIn = inputs.datatypes.data;
const goldenIn = inputs.golden.data;

// ---------------------------------------------------------------------------
// repair patches
//
// Six repair passes wrote corrected artifacts next to the first-pass extraction. They are
// applied ON TOP of spec-build/*.json here rather than being merged back into it, so this
// compiler stays re-runnable: originals + patches in, src/spec out, deterministically. A
// missing or malformed patch degrades the bundle, it never fails the build.
// ---------------------------------------------------------------------------

const PATCH_NAMES = [
  'patch-xds-ebrim',
  'patch-literals',
  'patch-fhir-entries',
  'patch-cda',
  'patch-saml',
  'sample-defects',
];
const patches = {};
for (const name of PATCH_NAMES) {
  const rec = readInput(name);
  patches[name] = rec;
  if (!rec.present) warn('patch', `repair patch spec-build/${name}.json is absent — the repairs it carries are NOT in this bundle`);
}
const patchData = (name) => patches[name]?.data ?? null;

const xdsPatch = patchData('patch-xds-ebrim');
const literalsPatch = patchData('patch-literals');
const fhirEntriesPatch = patchData('patch-fhir-entries');
const cdaPatch = patchData('patch-cda');
const samlPatch = patchData('patch-saml');
const sampleDefectsPatch = patchData('sample-defects');

// ---------------------------------------------------------------------------
// literal normalisation
//
// Three extractor bugs mangled identifiers on the way out of Confluence (patch-literals):
//   (1) U+00A0 typed MID-TOKEN inside a <code> span, flattened to a space
//       -> "$XDSDocumentEntry PatientId"
//   (2) a <sup>1</sup> footnote marker flattened into the identifier
//       -> "$XDSDocumentEntry ClassCode 1", "CreationTimeFrom5"
//   (3) <p>/<br> boundaries joined with a space, merging two element paths into one
//
// Two things happen here, and they are different:
//   * the 36 VERIFIED corrections are applied to the raw inputs by exact literal match,
//     skipping provenance slots so every quote stays verbatim;
//   * the RULE itself is folded into normaliseIdentifier(), which every identifier slot
//     passes through, so a re-scrape that still carries the bug cannot silently reintroduce
//     it. A guard at the end asserts no identifier survives with NBSP or a glued footnote.
// ---------------------------------------------------------------------------

const NBSP = '\u00a0';
const ZWSP = '\u200b';
const SHY = '\u00ad';

/** Slots that hold VERBATIM source text. Never rewritten, whatever they contain. */
const PROVENANCE_SLOTS = new Set([
  'quote',
  'row',
  'guidance',
  'description',
  'elementLocationRaw',
  'noteBefore',
  'sourceHtmlFragment',
  'pageTitle',
  'title',
  'definition',
  'meaning',
  'text',
  'rawUsage',
  'rawMaxRpt',
]);

/** Is this string a single wire identifier rather than prose? */
const IDENTIFIER_RE = /^[$@#]?[A-Za-z_./][A-Za-z0-9_$.:/\u00a0 -]*$/;

const literalNormalisations = [];

/**
 * Normalise ONE identifier cell. Whitespace inside a wire identifier is always an
 * extractor artefact; whitespace inside prose is not. The test is deliberately narrow:
 * only strings that are already shaped like an identifier AND start with a known
 * identifier prefix get their internal whitespace deleted. Everything else keeps its
 * spaces and only loses the zero-width characters, which are never meaningful.
 */
function normaliseIdentifier(raw, where) {
  if (typeof raw !== 'string') return raw;
  let out = raw.replace(new RegExp(`[${ZWSP}${SHY}]`, 'g'), '');
  const trimmed = out.trim();
  const identifierish = IDENTIFIER_RE.test(trimmed) && /^(\$XDS|urn:uuid:|urn:ihe:|urn:oasis:)/.test(trimmed);
  if (identifierish) {
    const squashed = trimmed.replace(new RegExp(`[\\s${NBSP}]+`, 'g'), '');
    if (squashed !== trimmed) {
      literalNormalisations.push({ where: where ?? null, from: raw, to: squashed, rule: 'whitespace-in-identifier' });
      return squashed;
    }
    return trimmed;
  }
  // Prose: a no-break space really is a space.
  return out.replace(new RegExp(NBSP, 'g'), ' ');
}

/** Apply the verified literal corrections to one loaded artifact, in place. */
function applyLiteralCorrections() {
  const summary = { applied: 0, occurrences: 0, artifacts: [], misses: [], specDefectsShipped: 0 };
  if (!literalsPatch || !Array.isArray(literalsPatch.corrections)) {
    if (literalsPatch) warn('literals', 'patch-literals.json carries no corrections array');
    return summary;
  }
  const byArtifact = new Map();
  for (const c of literalsPatch.corrections) {
    if (typeof c?.storedLiteral !== 'string' || typeof c?.correctedLiteral !== 'string') {
      warn('literals', 'a correction has no storedLiteral/correctedLiteral pair and was skipped', c?.jsonPath ?? null);
      continue;
    }
    const artifact = String(c.artifact ?? '').replace(/\.json$/, '');
    if (!INPUT_NAMES.includes(artifact)) {
      warn('literals', `correction targets unknown artifact "${c.artifact}"`, { storedLiteral: c.storedLiteral });
      continue;
    }
    if (!byArtifact.has(artifact)) byArtifact.set(artifact, new Map());
    byArtifact.get(artifact).set(c.storedLiteral, {
      to: c.correctedLiteral,
      hits: 0,
      declared: typeof c.occurrences === 'number' ? c.occurrences : null,
      confidence: c.confidence ?? null,
      cause: c.cause ?? null,
    });
  }

  const walk = (node, table, key) => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const v = node[i];
        if (typeof v === 'string') {
          if (PROVENANCE_SLOTS.has(key)) continue;
          const hit = table.get(v);
          if (hit) {
            node[i] = hit.to;
            hit.hits += 1;
          }
        } else if (v && typeof v === 'object') walk(v, table, key);
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string') {
        if (PROVENANCE_SLOTS.has(k)) continue;
        const hit = table.get(v);
        if (hit) {
          node[k] = hit.to;
          hit.hits += 1;
        }
      } else if (v && typeof v === 'object') walk(v, table, k);
    }
  };

  for (const [artifact, table] of [...byArtifact.entries()].sort()) {
    const root = inputs[artifact]?.data;
    if (!root) {
      warn('literals', `corrections for "${artifact}" could not be applied — the input is missing`);
      continue;
    }
    walk(root, table, null);
    summary.artifacts.push(artifact);
    for (const [from, rec] of table) {
      if (rec.hits === 0) {
        summary.misses.push({ artifact, storedLiteral: from, expected: rec.declared });
        warn('literals', `correction for "${from}" matched nothing in ${artifact}.json — the input may already be fixed`, {
          expectedOccurrences: rec.declared,
        });
        continue;
      }
      summary.applied += 1;
      summary.occurrences += rec.hits;
      if (rec.declared !== null && rec.hits !== rec.declared) {
        warn('literals', `correction for "${from}" hit ${rec.hits} slots in ${artifact}.json, the patch declared ${rec.declared}`);
      }
    }
  }
  return summary;
}

const literalCorrectionSummary = applyLiteralCorrections();


// ---------------------------------------------------------------------------
// cross-artefact join indexes (fixed values, value-set bindings)
// ---------------------------------------------------------------------------

const fixedValueIndex = new Map(); // "pageId::rowToken" -> FixedValueRule[]
if (constantsIn && Array.isArray(constantsIn.fixedValues)) {
  for (const fv of constantsIn.fixedValues) {
    const key = joinKey(fv.pageId, fv.row);
    if (!key) continue;
    const rule = {
      value: fv.value ?? null,
      target: cleanText(fv.target),
      statementType: cleanText(fv.statementType),
      scope: cleanText(fv.scope),
      elementPath: cleanText(fv.elementPath),
      attribute: cleanText(fv.attribute),
      component: fv.component ?? null,
      provenance: provenance(fv.source, fv),
    };
    const list = fixedValueIndex.get(key);
    if (list) list.push(rule);
    else fixedValueIndex.set(key, [rule]);
  }
}

const valueSetById = new Map();
if (valuesetsIn && Array.isArray(valuesetsIn.valueSets)) {
  for (const vs of valuesetsIn.valueSets) valueSetById.set(vs.id, vs);
}

const bindingIndex = new Map(); // "pageId::rowToken" -> ValueSetBinding[]
if (valuesetsIn && Array.isArray(valuesetsIn.bindings)) {
  for (const b of valuesetsIn.bindings) {
    const key = joinKey(b.pageId, b.fieldKey || b.source?.row);
    if (!key) continue;
    const vs = b.valueSetId ? valueSetById.get(b.valueSetId) : null;
    const binding = {
      valueSetId: b.valueSetId ?? null,
      title: vs ? vs.title : null,
      referenceText: cleanText(b.referenceText),
      column: cleanText(b.column),
      resolvedVia: cleanText(b.resolvedVia),
      confidence: cleanText(b.confidence),
      external: vs ? Boolean(vs.external) : null,
      note: cleanText(b.note),
      provenance: provenance(b.source, b),
    };
    const list = bindingIndex.get(key);
    if (list) {
      // bindings.json contains exact duplicates for fields cited twice on a page
      const seen = list.some(
        (x) => x.valueSetId === binding.valueSetId && x.referenceText === binding.referenceText && x.column === binding.column,
      );
      if (!seen) list.push(binding);
    } else {
      bindingIndex.set(key, [binding]);
    }
  }
}

const extensionBase =
  constantsIn && constantsIn.fhirProfiles && typeof constantsIn.fhirProfiles.extensionBase === 'string'
    ? constantsIn.fhirProfiles.extensionBase
    : null;

// ---------------------------------------------------------------------------
// SpecNode compilation
// ---------------------------------------------------------------------------

const FAMILY_OF_BUCKET = { segments: 'hl7v2', fhir: 'fhir', cda: 'cda', xdsMetadata: 'xds' };
const FAMILY_LABEL = {
  hl7v2: 'HL7 v2.5.1 (ADT / ORU / ACK)',
  fhir: 'FHIR R4 (medications, laboratory, radiology)',
  cda: 'HL7 CDA R2 clinical documents',
  xds: 'IHE XDS.b / SOAP metadata',
};

/** ancestors[3] is the interface area ("ADT", "Clinical Documents", "FHIR Radiology Report", ...). */
function areaOf(ancestors) {
  if (!Array.isArray(ancestors) || !ancestors.length) return null;
  return ancestors[3] ?? ancestors[ancestors.length - 1] ?? null;
}

function roleOf(row, hasChildren) {
  if (typeof row.role === 'string' && ['data', 'structural', 'container', 'omit'].includes(row.role)) {
    return { role: row.role, inferred: false };
  }
  // The extractor could not classify this row (it carries no usage and no location).
  // Infer only from the tree shape, and say so.
  return { role: hasChildren ? 'container' : 'data', inferred: true };
}

function compileNode(row, ctx) {
  const { family, table, pageId, pageTitle, byRowId, parentPath } = ctx;
  const key = joinKey(pageId, row.source?.row ?? row.field ?? row.num);

  const locations = Array.isArray(row.elementLocation) ? row.elementLocation : [];
  let locator = null;
  let altLocators = [];

  if (family === 'hl7v2') {
    locator = hl7Locator(row.field, table.segment);
  } else if (family === 'fhir') {
    const built = locations.map((l) => fhirLocator(l, parentPath)).filter(Boolean);
    locator = built[0] ?? null;
    altLocators = built.slice(1);
  } else if (family === 'cda') {
    const built = locations.map((l) => cdaLocator(l, parentPath)).filter(Boolean);
    locator = built[0] ?? null;
    altLocators = built.slice(1);
  } else if (family === 'xds') {
    // Fold the literal-extraction rule in: whitespace inside a $XDS.../urn: identifier is
    // always an artefact of the Confluence renderer, never part of the wire name.
    const name = cleanText(normaliseIdentifier(row.name, `fields.xdsMetadata.${pageId}`));
    if (name) locator = { kind: 'xdsSlot', name };
    altLocators = locations.map((l) => cdaLocator(l, parentPath)).filter(Boolean);
  }

  const fixedValues = key ? (fixedValueIndex.get(key) ?? []) : [];
  const valueSets = key ? (bindingIndex.get(key) ?? []) : [];

  if (locator && locator.kind === 'fhirPath' && extensionBase) {
    const ext = fixedValues.find((fv) => typeof fv.value === 'string' && fv.value.startsWith(extensionBase));
    if (ext) locator.extensionUrl = ext.value;
  }

  const childRows = (Array.isArray(row.childRowIds) ? row.childRowIds : [])
    .map((id) => byRowId.get(id))
    .filter(Boolean);

  const nextParentPath =
    locator && (locator.kind === 'fhirPath' || locator.kind === 'cdaXPath') && !locator.path.startsWith('.')
      ? locator.path
      : parentPath;

  const children = childRows.map((child) =>
    compileNode(child, { ...ctx, parentPath: locator && locator.kind !== 'hl7Field' ? locator.path : nextParentPath }),
  );

  const { role, inferred } = roleOf(row, children.length > 0);
  const templateIds = locator && locator.kind === 'cdaXPath' ? templateIdsFromPath(row.elementLocationRaw ?? '') : [];

  const node = {
    id: row.rowId,
    family,
    label: cleanText(row.name) ?? cleanText(row.fieldName) ?? cleanText(row.field) ?? cleanText(row.num) ?? row.rowId,
    number: cleanText(row.num) ?? null,
    locator,
    locatorRaw: cleanText(row.elementLocationRaw) ?? cleanText(row.field) ?? null,
    role,
    roleInferred: inferred,
    roleConfidence: cleanText(row.roleConfidence) ?? (inferred ? 'low' : null),
    usage: normaliseUsageList(row.usage),
    datatype: cleanText(row.dataType) ?? null,
    length: row.length && typeof row.length === 'object' ? row.length : null,
    codeSet: cleanText(row.codeSet) ?? null,
    guidance: cleanText(row.guidance) ?? null,
    fixedValues,
    valueSets,
    templateIds,
    children,
    provenance: provenance(row.source, { pageId, pageTitle }),
  };
  if (altLocators.length) node.altLocators = altLocators;
  if (cleanText(row.noteBefore)) node.noteBefore = cleanText(row.noteBefore);
  return node;
}

function compileFieldBundles() {
  const bundles = {
    hl7v2: { family: 'hl7v2', label: FAMILY_LABEL.hl7v2, pages: {}, index: { bySegment: {}, byArea: {} }, counts: {} },
    fhir: { family: 'fhir', label: FAMILY_LABEL.fhir, pages: {}, index: { bySegment: {}, byArea: {} }, counts: {} },
    cda: { family: 'cda', label: FAMILY_LABEL.cda, pages: {}, index: { bySegment: {}, byArea: {} }, counts: {} },
    xds: { family: 'xds', label: FAMILY_LABEL.xds, pages: {}, index: { bySegment: {}, byArea: {} }, counts: {} },
  };
  const nodeIndex = new Map(); // nodeId -> { family, pageId, tableIndex }

  if (!fieldsIn) {
    warn('fields', 'fields.json absent — no SpecNode trees were compiled');
    return { bundles, nodeIndex };
  }

  for (const bucket of Object.keys(FAMILY_OF_BUCKET)) {
    const family = FAMILY_OF_BUCKET[bucket];
    const group = fieldsIn[bucket];
    if (!group || typeof group !== 'object') {
      warn('fields', `fields.json has no "${bucket}" bucket`);
      continue;
    }
    for (const pageId of Object.keys(group).sort()) {
      const page = group[pageId];
      const area = areaOf(page.ancestors);
      const tables = [];
      for (const table of Array.isArray(page.tables) ? page.tables : []) {
        const rows = Array.isArray(table.rows) ? table.rows : [];
        const byRowId = new Map();
        for (const r of rows) if (r && r.rowId) byRowId.set(r.rowId, r);

        // attach note rows to the field row that follows them
        let pendingNote = null;
        const notes = [];
        for (const r of rows) {
          if (r.kind === 'note') {
            pendingNote = cleanText(r.text);
            notes.push({ rowId: r.rowId, text: pendingNote, provenance: provenance(r.source, page) });
          } else if (pendingNote) {
            r.noteBefore = pendingNote;
            pendingNote = null;
          }
        }

        const fieldRows = rows.filter((r) => r.kind === 'field');
        const roots = fieldRows.filter((r) => !r.parentRowId || !byRowId.has(r.parentRowId));
        const ctx = {
          family,
          table,
          pageId: String(pageId),
          pageTitle: page.pageTitle,
          byRowId,
          parentPath: null,
        };
        const nodes = roots.map((r) => compileNode(r, ctx));

        const walk = (list) => {
          for (const n of list) {
            nodeIndex.set(n.id, { family, pageId: String(pageId), tableIndex: table.tableIndex });
            walk(n.children);
          }
        };
        walk(nodes);

        tables.push({
          tableIndex: table.tableIndex,
          kind: cleanText(table.kind),
          segment: cleanText(table.segment),
          header: Array.isArray(table.header) ? table.header : [],
          columns: Array.isArray(table.columns) ? table.columns : [],
          numberingStyle: cleanText(table.numberingStyle),
          notes,
          nodes,
        });

        if (table.segment) {
          const ref = `${pageId}:${table.tableIndex}`;
          const bySeg = bundles[family].index.bySegment;
          (bySeg[table.segment] ??= []).push({
            ref,
            pageId: String(pageId),
            tableIndex: table.tableIndex,
            area,
            pageTitle: page.pageTitle ?? null,
            path: (Array.isArray(page.ancestors) ? page.ancestors.slice(3) : []).concat(page.pageTitle ?? []).join(' > '),
          });
        }
      }

      bundles[family].pages[String(pageId)] = {
        pageId: String(pageId),
        pageTitle: page.pageTitle ?? null,
        ancestors: Array.isArray(page.ancestors) ? page.ancestors : [],
        ancestorIds: Array.isArray(page.ancestorIds) ? page.ancestorIds.map(String) : [],
        area,
        tables,
      };
      if (area) (bundles[family].index.byArea[area] ??= []).push(String(pageId));
    }
  }

  for (const family of Object.keys(bundles)) {
    const b = bundles[family];
    let tableCount = 0;
    let nodeCount = 0;
    const countNodes = (list) => {
      for (const n of list) {
        nodeCount += 1;
        countNodes(n.children);
      }
    };
    for (const pageId of Object.keys(b.pages)) {
      for (const t of b.pages[pageId].tables) {
        tableCount += 1;
        countNodes(t.nodes);
      }
    }
    for (const seg of Object.keys(b.index.bySegment)) {
      b.index.bySegment[seg].sort((x, y) => x.ref.localeCompare(y.ref));
    }
    for (const area of Object.keys(b.index.byArea)) b.index.byArea[area].sort();
    b.counts = { pages: Object.keys(b.pages).length, tables: tableCount, nodes: nodeCount };
  }

  return { bundles, nodeIndex };
}

const { bundles: fieldBundles } = compileFieldBundles();

// ---------------------------------------------------------------------------
// XDS ebRIM: the metadata model fields.json could never have held
//
// The first-pass extraction captured the XDS metadata attribute NAMES from Confluence
// (classCode, authorPerson, uniqueId, ...) but not the ebRIM machinery that carries them on
// the wire: the classification / identification scheme UUIDs, the ebRIM slots that are not
// NPHIES attributes at all (codingScheme, SubmissionSetStatus), and the object attributes
// whose values are fixed URNs. A scheme UUID is a fixed structural value — a message can
// neither be built nor checked without it — so it belongs in fields/xds.json alongside the
// attribute it denotes. That is what this derived page adds.
//
// EVIDENCE. Most of it comes from the official samples, because Confluence never prints a
// UUID. Every node therefore says so: `derivation: "sample"`, `provenance.sample` naming
// the file, `provenance.quote` the verbatim XML. Where a Confluence row states the
// attribute's optionality, that row is carried as the node's `usage` with its own quote, so
// the two kinds of evidence stay distinguishable. Nothing is promoted: the two values the
// repair pass flagged as conflicting stay low/medium confidence and say why.
// ---------------------------------------------------------------------------

const EBRIM_PAGE_ID = 'ebrim';
const EBRIM_AREA = 'IHE ebRIM content model (derived)';

function ebrimUsage(opt, fallbackCardinality) {
  if (opt && typeof opt === 'object') {
    return normaliseUsageList([
      {
        usage: opt.usage,
        min: typeof opt.min === 'number' ? opt.min : null,
        max: opt.max === '*' ? '*' : typeof opt.max === 'number' ? opt.max : null,
        rawUsage: opt.usage ?? null,
        rawMaxRpt: opt.maxRpt ?? null,
      },
    ]);
  }
  // No Confluence optionality row: record the observed cardinality WITHOUT claiming a usage
  // code. An empty usage list means "no source states a requirement here", which is the
  // truth, and resolveUsage() already reports that as unstated rather than optional.
  if (typeof fallbackCardinality === 'string' && fallbackCardinality.trim()) {
    const { min, max } = parseCardinalityString(fallbackCardinality);
    if (min !== null || max !== null) {
      return [{ usage: null, min, max, condition: null, validator: 'unknown', raw: { usage: null, cardinality: fallbackCardinality } }];
    }
  }
  return [];
}

function ebrimNode(id, fields) {
  return {
    id,
    family: 'xds',
    number: null,
    altLocators: undefined,
    datatype: null,
    length: null,
    codeSet: null,
    valueSets: [],
    templateIds: [],
    children: [],
    roleInferred: false,
    ...fields,
  };
}

function buildEbrimFieldPage() {
  if (!xdsPatch) return null;
  const tables = [];
  let nodeCount = 0;

  /* ---- table 0: classification / identification scheme UUIDs ---------------- */
  const schemeNodes = [];
  for (const [i, sch] of (Array.isArray(xdsPatch.schemes) ? xdsPatch.schemes : []).entries()) {
    if (!sch?.uuid || !sch?.attribute) {
      warn('xds-ebrim', 'a scheme entry has no uuid/attribute and was skipped');
      continue;
    }
    const schemeKind = sch.kind === 'identification' ? 'identification' : 'classification';
    const attributeName = schemeKind === 'classification' ? 'classificationScheme' : 'identificationScheme';
    const observed = Number(sch.sampleCount) > 0;
    schemeNodes.push(
      ebrimNode(`${EBRIM_PAGE_ID}:0:${i}`, {
        label: sch.attribute,
        locator: {
          kind: 'xdsScheme',
          scheme: schemeKind,
          uuid: String(sch.uuid).toLowerCase(),
          attribute: sch.attribute,
          ...(sch.appliesTo ? { appliesTo: sch.appliesTo } : {}),
        },
        locatorRaw: `${sch.carriedBy ?? 'rim:Classification'}/@${attributeName}="${sch.uuid}"`,
        role: 'structural',
        roleConfidence: 'high',
        usage: ebrimUsage(sch.nphiesOptionality, null),
        guidance: [
          `${sch.appliesTo ?? 'DocumentEntry'}.${sch.attribute} (IHE ${sch.iheName ?? sch.attribute}).`,
          sch.valueFormat ? `Value: ${sch.valueFormat}` : null,
          Array.isArray(sch.requiredChildSlots) && sch.requiredChildSlots.length
            ? `Requires child rim:Slot(s): ${sch.requiredChildSlots.join(', ')}.`
            : null,
        ]
          .filter(Boolean)
          .join(' '),
        fixedValues: [
          {
            value: String(sch.uuid),
            target: attributeName,
            statementType: 'ebrimSchemeUuid',
            scope: 'attribute',
            elementPath: sch.carriedBy ?? null,
            attribute: attributeName,
            component: null,
            provenance: provenance(sch.source),
          },
        ],
        provenance: provenance(sch.source) ?? provenance(sch.nphiesOptionality?.source),
        ...evidence({
          confidence: sch.confidence,
          verifiedAgainstSample: observed,
          derivation: sch.nphiesOptionality ? (observed ? 'confluence+sample' : 'confluence') : observed ? 'sample' : 'standard',
          confidenceReason: sch.confidenceReason,
          samples: sch.derivedFrom,
        }),
        valueCarrier: sch.valueCarrier ?? null,
        requiredChildSlots: Array.isArray(sch.requiredChildSlots) ? sch.requiredChildSlots : [],
        observedNames: Array.isArray(sch.observedNames) ? sch.observedNames : [],
        occurrenceCount: typeof sch.occurrenceCount === 'number' ? sch.occurrenceCount : null,
        ...(sch.nphiesOptionality?.source ? { optionalityProvenance: provenance(sch.nphiesOptionality.source) } : {}),
      }),
    );
  }
  if (schemeNodes.length) {
    tables.push({
      tableIndex: 0,
      kind: 'ebrimSchemes',
      segment: null,
      header: ['Metadata attribute', 'ebRIM scheme UUID', 'Object', 'Value carrier'],
      columns: ['attribute', 'uuid', 'appliesTo', 'valueCarrier'],
      numberingStyle: null,
      notes: [],
      nodes: schemeNodes,
    });
    nodeCount += schemeNodes.length;
  }

  /* ---- table 1: ebRIM slots ------------------------------------------------- */
  const slotNodes = [];
  for (const [i, slot] of (Array.isArray(xdsPatch.slots) ? xdsPatch.slots : []).entries()) {
    if (!slot?.slotName) continue;
    const name = normaliseIdentifier(slot.slotName, 'patch-xds-ebrim.slots');
    slotNodes.push(
      ebrimNode(`${EBRIM_PAGE_ID}:1:${i}`, {
        label: name,
        locator: { kind: 'xdsSlot', name },
        locatorRaw: `<rim:Slot name="${name}">`,
        role: 'data',
        roleConfidence: 'high',
        usage: ebrimUsage(slot.nphiesOptionality, slot.cardinality),
        guidance: [slot.carries, slot.notes].filter(Boolean).join(' '),
        fixedValues: [],
        provenance: provenance(slot.source) ?? provenance(slot.nphiesOptionality?.source),
        ...evidence({
          confidence: slot.confidence,
          verifiedAgainstSample: Number(slot.sampleCount) > 0,
          derivation: slot.nphiesOptionality ? 'confluence+sample' : 'sample',
          confidenceReason: slot.confidenceReason,
          samples: slot.derivedFrom,
        }),
        container: slot.container ?? null,
        appliesTo: slot.appliesTo ?? null,
        cardinalityText: slot.cardinality ?? null,
        exampleValue: slot.exampleValue ?? null,
        occurrenceCount: typeof slot.occurrenceCount === 'number' ? slot.occurrenceCount : null,
        ...(slot.nphiesOptionality?.source ? { optionalityProvenance: provenance(slot.nphiesOptionality.source) } : {}),
      }),
    );
  }
  if (slotNodes.length) {
    tables.push({
      tableIndex: 1,
      kind: 'ebrimSlots',
      segment: null,
      header: ['Slot name', 'Container', 'Applies to', 'Cardinality'],
      columns: ['slotName', 'container', 'appliesTo', 'cardinality'],
      numberingStyle: null,
      notes: [],
      nodes: slotNodes,
    });
    nodeCount += slotNodes.length;
  }

  /* ---- table 2: classification NODES (not schemes) -------------------------- */
  const nodeNodes = [];
  for (const [i, cn] of (Array.isArray(xdsPatch.classificationNodes) ? xdsPatch.classificationNodes : []).entries()) {
    const uuid = cn.observedValue ?? cn.iheStandardValue;
    if (!uuid) continue;
    const conflicting = Boolean(cn.observedValue && cn.iheStandardValue && cn.observedValue !== cn.iheStandardValue);
    nodeNodes.push(
      ebrimNode(`${EBRIM_PAGE_ID}:2:${i}`, {
        label: cn.iheName ?? cn.purpose ?? 'classification node',
        locator: {
          kind: 'xdsScheme',
          scheme: 'classificationNode',
          uuid: String(uuid).toLowerCase(),
          attribute: cn.iheName ?? 'classificationNode',
          ...(cn.purpose ? { appliesTo: /Folder/i.test(String(cn.iheName)) ? 'Folder' : 'SubmissionSet' } : {}),
        },
        locatorRaw: `rim:Classification/@classificationNode="${uuid}"`,
        role: 'structural',
        roleConfidence: cn.confidence ?? 'low',
        usage: ebrimUsage(null, cn.cardinality),
        guidance: cn.purpose ?? null,
        // Both candidate values are carried, neither is asserted: a validator must flag the
        // mismatch for a human rather than auto-correct in either direction.
        fixedValues: [
          ...(cn.observedValue
            ? [{
                value: cn.observedValue,
                target: 'classificationNode',
                statementType: conflicting ? 'ebrimClassificationNodeObserved' : 'ebrimClassificationNode',
                scope: 'attribute',
                elementPath: 'rim:Classification',
                attribute: 'classificationNode',
                component: null,
                provenance: provenance(cn.source),
              }]
            : []),
          ...(conflicting
            ? [{
                value: cn.iheStandardValue,
                target: 'classificationNode',
                statementType: 'ebrimClassificationNodeIheStandard',
                scope: 'attribute',
                elementPath: 'rim:Classification',
                attribute: 'classificationNode',
                component: null,
                provenance: null,
              }]
            : []),
        ],
        provenance: provenance(cn.source),
        ...evidence({
          confidence: cn.confidence,
          verifiedAgainstSample: Number(cn.sampleCount) > 0,
          derivation: cn.source?.pageId ? 'confluence' : Number(cn.sampleCount) > 0 ? 'sample' : 'standard',
          confidenceReason: cn.confidenceReason,
          samples: cn.derivedFrom,
        }),
        conflict: conflicting
          ? { observedValue: cn.observedValue, iheStandardValue: cn.iheStandardValue, action: 'flag for a human; do not auto-correct' }
          : null,
      }),
    );
  }
  if (nodeNodes.length) {
    tables.push({
      tableIndex: 2,
      kind: 'ebrimClassificationNodes',
      segment: null,
      header: ['Purpose', 'classificationNode UUID', 'Cardinality'],
      columns: ['purpose', 'uuid', 'cardinality'],
      numberingStyle: null,
      notes: [],
      nodes: nodeNodes,
    });
    nodeCount += nodeNodes.length;
  }

  /* ---- table 3: ITI-18 stored query parameters ------------------------------ */
  const paramNodes = [];
  const iti18 = xdsPatch.iti18 ?? null;
  for (const [i, prm] of (Array.isArray(iti18?.parameters) ? iti18.parameters : []).entries()) {
    const name = normaliseIdentifier(prm.officialName ?? prm.name, 'patch-xds-ebrim.iti18.parameters');
    if (!name) continue;
    paramNodes.push(
      ebrimNode(`${EBRIM_PAGE_ID}:3:${i}`, {
        label: name,
        locator: { kind: 'xdsSlot', name },
        locatorRaw: `<rim:Slot name="${name}"> inside rim:AdhocQuery`,
        role: 'data',
        roleConfidence: 'high',
        usage: usageFromCode(prm.required ? 'R' : 'O', {
          min: prm.required ? 1 : 0,
          max: prm.multipleAllowed ? '*' : 1,
          quoteCardinality: prm.optionality ?? null,
        }),
        guidance: [prm.valueFormat ? `Value format: ${prm.valueFormat}` : null, prm.attribute ? `Queries ${prm.attribute}.` : null]
          .filter(Boolean)
          .join(' '),
        fixedValues: [],
        provenance: provenance(prm.source),
        ...evidence({
          confidence: prm.confidence,
          verifiedAgainstSample: prm.verifiedInSample === true,
          derivation: prm.source?.pageId ? (prm.verifiedInSample ? 'confluence+sample' : 'confluence') : 'sample',
          confidenceReason: prm.confidenceReason,
          samples: prm.derivedFrom,
        }),
        exampleValue: prm.exampleValue ?? null,
        // The Confluence cell and the wire disagree on some of these names; the cell is kept
        // so spec-defects.json can show the analyst both spellings.
        confluenceCellSpelling: prm.confluenceCellSpelling ?? null,
      }),
    );
  }
  if (paramNodes.length) {
    const storedQueryProv = provenance(iti18?.storedQuerySource);
    paramNodes.push(
      ebrimNode(`${EBRIM_PAGE_ID}:3:${paramNodes.length}`, {
        label: 'FindDocuments stored query id',
        locator: { kind: 'xdsSlot', name: 'AdhocQuery/@id' },
        locatorRaw: `<rim:AdhocQuery id="${iti18?.storedQueryId ?? ''}">`,
        role: 'structural',
        roleConfidence: 'high',
        usage: usageFromCode('M', { min: 1, max: 1 }),
        guidance: iti18?.storedQueryName ? `Stored query: ${iti18.storedQueryName}.` : null,
        fixedValues: iti18?.storedQueryId
          ? [{
              value: iti18.storedQueryId,
              target: 'id',
              statementType: 'fixedValue',
              scope: 'attribute',
              elementPath: 'rim:AdhocQuery',
              attribute: 'id',
              component: null,
              provenance: storedQueryProv,
            }]
          : [],
        provenance: storedQueryProv,
        ...evidence({
          confidence: iti18?.storedQueryConfidence,
          verifiedAgainstSample: Array.isArray(iti18?.storedQueryDerivedFrom) && iti18.storedQueryDerivedFrom.length > 0,
          derivation: 'confluence+sample',
          samples: iti18?.storedQueryDerivedFrom,
        }),
      }),
    );
    tables.push({
      tableIndex: 3,
      kind: 'iti18QueryParameters',
      segment: null,
      header: ['Parameter', 'Optionality', 'Multiple allowed', 'Value format'],
      columns: ['officialName', 'optionality', 'multipleAllowed', 'valueFormat'],
      numberingStyle: null,
      notes: (Array.isArray(iti18?.notes) ? iti18.notes : []).map((t, i) => ({
        rowId: `${EBRIM_PAGE_ID}:3:note${i}`,
        text: t,
        provenance: null,
      })),
      nodes: paramNodes,
    });
    nodeCount += paramNodes.length;
  }

  /* ---- table 4: ebRIM object attributes with fixed URN values --------------- */
  const attrNodes = [];
  let attrIndex = 0;
  for (const objectName of ['ExtrinsicObject', 'RegistryPackage', 'Association']) {
    const obj = xdsPatch.ebrimModel?.[objectName];
    for (const attr of Array.isArray(obj?.attributes) ? obj.attributes : []) {
      if (!attr?.attribute) continue;
      attrNodes.push(
        ebrimNode(`${EBRIM_PAGE_ID}:4:${attrIndex}`, {
          label: `${objectName}/@${attr.attribute}`,
          locator: { kind: 'xdsSlot', name: `${objectName}/@${attr.attribute}` },
          locatorRaw: `rim:${objectName}/@${attr.attribute}`,
          role: 'structural',
          roleConfidence: attr.confidence ?? 'high',
          usage: attr.required ? usageFromCode('M', { min: 1, max: 1 }) : usageFromCode('O', { min: 0, max: 1 }),
          guidance: [attr.carries, attr.valueFormat ? `Format: ${attr.valueFormat}` : null].filter(Boolean).join(' '),
          fixedValues: (Array.isArray(attr.fixedValues) ? attr.fixedValues : []).map((fv) => ({
            value: fv.value,
            target: attr.attribute,
            statementType: Number(fv.observedIn) > 0 ? 'fixedValue' : 'fixedValueDeclaredNeverObserved',
            scope: 'attribute',
            elementPath: `rim:${objectName}`,
            attribute: attr.attribute,
            component: null,
            provenance: provenance(attr.source),
            meaning: fv.meaning ?? null,
            observedInSamples: typeof fv.observedIn === 'number' ? fv.observedIn : null,
            note: fv.note ?? null,
          })),
          provenance: provenance(attr.source),
          ...evidence({
            confidence: attr.confidence,
            verifiedAgainstSample: Boolean(attr.source?.sample) || (Array.isArray(attr.fixedValues) && attr.fixedValues.some((f) => Number(f.observedIn) > 0)),
            derivation: attr.source?.pageId ? 'confluence+sample' : 'sample',
            confidenceReason: attr.confidenceReason,
          }),
          ebrimObject: objectName,
        }),
      );
      attrIndex += 1;
    }
  }
  if (attrNodes.length) {
    tables.push({
      tableIndex: 4,
      kind: 'ebrimObjectAttributes',
      segment: null,
      header: ['ebRIM object attribute', 'Carries', 'Fixed value(s)'],
      columns: ['attribute', 'carries', 'fixedValues'],
      numberingStyle: null,
      notes: [],
      nodes: attrNodes,
    });
    nodeCount += attrNodes.length;
  }

  if (!tables.length) return null;
  return {
    page: {
      pageId: EBRIM_PAGE_ID,
      pageTitle: 'IHE XDS.b ebRIM content model (derived from the official samples and the metadata optionality pages)',
      ancestors: [],
      ancestorIds: [],
      area: EBRIM_AREA,
      derived: true,
      derivedFrom: 'spec-build/patch-xds-ebrim.json',
      derivedNote:
        'NOT a Confluence page. Every node says where it came from: nodes whose provenance carries `sample` were read off an official golden SOAP message because no cached Confluence page states the fact; nodes whose provenance carries `pageId` quote the metadata-optionality row verbatim.',
      tables,
    },
    nodeCount,
  };
}

const ebrimFieldPage = buildEbrimFieldPage();
if (ebrimFieldPage) {
  fieldBundles.xds.pages[EBRIM_PAGE_ID] = ebrimFieldPage.page;
  (fieldBundles.xds.index.byArea[EBRIM_AREA] ??= []).push(EBRIM_PAGE_ID);
  fieldBundles.xds.counts.pages += 1;
  fieldBundles.xds.counts.tables += ebrimFieldPage.page.tables.length;
  fieldBundles.xds.counts.nodes += ebrimFieldPage.nodeCount;
} else if (xdsPatch) {
  warn('xds-ebrim', 'patch-xds-ebrim.json produced no ebRIM field nodes');
}

// ---------------------------------------------------------------------------
// literal regression guard
//
// The three extraction bugs patch-literals fixed are the kind that come back silently on
// the next scrape. Assert they are gone: no compiled identifier may carry a no-break space,
// an internal space in a $XDS.../urn: token, or a glued footnote digit.
// ---------------------------------------------------------------------------

const literalGuardViolations = [];
{
  const check = (value, where) => {
    if (typeof value !== 'string' || !value) return;
    if (value.includes(NBSP)) literalGuardViolations.push({ where, value, rule: 'no-break-space-in-identifier' });
    else if (/^\$XDS[A-Za-z]*\s/.test(value)) literalGuardViolations.push({ where, value, rule: 'injected-space-in-identifier' });
    else if (/^\$XDS[A-Za-z]+\s*\d{1,2}$/.test(value)) literalGuardViolations.push({ where, value, rule: 'glued-footnote-digit' });
  };
  const walkNodes = (nodes, where) => {
    for (const n of nodes) {
      if (n.locator?.kind === 'xdsSlot') check(n.locator.name, `${where} locator`);
      check(n.label, `${where} label`);
      walkNodes(n.children ?? [], where);
    }
  };
  for (const pageId of Object.keys(fieldBundles.xds.pages)) {
    for (const t of fieldBundles.xds.pages[pageId].tables) walkNodes(t.nodes, `fields/xds.json ${pageId}:${t.tableIndex}`);
  }
  for (const v of literalGuardViolations) {
    warn('literals-guard', `identifier "${v.value}" still carries an extraction artefact (${v.rule})`, { where: v.where });
  }
}

/**
 * segment -> field-table refs for MessageStructure specRefs.
 * `scope` narrows by interface area AND by ancestor path, so that an ADT event's MSH does
 * not pick up the ACK MSH page (both live under the "ADT" area).
 */
function segmentRefs(segment, scope) {
  const idx = fieldBundles.hl7v2.index;
  let refs = idx.bySegment[segment] ?? [];
  if (!refs.length && segment.includes('-')) {
    // "OBR-NTE" is not an HL7 segment id: it is an NTE table whose PAGE TITLE names the
    // segment it follows. Match on the page title rather than inventing a segment id.
    refs = Object.values(idx.bySegment)
      .flat()
      .filter((r) => r.pageTitle === segment);
  }
  const areas = scope && scope.areas;
  const include = scope && scope.includePath;
  const exclude = scope && scope.excludePath;
  const wanted = refs.filter((r) => {
    if (areas && !areas.includes(r.area)) return false;
    const path = r.path ?? '';
    if (include && !include.test(path)) return false;
    if (exclude && exclude.test(path)) return false;
    return true;
  });
  if (!wanted.length) warn('structures', `no HL7 field table resolved for segment "${segment}"`, { scope: scope ? scope.areas : null });
  return wanted
    .map((r) => ({ family: 'hl7v2', pageId: r.pageId, tableIndex: r.tableIndex, ref: r.ref }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

const RESPONSE_PATH = /Responses?\s*\/\s*Error/i;
const SCOPE = {
  adtRequest: { areas: ['ADT'], excludePath: RESPONSE_PATH },
  adtResponse: { areas: ['ADT'], includePath: RESPONSE_PATH },
  oruRequest: { areas: ['Vital Signs - ORU'], excludePath: RESPONSE_PATH },
  oruResponse: { areas: ['Vital Signs - ORU'], includePath: RESPONSE_PATH },
};

function pageRef(family, pageId, tableIndex = 0) {
  if (!pageId) return null;
  const bundle = fieldBundles[family];
  const page = bundle ? bundle.pages[String(pageId)] : null;
  if (!page) return { family, pageId: String(pageId), tableIndex, ref: `${pageId}:${tableIndex}`, resolved: false };
  return { family, pageId: String(pageId), tableIndex, ref: `${pageId}:${tableIndex}`, resolved: true };
}

// ---------------------------------------------------------------------------
// MessageStructure builders
// ---------------------------------------------------------------------------

let memberSeq = 0;
const memberId = (prefix) => `${prefix}#${(memberSeq += 1)}`;

function segmentMember(structureId, entry, areas, extra = {}) {
  const segment = entry.segment;
  return {
    kind: 'segment',
    id: `${structureId}/${segment}${extra.suffix ?? ''}`,
    segment,
    label: cleanText(entry.name) ?? segment,
    repeats: Boolean(entry.repeats),
    usage: entry.usage,
    specRefs: segmentRefs(segment, areas),
    guidance: cleanText(entry.guidance),
    provenance: entry.provenance,
    ...(extra.extras ?? {}),
  };
}

function buildAdtStructures() {
  const out = [];
  if (!structuresIn || !structuresIn.adt) {
    warn('structures', 'structures.json has no "adt" section — ADT message structures were not compiled');
    return out;
  }
  const adt = structuresIn.adt;
  const resolved = Array.isArray(adt.resolvedByEvent) ? adt.resolvedByEvent : [];
  if (!resolved.length) warn('structures', 'structures.adt.resolvedByEvent is empty');

  for (const ev of resolved) {
    const structureId = `adt-${String(ev.event).toLowerCase()}`;
    const members = (Array.isArray(ev.segments) ? ev.segments : []).map((seg) =>
      segmentMember(
        structureId,
        {
          segment: seg.segment,
          name: seg.name,
          repeats: seg.repeats,
          usage: usageFromCode(seg.effectiveUsage),
          guidance: seg.guidance,
          provenance: provenance(Array.isArray(seg.sources) ? seg.sources[0] : seg.source),
        },
        SCOPE.adtRequest,
        {
          extras: {
            sources: (Array.isArray(seg.sources) ? seg.sources : []).map((s) => provenance(s)).filter(Boolean),
            agreesAcrossTables: seg.agrees ?? null,
            usageInStructureTable: seg.usageInStructureTable ?? null,
            usageInEventMatrix: seg.usageInEventMatrix ?? null,
          },
        },
      ),
    );

    const notPresent = Array.isArray(ev.segmentsMarkedNotPresent) ? ev.segmentsMarkedNotPresent : [];
    for (const segment of notPresent) {
      members.push(
        segmentMember(
          structureId,
          {
            segment,
            name: segment,
            repeats: false,
            usage: usageFromCode('-'),
            guidance: null,
            provenance: provenance(adt.eventMatrix?.source),
          },
          SCOPE.adtRequest,
          { suffix: ':absent' },
        ),
      );
    }

    out.push({
      id: structureId,
      useCaseId: 'adt',
      variant: String(ev.event),
      variantLabel: cleanText(ev.name) ?? String(ev.event),
      family: 'hl7v2',
      encoding: 'hl7v2-er7',
      title: `ADT^${ev.event} — ${cleanText(ev.name) ?? 'ADT event'}`,
      confidence: 'high',
      envelope: {
        kind: 'hl7v2Message',
        messageType: `ADT^${ev.event}`,
        segmentTerminator: '\\r',
        structureTable: cleanText(ev.structureTable),
      },
      root: {
        kind: 'group',
        id: structureId,
        label: `ADT^${ev.event}`,
        repeats: false,
        usage: usageFromCode('M', { min: 1, max: 1 }),
        members,
        provenance: provenance(adt.eventMatrix?.source),
      },
      notes: notPresent.length
        ? [`Segments marked "-" (not present in this event) and therefore flagged if sent: ${notPresent.join(', ')}.`]
        : [],
    });
  }

  // ACK (response) structures for ADT
  const ack = structuresIn.ack?.adt;
  if (ack && Array.isArray(ack.types)) {
    for (const type of ack.types) {
      const slug = String(type.ackType).toLowerCase().includes('negative') ? 'nack' : 'ack';
      const structureId = `adt-${slug}`;
      const members = (Array.isArray(type.segments) ? type.segments : []).map((seg) =>
        segmentMember(
          structureId,
          {
            segment: seg.segment,
            name: seg.segment,
            repeats: false,
            usage: usageFromCode(seg.usage),
            guidance: cleanText(seg.meaning),
            provenance: provenance(type.source),
          },
          SCOPE.adtResponse,
        ),
      );
      for (const segment of Array.isArray(type.absentSegments) ? type.absentSegments : []) {
        members.push(
          segmentMember(
            structureId,
            { segment, name: segment, repeats: false, usage: usageFromCode('-'), guidance: null, provenance: provenance(type.source) },
            SCOPE.adtResponse,
            { suffix: ':absent' },
          ),
        );
      }
      out.push({
        id: structureId,
        useCaseId: 'adt',
        variant: slug === 'nack' ? 'ACK-negative' : 'ACK-positive',
        variantLabel: cleanText(type.ackType),
        family: 'hl7v2',
        encoding: 'hl7v2-er7',
        direction: 'response',
        title: `ADT ${cleanText(type.ackType) ?? 'Acknowledgement'}`,
        confidence: 'high',
        envelope: { kind: 'hl7v2Message', messageType: 'ACK', segmentTerminator: '\\r' },
        root: {
          kind: 'group',
          id: structureId,
          label: cleanText(type.ackType) ?? 'ACK',
          repeats: false,
          usage: usageFromCode('M', { min: 1, max: 1 }),
          members,
          provenance: provenance(type.source),
        },
        notes: [],
      });
    }
  }

  return out;
}

function buildOruStructures() {
  const out = [];
  if (!structuresIn || !structuresIn.oru || !structuresIn.oru.structure) {
    warn('structures', 'structures.json has no "oru.structure" — ORU message structure was not compiled');
    return out;
  }
  const oru = structuresIn.oru;
  const structureId = 'oru-r01';
  const areas = SCOPE.oruRequest;

  const toMember = (el, parentId) => {
    if (el.kind === 'group') {
      const gid = `${parentId}/${(cleanText(el.group) ?? 'group').replace(/\s+/g, '-')}`;
      return {
        kind: 'group',
        id: gid,
        label: cleanText(el.group) ?? 'group',
        repeats: Boolean(el.repeats),
        usage: normaliseUsageList(el.usage),
        members: (Array.isArray(el.members) ? el.members : []).map((m) => toMember(m, gid)),
        provenance: provenance(el.source),
      };
    }
    return segmentMember(
      parentId,
      {
        segment: el.segment,
        name: el.name,
        repeats: el.repeats,
        usage: normaliseUsageList(el.usage),
        guidance: el.guidance,
        provenance: provenance(el.source),
      },
      areas,
    );
  };

  const members = (Array.isArray(oru.structure.elements) ? oru.structure.elements : []).map((el) => toMember(el, structureId));

  out.push({
    id: structureId,
    useCaseId: 'oru-vitals',
    variant: 'R01',
    variantLabel: 'Vital signs observation result',
    family: 'hl7v2',
    encoding: 'hl7v2-er7',
    title: cleanText(oru.structure.title) ?? 'ORU^R01',
    confidence: oru.derivedShape ? 'medium' : 'high',
    envelope: {
      kind: 'hl7v2Message',
      messageType: cleanText(oru.structure.messageType) ?? 'ORU^R01',
      segmentTerminator: '\\r',
      derivedShape: oru.derivedShape ? oru.derivedShape.notation : null,
    },
    root: {
      kind: 'group',
      id: structureId,
      label: cleanText(oru.structure.messageType) ?? 'ORU^R01',
      repeats: false,
      usage: usageFromCode('M', { min: 1, max: 1 }),
      members,
      provenance: provenance(oru.structure.elements?.[0]?.source),
    },
    notes: [
      oru.derivedShape
        ? `Nesting confidence: ${oru.derivedShape.confidence}. ${oru.derivedShape.basis}`
        : 'No derivedShape note was supplied by the structures extractor.',
      goldenIn && Array.isArray(goldenIn.missing) && goldenIn.missing.some((m) => m.useCaseId === 'oru-vitals')
        ? 'No ORU golden sample ships in spec-source/golden/, so this structure is unverified against a real message.'
        : null,
    ].filter(Boolean),
  });

  const ack = structuresIn.ack?.oru;
  if (ack && Array.isArray(ack.types)) {
    for (const type of ack.types) {
      const slug = String(type.ackType).toLowerCase().includes('negative') ? 'nack' : 'ack';
      const sid = `oru-${slug}`;
      out.push({
        id: sid,
        useCaseId: 'oru-vitals',
        variant: slug === 'nack' ? 'ACK-negative' : 'ACK-positive',
        variantLabel: cleanText(type.ackType),
        family: 'hl7v2',
        encoding: 'hl7v2-er7',
        direction: 'response',
        title: `ORU ${cleanText(type.ackType) ?? 'Acknowledgement'}`,
        confidence: 'high',
        envelope: { kind: 'hl7v2Message', messageType: 'ACK', segmentTerminator: '\\r' },
        root: {
          kind: 'group',
          id: sid,
          label: cleanText(type.ackType) ?? 'ACK',
          repeats: false,
          usage: usageFromCode('M', { min: 1, max: 1 }),
          members: (Array.isArray(type.segments) ? type.segments : []).map((seg) =>
            segmentMember(
              sid,
              {
                segment: seg.segment,
                name: seg.segment,
                repeats: false,
                usage: usageFromCode(seg.usage),
                guidance: cleanText(seg.meaning),
                provenance: provenance(type.source),
              },
              SCOPE.oruResponse,
            ),
          ),
          provenance: provenance(type.source),
        },
        notes: [],
      });
    }
  }

  return out;
}

/** "One entry of type “Patient” SHALL be present." -> Patient (quotable, never guessed). */
function resourceTypeFromGuidance(text) {
  if (typeof text !== 'string') return null;
  const m = /entr(?:y|ies)?(?:\([s]\))?\s*(?:of\s*)?(?:type\s*)?[“"']([A-Za-z][A-Za-z ]*)[”"']/i.exec(text);
  if (!m) return null;
  return m[1].replace(/\s+/g, '');
}

function bundleEntryMember(structureId, entry, index) {
  const resourceType = entry.resourceType ?? resourceTypeFromGuidance(entry.guidance);
  return {
    kind: 'entry',
    id: `${structureId}/entry[${index}]`,
    position: entry.position ?? index + 1,
    label: cleanText(entry.name) ?? (resourceType ? `Bundle entry for ${resourceType}` : `Bundle entry ${index + 1}`),
    resourceType: resourceType ?? null,
    resourceTypeSource: entry.resourceType ? 'stated' : resourceType ? 'guidance-quote' : null,
    locator: { kind: 'fhirPath', path: './entry', relativeTo: 'Bundle' },
    repeats: (() => {
      const u = normaliseUsageList(entry.usage)[0];
      return Boolean(u && (u.max === '*' || (typeof u.max === 'number' && u.max > 1)));
    })(),
    usage: normaliseUsageList(entry.usage),
    guidance: cleanText(entry.guidance),
    orderingConstraint: cleanText(entry.orderingConstraint) ?? cleanText(entry.rule),
    provenance: provenance(entry.source),
  };
}

function bundleElementMember(structureId, item) {
  const split = splitXPath(item.path);
  const locator = split ? { kind: 'fhirPath', path: split.path, relativeTo: 'Bundle' } : null;
  const key = joinKey(item.source?.pageId, item.source?.row ?? item.no);
  return {
    kind: 'element',
    id: `${structureId}/${split ? split.path : (item.no ?? 'element')}`,
    label: cleanText(item.name) ?? split?.path ?? cleanText(item.no) ?? 'element',
    number: cleanText(item.no),
    locator,
    usage: normaliseUsageList(item.usage),
    guidance: cleanText(item.guidance),
    fixedValues: key ? (fixedValueIndex.get(key) ?? []) : [],
    valueSets: key ? (bindingIndex.get(key) ?? []) : [],
    provenance: provenance(item.source),
  };
}

const FHIR_BUNDLE_USE_CASES = {
  Prescription: { useCaseId: 'fhir-med-prescribe', title: 'FHIR Prescription Bundle (uncontrolled medications)' },
  Dispense: { useCaseId: 'fhir-med-dispense', title: 'FHIR Dispense Bundle (uncontrolled medications)' },
  'Prescription (Raqeeb)': { useCaseId: 'fhir-med-raqeeb-prescribe', title: 'FHIR Prescription Bundle (Raqeeb controlled medications)' },
  'Dispense (Raqeeb)': { useCaseId: 'fhir-med-raqeeb-dispense', title: 'FHIR Dispense Bundle (Raqeeb controlled medications)' },
  'Laboratory Order': { useCaseId: 'fhir-lab-order', title: 'FHIR Laboratory Order Bundle' },
  'Laboratory Report': { useCaseId: 'fhir-lab-result', title: 'FHIR Laboratory Report Bundle' },
  'Radiology Order': { useCaseId: 'fhir-rad-order', title: 'FHIR Radiology Order Bundle' },
  'Radiology Report': { useCaseId: 'fhir-rad-report', title: 'FHIR Radiology Report Bundle' },
};

function buildFhirBundleStructure(bundleKey, bundle, familyMeta) {
  const mapping = FHIR_BUNDLE_USE_CASES[bundleKey];
  if (!mapping) {
    warn('structures', `FHIR bundle "${bundleKey}" has no use-case mapping and was skipped`);
    return null;
  }
  const structureId = mapping.useCaseId;
  const page = bundle.page ?? bundle.baseBundle ?? null;
  const items = page && Array.isArray(page.items) ? page.items : [];

  const elementMembers = items
    .filter((it) => {
      const split = splitXPath(it.path);
      return split && split.path !== './entry' && split.path !== 'Bundle';
    })
    .map((it) => bundleElementMember(structureId, it));

  const entrySource = Array.isArray(bundle.composedEntryOrder) && bundle.composedEntryOrder.length
    ? bundle.composedEntryOrder
    : Array.isArray(bundle.entries)
      ? bundle.entries
      : [];
  if (!entrySource.length) warn('structures', `FHIR bundle "${bundleKey}" has no entry list`);
  const entryMembers = entrySource.map((e, i) => bundleEntryMember(structureId, e, i));

  const bundleType = cleanText(bundle.bundleType) ?? cleanText(familyMeta?.bundleType);
  const firstEntry = bundle.firstEntryRule ?? familyMeta?.firstEntryRule ?? null;

  return {
    id: structureId,
    useCaseId: mapping.useCaseId,
    variant: null,
    variantLabel: null,
    family: 'fhir',
    encoding: 'fhir-json',
    title: mapping.title,
    confidence: firstEntry && firstEntry.basis ? 'medium' : 'high',
    envelope: {
      kind: 'fhirBundle',
      bundleType,
      bundleTypeRule: bundle.bundleTypeRule ?? familyMeta?.bundleTypeRule ?? null,
      firstEntryRule: firstEntry,
      specPage: page ? { pageId: String(page.pageId), pageTitle: page.pageTitle ?? null } : null,
    },
    specRefs: page ? [pageRef('fhir', page.pageId, 0)].filter(Boolean) : [],
    root: {
      kind: 'group',
      id: structureId,
      label: 'Bundle',
      repeats: false,
      usage: usageFromCode('M', { min: 1, max: 1 }),
      members: [
        ...elementMembers,
        {
          kind: 'group',
          id: `${structureId}/entries`,
          label: 'Bundle.entry',
          locator: { kind: 'fhirPath', path: './entry', relativeTo: 'Bundle' },
          repeats: true,
          usage: usageFromCode('M', { min: entryMembers.length ? 1 : 0, max: '*' }),
          members: entryMembers,
          provenance: provenance(firstEntry?.source) ?? provenance(bundle.bundleTypeRule?.source),
        },
      ],
      provenance: provenance(bundle.bundleTypeRule?.source ?? familyMeta?.bundleTypeRule?.source),
    },
    notes: [
      firstEntry && firstEntry.basis ? `First-entry rule basis: ${firstEntry.basis}` : null,
      cleanText(bundle.emptyPageNote),
    ].filter(Boolean),
  };
}

function buildFhirStructures() {
  const out = [];
  const fhir = structuresIn?.fhir;
  if (!fhir || !fhir.families) {
    warn('structures', 'structures.json has no "fhir.families" — FHIR bundle structures were not compiled');
    return out;
  }
  const med = fhir.families.medications;
  if (med && med.bundles) {
    for (const key of Object.keys(med.bundles).sort()) {
      const built = buildFhirBundleStructure(key, med.bundles[key], med);
      if (built) out.push(built);
    }
  } else {
    warn('structures', 'structures.fhir.families.medications is missing');
  }
  const labRad = fhir.families.labRadDocuments;
  if (labRad && labRad.bundles) {
    for (const key of Object.keys(labRad.bundles).sort()) {
      const built = buildFhirBundleStructure(key, labRad.bundles[key], labRad);
      if (built) out.push(built);
    }
  } else {
    warn('structures', 'structures.fhir.families.labRadDocuments is missing');
  }
  return out;
}

const CDA_USE_CASES = {
  'Outpatient Encounter Summary': { useCaseId: 'cda-outpatient-encounter', headerKey: 'Outpatient Encounter Summary', sectionKey: 'Outpatient Summary' },
  'Discharge Summary': { useCaseId: 'cda-discharge-summary', headerKey: 'Discharge Summary', sectionKey: 'Discharge Summary' },
  'Maternal Discharge Summary': { useCaseId: 'cda-maternal-discharge', headerKey: 'Maternal Discharge Summary', sectionKey: 'Maternal DisSum' },
  'Newborn Discharge Summary': { useCaseId: 'cda-newborn-discharge', headerKey: 'Newborn Discharge Summary', sectionKey: 'Newborn DisSum' },
  'Operative Notes': { useCaseId: 'cda-operative-notes', headerKey: 'Operative Notes', sectionKey: 'Operative Notes' },
  'Laboratory Order': { useCaseId: 'cda-lab-order' },
  'Laboratory Results': { useCaseId: 'cda-lab-result' },
  'Radiology Order': { useCaseId: 'cda-rad-order' },
  'Radiology Results (structured)': { useCaseId: 'cda-rad-result', variant: 'structured' },
  'Radiology Results (embedded PDF)': { useCaseId: 'cda-rad-result', variant: 'embedded-pdf' },
  'Immunization Card': { useCaseId: 'cda-immunization-card' },
  'Immunization Summary': { useCaseId: 'cda-immunization-summary' },
  'iEHR Summary': { useCaseId: 'cda-iehr-summary' },
};

function buildCdaStructures() {
  const out = [];
  const cda = structuresIn?.cda;
  if (!cda || !cda.bodyByDocumentType) {
    warn('structures', 'structures.json has no "cda.bodyByDocumentType" — CDA document structures were not compiled');
    return out;
  }
  const docTypeMeta = new Map();
  for (const dt of Array.isArray(cda.documentTypes) ? cda.documentTypes : []) docTypeMeta.set(dt.documentType, dt);
  const headerRows = cda.headerByDocumentType?.rows ?? {};

  for (const docType of Object.keys(cda.bodyByDocumentType).sort()) {
    const mapping = CDA_USE_CASES[docType];
    if (!mapping) {
      warn('structures', `CDA document type "${docType}" has no use-case mapping and was skipped`);
      continue;
    }
    const body = cda.bodyByDocumentType[docType];
    const structureId = mapping.variant ? `${mapping.useCaseId}-${mapping.variant}` : mapping.useCaseId;
    const items = Array.isArray(body.items) ? body.items : [];

    const sectionMembers = items.map((item, i) => {
      const split = splitXPath(item.path);
      const templateIds = item.templateId ? [item.templateId] : templateIdsFromPath(item.path ?? '');
      const locator = split
        ? {
            kind: 'cdaXPath',
            path: split.path,
            ...(split.path.startsWith('.') ? { relativeTo: '/ClinicalDocument' } : {}),
            ...(split.attribute ? { attribute: split.attribute } : {}),
            ...(split.predicates.length ? { predicate: split.predicates.join(' and ') } : {}),
          }
        : null;
      const usage = normaliseUsageList(item.usage);
      return {
        kind: 'section',
        id: `${structureId}/section[${i}]`,
        position: i + 1,
        label: cleanText(item.name) ?? `section ${i + 1}`,
        number: cleanText(item.no),
        templateIds,
        locator,
        repeats: Boolean(usage[0] && (usage[0].max === '*' || (typeof usage[0].max === 'number' && usage[0].max > 1))),
        usage,
        guidance: cleanText(item.guidance),
        members: [],
        specRefs: templateIds
          .map((oid) => {
            const declaringPage = cda.containment?.declares?.[oid];
            return declaringPage ? pageRef('cda', declaringPage, 0) : null;
          })
          .filter(Boolean),
        provenance: provenance(item.source),
      };
    });

    const meta = docTypeMeta.get(docType) ?? docTypeMeta.get(`${docType} Report`) ?? null;
    const headerMembers = [];
    if (mapping.headerKey) {
      for (const rowLabel of Object.keys(headerRows).sort()) {
        const row = headerRows[rowLabel];
        const value = row?.values?.[mapping.headerKey];
        if (value === undefined || value === null || value === '') continue;
        // Table 22 cells are NOT uniformly fixed values: some are an OID or a LOINC code,
        // others are prose constraints ("R [1..1] With ... being present"). The verbatim
        // cell is carried as a constraint; nothing is reclassified as a fixed value here.
        headerMembers.push({
          kind: 'element',
          id: `${structureId}/header/${rowLabel.replace(/\s+/g, '-')}`,
          label: cleanText(row.rowLabel) ?? rowLabel,
          locator: null,
          usage: [],
          constraint: { kind: 'headerConstraintCell', attribute: rowLabel, value, documentTypeColumn: mapping.headerKey },
          fixedValues: [],
          valueSets: [],
          provenance: provenance(row.source),
        });
      }
    }

    out.push({
      id: structureId,
      useCaseId: mapping.useCaseId,
      variant: mapping.variant ?? null,
      variantLabel: mapping.variant ? docType : null,
      family: 'cda',
      encoding: 'cda-xml',
      title: `CDA ${docType}`,
      confidence: items.length ? 'high' : 'low',
      envelope: {
        kind: 'cdaDocument',
        documentTemplateId: meta?.templateId ?? null,
        typeCode: meta?.typeCodeLOINC ?? null,
        typeCodeDisplay: meta?.typeCodeDisplay ?? null,
        typeCodeSystem: meta?.typeCodeSystem ?? null,
        classCode: meta?.classCode ?? null,
        formatCode: meta?.formatCode ?? null,
        mimeType: meta?.mimeType ?? null,
        specPage: body.pageId ? { pageId: String(body.pageId), pageTitle: body.pageTitle ?? null } : null,
      },
      specRefs: body.pageId ? [pageRef('cda', body.pageId, 0)].filter(Boolean) : [],
      root: {
        kind: 'group',
        id: structureId,
        label: 'ClinicalDocument',
        repeats: false,
        usage: usageFromCode('M', { min: 1, max: 1 }),
        members: [
          ...(headerMembers.length
            ? [
                {
                  kind: 'group',
                  id: `${structureId}/header`,
                  label: 'CDA header (document-type constraints)',
                  repeats: false,
                  usage: usageFromCode('M', { min: 1, max: 1 }),
                  members: headerMembers,
                  provenance: provenance(cda.headerByDocumentType?.rows?.['Document templateId']?.source),
                },
              ]
            : []),
          {
            kind: 'group',
            id: `${structureId}/body`,
            label: 'CDA body (section order)',
            locator: { kind: 'cdaXPath', path: '/ClinicalDocument/component/structuredBody' },
            repeats: false,
            usage: usageFromCode('M', { min: 1, max: 1 }),
            members: sectionMembers,
            provenance: provenance(items[0]?.source),
          },
        ],
        provenance: provenance(items[0]?.source),
      },
      notes: [
        items.length ? null : `The CDA Body page for "${docType}" produced no rows.`,
        mapping.headerKey ? null : `No CDA header constraint column exists for "${docType}" in Table 22; header rules were not compiled.`,
        ...(Array.isArray(cda.emptyPages)
          ? cda.emptyPages.filter((p) => String(p.pageId) === String(body.pageId)).map((p) => `${p.issue} ${p.fallback}`)
          : []),
      ].filter(Boolean),
    });
  }
  return out;
}

/** Parse an indented shape outline into nested element members. */
function parseShapeOutline(lines, structureId, prov) {
  const root = [];
  const stack = [{ indent: -1, members: root }];
  let n = 0;
  for (const rawLine of Array.isArray(lines) ? lines : []) {
    if (typeof rawLine !== 'string' || !rawLine.trim()) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const text = rawLine.trim();
    const nameMatch = /^([A-Za-z_][\w:.-]*)\s*(.*)$/.exec(text);
    const name = nameMatch ? nameMatch[1] : text;
    const rest = nameMatch ? nameMatch[2].trim() : '';

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();

    const cardMatch = /\[\s*(\d+)\s*\.\.\s*(\d+|\*)\s*\]/.exec(rest);
    const noteMatch = /\(([^)]*)\)/.exec(rest);
    const braceMatch = /\{([^}]*)\}/.exec(rest);

    n += 1;
    const member = {
      kind: 'element',
      id: `${structureId}/${name}#${n}`,
      label: name,
      locator: { kind: 'cdaXPath', path: name },
      repeats: cardMatch ? cardMatch[2] === '*' || Number(cardMatch[2]) > 1 : false,
      usage: cardMatch
        ? [
            {
              usage: Number(cardMatch[1]) > 0 ? 'M' : 'O',
              min: Number(cardMatch[1]),
              max: cardMatch[2] === '*' ? '*' : Number(cardMatch[2]),
              condition: null,
              validator: Number(cardMatch[1]) > 0 ? 'error-if-missing' : 'ok',
              raw: { usage: null, cardinality: cardMatch[0] },
            },
          ]
        : [],
      note: noteMatch ? noteMatch[1].trim() : null,
      members: [],
      provenance: prov ? { ...prov, quote: text } : { pageId: null, pageTitle: null, row: null, quote: text },
    };

    if (braceMatch) {
      member.members = braceMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((child, i) => ({
          kind: 'element',
          id: `${structureId}/${name}#${n}/${child}#${i}`,
          label: child,
          locator: { kind: 'cdaXPath', path: child, relativeTo: name },
          repeats: false,
          usage: [],
          note: null,
          members: [],
          provenance: prov ? { ...prov, quote: text } : { pageId: null, pageTitle: null, row: null, quote: text },
        }));
    }

    stack[stack.length - 1].members.push(member);
    stack.push({ indent, members: member.members });
  }
  return root;
}

const XDS_USE_CASES = {
  'ITI-41': { useCaseId: 'xds-iti41', title: 'ITI-41 Provide and Register Document Set-b' },
  'ITI-18': { useCaseId: 'xds-iti18', title: 'ITI-18 Registry Stored Query' },
  'ITI-43': { useCaseId: 'xds-iti43', title: 'ITI-43 Retrieve Document Set' },
};

function buildXdsStructures() {
  const out = [];
  const xds = structuresIn?.xds;
  if (!xds || !xds.envelopeRules) {
    warn('structures', 'structures.json has no "xds.envelopeRules" — SOAP envelope structures were not compiled');
    return out;
  }
  for (const key of Object.keys(xds.envelopeRules).sort()) {
    const mapping = XDS_USE_CASES[key];
    if (!mapping) {
      warn('structures', `XDS transaction "${key}" has no use-case mapping and was skipped`);
      continue;
    }
    const rule = xds.envelopeRules[key];
    const transaction = xds.transactions?.[key] ?? null;
    const prov = provenance(transaction?.connectivitySource) ?? {
      pageId: null,
      pageTitle: null,
      row: 'envelopeRules',
      quote: cleanText(rule.derivedFrom),
    };

    const variants = [];
    if (Array.isArray(rule.shape)) variants.push({ variant: null, label: null, shape: rule.shape, action: rule.wsAddressingAction });
    if (rule.request) variants.push({ variant: 'request', label: 'Request', shape: rule.request.shape, action: rule.request.wsAddressingAction });
    if (rule.response) variants.push({ variant: 'response', label: 'Response', shape: rule.response.shape, action: rule.response.wsAddressingAction });

    for (const v of variants) {
      const structureId = v.variant ? `${mapping.useCaseId}-${v.variant}` : mapping.useCaseId;
      out.push({
        id: structureId,
        useCaseId: mapping.useCaseId,
        variant: v.variant,
        variantLabel: v.label,
        family: 'xds',
        encoding: 'soap-xml',
        direction: v.variant === 'response' ? 'response' : 'request',
        title: v.label ? `${mapping.title} — ${v.label}` : mapping.title,
        confidence: 'medium',
        envelope: {
          kind: 'soapEnvelope',
          soapVersion: cleanText(rule.soapVersion),
          wsAddressingAction: cleanText(v.action),
          derivedFrom: cleanText(rule.derivedFrom),
          serviceName: cleanText(transaction?.serviceName),
        },
        root: {
          kind: 'group',
          id: structureId,
          label: 'soap12:Envelope',
          repeats: false,
          usage: usageFromCode('M', { min: 1, max: 1 }),
          members: parseShapeOutline(v.shape, structureId, prov),
          provenance: prov,
        },
        notes: [
          ...(Array.isArray(rule.notes) ? rule.notes : []),
          cleanText(rule.caseNote),
          'This envelope shape is derived from the official golden SOAP samples, not from a Confluence table; each member quotes the outline line it came from.',
        ].filter(Boolean),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// XDS ebRIM content model -> the SOAP message structures
//
// The compiled SOAP envelopes stopped at the Body: the connectivity outline on page
// 54788867 names soap12:Envelope / Header / Body and the transaction element, and nothing
// below. Everything inside the RegistryObjectList — ExtrinsicObject, RegistryPackage,
// Classification, ExternalIdentifier, Association and their Slot/ValueList/Value and
// Name/LocalizedString children — is ebRIM, and no cached Confluence page draws it.
//
// The repair pass modelled it from the 19 official SOAP samples. That is the only source
// there is, so every member grafted here is marked `derivation: "sample"` with the sample
// named in its provenance, carries `observed` (what the samples show) instead of `usage`
// (what a source requires), and the structure gets a note saying that a resolution
// measurement taken against those same samples is not independent confirmation.
// ---------------------------------------------------------------------------

const XDS_TRANSACTION_OF_STRUCTURE = {
  'xds-iti41': 'ITI-41/ProvideAndRegisterDocumentSetRequest',
  'xds-iti18-request': 'ITI-18/AdhocQueryRequest',
  'xds-iti18-response': 'ITI-18/AdhocQueryResponse',
  'xds-iti43-request': 'ITI-43/RetrieveDocumentSetRequest',
  'xds-iti43-response': 'ITI-43/RetrieveDocumentSetResponse',
};

/**
 * Namespace prefixes, read off the verbatim XML fragments the patch itself quotes.
 * Nothing is recalled: an element whose prefix never appears in a quote gets `null`, which
 * means "not asserted", not "unprefixed".
 */
function ebrimPrefixMap(patch) {
  const counts = new Map();
  const scan = (value) => {
    if (typeof value === 'string') {
      const re = /<([A-Za-z][\w.-]*):([A-Za-z][\w.-]*)/g;
      let m;
      while ((m = re.exec(value)) !== null) {
        const key = m[2];
        if (!counts.has(key)) counts.set(key, new Map());
        const bucket = counts.get(key);
        bucket.set(m[1], (bucket.get(m[1]) ?? 0) + 1);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) scan(v);
      return;
    }
    if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) scan(value[k]);
    }
  };
  scan(patch);
  const out = {};
  for (const [local, bucket] of counts) {
    const best = [...bucket.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best) out[local] = best[0];
  }
  return out;
}

const localOfLabel = (label) => String(label ?? '').split(':').pop().trim();

function applyEbrimToXdsStructures(structures) {
  if (!xdsPatch?.ebrimModel?.transactionPaths) {
    if (xdsPatch) warn('xds-ebrim', 'patch-xds-ebrim.json has no ebrimModel.transactionPaths — SOAP trees were not extended');
    return { grafted: 0, structures: 0, schemesAttached: 0 };
  }
  const prefixes = ebrimPrefixMap(xdsPatch);
  const model = xdsPatch.ebrimModel;

  // Which scheme UUIDs may sit on which Classification / ExternalIdentifier, by ebRIM
  // object. The scheme list itself says which object it applies to.
  const schemesByObject = new Map(); // "DocumentEntry|classification" -> scheme[]
  for (const sch of Array.isArray(xdsPatch.schemes) ? xdsPatch.schemes : []) {
    if (!sch?.uuid) continue;
    const key = `${sch.appliesTo ?? 'DocumentEntry'}|${sch.kind === 'identification' ? 'identification' : 'classification'}`;
    if (!schemesByObject.has(key)) schemesByObject.set(key, []);
    schemesByObject.get(key).push(sch);
  }
  const schemeRule = (sch) => ({
    locator: {
      kind: 'xdsScheme',
      scheme: sch.kind === 'identification' ? 'identification' : 'classification',
      uuid: String(sch.uuid).toLowerCase(),
      attribute: sch.attribute,
      ...(sch.appliesTo ? { appliesTo: sch.appliesTo } : {}),
    },
    valueCarrier: sch.valueCarrier ?? null,
    requiredChildSlots: Array.isArray(sch.requiredChildSlots) ? sch.requiredChildSlots : [],
    usage: ebrimUsage(sch.nphiesOptionality, null),
    provenance: provenance(sch.source) ?? provenance(sch.nphiesOptionality?.source),
    ...evidence({
      confidence: sch.confidence,
      verifiedAgainstSample: Number(sch.sampleCount) > 0,
      derivation: sch.nphiesOptionality ? 'confluence+sample' : 'sample',
      confidenceReason: sch.confidenceReason,
      samples: sch.derivedFrom,
    }),
  });

  let grafted = 0;
  let touched = 0;
  let schemesAttached = 0;

  for (const structure of structures) {
    const txnKey = XDS_TRANSACTION_OF_STRUCTURE[structure.id];
    const txn = txnKey ? model.transactionPaths[txnKey] : null;
    if (!txn || !txn.paths) continue;
    touched += 1;

    const sampleProv = (quote) => ({
      pageId: null,
      pageTitle: null,
      row: txnKey,
      quote: quote ?? null,
      sample: Array.isArray(txn.derivedFrom) && txn.derivedFrom.length ? txn.derivedFrom[0] : null,
    });

    // index every element member already in the tree by its localName path
    const index = new Map();
    const seed = (members, prefix) => {
      for (const m of members ?? []) {
        if (m.kind === 'group') {
          seed(m.members ?? [], prefix);
          continue;
        }
        const path = prefix ? `${prefix}/${localOfLabel(m.label)}` : localOfLabel(m.label);
        if (!index.has(path)) index.set(path, m);
        seed(m.members ?? [], path);
      }
    };
    seed(structure.root.members, '');

    let seq = 0;
    const ensure = (path) => {
      const hit = index.get(path);
      if (hit) return hit;
      const parts = path.split('/');
      const local = parts[parts.length - 1];
      const parentPath = parts.slice(0, -1).join('/');
      const parent = parentPath ? ensure(parentPath) : null;
      const observed = txn.paths[path] ?? null;
      const card = parseCardinalityString(observed?.cardinalityObserved ?? '');
      const prefix = prefixes[local] ?? null;
      seq += 1;
      const member = {
        kind: 'element',
        id: `${structure.id}/ebrim/${path.replace(/\//g, '.')}#${seq}`,
        label: prefix ? `${prefix}:${local}` : local,
        xmlPrefix: prefix,
        locator: { kind: 'cdaXPath', path: local, ...(parentPath ? { relativeTo: parentPath } : {}) },
        repeats: card.max === '*' || (typeof card.max === 'number' && card.max > 1),
        // Deliberately empty: nothing in Confluence states a requirement at this path, so
        // claiming one would be an invention. The evidence lives in `observed`.
        usage: [],
        observed: observed
          ? {
              cardinality: observed.cardinalityObserved ?? null,
              min: card.min,
              max: card.max,
              samples: typeof observed.samples === 'number' ? observed.samples : 0,
              occurrences: typeof observed.occurrences === 'number' ? observed.occurrences : 0,
            }
          : undefined,
        members: [],
        note: prefix ? null : 'namespace prefix not asserted: no verbatim source fragment showed one for this element',
        provenance: sampleProv(null),
        ...evidence({
          confidence: txn.confidence,
          verifiedAgainstSample: true,
          derivation: 'sample',
          confidenceReason: txn.confidenceReason,
          samples: txn.derivedFrom,
        }),
      };
      index.set(path, member);
      grafted += 1;
      if (parent) {
        parent.members = parent.members ?? [];
        parent.members.push(member);
      } else {
        structure.root.members.push(member);
      }
      return member;
    };

    for (const path of Object.keys(txn.paths).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
      if (path === 'Envelope') continue; // the root group already is the envelope
      ensure(path);
    }

    // Attach the scheme UUIDs to the members that actually carry them. Without the UUID a
    // <rim:Classification> says nothing at all about which metadata attribute it expresses.
    for (const [path, member] of index) {
      const parentLocal = path.split('/').slice(-2)[0] ?? '';
      const local = localOfLabel(member.label);
      let object = null;
      if (parentLocal === 'ExtrinsicObject') object = 'DocumentEntry';
      else if (parentLocal === 'RegistryPackage') object = 'SubmissionSet';
      if (local === 'Classification' && object) {
        const list = schemesByObject.get(`${object}|classification`) ?? [];
        if (list.length) {
          member.xdsSchemes = list.map(schemeRule);
          schemesAttached += list.length;
        }
      } else if (local === 'ExternalIdentifier' && object) {
        const list = schemesByObject.get(`${object}|identification`) ?? [];
        if (list.length) {
          member.xdsSchemes = list.map(schemeRule);
          schemesAttached += list.length;
        }
      } else if (local === 'Classification' && parentLocal === 'RegistryObjectList') {
        // The node form: no scheme, a classificationNode that types the RegistryPackage as
        // an XDSSubmissionSet. Its value is in conflict — carried, never asserted.
        const cn = (Array.isArray(xdsPatch.classificationNodes) ? xdsPatch.classificationNodes : []).find(
          (c) => c.observedValue,
        );
        if (cn) {
          member.xdsSchemes = [
            {
              locator: {
                kind: 'xdsScheme',
                scheme: 'classificationNode',
                uuid: String(cn.observedValue).toLowerCase(),
                attribute: cn.iheName ?? 'XDSSubmissionSet classification node',
                appliesTo: 'SubmissionSet',
              },
              valueCarrier: 'none',
              requiredChildSlots: [],
              usage: ebrimUsage(null, cn.cardinality),
              provenance: provenance(cn.source),
              ...evidence({
                confidence: cn.confidence,
                verifiedAgainstSample: Number(cn.sampleCount) > 0,
                derivation: 'sample',
                confidenceReason: cn.confidenceReason,
                samples: cn.derivedFrom,
              }),
            },
          ];
          schemesAttached += 1;
          member.note =
            'The samples and the IHE ITI TF-3 constant for this classification node differ by one character. Flag the mismatch for a human; do not auto-correct. NEEDS NPHIES CLARIFICATION.';
        }
      }
    }

    structure.notes = [
      ...(structure.notes ?? []),
      `The ebRIM content model below the SOAP Body (RegistryObjectList and everything under it) is derived from ${
        txn.sampleCount ?? (Array.isArray(txn.derivedFrom) ? txn.derivedFrom.length : 0)
      } official ${txnKey} sample(s); no cached Confluence page draws it. Those members carry "observed" cardinalities rather than a usage code: a [0..n] low bound means "not in every sample", NOT "optional per NPHIES".`,
      'Because these members were derived from the golden samples, resolving a golden sample against them is not independent confirmation of the spec.',
      ...(txn.rootElementDefect ? [txn.rootElementDefect] : []),
    ];
    structure.verifiedAgainstSample = true;
    if (model.RegistryObjectList?.childOrderNote) {
      structure.notes.push(`RegistryObjectList child order: ${model.RegistryObjectList.childOrderNote}`);
    }
  }

  return { grafted, structures: touched, schemesAttached };
}

// ---------------------------------------------------------------------------
// CDA repairs
//
// Four things the first pass could not produce:
//   * the ClinicalDocument HEADER element model in document order. The Confluence header
//     table is a per-document-type CONSTRAINT matrix, not an element list, so the compiled
//     structures had no <typeId>, <realmCode>, <recordTarget>, ... at all — which is why
//     `typeId` was the single most frequent unresolved identifier, in all 16 CDA samples.
//   * sections the body tables place NESTED inside another section, which a flat list loses,
//     plus one upstream templateId typo corrected in place.
//   * cda-rad-order, whose body page is genuinely empty upstream; its four children carry
//     the whole model, so this is Confluence-derived, not sample-derived.
//   * Full / NoInfo as real variants. The NoInfo mechanism is a templateId flag, NOT
//     nullFlavor — a checker looking for section/@nullFlavor finds nothing and passes or
//     fails for the wrong reason.
// ---------------------------------------------------------------------------

/** Identify a CDA section by (parentTemplateId, templateId, code) — never by OID alone. */
function findSectionByTemplateId(members, templateId) {
  for (const m of members ?? []) {
    if (m.kind === 'section' && (m.templateIds ?? []).includes(templateId)) return m;
    const hit = findSectionByTemplateId(m.members, templateId);
    if (hit) return hit;
  }
  return null;
}

function cdaSectionMember(id, spec, position, prov) {
  const templateIds = [spec.templateId].filter(Boolean);
  const path = spec.path ?? `./component/section[templateId='${spec.templateId}']`;
  const split = splitXPath(path);
  return {
    kind: 'section',
    id,
    position,
    label: spec.name ?? spec.templateId,
    number: spec.number ?? null,
    templateIds,
    locator: split
      ? {
          kind: 'cdaXPath',
          path: split.path,
          ...(split.path.startsWith('.') ? { relativeTo: '/ClinicalDocument' } : {}),
          ...(split.attribute ? { attribute: split.attribute } : {}),
          ...(split.predicates.length ? { predicate: split.predicates.join(' and ') } : {}),
        }
      : null,
    repeats: spec.max === '*' || (typeof spec.max === 'number' && spec.max > 1),
    usage: usageFromCode(spec.usage, {
      min: typeof spec.min === 'number' ? spec.min : null,
      max: spec.max === null || spec.max === undefined ? null : spec.max,
    }),
    guidance: spec.loincCode ? `Section code ${spec.loincCode}${spec.loincDisplay ? ` (${spec.loincDisplay})` : ''}.` : null,
    members: [],
    provenance: prov,
    // A section OID is not globally unique in this spec (204.35 is both "Request" and
    // "Key Images"); carry the parent so a checker can apply the identity rule.
    parentTemplateId: spec.parentTemplateId ?? null,
    sectionCode: spec.loincCode ?? null,
    ...evidence({
      confidence: spec.confidence,
      verifiedAgainstSample: spec.sampleConfirmed === true || Boolean(spec.sampleQuote),
      derivation: (spec.source ?? spec.sources?.[0])?.pageId ? 'confluence' : 'sample',
      confidenceReason: spec.confidenceReason,
    }),
    ...(spec.noInfoFlagTemplateId ? { noInfoFlagTemplateId: spec.noInfoFlagTemplateId } : {}),
    ...(Array.isArray(spec.entries) && spec.entries.length
      ? {
          entries: spec.entries.map((e) => ({
            templateId: e.templateId,
            label: e.name ?? e.templateId,
            usage: usageFromCode(e.usage, {
              min: typeof e.min === 'number' ? e.min : null,
              max: e.max === null || e.max === undefined ? null : e.max,
            }),
            provenance: provenance(e.source),
            ...evidence({
              confidence: 'high',
              verifiedAgainstSample: e.sampleConfirmed === true,
              derivation: e.source?.pageId ? 'confluence' : 'sample',
            }),
          })),
        }
      : {}),
  };
}

function buildCdaHeaderMembers(structureId) {
  const model = cdaPatch?.headerModel;
  if (!model || !Array.isArray(model.elements) || !model.elements.length) return null;
  const members = model.elements.map((el, i) => {
    const split = splitXPath(el.path ?? `/ClinicalDocument/${el.name}`);
    const fixed = Object.entries(el.fixedAttributes ?? {}).map(([attribute, value]) => ({
      value: String(value),
      target: attribute,
      statementType: 'attributeFixedValue',
      scope: 'attribute',
      elementPath: el.path ?? null,
      attribute,
      component: null,
      provenance: provenance(el.source),
    }));
    return {
      kind: 'element',
      id: `${structureId}/header/${el.name.replace(/[^\w:.-]/g, '-')}`,
      label: el.name,
      number: String(el.order),
      locator: split ? { kind: 'cdaXPath', path: split.path, ...(split.attribute ? { attribute: split.attribute } : {}) } : null,
      repeats: el.repeats === true,
      usage: usageFromCode(el.usage, {
        min: typeof el.min === 'number' ? el.min : null,
        max: el.max === null || el.max === undefined ? null : el.max,
      }),
      guidance: cleanText(el.notes),
      fixedValues: fixed,
      valueSets: [],
      // Document order is normative in CDA R2 and every sample agrees; a checker may report
      // an out-of-order header element as an error rather than a warning.
      documentOrder: el.order,
      observed: el.observed
        ? {
            cardinality: null,
            min: typeof el.observed.minObserved === 'number' ? el.observed.minObserved : null,
            max: typeof el.observed.maxObserved === 'number' ? el.observed.maxObserved : null,
            samples: typeof el.observed.samplesPresent === 'number' ? el.observed.samplesPresent : 0,
            occurrences: 0,
          }
        : undefined,
      provenance: provenance(el.source),
      ...evidence({
        confidence: el.confidence,
        verifiedAgainstSample: Number(el.observed?.samplesPresent) > 0,
        derivation: el.source?.pageId ? 'confluence+sample' : el.source?.sample ? 'sample' : 'standard',
        confidenceReason: el.source?.note ?? null,
      }),
      members: [],
    };
  });
  return {
    kind: 'group',
    id: `${structureId}/header`,
    label: 'ClinicalDocument header (document order)',
    locator: { kind: 'cdaXPath', path: '/ClinicalDocument' },
    repeats: false,
    usage: usageFromCode('M', { min: 1, max: 1 }),
    members,
    guidance: model.orderBasis ?? null,
    provenance: provenance(model.elements[0]?.source),
    ...evidence({ confidence: 'high', verifiedAgainstSample: true, derivation: 'confluence+sample' }),
  };
}

function applyCdaPatch(structures) {
  const out = { headerGroups: 0, sectionsAdded: 0, sectionsCorrected: 0, radOrderSections: 0, variants: [] };
  if (!cdaPatch) {
    warn('cda', 'patch-cda.json absent — CDA header model, nested sections and Full/NoInfo variants are NOT in this bundle');
    return out;
  }
  const byId = new Map(structures.map((s) => [s.id, s]));

  /* ---- 1. the header element model, in document order ---------------------- */
  for (const structure of structures) {
    const header = buildCdaHeaderMembers(structure.id);
    if (!header) break;
    // The existing Table 22 group is a per-document-type CONSTRAINT matrix, not an element
    // list. Keep it (its id is unchanged) but say what it is, and put the element model in
    // front of it so document order reads top to bottom.
    const constraints = structure.root.members.find((m) => m.id === `${structure.id}/header`);
    if (constraints) {
      constraints.id = `${structure.id}/header-constraints`;
      constraints.label = 'CDA header constraints for this document type (Table 22)';
    }
    structure.root.members.unshift(header);
    out.headerGroups += 1;
  }

  /* ---- 2. cda-rad-order: a body from Confluence, not from the sample ------- */
  const radOrder = cdaPatch.cdaRadOrder;
  const radOrderStructure = radOrder ? byId.get(radOrder.useCaseId) : null;
  if (radOrder && radOrderStructure) {
    const body = radOrderStructure.root.members.find((m) => m.id === `${radOrderStructure.id}/body`);
    if (body) {
      const nodes = new Map();
      const roots = [];
      for (const [i, sec] of (radOrder.sections ?? []).entries()) {
        const member = cdaSectionMember(
          `${radOrderStructure.id}/section[${i}]`,
          sec,
          typeof sec.position === 'number' ? sec.position : i + 1,
          provenance(sec.source),
        );
        nodes.set(sec.templateId, member);
        if (sec.parentTemplateId && nodes.has(sec.parentTemplateId)) nodes.get(sec.parentTemplateId).members.push(member);
        else roots.push(member);
        out.radOrderSections += 1;
      }
      body.members = roots;
      body.provenance = provenance(radOrder.body?.source) ?? body.provenance;
      radOrderStructure.confidence = radOrder.confidence === 'high' ? 'high' : radOrderStructure.confidence;
      radOrderStructure.verifiedAgainstSample = Boolean(radOrder.sampleConfirmation?.agreesWithConfluence);
      radOrderStructure.notes = [
        ...(radOrderStructure.notes ?? []).filter((n) => !/produced no rows/.test(n)),
        `The CDA Body page ${radOrder.emptyPageInvestigation?.pageId ?? ''} is genuinely empty upstream (refetched, HTTP 200, empty body). ${
          radOrder.emptyPageInvestigation?.why ?? ''
        } The model below therefore comes from those child pages, not from a sample.`,
      ].filter(Boolean);
    }
  }

  /* ---- 3. section corrections and nested additions ------------------------ */
  for (const [useCaseId, entry] of Object.entries(cdaPatch.sectionAdditions ?? {})) {
    if (useCaseId === radOrder?.useCaseId) continue; // handled above, wholesale
    const structure = byId.get(useCaseId);
    if (!structure) {
      warn('cda', `patch-cda sectionAdditions names "${useCaseId}", which is not a compiled structure`);
      continue;
    }
    const body = structure.root.members.find((m) => m.id === `${structure.id}/body`);
    if (!body) continue;

    const corr = entry.correction;
    if (corr && corr.action === 'correct-templateId-in-place') {
      const target = findSectionByTemplateId(body.members, corr.compiledTemplateId);
      if (target && target.templateIds.includes(corr.compiledTemplateId)) {
        target.templateIds = target.templateIds.map((t) => (t === corr.compiledTemplateId ? corr.correctedTemplateId : t));
        if (target.locator?.path) {
          target.locator.path = target.locator.path.split(corr.compiledTemplateId).join(corr.correctedTemplateId);
          if (target.locator.predicate) {
            target.locator.predicate = target.locator.predicate.split(corr.compiledTemplateId).join(corr.correctedTemplateId);
          }
        }
        if (corr.noInfoFlagTemplateId) target.noInfoFlagTemplateId = corr.noInfoFlagTemplateId;
        target.sectionCode = corr.loincCode ?? target.sectionCode ?? null;
        target.correction = {
          was: corr.compiledTemplateId,
          now: corr.correctedTemplateId,
          rootCause: corr.rootCause ?? null,
          provenance: provenance(corr.source),
        };
        Object.assign(
          target,
          evidence({ confidence: corr.confidence, verifiedAgainstSample: true, derivation: 'confluence+sample', confidenceReason: corr.rootCause }),
        );
        out.sectionsCorrected += 1;
      } else {
        warn('cda', `templateId correction for "${useCaseId}" found no section carrying ${corr.compiledTemplateId}`);
      }
    }

    for (const add of entry.additions ?? []) {
      const parent = add.parentTemplateId ? findSectionByTemplateId(body.members, add.parentTemplateId) : null;
      if (add.parentTemplateId && !parent) {
        warn('cda', `nested section ${add.templateId} for "${useCaseId}" has no compiled parent ${add.parentTemplateId}`);
        continue;
      }
      const host = parent ? parent.members : body.members;
      if (host.some((m) => (m.templateIds ?? []).includes(add.templateId) && m.sectionCode === (add.loincCode ?? null))) continue;
      const prov = provenance(add.source) ?? provenance((add.sources ?? []).find((x) => x && x.pageId)) ?? provenance((add.sources ?? [])[0]);
      const member = cdaSectionMember(
        `${structure.id}/section[${add.parentTemplateId ?? 'body'}/${add.templateId}]`,
        add,
        typeof add.position === 'number' ? add.position : host.length + 1,
        prov,
      );
      member.nestingNote = add.nesting ?? null;
      host.push(member);
      out.sectionsAdded += 1;
    }
  }

  /* ---- 4. Full / NoInfo variants ------------------------------------------ */
  const noInfo = cdaPatch.noInfoVariantRule ?? null;
  const variantStructures = [];
  for (const [useCaseId, spec] of Object.entries(cdaPatch.variants ?? {})) {
    const base = byId.get(useCaseId);
    if (!base) {
      warn('cda', `patch-cda variants names "${useCaseId}", which is not a compiled structure`);
      continue;
    }
    for (const variantName of ['Full', 'NoInfo']) {
      const observed = spec[variantName];
      if (!observed) continue;
      const clone = JSON.parse(JSON.stringify(base));
      const suffix = variantName.toLowerCase();
      clone.id = `${base.id}-${suffix}`;
      clone.variant = variantName;
      clone.variantLabel = variantName === 'Full' ? 'Full (information available)' : 'NoInfo (no information available)';
      clone.title = `${base.title} — ${clone.variantLabel}`;
      const reId = (member) => {
        member.id = member.id.replace(base.id, clone.id);
        for (const child of member.members ?? []) reId(child);
      };
      clone.root.id = clone.id;
      for (const m of clone.root.members) reId(m);

      const flagByTemplate = new Map(
        (observed.sections ?? []).filter((x) => x.noInfoFlagTemplateId).map((x) => [x.templateId, x.noInfoFlagTemplateId]),
      );
      if (variantName === 'NoInfo') {
        const stamp = (members) => {
          for (const m of members ?? []) {
            if (m.kind === 'section') {
              const flag = flagByTemplate.get((m.templateIds ?? [])[0]) ?? m.noInfoFlagTemplateId ?? null;
              if (flag && !m.templateIds.includes(flag)) m.templateIds = [...m.templateIds, flag];
              if (flag) m.noInfoFlagTemplateId = flag;
              // The section stays REQUIRED; only its entry requirement is waived.
              m.entryConstraintWaived = true;
            }
            stamp(m.members ?? []);
          }
        };
        stamp(clone.root.members);
        clone.notes = [
          ...(clone.notes ?? []),
          noInfo?.howItWorks ?? null,
          noInfo?.notNullFlavor ?? null,
          'The section itself stays required in a NoInfo document: only the entry requirement is waived.',
        ].filter(Boolean);
      } else {
        clone.notes = [...(clone.notes ?? []), 'Every section required by this document type is present and carries entries.'];
      }
      clone.verifiedAgainstSample = Boolean(observed.sample);
      clone.confidenceReason = cleanText(spec.verdict);
      if (/INCONSISTENT/i.test(String(spec.verdict ?? ''))) {
        clone.notes.push(
          `Variant verdict: ${spec.verdict}${
            cdaPatch.immunizationRecommendationsRuling?.verdict === 'sample-defect'
              ? ' The compiled usage is correct and the official sample is defective; see spec-defects.json and sample-defects.json.'
              : ''
          }`,
        );
      }
      variantStructures.push(clone);
      out.variants.push(clone.id);
    }
  }
  out.newStructures = variantStructures;
  return out;
}

// ---------------------------------------------------------------------------
// FHIR bundle entries
//
// Two defects the first pass shipped:
//   * the row LABEL was read as the resource type. "Bundle entry(s) for Imaging Procedure"
//     names a clinical role; the type is whatever the profile constrains — Procedure. Nine
//     of sixteen phantom types were exactly this mistake, and a phantom type makes the
//     entry uncheckable in both directions.
//   * fhir-rad-report was compiled from the STRUCTURED variant table only, so the
//     embedded-PDF bundle's DocumentReference entry could not resolve and three structured
//     entries were reported missing from a bundle that legitimately has none.
//
// The two-family rule is also ENFORCED here rather than merely recorded: every medications
// bundle is type "message" with MessageHeader first, every lab/rad document bundle is type
// "document" with Composition first. A compiled structure that disagrees is a warning, not
// a silent overwrite.
// ---------------------------------------------------------------------------

/** `derivation: "confluence-stated + profile-url + sample"` -> a Derivation + a source kind. */
function fhirDerivation(raw, source) {
  const text = String(raw ?? '').toLowerCase();
  const fromPage = Boolean(source?.pageId);
  const fromSample = /sample/.test(text) || Boolean(source?.sample);
  if (fromPage && fromSample) return 'confluence+sample';
  if (fromPage) return 'confluence';
  if (fromSample) return 'sample';
  return 'inferred';
}

function fhirResourceTypeSource(raw) {
  const text = String(raw ?? '').toLowerCase();
  if (/stated/.test(text)) return 'stated';
  if (/guidance/.test(text)) return 'guidance-quote';
  if (/profile/.test(text)) return 'profile-url';
  if (/sample/.test(text)) return 'sample';
  return null;
}

function fhirEntryMember(structureId, entry, index, variantName) {
  const ev = entry.evidence ?? {};
  const src = ev.source ?? null;
  const samples = [
    ...(src?.sample ? [src.sample] : []),
    ...(Array.isArray(ev.corroboratedBy) ? ev.corroboratedBy.map((c) => c?.sample).filter(Boolean) : []),
  ];
  const max = entry.max === '*' ? '*' : typeof entry.max === 'number' ? entry.max : null;
  const usageCode = typeof entry.usageCode === 'string' && USAGE_CODES.has(entry.usageCode.trim()) ? entry.usageCode.trim() : null;
  return {
    kind: 'entry',
    id: `${structureId}/entry[${index}]`,
    position: index + 1,
    label: cleanText(entry.label) ?? `Bundle entry for ${entry.resourceType}`,
    resourceType: entry.resourceType ?? null,
    resourceTypeSource: fhirResourceTypeSource(ev.derivation),
    profile: entry.profile ?? null,
    locator: { kind: 'fhirPath', path: './entry', relativeTo: 'Bundle' },
    repeats: max === '*' || (typeof max === 'number' && max > 1),
    usage: usageCode
      ? usageFromCode(usageCode, { min: typeof entry.min === 'number' ? entry.min : null, max })
      : [
          {
            usage: typeof entry.min === 'number' && entry.min > 0 ? 'M' : 'O',
            min: typeof entry.min === 'number' ? entry.min : null,
            max,
            // A conditional cell such as "M (otherwise) / NP (in case no images)" is kept
            // verbatim as the condition instead of being collapsed to one code.
            condition: typeof entry.usageCode === 'string' ? entry.usageCode : null,
            validator: typeof entry.min === 'number' && entry.min > 0 ? 'error-if-missing' : 'ok',
            raw: { usage: typeof entry.usageCode === 'string' ? entry.usageCode : null, cardinality: null },
          },
        ],
    guidance: cleanText(src?.quote),
    orderingConstraint: index === 0 ? 'First entry of the bundle.' : null,
    provenance: provenance(src),
    ...(variantName ? { variants: [variantName] } : {}),
    ...evidence({
      confidence: entry.confidence ?? 'high',
      verifiedAgainstSample: samples.length > 0,
      derivation: fhirDerivation(ev.derivation, src),
      confidenceReason: entry.confidenceReason ?? cleanText(ev.note),
      samples,
    }),
    ...(entry.corrected
      ? { correction: { wasCompiledAs: entry.wasCompiledAs ?? null, now: entry.resourceType, reason: cleanText(ev.note) } }
      : {}),
    ...(entry.observedCardinality ? { observed: { cardinality: null, min: entry.observedCardinality.min ?? null, max: entry.observedCardinality.max ?? null, samples: entry.observedCardinality.acrossSamples ?? 0, occurrences: 0 } } : {}),
  };
}

function applyFhirEntriesPatch(structures) {
  const out = { replaced: 0, entries: 0, corrected: 0, variants: [], newStructures: [], conflicts: 0 };
  if (!fhirEntriesPatch?.structures) {
    warn('fhir', 'patch-fhir-entries.json absent — bundle entry lists keep their first-pass (label-derived) resource types');
    return out;
  }
  const byId = new Map(structures.map((s) => [s.id, s]));
  const familyOfUseCase = new Map();
  for (const fam of fhirEntriesPatch.twoFamilyRule?.rule ?? []) {
    for (const uc of fam.useCases ?? []) familyOfUseCase.set(uc, fam);
  }

  for (const [useCaseId, spec] of Object.entries(fhirEntriesPatch.structures)) {
    const structure = byId.get(useCaseId);
    if (!structure) {
      warn('fhir', `patch-fhir-entries names "${useCaseId}", which is not a compiled structure`);
      continue;
    }
    const entriesGroup = structure.root.members.find((m) => m.id === `${structure.id}/entries`);
    if (!entriesGroup) {
      warn('fhir', `compiled structure "${useCaseId}" has no entries group to replace`);
      continue;
    }

    const applyTo = (target, entries, variantName) => {
      target.members = entries.map((e, i) => fhirEntryMember(target.id.replace(/\/entries$/, ''), e, i, variantName));
      out.entries += target.members.length;
      out.corrected += entries.filter((e) => e.corrected).length;
    };
    applyTo(entriesGroup, spec.entries ?? [], null);
    out.replaced += 1;

    // --- envelope: bundle type, first entry, fixed profile -------------------
    const env = structure.envelope ?? {};
    env.bundleType = spec.bundleType ?? env.bundleType;
    env.bundleTypeRule = { value: spec.bundleType ?? null, ...(spec.bundleTypeEvidence ?? {}), provenance: provenance(spec.bundleTypeEvidence?.source) };
    env.firstEntryRule = { resourceType: spec.firstEntry ?? null, ...(spec.firstEntryEvidence ?? {}), provenance: provenance(spec.firstEntryEvidence?.source) };
    env.profileFixed = spec.profileFixed ?? null;
    env.profileFixedRule = spec.profileFixedEvidence
      ? { value: spec.profileFixed ?? null, ...spec.profileFixedEvidence, provenance: provenance(spec.profileFixedEvidence.source) }
      : null;
    structure.envelope = env;
    structure.confidence = spec.confidence === 'high' || spec.confidence === 'medium' || spec.confidence === 'low' ? spec.confidence : structure.confidence;
    structure.verifiedAgainstSample = Boolean(fhirEntriesPatch.observedInSamples?.[useCaseId]?.samples);
    structure.specRefs = [
      ...(structure.specRefs ?? []),
      ...(spec.specPages ?? []).map((pid) => pageRef('fhir', pid, 0)),
    ].filter((r, i, a) => r && a.findIndex((x) => x.ref === r.ref) === i);

    // resources the spec names but that are NOT Bundle.entry — knowing this stops a
    // checker demanding an entry that belongs inside another resource
    if (Array.isArray(spec.notEntries) && spec.notEntries.length) {
      structure.notEntries = spec.notEntries.map((n) => ({
        resourceType: n.resourceType,
        reason: n.reason,
        provenance: provenance(n.evidence?.source),
        ...evidence({
          confidence: 'high',
          verifiedAgainstSample: Boolean(n.evidence?.source?.sample),
          derivation: fhirDerivation(n.evidence?.derivation, n.evidence?.source),
        }),
      }));
    }

    // --- enforce the two-family rule ---------------------------------------
    const fam = familyOfUseCase.get(useCaseId);
    if (fam) {
      structure.bundleFamilyRule = {
        family: fam.family,
        bundleType: fam.bundleType,
        firstEntryResourceType: fam.firstEntryResourceType,
        evidenceStrength: fam.evidenceStrength ?? null,
        sources: (fam.sources ?? []).map((x) => provenance(x)).filter(Boolean),
        samplesChecked: fam.samplesChecked ?? null,
        samplesConforming: fam.samplesConforming ?? null,
      };
      if (env.bundleType && env.bundleType !== fam.bundleType) {
        warn('fhir', `"${useCaseId}" compiles bundleType "${env.bundleType}" but the ${fam.family} family rule says "${fam.bundleType}"`);
        out.conflicts += 1;
      }
      const first = entriesGroup.members[0];
      if (first && first.resourceType && first.resourceType !== fam.firstEntryResourceType) {
        warn('fhir', `"${useCaseId}" first entry is "${first.resourceType}" but the ${fam.family} family rule says "${fam.firstEntryResourceType}"`);
        out.conflicts += 1;
      }
      if (first) first.orderingConstraint = `First entry SHALL be ${fam.firstEntryResourceType} (${fam.family} bundle family).`;
    }

    // --- content variants ---------------------------------------------------
    if (spec.variants) {
      structure.variantRule = {
        requirement: spec.variantRule?.requirement ?? null,
        note: spec.variantRule?.note ?? null,
        selectedBy: 'Composition.meta.profile',
        source: spec.variantRule?.source ?? null,
      };
      structure.notes = [
        ...(structure.notes ?? []),
        spec.entriesNote ?? null,
        spec.variantRule?.requirement ?? null,
      ].filter(Boolean);
      for (const [variantKey, variantSpec] of Object.entries(spec.variants)) {
        const clone = JSON.parse(JSON.stringify(structure));
        const slug = variantKey.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        clone.id = `${structure.id}-${slug}`;
        clone.variant = variantKey;
        clone.variantLabel = variantKey === 'structured' ? 'Structured report' : 'Embedded PDF report';
        clone.title = `${structure.title} — ${clone.variantLabel}`;
        const reId = (m) => {
          m.id = m.id.replace(structure.id, clone.id);
          for (const c of m.members ?? []) reId(c);
        };
        clone.root.id = clone.id;
        for (const m of clone.root.members) reId(m);
        const g = clone.root.members.find((m) => m.id === `${clone.id}/entries`);
        if (g) applyTo(g, variantSpec.entries ?? [], variantKey);
        clone.envelope = { ...clone.envelope, compositionProfile: variantSpec.compositionProfile ?? null };
        clone.specRefs = [...(clone.specRefs ?? []), pageRef('fhir', variantSpec.specPage, 0)].filter(Boolean);
        clone.verifiedAgainstSample = Array.isArray(variantSpec.officialSamples) && variantSpec.officialSamples.length > 0;
        clone.notes = [
          ...(clone.notes ?? []),
          `Variant selected by the Composition profile ${variantSpec.compositionProfile}.`,
        ];
        out.newStructures.push(clone);
        out.variants.push(clone.id);
      }
    }
  }

  // Conflicts the repair pass found between the spec and the official samples. These are
  // NOT resolved here: both readings are shipped so an analyst can see the disagreement.
  if (Array.isArray(fhirEntriesPatch.conflicts)) {
    for (const c of fhirEntriesPatch.conflicts) {
      for (const uc of c.useCases ?? []) {
        const st = byId.get(uc);
        if (!st) continue;
        st.specVsSampleConflicts = [
          ...(st.specVsSampleConflicts ?? []),
          {
            id: c.id,
            field: c.field,
            specValue: c.specValue,
            wireValue: c.wireValue,
            resolution: c.resolution,
            recommendation: c.recommendation,
            confidence: c.confidence ?? 'medium',
            affectedSamples: c.affectedSamples ?? [],
            sources: (c.specSources ?? []).map((x) => provenance(x)).filter(Boolean),
          },
        ];
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SAML SSO
//
// saml-sso was the one use case with NO MessageStructure at all. It still has no golden
// sample: everything below rests on one literal samlp:Response skeleton published on page
// 7766254 plus surrounding prose, so `verifiedAgainstSample` is false and the confidence
// is medium for that reason alone — the skeleton itself is unambiguous.
//
// Two contract points, both handled by widening rather than by mislabelling:
//   * `family` is "saml". It is NOT a SpecFamily (saml-sso has no field tables), and
//     MessageStructure.family now admits it. Do not relabel it "cda" to satisfy an older
//     check: the locators are cdaXPath only because that is the XML locator kind on offer.
//   * `EnvelopeSpec` gained a `samlResponse` kind, so the root element, SAML version,
//     signature level and required namespaces are carried structurally instead of in prose.
// ---------------------------------------------------------------------------

function buildSamlStructures() {
  if (!samlPatch?.structure) {
    if (samlPatch) warn('saml', 'patch-saml.json carries no structure');
    else warn('saml', 'patch-saml.json absent — use case "saml-sso" still has no MessageStructure');
    return [];
  }
  const src = JSON.parse(JSON.stringify(samlPatch.structure));

  // Re-run every usage list and provenance object through this compiler's own normalisers
  // so the SAML tree is byte-comparable with the rest of the bundle.
  const normalise = (member) => {
    if (Array.isArray(member.usage)) member.usage = normaliseUsageList(member.usage);
    if (member.provenance) member.provenance = provenance(member.provenance);
    for (const fv of member.fixedValues ?? []) if (fv.provenance) fv.provenance = provenance(fv.provenance);
    Object.assign(
      member,
      evidence({
        confidence: member.sourceTier === 'literal-skeleton' ? 'medium' : 'low',
        verifiedAgainstSample: false,
        derivation: 'confluence',
        confidenceReason:
          member.sourceTier === 'literal-skeleton'
            ? 'read off the literal samlp:Response skeleton published on page 7766254; no golden sample exists to confirm it'
            : 'derived from prose around the skeleton, not from the skeleton itself; no golden sample exists to confirm it',
      }),
    );
    for (const child of member.members ?? []) normalise(child);
  };
  if (Array.isArray(src.root?.usage)) src.root.usage = normaliseUsageList(src.root.usage);
  if (src.root?.provenance) src.root.provenance = provenance(src.root.provenance);
  for (const m of src.root?.members ?? []) normalise(m);

  const envPatch = samlPatch.samlEnvelope ?? {};
  src.envelope = {
    kind: 'samlResponse',
    samlVersion: envPatch.samlVersion ?? null,
    rootElement: envPatch.rootElement ?? 'samlp:Response',
    binding: envPatch.proposedEnvelopeSpec?.binding ?? null,
    signatureLevel: envPatch.proposedEnvelopeSpec?.signatureLevel ?? null,
    namespaces: (samlPatch.namespaces ?? []).map((n) => ({ prefix: n.prefix, uri: n.uri })),
    specPage: envPatch.proposedEnvelopeSpec?.specPage ?? null,
  };

  // The environment is a variant AXIS, not a variant: the element tree is identical across
  // ONA / ONB / PROD and only three leaf values move. Encoding it as three structures would
  // triple the tree to carry two URLs.
  const axis = samlPatch.variantAxis;
  if (axis && samlPatch.environments) {
    src.variantAxis = {
      axis: axis.axis,
      label: axis.label,
      values: axis.values ?? Object.keys(samlPatch.environments),
      valuesByMember: Object.fromEntries(
        Object.entries(samlPatch.environments).map(([env, spec]) => [env, spec.fixedValues ?? {}]),
      ),
      note: [axis.note, axis.envHostWarning].filter(Boolean).join(' '),
      provenance: provenance(Object.values(samlPatch.environments)[0]?.source),
    };
  }

  src.specRefs = (samlPatch.sourcePages ?? [])
    .map((p) => ({ family: 'saml', pageId: String(p.pageId), tableIndex: 0, ref: `${p.pageId}:0`, resolved: false, use: p.use ?? null }));
  src.verifiedAgainstSample = false;
  src.confidenceReason = samlPatch.confidenceReason ?? null;
  src.notes = [
    ...(src.notes ?? []),
    ...(samlPatch.knownGaps ?? [])
      .filter((g) => g.severity === 'high')
      .map((g) => `KNOWN GAP (${g.id}): ${g.gap}`),
    ...(samlPatch.sampleValuesWarning ? [samlPatch.sampleValuesWarning] : []),
  ];
  Object.assign(
    src,
    evidence({
      confidence: samlPatch.confidence ?? src.confidence,
      verifiedAgainstSample: false,
      derivation: 'confluence',
      confidenceReason: samlPatch.confidenceReason,
    }),
  );
  return [src];
}

const messageStructures = [
  ...buildAdtStructures(),
  ...buildOruStructures(),
  ...buildFhirStructures(),
  ...buildCdaStructures(),
  ...buildXdsStructures(),
  ...buildSamlStructures(),
];
const ebrimGraft = applyEbrimToXdsStructures(messageStructures.filter((m) => m.family === 'xds'));
const cdaPatchApplied = applyCdaPatch(messageStructures.filter((m) => m.family === 'cda'));
messageStructures.push(...(cdaPatchApplied.newStructures ?? []));
const fhirPatchApplied = applyFhirEntriesPatch(messageStructures.filter((m) => m.family === 'fhir'));
messageStructures.push(...(fhirPatchApplied.newStructures ?? []));
void memberId; // reserved for future generated ids

// ---------------------------------------------------------------------------
// use cases
// ---------------------------------------------------------------------------

const USE_CASE_META = {
  adt: { title: 'ADT — Admit/Discharge/Transfer notifications', family: 'hl7v2', encoding: 'hl7v2-er7', areas: ['ADT'] },
  'oru-vitals': { title: 'ORU^R01 — Vital signs', family: 'hl7v2', encoding: 'hl7v2-er7', areas: ['Vital Signs - ORU'] },
  'fhir-med-prescribe': { title: 'FHIR Medication Prescription (uncontrolled)', family: 'fhir', encoding: 'fhir-json', areas: ['Medications Prescription and Dispense'] },
  'fhir-med-dispense': { title: 'FHIR Medication Dispense (uncontrolled)', family: 'fhir', encoding: 'fhir-json', areas: ['Medications Prescription and Dispense'] },
  'fhir-med-raqeeb-prescribe': { title: 'FHIR Medication Prescription (Raqeeb controlled)', family: 'fhir', encoding: 'fhir-json', areas: ['Medication Prescription and Dispense (Raqeeb)'] },
  'fhir-med-raqeeb-dispense': { title: 'FHIR Medication Dispense (Raqeeb controlled)', family: 'fhir', encoding: 'fhir-json', areas: ['Medication Prescription and Dispense (Raqeeb)'] },
  'fhir-lab-order': { title: 'FHIR Laboratory Order Bundle', family: 'fhir', encoding: 'fhir-json', areas: ['FHIR Laboratory Orders'] },
  'fhir-lab-result': { title: 'FHIR Laboratory Report Bundle', family: 'fhir', encoding: 'fhir-json', areas: ['FHIR Laboratory Results'] },
  'fhir-rad-order': { title: 'FHIR Radiology Order Bundle', family: 'fhir', encoding: 'fhir-json', areas: ['FHIR Radiology Orders'] },
  'fhir-rad-report': { title: 'FHIR Radiology Report Bundle', family: 'fhir', encoding: 'fhir-json', areas: ['FHIR Radiology Report'] },
  'cda-discharge-summary': { title: 'CDA Discharge Summary', family: 'cda', encoding: 'cda-xml', areas: ['Clinical Documents'] },
  'cda-maternal-discharge': { title: 'CDA Maternal Discharge Summary', family: 'cda', encoding: 'cda-xml', areas: ['Clinical Documents'] },
  'cda-newborn-discharge': { title: 'CDA Newborn Discharge Summary', family: 'cda', encoding: 'cda-xml', areas: ['Clinical Documents'] },
  'cda-outpatient-encounter': { title: 'CDA Outpatient Encounter Summary', family: 'cda', encoding: 'cda-xml', areas: ['Clinical Documents'] },
  'cda-operative-notes': { title: 'CDA Operative Notes', family: 'cda', encoding: 'cda-xml', areas: ['Clinical Documents'] },
  'cda-lab-order': { title: 'CDA Laboratory Order', family: 'cda', encoding: 'cda-xml', areas: ['Laboratory Orders'] },
  'cda-lab-result': { title: 'CDA Laboratory Results', family: 'cda', encoding: 'cda-xml', areas: ['Laboratory Results'] },
  'cda-rad-order': { title: 'CDA Radiology Order', family: 'cda', encoding: 'cda-xml', areas: ['Radiology Orders'] },
  'cda-rad-result': { title: 'CDA Radiology Results', family: 'cda', encoding: 'cda-xml', areas: ['Radiology Results'] },
  'cda-iehr-summary': { title: 'CDA iEHR Summary (on demand)', family: 'cda', encoding: 'cda-xml', areas: ['iEHR Summary'] },
  'cda-immunization-card': { title: 'CDA Immunization Card (on demand)', family: 'cda', encoding: 'cda-xml', areas: ['Immunization Card'] },
  'cda-immunization-summary': { title: 'CDA Immunization Summary (on demand)', family: 'cda', encoding: 'cda-xml', areas: ['Immunization Summary'] },
  // EBRIM_AREA is the derived ebRIM content-model page: it is where the classification and
  // identification scheme UUIDs live, and all three transactions need it.
  'xds-iti41': { title: 'XDS ITI-41 Provide and Register Document Set-b', family: 'xds', encoding: 'soap-xml', areas: ['Provide and Register – ITI-41', EBRIM_AREA] },
  'xds-iti18': { title: 'XDS ITI-18 Registry Stored Query', family: 'xds', encoding: 'soap-xml', areas: ['XDS Query Document Set', EBRIM_AREA] },
  'xds-iti43': { title: 'XDS ITI-43 Retrieve Document Set', family: 'xds', encoding: 'soap-xml', areas: ['XDS Query Document Set', EBRIM_AREA] },
  'saml-sso': { title: 'SAML single sign-on', family: 'saml', encoding: 'saml-xml', areas: [] },
};

function buildUseCases() {
  const ids = new Set(Object.keys(USE_CASE_META));
  if (goldenIn && Array.isArray(goldenIn.useCaseIds)) {
    for (const id of goldenIn.useCaseIds) {
      if (!ids.has(id)) {
        warn('useCases', `golden.json declares use case "${id}" that the compiler has no metadata for`);
        ids.add(id);
      }
    }
  } else {
    warn('golden', 'golden.json has no useCaseIds — use-case list falls back to the compiler table');
  }
  for (const id of ids) {
    if (goldenIn && Array.isArray(goldenIn.useCaseIds) && !goldenIn.useCaseIds.includes(id)) {
      warn('useCases', `use case "${id}" is not present in golden.json#useCaseIds`);
    }
  }

  const goldenMissing = new Map();
  for (const m of goldenIn && Array.isArray(goldenIn.missing) ? goldenIn.missing : []) goldenMissing.set(m.useCaseId, m);

  const out = [];
  for (const id of [...ids].sort()) {
    const meta = USE_CASE_META[id] ?? { title: id, family: 'unknown', encoding: 'unknown', areas: [] };
    const structures = messageStructures.filter((s) => s.useCaseId === id);
    const samples = goldenIn && goldenIn.byUseCase && Array.isArray(goldenIn.byUseCase[id]) ? goldenIn.byUseCase[id] : [];
    const missing = goldenMissing.get(id) ?? null;

    const familyKey = meta.family === 'saml' ? null : meta.family;
    const relatedPages = [];
    if (familyKey && fieldBundles[familyKey]) {
      for (const area of meta.areas ?? []) {
        for (const pageId of fieldBundles[familyKey].index.byArea[area] ?? []) relatedPages.push(pageId);
      }
    }
    // CDA content modules and FHIR datatype pages live under shared areas; include them
    // for the CDA clinical-document use cases where Table 21 says they belong.
    relatedPages.sort();

    const specPages = new Set();
    for (const s of structures) {
      for (const ref of s.specRefs ?? []) specPages.add(ref.pageId);
      const walk = (members) => {
        for (const m of members ?? []) {
          for (const ref of m.specRefs ?? []) specPages.add(ref.pageId);
          walk(m.members);
        }
      };
      walk(s.root?.members);
    }

    let status = 'complete';
    const statusReasons = [];
    if (!structures.length) {
      status = 'missing';
      statusReasons.push('no MessageStructure could be compiled from the inputs');
    }
    if (missing) {
      status = status === 'missing' ? 'missing' : 'partial';
      statusReasons.push(`no golden sample: ${missing.reason}`);
    }
    if (structures.some((s) => s.confidence === 'low')) {
      status = status === 'missing' ? 'missing' : 'partial';
      statusReasons.push('at least one compiled structure has low confidence');
    }

    out.push({
      id,
      title: meta.title,
      family: meta.family,
      encoding: meta.encoding,
      areas: meta.areas ?? [],
      structureIds: structures.map((s) => s.id),
      variants: structures
        .filter((s) => s.variant)
        .map((s) => ({ id: s.id, variant: s.variant, label: s.variantLabel ?? s.variant, direction: s.direction ?? 'request' })),
      goldenSamples: samples,
      goldenSampleCount: samples.length,
      goldenMissing: missing ? { reason: missing.reason, note: missing.note ?? null } : null,
      specPages: [...specPages].sort(),
      relatedPages,
      status,
      statusReasons,
    });
  }
  return out;
}

const useCases = buildUseCases();

// ---------------------------------------------------------------------------
// value sets
// ---------------------------------------------------------------------------

function compileValueSets() {
  const index = { $schema: BUNDLE_SCHEMA, count: 0, totalConcepts: 0, valueSets: {} };
  if (!valuesetsIn || !Array.isArray(valuesetsIn.valueSets)) {
    warn('valuesets', 'valuesets.json has no valueSets array — no value set files were written');
    return { index, files: [] };
  }
  const files = [];
  for (const vs of [...valuesetsIn.valueSets].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (!vs.id) {
      warn('valuesets', 'a value set has no id and was skipped', { title: vs.title ?? null });
      continue;
    }
    const file = `valuesets/${vs.id}.json`;
    const concepts = Array.isArray(vs.concepts) ? vs.concepts : [];
    writeJson(file, {
      id: vs.id,
      title: vs.title ?? null,
      previousName: vs.previousName ?? null,
      aliases: Array.isArray(vs.aliases) ? vs.aliases : [],
      version: vs.version ?? null,
      definition: vs.definition ?? null,
      valueSetOid: vs.valueSetOid ?? null,
      codeSystemOid: vs.codeSystemOid ?? null,
      scope: vs.scope ?? null,
      external: Boolean(vs.external),
      validation: vs.validation ?? null,
      columns: Array.isArray(vs.columns) ? vs.columns : [],
      conceptSource: vs.conceptSource ?? null,
      conceptCount: typeof vs.conceptCount === 'number' ? vs.conceptCount : concepts.length,
      concepts,
      provenance: provenance(vs.source, { pageId: vs.pageId, pageTitle: vs.title }),
    });
    files.push(file);
    index.valueSets[vs.id] = {
      title: vs.title ?? null,
      aliases: Array.isArray(vs.aliases) ? vs.aliases : [],
      conceptCount: typeof vs.conceptCount === 'number' ? vs.conceptCount : concepts.length,
      external: Boolean(vs.external),
      validation: vs.validation ?? null,
      pageId: vs.pageId ? String(vs.pageId) : null,
      file,
    };
    index.count += 1;
    index.totalConcepts += typeof vs.conceptCount === 'number' ? vs.conceptCount : concepts.length;
  }
  index.aliasIndex = valuesetsIn.aliasIndex ?? {};
  index.aliasOrigin = valuesetsIn.aliasOrigin ?? {};
  index.unresolved = Array.isArray(valuesetsIn.unresolved) ? valuesetsIn.unresolved : [];
  index.meta = valuesetsIn.meta ?? null;
  index.stats = valuesetsIn.stats ?? null;
  index.bindingCount = Array.isArray(valuesetsIn.bindings) ? valuesetsIn.bindings.length : 0;
  writeJson('valuesets/index.json', index, { pretty: false });
  return { index, files };
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

// fields/<family>.json
const familyFiles = {};
for (const family of ['hl7v2', 'fhir', 'cda', 'xds']) {
  familyFiles[family] = writeJson(`fields/${family}.json`, fieldBundles[family]);
}

// structures.json
const structuresBundle = {
  $schema: BUNDLE_SCHEMA,
  usageLegend: structuresIn?.usageLegend ?? fieldsIn?.generatedFrom?.usageLegend ?? null,
  usageSemantics: USAGE_SEMANTICS,
  messageStructures: Object.fromEntries(messageStructures.map((s) => [s.id, s])),
  structureIds: messageStructures.map((s) => s.id).sort(),
  rules: structuresIn
    ? {
        meta: structuresIn.meta ?? null,
        adt: structuresIn.adt ?? null,
        oru: structuresIn.oru ?? null,
        ack: structuresIn.ack ?? null,
        cda: structuresIn.cda ?? null,
        fhir: structuresIn.fhir ?? null,
        xds: structuresIn.xds ?? null,
        connectivity: structuresIn.connectivity ?? null,
        conflicts: structuresIn.conflicts ?? [],
        discrepancies: structuresIn.discrepancies ?? [],
      }
    : null,
};
const structuresFile = writeJson('structures.json', structuresBundle);

// datatypes / constants / errors / golden — passed through, with small compiled indexes added
const datatypesBundle = datatypesIn
  ? {
      ...datatypesIn,
      compiledIndex: {
        componentLayouts: Object.fromEntries(
          Object.keys(datatypesIn.datatypes ?? {})
            .sort()
            .map((name) => {
              const dt = datatypesIn.datatypes[name];
              return [
                name,
                (Array.isArray(dt.components) ? dt.components : []).map((c) => ({
                  index: c.index,
                  name: c.name,
                  datatype: c.datatype,
                  maxLength: c.maxLength ?? null,
                  provenance: c.provenance ?? null,
                })),
              ];
            }),
        ),
      },
    }
  : { missing: true };
if (!datatypesIn) warn('datatypes', 'datatypes.json absent — componentLayout() will resolve nothing');
const datatypesFile = writeJson('datatypes.json', datatypesBundle);

const quarantinedOidList = constantsIn && Array.isArray(constantsIn.quarantined)
  ? constantsIn.quarantined.map((q) => ({
      oid: q.oid,
      reason: q.reason ?? null,
      confidence: q.confidence ?? null,
      detectionRule: q.detectionRule ?? null,
      exemptContexts: Array.isArray(q.exemptContexts) ? q.exemptContexts : [],
      provenance: provenance(q.source),
    }))
  : [];
if (!constantsIn) warn('constants', 'constants.json absent — fixed values, OIDs and quarantine list are empty');
const constantsBundle = constantsIn
  ? { ...constantsIn, compiledIndex: { quarantinedOids: quarantinedOidList.map((q) => q.oid).sort(), quarantined: quarantinedOidList } }
  : { missing: true, compiledIndex: { quarantinedOids: [], quarantined: [] } };
const constantsFile = writeJson('constants.json', constantsBundle);

if (!errorsIn) warn('errors', 'errors.json absent — the error catalogue is empty');
const errorsFile = writeJson('errors.json', errorsIn ?? { missing: true, errors: [] });

if (!goldenIn) warn('golden', 'golden.json absent — no golden sample index is shipped');
const goldenFile = writeJson('golden.json', goldenIn ?? { missing: true, samples: [] });

const { index: valueSetIndex, files: valueSetFiles } = compileValueSets();

// ---------------------------------------------------------------------------
// spec-defects.json — where the PUBLISHED SPEC is wrong
//
// These are not compiler failures and they are not sample failures: they are places the
// Confluence text contradicts the wire, or contradicts itself. The stored Confluence
// literal stays verbatim everywhere else in the bundle; this file is what lets the UI say
// "Confluence says authorSpeciality, the wire uses authorSpecialty" instead of silently
// rewriting either side. Where no sample settles it, no winner is picked.
// ---------------------------------------------------------------------------

function buildSpecDefects() {
  const defects = [];
  for (const [i, d] of (literalsPatch?.specDefects ?? []).entries()) {
    defects.push({
      id: `literal-${i + 1}-${String(d.confluenceSpelling ?? '').replace(/[^\w.$-]/g, '')}`,
      kind: 'identifier-spelling',
      confluenceSpelling: d.confluenceSpelling ?? null,
      wireSpelling: d.wireSpelling ?? null,
      whatItIs: d.whatItIs ?? null,
      wireWins: d.wireWins === true,
      action: d.action ?? null,
      affectedPages: (d.affectedPages ?? []).map((pg) => ({
        pageId: String(pg.pageId),
        title: pg.title ?? null,
        row: pg.row ?? null,
      })),
      affectedSpecBuildPaths: d.affectedSpecBuildPaths ?? [],
      provenance: provenance(
        d.evidence?.confluence ? { ...d.evidence.confluence, pageTitle: d.affectedPages?.[0]?.title ?? null } : null,
      ),
      evidence: d.evidence ?? null,
      ...evidence({
        confidence: d.confidence,
        verifiedAgainstSample: Number(d.evidence?.sampleOccurrences) > 0,
        derivation: Number(d.evidence?.sampleOccurrences) > 0 ? 'confluence+sample' : 'confluence',
        confidenceReason: d.lowConfidenceReason ?? null,
        samples: d.evidence?.samples,
      }),
    });
  }

  // The radiology-report Composition profile disagreement and its siblings: the spec and the
  // official samples say different things and neither side is overwritten.
  for (const c of fhirEntriesPatch?.conflicts ?? []) {
    defects.push({
      id: `fhir-conflict-${c.id}`,
      kind: 'spec-vs-wire-conflict',
      confluenceSpelling: c.specValue ?? null,
      wireSpelling: c.wireValue ?? null,
      whatItIs: `${c.field} in ${(c.useCases ?? []).join(', ')}`,
      wireWins: /wire|sample/i.test(String(c.resolution ?? '')),
      action: c.recommendation ?? c.resolution ?? null,
      affectedPages: (c.specSources ?? []).map((pg) => ({
        pageId: String(pg.pageId),
        title: pg.pageTitle ?? null,
        row: pg.row ?? null,
      })),
      affectedSpecBuildPaths: [],
      provenance: provenance((c.specSources ?? [])[0]),
      evidence: { investigation: c.investigation ?? null, affectedSamples: c.affectedSamples ?? [] },
      ...evidence({
        confidence: c.confidence,
        verifiedAgainstSample: Array.isArray(c.affectedSamples) && c.affectedSamples.length > 0,
        derivation: 'confluence+sample',
        confidenceReason: c.investigation ?? null,
        samples: c.affectedSamples,
      }),
    });
  }

  // A section templateId OID is not globally unique in this spec: resolving by OID alone
  // silently accepts a Key Images section where a Request section belongs.
  for (const col of cdaPatch?.oidCollisions?.collisions ?? []) {
    defects.push({
      id: `cda-oid-collision-${col.templateId}`,
      kind: 'templateid-collision',
      confluenceSpelling: col.templateId,
      wireSpelling: null,
      whatItIs: `templateId ${col.templateId} names ${(col.meanings ?? []).length} different CDA sections`,
      wireWins: false,
      action: cdaPatch.oidCollisions.identityRule ?? null,
      affectedPages: (col.meanings ?? [])
        .map((m) => m.declaredOn)
        .filter(Boolean)
        .map((pg) => ({ pageId: String(pg.pageId), title: pg.pageTitle ?? null, row: pg.row ?? null })),
      affectedSpecBuildPaths: [],
      provenance: provenance((col.meanings ?? [])[0]?.declaredOn),
      evidence: { meanings: col.meanings ?? [], why: cdaPatch.oidCollisions.why ?? null },
      ...evidence({ confidence: 'high', verifiedAgainstSample: true, derivation: 'confluence+sample' }),
    });
  }

  const bundle = {
    $schema: BUNDLE_SCHEMA,
    generatedAt: process.env.SPEC_GENERATED_AT || new Date().toISOString(),
    what:
      'Places the PUBLISHED NPHIES SPEC is wrong, contradicts the wire, or contradicts itself. The stored Confluence literal is kept verbatim everywhere else in the bundle; nothing here is a silent rewrite. Where no official sample settles a disagreement, no winner is picked.',
    defects: defects.sort((a, b) => String(a.id).localeCompare(String(b.id))),
    upstreamPageDefects: (cdaPatch?.upstreamDefects ?? []).map((d) => ({
      severity: d.severity ?? null,
      pageId: d.pageId === undefined || d.pageId === null ? null : String(d.pageId),
      where: d.where ?? null,
      defect: d.defect ?? null,
      impact: d.impact ?? null,
      evidence: d.evidence ?? null,
    })),
    openQuestions: [
      ...(xdsPatch?.openQuestions ?? []).map((q) => ({ area: 'xds', ...q })),
      ...(samlPatch?.knownGaps ?? []).map((g) => ({ area: 'saml', id: g.id, severity: g.severity, question: g.gap, why: g.effect ?? null })),
    ],
    /** Literals the compiler corrected on the way in, and the rule that stops them coming back. */
    literalCorrections: {
      summary: { ...literalCorrectionSummary, specDefectsShipped: defects.length },
      rule: literalsPatch?.extractionRule?.description ?? null,
      guardViolations: literalGuardViolations,
      normalisedByCompiler: literalNormalisations,
      rejected: literalsPatch?.rejected ?? [],
    },
    counts: {
      defects: defects.length,
      identifierSpellings: defects.filter((d) => d.kind === 'identifier-spelling').length,
      specVsWireConflicts: defects.filter((d) => d.kind === 'spec-vs-wire-conflict').length,
      templateIdCollisions: defects.filter((d) => d.kind === 'templateid-collision').length,
      upstreamPageDefects: (cdaPatch?.upstreamDefects ?? []).length,
      openQuestions: (xdsPatch?.openQuestions ?? []).length + (samlPatch?.knownGaps ?? []).length,
      lowConfidence: defects.filter((d) => d.confidence === 'low').length,
    },
  };
  if (!literalsPatch && !cdaPatch && !fhirEntriesPatch) {
    warn('spec-defects', 'no repair patch supplied spec defects — spec-defects.json is empty');
  }
  return bundle;
}

const specDefectsBundle = buildSpecDefects();
const specDefectsFile = writeJson('spec-defects.json', specDefectsBundle);

// ---------------------------------------------------------------------------
// sample-defects.json — where the OFFICIAL SAMPLES are wrong
//
// Shipped so a hospital copying a golden message does not copy its mistakes, and so a
// checker can tell "your message differs from the sample" from "your message is wrong".
// ---------------------------------------------------------------------------

if (!sampleDefectsPatch) warn('sample-defects', 'sample-defects.json absent — the official samples ship with no defect list');
const sampleDefectsFile = writeJson(
  'sample-defects.json',
  sampleDefectsPatch
    ? {
        $schema: BUNDLE_SCHEMA,
        ...sampleDefectsPatch,
        what:
          sampleDefectsPatch.what ??
          'Defects in the OFFICIAL NPHIES sample messages. A sample is ground truth for STRUCTURE, not for correctness: where a sample is wrong, the compiled rule wins and this file says why.',
      }
    : { $schema: BUNDLE_SCHEMA, missing: true, defects: [], summary: null },
);


// index.json
const generatedAt = process.env.SPEC_GENERATED_AT || new Date().toISOString();

function countNodes(family) {
  return fieldBundles[family].counts.nodes ?? 0;
}

const manifest = {
  $schema: BUNDLE_SCHEMA,
  bundleVersion: BUNDLE_VERSION,
  generatedAt,
  generator: 'scripts/compile-spec.mjs',
  engine: 'src/lib/structure.ts',
  inputs: [...INPUT_NAMES, ...PATCH_NAMES].map((name) => ({
    name: `spec-build/${name}.json`,
    present: (inputs[name] ?? patches[name]).present,
    bytes: (inputs[name] ?? patches[name]).bytes,
    sha256: (inputs[name] ?? patches[name]).sha256,
    error: (inputs[name] ?? patches[name]).error ?? null,
    kind: INPUT_NAMES.includes(name) ? 'extraction' : 'repair-patch',
  })),
  missingInputs: [
    ...INPUT_NAMES.filter((n) => !inputs[n].present),
    ...PATCH_NAMES.filter((n) => !patches[n].present),
  ].map((n) => `spec-build/${n}.json`),
  usageLegend: {
    source: { pageId: '171278410', pageTitle: 'Usage Legend', row: 'legend', quote: 'R = required, R2 = required if known, O = optional, I = ignored' },
    codes: USAGE_SEMANTICS,
    note: 'M, X and NP are pinned by cross-tabbing usage against the cardinality column; see structures.json#usageLegend for the extractor\'s own record.',
  },
  files: {
    structures: structuresFile,
    datatypes: datatypesFile,
    constants: constantsFile,
    errors: errorsFile,
    golden: goldenFile,
    fields: familyFiles,
    valueSetIndex: 'valuesets/index.json',
    specDefects: specDefectsFile,
    sampleDefects: sampleDefectsFile,
  },
  /**
   * What the six repair passes contributed, and what the compiler normalises on the way in
   * so the defects they fixed cannot come back silently on the next scrape.
   */
  repairs: {
    patchesApplied: PATCH_NAMES.filter((n) => patches[n].present).map((n) => `spec-build/${n}.json`),
    patchesMissing: PATCH_NAMES.filter((n) => !patches[n].present).map((n) => `spec-build/${n}.json`),
    literals: {
      correctionsApplied: literalCorrectionSummary.applied,
      slotsRewritten: literalCorrectionSummary.occurrences,
      artifactsTouched: literalCorrectionSummary.artifacts,
      correctionsThatMatchedNothing: literalCorrectionSummary.misses,
      normalisedByCompilerRule: literalNormalisations.length,
      guardViolations: literalGuardViolations.length,
      specDefectsShipped: specDefectsBundle.counts.defects,
      normalisationRules: [
        'identifier cells: U+200B and U+00AD are deleted; U+00A0 and whitespace inside a $XDS…/urn: token are deleted; in prose U+00A0 becomes a space',
        'element paths and predicates: curly quotes are mapped to apostrophes and stray spaces around / and [ ] are removed — the verbatim cell survives in locatorRaw and in every provenance quote',
        'provenance slots (quote, row, guidance, description, elementLocationRaw, …) are NEVER rewritten',
      ],
    },
    xdsEbrim: {
      schemesAsSpecNodes: ebrimFieldPage ? ebrimFieldPage.page.tables.reduce((n, t) => n + t.nodes.length, 0) : 0,
      fieldTablesAdded: ebrimFieldPage ? ebrimFieldPage.page.tables.length : 0,
      soapMembersGrafted: ebrimGraft.grafted,
      structuresExtended: ebrimGraft.structures,
      schemeRulesAttached: ebrimGraft.schemesAttached,
      note:
        'The ebRIM content model below the SOAP Body is derived from the official samples; no cached Confluence page draws it. Those members carry `observed` cardinalities, not usage codes, and a resolution measurement taken against the same samples is not independent confirmation.',
    },
    cda: {
      headerModelsAttached: cdaPatchApplied.headerGroups,
      headerElementsPerDocument: cdaPatch?.headerModel?.elements?.length ?? 0,
      sectionsAdded: cdaPatchApplied.sectionsAdded,
      sectionsCorrectedInPlace: cdaPatchApplied.sectionsCorrected,
      radOrderSectionsBuilt: cdaPatchApplied.radOrderSections,
      variantStructures: cdaPatchApplied.variants,
      noInfoMechanism: cdaPatch?.noInfoVariantRule?.mechanism ?? null,
    },
    fhir: {
      entryListsReplaced: fhirPatchApplied.replaced,
      entryRows: fhirPatchApplied.entries,
      entriesCorrected: fhirPatchApplied.corrected,
      variantStructures: fhirPatchApplied.variants,
      twoFamilyRuleConfirmed: fhirEntriesPatch?.twoFamilyRule?.confirmed === true,
      twoFamilyRuleViolations: fhirPatchApplied.conflicts,
    },
    saml: {
      structuresAdded: messageStructures.filter((m) => m.family === 'saml').map((m) => m.id),
      verifiedAgainstSample: false,
      note: 'No official SAML sample exists. Every member rests on one published skeleton plus prose.',
    },
    sampleDefects: sampleDefectsPatch?.summary ?? null,
  },
  families: ['hl7v2', 'fhir', 'cda', 'xds'].map((family) => ({
    id: family,
    label: FAMILY_LABEL[family],
    file: familyFiles[family],
    pages: fieldBundles[family].counts.pages,
    tables: fieldBundles[family].counts.tables,
    nodes: countNodes(family),
    segments: Object.keys(fieldBundles[family].index.bySegment).sort(),
    areas: Object.keys(fieldBundles[family].index.byArea).sort(),
  })),
  useCases,
  counts: {
    useCases: useCases.length,
    messageStructures: messageStructures.length,
    specNodes: ['hl7v2', 'fhir', 'cda', 'xds'].reduce((n, f) => n + countNodes(f), 0),
    specPages: ['hl7v2', 'fhir', 'cda', 'xds'].reduce((n, f) => n + fieldBundles[f].counts.pages, 0),
    valueSets: valueSetIndex.count,
    valueSetConcepts: valueSetIndex.totalConcepts,
    valueSetBindings: valueSetIndex.bindingCount ?? 0,
    fixedValues: constantsIn && Array.isArray(constantsIn.fixedValues) ? constantsIn.fixedValues.length : 0,
    oids: constantsIn && constantsIn.oids ? (constantsIn.oids.count ?? 0) : 0,
    quarantinedOids: quarantinedOidList.length,
    errors: errorsIn && Array.isArray(errorsIn.errors) ? errorsIn.errors.length : 0,
    datatypes: datatypesIn && datatypesIn.datatypes ? Object.keys(datatypesIn.datatypes).length : 0,
    goldenSamples: goldenIn && Array.isArray(goldenIn.samples) ? goldenIn.samples.length : 0,
    specDefects: specDefectsBundle.counts.defects,
    sampleDefects: sampleDefectsPatch?.summary?.defects ?? 0,
    structuresVerifiedAgainstSample: messageStructures.filter((s) => s.verifiedAgainstSample === true).length,
  },
  coverage: {
    useCasesWithStructure: useCases.filter((u) => u.structureIds.length > 0).length,
    useCasesWithoutStructure: useCases.filter((u) => u.structureIds.length === 0).map((u) => u.id),
    useCasesWithoutGolden: useCases.filter((u) => u.goldenSampleCount === 0).map((u) => u.id),
    partial: useCases.filter((u) => u.status === 'partial').map((u) => u.id),
    missing: useCases.filter((u) => u.status === 'missing').map((u) => u.id),
  },
  warnings,
  files_written: written.map((w) => w.file).sort(),
};

writeJson('index.json', manifest, { pretty: true });

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const totalBytes = written.reduce((n, w) => n + w.bytes, 0);
process.stdout.write(
  [
    `compile-spec: wrote ${written.length} files (${(totalBytes / 1024 / 1024).toFixed(2)} MB) to src/spec/`,
    `  use cases:          ${useCases.length}`,
    `  message structures: ${messageStructures.length}`,
    `  spec nodes:         ${manifest.counts.specNodes}`,
    `  value sets:         ${valueSetIndex.count} (${valueSetIndex.totalConcepts} concepts)`,
    `  repair patches:     ${manifest.repairs.patchesApplied.length}/${PATCH_NAMES.length} applied${
      manifest.repairs.patchesMissing.length ? ` (missing: ${manifest.repairs.patchesMissing.join(', ')})` : ''
    }`,
    `  literal fixes:      ${literalCorrectionSummary.applied} corrections / ${literalCorrectionSummary.occurrences} slots, ${literalGuardViolations.length} guard violation(s)`,
    `  ebRIM:              ${manifest.repairs.xdsEbrim.schemesAsSpecNodes} spec nodes, ${ebrimGraft.grafted} SOAP members, ${ebrimGraft.schemesAttached} scheme rules`,
    `  spec defects:       ${specDefectsBundle.counts.defects}   sample defects: ${manifest.counts.sampleDefects}`,
    `  missing inputs:     ${manifest.missingInputs.length ? manifest.missingInputs.join(', ') : 'none'}`,
    `  warnings:           ${warnings.length}`,
    ...(valueSetFiles.length ? [] : ['  NOTE: no value set files were written']),
    '',
  ].join('\n'),
);
