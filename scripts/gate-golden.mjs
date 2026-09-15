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
  const addXdsName = (literal) => {
    const lit = norm(literal);
    if (!lit) return;
    xdsNamesExact.add(lit);
    const key = squashFootnote(lit);
    if (!key) return;
    if (!xdsNames.has(key)) xdsNames.set(key, []);
    if (!xdsNames.get(key).includes(lit)) xdsNames.get(key).push(lit);
    const glued = squashGluedFootnote(lit);
    if (!glued) return;
    if (!xdsNamesGlued.has(glued)) xdsNamesGlued.set(glued, []);
    if (!xdsNamesGlued.get(glued).includes(lit)) xdsNamesGlued.get(glued).push(lit);
  };
  const collectXds = (node) => {
    const loc = node.locator;
    if (loc && loc.kind === "xdsSlot" && loc.name) addXdsName(loc.name);
    if (node.label) addXdsName(String(node.label).split("\n")[0]);
    for (const c of node.children || []) collectXds(c);
  };
  for (const page of Object.values(fields.xds.pages || {})) {
    for (const table of page.tables || []) for (const node of table.nodes || []) collectXds(node);
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
    knownUuids,
  };
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

/** status: "resolved" | "normalised" | "unknown" */
function record(result, kind, id, status, detail) {
  const key = kind + "::" + id;
  let entry = result.elements.get(key);
  if (!entry) {
    entry = { kind, id, status, occurrences: 0, detail: detail || null };
    result.elements.set(key, entry);
  } else if (status === "unknown" && entry.status !== "unknown") {
    entry.status = "unknown";
    entry.detail = detail || entry.detail;
  }
  entry.occurrences++;
  return entry;
}

function mismatch(result, severity, code, message, evidence) {
  result.structuralMismatches.push({
    severity,
    code,
    message,
    ...(evidence ? { evidence } : {}),
  });
}

function finaliseResult(result) {
  result.kindTotals = {};
  for (const entry of result.elements.values()) {
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
  const localOf = (label) => String(label || "").split(":").pop().trim();
  const visit = (node, prefixPath) => {
    const local = localOf(node.label);
    let next = prefixPath;
    if (node.kind !== "group") {
      next = prefixPath ? prefixPath + "/" + local : local;
      paths.add(next);
      names.add(local);
    }
    for (const m of structureMembers(node)) visit(m, next);
  };
  visit(structure.root, "");
  return { paths, names };
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
  const specPaths = structure ? structureElementPaths(structure) : { paths: new Set(), names: new Set() };

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
      record(result, "soapPath", p, "resolved");
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
      const uuid = String(node.attrs.classificationScheme).toLowerCase();
      record(
        result,
        "xdsClassificationScheme",
        node.attrs.classificationScheme,
        spec.knownUuids.has(uuid) ? "resolved" : "unknown",
        spec.knownUuids.has(uuid) ? null : "classification scheme UUID never mentioned anywhere in the compiled spec",
      );
    }
    if (node.local === "ExternalIdentifier" && node.attrs.identificationScheme) {
      const uuid = String(node.attrs.identificationScheme).toLowerCase();
      record(
        result,
        "xdsIdentificationScheme",
        node.attrs.identificationScheme,
        spec.knownUuids.has(uuid) ? "resolved" : "unknown",
        spec.knownUuids.has(uuid) ? null : "identification scheme UUID never mentioned anywhere in the compiled spec",
      );
    }
  }

  // ITI-18 query parameters live in rim:Slot/@name inside rim:AdhocQuery — already
  // covered above; also resolve the stored query id.
  for (const node of walkXml(root)) {
    if (node.local === "AdhocQuery" && node.attrs.id) {
      const uuid = String(node.attrs.id).toLowerCase();
      record(
        result,
        "xdsStoredQueryId",
        node.attrs.id,
        spec.knownUuids.has(uuid) ? "resolved" : "unknown",
        spec.knownUuids.has(uuid) ? null : "stored query UUID not mentioned anywhere in the compiled spec",
      );
    }
  }

  return finaliseResult(result);
}

