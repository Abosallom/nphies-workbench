import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  SourceNote,
  StructureTree,
  Toolbar,
  ToolbarTitle,
  Tooltip,
  UsageBadge,
  type StructureNode,
  type Usage,
} from "../ui";
import type { MessageStructure } from "../lib/structure";
import type { ResolvedUseCase } from "../lib/workbench";
import { adaptStructure, type SpecDetail } from "../lib/adapt";

/* ========================================================================== *
 * Explain — the rule, with no message in front of it.
 *
 * Click any position in the message shape and see what governs it: usage, cardinality, the
 * fixed value the spec pins, and the VERBATIM Confluence quote the claim rests on. Every
 * claim is traceable, and a rule with no quote behind it says so.
 * ========================================================================== */

export interface ExplainViewProps {
  structure: MessageStructure | null;
  structures: MessageStructure[];
  resolved: ResolvedUseCase | null;
  onStructureChange: (structureId: string) => void;
  baseUrl?: string;
}

export function ExplainView({
  structure,
  structures,
  resolved,
  onStructureChange,
  baseUrl,
}: ExplainViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hideIgnored, setHideIgnored] = useState(false);

  const adapted = useMemo(
    () => (structure ? adaptStructure(structure, resolved?.tables) : null),
    [structure, resolved],
  );

  const detail = selectedId && adapted ? (adapted.details.get(selectedId) ?? null) : null;

  if (!structure || !adapted) {
    return (
      <EmptyState
        fill
        glyph="§"
        title="No compiled structure"
        description="Nothing was extracted for this use case, so there is no rule tree to walk."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <Toolbar
        dense
        aria-label="Explain"
        end={
          <Button size="xs" onClick={() => setHideIgnored((v) => !v)}>
            {hideIgnored ? "Show ignored" : "Hide ignored"}
          </Button>
        }
      >
        <ToolbarTitle>Explain</ToolbarTitle>
        {structures.length > 1 ? (
          <select
            className="rounded-xs border border-line bg-surface px-1 py-0.5 font-mono text-2xs text-ink"
            value={structure.id}
            onChange={(e) => onStructureChange(e.target.value)}
            aria-label="Variant"
          >
            {structures.map((s) => (
              <option key={s.id} value={s.id}>
                {s.variantLabel ?? s.variant ?? s.title}
                {(s.direction ?? "request") === "response" ? " (response)" : ""}
              </option>
            ))}
          </select>
        ) : null}
        <Badge mono>{adapted.total.toLocaleString()} rules</Badge>
        <Tooltip
          wide
          content={
            "Rules with no Confluence page behind them. They were recovered from the official sample messages, " +
            "which makes them real but not normative: NPHIES never published them."
          }
        >
          <span className="cursor-help">
            <Badge tone={adapted.sampleDerived ? "warn" : "neutral"} mono>
              {adapted.sampleDerived} sample-derived
            </Badge>
          </span>
        </Tooltip>
        {structure.verifiedAgainstSample ? (
          <Badge tone="ok">verified against an official sample</Badge>
        ) : (
          <Badge tone="warn">no official sample</Badge>
        )}
      </Toolbar>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 border-r border-line">
          <StructureTree
            aria-label="Structure rules"
            nodes={adapted.tree as StructureNode[]}
            selectedId={selectedId}
            onSelect={(n) => setSelectedId(n.id)}
            defaultExpandedDepth={1}
            hideIgnored={hideIgnored}
          />
        </div>
        <aside className="flex w-[26rem] shrink-0 flex-col overflow-auto">
          <DetailPanel structure={structure} detail={detail} baseUrl={baseUrl} />
        </aside>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function DetailPanel({
  structure,
  detail,
  baseUrl,
}: {
  structure: MessageStructure;
  detail: SpecDetail | null;
  baseUrl?: string;
}) {
  if (!detail) return <EnvelopePanel structure={structure} />;

  return (
    <div className="space-y-3 p-3 text-xs">
      <header>
        <div className="font-mono text-sm text-ink">{detail.locator ?? detail.label}</div>
        {detail.locator && detail.label !== detail.locator ? (
          <div className="text-ink-2">{detail.label}</div>
        ) : null}
        <div className="mt-1 break-all font-mono text-2xs text-ink-3">{detail.path}</div>
      </header>

      <Section title="Usage">
        {detail.usage.length ? (
          <div className="flex flex-wrap gap-1">
            {detail.usage.map((r, i) => (
              <UsageBadge
                key={i}
                usage={(r.usage === "-" ? "NP" : r.usage) as Usage}
                cardinality={r.raw?.cardinality ?? cardinalityText(r.min, r.max)}
                condition={r.condition ?? undefined}
              />
            ))}
          </div>
        ) : (
          <p className="text-ink-3">
            No usage is stated for this position. The workbench will not invent one, so nothing
            is enforced here.
          </p>
        )}
        {detail.repeats ? <p className="mt-1 text-ink-2">This position may repeat.</p> : null}
      </Section>

      {detail.datatype ? (
        <Section title="Datatype">
          <code className="font-mono text-ink">{detail.datatype}</code>
        </Section>
      ) : null}

      {detail.fixedValues.length ? (
        <Section title="Fixed values">
          <ul className="space-y-1">
            {detail.fixedValues.map((f, i) => (
              <li key={i} className="break-all">
                <span className="text-ink-3">{f.attribute ? `@${f.attribute}` : (f.scope ?? "value")}</span>{" "}
                <code className="font-mono text-ink">{f.value ?? "—"}</code>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-ink-3">
            The specification pins these exactly. Any other value is a structural defect.
          </p>
        </Section>
      ) : null}

      {detail.templateIds.length ? (
        <Section title="templateId">
          <ul className="space-y-0.5 font-mono text-2xs text-ink">
            {detail.templateIds.map((t) => (
              <li key={t} className="break-all">
                {t}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {detail.valueSets.length ? (
        <Section title="Value sets">
          <ul className="space-y-1">
            {detail.valueSets.map((v, i) => (
              <li key={i}>
                <span className="text-ink">{v.title ?? v.valueSetId ?? "unnamed"}</span>
                {v.external ? (
                  <Badge tone="warn" className="ml-1">
                    NHIC-hosted
                  </Badge>
                ) : null}
                {v.resolvedVia ? (
                  <span className="ml-1 text-2xs text-ink-3">matched by {v.resolvedVia}</span>
                ) : null}
              </li>
            ))}
          </ul>
          {detail.valueSets.some((v) => v.external) ? (
            <p className="mt-1 text-ink-3">
              An NHIC-hosted set is not shipped with the workbench, so membership is not
              checked — only the format. The checker says so rather than passing it silently.
            </p>
          ) : null}
        </Section>
      ) : null}

      {detail.codeSet ? (
        <Section title="Code set column">
          <p className="whitespace-pre-wrap text-ink-2">{detail.codeSet}</p>
        </Section>
      ) : null}

      {detail.guidance ? (
        <Section title="Guidance">
          <p className="whitespace-pre-wrap text-ink-2">{detail.guidance}</p>
        </Section>
      ) : null}

      <Section title="Where this comes from">
        {detail.provenance?.pageId && detail.provenance.quote ? (
          <SourceNote
            source={{
              pageId: detail.provenance.pageId,
              pageTitle: detail.provenance.pageTitle ?? "",
              quote: detail.provenance.quote,
              ...(detail.provenance.row ? { row: detail.provenance.row } : {}),
            }}
            baseUrl={baseUrl}
            defaultOpen
          />
        ) : detail.provenance?.sample ? (
          <p className="text-ink-2">
            This rule is not in the published specification. It was recovered from the official
            sample <code className="font-mono">{detail.provenance.sample}</code>, so it describes
            what NPHIES actually sends — not what NPHIES requires.
          </p>
        ) : (
          <p className="text-ink-3">
            No source was recorded for this rule, so the workbench does not enforce it.
          </p>
        )}
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-2xs text-ink-3">
          {detail.derivation ? (
            <>
              <dt>derivation</dt>
              <dd className="text-ink-2">{detail.derivation}</dd>
            </>
          ) : null}
          {detail.confidence ? (
            <>
              <dt>confidence</dt>
              <dd className="text-ink-2">{detail.confidence}</dd>
            </>
          ) : null}
          <dt>official sample</dt>
          <dd className="text-ink-2">
            {detail.verifiedAgainstSample ? "checked against one" : "not checked against one"}
          </dd>
        </dl>
      </Section>
    </div>
  );
}

function EnvelopePanel({ structure }: { structure: MessageStructure }) {
  const env = structure.envelope;
  return (
    <div className="space-y-3 p-3 text-xs">
      <header>
        <div className="text-sm font-semibold text-ink">{structure.title}</div>
        <div className="font-mono text-2xs text-ink-3">{structure.id}</div>
      </header>
      <p className="text-ink-2">
        Pick any position on the left to see the rule that governs it, and the verbatim text of
        the specification page it came from.
      </p>

      {env ? (
        <Section title="Envelope">
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
            {Object.entries(env)
              .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
              .map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-ink-3">{k}</dt>
                  <dd className="break-all font-mono text-ink">{String(v)}</dd>
                </div>
              ))}
          </dl>
        </Section>
      ) : null}

      {structure.notes.length ? (
        <Section title="Caveats the compiler recorded">
          <ul className="list-disc space-y-1 pl-4 text-ink-2">
            {structure.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {structure.variantAxis ? (
        <Section title={structure.variantAxis.label}>
          <p className="text-ink-2">{structure.variantAxis.note ?? ""}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {structure.variantAxis.values.map((v) => (
              <Badge key={v} mono>
                {v}
              </Badge>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">{title}</h3>
      {children}
    </section>
  );
}

function cardinalityText(min: number | null, max: number | "*" | null): string | undefined {
  if (min === null && max === null) return undefined;
  return `${min ?? 0}..${max ?? "*"}`;
}
