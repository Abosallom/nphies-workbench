#!/usr/bin/env node
/**
 * Copy the official NPHIES sample messages into `public/golden/` so the deployed app can
 * load them.
 *
 * `spec-source/` is gitignored — it is large and re-derivable — but the 62 samples ARE the
 * reference an analyst compares their own message against, and a static page has nowhere
 * else to fetch them from. They are small (2.8 MB) and public: NPHIES publishes them as
 * Confluence attachments with no authentication.
 *
 * Usage: node scripts/copy-samples.mjs [--check]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FROM = path.join(ROOT, "spec-source", "golden");
const TO = path.join(ROOT, "public", "golden");
const checkOnly = process.argv.includes("--check");

if (!fs.existsSync(FROM)) {
  // In CI the raw scrape is absent — `spec-source/` is gitignored — but `public/golden/` is
  // committed, so the samples are already where the app looks for them. Only a build that
  // has NEITHER is broken.
  const already = fs.existsSync(TO) && fs.readdirSync(TO).length > 0;
  console[already ? "log" : "error"](
    already
      ? `copy-samples: ${path.relative(ROOT, FROM)} is absent; using the committed copies in public/golden/.`
      : `copy-samples: neither ${path.relative(ROOT, FROM)} nor public/golden/ exists — the app would ship with no reference messages.`,
  );
  process.exit(already ? 0 : 1);
}

let copied = 0;
let bytes = 0;

const walk = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      walk(src, dst);
      continue;
    }
    const stat = fs.statSync(src);
    const fresh = fs.existsSync(dst) && fs.statSync(dst).size === stat.size;
    if (!fresh && !checkOnly) fs.copyFileSync(src, dst);
    if (!fresh) copied++;
    bytes += stat.size;
  }
};

walk(FROM, TO);
console.log(
  checkOnly
    ? `copy-samples: ${copied} file(s) would be copied (${(bytes / 1e6).toFixed(1)} MB total).`
    : `copy-samples: ${copied} file(s) copied, ${(bytes / 1e6).toFixed(1)} MB in public/golden/.`,
);
