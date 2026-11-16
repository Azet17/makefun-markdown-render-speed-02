// parse.js — a fast drop-in for marked 18.1.3 (default options: gfm on, breaks
// off, pedantic off, async off). parse(markdown) returns exactly the HTML
// marked.parse(markdown) returns. Written from scratch: block parser,
// delimiter-stack inline parser, CommonMark 0.31.2 + GFM 0.29 semantics as
// marked renders them (where marked departs from the spec, marked wins).

// ---------------- character helpers ----------------
const CC_SPACE = 32, CC_TAB = 9, CC_LF = 10, CC_CR = 13;
const CC_LT = 60, CC_GT = 62, CC_AMP = 38, CC_QUOT = 34, CC_SQ = 39;
const CC_BACKSLASH = 92, CC_TICK = 96, CC_STAR = 42, CC_US = 95, CC_TILDE = 126;
const CC_LBRK = 91, CC_RBRK = 93, CC_LPAREN = 40, CC_RPAREN = 41, CC_BANG = 33;
const CC_HASH = 35, CC_DASH = 45, CC_PLUS = 43, CC_DOT = 46, CC_SLASH = 47;
const CC_COLON = 58, CC_SEMI = 59, CC_EQ = 61, CC_PIPE = 124, CC_CARET = 94, CC_QUEST = 63;

function isSpace(c) { return c === CC_SPACE || c === CC_TAB || c === CC_LF || c === CC_CR; }
function isBlank(c) { return c === CC_SPACE || c === CC_TAB; }
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
// ASCII punctuation (CommonMark): ! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^ _ ` { | } ~
function isPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isWhitespace(c) {
  // Unicode whitespace for flanking rules (covers the cases the spec tests)
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 ||
    c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f ||
    c === 0x205f || c === 0x3000 || c === 0xfeff;
}
// Unicode punctuation for flanking: ASCII punctuation plus Unicode general
// categories P (punctuation) and S (symbol) — so £ and € count as punctuation.
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
function isUnicodePunct(c) {
  if (c < 128) return isPunct(c);
  return UNICODE_PUNCT_RE.test(String.fromCodePoint(c));
}

// ---------------- HTML escaping ----------------
// marked escapes & < > " ' in text. A & that begins a valid entity reference
// (&name; or &#...; / &#x...;) is left alone when named, and decoded when
// numeric (invalid code points become U+FFFD, then re-escaped if needed).
const ENTITY_RE = /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/y;

function decodeCodePoint(cp) {
  // out of range (> 0x10FFFF) is NOT an entity at all (callers leave the
  // &...; as literal text); 0 and surrogates decode to U+FFFD
  if (cp > 0x10ffff) return null;
  if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
  return String.fromCodePoint(cp);
}

// Escape a plain-text run (text content and attribute values alike: marked
// escapes " and ' everywhere, e.g. text " -> &quot;, ' -> &#39;).
function escText(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === CC_AMP) {
      ENTITY_RE.lastIndex = i;
      const m = ENTITY_RE.exec(s);
      if (m) {
        if (m[1] !== undefined || m[2] !== undefined) {
          const cp = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2], 16);
          const ch = decodeCodePoint(cp);
          if (ch === null) { out += '&amp;'; i++; continue; } // not an entity
          const cc = ch.charCodeAt(0);
          if (cc === CC_AMP) out += '&amp;';
          else if (cc === CC_LT) out += '&lt;';
          else if (cc === CC_GT) out += '&gt;';
          else if (cc === CC_QUOT) out += '&quot;';
          else if (cc === CC_SQ) out += '&#39;';
          else out += ch;
        } else {
          out += m[0]; // named entity, verbatim
        }
        i += m[0].length;
        continue;
      }
      out += '&amp;';
      i++;
    } else if (c === CC_LT) { out += '&lt;'; i++; }
    else if (c === CC_GT) { out += '&gt;'; i++; }
    else if (c === CC_QUOT) { out += '&quot;'; i++; }
    else if (c === CC_SQ) { out += '&#39;'; i++; }
    else {
      // fast path: copy a run with no special chars
      let j = i + 1;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (d === CC_AMP || d === CC_LT || d === CC_GT || d === CC_QUOT || d === CC_SQ) break;
        j++;
      }
      out += s.slice(i, j);
      i = j;
    }
  }
  return out;
}

// Escape code content (& < > " '), with NO entity recognition: in code,
// &ouml; is literal text and the & becomes &amp;.
function escCode(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === CC_AMP) { out += '&amp;'; i++; }
    else if (c === CC_LT) { out += '&lt;'; i++; }
    else if (c === CC_GT) { out += '&gt;'; i++; }
    else if (c === CC_QUOT) { out += '&quot;'; i++; }
    else if (c === CC_SQ) { out += '&#39;'; i++; }
    else {
      let j = i + 1;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (d === CC_AMP || d === CC_LT || d === CC_GT || d === CC_QUOT || d === CC_SQ) break;
        j++;
      }
      out += s.slice(i, j);
      i = j;
    }
  }
  return out;
}

// Decode entities in a link destination / title (numeric decoded, named kept),
// without HTML-escaping the result.
function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === CC_AMP) {
      ENTITY_RE.lastIndex = i;
      const m = ENTITY_RE.exec(s);
      if (m) {
        if (m[1] !== undefined || m[2] !== undefined) {
          const cp = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2], 16);
          const ch = decodeCodePoint(cp);
          if (ch === null) { out += '&'; i++; continue; } // not an entity
          out += ch;
        } else {
          out += m[0];
        }
        i += m[0].length;
        continue;
      }
      out += '&';
      i++;
    } else {
      let j = i + 1;
      while (j < n && s.charCodeAt(j) !== CC_AMP) j++;
      out += s.slice(i, j);
      i = j;
    }
  }
  return out;
}

// ---------------- URL handling ----------------
// marked's href pipeline: decode entities, encodeURI with %25 restored to %
// (so existing %XX sequences survive), then HTML-escape (which preserves
// valid entities and escapes a bare & to &amp;).
function encodeHref(raw) {
  let h = raw;
  try { h = encodeURI(h); } catch (e) { h = raw; }
  if (h.indexOf('%25') >= 0) h = h.replace(/%25/g, '%');
  return escText(h);
}
function cleanHref(dest) {
  return encodeHref(decodeEntities(dest));
}

// ---------------- link reference definitions ----------------
// refs: Map from normalized label -> {dest, title}
// Case folding for link labels: full Unicode case fold for the characters
// a plain lowercase misses (sharp S and ligatures), then lowercase.
const FOLD_MAP = { 'ẞ': 'ss', 'ß': 'ss', 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };
function normalizeLabel(label) {
  // case-fold and collapse whitespace; backslash escapes are NOT resolved:
  // the label foo\! does not match foo!
  let t = '';
  for (let i = 0; i < label.length; i++) {
    const ch = label[i];
    t += FOLD_MAP[ch] !== undefined ? FOLD_MAP[ch] : ch;
  }
  return t.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---------------- line helpers ----------------
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== CC_SPACE && c !== CC_TAB) return false;
  }
  return true;
}
function indentCols(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === CC_SPACE) col++;
    else if (c === CC_TAB) col += 4 - (col & 3);
    else break;
  }
  return col;
}
function firstNonBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== CC_SPACE && c !== CC_TAB) return i;
  }
  return s.length;
}
// Expand leading tabs in s to spaces, starting from column col (a tab's
// width depends on its absolute column, so tabs carried past a strip point
// must be expanded by their original column, not their new position).
// Only the leading whitespace run is expanded; a tab after content starts
// stays a literal tab.
function expandLeadingTabs(s, col) {
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === CC_SPACE) { col++; i++; }
    else if (c === CC_TAB) {
      const w = 4 - (col & 3);
      s = s.slice(0, i) + ' '.repeat(w) + s.slice(i + 1);
      col += w;
      i += w;
    } else break;
  }
  return s;
}

// Remove up to n columns of leading whitespace from a fenced-code content
// line (the opening fence's indent). A straddling tab leaves spaces; the
// remainder's tabs are kept literal (code content).
function stripFenceIndent(s, n) {
  let col = 0;
  let i = 0;
  while (i < s.length && col < n) {
    const c = s.charCodeAt(i);
    if (c === CC_SPACE) { col++; i++; }
    else if (c === CC_TAB) {
      const next = col + (4 - (col & 3));
      if (next <= n) { col = next; i++; }
      else return ' '.repeat(next - n) + s.slice(i + 1);
    } else break;
  }
  return s.slice(i);
}

// Remove n columns of indentation from the start of s (tab-aware; a tab
// straddling the boundary leaves spaces behind). Leading tabs in the
// remainder are expanded to spaces by their original column, so a later
// strip of the result measures them correctly.
function stripIndent(s, n) {
  let col = 0;
  let i = 0;
  while (i < s.length && col < n) {
    const c = s.charCodeAt(i);
    if (c === CC_SPACE) { col++; i++; }
    else if (c === CC_TAB) {
      const next = col + (4 - (col & 3));
      if (next <= n) { col = next; i++; }
      else return ' '.repeat(next - n) + expandLeadingTabs(s.slice(i + 1), next);
    } else { col++; i++; } // any other char counts as one column
  }
  return expandLeadingTabs(s.slice(i), col);
}

