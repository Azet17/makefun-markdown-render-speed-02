// parse.js — a fast drop-in for marked 18.1.3 (default options: gfm on, breaks off).
// Written from scratch: block lexer + integrated inline parser, mirroring marked's
// observable output (HTML escaping, entity handling, URL cleaning, tab rules).

export function parse(src) {
  src = src.replace(/\r\n|\r/g, '\n');
  const links = Object.create(null);
  const blocks = lexBlocks(splitLines(src), links, true, src.endsWith('\n'));
  return renderBlocks(blocks, links);
}

// ---------- character helpers ----------
const isSpace = c => c === 32 || c === 9;
const isDigit = c => c >= 48 && c <= 57;
const isAlphaNum = c => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const PUNCT = '!\"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const isPunct = c => c < 128 && PUNCT.indexOf(String.fromCharCode(c)) >= 0;

// column of index i in line (a tab advances to the next multiple of 4)
function colAt(line, i) {
  let c = 0;
  for (let j = 0; j < i; j++) c += line.charCodeAt(j) === 9 ? 4 - (c % 4) : 1;
  return c;
}
// leading whitespace of a line: {cols, idx} (idx = first non-space index)
function indentOf(line) {
  let col = 0, i = 0;
  while (i < line.length) {
    const ch = line.charCodeAt(i);
    if (ch === 32) { col++; i++; }
    else if (ch === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return { cols: col, idx: i };
}
// Remove the first n columns of line starting at (startIdx, startCol).
// A tab straddling the cut becomes spaces equal to its remaining width.
// Returns {text, col} where col is the original column of the first char of text.
function stripCols(line, startIdx, startCol, n) {
  let i = startIdx, col = startCol, left = n;
  while (i < line.length && left > 0) {
    const ch = line.charCodeAt(i);
    if (ch === 9) {
      const w = 4 - (col % 4);
      if (w > left) return { text: ' '.repeat(w - left) + line.slice(i + 1), col: col + left };
      left -= w; col += w; i++;
    } else if (ch === 32) { left--; col++; i++; }
    else break;
  }
  return { text: line.slice(i), col };
}
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

// ---------- HTML escaping (marked's escape) ----------
// encode=false: escape < > " ' and & unless & starts a valid entity reference.
// encode=true (code): escape & always.
// AMP is a private-use sentinel for an & produced by a backslash escape (\&):
// it must be re-escaped to &amp; and NOT re-read as part of an entity (cm-014).
const AMP = '';
const ESC_NOENC_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESC_ENC_RE = /[&<>"']/g;
function esc(s, encode) {
  if (s.indexOf(AMP) >= 0) s = s.replace(//g, encode ? '&' : '&amp;');
  if (encode) return ESC_ENC_RE.test(s) ? s.replace(ESC_ENC_RE, escRep) : s;
  return ESC_NOENC_RE.test(s) ? s.replace(ESC_NOENC_RE, escRep) : s;
}
function escRep(m) {
  return m === '&' ? '&amp;' : m === '<' ? '&lt;' : m === '>' ? '&gt;' : m === '"' ? '&quot;' : '&#39;';
}
// Decode a numeric character reference body (#123 or #x1F600) to a string (U+FFFD on invalid).
function decodeNumeric(body) {
  let cp;
  if (body.charCodeAt(0) === 120 || body.charCodeAt(0) === 88) cp = parseInt(body.slice(1), 16);
  else cp = parseInt(body, 10);
  if (isNaN(cp)) return null;
  if (cp === 0) return '\uFFFD';
  // out of range / surrogate -> not a valid entity; caller keeps it literal
  if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return null;
  return String.fromCodePoint(cp);
}

// Clean a link destination the way marked does: encodeURI, keep %XX sequences intact.
function cleanUrl(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch (e) { return null; }
}

// ---------- link reference definitions ----------

// Try to parse a link reference definition starting at lines[i].
// Returns {label, href, title, next} (next = index of first line after the def) or null.
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().replace(/&(#\d+|#[xX][0-9a-fA-F]+|\w+);/g, (m, g) => {
    if (g[0] === '#') {
      const cp = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return String.fromCodePoint(cp === 0 ? 0xFFFD : cp);
    }
    return m;
  });
}

function parseDef(lines, i) {
  const line = lines[i];
  const ind = indentOfL(line);
  if (ind.cols > 3) return null;
  let p = ind.idx;
  const s = line.s;
  if (s.charCodeAt(p) !== 91) return null; // [
  // label: find matching ] (escapes allowed); the label may span lines
  let label = '', cur = i, j = p + 1, ls = s;
  let closed = false;
  while (!closed) {
    while (j < ls.length) {
      const ch = ls.charCodeAt(j);
      if (ch === 92 && j + 1 < ls.length) { label += ls[j + 1]; j += 2; continue; }
      if (ch === 93) { closed = true; break; }
      label += ls[j]; j++;
    }
    if (closed) break;
    if (cur + 1 >= lines.length) return null;
    cur++; ls = lines[cur].s; j = 0;
    label += '\n';
    if (isBlank(ls)) return null; // a blank line ends the label
  }
  if (label.length === 0 || label.length > 999) return null;
  j++; // past ]
  if (ls.charCodeAt(j) !== 58) return null; // :
  j++;
  // skip spaces/tabs (and at most one newline) to the destination
  let rest = ls.slice(j);
  while (true) {
    let k = 0;
    while (k < rest.length && isSpace(rest.charCodeAt(k))) k++;
    if (k < rest.length) { rest = rest.slice(k); break; }
    if (cur + 1 >= lines.length) return null;
    cur++; rest = lines[cur].s;
    if (isBlank(rest)) return null;
  }
  // destination: <...> or bare
  let dest = '';
  if (rest.charCodeAt(0) === 60) { // <
    let k = 1;
    while (k < rest.length) {
      const ch = rest.charCodeAt(k);
      if (ch === 62) break;
      if (ch === 60 || ch === 10) return null;
      dest += rest[k]; k++;
    }
    if (k >= rest.length) return null;
    rest = rest.slice(k + 1);
  } else {
    // bare destination: no spaces, balanced parens; only \+punct unescapes
    let k = 0, depth = 0;
    while (k < rest.length) {
      const ch = rest.charCodeAt(k);
      if (ch === 92 && k + 1 < rest.length) {
        if (isPunct(rest.charCodeAt(k + 1))) { dest += rest[k + 1]; k += 2; }
        else { dest += rest[k] + rest[k + 1]; k += 2; }
        continue;
      }
      if (ch === 32 || ch === 9) break;
      if (ch === 40) depth++;
      else if (ch === 41) { if (depth === 0) break; depth--; }
      dest += rest[k]; k++;
    }
    if (dest.length === 0) return null;
    rest = rest.slice(k);
  }
  // optional title: must be preceded by whitespace, on this line or the next
  let title = null, next = cur;
  // how much whitespace was skipped after the destination on its own line
  let wsAfterDest = 0;
  {
    let k = 0;
    while (k < rest.length && isSpace(rest.charCodeAt(k))) { k++; wsAfterDest++; }
    rest = rest.slice(k);
  }
  const tryTitle = (t) => {
    // t is the text starting at the title quote; returns {title, rest} or null
    const q = t.charCodeAt(0);
    if (q !== 34 && q !== 39 && q !== 40) return null;
    const close = q === 40 ? 41 : q;
    let tv = '', pos = 1, tcur = t, tline = next;
    while (true) {
      let found = false;
      while (pos < tcur.length) {
        const ch = tcur.charCodeAt(pos);
        if (ch === 92 && pos + 1 < tcur.length && isPunct(tcur.charCodeAt(pos + 1))) { tv += tcur[pos + 1]; pos += 2; continue; }
        if (ch === close) { found = true; break; }
        tv += tcur[pos]; pos++;
      }
      if (found) return { title: tv, rest: tcur.slice(pos + 1), line: tline };
      // title continues on the next line
      if (tline + 1 >= lines.length) return null;
      tline++;
      if (isBlankL(lines[tline])) return null;
      tv += '\n';
      tcur = lines[tline].s;
      pos = 0;
    }
  };
  if (rest.length > 0) {
    // a title on the same line requires whitespace before it (cm-201)
    if (wsAfterDest === 0) return null;
    const tt = tryTitle(rest);
    if (tt) {
      // after the title only spaces may follow on its last line
      let k = 0;
      while (k < tt.rest.length && isSpace(tt.rest.charCodeAt(k))) k++;
      if (k < tt.rest.length) {
        // junk after a same-line title: the whole definition is invalid (cm-209)
        return null;
      }
      title = tt.title;
      next = tt.line;
    } else {
      return null; // junk after the destination on the same line
    }
  } else {
    // try the next line for a title (only if it starts with a quote)
    if (next + 1 < lines.length && !isBlankL(lines[next + 1])) {
      const nl = lines[next + 1];
      let ti = 0;
      const ns = nl.s;
      while (ti < ns.length && isSpace(ns.charCodeAt(ti))) ti++;
      if (ti < ns.length) {
        const q = ns.charCodeAt(ti);
        if (q === 34 || q === 39 || q === 40) {
          const saveNext = next;
          next++;
          const tt = tryTitle(ns.slice(ti));
          if (tt) {
            let k = 0;
            while (k < tt.rest.length && isSpace(tt.rest.charCodeAt(k))) k++;
            if (k >= tt.rest.length) { title = tt.title; next = tt.line; }
            else next = saveNext; // junk after a next-line title: def valid
            // without the title; do not consume the title line (cm-210)
          } else {
            next = saveNext;
          }
        }
      }
    }
  }
  return { label: normalizeLabel(label), href: dest, title, next: next + 1 };
}

// ---------- block HTML types ----------
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
const VOID_ELEMS = new Set(('area base br col command embed hr img input keygen link meta param source track wbr').split(' '));

// Classify a line as the start of a block HTML construct.
// Returns {type, endRe} or null. Types 1-5 end on a line containing endRe; 6-7 end at a blank line.
function htmlBlockStart(line) {
  const ind = indentOfL(line);
  if (ind.cols > 3) return null;
  const s = line.s.slice(ind.idx);
  const low = s.toLowerCase();
  if (/^<(script|pre|style|textarea)(\s|\/|>|$)/.test(low)) {
    const tag = low.match(/^<(script|pre|style|textarea)/)[1];
    return { type: 1, endRe: new RegExp('</' + tag + '\\s*>', 'i') };
  }
  if (low.startsWith('<!--')) return { type: 2, endRe: /-->/ };
  if (low.startsWith('<?')) return { type: 3, endRe: /\?>/ };
  if (/^<![a-z]/i.test(s)) return { type: 4, endRe: />/ };
  if (low.startsWith('<![cdata[')) return { type: 5, endRe: /\]\]>/ };
  let m = /^<\/?([a-z][a-z0-9-]*)(\s|\/|>|$)/i.exec(s);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return { type: 6, endRe: null };
  m = /^<([a-z][a-z0-9-]*)(\s[^>]*)?\/?>\s*$/i.exec(s) || /^<\/([a-z][a-z0-9-]*)\s*>\s*$/i.exec(s);
  if (m) {
    const name = m[1].toLowerCase();
    if (!VOID_ELEMS.has(name)) return { type: 7, endRe: null };
  }
  return null;
}

// ---------- fenced code ----------
function fenceStart(line) {
  const ind = indentOfL(line);
  if (ind.cols > 3) return null;
  let i = ind.idx;
  const s = line.s;
  const ch = s.charCodeAt(i);
  if (ch !== 96 && ch !== 126) return null; // ` or ~
  let n = 0;
  while (s.charCodeAt(i + n) === ch) n++;
  if (n < 3) return null;
  const info = s.slice(i + n);
  if (ch === 96 && info.indexOf('`') >= 0) return null;
  return { ch: String.fromCharCode(ch), len: n, info, indent: ind.cols };
}
function fenceEnd(line, fence) {
  const ind = indentOfL(line);
  if (ind.cols > 3) return false;
  let i = ind.idx;
  const s = line.s;
  if (s.charCodeAt(i) !== fence.ch.charCodeAt(0)) return false;
  let n = 0;
  while (s.charCodeAt(i + n) === fence.ch.charCodeAt(0)) n++;
  if (n < fence.len) return false;
  for (let k = i + n; k < s.length; k++) {
    if (!isSpace(s.charCodeAt(k))) return false;
  }
  return true;
}

// ---------- line objects ----------
// A line is {s, c}: s is the (materialized) text, c is the original column of s[0].
// Tab widths are always computed from the original column, so a partially consumed
// tab keeps its original width (this is what makes cm-005/006/007 come out right).
// `lazy` marks a line included as a paragraph continuation (blockquote/list
// lazy line): it can never start a new block (cm-238).
function L(s, c, lazy) { return { s, c, lazy: !!lazy }; }
function isBlankL(l) { return isBlank(l.s); }
function colAtL(l, i) {
  let col = l.c;
  for (let j = 0; j < i; j++) col += l.s.charCodeAt(j) === 9 ? 4 - (col % 4) : 1;
  return col;
}
function indentOfL(l) {
  let col = l.c, i = 0;
  const s = l.s;
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 32) { col++; i++; }
    else if (ch === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return { cols: col - l.c, idx: i, endCol: col };
}
// Remove n columns of leading whitespace from a line object.
function stripColsL(l, n) {
  let i = 0, col = l.c, left = n;
  const s = l.s;
  while (i < s.length && left > 0) {
    const ch = s.charCodeAt(i);
    if (ch === 9) {
      const w = 4 - (col % 4);
      if (w > left) return L(' '.repeat(w - left) + s.slice(i + 1), col + left);
      left -= w; col += w; i++;
    } else if (ch === 32) { left--; col++; i++; }
    else break;
  }
  return L(s.slice(i), col);
}
function splitLines(src) {
  const raw = src.split('\n');
  // drop the phantom last line when src ends with \n (it is not a real line)
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();
  return raw.map(s => L(s, 0));
}

// ---------- block start classification ----------
function atxHeading(line) {
  const ind = indentOfL(line);
  if (ind.cols > 3) return null;
  let i = ind.idx;
  const s = line.s;
  if (s.charCodeAt(i) !== 35) return null;
  let n = 0;
  while (s.charCodeAt(i + n) === 35) n++;
  if (n > 6) return null;
  const rest = s.slice(i + n);
  if (rest.length > 0 && rest.charCodeAt(0) !== 32 && rest.charCodeAt(0) !== 9) return null;
  // strip trailing closing sequence: spaces + #s + spaces
  let text = rest.replace(/[ \t]+$/, '');
  text = text.replace(/[ \t]+#+$/, '').replace(/[ \t]+$/, '');
  return { level: n, text: text.replace(/^[ \t]+/, '') };
}
function setextUnderline(line) {
  const ind = indentOfL(line);
  if (ind.cols > 3) return 0;
  const s = line.s.slice(ind.idx);
  if (/^=+[ \t]*$/.test(s)) return 1;
  if (/^-+[ \t]*$/.test(s)) return 2;
  return 0;
}
function hrLine(line) {
  const ind = indentOfL(line);
  if (ind.cols > 3) return false;
  const s = line.s.slice(ind.idx);
  return /^(?:\*[ \t]*){3,}$/.test(s) || /^(?:-[ \t]*){3,}$/.test(s) || /^(?:_[ \t]*){3,}$/.test(s);
}
function fenceStartL(line) {
  const ind = indentOfL(line);
  if (ind.cols > 3) return null;
  const s = line.s;
  let i = ind.idx;
  const ch = s.charCodeAt(i);
  if (ch !== 96 && ch !== 126) return null;
  let n = 0;
  while (s.charCodeAt(i + n) === ch) n++;
  if (n < 3) return null;
  const info = s.slice(i + n);
  if (ch === 96 && info.indexOf('`') >= 0) return null;
  return { ch: String.fromCharCode(ch), len: n, info, indent: ind.cols };
}
function fenceEndL(line, fence) {
  const ind = indentOfL(line);
  if (ind.cols > 3) return false;
  const s = line.s;
  let i = ind.idx;
  if (s.charCodeAt(i) !== fence.ch.charCodeAt(0)) return false;
  let n = 0;
  while (s.charCodeAt(i + n) === fence.ch.charCodeAt(0)) n++;
  if (n < fence.len) return false;
  for (let k = i + n; k < s.length; k++) if (!isSpace(s.charCodeAt(k))) return false;
  return true;
}
// blockquote prefix: returns the stripped line object, or null
function stripQuotePrefix(l) {
  const ind = indentOfL(l);
  if (ind.cols > 3) return null;
  const s = l.s;
  let i = ind.idx;
  if (s.charCodeAt(i) !== 62) return null; // >
  const colAfter = colAtL(l, i + 1);
  // optional one space after >
  return stripColsL(L(s.slice(i + 1), colAfter), 1);
}
// list marker at a line: {bullet, ordered, start, delim, markerLen, markerEndIdx, markerEndCol}
function listMarker(line) {
  const ind = indentOfL(line);
  if (ind.cols > 3) return null;
  const s = line.s;
  let i = ind.idx;
  const ch = s.charCodeAt(i);
  if (ch === 45 || ch === 43 || ch === 42) { // - + *
    const nx = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
    if (nx !== -1 && nx !== 32 && nx !== 9) return null;
    return { bullet: String.fromCharCode(ch), ordered: false, start: 0, delim: '', markerLen: 1, markerEndIdx: i + 1, markerEndCol: colAtL(line, i + 1), baseIndent: ind.cols };
  }
  if (isDigit(ch)) {
    let j = i, num = '';
    while (j < s.length && isDigit(s.charCodeAt(j)) && num.length < 9) { num += s[j]; j++; }
    if (num.length === 0) return null;
    const d = s.charCodeAt(j);
    if (d !== 46 && d !== 41) return null; // . or )
    const nx = j + 1 < s.length ? s.charCodeAt(j + 1) : -1;
    if (nx !== -1 && nx !== 32 && nx !== 9) return null;
    return { bullet: '', ordered: true, start: parseInt(num, 10), delim: String.fromCharCode(d), markerLen: j + 1 - i, markerEndIdx: j + 1, markerEndCol: colAtL(line, j + 1), baseIndent: ind.cols };
  }
  return null;
}
// Content indent of a list item, and the stripped first line.
// Returns {contentIndent, content} where content is the line object after the marker+spaces.
function listContent(line, m) {
  const s = line.s;
  // measure whitespace columns after the marker (from markerEndCol)
  let col = m.markerEndCol, i = m.markerEndIdx, spaces = 0;
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 32) { spaces++; col++; i++; }
    else if (ch === 9) { const w = 4 - (col % 4); spaces += w; col += w; i++; }
    else break;
  }
  const empty = i >= s.length;
  let contentIndent;
  if (empty) contentIndent = m.baseIndent + m.markerLen + 1;
  else if (spaces >= 1 && spaces <= 4) contentIndent = m.baseIndent + m.markerLen + spaces;
  else contentIndent = m.baseIndent + m.markerLen + 1;
  // strip the marker + the counted spaces (at most contentIndent - baseIndent columns of whitespace)
  const stripN = empty ? 0 : Math.min(spaces, contentIndent - m.baseIndent - m.markerLen);
  const after = stripColsL(L(s.slice(m.markerEndIdx), m.markerEndCol), stripN);
  return { contentIndent, content: after, empty };
}
// Split a table row line into cells (on unescaped |). Leading/trailing | are optional.
function splitCells(line) {
  let s = line.s;
  const ind = indentOfL(line);
  if (ind.cols > 3) return null;
  s = s.slice(ind.idx);
  let start = 0, end = s.length;
  if (s.charCodeAt(0) === 124) start = 1;
  if (end > start && s.charCodeAt(end - 1) === 124) end--;
  const cells = [];
  let cur = '', i = start;
  while (i < end) {
    const ch = s.charCodeAt(i);
    if (ch === 92 && i + 1 < end) {
      const nx = s.charCodeAt(i + 1);
      if (nx === 124) { cur += '|'; i += 2; continue; } // \| -> | (escaped pipe, no split)
      if (nx === 92) { cur += '\\\\'; i += 2; continue; } // \\ stays (literal backslash)
      cur += s[i]; i++; continue;
    }
    if (ch === 124) { cells.push(cur.trim()); cur = ''; i++; continue; }
    cur += s[i]; i++;
  }
  cells.push(cur.trim());
  return cells;
}
function isDelimiterRow(line) {
  const cells = splitCells(line);
  if (!cells || cells.length === 0) return null;
  const aligns = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    aligns.push(c.charCodeAt(0) === 58 ? (c.charCodeAt(c.length - 1) === 58 ? 'center' : 'left') : (c.charCodeAt(c.length - 1) === 58 ? 'right' : null));
  }
  return aligns;
}
// What kind of block (if any) starts at this line? Used for paragraph interruption.
// Returns a string kind or null. `para` = true when called from inside a paragraph.
function blockStartKind(line, para) {
  if (line.lazy) return null; // a lazy continuation line is paragraph text
  const ind = indentOfL(line);
  const s = line.s;
  if (isBlankL(line)) return null;
  if (ind.cols <= 3) {
    if (atxHeading(line)) return 'heading';
    if (fenceStartL(line)) return 'fence';
    if (hrLine(line)) return 'hr';
    if (s.charCodeAt(ind.idx) === 62) return 'quote';
    if (listMarker(line)) {
      if (!para) return 'list';
      const m = listMarker(line);
      // a bullet list can interrupt a paragraph; an ordered list only if it starts with 1;
      // an empty list item cannot interrupt a paragraph
      const lc = listContent(line, m);
      if (lc.empty) return null;
      if (!m.ordered) return 'list';
      return m.start === 1 ? 'list' : null;
    }
    const hb = htmlBlockStart(line);
    if (hb) {
      if (!para) return 'html';
      return hb.type === 7 ? null : 'html';
    }
  }
  return null;
}

