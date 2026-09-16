/**
 * Optional AI assistance — bring your own Anthropic key.
 *
 * Four rules this module exists to enforce:
 *
 *  1. **The workbench works without it.** Every structural verdict comes from the compiled
 *     spec and `check()`. Nothing here is ever consulted to decide whether a message is
 *     conformant. What a model returns is an {@link Advisory} — a type with no severity, no
 *     provenance, no code and no location, which `summarise()`/`sortFindings()` reject at
 *     compile time (`tests/fixtures/advisory-is-not-a-finding.ts`). The only way a proposal
 *     becomes a verdict is a human clicking `declare-condition`, after which the VIEW re-runs
 *     `analyse(text, structure, resolved, { conditions: [c] })` and `check()` emits the finding.
 *  2. **The document never leaves the browser.** An 87 KB CDA is ~24,700 tokens and is full of
 *     patient data, so no call here ever sends message text. Calls send the redacted
 *     {@link Skeleton} (`skeleton.ts`), redacted findings ({@link redactFinding}) and the
 *     compiled rule list. {@link payloadPreview} returns the EXACT text that would go, so the
 *     UI can show it and its size before the first call.
 *  3. **The key stays in the browser.** A static page has no server to hide a key behind, so
 *     the user supplies their own, it lives in `localStorage`, and it is sent only to Anthropic.
 *  4. **Answers are typed and verified.** Every call goes through `messages.parse()` with a Zod
 *     schema, and every claim then passes {@link validateAdvisories}: quotes must be verbatim
 *     substrings of the payload, rule ids must be in the closed list, lines must be ones the
 *     skeleton shows. What fails is dropped and counted, never rendered as fact.
 *
 * Things deliberately NOT here: any judgement on the Raqeeb/uncontrolled-medication tie (a
 * clinical decision on patient data), membership checks against NHIC-hosted value sets (the
 * value set is the authority, not a model's memory), numeric detection probabilities, and any
 * path that applies an advisory without a click.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Finding, FindingCode } from "./check";
import type { MessageStructure, SpecNode } from "./structure";
import { formatLocator } from "./structure";
import type { Skeleton } from "./skeleton";
import { estimateTokens } from "./skeleton";
import { digestOf, validateAdvisories } from "./advisory";
import type { Advisory, AdvisoryAction, DroppedAdvisory, ModelConfidence, RawAdvisory, SentContext } from "./advisory";
import type { Gap } from "./gaps";
import { actionsOf } from "./gaps";

export { estimateTokens };
export type { Advisory, DroppedAdvisory, ModelConfidence };

export const AI_MODEL = "claude-opus-5";

export class MissingKeyError extends Error {
  constructor() {
    super("No Anthropic API key is stored in this browser.");
    this.name = "MissingKeyError";
  }
}

/**
 * Load the SDK and build a client.
 *
 * Imported dynamically so the ~200KB SDK is fetched only when someone actually asks for an
 * explanation. A hospital analyst checking a message structure — which is everything the
 * workbench is for — never downloads it at all.
 */
async function client(apiKey: string): Promise<{ anthropic: Anthropic; zodOutputFormat: typeof import("@anthropic-ai/sdk/helpers/zod").zodOutputFormat }> {
  if (!apiKey.trim()) throw new MissingKeyError();
  const [{ default: Anthropic }, { zodOutputFormat }] = await Promise.all([
    import("@anthropic-ai/sdk"),
    import("@anthropic-ai/sdk/helpers/zod"),
  ]);
  return {
    anthropic: new Anthropic({
      apiKey,
      // A static page has no backend to proxy through; the user's own key, in their own
      // browser, talking to Anthropic directly is the whole design.
      dangerouslyAllowBrowser: true,
    }),
    zodOutputFormat,
  };
}

