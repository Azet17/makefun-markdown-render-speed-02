// parse.js — a fast drop-in replacement for marked 18.1.3 (default options:
// gfm true, breaks false, pedantic false, async false).
// Written from scratch for the make.fun markdown-render-speed-02 competition.
// parse(markdown) returns exactly the HTML marked 18.1.3 renders.

const REPLACEMENT = '\uFFFD';
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

// ---------- character classes (on char codes) ----------
function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 ||
    c === 133 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) ||
    c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}
function isAsciiLetter(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAsciiDigit(c) { return c >= 48 && c <= 57; }
function isAsciiAlnum(c) { return isAsciiLetter(c) || isAsciiDigit(c); }
const PUNCT_RE = /^[\p{P}\p{S}]$/u;
function isPunctCode(c) {
  // ASCII punctuation only (backslash escapes, link parsing). Non-ASCII
  // punctuation is NOT escapable: \<non-ascii> keeps the backslash.
  if (c >= 128) return false;
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isUniPunctCode(c) {
  // Unicode punctuation for flanking rules: CommonMark counts both P
  // (punctuation) and S (symbol) categories — so £/€/$ are punctuation.
  // ASCII punctuation is also Unicode punctuation, so the regex covers both.
  if (c < 128) return isPunctCode(c);
  return PUNCT_RE.test(String.fromCharCode(c));
}
// flanking: left-flanking = not followed by space, and (not followed by punct, or followed by punct and preceded by space/punct)
// right-flanking = not preceded by space, and (not preceded by punct, or preceded by punct and followed by space/punct)
function flanking(before, after) {
  // before/after: char codes, or -1 for start/end of string. The string
  // boundary counts as whitespace (a word boundary) for flanking.
  const afterSpace = after === -1 ? true : isSpaceCode(after);
  const beforeSpace = before === -1 ? true : isSpaceCode(before);
  const afterPunct = after === -1 ? false : isUniPunctCode(after);
  const beforePunct = before === -1 ? false : isUniPunctCode(before);
  const leftFlanking = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const rightFlanking = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  return [leftFlanking, rightFlanking];
}

// ---------- escaping ----------
// Escape text, decoding numeric character references and leaving named
// &name; sequences literally (marked does not decode named entities).
function escInlineText(s) {
  const n = s.length;
  let out = null;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) { // &
      let j = i + 1;
      if (j < n && s.charCodeAt(j) === 35) { // #
        j++;
        let hex = false;
        if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
        let k = j;
        let val = 0;
        let digits = 0;
        let over = false;
        while (k < n) {
          const d = s.charCodeAt(k);
          let v = -1;
          if (d >= 48 && d <= 57) v = d - 48;
          else if (hex && d >= 65 && d <= 70) v = d - 55;
          else if (hex && d >= 97 && d <= 102) v = d - 87;
          else break;
          if (!over) {
            val = val * (hex ? 16 : 10) + v;
            if (val > 0x10FFFF) { over = true; val = 0x110000; }
          }
          digits++;
          k++;
        }
        if (digits > 0 && k < n && s.charCodeAt(k) === 59) { // ;
          let ch;
          if (val === 0 || val > 0x10FFFF || (val >= 0xD800 && val <= 0xDFFF)) ch = REPLACEMENT;
          else ch = String.fromCodePoint(val);
          const cc = ch.charCodeAt(0);
          if (cc === 38) rep = '&amp;';
          else if (cc === 60) rep = '&lt;';
          else if (cc === 62) rep = '&gt;';
          else if (cc === 34) rep = '&quot;';
          else if (cc === 39) rep = '&#39;';
          else rep = ch;
          if (!out) out = [];
          out.push(s.slice(start, i), rep);
          i = k;
          start = k + 1;
          continue;
        }
      } else {
        // named entity-like &name; -> leave literally
        let k = j;
        if (k < n && isAsciiLetter(s.charCodeAt(k))) {
          k++;
          while (k < n && isAsciiAlnum(s.charCodeAt(k))) k++;
          if (k < n && s.charCodeAt(k) === 59) continue;
        }
      }
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (!out) out = [];
    out.push(s.slice(start, i), rep);
    start = i + 1;
  }
  if (!out) return s;
  out.push(s.slice(start));
  return out.join('');
}

// Escape code content: no entity decoding, escape & < > " '.
function escCode(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Clean a link/image URL the way marked does: encodeURI, then escape
// & (entity-aware) and ' — < > " are already percent-encoded by encodeURI.
const AMP_NOT_ENT_RE = /&(?!(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);)/g;
function cleanUrl(url, plainAmp) {
  let u;
  try { u = encodeURI(url).replace(/%25/g, '%'); } catch (e) { u = url; }
  if (u.indexOf('&') !== -1) {
    if (plainAmp) u = u.replace(/&/g, '&amp;');
    else u = u.replace(AMP_NOT_ENT_RE, '&amp;');
  }
  if (u.indexOf('<') !== -1) u = u.replace(/</g, '&lt;');
  if (u.indexOf('>') !== -1) u = u.replace(/>/g, '&gt;');
  if (u.indexOf('"') !== -1) u = u.replace(/"/g, '&quot;');
  if (u.indexOf("'") !== -1) u = u.replace(/'/g, '&#39;');
  return u;
}

// Decode backslash escapes in a label/destination/title fragment:
// backslash + ASCII punctuation -> the punctuation; otherwise keep both.
function unescapeStr(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && isPunctCode(s.charCodeAt(i + 1))) { out += s[i + 1]; i++; }
    else out += c;
  }
  return out;
}

// Normalize a link label for lookup: unescape, collapse whitespace, trim, lowercase.
function normalizeLabel(s) {
  // Link labels match LITERALLY (backslashes preserved): `[foo\!]` matches
  // `[foo\!]` but NOT `[foo!]` (cm-545). Only whitespace is collapsed,
  // case is folded (with ß/ẞ → ss, cm-540), and backslashes are kept.
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// Does a parts list contain a BRACKET link node (t=4, not an autolink)
// anywhere, recursing into emphasis/strong/del children? A link label may
// not contain a bracket link, but autolinks (<...>/GFM) inside a label are
// fine and do not block the outer link.
function containsLink(parts) {
  for (const p of parts) {
    if (p.t === 4 && !p.auto) return true;
    if ((p.t === 1 || p.t === 2 || p.t === 3) && p.c && containsLink(p.c)) return true;
  }
  return false;
}

// Does the label text contain a code span whose content includes a
// backtick AND that is not the last thing in the label (non-whitespace
// follows it before the `]`)? Probed: `[x `` a ` b ``]` forms (code
// span is last), but `[x `` a ` b `` y]`, `[x `` a ` b ``_]` and
// `[but _prev `` a ` b ``_]` do not form (text/`_` follows the span).
// The code span still renders and the URL is autolinked.
function backtickCodeSpanBlocksLink(label) {
  let idx = 0;
  const n = label.length;
  while (idx < n) {
    if (label.charCodeAt(idx) !== 96) { idx++; continue; }
    let j = idx;
    while (j < n && label.charCodeAt(j) === 96) j++;
    const m = j - idx;
    let close = -1;
    let k = j;
    while (k < n) {
      if (label.charCodeAt(k) === 96) {
        let e = k;
        while (e < n && label.charCodeAt(e) === 96) e++;
        if (e - k === m) { close = k; break; }
        k = e;
      } else k++;
    }
    if (close === -1) return false;
    if (label.slice(j, close).includes('`')) {
      if (label.slice(close + m).trim() !== '') return true;
    }
    idx = close + m;
  }
  return false;
}

// ---------- inline parsing ----------
// Node types: 0 text {s}, 1 em {c}, 2 strong {c}, 3 del {c}, 4 link {href,title,c},
// 5 image {src,alt,title}, 6 code {s}, 7 html {s}, 8 br
function renderParts(parts, out) {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    switch (p.t) {
      case 0: out.push(p.s); break;
      case 1: out.push('<em>'); renderParts(p.c, out); out.push('</em>'); break;
      case 2: out.push('<strong>'); renderParts(p.c, out); out.push('</strong>'); break;
      case 3: out.push('<del>'); renderParts(p.c, out); out.push('</del>'); break;
      case 4:
        out.push('<a href="', p.href, '"');
        if (p.title != null) out.push(' title="', p.title, '"');
        out.push('>');
        renderParts(p.c, out);
        out.push('</a>');
        break;
      case 5:
        out.push('<img src="', p.src, '" alt="', p.alt, '"');
        if (p.title != null) out.push(' title="', p.title, '"');
        out.push('>');
        break;
      case 6: out.push('<code>', escCode(p.s), '</code>'); break;
      case 7: out.push(p.s); break;
      case 8: out.push('<br>'); break;
    }
  }
}

// Plain text of parsed inline parts (for image alt text). Text nodes already
// hold escaped HTML, which is exactly what an attribute value needs.
function plainText(parts) {
  let s = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.t === 0) s += p.s;
    else if (p.t === 6) s += escCode(p.s);
    else if (p.t === 1 || p.t === 2 || p.t === 3 || p.t === 4) s += plainText(p.c);
    else if (p.t === 5) s += p.alt;
  }
  return s;
}

function skipWS(text, i) {
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) i++;
    else break;
  }
  return i;
}