// ---------- block lexer ----------
// Does the block content in `inner` end with a paragraph at the TOP level
// (no descending into nested lists/quotes)? Used for the looseness check:
// a blank line inside a nested list must not make the outer list loose.
function endsWithParaTop(inner, links) {
  if (inner.length === 0) return false;
  let last = inner.length - 1;
  while (last >= 0 && isBlankL(inner[last])) last--;
  if (last < 0) return false;
  const nodes = lexBlocks(inner.slice(0, last + 1), links, false, false);
  return nodes.length > 0 && nodes[nodes.length - 1].t === 'p';
}

// Does the block content in `inner` (so far) end with an open paragraph?
// A lazy continuation line can only continue a paragraph, not a fence/code/html/list.
// Descends into nested blockquotes / list items (cm-250/251).
function endsWithPara(inner, links) {
  if (inner.length === 0) return false;
  let last = inner.length - 1;
  while (last >= 0 && isBlankL(inner[last])) last--;
  if (last < 0) return false;
  const nodes = lexBlocks(inner.slice(0, last + 1), links, false, false);
  let cur = nodes;
  while (cur.length > 0) {
    const lastNode = cur[cur.length - 1];
    if (lastNode.t === 'p') return true;
    if (lastNode.t === 'quote') { cur = lastNode.children; continue; }
    if (lastNode.t === 'list' && lastNode.items.length > 0) {
      cur = lastNode.items[lastNode.items.length - 1].children;
      continue;
    }
    return false;
  }
  return false;
}