/** Shared framing: what this assistant is for, and what it must never do. */
const SYSTEM = [
  "You help hospital integration engineers in Saudi Arabia onboard a HIS to NPHIES.",
  "A deterministic workbench has already decided what is structurally wrong with the message",
  "from the compiled NPHIES specification. You never re-judge that from memory; you review it",
  "against the evidence you are shown, and you make findings actionable on the HIS side.",
  "",
  "What you are shown:",
  "- A REDACTED structural skeleton of the message, never the full message. Every line starts",
  "  with its source line number (L12). A value shown as … was redacted because no rule pins it;",
  "  do not speculate about redacted values.",
  "- The compiled rule list for this message structure: rule id, position, usage and the",
  "  verbatim specification quote. Rule ids look like <pageId>:<table>:<row> or member ids.",
  "- Findings the workbench made, each with an id, code, and the line it points at.",
  "",
  "Rules:",
  "- You may only reference rule ids and line numbers that appear in what you were given.",
  "  A rule id you were not shown does not exist for this purpose; a line the skeleton does",
  "  not show cannot be cited.",
  "- Every claim must quote the fragment it rests on, verbatim, from what you were given.",
  "  Unquoted claims are discarded before anyone sees them.",
  "- Never invent a rule, OID, code, profile URL or field name. If the supplied evidence does",
  "  not settle something, say 'cannot-tell' or leave it unresolved instead of guessing.",
  "- Speak to an integration engineer: concrete, short, no marketing tone, no apologies.",
  "- Do not decide whether a medication is controlled (Raqeeb) or uncontrolled, and do not",
  "  assert value-set membership from memory: the value set file is the authority.",
].join("\n");

/* ========================================================================== *
 * Redaction of findings and rules — what a payload is made of
 * ========================================================================== */

/**
 * Codes whose `actual`/`expected` are structural values the spec pins or binds (an OID, a
 * bundle type, a code, a count). For every other code the value would be message content —
 * the flattened composite that carried a national id, the text an unknown element held.
 */
const STRUCTURAL_VALUE_CODES: ReadonlySet<FindingCode> = new Set<FindingCode>([
  "fixed-value-mismatch",
  "bundle-type-mismatch",
  "bundle-first-entry",
  "bundle-entry-resource-mismatch",
  "valueset-code-unknown",
  "valueset-code-case",
  "quarantined-oid",
  "cardinality-too-few",
  "cardinality-too-many",
]);

/** A finding with everything that could carry a message value removed. */
export interface RedactedFinding {
  readonly id: string;
  readonly code: FindingCode;
  readonly severity: Finding["severity"];
  readonly title: string;
  readonly detail: string;
  readonly path: string;
  readonly line: number | null;
  readonly specNodeId: string | null;
  readonly memberId: string | null;
  readonly expected?: string;
  readonly actual?: string;
  /** Condition strings of the usage rules in play, e.g. `["Report", "Order"]`. */
  readonly conditions: readonly string[];
  /**
   * Verbatim Confluence quote behind the rule. `null` for sample-derived rules: their "quote"
   * is a fragment of an official sample — possibly of THIS message — and a known-sample-defect's
   * evidence is literally the offending text, so it is not transported.
   */
  readonly quote: string | null;
  readonly independent: boolean;
}

/** Replace every double-quoted fragment and ` = "value"` tail with a placeholder. */
function stripQuoted(text: string): string {
  return text.replace(/ = "[^"]*"/g, ' = "…"').replace(/"[^"]*"/g, '"…"').replace(/“[^”]*”/g, "“…”");
}

/**
 * Redact one finding for transport.
 *
 * `actual`/`expected` survive only for {@link STRUCTURAL_VALUE_CODES}; everywhere else any
 * quoted fragment in the title or detail is blanked, which removes the `= "value"` an
 * `unknown-element` carries and whatever a parser diagnostic echoed.
 */
export function redactFinding(f: Finding): RedactedFinding {
  const structural = STRUCTURAL_VALUE_CODES.has(f.code);
  const out: RedactedFinding = {
    id: f.id,
    code: f.code,
    severity: f.severity,
    title: structural ? f.title : stripQuoted(f.title),
    detail: structural ? f.detail : stripQuoted(f.detail),
    path: f.path,
    line: f.location?.line ?? null,
    specNodeId: f.specNodeId,
    memberId: f.memberId ?? null,
    ...(structural && f.expected !== undefined ? { expected: f.expected } : {}),
    ...(structural && f.actual !== undefined ? { actual: f.actual } : {}),
    conditions: (f.rules ?? []).map((r) => r.condition).filter((c): c is string => Boolean(c && c.trim())),
    quote: f.provenance.pageId ? f.provenance.quote : null,
    independent: f.independent,
  };
  return out;
}

