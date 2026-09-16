/**
 * Advisory — what a model may say, shaped so that it can NEVER be a Finding.
 *
 * The product's founding rule is that a confidently wrong structural verdict is worse than an
 * acknowledged unknown, and a model is the one component here that can be confidently wrong
 * at scale. So the boundary is enforced by the type system rather than by discipline: an
 * `Advisory` has no `severity`, no `provenance`, no `code`, no `location` and no `path`.
 * `summarise()`, `sortFindings()`, `toUiFinding()` and `adaptMessage()` all take `Finding`,
 * and `tests/fixtures/advisory-is-not-a-finding.ts` proves that handing them an Advisory does
 * not compile. There is no adapter in the other direction, and there must never be one: the
 * only way a proposal becomes a verdict is a human clicking `declare-condition`, after which
 * `analyse(text, structure, resolved, { conditions: [c] })` and `check()` emit the finding.
 *
 * Every claim is verified against what was actually sent before it is shown:
 *   - each quote must be a verbatim substring of the payload;
 *   - each rule id must be in the closed list the caller supplied;
 *   - a cited line must be one the skeleton mentions;
 *   - an action must pick from the closed option list the gap offered.
 * Anything that fails is dropped and COUNTED — the count is shown, so a review that lost
 * half its claims is visibly less trustworthy than one that lost none.
 *
 * Imports nothing from the engine but types, and never the SDK.
 */

/* ========================================================================== *
 * The type
 * ========================================================================== */

export type AdvisoryKind = "second-opinion" | "gap-proposal" | "code-mapping" | "column-mapping";

/** Deliberately NOT named `confidence`: that word is reserved for compiled-spec evidence. */
export type ModelConfidence = "high" | "medium" | "low";

export type AdvisoryAction =
  | { readonly type: "declare-condition"; readonly condition: string }
  | { readonly type: "switch-structure"; readonly structureId: string }
  | { readonly type: "copy-code"; readonly code: string };

export interface Advisory {
  readonly source: "model";
  readonly kind: AdvisoryKind;
  readonly id: string;
  /** The model id that produced it, verbatim from the response. */
  readonly model: string;
  readonly about: {
    readonly findingId?: string;
    readonly gapId?: string;
    readonly specNodeId?: string;
    readonly memberId?: string;
    /** A source line the skeleton mentions, or `null` when the claim is not about a place. */
    readonly line?: number | null;
  };
  /** For a second opinion on a finding: what the model concluded about it. */
  readonly verdict?: "agree" | "doubt" | "cannot-tell";
  readonly claim: string;
  readonly reasoning: string;
  readonly modelConfidence: ModelConfidence;
  /** Verified verbatim substrings of what was sent. Never empty. */
  readonly quotes: readonly string[];
  /** Verified against the closed rule list. */
  readonly ruleIds: readonly string[];
  readonly action?: AdvisoryAction;
  /** Digest of the exact payload that was sent, so a claim can be tied to its input. */
  readonly inputDigest: string;
  /** How many sibling claims in the same response failed verification. */
  readonly dropped: number;
}

/* ========================================================================== *
 * Raw (unverified) shape
 * ========================================================================== */

/** What an adapter over the model's parsed output produces BEFORE verification. */
export interface RawAdvisory {
  readonly kind: AdvisoryKind;
  readonly about: Advisory["about"];
  readonly verdict?: Advisory["verdict"];
  readonly claim: string;
  readonly reasoning: string;
  readonly modelConfidence: ModelConfidence;
  readonly quotes: readonly string[];
  readonly ruleIds: readonly string[];
  readonly action?: AdvisoryAction;
}

export type DropReason =
  | "no-quote"
  | "quote-not-verbatim"
  | "unknown-rule-id"
  | "line-not-in-skeleton"
  | "unknown-finding-id"
  | "unknown-gap-id"
  | "action-not-offered"
  | "rule-not-offered"
  | "empty-claim";

export interface DroppedAdvisory {
  readonly reason: DropReason;
  readonly raw: RawAdvisory;
  readonly detail: string;
}

/** Everything the verifier needs to know about what was sent. */
export interface SentContext {
  /** The EXACT text that went to the model, all blocks concatenated. */
  readonly payload: string;
  readonly model: string;
  readonly digest: string;
  /** Closed rule list: spec node ids / member ids the model was shown. */
  readonly ruleIds: ReadonlySet<string>;
  /** Source lines the skeleton mentions. A claim citing any other line is fabricated. */
  readonly lines?: ReadonlySet<number>;
  /** Finding ids that were sent, when reviewing findings. */
  readonly findingIds?: ReadonlySet<string>;
  /** Per gap id, the actions it offered; a proposal may only choose from these. */
  readonly offeredActions?: ReadonlyMap<string, readonly AdvisoryAction[]>;
  /** Per gap id, the rule ids it offered; a proposal naming a rule must pick one of them. */
  readonly offeredRuleIds?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface Validated {
  readonly advisories: readonly Advisory[];
  readonly dropped: readonly DroppedAdvisory[];
}

/* ========================================================================== *
 * Verification
 * ========================================================================== */

const norm = (s: string) => s.replace(/\r\n|\r/g, "\n");

/** Is `quote` verbatim in the payload? Whitespace is compared exactly; only newlines are unified. */
export function isVerbatim(payload: string, quote: string): boolean {
  const qn = norm(quote);
  return qn.trim().length > 0 && norm(payload).includes(qn);
}

export function sameAction(a: AdvisoryAction, b: AdvisoryAction): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "declare-condition":
      return a.condition === (b as typeof a).condition;
    case "switch-structure":
      return a.structureId === (b as typeof a).structureId;
    case "copy-code":
      return a.code === (b as typeof a).code;
  }
}

