import { useEffect, useRef, useState } from "react";

export interface AsyncValue<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/** Load a cached bundle once. Nothing clever — the caching lives in `src/lib`. */
export function useAsyncValue<T>(load: () => Promise<T>): AsyncValue<T> {
  const [state, setState] = useState<AsyncValue<T>>({ data: null, loading: true, error: null });
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    load().then(
      (data) => setState({ data, loading: false, error: null }),
      (err) => setState({ data: null, loading: false, error: err instanceof Error ? err.message : String(err) }),
    );
  }, [load]);
  return state;
}
