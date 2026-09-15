import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  KeyDialog,
  Tabs,
  ThemeToggle,
  Tooltip,
  UseCaseRail,
  maskKey,
  useApiKey,
  useTheme,
  type TabItem,
  type UseCase,
  type UseCaseRailHandle,
} from "../ui";
import { loadGoldenIndex, structureForSample, type GoldenSample } from "../lib/workbench";
import { BuildView } from "./BuildView";
import { CheckView } from "./CheckView";
import { CoverageView } from "./CoverageView";
import { DecoderView } from "./DecoderView";
import { ExplainView } from "./ExplainView";
import { ReadinessView, type SessionResult } from "./ReadinessView";
import { CONFLUENCE_BASE } from "./constants";
import { useGolden, useRegistry, useResolved } from "./useSpec";

/* ========================================================================== *
 * The shell: use-case rail, workflow tabs, and the three global surfaces.
 *
 * It owns one thing of substance — the per-use-case working state (which variant, what the
 * analyst pasted, what the last check found) — so switching tabs or use cases never discards
 * work, and the Readiness matrix can report what has actually been checked in this session.
 * ========================================================================== */

type ActiveTab = "build" | "check" | "explain" | "readiness" | "decoder" | "coverage";

const GLOBAL_TABS = new Set<ActiveTab>(["readiness", "decoder", "coverage"]);

interface UseCaseState {
  structureId: string | null;
  text: string;
}

