import { useCallback, useRef, useState } from "react";
import { Button, type ButtonProps } from "./Button";
import { useToast } from "./Toast";

export interface CopyButtonProps
  extends Omit<ButtonProps, "onClick" | "children" | "value"> {
  /** Text to copy, or a getter for large payloads that should not be held in props. */
  value: string | (() => string);
  label?: string;
  copiedLabel?: string;
  /** Also raise a toast (no-op outside a ToastProvider). */
  toast?: boolean;
  /** Describes what was copied, for the toast and the screen-reader message. */
  what?: string;
}

export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  toast = false,
  what,
  variant = "ghost",
  size = "sm",
  ...rest
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { push } = useToast();

  const onClick = useCallback(async () => {
    const text = typeof value === "function" ? value() : value;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = false;
    }
    setCopied(ok);
    setFailed(!ok);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 1600);
    if (toast) {
      push(
        ok
          ? { title: what ? `Copied ${what}` : "Copied to clipboard" }
          : {
              title: "Could not copy",
              detail: "The browser blocked clipboard access. Select the text and copy manually.",
            },
      );
    }
  }, [value, toast, push, what]);

  return (
    <>
      <Button
        variant={variant}
        size={size}
        onClick={onClick}
        aria-label={what ? `Copy ${what}` : label}
        {...rest}
      >
        {failed ? "Copy failed" : copied ? copiedLabel : label}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? `${what ?? "Content"} copied to clipboard` : ""}
      </span>
    </>
  );
}