/** One compiled rule, as the model sees it. */
export interface RuleStub {
  /** Spec node id (`<pageId>:<table>:<row>`) — the closed vocabulary a claim may cite. */
  readonly id: string;
  readonly label: string;
  readonly where: string | null;
  /** e.g. `M`, `R2 (Report) / NP (Order)`. */
  readonly usage: string;
  readonly quote: string | null;
}

/**
 * Rule stubs from a resolved use case's spec nodes, sorted by id.
 *
 * Sorted so the rendered block is byte-identical across calls for the same structure — the
 * block carries `cache_control`, and a prefix cache is only as good as its stability.
 */
export function ruleStubsFrom(specNodes: ReadonlyMap<string, SpecNode>, max = 1500): RuleStub[] {
  const stubs: RuleStub[] = [];
  for (const node of specNodes.values()) {
    if (node.role === "container" && !node.usage.length) continue;
    stubs.push({
      id: node.id,
      label: node.label.replace(/\s+/g, " ").trim(),
      where: node.locator ? formatLocator(node.locator) : node.locatorRaw?.replace(/\s+/g, " ").trim() || null,
      usage: node.usage.map((u) => `${u.usage ?? "?"}${u.condition ? ` (${u.condition})` : ""}`).join(" / ") || "-",
      quote: node.provenance?.quote ? node.provenance.quote.replace(/\s+/g, " ").trim().slice(0, 160) : null,
    });
  }
  stubs.sort((a, b) => a.id.localeCompare(b.id));
  return stubs.slice(0, max);
}

function rulesBlock(structure: MessageStructure, rules: readonly RuleStub[]): string {
  return [
    `Compiled rules for ${structure.title} (${structure.id}, ${structure.encoding}). One per line:`,
    "ruleId | position | label | usage | specification quote",
    ...rules.map((r) => `${r.id} | ${r.where ?? "-"} | ${r.label} | ${r.usage} | ${r.quote ? `"${r.quote}"` : "(no quote: sample-derived)"}`),
  ].join("\n");
}

function findingsBlock(findings: readonly RedactedFinding[]): string {
  if (!findings.length) return "Findings: none.";
  return [
    "Findings (id | severity | code | line | path | rule):",
    ...findings.flatMap((f) => [
      `${f.id} | ${f.severity} | ${f.code} | ${f.line === null ? "no line (absent element)" : `L${f.line}`} | ${f.path} | ${f.specNodeId ?? f.memberId ?? "-"}`,
      `  ${f.title}`,
      `  ${f.detail}`,
      f.expected !== undefined ? `  expected: ${f.expected}` : "",
      f.actual !== undefined ? `  actual: ${f.actual}` : "",
      f.conditions.length ? `  conditions in play: ${f.conditions.join(" | ")}` : "",
      f.quote ? `  specification says: "${f.quote}"` : "  (no published quote; sample-derived rule)",
    ]).filter(Boolean),
  ].join("\n");
}

function skeletonBlock(skeleton: Skeleton): string {
  const elided = skeleton.elided.length
    ? `\n${skeleton.elided.length} subtree(s) with no findings were folded into one line each; ${skeleton.redacted} values were redacted as …, ${skeleton.kept} structural values kept.`
    : `\n${skeleton.redacted} values were redacted as …, ${skeleton.kept} structural values kept.`;
  return `Redacted structural skeleton (${skeleton.sourceLines} source lines; only the lines shown may be cited):${elided}\n\n${skeleton.text}`;
}

/* ========================================================================== *
 * Payloads — one function builds what is sent AND what is previewed
 * ========================================================================== */

export interface Detection {
  /** Structure id the workbench chose. */
  readonly chosen: string;
  /** Why, in the detector's own words. Never a probability. */
  readonly because: string;
  readonly alternatives?: readonly string[];
}

export interface ReviewInput {
  readonly structure: MessageStructure;
  readonly findings: readonly RedactedFinding[];
  readonly skeleton: Skeleton;
  readonly rules: readonly RuleStub[];
  readonly detection?: Detection;
}

export interface GapInput {
  readonly structure: MessageStructure;
  readonly gaps: readonly Gap[];
  readonly skeleton: Skeleton;
  readonly rules: readonly RuleStub[];
}

export interface PayloadParts {
  /** Frozen framing. */
  readonly system: string;
  /** Per-structure rule list; sent as its own cached system block. */
  readonly rules: string;
  /** The user turn. */
  readonly user: string;
  /** All of the above joined — the string quotes are verified against. */
  readonly text: string;
  readonly estimatedTokens: number;
}