function lexBlocks(lines, links, top, srcEndsNL) {
  const nodes = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlankL(line)) { i++; continue; }
    const ind = indentOfL(line);
    // indented code
    if (ind.cols >= 4) {
      const codeLines = [];
      let j = i;
      while (j < n) {
        const l = lines[j];
        if (isBlankL(l)) {
          let k = j + 1;
          while (k < n && isBlankL(lines[k])) k++;
          if (k < n && indentOfL(lines[k]).cols >= 4) { while (j < k) { codeLines.push(stripColsL(lines[j], 4).s); j++; } continue; }
          break;
        }
        if (indentOfL(l).cols >= 4) { codeLines.push(stripColsL(l, 4).s); j++; continue; }
        break;
      }
      nodes.push({ t: 'code', text: codeLines.join('\n') });
      i = j;
      continue;
    }
    // fenced code
    const fence = fenceStartL(line);
    if (fence) {
      const body = [];
      let j = i + 1;
      // content lines are dedented by the opening fence's indent. A leading
      // tab expands to spaces from the line's column only when the line came
      // from a container (column > 0); at column 0 it is preserved (doc-01).
      while (j < n && !fenceEndL(lines[j], fence)) {
        const dl = stripColsL(lines[j], fence.indent);
        let txt = dl.s;
        if (txt.charCodeAt(0) === 9 && dl.c > 0) {
          txt = ' '.repeat(4 - (dl.c % 4)) + txt.slice(1);
        }
        body.push(txt);
        j++;
      }
      const info = fence.info.replace(/\\(.)/g, '$1').trim();
      const lang = info ? info.split(/\s+/)[0] : '';
      nodes.push({ t: 'fence', lang, text: body.join('\n') });
      i = j < n ? j + 1 : j;
      continue;
    }
    // ATX heading
    const atx = atxHeading(line);
    if (atx) { nodes.push({ t: 'h', level: atx.level, text: atx.text }); i++; continue; }
    // table
    if (line.s.indexOf('|') >= 0 && i + 1 < n) {
      const aligns = isDelimiterRow(lines[i + 1]);
      if (aligns) {
        const header = splitCells(line);
        if (header && header.length === aligns.length) {
          const rows = [];
          let j = i + 2;
          // a body row is any non-blank line (it need not contain a |, gfm-202)
          while (j < n && !isBlankL(lines[j])) {
            const cells = splitCells(lines[j]);
            if (!cells) break;
            while (cells.length < header.length) cells.push('');
            rows.push(cells.slice(0, header.length));
            j++;
          }
          nodes.push({ t: 'table', aligns, header, rows });
          i = j;
          continue;
        }
      }
    }
    // thematic break
    if (hrLine(line)) { nodes.push({ t: 'hr' }); i++; continue; }
    // blockquote
    if (ind.cols <= 3 && line.s.charCodeAt(ind.idx) === 62) {
      const inner = [];
      let j = i;
      while (j < n) {
        const q = stripQuotePrefix(lines[j]);
        if (q) { inner.push(q); j++; continue; }
        if (!isBlankL(lines[j]) && inner.length > 0 && !isBlankL(inner[inner.length - 1]) && !blockStartKind(lines[j], true) && !hrLine(lines[j]) && endsWithPara(inner, links)) {
          // a lazy setext === line cannot be a heading underline: neutralize it
          // with 4 spaces so it stays paragraph text (marked's behaviour, cm-093)
          if (setextUnderline(lines[j]) === 1) {
            inner.push(L('    ' + lines[j].s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''), 0, true));
          } else {
            // a lazy line's leading whitespace is stripped (cm-238)
            inner.push(L(lines[j].s.replace(/^[ \t]+/, ''), 0, true));
          }
          j++; continue; // lazy continuation (incl. setext underline lines)
        }
        break;
      }
      nodes.push({ t: 'quote', children: lexBlocks(inner, links) });
      i = j;
      continue;
    }
    // list
    const lm = ind.cols <= 3 ? listMarker(line) : null;
    if (lm) {
      const res = parseList(lines, i, links);
      nodes.push(res.node);
      i = res.next;
      continue;
    }
    // HTML block
    if (ind.cols <= 3) {
      const hb = htmlBlockStart(line);
      if (hb) {
        const htmlLines = [line.s];
        let j = i + 1;
        if (hb.type <= 5) {
          if (!hb.endRe.test(line.s)) {
            while (j < n) {
              htmlLines.push(lines[j].s);
              if (hb.endRe.test(lines[j].s)) { j++; break; }
              j++;
            }
          }
        } else {
          while (j < n && !isBlankL(lines[j])) { htmlLines.push(lines[j].s); j++; }
        }
        // trailing newline: the block keeps the newline after its last line when
        // the next line is non-blank content, or when it is the last block and the
        // source ends with a newline; a following blank line means no trailing \n.
        let htext = htmlLines.join('\n');
        const nextIsContent = j < n && !isBlankL(lines[j]);
        const atDocEnd = top && j >= n;
        if (nextIsContent || (atDocEnd && srcEndsNL)) htext += '\n';
        nodes.push({ t: 'html', text: htext });
        i = j;
        continue;
      }
    }
    // link reference definition
    const def = parseDef(lines, i);
    if (def) {
      if (!links[def.label]) links[def.label] = { href: def.href, title: def.title };
      i = def.next;
      continue;
    }
    // paragraph (a following setext underline turns it into a heading)
    const pLines = [line.s];
    let j = i + 1;
    while (j < n) {
      const l = lines[j];
      if (isBlankL(l)) break;
      if (setextUnderline(l)) break;
      if (blockStartKind(l, true)) break;
      pLines.push(l.s);
      j++;
    }
    if (j < n && setextUnderline(lines[j])) {
      // a setext heading's text is the paragraph text with leading/trailing spaces stripped
      const ht = pLines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      nodes.push({ t: 'h', level: setextUnderline(lines[j]), text: ht });
      i = j + 1;
      continue;
    }
    nodes.push({ t: 'p', text: pLines.join('\n') });
    i = j;
  }
  return nodes;
}