// Decode a numeric character reference at text[i] ('&'). Returns {ch, end}
// (end = index just past ';') or null.
function decodeNumericRef(text, i) {
  const n = text.length;
  let j = i + 1;
  if (j >= n || text.charCodeAt(j) !== 35) return null;
  j++;
  let hex = false;
  if (j < n && (text.charCodeAt(j) === 120 || text.charCodeAt(j) === 88)) { hex = true; j++; }
  let k = j;
  let val = 0;
  let digits = 0;
  let over = false;
  while (k < n) {
    const d = text.charCodeAt(k);
    let v = -1;
    if (d >= 48 && d <= 57) v = d - 48;
    else if (hex && d >= 65 && d <= 70) v = d - 55;
    else if (hex && d >= 97 && d <= 102) v = d - 87;
    else break;
    if (!over) {
      val = val * (hex ? 16 : 10) + v;
      if (val > 0x10FFFF) { over = true; val = 0x110000; }
    }
    digits++;
    k++;
  }
  if (digits === 0 || k >= n || text.charCodeAt(k) !== 59) return null;
  // marked rejects numeric references with too many digits outright
  // (decimal > 7 digits, hex > 6 digits) instead of decoding them.
  if ((hex && digits > 6) || (!hex && digits > 7)) return null;
  let ch;
  if (val === 0 || val > 0x10FFFF || (val >= 0xD800 && val <= 0xDFFF)) ch = REPLACEMENT;
  else ch = String.fromCodePoint(val);
  return { ch, end: k + 1 };
}

// Parse a link/image target starting at text[i] (just after ']').
// br is the bracket entry. Returns {href, title, end} or null.
function parseLinkTarget(text, i, br, ctx) {
  const n = text.length;
  if (i < n && text.charCodeAt(i) === 40) { // (
    let j = skipWS(text, i + 1);
    let dest = null;
    if (j < n && text.charCodeAt(j) === 60) { // <
      let k = j + 1;
      let d = '';
      let ok = false;
      while (k < n) {
        const c = text.charCodeAt(k);
        if (c === 10) break;
        if (c === 92 && k + 1 < n && isPunctCode(text.charCodeAt(k + 1))) { d += text[k + 1]; k += 2; continue; }
        if (c === 62) { ok = true; break; }
        if (c === 60) break;
        d += text[k];
        k++;
      }
      if (!ok) return null;
      dest = d;
      j = k + 1;
    } else {
      let k = j;
      let d = '';
      let depth = 0;
      while (k < n) {
        const c = text.charCodeAt(k);
        if (c === 32 || c === 9 || c === 10 || c === 13) break;
        if (c < 32) break;
        if (c === 92 && k + 1 < n && isPunctCode(text.charCodeAt(k + 1))) { d += text[k + 1]; k += 2; continue; }
        if (c === 40) { depth++; d += text[k]; k++; continue; }
        if (c === 41) {
          if (depth === 0) break;
          depth--; d += text[k]; k++; continue;
        }
        d += text[k];
        k++;
      }
      // an empty destination is valid: `[link]()` and `[link](<>)`
      // both link to "" (cm-485/486); the closing-paren check below
      // still validates the overall shape
      dest = d;
      j = k;
    }
    let k = skipWS(text, j);
    let title = null;
    if (k < n) {
      const qc = text.charCodeAt(k);
      if (qc === 34 || qc === 39 || qc === 40) {
        const endQ = qc === 40 ? 41 : qc;
        let t = '';
        let m = k + 1;
        let ok = false;
        while (m < n) {
          const c = text.charCodeAt(m);
          if (c === 92 && m + 1 < n && isPunctCode(text.charCodeAt(m + 1))) { t += text[m + 1]; m += 2; continue; }
          if (c === endQ) { ok = true; break; }
          t += text[m];
          m++;
        }
        if (!ok) return null;
        title = t;
        k = skipWS(text, m + 1);
      }
    }
    if (k >= n || text.charCodeAt(k) !== 41) return null;
    return { href: dest, title, end: k + 1 };
  }
  // reference link
  let label;
  let end;
  if (i < n && text.charCodeAt(i) === 91) { // [
    let k = i + 1;
    let lab = '';
    let ok = false;
    while (k < n) {
      const c = text.charCodeAt(k);
      if (c === 92 && k + 1 < n) { lab += text[k] + text[k + 1]; k += 2; continue; }
      if (c === 93) { ok = true; break; }
      if (c === 91) return null;
      lab += text[k];
      k++;
    }
    if (!ok) return null;
    if (lab === '') label = normalizeLabel(text.slice(br.src + 1, i - 1));
    else label = normalizeLabel(lab);
    if (label === '') return null;
    end = k + 1;
  } else {
    label = normalizeLabel(text.slice(br.src + 1, i - 1));
    if (label === '') return null;
    end = i;
  }
  const ref = ctx.refs.get(label);
  if (!ref) return null;
  return { href: ref.href, title: ref.title, end };
}

// Resolve emphasis/delimiters in `parts` using the delimiter stack `delims`.
// bottomNode: a node object — only delimiters after it in parts are processed
// (null = process all). Mutates parts and delims.
function processEmphasis(parts, delims, brackets, bottomNode) {
  const bottomIdx = bottomNode ? parts.indexOf(bottomNode) : -1;
  // Scan closers FORWARD so inner delimiters resolve before outer ones:
  // for `*a ~~b~~ c*` the `~` closer (earlier in the stack) forms <del>
  // before the `*` closer forms <em> around it.
  let cur = 0;
  while (cur < delims.length) {
    const closer = delims[cur];
    if (!closer.active) { cur++; continue; }
    const cIdx = parts.indexOf(closer.node);
    if (cIdx <= bottomIdx) { cur++; continue; }
    if (!closer.close) { cur++; continue; }
    let op = cur - 1;
    let found = -1;
    while (op >= 0) {
      const o = delims[op];
      if (!o.active) { op--; continue; }
      const oIdx = parts.indexOf(o.node);
      if (oIdx <= bottomIdx) break;
      if (o.ch === closer.ch && o.open) {
        // '~' delimiters match only at equal length (single~single,
        // double~~double; no cross-matching), and the odd-match rule
        // does not apply to '~'
        if (closer.ch === '~') {
          if (o.len !== closer.len) { op--; continue; }
          found = op; break;
        }
        // Odd-match rule (CommonMark): if EITHER delimiter can both open
        // and close, the sum of the run lengths must not be a multiple of
        // 3 unless both lengths are multiples of 3.
        const canBoth = (o.open && o.close) || (closer.open && closer.close);
        const odd = canBoth && ((o.len + closer.len) % 3 === 0) && !(o.len % 3 === 0 && closer.len % 3 === 0);
        if (odd) { op--; continue; }
        // Blocking rule (probed): the inner closer IMMEDIATELY before this
        // closer, which could also open, whose inner opener could NOT
        // close, and whose run length + this opener's length is a multiple
        // of 3, blocks the match — e.g. `*a **b**c*` leaves the outer `*`
        // literal (2+1=3, inner opener `**` cannot close), while
        // `*foo**bar**baz*` forms it (inner opener `**` CAN close),
        // `*a *b*c*` (1+1=2), `*a **b** c*` (inner closer cannot open)
        // and `*a **b**c** d*` (another delimiter intervenes) all form it.
        let blocked = false;
        if (cur - 1 > op) {
          const e = delims[cur - 1];
          if (e.wasCloser && e.ch === closer.ch && e.matchOpen && !e.matchOpenerClose && ((e.matchLen + o.len) % 3 === 0)) blocked = true;
        }
        if (blocked) { op--; continue; }
        found = op; break;
      }
      op--;
    }
    if (found === -1) { cur++; continue; }
    const opener = delims[found];
    const use = closer.ch === '~' ? closer.len : (opener.len >= 2 && closer.len >= 2 ? 2 : 1);
    const oi = parts.indexOf(opener.node);
    const ci = parts.indexOf(closer.node);
    // record that this closer was used (for the blocking rule above)
    closer.wasCloser = true; closer.matchLen = closer.len; closer.matchOpen = closer.open; closer.matchOpenerClose = opener.close;
    // trim the delimiter runs: opener loses `use` chars from its end,
    // closer loses `use` chars from its start
    opener.node.s = opener.node.s.slice(0, opener.node.s.length - use);
    closer.node.s = closer.node.s.slice(use);
    opener.len -= use;
    closer.len -= use;
    // children = nodes strictly between opener and closer
    const children = parts.slice(oi + 1, ci);
    // delimiters/brackets inside the new node can no longer match outside it
    const inside = new Set(children);
    for (let d = 0; d < delims.length; d++) {
      const e = delims[d];
      if (e.active && e !== opener && e !== closer && inside.has(e.node)) e.active = false;
    }
    if (brackets) {
      for (let b = 0; b < brackets.length; b++) {
        const be = brackets[b];
        if (be.active && inside.has(be.node)) be.active = false;
      }
    }
    const kind = closer.ch === '~' ? 3 : (use === 2 ? 2 : 1);
    const node = { t: kind, c: children };
    const repl = [];
    if (opener.node.s !== '') repl.push(opener.node);
    repl.push(node);
    if (closer.node.s !== '') repl.push(closer.node);
    parts.splice(oi, ci - oi + 1, ...repl);
    if (opener.len === 0) opener.active = false;
    if (closer.len === 0) { closer.active = false; cur++; }
    // if the closer still has delimiters left, keep cur on it so it may
    // match another (earlier) opener
  }
}

