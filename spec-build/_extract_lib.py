"""
Reusable HTML table extraction utilities for the NPHIES Confluence spec dump.

Designed for `spec-source/pages/<pageId>.json`, whose `html` field is the
RENDERED Confluence body (body.view).

Why this exists (bugs this library deliberately avoids):
  * Confluence HL7 segment tables put colspan="2" on the *Field* header cell,
    so a naive zip of header names against data cells shifts every row by one
    column.  `table_to_grid()` expands colspan/rowspan into phantom cells so
    every row of the grid has the same width and positional alignment holds.
  * FHIR/CDA tables carry a LEADING NUMBERING COLUMN whose header cell is
    empty ("1", "1.1", "44.4").  That column is the parent/child hierarchy;
    it must never be dropped because its header is blank.
  * Tables NEST.  A regex like /<table.*?<\\/table>/ truncates at the first
    inner </table>.  `parse_tables()` uses a real (stack based) HTML parser.
  * Several pages prepend ~1.5KB of CSS; <style>/<script> content is dropped.
  * <a ...> tags are stripped WITHOUT inserting whitespace, so element paths
    stay "./id" instead of "./ id".

Public API
----------
    parse_tables(html)              -> list[Table]           (nested-aware)
    table_to_grid(table)            -> list[list[Cell]]      (colspan expanded)
    grid_text(grid)                 -> list[list[str]]
    distinct_cells(grid_row_slice)  -> list[Cell]   (collapse span phantoms)
    note_row_text(grid_row)         -> str | None   (full-width prose row)
    classify_table(grid, page=None) -> dict | None  (family/kind/colmap)
    parse_usage(usage_raw, rpt_raw, *, hl7=False) -> list[dict]
    parse_cardinality(text)         -> (min, max)
    normalise_path(text)            -> str
    split_paths(text)               -> list[str]
    classify_path(path)             -> str
    path_steps(path)                -> list[str]    (predicates stripped)
    classify_role(...)              -> str
    parse_num(text) / parent_num(num)
    build_tree(rows)                -> list[dict]            (num/parentNum)
    clean_text(html_fragment)       -> str
    load_page(dir, id) / iter_pages(dir)
    selftest(pages_dir)             -> (ok, details)  PID.3 colspan regression

Run `python3 spec-build/_extract_lib.py` to execute the self test.
"""

from __future__ import annotations

import html as _html
import re
from html.parser import HTMLParser

__all__ = [
    "Cell", "Table", "parse_tables", "table_to_grid", "grid_text",
    "classify_table", "parse_usage", "parse_cardinality", "normalise_path",
    "split_paths", "classify_path", "classify_role", "build_tree",
    "clean_text", "HL7_COLUMNS", "FHIR_COLUMNS", "CDA_COLUMNS",
    "distinct_cells", "is_span_row", "note_row_text", "parse_num", "parent_num",
    "load_page", "iter_pages", "path_steps", "selftest",
]

# ---------------------------------------------------------------------------
# Expected column layouts (after colspan expansion)
# ---------------------------------------------------------------------------

HL7_COLUMNS = ["field", "fieldName", "dataType", "usage", "maxRpt",
               "length", "codeSet", "guidance"]
FHIR_COLUMNS = ["num", "name", "usage", "maxRpt", "location", "guidance"]
CDA_COLUMNS = ["num", "name", "usage", "maxRpt", "location", "guidance"]

VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input",
             "link", "meta", "param", "source", "track", "wbr"}

# Tags whose *content* must never reach the text output.
DROP_CONTENT = {"style", "script"}

# Block level tags: a block boundary becomes a newline in cell text.
BLOCK_TAGS = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5",
              "h6", "blockquote", "pre"}


# ---------------------------------------------------------------------------
# DOM-ish model
# ---------------------------------------------------------------------------

class Cell:
    """One <td>/<th>, already positioned on the expanded grid."""

    __slots__ = ("html", "text", "is_header", "colspan", "rowspan",
                 "phantom", "tables", "row", "col", "src")

    def __init__(self, html="", is_header=False, colspan=1, rowspan=1):
        self.html = html
        self.text = ""
        self.is_header = is_header
        self.colspan = colspan
        self.rowspan = rowspan
        self.phantom = False      # True for colspan/rowspan continuation slots
        self.tables = []          # nested Table objects found inside this cell
        self.row = -1
        self.col = -1
        self.src = None           # for phantoms: the authored Cell they copy

    def __repr__(self):  # pragma: no cover - debugging aid
        t = self.text.replace("\n", "\\n")
        return f"<Cell {t[:30]!r}{' phantom' if self.phantom else ''}>"


class Table:
    """A parsed <table>.  `rows` is a list of lists of *authored* Cells."""

    __slots__ = ("rows", "attrs", "depth", "index", "parent")

    def __init__(self, attrs=None, depth=0):
        self.rows = []
        self.attrs = attrs or {}
        self.depth = depth
        self.index = -1
        self.parent = None

    def __repr__(self):  # pragma: no cover
        return f"<Table rows={len(self.rows)} depth={self.depth}>"


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