export function Shell() {
  const registry = useRegistry();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<ActiveTab>("check");
  const [states, setStates] = useState<Record<string, UseCaseState>>({});
  const [results, setResults] = useState<Record<string, SessionResult>>({});
  const [keyOpen, setKeyOpen] = useState(false);

  const { theme, setTheme } = useTheme();
  const { key, setKey } = useApiKey();
  const railRef = useRef<UseCaseRailHandle>(null);

  const useCases: UseCase[] = useMemo(
    () => (registry.data?.entries ?? []).map((e) => e.ui as UseCase),
    [registry.data],
  );

  useEffect(() => {
    if (!selectedId && useCases.length) setSelectedId(useCases[0].id);
  }, [useCases, selectedId]);

  const state = selectedId ? (states[selectedId] ?? { structureId: null, text: "" }) : { structureId: null, text: "" };
  const resolved = useResolved(selectedId, state.structureId);
  const golden = useGolden(selectedId);

  const entry = selectedId ? (registry.data?.byId.get(selectedId) ?? null) : null;
  const structures = resolved.data?.structures ?? [];
  const structure = resolved.data?.structure ?? null;

  const patch = useCallback(
    (id: string, next: Partial<UseCaseState>) => {
      setStates((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { structureId: null, text: "" }), ...next } }));
    },
    [],
  );

  const onSelectUseCase = useCallback((uc: UseCase) => {
    setSelectedId(uc.id);
    setTab((t) => (GLOBAL_TABS.has(t) ? "check" : t));
  }, []);

  const onStructureChange = useCallback(
    (structureId: string) => {
      if (selectedId) patch(selectedId, { structureId });
    },
    [selectedId, patch],
  );

  const onTextChange = useCallback(
    (text: string) => {
      if (selectedId) patch(selectedId, { text });
    },
    [selectedId, patch],
  );

  /** Build hands a sample to Check, which is where a reference message is useful. */
  const openSample = useCallback(
    async (sample: GoldenSample) => {
      if (!selectedId) return;
      const index = await loadGoldenIndex();
      void index;
      const target = structureForSample(structures, sample);
      const res = await fetch(sample.url);
      if (!res.ok) return;
      const body = await res.text();
      patch(selectedId, { text: body, ...(target ? { structureId: target.id } : {}) });
      setTab("check");
    },
    [selectedId, structures, patch],
  );

  const recordResult = useCallback((useCaseId: string, result: SessionResult) => {
    setResults((prev) => (prev[useCaseId]?.at === result.at ? prev : { ...prev, [useCaseId]: result }));
  }, []);

  /* "/" focuses the rail filter from anywhere outside a text field. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      railRef.current?.focusFilter();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const result = selectedId ? results[selectedId] : undefined;

  const tabs: TabItem[] = [
    { id: "build", label: "Build", title: "What this message type requires — and what NPHIES ignores" },
    {
      id: "check",
      label: "Check",
      title: "Validate a message against the compiled structural rules",
      badge:
        result && result.errors + result.warns > 0 ? (
          <span className="font-mono text-2xs">
            {result.errors ? `${result.errors}E` : ""}
            {result.errors && result.warns ? " " : ""}
            {result.warns ? `${result.warns}W` : ""}
          </span>
        ) : undefined,
    },
    { id: "explain", label: "Explain", title: "Walk the compiled rules for this message type" },
    { id: "readiness", label: "Readiness", startsGroup: true, title: "Global: which use cases have been checked" },
    { id: "decoder", label: "Error Decoder", title: "Global: decode an NPHIES rejection" },
    { id: "coverage", label: "Coverage", title: "Global: what the workbench does not know" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas text-ink">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface px-2.5">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-flex h-4 w-4 items-center justify-center rounded-xs bg-accent font-mono text-2xs font-bold text-accent-ink"
          >
            N
          </span>
          <span className="text-xs font-semibold tracking-tight">NPHIES Workbench</span>
        </span>
        <Badge mono className="shrink-0">
          message structure
        </Badge>
        <span className="hidden text-2xs text-ink-3 sm:inline">
          Nothing you paste leaves this browser.
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <Tooltip
            wide
            content={
              key
                ? `Anthropic key stored in this browser (${maskKey(key)}). Used only when you ask for an explanation.`
                : "No Anthropic key stored. Every structural check works without one."
            }
          >
            <Button onClick={() => setKeyOpen(true)}>{key ? "API key set" : "Set API key"}</Button>
          </Tooltip>
          <ThemeToggle theme={theme} onChange={setTheme} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <UseCaseRail ref={railRef} useCases={useCases} selectedId={selectedId} onSelect={onSelectUseCase} />

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-surface px-2.5">
            <span className="flex min-w-0 shrink items-center gap-1.5">
              {entry ? (
                <>
                  <code className="shrink-0 font-mono text-xs text-ink">{entry.ui.code}</code>
                  <span className="truncate text-xs text-ink-2">{entry.ui.label}</span>
                </>
              ) : (
                <span className="text-xs text-ink-3">
                  {registry.loading ? "Loading the compiled spec…" : "No use case selected"}
                </span>
              )}
            </span>
            <Tabs
              aria-label="Workflow"
              items={tabs}
              activeId={tab}
              onChange={(id) => setTab(id as ActiveTab)}
              className="ml-auto"
            />
          </div>

          <div className="min-h-0 flex-1">
            {registry.error ? (
              <EmptyState
                fill
                title="The compiled spec bundle could not be loaded"
                description={registry.error}
              />
            ) : tab === "readiness" ? (
              <ReadinessView
                registry={registry.data}
                results={results}
                onOpen={(id) => {
                  setSelectedId(id);
                  setTab("check");
                }}
              />
            ) : tab === "decoder" ? (
              <DecoderView baseUrl={CONFLUENCE_BASE} />
            ) : tab === "coverage" ? (
              <CoverageView registry={registry.data} baseUrl={CONFLUENCE_BASE} />
            ) : tab === "build" ? (
              <BuildView
                structure={structure}
                structures={structures}
                resolved={resolved.data?.resolved ?? null}
                samples={golden.data ?? []}
                onStructureChange={onStructureChange}
                onOpenSample={openSample}
                baseUrl={CONFLUENCE_BASE}
              />
            ) : tab === "explain" ? (
              <ExplainView
                structure={structure}
                structures={structures}
                resolved={resolved.data?.resolved ?? null}
                onStructureChange={onStructureChange}
                baseUrl={CONFLUENCE_BASE}
              />
            ) : (
              <CheckView
                key={selectedId ?? "none"}
                structure={structure}
                structures={structures}
                resolved={resolved.data?.resolved ?? null}
                samples={golden.data ?? []}
                text={state.text}
                onTextChange={onTextChange}
                onStructureChange={onStructureChange}
                structureIdForSample={(sample) => structureForSample(structures, sample)?.id ?? null}
                onResult={(r) => selectedId && recordResult(selectedId, r)}
                baseUrl={CONFLUENCE_BASE}
                useCaseCode={entry?.ui.code}
              />
            )}
          </div>
        </main>
      </div>

      <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-surface px-2.5 text-2xs text-ink-3">
        <span className="font-mono">{structure ? structure.id : (selectedId ?? "—")}</span>
        {registry.data ? (
          <span>
            {registry.data.entries.length} use cases ·{" "}
            {Number(registry.data.manifest.counts.specNodes ?? 0).toLocaleString()} compiled rules ·{" "}
            {Number(registry.data.manifest.counts.goldenSamples ?? 0)} official samples
          </span>
        ) : null}
        <span className="ml-auto">
          Press <kbd className="rounded-xs border border-line px-1 font-mono">/</kbd> to filter use cases
        </span>
      </footer>

      <KeyDialog open={keyOpen} onClose={() => setKeyOpen(false)} value={key} onSave={setKey} />
    </div>
  );
}