// Trim the trailing end of a GFM extended autolink candidate (probed rules):
// trailing punctuation, unmatched/paren rules, partial entity tails.
function trimAutolink(s) {
  // (c) first: a '(' with no ')' after it anywhere -> cut from that '(' on
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s.charCodeAt(i) === 40) { // (
        let hasClose = false;
        for (let j = i + 1; j < s.length; j++) if (s.charCodeAt(j) === 41) { hasClose = true; break; }
        if (!hasClose) { s = s.slice(0, i); changed = true; break; }
      }
    }
  }
  while (s.length > 0) {
    const last = s.charCodeAt(s.length - 1);
    // (a) unmatched trailing ')'
    if (last === 41) {
      let open = 0, close = 0;
      for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) === 40) open++;
        else if (s.charCodeAt(i) === 41) close++;
      }
      if (close > open) { s = s.slice(0, -1); continue; }
      // (b) final ')' closes a '(' that itself contains a '('
      let depth = 0;
      let matchIdx = -1;
      for (let i = s.length - 1; i >= 0; i--) {
        const c = s.charCodeAt(i);
        if (c === 41) depth++;
        else if (c === 40) {
          depth--;
          if (depth === 0) { matchIdx = i; break; }
        }
      }
      if (matchIdx > 0) {
        let innerOpen = false;
        for (let i = matchIdx + 1; i < s.length - 1; i++) if (s.charCodeAt(i) === 40) { innerOpen = true; break; }
        if (innerOpen) { s = s.slice(0, -1); continue; }
      }
      break;
    }
    // trailing punctuation
    if (
      last === 33 || last === 63 || last === 46 || last === 44 || last === 58 || last === 59 ||
      last === 42 || last === 95 || last === 126 || last === 39 || last === 34
    ) { s = s.slice(0, -1); continue; }
    // trailing partial entity: ends with &... (no ';') where the & is preceded
    // by text, i.e. remove from the last '&' onward when what follows it is
    // alnum/# only and there is no ';' after it
    if (last === 38) { s = s.slice(0, -1); continue; }
    const amp = s.lastIndexOf('&');
    if (amp >= 0) {
      let tail = s.slice(amp + 1);
      if (/^[A-Za-z0-9#]+$/.test(tail) && s.indexOf(';', amp) === -1) { s = s.slice(0, amp); continue; }
    }
    break;
  }
  return s;
}

function isLabelChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95;
}

// Try to match a GFM extended autolink at text[i]. prev is the char before i
// (-1 at start). Returns {text, href, end} or null. ctx carries inLink state
// and the bracket stack (labels suppress autolinks).
function tryAutolink(text, i, prev, ctx) {
  const n = text.length;
  // preceding char must be start, whitespace, or * _ ~ ( < (probed: a GFM
  // autolink after a literal '<' still forms)
  if (!(prev === -1 || prev === 32 || prev === 9 || prev === 10 || prev === 42 || prev === 95 || prev === 126 || prev === 40 || prev === 60)) return null;
  if (ctx.inLink.v) return null;
  // autolinks are suppressed inside a link label — but only while that
  // label could still become a link. If the innermost active bracket's
  // label already contains a formed bracket link, the outer link can
  // never form (containsLink), so autolinks inside it ARE recognized
  // (probed doc-08: nested `[a [b](#to)](u)` autolinks the `u`).
  for (let b = ctx.brackets.length - 1; b >= 0; b--) {
    const br = ctx.brackets[b];
    if (!br.active) continue;
    if (ctx.parts) {
      const oi = ctx.parts.indexOf(br.node);
      if (oi >= 0 && containsLink(ctx.parts.slice(oi + 1))) continue;
    }
    return null;
  }
  const rest = text.slice(i);
  let m;
  // www. (indices are absolute into text, starting at i + 4)
  if (rest.startsWith('www.')) {
    // domain: labels of [A-Za-z0-9_-]+ separated by '.'
    let j = i + 4;
    let labels = 0;
    while (j < n) {
      let k = j;
      while (k < n && isLabelChar(text.charCodeAt(k))) k++;
      if (k === j) break;
      labels++;
      j = k;
      if (j < n && text.charCodeAt(j) === 46) { j++; continue; }
      break;
    }
    if (labels === 0) return null;
    // candidate: from i to the next whitespace / < / > / control char
    let end = j;
    while (end < n) {
      const c = text.charCodeAt(end);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 60 || c === 62 || c < 32) break;
      end++;
    }
    let link = trimAutolink(text.slice(i, end));
    if (link.length === 0) return null;
    return { text: link, href: 'http://' + link, end: i + link.length };
  }
  // scheme:// (trim trailing punctuation/parens BEFORE host validation,
  // so a URL in parens like (https://x) still validates)
  m = /^(https?|ftp):\/\/[^\s<>\x00-\x1f]+/i.exec(rest);
  if (m) {
    let link = trimAutolink(m[0]);
    if (link.length === 0) return null;
    // host: from after '://' up to the first / ? #
    const schemeEnd = link.indexOf('://') + 3;
    let hEnd = link.length;
    for (let k = schemeEnd; k < link.length; k++) {
      const ch = link[k];
      if (ch === '/' || ch === '?' || ch === '#') { hEnd = k; break; }
    }
    const host = link.slice(schemeEnd, hEnd);
    if (host.length === 0 || !/^[A-Za-z0-9._~%:@\-]+$/.test(host)) return null;
    return { text: link, href: link, end: i + link.length };
  }
  // mailto: — capture just the address (the regex stops at trailing junk
  // like `/` or `.`); a trailing `-` is part of the domain (invalid) and
  // a `_` right after means the word continues (gfm-632/633)
  m = /^mailto:([A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)+)/i.exec(rest);
  if (m) {
    const email = m[1];
    if (email.endsWith('-') || email.endsWith('_')) return null;
    const after = text[i + m[0].length];
    if (after === '_') {
      const hasUnderscoreOpener = ctx.delims && ctx.delims.some((d) => d.active && d.ch === '_' && d.open);
      if (!hasUnderscoreOpener) return null;
    }
    return { text: m[0], href: m[0], end: i + m[0].length };
  }
  // a `mailto:` prefix followed by something that is not a valid address
  // is not an autolink at all (do not fall through to bare-email inside it)
  if (/^mailto:/i.test(rest)) return null;
  // generic scheme + email autolink (e.g. `xmpp:foo@bar.baz`,
  // `xmpp:foo@bar.baz/txt`): scheme, email, and an optional single path
  // segment. The path is one segment only (`/txt/bin` links only `/txt`).
  m = /^([A-Za-z][A-Za-z0-9+.\-]{1,31}):([A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)+)(\/[^\s<>\/]+)?/i.exec(rest);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ftp' && scheme !== 'mailto') {
      const email = m[2];
      if (!email.endsWith('-') && !email.endsWith('_')) {
        let link = m[0];
        // trim trailing punctuation from the path (e.g. a trailing `.`)
        link = trimAutolink(link);
        const after = text[i + link.length];
        if (after === '_') {
          const hasUnderscoreOpener = ctx.delims && ctx.delims.some((d) => d.active && d.ch === '_' && d.open);
          if (!hasUnderscoreOpener) return null;
        }
        return { text: link, href: link, end: i + link.length };
      }
    }
  }
  // bare email
  m = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)+/.exec(rest);
  if (m) {
    const email = m[0];
    // the domain must end with an alphanumeric char: a trailing `-`
    // makes the address invalid; a `_` immediately after means the
    // "word" continues — UNLESS that `_` closes an open `_` emphasis
    // (e.g. `__a b@c.d__` links, but `a b@c.d_` does not) (gfm-632/633)
    if (email.endsWith('-') || email.endsWith('_')) return null;
    const after = text[i + email.length];
    if (after === '_') {
      const hasUnderscoreOpener = ctx.delims && ctx.delims.some((d) => d.active && d.ch === '_' && d.open);
      if (!hasUnderscoreOpener) return null;
    }
    return { text: email, href: 'mailto:' + email, end: i + email.length };
  }
  return null;
}

