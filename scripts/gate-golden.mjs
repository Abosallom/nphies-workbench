#!/usr/bin/env node
/**
 * gate-golden.mjs — GOLDEN SAMPLE RESOLUTION GATE
 *
 * Measures how much of every OFFICIAL NPHIES sample message the compiled spec
 * (src/spec/) can actually account for.
 *
 * This is a MEASUREMENT, not a pass/fail build step. It never throws on a
 * structural finding; it records it. An official message containing something
 * the spec does not know about means OUR SPEC IS INCOMPLETE.
 *
 * Reads (read-only):
 *   spec-build/golden.json      use case + format + variant per sample
 *   src/spec/structures.json    compiled MessageStructures
 *   src/spec/fields/*.json      compiled field/attribute tables
 *   src/spec/constants.json     OIDs, FHIR profiles, resource types
 *   spec-source/golden/**       the 62 official samples
 *
 * Writes exactly one file: spec-build/gate-report.json
 *
 * Usage: node scripts/gate-golden.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = path.join(ROOT, "spec-build", "gate-report.json");

/* ------------------------------------------------------------------ */
/* io                                                                  */
/* ------------------------------------------------------------------ */

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
const readTextIfExists = (abs) => {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ */
/* minimal XML parser (no deps; handles comments, CDATA, PIs, doctype,  */
/* self-closing tags, nested identical tags, namespace prefixes)        */
/* ------------------------------------------------------------------ */

const ATTR_RE = /([A-Za-z_:][-\w.:]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttrs(raw) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(raw))) attrs[m[1]] = m[3] !== undefined ? m[3] : m[4];
  return attrs;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/**
 * Returns { root, errors } where every node is
 * { name, prefix, local, ns, attrs, children, text, parent }
 */
function parseXml(text) {
  const errors = [];
  const rootHolder = { name: "#document", local: "#document", children: [], attrs: {}, nsMap: {} };
  const stack = [rootHolder];
  let i = 0;
  const n = text.length;

  const resolve = (prefix) => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const map = stack[k].nsMap;
      if (map && Object.prototype.hasOwnProperty.call(map, prefix)) return map[prefix];
    }
    return null;
  };

  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) {
      const chunk = text.slice(i, lt);
      if (chunk.trim()) {
        const top = stack[stack.length - 1];
        top.text = (top.text || "") + decodeEntities(chunk);
      }
    }
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      const top = stack[stack.length - 1];
      top.text = (top.text || "") + text.slice(lt + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      // DOCTYPE or other declaration — skip to matching '>' accounting for []
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        const ch = text[j];
        if (ch === "[") depth++;
        else if (ch === "]") depth--;
        else if (ch === ">" && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    const gt = text.indexOf(">", lt);
    if (gt < 0) {
      errors.push("unterminated tag at offset " + lt);
      break;
    }
    const inner = text.slice(lt + 1, gt);
    if (inner.startsWith("/")) {
      const closeName = inner.slice(1).trim();
      let found = -1;
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].name === closeName) {
          found = k;
          break;
        }
      }
      if (found < 0) {
        errors.push("stray closing tag </" + closeName + ">");
      } else {
        if (found !== stack.length - 1) {
          errors.push(
            "mismatched close </" + closeName + "> (open: " + stack[stack.length - 1].name + ")",
          );
        }
        stack.length = found;
      }
      i = gt + 1;
      continue;
    }
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const spaceAt = body.search(/[\s]/);
    const name = (spaceAt < 0 ? body : body.slice(0, spaceAt)).trim();
    const attrs = spaceAt < 0 ? {} : parseAttrs(body.slice(spaceAt));
    const nsMap = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "xmlns") nsMap[""] = v;
      else if (k.startsWith("xmlns:")) nsMap[k.slice(6)] = v;
    }
    const colon = name.indexOf(":");
    const prefix = colon < 0 ? "" : name.slice(0, colon);
    const local = colon < 0 ? name : name.slice(colon + 1);
    const node = {
      name,
      prefix,
      local,
      attrs,
      nsMap,
      children: [],
      text: "",
      parent: stack[stack.length - 1],
    };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
    node.ns = nsMap[prefix] !== undefined ? nsMap[prefix] : resolve(prefix);
    if (selfClosing) stack.pop();
    i = gt + 1;
  }

  const root = rootHolder.children.find((c) => c.local !== "#document") || null;
  return { root, errors };
}

function* walkXml(node) {
  yield node;
  for (const c of node.children) yield* walkXml(c);
}

function xmlPath(node, stopLocal) {
  const parts = [];
  let cur = node;
  while (cur && cur.local && cur.local !== "#document") {
    parts.unshift(cur.local);
    if (stopLocal && cur.local === stopLocal) break;
    cur = cur.parent;
  }
  return parts.join("/");
}

/* ------------------------------------------------------------------ */
/* HL7 v2 ER7 parser                                                    */
/* ------------------------------------------------------------------ */

function parseEr7(raw) {
  const notes = [];
  let text = raw.replace(/^﻿/, "");
  // Two golden ADT files are escaped-string dumps: each segment ends with the
  // literal two characters \ r before the real CRLF, and MSH.2 reads ^~\\&.
  // constants.json:hl7Encoding.encodingCharacters already documents this.
  if (/\\r\r?\n/.test(text)) {
    notes.push("file carries a literal two-character \\\\r before each real line break (escaped-string dump)");
    text = text.replace(/\\r(\r?\n|$)/g, "$1");
  }
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0);

  const segments = [];
  for (const line of lines) {
    const name = line.slice(0, 3);
    const parts = line.split("|");
    const fields = new Map();
    if (name === "MSH") {
      fields.set(1, "|");
      for (let k = 1; k < parts.length; k++) fields.set(k + 1, parts[k]);
    } else {
      for (let k = 1; k < parts.length; k++) fields.set(k, parts[k]);
    }
    segments.push({ name, fields, raw: line });
  }
  return { segments, notes };
}

const comp = (value, index) => (value == null ? "" : String(value).split("^")[index] || "");

/* ------------------------------------------------------------------ */
/* spec indices                                                         */
/* ------------------------------------------------------------------ */

const norm = (s) => String(s == null ? "" : s).trim();
const squash = (s) => norm(s).toLowerCase().replace(/[\s_‐-―-]+/g, "");
/** strips injected spaces AND a trailing footnote marker ("$XDSDocumentEntry ClassCode 1") */
const squashFootnote = (s) => squash(String(s).replace(/\s+\d+\s*$/, ""));
/** last resort: the footnote marker was glued on with no space ("CreationTimeFrom5") */
const squashGluedFootnote = (s) => squashFootnote(s).replace(/\d+$/, "");

function structureMembers(member) {
  return member.members || member.children || [];
}

function* walkStructure(structure) {
  const stack = [structure.root];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;
    yield cur;
    for (const m of structureMembers(cur)) stack.push(m);
  }
}

function buildHl7Index(fieldsHl7) {
  const bySegment = new Map();
  for (const [seg, refs] of Object.entries(fieldsHl7.index.bySegment || {})) {
    const tables = [];
    for (const ref of refs) {
      const page = fieldsHl7.pages[ref.pageId];
      const table = page && page.tables && page.tables[ref.tableIndex];
      if (!table) continue;
      const fields = new Map();
      for (const node of table.nodes || []) {
        const loc = node.locator;
        if (!loc || loc.kind !== "hl7Field") continue;
        if (loc.segment && loc.segment !== seg) continue;
        if (typeof loc.field !== "number") continue;
        if (!fields.has(loc.field)) fields.set(loc.field, node);
      }
      if (fields.size) tables.push({ area: ref.area, pageId: ref.pageId, pageTitle: ref.pageTitle, fields });
    }
    bySegment.set(seg, tables);
  }
  return bySegment;
}

function hl7FieldNode(hl7Index, segment, fieldNo, areaHint) {
  const tables = hl7Index.get(segment);
  if (!tables || !tables.length) return { node: null, reason: "no field table for segment" };
  const preferred = areaHint ? tables.filter((t) => (t.area || "").toUpperCase().includes(areaHint)) : [];
  const ordered = preferred.length ? preferred.concat(tables.filter((t) => !preferred.includes(t))) : tables;
  for (const t of ordered) {
    const node = t.fields.get(fieldNo);
    if (node) return { node, table: t, offArea: !preferred.length || !preferred.includes(t) };
  }
  return { node: null, reason: "field number not defined in any compiled table for this segment" };
}

function firstUsage(node) {
  const usages = (node && node.usage) || [];
  return usages.length ? usages[0] : null;
}