// ---------------- block start matchers ----------------
function matchFence(rest) {
  const c = rest.charCodeAt(0);
  if (c !== CC_TICK && c !== CC_TILDE) return null;
  let n = 0;
  while (n < rest.length && rest.charCodeAt(n) === c) n++;
  if (n < 3) return null;
  const info = rest.slice(n).trim();
  if (c === CC_TICK && info.indexOf('`') >= 0) return null;
  return { ch: c, len: n, info };
}
function isFenceClose(rest, ch, len) {
  if (rest.length === 0 || rest.charCodeAt(0) !== ch) return false;
  let n = 0;
  while (n < rest.length && rest.charCodeAt(n) === ch) n++;
  if (n < len) return false;
  for (let i = n; i < rest.length; i++) {
    const c = rest.charCodeAt(i);
    if (c !== CC_SPACE && c !== CC_TAB) return false;
  }
  return true;
}
function matchATX(rest) {
  if (rest.charCodeAt(0) !== CC_HASH) return null;
  let n = 0;
  while (n < rest.length && rest.charCodeAt(n) === CC_HASH) n++;
  if (n > 6) return null;
  if (n < rest.length) {
    const c = rest.charCodeAt(n);
    if (c !== CC_SPACE && c !== CC_TAB) return null;
  }
  let text = rest.slice(n).trimEnd();
  // strip a closing sequence of #'s preceded by space/tab (before
  // trimming the front, so a heading that is only a closing sequence empties)
  let e = text.length;
  while (e > 0 && text.charCodeAt(e - 1) === CC_HASH) e--;
  if (e < text.length && e > 0) {
    const c = text.charCodeAt(e - 1);
    if (c === CC_SPACE || c === CC_TAB) text = text.slice(0, e);
  }
  text = text.trim();
  return { level: n, text };
}
function matchHR(rest) {
  const c = rest.charCodeAt(0);
  if (c !== CC_STAR && c !== CC_DASH && c !== CC_US) return false;
  let n = 0;
  for (let i = 0; i < rest.length; i++) {
    const d = rest.charCodeAt(i);
    if (d === c) n++;
    else if (d !== CC_SPACE && d !== CC_TAB) return false;
  }
  return n >= 3;
}
// Setext underline level: 1 for ===, 2 for ---, 0 otherwise.
function matchSetext(rest) {
  if (rest.length === 0) return 0;
  const c = rest.charCodeAt(0);
  if (c !== CC_EQ && c !== CC_DASH) return 0;
  let i = 0;
  while (i < rest.length && rest.charCodeAt(i) === c) i++;
  while (i < rest.length && (rest.charCodeAt(i) === CC_SPACE || rest.charCodeAt(i) === CC_TAB)) i++;
  if (i !== rest.length) return 0;
  return c === CC_EQ ? 1 : 2;
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

// HTML block start: returns {type:1..7} or 0. Type 7 cannot interrupt a paragraph.
function matchHtmlStart(rest) {
  if (rest.charCodeAt(0) !== CC_LT) return 0;
  const s = rest;
  let i = 1;
  // type 1: <script, <pre, <style, <textarea (case-insensitive)
  const lower = s.slice(0, 10).toLowerCase();
  if (lower.startsWith('<script') && (lower.length === 7 || isHtmlNameEnd(lower.charCodeAt(7)))) return 1;
  if (lower.startsWith('<pre') && (lower.length === 4 || isHtmlNameEnd(lower.charCodeAt(4)))) return 1;
  if (lower.startsWith('<style') && (lower.length === 6 || isHtmlNameEnd(lower.charCodeAt(6)))) return 1;
  if (lower.startsWith('<textarea') && (lower.length === 9 || isHtmlNameEnd(lower.charCodeAt(9)))) return 1;
  if (s.startsWith('<!--')) return 2;
  if (s.startsWith('<?')) return 3;
  if (s.startsWith('<!') && s.length > 2 && isAlpha(s.charCodeAt(2))) return 4;
  if (s.startsWith('<![CDATA[')) return 5;
  // type 6/7: <tag or </tag, tag name then space/tab/EOL/> (or />)
  let j = i;
  if (s.charCodeAt(j) === CC_SLASH) j++;
  if (j >= s.length || !isAlpha(s.charCodeAt(j))) return 0;
  let k = j;
  while (k < s.length && (isAlnum(s.charCodeAt(k)) || s.charCodeAt(k) === CC_DASH)) k++;
  const name = s.slice(j, k).toLowerCase();
  if (k < s.length) {
    const c = s.charCodeAt(k);
    if (!(c === CC_SPACE || c === CC_TAB || c === CC_GT || c === CC_SLASH)) return 0;
  }
  if (BLOCK_TAGS.has(name)) return 6;
  // type 7: a complete tag alone on the line (only spaces/tabs after it)
  const te = tagEndOnLine(s);
  if (te < 0) return 0;
  let r = te;
  while (r < s.length && (s.charCodeAt(r) === CC_SPACE || s.charCodeAt(r) === CC_TAB)) r++;
  if (r !== s.length) return 0;
  return 7;
}

// Scan a complete HTML tag at the start of s (single line). Returns the index
// just past '>' or -1. Used for the type-7 "tag alone on the line" test.
function tagEndOnLine(s) {
  const n = s.length;
  let j = 1;
  if (s.charCodeAt(j) === CC_SLASH) j++;
  if (j >= n || !isAlpha(s.charCodeAt(j))) return -1;
  while (j < n && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === CC_DASH)) j++;
  let closing = s.charCodeAt(1) === CC_SLASH;
  while (j < n) {
    let ws = 0;
    while (j < n && (s.charCodeAt(j) === CC_SPACE || s.charCodeAt(j) === CC_TAB)) { j++; ws++; }
    if (j >= n) return -1;
    const c = s.charCodeAt(j);
    if (c === CC_GT) return j + 1;
    if (c === CC_SLASH) {
      if (closing) return -1;
      if (j + 1 < n && s.charCodeAt(j + 1) === CC_GT) return j + 2;
      return -1;
    }
    if (closing || ws === 0) return -1;
    if (!isAlpha(c) && c !== CC_US && c !== CC_COLON) return -1;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (isAlnum(d) || d === CC_US || d === CC_DASH || d === CC_DOT || d === CC_COLON) j++;
      else break;
    }
    while (j < n && (s.charCodeAt(j) === CC_SPACE || s.charCodeAt(j) === CC_TAB)) j++;
    if (j < n && s.charCodeAt(j) === CC_EQ) {
      j++;
      while (j < n && (s.charCodeAt(j) === CC_SPACE || s.charCodeAt(j) === CC_TAB)) j++;
      if (j >= n) return -1;
      const q = s.charCodeAt(j);
      if (q === CC_QUOT || q === CC_SQ) {
        j++;
        const e = s.indexOf(String.fromCharCode(q), j);
        if (e < 0) return -1;
        j = e + 1;
      } else {
        let started = false;
        while (j < n) {
          const d = s.charCodeAt(j);
          if (d === CC_SPACE || d === CC_TAB || d === CC_QUOT || d === CC_SQ || d === CC_EQ || d === CC_LT || d === CC_GT || d === CC_TICK) break;
          started = true;
          j++;
        }
        if (!started) return -1;
      }
    }
  }
  return -1;
}
function isHtmlNameEnd(c) {
  return c === CC_SPACE || c === CC_TAB || c === CC_GT || c === CC_SLASH || c === undefined || Number.isNaN(c);
}
// HTML block end test for types 1-5 (line contains the end marker).
function htmlBlockEnds(line, type) {
  const l = line.toLowerCase();
  if (type === 1) return l.indexOf('</script') >= 0 || l.indexOf('</pre') >= 0 || l.indexOf('</style') >= 0 || l.indexOf('</textarea') >= 0;
  if (type === 2) return l.indexOf('-->') >= 0;
  if (type === 3) return l.indexOf('?>') >= 0;
  if (type === 4) return l.indexOf('>') >= 0;
  if (type === 5) return l.indexOf(']]>') >= 0;
  return false;
}

// ---------------- link reference definitions ----------------
// Parse a definition starting at lines[i]. Returns {dest, title, next} or null.
function parseDef(lines, i, end) {
  const line = lines[i];
  const s0 = firstNonBlank(line);
  if (line.charCodeAt(s0) !== CC_LBRK) return null;
  // label: [ ... ] ends at the first unescaped ]; it may span lines. A
  // label may not contain an unescaped [. Escapes and code spans are
  // skipped; the raw label text is kept.
  let label = '';
  let cur = i;
  let pos = s0 + 1;
  let labelEnd = -1;
  while (cur < end) {
    const ln = lines[cur];
    let j = pos;
    let done = false;
    while (j < ln.length) {
      const c = ln.charCodeAt(j);
      if (c === CC_BACKSLASH && j + 1 < ln.length && isPunct(ln.charCodeAt(j + 1))) { label += ln.slice(j, j + 2); j += 2; continue; }
      if (c === CC_TICK) {
        let r = 0;
        while (j + r < ln.length && ln.charCodeAt(j + r) === CC_TICK) r++;
        let k = j + r;
        let found = -1;
        while (k < ln.length) {
          if (ln.charCodeAt(k) === CC_TICK) {
            let r2 = 0;
            while (k + r2 < ln.length && ln.charCodeAt(k + r2) === CC_TICK) r2++;
            if (r2 === r) { found = k; break; }
            k += r2;
          } else k++;
        }
        if (found < 0) { label += ln.slice(j, j + r); j += r; continue; }
        label += ln.slice(j, found + r);
        j = found + r;
        continue;
      }
      if (c === CC_LBRK) return null; // [ may not appear in a label
      if (c === CC_RBRK) { labelEnd = j + 1; done = true; break; }
      label += ln[j];
      j++;
    }
    if (done) break;
    cur++;
    if (cur >= end || isBlankLine(lines[cur])) return null;
    label += '\n';
    pos = 0;
  }
  if (labelEnd < 0) return null;
  if (label.length === 0) return null;
  // the : must follow the ] on the same line
  if (labelEnd >= lines[cur].length || lines[cur].charCodeAt(labelEnd) !== CC_COLON) return null;
  let j = labelEnd + 1;
  // skip spaces/tabs; dest may be on this line or the next
  let rest = lines[cur].slice(j);
  let k = 0;
  while (k < rest.length && (rest.charCodeAt(k) === CC_SPACE || rest.charCodeAt(k) === CC_TAB)) k++;
  if (k >= rest.length) {
    cur++;
    if (cur >= end || isBlankLine(lines[cur])) return null;
    rest = lines[cur];
    k = firstNonBlank(rest);
  }
  // destination: <...> or bare
  let dest = '';
  if (rest.charCodeAt(k) === CC_LT) {
    let m = k + 1;
    let ok = false;
    while (m < rest.length) {
      const c = rest.charCodeAt(m);
      if (c === CC_LT || c === CC_LF) break;
      if (c === CC_BACKSLASH && m + 1 < rest.length && isPunct(rest.charCodeAt(m + 1))) { dest += rest[m + 1]; m += 2; continue; }
      if (c === CC_GT) { ok = true; break; }
      dest += rest[m];
      m++;
    }
    if (!ok) return null;
    k = m + 1;
  } else {
    // bare destination: no spaces/control, balanced parens, backslash escapes
    let m = k;
    let paren = 0;
    let got = false;
    while (m < rest.length) {
      const c = rest.charCodeAt(m);
      if (c === CC_SPACE || c === CC_TAB || c < 32) break;
      if (c === CC_BACKSLASH && m + 1 < rest.length && isPunct(rest.charCodeAt(m + 1))) { dest += rest[m + 1]; m += 2; got = true; continue; }
      if (c === CC_LPAREN) paren++;
      else if (c === CC_RPAREN) { if (paren === 0) break; paren--; }
      dest += rest[m];
      m++;
      got = true;
    }
    if (!got || paren !== 0) return null;
    k = m;
  }
  // skip spaces/tabs; a title may follow on this line, the next line, or
  // span several lines. It must be separated from the destination by
  // whitespace.
  let title = null;
  let tline = rest;
  let tk = k;
  while (tk < tline.length && (tline.charCodeAt(tk) === CC_SPACE || tline.charCodeAt(tk) === CC_TAB)) tk++;
  if (tk >= tline.length) {
    // title may start on the next line; if that line is not a title, the
    // definition is still valid without one (and the line is not consumed)
    if (cur + 1 < end && !isBlankLine(lines[cur + 1])) {
      const nl = lines[cur + 1];
      const nk = firstNonBlank(nl);
      if (nk < nl.length) {
        const c = nl.charCodeAt(nk);
        if (c === CC_QUOT || c === CC_SQ || c === CC_LPAREN) {
          const mt = parseTitleMulti(lines, cur + 1, end, nk);
          if (mt) { title = mt.title; cur = mt.endLine; }
        }
      }
    }
    return { label, dest, title, next: cur + 1 };
  }
  // content on the same line after the dest: it must be a whitespace-
  // separated title, else the definition is invalid
  if (tk === k) return null; // no space after the dest
  const qc = tline.charCodeAt(tk);
  if (qc !== CC_QUOT && qc !== CC_SQ && qc !== CC_LPAREN) return null;
  // tk indexes into rest (the slice after ':'); the title starts at j+tk
  // in the full line
  const mt = parseTitleMulti(lines, cur, end, j + tk);
  if (!mt) return null;
  title = mt.title;
  cur = mt.endLine;
  return { label, dest, title, next: cur + 1 };
}
// Parse a link title starting at lines[line][pos] (opening " or ' or (), the
// title may span several lines. Returns {title, endLine} (endLine is the
// line holding the closing delimiter) or null. The title must be alone on
// its closing line (only whitespace after the delimiter).
function parseTitleMulti(lines, line, end, pos) {
  const first = lines[line];
  const q = first.charCodeAt(pos);
  let title = '';
  let cur = line;
  let j = pos + 1;
  let depth = 0;
  while (cur < end) {
    const s = lines[cur];
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === CC_BACKSLASH && j + 1 < s.length && isPunct(s.charCodeAt(j + 1))) { title += s[j + 1]; j += 2; continue; }
      if (q === CC_LPAREN && c === CC_LPAREN) { depth++; title += s[j]; j++; continue; }
      if (q === CC_LPAREN && c === CC_RPAREN) {
        if (depth === 0) {
          let e = j + 1;
          while (e < s.length && (s.charCodeAt(e) === CC_SPACE || s.charCodeAt(e) === CC_TAB)) e++;
          if (e < s.length) return null;
          return { title, endLine: cur };
        }
        depth--;
        title += s[j];
        j++;
        continue;
      }
      if ((q === CC_QUOT || q === CC_SQ) && c === q) {
        let e = j + 1;
        while (e < s.length && (s.charCodeAt(e) === CC_SPACE || s.charCodeAt(e) === CC_TAB)) e++;
        if (e < s.length) return null;
        return { title, endLine: cur };
      }
      title += s[j];
      j++;
    }
    // end of line without closing: continue on the next line
    cur++;
    if (cur >= end || isBlankLine(lines[cur])) return null;
    title += '\n';
    j = 0;
  }
  return null;
}
// Parse a link title at s[pos]: "..." | '...' | (...). Returns {title, end} or null.
// Title content may not contain the closing delimiter (no backslash escapes).
function parseTitle(s, pos) {
  const q = s.charCodeAt(pos);
  if (q === CC_QUOT || q === CC_SQ) {
    let j = pos + 1;
    let title = '';
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === CC_BACKSLASH && j + 1 < s.length && isPunct(s.charCodeAt(j + 1))) { title += s[j + 1]; j += 2; continue; }
      if (c === q) return { title, end: j + 1 };
      title += s[j];
      j++;
    }
    return null;
  }
  if (q === CC_LPAREN) {
    let j = pos + 1;
    let title = '';
    let depth = 0;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === CC_BACKSLASH && j + 1 < s.length && isPunct(s.charCodeAt(j + 1))) { title += s[j + 1]; j += 2; continue; }
      if (c === CC_LPAREN) { depth++; title += s[j]; j++; continue; }
      if (c === CC_RPAREN) {
        if (depth === 0) return { title, end: j + 1 };
        depth--;
        title += s[j];
        j++;
        continue;
      }
      title += s[j];
      j++;
    }
    return null;
  }
  return null;
}