// ---------- lists ----------
function parseList(lines, start, links) {
  const first = listMarker(lines[start]);
  const items = [];
  let loose = false;
  let i = start;
  let prevBlank = false;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankL(line)) {
      let k = i + 1;
      while (k < lines.length && isBlankL(lines[k])) k++;
      if (k >= lines.length) break;
      const nm = listMarker(lines[k]);
      if (nm && nm.bullet === first.bullet && nm.ordered === first.ordered && nm.delim === first.delim && indentOfL(lines[k]).cols < items[items.length - 1].contentIndent) {
        prevBlank = true; i = k; continue;
      }
      if (items.length > 0 && indentOfL(lines[k]).cols >= items[items.length - 1].contentIndent) {
        prevBlank = true; i = k; continue;
      }
      break;
    }
    // a thematic break line ends the list (it is not a list item)
    if (hrLine(line)) break;
    const m = listMarker(line);
    if (m && m.bullet === first.bullet && m.ordered === first.ordered && m.delim === first.delim
        && (items.length === 0 || indentOfL(line).cols < items[items.length - 1].contentIndent)) {
      const lc = listContent(line, m);
      const itemLines = [];
      if (!lc.empty) itemLines.push(lc.content);
      // a fence opened in the item swallows following lines regardless of
      // indent until it closes (doc-02)
      let inFence = null;
      if (!lc.empty) { const f0 = fenceStartL(lc.content); if (f0) inFence = f0; }
      let j = i + 1;
      let itemHasBlank = false;
      while (j < lines.length) {
        const l = lines[j];
        if (inFence) {
          const dl = indentOfL(l).cols >= lc.contentIndent ? stripColsL(l, lc.contentIndent) : L(l.s, l.c);
          itemLines.push(dl);
          if (fenceEndL(dl, inFence)) inFence = null;
          j++; continue;
        }
        if (isBlankL(l)) {
          // an empty item followed by a blank line is empty: no content
          // may follow (cm-280)
          if (lc.empty) break;
          let k = j + 1;
          while (k < lines.length && isBlankL(lines[k])) k++;
          if (k >= lines.length) break;
          const nm2 = listMarker(lines[k]);
          if (nm2 && nm2.bullet === first.bullet && nm2.ordered === first.ordered && nm2.delim === first.delim && indentOfL(lines[k]).cols < lc.contentIndent) break;
          if (indentOfL(lines[k]).cols >= lc.contentIndent) {
            // a blank line counts toward looseness only if it separates two
            // blocks that are direct children of this item: the following
            // line is at the item's content indent, or the item so far ends
            // with a paragraph (a blank inside a nested list/quote does not
            // make the outer list loose, doc-02)
            if (indentOfL(lines[k]).cols === lc.contentIndent || endsWithParaTop(itemLines, links)) itemHasBlank = true;
            while (j < k) { itemLines.push(L('', 0)); j++; } continue;
          }
          break;
        }
        if (indentOfL(l).cols >= lc.contentIndent) {
          const dl = stripColsL(l, lc.contentIndent);
          itemLines.push(dl);
          const f = fenceStartL(dl);
          if (f) inFence = f;
          j++; continue;
        }
        // a lazy paragraph continuation: a plain-text line (no block start,
        // not a list marker, not an hr) while the item so far ends with a
        // paragraph (cm-290/291). Indent >= 4 loses 4 columns (code-indent
        // quirk); indent < 4 keeps its spaces.
        if (!hrLine(l) && !listMarker(l) && blockStartKind(l, true) === null && endsWithPara(itemLines, links)) {
          const ind = indentOfL(l);
          if (ind.cols >= 4) itemLines.push(L(stripColsL(l, 4).s, 0, true));
          else itemLines.push(L(l.s, 0, true));
          j++; continue;
        }
        break;
      }
      let task = false, checked = false;
      if (itemLines.length > 0) {
        const fl = itemLines[0].s;
        const tm = /^\[([ xX])\] /.exec(fl);
        if (tm) {
          task = true; checked = tm[1] !== ' ';
          itemLines[0] = L(fl.slice(4), itemLines[0].c + 4);
        }
      }
      if (prevBlank) loose = true;
      if (itemHasBlank) loose = true;
      items.push({ task, checked, children: lexBlocks(itemLines, links), contentIndent: lc.contentIndent });
      i = j;
      prevBlank = false;
      continue;
    }
    break;
  }
  return { node: { t: 'list', ordered: first.ordered, start: first.start, items, loose }, next: i };
}

