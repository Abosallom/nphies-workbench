/**
 * The structural mutation engine.
 *
 * It takes an OFFICIAL message, breaks it in one specific way, and hands the broken text to
 * the checker together with what the checker ought to say about it. That is the only test
 * that measures the thing this product claims: not "does it run", but "does it tell a
 * hospital the truth about what is structurally wrong, and where".
 *
 * Mutations are derived from the parsed tree rather than hard-coded per message, so the same
 * nine operations apply to HL7, CDA, FHIR and SOAP alike, and a new use case is covered the
 * day its structure compiles.
 *
 * Scoring is deliberately three separate numbers:
 *   detection      — a NEW finding appeared that was not in the clean baseline
 *   location       — that finding points at the line the mutation touched
 *   classification — it carries the finding code the defect actually is
 * A tool that detects everything and locates nothing is not useful, and averaging the three
 * would hide exactly that.
 */

/**
 * @typedef {object} Mutation
 * @property {string} name        what was done, for the failure message
 * @property {string} kind        the operation, e.g. "delete-required"
 * @property {string} text        the broken message
 * @property {number} line        the line the defect is on
 * @property {string[]} expect    finding codes that would be a correct diagnosis
 * @property {string} [names]     the element touched — a finding about something ABSENT has
 *                                no line to point at, so naming it is how it locates itself
 * @property {string} [mentions]  text the finding must contain to count as the right one
 * @property {string} what        one sentence describing the defect
 */

const has = (node) => node.loc && typeof node.loc.offset === "number" && typeof node.loc.endOffset === "number";

function nodesOf(walkTree, tree) {
  const out = [];
  walkTree(tree, (node, ancestors) => {
    if (ancestors.length) out.push({ node, parent: ancestors[ancestors.length - 1] });
  });
  return out;
}

const isLexical = (node) => node.kind === "text" || node.label.startsWith("#");

/** Usage the compiled spec resolves for a node, via its linked SpecNode. */
function usagesOf(node) {
  return (node.spec?.usage ?? []).map((u) => u.usage);
}

function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

function cut(text, from, to) {
  return text.slice(0, from) + text.slice(to);
}

function splice(text, from, to, replacement) {
  return text.slice(0, from) + replacement + text.slice(to);
}

/** Replace a leaf's value inside its own source span, leaving any key or tag intact. */
function replaceValue(span, value, next) {
  const quoted = span.indexOf(`"${value}"`);
  if (quoted >= 0) return span.slice(0, quoted) + `"${next}"` + span.slice(quoted + value.length + 2);
  const at = span.lastIndexOf(value);
  return at < 0 ? span : span.slice(0, at) + next + span.slice(at + value.length);
}

/**
 * Build the mutation set for one parsed message.
 *
 * Every mutation states the finding codes that would be a CORRECT diagnosis. More than one
 * is allowed where more than one is genuinely right — deleting a required element that also
 * carries a fixed value may be reported either way — but the list is never so wide that
 * anything counts.
 */