// ---------------- tables ----------------
// Split a table line into cells (split on unescaped |; \| becomes a literal |).
function splitTableCells(line) {
  let s = line;
  // trim leading/trailing whitespace
  let a = 0, b = s.length;
  while (a < b && (s.charCodeAt(a) === CC_SPACE || s.charCodeAt(a) === CC_TAB)) a++;
  while (b > a && (s.charCodeAt(b - 1) === CC_SPACE || s.charCodeAt(b - 1) === CC_TAB)) b--;
  s = s.slice(a, b);
  if (s.charCodeAt(0) === CC_PIPE) s = s.slice(1);
  if (s.length > 0 && s.charCodeAt(s.length - 1) === CC_PIPE) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === CC_BACKSLASH && i + 1 < s.length && s.charCodeAt(i + 1) === CC_PIPE) { cur += '|'; i++; continue; }
    if (c === CC_PIPE) { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}
// Pad a body row with empty cells / truncate extras to the header width.
function padRow(cells, n) {
  while (cells.length < n) cells.push('');
  if (cells.length > n) cells.length = n;
  return cells;
}
// Delimiter row: returns align array ('' | 'left' | 'right' | 'center') or null.
function parseDelimiter(line) {
  const cells = splitTableCells(line);
  if (cells.length === 0) return null;
  const align = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    if (cell.charCodeAt(0) === CC_COLON && cell.charCodeAt(cell.length - 1) === CC_COLON) align.push('center');
    else if (cell.charCodeAt(0) === CC_COLON) align.push('left');
    else if (cell.charCodeAt(cell.length - 1) === CC_COLON) align.push('right');
    else align.push('');
  }
  return align;
}

// ---------------- list markers ----------------
// Returns null or {ordered, bullet, num, delim, markerCols, contentCols, contentIdx}
// contentIdx: index in the line where the item content starts (-1 if none on this line).
function matchListMarker(line) {
  const ind = indentCols(line);
  if (ind > 3) return null;
  const s = firstNonBlank(line);
  const c = line.charCodeAt(s);
  let ordered = false, num = 0, delim = '', markerCols = 0;
  if (c === CC_DASH || c === CC_PLUS || c === CC_STAR) {
    markerCols = 1;
  } else if (isDigit(c)) {
    let j = s;
    let n = 0;
    let digits = 0;
    while (j < line.length && isDigit(line.charCodeAt(j)) && digits < 9) { n = n * 10 + (line.charCodeAt(j) - 48); j++; digits++; }
    if (j >= line.length) return null;
    const d = line.charCodeAt(j);
    if (d !== CC_DOT && d !== CC_RPAREN) return null;
    if (j === s) return null;
    ordered = true; num = n; delim = String.fromCharCode(d);
    markerCols = (j - s) + 1;
  } else return null;
  // after the marker: space/tab/EOL required
  let k = s + markerCols;
  if (k < line.length) {
    const d = line.charCodeAt(k);
    if (d !== CC_SPACE && d !== CC_TAB) return null;
  }
  // measure the space run in columns
  const startCol = ind + markerCols;
  let col = startCol;
  let m = k;
  while (m < line.length) {
    const d = line.charCodeAt(m);
    if (d === CC_SPACE) { col++; m++; }
    else if (d === CC_TAB) { col += 4 - (col & 3); m++; }
    else break;
  }
  if (m >= line.length) {
    // empty item: content indent is marker + 1
    return { ordered, bullet: ordered ? null : String.fromCharCode(c), num, delim, markerCols, contentCols: startCol + 1, contentIdx: -1 };
  }
  const gap = col - startCol;
  if (gap >= 1 && gap <= 4) {
    return { ordered, bullet: ordered ? null : String.fromCharCode(c), num, delim, markerCols, contentCols: col, contentIdx: m };
  }
  // gap >= 5: content indent is marker + 1; content starts after that
  return { ordered, bullet: ordered ? null : String.fromCharCode(c), num, delim, markerCols, contentCols: startCol + 1, contentIdx: m };
}

// Can this line interrupt a paragraph? (ATX, fence, hr, blockquote, list,
// HTML block types 1-6; NOT indented code, NOT setext, NOT def, NOT table.)
function interruptsParagraph(line, inList) {
  const ind = indentCols(line);
  if (ind > 3) return false;
  const rest = line.slice(firstNonBlank(line));
  if (rest.length === 0) return false;
  if (matchFence(rest)) return true;
  if (matchATX(rest)) return true;
  if (matchHR(rest)) return true;
  if (rest.charCodeAt(0) === CC_GT) return true;
  const html = matchHtmlStart(rest);
  if (html >= 1 && html <= 6) return true;
  const lm = matchListMarker(line);
  if (lm) {
    if (!lm.ordered) return lm.contentIdx >= 0; // empty bullet item cannot interrupt
    // inside a list item any ordered marker interrupts; elsewhere only 1
    return inList ? lm.contentIdx >= 0 : (lm.num === 1 && lm.contentIdx >= 0);
  }
  return false;
}
// Is this line a block start (for lazy-continuation exclusion)?
function isBlockStart(line) {
  const ind = indentCols(line);
  if (ind > 3) return false;
  const rest = line.slice(firstNonBlank(line));
  if (rest.length === 0) return false;
  if (matchSetext(rest)) return true;
  return interruptsParagraph(line);
}

// True if the parsed blocks end in an open paragraph (which accepts lazy
// continuation lines), descending into the last list item / blockquote.
function endsWithOpenParagraph(blocks) {
  if (blocks.length === 0) return false;
  const last = blocks[blocks.length - 1];
  if (last.t === 'para') return true;
  if (last.t === 'list' && last.items.length > 0) {
    return endsWithOpenParagraph(last.items[last.items.length - 1].children);
  }
  if (last.t === 'quote') return endsWithOpenParagraph(last.children);
  return false;
}

// ---------------- blockquote / list collection ----------------
// Collect the lines belonging to a blockquote starting at lines[i].
// Returns {inner, innerLazy, innerHasNL, next} where inner[k] is the quote's
// k-th line with its marker stripped, innerLazy[k] flags lazy continuations.
// A blank line with no > marker ends the quote; a line with no marker is a
// lazy continuation only when the inner content so far ends in an open
// paragraph (code blocks and fences take no lazy lines). A lazy line indented
// by 4+ columns loses one indent level.
function collectQuote(lines, i, end, lazy, hasNL, refs) {
  const inner = [], innerLazy = [], innerHasNL = [];
  let j = i;
  while (j < end) {
    const line = lines[j];
    if (!isBlankLine(line) && indentCols(line) <= 3) {
      const s = firstNonBlank(line);
      if (line.charCodeAt(s) === CC_GT) {
        const gtCol = indentCols(line);
        let k = s + 1;
        if (k < line.length && line.charCodeAt(k) === CC_SPACE) {
          k++;
          inner.push(expandLeadingTabs(line.slice(k), gtCol + 2));
        } else if (k < line.length && line.charCodeAt(k) === CC_TAB) {
          // a tab after > is the optional space: consume one column of it,
          // keep the remainder as spaces
          const w = 4 - ((gtCol + 1) & 3);
          inner.push(' '.repeat(w - 1) + expandLeadingTabs(line.slice(k + 1), gtCol + 1 + w));
        } else {
          inner.push(expandLeadingTabs(line.slice(k), gtCol + 1));
        }
        innerLazy.push(false);
        innerHasNL.push(hasNL[j]);
        j++;
        continue;
      }
    }
    if (isBlankLine(line)) break;
    // a level-1 setext underline (===) as a lazy line is literal paragraph
    // text, not a heading: it is kept with a 4-space prefix so the
    // paragraph pass does not read it as a setext underline
    if (matchSetext(line.slice(firstNonBlank(line))) === 1) {
      const innerParsed = parseBlocks(inner, 0, inner.length, innerLazy, innerHasNL, refs);
      if (endsWithOpenParagraph(innerParsed.blocks)) {
        inner.push('    ' + line);
        innerLazy.push(true);
        innerHasNL.push(hasNL[j]);
        j++;
        continue;
      }
      break;
    }
    if (isBlockStart(line)) break;
    // lazy continuation: only into an open paragraph
    const innerParsed = parseBlocks(inner, 0, inner.length, innerLazy, innerHasNL, refs);
    if (!endsWithOpenParagraph(innerParsed.blocks)) break;
    const ind = indentCols(line);
    inner.push(ind >= 4 ? stripIndent(line, 4) : line);
    innerLazy.push(true);
    innerHasNL.push(hasNL[j]);
    j++;
  }
  // the blockquote's inner text carries no trailing newline on its last line
  if (innerHasNL.length > 0) innerHasNL[innerHasNL.length - 1] = false;
  return { inner, innerLazy, innerHasNL, next: j };
}

// Parse a list starting at lines[i]. Returns {node, next}.
function parseList(lines, i, end, lazy, hasNL, refs) {
  const first = matchListMarker(lines[i]);
  const ordered = first.ordered;
  const bullet = first.bullet;
  const delim = first.delim;
  const startNum = first.num;
  const items = [];
  let j = i;
  // A list is loose if any item holds a blank line between blocks, or two
  // items are separated by a blank line.
  let loose = false;
  while (j < end) {
    const line = lines[j];
    if (isBlankLine(line)) {
      // blank line between items: the list stays open; a following marker is
      // the next item, anything else ends the list
      let m = j;
      while (m < end && isBlankLine(lines[m])) m++;
      if (m >= end) { j = m; break; }
      const lm0 = indentCols(lines[m]) <= 3 ? matchListMarker(lines[m]) : null;
      if (!lm0 || lm0.ordered !== ordered || (ordered ? lm0.delim !== delim : lm0.bullet !== bullet)) {
        // list ends here: leave the blank line(s) for the parent to see
        break;
      }
      loose = true;
      j = m;
      continue;
    }
    const lm = indentCols(line) <= 3 ? matchListMarker(line) : null;
    if (!lm) break;
    // a thematic break line (e.g. * * *) ends the list; it is not an item
    if (matchHR(line.slice(firstNonBlank(line)))) break;
    if (lm.ordered !== ordered) break;
    if (ordered ? lm.delim !== delim : lm.bullet !== bullet) break;
    // collect this item's lines
    const itemLines = [], itemLazy = [], itemHasNL = [];
    const contentCols = lm.contentCols;
    if (lm.contentIdx >= 0) {
      // The marker line's content: everything from the content column on.
      itemLines.push(stripIndent(line, contentCols));
      itemLazy.push(false);
      itemHasNL.push(hasNL[j]);
    } else if (j + 1 < end && isBlankLine(lines[j + 1])) {
      // an empty item followed by a blank line is empty: it takes no lines
      const parsed = parseBlocks([], 0, 0, [], [], refs);
      items.push({ children: parsed.blocks, trailingBlank: true, lines: [] });
      j = j + 1;
      continue;
    }
    let k = j + 1;
    let prevBlank = false;
    let trailingBlank = false;
    while (k < end) {
      const l2 = lines[k];
      if (isBlankLine(l2)) {
        // peek ahead: does this item continue after the blank(s)?
        let m = k;
        while (m < end && isBlankLine(lines[m])) m++;
        let continues = false;
        if (m < end) {
          const l3 = lines[m];
          const ind3 = indentCols(l3);
          if (ind3 >= contentCols) continues = true;
          else {
            const lm3 = ind3 <= 3 ? matchListMarker(l3) : null;
            if (lm3 && lm3.ordered === ordered && (ordered ? lm3.delim === delim : lm3.bullet === bullet)) continues = true;
          }
        }
        if (!continues) {
          // trailing blank(s): leave them for the parent to see as a
          // separator between this list and what follows
          trailingBlank = true;
          break;
        }
        while (k < m) {
          itemLines.push('');
          itemLazy.push(false);
          itemHasNL.push(hasNL[k]);
          k++;
        }
        prevBlank = true;
        trailingBlank = true;
        continue;
      }
      const ind2 = indentCols(l2);
      if (ind2 >= contentCols) {
        itemLines.push(stripIndent(l2, contentCols));
        itemLazy.push(false);
        itemHasNL.push(hasNL[k]);
        prevBlank = false;
        trailingBlank = false;
        k++;
        continue;
      }
      // a list marker at the list level ends this item (any marker: a
      // different delimiter or bullet starts a new list, not a lazy line)
      const lm2 = ind2 <= 3 ? matchListMarker(l2) : null;
      if (lm2) break;
      if (prevBlank) break;
      if (isBlockStart(l2)) break;
      // lazy continuation line; indented by 4+ columns it loses one
      // indent level, like a blockquote lazy line
      itemLines.push(ind2 >= 4 ? stripIndent(l2, 4) : l2);
      itemLazy.push(true);
      itemHasNL.push(hasNL[k]);
      prevBlank = false;
      trailingBlank = false;
      k++;
    }
    // looseness: the item directly contains two blocks separated by a
    // blank line (blank lines inside a nested list, quote, or fence do
    // not make this list loose)
    // the item's inner text carries no trailing newline on its last line
    if (itemHasNL.length > 0) itemHasNL[itemHasNL.length - 1] = false;
    const parsed = parseBlocks(itemLines, 0, itemLines.length, itemLazy, itemHasNL, refs, true);
    if (parsed.blankGap) loose = true;
    items.push({ children: parsed.blocks, trailingBlank, lines: itemLines });
    j = k;
    // if this item ended with a blank line and another item follows, loose
    if (trailingBlank) {
      // peek: is there another item marker next (skipping blanks is wrong:
      // the blanks are already consumed into this item; the next line, if a
      // marker, means items are blank-separated)
      if (j < end && !isBlankLine(lines[j])) {
        const lm3 = indentCols(lines[j]) <= 3 ? matchListMarker(lines[j]) : null;
        if (lm3 && lm3.ordered === ordered && (ordered ? lm3.delim === delim : lm3.bullet === bullet)) loose = true;
      }
    }
  }
  return { node: { t: 'list', ordered, start: startNum, tight: !loose, items }, next: j };
}