// ---------- block renderer ----------
function renderBlocks(nodes, links) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'p': out += '<p>' + inline(n.text, links) + '</p>\n'; break;
      case 'h': out += '<h' + n.level + '>' + inline(n.text, links) + '</h' + n.level + '>\n'; break;
      case 'code': { const t = stripTrailingNewlines(n.text); out += '<pre><code>' + esc(t ? t + '\n' : '', true) + '</code></pre>\n'; break; }
      case 'fence': {
        const lang = n.lang ? ' class="language-' + esc(n.lang) + '"' : '';
        const t = stripTrailingNewlines(n.text);
        out += '<pre><code' + lang + '>' + esc(t ? t + '\n' : '', true) + '</code></pre>\n';
        break;
      }
      case 'hr': out += '<hr>\n'; break;
      case 'html': out += n.text; break;
      case 'quote': out += '<blockquote>\n' + renderBlocks(n.children, links) + '</blockquote>\n'; break;
      case 'list': {
        const tag = n.ordered ? 'ol' : 'ul';
        const startAttr = n.ordered && n.start !== 1 ? ' start="' + n.start + '"' : '';
        out += '<' + tag + startAttr + '>\n';
        for (const it of n.items) out += renderListItem(it, links, n.loose);
        out += '</' + tag + '>\n';
        break;
      }
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let k = 0; k < n.header.length; k++) {
          const a = n.aligns[k];
          out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + inline(n.header[k], links) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (n.rows.length > 0) {
          out += '<tbody>';
          for (const row of n.rows) {
            out += '<tr>\n';
            for (let k = 0; k < row.length; k++) {
              const a = n.aligns[k];
              out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + inline(row[k], links) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
    }
  }
  return out;
}
function stripTrailingNewlines(s) {
  let e = s.length;
  while (e > 0 && s.charCodeAt(e - 1) === 10) e--;
  return s.slice(0, e);
}
function renderListItem(it, links, loose) {
  const checkbox = it.task ? (it.checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ') : '';
  let out = '<li>';
  if (!loose) {
    out += checkbox;
    for (const c of it.children) {
      if (c.t === 'p') out += inline(c.text, links);
      else out += renderBlocks([c], links);
    }
  } else {
    // loose: the checkbox goes inside the first paragraph
    let placed = false;
    for (const c of it.children) {
      if (!placed && checkbox && c.t === 'p') {
        out += '<p>' + checkbox + inline(c.text, links) + '</p>\n';
        placed = true;
      } else out += renderBlocks([c], links);
    }
    if (checkbox && !placed) out += checkbox;
  }
  out += '</li>\n';
  return out;
}

// ---------- inline parser ----------
// Node types: 0 text, 1 code, 2 delimiter, 3 link, 4 image, 5 br, 6 html, 7 em, 8 strong, 9 del
function inline(src, links) { return renderInline(parseInline(src, links, false).nodes); }

function isPunctChar(ch) {
  if (ch < 128) return isPunct(ch);
  return /[\p{P}\p{S}]/u.test(String.fromCharCode(ch));
}
function isSpaceChar(ch) {
  return ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 11 || ch === 12 || ch === 160 || ch === 8195 || ch === 8196 || ch === 8197 || ch === 8198 || ch === 8199 || ch === 8200 || ch === 8201 || ch === 8202 || ch === 8239 || ch === 8287 || ch === 12288;
}
function isWordChar(ch) {
  return isAlphaNum(ch) || ch > 127;
}

// Find the matching ] for a [ at position i. Returns {end, label} or null.
// Find the matching ] for a [ at position i. Returns {end, label} or null.
// Respects nested brackets, code spans, and backslash escapes.
// The label is returned with backslash escapes processed (like a def label).
function findLabelEnd(s, i) {
  let depth = 0, j = i + 1, label = '';
  while (j < s.length) {
    const ch = s.charCodeAt(j);
    if (ch === 92) {
      if (j + 1 < s.length) { label += s[j + 1]; j += 2; }
      else { label += s[j]; j++; }
      continue;
    }
    if (ch === 96) {
      let n = 0; while (s.charCodeAt(j + n) === 96) n++;
      let k = j + n, found = -1;
      while (k < s.length) {
        if (s.charCodeAt(k) === 96) {
          let m = 0; while (s.charCodeAt(k + m) === 96) m++;
          if (m === n) { found = k; break; }
          k += m;
        } else k++;
      }
      if (found < 0) { label += '`'.repeat(n); j += n; continue; }
      label += s.slice(j, found + n);
      j = found + n;
      continue;
    }
    if (ch === 91) { depth++; label += s[j]; j++; continue; }
    if (ch === 93) {
      if (depth === 0) return { end: j, label };
      depth--; label += s[j]; j++; continue;
    }
    label += s[j]; j++;
  }
  return null;
}
// Find the matching ) for a ( at position i (balanced, escapes). Returns index just past ) or -1.
function findParenEnd(s, i) {
  let depth = 0, j = i;
  while (j < s.length) {
    const ch = s.charCodeAt(j);
    if (ch === 92) { j += 2; continue; }
    if (ch === 40) depth++;
    else if (ch === 41) { depth--; if (depth === 0) return j + 1; }
    j++;
  }
  return -1;
}
const UNESCAPE_RE = /\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g;
// Parse an inline link (dest title) starting at s[i] === '('. Returns {href, title, end} or null.
function parseInlineLink(s, i) {
  let j = i + 1;
  while (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
  let href = '';
  if (s.charCodeAt(j) === 60) {
    j++;
    const start = j;
    while (j < s.length && s.charCodeAt(j) !== 62 && s.charCodeAt(j) !== 10) {
      if (s.charCodeAt(j) === 60) return null;
      if (s.charCodeAt(j) === 92 && j + 1 < s.length) { j += 2; continue; }
      j++;
    }
    if (j >= s.length || s.charCodeAt(j) !== 62) return null;
    href = s.slice(start, j).replace(UNESCAPE_RE, '$1');
    j++;
  } else {
    const start = j;
    let depth = 0;
    while (j < s.length) {
      const ch = s.charCodeAt(j);
      if (ch === 92 && j + 1 < s.length) {
        if (isPunct(s.charCodeAt(j + 1))) { href += s[j + 1]; j += 2; }
        else { href += s[j] + s[j + 1]; j += 2; }
        continue;
      }
      if (ch === 32 || ch === 9 || ch === 10) break;
      if (ch === 40) depth++;
      else if (ch === 41) { if (depth === 0) break; depth--; }
      href += s[j]; j++;
    }
    if (j === start && href.length === 0) {
      if (s.charCodeAt(j) !== 41) return null;
      href = '';
    }
  }
  let k = j;
  while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
  let title = null;
  if (k < s.length && s.charCodeAt(k) !== 41) {
    const q = s.charCodeAt(k);
    if (q === 34 || q === 39) {
      let m = k + 1, tv = '';
      while (m < s.length) {
        const ch = s.charCodeAt(m);
        if (ch === 92 && m + 1 < s.length) { tv += s[m + 1]; m += 2; continue; }
        if (ch === q) break;
        tv += s[m]; m++;
      }
      if (m >= s.length) return null;
      title = tv;
      k = m + 1;
    } else if (q === 40) {
      let m = k + 1, tv = '';
      while (m < s.length) {
        const ch = s.charCodeAt(m);
        if (ch === 92 && m + 1 < s.length) { tv += s[m + 1]; m += 2; continue; }
        if (ch === 40) return null;
        if (ch === 41) break;
        tv += s[m]; m++;
      }
      if (m >= s.length) return null;
      title = tv;
      k = m + 1;
    } else return null;
    while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
  }
  if (k >= s.length || s.charCodeAt(k) !== 41) return null;
  return { href, title, end: k + 1 };
}

// Ranges [start, end) where emphasis delimiters are invisible (marked's masked source):
// link-like [...](...) regions (even when the link is rejected) and resolved [...][...] regions.
function findMaskRegions(s, links) {
  const ranges = [];
  let i = 0;
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 91 || (ch === 33 && s.charCodeAt(i + 1) === 91)) {
      const open = ch === 91 ? i : i + 1;
      const lab = findLabelEnd(s, open);
      if (lab) {
        const after = lab.end + 1;
        if (s.charCodeAt(after) === 40) {
          const pe = findParenEnd(s, after);
          if (pe > 0) { ranges.push([i, pe]); i = pe; continue; }
        } else if (s.charCodeAt(after) === 91) {
          const ref = findLabelEnd(s, after);
          if (ref) {
            const key = normalizeLabel(ref.label === '' ? lab.label : ref.label);
            if (links[key]) { ranges.push([i, ref.end + 1]); i = ref.end + 1; continue; }
          }
        }
      }
    }
    i++;
  }
  return ranges;
}

function containsLink(nodes) {
  for (const n of nodes) {
    if (n.t === 3) return true;
    if (n.children && containsLink(n.children)) return true;
  }
  return false;
}
function plainText(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 0 || n.t === 1 || n.t === 6) out += n.s;
    else if (n.t === 4) out += n.alt;
    else if (n.children) out += plainText(n.children);
  }
  return out;
}