// Main inline parser. Returns an array of parts.
function inlineParse(text, ctx) {
  const parts = [];
  let cur = '';
  const delims = [];
  const brackets = [];
  const n = text.length;
  let i = 0;
  const flush = () => { if (cur !== '') { parts.push({ t: 0, s: cur }); cur = ''; } };

  while (i < n) {
    const c = text.charCodeAt(i);
    // newline: hard break if preceded by 2+ spaces or a backslash, else soft
    if (c === 10) {
      let trail = 0;
      for (let k = cur.length - 1; k >= 0 && cur.charCodeAt(k) === 32; k--) trail++;
      if (trail >= 2) {
        cur = cur.slice(0, cur.length - trail);
        flush();
        parts.push({ t: 8 });
        i++;
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
      } else {
        cur += '\n';
        i++;
      }
      continue;
    }
    // backslash
    if (c === 92) {
      if (i + 1 < n && text.charCodeAt(i + 1) === 10) {
        flush();
        parts.push({ t: 8 });
        i += 2;
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        continue;
      }
      if (i + 1 < n && isPunctCode(text.charCodeAt(i + 1))) {
        const ch = text[i + 1];
        cur += escInlineText(ch);
        i += 2;
        continue;
      }
      cur += '\\';
      i++;
      continue;
    }
    // backtick run -> code span
    if (c === 96) {
      let j = i;
      while (j < n && text.charCodeAt(j) === 96) j++;
      const m = j - i;
      let close = -1;
      let k = j;
      while (k < n) {
        if (text.charCodeAt(k) === 96) {
          let e = k;
          while (e < n && text.charCodeAt(e) === 96) e++;
          if (e - k === m) { close = k; break; }
          k = e;
        } else k++;
      }
      if (close === -1) { cur += '`'.repeat(m); i = j; continue; }
      let content = text.slice(j, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && !/^[ ]+$/.test(content)) {
        content = content.slice(1, -1);
      }
      flush();
      parts.push({ t: 6, s: content });
      i = close + m;
      continue;
    }
    // emphasis / strikethrough runs
    if (c === 42 || c === 95 || c === 126) {
      let j = i;
      while (j < n && text.charCodeAt(j) === c) j++;
      const m = j - i;
      const before = i > 0 ? text.charCodeAt(i - 1) : -1;
      const after = j < n ? text.charCodeAt(j) : -1;
      const [left, right] = flanking(before, after);
      let open, close;
      if (c === 95) {
        open = left && (!right || isUniPunctCode(before));
        close = right && (!left || isUniPunctCode(after));
      } else if (c === 126) {
        // strikethrough: only runs of 1-2 tildes form <del>; 3+ tildes
        // stay literal (gfm-493: `~~~not~~~` is not struck through)
        open = m <= 2 ? left : false;
        close = m <= 2 ? right : false;
      } else {
        open = left;
        close = right;
      }
      flush();
      const node = { t: 0, s: String.fromCharCode(c).repeat(m) };
      parts.push(node);
      delims.push({ ch: String.fromCharCode(c), len: m, open, close, node, active: true });
      i = j;
      continue;
    }
    // link / image opener
    if (c === 91 || (c === 33 && i + 1 < n && text.charCodeAt(i + 1) === 91)) {
      const isImg = c === 33;
      flush();
      const node = { t: 0, s: isImg ? '![' : '[' };
      parts.push(node);
      brackets.push({ node, img: isImg, src: isImg ? i + 1 : i, active: true });
      i += isImg ? 2 : 1;
      continue;
    }
    // link / image closer
    if (c === 93) {
      flush();
      let b = -1;
      for (let k = brackets.length - 1; k >= 0; k--) if (brackets[k].active) { b = k; break; }
      if (b === -1) { cur += ']'; i++; continue; }
      const br = brackets[b];
      let res = parseLinkTarget(text, i + 1, br, ctx);
      if (!res) {
        // If an inline link `(...)` is present but invalid, the bracket
        // can still form a shortcut reference link (cm-568:
        // `[foo](not a link)` -> `<a>foo</a>(not a link)`), leaving the
        // parenthesised text literal.
        if (i + 1 < n && text.charCodeAt(i + 1) === 40) {
          const label = normalizeLabel(text.slice(br.src + 1, i));
          const ref = label === '' ? null : ctx.refs.get(label);
          if (ref) res = { href: ref.href, title: ref.title, end: i + 1 };
        }
      }
      if (!res) { br.active = false; cur += ']'; i++; continue; }
      const oi = parts.indexOf(br.node);
      const children = parts.slice(oi + 1);
      // a link label may not contain a link: if it does, do not form this
      // link — the ']' is literal and the bracket is dropped (a later
      // shortcut reference like [options-20] can still form on its own)
      if (!br.img && containsLink(children)) {
        br.active = false;
        cur += ']';
        i++;
        continue;
      }
      // a link label may not contain a code span whose content includes
      // a backtick unless the span is the last thing in the label:
      // same treatment (the code span still renders), and the emphasis
      // delimiters inside the label are deactivated so
      // `_previous from ... _` stays literal too. These checks run
      // BEFORE processEmphasis, or the <em> would already be formed.
      if (!br.img && backtickCodeSpanBlocksLink(text.slice(br.src + 1, i))) {
        const inside = new Set(children);
        for (let d = 0; d < delims.length; d++) {
          const e = delims[d];
          if (e.active && inside.has(e.node)) e.active = false;
        }
        br.active = false;
        cur += ']';
        i++;
        continue;
      }
      // resolve emphasis inside the label first (bottom = the '[' node)
      processEmphasis(parts, delims, brackets, br.node);
      const children2 = parts.slice(parts.indexOf(br.node) + 1);
      const inside = new Set(children2);
      for (let d = 0; d < delims.length; d++) {
        const e = delims[d];
        if (e.active && inside.has(e.node)) e.active = false;
      }
      for (let k = 0; k < brackets.length; k++) {
        const be = brackets[k];
        if (be.active && inside.has(be.node)) be.active = false;
      }
      br.active = false;
      parts.splice(oi, parts.length - oi);
      if (br.img) {
        const alt = plainText(children2);
        parts.push({ t: 5, src: cleanUrl(res.href), alt, title: res.title == null ? null : escInlineText(res.title) });
      } else {
        parts.push({ t: 4, href: cleanUrl(res.href), title: res.title == null ? null : escInlineText(res.title), c: children2 });
      }
      i = res.end;
      continue;
    }
    // autolink / HTML tag
    if (c === 60) {
      // explicit autolink <scheme:...> or <email>
      let m = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]+)>/.exec(text.slice(i));
      if (m) {
        flush();
        parts.push({ t: 4, auto: true, href: cleanUrl(m[1], true), title: null, c: [{ t: 0, s: escInlineText(m[1]) }] });
        i += m[0].length;
        continue;
      }
      m = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)*)>/.exec(text.slice(i));
      if (m) {
        flush();
        parts.push({ t: 4, auto: true, href: 'mailto:' + cleanUrl(m[1], true), title: null, c: [{ t: 0, s: escInlineText(m[1]) }] });
        i += m[0].length;
        continue;
      }
      // HTML tag
      const tag = parseHtmlTag(text, i);
      if (tag) {
        flush();
        parts.push({ t: 7, s: tag.raw });
        // <a > state: doc-wide suppression of extended autolinks
        const low = tag.raw.toLowerCase();
        if (low.startsWith('<a ') || low === '<a ') ctx.inLink.v = true;
        else if (low.startsWith('</a') && (low.length === 3 || low.charCodeAt(3) === 62 || low.charCodeAt(3) === 32 || low.charCodeAt(3) === 9 || low.charCodeAt(3) === 47)) ctx.inLink.v = false;
        i = tag.end;
        continue;
      }
      cur += '&lt;';
      i++;
      continue;
    }
    // entity / ampersand
    if (c === 38) {
      const dec = decodeNumericRef(text, i);
      if (dec) { cur += escInlineText(dec.ch); i = dec.end; continue; }
      const nm = /^&[A-Za-z][A-Za-z0-9]{0,31};/.exec(text.slice(i));
      if (nm) { cur += nm[0]; i += nm[0].length; continue; }
      cur += '&amp;';
      i++;
      continue;
    }
    // GFM extended autolink: www/scheme/mailto start at w/h/f/m, but a bare
    // email local part can start at ANY letter — scan ahead for '@' in the
    // word (bounded) and only then attempt it
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      let tryIt = false;
      if (c === 119 || c === 104 || c === 72 || c === 102 || c === 70 || c === 109 || c === 77) tryIt = true;
      else if (i === 0 || text.charCodeAt(i - 1) === 32 || text.charCodeAt(i - 1) === 9 || text.charCodeAt(i - 1) === 10 || text.charCodeAt(i - 1) === 42 || text.charCodeAt(i - 1) === 95 || text.charCodeAt(i - 1) === 126 || text.charCodeAt(i - 1) === 40) {
        let k = i;
        while (k < n) {
          const cc = text.charCodeAt(k);
          if (cc === 32 || cc === 9 || cc === 10 || cc === 60 || cc === 62 || cc < 32) break;
          if (cc === 64) { tryIt = true; break; }
          k++;
        }
      }
      if (tryIt) {
        ctx.brackets = brackets;
        ctx.delims = delims;
        ctx.parts = parts;
        const prev = i > 0 ? text.charCodeAt(i - 1) : -1;
        const al = tryAutolink(text, i, prev, ctx);
        if (al) {
          flush();
          parts.push({ t: 4, auto: true, href: cleanUrl(al.href, true), title: null, c: [{ t: 0, s: escInlineText(al.text) }] });
          i = al.end;
          continue;
        }
      }
    }
    // plain char
    cur += escInlineText(text[i]);
    i++;
  }
  flush();
  processEmphasis(parts, delims, brackets, null);
  return parts;
}

// ---------- block parsing ----------
// Column-aware line helpers. A tab advances the column to the next multiple of 4.

function lineIndent(line) {
  // columns of leading whitespace + index of first non-whitespace char
  let col = 0;
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line.charCodeAt(i);
    if (ch === 32) { col++; i++; }
    else if (ch === 9) { col = ((col >> 2) + 1) << 2; i++; }
    else break;
  }
  return { cols: col, index: i };
}

function stripColumns(line, cols) {
  // Remove `cols` columns of leading whitespace. Returns the stripped line
  // (leading whitespace expanded to spaces), or null if the line's leading
  // whitespace is fewer than `cols` columns.
  const { cols: total, index } = lineIndent(line);
  if (total < cols) return null;
  return ' '.repeat(total - cols) + line.slice(index);
}

// Remove `cols` columns of leading whitespace for CODE BLOCK content:
// consume spaces/tabs from the start (a partially-consumed tab leaves
// spaces), but keep the REST of the line literal — a tab that lies beyond
// the stripped indent stays a literal tab in the output (probed: a code
// line `    \tfoo` renders as `\tfoo`, not `    foo`).
function stripCodeIndent(line, cols) {
  let col = 0;
  let i = 0;
  const n = line.length;
  let prefix = '';
  while (i < n && col < cols) {
    const ch = line.charCodeAt(i);
    if (ch === 32) { col++; i++; }
    else if (ch === 9) {
      const next = ((col >> 2) + 1) << 2;
      if (next <= cols) { col = next; i++; }
      else { prefix = ' '.repeat(next - cols); col = cols; i++; }
    } else break;
  }
  if (col < cols) return null;
  return prefix + line.slice(i);
}