// ---------------- the block parser ----------------
// For table body rows: a whitespace-only line ending in a tab whose
// expanded width is exactly 4 is a row of empty cells, not a table end.
// (A spaces-only line, or a tab line landing elsewhere, ends the table.)
function isTableBlank(line) {
  if (line.length === 0) return true;
  let col = 0;
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c === CC_SPACE) { col++; continue; }
    if (c === CC_TAB) { col += 4 - (col % 4); continue; }
    return false; // has non-whitespace: not blank
  }
  return !(line.charCodeAt(line.length - 1) === CC_TAB && col === 4);
}

function parseBlocks(lines, start, end, lazy, hasNL, refs, inList) {
  const blocks = [];
  let i = start;
  // blankGap: true when two consecutive direct-child blocks are separated
  // by a blank line (this is what makes a list item "loose")
  let pendingBlank = false;
  let blankGap = false;
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) { pendingBlank = true; i++; continue; }
    if (lazy && lazy[i]) break; // lazy line with no open paragraph: stop here
    if (pendingBlank && blocks.length > 0) blankGap = true;
    pendingBlank = false;
    const ind = indentCols(line);
    const s = firstNonBlank(line);
    const rest = line.slice(s);
    // fenced code
    if (ind <= 3) {
      const fence = matchFence(rest);
      if (fence) {
        let j = i + 1;
        const contentLines = [];
        while (j < end) {
          const l2 = lines[j];
          if (!isBlankLine(l2) && indentCols(l2) <= 3 && isFenceClose(l2.slice(firstNonBlank(l2)), fence.ch, fence.len)) break;
          // up to the opening fence's indent is stripped from each line,
          // but only for backtick fences: marked keeps a tilde fence's
          // content indentation verbatim (doc-22)
          contentLines.push(fence.ch === CC_TICK ? stripFenceIndent(l2, ind) : l2);
          j++;
        }
        // a trailing blank line before the closing fence is dropped
        if (contentLines.length > 0 && contentLines[contentLines.length - 1] === '') contentLines.pop();
        const content = contentLines.length > 0 ? contentLines.join('\n') + '\n' : '';
        // the language is the info string's first word, backslash escapes
        // resolved (foo\+bar -> foo+bar)
        const lang = fence.info.length === 0 ? '' : fence.info.split(/\s+/)[0].replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1');
        blocks.push({ t: 'fence', lang, text: content });
        i = j < end ? j + 1 : j;
        continue;
      }
    }
    // ATX heading
    if (ind <= 3) {
      const atx = matchATX(rest);
      if (atx) { blocks.push({ t: 'h', level: atx.level, text: atx.text }); i++; continue; }
    }
    // thematic break
    if (ind <= 3 && matchHR(rest)) { blocks.push({ t: 'hr' }); i++; continue; }
    // blockquote
    if (ind <= 3 && rest.charCodeAt(0) === CC_GT) {
      const q = collectQuote(lines, i, end, lazy, hasNL, refs);
      const inner = parseBlocks(q.inner, 0, q.inner.length, q.innerLazy, q.innerHasNL, refs);
      blocks.push({ t: 'quote', children: inner.blocks });
      i = i + inner.next;
      continue;
    }
    // list
    if (ind <= 3 && matchListMarker(line)) {
      const res = parseList(lines, i, end, lazy, hasNL, refs);
      blocks.push(res.node);
      i = res.next;
      continue;
    }
    // HTML block (types 1-7; type 7 cannot interrupt a paragraph, but here
    // we are at a block boundary so all types may start one)
    if (ind <= 3) {
      const ht = matchHtmlStart(rest);
      if (ht >= 1) {
        let j = i;
        let text = '';
        if (ht <= 5) {
          while (j < end) {
            text += lines[j] + '\n';
            if (htmlBlockEnds(lines[j], ht)) { j++; break; }
            j++;
          }
        } else {
          while (j < end && !isBlankLine(lines[j])) { text += lines[j] + '\n'; j++; }
        }
        // the last line keeps its newline unless the source had none.
        // Types 6-7 (block tags / complete open tags) also drop it when
        // the block ends at a blank line (even a whitespace-only one,
        // doc-03); types 1-5 drop it only at a truly empty next line
        // (a whitespace-only next line keeps the newline, doc-15).
        const dropNL = !hasNL[j - 1] || (j < end && (lines[j].length === 0 || (ht >= 6 && isBlankLine(lines[j]))));
        if (j > i && text.endsWith('\n') && dropNL) text = text.slice(0, -1);
        blocks.push({ t: 'html', text });
        i = j;
        continue;
      }
    }
    // indented code
    if (ind >= 4) {
      let j = i;
      const contentLines = [];
      while (j < end) {
        const l2 = lines[j];
        if (isBlankLine(l2)) { contentLines.push(stripFenceIndent(l2, 4)); j++; continue; }
        if (indentCols(l2) < 4) break;
        contentLines.push(stripFenceIndent(l2, 4));
        j++;
      }
      while (contentLines.length > 0 && isBlankLine(contentLines[contentLines.length - 1])) contentLines.pop();
      blocks.push({ t: 'code', text: contentLines.map(l => l + '\n').join('') });
      i = j;
      continue;
    }
    // link reference definition (an empty normalized label is not a def)
    const def = parseDef(lines, i, end);
    if (def) {
      const key = normalizeLabel(def.label);
      if (key.length > 0) {
        if (!refs.has(key)) refs.set(key, { dest: def.dest, title: def.title });
        i = def.next;
        continue;
      }
    }
    // table (header line + delimiter line). A delimiter line that is also a
    // setext underline makes a heading, not a table.
    if (i + 1 < end) {
      const align = parseDelimiter(lines[i + 1]);
      if (align && !matchSetext(lines[i + 1].slice(firstNonBlank(lines[i + 1])))) {
        const headerCells = splitTableCells(line);
        if (headerCells.length === align.length) {
          const rows = [];
          let j = i + 2;
          while (j < end) {
            const l2 = lines[j];
            if (isTableBlank(l2)) break;
            if (lazy && lazy[j]) break;
            // a === line is a table row (a single cell), not a setext
            // underline; --- still ends the table via interruptsParagraph
            // (it is an HR)
            if (interruptsParagraph(l2, inList)) break;
            rows.push(padRow(splitTableCells(l2), align.length));
            j++;
          }
          blocks.push({ t: 'table', align, header: headerCells, rows });
          i = j;
          continue;
        }
      }
    }
    // paragraph (with setext-heading and table-split handling)
    const paraLines = [];
    let p = i;
    let setextLevel = 0;
    let tableSplit = null;
    while (p < end) {
      const l2 = lines[p];
      // a whitespace-only last line with no trailing newline is paragraph
      // text (it continues the paragraph to EOF), not a blank line; a
      // truly empty line still ends the paragraph
      if (isBlankLine(l2) && !(l2.length > 0 && p === end - 1 && !hasNL[p] && paraLines.length > 0)) break;
      if (lazy && lazy[p] && paraLines.length === 0) break;
      const ind2 = indentCols(l2);
      const rest2 = l2.slice(firstNonBlank(l2));
      // a lazy continuation line is paragraph text: it never starts a
      // setext heading, a table, or an interrupting block
      if (paraLines.length > 0 && ind2 <= 3 && !(lazy && lazy[p])) {
        const sx = matchSetext(rest2);
        if (sx) { setextLevel = sx; p++; break; }
        if (l2.indexOf('-') >= 0) {
          const al = parseDelimiter(l2);
          if (al) {
            const headerCells = splitTableCells(paraLines[paraLines.length - 1]);
            if (headerCells.length === al.length) {
              tableSplit = { align: al, header: headerCells, delimIdx: p };
              break;
            }
          }
        }
        if (interruptsParagraph(l2, inList)) break;
      }
      paraLines.push(l2);
      p++;
    }
    if (tableSplit) {
      paraLines.pop();
      if (paraLines.length > 0) blocks.push({ t: 'para', text: paraLines.join('\n') });
      const rows = [];
      let j = tableSplit.delimIdx + 1;
      while (j < end) {
        const l2 = lines[j];
        if (isTableBlank(l2)) break;
        if (lazy && lazy[j]) break;
        // a === line is a table row, not a setext underline; --- still
        // ends the table via interruptsParagraph (it is an HR)
        if (interruptsParagraph(l2, inList)) break;
        rows.push(padRow(splitTableCells(l2), tableSplit.align.length));
        j++;
      }
      blocks.push({ t: 'table', align: tableSplit.align, header: tableSplit.header, rows });
      i = j;
      continue;
    }
    if (setextLevel) {
      // a setext heading's content is the paragraph text with leading and
      // trailing spaces/tabs stripped
      blocks.push({ t: 'h', level: setextLevel, text: paraLines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') });
      i = p;
      continue;
    }
    if (paraLines.length > 0) {
      blocks.push({ t: 'para', text: paraLines.join('\n') });
      i = p;
      continue;
    }
    i++; // unreachable in practice; guard against stalling
  }
  return { blocks, next: i, blankGap };
}

// ---------------- inline parsing ----------------
// Node kinds: t (text; e=true means already escaped), d (delimiter run),
// code, br, link, img, html, em, strong, del.

// Escape a single literal character (from an entity decode or backslash escape).
function escSingle(ch) {
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '"') return '&quot;';
  if (ch === "'") return '&#39;';
  return ch;
}

function processCodeSpan(content) {
  let s = '';
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (c === CC_CR) { if (content.charCodeAt(i + 1) === CC_LF) i++; s += ' '; }
    else if (c === CC_LF) s += ' ';
    else s += content[i];
  }
  if (s.length >= 2 && s.charCodeAt(0) === CC_SPACE && s.charCodeAt(s.length - 1) === CC_SPACE) {
    let hasNonSpace = false;
    for (let i = 1; i < s.length - 1; i++) if (s.charCodeAt(i) !== CC_SPACE) { hasNonSpace = true; break; }
    if (hasNonSpace) s = s.slice(1, -1);
  }
  return s;
}

// Flanking for a delimiter run at [i, i+n) in s.
function flanking(s, i, n) {
  const beforeWS = i === 0 || isWhitespace(s.charCodeAt(i - 1));
  const beforePunct = i > 0 && isUnicodePunct(s.charCodeAt(i - 1));
  const afterWS = i + n >= s.length || isWhitespace(s.charCodeAt(i + n));
  const afterPunct = i + n < s.length && isUnicodePunct(s.charCodeAt(i + n));
  const left = !afterWS && (!afterPunct || beforeWS || beforePunct);
  const right = !beforeWS && (!beforePunct || afterWS || afterPunct);
  return { left, right };
}

