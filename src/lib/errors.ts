/**
 * The NPHIES error catalogue, and the decoder that maps a rejection back onto the message.
 *
 * The Error Handling Guide's 38 tables are compiled into `src/spec/errors.json`. What an
 * integrator has is a rejection string; what they need is the position in their message that
 * caused it. This module does that lookup and NEVER guesses: a match reports how it was made
 * (an exact signature, a code, or overlapping keywords) and a weak match says it is weak.
 */

import { loadErrors } from "./structure";

export interface ErrorLocator {
  kind: string;
  value: string;
  verbatimInRow?: boolean;
}

export interface ErrorSource {
  pageId?: string | null;
  pageTitle?: string | null;
  row?: string | null;
  quote?: string | null;
}

export interface ErrorEntry {
  id: string;
  title?: string | null;
  code?: string | null;
  chapter?: string | null;
  sectionTitle?: string | null;
  family?: string | null;
  familyConfidence?: string | null;
  description?: string | null;
  possibleCause?: string | null;
  recommendation?: string | null;
  sample?: string | null;
  note?: string | null;
  ref?: string | null;
  keywords?: string[];
  locators?: ErrorLocator[];
  oidsMentioned?: string[];
  source?: ErrorSource | null;
  /** XDS entries only. */
  condition?: string | null;
  transaction?: string | null;
  codeSpellingNote?: string | null;
}

export interface ErrorCatalogue {
  entries: ErrorEntry[];
  xds: ErrorEntry[];
  ackCodes: {
    code: string;
    name?: string | null;
    field?: string | null;
    meaning?: string | null;
    meaningIsInferred?: boolean;
    source?: ErrorSource | null;
  }[];
  signatures: { entryId: string; family?: string | null; pattern: string }[];
  tokens: Record<string, string[]>;
  operationOutcome: Record<string, unknown>;
  stats: Record<string, unknown>;
  byId: Map<string, ErrorEntry>;
}

let cataloguePromise: Promise<ErrorCatalogue> | null = null;

export function loadErrorCatalogue(): Promise<ErrorCatalogue> {
  if (!cataloguePromise) {
    cataloguePromise = loadErrors().then((raw) => {
      const bundle = raw as unknown as {
        errors?: ErrorEntry[];
        xds?: ErrorEntry[];
        ackCodes?: ErrorCatalogue["ackCodes"];
        searchIndex?: { signatures?: ErrorCatalogue["signatures"]; tokens?: Record<string, string[]> };
        operationOutcome?: Record<string, unknown>;
        stats?: Record<string, unknown>;
      };
      const entries = bundle.errors ?? [];
      const xds = bundle.xds ?? [];
      const byId = new Map<string, ErrorEntry>();
      for (const e of [...entries, ...xds]) byId.set(e.id, e);
      return {
        entries,
        xds,
        ackCodes: bundle.ackCodes ?? [],
        signatures: bundle.searchIndex?.signatures ?? [],
        tokens: bundle.searchIndex?.tokens ?? {},
        operationOutcome: bundle.operationOutcome ?? {},
        stats: bundle.stats ?? {},
        byId,
      };
    });
  }
  return cataloguePromise;
}

/* ------------------------------------------------------------------ decode */

export type MatchKind = "signature" | "code" | "keywords";

export interface ErrorMatch {
  entry: ErrorEntry;
  kind: MatchKind;
  /** 0..1. Only a signature or a code match ever reaches 1. */
  score: number;
  /** What in the pasted text produced the match — shown, never implied. */
  evidence: string;
}

const STOP = new Set([
  "the", "and", "for", "with", "this", "that", "from", "not", "was", "are", "has", "have", "must",
  "error", "errors", "invalid", "value", "values", "field", "fields", "message", "please", "your",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.:/[\]-]+/)
    .map((w) => w.replace(/^[.:/-]+|[.:/-]+$/g, ""))
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** A compiled signature becomes a regex with `{value}` standing for anything volatile. */
function signatureRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.split("\\{value\\}").join("[\\s\\S]{1,120}?"), "i");
}

/**
 * Decode a pasted NPHIES rejection.
 *
 * Ranked: an exact signature from the Error Handling Guide first, then a literal error code,
 * then keyword overlap. Keyword matches are capped below 0.6 and labelled, because sharing
 * three words with a catalogue row is a lead, not an identification.
 */
export function decodeRejection(text: string, catalogue: ErrorCatalogue, limit = 12): ErrorMatch[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const haystack = trimmed.toLowerCase();
  const matches = new Map<string, ErrorMatch>();

  const add = (match: ErrorMatch) => {
    const existing = matches.get(match.entry.id);
    if (!existing || existing.score < match.score) matches.set(match.entry.id, match);
  };

  for (const sig of catalogue.signatures) {
    const entry = catalogue.byId.get(sig.entryId);
    if (!entry) continue;
    const re = signatureRegex(sig.pattern);
    const hit = re.exec(trimmed);
    if (hit) {
      add({
        entry,
        kind: "signature",
        score: 1,
        evidence: hit[0].replace(/\s+/g, " ").slice(0, 160),
      });
    }
  }

  for (const entry of [...catalogue.xds, ...catalogue.entries]) {
    const code = entry.code;
    if (!code) continue;
    const at = haystack.indexOf(code.toLowerCase());
    if (at >= 0) add({ entry, kind: "code", score: 0.95, evidence: trimmed.slice(at, at + code.length) });
  }

  const pasted = new Set(words(trimmed));
  if (pasted.size) {
    const counts = new Map<string, string[]>();
    for (const word of pasted) {
      for (const id of catalogue.tokens[word] ?? []) {
        const list = counts.get(id);
        if (list) list.push(word);
        else counts.set(id, [word]);
      }
    }
    for (const [id, hits] of counts) {
      const entry = catalogue.byId.get(id);
      if (!entry) continue;
      const denominator = Math.max(3, entry.keywords?.length ?? 3);
      const score = Math.min(0.55, (hits.length / denominator) * 0.55 + hits.length * 0.02);
      if (hits.length >= 2) {
        add({ entry, kind: "keywords", score, evidence: hits.slice(0, 6).join(", ") });
      }
    }
  }

  return [...matches.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Catalogue entries whose locator names a position in the message, for cross-linking. */
export function locatorsOf(entry: ErrorEntry): string[] {
  return (entry.locators ?? []).map((l) => l.value).filter(Boolean);
}

/** Plain-text search over the whole catalogue, for browsing rather than decoding. */
export function searchCatalogue(query: string, catalogue: ErrorCatalogue): ErrorEntry[] {
  const q = query.trim().toLowerCase();
  const all = [...catalogue.entries, ...catalogue.xds];
  if (!q) return all;
  return all.filter((e) =>
    [e.id, e.title, e.code, e.chapter, e.description, e.possibleCause, e.recommendation, e.sample, e.condition]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(q)),
  );
}
