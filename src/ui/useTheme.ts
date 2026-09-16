import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "isit.theme";

/**
 * Explicit theme choice stamped on <html data-theme>. "system" removes the
 * attribute and lets `prefers-color-scheme` decide; both palettes are defined
 * in full in index.css, so neither mode is an afterthought.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<ThemeChoice>(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === "light" || v === "dark" || v === "system") return v;
    } catch {
      /* storage blocked */
    }
    return "system";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* storage blocked */
    }
  }, [theme]);

  const setTheme = useCallback((t: ThemeChoice) => setThemeState(t), []);

  const cycle = useCallback(() => {
    setThemeState((t) =>
      t === "system" ? "light" : t === "light" ? "dark" : "system",
    );
  }, []);

  return { theme, setTheme, cycle };
}