// Scan for the matching ] of a link starting at s[i] === '['.
// Skips code spans and backslash escapes. Returns the index of ] or -1.
function findLinkClose(s, i) {
  const n = s.length;
  let depth = 1;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === CC_BACKSLASH && j + 1 < n && isPunct(s.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === CC_TICK) {
      let r = 0;
      while (j + r < n && s.charCodeAt(j + r) === CC_TICK) r++;
      let k = j + r;
      let found = -1;
      while (k < n) {
        if (s.charCodeAt(k) === CC_TICK) {
          let r2 = 0;
          while (k + r2 < n && s.charCodeAt(k + r2) === CC_TICK) r2++;
          if (r2 === r) { found = k; break; }
          k += r2;
        } else k++;
      }
      if (found < 0) { j += r; continue; } // unclosed: backticks are literal
      j = found + r;
      continue;
    }
    if (c === CC_LBRK) depth++;
    else if (c === CC_RBRK) { depth--; if (depth === 0) return j; }
    else if (c === CC_LT) {
      // a < that starts a complete HTML tag or autolink is skipped as a
      // unit; a ] inside it does not close the label. A < that starts no
      // valid tag is literal text and the scan continues.
      const nc = j + 1 < n ? s.charCodeAt(j + 1) : 0;
      const startsTag = isAlpha(nc) || nc === CC_BANG || nc === CC_QUEST ||
        (nc === CC_SLASH && j + 2 < n && isAlpha(s.charCodeAt(j + 2)));
      if (startsTag) {
        const al = tryAutolink(s, j);
        if (al) { j = al.end; continue; }
        const tag = tryHtmlTag(s, j);
        if (tag) { j = tag.end; continue; }
      }
    }
    j++;
  }
  return -1;
}

// Scan for a link label's closing ] starting at s[i] === '['. A label
// ends at the FIRST unescaped ] and may not contain an unescaped [ (even a
// balanced one: ref[bar] is not a valid label). Backslash escapes and code
// spans are skipped. Returns {label, end} (the raw label text between the
// brackets, end just past ]) or null.
function findLabelCloseStr(s, i) {
  const n = s.length;
  let label = '';
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === CC_BACKSLASH && j + 1 < n && isPunct(s.charCodeAt(j + 1))) { label += s.slice(j, j + 2); j += 2; continue; }
    if (c === CC_TICK) {
      let r = 0;
      while (j + r < n && s.charCodeAt(j + r) === CC_TICK) r++;
      let k = j + r;
      let found = -1;
      while (k < n) {
        if (s.charCodeAt(k) === CC_TICK) {
          let r2 = 0;
          while (k + r2 < n && s.charCodeAt(k + r2) === CC_TICK) r2++;
          if (r2 === r) { found = k; break; }
          k += r2;
        } else k++;
      }
      if (found < 0) { label += s.slice(j, j + r); j += r; continue; }
      label += s.slice(j, found + r);
      j = found + r;
      continue;
    }
    if (c === CC_LBRK) return null; // [ may not appear in a label
    if (c === CC_RBRK) return { label, end: j + 1 };
    label += s[j];
    j++;
  }
  return null;
}
// Returns {dest, title, end} or null. end is just past ')'.
function parseInlineLink(s, k) {
  const n = s.length;
  let i = k + 1;
  while (i < n && isSpace(s.charCodeAt(i))) i++;
  if (i >= n) return null;
  let dest = '';
  if (s.charCodeAt(i) === CC_LT) {
    let j = i + 1;
    let ok = false;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === CC_LT || c === CC_LF || c === CC_CR) break;
      if (c === CC_BACKSLASH && j + 1 < n && isPunct(s.charCodeAt(j + 1))) { dest += s[j + 1]; j += 2; continue; }
      if (c === CC_GT) { ok = true; break; }
      dest += s[j];
      j++;
    }
    if (!ok) return null;
    i = j + 1;
  } else {
    let j = i;
    let paren = 0;
    let got = false;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === CC_SPACE || c === CC_TAB || c === CC_LF || c === CC_CR || c < 32) break;
      if (c === CC_BACKSLASH && j + 1 < n && isPunct(s.charCodeAt(j + 1))) { dest += s[j + 1]; j += 2; got = true; continue; }
      if (c === CC_LPAREN) paren++;
      else if (c === CC_RPAREN) { if (paren === 0) break; paren--; }
      dest += s[j];
      j++;
      got = true;
    }
    if (paren !== 0) return null;
    i = j;
    // an empty bare destination is only valid if ) or a title follows
    if (!got && s.charCodeAt(i) !== CC_RPAREN && s.charCodeAt(i) !== CC_QUOT && s.charCodeAt(i) !== CC_SQ && s.charCodeAt(i) !== CC_LPAREN && !isSpace(s.charCodeAt(i))) return null;
  }
  while (i < n && isSpace(s.charCodeAt(i))) i++;
  let title = null;
  if (i < n && (s.charCodeAt(i) === CC_QUOT || s.charCodeAt(i) === CC_SQ || s.charCodeAt(i) === CC_LPAREN)) {
    const t = parseTitle(s, i);
    if (!t) return null;
    title = t.title;
    i = t.end;
    while (i < n && isSpace(s.charCodeAt(i))) i++;
  }
  if (i >= n || s.charCodeAt(i) !== CC_RPAREN) return null;
  return { dest, title, end: i + 1 };
}

// Plain-text rendering of inline nodes (for image alt text).
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 't') out += nd.e ? unescapePre(nd.s) : nd.s;
    else if (nd.k === 'code') out += nd.s;
    else if (nd.k === 'br') out += '\n';
    else if (nd.k === 'link' || nd.k === 'em' || nd.k === 'strong' || nd.k === 'del') out += plainText(nd.children);
    else if (nd.k === 'img') out += nd.alt;
    else if (nd.k === 'html') out += nd.s;
  }
  return out;
}
// Undo the escaping of a pre-escaped single-char text node (for alt text).
function unescapePre(s) {
  if (s === '&amp;') return '&';
  if (s === '&lt;') return '<';
  if (s === '&gt;') return '>';
  if (s === '&quot;') return '"';
  if (s === '&#39;') return "'";
  return s;
}

// Try to parse a link/image starting at s[i] === '['. Returns {node, end} or null.
function tryLink(s, i, refs, isImage) {
  const closeIdx = findLinkClose(s, i);
  if (closeIdx < 0) return null;
  const linkText = s.slice(i + 1, closeIdx);
  const n = s.length;
  let k = closeIdx + 1;
  let dest = null, title = null, end = -1;
  if (k < n && s.charCodeAt(k) === CC_LPAREN) {
    const p = parseInlineLink(s, k);
    if (p) { dest = p.dest; title = p.title; end = p.end; }
    else {
      // not a valid inline link: fall back to shortcut reference [foo],
      // leaving the (...) as literal text
      const key = normalizeLabel(linkText);
      if (key.length === 0) return null;
      const ref = refs.get(key);
      if (!ref) return null;
      dest = ref.dest; title = ref.title; end = closeIdx + 1;
    }
  } else if (k < n && s.charCodeAt(k) === CC_LBRK) {
    // full or collapsed reference: the label ends at the balancing ]
    const lc = findLabelCloseStr(s, k);
    if (!lc) return null;
    const label = lc.label;
    const key = label.length === 0 ? normalizeLabel(linkText) : normalizeLabel(label);
    if (key.length === 0) return null;
    const ref = refs.get(key);
    if (!ref) return null;
    dest = ref.dest; title = ref.title; end = lc.end;
  } else {
    // shortcut reference
    const key = normalizeLabel(linkText);
    if (key.length === 0) return null;
    const ref = refs.get(key);
    if (!ref) return null;
    dest = ref.dest; title = ref.title; end = closeIdx + 1;
  }
  const children = inlineParse(linkText, refs);
  // extended autolinks (bare URL / www. / email) are plain text inside a
  // link's text; only <...> autolinks stay links there
  deExtAutolinks(children);
  if (isImage) {
    return { node: { k: 'img', src: dest, alt: plainText(children), title }, end };
  }
  // a link's text may not contain another link
  if (containsLink(children)) return null;
  return { node: { k: 'link', href: dest, title, children }, end };
}

// Turn extended-autolink nodes (bare URL / www. / email) back into plain
// text nodes, in place, recursing into emphasis/strong/del children.
// Used for a link's text, where only <...> autolinks stay links.
function deExtAutolinks(nodes) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    if (nd.k === 'link' && nd.auto === 'ext') {
      nodes[idx] = { k: 't', s: plainText(nd.children) };
    } else if (nd.k === 'em' || nd.k === 'strong' || nd.k === 'del') {
      deExtAutolinks(nd.children);
    }
  }
}

// Does this node array contain a (non-autolink) link node at any depth?
// Autolinks inside a link's text are allowed; full links are not.
function containsLink(nodes) {
  for (const nd of nodes) {
    if (nd.k === 'link' && !nd.auto) return true;
    if (nd.k === 'em' || nd.k === 'strong' || nd.k === 'del') {
      if (containsLink(nd.children)) return true;
    }
  }
  return false;
}

// Autolink <...> at s[i] === '<'. Returns {node, end} or null.
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):([^<>\x00-\x20]*)$/;
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
function tryAutolink(s, i) {
  const gt = s.indexOf('>', i + 1);
  if (gt < 0) return null;
  const inner = s.slice(i + 1, gt);
  if (inner.length === 0 || /[\x00-\x20<>]/.test(inner)) return null;
  const m = SCHEME_RE.exec(inner);
  if (m) {
    return { node: { k: 'link', auto: 'angle', href: inner, title: null, children: [{ k: 't', s: inner }] }, end: gt + 1 };
  }
  if (EMAIL_RE.test(inner)) {
    return { node: { k: 'link', auto: 'angle', href: 'mailto:' + inner, title: null, children: [{ k: 't', s: inner }] }, end: gt + 1 };
  }
  return null;
}

// Inline HTML tag at s[i] === '<'. Returns {raw, end} or null.
function tryHtmlTag(s, i) {
  const n = s.length;
  if (s.startsWith('<!--', i)) {
    // <!--> and <!---> are complete (abruptly closed) comments
    if (s.charCodeAt(i + 4) === CC_GT) return { raw: s.slice(i, i + 5), end: i + 5 };
    if (s.startsWith('<!--->', i)) return { raw: s.slice(i, i + 7), end: i + 7 };
    const e = s.indexOf('-->', i + 4);
    if (e < 0) return null;
    return { raw: s.slice(i, e + 3), end: e + 3 };
  }
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    if (e < 0) return null;
    return { raw: s.slice(i, e + 2), end: e + 2 };
  }
  if (s.startsWith('<!', i) && i + 2 < n && isAlpha(s.charCodeAt(i + 2))) {
    const e = s.indexOf('>', i + 2);
    if (e < 0) return null;
    return { raw: s.slice(i, e + 1), end: e + 1 };
  }
  if (s.startsWith('<![CDATA[', i)) {
    const e = s.indexOf(']]>', i + 9);
    if (e < 0) return null;
    return { raw: s.slice(i, e + 3), end: e + 3 };
  }
  // open or close tag
  let j = i + 1;
  let closing = false;
  if (s.charCodeAt(j) === CC_SLASH) { closing = true; j++; }
  if (j >= n || !isAlpha(s.charCodeAt(j))) return null;
  while (j < n && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === CC_DASH)) j++;
  // attributes
  while (j < n) {
    // skip whitespace (incl. newlines); an attribute must be preceded by it
    let ws = 0;
    while (j < n && isSpace(s.charCodeAt(j))) { j++; ws++; }
    if (j >= n) return null;
    const c = s.charCodeAt(j);
    if (c === CC_GT) return { raw: s.slice(i, j + 1), end: j + 1 };
    if (c === CC_SLASH) {
      if (closing) return null;
      if (j + 1 < n && s.charCodeAt(j + 1) === CC_GT) return { raw: s.slice(i, j + 2), end: j + 2 };
      return null;
    }
    if (closing || ws === 0) return null;
    // attribute name
    if (!isAlpha(c) && c !== CC_US && c !== CC_COLON) return null;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (isAlnum(d) || d === CC_US || d === CC_DASH || d === CC_DOT || d === CC_COLON) j++;
      else break;
    }
    // look ahead past whitespace for '='; only consume the whitespace when
    // a value follows, so a valueless attribute keeps its separator for
    // the next attribute
    let k = j;
    while (k < n && isSpace(s.charCodeAt(k))) k++;
    if (k < n && s.charCodeAt(k) === CC_EQ) {
      j = k + 1;
      while (j < n && isSpace(s.charCodeAt(j))) j++;
      if (j >= n) return null;
      const q = s.charCodeAt(j);
      if (q === CC_QUOT || q === CC_SQ) {
        j++;
        const e = s.indexOf(String.fromCharCode(q), j);
        if (e < 0) return null;
        j = e + 1;
      } else {
        // unquoted value: no space, ", ', =, <, >, `
        let started = false;
        while (j < n) {
          const d = s.charCodeAt(j);
          if (d === CC_SPACE || d === CC_TAB || d === CC_LF || d === CC_CR || d === CC_QUOT || d === CC_SQ || d === CC_EQ || d === CC_LT || d === CC_GT || d === CC_TICK) break;
          started = true;
          j++;
        }
        if (!started) return null;
      }
    }
  }
  return null;
}