function joinParts(system: string, rules: string, user: string): PayloadParts {
  const text = `${system}\n\n${rules}\n\n${user}`;
  return { system, rules, user, text, estimatedTokens: estimateTokens(text) };
}

function reviewParts(input: ReviewInput): PayloadParts {
  const user = [
    `Message type: ${input.structure.title} (${input.structure.id}, ${input.structure.encoding}).`,
    input.detection ? `Structure chosen because: ${input.detection.because}${input.detection.alternatives?.length ? ` Alternatives considered: ${input.detection.alternatives.join(", ")}.` : ""}` : "",
    "",
    "Review each finding against the rule it cites and the skeleton line it points at.",
    "For each finding return agree, doubt or cannot-tell with a reason and verbatim quotes.",
    "Then list ADDITIONAL structural problems you can see in the skeleton that the findings",
    "miss — only structural ones (order, presence, cardinality, a pinned value, an unknown",
    "element), each with the skeleton line, the rule id it rests on when one applies, quotes,",
    "and your confidence. Put finding ids you could not assess into notReviewed.",
    "",
    findingsBlock(input.findings),
    "",
    skeletonBlock(input.skeleton),
  ]
    .filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n");
  return joinParts(SYSTEM, rulesBlock(input.structure, input.rules), user);
}

function gapsBlock(gaps: readonly Gap[]): string {
  return [
    "Gaps (each with the CLOSED list of choices; choose one or none):",
    ...gaps.flatMap((g) => [
      `${g.id} | ${g.kind} | ${g.line === null ? "no line" : `L${g.line}`} | ${g.path} | finding ${g.findingId}`,
      `  ${g.question}`,
      ...Object.entries(g.facts)
        .filter(([, v]) => v !== null && (typeof v === "string" ? v.length > 0 : v.length > 0))
        .map(([k, v]) => `  ${k}: ${Array.isArray(v) ? v.join(" | ") : String(v)}`),
      g.options.length
        ? `  choices: ${g.options
            .map((o) =>
              o.type === "declare-condition"
                ? `declare-condition "${o.condition}" (usage ${o.usage ?? "?"}, ${o.cardinality})`
                : o.type === "rule"
                  ? `rule ${o.ruleId} (${o.label})`
                  : `copy-code "${o.code}"${o.display ? ` (${o.display})` : ""}`,
            )
            .join("; ")}`
        : "  choices: none — reasoning only",
    ]),
  ].join("\n");
}

function gapParts(input: GapInput): PayloadParts {
  const user = [
    `Message type: ${input.structure.title} (${input.structure.id}, ${input.structure.encoding}).`,
    "",
    "The workbench could not decide the questions below and did NOT guess. For each gap,",
    "propose which listed choice the skeleton supports, or 'none', with a reason and verbatim",
    "quotes from the skeleton or rule list that support it. A choice you cannot support from",
    "the evidence goes into unresolved. Your proposal is not applied; an engineer clicks it,",
    "and the deterministic checker re-runs with that condition declared.",
    "",
    gapsBlock(input.gaps),
    "",
    skeletonBlock(input.skeleton),
  ].join("\n");
  return joinParts(SYSTEM, rulesBlock(input.structure, input.rules), user);
}

/** The exact text a review or gap call would send, for the UI to show and size beforehand. */
export function payloadPreview(input: ReviewInput | GapInput): string {
  return payloadParts(input).text;
}

/** The same, split into the blocks the request is built from, with a token estimate. */
export function payloadParts(input: ReviewInput | GapInput): PayloadParts {
  return "gaps" in input ? gapParts(input) : reviewParts(input);
}

/* ========================================================================== *
 * Usage accounting
 * ========================================================================== */

export interface AiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

function usageOf(u: Anthropic.Messages.Usage | undefined): AiUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

type SystemBlocks = Anthropic.Messages.TextBlockParam[];

/** The framing plus the cached per-structure rule block. */
function systemBlocks(parts: PayloadParts): SystemBlocks {
  return [
    { type: "text", text: parts.system },
    // The rule list is identical for every call about the same structure, so it is the one
    // block worth caching; the user turn that follows varies with each message.
    { type: "text", text: parts.rules, cache_control: { type: "ephemeral" } },
  ];
}

