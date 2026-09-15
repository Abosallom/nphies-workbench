import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  KeyDialog,
  SeverityCount,
  SplitView,
  Tabs,
  ThemeToggle,
  Tooltip,
  UseCaseRail,
  maskKey,
  useApiKey,
  useTheme,
  type Finding,
  type Region,
  type SplitSelection,
  type StructureNode,
  type TabItem,
  type Token,
  type UseCase,
  type UseCaseRailHandle,
  type Severity,
  type WorkflowTab,
} from "../ui";
import {
  CONFLUENCE_BASE,
  FIXTURE_FINDINGS,
  FIXTURE_MESSAGE,
  FIXTURE_REGIONS,
  FIXTURE_TOKENS,
  FIXTURE_TREE,
  USE_CASES,
} from "../ui/fixture";
import { Placeholder } from "./Placeholder";

/* -------------------------------------------------------------------------- */

/**
 * Everything the Check surface needs for one message. The compiled spec will
 * produce exactly this shape, so `Shell` never changes when the fixture goes.
 */
export interface MessageModel {
  text: string;
  regions: Region[];
  tree: StructureNode[];
  findings: Finding[];
  tokens?: Token[];
}

export interface ShellProps {
  useCases?: UseCase[];
  /** Returns the model to check for a use case, or null when none is loaded. */
  getMessageModel?: (useCaseId: string) => MessageModel | null;
  /** Confluence base URL for provenance links. */
  baseUrl?: string;
}

const FIXTURE_MODEL: MessageModel = {
  text: FIXTURE_MESSAGE,
  regions: FIXTURE_REGIONS,
  tree: FIXTURE_TREE,
  findings: FIXTURE_FINDINGS,
  tokens: FIXTURE_TOKENS,
};

function defaultGetMessageModel(useCaseId: string): MessageModel | null {
  // Until the compiled spec lands, only the ADT^A01 fixture has a model.
  return useCaseId === "adt-a01" ? FIXTURE_MODEL : null;
}

type ActiveTab = WorkflowTab | "readiness" | "decoder";

const GLOBAL_TABS = new Set<ActiveTab>(["readiness", "decoder"]);

/* -------------------------------------------------------------------------- */