function isHexDigit(c) { return isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102); }

// Named HTML entities (common set) — used to decide whether an &name; in an
// autolink path is a real entity reference (kept) or not (autolink ends).
const NAMED_ENTITIES = new Set(('amp lt gt quot apos nbsp copy reg trade hellip mdash ndash laquo raquo ' +
  'times divide plusmn deg micro para sect middot bull dagger Dagger permil prime Prime oline frasl ' +
  'euro pound yen cent curren brvbar uml ordf ordm iexcl iquest szlig agrave aacute acirc atilde auml ' +
  'aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc ' +
  'otilde ouml oslash ugrave uacute ucirc uuml yacute yuml thorn Agrave Aacute Acirc Atilde Auml Aring ' +
  'AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde ' +
  'Ouml Oslash Ugrave Uacute Ucirc Uuml Yacute THORN alpha beta gamma delta epsilon zeta eta theta iota ' +
  'kappa lambda mu nu xi pi rho sigma tau upsilon phi chi psi omega Alpha Beta Gamma Delta Epsilon Zeta ' +
  'Eta Theta Iota Kappa Lambda Mu Nu Xi Pi Rho Sigma Tau Upsilon Phi Chi Psi Omega thetasym upsih piv ' +
  'infin ne le ge minus plus equiv neq approx prop cong sim sime asymp leq geq sub sup nsub sube supe ' +
  'nsup isin notin ni prod sum lowast radic ang and or cap cup int there4 empty nabla isin notin ni ' +
  'prod sum minus lowast radic prop infin ang and or cap cup int lceil rceil lfloor rfloor lang rang ' +
  'loz spades clubs hearts diams ensp emsp thinsp zwnj zwj lrm rlm sbquo bdquo lsquo rsquo ldquo rdquo ' +
  'dagger Dagger bull hellip permil prime Prime lsaquo rsaquo oline frasl euro image weierp real trade ' +
  'alefsym larr uarr rarr darr harr crarr lArr uArr rArr dArr hArr forall part exist empty nabla isin ' +
  'notin ni prod sum minus lowast radic prop infin ang and or cap cup int there4 sim cong asymp ne ' +
  'equiv le ge sub sup nsub supe sube prod sum minus lowast radic prop infin ang and or cap cup int ' +
  'forall part exist empty nabla isin notin ni prod sum minus lowast radic prop infin ang and or cap ' +
  'cup int there4 sim cong asymp ne equiv le ge sub sup nsub supe sube prod sum minus lowast radic ' +
  'prop infin ang and or cap cup int there4 sim cong asymp ne equiv le ge sub sup nsub supe sube ' +
  'prod sum minus lowast radic prop infin ang and or cap cup int there4').split(' ').filter(Boolean));

// True when the & at s[amp] starts an INVALID &name; reference — the
// autolink must end before it. A valid entity (named or numeric), or an &
// that does not start a name; pattern, is kept (returns false).
function autolinkEntityCut(s, amp) {
  const n = s.length;
  let j = amp + 1;
  if (j < n && s.charCodeAt(j) === 35) { // # numeric
    j++;
    let hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    let d = j;
    while (d < n && (hex ? isHexDigit(s.charCodeAt(d)) : isDigit(s.charCodeAt(d)))) d++;
    return false; // numeric (or malformed): keep the &
  }
  if (j < n && isAlpha(s.charCodeAt(j))) {
    let d = j;
    while (d < n && isAlnum(s.charCodeAt(d))) d++;
    if (d < n && s.charCodeAt(d) === CC_SEMI) {
      return !NAMED_ENTITIES.has(s.slice(j, d));
    }
  }
  return false;
}

// Scan an autolink path (after www. domain or scheme://): stop at whitespace,
// <, >, control chars, or at an & starting an invalid entity reference.
// Parentheses must balance: an ( with no matching ) before whitespace ends
// the URL before the ( (doc-08/12).
function scanAutolinkPath(s, j) {
  const n = s.length;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === CC_SPACE || c === CC_TAB || c === CC_LF || c === CC_CR || c === CC_LT || c === CC_GT || c < 32) break;
    if (c === CC_AMP && autolinkEntityCut(s, j)) break;
    if (c === CC_LPAREN) {
      // is this ( balanced before whitespace?
      let depth = 1;
      let k = j + 1;
      let balanced = false;
      while (k < n) {
        const d = s.charCodeAt(k);
        if (d === CC_SPACE || d === CC_TAB || d === CC_LF || d === CC_CR || d === CC_LT || d === CC_GT || d < 32) break;
        if (d === CC_LPAREN) depth++;
        else if (d === CC_RPAREN) { depth--; if (depth === 0) { balanced = true; break; } }
        k++;
      }
      if (!balanced) break;
    }
    j++;
  }
  return j;
}

// Scan a scheme-email resource segment: like scanAutolinkPath but also stops
// at / (a resource is a single path segment).
function scanResource(s, j) {
  const n = s.length;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === CC_SPACE || c === CC_TAB || c === CC_LF || c === CC_CR || c === CC_LT || c === CC_GT || c === CC_SLASH || c < 32) break;
    if (c === CC_AMP && autolinkEntityCut(s, j)) break;
    j++;
  }
  return j;
}

// Extended autolinks (GFM): www. and bare emails.
// Preceding char must be start-of-string, whitespace, or one of ( [ * _ ~
const EXT_PRECEDING = new Set([40, 91, 42, 95, 126]);
function extPrecedingOk(s, idx) {
  if (idx === 0) return true;
  const c = s.charCodeAt(idx - 1);
  return isWhitespace(c) || EXT_PRECEDING.has(c);
}
function trimAutolinkEnd(u, trimDash) {
  // trim trailing punctuation ? ! . , : ; * _ ~ and unbalanced ) and ; not in an entity
  // (trimDash also trims a trailing -, used for scheme-email resources)
  let end = u.length;
  while (end > 0) {
    const c = u.charCodeAt(end - 1);
    if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 || c === 42 || c === 95 || c === 126 || (trimDash && c === CC_DASH)) {
      if (c === 59) {
        // keep ; if it ends a valid entity
        const amp = u.lastIndexOf('&', end - 1);
        if (amp >= 0 && /^&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);$/.test(u.slice(amp, end))) break;
      }
      end--;
      continue;
    }
    if (c === 41) {
      // trim a trailing ) only if it has no matching ( : scan back for
      // the ( that pairs with this ) (an unpaired ) earlier in the URL
      // is literal and does not count, doc-12)
      let depth = 1;
      let i = end - 2;
      let matched = false;
      while (i >= 0) {
        const d = u.charCodeAt(i);
        if (d === 41) depth++;
        else if (d === 40) { depth--; if (depth === 0) { matched = true; break; } }
        i--;
      }
      if (!matched) { end--; continue; }
    }
    break;
  }
  return u.slice(0, end);
}
// Try a www. autolink at s[i] (s starts with 'www.' there). Returns {node, end} or null.
// The domain after www. must start with a domain char; dots (incl. trailing
// and double) are allowed inside; a path may follow.
function tryWwwAutolink(s, i) {
  if (!extPrecedingOk(s, i)) return null;
  const n = s.length;
  // the char right after 'www.' must be a domain char (alnum, -, _)
  if (i + 4 >= n) return null;
  const first = s.charCodeAt(i + 4);
  if (!(isAlnum(first) || first === CC_DASH || first === 95)) return null;
  let j = i;
  let dot = false;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === CC_DASH || c === 95) { j++; continue; }
    if (c === CC_DOT) { dot = true; j++; continue; }
    break;
  }
  if (!dot || j === i) return null;
  // optional path/query/fragment: /... ?... #... or a trailing \ (a \ is a
  // URL char, encoded %5C; it also keeps a preceding ?! from being trimmed
  // as trailing punctuation). trimAutolinkEnd removes trailing punctuation.
  if (j < n && (s.charCodeAt(j) === CC_SLASH || s.charCodeAt(j) === 63 || s.charCodeAt(j) === 35 || s.charCodeAt(j) === CC_BACKSLASH)) {
    j = scanAutolinkPath(s, j);
  }
  let url = trimAutolinkEnd(s.slice(i, j));
  if (url.length === 0 || url.indexOf('.') < 0) return null;
  return { node: { k: 'link', auto: 'ext', href: 'http://' + url, title: null, children: [{ k: 't', s: url }] }, end: i + url.length };
}
// Scan an email domain: labels of [A-Za-z0-9_-]+ separated by single dots.
// A dot is consumed only when followed by a label char, so the scan stops at
// a trailing dot, a double dot, or a non-label char. Returns {end, labels}.
function scanEmailDomain(s, j) {
  const n = s.length;
  let labels = 0;
  let end = j;
  while (true) {
    const ls = end;
    while (end < n) {
      const c = s.charCodeAt(end);
      if (isAlnum(c) || c === CC_DASH || c === 95) end++;
      else break;
    }
    if (end === ls) break;
    labels++;
    if (end < n && s.charCodeAt(end) === CC_DOT && end + 1 < n) {
      const nc = s.charCodeAt(end + 1);
      if (isAlnum(nc) || nc === CC_DASH || nc === 95) { end++; continue; }
    }
    break;
  }
  return { end, labels };
}

// Try a bare email autolink ending at the @ at s[at]. localStart is the
// index where the local part begins. Returns {node, end} or null.
// The domain must have at least two labels and its last label must end with
// an alnum char; a trailing . is excluded (the domain scan stops before it),
// but a trailing - or _ invalidates the whole email.
function tryEmailAutolink(s, localStart, at) {
  if (!extPrecedingOk(s, localStart)) return null;
  const dom = scanEmailDomain(s, at + 1);
  if (dom.labels < 2) return null;
  if (!isAlnum(s.charCodeAt(dom.end - 1))) return null;
  const email = s.slice(localStart, dom.end);
  return { node: { k: 'link', auto: 'ext', href: 'mailto:' + email, title: null, children: [{ k: 't', s: email }] }, end: localStart + email.length };
}

// Trimmed variant: when the domain ends in a run of _ (invalid as a domain
// ending), the run may be a closing __ emphasis delimiter. Only then —
// i.e. an opening _ delimiter is present in the already-emitted nodes —
// is the email valid with the run trimmed off. A trailing - never trims.
function tryEmailAutolinkTrimmed(s, localStart, at, nodes) {
  if (!extPrecedingOk(s, localStart)) return null;
  const dom = scanEmailDomain(s, at + 1);
  if (dom.labels < 2) return null;
  let end = dom.end;
  // count the trailing _ run
  let runStart = end;
  while (runStart > at + 1 && s.charCodeAt(runStart - 1) === 95) runStart--;
  if (runStart === end) return null; // no trailing _ run
  if (!isAlnum(s.charCodeAt(runStart - 1))) return null;
  // the trimmed domain must still have >= 2 labels and end in alnum;
  // rescan the trimmed span (slice keeps indices aligned)
  const trimmed = scanEmailDomain(s.slice(0, runStart), at + 1);
  if (trimmed.end !== runStart) return null;
  if (trimmed.labels < 2) return null;
  // is there an opening _ delimiter in the emitted nodes?
  let hasOpener = false;
  for (let k = nodes.length - 1; k >= 0; k--) {
    const nd = nodes[k];
    if (nd.k === 'd' && nd.ch === '_' && nd.open) { hasOpener = true; break; }
    if (nd.k === 't' || nd.k === 'link' || nd.k === 'img') break;
  }
  if (!hasOpener) return null;
  const email = s.slice(localStart, runStart);
  return { node: { k: 'link', auto: 'ext', href: 'mailto:' + email, title: null, children: [{ k: 't', s: email }] }, end: localStart + email.length };
}
// Try a scheme:// URL autolink (http/https/ftp, any case). s[start..] is the
// scheme, rest starts at restStart (just after '://'). The rest is any run of
// non-space chars (cut at an invalid &name;), trailing punctuation trimmed.
// No preceding-char restriction. Returns {node, end} or null.
function trySchemeUrl(s, start, restStart) {
  const j = scanAutolinkPath(s, restStart);
  const url = trimAutolinkEnd(s.slice(start, j));
  if (url.length === 0) return null;
  const after = url.indexOf('://') + 3;
  if (after >= url.length) return null;
  return { node: { k: 'link', auto: 'ext', href: url, title: null, children: [{ k: 't', s: url }] }, end: start + url.length };
}

