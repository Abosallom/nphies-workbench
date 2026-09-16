/**
 * Deterministic message detection: which compiled structure does a pasted message claim to be?
 *
 * The rail asks the analyst to pick one of 55 structures by hand, and a wrong pick makes the
 * checker print a page of plausible, confidently wrong "required-field-missing" findings. Yet
 * every structure already carries a fingerprint in `MessageStructure.envelope` — MSH-9, the
 * pinned `Bundle.meta.profile`, the document templateId and LOINC code, `wsa:Action`, the
 * SAML root — so the message can be matched against the spec rather than against a guess.
 *
 * Three rules, in the order the product's founding rule imposes them:
 *
 *  1. Every candidate carries EVIDENCE: the verbatim fragment of the message and the envelope
 *     field it was compared with. The analyst can check the claim; nothing is asserted bare.
 *  2. Where fingerprints collide (four ACK structures share `ACK`; six immunization
 *     structures share LOINC 11369-6; two use cases share 57832-8; Raqeeb and uncontrolled
 *     medication bundles share one bundle profile) the collision is settled by a stated
 *     tiebreak, and where the tiebreak cannot settle it EVERY sharer is returned, ranked, with
 *     the reason it could not be separated. Never the first one.
 *  3. No match is a first-class result with a reason, not an empty list.
 *
 * Nothing here is wired into a view; this module only exports.
 */

import {
  loadManifest,
  loadStructures,
  walkStructure,
  type MessageStructure,
  type SpecManifest,
  type StructureMember,
  type StructuresBundle,
} from "./structure";
import { detectEncoding, type EncodingGuess } from "./workbench";

/* ========================================================================== *
 * Result shape
 * ========================================================================== */

/**
 * How firmly a candidate is identified.
 *
 *   `certain`   an identifier the spec pins to this structure alone matched verbatim
 *               (MSH-9, wsa:Action, a document templateId, bundle + composition profile)
 *   `probable`  matched, but the decision rested on a secondary signal: a section templateId
 *               only this structure carries, MSA-1, a value only ever seen in the official
 *               samples, or the ABSENCE of a marker the alternative would have to carry
 *   `possible`  the fingerprint is shared and nothing in the message separated the sharers;
 *               every sharer is returned at this grade
 */
export type DetectGrade = "certain" | "probable" | "possible";

export interface DetectEvidence {
  /** What the fragment was compared with: the envelope field or structure fact, in words. */
  field: string;
  /** The value the compiled spec (or, where `basis` says so, an official sample) pins. */
  expected: string;
  /** The message's own text, verbatim. */
  fragment: string;
  /** 0-based offset of `fragment` in the message text. */
  offset: number;
  /** 1-based line of `fragment`. */
  line: number;
  /**
   * Where `expected` comes from. `spec` is the compiled envelope or a compiled member;
   * `sample` means only an official sample states it and the published pages do not;
   * `standard` is HL7/IHE/OASIS itself (e.g. the MSA-1 acknowledgment codes).
   */
  basis: "spec" | "sample" | "standard";
  /** The page or sample that states `expected`, where one is known. */
  source?: string;
}

export interface DetectCandidate {
  useCaseId: string;
  structureId: string;
  variant: string | null;
  title: string;
  grade: DetectGrade;
  evidence: DetectEvidence[];
  /** What kept the grade from being higher, in words the analyst can check. */
  caveats: string[];
}

export interface DetectResult {
  /** The family gate: `detectEncoding()`'s verdict on the first bytes. */
  encoding: EncodingGuess;
  /**
   * `identified`  one candidate stands alone at the top grade
   * `ambiguous`   two or more candidates share the top grade — read all of them
   * `none`        nothing matched; `reason` says why
   */
  outcome: "identified" | "ambiguous" | "none";
  /** Best first. Empty only when `outcome` is `none`. */
  candidates: DetectCandidate[];
  /** Why there are no candidates. `null` whenever there is at least one. */
  reason: string | null;
}

export interface DetectInputs {
  manifest: SpecManifest;
  structures: StructuresBundle;
}

/* ========================================================================== *
 * Entry points
 * ========================================================================== */

/** Detect against the compiled bundle, loaded through the shared cached loaders. */
export async function detectMessage(text: string): Promise<DetectResult> {
  const [manifest, structures] = await Promise.all([loadManifest(), loadStructures()]);
  return detect(text, { manifest, structures });
}

/** Pure form: same result, no I/O. */
export function detect(text: string, inputs: DetectInputs): DetectResult {
  const encoding = detectEncoding(text);
  const pool = candidateStructures(inputs);
  let verdict: Verdict;
  switch (encoding.encoding) {
    case "hl7v2-er7":
      verdict = detectHl7v2(text, pool);
      break;
    case "fhir-json":
      verdict = detectFhir(text, pool, inputs);
      break;
    case "cda-xml":
      verdict = detectCda(text, pool, inputs);
      break;
    case "soap-xml":
      verdict = detectSoap(text, pool);
      break;
    case "saml-xml":
      verdict = detectSaml(text, pool);
      break;
    default:
      verdict = none(`Nothing to match: ${encoding.because}.`);
  }
  return finish(encoding, verdict);
}

interface Verdict {
  candidates: DetectCandidate[];
  reason: string | null;
}

const none = (reason: string): Verdict => ({ candidates: [], reason });

const GRADE_RANK: Record<DetectGrade, number> = { certain: 0, probable: 1, possible: 2 };

function finish(encoding: EncodingGuess, verdict: Verdict): DetectResult {
  // Stable: a family detector's own order survives among equal grades.
  const candidates = verdict.candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => GRADE_RANK[a.c.grade] - GRADE_RANK[b.c.grade] || a.i - b.i)
    .map(({ c }) => c);
  if (!candidates.length) {
    return { encoding, outcome: "none", candidates, reason: verdict.reason ?? "no compiled structure matched" };
  }
  const tied = candidates.length > 1 && candidates[1].grade === candidates[0].grade;
  return { encoding, outcome: tied ? "ambiguous" : "identified", candidates, reason: null };
}

/**
 * The structures worth naming. A use case with variants also compiles an umbrella structure
 * with `variant: null` (cda-iehr-summary next to -full and -noinfo, fhir-rad-report next to
 * -structured and -embedded-pdf). Pointing an analyst at the umbrella when a variant can be
 * told apart would put the less specific rules in front of them, so umbrellas are dropped
 * wherever a sibling variant exists.
 */
function candidateStructures({ structures }: DetectInputs): MessageStructure[] {
  const list = structures.structureIds
    .map((id) => structures.messageStructures[id])
    .filter((s): s is MessageStructure => Boolean(s));
  const withVariants = new Set(list.filter((s) => s.variant !== null).map((s) => s.useCaseId));
  return list.filter((s) => s.variant !== null || !withVariants.has(s.useCaseId));
}

