import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "./Button";
import { cx } from "./cx";

export const API_KEY_STORAGE_KEY = "isit.anthropic-api-key";

/** What the key was stored under before the tool was named ISIT. Read once, then migrated. */
const LEGACY_API_KEY_STORAGE_KEY = "nphies-workbench.anthropic-api-key";

/* ------------------------------------------------------------------ hook -- */

/**
 * Reads/writes the Anthropic API key in localStorage. The key never leaves the
 * browser through this app's code; it is only ever attached to requests the
 * browser makes directly to Anthropic.
 */
export function useApiKey(storageKey: string = API_KEY_STORAGE_KEY) {
  const [key, setKeyState] = useState<string>(() => {
    try {
      const current = localStorage.getItem(storageKey);
      if (current) return current;
      // Carry a key stored under the old product name across, rather than silently
      // losing something the user had to paste in by hand.
      if (storageKey === API_KEY_STORAGE_KEY) {
        const legacy = localStorage.getItem(LEGACY_API_KEY_STORAGE_KEY);
        if (legacy) {
          localStorage.setItem(storageKey, legacy);
          localStorage.removeItem(LEGACY_API_KEY_STORAGE_KEY);
          return legacy;
        }
      }
      return "";
    } catch {
      return "";
    }
  });

  const setKey = useCallback(
    (next: string) => {
      setKeyState(next);
      try {
        if (next) localStorage.setItem(storageKey, next);
        else localStorage.removeItem(storageKey);
      } catch {
        /* private mode / blocked storage: keep it in memory for this session */
      }
    },
    [storageKey],
  );

  return { key, setKey, hasKey: key.length > 0 };
}

/** `sk-ant-api03-...` -> `sk-ant-…4f2a`. Never render the full key. */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "•".repeat(key.length);
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

/* ---------------------------------------------------------------- dialog -- */

export interface KeyDialogProps {
  open: boolean;
  onClose: () => void;
  /** Current stored key (may be empty). */
  value: string;
  /** Called with the new key, or "" to clear it. */
  onSave: (key: string) => void;
  /** Where the key is used, one short sentence. */
  purpose?: ReactNode;
}

export function KeyDialog({
  open,
  onClose,
  value,
  onSave,
  purpose = "Explain findings in plain language and draft structural fixes.",
}: KeyDialogProps) {
  const titleId = useId();
  const descId = useId();
  const inputId = useId();
  const [draft, setDraft] = useState(value);
  const [reveal, setReveal] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setDraft(value);
      setReveal(false);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = panelRef.current;
      if (!root) return;
      const f = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const looksWrong = draft.length > 0 && !draft.startsWith("sk-ant-");

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/45 p-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="w-full max-w-md rounded-md border border-line bg-surface shadow-[0_8px_32px_rgba(0,0,0,0.28)]"
      >
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h2 id={titleId} className="text-lg font-semibold text-ink">
            Anthropic API key
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-xs px-1 text-ink-3 hover:bg-inset hover:text-ink"
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>

        <form
          className="space-y-3 px-3 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(draft.trim());
            onClose();
          }}
        >
          <p id={descId} className="text-sm leading-5 text-ink-2">
            Optional. Used only to: {purpose} Structure checking works without a
            key &mdash; the rules are compiled from the NPHIES specification and
            evaluated locally.
          </p>

          <div className="rounded-sm border border-line bg-inset px-2.5 py-2 text-xs leading-4 text-ink-2">
            <strong className="font-semibold text-ink">
              The key stays in this browser.
            </strong>{" "}
            It is saved in this browser&rsquo;s <code className="font-mono">localStorage</code> under{" "}
            <code className="font-mono">{API_KEY_STORAGE_KEY}</code>, and is sent
            only to <code className="font-mono">api.anthropic.com</code> from
            this machine. This tool has no backend: nothing is uploaded, logged
            or shared. Clearing it below removes it from storage immediately.
          </div>

          <div className="space-y-1">
            <label
              htmlFor={inputId}
              className="block text-xs font-medium text-ink-2"
            >
              Key
            </label>
            <div className="flex items-center gap-1.5">
              <input
                ref={inputRef}
                id={inputId}
                type={reveal ? "text" : "password"}
                value={draft}
                autoComplete="off"
                spellCheck={false}
                placeholder={"sk-ant-api03-…"}
                onChange={(e) => setDraft(e.target.value)}
                aria-invalid={looksWrong || undefined}
                aria-describedby={looksWrong ? `${inputId}-hint` : undefined}
                className={cx(
                  "h-7 min-w-0 flex-1 rounded-sm border bg-canvas px-2 font-mono text-xs text-ink",
                  "placeholder:text-ink-3",
                  looksWrong ? "border-warn" : "border-line",
                )}
              />
              <Button
                onClick={() => setReveal((r) => !r)}
                aria-pressed={reveal}
                aria-label={reveal ? "Hide key" : "Show key"}
              >
                {reveal ? "Hide" : "Show"}
              </Button>
            </div>
            {looksWrong ? (
              <p id={`${inputId}-hint`} className="text-xs text-warn">
                Anthropic keys normally start with{" "}
                <code className="font-mono">sk-ant-</code>. Saving anyway is
                fine if you know what you are doing.
              </p>
            ) : value ? (
              <p className="text-xs text-ink-3">
                Currently stored:{" "}
                <code className="font-mono">{maskKey(value)}</code>
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line pt-2.5">
            <Button
              variant="danger"
              disabled={!value && !draft}
              onClick={() => {
                setDraft("");
                onSave("");
              }}
            >
              Clear stored key
            </Button>
            <div className="flex items-center gap-1.5">
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" type="submit">
                Save
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