// Try a scheme:email autolink (mailto/xmpp, lowercase only). The email must
// have at least two domain labels and its last label must end with an
// alnum char (a trailing - or _ invalidates the whole link — unlike bare
// emails, nothing is trimmed from the email). An optional single-segment
// /resource may follow the email.
// Returns {node, end} on success; {node: null, end} (end = how far the email
// scan got) when the scheme is at a valid position but the email is invalid,
// so the caller can suppress a bare-email match inside it; null when the
// scheme is not at a valid position.
function trySchemeEmail(s, start, ci) {
  if (!extPrecedingOk(s, start)) return null;
  const n = s.length;
  let j = ci + 1;
  const ls = j;
  while (j < n && isEmailLocalChar(s.charCodeAt(j))) j++;
  if (j === ls) return { node: null, end: j };
  if (j >= n || s.charCodeAt(j) !== 64) return { node: null, end: j };
  const dom = scanEmailDomain(s, j + 1);
  if (dom.labels < 2) return { node: null, end: dom.end };
  if (!isAlnum(s.charCodeAt(dom.end - 1))) return { node: null, end: dom.end };
  let end = dom.end;
  let email = s.slice(ci + 1, end);
  if (end < n && s.charCodeAt(end) === CC_SLASH) {
    const rs = end + 1;
    const re = scanResource(s, rs);
    if (re > rs) {
      const res = trimAutolinkEnd(s.slice(rs, re), true);
      if (res.length > 0) {
        email += '/' + res;
        end = rs + res.length;
      }
    }
  }
  const url = s.slice(start, ci + 1) + email;
  return { node: { k: 'link', auto: 'ext', href: url, title: null, children: [{ k: 't', s: url }] }, end: start + url.length };
}