// GFM bare URL / email starting at i (only when not inside a link label).
// Returns {href, text, end, email} or null.
const EMAIL_PART = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const EMAIL_RE = new RegExp('^' + EMAIL_PART);
const EMAIL_PROTO_RE = new RegExp('^(?:mailto:' + EMAIL_PART + '|xmpp:' + EMAIL_PART + '(?:\\/[A-Za-z0-9@.]+)?)');
function matchGfmUrl(s, i, n) {
  const rest = s.slice(i);
  // mailto: / xmpp: + email (xmpp may carry one /resource segment)
  let m = EMAIL_PROTO_RE.exec(rest);
  if (m) {
    let url = backpedalUrl(m[0]);
    if (url.length === 0) return null;
    return { href: url, text: url, end: i + url.length, email: false };
  }
  m = /^www\.[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*[^\s<]*/.exec(rest);
  let isWww = true;
  if (!m) {
    m = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:\/\/[^\s<]*/.exec(rest);
    isWww = false;
  }
  if (m) {
    let url = m[0];
    url = backpedalUrl(url);
    if (url.length === 0) return null;
    return { href: isWww ? 'http://' + url : url, text: url, end: i + url.length, email: false };
  }
  m = EMAIL_RE.exec(rest);
  if (m) {
    return { href: 'mailto:' + m[0], text: m[0], end: i + m[0].length, email: true };
  }
  return null;
}
// Trim trailing punctuation from a bare URL the way marked's _backpedal does.
function backpedalUrl(url) {
  let changed = true;
  while (changed && url.length > 0) {
    changed = false;
    const last = url.charCodeAt(url.length - 1);
    if (last === 63 || last === 33 || last === 46 || last === 44 || last === 58 || last === 59 || last === 42 || last === 95 || last === 39 || last === 34 || last === 126) {
      url = url.slice(0, -1); changed = true; continue;
    }
    if (last === 41) {
      let open = 0, close = 0;
      for (let k = 0; k < url.length; k++) {
        if (url.charCodeAt(k) === 40) open++;
        else if (url.charCodeAt(k) === 41) close++;
      }
      if (close > open) { url = url.slice(0, -1); changed = true; continue; }
    }
    if (last === 59) {
      // trailing &word; (an entity-like tail) is not part of the URL
      const mm = /&\w+;$/.exec(url);
      if (mm) { url = url.slice(0, url.length - mm[0].length); changed = true; continue; }
    }
    if (last === 38) {
      // trailing & that is not part of a valid entity
      const tail = url.slice(Math.max(0, url.length - 12));
      if (!/&(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);$/.test(tail)) { url = url.slice(0, -1); changed = true; continue; }
    }
  }
  return url;
}

const AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*)>/;
const EMAIL_AUTOLINK_RE = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)>/;
const TAG_RE = /^<!--[\s\S]*?-->|^<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+[^>]*>|^<!\[CDATA\[[\s\S]*?\]\]>/;