// Fenced-code variant: strip up to N leading whitespace CHARACTERS
// (a space or a tab counts as 1 each), stopping at the first
// non-whitespace character. Probed: N=2, `\t\ta` -> `a` (2 tabs),
// N=1, `\t\ta` -> `\ta` (1 tab), N=2, `\t a` -> `a`, N=3,
// `    a` -> ` a`. A line with less indent than the fence loses all
// of its leading whitespace (the loop stops at non-whitespace).
function stripFenceIndent(line, cols) {
  let i = 0;
  while (i < cols && i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return line.slice(i);
}

function stripBlockquote(line) {
  // If the line starts a blockquote marker (<=3 leading spaces + '>'),
  // return the content line. Else null.
  const n = line.length;
  let i = 0;
  let col = 0;
  while (i < n && line.charCodeAt(i) === 32) { col++; i++; }
  if (col > 3) return null;
  if (i >= n || line.charCodeAt(i) !== 62) return null;
  i++; col++;
  let contentIndent = col;
  let prefixEndCol = col;
  let prefixEndIndex = i;
  if (i < n && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) {
    contentIndent = col + 1;
    if (line.charCodeAt(i) === 32) { prefixEndCol = col + 1; prefixEndIndex = i + 1; }
    else { prefixEndCol = ((col >> 2) + 1) << 2; prefixEndIndex = i + 1; }
  }
  let c2 = prefixEndCol;
  let j = prefixEndIndex;
  while (j < n) {
    const ch = line.charCodeAt(j);
    if (ch === 32) { c2++; j++; }
    else if (ch === 9) { c2 = ((c2 >> 2) + 1) << 2; j++; }
    else break;
  }
  return ' '.repeat(Math.max(0, c2 - contentIndent)) + line.slice(j);
}

function listMarker(line) {
  // Detect a list marker at the start of the line (<=3 leading spaces).
  // Returns {markerLen, ordered, start, delim, bullet, contentIndent,
  // contentStartIndex, contentStartCol, empty} or null.
  const n = line.length;
  let i = 0;
  let col = 0;
  while (i < n && line.charCodeAt(i) === 32) { col++; i++; }
  if (col > 3 || i >= n) return null;
  const c = line.charCodeAt(i);
  let markerLen = 0;
  let ordered = false;
  let start = 1;
  let delim = null;
  let bullet = null;
  if (c === 45 || c === 43 || c === 42) {
    markerLen = 1;
    bullet = line.charAt(i);
  } else if (c >= 48 && c <= 57) {
    let j = i;
    let num = 0;
    let digits = 0;
    while (j < n && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57 && digits < 9) {
      num = num * 10 + (line.charCodeAt(j) - 48);
      digits++;
      j++;
    }
    if (digits === 0) return null;
    if (j >= n || (line.charCodeAt(j) !== 46 && line.charCodeAt(j) !== 41)) return null;
    markerLen = digits + 1;
    ordered = true;
    start = num;
    delim = line.charAt(j);
  } else return null;
  const afterMarker = i + markerLen;
  if (afterMarker >= n) {
    return { markerLen, ordered, start, delim, bullet, contentIndent: col + markerLen + 1, contentStartIndex: afterMarker, contentStartCol: col + markerLen, empty: true, leadCols: col };
  }
  const sc = line.charCodeAt(afterMarker);
  if (sc !== 32 && sc !== 9) return null;
  let sepCol = col + markerLen;
  let j = afterMarker;
  while (j < n && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) {
    if (line.charCodeAt(j) === 32) sepCol++;
    else sepCol = ((sepCol >> 2) + 1) << 2;
    j++;
  }
  const sepWidth = sepCol - (col + markerLen);
  let contentIndent;
  if (j >= n) contentIndent = col + markerLen + 1;
  else if (sepWidth >= 5) contentIndent = col + markerLen + 1;
  else contentIndent = col + markerLen + sepWidth;
  return { markerLen, ordered, start, delim, bullet, contentIndent, contentStartIndex: j, contentStartCol: sepCol, empty: j >= n, leadCols: col };
}

function stripListFirstLine(line, m) {
  // Content of a list item's first line, after the marker + separator.
  let c2 = m.contentStartCol;
  let j = m.contentStartIndex;
  const n = line.length;
  while (j < n) {
    const ch = line.charCodeAt(j);
    if (ch === 32) { c2++; j++; }
    else if (ch === 9) { c2 = ((c2 >> 2) + 1) << 2; j++; }
    else break;
  }
  return ' '.repeat(Math.max(0, c2 - m.contentIndent)) + line.slice(j);
}

// ---------- HTML blocks ----------
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Closing tag for a raw-text element (script/pre/style/textarea): unlike
// other block-tag closes, it does NOT interrupt a paragraph (probed).
function isRawCloseTag(line) {
  const { cols, index } = lineIndent(line);
  if (cols > 3) return false;
  return /^<\/(script|pre|style|textarea)(\s|\/|>|$)/i.test(line.slice(index));
}

function htmlBlockStart(line) {
  // line: content after container stripping, with leading spaces counted.
  // Returns {type, endRe} or null. Types 1-5 end on a line containing endRe;
  // types 6-7 end at a blank line.
  const { cols, index } = lineIndent(line);
  if (cols > 3) return null;
  const s = line.slice(index);
  const low = s.toLowerCase();
  if (/^<(script|pre|style|textarea)(\s|\/|>|$)/.test(low)) {
    const tag = low.match(/^<(script|pre|style|textarea)/)[1];
    return { type: 1, endRe: new RegExp('</' + tag + '\\s*>', 'i') };
  }
  if (low.startsWith('<!--')) return { type: 2, endRe: /-->/ };
  if (low.startsWith('<?')) return { type: 3, endRe: /\?>/ };
  if (/^<![a-z]/i.test(s)) return { type: 4, endRe: />/ };
  if (low.startsWith('<![cdata[')) return { type: 5, endRe: /\]\]>/ };
  // type 6: block-level tag (open or close), possibly with attributes
  let m = /^<\/?([a-z][a-z0-9-]*)([\s\/>]|$)/i.exec(s);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return { type: 6, endRe: null };
  // type 7: any complete open/close tag that is not a void element,
  // ALONE on the line (followed only by whitespace). The tag must have
  // VALID attributes (spec regex) — `<a h*#ref="hi">` and
  // `<a href='bar'title=title>` are not tags (cm-619/622) — and a close
  // tag has NO attributes (`</a href="foo">` is not a tag, cm-624).
  m = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/.exec(s) || /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/.exec(s);
  if (m && s.slice(m[0].length).trim() === '') {
    const name = s.slice(1).replace(/^\//, '').match(/^[A-Za-z][A-Za-z0-9-]*/)[0].toLowerCase();
    if (!VOID_ELEMENTS.has(name)) return { type: 7, endRe: null };
  }
  return null;
}

// Parse an HTML tag starting at text[i] ('<'). Returns {raw, end} or null.
// Single-line only; no newline inside.
function parseHtmlTag(text, i) {
  const n = text.length;
  const rest = text.slice(i);
  // HTML tags MAY span newlines (cm-615: `<b2\ndata="foo" >` is a tag).
  // The `<a` suppression rule is about a literal SPACE after `<a`, not
  // about newlines.
  let m = /^<!-->|^<!--->|^<!--(?:(?!-->)[\s\S])*?-->/.exec(rest);
  if (m) return { raw: m[0], end: i + m[0].length };
  m = /^<\?(?:(?!\?>)[\s\S])*?\?>/.exec(rest);
  if (m) return { raw: m[0], end: i + m[0].length };
  m = /^<![A-Z]+\s[^>]*>/.exec(rest);
  if (m) return { raw: m[0], end: i + m[0].length };
  m = /^<!\[CDATA\[(?:(?!\]\]>)[\s\S])*?\]\]>/.exec(rest);
  if (m) return { raw: m[0], end: i + m[0].length };
  // open / close tag — CommonMark spec regex. A CLOSE tag has NO
  // attributes (`</a href="foo">` is not a tag, cm-624); an open tag's
  // attribute names are [A-Za-z_:][A-Za-z0-9_.:-]*, values are unquoted
  // (no space " ' = < > `), single-quoted, or double-quoted, and a
  // quoted value may contain `>` (cm-616/619-622).
  m = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/.exec(rest);
  if (m) return { raw: m[0], end: i + m[0].length };
  m = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/.exec(rest);
  if (m) {
    return { raw: m[0], end: i + m[0].length };
  }
  return null;
}

