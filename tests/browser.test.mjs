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
//
// ISIT_BROWSER_URL points the whole suite at a deployed site instead of the local preview —
// the same journey, against what users actually get. That is how the live site is re-audited
// after every deploy.
const LIVE = process.env.ISIT_BROWSER_URL;
const URL = LIVE ?? `http://localhost:${PORT}/`;

const chrome = findChrome();
const skip = chrome ? false : "no Chrome or Chromium binary on this machine";

let server;

before(async () => {
  if (skip) return;
  if (LIVE) return; // nothing to build or serve: the site under test is already published
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

    /* --- first run: the Welcome sits in front of the work area --------- */
    // A fresh profile is a first run, so the onboarding surface is what a new user sees.
    // Go through it the way they would: the "Check an official sample" action selects ADT and
    // opens Check. This exercises the onboarding flow rather than bypassing it via storage.
    await waitFor(
      evaluate,
      `[...document.querySelectorAll("button")].some((b) => /Check an official sample/i.test(b.textContent))`,
      "the first-run welcome",
      30000,
    );
    await evaluate(
      `[...document.querySelectorAll("button")].find((b) => /Check an official sample/i.test(b.textContent)).click()`,
    );
    const welcomed = await waitFor(
      evaluate,
      `localStorage.getItem("isit.welcomed") === "1" && ![...document.querySelectorAll("button")].some((b) => /Check an official sample/i.test(b.textContent))`,
      "the welcome to dismiss and persist",
      10000,
    );
    assert.ok(welcomed, "dismissing the welcome did not persist");

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

    /*
     * The detector, end to end. Loading an official sample selects its own variant, so the
     * banner should first CONFIRM. Then the analyst picks the wrong variant on purpose — the
     * mistake that used to produce a page of confidently wrong "required but missing"
     * findings — and the banner must name the evidence and OFFER the switch, never perform it.
     */
    await waitFor(
      evaluate,
      `document.querySelector("main select")?.value === "adt-a03" && /A03/.test(document.querySelector("main").innerText)`,
      "the sample to select its own variant and the detector to confirm it",
      20000,
    );
    await evaluate(`(() => {
      const select = document.querySelector("main select");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(select, "adt-a01");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitFor(
      evaluate,
      `[...document.querySelectorAll("button")].some((b) => /^Switch to/.test(b.textContent.trim()))`,
      "the detector banner offering a switch after the analyst picked A01",
      20000,
    );
    const bannerText = await evaluate(`document.querySelector("main").innerText`);
    assert.match(bannerText, /A03/, "the detector banner does not name the detected event");
    const selectedBefore = await evaluate(`document.querySelector("main select")?.value ?? null`);
    assert.equal(selectedBefore, "adt-a01", "the detector switched the structure on its own");
    await evaluate(
      `[...document.querySelectorAll("button")].find((b) => /^Switch to/.test(b.textContent.trim())).click()`,
    );
    const selectedAfter = await waitFor(
      evaluate,
      `document.querySelector("main select")?.value === "adt-a03" ? "adt-a03" : 0`,
      "the analyst's click to select A03",
      10000,
    );
    assert.equal(selectedAfter, "adt-a03");

    await evaluate(
      `[...document.querySelectorAll("button")].find((b) => /Check structure/.test(b.textContent)).click()`,
    );
    // Scope to the pane: the use-case rail is a tree too, so a bare [role="treeitem"] count
    // passes on the rail alone and proves nothing about the message.
    const treeRows = await waitFor(
      evaluate,
      `document.querySelectorAll('[aria-label="Message structure"] [role="treeitem"]').length`,
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

    /*
     * Clicking a finding must not empty the list it came from.
     *
     * Findings are scoped to the selection, and the scope used to be matched on path TEXT: a
     * finding's path is the checker's (`ADT^A03/MSH/MSH-6`), a node's is built from labels
     * (`Message Header/Receiving Facility`). They never matched, so selecting a finding
     * reported "nothing to report" about the element that had just reported something.
     */
    const afterClick = await evaluate(`(() => {
      const head = [...document.querySelectorAll("span")].find((s) => s.textContent.trim() === "Findings");
      const pane = head?.closest("div")?.parentElement;
      const row = [...pane.querySelectorAll('[role="button"]')].find((r) =>
        [...r.querySelectorAll("button")].some((b) => /reveal/i.test(b.textContent)),
      );
      if (!row) return null;
      row.click();
      return new Promise((r) =>
        setTimeout(
          () =>
            r({
              stillListed: pane.querySelectorAll('[role="button"]').length,
              markedSelected: document.querySelectorAll('[aria-pressed="true"]').length,
              // The structure pane names the selected node as a path, e.g.
              // "Message Header/Receiving Facility". Injected code carries no newline
              // escapes: a template literal turns one into a real line break and the page
              // then sees an unterminated string.
              treeFollowed: (
                document.querySelector('[aria-label="Structure and findings"]')?.innerText || ""
              ).includes("/"),
            }),
          700,
        ),
      );
    })()`);
    assert.ok(afterClick, "no finding offered a reveal affordance");
    assert.ok(afterClick.stillListed > 0, "clicking a finding emptied the findings pane");
    assert.equal(afterClick.markedSelected, 1, "the clicked finding is not marked as selected");
    assert.ok(afterClick.treeFollowed, "the structure pane did not follow the selection");

    /* --- the anatomy map: a click lands in the code pane ----------------- */
    const blocks = await waitFor(
      evaluate,
      `document.querySelectorAll('[aria-label^="Message anatomy"] [role="option"]').length`,
      "the anatomy map",
      20000,
    );
    assert.ok(blocks >= 4, `the anatomy map drew only ${blocks} blocks for an ADT message`);
    const anatomyClick = await evaluate(`(() => {
      const options = [...document.querySelectorAll('[aria-label^="Message anatomy"] [role="option"]')];
      // The blocks are SVG elements: no HTMLElement.click(), so dispatch the event a user would.
      options[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return new Promise((r) =>
        setTimeout(
          () =>
            r({
              selected: document.querySelectorAll('[aria-label^="Message anatomy"] [aria-selected="true"]').length,
              structureHeader: (document.querySelector('[aria-label="Structure and findings"]')?.innerText || "").includes("/"),
            }),
          600,
        ),
      );
    })()`);
    assert.equal(anatomyClick.selected, 1, "clicking a block did not select exactly one block");
    assert.ok(anatomyClick.structureHeader, "clicking a block did not select a node in the structure pane");

    /* --- presentation mode: bigger type AND bigger rows ------------------ */
    // Row heights are JS constants feeding the virtualiser; a token-only rescale would leave
    // 15px type inside 20px rows. Both must move together or rows overlap.
    const denseRow = await evaluate(
      `document.querySelector('[aria-label="Message structure"] [role="treeitem"]')?.offsetHeight ?? 0`,
    );
    const denseFont = await evaluate(`parseFloat(getComputedStyle(document.body).fontSize)`);
    await evaluate(`document.querySelector('[aria-label="Presentation layout"]').click()`);
    await waitFor(
      evaluate,
      `document.documentElement.getAttribute("data-density") === "roomy"`,
      "the roomy density to stamp <html>",
      10000,
    );
    const roomy = await evaluate(`(() => ({
      stored: localStorage.getItem("isit.density"),
      font: parseFloat(getComputedStyle(document.body).fontSize),
      row: document.querySelector('[aria-label="Message structure"] [role="treeitem"]')?.offsetHeight ?? 0,
      codeStillThere: document.body.innerText.includes("MSH|"),
      verdictBar: !!document.querySelector('main [role="img"], main svg'),
    }))()`);
    assert.equal(roomy.stored, "roomy", "the density choice was not persisted");
    assert.ok(roomy.font > denseFont, `type did not grow (dense ${denseFont}px, roomy ${roomy.font}px)`);
    assert.ok(roomy.row > denseRow, `tree rows did not grow (dense ${denseRow}px, roomy ${roomy.row}px)`);
    assert.ok(roomy.codeStillThere, "presentation mode hid the wire message");

    /* --- the advisory panel exists, is inert without a key, and the AI footer is redacted -- */
    // The panel is collapsed until asked for; open it the way a user would, from its header.
    await evaluate(`(() => {
      const main = document.querySelector("main");
      const header = [...main.querySelectorAll("button, summary")].find((el) =>
        /Model opinion|second opinion|advisor/i.test(el.textContent),
      );
      header?.click();
    })()`);
    await waitFor(evaluate, `/no Anthropic API key/i.test(document.querySelector("main").innerText)`, "the advisory panel to open", 10000);
    const advisory = await evaluate(`(() => {
      const main = document.querySelector("main");
      const text = main.innerText;
      return {
        disclaimer: text.includes("Model opinion — not a structural verdict"),
        noKeyExplained: /no Anthropic API key/i.test(text),
        // Findings still say what the model would be sent, and that it is redacted.
        footerRedacted: [...main.querySelectorAll("button")].some((b) => /Explain for my HIS team/.test(b.textContent))
          ? /redacted excerpt/.test(text)
          : /needs a key|redacted/.test(text),
        // Nothing in the advisory region wears a verdict colour.
        panelSeverityClasses: [...main.querySelectorAll('[class*="border-dashed"] *')].filter((el) =>
          /\b(bg|text|border)-(error|warn|ok)\b/.test(el.className || ""),
        ).length,
      };
    })()`);
    assert.ok(advisory.disclaimer, "the advisory panel does not carry its disclaimer");
    assert.ok(advisory.noKeyExplained, "with no key, the panel does not say why the model is inert");
    assert.ok(advisory.footerRedacted, "the AI footer no longer says its excerpt is redacted");
    assert.equal(advisory.panelSeverityClasses, 0, "a verdict colour leaked into the advisory region");

    /* --- the other surfaces -------------------------------------------- */
    await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Explain").click()`);
    const rules = await waitFor(
      evaluate,
      `document.querySelectorAll('[aria-label="Structure rules"] [role="treeitem"]').length`,
      "the rule tree",
      25000,
    );
    assert.ok(rules > 10, `Explain rendered ${rules} rule rows`);

    await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Build").click()`);
    const profile = await waitFor(evaluate, `document.querySelectorAll("table tbody tr").length`, "the profile table", 25000);
    assert.ok(profile > 5, `Build rendered ${profile} rows`);
    const importOffered = await evaluate(
      `[...document.querySelectorAll("main button")].some((b) => /Import profile/.test(b.textContent))`,
    );
    assert.ok(importOffered, "Build no longer offers to import a vendor profile");
    // Still roomy: the summary panel with the donut must be there, and the obligation chart.
    await waitFor(evaluate, `!!document.querySelector('[aria-label="Build summary"]')`, "the roomy Build summary", 10000);
    await waitFor(evaluate, `!!document.querySelector('[aria-label^="Obligations across"]')`, "the obligations chart", 10000);
    const ignoredShown = await evaluate(`/Do not build/.test(document.querySelector("main").innerText)`);
    assert.ok(ignoredShown, "Build no longer states what NPHIES ignores");

    // Back to dense, and the app must follow.
    await evaluate(`document.querySelector('[aria-label="Dense layout"]').click()`);
    await waitFor(
      evaluate,
      `document.documentElement.getAttribute("data-density") !== "roomy"`,
      "the dense density to return",
      10000,
    );

    /* --- Ingest: the tab exists, states its privacy rule, and the model stays inert -- */
    await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Ingest").click()`);
    await waitFor(evaluate, `!!document.querySelector('main input[type="file"]')`, "the ingest upload", 20000);
    const ingest = await evaluate(`(() => {
      const text = document.querySelector("main").innerText;
      return {
        privacy: /stays in this browser/i.test(text) && /column names/i.test(text),
        acceptsSheets: /\.xlsx|\.csv/i.test(document.querySelector('main input[type="file"]').getAttribute("accept") || "") || /xlsx|csv/i.test(text),
      };
    })()`);
    assert.ok(ingest.privacy, "Ingest does not state that cell data stays in the browser");
    assert.ok(ingest.acceptsSheets, "Ingest does not accept spreadsheets");

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
    await waitFor(evaluate, `!!document.querySelector('[aria-label="Spec defects by kind"]')`, "the spec-defect chart", 15000);
    // The SOAP pane used to colour a provenance SHARE with verdict colours; it is a bar now.
    await evaluate(`[...document.querySelectorAll("main button")].find((b) => /^SOAP/.test(b.textContent.trim()))?.click()`);
    await waitFor(
      evaluate,
      `!!document.querySelector('[aria-label="Independently sourced rules by element kind"]')`,
      "the provenance bars",
      15000,
    );

    /* --- nothing threw along the way ----------------------------------- */
    assert.deepEqual(errors, [], `the page logged errors:\n${errors.join("\n")}`);
  });
});
