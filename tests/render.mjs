/**
 * Mount every view in Node, through Vite's own SSR pipeline.
 *
 * This is the app exactly as it is bundled — same JSX transform, same `import.meta.glob`
 * spec loading — so a view that throws on first render fails here rather than in front of an
 * analyst. It is a smoke test, not a visual one: it asserts that each surface mounts and puts
 * its own subject on the page.
 */
import React from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";

/* The browser surface the design system touches while rendering. */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});

export async function withApp(run) {
  const server = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    logLevel: "error",
  });
  try {
    const load = (p) => server.ssrLoadModule(p);
    await run({ load, render: (el) => renderToString(el), h: React.createElement });
  } finally {
    await server.close();
  }
}