// ---------- reference definitions ----------
// Parse a link reference definition starting at lines[i]. The label and the
// title may each span multiple lines. Returns {label, href, title,
// consumed} or null. consumed = number of lines used.
function parseRefDef(lines, i) {
  const first = lines[i];
  const { cols, index } = lineIndent(first);
  if (cols > 3) return null;
  let s = first.slice(index);
  // [label]: — the label may span lines; track where ']' lands
  if (s.charCodeAt(0) !== 91) return null;
  let lab = '';
  let ok = false;
  let labelEndLine = i;
  let labelEndPos = -1;
  let curLine = s;
  let curIdx = 1;
  let lineNo = i;
  while (true) {
    while (curIdx < curLine.length) {
      const c = curLine.charCodeAt(curIdx);
      if (c === 92 && curIdx + 1 < curLine.length) { lab += curLine[curIdx] + curLine[curIdx + 1]; curIdx += 2; continue; }
      if (c === 93) { ok = true; labelEndLine = lineNo; labelEndPos = curIdx + 1; break; }
      if (c === 91) return null;
      lab += curLine[curIdx];
      curIdx++;
    }
    if (ok) break;
    // end of line without ']': the label continues on the next line
    if (lineNo + 1 >= lines.length) return null;
    const nextLine = lines[lineNo + 1];
    if (isBlank(nextLine)) return null;
    lab += '\n';
    lineNo++;
    curLine = nextLine;
    curIdx = 0;
  }
  if (!ok) return null;
  const label = normalizeLabel(lab);
  if (label === '') return null;
  // the ':' and destination start on the line where ']' landed; curLine
  // is that line (stripped of leading indent only for the first line)
  let consumed = labelEndLine - i + 1;
  let s2 = curLine.slice(labelEndPos);
  let k = 0;
  // ':' then optional whitespace
  while (k < s2.length && (s2.charCodeAt(k) === 32 || s2.charCodeAt(k) === 9)) k++;
  if (k >= s2.length || s2.charCodeAt(k) !== 58) return null;
  k++;
  while (k < s2.length && (s2.charCodeAt(k) === 32 || s2.charCodeAt(k) === 9)) k++;
  // destination: <...> or bare (no spaces, no control chars), or on the next line
  let dest = null;
  let rest = s2.slice(k);
  if (rest === '') {
    if (labelEndLine + 1 >= lines.length) return null;
    const next = lines[labelEndLine + 1];
    if (isBlank(next)) return null;
    // continuation line: any indent allowed, strip leading whitespace
    const ni = lineIndent(next);
    rest = next.slice(ni.index);
    consumed++;
  }
  if (rest.charCodeAt(0) === 60) {
    // <...>
    let d = '';
    let q = 1;
    let good = false;
    while (q < rest.length) {
      const c = rest.charCodeAt(q);
      if (c === 10) break;
      if (c === 92 && q + 1 < rest.length && isPunctCode(rest.charCodeAt(q + 1))) { d += rest[q + 1]; q += 2; continue; }
      if (c === 62) { good = true; break; }
      if (c === 60) break;
      d += rest[q];
      q++;
    }
    if (!good) return null;
    dest = d;
    rest = rest.slice(q + 1);
  } else {
    let d = '';
    let q = 0;
    let depth = 0;
    while (q < rest.length) {
      const c = rest.charCodeAt(q);
      if (c === 32 || c === 9 || c === 10 || c === 13) break;
      if (c < 32) break;
      if (c === 92 && q + 1 < rest.length && isPunctCode(rest.charCodeAt(q + 1))) { d += rest[q + 1]; q += 2; continue; }
      if (c === 40) { depth++; d += rest[q]; q++; continue; }
      if (c === 41) {
        if (depth === 0) break;
        depth--; d += rest[q]; q++; continue;
      }
      d += rest[q];
      q++;
    }
    if (d === '') return null;
    dest = d;
    rest = rest.slice(q);
  }
  // the destination must be followed by whitespace (or end of line) —
  // a title glued to it (e.g. `<bar>(baz)`) makes the definition invalid
  if (rest.length > 0 && rest.charCodeAt(0) !== 32 && rest.charCodeAt(0) !== 9) return null;
  // optional title: on the same line, the next line, or spanning lines
  let title = null;
  let t = rest;
  let ti = 0;
  while (ti < t.length && (t.charCodeAt(ti) === 32 || t.charCodeAt(ti) === 9)) ti++;
  if (ti < t.length) {
    const qc = t.charCodeAt(ti);
    if (qc === 34 || qc === 39 || qc === 40) {
      const endQ = qc === 40 ? 41 : qc;
      // the title may span lines: scan this line then following lines
      let tv = '';
      let good = false;
      let tline = t.slice(ti + 1);
      let extra = 0;
      while (true) {
        let q = 0;
        let found = false;
        while (q < tline.length) {
          const c = tline.charCodeAt(q);
          if (c === 92 && q + 1 < tline.length && isPunctCode(tline.charCodeAt(q + 1))) { tv += tline[q + 1]; q += 2; continue; }
          if (c === endQ) { good = true; found = true; break; }
          tv += tline[q];
          q++;
        }
        if (found) { t = tline.slice(q + 1); break; }
        // no closing quote on this line: continue on the next line
        // (a blank line ends the title — it cannot span one)
        if (i + consumed + extra >= lines.length) return null;
        const nl = lines[i + consumed + extra];
        if (isBlank(nl)) return null;
        tv += '\n';
        extra++;
        tline = nl;
      }
      if (!good) return null;
      title = tv;
      consumed += extra;
    } else return null;
  } else if (i + consumed < lines.length && !isBlank(lines[i + consumed])) {
    // title on the next line (after the label line or the destination line)
    const next = lines[i + consumed];
    const ni = lineIndent(next);
    const nt = next.slice(ni.index);
    const qc = nt.charCodeAt(0);
    if (qc === 34 || qc === 39 || qc === 40) {
      const endQ = qc === 40 ? 41 : qc;
      let tv = '';
      let good = false;
      let tline = nt.slice(1);
      let extra = 0;
      let after = '';
      while (true) {
        let q = 0;
        let found = false;
        while (q < tline.length) {
          const c = tline.charCodeAt(q);
          if (c === 92 && q + 1 < tline.length && isPunctCode(tline.charCodeAt(q + 1))) { tv += tline[q + 1]; q += 2; continue; }
          if (c === endQ) { good = true; found = true; break; }
          tv += tline[q];
          q++;
        }
        if (found) { after = tline.slice(q + 1); break; }
        if (i + consumed + 1 + extra >= lines.length) break;
        const nl = lines[i + consumed + 1 + extra];
        tv += '\n';
        extra++;
        tline = nl;
      }
      if (good && after.trim() === '') { title = tv; consumed += 1 + extra; t = ''; }
    }
  }
  // nothing but whitespace may follow the title
  if (t.trim() !== '') return null;
  return { label, href: dest, title, consumed };
}

function isBlank(line) {
  return /^[ \t]*$/.test(line);
}

// Thematic break: 0-3 leading spaces, then 3+ of the same * - _ char,
// each optionally followed by spaces/tabs.
function isHrLine(text) {
  const { cols, index } = lineIndent(text);
  if (cols > 3) return false;
  const s = text.slice(index);
  return /^(\*\s*){3,}$/.test(s) || /^(-\s*){3,}$/.test(s) || /^(_\s*){3,}$/.test(s);
}