function recordXdsName(spec, result, name, kind) {
  const literal = norm(name);
  if (spec.xdsNamesExact.has(literal)) {
    record(result, kind, literal, "resolved");
    return;
  }
  const hit = spec.xdsNames.get(squashFootnote(literal));
  if (hit) {
    record(result, kind, literal, "normalised", hit.join(" | "));
    return;
  }
  const glued = spec.xdsNamesGlued.get(squashGluedFootnote(literal));
  if (glued) {
    record(result, kind, literal, "normalised", glued.join(" | "));
    return;
  }
  record(result, kind, literal, "unknown", "no compiled XDS metadata attribute or query parameter with this name");
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
  const byFormat = {};
  const unresolvedIndex = new Map();
  const mismatchIndex = new Map();
  const byKind = {};

  for (const r of perSample) {
    totals.elementsFound += r.elementsFound;
    totals.elementsResolved += r.elementsResolved;
    totals.elementsResolvedExact += r.elementsResolvedExact;
    totals.elementsResolvedNormalised += r.elementsResolvedNormalised;

    const f = (byFormat[r.format] = byFormat[r.format] || {
      samples: 0,
      elementsFound: 0,
      elementsResolved: 0,
      elementsResolvedNormalised: 0,
      elementsUnknown: 0,
      samplesWithoutStructure: 0,
      structuralMismatches: 0,
    });
    f.samples++;
    f.elementsFound += r.elementsFound;
    f.elementsResolved += r.elementsResolved;
    f.elementsResolvedNormalised += r.elementsResolvedNormalised;
    f.elementsUnknown += r.elementsUnknownCount;
    f.structuralMismatches += r.structuralMismatches.length;
    if (!r.structureId) f.samplesWithoutStructure++;

    for (const [kind, kt] of Object.entries(r.kindTotals || {})) {
      const agg = (byKind[kind] = byKind[kind] || { found: 0, resolved: 0, unknown: 0 });
      agg.found += kt.found;
      agg.resolved += kt.resolved;
      agg.unknown += kt.unknown;
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
  }
  for (const k of Object.values(byKind)) {
    k.resolutionRate = k.found ? Number((k.resolved / k.found).toFixed(4)) : 0;
  }

  const topUnresolved = [...unresolvedIndex.values()]
    .map((a) => ({ ...a, formats: [...a.formats].sort() }))
    .sort((a, b) => b.samples - a.samples || b.occurrences - a.occurrences || a.identifier.localeCompare(b.identifier));

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

  const circular = perSample.filter(
    (r) => r.format === "soap-xds" && r.structureId && /derivedFrom/.test(
      JSON.stringify((spec.structures[r.structureId] || {}).envelope || {}),
    ),
  );
  if (circular.length) {
    push(
      "warn",
      "methodology",
      "SOAP/XDS structures are themselves derived from these same golden samples",
      "envelope.derivedFrom on " +
        [...new Set(circular.map((r) => r.structureId))].join(", ") +
        " cites spec-source/golden/SOAP/*. Any SOAP resolution number is partly circular and must not be read as independent confirmation. Only the XDS metadata attribute names (resolved against fields/xds.json, which comes from Confluence) are an independent measurement.",
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
      structuralMismatches: perSample.reduce((n, r) => n + r.structuralMismatches.length, 0),
      samplesFullyResolved: perSample.filter((r) => r.elementsUnknownCount === 0).length,
    },
    byFormat,
    byElementKind: Object.fromEntries(
      Object.entries(byKind).sort((a, b) => a[1].resolutionRate - b[1].resolutionRate),
    ),
    perSample: perSample.sort((a, b) => a.resolutionRate - b.resolutionRate),
    topUnresolved: topUnresolved.slice(0, 120),
    topUnresolvedTruncated: Math.max(0, topUnresolved.length - 120),
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
      "  structural mismatches " + o.structuralMismatches + "\n" +
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
  process.stdout.write("\n  wrote " + path.relative(ROOT, OUT_PATH) + "\n\n");
}

main();