function parseInline(src, links, inLink) {
  const mask = findMaskRegions(src, links);
  let maskIdx = 0;
  const inMask = p => {
    while (maskIdx < mask.length && mask[maskIdx][1] <= p) maskIdx++;
    return maskIdx < mask.length && mask[maskIdx][0] <= p && p < mask[maskIdx][1];
  };
  const nodes = [];
  const delims = [];
  let textBuf = '';
  let inRawBlock = false;
  let rawTag = '';
  const flushText = () => { if (textBuf) { nodes.push({ t: 0, s: textBuf }); textBuf = ''; } };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src.charCodeAt(i);
    // raw block (<pre>/<script>/<style>/<textarea>): only the closing tag is parsed
    if (inRawBlock) {
      if (ch === 60 && src.slice(i, i + 2 + rawTag.length + 1).toLowerCase() === '</' + rawTag + '>') {
        flushText();
        nodes.push({ t: 6, s: src.slice(i, i + 2 + rawTag.length + 1) });
        i += 2 + rawTag.length + 1;
        inRawBlock = false;
        continue;
      }
      textBuf += src[i]; i++; continue;
    }
    // backslash escape / hard break
    if (ch === 92) {
      const nx = i + 1 < n ? src.charCodeAt(i + 1) : -1;
      if (nx === 10) { flushText(); nodes.push({ t: 5 }); i += 2; continue; }
      if (nx >= 0 && isPunct(nx)) { textBuf += nx === 38 ? AMP : String.fromCharCode(nx); i += 2; continue; }
      textBuf += '\\'; i++; continue;
    }
    // code span
    if (ch === 96) {
      let run = 0; while (src.charCodeAt(i + run) === 96) run++;
      let k = i + run, found = -1;
      while (k < n) {
        if (src.charCodeAt(k) === 96) {
          let m = 0; while (src.charCodeAt(k + m) === 96) m++;
          if (m === run) { found = k; break; }
          k += m;
        } else k++;
      }
      if (found < 0) { textBuf += '`'.repeat(run); i += run; continue; }
      let content = src.slice(i + run, found).replace(/\n/g, ' ');
      if (content.length > 1 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && /[^ ]/.test(content)) content = content.slice(1, -1);
      flushText();
      nodes.push({ t: 1, s: content });
      i = found + run;
      continue;
    }
    // link / image
    if (ch === 91 || (ch === 33 && src.charCodeAt(i + 1) === 91)) {
      const isImage = ch === 33;
      const open = isImage ? i + 1 : i;
      const lab = findLabelEnd(src, open);
      if (lab) {
        const after = lab.end + 1;
        let href = null, title = null, end = -1;
        if (src.charCodeAt(after) === 40) {
          const pl = parseInlineLink(src, after);
          if (pl) { href = pl.href; title = pl.title; end = pl.end; }
        } else if (src.charCodeAt(after) === 91) {
          const ref = findLabelEnd(src, after);
          if (ref) {
            const key = normalizeLabel(ref.label === '' ? lab.label : ref.label);
            const def = links[key];
            if (def) { href = def.href; title = def.title; end = ref.end + 1; }
          }
        } else {
          const key = normalizeLabel(lab.label);
          const def = links[key];
          if (def) { href = def.href; title = def.title; end = after; }
        }
        if (href !== null) {
          const clean = cleanUrl(href);
          if (clean !== null) {
            const sub = parseInline(lab.label, links, true);
            if (!isImage && containsLink(sub.nodes)) {
              // a link inside a link: the outer link does not form
            } else {
              flushText();
              if (isImage) nodes.push({ t: 4, href: clean, title, alt: plainText(sub.nodes) });
              else nodes.push({ t: 3, href: clean, title, children: sub.nodes });
              i = end;
              continue;
            }
          }
        }
      }
      textBuf += isImage ? '![' : '[';
      i += isImage ? 2 : 1;
      continue;
    }
    // autolink / inline HTML
    if (ch === 60) {
      const rest = src.slice(i);
      let m = AUTOLINK_RE.exec(rest);
      if (m) {
        const clean = cleanUrl(m[1]);
        if (clean !== null) {
          flushText();
          nodes.push({ t: 3, href: clean, title: null, children: [{ t: 0, s: m[1] }], autolink: true });
          i += m[0].length;
          continue;
        }
      }
      m = EMAIL_AUTOLINK_RE.exec(rest);
      if (m) {
        flushText();
        nodes.push({ t: 3, href: 'mailto:' + m[1], title: null, children: [{ t: 0, s: m[1] }], autolink: true });
        i += m[0].length;
        continue;
      }
      m = TAG_RE.exec(rest);
      if (m) {
        const tag = m[0];
        const low = tag.toLowerCase();
        flushText();
        nodes.push({ t: 6, s: tag });
        // marked's inRawBlock: only <pre>, <code>, <kbd>, <script> open/close
        if (/^<(pre|code|kbd|script)(\s|\/|>)/.test(low)) { inRawBlock = true; rawTag = low.match(/^<(pre|code|kbd|script)/)[1]; }
        else if (/^<\/(pre|code|kbd|script)(\s|\/|>)/.test(low)) { inRawBlock = false; }
        i += tag.length;
        continue;
      }
      textBuf += '<'; i++; continue;
    }
    // emphasis / strikethrough delimiters
    if (ch === 42 || ch === 95 || ch === 126) {
      if (inMask(i)) { textBuf += src[i]; i++; continue; }
      let run = 0; while (src.charCodeAt(i + run) === ch) run++;
      if (ch === 126 && run >= 3) { textBuf += '~'.repeat(run); i += run; continue; }
      const prev = i > 0 ? src.charCodeAt(i - 1) : -1;
      const next = i + run < n ? src.charCodeAt(i + run) : -1;
      const prevWS = prev < 0 || isSpaceChar(prev);
      const nextWS = next < 0 || isSpaceChar(next);
      const prevP = prev >= 0 && isPunctChar(prev);
      const nextP = next >= 0 && isPunctChar(next);
      const leftFlank = !nextWS && (!nextP || prevWS || prevP);
      const rightFlank = !prevWS && (!prevP || nextWS || nextP);
      let canOpen, canClose;
      if (ch === 95) {
        canOpen = leftFlank && (!rightFlank || prevP);
        canClose = rightFlank && (!leftFlank || nextP);
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      if (!canOpen && !canClose) { textBuf += String.fromCharCode(ch).repeat(run); i += run; continue; }
      flushText();
      const node = { t: 2, c: String.fromCharCode(ch), len: run, canOpen, canClose };
      nodes.push(node);
      delims.push(node);
      i += run;
      continue;
    }
    // newline: hard break (2+ trailing spaces or backslash) or soft break
    if (ch === 10) {
      // strip trailing spaces from the current text buffer
      let e = textBuf.length;
      let spaces = 0;
      while (e > 0 && textBuf.charCodeAt(e - 1) === 32) { e--; spaces++; }
      if (spaces >= 2) { textBuf = textBuf.slice(0, e); flushText(); nodes.push({ t: 5 }); }
      else textBuf += '\n';
      i++;
      continue;
    }
    // entity / bare &
    if (ch === 38) {
      const rest = src.slice(i);
      let m = /^&#(\d+);/.exec(rest) || /^&#[Xx]([0-9a-fA-F]+);/.exec(rest);
      if (m) {
        const body = m[0].slice(2, -1);
        const dec = decodeNumeric(body);
        if (dec !== null) { textBuf += dec; i += m[0].length; continue; }
        textBuf += m[0]; i += m[0].length; continue; // invalid codepoint: literal
      }
      m = /^&\w+;/.exec(rest);
      if (m) { textBuf += m[0]; i += m[0].length; continue; }
      textBuf += '&'; i++; continue;
    }
    // GFM bare URL / email (not inside a link label)
    if (!inLink && isAlphaNum(ch)) {
      const prev = i > 0 ? src.charCodeAt(i - 1) : -1;
      if (prev < 0 || !isWordChar(prev) && prev !== 46 && prev !== 95 && prev !== 37 && prev !== 43 && prev !== 45) {
        const g = matchGfmUrl(src, i, n);
        if (g) {
          const clean = cleanUrl(g.href);
          if (clean !== null) {
            flushText();
            nodes.push({ t: 3, href: clean, title: null, children: [{ t: 0, s: g.text }], autolink: true });
            i = g.end;
            continue;
          }
        }
      }
    }
    textBuf += src[i]; i++;
  }
  flushText();
  processEmphasis(nodes, delims);
  return { nodes, hasLink: containsLink(nodes) };
}

