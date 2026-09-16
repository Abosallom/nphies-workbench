/**
 * React bindings over `src/lib/workbench.ts`.
 *
 * Every bundle load is async and cached in the workbench layer, so these hooks are thin:
 * they track loading/error state and drop results from a stale request. Nothing here
 * computes a structural verdict — that is `check()`'s job, and it stays in `lib`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  analyse,
  loadGoldenIndex,
  loadRegistry,
  resolve,
  structureForSample,
  structuresFor,
  type Analysis,
  type GoldenSample,
  type Registry,
  type ResolvedUseCase,
  type UseCaseEntry,
} from "../lib/workbench";
import type { MessageStructure } from "../lib/structure";

export interface Async<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

const IDLE = { data: null, loading: true, error: null } as const;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run an async loader, ignoring results that arrive after the inputs changed. */
function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): Async<T> {
  const [state, setState] = useState<Async<T>>(IDLE);
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    setState((prev) => ({ data: prev.data, loading: true, error: null }));
    load().then(
      (data) => {
        if (seq.current === mine) setState({ data, loading: false, error: null });
      },
      (err) => {
        if (seq.current === mine) setState({ data: null, loading: false, error: messageOf(err) });
      },
    );
    // `load` is recreated per render by design; `deps` is the real dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

/* ------------------------------------------------------------------ registry */

export function useRegistry(): Async<Registry> {
  return useAsync(() => loadRegistry(), []);
}

/* ------------------------------------------------------------- resolution -- */

export interface ResolvedState {
  resolved: ResolvedUseCase | null;
  /** Every structure for the use case, request variants first. */
  structures: MessageStructure[];
  /** The structure currently selected. */
  structure: MessageStructure | null;
}

export function useResolved(useCaseId: string | null, structureId: string | null): Async<ResolvedState> {
  return useAsync(async () => {
    if (!useCaseId) return { resolved: null, structures: [], structure: null };
    const all = await structuresFor(useCaseId);
    const wanted = structureId ? (all.find((s) => s.id === structureId) ?? null) : null;
    const chosen = wanted ?? all.find((s) => (s.direction ?? "request") === "request") ?? all[0] ?? null;
    const resolved = chosen ? await resolve(useCaseId, chosen.variant ?? chosen.id) : null;
    return { resolved, structures: all, structure: chosen };
  }, [useCaseId, structureId]);
}

/* ------------------------------------------------------------------ golden -- */

export function useGolden(useCaseId: string | null): Async<GoldenSample[]> {
  return useAsync(async () => {
    if (!useCaseId) return [];
    const index = await loadGoldenIndex();
    return index.get(useCaseId) ?? [];
  }, [useCaseId]);
}

/**
 * Which structure an official sample belongs to, so loading one selects its own variant
 * rather than checking a PDF-bodied document against the structured shape.
 */
export function structureIdForSample(
  structures: readonly MessageStructure[],
  sample: GoldenSample,
): string | null {
  return structureForSample(structures, sample)?.id ?? null;
}

/* ----------------------------------------------------------------- analysis */

export interface RunOptions {
  /**
   * Condition strings to declare for conditional-usage rows ("Report", "Order", …). Only a
   * human sets these — a model may SUGGEST one, but the click that passes it here is the
   * analyst's, and `check()` then emits the finding under its own evidence.
   */
  conditions?: readonly string[];
}

export interface AnalysisState extends Async<Analysis> {
  /** Re-run against the current text, optionally with conditions declared. */
  run: (opts?: RunOptions) => void;
  /**
   * The conditions the verdict in `data` was checked under. Empty for a plain check. Kept
   * beside the data rather than inferred from it, so the UI can say "checked as Report"
   * about exactly the run it is showing and nothing else.
   */
  conditions: readonly string[];
}

const NONE: readonly string[] = [];

type AnalysisInner = Async<Analysis> & { conditions: readonly string[] };

const CLEARED: AnalysisInner = { data: null, loading: false, error: null, conditions: NONE };

/**
 * Parse + check one message. Runs only when asked, because checking a 90KB CDA on every
 * keystroke would make the paste box unusable — and because a verdict appearing before the
 * analyst has finished pasting is a verdict about a truncated message.
 */
export function useAnalysis(
  text: string,
  structure: MessageStructure | null,
  resolved: ResolvedUseCase | null,
): AnalysisState {
  const [state, setState] = useState<AnalysisInner>(CLEARED);
  const seq = useRef(0);
  const trimmed = text.trim();

  const run = useCallback(
    (opts?: RunOptions) => {
      if (!trimmed || !structure || !resolved) {
        setState(CLEARED);
        return;
      }
      const conditions = opts?.conditions?.filter((c) => c.trim()) ?? NONE;
      const mine = ++seq.current;
      setState({ data: null, loading: true, error: null, conditions });
      analyse(text, structure, resolved, conditions.length ? { conditions } : undefined).then(
        (data) => {
          if (seq.current === mine) setState({ data, loading: false, error: null, conditions });
        },
        (err) => {
          if (seq.current === mine) setState({ data: null, loading: false, error: messageOf(err), conditions });
        },
      );
    },
    [text, trimmed, structure, resolved],
  );

  // A new message or a new structure invalidates the previous verdict immediately: showing
  // findings about the text that WAS there is the one thing worse than showing none. The
  // declared conditions go with it — they were declared about that text.
  useEffect(() => {
    seq.current++;
    setState(CLEARED);
  }, [trimmed, structure?.id]);

  return { ...state, run };
}

/* -------------------------------------------------------------------- misc -- */

/** The registry entry for one use case. */
export function useEntry(registry: Registry | null, useCaseId: string | null): UseCaseEntry | null {
  return useMemo(
    () => (registry && useCaseId ? (registry.byId.get(useCaseId) ?? null) : null),
    [registry, useCaseId],
  );
}
