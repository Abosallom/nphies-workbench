import { useCallback, useEffect, useRef, useState } from "react";

export interface VirtualWindow {
  /** First row index to render (inclusive). */
  start: number;
  /** Last row index to render (exclusive). */
  end: number;
  /** Total scrollable height in px. */
  totalHeight: number;
  /** Offset to translate the rendered slice by. */
  offsetY: number;
}

export interface UseVirtualRowsOptions {
  count: number;
  rowHeight: number;
  /** Extra rows rendered above and below the viewport. */
  overscan?: number;
}

/**
 * Fixed-row-height windowing. Deliberately small and dependency-free: an 89KB
 * CDA is a couple of thousand lines, and rendering thousands of DOM rows per
 * pane makes scrolling and re-highlighting janky. We render ~60.
 *
 * Returns a ref for the scroll container, the current window, and a
 * `scrollToRow` used for cross-pane selection.
 */
export function useVirtualRows({
  count,
  rowHeight,
  overscan = 12,
}: UseVirtualRowsOptions) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setViewport(el.clientHeight || 600);
    setScrollTop(el.scrollTop);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(viewport / rowHeight) + overscan * 2;
  const start = count === 0 ? 0 : Math.min(first, Math.max(0, count - 1));
  const end = Math.min(count, start + visible);

  const win: VirtualWindow = {
    start,
    end,
    totalHeight: count * rowHeight,
    offsetY: start * rowHeight,
  };

  /** Scroll `index` into view; `center` puts it mid-viewport rather than just inside. */
  const scrollToRow = useCallback(
    (index: number, center = true) => {
      const el = ref.current;
      if (!el || index < 0) return;
      const top = index * rowHeight;
      const h = el.clientHeight;
      if (center) {
        el.scrollTop = Math.max(0, top - h / 2 + rowHeight / 2);
        return;
      }
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowHeight > el.scrollTop + h)
        el.scrollTop = top + rowHeight - h;
    },
    [rowHeight],
  );

  return { ref, window: win, onScroll, scrollToRow };
}
