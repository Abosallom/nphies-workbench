/**
 * Cosmetic syntax tokens for the message pane.
 *
 * Purely decorative: `SplitView` takes geometry, and nothing here affects a verdict. It is
 * deliberately a scanner rather than a parser — the pane must colour a message that does
 * NOT parse, which is the case the analyst needs most.
 */

import type { MessageEncoding } from "./structure";

export interface Token {
  line: number;
  startCol: number;
  endCol: number;
  kind: "punct" | "name" | "key" | "value" | "string" | "number" | "meta" | "comment";
}

/** Above this many lines, colour the first slice only: the pane windows rows anyway. */
const MAX_LINES = 4000;

export function highlight(text: string, encoding: MessageEncoding): Token[] {
  const lines = text.split(/\r\n|\r|\n/);
  const n = Math.min(lines.length, MAX_LINES);
  switch (encoding) {
    case "hl7v2-er7":
      return er7(lines, n);
    case "fhir-json":
      return json(lines, n);
    case "cda-xml":
    case "soap-xml":
    case "saml-xml":
      return xml(lines, n);
    default:
      return [];
  }
}

/* ------------------------------------------------------------------- HL7 v2 */

function er7(lines: string[], n: number): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    const ln = i + 1;
    if (!line) continue;
    if (/^[A-Z][A-Z0-9]{2}/.test(line)) {
      out.push({ line: ln, startCol: 0, endCol: 3, kind: "name" });
    }
    for (let c = 3; c < line.length; c++) {
      const ch = line[c];
      if (ch === "|" || ch === "^" || ch === "~" || ch === "&") {
        out.push({ line: ln, startCol: c, endCol: c + 1, kind: "punct" });
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------------- XML */

const XML_TOKEN = /<\/?([A-Za-z_][\w.:-]*)|(\/?>)|([A-Za-z_][\w.:-]*)\s*=\s*("[^"]*"|'[^']*')/g;

function xml(lines: string[], n: number): Token[] {
  const out: Token[] = [];
  let inComment = false;
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    const ln = i + 1;
    if (!line) continue;

    if (inComment) {
      const end = line.indexOf("-->");
      out.push({ line: ln, startCol: 0, endCol: end < 0 ? line.length : end + 3, kind: "comment" });
      if (end < 0) continue;
      inComment = false;
    }

    let from = 0;
    while (from < line.length) {
      const open = line.indexOf("<!--", from);
      const segEnd = open < 0 ? line.length : open;
      scanXmlSegment(line, from, segEnd, ln, out);
      if (open < 0) break;
      const close = line.indexOf("-->", open + 4);
      out.push({ line: ln, startCol: open, endCol: close < 0 ? line.length : close + 3, kind: "comment" });
      if (close < 0) {
        inComment = true;
        break;
      }
      from = close + 3;
    }
  }
  return out;
}

function scanXmlSegment(line: string, from: number, to: number, ln: number, out: Token[]): void {
  const slice = line.slice(from, to);
  XML_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = XML_TOKEN.exec(slice))) {
    const at = from + m.index;
    if (m[1]) {
      const nameAt = at + m[0].indexOf(m[1]);
      out.push({ line: ln, startCol: at, endCol: nameAt, kind: "punct" });
      out.push({ line: ln, startCol: nameAt, endCol: nameAt + m[1].length, kind: "name" });
    } else if (m[2]) {
      out.push({ line: ln, startCol: at, endCol: at + m[2].length, kind: "punct" });
    } else if (m[3]) {
      out.push({ line: ln, startCol: at, endCol: at + m[3].length, kind: "key" });
      const valueAt = at + m[0].length - m[4].length;
      out.push({ line: ln, startCol: valueAt, endCol: valueAt + m[4].length, kind: "string" });
    }
  }
}

/* --------------------------------------------------------------------- JSON */

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])|(\/\/.*$)/g;

function json(lines: string[], n: number): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    const ln = i + 1;
    if (!line) continue;
    JSON_TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = JSON_TOKEN.exec(line))) {
      const at = m.index;
      if (m[1]) {
        out.push({ line: ln, startCol: at, endCol: at + m[1].length, kind: m[2] ? "key" : "string" });
        if (m[2]) out.push({ line: ln, startCol: at + m[1].length, endCol: at + m[0].length, kind: "punct" });
      } else if (m[3]) {
        out.push({ line: ln, startCol: at, endCol: at + m[3].length, kind: "number" });
      } else if (m[4]) {
        out.push({ line: ln, startCol: at, endCol: at + m[4].length, kind: "meta" });
      } else if (m[5]) {
        out.push({ line: ln, startCol: at, endCol: at + m[5].length, kind: "punct" });
      } else if (m[6]) {
        // Not valid JSON, and four official NPHIES samples carry them — colour as comment.
        out.push({ line: ln, startCol: at, endCol: line.length, kind: "comment" });
      }
    }
  }
  return out;
}