/**
 * Verify a batch of raw claims against what was sent.
 *
 * A dropped claim is not an error: it is the expected outcome for a model that paraphrased a
 * quote or reached for a rule it was not shown. The batch's drop count is stamped on every
 * surviving advisory so the UI can say "3 of 7 claims did not verify" next to the ones it
 * shows.
 */
export function validateAdvisories(raw: readonly RawAdvisory[], sent: SentContext): Validated {
  const dropped: DroppedAdvisory[] = [];
  const kept: Omit<Advisory, "dropped">[] = [];

  raw.forEach((r, i) => {
    const fail = (reason: DropReason, detail: string): void => {
      dropped.push({ reason, raw: r, detail });
    };

    if (!r.claim || !r.claim.trim()) return fail("empty-claim", "claim is empty");
    if (!r.quotes.length) return fail("no-quote", "a claim must quote the fragment it rests on");
    const bad = r.quotes.find((quote) => !isVerbatim(sent.payload, quote));
    if (bad !== undefined) return fail("quote-not-verbatim", `not in the payload: ${JSON.stringify(bad.slice(0, 120))}`);

    const unknownRule = r.ruleIds.find((id) => !sent.ruleIds.has(id));
    if (unknownRule !== undefined) return fail("unknown-rule-id", `rule id not in the closed list: ${unknownRule}`);

    const line = r.about.line;
    if (line !== undefined && line !== null) {
      if (!Number.isInteger(line) || !sent.lines || !sent.lines.has(line)) {
        return fail("line-not-in-skeleton", `line ${String(line)} is not one the skeleton shows`);
      }
    }
    if (r.about.findingId !== undefined && sent.findingIds && !sent.findingIds.has(r.about.findingId)) {
      return fail("unknown-finding-id", `finding ${r.about.findingId} was not sent`);
    }
    if (r.about.gapId !== undefined && sent.offeredActions && !sent.offeredActions.has(r.about.gapId)) {
      return fail("unknown-gap-id", `gap ${r.about.gapId} was not sent`);
    }
    if (r.about.gapId !== undefined && sent.offeredRuleIds && r.ruleIds.length) {
      const offered = sent.offeredRuleIds.get(r.about.gapId);
      const stray = r.ruleIds.find((id) => !offered || !offered.has(id));
      if (stray !== undefined) return fail("rule-not-offered", `rule ${stray} is not one the gap offered`);
    }
    if (r.action) {
      const offered = r.about.gapId !== undefined ? sent.offeredActions?.get(r.about.gapId) : undefined;
      if (!offered || !offered.some((o) => sameAction(o, r.action as AdvisoryAction))) {
        return fail("action-not-offered", `action ${JSON.stringify(r.action)} is not one the gap offered`);
      }
    }

    kept.push({
      source: "model",
      kind: r.kind,
      id: `${r.kind}:${sent.digest.slice(0, 12)}:${i}`,
      model: sent.model,
      about: { ...r.about },
      ...(r.verdict ? { verdict: r.verdict } : {}),
      claim: r.claim.trim(),
      reasoning: r.reasoning?.trim() ?? "",
      modelConfidence: r.modelConfidence,
      quotes: [...r.quotes],
      ruleIds: [...r.ruleIds],
      ...(r.action ? { action: r.action } : {}),
      inputDigest: sent.digest,
    });
  });

  const advisories: Advisory[] = kept.map((a) => ({ ...a, dropped: dropped.length }));
  return { advisories, dropped };
}

/* ========================================================================== *
 * Digest
 * ========================================================================== */

/**
 * A stable string hash (FNV-1a, 64 bits as two 32-bit lanes). No `Date.now()`, no random:
 * the same payload always digests the same, which is what lets a stored advisory be matched
 * back to the exact input it was made from, and what keeps tests deterministic.
 */
export function stableHash(payload: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x9747b28c;
  for (let i = 0; i < payload.length; i++) {
    const c = payload.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/**
 * SHA-256 of the payload where Web Crypto is available (browsers, modern Node), else the
 * stable hash. Both are deterministic; the prefix says which one it is.
 */
export async function digestOf(payload: string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle && typeof TextEncoder !== "undefined") {
    try {
      const bytes = new TextEncoder().encode(payload);
      const hash = await subtle.digest("SHA-256", bytes);
      return "sha256:" + Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      // Fall through: some sandboxes expose `subtle` and then refuse to digest.
    }
  }
  return "fnv:" + stableHash(payload);
}