function candidate(
  s: MessageStructure,
  grade: DetectGrade,
  evidence: DetectEvidence[],
  caveats: string[] = [],
): DetectCandidate {
  // Two witnesses can land on the same tag (a NoInfo section templateId is exclusive both to
  // its use case and to its variant); the analyst should see it once.
  const seen = new Set<string>();
  const unique = evidence.filter((e) => {
    const key = `${e.field}|${e.offset}|${e.expected}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    useCaseId: s.useCaseId,
    structureId: s.id,
    variant: s.variant,
    title: s.title,
    grade,
    evidence: unique,
    caveats,
  };
}

/* ========================================================================== *
 * Evidence helpers
 * ========================================================================== */

function lineAt(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10) line++;
    else if (ch === 13) {
      line++;
      if (text.charCodeAt(i + 1) === 10) i++;
    }
  }
  return line;
}

function evidence(text: string, e: Omit<DetectEvidence, "line">): DetectEvidence {
  return { ...e, line: lineAt(text, e.offset) };
}

const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
const quoteList = (xs: readonly string[]) => xs.map((x) => `"${x}"`).join(", ");

/* ========================================================================== *
 * HL7 v2 — MSH-9, then MSA-1 for the ACK cluster
 * ========================================================================== */

interface Segment {
  text: string;
  offset: number;
}

function splitSegments(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /[^\r\n]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ text: m[0], offset: m.index });
  return out;
}

/** Offset of field `n` (0 = the segment id) within a segment, given its field separator. */
function fieldOffset(segment: string, sep: string, n: number): number {
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const next = segment.indexOf(sep, pos);
    if (next < 0) return segment.length;
    pos = next + 1;
  }
  return pos;
}

function hl7TypeOf(s: MessageStructure): { code: string; trigger: string | null; raw: string } | null {
  if (s.envelope?.kind !== "hl7v2Message" || !s.envelope.messageType) return null;
  const [code, trigger] = s.envelope.messageType.split("^");
  return { code, trigger: trigger || null, raw: s.envelope.messageType };
}

/**
 * ACK-positive vs ACK-negative is a fact about the structure, carried in its variant name
 * ("ACK-positive" / "Negative Acknowledgment"). Its members cannot tell them apart — the ADT
 * positive ACK compiles an ERR member too, at usage I — so the name is what there is.
 */
function ackPolarity(s: MessageStructure): "positive" | "negative" | null {
  const name = `${s.variant ?? ""} ${s.variantLabel ?? ""}`;
  if (/negative/i.test(name)) return "negative";
  if (/positive/i.test(name)) return "positive";
  return null;
}

/** HL7 v2.5.1 Table 0008. Original-mode and enhanced-mode codes both count. */
const MSA_POSITIVE = new Set(["AA", "CA"]);
const MSA_NEGATIVE = new Set(["AE", "AR", "CE", "CR"]);

function detectHl7v2(text: string, pool: MessageStructure[]): Verdict {
  const hl7 = pool.filter((s) => hl7TypeOf(s) !== null);
  const segments = splitSegments(text);
  const msh = segments[0];
  if (!msh || !msh.text.startsWith("MSH")) return none("No MSH segment leads the message.");
  const sep = msh.text[3];
  const comp = msh.text[4] ?? "^";
  const fields = msh.text.split(sep);
  const msh9 = fields[8] ?? "";
  if (!msh9) {
    return none("MSH-9 (Message Type) is empty, and it is the only field that says which HL7 v2 structure this is.");
  }
  const msh9Offset = msh.offset + fieldOffset(msh.text, sep, 8);
  const [code, trigger = ""] = msh9.split(comp);

  const declared = uniq(hl7.map((s) => hl7TypeOf(s)!.raw));

  // A trigger-bearing type (ADT^A01, ORU^R01) is unique per structure.
  const exact = hl7.filter((s) => {
    const t = hl7TypeOf(s)!;
    return t.code === code && t.trigger !== null && t.trigger === trigger;
  });
  if (exact.length) {
    return {
      reason: null,
      candidates: exact.map((s) =>
        candidate(s, "certain", [
          evidence(text, {
            field: "MSH-9 Message Type vs envelope.hl7v2Message.messageType",
            expected: hl7TypeOf(s)!.raw,
            fragment: msh9,
            offset: msh9Offset,
            basis: "spec",
          }),
        ]),
      ),
    };
  }

  // A trigger-less type ("ACK") is shared by every acknowledgment structure.
  let acks = hl7.filter((s) => {
    const t = hl7TypeOf(s)!;
    return t.code === code && t.trigger === null;
  });
  if (!acks.length) {
    return none(
      `MSH-9 is "${msh9}", which none of the ${hl7.length} compiled HL7 v2 structures declares. Declared message types: ${declared.join(", ")}.`,
    );
  }

  const shared: DetectEvidence[] = [
    evidence(text, {
      field: "MSH-9 Message Type vs envelope.hl7v2Message.messageType",
      expected: code,
      fragment: msh9,
      offset: msh9Offset,
      basis: "spec",
    }),
  ];
  const caveats: string[] = [];
  let axes = 0;

  // Axis 1 — which use case is being acknowledged. MSH-9.2 of an ACK may carry the trigger
  // event of the message it answers; if it does, the owner of that event owns the ACK.
  const ownerByTrigger = new Map<string, string>();
  for (const s of hl7) {
    const t = hl7TypeOf(s)!;
    if (t.trigger) ownerByTrigger.set(t.trigger, s.useCaseId);
  }
  const owner = trigger ? ownerByTrigger.get(trigger) : undefined;
  if (owner) {
    acks = acks.filter((s) => s.useCaseId === owner);
    shared.push(
      evidence(text, {
        field: "MSH-9.2 Trigger Event vs the use case whose structure declares it",
        expected: `${trigger} (declared by ${owner})`,
        fragment: trigger,
        offset: msh9Offset + msh9.indexOf(trigger),
        basis: "spec",
      }),
    );
    axes++;
  } else if (trigger) {
    caveats.push(
      `MSH-9.2 is "${trigger}", a trigger event no compiled ADT or ORU structure declares, so the ACK cannot be tied to a use case.`,
    );
  } else {
    caveats.push(
      "MSH-9 carries no trigger event (MSH-9.2), so this ACK cannot be tied to ADT or ORU from the ACK alone.",
    );
  }

  // Axis 2 — positive or negative, from MSA-1 (HL7 Table 0008) with ERR as a witness.
  const msa = segments.find((seg) => seg.text.startsWith(`MSA${sep}`));
  const err = segments.find((seg) => seg.text.startsWith(`ERR${sep}`));
  let polarity: "positive" | "negative" | null = null;
  if (msa) {
    const msa1 = msa.text.split(sep)[1] ?? "";
    if (MSA_POSITIVE.has(msa1)) polarity = "positive";
    else if (MSA_NEGATIVE.has(msa1)) polarity = "negative";
    if (polarity) {
      shared.push(
        evidence(text, {
          field: "MSA-1 Acknowledgment Code (HL7 v2.5.1 Table 0008)",
          expected: polarity === "positive" ? "AA or CA (accepted)" : "AE, AR, CE or CR (error / rejected)",
          fragment: msa1,
          offset: msa.offset + fieldOffset(msa.text, sep, 1),
          basis: "standard",
        }),
      );
    } else {
      caveats.push(`MSA-1 is "${msa1}", which is neither an accept nor an error/reject code in HL7 Table 0008.`);
    }
    if (polarity === "positive" && err) {
      caveats.push("MSA-1 accepts the message, yet an ERR segment is present; both acknowledgment shapes are kept.");
      polarity = null;
    } else if (polarity === "negative" && err) {
      shared.push(
        evidence(text, {
          field: "ERR segment present",
          expected: "an ERR segment (negative acknowledgments carry one)",
          fragment: err.text.split(sep).slice(0, 2).join(sep),
          offset: err.offset,
          basis: "spec",
        }),
      );
    }
  } else {
    caveats.push("No MSA segment, so positive and negative acknowledgments cannot be told apart.");
  }
  if (polarity) {
    const narrowed = acks.filter((s) => ackPolarity(s) === polarity);
    if (narrowed.length) {
      acks = narrowed;
      axes++;
    }
  }

  const grade: DetectGrade = axes === 2 ? "probable" : "possible";
  return { reason: null, candidates: acks.map((s) => candidate(s, grade, shared, caveats)) };
}

/* ========================================================================== *
 * FHIR — Bundle.meta.profile, then Composition profile / entry shape / medication markers
 * ========================================================================== */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const isObj = (v: unknown): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);

type JsonRead = { ok: true; value: Json } | { ok: false; error: string };

/**
 * `JSON.parse`, then once more with line (`//`) and block comments blanked and trailing commas
 * dropped. Nine official medication samples carry `///` comments (see sample-defects.json),
 * and a detector that refused them would fail on the very messages it is meant to recognise.
 * Comments are blanked rather than removed so nothing shifts: the position in the error
 * message of the second pass is a position in the original text.
 */
function readJsonLenient(text: string): JsonRead {
  try {
    return { ok: true, value: JSON.parse(text) as Json };
  } catch {
    /* fall through to the tolerant pass */
  }
  const n = text.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        if (text[j] === "\\") j++;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close < 0 ? n : close + 2;
      out += text.slice(i, end).replace(/[^\n\r]/g, " ");
      i = end;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") {
        out += " ";
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  try {
    return { ok: true, value: JSON.parse(out) as Json };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function walkJson(v: Json, visit: (node: { [k: string]: Json }) => void): void {
  if (Array.isArray(v)) for (const x of v) walkJson(x, visit);
  else if (isObj(v)) {
    visit(v);
    for (const x of Object.values(v)) walkJson(x, visit);
  }
}

function stringList(v: Json | undefined): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

function locatorPath(member: StructureMember): string | null {
  const loc = (member as { locator?: unknown }).locator;
  if (!loc || typeof loc !== "object") return null;
  const path = (loc as { path?: unknown }).path;
  return typeof path === "string" ? path : null;
}

/** The URL a bundle structure pins on `Bundle.meta.profile`, from its own fixed-value rule. */
function bundleProfileOf(s: MessageStructure): { url: string; source?: string } | null {
  for (const m of s.root.members) {
    if (m.kind !== "element" || locatorPath(m) !== "./meta/profile") continue;
    const fixed = (m.fixedValues ?? []).find((f) => f.scope === "wholeField" && f.value);
    if (fixed?.value) return { url: fixed.value, source: fixed.provenance?.pageTitle ?? undefined };
  }
  return null;
}

/** The profile a bundle structure pins on its Composition entry, when it has one. */
function compositionProfileOf(s: MessageStructure): string | null {
  let found: string | null = null;
  walkStructure(s, (m) => {
    if (found) return false;
    if (m.kind === "entry" && m.resourceType === "Composition" && m.profile) found = m.profile;
  });
  return found;
}

/** The resource types a bundle structure compiles as entries. */
function entryTypesOf(s: MessageStructure): Set<string> {
  const out = new Set<string>();
  walkStructure(s, (m) => {
    if (m.kind === "entry" && m.resourceType) out.add(m.resourceType);
  });
  return out;
}

/**
 * One row of a structure's `specVsSampleConflicts`: a place where the compiler found the
 * published page and the official samples disagreeing and recorded BOTH values instead of
 * picking one (the dispense bundles' profile, the structured radiology Composition's
 * profile). Kept off the `MessageStructure` type on purpose — it is the compiler's own
 * evidence trail, read here only so a wire value can be matched WITH its provenance.
 */
interface SpecVsSampleConflict {
  id?: string;
  field?: string;
  specValue?: string;
  wireValue?: string;
  resolution?: string;
  recommendation?: string;
  sources?: { pageId?: string; pageTitle?: string | null; quote?: string | null; row?: string | null }[];
  affectedSamples?: string[];
}

/** Every recorded conflict for a use case, including those on the umbrella the pool drops. */
function conflictsFor(inputs: DetectInputs, useCaseId: string): SpecVsSampleConflict[] {
  const out: SpecVsSampleConflict[] = [];
  for (const id of inputs.structures.structureIds) {
    const s = inputs.structures.messageStructures[id] as (MessageStructure & { specVsSampleConflicts?: unknown }) | undefined;
    if (!s || s.useCaseId !== useCaseId || !Array.isArray(s.specVsSampleConflicts)) continue;
    for (const c of s.specVsSampleConflicts) if (c && typeof c === "object") out.push(c as SpecVsSampleConflict);
  }
  return out;
}

function conflictSource(c: SpecVsSampleConflict): string | undefined {
  const src = c.sources?.[0];
  if (!src?.pageTitle) return undefined;
  return `${src.pageTitle}${src.row ? `, ${src.row}` : ""} (page ${src.pageId ?? "?"})`;
}

/** Locate a string value in the text, quotes included, so the fragment is the message's own. */
function locateString(text: string, value: string): { fragment: string; offset: number } {
  const quoted = `"${value}"`;
  const at = text.indexOf(quoted);
  if (at >= 0) return { fragment: quoted, offset: at };
  const bare = text.indexOf(value);
  return bare >= 0 ? { fragment: value, offset: bare } : { fragment: value, offset: 0 };
}

/** Locate `"resourceType": "X"` in the text, spacing as the message wrote it. */
function locateResourceType(text: string, resourceType: string): { fragment: string; offset: number } {
  const m = new RegExp(`"resourceType"\\s*:\\s*"${resourceType}"`).exec(text);
  return m ? { fragment: m[0], offset: m.index } : locateString(text, resourceType);
}

const stripVersion = (url: string) => url.split("|")[0];

/**
 * The KSA Medication Prescription Type code system (`urn:oid:2.16.840.1.113883.3.3731.1.205.14`).
 * Its Raqeeb value set (Confluence page 118849697) lists C, U, N, R; the non-Raqeeb value set
 * lists C, U. So U and C do not settle the flow by value set alone — what settles the rank
 * is the official samples: all four uncontrolled prescriptions carry U, all three Raqeeb
 * prescriptions carry C. That is why the evidence below is graded `sample`.
 */
const PRESCRIPTION_TYPE_OID = "2.16.840.1.113883.3.3731.1.205.14";

/**
 * Raqeeb dispenses carry a SecureCode tag extension on `./meta/tag/extension/url` — page
 * 117965118 "MedicationDispense (Dispense Item)(Raqeeb)" rows 2.5 and 2.6 make it mandatory
 * under either tag (Code-Authenticated -> SecureCode-verification, Code-Override ->
 * Override-SecureCode-Justification). The uncontrolled dispense pages have no such row.
 */
const SECURE_CODE_EXTENSION = /^http:\/\/nphies\.sa\/fhir\/ksa\/nphies-cs\/Extension\/.*SecureCode/i;

/**
 * Everything the FHIR detector reads off a message, gathered up front so the decision
 * logic is the same whether the JSON parsed or had to be scraped from the text.
 */
interface FhirFacts {
  resourceType: string | null;
  bundleProfiles: string[];
  compositionProfiles: string[];
  /** `resourceType` of each `Bundle.entry.resource` (in text mode: every one after the root's). */
  entryResourceTypes: string[];
  /** Codes on the KSA prescription-type system, wherever a `category` carries one. */
  categoryCodes: string[];
  secureCodeUrls: string[];
  /**
   * Non-null when the facts were scraped off the raw text because the JSON does not parse
   * even leniently. One official Raqeeb sample has an unclosed object at line 596
   * (sample-defects.json, `invalid-json`); its Bundle.meta.profile is still legible at the
   * top of the file, and refusing to name it would fail the one message the analyst pasted.
   */
  parseFailure: string | null;
}

function factsFromJson(root: { [k: string]: Json }): FhirFacts {
  const compositionProfiles: string[] = [];
  const categoryCodes: string[] = [];
  const secureCodeUrls: string[] = [];
  walkJson(root, (node) => {
    if (node.resourceType === "Composition" && isObj(node.meta)) {
      compositionProfiles.push(...stringList(node.meta.profile));
    }
    if (Array.isArray(node.category)) {
      for (const cat of node.category) {
        if (!isObj(cat) || !Array.isArray(cat.coding)) continue;
        for (const c of cat.coding) {
          if (isObj(c) && typeof c.system === "string" && c.system.endsWith(PRESCRIPTION_TYPE_OID) && typeof c.code === "string") {
            categoryCodes.push(c.code);
          }
        }
      }
    }
    if (typeof node.url === "string" && SECURE_CODE_EXTENSION.test(node.url)) secureCodeUrls.push(node.url);
  });
  const entryResourceTypes: string[] = [];
  if (Array.isArray(root.entry)) {
    for (const e of root.entry) {
      if (isObj(e) && isObj(e.resource) && typeof e.resource.resourceType === "string") entryResourceTypes.push(e.resource.resourceType);
    }
  }
  return {
    resourceType: typeof root.resourceType === "string" ? root.resourceType : null,
    bundleProfiles: stringList(isObj(root.meta) ? root.meta.profile : undefined),
    compositionProfiles,
    entryResourceTypes,
    categoryCodes,
    secureCodeUrls,
    parseFailure: null,
  };
}

/**
 * The same facts by regular expression, for a message no JSON reader accepts. Coarser: a
 * contained resource's `resourceType` counts as an entry's, and a Composition's profile is
 * the first `"profile"` after its `"resourceType"`. Every candidate built from these facts
 * carries the parse failure as a caveat and is graded no higher than `probable`.
 */
function factsFromText(text: string, failure: string): FhirFacts {
  const types = [...text.matchAll(/"resourceType"\s*:\s*"([A-Za-z]+)"/g)];
  const profileRe = /"profile"\s*:\s*(\[[^\]]*\]|"[^"]*")/g;
  const strings = (blob: string) => [...blob.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const profileAfter = (from: number, limit: number): string[] => {
    profileRe.lastIndex = from;
    const m = profileRe.exec(text);
    return m && m.index < limit ? strings(m[1]) : [];
  };
  const firstEntry = text.search(/"entry"\s*:/);
  const compositionProfiles: string[] = [];
  for (const t of types) if (t[1] === "Composition") compositionProfiles.push(...profileAfter(t.index, t.index + 800));
  const categoryCodes: string[] = [];
  for (let at = text.indexOf(PRESCRIPTION_TYPE_OID); at >= 0; at = text.indexOf(PRESCRIPTION_TYPE_OID, at + 1)) {
    const open = text.lastIndexOf("{", at);
    const close = text.indexOf("}", at);
    if (open < 0 || close < 0) continue;
    const code = /"code"\s*:\s*"([^"]+)"/.exec(text.slice(open, close))?.[1];
    if (code) categoryCodes.push(code);
  }
  return {
    resourceType: types[0]?.[1] ?? null,
    bundleProfiles: profileAfter(0, firstEntry < 0 ? 4096 : firstEntry),
    compositionProfiles,
    entryResourceTypes: types.slice(1).map((t) => t[1]),
    categoryCodes,
    secureCodeUrls: [...text.matchAll(/"url"\s*:\s*"([^"]+)"/g)].map((m) => m[1]).filter((u) => SECURE_CODE_EXTENSION.test(u)),
    parseFailure: failure,
  };
}

interface ProfilePin {
  url: string;
  source?: string;
}

interface ProfileHit {
  s: MessageStructure;
  pin: ProfilePin;
  /** The profile string the message actually carries. */
  seen: string;
  how: "exact" | "version" | "wire";
  conflict?: SpecVsSampleConflict;
}

function detectFhir(text: string, pool: MessageStructure[], inputs: DetectInputs): Verdict {
  const fhir = pool.filter((s) => s.envelope?.kind === "fhirBundle");
  const read = readJsonLenient(text);
  let facts: FhirFacts;
  if (read.ok) {
    if (!isObj(read.value)) return none("The JSON is not an object, so it is not a FHIR resource.");
    facts = factsFromJson(read.value);
  } else {
    facts = factsFromText(text, read.error);
  }
  if (facts.resourceType !== "Bundle") {
    return none(
      `resourceType is ${facts.resourceType ? `"${facts.resourceType}"` : "absent"}; every compiled FHIR structure is a Bundle, and a bare resource cannot be matched to one.` +
        (facts.parseFailure ? ` (The JSON does not parse: ${facts.parseFailure}.)` : ""),
    );
  }

  const pinned = fhir
    .map((s) => ({ s, pin: bundleProfileOf(s) }))
    .filter((p): p is { s: MessageStructure; pin: ProfilePin } => p.pin !== null);
  const pinnedUrls = uniq(pinned.map((p) => p.pin.url));
  if (!facts.bundleProfiles.length) {
    return none(
      `Bundle.meta.profile is absent, and the pinned bundle profile URL is what tells the ${fhir.length} compiled bundles apart. Pinned profiles: ${pinnedUrls.join(", ")}.`,
    );
  }

  // Three tiers, best available wins: the pinned URL verbatim; the pinned URL with its
  // "|version" ignored; the wire value the compiler recorded the official samples sending
  // in place of the pinned one. The last is how the dispense bundles are recognised at all.
  const hitsBy = (how: ProfileHit["how"]): ProfileHit[] =>
    pinned.flatMap(({ s, pin }): ProfileHit[] => {
      if (how === "exact") {
        const seen = facts.bundleProfiles.find((u) => u === pin.url);
        return seen ? [{ s, pin, seen, how }] : [];
      }
      if (how === "version") {
        const seen = facts.bundleProfiles.find((u) => stripVersion(u) === stripVersion(pin.url));
        return seen ? [{ s, pin, seen, how }] : [];
      }
      for (const conflict of conflictsFor(inputs, s.useCaseId)) {
        if (conflict.specValue !== pin.url || !conflict.wireValue) continue;
        const seen = facts.bundleProfiles.find((u) => u === conflict.wireValue);
        if (seen) return [{ s, pin, seen, how, conflict }];
      }
      return [];
    });
  const hits = hitsBy("exact").length ? hitsBy("exact") : hitsBy("version").length ? hitsBy("version") : hitsBy("wire");
  if (!hits.length) {
    return none(
      `Bundle.meta.profile is ${quoteList(facts.bundleProfiles)}; no compiled bundle pins that URL. Pinned profiles: ${pinnedUrls.join(", ")}.`,
    );
  }

  const how = hits[0].how;
  const identityGrade: DetectGrade = how === "exact" && !facts.parseFailure ? "certain" : "probable";
  const identityCaveats: string[] = [];
  if (how === "version") {
    identityCaveats.push(`Bundle.meta.profile ${quoteList(facts.bundleProfiles)} matches the pinned URL only with its "|version" suffix ignored.`);
  }
  if (how === "wire") {
    const c = hits[0].conflict!;
    identityCaveats.push(
      `Bundle.meta.profile is "${c.wireValue}", which the published page does not pin: ${conflictSource(c) ?? "the page"} says "${c.sources?.[0]?.quote ?? c.specValue}". The compiler recorded the official samples sending this value instead (${c.field ?? c.id ?? "specVsSampleConflicts"}).` +
        (c.recommendation ? ` Its recommendation: ${c.recommendation}` : ""),
    );
  }
  if (facts.parseFailure) {
    identityCaveats.push(
      `The JSON does not parse, even with // comments and trailing commas removed (${facts.parseFailure}); the identity below was read off the raw text, not a parsed Bundle.`,
    );
  }
  const cap = (g: DetectGrade): DetectGrade => (facts.parseFailure && g === "certain" ? "probable" : g);
  const profileEvidence = (p: ProfileHit): DetectEvidence => {
    const at = locateString(text, p.seen);
    return evidence(text, {
      field: p.how === "wire" ? "Bundle.meta.profile vs the wire value the official samples send for the structure's fixed profile URL" : "Bundle.meta.profile vs the structure's fixed profile URL",
      expected: p.how === "wire" ? `${p.conflict!.wireValue} (samples) for ${p.pin.url} (page)` : p.pin.url,
      fragment: at.fragment,
      offset: at.offset,
      basis: p.how === "wire" ? "sample" : "spec",
      ...(p.how === "wire"
        ? { source: `specVsSampleConflicts "${p.conflict!.id ?? "?"}": ${p.conflict!.affectedSamples?.length ?? 0} official sample(s) vs ${conflictSource(p.conflict!) ?? "the page"}` }
        : p.pin.source
          ? { source: p.pin.source }
          : {}),
    });
  };

  const useCases = uniq(hits.map((p) => p.s.useCaseId));

  if (useCases.length === 1) {
    if (hits.length === 1) {
      return { reason: null, candidates: [candidate(hits[0].s, identityGrade, [profileEvidence(hits[0])], identityCaveats)] };
    }
    return {
      reason: null,
      candidates: resolveBundleVariants(text, hits, facts, conflictsFor(inputs, useCases[0]), identityGrade, identityCaveats, profileEvidence, cap),
    };
  }

  // Two use cases share a bundle profile: the uncontrolled and the Raqeeb medication flows.
  const raqeeb = hits.filter((p) => /raqeeb/i.test(p.s.title));
  const plain = hits.filter((p) => !/raqeeb/i.test(p.s.title));
  if (raqeeb.length !== 1 || plain.length !== 1) {
    return {
      reason: null,
      candidates: hits.map((p) =>
        candidate(p.s, "possible", [profileEvidence(p)], [
          ...identityCaveats,
          `The bundle profile is shared by ${hits.length} structures across ${useCases.length} use cases, and nothing in the message separates them.`,
        ]),
      ),
    };
  }

  const shared = (p: ProfileHit) => [profileEvidence(p)];
  const sharedCaveat = `The bundle profile "${hits[0].pin.url}" is pinned by both the uncontrolled and the Raqeeb structure.`;

  if (facts.categoryCodes.length) {
    const codes = uniq(facts.categoryCodes);
    const controlled = codes.some((c) => c !== "U");
    const first = controlled ? raqeeb[0] : plain[0];
    const second = controlled ? plain[0] : raqeeb[0];
    const at = locateString(text, facts.categoryCodes[0]);
    const ev = evidence(text, {
      field: `medication category coding on ${PRESCRIPTION_TYPE_OID} (KSA Medication Prescription Type)`,
      expected: controlled ? "C, N or R (the official Raqeeb samples carry C)" : "U (the official uncontrolled samples carry U)",
      fragment: at.fragment,
      offset: at.offset,
      basis: "sample",
      source: controlled
        ? "golden/FHIR/Raqeeb (Controlled,Narcotic & Restricted Meds)/MedicationRequestBundle_Raqeeb_*.json"
        : "golden/FHIR/Nphies (Uncontrolled Meds)/MedicationRequestBundle_*-UncontrolledMed_22052025.json",
    });
    const valueSetNote = controlled
      ? codes.every((c) => c === "C")
        ? 'Code C ("Controlled") is admitted by both the Raqeeb and the non-Raqeeb prescription-type value sets; only the official samples tie it to Raqeeb.'
        : `Code(s) ${quoteList(codes.filter((c) => c !== "U"))} appear only in the Raqeeb value set (page 118849697), not in the non-Raqeeb one.`
      : 'Code U ("Uncontrolled") is also admitted by the Raqeeb value set (page 118849697); only the official samples tie it to the uncontrolled flow.';
    return {
      reason: null,
      candidates: [
        candidate(first.s, "probable", [...shared(first), ev], [...identityCaveats, sharedCaveat]),
        candidate(second.s, "possible", shared(second), [...identityCaveats, sharedCaveat, valueSetNote]),
      ],
    };
  }

  if (facts.secureCodeUrls.length) {
    const at = locateString(text, facts.secureCodeUrls[0]);
    const ev = evidence(text, {
      field: "meta.tag extension url vs the Raqeeb SecureCode tag extension",
      expected: "http://nphies.sa/fhir/ksa/nphies-cs/Extension/SecureCode-verification or .../Override-SecureCode-Justification",
      fragment: at.fragment,
      offset: at.offset,
      basis: "spec",
      source: "MedicationDispense (Dispense Item)(Raqeeb), page 117965118 rows 2.5–2.6",
    });
    return {
      reason: null,
      candidates: [
        candidate(raqeeb[0].s, "probable", [...shared(raqeeb[0]), ev], [...identityCaveats, sharedCaveat]),
        candidate(plain[0].s, "possible", shared(plain[0]), [
          ...identityCaveats,
          sharedCaveat,
          "The message carries the Raqeeb SecureCode tag extension, which the uncontrolled pages never mention.",
        ]),
      ],
    };
  }

  const absence =
    "Nothing in the message names either flow: no prescription-type category coding, and no Raqeeb SecureCode tag extension. Page 117965118 makes that extension mandatory on a Raqeeb dispense, so its absence is the only thing ranking the uncontrolled structure first.";
  return {
    reason: null,
    candidates: [
      candidate(plain[0].s, "possible", shared(plain[0]), [...identityCaveats, sharedCaveat, absence]),
      candidate(raqeeb[0].s, "possible", shared(raqeeb[0]), [...identityCaveats, sharedCaveat, absence]),
    ],
  };
}

/**
 * Settle the variants of one bundle once the bundle itself is known (radiology report:
 * structured vs embedded PDF). Two independent witnesses:
 *
 *   profile  the Composition entry's `meta.profile`, pinned per variant
 *   shape    entry resource types compiled for one variant only (DocumentReference for the
 *            PDF; DiagnosticReport, Procedure, Binary for the structured report)
 *
 * They agree on the official PDF sample and CONTRADICT on the official structured sample,
 * whose Composition carries the EmbeddedPDF profile over structured-only entries — the
 * compiler recorded that as `rad-report-structured-composition-profile`. A detector that
 * trusted the profile alone would name the wrong variant with certainty on an official
 * message, so a contradiction returns both variants at `possible` with both witnesses shown.
 */
function resolveBundleVariants(
  text: string,
  hits: ProfileHit[],
  facts: FhirFacts,
  conflicts: SpecVsSampleConflict[],
  identityGrade: DetectGrade,
  identityCaveats: string[],
  profileEvidence: (p: ProfileHit) => DetectEvidence,
  cap: (g: DetectGrade) => DetectGrade,
): DetectCandidate[] {
  const byProfile = hits.filter((p) => {
    const want = compositionProfileOf(p.s);
    return want !== null && facts.compositionProfiles.includes(want);
  });
  const exclusive = new Map<string, string[]>();
  for (const p of hits) {
    const others = new Set(hits.filter((q) => q !== p).flatMap((q) => [...entryTypesOf(q.s)]));
    exclusive.set(p.s.id, [...entryTypesOf(p.s)].filter((t) => !others.has(t)));
  }
  const present = (p: ProfileHit) => uniq(exclusive.get(p.s.id)!.filter((t) => facts.entryResourceTypes.includes(t)));
  const byShape = hits.filter((p) => present(p).length > 0);

  const compositionEvidence = (p: ProfileHit): DetectEvidence => {
    const want = compositionProfileOf(p.s)!;
    const at = locateString(text, want);
    return evidence(text, {
      field: "Composition.meta.profile vs the variant's pinned Composition profile",
      expected: want,
      fragment: at.fragment,
      offset: at.offset,
      basis: "spec",
    });
  };
  const shapeEvidence = (p: ProfileHit): DetectEvidence[] =>
    present(p).map((t) => {
      const at = locateResourceType(text, t);
      return evidence(text, {
        field: "Bundle.entry.resource.resourceType vs an entry type compiled only for this variant",
        expected: `${t} (compiled for ${p.s.variantLabel ?? p.s.variant ?? p.s.title} only)`,
        fragment: at.fragment,
        offset: at.offset,
        basis: "spec",
      });
    });
  const label = (p: ProfileHit) => p.s.variantLabel ?? p.s.variant ?? p.s.title;
  const pinnedList = hits.map((p) => compositionProfileOf(p.s) ?? "none pinned").join(", ");

  if (byProfile.length === 1 && (byShape.length === 0 || (byShape.length === 1 && byShape[0] === byProfile[0]))) {
    const p = byProfile[0];
    return [candidate(p.s, cap(identityGrade), [profileEvidence(p), compositionEvidence(p), ...shapeEvidence(p)], identityCaveats)];
  }
  if (byProfile.length === 0 && byShape.length === 1) {
    const p = byShape[0];
    const why = facts.compositionProfiles.length
      ? `The Composition's meta.profile ${quoteList(facts.compositionProfiles)} matches none of the variants' pinned Composition profiles (${pinnedList}); the variant was chosen from the entries only it compiles.`
      : `No Composition entry with a meta.profile was found; the variant was chosen from the entries only it compiles.`;
    return [candidate(p.s, "probable", [profileEvidence(p), ...shapeEvidence(p)], [...identityCaveats, why])];
  }
  if (byProfile.length === 1 && byShape.length === 1) {
    // Profile says one variant, the entries say the other.
    const prof = byProfile[0];
    const shape = byShape[0];
    const seen = compositionProfileOf(prof.s)!;
    const catalogued = conflicts.find((c) => c.wireValue === seen && c.specValue === compositionProfileOf(shape.s));
    const contradiction =
      `The Composition's meta.profile "${seen}" is pinned for ${label(prof)}, but the bundle carries ${quoteList(present(shape))} entr${present(shape).length === 1 ? "y" : "ies"}, compiled only for ${label(shape)}, and none of ${quoteList(exclusive.get(prof.s.id)!)}. The two witnesses disagree, so neither variant is asserted.` +
      (catalogued
        ? ` The compiler recorded exactly this on the official sample ${catalogued.affectedSamples?.[0]?.replace(/^spec-source\//, "") ?? ""} (${catalogued.id}): ${catalogued.recommendation ?? ""}`
        : "");
    // With the contradiction on record the compiler's own recommendation orders the pair;
    // without one, the profile the message states goes first. Both stay `possible`.
    const ordered = catalogued ? [shape, prof] : [prof, shape];
    return ordered.map((p) =>
      candidate(
        p.s,
        "possible",
        [profileEvidence(p), ...(p === prof ? [compositionEvidence(p)] : []), ...(p === shape ? shapeEvidence(p) : [])],
        [...identityCaveats, contradiction],
      ),
    );
  }
  const why =
    byProfile.length > 1
      ? `The Composition's meta.profile ${quoteList(facts.compositionProfiles)} matches more than one variant's pinned Composition profile (${pinnedList}).`
      : byShape.length > 1
        ? `The bundle carries entries compiled exclusively for more than one variant (${byShape.map((p) => `${label(p)}: ${present(p).join("/")}`).join("; ")}).`
        : facts.compositionProfiles.length
          ? `The Composition's meta.profile ${quoteList(facts.compositionProfiles)} matches none of the variants' pinned Composition profiles (${pinnedList}), and no entry type present is compiled for one variant only.`
          : "No Composition entry with a meta.profile was found, and no entry type present is compiled for one variant only.";
  return hits.map((p) => candidate(p.s, "possible", [profileEvidence(p), ...shapeEvidence(p)], [...identityCaveats, why]));
}

/* ========================================================================== *
 * XML — a tag tokenizer shared by the CDA, SOAP and SAML detectors
 * ========================================================================== */

interface XmlTag {
  /** Local name, prefix stripped. */
  local: string;
  prefix: string | null;
  attrs: string;
  closing: boolean;
  selfClosing: boolean;
  offset: number;
  /** The whole tag, verbatim. */
  raw: string;
}

/**
 * Enough XML to find elements and their attributes without building a tree: comments, CDATA,
 * processing instructions and DOCTYPE are skipped whole so a `<section>` inside a comment is
 * not counted. Attribute values may contain `>`. The attribute group must not swallow the `/`
 * of `<realmCode code="SA"/>`: when it did, every empty element was pushed on the stack as an
 * open one, the document templateId and code were read as children of `realmCode`, and all
 * seventeen official CDA samples came back "no templateId, no code".
 */
const XML_TAG = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:"[^"]*"|'[^']*'|[^'">/]|\/(?!>))*)(\/?)>/g;

