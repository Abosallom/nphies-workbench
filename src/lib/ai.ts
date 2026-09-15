/**
 * Optional AI assistance — bring your own Anthropic key.
 *
 * Three rules this module exists to enforce:
 *
 *  1. **The workbench works without it.** Every structural verdict comes from the compiled
 *     spec and `check()`. Nothing here is ever consulted to decide whether a message is
 *     conformant; it only puts words around a verdict that has already been reached, or
 *     proposes a mapping a human then confirms.
 *  2. **The key stays in the browser.** A static page has no server to hide a key behind, so
 *     the user supplies their own, it lives in `localStorage`, and it is sent only to
 *     Anthropic. The message content is sent with it — so every call is user-triggered and
 *     the UI says what will leave the browser before it does.
 *  3. **Answers are typed.** Every call goes through `messages.parse()` with a Zod schema, so
 *     a malformed or evasive answer fails loudly instead of being rendered as fact.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Finding } from "./check";
import type { MessageStructure } from "./structure";

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
  "A deterministic workbench has already decided what is structurally wrong with the message;",
  "you never re-judge that. Your job is to make the finding actionable on the HIS side.",
  "",
  "Rules:",
  "- Never contradict the supplied finding, and never invent a rule, OID, code or field name.",
  "- If the supplied evidence does not settle something, say so plainly instead of guessing.",
  "- Speak to an integration engineer: concrete, short, no marketing tone, no apologies.",
  "- Patient data may appear in what you are shown. Never repeat identifiers back in full.",
].join("\n");

/* ========================================================================== *
 * 1. Explain a finding
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
 * The finding, its rule and its Confluence quote are all supplied — the model is asked to
 * rephrase and locate the work, not to decide whether the finding is right.
 */
export async function explainFinding(
  apiKey: string,
  finding: Finding,
  structure: MessageStructure,
  snippet?: string,
): Promise<Explanation> {
  const { anthropic, zodOutputFormat } = await client(apiKey);
  const response = await anthropic.messages.parse({
    model: AI_MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { effort: "medium", format: zodOutputFormat(ExplanationSchema) },
    messages: [
      {
        role: "user",
        content: [
          `Message type: ${structure.title} (${structure.id}, ${structure.encoding}).`,
          "",
          "The workbench reported this finding:",
          `  severity: ${finding.severity}`,
          `  code:     ${finding.code}`,
          `  title:    ${finding.title}`,
          `  detail:   ${finding.detail}`,
          `  path:     ${finding.path}`,
          finding.expected ? `  expected: ${finding.expected}` : "",
          finding.actual ? `  actual:   ${finding.actual}` : "",
          finding.rules?.length
            ? `  usage:    ${finding.rules.map((r) => `${r.usage}${r.condition ? ` (${r.condition})` : ""}`).join(", ")}`
            : "",
          finding.provenance.quote
            ? `  specification says, verbatim: "${finding.provenance.quote}"`
            : "  no published specification text backs this rule; it was derived from an official sample message.",
          snippet ? `\nThe message around that position:\n${snippet}` : "",
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
 * 2. Map HIS extract columns onto spec fields
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
 * the workbench applies on its own.
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
 * 3. Map a local code onto an NPHIES concept
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
 * reasons for a human to choose between — never a single answer presented as settled.
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
    max_tokens: 4000,
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
 * 4. Synthesise test data
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
    system: SYSTEM,
    output_config: { effort: "low", format: zodOutputFormat(TestDataSchema) },
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