// ---------- main block parser ----------
// lines: array of {text, lazy}. Returns {blocks, next} — next is the index
// of the first unconsumed line (only < lines.length when a lazy line ends
// the container because no paragraph is open).
function parseBlocks(lines, ctx, opts) {
  const strip4 = !!(opts && opts.strip4);
  const isTop = !opts || opts.isTop === true;
  const blocks = [];
  let i = 0;
  const n = lines.length;
  let para = null; // array of text lines, or null
  let paraLastLazy = false; // the last line added to the paragraph was lazy
  let loose = false; // a blank line separates two blocks in this container
  let sawBlank = false;
  function addBlock(b) {
    if (sawBlank && blocks.length > 0) loose = true;
    sawBlank = false;
    blocks.push(b);
  }

  function closePara() {
    if (para && para.length > 0) addBlock({ kind: 'para', text: para.join('\n') });
    para = null;
    paraLastLazy = false;
  }

  // text of a paragraph-continuation line (list items strip a code indent)
  function paraLineText(lineObj) {
    if (lineObj.lazy) {
      const { cols } = lineIndent(lineObj.text);
      if (cols >= 4) return stripColumns(lineObj.text, 4);
      return lineObj.text;
    }
    if (strip4) {
      const { cols } = lineIndent(lineObj.text);
      if (cols >= 4) return stripColumns(lineObj.text, 4);
    }
    return lineObj.text;
  }

  // Can this line interrupt a paragraph? (checked on the container-stripped line)
  // Does this line start a new block (list, heading, hr, fence, HTML
  // block)? Used to end a table body: any block start ends the table.
  function startsBlock(text) {
    const { cols, index } = lineIndent(text);
    if (cols > 3) return false;
    const s = text.slice(index);
    if (/^#{1,6}(\s|$)/.test(s)) return true;
    const fm = /^(`{3,}|~{3,})(.*)$/.exec(s);
    if (fm && !(fm[1].charAt(0) === '`' && fm[2].includes('`'))) return true;
    if (isHrLine(text)) return true;
    if (htmlBlockStart(text)) return true;
    if (listMarker(text)) return true;
    return false;
  }

  function interruptsPara(text) {
    const { cols, index } = lineIndent(text);
    if (cols > 3) return false;
    const s = text.slice(index);
    if (/^#{1,6}(\s|$)/.test(s)) return true;
    // a fence line interrupts — but a BACKTICK fence whose info string
    // contains a backtick is not a fence at all (probed doc-05/21:
    // ` ```inner backticks``` ` is a code span inside the paragraph)
    const fm = /^(`{3,}|~{3,})(.*)$/.exec(s);
    if (fm && !(fm[1].charAt(0) === '`' && fm[2].includes('`'))) return true;
    if (/^(\*\s*){3,}$/.test(s) || /^(-\s*){3,}$/.test(s) || /^(_\s*){3,}$/.test(s)) return true;
    // only HTML block types 1-5 can interrupt a paragraph (6-7 cannot),
    // except a type-6 block-tag close (not a raw-text close) CAN interrupt
    const hb = htmlBlockStart(text);
    if (hb && hb.type <= 5) return true;
    if (hb && hb.type === 6 && !isRawCloseTag(text)) return true;
    // a list marker interrupts a paragraph only if the item is non-empty;
    // an ORDERED list interrupts a top-level paragraph only when it starts
    // with 1 (cm-304); inside a list item / blockquote a nested list may
    // start with any number (probed: `- foo\n  14. bar` nests)
    const lm = listMarker(text);
    if (lm && !lm.empty && (!lm.ordered || lm.start === 1 || !opts.isTop)) return true;
    if (stripBlockquote(text) !== null) return true;
    return false;
  }

  function isSetext(text) {
    const { cols, index } = lineIndent(text);
    if (cols > 3) return 0;
    const s = text.slice(index).trim();
    if (/^=+\s*$/.test(s)) return 1;
    if (/^-+\s*$/.test(s)) return 2;
    return 0;
  }

  // Table delimiter row? Returns aligns array or null.
  function tableDelim(text, headerCells) {
    const { cols, index } = lineIndent(text);
    if (cols > 3) return null;
    let s = text.slice(index).trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    const cells = s.split('|').map((c) => c.trim());
    if (cells.length !== headerCells.length) return null;
    const aligns = [];
    for (const c of cells) {
      if (/^:?-+:?$/.test(c)) {
        if (c.startsWith(':') && c.endsWith(':')) aligns.push('center');
        else if (c.endsWith(':')) aligns.push('right');
        else if (c.startsWith(':')) aligns.push('left');
        else aligns.push(null);
      } else return null;
    }
    return aligns;
  }

  function splitRow(text) {
    let s = text.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    // split on unescaped |; an escaped \| becomes a literal | in the cell
    const cells = [];
    let cur = '';
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (ch === '\\' && k + 1 < s.length) {
        if (s[k + 1] === '|') { cur += '|'; k++; continue; }
        cur += s[k] + s[k + 1]; k++; continue;
      }
      if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  }

  while (i < n) {
    const lineObj = lines[i];
    const text = lineObj.text;

    // lazy line: only a paragraph continuation; otherwise the container ends
    if (lineObj.lazy) {
      if (para) {
        let t = paraLineText(lineObj);
        // a lazy setext `===` underline following another lazy line is padded
        // with spaces to 4 columns (so it cannot be read as a heading
        // underline); a leading tab is left literal
        if (paraLastLazy && /^=+[ \t]*$/.test(t.trim()) && /^[ ]*$/.test(t.slice(0, t.length - t.trimStart().length)) && t.length - t.trimStart().length < 4) {
          const lead = t.length - t.trimStart().length;
          t = ' '.repeat(4 - lead) + t.slice(lead);
        }
        para.push(t);
        paraLastLazy = true;
        i++;
        continue;
      }
      break;
    }

    if (isBlank(text)) {
      // a trailing whitespace-only line at the end of a container is kept
      // as a paragraph continuation (its spaces are paragraph content),
      // not a blank line (probed: `> foo\n>  ` keeps the space, while a
      // top-level `foo\n ` line does not)
      if (para && !isTop && i === n - 1 && text.length > 0) {
        para.push(text);
        i++;
        continue;
      }
      closePara(); sawBlank = true; i++; continue;
    }

    // setext heading (paragraph open, line is === or ---)
    if (para) {
      const lv = isSetext(text);
      if (lv > 0) {
        const htext = para.join('\n').trim();
        para = null;
        addBlock({ kind: 'heading', level: lv, text: htext });
        i++;
        continue;
      }
      // table: paragraph has exactly 1 line and this line is a delimiter row
      if (para.length === 1) {
        const headerCells = splitRow(para[0]);
        const aligns = tableDelim(text, headerCells);
        if (aligns) {
          const header = headerCells;
          const rows = [];
          i++;
          // a body row is any non-blank line that does not start a
          // different block (a `> ` blockquote ends the table, gfm-201);
          // a row without a pipe is a single cell, padded (gfm-202). A
          // line of ONLY tabs is an empty row (probed); a spaces-only or
          // truly empty line ends the table. A line starting a list,
          // heading, hr or fence also ends the table (doc-07: `* Lexer`
          // after a table is a list item, not a row).
          while (i < n && (!isBlank(lines[i].text) || /^\t+$/.test(lines[i].text)) && !lines[i].lazy && stripBlockquote(lines[i].text) === null && !startsBlock(lines[i].text)) {
            if (/^\t+$/.test(lines[i].text)) {
              rows.push(new Array(header.length).fill(''));
              i++;
              continue;
            }
            const rc = splitRow(lines[i].text);
            while (rc.length < header.length) rc.push('');
            rows.push(rc.slice(0, header.length));
            i++;
          }
          addBlock({ kind: 'table', header, aligns, rows });
          para = null;
          continue;
        }
      }
    }

    // reference definition (only at a paragraph start)
    if (!para) {
      const rd = parseRefDef(lines.map((l) => l.text), i);
      if (rd) {
        if (!ctx.refs.has(rd.label)) ctx.refs.set(rd.label, { href: rd.href, title: rd.title });
        // a ref def is a block: a blank line before it makes the
        // container loose (cm-317: ref def between list items)
        if (sawBlank && blocks.length > 0) loose = true;
        sawBlank = false;
        i += rd.consumed;
        continue;
      }
    }

    // if a paragraph is open and this line can interrupt it, close it first
    if (para && interruptsPara(text)) closePara();

    const { cols, index } = lineIndent(text);
    const s = text.slice(index);

    // ATX heading
    if (cols <= 3 && s.charCodeAt(0) === 35) {
      const m = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(s);
      if (m) {
        let h = m[2] || '';
        h = h.replace(/[ \t]+$/, '');
        if (/^#+$/.test(h)) h = '';
        else h = h.replace(/[ \t]+#+$/, '');
        addBlock({ kind: 'heading', level: m[1].length, text: h });
        i++;
        continue;
      }
    }

    // fenced code
    if (cols <= 3) {
      const fm = /^(`{3,}|~{3,})(.*)$/.exec(s);
      if (fm) {
        const fence = fm[1];
        const info = fm[2].trim();
        if (fence.charAt(0) === '`' && info.includes('`')) {
          // backtick fence with a backtick in the info string: not a fence
        } else {
          const content = [];
          i++;
          while (i < n) {
            const lobj = lines[i];
            const lt = lobj.text;
            // a lazy line ends the fence only while the fence is still
            // EMPTY (no content yet) — once the fence has a non-lazy
            // content line, lazy lines are fence content (probed: list
            // `- ```css\n  a\nb\n  ``` ` keeps `b`; list2 `- ```\nfoo\n`
            // is an empty fence, `foo` exits the list; cm-237 blockquote
            // `> ```\nfoo` is an empty fence, `foo` exits the quote)
            // a lazy line ends the fence while it is still EMPTY, or
            // when the fence is NOT inside a list item. Inside a list
            // item, a lazy line after the fence already has content IS
            // fence content (probed `- ```css\n  a\nb\n` keeps `b`); in a
            // blockquote or at top level a lazy line ends the fence even
            // with content (doc-01/03/14/34)
            if (lobj.lazy && (content.length === 0 || !opts.inList)) break;
            {
              const li = lineIndent(lt);
              if (li.cols <= 3) {
                const ls = lt.slice(li.index);
                const cm = /^(`{3,}|~{3,})[ \t]*$/.exec(ls);
                if (cm && cm[1].charAt(0) === fence.charAt(0) && cm[1].length >= fence.length) {
                  i++;
                  break;
                }
              }
            }
            let ct = lt;
            {
              // fenced code strips up to the fence indent in whitespace
              // characters (a tab counts as 1); a line with less indent
              // loses all of its leading whitespace
              ct = stripFenceIndent(lt, cols);
            }
            content.push(ct);
            i++;
          }
          // a fenced code block drops exactly one trailing blank line,
          // but only a truly empty line — a whitespace-only line is
          // content and is kept (probed cm-129: `  ` stays)
          if (content.length && content[content.length - 1] === '') content.pop();
          addBlock({ kind: 'fence', text: content.join('\n') + (content.length ? '\n' : ''), info });
          continue;
        }
      }
    }

    // thematic break
    if (cols <= 3 && isHrLine(text)) {
      addBlock({ kind: 'hr' });
      i++;
      continue;
    }

    // HTML block (types 6-7 cannot interrupt a paragraph, except a type-6
    // block-tag close other than a raw-text close, which CAN)
    if (cols <= 3) {
      const hb = htmlBlockStart(text);
      const canInterrupt = !!hb && (hb.type <= 5 || (hb.type === 6 && !isRawCloseTag(text)));
      if (hb && (!para || canInterrupt)) {
        const hlines = [];
        if (hb.type <= 5) {
          while (i < n) {
            const lt = lines[i].text;
            hlines.push(lt);
            i++;
            if (hb.endRe.test(lt)) break;
          }
          // trailing newline: dropped when the block is followed by a blank
          // line, or when it ends at a container boundary (only a true
          // document-EOF end keeps it)
          const trail = (i < n && isBlank(lines[i].text)) ? '' : (i >= n ? (isTop ? '\n' : '') : '\n');
          addBlock({ kind: 'html', text: hlines.join('\n') + trail });
        } else {
          while (i < n && !isBlank(lines[i].text)) {
            hlines.push(lines[i].text);
            i++;
          }
          addBlock({ kind: 'html', text: hlines.join('\n') + (i >= n && isTop ? '\n' : '') });
        }
        continue;
      }
    }

    // indented code (only when no paragraph is open)
    if (!para && cols >= 4) {
      const clines = [];
      while (i < n) {
        const lobj = lines[i];
        if (lobj.lazy) break;
        if (isBlank(lobj.text)) {
          // a blank line ends the code block unless the next line is also code
          let j = i + 1;
          while (j < n && isBlank(lines[j].text)) j++;
          if (j < n && !lines[j].lazy && lineIndent(lines[j].text).cols >= 4) {
            // blank line inside the code block: strip the 4-column code indent
            const bc = stripCodeIndent(lobj.text, 4);
            clines.push(bc === null ? '' : bc);
            i++;
            continue;
          }
          break;
        }
        const stripped = stripCodeIndent(lobj.text, 4);
        if (stripped === null) break;
        clines.push(stripped);
        i++;
      }
      while (clines.length > 0 && clines[clines.length - 1] === '') clines.pop();
      addBlock({ kind: 'code', text: clines.join('\n') + '\n' });
      continue;
    }

    // blockquote
    if (cols <= 3 && stripBlockquote(text) !== null) {
      closePara();
      // gather the blockquote's lines
      const sub = [];
      let j = i;
      let startIdx = i;
      while (j < n) {
        const lobj = lines[j];
        const lt = lobj.text;
        if (isBlank(lt)) {
          // a truly-blank line (no '>') ENDS the blockquote; a following
          // '>' line starts a NEW blockquote (probed). Only a '>'-prefixed
          // blank line (handled by stripBlockquote below) continues it.
          break;
        }
        const stripped = stripBlockquote(lt);
        if (stripped !== null) { sub.push({ text: stripped, lazy: false }); j++; continue; }
        // lazy line: include only if it does not start a new block
        if (interruptsPara(lt) && !para) { break; }
        // a lazy line is a paragraph continuation candidate; include it raw
        // (it will end the blockquote at parse time if no paragraph is open)
        sub.push({ text: lt, lazy: true });
        j++;
      }
      const res = parseBlocks(sub, ctx, { strip4: false });
      addBlock({ kind: 'blockquote', blocks: res.blocks });
      // advance the outer index by the number of lines the inner parse consumed
      i = startIdx + res.next;
      continue;
    }

    // list
    const lm = cols <= 3 ? listMarker(text) : null;
    // an empty list item cannot interrupt a paragraph: it stays a
    // paragraph continuation line; an ordered list interrupts a top-level
    // paragraph only when it starts with 1 (cm-304); nested lists inside
    // a list item may start with any number
    if (lm && !(para && lm.empty) && !(para && lm.ordered && lm.start !== 1 && opts.isTop)) {
      closePara();
      const items = [];
      let ordered = lm.ordered;
      let start = lm.start;
      let delim = lm.delim;
      let bullet = lm.bullet;
      const leadCols = lm.leadCols;
      // same level: same type, and the marker column is below the CURRENT
      // (most recent) item's content indent — so an outdented following
      // item stays in the list, while a more-indented one nests under the
      // previous item (probed doc-03 pattern).
      let curContentIndent = lm.contentIndent;
      const sameLevel = (nm) => nm && nm.ordered === ordered && nm.leadCols < curContentIndent && (ordered ? nm.delim === delim : nm.bullet === bullet);
      let j = i;
      let loose = false;
      while (j < n) {
        const lobj = lines[j];
        const lt = lobj.text;
        if (isBlank(lt)) {
          // a blank line: look ahead — if the next non-blank line is a new
          // item at this level, the list continues (and becomes loose)
          let k = j + 1;
          while (k < n && isBlank(lines[k].text)) k++;
          if (k < n && !lines[k].lazy) {
            if (isHrLine(lines[k].text)) break;
            const nm = listMarker(lines[k].text);
            if (sameLevel(nm)) {
              loose = true;
              j = k;
              continue;
            }
          }
          break;
        }
        // a thematic break ends the list (it is not a new item)
        if (isHrLine(lt)) break;
        const nm = listMarker(lt);
        if (sameLevel(nm)) {
          // new item at this level
          const contentIndent = nm.contentIndent;
          curContentIndent = contentIndent;
          const sub = [];
          sub.push({ text: stripListFirstLine(lt, nm), lazy: false });
          j++;
          // gather continuation lines
          while (j < n) {
            const cobj = lines[j];
            const ct = cobj.text;
            if (isBlank(ct)) {
              // an item with no content yet ends at a blank line: a
              // following indented line is NOT part of an empty item
              // (probed: `-\n\n  foo` leaves an empty <li>)
              let hasContent = false;
              for (const sl of sub) if (!isBlank(sl.text)) { hasContent = true; break; }
              if (!hasContent) break;
              // blank: include, but stop if the next non-blank line is a new
              // item at this level or is outside the list
              let k = j + 1;
              while (k < n && isBlank(lines[k].text)) k++;
              if (k >= n) { sub.push({ text: '', lazy: false }); j = k; break; }
              const kl = lines[k].text;
              const km = listMarker(kl);
              if (sameLevel(km)) {
                loose = true;
                sub.push({ text: '', lazy: false });
                j = k;
                break;
              }
              if (stripColumns(kl, contentIndent) !== null || isBlank(kl)) {
                sub.push({ text: '', lazy: false });
                j++;
                continue;
              }
              // the next non-blank line is outside: the blank line ends the item
              break;
            }
            const cm = listMarker(ct);
            if (sameLevel(cm)) break;
            // a list marker of a different type/delimiter at this level
            // (not nested) ends the item AND the list — the outer level
            // starts a new list there (cm-302: `3)` after `1.`/`2.`)
            if (cm && cm.leadCols < contentIndent) break;
            const stripped = stripColumns(ct, contentIndent);
            if (stripped !== null) { sub.push({ text: stripped, lazy: false }); j++; continue; }
            // lazy line
            if (interruptsPara(ct)) break;
            sub.push({ text: ct, lazy: true });
            j++;
          }
          const res = parseBlocks(sub, ctx, { strip4: true, inList: true });
          items.push(res.blocks);
          if (res.loose) loose = true;
          // if the inner parse stopped early (a lazy line that could not
          // continue a paragraph), the item ended there; rewind the outer
          // index to that line
          const consumedOuter = res.next;
          // res.next counts sub-lines; map back: sub-lines were gathered from
          // the outer lines starting at the item's first line. We approximate
          // by recomputing: the item consumed (j - itemStart) lines, minus
          // the unconsumed tail. Since lazy lines are only at the end of the
          // sub-array, and the outer index j already points past the gathered
          // lines, we adjust j back by (sub.length - consumedOuter) lines.
          const unused = sub.length - consumedOuter;
          if (unused > 0) {
            // walk back `unused` outer lines from j
            j -= unused;
          }
          continue;
        }
        break;
      }
      // determine looseness: an item is loose if it contains a blank line
      // between blocks, or two block-level children separated by a blank line.
      // (Simplified: use the `loose` flag set above, plus a check for blank
      // lines inside any item's blocks.)
      addBlock({ kind: 'list', ordered, start, items, loose });
      i = j;
      continue;
    }

    // paragraph (default): start or continue
    if (!para) para = [];
    para.push(text);
    paraLastLazy = false;
    i++;
  }
  closePara();
  return { blocks, next: i, loose };
}

// ---------- rendering ----------
function escAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Fence info string's first word, for the language class: backslash escapes
// are processed, < > " ' are escaped, but & is left literal (named entities
// in the info string stay as-is).
function infoLang(info) {
  const word = info.split(/\s+/)[0] || '';
  let out = '';
  for (let i = 0; i < word.length; i++) {
    const c = word.charCodeAt(i);
    if (c === 92 && i + 1 < word.length && isPunctCode(word.charCodeAt(i + 1))) { out += word[i + 1]; i++; continue; }
    if (c === 60) out += '&lt;';
    else if (c === 62) out += '&gt;';
    else if (c === 34) out += '&quot;';
    else if (c === 39) out += '&#39;';
    else out += word[i];
  }
  return out;
}

function renderBlocks(blocks, ctx, tightList) {
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    switch (b.kind) {
      case 'para': {
        const parts = inlineParse(b.text, ctx);
        if (tightList) {
          const tmp = [];
          renderParts(parts, tmp);
          out.push(tmp.join(''));
        } else {
          out.push('<p>');
          renderParts(parts, out);
          out.push('</p>\n');
        }
        break;
      }
      case 'heading': {
        out.push('<h' + b.level + '>');
        const parts = inlineParse(b.text, ctx);
        renderParts(parts, out);
        out.push('</h' + b.level + '>\n');
        break;
      }
      case 'code':
        out.push('<pre><code>', escCode(b.text), '</code></pre>\n');
        break;
      case 'fence': {
        let cls = '';
        if (b.info) {
          const lang = infoLang(b.info);
          if (lang) cls = ' class="language-' + lang + '"';
        }
        out.push('<pre><code' + cls + '>', escCode(b.text), '</code></pre>\n');
        break;
      }
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'html':
        out.push(b.text);
        break;
      case 'blockquote':
        out.push('<blockquote>\n');
        out.push(renderBlocks(b.blocks, ctx, false));
        out.push('</blockquote>\n');
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        let open = '<' + tag;
        if (b.ordered && b.start !== 1) open += ' start="' + b.start + '"';
        open += '>\n';
        out.push(open);
        for (const item of b.items) {
          out.push('<li>');
          const inner = renderBlocks(item, ctx, !b.loose);
          out.push(inner);
          out.push('</li>\n');
        }
        out.push('</' + tag + '>\n');
        break;
      }
      case 'table': {
        out.push('<table>\n<thead>\n<tr>\n');
        for (let c = 0; c < b.header.length; c++) {
          const al = b.aligns[c];
          const attr = al ? ' align="' + al + '"' : '';
          out.push('<th' + attr + '>');
          const parts = inlineParse(b.header[c], ctx);
          renderParts(parts, out);
          out.push('</th>\n');
        }
        out.push('</tr>\n</thead>\n');
        // a table with no body rows has no <tbody> at all (gfm-205)
        if (b.rows.length > 0) {
          out.push('<tbody>');
          for (const row of b.rows) {
            out.push('<tr>\n');
            for (let c = 0; c < row.length; c++) {
              const al = b.aligns[c];
              const attr = al ? ' align="' + al + '"' : '';
              out.push('<td' + attr + '>');
              const parts = inlineParse(row[c], ctx);
              renderParts(parts, out);
              out.push('</td>\n');
            }
            out.push('</tr>\n');
          }
          out.push('</tbody>');
        }
        out.push('</table>\n');
        break;
      }
    }
  }
  return out.join('');
}

// Task lists: post-process <li> contents — a leading "[ ] " / "[x] " becomes a
// checkbox input. Applied to the rendered list-item HTML. Handles tight
// items (<li>[x] ) and loose items (<li><p>[x] ).
function applyTaskLists(html) {
  return html
    .replace(/<li>(?:\n)?(\[ \]|\[x\]|\[X\]) /g, (m, box) => {
      const checked = box !== '[ ]' ? ' checked=""' : '';
      return '<li><input' + checked + ' disabled="" type="checkbox"> ';
    })
    .replace(/<li><p>(\[ \]|\[x\]|\[X\]) /g, (m, box) => {
      const checked = box !== '[ ]' ? ' checked=""' : '';
      return '<li><p><input' + checked + ' disabled="" type="checkbox"> ';
    });
}

// ---------- top-level parse ----------
// src: the whole markdown document. Returns the HTML string.
function parse(src) {
  const ctx = { refs: new Map(), inLink: { v: false } };
  // normalize line endings, split into lines (no trailing newline on lines)
  src = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawLines = src.split('\n');
  // a trailing newline produces a final empty string; drop it (it is not a line)
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const lines = rawLines.map((t) => ({ text: t, lazy: false }));
  const { blocks } = parseBlocks(lines, ctx, { strip4: false, isTop: true });
  let html = renderBlocks(blocks, ctx, false);
  html = applyTaskLists(html);
  return html;
}

export { parse };