function xmlTags(text: string): XmlTag[] {
  const out: XmlTag[] = [];
  XML_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = XML_TAG.exec(text))) {
    if (m[2] === undefined) continue;
    const [prefix, local] = m[2].includes(":") ? m[2].split(":") : [null, m[2]];
    out.push({
      local,
      prefix,
      attrs: m[3] ?? "",
      closing: m[1] === "/",
      selfClosing: m[4] === "/",
      offset: m.index,
      raw: m[0],
    });
  }
  return out;
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? (m[1] ?? m[2] ?? "") : null;
}

/* ========================================================================== *
 * CDA — document templateId and code, then body kind and section templateIds
 * ========================================================================== */

interface CdaHeaderScan {
  rootFound: boolean;
  docTemplateIds: { root: string; tag: XmlTag }[];
  code: { code: string; tag: XmlTag } | null;
  body: { kind: "structuredBody" | "nonXMLBody"; tag: XmlTag } | null;
  /** Every `section/templateId/@root`, with the tag that carried it. */
  sectionTemplateIds: { root: string; tag: XmlTag }[];
  sectionCount: number;
}

function scanCda(text: string): CdaHeaderScan {
  const scan: CdaHeaderScan = {
    rootFound: false,
    docTemplateIds: [],
    code: null,
    body: null,
    sectionTemplateIds: [],
    sectionCount: 0,
  };
  const stack: string[] = [];
  for (const tag of xmlTags(text)) {
    if (tag.closing) {
      stack.pop();
      continue;
    }
    const parent = stack[stack.length - 1];
    if (!stack.length) {
      if (tag.local !== "ClinicalDocument") break;
      scan.rootFound = true;
    } else if (parent === "ClinicalDocument") {
      if (tag.local === "templateId") {
        const root = attr(tag.attrs, "root");
        if (root) scan.docTemplateIds.push({ root, tag });
      } else if (tag.local === "code" && !scan.code) {
        const code = attr(tag.attrs, "code");
        if (code) scan.code = { code, tag };
      }
    }
    if ((tag.local === "structuredBody" || tag.local === "nonXMLBody") && !scan.body) {
      scan.body = { kind: tag.local, tag };
    }
    if (tag.local === "section") scan.sectionCount++;
    if (tag.local === "templateId" && parent === "section") {
      const root = attr(tag.attrs, "root");
      if (root) scan.sectionTemplateIds.push({ root, tag });
    }
    if (!tag.selfClosing) stack.push(tag.local);
  }
  return scan;
}