export function mutationsFor({ walkTree, tree, text, structure }) {
  const all = nodesOf(walkTree, tree).filter(({ node }) => node.present !== false && !isLexical(node) && has(node));
  const mutations = [];

  /* ---- 1. delete a required element ---------------------------------- */
  const required = all.filter(({ node }) => {
    const u = usagesOf(node);
    return (u.includes("M") || u.includes("R")) && node.loc.endOffset > node.loc.offset;
  });
  const deletable = required.find(({ node, parent }) => {
    // Never delete something that carries the whole message.
    return parent && node.loc.endOffset - node.loc.offset < text.length / 4;
  });
  if (deletable) {
    mutations.push({
      name: `delete required ${deletable.node.label}`,
      kind: "delete-required",
      text: cut(text, deletable.node.loc.offset, deletable.node.loc.endOffset),
      line: deletable.node.loc.line,
      expect: ["required-field-missing", "cardinality-too-few", "sequence-out-of-order"],
      names: deletable.node.label,
      what: `${deletable.node.label} carries usage M/R and was removed entirely.`,
    });
  }

  /* ---- 2. break a fixed value ----------------------------------------- */
  const fixed = all.find(({ node }) => {
    const rules = node.spec?.fixedValues ?? [];
    const whole = rules.find((r) => r.value && r.scope === "wholeField");
    return whole && node.value === whole.value;
  });
  if (fixed) {
    mutations.push({
      name: `corrupt fixed value at ${fixed.node.label}`,
      kind: "break-fixed-value",
      // Rewrite the VALUE inside the node's own source span. Writing `raw` over the span is
      // not the same thing: for JSON the span covers `"key": "value"` while `raw` is only the
      // value, so that would delete the key and produce a syntax error instead of a
      // structural one — which tests the JSON parser, not the checker.
      text: splice(text, fixed.node.loc.offset, fixed.node.loc.endOffset, replaceValue(text.slice(fixed.node.loc.offset, fixed.node.loc.endOffset), fixed.node.value, "9.9.9.9.9")),
      line: fixed.node.loc.line,
      expect: ["fixed-value-mismatch", "parse-diagnostic", "bundle-type-mismatch"],
      mentions: "9.9.9.9.9",
      names: fixed.node.label,
      what: `${fixed.node.label} is pinned to ${fixed.node.value}; it was changed.`,
    });
  }

  /* ---- 3. swap two siblings (order) ----------------------------------- */
  const byParent = new Map();
  for (const entry of all) {
    if (!entry.parent) continue;
    const list = byParent.get(entry.parent) ?? [];
    list.push(entry);
    byParent.set(entry.parent, list);
  }
  for (const [, siblings] of byParent) {
    const ordered = siblings
      .filter(({ node }) => node.kind === "segment" || node.kind === "element" || node.kind === "entry")
      .sort((a, b) => a.node.loc.offset - b.node.loc.offset);
    // Two ADJACENT siblings with different labels, neither enclosing the other.
    for (let i = 0; i + 1 < ordered.length; i++) {
      const a = ordered[i].node;
      const b = ordered[i + 1].node;
      if (a.label === b.label) continue;
      if (b.loc.offset < a.loc.endOffset) continue;
      const between = text.slice(a.loc.endOffset, b.loc.offset);
      if (between.trim()) continue; // only whitespace may sit between them
      const swapped =
        text.slice(0, a.loc.offset) +
        text.slice(b.loc.offset, b.loc.endOffset) +
        between +
        text.slice(a.loc.offset, a.loc.endOffset) +
        text.slice(b.loc.endOffset);
      mutations.push({
        name: `swap ${a.label} and ${b.label}`,
        kind: "swap-order",
        text: swapped,
        line: a.loc.line,
        expect: ["sequence-out-of-order", "bundle-first-entry", "required-field-missing"],
        names: a.label,
        what: `${a.label} and ${b.label} were exchanged, so the normative order is broken.`,
      });
      break;
    }
    if (mutations.some((m) => m.kind === "swap-order")) break;
  }

  /* ---- 4. duplicate a single-occurrence node -------------------------- */
  // The element must be the ONLY one of its name at its position. Duplicating one of several
  // same-named siblings (a CDA section's two templateIds) shifts the positional identity the
  // parser assigns, so what the checker then reports is about a different element — that
  // measures the parser's index arithmetic, not the checker's grasp of cardinality.
  const single = all.find(({ node, parent }) => {
    const u = node.spec?.usage ?? [];
    if (!u.length || !u.every((r) => r.max === 1)) return false;
    if (node.loc.endOffset - node.loc.offset >= 400) return false;
    const twins = (parent?.children ?? []).filter((c) => c.present !== false && c.label === node.label);
    return twins.length === 1;
  });
  if (single) {
    const span = text.slice(single.node.loc.offset, single.node.loc.endOffset);
    const sep = structure.encoding === "hl7v2-er7" ? "" : "\n";
    mutations.push({
      name: `duplicate ${single.node.label}`,
      kind: "duplicate",
      text: splice(text, single.node.loc.offset, single.node.loc.endOffset, span + sep + span),
      line: single.node.loc.line,
      expect: ["cardinality-too-many", "sequence-out-of-order", "unknown-element"],
      names: single.node.label,
      what: `${single.node.label} is [x..1] and now appears twice.`,
    });
  }

  /* ---- 5. flatten an HL7 composite ------------------------------------ */
  if (structure.encoding === "hl7v2-er7") {
    // Prefer a composite the spec actually constrains — one with a pinned component value or
    // a bound value set. Flattening `MSH-3` proves nothing: NPHIES pins none of its parts, so
    // there is nothing there for a checker to be right or wrong about.
    const composites = all.filter(
      ({ node }) => node.kind === "field" && node.children.filter((c) => c.kind === "component").length >= 3,
    );
    const constrained = composites.find(
      ({ node }) => (node.spec?.fixedValues ?? []).length > 0 || (node.spec?.valueSets ?? []).length > 0,
    );
    const composite = constrained ?? composites[0];
    if (composite) {
      const span = text.slice(composite.node.loc.offset, composite.node.loc.endOffset);
      mutations.push({
        name: `flatten composite ${composite.node.label}`,
        kind: "flatten-composite",
        text: splice(text, composite.node.loc.offset, composite.node.loc.endOffset, span.replace(/\^/g, " ")),
        line: composite.node.loc.line,
        expect: ["composite-component-missing", "fixed-value-mismatch", "required-field-missing", "valueset-code-unknown"],
        names: composite.node.label,
        what: `${composite.node.label} is a composite; its component separators were removed.`,
      });
    }
  }

  /* ---- 6. change the FHIR bundle type --------------------------------- */
  if (structure.encoding === "fhir-json") {
    const type = all.find(({ node }) => node.label === "type" && node.id === "Bundle.type");
    if (type && type.node.value) {
      const wrong = type.node.value === "document" ? "message" : "document";
      mutations.push({
        name: `Bundle.type -> ${wrong}`,
        kind: "wrong-bundle-type",
        text: splice(text, type.node.loc.offset, type.node.loc.endOffset, replaceValue(text.slice(type.node.loc.offset, type.node.loc.endOffset), type.node.value, wrong)),
        line: type.node.loc.line,
        expect: ["bundle-type-mismatch", "fixed-value-mismatch", "valueset-code-unknown"],
        names: "type",
        what: `The two bundle families are incompatible; type was switched to "${wrong}".`,
      });
    }
  }

  /* ---- 7. rename an element (unknown content) ------------------------- */
  const renameable = all.find(
    ({ node }) => node.kind === "element" && node.spec && node.loc.endOffset - node.loc.offset < 3000 && String(node.raw ?? "").startsWith("<"),
  );
  if (renameable) {
    const span = text.slice(renameable.node.loc.offset, renameable.node.loc.endOffset);
    const qname = /^<([^\s/>]+)/.exec(span)?.[1];
    if (qname) {
      const renamed = span.split(qname).join(`${qname}X`);
      mutations.push({
        name: `rename <${qname}> to <${qname}X>`,
        kind: "rename-element",
        text: splice(text, renameable.node.loc.offset, renameable.node.loc.endOffset, renamed),
        line: renameable.node.loc.line,
        expect: ["required-field-missing", "unknown-element", "sequence-out-of-order", "cardinality-too-few", "recommended-field-missing"],
        names: qname,
        what: `<${qname}> was misspelled, so the element the spec requires is absent and unknown content is present.`,
      });
    }
  }

  return mutations;
}
