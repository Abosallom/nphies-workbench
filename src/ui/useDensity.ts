import { useCallback, useEffect, useState } from "react";

export type DensityChoice = "dense" | "roomy";

const STORAGE_KEY = "isit.density";

/**
 * Layout density stamped on <html data-density>. "dense" is the instrument
 * the app was designed as; "roomy" is presentation mode. The whole rescale is
 * one CSS block in index.css that redefines --spacing, the --text-* scale and
 * --radius-*, which every Tailwind utility already reads — so no component
 * takes a density prop and none should.
 */
export function useDensity() {
  const [density, setDensityState] = useState<DensityChoice>(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === "dense" || v === "roomy") return v;
    } catch {
      /* storage blocked */
    }
    return "dense";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-density", density);
    try {
      localStorage.setItem(STORAGE_KEY, density);
    } catch {
      /* storage blocked */
    }
  }, [density]);

  const setDensity = useCallback((d: DensityChoice) => setDensityState(d), []);

  const toggle = useCallback(() => {
    setDensityState((d) => (d === "dense" ? "roomy" : "dense"));
  }, []);

  return { density, setDensity, toggle };
}