function buildSpecIndex() {
  const structuresBundle = readJson("src/spec/structures.json");
  const constants = readJson("src/spec/constants.json");
  const fields = {
    hl7v2: readJson("src/spec/fields/hl7v2.json"),
    cda: readJson("src/spec/fields/cda.json"),
    fhir: readJson("src/spec/fields/fhir.json"),
    xds: readJson("src/spec/fields/xds.json"),
  };

  const structures = structuresBundle.messageStructures;

  /* ---- OIDs -------------------------------------------------------- */
  const oidInfo = new Map();
  for (const item of constants.oids.items || []) {
    oidInfo.set(item.oid, { quarantined: !!item.quarantined, role: item.role, label: item.label });
  }

  /* ---- CDA --------------------------------------------------------- */
  const cdaTemplateIds = new Set();
  const cdaElementNames = new Set();
  const cdaLabelNames = new Set();
  const collectCda = (node) => {
    for (const t of node.templateIds || []) cdaTemplateIds.add(t);
    const loc = node.locator;
    if (loc && loc.kind === "cdaXPath" && loc.path) {
      for (const seg of String(loc.path).split(/[/|]/)) {
        const cleaned = seg.replace(/\[.*$/, "").replace(/^[.\s]+/, "").trim();
        if (/^[A-Za-z][\w:.-]*$/.test(cleaned)) {
          cdaElementNames.add(cleaned);
          cdaElementNames.add(cleaned.includes(":") ? cleaned.split(":").pop() : cleaned);
        }
      }
      const tid = String(loc.path).match(/templateId(?:\/@root)?\s*=\s*['‘’"]?([\d.]+)/);
      if (tid) cdaTemplateIds.add(tid[1]);
    }
    if (node.label) cdaLabelNames.add(squash(node.label));
    for (const c of node.children || []) collectCda(c);
  };
  for (const page of Object.values(fields.cda.pages || {})) {
    for (const table of page.tables || []) for (const node of table.nodes || []) collectCda(node);
  }
  for (const structure of Object.values(structures)) {
    if (structure.family !== "cda") continue;
    for (const m of walkStructure(structure)) {
      for (const t of m.templateIds || []) cdaTemplateIds.add(t);
      if (m.label) cdaLabelNames.add(squash(String(m.label).split("\n")[0]));
    }
    const env = structure.envelope || {};
    if (env.documentTemplateId) cdaTemplateIds.add(env.documentTemplateId);
  }
  for (const [oid, info] of oidInfo) if (!info.quarantined) cdaTemplateIds.add(oid);

  /* ---- FHIR -------------------------------------------------------- */
  const fhirResourceTypes = new Set((constants.resourceTypes.items || []).map((i) => i.resourceType));
  const fhirProfiles = new Map();
  for (const p of constants.fhirProfiles.items || []) fhirProfiles.set(p.url, p);
  const fhirProfilesLoose = new Map();
  for (const url of fhirProfiles.keys()) fhirProfilesLoose.set(url.toLowerCase(), url);

  /* ---- XDS --------------------------------------------------------- */
  const xdsNames = new Map(); // squashFootnote -> [literal, ...]
  const xdsNamesGlued = new Map(); // squashGluedFootnote -> [literal, ...]
  const xdsNamesExact = new Set();
  /** exact literal -> strongest derivation seen for it ("confluence" | "confluence+sample" | "sample" | "standard") */
  const xdsNameDerivation = new Map();
  /** scheme/node UUID -> the compiled metadata attribute it identifies, with its derivation */
  const xdsSchemeByUuid = new Map();

  const DERIV_RANK = { confluence: 4, "confluence+sample": 3, standard: 2, sample: 1 };
  const strongerDerivation = (a, b) => ((DERIV_RANK[a] || 0) >= (DERIV_RANK[b] || 0) ? a : b);
  const normaliseDerivation = (node) => {
    const d = node.derivation;
    if (d === "confluence" || d === "confluence+sample" || d === "sample" || d === "standard") return d;
    const p = node.provenance || {};
    if (p.pageId && p.sample) return "confluence+sample";
    if (p.pageId) return "confluence";
    if (p.sample) return "sample";
    return "unattributed";
  };

  const addXdsName = (literal, derivation) => {
    const lit = norm(literal);
    if (!lit) return;
    xdsNamesExact.add(lit);
    if (derivation) {
      xdsNameDerivation.set(lit, strongerDerivation(derivation, xdsNameDerivation.get(lit) || ""));
    }
    const key = squashFootnote(lit);
    if (!key) return;
    if (!xdsNames.has(key)) xdsNames.set(key, []);
    if (!xdsNames.get(key).includes(lit)) xdsNames.get(key).push(lit);
    const glued = squashGluedFootnote(lit);
    if (!glued) return;
    if (!xdsNamesGlued.has(glued)) xdsNamesGlued.set(glued, []);
    if (!xdsNamesGlued.get(glued).includes(lit)) xdsNamesGlued.get(glued).push(lit);
  };
  const collectXds = (node, pageId) => {
    const loc = node.locator;
    const derivation = normaliseDerivation(node);
    if (loc && loc.kind === "xdsSlot" && loc.name) addXdsName(loc.name, derivation);
    if (loc && loc.kind === "xdsScheme" && loc.uuid) {
      const uuid = String(loc.uuid).toLowerCase();
      const prev = xdsSchemeByUuid.get(uuid);
      const entry = {
        uuid,
        label: String(node.label || "").split("\n")[0],
        derivation,
        confidence: node.confidence || null,
        conflict: node.conflict || null,
        pageId: (node.provenance || {}).pageId || (pageId === "ebrim" ? null : pageId),
        sample: (node.provenance || {}).sample || null,
      };
      if (!prev || strongerDerivation(derivation, prev.derivation) === derivation) xdsSchemeByUuid.set(uuid, entry);
    }
    if (node.label) addXdsName(String(node.label).split("\n")[0], derivation);
    for (const c of node.children || []) collectXds(c, pageId);
  };
  for (const [pageId, page] of Object.entries(fields.xds.pages || {})) {
    for (const table of page.tables || []) for (const node of table.nodes || []) collectXds(node, pageId);
  }

  /* fixedValues on the ebRIM nodes carry the UUIDs for objectType / status /
   * associationType as well; index them the same way. */
  const xdsFixedValues = new Map(); // "<elementPath>/@<attr>" -> [{value, derivation, ...}]
  const collectXdsFixed = (node) => {
    const derivation = normaliseDerivation(node);
    for (const fv of node.fixedValues || []) {
      /* value-less rows are kept ON PURPOSE: a compiled fixedValue that states
       * a meaning and a page but no literal cannot validate anything, and the
       * gate has to be able to say so. */
      const key = (fv.elementPath || "") + "/@" + (fv.attribute || fv.target || "");
      if (!xdsFixedValues.has(key)) xdsFixedValues.set(key, []);
      xdsFixedValues.get(key).push({
        value: fv.value == null || fv.value === "" ? null : String(fv.value),
        derivation: fv.provenance && fv.provenance.pageId ? "confluence" : fv.provenance && fv.provenance.sample ? "sample" : derivation,
        statementType: fv.statementType || null,
        quote: (fv.provenance || {}).quote || null,
        sample: (fv.provenance || {}).sample || null,
        ownerConfidence: node.confidence || null,
        ownerConfidenceReason: node.confidenceReason || null,
      });
    }
    for (const c of node.children || []) collectXdsFixed(c);
  };
  for (const page of Object.values(fields.xds.pages || {})) {
    for (const table of page.tables || []) for (const node of table.nodes || []) collectXdsFixed(node);
  }

  /* ---- UUIDs the compiled spec mentions anywhere --------------------
   * src/spec/golden.json is DELIBERATELY excluded: it is a fingerprint of the
   * very samples under test, so counting its UUIDs as spec knowledge would be
   * circular. */
  const knownUuids = new Set();
  const uuidRe = /urn:uuid:[0-9a-fA-F-]{36}/g;
  for (const blob of [
    JSON.stringify(constants),
    JSON.stringify(structuresBundle),
    JSON.stringify(fields.xds),
    JSON.stringify(fields.cda),
    JSON.stringify(fields.fhir),
    JSON.stringify(fields.hl7v2),
    fs.readFileSync(path.join(ROOT, "src/spec/errors.json"), "utf8"),
  ]) {
    let m;
    while ((m = uuidRe.exec(blob))) knownUuids.add(m[0].toLowerCase());
  }

  /* ---- UUIDs the spec states STRUCTURALLY (a locator or a fixed value),
   * as opposed to UUIDs that merely appear inside a prose sentence. The
   * baseline gate treated any UUID anywhere in the bundle as "known", which
   * means a UUID quoted inside a sentence explaining that it is WRONG still
   * counted as resolved. Both figures are reported. ------------------- */
  const uuidStructured = new Map(); // uuid -> { derivation, where, label, conflict, confidence }
  const noteUuid = (value, info) => {
    const m = String(value || "").toLowerCase().match(/urn:uuid:[0-9a-f-]{36}/);
    if (!m) return;
    const prev = uuidStructured.get(m[0]);
    if (!prev || strongerDerivation(info.derivation, prev.derivation) === info.derivation) {
      uuidStructured.set(m[0], { uuid: m[0], ...info });
    }
  };
  for (const [uuid, s] of xdsSchemeByUuid) {
    noteUuid(uuid, {
      derivation: s.derivation,
      where: "fields/xds.json locator.uuid",
      label: s.label,
      conflict: s.conflict,
      confidence: s.confidence,
      pageId: s.pageId,
    });
  }
  for (const [key, list] of xdsFixedValues) {
    for (const fv of list) {
      noteUuid(fv.value, {
        derivation: fv.derivation,
        where: "fields/xds.json fixedValue " + key,
        label: fv.statementType,
        conflict: null,
        confidence: null,
      });
    }
  }
  for (const structure of Object.values(structures)) {
    for (const m of walkStructure(structure)) {
      for (const fv of m.fixedValues || []) {
        noteUuid(fv.value, {
          derivation: (fv.provenance || {}).pageId ? "confluence" : (fv.provenance || {}).sample ? "sample" : "unattributed",
          where: "structures.json " + structure.id + " fixedValue",
          label: String(m.label || "").split("\n")[0],
          conflict: null,
          confidence: m.confidence || null,
        });
      }
      const loc = m.locator || {};
      if (loc.uuid) {
        noteUuid(loc.uuid, {
          derivation: (m.provenance || {}).pageId ? "confluence" : (m.provenance || {}).sample ? "sample" : "unattributed",
          where: "structures.json " + structure.id + " locator.uuid",
          label: String(m.label || "").split("\n")[0],
          conflict: null,
          confidence: m.confidence || null,
        });
      }
    }
  }

  return {
    structuresBundle,
    structures,
    constants,
    fields,
    hl7Index: buildHl7Index(fields.hl7v2),
    oidInfo,
    cdaTemplateIds,
    cdaElementNames,
    cdaLabelNames,
    fhirResourceTypes,
    fhirProfiles,
    fhirProfilesLoose,
    xdsNames,
    xdsNamesGlued,
    xdsNamesExact,
    xdsNameDerivation,
    xdsSchemeByUuid,
    xdsFixedValues,
    uuidStructured,
    knownUuids,
  };
}

/**
 * How does the compiled spec know this UUID?
 * Returns { status, provenance, detail, conflict }.
 */
function classifyUuid(spec, raw) {
  const uuid = String(raw || "").toLowerCase();
  const hit = spec.uuidStructured.get(uuid);
  if (hit) {
    return {
      status: "resolved",
      provenance: hit.derivation === "unattributed" ? "unattributed" : hit.derivation,
      detail:
        (hit.label ? hit.label + " — " : "") +
        hit.where +
        (hit.derivation === "sample" ? " (READ OFF A GOLDEN SAMPLE — circular)" : ""),
      conflict: hit.conflict || null,
      confidence: hit.confidence || null,
    };
  }
  if (spec.knownUuids.has(uuid)) {
    return {
      status: "resolved",
      provenance: "prose-mention",
      detail:
        "the UUID appears in the compiled bundle ONLY inside narrative text (a provenance quote, guidance or confidenceReason), " +
        "never as a locator or a fixed value. The baseline gate counts this as resolved; it is the weakest possible match and a " +
        "validator cannot act on it",
      conflict: null,
    };
  }
  return { status: "unknown", provenance: "none", detail: null, conflict: null };
}

/* ------------------------------------------------------------------ */
/* per-sample result accumulator                                        */
/* ------------------------------------------------------------------ */

function makeResult(sample, structureId, structureConfidence) {
  return {
    path: sample.path,
    fileName: sample.fileName,
    format: sample.format,
    useCaseId: sample.useCaseId,
    variant: sample.variant || [],
    structureId: structureId || null,
    structureConfidence: structureConfidence || null,
    elementsFound: 0,
    elementsResolved: 0,
    elementsResolvedExact: 0,
    elementsResolvedNormalised: 0,
    elementsUnknownCount: 0,
    resolutionRate: 0,
    occurrences: 0,
    elements: new Map(),
    elementsUnknown: [],
    elementsIgnoredByNphies: [],
    normalisedMatches: [],
    structuralMismatches: [],
    parseNotes: [],
  };
}

/**
 * status: "resolved" | "normalised" | "unknown"
 *
 * meta (optional):
 *   scope      "baseline" (default) — counted in `overall`, the apples-to-apples
 *                                     figure comparable with the previous run
 *              "extended"           — added by this pass; counted only in
 *                                     `overallExtended`
 *   provenance where the COMPILED RULE that resolved this identifier came from:
 *              "confluence"        a cached Confluence page quote      (independent)
 *              "confluence+sample" a Confluence row confirmed by a sample (independent)
 *              "sample"            read off a golden sample only        (CIRCULAR)
 *              "standard"          IHE/HL7 published constant, not NPHIES (independent
 *                                  of the samples, but not NPHIES-confirmed)
 *              "prose-mention"     the literal appears only inside narrative text
 *                                  in the bundle (weakest possible match)
 *              "none"              unresolved, or resolved with no provenance at all
 */
function record(result, kind, id, status, detail, meta) {
  const key = kind + "::" + id;
  let entry = result.elements.get(key);
  if (!entry) {
    entry = {
      kind,
      id,
      status,
      occurrences: 0,
      detail: detail || null,
      scope: (meta && meta.scope) || "baseline",
      provenance: (meta && meta.provenance) || (status === "unknown" ? "none" : "unattributed"),
      ...(meta && meta.conflict ? { conflict: meta.conflict } : {}),
    };
    result.elements.set(key, entry);
  } else if (status === "unknown" && entry.status !== "unknown") {
    entry.status = "unknown";
    entry.detail = detail || entry.detail;
    entry.provenance = "none";
  }
  entry.occurrences++;
  return entry;
}

/** mismatch codes raised only by the checks this pass added */
const EXTENDED_MISMATCH_CODES = new Set([
  "xds-uuid-conflict",
  "xds-fixedvalue-without-value",
  "xds-fixedvalue-mismatch",
  "xds-externalidentifier-name-unqualified",
  "ebrim-externalidentifier-no-value",
  "ebrim-dangling-reference",
  "ebrim-child-order",
  "xds-document-id-binding",
  "cda-header-order",
  "two-family-spec-inconsistent",
  "two-family-mixed",
]);

function mismatch(result, severity, code, message, evidence) {
  result.structuralMismatches.push({
    severity,
    code,
    scope: EXTENDED_MISMATCH_CODES.has(code) ? "extended" : "baseline",
    message,
    ...(evidence ? { evidence } : {}),
  });
}

const INDEPENDENT_PROVENANCE = new Set(["confluence", "confluence+sample", "standard"]);

function finaliseResult(result) {
  result.kindTotals = {};
  result.extended = { elementsFound: 0, elementsResolved: 0, elementsUnknown: 0 };
  result.provenanceTotals = {};
  for (const entry of result.elements.values()) {
    /* ---- extended-scope elements are tallied separately so `overall`
     * stays comparable with the previous run ------------------------- */
    if (entry.scope === "extended") {
      result.extended.elementsFound++;
      if (entry.status === "unknown") result.extended.elementsUnknown++;
      else result.extended.elementsResolved++;
      result.provenanceTotalsExtended = result.provenanceTotalsExtended || {};
      const pt0 = (result.provenanceTotalsExtended[entry.provenance] =
        result.provenanceTotalsExtended[entry.provenance] || { found: 0, resolved: 0 });
      pt0.found++;
      if (entry.status !== "unknown") pt0.resolved++;
      const ktx = (result.kindTotalsExtended = result.kindTotalsExtended || {});
      const kx = (ktx[entry.kind] = ktx[entry.kind] || { found: 0, resolved: 0, unknown: 0 });
      kx.found++;
      if (entry.status === "unknown") kx.unknown++;
      else kx.resolved++;
      if (entry.status === "unknown") {
        result.elementsUnknownExtended = result.elementsUnknownExtended || [];
        result.elementsUnknownExtended.push({
          kind: entry.kind,
          id: entry.id,
          occurrences: entry.occurrences,
          reason: entry.detail,
        });
      }
      continue;
    }
    const pt = (result.provenanceTotals[entry.provenance] =
      result.provenanceTotals[entry.provenance] || { found: 0, resolved: 0 });
    pt.found++;
    if (entry.status !== "unknown") pt.resolved++;
    result.kindProvenance = result.kindProvenance || {};
    const kp = (result.kindProvenance[entry.kind] = result.kindProvenance[entry.kind] || {});
    kp[entry.provenance] = (kp[entry.provenance] || 0) + 1;

    result.elementsFound++;
    result.occurrences += entry.occurrences;
    const kt = (result.kindTotals[entry.kind] = result.kindTotals[entry.kind] || { found: 0, resolved: 0, unknown: 0 });
    kt.found++;
    if (entry.status === "unknown") kt.unknown++;
    else kt.resolved++;
    if (entry.status === "resolved") {
      result.elementsResolved++;
      result.elementsResolvedExact++;
    } else if (entry.status === "normalised") {
      result.elementsResolved++;
      result.elementsResolvedNormalised++;
      result.normalisedMatches.push({ kind: entry.kind, id: entry.id, matchedSpecLiteral: entry.detail });
    } else {
      result.elementsUnknownCount++;
      result.elementsUnknown.push({
        kind: entry.kind,
        id: entry.id,
        occurrences: entry.occurrences,
        reason: entry.detail,
      });
    }
  }
  result.elementsUnknown.sort((a, b) => b.occurrences - a.occurrences || a.id.localeCompare(b.id));
  result.resolutionRate = result.elementsFound
    ? Number((result.elementsResolved / result.elementsFound).toFixed(4))
    : 0;
  delete result.elements;
  return result;
}

/* ------------------------------------------------------------------ */
/* structure selection                                                  */
/* ------------------------------------------------------------------ */

function selectStructure(spec, sample, parsed) {
  const candidates = Object.values(spec.structures).filter((s) => s.useCaseId === sample.useCaseId);
  if (!candidates.length) return { structure: null, reason: "no compiled MessageStructure for useCaseId " + sample.useCaseId };

  if (sample.format === "hl7v2" && parsed && parsed.segments.length) {
    const msh = parsed.segments.find((s) => s.name === "MSH");
    const msgType = msh ? msh.fields.get(9) || "" : "";
    const code = comp(msgType, 0);
    const trigger = comp(msgType, 1);
    if (code === "ACK") {
      const msa = parsed.segments.find((s) => s.name === "MSA");
      const ack = msa ? comp(msa.fields.get(1), 0) : "";
      const wanted = ack === "AE" || ack === "AR" ? "ACK-negative" : "ACK-positive";
      const hit = candidates.find((c) => c.variant === wanted);
      return hit
        ? { structure: hit, reason: "MSH-9=" + msgType + ", MSA-1=" + ack }
        : { structure: null, reason: "no ACK structure for " + wanted };
    }
    const wantedId = (code + "-" + trigger).toLowerCase();
    const hit = spec.structures[wantedId] || candidates.find((c) => c.variant === trigger);
    return hit
      ? { structure: hit, reason: "MSH-9=" + msgType }
      : { structure: null, reason: "no compiled structure for message type " + msgType };
  }

  if (candidates.length === 1) return { structure: candidates[0], reason: "single structure for use case" };

  const variants = (sample.variant || []).map(squash);
  const hit = candidates.find((c) => c.variant && variants.includes(squash(c.variant)));
  if (hit) return { structure: hit, reason: "variant " + hit.variant };
  const byName = candidates.find((c) => variants.some((v) => squash(c.id).includes(v)));
  if (byName) return { structure: byName, reason: "variant token match on id" };
  return {
    structure: null,
    reason:
      "ambiguous: " +
      candidates.length +
      " structures for useCaseId " +
      sample.useCaseId +
      " and variant [" +
      (sample.variant || []).join(", ") +
      "] matches none",
  };
}

/* ------------------------------------------------------------------ */
/* HL7 v2 checker                                                       */
/* ------------------------------------------------------------------ */

function checkHl7(spec, sample, text) {
  const parsed = parseEr7(text);
  const picked = selectStructure(spec, sample, parsed);
  const structure = picked.structure;
  const result = makeResult(sample, structure ? structure.id : null, structure ? structure.confidence : null);
  result.parseNotes = parsed.notes.slice();
  result.structureSelection = picked.reason;

  if (!structure) {
    mismatch(result, "blocker", "no-structure", picked.reason);
    for (const seg of parsed.segments) record(result, "hl7Segment", seg.name, "unknown", "no structure selected");
    return finaliseResult(result);
  }

  const specSegments = [];
  for (const m of walkStructure(structure)) if (m.kind === "segment" && m.segment) specSegments.push(m);
  const orderIndex = new Map();
  const memberList = structureMembers(structure.root);
  memberList.forEach((m, idx) => {
    if (m.kind === "segment" && m.segment && !orderIndex.has(m.segment)) orderIndex.set(m.segment, idx);
  });
  const bySegName = new Map(specSegments.map((m) => [m.segment, m]));
  const areaHint = structure.id.startsWith("oru") ? "ORU" : "ADT";

  // MSH.2 encoding characters — structural, fixed value
  const msh = parsed.segments.find((s) => s.name === "MSH");
  if (msh) {
    const enc = msh.fields.get(2);
    const expected = spec.constants.hl7Encoding.encodingCharacters.value;
    if (enc !== expected) {
      mismatch(
        result,
        "warn",
        "fixed-value",
        'MSH-2 encoding characters are "' + enc + '" but the compiled constant is "' + expected + '"',
        { specQuote: spec.constants.hl7Encoding.encodingCharacters.goldenEvidence },
      );
    }
  }

  let lastOrder = -1;
  for (const seg of parsed.segments) {
    const specMember = bySegName.get(seg.name);
    if (specMember) {
      record(result, "hl7Segment", seg.name, "resolved");
      const usage = firstUsage(specMember);
      if (usage && (usage.usage === "X" || usage.usage === "NP" || usage.usage === "-")) {
        mismatch(
          result,
          "error",
          "segment-not-allowed",
          seg.name + " is present but " + structure.id + " marks it " + usage.usage,
          { specQuote: (specMember.provenance || {}).quote },
        );
      }
      const idx = orderIndex.has(seg.name) ? orderIndex.get(seg.name) : null;
      if (idx != null) {
        if (idx < lastOrder) {
          mismatch(
            result,
            "warn",
            "segment-order",
            seg.name + " appears after a segment the compiled structure places later in the sequence",
          );
        }
        lastOrder = Math.max(lastOrder, idx);
      }
    } else if (spec.hl7Index.has(seg.name)) {
      record(result, "hl7Segment", seg.name, "resolved");
      mismatch(
        result,
        "error",
        "segment-not-in-structure",
        seg.name +
          " has a compiled field table but is not a member of " +
          structure.id +
          " (the event structure table does not list it)",
      );
    } else {
      record(result, "hl7Segment", seg.name, "unknown", "segment unknown to the compiled spec");
    }

    for (const [num, value] of seg.fields) {
      if (!value || !String(value).trim()) continue;
      if (seg.name === "MSH" && num === 1) continue; // the separator itself
      const id = seg.name + "-" + num;
      const found = hl7FieldNode(spec.hl7Index, seg.name, num, areaHint);
      if (!found.node) {
        record(result, "hl7Field", id, "unknown", found.reason);
        continue;
      }
      record(result, "hl7Field", id, "resolved");
      const usage = firstUsage(found.node);
      if (usage && (usage.usage === "X" || usage.usage === "NP" || usage.usage === "-")) {
        mismatch(
          result,
          usage.usage === "NP" ? "error" : "warn",
          "field-not-allowed",
          id + " is populated but the compiled usage is " + usage.usage,
          { specQuote: (found.node.provenance || {}).quote },
        );
      } else if (usage && usage.usage === "I") {
        result.elementsIgnoredByNphies.push({
          id,
          note: "usage I — NPHIES accepts then discards this field",
          specQuote: (found.node.provenance || {}).quote,
        });
      }
    }
  }

  // required segments that are absent (structure knowledge, not resolution)
  for (const m of memberList) {
    if (m.kind !== "segment" || !m.segment) continue;
    const usage = firstUsage(m);
    if (!usage) continue;
    if ((usage.usage === "R" || usage.usage === "M") && !parsed.segments.some((s) => s.name === m.segment)) {
      mismatch(
        result,
        "error",
        "required-segment-missing",
        m.segment + " is " + usage.usage + " in " + structure.id + " but is absent from the official sample",
        { specQuote: (m.provenance || {}).quote },
      );
    }
  }

  return finaliseResult(result);
}

/* ------------------------------------------------------------------ */
/* CDA checker                                                          */
/* ------------------------------------------------------------------ */

function checkCda(spec, sample, text) {
  const picked = selectStructure(spec, sample, null);
  const structure = picked.structure;
  const result = makeResult(sample, structure ? structure.id : null, structure ? structure.confidence : null);
  result.structureSelection = picked.reason;

  const { root, errors } = parseXml(text);
  for (const e of errors) result.parseNotes.push("xml: " + e);
  if (!root) {
    mismatch(result, "blocker", "unparseable", "could not parse XML document element");
    return finaliseResult(result);
  }
  if (root.local !== "ClinicalDocument") {
    mismatch(result, "error", "root-element", "document element is <" + root.name + ">, expected <ClinicalDocument>");
  }
  if (!structure) {
    mismatch(result, "blocker", "no-structure", picked.reason);
  }

  const env = (structure && structure.envelope) || {};

  // --- document-level templateIds + child element names ---------------
  const docTemplateIds = [];
  for (const child of root.children) {
    if (child.local === "templateId" && child.attrs.root) docTemplateIds.push(child.attrs.root);
  }
  if (env.documentTemplateId && !docTemplateIds.includes(env.documentTemplateId)) {
    mismatch(
      result,
      "error",
      "document-templateid",
      "document templateId(s) [" +
        docTemplateIds.join(", ") +
        "] do not include the compiled document templateId " +
        env.documentTemplateId,
      { specPage: env.specPage },
    );
  }

  for (const child of root.children) {
    if (child.local === "templateId") continue;
    const name = child.local;
    const known =
      spec.cdaElementNames.has(name) ||
      spec.cdaElementNames.has(child.name) ||
      spec.cdaLabelNames.has(squash(name));
    record(
      result,
      "cdaHeaderElement",
      child.name,
      known ? "resolved" : "unknown",
      known ? null : "no compiled CDA element path or header row names this element",
    );
  }

  /* ================================================================== *
   * EXTENDED (this pass): header element ORDER, not merely presence.
   * The compiled structure carries the normative ClinicalDocument sequence
   * as an ORDERED member list (group "ClinicalDocument header (document
   * order)"), with its own Confluence provenance — so this check is made
   * against the spec, not against a sequence invented here.
   * ================================================================== */
  checkCdaHeaderOrder(spec, result, root, structure);

  // --- every templateId anywhere in the document ----------------------
  const sectionNodes = [];
  for (const node of walkXml(root)) {
    if (node.local === "templateId" && node.attrs.root) {
      const oid = node.attrs.root;
      const info = spec.oidInfo.get(oid);
      if (spec.cdaTemplateIds.has(oid)) {
        record(result, "cdaTemplateId", oid, "resolved");
      } else if (info && info.quarantined) {
        record(
          result,
          "cdaTemplateId",
          oid,
          "unknown",
          "OID is quarantined in constants.json (" + (info.quarantineReason || "placeholder/example") + ") yet the official sample uses it as a templateId",
        );
      } else {
        record(result, "cdaTemplateId", oid, "unknown", "OID not present in the compiled OID index");
      }
    }
    if (node.local === "section" && node.parent && node.parent.local === "component") sectionNodes.push(node);
  }

  // --- sections against the compiled section list ---------------------
  const specSections = [];
  if (structure) for (const m of walkStructure(structure)) if (m.kind === "section") specSections.push(m);
  const sectionByTemplate = new Map();
  for (const s of specSections) for (const t of s.templateIds || []) sectionByTemplate.set(t, s);

  let lastPosition = -1;
  for (const node of sectionNodes) {
    const tids = node.children.filter((c) => c.local === "templateId" && c.attrs.root).map((c) => c.attrs.root);
    const codeEl = node.children.find((c) => c.local === "code");
    const code = codeEl ? codeEl.attrs.code : null;
    const label = tids.length ? tids[0] : code ? "code:" + code : "(no templateId, no code)";
    const hit = tids.map((t) => sectionByTemplate.get(t)).find(Boolean);
    if (hit) {
      record(result, "cdaSection", label, "resolved");
      const pos = typeof hit.position === "number" ? hit.position : null;
      if (pos != null && node.parent.parent === root) {
        if (pos < lastPosition) {
          mismatch(
            result,
            "warn",
            "section-order",
            'section "' + hit.label + '" (position ' + pos + ") appears after a section the compiled structure places later",
          );
        }
        lastPosition = Math.max(lastPosition, pos);
      }
    } else if (tids.some((t) => spec.cdaTemplateIds.has(t))) {
      record(
        result,
        "cdaSection",
        label,
        "unknown",
        "section templateId is a known OID but is NOT one of the " +
          specSections.length +
          " sections the compiled structure " +
          (structure ? structure.id : "(none)") +
          " allows",
      );
      mismatch(
        result,
        "error",
        "section-not-in-structure",
        "section " + label + " is present in the official sample but absent from the compiled section list of " +
          (structure ? structure.id : "(none)"),
      );
    } else {
      record(result, "cdaSection", label, "unknown", "section templateId unknown to the compiled spec");
    }
  }

  // required sections missing from the official sample
  if (structure) {
    const presentTids = new Set();
    for (const node of sectionNodes)
      for (const c of node.children) if (c.local === "templateId" && c.attrs.root) presentTids.add(c.attrs.root);
    for (const s of specSections) {
      const usage = firstUsage(s);
      if (!usage || !(usage.usage === "R" || usage.usage === "M")) continue;
      const tids = s.templateIds || [];
      if (!tids.length) continue;
      if (!tids.some((t) => presentTids.has(t))) {
        mismatch(
          result,
          "error",
          "required-section-missing",
          'section "' + String(s.label).split("\n")[0] + '" is ' + usage.usage + " in " + structure.id + " but absent from the official sample",
          { specQuote: (s.provenance || {}).quote },
        );
      }
    }
  }

  return finaliseResult(result);
}

/* ------------------------------------------------------------------ */
/* EXTENDED: CDA header element ORDER                                   */
/* ------------------------------------------------------------------ */

/** the compiled ordered header sequence, or null if the structure has none */
function compiledHeaderSequence(structure) {
  if (!structure) return null;
  for (const m of walkStructure(structure)) {
    if (m.kind !== "group") continue;
    if (!/document order/i.test(String(m.label || ""))) continue;
    const members = structureMembers(m);
    if (!members.length) continue;
    return { group: m, sequence: members.map((x) => String(x.label || "").trim()) };
  }
  return null;
}

function checkCdaHeaderOrder(spec, result, root, structure) {
  const EXT = { scope: "extended" };
  const compiled = compiledHeaderSequence(structure);
  if (!compiled) {
    record(
      result,
      "cdaHeaderOrder",
      "(no compiled sequence)",
      "unknown",
      "the compiled structure " +
        (structure ? structure.id : "(none)") +
        ' has no ordered "ClinicalDocument header (document order)" group, so header ORDER cannot be checked at all',
      { ...EXT, provenance: "none" },
    );
    return;
  }

  const prov = memberProvenance(compiled.group);
  const index = new Map();
  compiled.sequence.forEach((label, i) => {
    index.set(label, i);
    index.set(label.split(":").pop(), i);
  });

  let last = -1;
  let lastLabel = null;
  let inverted = null;
  let positioned = 0;
  for (const child of root.children) {
    const i = index.has(child.name) ? index.get(child.name) : index.get(child.local);
    if (i === undefined) continue;
    positioned++;
    if (i < last && !inverted) inverted = { before: lastLabel, after: child.name };
    if (i >= last) {
      last = i;
      lastLabel = child.name;
    }
  }

  record(
    result,
    "cdaHeaderOrder",
    structure.id,
    inverted ? "unknown" : "resolved",
    inverted
      ? "<" + inverted.after + "> appears after <" + inverted.before + ">, inverting the compiled ClinicalDocument sequence"
      : positioned + " header element(s) appear in the compiled normative order",
    { ...EXT, provenance: prov },
  );

  if (inverted) {
    mismatch(
      result,
      "error",
      "cda-header-order",
      "ClinicalDocument header is out of order: <" +
        inverted.after +
        "> appears after <" +
        inverted.before +
        ">. The compiled sequence is " +
        compiled.sequence.join(" → "),
      { specQuote: (compiled.group.provenance || {}).quote },
    );
  }

  /* header elements the sample carries that the compiled sequence does not
   * place at all — presence-only checking hid these. */
  for (const child of root.children) {
    if (index.has(child.name) || index.has(child.local)) continue;
    record(
      result,
      "cdaHeaderOrder",
      "unsequenced:" + child.name,
      "unknown",
      "<" + child.name + "> is present in the official sample but the compiled header sequence does not place it, " +
        "so its position cannot be validated",
      { ...EXT, provenance: "none" },
    );
  }
}

/* ------------------------------------------------------------------ */
/* FHIR checker                                                         */
/* ------------------------------------------------------------------ */

function checkFhir(spec, sample, text) {
  const picked = selectStructure(spec, sample, null);
  const structure = picked.structure;
  const result = makeResult(sample, structure ? structure.id : null, structure ? structure.confidence : null);
  result.structureSelection = picked.reason;

  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch (err) {
    // Several official Raqeeb samples carry C-style `///` annotations inside the
    // JSON, which makes the published file invalid JSON. Strip them so the
    // structure can still be measured, and record the defect.
    const repaired = stripJsonComments(text).replace(/,(\s*[}\]])/g, "$1");
    try {
      bundle = JSON.parse(repaired);
      mismatch(
        result,
        "blocker",
        "sample-not-valid-json",
        "the OFFICIAL sample file is not valid JSON (" +
          err.message +
          "); it carries `//` annotation comments. Measured after stripping them, but any HIS parsing this file as published will fail",
      );
    } catch (err2) {
      mismatch(
        result,
        "blocker",
        "sample-unparseable",
        "the OFFICIAL sample file is broken JSON and cannot be measured at all — " +
          err2.message +
          " (original error: " +
          err.message +
          "). This is a defect in the published sample, not in the compiled spec.",
      );
      return finaliseResult(result);
    }
  }
  if (!structure) mismatch(result, "blocker", "no-structure", picked.reason);
  const env = (structure && structure.envelope) || {};

  // --- Bundle level ---------------------------------------------------
  const bundleType = bundle.resourceType;
  record(
    result,
    "fhirResourceType",
    bundleType,
    spec.fhirResourceTypes.has(bundleType) ? "resolved" : "unknown",
    spec.fhirResourceTypes.has(bundleType) ? null : "resourceType not in constants.resourceTypes",
  );
  if (bundleType !== "Bundle") {
    mismatch(result, "error", "root-resource", "root resourceType is " + bundleType + ", expected Bundle");
  }
  if (env.bundleType && bundle.type !== env.bundleType) {
    mismatch(
      result,
      "error",
      "bundle-type",
      'Bundle.type is "' + bundle.type + '" but the compiled rule fixes it to "' + env.bundleType + '"',
      { specQuote: env.bundleTypeRule ? env.bundleTypeRule.quote : undefined },
    );
  }

  const bundleProfiles = (bundle.meta && bundle.meta.profile) || [];
  const structureProfileFixed = [];
  if (structure) {
    for (const m of walkStructure(structure)) {
      for (const fv of m.fixedValues || []) {
        if (fv.elementPath === "./meta/profile" && fv.value) structureProfileFixed.push(fv.value);
      }
    }
  }
  for (const p of bundleProfiles) {
    recordProfile(spec, result, p, "fhirBundleProfile");
    if (structureProfileFixed.length && !structureProfileFixed.includes(p)) {
      mismatch(
        result,
        "error",
        "bundle-profile",
        "Bundle.meta.profile is " + p + " but the compiled fixed value is " + structureProfileFixed.join(" | "),
      );
    }
  }
  if (!bundleProfiles.length && structureProfileFixed.length) {
    mismatch(result, "error", "bundle-profile-missing", "Bundle.meta.profile is absent; compiled rule fixes it to " + structureProfileFixed[0]);
  }

  // --- compiled entry list --------------------------------------------
  const specEntries = [];
  if (structure) for (const m of walkStructure(structure)) if (m.kind === "entry") specEntries.push(m);
  const declaredTypes = new Set(
    specEntries.map((e) => (e.resourceType ? String(e.resourceType) : null)).filter(Boolean),
  );
  const declaredTypesLc = new Set([...declaredTypes].map((t) => t.toLowerCase()));
  const untypedEntries = specEntries.filter((e) => !e.resourceType);

  const entries = Array.isArray(bundle.entry) ? bundle.entry : [];
  if (!entries.length) mismatch(result, "error", "no-entries", "Bundle has no entry array");

  if (env.firstEntryRule && env.firstEntryRule.resourceType) {
    const first = entries[0] && entries[0].resource ? entries[0].resource.resourceType : null;
    if (first !== env.firstEntryRule.resourceType) {
      mismatch(
        result,
        "error",
        "first-entry",
        "first Bundle.entry is " + first + " but the compiled rule requires " + env.firstEntryRule.resourceType,
        { specQuote: env.firstEntryRule.requirement || (env.firstEntryRule.source || {}).quote },
      );
    }
  }

  /* ================================================================== *
   * EXTENDED (this pass): the FHIR TWO-FAMILY rule, checked explicitly
   * per sample as a single pass/fail fact rather than as two independent
   * mismatches that are silently skipped when the compiled rule is absent.
   *
   * NPHIES FHIR splits into two families:
   *   document family — Bundle.type = "document", first entry Composition
   *   message  family — Bundle.type = "message",  first entry MessageHeader
   * A bundle that mixes them (type "message" opening with a Composition, or
   * type "document" opening with a MessageHeader) is structurally wrong even
   * though every individual element resolves.
   * ================================================================== */
  checkFhirTwoFamily(result, structure, env, bundle, entries);

  const seenTypes = new Set();
  entries.forEach((entry, idx) => {
    const res = entry && entry.resource;
    if (!res) {
      record(result, "fhirEntry", "entry[" + idx + "] (no resource)", "unknown", "Bundle.entry without a resource");
      return;
    }
    const rt = res.resourceType;
    seenTypes.add(rt);
    if (declaredTypesLc.has(String(rt).toLowerCase())) {
      record(result, "fhirResourceType", rt, "resolved");
    } else if (spec.fhirResourceTypes.has(rt)) {
      record(
        result,
        "fhirResourceType",
        rt,
        "unknown",
        "resourceType is known to constants.json but is NOT in the compiled entry list of " +
          (structure ? structure.id : "(none)") +
          " [" +
          [...declaredTypes].join(", ") +
          "]",
      );
      mismatch(
        result,
        "error",
        "entry-type-not-in-structure",
        "Bundle.entry[" + idx + "] is a " + rt + ", which the compiled entry list of " +
          (structure ? structure.id : "(none)") +
          " does not declare" +
          (untypedEntries.length
            ? " (" + untypedEntries.length + " compiled entry row(s) carry no resourceType at all: " +
              untypedEntries.map((e) => String(e.label).split("\n")[0]).join("; ") + ")"
            : ""),
      );
    } else {
      record(result, "fhirResourceType", rt, "unknown", "resourceType unknown to the compiled spec");
    }
    for (const p of (res.meta && res.meta.profile) || []) recordProfile(spec, result, p, "fhirProfile");
  });

  // compiled entries that name a resourceType no real message can carry
  for (const e of specEntries) {
    if (!e.resourceType) continue;
    if (!spec.fhirResourceTypes.has(e.resourceType) && !seenTypes.has(e.resourceType)) {
      mismatch(
        result,
        "error",
        "phantom-resource-type",
        'compiled entry "' + String(e.label).split("\n")[0] + '" declares resourceType "' + e.resourceType +
          '", which is neither a FHIR resource type in constants.json nor present in any official sample — it looks like a profile/label captured in the wrong column',
        { specQuote: (e.provenance || {}).quote },
      );
    }
  }

  // required entries absent from the official sample
  for (const e of specEntries) {
    const usage = firstUsage(e);
    if (!usage || !(usage.usage === "M" || usage.usage === "R")) continue;
    if (!e.resourceType) continue;
    if (!seenTypes.has(e.resourceType)) {
      mismatch(
        result,
        "warn",
        "required-entry-missing",
        "compiled entry " + e.resourceType + " is " + usage.usage + " in " + (structure ? structure.id : "") +
          " but no entry of that type is present in the official sample",
        { specQuote: (e.provenance || {}).quote },
      );
    }
  }

  return finaliseResult(result);
}

const FHIR_FAMILIES = {
  document: "Composition",
  message: "MessageHeader",
};

function checkFhirTwoFamily(result, structure, env, bundle, entries) {
  const EXT = { scope: "extended" };
  const id = structure ? structure.id : "(no structure)";
  const specType = env.bundleType || null;
  const specFirst = (env.firstEntryRule && env.firstEntryRule.resourceType) || null;

  if (!specType || !specFirst) {
    record(
      result,
      "fhirTwoFamilyRule",
      id,
      "unknown",
      "the compiled structure states " +
        (specType ? "" : "no Bundle.type") +
        (!specType && !specFirst ? " and " : "") +
        (specFirst ? "" : "no first-entry rule") +
        " — the two-family rule cannot be checked for this use case",
      { ...EXT, provenance: "none" },
    );
    return;
  }

  /* is the compiled pair itself self-consistent? */
  const expectedFirst = FHIR_FAMILIES[specType];
  if (expectedFirst && expectedFirst !== specFirst) {
    record(
      result,
      "fhirTwoFamilyRule",
      id,
      "unknown",
      "THE COMPILED RULE IS INTERNALLY INCONSISTENT: it fixes Bundle.type to \"" +
        specType +
        '" but requires the first entry to be ' +
        specFirst +
        " — the " +
        specType +
        " family opens with " +
        expectedFirst,
      { ...EXT, provenance: "none" },
    );
    mismatch(
      result,
      "error",
      "two-family-spec-inconsistent",
      "compiled structure " + id + ' pairs Bundle.type "' + specType + '" with first entry ' + specFirst +
        " — those belong to different NPHIES FHIR families",
    );
    return;
  }

  const actualType = bundle.type || null;
  const actualFirst = entries[0] && entries[0].resource ? entries[0].resource.resourceType : null;
  const typeOk = actualType === specType;
  const firstOk = actualFirst === specFirst;

  record(
    result,
    "fhirTwoFamilyRule",
    id,
    typeOk && firstOk ? "resolved" : "unknown",
    typeOk && firstOk
      ? 'Bundle.type "' + actualType + '" + first entry ' + actualFirst + " — consistent " + specType + " family"
      : "family violated: Bundle.type is \"" + actualType + '" (compiled: "' + specType + '") and the first entry is ' +
        actualFirst + " (compiled: " + specFirst + ")",
    { ...EXT, provenance: memberProvenance({ provenance: (env.bundleTypeRule || {}).source || env.bundleTypeRule }) },
  );

  if (typeOk && !firstOk) {
    mismatch(
      result,
      "error",
      "two-family-mixed",
      'Bundle.type is "' + actualType + '" (the ' + actualType + " family) but the bundle opens with " + actualFirst +
        ", not " + specFirst,
    );
  }
}

/** removes `//...` line comments that sit OUTSIDE JSON string literals */
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
      out += text[i] || "";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function recordProfile(spec, result, url, kind) {
  if (spec.fhirProfiles.has(url)) {
    record(result, kind, url, "resolved");
    return;
  }
  const loose = spec.fhirProfilesLoose.get(String(url).toLowerCase());
  if (loose) {
    record(result, kind, url, "normalised", loose);
    return;
  }
  const base = String(url).split("|")[0];
  const looseBase = spec.fhirProfilesLoose.get(base.toLowerCase()) ||
    [...spec.fhirProfiles.keys()].find((k) => k.split("|")[0].toLowerCase() === base.toLowerCase());
  if (looseBase) {
    record(result, kind, url, "normalised", looseBase);
    return;
  }
  record(result, kind, url, "unknown", "profile URL not in constants.fhirProfiles (" + spec.fhirProfiles.size + " known)");
}

/* ------------------------------------------------------------------ */
/* SOAP / XDS checker                                                   */
/* ------------------------------------------------------------------ */

function structureElementPaths(structure) {
  // Build localName paths from the compiled tree, skipping the wrapper group
  // whose label duplicates the document element.
  const paths = new Set();
  const names = new Set();
  const nodeByPath = new Map();
  const localOf = (label) => String(label || "").split(":").pop().trim();
  const visit = (node, prefixPath) => {
    const local = localOf(node.label);
    let next = prefixPath;
    if (node.kind !== "group") {
      next = prefixPath ? prefixPath + "/" + local : local;
      paths.add(next);
      names.add(local);
      if (!nodeByPath.has(next)) nodeByPath.set(next, node);
    }
    for (const m of structureMembers(node)) visit(m, next);
  };
  visit(structure.root, "");
  return { paths, names, nodeByPath };
}

/** provenance bucket for one compiled structure member */
function memberProvenance(node) {
  if (!node) return "unattributed";
  const d = node.derivation;
  if (d === "confluence" || d === "confluence+sample" || d === "sample" || d === "standard") return d;
  const p = node.provenance || {};
  if (p.pageId && p.sample) return "confluence+sample";
  if (p.pageId) return "confluence";
  if (p.sample || (node.samples && node.samples.length)) return "sample";
  return "unattributed";
}

function checkSoap(spec, sample, text) {
  const picked = selectStructure(spec, sample, null);
  const structure = picked.structure;
  const result = makeResult(sample, structure ? structure.id : null, structure ? structure.confidence : null);
  result.structureSelection = picked.reason;

  const { root, errors } = parseXml(text);
  for (const e of errors) result.parseNotes.push("xml: " + e);
  if (!root) {
    mismatch(result, "blocker", "unparseable", "could not parse XML document element");
    return finaliseResult(result);
  }
  if (!structure) mismatch(result, "blocker", "no-structure", picked.reason);

  const env = (structure && structure.envelope) || {};
  const specPaths = structure
    ? structureElementPaths(structure)
    : { paths: new Set(), names: new Set(), nodeByPath: new Map() };

  if (root.local !== "Envelope") {
    mismatch(
      result,
      "error",
      "root-element",
      "document element is <" +
        root.name +
        ">, expected <Envelope> — XML element names are case-sensitive, so this is not a SOAP envelope",
    );
  }

  // Path of localNames relative to the document element; the document element is
  // reported as "Envelope" so a mis-cased root does not distort the measurement.
  const soapPath = (node) => {
    const parts = [];
    let cur = node;
    while (cur && cur !== root) {
      parts.unshift(cur.local);
      cur = cur.parent;
    }
    return ["Envelope", ...parts].join("/");
  };

  // ws-addressing Action must match the compiled envelope rule
  if (env.wsAddressingAction) {
    let actual = null;
    for (const node of walkXml(root)) {
      if (node.local === "Action") {
        actual = norm(node.text);
        break;
      }
    }
    if (actual && actual !== env.wsAddressingAction) {
      mismatch(
        result,
        "error",
        "wsa-action",
        "wsa:Action is " + actual + " but the compiled envelope declares " + env.wsAddressingAction,
      );
    }
  }

  // Embedded CDA payloads are gated by the CDA checker; do not descend into them.
  const inEmbeddedDocument = (node) => {
    let cur = node.parent;
    while (cur) {
      if (cur.local === "ClinicalDocument") return true;
      cur = cur.parent;
    }
    return false;
  };

  for (const node of walkXml(root)) {
    if (node === root) continue;
    if (inEmbeddedDocument(node)) continue;
    const p = soapPath(node);
    if (specPaths.paths.has(p)) {
      const specNode = specPaths.nodeByPath.get(p);
      const prov = memberProvenance(specNode);
      record(result, "soapPath", p, "resolved", null, { provenance: prov });
    } else if (specPaths.names.has(node.local)) {
      record(
        result,
        "soapPath",
        p,
        "unknown",
        "the compiled tree knows an element named <" +
          node.local +
          "> but does not place it at this path, so the nesting is unspecified",
      );
    } else {
      record(
        result,
        "soapPath",
        p,
        "unknown",
        "element path not present in the compiled SOAP tree for " + (structure ? structure.id : "(none)"),
      );
    }

    // XDS metadata: Slot names, classification schemes, ExternalIdentifier names
    if (node.local === "Slot" && node.attrs.name) recordXdsName(spec, result, node.attrs.name, "xdsSlot");
    if (node.attrs.classificationScheme) {
      const c = classifyUuid(spec, node.attrs.classificationScheme);
      record(
        result,
        "xdsClassificationScheme",
        node.attrs.classificationScheme,
        c.status,
        c.status === "resolved" ? c.detail : "classification scheme UUID never mentioned anywhere in the compiled spec",
        { provenance: c.provenance },
      );
    }
    if (node.local === "ExternalIdentifier" && node.attrs.identificationScheme) {
      const c = classifyUuid(spec, node.attrs.identificationScheme);
      record(
        result,
        "xdsIdentificationScheme",
        node.attrs.identificationScheme,
        c.status,
        c.status === "resolved" ? c.detail : "identification scheme UUID never mentioned anywhere in the compiled spec",
        { provenance: c.provenance },
      );
    }
  }

  /* ================================================================== *
   * EXTENDED (this pass): resolve INSIDE the RegistryObjectList.
   * The baseline gate only walked element paths and Slot names; it never
   * looked at the ebRIM identity attributes that actually carry the XDS
   * metadata model. Everything below is scope "extended" so the headline
   * `overall` number stays comparable with the previous run.
   * ================================================================== */
  checkEbrim(spec, result, root, structure, inEmbeddedDocument);

  // ITI-18 query parameters live in rim:Slot/@name inside rim:AdhocQuery — already
  // covered above; also resolve the stored query id.
  for (const node of walkXml(root)) {
    if (node.local === "AdhocQuery" && node.attrs.id) {
      const c = classifyUuid(spec, node.attrs.id);
      record(
        result,
        "xdsStoredQueryId",
        node.attrs.id,
        c.status,
        c.status === "resolved" ? c.detail : "stored query UUID not mentioned anywhere in the compiled spec",
        { provenance: c.provenance },
      );
    }
  }

  return finaliseResult(result);
}

function recordXdsName(spec, result, name, kind, scope) {
  const literal = norm(name);
  const meta = (lit) => ({
    scope: scope || "baseline",
    provenance: spec.xdsNameDerivation.get(lit) || "unattributed",
  });
  if (spec.xdsNamesExact.has(literal)) {
    record(result, kind, literal, "resolved", null, meta(literal));
    return;
  }
  const hit = spec.xdsNames.get(squashFootnote(literal));
  if (hit) {
    record(result, kind, literal, "normalised", hit.join(" | "), meta(hit[0]));
    return;
  }
  const glued = spec.xdsNamesGlued.get(squashGluedFootnote(literal));
  if (glued) {
    record(result, kind, literal, "normalised", glued.join(" | "), meta(glued[0]));
    return;
  }
  record(result, kind, literal, "unknown", "no compiled XDS metadata attribute or query parameter with this name", {
    scope: scope || "baseline",
  });
}

/* ------------------------------------------------------------------ */
/* EXTENDED: ebRIM content model inside the RegistryObjectList          */
/* ------------------------------------------------------------------ */

const EBRIM_OBJECTS = new Set([
  "ExtrinsicObject",
  "RegistryPackage",
  "Association",
  "Classification",
  "ExternalIdentifier",
  "ObjectRef",
  "RegistryObject",
]);

/**
 * Resolves the identity attributes of every ebRIM RegistryObject against the
 * compiled XDS content model, and checks the sample's own internal referential
 * integrity (classifiedObject / sourceObject / targetObject must point at an id
 * the same message declares — that is ebRIM law, not an NPHIES rule, and is
 * recorded as provenance "standard").
 */
function checkEbrim(spec, result, root, structure, inEmbeddedDocument) {
  const EXT = { scope: "extended" };
  const declaredIds = new Set();
  const objects = [];

  for (const node of walkXml(root)) {
    if (inEmbeddedDocument(node)) continue;
    if (EBRIM_OBJECTS.has(node.local) || node.local === "RegistryObjectList") {
      if (node.attrs.id) declaredIds.add(norm(node.attrs.id));
      if (EBRIM_OBJECTS.has(node.local)) objects.push(node);
    }
  }
  if (!objects.length) return;

  /**
   * Resolve an ebRIM identity attribute. Two ways the compiled spec can know
   * it: as a scheme UUID, or as a fixedValue on rim:<Object>/@<attr>. The
   * second matters because several of these are URNs, not UUIDs.
   */
  const fixedValueFor = (objectLocal, attr) =>
    spec.xdsFixedValues.get("rim:" + objectLocal + "/@" + attr) || [];

  const uuidAttr = (node, attr, kind, label) => {
    const raw = node.attrs[attr];
    if (!raw) return;
    const fixed = fixedValueFor(node.local, attr);
    const stated = fixed.filter((f) => f.value);
    const hitFixed = stated.find((f) => f.value === norm(raw));
    if (hitFixed) {
      record(result, kind, raw, "resolved", "compiled fixed value on rim:" + node.local + "/@" + attr, {
        ...EXT,
        provenance: hitFixed.derivation,
      });
      return;
    }
    const c = classifyUuid(spec, raw);
    if (c.status === "unknown" && fixed.length && !stated.length) {
      /* The compiled spec HAS a rule for this attribute but the rule carries no
       * value — it was compiled with `meaning` and provenance but the literal
       * was dropped. Nothing can be validated against it. */
      record(
        result,
        kind,
        raw,
        "unknown",
        "the compiled spec declares " +
          fixed.length +
          " fixed value(s) for rim:" +
          node.local +
          "/@" +
          attr +
          " but EVERY ONE has a null `value` — the rule names the meanings and cites a page, yet states no literal, so nothing can be matched against it",
        { ...EXT, provenance: "none" },
      );
      mismatch(
        result,
        "error",
        "xds-fixedvalue-without-value",
        "rim:" +
          node.local +
          "/@" +
          attr +
          " carries " +
          fixed.length +
          " compiled fixedValue row(s) with no `value` at all (meanings: " +
          fixed.map((f) => f.statementType).join(", ") +
          "); the official sample emits \"" +
          raw +
          '" and the compiled spec cannot confirm or reject it',
      );
      return;
    }
    if (c.status === "unknown" && stated.length) {
      record(
        result,
        kind,
        raw,
        "unknown",
        "the compiled fixed value(s) for rim:" +
          node.local +
          "/@" +
          attr +
          " are [" +
          stated.map((f) => f.value).join(", ") +
          "]; the official sample emits a different literal",
        { ...EXT, provenance: "none" },
      );
      mismatch(
        result,
        "error",
        "xds-fixedvalue-mismatch",
        "rim:" + node.local + "/@" + attr + ' is "' + raw + '" but the compiled fixed value(s) are ' +
          stated.map((f) => f.value).join(" | "),
      );
      return;
    }
    record(
      result,
      kind,
      raw,
      c.status,
      c.status === "resolved"
        ? c.detail
        : label + " is neither a compiled fixed value nor a UUID the spec states structurally",
      { ...EXT, provenance: c.provenance, ...(c.conflict ? { conflict: c.conflict } : {}) },
    );
    if (c.conflict) {
      mismatch(
        result,
        "error",
        "xds-uuid-conflict",
        label +
          ' is "' +
          raw +
          '" — the compiled spec records this as a CONFLICT that must not be auto-corrected: ' +
          (c.conflict.action || "flag for a human") +
          " (IHE standard value " +
          (c.conflict.iheStandardValue || "?") +
          ")",
      );
    }
  };

  /* ---- localised name / description under each RegistryObject -------- */
  const localisedText = (parent, childLocal) => {
    const holder = parent.children.find((c) => c.local === childLocal);
    if (!holder) return null;
    const ls = holder.children.find((c) => c.local === "LocalizedString");
    return ls ? { value: norm(ls.attrs.value), charset: ls.attrs.charset || null, lang: ls.attrs.lang || null } : { value: null };
  };

  for (const obj of objects) {
    /* identity attributes */
    uuidAttr(obj, "objectType", "xdsObjectType", obj.local + "/@objectType");
    uuidAttr(obj, "classificationNode", "xdsClassificationNode", obj.local + "/@classificationNode");

    if (obj.attrs.status) {
      const known =
        /^urn:oasis:names:tc:ebxml-regrep:StatusType:/.test(obj.attrs.status) ||
        spec.xdsNamesExact.has(norm(obj.attrs.status));
      record(
        result,
        "xdsObjectStatus",
        obj.attrs.status,
        known ? "resolved" : "unknown",
        known ? "ebRIM StatusType URN" : "status URN not recognised as an ebRIM StatusType and not in the compiled spec",
        { ...EXT, provenance: known ? "standard" : "none" },
      );
    }
    if (obj.local === "Association") uuidAttr(obj, "associationType", "xdsAssociationType", "Association/@associationType");

    /* the ebRIM ATTRIBUTE SLOTS: which metadata attribute does each
     * Classification / ExternalIdentifier actually carry? The compiled
     * fields/xds.json maps the scheme UUID to the attribute NAME, and those
     * rows come from Confluence — so this is an INDEPENDENT check even though
     * the surrounding element tree is sample-derived. */
    /* rim:Name on a <rim:Classification> is the DISPLAY NAME of the coded
     * value ("Primary Healthcare"), i.e. value-level content, which this gate
     * does not measure. On a <rim:ExternalIdentifier> it is the IHE-prescribed
     * metadata ATTRIBUTE NAME ("XDSDocumentEntry.patientId") — a structural
     * literal an HIS must emit exactly. Only the latter is recorded. */
    if (obj.local === "ExternalIdentifier") {
      const schemeUuid = String(obj.attrs.identificationScheme || "").toLowerCase();
      const scheme = schemeUuid ? spec.xdsSchemeByUuid.get(schemeUuid) : null;
      const nm = localisedText(obj, "Name");
      if (nm && nm.value) {
        const literal = nm.value;
        const tail = literal.includes(".") ? literal.slice(literal.lastIndexOf(".") + 1) : literal;
        if (spec.xdsNamesExact.has(literal)) {
          record(result, "xdsExternalIdentifierName", literal, "resolved", null, {
            ...EXT,
            provenance: spec.xdsNameDerivation.get(literal) || "unattributed",
          });
        } else if (scheme && scheme.label && squash(scheme.label) === squash(tail)) {
          /* The compiled spec names the attribute by its BARE form; the samples
           * (and IHE ITI TF-3) emit the object-qualified form. An HIS that emits
           * the compiled literal verbatim would be emitting the wrong name. */
          record(
            result,
            "xdsExternalIdentifierName",
            literal,
            "normalised",
            'the compiled spec names this attribute "' +
              scheme.label +
              '" (bare); the official samples emit the IHE object-qualified form "' +
              literal +
              '". The qualified literal is never stated in the compiled spec',
            { ...EXT, provenance: scheme.derivation },
          );
          mismatch(
            result,
            "warn",
            "xds-externalidentifier-name-unqualified",
            'rim:ExternalIdentifier for scheme ' + schemeUuid + ' must carry rim:Name "' + literal +
              '", but the compiled spec records the attribute only as "' + scheme.label + '"',
          );
        } else {
          record(
            result,
            "xdsExternalIdentifierName",
            literal,
            "unknown",
            "no compiled XDS metadata attribute matches this ExternalIdentifier name" +
              (scheme ? ' (scheme ' + schemeUuid + ' is compiled as "' + scheme.label + '")' : ""),
            { ...EXT, provenance: "none" },
          );
        }
      }
      if (!obj.attrs.value) {
        mismatch(result, "error", "ebrim-externalidentifier-no-value", "<rim:ExternalIdentifier> has no @value attribute");
      }
    }

    const desc = localisedText(obj, "Description");
    if (desc && desc.value) {
      record(result, "xdsDescription", obj.local + "/Description", "resolved", "ebRIM InternationalString", {
        ...EXT,
        provenance: "standard",
      });
    }

    /* ---- referential integrity (ebRIM law) -------------------------- */
    /* An Association whose type is NOT HasMember deliberately points OUTSIDE
     * the submission: an RPLC targetObject is the entryUUID of the document
     * already in the registry that this submission replaces. Such a reference
     * is unresolvable within the message BY DESIGN and is not a defect. */
    const assocType = obj.local === "Association" ? norm(obj.attrs.associationType) : null;
    const pointsOutsideByDesign =
      obj.local === "Association" && assocType && !/(^|:)HasMember$/.test(assocType);

    for (const [attr, kind] of [
      ["classifiedObject", "xdsRef/classifiedObject"],
      ["registryObject", "xdsRef/registryObject"],
      ["sourceObject", "xdsRef/sourceObject"],
      ["targetObject", "xdsRef/targetObject"],
    ]) {
      const ref = norm(obj.attrs[attr]);
      if (!ref) continue;
      const external = pointsOutsideByDesign && attr === "targetObject";
      const ok = declaredIds.has(ref);
      if (external && !ok) {
        record(
          result,
          "xdsObjectReference",
          kind + " (external)",
          "resolved",
          "targetObject of a " + assocType + " association refers to an object already in the registry, not to this submission",
          { ...EXT, provenance: "standard" },
        );
        continue;
      }
      record(result, "xdsObjectReference", kind, ok ? "resolved" : "unknown", ok ? null : "dangling reference", {
        ...EXT,
        provenance: "standard",
      });
      if (!ok) {
        mismatch(
          result,
          "error",
          "ebrim-dangling-reference",
          "<" + obj.local + " " + attr + '="' + ref + '"> points at an id no RegistryObject in this message declares',
        );
      }
    }
  }

  /* ---- ebRIM child order inside each RegistryObject ----------------- *
   * ebRIM's own schema sequences RegistryObject children as
   * Slot*, Name?, Description?, Classification*, ExternalIdentifier*.
   * The official ITI-41 samples state this sequence in an inline comment.
   * Recorded as provenance "standard": it is the ebXML RegRep schema, not a
   * cached NPHIES page. */
  const ORDER = ["Slot", "Name", "Description", "VersionInfo", "Classification", "ExternalIdentifier"];
  for (const obj of objects) {
    if (obj.local !== "ExtrinsicObject" && obj.local !== "RegistryPackage") continue;
    let last = -1;
    let lastName = null;
    let inverted = null;
    for (const child of obj.children) {
      const idx = ORDER.indexOf(child.local);
      if (idx < 0) continue;
      if (idx < last && !inverted) inverted = { before: lastName, after: child.local };
      else if (idx >= last) {
        last = idx;
        lastName = child.local;
      }
    }
    record(
      result,
      "xdsEbrimChildOrder",
      obj.local,
      inverted ? "unknown" : "resolved",
      inverted
        ? "child <rim:" + inverted.after + "> appears after <rim:" + inverted.before + ">, which violates the ebRIM RegistryObject sequence " +
          ORDER.filter((o) => o !== "VersionInfo").join(" → ")
        : "children follow the ebRIM RegistryObject sequence",
      { ...EXT, provenance: "standard" },
    );
    if (inverted) {
      mismatch(
        result,
        "error",
        "ebrim-child-order",
        "<rim:" + obj.local + "> emits <rim:" + inverted.after + "> after <rim:" + inverted.before +
          ">; ebRIM sequences RegistryObject children as Slot*, Name?, Description?, Classification*, ExternalIdentifier*",
      );
    }
  }

  /* ---- ITI-41: xdsb:Document/@id SHALL match an ExtrinsicObject @id -- *
   * This one IS stated by the compiled structure's own notes. */
  const note = ((structure && structure.notes) || []).find((n) => /@id SHALL match the ExtrinsicObject @id/.test(n));
  if (note) {
    const extrinsicIds = new Set(objects.filter((o) => o.local === "ExtrinsicObject").map((o) => norm(o.attrs.id)));
    for (const node of walkXml(root)) {
      if (node.local !== "Document" || !node.attrs.id) continue;
      const ok = extrinsicIds.has(norm(node.attrs.id));
      record(result, "xdsDocumentIdBinding", node.attrs.id, ok ? "resolved" : "unknown", ok ? null : "no matching ExtrinsicObject @id", {
        ...EXT,
        provenance: "confluence",
      });
      if (!ok) {
        mismatch(
          result,
          "error",
          "xds-document-id-binding",
          '<xdsb:Document id="' + node.attrs.id + '"> does not match any ExtrinsicObject @id',
          { specQuote: note },
        );
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* EXTENDED: structures with NO official sample                         */
/* ------------------------------------------------------------------ */

/**
 * A structure no golden sample exercises cannot be RESOLVED against anything.
 * It can only be checked for INTERNAL CONSISTENCY. The result is reported in
 * its own section and is deliberately NOT folded into any resolution rate:
 * "internally consistent" is not "verified".
 */
function checkUnverifiedStructure(structure) {
  const findings = [];
  const add = (severity, code, message) => findings.push({ severity, code, message });
  const nodes = [...walkStructure(structure)];
  const env = structure.envelope || {};

  /* 1. root element agrees with the declared envelope root */
  const rootChild = structureMembers(structure.root)[0] || structure.root;
  const rootLabel = String(rootChild.label || structure.root.label || "").trim();
  if (env.rootElement && rootLabel && env.rootElement !== rootLabel) {
    add("error", "root-mismatch", 'envelope.rootElement is "' + env.rootElement + '" but the tree root is "' + rootLabel + '"');
  }

  /* 2. every namespace prefix used by a label is declared in the envelope */
  const declared = new Set((env.namespaces || []).map((n) => n.prefix));
  const usedPrefixes = new Map();
  for (const n of nodes) {
    const label = String(n.label || "");
    const m = label.match(/^@?xmlns:([A-Za-z_][\w.-]*)$/) || label.match(/^@?([A-Za-z_][\w.-]*):/);
    if (!m) continue;
    if (!usedPrefixes.has(m[1])) usedPrefixes.set(m[1], label);
  }
  for (const [prefix, example] of usedPrefixes) {
    if (!declared.has(prefix)) {
      add("error", "undeclared-prefix", 'prefix "' + prefix + ':" is used (e.g. ' + example + ") but envelope.namespaces does not declare it");
    }
  }
  const unusedPrefixes = [...declared].filter((p) => !usedPrefixes.has(p));
  if (unusedPrefixes.length) {
    add(
      "warn",
      "unused-prefix",
      "envelope.namespaces declares " + unusedPrefixes.join(", ") + " but no member label uses " +
        (unusedPrefixes.length === 1 ? "it" : "them") +
        " (they may still be needed by attribute VALUES such as xsi:type)",
    );
  }

  /* 3. every member carries provenance */
  const noProv = nodes.filter((n) => !(n.provenance && (n.provenance.pageId || n.provenance.sample || n.provenance.quote)));
  if (noProv.length) {
    add("error", "missing-provenance", noProv.length + " of " + nodes.length + " member(s) carry no provenance at all");
  }

  /* 4. attribute members must sit under an element member */
  for (const n of nodes) {
    if (!String(n.label || "").startsWith("@")) continue;
    const owner = nodes.find((p) => structureMembers(p).includes(n));
    if (!owner || String(owner.label || "").startsWith("@")) {
      add("error", "orphan-attribute", 'attribute member "' + n.label + '" is not a child of an element member');
    }
  }

  /* 5. usage cardinalities must be coherent */
  for (const n of nodes) {
    for (const u of n.usage || []) {
      if (u.min != null && u.max != null && u.max !== 0 && u.min > u.max) {
        add("error", "bad-cardinality", '"' + n.label + '" has min ' + u.min + " > max " + u.max);
      }
      if ((u.usage === "M" || u.usage === "R") && u.min === 0) {
        add("warn", "usage-vs-min", '"' + n.label + '" is usage ' + u.usage + " but min is 0");
      }
    }
  }

  /* 6. a declared signature level must correspond to a signature member */
  if (env.signatureLevel) {
    const sig = nodes.find((n) => /Signature$/.test(String(n.label || "")));
    if (!sig) {
      add("error", "signature-missing", 'envelope.signatureLevel is "' + env.signatureLevel + '" but no member is a Signature element');
    }
  }

  /* 7. duplicate sibling labels */
  for (const n of nodes) {
    const seen = new Set();
    for (const m of structureMembers(n)) {
      const l = String(m.label || "");
      if (seen.has(l)) add("warn", "duplicate-sibling", 'two children of "' + n.label + '" share the label "' + l + '"');
      seen.add(l);
    }
  }

  return {
    structureId: structure.id,
    family: structure.family,
    useCaseId: structure.useCaseId,
    confidence: structure.confidence,
    confidenceReason: structure.confidenceReason || null,
    verifiedAgainstSample: structure.verifiedAgainstSample === true,
    members: nodes.length,
    status: "UNVERIFIED — no official sample exists; internal consistency only",
    internallyConsistent: findings.filter((f) => f.severity === "error").length === 0,
    findings,
  };
}

/* ------------------------------------------------------------------ */
/* main                                                                 */
/* ------------------------------------------------------------------ */

function main() {
  const startedAt = new Date().toISOString();
  const spec = buildSpecIndex();
  const golden = readJson("spec-build/golden.json");
  const samples = golden.samples || [];

  const perSample = [];
  const skipped = [];

  for (const sample of samples) {
    const abs = path.join(ROOT, "spec-source", sample.path);
    if (!sample.isMessageSample) {
      skipped.push({
        path: sample.path,
        format: sample.format,
        reason: "not a message sample (" + sample.format + ")",
      });
      continue;
    }
    const text = readTextIfExists(abs);
    if (text == null) {
      perSample.push(
        finaliseResult(
          Object.assign(makeResult(sample, null, null), {
            structuralMismatches: [
              { severity: "blocker", code: "missing-file", message: "sample file not found on disk: " + sample.path },
            ],
          }),
        ),
      );
      continue;
    }
    let res;
    try {
      if (sample.format === "hl7v2") res = checkHl7(spec, sample, text);
      else if (sample.format === "cda") res = checkCda(spec, sample, text);
      else if (sample.format === "fhir") res = checkFhir(spec, sample, text);
      else if (sample.format === "soap-xds") res = checkSoap(spec, sample, text);
      else {
        skipped.push({ path: sample.path, format: sample.format, reason: "no checker for format " + sample.format });
        continue;
      }
    } catch (err) {
      // A measurement must never crash the run.
      res = finaliseResult(
        Object.assign(makeResult(sample, null, null), {
          structuralMismatches: [
            { severity: "blocker", code: "checker-crash", message: String((err && err.stack) || err) },
          ],
        }),
      );
    }
    perSample.push(res);
  }

  /* ---- aggregate ---------------------------------------------------- */
  const totals = { elementsFound: 0, elementsResolved: 0, elementsResolvedExact: 0, elementsResolvedNormalised: 0 };
  const extendedTotals = { elementsFound: 0, elementsResolved: 0, elementsUnknown: 0 };
  const byFormat = {};
  const unresolvedIndex = new Map();
  const unresolvedExtendedIndex = new Map();
  const mismatchIndex = new Map();
  const byKind = {};
  const byKindExtended = {};

  for (const r of perSample) {
    totals.elementsFound += r.elementsFound;
    totals.elementsResolved += r.elementsResolved;
    totals.elementsResolvedExact += r.elementsResolvedExact;
    totals.elementsResolvedNormalised += r.elementsResolvedNormalised;
    extendedTotals.elementsFound += (r.extended || {}).elementsFound || 0;
    extendedTotals.elementsResolved += (r.extended || {}).elementsResolved || 0;
    extendedTotals.elementsUnknown += (r.extended || {}).elementsUnknown || 0;

    const f = (byFormat[r.format] = byFormat[r.format] || {
      samples: 0,
      elementsFound: 0,
      elementsResolved: 0,
      elementsResolvedNormalised: 0,
      elementsUnknown: 0,
      samplesWithoutStructure: 0,
      structuralMismatches: 0,
      byProvenance: {},
      extendedFound: 0,
      extendedResolved: 0,
    });
    f.samples++;
    f.elementsFound += r.elementsFound;
    f.elementsResolved += r.elementsResolved;
    f.elementsResolvedNormalised += r.elementsResolvedNormalised;
    f.elementsUnknown += r.elementsUnknownCount;
    f.structuralMismatches += r.structuralMismatches.length;
    f.extendedFound += (r.extended || {}).elementsFound || 0;
    f.extendedResolved += (r.extended || {}).elementsResolved || 0;
    if (!r.structureId) f.samplesWithoutStructure++;
    for (const [prov, pt] of Object.entries(r.provenanceTotals || {})) {
      const agg = (f.byProvenance[prov] = f.byProvenance[prov] || { found: 0, resolved: 0 });
      agg.found += pt.found;
      agg.resolved += pt.resolved;
    }
    for (const [kind, kp] of Object.entries(r.kindProvenance || {})) {
      f.byKindProvenance = f.byKindProvenance || {};
      const agg = (f.byKindProvenance[kind] = f.byKindProvenance[kind] || {});
      for (const [prov, n] of Object.entries(kp)) agg[prov] = (agg[prov] || 0) + n;
    }

    for (const [kind, kt] of Object.entries(r.kindTotals || {})) {
      const agg = (byKind[kind] = byKind[kind] || { found: 0, resolved: 0, unknown: 0 });
      agg.found += kt.found;
      agg.resolved += kt.resolved;
      agg.unknown += kt.unknown;
    }
    for (const [kind, kt] of Object.entries(r.kindTotalsExtended || {})) {
      const agg = (byKindExtended[kind] = byKindExtended[kind] || { found: 0, resolved: 0, unknown: 0 });
      agg.found += kt.found;
      agg.resolved += kt.resolved;
      agg.unknown += kt.unknown;
    }
    for (const u of r.elementsUnknownExtended || []) {
      const key = u.kind + "::" + u.id;
      let agg = unresolvedExtendedIndex.get(key);
      if (!agg) {
        agg = { kind: u.kind, identifier: u.id, samples: 0, occurrences: 0, reason: u.reason, formats: new Set(), exampleSamples: [] };
        unresolvedExtendedIndex.set(key, agg);
      }
      agg.samples++;
      agg.occurrences += u.occurrences;
      agg.formats.add(r.format);
      if (agg.exampleSamples.length < 3) agg.exampleSamples.push(r.fileName);
    }

    for (const u of r.elementsUnknown) {
      const key = u.kind + "::" + u.id;
      let agg = unresolvedIndex.get(key);
      if (!agg) {
        agg = { kind: u.kind, identifier: u.id, samples: 0, occurrences: 0, reason: u.reason, formats: new Set(), exampleSamples: [] };
        unresolvedIndex.set(key, agg);
      }
      agg.samples++;
      agg.occurrences += u.occurrences;
      agg.formats.add(r.format);
      if (agg.exampleSamples.length < 3) agg.exampleSamples.push(r.fileName);
    }
    for (const m of r.structuralMismatches) {
      const key = m.severity + "::" + m.code;
      let agg = mismatchIndex.get(key);
      if (!agg) {
        agg = { severity: m.severity, code: m.code, count: 0, samples: 0, examples: [] };
        mismatchIndex.set(key, agg);
      }
      agg.count++;
      if (agg.examples.length < 3) agg.examples.push({ sample: r.fileName, message: m.message });
    }
  }

  for (const f of Object.values(byFormat)) {
    f.resolutionRate = f.elementsFound ? Number((f.elementsResolved / f.elementsFound).toFixed(4)) : 0;
    /* ---- INDEPENDENCE: how much resolves against a rule that did NOT come
     * from the golden samples themselves --------------------------------- */
    let indResolved = 0;
    let circResolved = 0;
    let unattributed = 0;
    let prose = 0;
    for (const [prov, pt] of Object.entries(f.byProvenance)) {
      if (INDEPENDENT_PROVENANCE.has(prov)) indResolved += pt.resolved;
      else if (prov === "sample") circResolved += pt.resolved;
      else if (prov === "prose-mention") prose += pt.resolved;
      else if (prov === "unattributed") unattributed += pt.resolved;
    }
    const tagged = indResolved + circResolved + prose;
    f.independent = tagged
      ? {
          provenanceTracked: true,
          resolvedByIndependentRule: indResolved,
          resolvedBySampleDerivedRule: circResolved,
          resolvedByProseMentionOnly: prose,
          resolvedByUnattributedRule: unattributed,
          independentResolutionRate: f.elementsFound ? Number((indResolved / f.elementsFound).toFixed(4)) : 0,
        }
      : {
          provenanceTracked: false,
          note:
            "This pass tags rule provenance for SOAP/XDS only, because that is where sample-derived structures live. " +
            "The " +
            "CDA, FHIR and HL7 v2 trees are compiled from Confluence tables rather than from the samples, so they are not " +
            "circular in the same way — but this gate has NOT proved that per rule. Read no independence figure into this format.",
          resolvedByUnattributedRule: unattributed,
        };
  }
  for (const k of Object.values(byKind)) {
    k.resolutionRate = k.found ? Number((k.resolved / k.found).toFixed(4)) : 0;
  }

  for (const k of Object.values(byKindExtended)) {
    k.resolutionRate = k.found ? Number((k.resolved / k.found).toFixed(4)) : 0;
  }

  const topUnresolved = [...unresolvedIndex.values()]
    .map((a) => ({ ...a, formats: [...a.formats].sort() }))
    .sort((a, b) => b.samples - a.samples || b.occurrences - a.occurrences || a.identifier.localeCompare(b.identifier));
  const topUnresolvedExtended = [...unresolvedExtendedIndex.values()]
    .map((a) => ({ ...a, formats: [...a.formats].sort() }))
    .sort((a, b) => b.samples - a.samples || b.occurrences - a.occurrences || a.identifier.localeCompare(b.identifier));

  /* ---- structures no golden sample exercises ------------------------- */
  const sampledUseCaseIds = new Set(perSample.map((r) => r.useCaseId));
  const unverifiedStructures = Object.values(spec.structures)
    .filter((s) => !sampledUseCaseIds.has(s.useCaseId))
    .map(checkUnverifiedStructure)
    .sort((a, b) => a.structureId.localeCompare(b.structureId));

  /* ---- blockers ------------------------------------------------------ */
  const blockers = [];
  const push = (severity, area, title, detail, evidence) =>
    blockers.push({ severity, area, title, detail, ...(evidence ? { evidence } : {}) });

  const noStructure = perSample.filter((r) => !r.structureId);
  if (noStructure.length) {
    push(
      "blocker",
      "coverage",
      noStructure.length + " official sample(s) resolve to NO compiled MessageStructure",
      "These samples cannot be validated at all: " + noStructure.map((r) => r.fileName + " (" + r.useCaseId + ")").join("; "),
    );
  }

  const declaredUseCases = new Set(Object.values(spec.structures).map((s) => s.useCaseId));
  const goldenUseCases = golden.useCaseIds || [];
  const useCasesWithoutStructure = goldenUseCases.filter((u) => !declaredUseCases.has(u));
  if (useCasesWithoutStructure.length) {
    push(
      "error",
      "coverage",
      useCasesWithoutStructure.length + " use case(s) named by golden.json have NO compiled MessageStructure at all",
      useCasesWithoutStructure.join(", ") + " — nothing in src/spec/structures.json carries these useCaseIds",
    );
  }
  const sampledUseCases = new Set(perSample.map((r) => r.useCaseId));
  const unexercised = [...declaredUseCases].filter((u) => u && !sampledUseCases.has(u)).sort();
  if (unexercised.length) {
    push(
      "warn",
      "coverage",
      unexercised.length + " compiled use case(s) have NO official sample and are therefore unverified by this gate",
      unexercised.join(", "),
    );
  }

  for (const agg of [...mismatchIndex.values()].sort((a, b) => b.count - a.count)) {
    if (agg.severity !== "error" && agg.severity !== "blocker") continue;
    push(
      agg.severity,
      "structure",
      agg.code + " × " + agg.count,
      agg.examples.map((e) => e.sample + ": " + e.message).join(" | "),
    );
  }

  const normalisedTotal = totals.elementsResolvedNormalised;
  if (normalisedTotal) {
    const byKind = new Map();
    for (const r of perSample)
      for (const nm of r.normalisedMatches) {
        if (!byKind.has(nm.kind)) byKind.set(nm.kind, new Set());
        byKind.get(nm.kind).add(nm.id + " → " + nm.matchedSpecLiteral);
      }
    push(
      "error",
      "extraction",
      normalisedTotal +
        " identifier(s) match the compiled spec only AFTER normalisation — the stored literal is mangled",
      [...byKind.entries()]
        .map(([k, v]) => k + ": " + [...v].slice(0, 6).join("; ") + (v.size > 6 ? " (+" + (v.size - 6) + " more)" : ""))
        .join(" || "),
    );
  }

  const emptyStructures = [];
  for (const id of new Set(perSample.map((r) => r.structureId).filter(Boolean))) {
    const s = spec.structures[id];
    const counts = { section: 0, entry: 0, segment: 0, element: 0 };
    for (const m of walkStructure(s)) if (counts[m.kind] !== undefined) counts[m.kind]++;
    if (s.family === "cda" && counts.section === 0) emptyStructures.push({ id, family: s.family, confidence: s.confidence, counts });
    else if (s.family === "fhir" && counts.entry === 0) emptyStructures.push({ id, family: s.family, confidence: s.confidence, counts });
    else if (s.family === "hl7v2" && counts.segment === 0) emptyStructures.push({ id, family: s.family, confidence: s.confidence, counts });
  }
  if (emptyStructures.length) {
    push(
      "blocker",
      "coverage",
      emptyStructures.length + " compiled structure(s) exercised by an official sample contain NO body members at all",
      emptyStructures
        .map((e) => e.id + " (confidence " + e.confidence + ", sections " + e.counts.section + ", entries " + e.counts.entry + ", segments " + e.counts.segment + ")")
        .join("; ") + " — every element of those samples is necessarily unresolved",
    );
  }

  const schemeKinds = ["xdsClassificationScheme", "xdsIdentificationScheme"];
  const schemeTotals = schemeKinds
    .map((k) => byKind[k])
    .filter(Boolean)
    .reduce((acc, k) => ({ found: acc.found + k.found, resolved: acc.resolved + k.resolved }), { found: 0, resolved: 0 });
  if (schemeTotals.found && schemeTotals.resolved === 0) {
    push(
      "error",
      "coverage",
      "the compiled spec knows ZERO of the XDS classificationScheme / identificationScheme UUIDs the official SOAP samples carry",
      schemeTotals.found +
        " occurrences across the ITI-41/18/43 samples resolve to nothing. fields/xds.json captures the metadata attribute NAMES (classCode, authorPerson, uniqueId, ...) but never the UUID that identifies each one in the ebXML payload, and a classification/identification scheme UUID is a fixed structural value — a message cannot be built or checked without it.",
    );
  }

  /* ---- CIRCULARITY, QUANTIFIED -------------------------------------- *
   * The SOAP/XDS structures are partly derived from the very samples this
   * gate measures them against. A resolution rate computed over those rules
   * is self-confirming. This block reports both numbers and states plainly
   * which one is honest. */
  const soap = byFormat["soap-xds"];
  const circularStructures = [...new Set(perSample.filter((r) => r.format === "soap-xds").map((r) => r.structureId))]
    .filter(Boolean)
    .map((id) => {
      const s = spec.structures[id] || {};
      const counts = { confluence: 0, "confluence+sample": 0, sample: 0, standard: 0, unattributed: 0 };
      for (const m of walkStructure(s)) {
        const p = memberProvenance(m);
        counts[p] = (counts[p] || 0) + 1;
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return {
        structureId: id,
        members: total,
        byProvenance: counts,
        sampleDerivedShare: total ? Number((counts.sample / total).toFixed(4)) : 0,
        envelopeDerivedFrom: (s.envelope || {}).derivedFrom || null,
        selfDeclaredCircular: ((s.notes || []).find((n) => /not independent confirmation/i.test(n)) || null),
      };
    })
    .sort((a, b) => b.sampleDerivedShare - a.sampleDerivedShare);

  const independence = soap
    ? {
        headline:
          "SOAP/XDS resolves " +
          (soap.resolutionRate * 100).toFixed(1) +
          "% overall, but only " +
          (soap.independent.independentResolutionRate * 100).toFixed(1) +
          "% against rules that did NOT come from these same samples. The second number is the honest one.",
        format: "soap-xds",
        elementsFound: soap.elementsFound,
        resolvedOverall: soap.elementsResolved,
        resolutionRateOverall: soap.resolutionRate,
        resolvedByIndependentRule: soap.independent.resolvedByIndependentRule,
        independentResolutionRate: soap.independent.independentResolutionRate,
        breakdown: soap.byProvenance,
        byElementKind: Object.fromEntries(
          Object.entries(soap.byKindProvenance || {}).map(([kind, counts]) => {
            const total = Object.values(counts).reduce((a, b) => a + b, 0);
            const ind = Object.entries(counts)
              .filter(([p]) => INDEPENDENT_PROVENANCE.has(p))
              .reduce((a, [, n]) => a + n, 0);
            return [
              kind,
              {
                found: total,
                independent: ind,
                circular: counts.sample || 0,
                proseMentionOnly: counts["prose-mention"] || 0,
                unattributed: counts.unattributed || 0,
                independentShare: total ? Number((ind / total).toFixed(4)) : 0,
              },
            ];
          }).sort((a, b) => a[1].independentShare - b[1].independentShare),
        ),
        provenanceMeaning: {
          confluence: "INDEPENDENT — a cached Confluence page states it",
          "confluence+sample": "INDEPENDENT — a Confluence row, confirmed against a sample",
          standard: "INDEPENDENT of the samples — published IHE/ebRIM/HL7 constant, but NOT NPHIES-confirmed",
          sample: "CIRCULAR — the rule was read off a golden sample, so resolving that sample proves nothing",
          "prose-mention": "WEAKEST — the literal appears only inside narrative text in the bundle, never as a locator or fixed value",
          unattributed: "the compiled member carries no provenance at all — treat as unverified",
        },
        perStructure: circularStructures,
        alsoAppliesTo:
          "The same reasoning applies to every format, but only SOAP/XDS has sample-derived structural members; the CDA, FHIR and HL7 v2 trees come from Confluence tables.",
      }
    : null;

  /* this one leads the blocker list: it qualifies every SOAP number above it */
  const pushFirst = (severity, area, title, detail) => blockers.unshift({ severity, area, title, detail });
  if (soap && soap.independent.resolvedBySampleDerivedRule) {
    pushFirst(
      "blocker",
      "methodology",
      "CIRCULARITY: " +
        soap.independent.resolvedBySampleDerivedRule +
        " of " +
        soap.elementsFound +
        " SOAP/XDS identifiers (" +
        ((soap.independent.resolvedBySampleDerivedRule / soap.elementsFound) * 100).toFixed(1) +
        "%) resolve ONLY against rules derived from these same golden samples",
      "SOAP/XDS reads " +
        (soap.resolutionRate * 100).toFixed(1) +
        "% overall but " +
        (soap.independent.independentResolutionRate * 100).toFixed(1) +
        "% against independently-sourced rules. " +
        circularStructures
          .filter((c) => c.byProvenance.sample)
          .map((c) => c.structureId + " (" + c.byProvenance.sample + "/" + c.members + " members sample-derived)")
          .join(", ") +
        ". The compiled structures say so themselves in envelope.derivedFrom and in their notes. Do not quote the overall SOAP figure as evidence that the spec is right.",
    );
  }
  if (soap && soap.independent.resolvedByProseMentionOnly) {
    push(
      "error",
      "methodology",
      soap.independent.resolvedByProseMentionOnly +
        " SOAP/XDS identifier(s) are counted resolved only because the literal appears inside NARRATIVE TEXT in the compiled bundle",
      "The baseline gate matched UUIDs by regexing whole JSON blobs, so a UUID quoted inside a provenance quote, a guidance sentence or a confidenceReason counted as spec knowledge. A validator cannot act on a UUID that is not a locator or a fixed value. These are now labelled provenance \"prose-mention\".",
    );
  }

  /* ---- recommendations ---------------------------------------------- */
  const recommendations = [];
  const recFrom = (list, n) => list.slice(0, n);
  const worstFormats = Object.entries(byFormat).sort((a, b) => a[1].resolutionRate - b[1].resolutionRate);
  for (const [fmt, f] of worstFormats) {
    if (f.resolutionRate >= 0.95) continue;
    recommendations.push({
      priority: recommendations.length + 1,
      area: fmt,
      action:
        "Raise " + fmt + " resolution (" + Math.round(f.resolutionRate * 1000) / 10 + "% of " + f.elementsFound +
        " distinct identifiers). " + f.elementsUnknown + " unresolved.",
      firstTargets: recFrom(
        topUnresolved.filter((u) => u.formats.includes(fmt)).map((u) => u.kind + " " + u.identifier + " (" + u.samples + " samples)"),
        8,
      ),
    });
  }
  if (normalisedTotal) {
    recommendations.push({
      priority: recommendations.length + 1,
      area: "extraction",
      action:
        "Fix the mangled literals in the compiled spec (injected spaces / trailing footnote digits / case). " +
        "A validator that matches on the stored literal will reject every one of these official values.",
      firstTargets: [...new Set(perSample.flatMap((r) => r.normalisedMatches.map((n) => n.id)))].slice(0, 10),
    });
  }
  const phantom = [...mismatchIndex.values()].find((m) => m.code === "phantom-resource-type");
  if (phantom) {
    recommendations.push({
      priority: recommendations.length + 1,
      area: "fhir",
      action:
        "Compiled FHIR entry rows carry profile names in the resourceType slot. Re-derive entry.resourceType from the row's profile URL / guidance rather than the row label.",
      firstTargets: phantom.examples.map((e) => e.message),
    });
  }
  if (schemeTotals.found && schemeTotals.resolved === 0) {
    recommendations.push({
      priority: recommendations.length + 1,
      area: "xds",
      action:
        "Capture the classificationScheme / identificationScheme UUID alongside every XDS metadata attribute in fields/xds.json. Without it the compiled XDS metadata cannot be matched to, or emitted into, a real ebXML RegistryObjectList.",
      firstTargets: [...unresolvedIndex.values()]
        .filter((u) => schemeKinds.includes(u.kind))
        .sort((a, b) => b.samples - a.samples)
        .slice(0, 12)
        .map((u) => u.kind + " " + u.identifier + " (" + u.samples + " samples)"),
    });
  }
  if (emptyStructures.length) {
    recommendations.push({
      priority: recommendations.length + 1,
      area: "structures",
      action: "These compiled structures have an empty body and cannot validate anything; re-extract their section/entry tables.",
      firstTargets: emptyStructures.map((e) => e.id + " (confidence " + e.confidence + ")"),
    });
  }
  if (unexercised.length) {
    recommendations.push({
      priority: recommendations.length + 1,
      area: "coverage",
      action: "No golden sample exercises these compiled use cases; their structures rest on Confluence text alone.",
      firstTargets: unexercised,
    });
  }

  const fixedValueless = [...mismatchIndex.values()].find((m) => m.code === "xds-fixedvalue-without-value");
  if (fixedValueless) {
    recommendations.push({
      priority: recommendations.length + 1,
      area: "xds",
      action:
        "rim:Association/@associationType compiles to three fixedValue rows that each carry a `meaning`, an `observedInSamples` count and a Confluence quote — but no `value`. The literal was dropped during compilation, so the compiled spec cannot confirm or reject the associationType an HIS emits, even though its confidenceReason discusses the HasMember bare-token-vs-URN conflict in detail. Re-extract the value column from page 17694743.",
      firstTargets: fixedValueless.examples.map((e) => e.message),
    });
  }
  const unqualified = [...mismatchIndex.values()].find((m) => m.code === "xds-externalidentifier-name-unqualified");
  if (unqualified) {
    recommendations.push({
      priority: recommendations.length + 1,
      area: "xds",
      action:
        "Every rim:ExternalIdentifier must carry the IHE object-qualified metadata name (XDSDocumentEntry.patientId, XDSSubmissionSet.sourceId, ...). The compiled spec stores only the bare attribute name (patientId, sourceId) as a locator; the qualified literal appears only inside guidance prose. An HIS generating rim:Name from the compiled label would emit the wrong name in every submission.",
      firstTargets: unqualified.examples.map((e) => e.message),
    });
  }
  if (soap && soap.independent.resolvedBySampleDerivedRule) {
    recommendations.push({
      priority: recommendations.length + 1,
      area: "methodology",
      action:
        "Reduce SOAP/XDS circularity: " +
        circularStructures
          .filter((c) => c.byProvenance.sample)
          .map((c) => c.structureId + " " + c.byProvenance.sample + "/" + c.members)
          .join(", ") +
        " members are sample-derived. Until those members are traced to a cached Confluence page, the honest SOAP number is " +
        (soap.independent.independentResolutionRate * 100).toFixed(1) +
        "%, not " +
        (soap.resolutionRate * 100).toFixed(1) +
        "%. soapPath is the worst kind at " +
        ((independence.byElementKind.soapPath || { independentShare: 0 }).independentShare * 100).toFixed(1) +
        "% independent.",
      firstTargets: circularStructures.filter((c) => c.byProvenance.sample).map((c) => c.structureId),
    });
  }

  const report = {
    $schema: "nphies-workbench/gate-report@1",
    generatedAt: startedAt,
    generator: "scripts/gate-golden.mjs",
    what: "Resolution gate: every structural element present in an OFFICIAL NPHIES sample must be KNOWN to the compiled spec in src/spec/. Unresolved identifiers mean the compiled spec is incomplete, not that the sample is wrong.",
    method: {
      elementsFound: "distinct structural identifiers per sample (segments, populated fields, templateIds, sections, bundle entry resourceTypes, profile URLs, SOAP element paths, XDS metadata attribute names)",
      elementsResolved: "exact matches + matches that required normalising a mangled spec literal",
      normalisedMatch: "the identifier exists in the compiled spec but only after stripping injected whitespace, trailing footnote digits or case differences — counted as resolved, reported as an extraction defect",
      structuralMismatch: "the element resolves but contradicts a compiled rule (order, usage X/NP, fixed value, bundle type, entry list membership)",
      notMeasured: "value-level conformance (code systems, value sets, datatypes, lengths) is out of scope for this gate",
      scope:
        "`overall` and `byFormat` count ONLY baseline-scope elements — the same identifiers the previous run counted — so the figures are directly comparable. Checks added by this pass are scope \"extended\" and are counted in `overallExtended` and `byElementKindExtended`.",
      independence:
        "Every resolved identifier is tagged with the PROVENANCE of the compiled rule that resolved it. A rule derived from a golden sample cannot confirm that same sample; see the `independence` section.",
    },
    overall: {
      samples: perSample.length,
      samplesSkipped: skipped.length,
      samplesWithStructure: perSample.filter((r) => r.structureId).length,
      samplesWithoutStructure: noStructure.length,
      elementsFound: totals.elementsFound,
      resolved: totals.elementsResolved,
      resolvedExact: totals.elementsResolvedExact,
      resolvedOnlyAfterNormalisation: totals.elementsResolvedNormalised,
      unresolved: totals.elementsFound - totals.elementsResolved,
      resolutionRate: totals.elementsFound
        ? Number((totals.elementsResolved / totals.elementsFound).toFixed(4))
        : 0,
      resolutionRateExact: totals.elementsFound
        ? Number((totals.elementsResolvedExact / totals.elementsFound).toFixed(4))
        : 0,
      distinctUnresolvedIdentifiers: topUnresolved.length,
      structuralMismatches: perSample.reduce(
        (n, r) => n + r.structuralMismatches.filter((m) => m.scope !== "extended").length,
        0,
      ),
      structuralMismatchesIncludingExtendedChecks: perSample.reduce((n, r) => n + r.structuralMismatches.length, 0),
      samplesFullyResolved: perSample.filter((r) => r.elementsUnknownCount === 0).length,
    },
    independence,
    overallExtended: {
      note:
        "baseline identifiers PLUS the checks this pass added (ebRIM content model, CDA header order, FHIR two-family rule). Not comparable with the previous run — compare `overall` for that.",
      elementsFound: totals.elementsFound + extendedTotals.elementsFound,
      resolved: totals.elementsResolved + extendedTotals.elementsResolved,
      unresolved:
        totals.elementsFound - totals.elementsResolved + extendedTotals.elementsUnknown,
      resolutionRate:
        totals.elementsFound + extendedTotals.elementsFound
          ? Number(
              ((totals.elementsResolved + extendedTotals.elementsResolved) /
                (totals.elementsFound + extendedTotals.elementsFound)).toFixed(4),
            )
          : 0,
      addedByThisPass: {
        elementsFound: extendedTotals.elementsFound,
        resolved: extendedTotals.elementsResolved,
        unresolved: extendedTotals.elementsUnknown,
        resolutionRate: extendedTotals.elementsFound
          ? Number((extendedTotals.elementsResolved / extendedTotals.elementsFound).toFixed(4))
          : 0,
      },
    },
    coverageExtensions: [
      {
        area: "soap-xds",
        check: "ebRIM content model inside RegistryObjectList",
        what:
          "@objectType, @classificationNode, @status, @associationType, the rim:Name of every Classification/ExternalIdentifier, rim:Description, referential integrity of classifiedObject/registryObject/sourceObject/targetObject, ebRIM child sequence, and the ITI-41 Document@id ↔ ExtrinsicObject@id binding",
        wasPreviouslyBlind: "the baseline gate saw only element PATHS and Slot names; none of the ebRIM identity attributes were checked",
        kinds: ["xdsObjectType", "xdsClassificationNode", "xdsObjectStatus", "xdsAssociationType", "xdsMetadataAttributeName", "xdsDescription", "xdsObjectReference", "xdsEbrimChildOrder", "xdsDocumentIdBinding"],
      },
      {
        area: "cda",
        check: "ClinicalDocument header element ORDER",
        what:
          "the sample's header children are checked against the ORDERED member list of the compiled \"ClinicalDocument header (document order)\" group, and any header element the compiled sequence does not place is reported as unsequenced",
        wasPreviouslyBlind: "the baseline gate only asked whether each header element NAME was known somewhere in the spec",
        kinds: ["cdaHeaderOrder"],
      },
      {
        area: "fhir",
        check: "two-family rule (Bundle.type + first entry) per sample",
        what:
          "document family = Bundle.type \"document\" opening with a Composition; message family = Bundle.type \"message\" opening with a MessageHeader. Checked as one fact per sample, including whether the COMPILED pair is itself self-consistent",
        wasPreviouslyBlind:
          "the baseline gate raised two independent mismatches and silently checked nothing when the compiled structure lacked either rule",
        kinds: ["fhirTwoFamilyRule"],
      },
      {
        area: "saml",
        check: "internal consistency of structures with no golden sample",
        what: "reported in `unverifiedStructures`; deliberately NOT counted as resolution — internally consistent is not verified",
        wasPreviouslyBlind: "saml-sso was invisible to the gate entirely",
        kinds: [],
      },
    ],
    unverifiedStructures,
    byFormat,
    byElementKind: Object.fromEntries(
      Object.entries(byKind).sort((a, b) => a[1].resolutionRate - b[1].resolutionRate),
    ),
    byElementKindExtended: Object.fromEntries(
      Object.entries(byKindExtended).sort((a, b) => a[1].resolutionRate - b[1].resolutionRate),
    ),
    perSample: perSample.sort((a, b) => a.resolutionRate - b.resolutionRate),
    topUnresolved: topUnresolved.slice(0, 120),
    topUnresolvedTruncated: Math.max(0, topUnresolved.length - 120),
    topUnresolvedExtended: topUnresolvedExtended.slice(0, 120),
    mismatchSummary: [...mismatchIndex.values()].sort((a, b) => b.count - a.count),
    blockers,
    recommendations,
    skipped,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");

  /* ---- console summary ---------------------------------------------- */
  const o = report.overall;
  process.stdout.write(
    "\nGOLDEN RESOLUTION GATE\n" +
      "  samples measured      " + o.samples + " (" + o.samplesSkipped + " skipped, non-message)\n" +
      "  distinct identifiers  " + o.elementsFound + "\n" +
      "  resolved              " + o.resolved + "  (" + (o.resolutionRate * 100).toFixed(1) + "%)\n" +
      "    exact               " + o.resolvedExact + "  (" + (o.resolutionRateExact * 100).toFixed(1) + "%)\n" +
      "    after normalisation " + o.resolvedOnlyAfterNormalisation + "\n" +
      "  UNRESOLVED            " + o.unresolved + "  (" + o.distinctUnresolvedIdentifiers + " distinct)\n" +
      "  structural mismatches " + o.structuralMismatches + "  (baseline checks; " +
      o.structuralMismatchesIncludingExtendedChecks + " including this pass's new checks)\n" +
      "  fully resolved samples " + o.samplesFullyResolved + "/" + o.samples + "\n\n",
  );
  for (const [fmt, f] of Object.entries(byFormat).sort((a, b) => a[1].resolutionRate - b[1].resolutionRate)) {
    process.stdout.write(
      "  " + fmt.padEnd(10) + " " + String(f.samples).padStart(2) + " samples  " +
        (f.resolutionRate * 100).toFixed(1).padStart(5) + "%  " +
        String(f.elementsResolved).padStart(5) + "/" + String(f.elementsFound).padEnd(5) +
        "  unresolved " + f.elementsUnknown + "\n",
    );
  }
  process.stdout.write("\n  BY ELEMENT KIND\n");
  for (const [kind, k] of Object.entries(report.byElementKind)) {
    process.stdout.write(
      "  " + kind.padEnd(26) + (k.resolutionRate * 100).toFixed(1).padStart(6) + "%  " +
        String(k.resolved).padStart(5) + "/" + String(k.found).padEnd(5) + "\n",
    );
  }
  process.stdout.write("\n  TOP UNRESOLVED\n");
  for (const u of topUnresolved.slice(0, 15)) {
    process.stdout.write(
      "    " + String(u.samples).padStart(2) + " samples  " + u.kind + "  " + u.identifier + "\n",
    );
  }

  if (independence) {
    process.stdout.write(
      "\n  INDEPENDENCE (soap-xds) — the honest number\n" +
        "    overall resolution            " + (independence.resolutionRateOverall * 100).toFixed(1) + "%  " +
        independence.resolvedOverall + "/" + independence.elementsFound + "\n" +
        "    INDEPENDENTLY-SOURCED ONLY    " + (independence.independentResolutionRate * 100).toFixed(1) + "%  " +
        independence.resolvedByIndependentRule + "/" + independence.elementsFound + "\n",
    );
    for (const [prov, pt] of Object.entries(independence.breakdown).sort((a, b) => b[1].found - a[1].found)) {
      process.stdout.write("      " + prov.padEnd(20) + String(pt.resolved).padStart(5) + "/" + String(pt.found).padEnd(5) + "\n");
    }
    process.stdout.write("    by element kind (independent share)\n");
    for (const [kind, k] of Object.entries(independence.byElementKind)) {
      process.stdout.write(
        "      " + kind.padEnd(26) + (k.independentShare * 100).toFixed(1).padStart(6) + "%   independent " +
          String(k.independent).padStart(4) + "  circular " + String(k.circular).padStart(4) +
          "  of " + k.found + "\n",
      );
    }
  }

  const ext = report.overallExtended;
  process.stdout.write(
    "\n  EXTENDED COVERAGE ADDED BY THIS PASS\n" +
      "    new identifiers       " + ext.addedByThisPass.elementsFound + "\n" +
      "    resolved              " + ext.addedByThisPass.resolved +
      "  (" + (ext.addedByThisPass.resolutionRate * 100).toFixed(1) + "%)\n" +
      "    unresolved            " + ext.addedByThisPass.unresolved + "\n" +
      "    baseline + extended   " + (ext.resolutionRate * 100).toFixed(1) + "%  " + ext.resolved + "/" + ext.elementsFound + "\n",
  );
  for (const [kind, k] of Object.entries(report.byElementKindExtended)) {
    process.stdout.write(
      "      " + kind.padEnd(26) + (k.resolutionRate * 100).toFixed(1).padStart(6) + "%  " +
        String(k.resolved).padStart(4) + "/" + String(k.found).padEnd(4) + "\n",
    );
  }
  if (topUnresolvedExtended.length) {
    process.stdout.write("\n    TOP UNRESOLVED (extended checks)\n");
    for (const u of topUnresolvedExtended.slice(0, 10)) {
      process.stdout.write("      " + String(u.samples).padStart(2) + " samples  " + u.kind + "  " + u.identifier + "\n");
    }
  }

  if (unverifiedStructures.length) {
    process.stdout.write("\n  UNVERIFIED STRUCTURES (no official sample — NOT counted as passing)\n");
    for (const u of unverifiedStructures) {
      process.stdout.write(
        "    " + u.structureId.padEnd(22) + " members " + String(u.members).padStart(3) +
          "  internally " + (u.internallyConsistent ? "consistent" : "INCONSISTENT") +
          "  findings " + u.findings.length + "\n",
      );
      for (const f of u.findings.filter((x) => x.severity === "error").slice(0, 5)) {
        process.stdout.write("        ERROR " + f.code + ": " + f.message + "\n");
      }
    }
  }

  process.stdout.write("\n  wrote " + path.relative(ROOT, OUT_PATH) + "\n\n");
}

main();
