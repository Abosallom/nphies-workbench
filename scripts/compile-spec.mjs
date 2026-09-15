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

function provenance(src, fallback) {
  const s = src && typeof src === 'object' ? src : fallback;
  if (!s || typeof s !== 'object') return null;
  return {
    pageId: s.pageId === undefined || s.pageId === null ? null : String(s.pageId),
    pageTitle: typeof s.pageTitle === 'string' ? s.pageTitle : null,
    row: typeof s.row === 'string' ? s.row : null,
    quote: typeof s.quote === 'string' ? s.quote : null,
  };
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
  let path = raw.replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
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
    const name = cleanText(row.name);
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

const messageStructures = [
  ...buildAdtStructures(),
  ...buildOruStructures(),
  ...buildFhirStructures(),
  ...buildCdaStructures(),
  ...buildXdsStructures(),
];
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
  'xds-iti41': { title: 'XDS ITI-41 Provide and Register Document Set-b', family: 'xds', encoding: 'soap-xml', areas: ['Provide and Register – ITI-41'] },
  'xds-iti18': { title: 'XDS ITI-18 Registry Stored Query', family: 'xds', encoding: 'soap-xml', areas: ['XDS Query Document Set'] },
  'xds-iti43': { title: 'XDS ITI-43 Retrieve Document Set', family: 'xds', encoding: 'soap-xml', areas: ['XDS Query Document Set'] },
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
  inputs: INPUT_NAMES.map((name) => ({
    name: `spec-build/${name}.json`,
    present: inputs[name].present,
    bytes: inputs[name].bytes,
    sha256: inputs[name].sha256,
    error: inputs[name].error ?? null,
  })),
  missingInputs: INPUT_NAMES.filter((n) => !inputs[n].present).map((n) => `spec-build/${n}.json`),
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
    `  missing inputs:     ${manifest.missingInputs.length ? manifest.missingInputs.join(', ') : 'none'}`,
    `  warnings:           ${warnings.length}`,
    ...(valueSetFiles.length ? [] : ['  NOTE: no value set files were written']),
    '',
  ].join('\n'),
);