class _TableParser(HTMLParser):
    """Stack-based table parser that keeps nested tables intact.

    Every <table> encountered becomes a Table.  A table opened while another
    table is open is recorded both in `self.tables` (flat, in document order)
    and attached to the enclosing cell (`cell.tables`), so callers can either
    walk the flat list or descend the nesting.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []            # flat, document order
        self._tstack = []           # open Table objects
        self._rowstack = []         # current row (list of Cell) per table
        self._cellstack = []        # open Cell per table
        self._raw_depth = 0         # depth inside the open cell's raw html
        self._drop_depth = 0        # inside <style>/<script>

    # -- helpers ----------------------------------------------------------
    @property
    def _cell(self):
        return self._cellstack[-1] if self._cellstack else None

    def _emit_raw(self, s):
        # Append raw html to *every* open cell so nested markup is preserved
        # for the outer cell too.
        for c in self._cellstack:
            if c is not None:
                c.html += s

    def _close_cell(self):
        if not self._cellstack:
            return
        cell = self._cellstack.pop()
        if cell is not None:
            cell.text = clean_text(cell.html)

    def _close_row(self):
        if not self._tstack:
            return
        self._close_cell()
        row = self._rowstack.pop() if self._rowstack else None
        if row is not None and row:
            self._tstack[-1].rows.append(row)

    # -- HTMLParser hooks -------------------------------------------------
    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if self._drop_depth:
            if tag in DROP_CONTENT:
                self._drop_depth += 1
            return
        if tag in DROP_CONTENT:
            self._drop_depth = 1
            return

        a = {k.lower(): (v or "") for k, v in attrs}

        if tag == "table":
            t = Table(a, depth=len(self._tstack))
            t.index = len(self.tables)
            if self._tstack:
                t.parent = self._tstack[-1]
                if self._cell is not None:
                    self._cell.tables.append(t)
            self.tables.append(t)
            self._tstack.append(t)
            self._rowstack.append(None)
            self._cellstack.append(None)
            # also record raw html into enclosing cells
            self._emit_raw(self._starttag_html(tag, attrs))
            return

        if not self._tstack:
            return

        if tag == "tr":
            # implicit close of a previous unterminated row
            if self._rowstack and self._rowstack[-1] is not None:
                self._close_row_soft()
            self._rowstack[-1] = []
            self._emit_raw(self._starttag_html(tag, attrs))
            return

        if tag in ("td", "th"):
            if self._rowstack[-1] is None:
                self._rowstack[-1] = []
            # implicit close of a previous unterminated cell
            if self._cellstack[-1] is not None:
                self._finish_cell()
            try:
                cs = max(1, int(float(a.get("colspan", "1") or 1)))
            except ValueError:
                cs = 1
            try:
                rs = max(1, int(float(a.get("rowspan", "1") or 1)))
            except ValueError:
                rs = 1
            cell = Cell(is_header=(tag == "th"), colspan=cs, rowspan=rs)
            self._cellstack[-1] = cell
            self._rowstack[-1].append(cell)
            self._emit_raw(self._starttag_html(tag, attrs))
            return

        self._emit_raw(self._starttag_html(tag, attrs))

    def handle_startendtag(self, tag, attrs):
        if self._drop_depth:
            return
        if self._tstack:
            self._emit_raw(self._starttag_html(tag, attrs, self_closing=True))

    def handle_endtag(self, tag):
        tag = tag.lower()
        if self._drop_depth:
            if tag in DROP_CONTENT:
                self._drop_depth -= 1
            return

        if tag == "table":
            if not self._tstack:
                return
            self._emit_raw(f"</{tag}>")
            # close dangling row/cell of this table
            if self._cellstack[-1] is not None:
                self._finish_cell()
            if self._rowstack[-1]:
                self._tstack[-1].rows.append(self._rowstack[-1])
            self._rowstack.pop()
            self._cellstack.pop()
            self._tstack.pop()
            return

        if not self._tstack:
            return

        if tag in ("td", "th"):
            self._emit_raw(f"</{tag}>")
            if self._cellstack[-1] is not None:
                self._finish_cell()
            return

        if tag == "tr":
            self._emit_raw(f"</{tag}>")
            if self._cellstack[-1] is not None:
                self._finish_cell()
            if self._rowstack[-1] is not None:
                if self._rowstack[-1]:
                    self._tstack[-1].rows.append(self._rowstack[-1])
                self._rowstack[-1] = None
            return

        self._emit_raw(f"</{tag}>")

    def handle_data(self, data):
        if self._drop_depth:
            return
        if self._tstack:
            self._emit_raw(_escape_min(data))

    def handle_entityref(self, name):  # convert_charrefs=True normally handles
        if not self._drop_depth and self._tstack:
            self._emit_raw(f"&{name};")

    def handle_charref(self, name):
        if not self._drop_depth and self._tstack:
            self._emit_raw(f"&#{name};")

    def handle_comment(self, data):
        pass

    # -- internals --------------------------------------------------------
    def _finish_cell(self):
        cell = self._cellstack[-1]
        if cell is not None:
            cell.text = clean_text(cell.html)
        self._cellstack[-1] = None

    def _close_row_soft(self):
        if self._cellstack[-1] is not None:
            self._finish_cell()
        if self._rowstack[-1]:
            self._tstack[-1].rows.append(self._rowstack[-1])
        self._rowstack[-1] = None

    @staticmethod
    def _starttag_html(tag, attrs, self_closing=False):
        parts = [tag]
        for k, v in attrs:
            if v is None:
                parts.append(k)
            else:
                parts.append(f'{k}="{_html.escape(v, quote=True)}"')
        return "<" + " ".join(parts) + ("/>" if self_closing else ">")


def _escape_min(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def parse_tables(html_src):
    """Return every <table> in `html_src`, in document order, nesting-aware.

    Nested tables appear in the flat list too; use `Table.depth == 0` to keep
    only the top-level ones, and `cell.tables` to descend.
    """
    p = _TableParser()
    p.feed(html_src or "")
    p.close()
    return p.tables


# ---------------------------------------------------------------------------
# Text extraction
# ---------------------------------------------------------------------------

_TAG_RE = re.compile(r"<(/?)([a-zA-Z0-9:-]+)((?:\s[^>]*?)?)/?>", re.S)
_STYLE_RE = re.compile(r"<(style|script)\b.*?</\1\s*>", re.S | re.I)
_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)


def clean_text(fragment, *, keep_nested_tables=False):
    """Turn an HTML fragment into readable plain text.

    - <style>/<script> blocks are removed with their content.
    - <a ...> and </a> are removed WITHOUT introducing whitespace, so an
      element path such as `./<a ...>meta</a>/profile` stays `./meta/profile`.
    - Block-level tags become newlines (so `<p>A</p><p>B</p>` -> "A\\nB"),
      which is what the conditional usage cells rely on.
    - Whitespace around "/" inside element-path-looking text is normalised by
      `normalise_path()`, not here.
    """
    if not fragment:
        return ""
    s = _COMMENT_RE.sub("", fragment)
    s = _STYLE_RE.sub("", s)
    if not keep_nested_tables:
        # a nested table's own text is handled separately; keep its text but
        # force row/cell boundaries to separate.
        pass

    out = []

    def repl(m):
        closing, tag, _rest = m.group(1), m.group(2).lower(), m.group(3)
        if tag == "a":
            return ""                      # no space: ./id not ./ id
        if tag in ("td", "th"):
            return "\t"
        if tag in BLOCK_TAGS:
            return "\n"
        if tag in ("table",):
            return "\n"
        return ""

    s = _TAG_RE.sub(repl, s)
    s = _html.unescape(s)
    s = s.replace(" ", " ").replace("​", "")
    # collapse spaces/tabs but keep newlines
    lines = [re.sub(r"[ \t  ]+", " ", ln).strip() for ln in s.split("\n")]
    lines = [ln for ln in lines if ln]
    out = "\n".join(lines)
    return out.strip()


# ---------------------------------------------------------------------------
# Grid expansion
# ---------------------------------------------------------------------------

def table_to_grid(table):
    """Expand colspan/rowspan into phantom cells.

    Returns a rectangular list of rows; each slot is a Cell.  The first slot
    of a spanned run is the authored Cell, the rest are `phantom` copies that
    carry the same text (so positional column alignment always holds).
    """
    grid = []
    occupied = {}          # (row, col) -> Cell  (from rowspans)
    for r, row in enumerate(table.rows):
        out_row = []
        c = 0
        for cell in row:
            # skip columns already claimed by a rowspan from above
            while (r, c) in occupied:
                out_row.append(occupied[(r, c)])
                c += 1
            cell.row, cell.col = r, c
            for i in range(cell.colspan):
                if i == 0:
                    slot = cell
                else:
                    slot = _phantom(cell)
                while len(out_row) < c:
                    out_row.append(_blank())
                out_row.append(slot)
                for j in range(1, cell.rowspan):
                    occupied[(r + j, c)] = _phantom(cell)
                c += 1
        # trailing rowspan claims
        while (r, c) in occupied:
            out_row.append(occupied[(r, c)])
            c += 1
        grid.append(out_row)

    width = max((len(r) for r in grid), default=0)
    for row in grid:
        while len(row) < width:
            row.append(_blank())
    return grid


def _phantom(src):
    p = Cell(html=src.html, is_header=src.is_header)
    p.text = src.text
    p.phantom = True
    p.tables = src.tables
    p.src = src.src or src
    return p


def distinct_cells(slots):
    """Collapse a run of grid slots back to the authored cells behind them.

    `table_to_grid` fills colspan/rowspan continuations with phantom copies;
    every phantom points at its authored Cell through `.src`, so a run such as
    [numCell, nameCell, nameCellPhantom] collapses to [numCell, nameCell].
    """
    out = []
    for s in slots:
        a = s.src or s
        if not out or out[-1] is not a:
            out.append(a)
    return out


def is_span_row(row):
    """True when the whole grid row is one authored cell (a spanning note)."""
    cells = distinct_cells(row)
    return len(cells) == 1 and len(row) > 1


def note_row_text(row):
    """Return the text of a full-width note row, else None.

    Confluence spec tables interleave prose rows: either one cell spanning the
    whole width, or a few empty leading (numbering) cells followed by one cell
    spanning the rest, e.g. the xmlns block on the CDA header pages.
    """
    if len(row) < 3:
        return None
    cells = distinct_cells(row)
    filled = [c for c in cells if c.text.strip()]
    if len(filled) != 1:
        return None
    c = filled[0]
    if len(cells) == 1 or c.colspan >= 2:
        return c.text
    return None


def _blank():
    c = Cell()
    c.phantom = True
    return c


def grid_text(grid):
    return [[c.text for c in row] for row in grid]


# ---------------------------------------------------------------------------
# Table classification
# ---------------------------------------------------------------------------

def _norm_hdr(s):
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def _dedupe_header(cells):
    """Header cell texts, normalised, with colspan phantoms kept in place."""
    return [_norm_hdr(c.text) for c in cells]


def _find(cells, *names):
    for n in names:
        if n in cells:
            return cells.index(n)
    return None


def _find_contains(cells, *frags):
    for i, c in enumerate(cells):
        for f in frags:
            if f in c:
                return i
    return None


def classify_table(grid, page=None):
    """Identify a field-level spec table from its header row.

    Returns a dict (or None when the table is not a field-level spec table):

        {
          "family": "hl7" | "fhir" | "cda" | "xds",
          "kind":   see below,
          "headerIndex": int,
          "colmap": {logical name -> grid column index},
          "header": [raw header texts],
        }

    Kinds
    -----
    hl7 / segmentFields
        field | fieldName | dataType | usage | maxRpt | length | codeSet | guidance
        (the authored header has 7 cells because "Field" carries colspan="2";
        after `table_to_grid` the phantom sits under `fieldName`.)
    fhir / resourceFields, cda / sectionFields
        <numbering> | Resource|Section/Field | Usage | Max Rpt |
        FHIR|CDA Element Location | Guidance
    fhir / datatypeSubElements
        <numbering> | Sub-element | Usage | Max Rpt | Guidance      (no location)
    fhir / subElements
        <numbering> | Sub Element | Max Repeat | FHIR Element Location | Guidance
        (no Usage column)
    xds / attributeOptionality
        <numbering> | Section/Field (colspan 2) | Usage | Max Rpt | Guidance
    xds / metadataValue
        Section/Field | Value | Description            (fixed structural values)
    xds / queryParameter
        Parameter Name | Attribute | Optionality [| Multiple Allowed]

    `page` (the page dict) is used only to disambiguate FHIR vs CDA when the
    header itself does not say which.
    """
    if not grid or len(grid) < 2:
        return None

    for hi, row in enumerate(grid[:3]):
        cells = _dedupe_header(row)
        if not any(cells):
            continue

        usage_i = _find(cells, "usage")
        rpt_i = _find(cells, "maxrpt", "maxrepeat", "maxrepetition",
                      "maxrptpossible")
        loc_i = _find_contains(cells, "elementlocation")
        if loc_i is None:
            loc_i = _find(cells, "fhirelement", "cdaelement", "xpath",
                          "elementpath")
        guid_i = _find(cells, "guidance", "comment", "comments", "notes")

        # ---- HL7 v2 segment field table --------------------------------
        dt_i = _find(cells, "datatype")
        len_i = _find(cells, "length")
        if dt_i is not None and usage_i is not None and rpt_i is not None \
                and len_i is not None:
            fi = _find(cells, "field", "segment", "element", "component")
            if fi is None:
                fi = 0
            colmap = {
                "field": fi,
                "fieldName": fi + 1,
                "dataType": dt_i,
                "usage": usage_i,
                "maxRpt": rpt_i,
                "length": len_i,
                "codeSet": _find(cells, "codeset", "codesystem", "valueset"),
                "guidance": guid_i,
            }
            if colmap["fieldName"] == dt_i:
                # header was NOT colspanned -> no separate name column
                colmap["fieldName"] = None
            return {"family": "hl7", "kind": "segmentFields",
                    "headerIndex": hi, "colmap": colmap,
                    "header": [c.text for c in row]}

        # ---- FHIR / CDA / XDS hierarchical field tables ------------------
        name_i = _find(cells, "resourcefield", "sectionfield", "subelement",
                       "fhirresourcefield", "documentfield", "entryfield",
                       "resource", "section")
        if name_i is None and loc_i is not None and usage_i is not None:
            name_i = _find(cells, "field", "element", "name")

        if name_i is not None and (usage_i is not None or
                                   (rpt_i is not None and loc_i is not None)):
            fam = None
            hdr_join = " ".join(cells)
            if loc_i is not None:
                if "cda" in cells[loc_i]:
                    fam = "cda"
                elif "fhir" in cells[loc_i]:
                    fam = "fhir"
            if fam is None:
                if "cda" in hdr_join:
                    fam = "cda"
                elif "fhir" in hdr_join:
                    fam = "fhir"
            if fam is None:
                fam = _family_from_page(page, cells, name_i)

            kind = {
                "fhir": "resourceFields",
                "cda": "sectionFields",
                "xds": "attributeOptionality",
            }[fam]
            if cells[name_i] == "subelement":
                kind = ("datatypeSubElements" if loc_i is None
                        else "subElements")
                fam = "fhir"
            if fam != "xds" and loc_i is None and kind == "resourceFields":
                kind = "fieldsNoLocation"

            colmap = {
                # numbering columns: every grid column left of the name
                "num": 0 if name_i > 0 else None,
                "numEnd": name_i - 1 if name_i > 0 else None,
                "name": name_i,
                "usage": usage_i,
                "maxRpt": rpt_i,
                "location": loc_i,
                "guidance": guid_i if guid_i is not None else
                            (loc_i + 1 if loc_i is not None and
                             loc_i + 1 < len(cells) else None),
            }
            return {"family": fam, "kind": kind, "headerIndex": hi,
                    "colmap": colmap, "header": [c.text for c in row]}

        # ---- XDS metadata fixed-value table ------------------------------
        if cells[:2] == ["sectionfield", "value"]:
            colmap = {"name": 0, "value": 1,
                      "guidance": 2 if len(cells) > 2 else None}
            return {"family": "xds", "kind": "metadataValue",
                    "headerIndex": hi, "colmap": colmap,
                    "header": [c.text for c in row]}

        # ---- XDS stored-query parameter table ----------------------------
        if cells[:1] == ["parametername"] and "optionality" in cells:
            colmap = {"name": 0,
                      "value": _find(cells, "attribute"),
                      "usage": cells.index("optionality"),
                      "multiple": _find(cells, "multipleallowed")}
            return {"family": "xds", "kind": "queryParameter",
                    "headerIndex": hi, "colmap": colmap,
                    "header": [c.text for c in row]}

    return None


_XDS_HINTS = ("xds", "document metadata", "provide and register",
              "registry stored query", "iti-18", "iti-41", "iti-43")


def _family_from_page(page, cells, name_i):
    """Disambiguate fhir / cda / xds when the header does not say."""
    blob = ""
    if page:
        blob = " ".join([page.get("title", "")] +
                        list(page.get("ancestors", []) or [])).lower()
    if cells[name_i] == "sectionfield":
        if any(h in blob for h in _XDS_HINTS):
            return "xds"
        return "cda"
    if "cda" in blob or "clinical document" in blob:
        return "cda"
    return "fhir"


# ---------------------------------------------------------------------------
# Usage / cardinality
# ---------------------------------------------------------------------------

USAGE_TOKENS = {"M", "R", "R2", "O", "C", "I", "X", "NP", "RE"}

_CARD_RE = re.compile(r"\[?\s*(\d+)\s*\.\.\s*(\d+|\*|n|N|many)\s*\]?")


def parse_cardinality(text):
    """("[0..*]") -> (0, None).  ("1") -> (1, 1).  ("No max") -> (None, None).

    Returns (min, max); `None` means "unbounded" for max, "unknown" for min.
    """
    if text is None:
        return None, None
    t = text.strip()
    if not t:
        return None, None
    low = t.lower()
    m = _CARD_RE.search(t)
    if m:
        lo = int(m.group(1))
        hi_s = m.group(2)
        hi = None if hi_s in ("*", "n", "N", "many") else int(hi_s)
        return lo, hi
    if low in ("no max", "nomax", "unbounded", "*", "many", "n", "no limit"):
        return None, None
    if low in ("0",):
        return None, 0
    m = re.fullmatch(r"(\d+)", t)
    if m:
        return None, int(m.group(1))
    return None, None


def _split_parallel(raw):
    """Split a conditional cell such as "M\\n(Report)\\nNP\\n(Order)".

    Returns a list of (token, condition) pairs preserving document order.
    Lines that are purely a parenthesised condition attach to the token above.
    """
    if raw is None:
        return []
    lines = [ln.strip() for ln in re.split(r"[\n\r]+", raw) if ln.strip()]
    out = []
    for ln in lines:
        cond = None
        body = ln
        # "M (Report)" on one line
        m = re.fullmatch(r"(.*?)\s*\((.+)\)\s*", ln)
        if m and m.group(1).strip():
            body, cond = m.group(1).strip(), m.group(2).strip()
        elif m and not m.group(1).strip():
            # pure condition line -> attach to previous token
            if out:
                prev_tok, prev_cond = out[-1]
                out[-1] = (prev_tok,
                           m.group(2).strip() if not prev_cond
                           else prev_cond + "; " + m.group(2).strip())
                continue
            body, cond = "", m.group(2).strip()
        out.append((body, cond))
    return out


def parse_usage(usage_raw, rpt_raw, *, hl7=False):
    """Compile usage + cardinality into a LIST of {usage,min,max,condition}.

    ~60 rows carry conditional usage like "M\\n(Report)\\nNP\\n(Order)" with a
    positionally parallel Max Rpt cell -> one entry per parallel position.

    For HL7 tables pass hl7=True: the Max Rpt cell carries ONLY the max, and
    the min is derived from usage (M/R -> 1, R2/O/I/X/NP -> 0).
    """
    u_parts = _split_parallel(usage_raw)
    r_parts = _split_parallel(rpt_raw)
    if not u_parts:
        u_parts = [("", None)]

    entries = []
    for i, (utok, ucond) in enumerate(u_parts):
        rtok, rcond = ("", None)
        if len(r_parts) == len(u_parts):
            rtok, rcond = r_parts[i]
        elif len(r_parts) == 1:
            rtok, rcond = r_parts[0]
        elif r_parts and i < len(r_parts):
            rtok, rcond = r_parts[i]

        usage = _norm_usage(utok)
        cond = ucond or rcond

        if hl7:
            lo, hi = parse_cardinality(rtok)
            mn = _hl7_min(usage)
            mx = hi
            if rtok and rtok.strip().lower() in ("no max", "nomax", "*"):
                mx = None
            if usage in ("X", "NP") or (rtok.strip() == "0"):
                mx = 0 if rtok.strip() == "0" else mx
            entries.append({
                "usage": usage,
                "min": mn,
                "max": mx,
                "condition": cond,
                "rawUsage": utok.strip() or None,
                "rawMaxRpt": (rtok or "").strip() or None,
            })
        else:
            lo, hi = parse_cardinality(rtok)
            if lo is None:
                lo = _hl7_min(usage)
            entries.append({
                "usage": usage,
                "min": lo,
                "max": hi,
                "condition": cond,
                "rawUsage": utok.strip() or None,
                "rawMaxRpt": (rtok or "").strip() or None,
            })
    return entries


def _norm_usage(tok):
    if not tok:
        return None
    t = tok.strip()
    up = re.sub(r"[^A-Za-z0-9]", "", t).upper()
    if up in USAGE_TOKENS:
        return up
    # "Defined by <something>" container rows
    if t.lower().startswith("defined by"):
        return "DEFINED_BY"
    m = re.match(r"^(R2|NP|RE|[MROCIX])\b", t.upper())
    if m and len(t) <= 4:
        return m.group(1)
    # Unrecognised prose (some cells hold a whole paragraph instead of a
    # usage code) -> no usage token; the raw text is kept in `rawUsage`.
    return None


def _hl7_min(usage):
    if usage in ("M", "R"):
        return 1
    if usage in ("R2", "O", "I", "X", "NP", "C", "RE"):
        return 0
    return None


# ---------------------------------------------------------------------------
# Element paths
# ---------------------------------------------------------------------------

def normalise_path(text):
    """"./ meta /profile" -> "./meta/profile"."""
    if not text:
        return ""
    s = text.replace(" ", " ")
    s = re.sub(r"\s*\n\s*", " ", s)
    s = re.sub(r"\s*/\s*", "/", s)
    s = re.sub(r"\s*\[\s*", "[", s)
    s = re.sub(r"\s*\]\s*", "]", s)
    s = re.sub(r"\s*@\s*", "@", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def split_paths(text):
    """Split a multi-valued location cell on " or " (and on newlines).

    Confluence writes alternatives either inline ("./a or ./b") or as three
    lines ("./a" / "or" / "./b"), so a standalone "or" line is dropped rather
    than kept as a bogus path.
    """
    if not text:
        return []
    chunks = []
    for line in re.split(r"[\n\r]+", text):
        for part in re.split(r"\s+or\s+", line, flags=re.I):
            p = normalise_path(part)
            if not p or p.lower() in ("or", "and", "/"):
                continue
            # "./extension/url=" on one line and the quoted fixed value on the
            # next belong to ONE path, not two.
            if chunks and chunks[-1].endswith("=") and p[0] in "\u201c\u201d\"'":
                chunks[-1] = chunks[-1] + p
                continue
            chunks.append(p)
    return chunks


def classify_path(path):
    """relative | descendant | absolute | attribute | resourceRoot | text."""
    if not path:
        return "none"
    p = path.strip()
    if p.startswith(".//"):
        return "descendant"
    if p.startswith("./"):
        return "relative"
    if p.startswith("@"):
        return "attribute"
    if p.startswith("/"):
        return "absolute"
    if re.fullmatch(r"[A-Z][A-Za-z0-9]*(\.[A-Za-z0-9_\[\]:\-]+)*", p):
        return "resourceRoot"
    if re.search(r"\s", p) and "/" not in p:
        return "text"
    return "other"


# ---------------------------------------------------------------------------
# Role classification
# ---------------------------------------------------------------------------

# HL7 envelope / generator-owned field names (lower case, without the
# trailing " - PID" style segment suffix).
_HL7_STRUCTURAL_NAMES = {
    "set id", "field separator", "encoding characters", "version id",
    "message type", "message control id", "processing id",
    "date/time of message", "date / time of message",
    "accept acknowledgment type", "application acknowledgment type",
    "country code", "character set", "principal language of message",
    "message profile identifier", "sending application",
    "receiving application", "sending facility", "receiving facility",
    "alternate character set handling scheme",
}

# FHIR/CDA element names the generator owns outright.
_STRUCTURAL_NAME_PAT = re.compile(
    r"^(resource\s*type|resourcetype|template\s*indicator|template\s*id|"
    r"templateid|realm\s*code|realmcode|type\s*id|typeid|"
    r"full\s*url|fullurl)\b", re.I)

# ... or whose name ends in "Profile" ("Metadata - Profile", "Bundle
# Metadata - Profile", "Profile").
_PROFILE_NAME_PAT = re.compile(r"(^|[\s\u2013\u2014-])profile$", re.I)

# Final path steps that ARE the fixed structure.
_STRUCTURAL_TAILS = {
    "templateid", "typeid", "realmcode", "resourcetype", "fullurl",
    "@classcode", "@moodcode", "@typecode", "@contextcontrolcode",
    "@contextconductionind", "@inversionind", "@negationind",
}

_PREDICATE_RE = re.compile(r"\[[^\]]*\]")


def path_steps(path):
    """Path steps with XPath predicates removed.

    Predicates matter for the GUARD: "./component/section[templateId/@root=
    '2.16...']" is a *section* row (HIS content), not a templateId row.  The
    templateId inside the predicate must never make the row structural.
    """
    if not path:
        return []
    p = _PREDICATE_RE.sub("", path)
    p = p.replace(".//", "/").lstrip(".")
    return [s for s in p.split("/") if s]


def classify_role(*, family, name, usage_entries, location_paths=(),
                  guidance="", field_id=None, raw_usage=""):
    """Return "data" | "structural" | "container" | "omit".

    data       - comes from the HIS
    structural - the generator supplies it (templateId, resourceType,
                 meta.profile, fixed structural codes, HL7 envelope fields)
    container  - usage cell starts with "Defined by ..."
    omit       - usage I / X / NP, or max == 0

    GUARD: a field is still "data" when only a SUB-COMPONENT is fixed, e.g.
    PV1.7 Attending Doctor is HIS data whose assigning authority is a fixed
    OID.  A mention of an OID in the guidance NEVER flips a data field to
    structural, and neither does a templateId inside an XPath predicate.
    """
    raw = (raw_usage or "").strip()
    if raw.lower().startswith("defined by"):
        return "container"

    usages = [e.get("usage") for e in (usage_entries or [])]
    maxes = [e.get("max") for e in (usage_entries or [])]
    non_null = [u for u in usages if u]

    if non_null and all(u in ("I", "X", "NP") for u in non_null):
        return "omit"
    if maxes and all(m == 0 for m in maxes) and any(m is not None for m in maxes):
        return "omit"

    nm = (name or "").strip()
    nml = re.sub(r"\s+", " ", nm.lower())

    if family == "hl7":
        base = re.sub(r"\s*[-\u2013]\s*[A-Za-z0-9]{2,4}\s*$", "", nml).strip()
        if nml in _HL7_STRUCTURAL_NAMES or base in _HL7_STRUCTURAL_NAMES:
            return "structural"
        return "data"

    # ---- FHIR / CDA / XDS ------------------------------------------------
    if _STRUCTURAL_NAME_PAT.match(nm) or _PROFILE_NAME_PAT.search(nml):
        return "structural"

    for p in location_paths:
        steps = path_steps(p)
        if not steps:
            continue
        tail = steps[-1].lower()
        if tail in _STRUCTURAL_TAILS:
            return "structural"
        if tail == "profile" and len(steps) >= 2 and steps[-2].lower() == "meta":
            return "structural"
        if tail in ("method", "url") and len(steps) >= 2 \
                and steps[-2].lower() == "request":
            return "structural"
    return "data"


# ---------------------------------------------------------------------------
# Numbering-column tree
# ---------------------------------------------------------------------------

_NUM_RE = re.compile(r"^\s*(\d+(?:\.\d+)*)\s*\.?\s*$")


def parse_num(text):
    """"44.4" -> "44.4"; anything that is not a dotted number -> None."""
    if not text:
        return None
    m = _NUM_RE.match(text.strip())
    return m.group(1) if m else None


def parent_num(num):
    if not num or "." not in num:
        return None
    return num.rsplit(".", 1)[0]


def build_tree(rows, *, id_key="rowId", num_key="num"):
    """Turn the leading numbering column into a real parent/child tree.

    `rows` is the flat list of field-row dicts, in document order.  Each row
    is annotated in place with:
        parentNum, parentRowId, childRowIds
    and the returned value is the nested skeleton of root nodes:
        {rowId, num, name, parentNum, children: [...]}
    kept separate from `rows` so the row payload is not duplicated.

    A row whose numbering cell is empty (several newer FHIR pages leave it
    blank) is a root; a gap in the numbering ("1.2.1" with no "1.2" row) is
    tolerated by walking up to the nearest existing ancestor.
    """
    by_num = {}
    for r in rows:
        n = r.get(num_key)
        if n and n not in by_num:
            by_num[n] = r

    nodes = {r[id_key]: {"rowId": r[id_key], "num": r.get(num_key),
                         "name": r.get("name"), "parentNum": None,
                         "children": []} for r in rows}
    roots = []
    for r in rows:
        node = nodes[r[id_key]]
        p = parent_num(r.get(num_key)) if r.get(num_key) else None
        while p and (p not in by_num or by_num[p] is r):
            p = parent_num(p)
        if p and by_num[p] is not r:
            node["parentNum"] = p
            r["parentNum"] = p
            r["parentRowId"] = by_num[p][id_key]
            nodes[by_num[p][id_key]]["children"].append(node)
        else:
            r["parentNum"] = None
            r["parentRowId"] = None
            roots.append(node)
    for r in rows:
        r["childRowIds"] = [c["rowId"] for c in nodes[r[id_key]]["children"]]
    return roots


# ---------------------------------------------------------------------------
# Page helpers
# ---------------------------------------------------------------------------

def load_page(pages_dir, page_id):
    import json
    import os
    with open(os.path.join(pages_dir, f"{page_id}.json")) as fh:
        return json.load(fh)


def iter_pages(pages_dir):
    import glob
    import json
    import os
    for path in sorted(glob.glob(os.path.join(pages_dir, "*.json"))):
        with open(path) as fh:
            yield json.load(fh)


# ---------------------------------------------------------------------------
# Self test
# ---------------------------------------------------------------------------

def selftest(pages_dir):
    """Regression check for the colspan bug, run against the real dump.

    PID (page 7766393) row PID.3 must come out as field="PID.3",
    fieldName="Patient Identifier List", dataType="CX", usage="R",
    maxRpt="1", length="No max", with the Health ID assigning authority
    2.16.840.1.113883.3.3731.1.1.100.1 in the guidance.  Any column shift
    caused by the colspan="2" on the Field header breaks this.

    Returns (ok: bool, details: dict).
    """
    page = load_page(pages_dir, "7766393")
    tables = parse_tables(page["html"])
    grid = table_to_grid(tables[0])
    info = classify_table(grid, page)
    cm = info["colmap"]
    got = None
    for row in grid:
        if row[cm["field"]].text.strip() == "PID.3":
            got = {
                "field": row[cm["field"]].text.strip(),
                "fieldName": row[cm["fieldName"]].text.strip(),
                "dataType": row[cm["dataType"]].text.strip(),
                "usage": row[cm["usage"]].text.strip(),
                "maxRpt": row[cm["maxRpt"]].text.strip(),
                "length": row[cm["length"]].text.strip(),
                "guidance": row[cm["guidance"]].text.strip(),
            }
            break
    expected = {"field": "PID.3", "fieldName": "Patient Identifier List",
                "dataType": "CX", "usage": "R", "maxRpt": "1",
                "length": "No max"}
    ok = bool(got) and all(got.get(k) == v for k, v in expected.items()) and \
        "2.16.840.1.113883.3.3731.1.1.100.1" in (got or {}).get("guidance", "")
    return ok, {"expected": expected, "got": got}


if __name__ == "__main__":  # pragma: no cover
    import os
    import sys
    here = os.path.dirname(os.path.abspath(__file__))
    pages = os.path.join(os.path.dirname(here), "spec-source", "pages")
    ok, detail = selftest(pages)
    print("PID.3 colspan self test:", "PASS" if ok else "FAIL")
    if not ok:
        print(detail)
        sys.exit(1)