export function Shell({
  useCases = USE_CASES,
  getMessageModel = defaultGetMessageModel,
  baseUrl = CONFLUENCE_BASE,
}: ShellProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    useCases[0]?.id ?? null,
  );
  const [tab, setTab] = useState<ActiveTab>("check");
  const [selection, setSelection] = useState<SplitSelection | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);

  const { theme, setTheme } = useTheme();
  const { key, setKey } = useApiKey();
  const railRef = useRef<UseCaseRailHandle>(null);

  const useCase = useMemo(
    () => useCases.find((u) => u.id === selectedId) ?? null,
    [useCases, selectedId],
  );

  const model = useMemo(
    () => (selectedId ? getMessageModel(selectedId) : null),
    [selectedId, getMessageModel],
  );

  const counts = useMemo(() => {
    const c: Record<Severity, number> = {
      error: 0,
      warn: 0,
      ok: 0,
      ignored: 0,
      info: 0,
    };
    for (const f of model?.findings ?? []) c[f.severity]++;
    return c;
  }, [model]);

  /* "/" focuses the rail filter from anywhere outside a text field. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      e.preventDefault();
      railRef.current?.focusFilter();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSelectUseCase = useCallback((uc: UseCase) => {
    setSelectedId(uc.id);
    setSelection(null);
    setTab((t) => (GLOBAL_TABS.has(t) ? "check" : t));
  }, []);

  const tabs: TabItem[] = [
    { id: "build", label: "Build", title: "Assemble a conformant message from the compiled structure" },
    {
      id: "check",
      label: "Check",
      title: "Validate a message against the compiled structural rules",
      badge:
        counts.error + counts.warn > 0 ? (
          <span className="flex items-center gap-1">
            <SeverityCount severity="error" count={counts.error} />
            <SeverityCount severity="warn" count={counts.warn} />
          </span>
        ) : undefined,
    },
    { id: "explain", label: "Explain", title: "Walk through the structure of this use case" },
    {
      id: "readiness",
      label: "Readiness",
      startsGroup: true,
      title: "Global: which use cases your HIS is ready to submit",
    },
    {
      id: "decoder",
      label: "Error Decoder",
      title: "Global: paste an NPHIES rejection and locate the structural cause",
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas text-ink">
      {/* ------------------------------------------------ application bar -- */}
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface px-2.5">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-flex h-4 w-4 items-center justify-center rounded-xs bg-accent font-mono text-2xs font-bold text-accent-ink"
          >
            N
          </span>
          <span className="text-xs font-semibold tracking-tight">
            NPHIES Workbench
          </span>
        </span>
        <Badge mono className="shrink-0">
          message structure
        </Badge>

        <div className="ml-auto flex items-center gap-1.5">
          <Tooltip
            wide
            content={
              key
                ? `Anthropic key stored in this browser (${maskKey(key)}). Used only for the Explain surface.`
                : "No Anthropic key stored. Structure checking works without one."
            }
          >
            <Button onClick={() => setKeyOpen(true)}>
              {key ? "API key set" : "Set API key"}
            </Button>
          </Tooltip>
          <ThemeToggle theme={theme} onChange={setTheme} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ----------------------------------------------------- left rail */}
        <UseCaseRail
          ref={railRef}
          useCases={useCases}
          selectedId={selectedId}
          onSelect={onSelectUseCase}
        />

        {/* --------------------------------------------------- work area -- */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-surface px-2.5">
            <span className="flex min-w-0 shrink items-center gap-1.5">
              {useCase ? (
                <>
                  <code className="shrink-0 font-mono text-xs text-ink">
                    {useCase.code}
                  </code>
                  <span className="truncate text-xs text-ink-2">
                    {useCase.label}
                  </span>
                </>
              ) : (
                <span className="text-xs text-ink-3">No use case selected</span>
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
            {tab === "readiness" ? (
              <Placeholder
                glyph="▦"
                title="Readiness"
                description="A matrix of every use case against the structural rules your HIS already satisfies — independent of any one message."
                owner="src/usecases/readiness"
              />
            ) : tab === "decoder" ? (
              <Placeholder
                glyph="⊘"
                title="Error Decoder"
                description="Paste an NPHIES rejection and this surface maps the reported code back onto the exact element, segment or entry that caused it."
                owner="src/usecases/decoder"
              />
            ) : tab === "build" ? (
              <Placeholder
                title="Build"
                description="Assemble a structurally conformant message from the compiled rules, with every required element pre-seeded and every ignored element hidden."
                owner="src/usecases/build"
                useCase={useCase}
              />
            ) : tab === "explain" ? (
              <Placeholder
                glyph="§"
                title="Explain"
                description="A narrated walk through this message type: required order, grouping, cardinality and the fixed structural values the specification pins."
                owner="src/usecases/explain"
                useCase={useCase}
              />
            ) : model ? (
              <SplitView
                text={model.text}
                regions={model.regions}
                tree={model.tree}
                findings={model.findings}
                tokens={model.tokens}
                selection={selection}
                onSelectionChange={setSelection}
                baseUrl={baseUrl}
                codeTitle={
                  <span className="flex items-center gap-1.5">
                    {useCase?.code ?? "Message"}
                    <span className="font-normal normal-case tracking-normal text-ink-3">
                      fixture
                    </span>
                  </span>
                }
                structureTitle="Structure"
              />
            ) : (
              <Placeholder
                glyph="⎔"
                title="No compiled structure yet"
                description="The structural rules for this use case have not been extracted. Pick ADT^A01 to exercise the shell against the fixture."
                owner="src/spec"
                useCase={useCase}
              />
            )}
          </div>
        </main>
      </div>

      {/* ------------------------------------------------------ status bar */}
      <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-surface px-2.5 text-2xs text-ink-3">
        <span className="font-mono">
          {useCase ? useCase.id : "—"}
        </span>
        {model ? (
          <span className="flex items-center gap-2">
            <SeverityCount severity="error" count={counts.error} />
            <SeverityCount severity="warn" count={counts.warn} />
            <SeverityCount severity="ok" count={counts.ok} />
            <SeverityCount severity="ignored" count={counts.ignored} />
          </span>
        ) : null}
        <span className="ml-auto">
          Press <kbd className="rounded-xs border border-line px-1 font-mono">/</kbd>{" "}
          to filter use cases
        </span>
      </footer>

      <KeyDialog
        open={keyOpen}
        onClose={() => setKeyOpen(false)}
        value={key}
        onSave={setKey}
      />
    </div>
  );
}