// CommonMark emphasis processing over the delimiter stack.
function processEmphasis(nodes, delims) {
  let cur = 0;
  while (cur < delims.length) {
    const closer = delims[cur];
    if (!closer.canClose) { cur++; continue; }
    // find the nearest preceding opener with the same char
    let oi = cur - 1, opener = null;
    while (oi >= 0) {
      const d = delims[oi];
      if (d.c === closer.c && d.canOpen) {
        if (d.canClose && closer.canOpen && (d.len + closer.len) % 3 === 0) { oi--; continue; }
        opener = d;
        break;
      }
      oi--;
    }
    if (!opener) { cur++; continue; }
    let use;
    if (closer.c === '~') {
      if (opener.len !== closer.len || opener.len > 2) { cur++; continue; }
      use = opener.len;
    } else {
      use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
    }
    const oi2 = nodes.indexOf(opener);
    const ci = nodes.indexOf(closer);
    if (oi2 < 0 || ci < 0 || ci <= oi2) { cur++; continue; }
    const inner = nodes.slice(oi2 + 1, ci);
    const kind = closer.c === '~' ? 9 : (use === 2 ? 8 : 7);
    const emNode = { t: kind, children: inner };
    opener.len -= use;
    closer.len -= use;
    const rep = [];
    if (opener.len > 0) rep.push(opener);
    rep.push(emNode);
    if (closer.len > 0) rep.push(closer);
    nodes.splice(oi2, ci - oi2 + 1, ...rep);
    // keep the delimiter stack consistent: capture indices before any removal
    const openerIdx = delims.indexOf(opener);
    let closerIdx = delims.indexOf(closer);
    if (opener.len === 0 && openerIdx >= 0) { delims.splice(openerIdx, 1); closerIdx--; }
    if (closer.len === 0) {
      if (closerIdx >= 0) delims.splice(closerIdx, 1);
      cur = closerIdx; // the delimiter after the removed closer is now here
    } else {
      cur = closerIdx; // stay on the closer (it still has length)
    }
    if (cur < 0) cur = 0;
  }
}

function renderInline(nodes) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 0: out += esc(n.s); break;
      case 1: out += '<code>' + esc(n.s, true) + '</code>'; break;
      case 2: out += n.c.repeat(n.len); break;
      case 3: {
        const inner = n.autolink ? esc(n.children[0].s, true) : renderInline(n.children);
        out += '<a href="' + esc(n.href, !!n.autolink) + '"' + (n.title ? ' title="' + esc(n.title) + '"' : '') + '>' + inner + '</a>';
        break;
      }
      case 4: out += '<img src="' + esc(n.href) + '" alt="' + esc(n.alt) + '"' + (n.title ? ' title="' + esc(n.title) + '"' : '') + '>'; break;
      case 5: out += '<br>'; break;
      case 6: out += n.s; break;
      case 7: out += '<em>' + renderInline(n.children) + '</em>'; break;
      case 8: out += '<strong>' + renderInline(n.children) + '</strong>'; break;
      case 9: out += '<del>' + renderInline(n.children) + '</del>'; break;
    }
  }
  return out;
}