// Try a scheme autolink at the ':' at s[ci]. Scans back over scheme chars and
// tries each whitelisted scheme suffix, leftmost first (like a regex scan):
// http/https/ftp (any case) need '://' after the colon; mailto/xmpp (lowercase
// only) need an email after it. Returns {node, end, start} or null.
function trySchemeAutolink(s, ci, bufStart) {
  let s0 = ci;
  while (s0 > bufStart) {
    const c = s.charCodeAt(s0 - 1);
    if (isAlnum(c) || c === 43 || c === CC_DOT || c === CC_DASH) s0--;
    else break;
  }
  if (s0 === ci) return null;
  const n = s.length;
  for (let p = s0; p < ci; p++) {
    const scheme = s.slice(p, ci);
    const low = scheme.toLowerCase();
    if (low === 'http' || low === 'https' || low === 'ftp') {
      if (ci + 2 < n && s.charCodeAt(ci + 1) === CC_SLASH && s.charCodeAt(ci + 2) === CC_SLASH) {
        const r = trySchemeUrl(s, p, ci + 3);
        if (r) return { node: r.node, end: r.end, start: p };
      }
      continue;
    }
    if (scheme === 'mailto' || scheme === 'xmpp') {
      const r = trySchemeEmail(s, p, ci);
      if (r && r.node) return { node: r.node, end: r.end, start: p };
      if (r) return { node: null, end: r.end, start: p };
      continue;
    }
  }
  return null;
}
function isEmailLocalChar(c) {
  return isAlnum(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 ||
    c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 || c === 95 || c === 96 ||
    c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}

// Emphasis processing on one container (array of nodes). Wraps matched
// delimiter pairs into em/strong/del nodes. Single left-to-right pass.
function processEmphasis(nodes) {
  for (let x = 0; x < nodes.length; x++) {
    const nd = nodes[x];
    if (nd.k === 'link' || nd.k === 'img') continue;
    if (nd.k === 'em' || nd.k === 'strong' || nd.k === 'del') continue;
  }
  // Barriers: when a match is formed by a closer that can both open and
  // close, and its opener can only open, an outer opener before that match
  // is blocked when (barrier length + opener length) is a multiple of 3.
  // (If the inner opener can also close, no barrier: *foo**bar**baz* still
  // forms the outer em.) A barrier is cleared when a later closer fails
  // to find an opener.
  let barriers = [];
  // collect delimiter nodes in order
  let delims = nodes.filter(nd => nd.k === 'd');
  let di = 0;
  while (di < delims.length) {
    const closer = delims[di];
    if (!closer.close || closer.n === 0) { di++; continue; }
    // find the nearest matching opener before it
    let opener = null;
    for (let k = di - 1; k >= 0; k--) {
      const op = delims[k];
      if (op.ch !== closer.ch || !op.open || op.n === 0) continue;
      // Rule of 3 (marked's form): block a match when the sum of the two
      // run lengths is a multiple of 3, either delimiter can both open and
      // close, and the two lengths are not both multiples of 3.
      if ((op.n + closer.n) % 3 === 0 && ((op.open && op.close) || (closer.open && closer.close)) && !(op.n % 3 === 0 && closer.n % 3 === 0)) continue;
      // Strong preference: if the opener is longer than this closer (so
      // it would be left over), and a later closer of the same char could
      // fully consume it, leave the opener for that later closer.
      if (op.n > closer.n) {
        let later = false;
        for (let m = di + 1; m < delims.length; m++) {
          const lc = delims[m];
          if (lc.ch === closer.ch && lc.close && lc.n >= op.n) { later = true; break; }
        }
        if (later) continue;
      }
      // Barrier: a "both" closer that formed an inner match blocks an
      // outer opener positioned before it when the lengths sum to a
      // multiple of 3 — but only when the closer is not too long for the
      // barrier (a *** closer is not blocked by a 1-length barrier, doc-11)
      let blocked = false;
      for (const b of barriers) {
        if (b.ch !== op.ch) continue;
        if (nodes.indexOf(op) < nodes.indexOf(b.after) && (b.n + op.n) % 3 === 0 && closer.n <= b.n + 1) { blocked = true; break; }
      }
      if (blocked) continue;
      opener = op;
      break;
    }
    if (!opener) {
      // a failing closer clears barriers of its own length (P3: the * that
      // fails after an em unblocks the ** that follows; a * failing after
      // a strong does not unblock the * it was barred from, doc-11)
      barriers = barriers.filter(b => b.n !== closer.n);
      di++; continue;
    }
    const use = closer.ch === '~' ? Math.min(opener.n, closer.n) : (opener.n >= 2 && closer.n >= 2 ? 2 : 1);
    const oiNode = nodes.indexOf(opener);
    const diNode = nodes.indexOf(closer);
    if (oiNode < 0 || diNode < 0 || diNode <= oiNode) { barriers = []; di++; continue; }
    const children = nodes.slice(oiNode + 1, diNode);
    const kind = closer.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    const emNode = { k: kind, children };
    const closerWasBoth = closer.open && closer.close;
    const openerOnlyOpen = opener.open && !opener.close;
    const closerN = closer.n;
    opener.n -= use;
    closer.n -= use;
    const rep = [];
    if (opener.n > 0) rep.push(opener);
    rep.push(emNode);
    // a leftover closer goes INSIDE the em node only for a strong (use 2)
    // when the inner match that left the barrier is a direct child of this
    // em node (the * of *** after an attached inner em lands inside the
    // strong, doc-11); for an em (use 1) it stays after
    let closerInside = false;
    if (closer.n > 0) {
      if (use === 2 && barriers.some(b => b.ch === closer.ch && emNode.children.includes(b.after))) { emNode.children.push(closer); closerInside = true; }
      else rep.push(closer);
    }
    nodes.splice(oiNode, diNode - oiNode + 1, ...rep);
    // a "both" closer whose opener can only open leaves a barrier
    if (closerWasBoth && openerOnlyOpen) barriers.push({ n: closerN, ch: closer.ch, after: emNode });
    // rebuild the delimiter list from the container's current nodes
    delims = nodes.filter(nd => nd.k === 'd');
    if (closer.n > 0 && !closerInside) {
      // re-process the remaining closer
      di = delims.indexOf(closer);
      if (di < 0) di = 0;
    } else {
      // continue with the first delimiter after the em node
      const emIdx = nodes.indexOf(emNode);
      di = delims.length;
      for (let k = 0; k < delims.length; k++) {
        if (nodes.indexOf(delims[k]) > emIdx) { di = k; break; }
      }
    }
  }
  // any delimiter left over renders literally
  for (const nd of nodes) {
    if (nd.k === 'd') { nd.k = 't'; nd.s = nd.ch.repeat(nd.n); delete nd.ch; delete nd.n; delete nd.open; delete nd.close; }
  }
}

function processContainer(nodes) {
  for (const nd of nodes) {
    if (nd.k === 'link') processContainer(nd.children);
  }
  processEmphasis(nodes);
}

const SPECIAL_RE = /[\\`*_~\[\]<&\n!@:]|www\./g;

// Marked quirk (doc-03): an unclosed inline lowercase <a> tag suppresses
// extended autolinks (bare URL / www. / email) for the rest of the
// document; a </a> clears it. Angle-bracket autolinks are unaffected.
// (An <a> alone on a line is an HTML block, not inline, and does not
// trigger this.) Reset per document in parse().
let suppressExtAuto = false;

// The inline parser: raw text -> array of nodes.
function inlineParse(text, refs) {
  const nodes = [];
  const n = text.length;
  let i = 0;
  let buf = '';
  let bufStart = 0;
  let suppressEmailUntil = 0;
  const flush = () => { if (buf.length > 0) { nodes.push({ k: 't', s: buf }); buf = ''; } };
  const pushLit = (ch) => { flush(); nodes.push({ k: 't', s: escSingle(ch), e: true }); };
  const pushDelim = (ch, len, open, close) => { flush(); nodes.push({ k: 'd', ch, n: len, open, close }); };
  SPECIAL_RE.lastIndex = 0;
  while (i < n) {
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(text);
    const next = m ? m.index : n;
    if (next > i) {
      if (buf.length === 0) bufStart = i;
      buf += text.slice(i, next);
      i = next;
      if (i >= n) break;
    }
    const c = text.charCodeAt(i);
    const matched = m ? m[0] : '';
    if (matched === 'www.') {
      const r = suppressExtAuto ? null : tryWwwAutolink(text, i);
      if (r) {
        // the www. is at the end of the current buffer region: flush text before it
        flush();
        nodes.push(r.node);
        i = r.end;
        bufStart = i;
        continue;
      }
      // not a link: treat 'w' as text
      if (buf.length === 0) bufStart = i;
      buf += 'w';
      i++;
      continue;
    }
    if (c === CC_BACKSLASH) {
      if (i + 1 < n && text.charCodeAt(i + 1) === CC_LF) {
        flush();
        nodes.push({ k: 'br' });
        i += 2;
        // a hard break strips the next line's leading spaces/tabs
        while (i < n && (text.charCodeAt(i) === CC_SPACE || text.charCodeAt(i) === CC_TAB)) i++;
        bufStart = i;
        continue;
      }
      if (i + 1 < n && isPunct(text.charCodeAt(i + 1))) {
        pushLit(text[i + 1]);
        i += 2;
        bufStart = i;
        continue;
      }
      if (buf.length === 0) bufStart = i;
      buf += '\\';
      i++;
      continue;
    }
    if (c === CC_TICK) {
      let r = 0;
      while (i + r < n && text.charCodeAt(i + r) === CC_TICK) r++;
      let k = i + r;
      let found = -1;
      while (k < n) {
        if (text.charCodeAt(k) === CC_TICK) {
          let r2 = 0;
          while (k + r2 < n && text.charCodeAt(k + r2) === CC_TICK) r2++;
          if (r2 === r) { found = k; break; }
          k += r2;
        } else k++;
      }
      if (found < 0) {
        if (buf.length === 0) bufStart = i;
        buf += text.slice(i, i + r);
        i += r;
        continue;
      }
      flush();
      nodes.push({ k: 'code', s: processCodeSpan(text.slice(i + r, found)) });
      i = found + r;
      bufStart = i;
      continue;
    }
    if (c === CC_STAR || c === CC_US || c === CC_TILDE) {
      let r = 0;
      while (i + r < n && text.charCodeAt(i + r) === c) r++;
      if (c === CC_TILDE && r >= 3) {
        // ~~~ and longer runs are literal text, not strikethrough
        if (buf.length === 0) bufStart = i;
        buf += text.slice(i, i + r);
        i += r;
        continue;
      }
      const fl = flanking(text, i, r);
      let open, close;
      if (c === CC_US) {
        open = fl.left && (!fl.right || (i > 0 && isUnicodePunct(text.charCodeAt(i - 1))));
        close = fl.right && (!fl.left || (i + r < n && isUnicodePunct(text.charCodeAt(i + r))));
      } else {
        open = fl.left;
        close = fl.right;
      }
      pushDelim(String.fromCharCode(c), r, open, close);
      i += r;
      bufStart = i;
      continue;
    }
    if (c === CC_LBRK || (c === CC_BANG && i + 1 < n && text.charCodeAt(i + 1) === CC_LBRK)) {
      const isImage = c === CC_BANG;
      const start = isImage ? i + 1 : i;
      const r = tryLink(text, start, refs, isImage);
      if (r) {
        flush();
        nodes.push(r.node);
        i = r.end;
        bufStart = i;
        continue;
      }
      // not a link: literal ! and/or [
      if (buf.length === 0) bufStart = i;
      buf += isImage ? '![' : '[';
      i += isImage ? 2 : 1;
      continue;
    }
    if (c === CC_COLON) {
      // possible scheme autolink (http/https/ftp/mailto/xmpp)
      const r = suppressExtAuto ? null : trySchemeAutolink(text, i, bufStart);
      if (r && r.node) {
        buf = buf.slice(0, r.start - bufStart);
        flush();
        nodes.push(r.node);
        i = r.end;
        bufStart = i;
        continue;
      }
      // a mailto:/xmpp: at a valid position with an invalid email still
      // claims the text: no bare-email match may start inside it
      if (r && !r.node) suppressEmailUntil = Math.max(suppressEmailUntil, r.end);
      if (buf.length === 0) bufStart = i;
      buf += ':';
      i++;
      continue;
    }
    if (c === CC_LT) {
      const al = tryAutolink(text, i);
      if (al) {
        flush();
        nodes.push(al.node);
        i = al.end;
        bufStart = i;
        continue;
      }
      const tag = tryHtmlTag(text, i);
      if (tag) {
        flush();
        nodes.push({ k: 'html', s: tag.raw });
        // marked quirk: an unclosed inline <a> suppresses extended
        // autolinks for the rest of the document; a </a> clears it
        const raw = tag.raw;
        if (raw.charCodeAt(1) === CC_SLASH) {
          let e = 2;
          while (e < raw.length && (isAlnum(raw.charCodeAt(e)) || raw.charCodeAt(e) === CC_DASH)) e++;
          if (e === 3 && raw.charCodeAt(2) === 97) suppressExtAuto = false;
        } else {
          let e = 1;
          while (e < raw.length && (isAlnum(raw.charCodeAt(e)) || raw.charCodeAt(e) === CC_DASH)) e++;
          // only the exact <a/> is self-closing in marked; <a /> and
          // <a href="x"/> still open a link
          if (e === 2 && raw.charCodeAt(1) === 97 && raw !== '<a/>') suppressExtAuto = true;
        }
        i = tag.end;
        bufStart = i;
        continue;
      }
      if (buf.length === 0) bufStart = i;
      buf += '<';
      i++;
      continue;
    }
    if (c === CC_AMP) {
      ENTITY_RE.lastIndex = i;
      const em = ENTITY_RE.exec(text);
      if (em) {
        if (em[1] !== undefined || em[2] !== undefined) {
          const cp = em[1] !== undefined ? parseInt(em[1], 10) : parseInt(em[2], 16);
          const ch = decodeCodePoint(cp);
          if (ch === null) {
            // out of range: not an entity; the & is literal text
            if (buf.length === 0) bufStart = i;
            buf += '&';
            i++;
            continue;
          }
          pushLit(ch);
          i += em[0].length;
          bufStart = i;
          continue;
        } else {
          // named entity: kept verbatim inside the current text run, so
          // bufStart (where this run began) must NOT move
          if (buf.length === 0) bufStart = i;
          buf += em[0];
          i += em[0].length;
          continue;
        }
      }
      if (buf.length === 0) bufStart = i;
      buf += '&';
      i++;
      continue;
    }
    if (c === CC_LF) {
      // hard break if the buffer ends with 2+ spaces
      if (buf.length >= 2 && buf.charCodeAt(buf.length - 1) === CC_SPACE && buf.charCodeAt(buf.length - 2) === CC_SPACE) {
        let e = buf.length;
        while (e > 0 && buf.charCodeAt(e - 1) === CC_SPACE) e--;
        buf = buf.slice(0, e);
        flush();
        nodes.push({ k: 'br' });
        i++;
        // a hard break strips the next line's leading spaces/tabs
        while (i < n && (text.charCodeAt(i) === CC_SPACE || text.charCodeAt(i) === CC_TAB)) i++;
        bufStart = i;
      } else {
        if (buf.length === 0) bufStart = i;
        buf += '\n';
        i++;
      }
      continue;
    }
    if (c === 64) { // @ — possible bare email autolink
      // (suppressed inside a failed mailto:/xmpp: scheme attempt)
      if (i < suppressEmailUntil) {
        if (buf.length === 0) bufStart = i;
        buf += '@';
        i++;
        continue;
      }
      // Look back over the local part. It may span trailing text nodes
      // and inert delimiter runs (a _ that can neither open nor close,
      // e.g. the _ in a.b-c_d, is plain text there). A delimiter that can
      // open or close emphasis (*, _, ~) stops the scan: the local part
      // never includes it (a*b@c.com -> b@c.com).
      const segs = [];
      let k = nodes.length - 1;
      while (k >= 0) {
        const nd = nodes[k];
        if (nd.k === 't' && !nd.e) segs.unshift(nd.s);
        else if (nd.k === 'd' && !nd.open && !nd.close) segs.unshift(nd.ch.repeat(nd.n));
        else break;
        k--;
      }
      segs.push(buf);
      let tailLen = 0;
      for (const s of segs) tailLen += s.length;
      const tailAt = (idx) => {
        let acc = 0;
        for (const s of segs) {
          if (idx < acc + s.length) return s.charCodeAt(idx - acc);
          acc += s.length;
        }
        return -1;
      };
      let li = tailLen;
      while (li > 0 && isEmailLocalChar(tailAt(li - 1))) li--;
      if (li < tailLen) {
        const tailStart = bufStart - (tailLen - buf.length);
        const localStart = tailStart + li;
        let r = suppressExtAuto ? null : tryEmailAutolink(text, localStart, i);
        if (!r && !suppressExtAuto) r = tryEmailAutolinkTrimmed(text, localStart, i, nodes);
        if (r) {
          // remove the local part (tailLen - li chars) from the tail
          let remove = tailLen - li;
          if (remove <= buf.length) {
            buf = buf.slice(0, buf.length - remove);
          } else {
            remove -= buf.length;
            buf = '';
            while (remove > 0 && nodes.length > 0) {
              const nd = nodes[nodes.length - 1];
              if (nd.k === 't' && !nd.e) {
                if (remove >= nd.s.length) { remove -= nd.s.length; nodes.pop(); }
                else { nd.s = nd.s.slice(0, nd.s.length - remove); remove = 0; }
              } else if (nd.k === 'd') {
                if (remove >= nd.n) { remove -= nd.n; nodes.pop(); }
                else { nd.n -= remove; remove = 0; }
              } else break;
            }
          }
          flush();
          nodes.push(r.node);
          i = r.end;
          bufStart = i;
          continue;
        }
      }
      if (buf.length === 0) bufStart = i;
      buf += '@';
      i++;
      continue;
    }
    // ! not followed by [ : literal
    if (buf.length === 0) bufStart = i;
    buf += text[i];
    i++;
  }
  flush();
  processContainer(nodes);
  return nodes;
}

// ---------------- rendering ----------------
function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 't') out += nd.e ? nd.s : escText(nd.s);
    else if (nd.k === 'code') out += '<code>' + escCode(nd.s) + '</code>';
    else if (nd.k === 'br') out += '<br>';
    else if (nd.k === 'link') {
      out += '<a href="' + cleanHref(nd.href) + '"';
      if (nd.title !== null && nd.title !== undefined) out += ' title="' + escText(nd.title) + '"';
      out += '>' + renderInline(nd.children) + '</a>';
    } else if (nd.k === 'img') {
      out += '<img src="' + cleanHref(nd.src) + '" alt="' + escText(nd.alt) + '"';
      if (nd.title !== null && nd.title !== undefined) out += ' title="' + escText(nd.title) + '"';
      out += '>';
    } else if (nd.k === 'html') out += nd.s;
    else if (nd.k === 'em') out += '<em>' + renderInline(nd.children) + '</em>';
    else if (nd.k === 'strong') out += '<strong>' + renderInline(nd.children) + '</strong>';
    else if (nd.k === 'del') out += '<del>' + renderInline(nd.children) + '</del>';
    else if (nd.k === 'd') out += escText(nd.ch.repeat(nd.n));
  }
  return out;
}

function renderBlock(b, refs) {
  if (b.t === 'para') return '<p>' + renderInline(inlineParse(b.text, refs)) + '</p>\n';
  if (b.t === 'h') return '<h' + b.level + '>' + renderInline(inlineParse(b.text, refs)) + '</h' + b.level + '>\n';
  if (b.t === 'fence') {
    return '<pre><code' + (b.lang ? ' class="language-' + escText(b.lang) + '"' : '') + '>' + escCode(b.text) + '</code></pre>\n';
  }
  if (b.t === 'code') return '<pre><code>' + escCode(b.text) + '</code></pre>\n';
  if (b.t === 'quote') return '<blockquote>\n' + renderBlocks(b.children, refs) + '</blockquote>\n';
  if (b.t === 'list') {
    const tag = b.ordered ? 'ol' : 'ul';
    let out = '<' + tag + (b.ordered && b.start !== null && b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n';
    for (const it of b.items) out += renderListItem(it, b.tight, refs);
    out += '</' + tag + '>\n';
    return out;
  }
  if (b.t === 'html') return b.text;
  if (b.t === 'hr') return '<hr>\n';
  if (b.t === 'table') {
    let out = '<table>\n<thead>\n<tr>\n';
    for (let c = 0; c < b.header.length; c++) {
      out += '<th' + (b.align[c] ? ' align="' + b.align[c] + '"' : '') + '>' + renderInline(inlineParse(b.header[c], refs)) + '</th>\n';
    }
    out += '</tr>\n</thead>\n';
    if (b.rows.length > 0) {
      out += '<tbody>';
      for (const row of b.rows) {
        out += '<tr>\n';
        for (let c = 0; c < b.header.length; c++) {
          out += '<td' + (b.align[c] ? ' align="' + b.align[c] + '"' : '') + '>' + renderInline(inlineParse(row[c], refs)) + '</td>\n';
        }
        out += '</tr>\n';
      }
      out += '</tbody>';
    }
    out += '</table>\n';
    return out;
  }
  return '';
}

function renderListItem(it, tight, refs) {
  let out = '<li>';
  let first = true;
  for (const b of it.children) {
    if (first && b.t === 'para') {
      first = false;
      // GFM task list: [ ] / [x] / [X] followed by whitespace at the start
      // of the item's first paragraph renders a checkbox; only the 3-char
      // marker is removed, the following space stays
      const m = /^(\[ \]|\[x\]|\[X\])(?=[ \t]|\n|$)/.exec(b.text);
      if (m) {
        const checked = m[1] !== '[ ]';
        const box = checked ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
        const restText = b.text.slice(3);
        if (tight) out += box + renderInline(inlineParse(restText, refs));
        else out += '<p>' + box + renderInline(inlineParse(restText, refs)) + '</p>\n';
        continue;
      }
      if (tight) out += renderInline(inlineParse(b.text, refs));
      else out += renderBlock(b, refs);
      continue;
    }
    first = false;
    if (tight && b.t === 'para') out += renderInline(inlineParse(b.text, refs));
    else out += renderBlock(b, refs);
  }
  out += '</li>\n';
  return out;
}

function renderBlocks(blocks, refs) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, refs);
  return out;
}

// ---------------- entry point ----------------
export function parse(markdown) {
  suppressExtAuto = false;
  const sp = splitLines(markdown);
  const refs = new Map();
  const res = parseBlocks(sp.lines, 0, sp.lines.length, null, sp.hasNL, refs);
  return renderBlocks(res.blocks, refs);
}

// Split markdown into plain string lines plus, for each line, whether it was
// followed by a line ending (\n, \r\n or \r). A trailing line ending makes no
// extra line.
function splitLines(src) {
  const lines = [];
  const hasNL = [];
  const n = src.length;
  let start = 0;
  while (start < n) {
    let i = start;
    while (i < n && src.charCodeAt(i) !== CC_LF && src.charCodeAt(i) !== CC_CR) i++;
    lines.push(src.slice(start, i));
    if (i < n) {
      hasNL.push(true);
      if (src.charCodeAt(i) === CC_CR && i + 1 < n && src.charCodeAt(i + 1) === CC_LF) i += 2;
      else i++;
    } else hasNL.push(false);
    start = i;
  }
  return { lines, hasNL };
}
