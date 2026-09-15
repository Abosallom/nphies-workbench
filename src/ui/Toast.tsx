import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cx } from "./cx";
import { SEV_CHIP } from "./severity";
import { SEVERITY_GLYPH, type Severity } from "./types";

export interface ToastMessage {
  id: string;
  title: string;
  detail?: string;
  /** Uses the reserved severity palette ONLY when the toast reports a verdict. */
  tone?: Severity | "neutral";
  /** ms; 0 keeps it until dismissed. */
  duration?: number;
}

interface ToastApi {
  push: (t: Omit<ToastMessage, "id"> & { id?: string }) => string;
  dismiss: (id: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

/** Safe outside a provider: falls back to a no-op so components stay portable. */
export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  return ctx ?? NOOP;
}

const NOOP: ToastApi = { push: () => "", dismiss: () => {} };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastMessage[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const push = useCallback<ToastApi["push"]>(
    (t) => {
      const id = t.id ?? `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setItems((xs) => [...xs.filter((x) => x.id !== id), { ...t, id }]);
      const duration = t.duration ?? 3200;
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <ToastViewport items={items} onDismiss={dismiss} />
    </Ctx.Provider>
  );
}

export function ToastViewport({
  items,
  onDismiss,
}: {
  items: ToastMessage[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-3 right-3 z-[100] flex w-80 flex-col gap-1.5"
    >
      {items.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

export function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastMessage;
  onDismiss: () => void;
}) {
  const tone = toast.tone ?? "neutral";
  return (
    <div
      role="status"
      className={cx(
        "pointer-events-auto flex items-start gap-2 rounded-sm border border-line bg-surface px-2.5 py-2",
        "shadow-[0_2px_10px_rgba(0,0,0,0.16)]",
      )}
    >
      {tone !== "neutral" ? (
        <span
          aria-hidden="true"
          className={cx(
            "mt-px inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-xs font-mono text-2xs font-bold",
            SEV_CHIP[tone],
          )}
        >
          {SEVERITY_GLYPH[tone]}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-ink">{toast.title}</div>
        {toast.detail ? (
          <div className="mt-0.5 text-xs leading-4 text-ink-2">{toast.detail}</div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="-mr-1 -mt-0.5 shrink-0 rounded-xs px-1 text-ink-3 hover:bg-inset hover:text-ink"
      >
        <span aria-hidden="true">&times;</span>
      </button>
    </div>
  );
}
