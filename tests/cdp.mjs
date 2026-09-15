/**
 * A minimal Chrome DevTools Protocol driver.
 *
 * The workbench is a browser app, and the only environment that proves it works is a browser.
 * Node's built-in WebSocket is enough to drive one, so this needs no dependency: launch
 * headless Chrome, evaluate expressions in the page, and collect every console error and
 * uncaught exception along the way.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findChrome() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

async function waitForTarget(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is not listening yet.
    }
    if (Date.now() > deadline) throw new Error("Chrome never opened a debuggable page");
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Open a page and hand it to `run`.
 *
 * `run` receives `{ evaluate, errors }`: `evaluate` runs an expression in the page and
 * resolves to its value (awaiting promises), and `errors` accumulates console errors and
 * uncaught exceptions, so a test can assert the page ran cleanly, not merely that it rendered.
 */
export async function withPage(url, run, { port = 9333 } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error("no Chrome or Chromium binary found");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nw-chrome-"));
  const proc = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--disable-extensions",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let socket;
  const errors = [];
  try {
    const wsUrl = await waitForTarget(port);
    socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
    });

    let nextId = 1;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        errors.push(`uncaught: ${d.exception?.description ?? d.text}`);
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        errors.push(`console.error: ${msg.params.args.map((a) => a.description ?? a.value).join(" ")}`);
      }
    });

    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });

    await send("Runtime.enable");
    await send("Page.enable");

    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          `page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
        );
      }
      return result.result.value;
    };

    await send("Page.navigate", { url });
    await evaluate(
      `new Promise((r) => (document.readyState === "complete" ? r(1) : addEventListener("load", () => r(1))))`,
    );

    return await run({ evaluate, errors });
  } finally {
    try {
      socket?.close();
    } catch {
      // already gone
    }
    proc.kill("SIGKILL");
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

/** Poll an expression in the page until it is truthy. */
export const waitFor = (evaluate, expression, what, timeoutMs = 20000) =>
  evaluate(`(async () => {
    const deadline = Date.now() + ${timeoutMs};
    for (;;) {
      try { const v = (${expression}); if (v) return v; } catch (e) { /* not ready */ }
      if (Date.now() > deadline) throw new Error(${JSON.stringify(`timed out waiting for ${what}`)});
      await new Promise((r) => setTimeout(r, 100));
    }
  })()`);
