import { useCallback, useEffect, useState } from "react";
import { Badge, cx } from "../ui";

/* ========================================================================== *
 * Welcome — the first-run surface.
 *
 * Shown in place of the work area until the person has chosen how to start. It has one job:
 * say what ISIT is for and why it can be trusted, in the time it takes to read a card. Nothing
 * on it has been judged yet, so it uses no severity token anywhere — the accent is the only
 * colour, and it means "here is where to go", never "this is fine".
 * ========================================================================== */

const STORAGE_KEY = "isit.welcomed";

function readWelcomed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    /* storage blocked — show it, the cost is one extra click */
    return false;
  }
}

/**
 * Whether the welcome is open, and whether it has ever been dismissed. `open` and `welcomed`
 * are separate because the header's About button reopens the same surface for someone who
 * has already been through it, and its quiet action reads differently then.
 */
export function useWelcome() {
  const [state, setState] = useState(() => {
    const welcomed = readWelcomed();
    return { open: !welcomed, welcomed };
  });

  useEffect(() => {
    if (!state.welcomed) return;
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* storage blocked */
    }
  }, [state.welcomed]);

  const dismiss = useCallback(() => setState({ open: false, welcomed: true }), []);
  const reopen = useCallback(() => setState((s) => ({ ...s, open: true })), []);

  return { open: state.open, welcomed: state.welcomed, dismiss, reopen };
}

export interface WelcomeProps {
  /** True until it has been dismissed once; the quiet action's wording depends on it. */
  firstRun: boolean;
  /** Select the use case with the richest set of official samples and open Check. */
  onCheckSample: () => void;
  /** Open Check on whatever use case is selected, ready for a paste. */
  onStart: () => void;
  onDismiss: () => void;
}

const PROMISES: Array<{ glyph: string; title: string; body: string }> = [
  {
    glyph: "⌂",
    title: "Nothing leaves this browser",
    body: "The specification is compiled into the page. What you paste is parsed and checked here, and is never sent anywhere.",
  },
  {
    glyph: "§",
    title: "Every finding cites its page",
    body: "Each rule the checker applies links to the specification page it rests on, so a finding can be read against the source that produced it.",
  },
  {
    glyph: "?",
    title: "Unknown is reported as unknown",
    body: "A rule with no evidence behind it is reported as unchecked — never as passed. A confidently wrong verdict costs a hospital more than an acknowledged gap.",
  },
];

export function Welcome({ firstRun, onCheckSample, onStart, onDismiss }: WelcomeProps) {
  return (
    <section aria-labelledby="welcome-title" className="h-full overflow-auto bg-canvas">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-10 sm:py-14">
        <header className="flex flex-col gap-3">
          <Badge tone="accent" className="self-start">
            Welcome
          </Badge>
          <h1 id="welcome-title" className="text-2xl font-semibold tracking-tight text-ink">
            Check the structure before the hospital submits.
          </h1>
          <p className="max-w-xl text-base text-ink-2">
            ISIT holds every NPHIES message structure — HL7 v2, FHIR, CDA and SOAP — as compiled
            rules. Paste what your HIS produced and it shows each structural deviation, located in
            the message and explained.
          </p>
        </header>

        <ul className="grid gap-3 sm:grid-cols-3" aria-label="What ISIT promises">
          {PROMISES.map((p) => (
            <li key={p.title} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
              <span
                aria-hidden="true"
                className="inline-flex h-7 w-7 items-center justify-center rounded-sm bg-accent-soft font-mono text-base text-accent"
              >
                {p.glyph}
              </span>
              <span className="text-sm font-semibold text-ink">{p.title}</span>
              <span className="text-sm text-ink-2">{p.body}</span>
            </li>
          ))}
        </ul>

        <div className="grid gap-3 sm:grid-cols-2">
          <ActionCard
            primary
            title="Check an official sample"
            body="Opens the ADT use case with NPHIES' own published samples one click away — the quickest way to see what a finding looks like."
            onClick={onCheckSample}
          />
          <ActionCard
            title="Start with my own message"
            body="Pick a use case in the rail, paste what your system produced, and press Check."
            onClick={onStart}
          />
        </div>

        <button
          type="button"
          onClick={onDismiss}
          className="self-start text-xs text-ink-3 underline-offset-2 transition-colors hover:text-ink hover:underline"
        >
          {firstRun ? "Don't show this again" : "Close"}
        </button>
      </div>
    </section>
  );
}

function ActionCard({
  title,
  body,
  onClick,
  primary,
}: {
  title: string;
  body: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "flex flex-col gap-2 rounded-lg border p-5 text-left transition-colors",
        primary ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-accent hover:bg-accent-soft",
      )}
    >
      <span className="flex items-center justify-between gap-3">
        <span className="text-lg font-semibold text-ink">{title}</span>
        <span aria-hidden="true" className="font-mono text-lg text-accent">
          →
        </span>
      </span>
      <span className="text-sm text-ink-2">{body}</span>
    </button>
  );
}