/* ========================================================================== *
 * 1. Review the findings (second opinion + additional observations)
 * ========================================================================== */

const ReviewSchema = z.object({
  reviews: z.array(
    z.object({
      findingId: z.string(),
      verdict: z.enum(["agree", "doubt", "cannot-tell"]),
      reason: z.string(),
      quotes: z.array(z.string()).describe("Verbatim fragments of the skeleton, finding or rule list the verdict rests on."),
    }),
  ),
  additional: z.array(
    z.object({
      title: z.string(),
      whyStructural: z.string(),
      line: z.number().int().nullable(),
      ruleId: z.string().nullable(),
      quotes: z.array(z.string()),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
  notReviewed: z.array(z.string()),
});

export interface ReviewOutcome {
  readonly advisories: readonly Advisory[];
  readonly dropped: readonly DroppedAdvisory[];
  readonly notReviewed: readonly string[];
  readonly usage: AiUsage;
  readonly model: string;
  readonly digest: string;
  /** What was sent, for display next to the result. */
  readonly payload: PayloadParts;
}

/**
 * Ask for a second opinion on the checker's findings, and for anything structural it missed.
 *
 * Returns advisories, never findings. `doubt` on a finding changes nothing about that finding;
 * an `additional` observation is shown as a model claim with its quotes and drop count. The
 * eval (`scripts/eval-ai.mjs`) measures how often each of those is right.
 */
export async function reviewFindings(apiKey: string, input: ReviewInput): Promise<ReviewOutcome> {
  const parts = reviewParts(input);
  const { anthropic, zodOutputFormat } = await client(apiKey);
  const response = await anthropic.messages.parse({
    model: AI_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: systemBlocks(parts),
    output_config: { effort: "high", format: zodOutputFormat(ReviewSchema) },
    messages: [{ role: "user", content: parts.user }],
  });
  if (!response.parsed_output) throw new Error("The model did not return a usable review.");
  const out = response.parsed_output;

  const byId = new Map(input.findings.map((f) => [f.id, f]));
  const digest = await digestOf(parts.text);
  const raw: RawAdvisory[] = [];
  for (const r of out.reviews) {
    const f = byId.get(r.findingId);
    raw.push({
      kind: "second-opinion",
      about: {
        findingId: r.findingId,
        ...(f?.specNodeId ? { specNodeId: f.specNodeId } : {}),
        ...(f?.memberId ? { memberId: f.memberId } : {}),
        line: f && f.line !== null && input.skeleton.mentionedLines.has(f.line) ? f.line : null,
      },
      verdict: r.verdict,
      claim: r.reason,
      reasoning: r.reason,
      modelConfidence: r.verdict === "cannot-tell" ? "low" : "medium",
      quotes: r.quotes,
      ruleIds: [],
    });
  }
  for (const a of out.additional) {
    raw.push({
      kind: "second-opinion",
      about: { line: a.line, ...(a.ruleId ? { specNodeId: a.ruleId } : {}) },
      claim: a.title,
      reasoning: a.whyStructural,
      modelConfidence: a.confidence,
      quotes: a.quotes,
      ruleIds: a.ruleId ? [a.ruleId] : [],
    });
  }
  const sent: SentContext = {
    payload: parts.text,
    model: response.model,
    digest,
    ruleIds: new Set(input.rules.map((r) => r.id)),
    lines: input.skeleton.mentionedLines,
    findingIds: new Set(byId.keys()),
  };
  const validated = validateAdvisories(raw, sent);
  return {
    advisories: validated.advisories,
    dropped: validated.dropped,
    notReviewed: out.notReviewed.filter((id) => byId.has(id)),
    usage: usageOf(response.usage),
    model: response.model,
    digest,
    payload: parts,
  };
}

/* ========================================================================== *
 * 2. Propose resolutions for the gaps the checker left open
 * ========================================================================== */

const GapSchema = z.object({
  proposals: z.array(
    z.object({
      gapId: z.string(),
      choice: z.object({
        type: z.enum(["declare-condition", "rule", "copy-code", "none"]),
        /** The condition string, rule id or code — exactly as listed — or null for none. */
        value: z.string().nullable(),
      }),
      reason: z.string(),
      quotes: z.array(z.string()),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
  unresolved: z.array(z.string()).describe("Gap ids the evidence does not settle."),
});

export interface GapOutcome {
  readonly advisories: readonly Advisory[];
  readonly dropped: readonly DroppedAdvisory[];
  readonly unresolved: readonly string[];
  readonly usage: AiUsage;
  readonly model: string;
  readonly digest: string;
  readonly payload: PayloadParts;
}

/**
 * Ask which of each gap's CLOSED choices the skeleton supports.
 *
 * A `declare-condition` advisory carries the exact condition string from the row; the view
 * turns it into a verdict only by re-running `analyse(..., { conditions: [c] })`, which is
 * the existing parameter — the model never sets it, a click does. A `rule` choice is carried
 * in `ruleIds`; a `copy-code` choice is an action the engineer may copy, never applied.
 */
export async function proposeGapResolutions(apiKey: string, input: GapInput): Promise<GapOutcome> {
  const parts = gapParts(input);
  const { anthropic, zodOutputFormat } = await client(apiKey);
  const response = await anthropic.messages.parse({
    model: AI_MODEL,
    max_tokens: 12000,
    thinking: { type: "adaptive" },
    system: systemBlocks(parts),
    output_config: { effort: "medium", format: zodOutputFormat(GapSchema) },
    messages: [{ role: "user", content: parts.user }],
  });
  if (!response.parsed_output) throw new Error("The model did not return usable proposals.");
  const out = response.parsed_output;

  const byId = new Map(input.gaps.map((g) => [g.id, g]));
  const digest = await digestOf(parts.text);
  const offeredActions = new Map<string, readonly AdvisoryAction[]>();
  const offeredRuleIds = new Map<string, ReadonlySet<string>>();
  for (const g of input.gaps) {
    offeredActions.set(g.id, actionsOf(g));
    offeredRuleIds.set(g.id, new Set(g.options.flatMap((o) => (o.type === "rule" ? [o.ruleId] : []))));
  }

  const raw: RawAdvisory[] = out.proposals.map((p) => {
    const g = byId.get(p.gapId);
    const value = p.choice.value ?? "";
    let action: AdvisoryAction | undefined;
    let ruleIds: string[] = [];
    if (p.choice.type === "declare-condition") action = { type: "declare-condition", condition: value };
    else if (p.choice.type === "copy-code") action = { type: "copy-code", code: value };
    else if (p.choice.type === "rule") ruleIds = [value];
    return {
      kind: "gap-proposal",
      about: {
        gapId: p.gapId,
        ...(g ? { findingId: g.findingId } : {}),
        ...(g?.specNodeId ? { specNodeId: g.specNodeId } : {}),
        ...(g?.memberId ? { memberId: g.memberId } : {}),
        line: g && g.line !== null && input.skeleton.mentionedLines.has(g.line) ? g.line : null,
      },
      claim: p.choice.type === "none" ? `No listed choice is supported: ${p.reason}` : `${p.choice.type} ${JSON.stringify(value)}: ${p.reason}`,
      reasoning: p.reason,
      modelConfidence: p.confidence,
      quotes: p.quotes,
      ruleIds,
      ...(action ? { action } : {}),
    };
  });
  const allRuleIds = new Set(input.rules.map((r) => r.id));
  for (const set of offeredRuleIds.values()) for (const id of set) allRuleIds.add(id);
  const sent: SentContext = {
    payload: parts.text,
    model: response.model,
    digest,
    ruleIds: allRuleIds,
    lines: input.skeleton.mentionedLines,
    findingIds: new Set(input.gaps.map((g) => g.findingId)),
    offeredActions,
    offeredRuleIds,
  };
  const validated = validateAdvisories(raw, sent);
  return {
    advisories: validated.advisories,
    dropped: validated.dropped,
    unresolved: out.unresolved.filter((id) => byId.has(id)),
    usage: usageOf(response.usage),
    model: response.model,
    digest,
    payload: parts,
  };
}

/* ========================================================================== *
 * 3. Explain a finding
 * ========================================================================== */

const ExplanationSchema = z.object({
  plainLanguage: z.string().describe("One or two sentences an engineer can act on."),
  hisSideCause: z.string().describe("What in a hospital information system typically produces this."),
  fix: z.string().describe("The concrete change to make, naming the field or element."),
  confidence: z.enum(["high", "medium", "low"]),
  unresolved: z
    .array(z.string())
    .describe("Anything the supplied evidence does not settle. Empty when nothing is in doubt."),
});

export type Explanation = z.infer<typeof ExplanationSchema>;

/**
 * Turn one structural finding into a HIS-side fix.
 *
 * The finding is redacted ({@link redactFinding}) and its rule and Confluence quote are
 * supplied — the model is asked to rephrase and locate the work, not to decide whether the
 * finding is right.
 *
 * `skeletonWindow` is the output of `skeletonWindow(skeleton, finding.location.line, 2)`:
 * the redacted skeleton lines around the finding. RAW MESSAGE LINES MUST NEVER BE PASSED
 * HERE — the previous ±2-line snippet carried patient names, ids and dates to the API, and
 * the skeleton exists to replace it.
 */
export async function explainFinding(
  apiKey: string,
  finding: Finding,
  structure: MessageStructure,
  skeletonWindow?: string,
): Promise<Explanation> {
  const f = redactFinding(finding);
  const { anthropic, zodOutputFormat } = await client(apiKey);
  const response = await anthropic.messages.parse({
    model: AI_MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    output_config: { effort: "medium", format: zodOutputFormat(ExplanationSchema) },
    messages: [
      {
        role: "user",
        content: [
          `Message type: ${structure.title} (${structure.id}, ${structure.encoding}).`,
          "",
          "The workbench reported this finding:",
          `  id:       ${f.id}`,
          `  severity: ${f.severity}`,
          `  code:     ${f.code}`,
          `  title:    ${f.title}`,
          `  detail:   ${f.detail}`,
          `  path:     ${f.path}`,
          f.line !== null ? `  line:     L${f.line}` : "",
          f.expected !== undefined ? `  expected: ${f.expected}` : "",
          f.actual !== undefined ? `  actual:   ${f.actual}` : "",
          finding.rules?.length
            ? `  usage:    ${finding.rules.map((r) => `${r.usage}${r.condition ? ` (${r.condition})` : ""}`).join(", ")}`
            : "",
          f.quote
            ? `  specification says, verbatim: "${f.quote}"`
            : "  no published specification text backs this rule; it was derived from an official sample message.",
          skeletonWindow ? `\nRedacted skeleton around that position (… = value not pinned by any rule):\n${skeletonWindow}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });
  if (!response.parsed_output) throw new Error("The model did not return a usable explanation.");
  return response.parsed_output;
}

/* ========================================================================== *
 * 4. Map HIS extract columns onto spec fields
 * ========================================================================== */

const ColumnMappingSchema = z.object({
  mappings: z.array(
    z.object({
      column: z.string(),
      /** A locator from the supplied list, or null when none of them fits. */
      locator: z.string().nullable(),
      confidence: z.enum(["high", "medium", "low"]),
      why: z.string(),
    }),
  ),
  unmapped: z.array(z.string()).describe("Columns with no defensible target."),
});

export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

/**
 * Propose a mapping from a HIS extract's column names to spec positions.
 *
 * The candidate list is closed: the model chooses from positions the compiled spec actually
 * has, or returns `null`. A proposal is a suggestion for a human to confirm, never a mapping
 * the workbench applies on its own. Column NAMES are sent, never column contents.
 */
export async function suggestColumnMapping(
  apiKey: string,
  columns: readonly string[],
  candidates: readonly { locator: string; label: string; usage: string }[],
): Promise<ColumnMapping> {
  const { anthropic, zodOutputFormat } = await client(apiKey);
  const response = await anthropic.messages.parse({
    model: AI_MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    output_config: { effort: "medium", format: zodOutputFormat(ColumnMappingSchema) },
    messages: [
      {
        role: "user",
        content: [
          "Map these HIS extract column names onto NPHIES positions.",
          "Choose ONLY from the candidate list. Where nothing fits, return null — a wrong",
          "mapping costs an integration team more than an unmapped column.",
          "",
          `Columns: ${columns.join(", ")}`,
          "",
          "Candidates:",
          ...candidates.map((c) => `  ${c.locator} — ${c.label} [${c.usage}]`),
        ].join("\n"),
      },
    ],
  });
  if (!response.parsed_output) throw new Error("The model did not return a usable mapping.");
  return response.parsed_output;
}

/* ========================================================================== *
 * 5. Map a local code onto an NPHIES concept
 * ========================================================================== */

const CodeMappingSchema = z.object({
  candidates: z.array(
    z.object({
      code: z.string(),
      display: z.string(),
      confidence: z.enum(["high", "medium", "low"]),
      why: z.string(),
    }),
  ),
  noMatch: z.boolean().describe("True when nothing in the value set is a defensible match."),
});

export type CodeMapping = z.infer<typeof CodeMappingSchema>;

/**
 * Suggest which concept in a bound value set a hospital's local code means.
 *
 * Terminology mapping is a clinical-safety decision, so this returns ranked candidates with
 * reasons for a human to choose between — never a single answer presented as settled. The
 * concepts are supplied from the value set file; the model is not asked to recall any.
 */
export async function suggestCodeMapping(
  apiKey: string,
  localCode: { code: string; display?: string; context?: string },
  valueSet: { title: string; concepts: readonly { code: string; display: string }[] },
): Promise<CodeMapping> {
  const concepts = valueSet.concepts.slice(0, 400);
  const { anthropic, zodOutputFormat } = await client(apiKey);
  const response = await anthropic.messages.parse({
    model: AI_MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    output_config: { effort: "medium", format: zodOutputFormat(CodeMappingSchema) },
    messages: [
      {
        role: "user",
        content: [
          `Local code: ${localCode.code}${localCode.display ? ` — ${localCode.display}` : ""}`,
          localCode.context ? `Context: ${localCode.context}` : "",
          "",
          `Target value set: ${valueSet.title}`,
          ...concepts.map((c) => `  ${c.code} — ${c.display}`),
          concepts.length < valueSet.concepts.length
            ? `  … ${valueSet.concepts.length - concepts.length} further concepts were not shown.`
            : "",
          "",
          "Return the concepts that could be meant, most likely first, each with a reason.",
          "Set noMatch when none of them is defensible.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });
  if (!response.parsed_output) throw new Error("The model did not return a usable code mapping.");
  return response.parsed_output;
}

/* ========================================================================== *
 * 6. Synthesise test data
 * ========================================================================== */

const TestDataSchema = z.object({
  rows: z.array(z.record(z.string(), z.string())),
  note: z.string().describe("What was invented and why it is safe to use as test data."),
});

export type TestData = z.infer<typeof TestDataSchema>;

/**
 * Invent realistic-looking rows for a use case before a real extract exists.
 *
 * Explicitly fictional: this exists so an integration team can exercise Build and Check
 * before the hospital's data is available, and the prompt forbids anything resembling a real
 * identifier.
 */
export async function synthesizeTestData(
  apiKey: string,
  columns: readonly { locator: string; label: string; datatype?: string | null }[],
  rows: number,
): Promise<TestData> {
  const { anthropic, zodOutputFormat } = await client(apiKey);
  const response = await anthropic.messages.parse({
    model: AI_MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    output_config: { effort: "medium", format: zodOutputFormat(TestDataSchema) },
    messages: [
      {
        role: "user",
        content: [
          `Invent ${rows} rows of FICTIONAL test data for a Saudi hospital extract.`,
          "Every identifier must be obviously fictional. Never produce anything that could be",
          "a real national ID, MRN, provider licence or organisation OID.",
          "Use Arabic names where a name is called for, transliterated as the field expects.",
          "",
          "Columns:",
          ...columns.map((c) => `  ${c.locator} — ${c.label}${c.datatype ? ` (${c.datatype})` : ""}`),
          "",
          "Key each row by the locator.",
        ].join("\n"),
      },
    ],
  });
  if (!response.parsed_output) throw new Error("The model did not return usable test data.");
  return response.parsed_output;
}

/* ========================================================================== *
 * Errors worth showing verbatim
 * ========================================================================== */

/**
 * A short, honest sentence for an AI failure. Never swallow one silently.
 *
 * Read off the error's `status` rather than `instanceof` against the SDK's classes, because
 * the SDK is loaded dynamically and importing it here just to name an exception would undo
 * that.
 */
export function describeAiError(err: unknown): string {
  if (err instanceof MissingKeyError) return err.message;
  const status = (err as { status?: number } | null)?.status;
  if (status === 401 || status === 403) return "Anthropic rejected that API key. Check it in the key dialog.";
  if (status === 429) return "Anthropic rate-limited this key. Wait a moment and try again.";
  if (typeof status === "number") {
    return `Anthropic returned ${status}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return err instanceof Error ? err.message : String(err);
}