/**
 * One row of `rules.cda.documentTypes` — the compiler's catalogue of CDA document types,
 * kept verbatim in the bundle. It carries the document templateIds the envelope leaves
 * `null` for (the on-demand documents, the orders, the radiology results), each with the
 * page quote that states it or a note that only the golden sample does.
 */
interface CdaCatalogueEntry {
  documentType?: string;
  typeCodeLOINC?: string | null;
  typeCodeIsSampleDerived?: boolean;
  documentTemplateIds?: {
    oid?: string;
    condition?: string | null;
    derivedFrom?: string | null;
    source?: { pageTitle?: string | null; quote?: string | null } | null;
  }[];
  golden?: { file?: string } | null;
}

interface CdaPin {
  value: string;
  basis: "spec" | "sample";
  source?: string;
}

interface CdaProfile {
  s: MessageStructure;
  templateIds: CdaPin[];
  typeCode: CdaPin | null;
  bodyKind: "structuredBody" | "nonXMLBody";
  sections: Set<string>;
}

function cdaCatalogue(inputs: DetectInputs): Map<string, CdaCatalogueEntry[]> {
  const byUseCase = new Map<string, CdaCatalogueEntry[]>();
  const cda = (inputs.structures.rules?.cda as { documentTypes?: unknown } | undefined)?.documentTypes;
  if (!Array.isArray(cda)) return byUseCase;
  for (const raw of cda as CdaCatalogueEntry[]) {
    // The catalogue names document types, not use cases; the official sample each row cites
    // is the join, because the manifest lists the same file under exactly one use case.
    const file = raw.golden?.file?.replace(/^spec-source\//, "");
    if (!file) continue;
    const owner = inputs.manifest.useCases.find((u) => u.goldenSamples.includes(file));
    if (!owner) continue;
    byUseCase.set(owner.id, [...(byUseCase.get(owner.id) ?? []), raw]);
  }
  return byUseCase;
}

function cdaProfileOf(s: MessageStructure, catalogue: Map<string, CdaCatalogueEntry[]>): CdaProfile {
  const env = s.envelope?.kind === "cdaDocument" ? s.envelope : null;
  const templateIds: CdaPin[] = [];
  let typeCode: CdaPin | null = null;
  if (env?.documentTemplateId) {
    templateIds.push({ value: env.documentTemplateId, basis: "spec", ...(env.specPage?.pageTitle ? { source: env.specPage.pageTitle } : {}) });
  }
  if (env?.typeCode) {
    typeCode = { value: env.typeCode, basis: "spec", ...(env.specPage?.pageTitle ? { source: env.specPage.pageTitle } : {}) };
  }
  for (const entry of catalogue.get(s.useCaseId) ?? []) {
    for (const t of entry.documentTemplateIds ?? []) {
      if (!t.oid || templateIds.some((x) => x.value === t.oid)) continue;
      const sampleOnly = Boolean(t.derivedFrom);
      templateIds.push({
        value: t.oid,
        basis: sampleOnly ? "sample" : "spec",
        ...(sampleOnly ? { source: entry.golden?.file?.replace(/^spec-source\//, "") } : t.source?.pageTitle ? { source: t.source.pageTitle } : {}),
      });
    }
    if (!typeCode && entry.typeCodeLOINC) {
      typeCode = {
        value: entry.typeCodeLOINC,
        basis: entry.typeCodeIsSampleDerived ? "sample" : "spec",
        ...(entry.typeCodeIsSampleDerived && entry.golden?.file ? { source: entry.golden.file.replace(/^spec-source\//, "") } : {}),
      };
    }
  }
  let bodyKind: CdaProfile["bodyKind"] = "structuredBody";
  const sections = new Set<string>();
  walkStructure(s, (m) => {
    if (locatorPath(m)?.includes("nonXMLBody")) bodyKind = "nonXMLBody";
    if (m.kind === "section") for (const id of m.templateIds) sections.add(id);
  });
  return { s, templateIds, typeCode, bodyKind, sections };
}

function detectCda(text: string, pool: MessageStructure[], inputs: DetectInputs): Verdict {
  const scan = scanCda(text);
  if (!scan.rootFound) {
    return none("The XML's document element is not ClinicalDocument, so it is not a CDA document (and neither a SOAP Envelope nor a SAML Response was found).");
  }
  const catalogue = cdaCatalogue(inputs);
  const profiles = pool.filter((s) => s.encoding === "cda-xml").map((s) => cdaProfileOf(s, catalogue));

  const docIds = scan.docTemplateIds.map((t) => t.root);
  const msgCode = scan.code?.code ?? null;
  const sectionIds = new Set(scan.sectionTemplateIds.map((t) => t.root));

  // Body kind is decisive where the structures differ on it (radiology results: structured
  // vs embedded PDF), so an incompatible structure is out before anything else is weighed.
  const compatible = scan.body ? profiles.filter((p) => p.bodyKind === scan.body!.kind) : profiles;
  const bodyEvidence = (p: CdaProfile): DetectEvidence[] =>
    scan.body && profiles.some((q) => q.s.useCaseId === p.s.useCaseId && q.bodyKind !== p.bodyKind)
      ? [
          evidence(text, {
            field: "ClinicalDocument/component body kind vs the structure's body",
            expected: p.bodyKind,
            fragment: scan.body.tag.raw,
            offset: scan.body.tag.offset,
            basis: "spec",
          }),
        ]
      : [];

  const templateEvidence = (p: CdaProfile): { evidence: DetectEvidence; basis: "spec" | "sample" } | null => {
    for (const pin of p.templateIds) {
      const hit = scan.docTemplateIds.find((t) => t.root === pin.value);
      if (!hit) continue;
      return {
        basis: pin.basis,
        evidence: evidence(text, {
          field: "ClinicalDocument/templateId/@root vs the document templateId the spec pins",
          expected: pin.value,
          fragment: hit.tag.raw,
          offset: hit.tag.offset,
          basis: pin.basis,
          ...(pin.source ? { source: pin.source } : {}),
        }),
      };
    }
    return null;
  };
  const codeEvidence = (p: CdaProfile): DetectEvidence | null => {
    if (!scan.code || !p.typeCode || p.typeCode.value !== scan.code.code) return null;
    return evidence(text, {
      field: "ClinicalDocument/code/@code vs the LOINC document type the spec pins",
      expected: p.typeCode.value,
      fragment: scan.code.tag.raw,
      offset: scan.code.tag.offset,
      basis: p.typeCode.basis,
      ...(p.typeCode.source ? { source: p.typeCode.source } : {}),
    });
  };

  // Identity by document templateId — unique per use case wherever one is stated.
  const byTemplate = compatible.filter((p) => templateEvidence(p) !== null);
  if (byTemplate.length) {
    const groups = groupBy(byTemplate, (p) => p.s.useCaseId);
    const candidates: DetectCandidate[] = [];
    for (const group of groups.values()) {
      const base = (p: CdaProfile) => {
        const t = templateEvidence(p)!;
        const code = codeEvidence(p);
        const caveats = t.basis === "sample" ? ["No published page states this document templateId; it is read off the official sample named in the evidence."] : [];
        return { evidence: [t.evidence, ...(code ? [code] : []), ...bodyEvidence(p)], grade: (t.basis === "sample" ? "probable" : "certain") as DetectGrade, caveats };
      };
      candidates.push(...resolveVariants(text, group, scan, sectionIds, base));
    }
    return { reason: null, candidates };
  }

  // Identity by LOINC code alone. Shared codes (11369-6, 57832-8) fall to section templateIds.
  const byCode = compatible.filter((p) => codeEvidence(p) !== null);
  if (!byCode.length) {
    const known = uniq(profiles.flatMap((p) => (p.typeCode ? [p.typeCode.value] : [])));
    const excluded = profiles.length - compatible.length;
    return none(
      `ClinicalDocument carries templateId root(s) ${docIds.length ? quoteList(docIds) : "(none)"} and code ${msgCode ? `"${msgCode}"` : "(none)"}; no compiled CDA document type pins either. Compiled LOINC document codes: ${known.join(", ")}.` +
        (excluded ? ` ${excluded} structure(s) were also excluded because their body kind is not ${scan.body!.kind}.` : ""),
    );
  }
  const groups = groupBy(byCode, (p) => p.s.useCaseId);
  const unknownTemplateCaveat = docIds.length
    ? [`ClinicalDocument/templateId root(s) ${quoteList(docIds)} are not ones the spec pins for any document type; the match rests on the LOINC code.`]
    : ["ClinicalDocument carries no templateId, so the match rests on the LOINC code."];

  if (groups.size === 1) {
    const [group] = [...groups.values()];
    return {
      reason: null,
      candidates: resolveVariants(text, group, scan, sectionIds, (p) => ({
        evidence: [codeEvidence(p)!, ...bodyEvidence(p)],
        grade: "probable",
        caveats: unknownTemplateCaveat,
      })),
    };
  }

  // Two use cases share the code: a section templateId that only one of them compiles wins.
  const unionOf = (others: CdaProfile[][]) => new Set(others.flat().flatMap((p) => [...p.sections]));
  const groupList = [...groups.entries()];
  const exclusiveHits = new Map<string, { root: string; tag: XmlTag }[]>();
  for (const [useCaseId, group] of groupList) {
    const others = unionOf(groupList.filter(([id]) => id !== useCaseId).map(([, g]) => g));
    const own = new Set(group.flatMap((p) => [...p.sections]));
    exclusiveHits.set(
      useCaseId,
      scan.sectionTemplateIds.filter((t) => own.has(t.root) && !others.has(t.root)),
    );
  }
  const winners = groupList.filter(([id]) => exclusiveHits.get(id)!.length > 0);
  // Named at use-case level: the sharers are document types, not the variant that happens
  // to head each group.
  const useCaseTitle = (id: string) => inputs.manifest.useCases.find((u) => u.id === id)?.title ?? id;
  const sharers = groupList.map(([id]) => useCaseTitle(id)).join(" and ");
  const candidates: DetectCandidate[] = [];
  for (const [useCaseId, group] of groupList) {
    const hits = exclusiveHits.get(useCaseId)!;
    const won = winners.length === 1 && hits.length > 0;
    const caveats = won
      ? [...unknownTemplateCaveat, `LOINC code "${msgCode}" is shared by ${sharers}; the section templateId(s) below are compiled only for this one.`]
      : [
          ...unknownTemplateCaveat,
          winners.length === 0
            ? `LOINC code "${msgCode}" is shared by ${sharers}, and no section templateId in the message is compiled for only one of them.`
            : winners.length > 1
              ? `LOINC code "${msgCode}" is shared by ${sharers}, and the message carries sections compiled exclusively for more than one of them.`
              : `LOINC code "${msgCode}" is shared by ${sharers}; the message carries section templateId(s) compiled only for the other one.`,
        ];
    candidates.push(
      ...resolveVariants(text, group, scan, sectionIds, (p) => ({
        evidence: [
          codeEvidence(p)!,
          ...hits.filter((h) => p.sections.has(h.root)).slice(0, 3).map((h) =>
            evidence(text, {
              field: "section/templateId/@root vs a section templateId compiled only for this document type",
              expected: h.root,
              fragment: h.tag.raw,
              offset: h.tag.offset,
              basis: "spec",
            }),
          ),
          ...bodyEvidence(p),
        ],
        grade: won ? "probable" : "possible",
        caveats,
      })),
    );
  }
  return { reason: null, candidates };
}

function groupBy<T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) out.set(key(x), [...(out.get(key(x)) ?? []), x]);
  return out;
}

/**
 * Settle the variants of one CDA use case once the use case itself is known.
 *
 * Full vs NoInfo: the compiled NoInfo structure appends to every section one extra
 * templateId, the section's own nphies OID with ".1" suffixed (see the structure's notes),
 * and the Full structure carries none of those. So the NoInfo-only templateIds present in the
 * message decide: on every section -> NoInfo; on none -> Full, by absence, hence `probable`
 * at best; on some -> neither shape fits and both are returned at `possible`.
 *
 * Structures whose section sets do not differ (or single-structure use cases) pass through.
 */
function resolveVariants(
  text: string,
  group: CdaProfile[],
  scan: CdaHeaderScan,
  sectionIds: Set<string>,
  base: (p: CdaProfile) => { evidence: DetectEvidence[]; grade: DetectGrade; caveats: string[] },
): DetectCandidate[] {
  const lower = (g: DetectGrade, floor: DetectGrade): DetectGrade => (GRADE_RANK[g] > GRADE_RANK[floor] ? g : floor);
  if (group.length === 1) {
    const b = base(group[0]);
    return [candidate(group[0].s, b.grade, b.evidence, b.caveats)];
  }
  const exclusive = new Map<string, Set<string>>();
  for (const p of group) {
    const others = new Set(group.filter((q) => q !== p).flatMap((q) => [...q.sections]));
    exclusive.set(p.s.id, new Set([...p.sections].filter((id) => !others.has(id))));
  }
  const withHits = group.filter((p) => [...exclusive.get(p.s.id)!].some((id) => sectionIds.has(id)));
  const subset = group.filter((p) => exclusive.get(p.s.id)!.size === 0);

  if (withHits.length === 1) {
    const p = withHits[0];
    const marks = scan.sectionTemplateIds.filter((t) => exclusive.get(p.s.id)!.has(t.root));
    const b = base(p);
    const markerEvidence = marks.slice(0, 3).map((t) =>
      evidence(text, {
        field: "section/templateId/@root vs a section templateId compiled only for this variant",
        expected: t.root,
        fragment: t.tag.raw,
        offset: t.tag.offset,
        basis: "spec",
      }),
    );
    if (marks.length >= scan.sectionCount) {
      return [candidate(p.s, b.grade, [...b.evidence, ...markerEvidence], b.caveats)];
    }
    // Some sections carry the marker and some do not: neither the Full nor the NoInfo shape.
    const mixed = `${marks.length} of ${scan.sectionCount} sections carry a templateId compiled only for ${p.s.variantLabel ?? p.s.variant ?? p.s.title}; the rest carry none. A ${p.s.variantLabel ?? p.s.variant} document carries one on every section and the other variant on no section.`;
    return group.map((q) => {
      const bq = base(q);
      return candidate(q.s, "possible", q === p ? [...bq.evidence, ...markerEvidence] : bq.evidence, [...bq.caveats, mixed]);
    });
  }
  if (withHits.length === 0 && subset.length === 1) {
    const p = subset[0];
    const b = base(p);
    const alternatives = group.filter((q) => q !== p).map((q) => q.s.variantLabel ?? q.s.variant ?? q.s.title);
    const sample = [...exclusive.get(group.find((q) => q !== p)!.s.id)!][0];
    return [
      candidate(p.s, lower(b.grade, "probable"), b.evidence, [
        ...b.caveats,
        scan.sectionCount
          ? `Chosen because none of the ${scan.sectionCount} sections carries a templateId compiled only for ${alternatives.join(" / ")} (e.g. ${sample}).`
          : `Chosen by absence: the document has no sections, so nothing marks it as ${alternatives.join(" / ")}.`,
      ]),
    ];
  }
  const why =
    withHits.length > 1
      ? `The message carries section templateIds compiled exclusively for more than one variant (${withHits.map((p) => p.s.variantLabel ?? p.s.variant ?? p.s.title).join(", ")}).`
      : "The variants of this document type cannot be told apart from the section templateIds present.";
  return group.map((p) => {
    const b = base(p);
    return candidate(p.s, "possible", b.evidence, [...b.caveats, why]);
  });
}

/* ========================================================================== *
 * SOAP — wsa:Action, unique across the five XDS structures
 * ========================================================================== */

function detectSoap(text: string, pool: MessageStructure[]): Verdict {
  const soap = pool.filter((s) => s.envelope?.kind === "soapEnvelope");
  const tags = xmlTags(text);
  const actionTag = tags.find((t) => t.local === "Action" && !t.closing && !t.selfClosing);
  if (!actionTag) {
    return none("The SOAP Envelope carries no WS-Addressing Action element, and wsa:Action is what names an XDS transaction.");
  }
  const start = actionTag.offset + actionTag.raw.length;
  const end = text.indexOf("<", start);
  const rawAction = text.slice(start, end < 0 ? undefined : end);
  const action = rawAction.trim();
  const declared = uniq(soap.map((s) => (s.envelope as { wsAddressingAction: string | null }).wsAddressingAction ?? "").filter(Boolean));
  const hits = soap.filter((s) => s.envelope?.kind === "soapEnvelope" && s.envelope.wsAddressingAction === action);
  if (!hits.length) {
    return none(`wsa:Action is "${action}", which none of the ${soap.length} compiled SOAP structures declares. Declared actions: ${declared.join(", ")}.`);
  }
  const offset = start + rawAction.indexOf(action);
  return {
    reason: null,
    candidates: hits.map((s) =>
      candidate(s, "certain", [
        evidence(text, {
          field: "wsa:Action vs envelope.soapEnvelope.wsAddressingAction",
          expected: action,
          fragment: action,
          offset,
          basis: "spec",
        }),
      ]),
    ),
  };
}

/* ========================================================================== *
 * SAML — root element and its namespace
 * ========================================================================== */

function detectSaml(text: string, pool: MessageStructure[]): Verdict {
  const saml = pool.filter((s) => s.envelope?.kind === "samlResponse");
  const root = xmlTags(text).find((t) => !t.closing);
  if (!root) return none("No XML element was found.");
  const declaredNs = new Map<string | null, string>();
  for (const m of root.attrs.matchAll(/xmlns(?::([\w.-]+))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    declaredNs.set(m[1] ?? null, m[2] ?? m[3] ?? "");
  }
  const rootNs = declaredNs.get(root.prefix) ?? null;

  const hits: { s: MessageStructure; expectedRoot: string; expectedNs: string }[] = [];
  for (const s of saml) {
    if (s.envelope?.kind !== "samlResponse" || !s.envelope.rootElement) continue;
    const [prefix, local] = s.envelope.rootElement.includes(":") ? s.envelope.rootElement.split(":") : [null, s.envelope.rootElement];
    const ns = s.envelope.namespaces.find((n) => n.prefix === prefix)?.uri ?? null;
    const nsMatches = ns === null || rootNs === ns || [...declaredNs.values()].includes(ns);
    if (root.local === local && nsMatches) hits.push({ s, expectedRoot: s.envelope.rootElement, expectedNs: ns ?? "(no namespace pinned)" });
  }
  if (!hits.length) {
    const roots = uniq(saml.map((s) => (s.envelope as { rootElement: string | null }).rootElement ?? "").filter(Boolean));
    return none(`The document element is <${root.prefix ? `${root.prefix}:` : ""}${root.local}> in namespace ${rootNs ? `"${rootNs}"` : "(none)"}; the compiled SAML structure expects ${roots.join(" or ")}.`);
  }
  return {
    reason: null,
    candidates: hits.map(({ s, expectedRoot, expectedNs }) =>
      candidate(s, "certain", [
        evidence(text, {
          field: "document element and its namespace vs envelope.samlResponse.rootElement / namespaces",
          expected: `${expectedRoot} in ${expectedNs}`,
          fragment: root.raw,
          offset: root.offset,
          basis: "spec",
        }),
      ]),
    ),
  };
}
