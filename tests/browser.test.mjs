/**
 * The app, in a real browser, as it is actually deployed.
 *
 * This suite exists because of a bug that every other check missed. `import.meta.glob` is a
 * COMPILE-TIME transform, and the loader was guarded with `typeof import.meta.glob ===
 * "function"` — an expression the transform leaves alone, which is `false` in a browser. The
 * production bundle therefore resolved the entire compiled specification to `{}`: no use
 * cases, no structures, every surface dead. The Node suites passed (they install their own
 * resolver) and the SSR suite passed (Vite's Node transform defines the glob), so nothing
 * caught it until the page was opened.
 *
 * The lesson is the test: the only environment that proves a browser app works is a browser,
 * running the built bundle, with the console watched for errors.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, waitFor, withPage } from "./cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 41733;
// `localhost`, not `127.0.0.1`: vite preview binds the loopback name, which resolves to ::1
// on a dual-stack machine, and polling the IPv4 literal then never sees the server come up.
const URL = `http://localhost:${PORT}/`;

const chrome = findChrome();
const skip = chrome ? false : "no Chrome or Chromium binary on this machine";

let server;

before(async () => {
  if (skip) return;
  if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) {
    const built = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
    assert.equal(built.status, 0, "npm run build failed");
  }
  server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(URL);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("vite preview never came up");
});

after(() => server?.kill("SIGKILL"));

test("the built app loads the compiled spec and works end to end", { skip }, async () => {
  await withPage(URL, async ({ evaluate, errors }) => {
    /* --- the regression itself ---------------------------------------- */
    const railLoaded = await waitFor(
      evaluate,
      `document.body.innerText.includes("ADT") && document.querySelectorAll("nav button, aside button").length`,
      "the use-case rail",
      30000,
    );
    assert.ok(railLoaded > 0, "the rail rendered no use cases");
    // The rail fills in as the manifest resolves, so wait for the whole set rather than
    // asserting on whichever snapshot the first family happened to land in.
    await waitFor(
      evaluate,
      // Case-insensitive: the rail's family headings are uppercased in CSS, and innerText
      // reports the transformed text.
      `["hl7 v2.5.1", "fhir r4", "cda r2", "xds / soap"].every((f) => document.body.innerText.toLowerCase().includes(f))`,
      "every use-case family",
      25000,
    );
    const text = await evaluate(`document.body.innerText`);
    assert.doesNotMatch(
      text,
      /spec bundle file .* is not available|could not be loaded/,
      "the compiled spec bundle did not load in the browser",
    );

    /* --- Check: load an official sample and run it --------------------- */
    await waitFor(
      evaluate,
      `[...document.querySelectorAll("button")].some((b) => /ADT_sample/.test(b.textContent))`,
      "an official sample to load",
      30000,
    );
    await evaluate(
      `[...document.querySelectorAll("button")].find((b) => /ADT_sample/.test(b.textContent)).click()`,
    );
    const chars = await waitFor(
      evaluate,
      `document.querySelector("textarea")?.value.length || 0`,
      "the sample to load into the paste box",
    );
    assert.ok(chars > 500, `the official sample loaded only ${chars} characters`);

    await evaluate(
      `[...document.querySelectorAll("button")].find((b) => /Check structure/.test(b.textContent)).click()`,
    );
    const treeRows = await waitFor(
      evaluate,
      `document.querySelectorAll('[role="treeitem"]').length`,
      "the structure tree",
      30000,
    );
    assert.ok(treeRows > 10, `the structure tree rendered ${treeRows} rows`);

    // Both panes are windowed, so wait for the rows rather than sampling the first frame.
    await waitFor(evaluate, `document.body.innerText.includes("MSH|")`, "the message in the code pane", 20000);
    const findings = await waitFor(
      evaluate,
      `(() => {
        const head = [...document.querySelectorAll("span")].find((s) => s.textContent.trim() === "Findings");
        const pane = head?.closest("div")?.parentElement;
        return pane ? pane.querySelectorAll('[role="button"]').length : 0;
      })()`,
      "the findings pane",
      20000,
    );
    assert.ok(findings > 0, "the findings pane is empty for a message with known defects");

    /* --- the other surfaces -------------------------------------------- */
    await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Explain").click()`);
    const rules = await waitFor(evaluate, `document.querySelectorAll('[role="treeitem"]').length`, "the rule tree", 25000);
    assert.ok(rules > 10, `Explain rendered ${rules} rule rows`);

    await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Build").click()`);
    const profile = await waitFor(evaluate, `document.querySelectorAll("table tbody tr").length`, "the profile table", 25000);
    assert.ok(profile > 5, `Build rendered ${profile} rows`);

    await evaluate(`[...document.querySelectorAll("button")].find((b) => /Error Decoder/.test(b.textContent)).click()`);
    await waitFor(evaluate, `document.querySelectorAll("textarea").length`, "the decoder");
    await evaluate(`(() => {
      const ta = document.querySelector("textarea");
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      set.call(ta, "Required field missing PID/PatientIdentifierList[0]/IDNumber");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    const matched = await waitFor(
      evaluate,
      `/([1-9]\\d*) catalogue entr(y|ies) matched/.test(document.body.innerText)`,
      "the decoder to match a real rejection",
      15000,
    );
    assert.ok(matched, "the decoder matched nothing for a rejection quoted from the guide");

    await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Readiness").click()`);
    await waitFor(evaluate, `document.body.innerText.includes("not checked")`, "the readiness matrix", 20000);

    await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Coverage").click()`);
    await waitFor(evaluate, `document.body.innerText.includes("rules")`, "the coverage surface", 20000);

    /* --- nothing threw along the way ----------------------------------- */
    assert.deepEqual(errors, [], `the page logged errors:\n${errors.join("\n")}`);
  });
});
