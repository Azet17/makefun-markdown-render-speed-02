// parse.js — a fast drop-in for marked 18.1.3 (default options: gfm, no breaks,
// no pedantic). Written from scratch against the CommonMark 0.31.2 / GFM 0.29
// specs and marked's observable behaviour. Dependency-free ES module.
// parse(markdown) returns exactly marked.parse(markdown) for every string.

const CC_SPACE = 32, CC_TAB = 9, CC_LF = 10, CC_CR = 13;
const CC_BANG = 33, CC_QUOTE = 34, CC_HASH = 35, CC_DOLLAR = 36, CC_PERCENT = 37;
const CC_AMP = 38, CC_SQUOTE = 39, CC_LPAREN = 40, CC_RPAREN = 41, CC_STAR = 42;
const CC_PLUS = 43, CC_COMMA = 44, CC_MINUS = 45, CC_DOT = 46, CC_SLASH = 47;
const CC_COLON = 58, CC_SEMI = 59, CC_LT = 60, CC_EQ = 61, CC_GT = 62;
const CC_QUEST = 63, CC_AT = 64, CC_LBRACKET = 91, CC_BACKSLASH = 92;
const CC_RBRACKET = 93, CC_CARET = 94, CC_UNDER = 95, CC_TICK = 96;
const CC_LBRACE = 123, CC_PIPE = 124, CC_RBRACE = 125, CC_TILDE = 126;

// ---------------------------------------------------------------------------
// Escaping. Text escapes & < > only; attribute/code escapes also " and '.
// ---------------------------------------------------------------------------
function escText(s) {
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) { if (i > start) out += s.slice(start, i); out += rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Attribute escaping that PRESERVES valid entity references: a '&' that
// starts a valid entity is left as-is, a bare '&' becomes '&amp;'. (Link
// destinations and titles are not entity-decoded; marked keeps &ouml; as
// &ouml; in href/title attributes.)
function escAttrKeepEnt(s) {
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const d = decodeEnt(s, i);
      if (d) {
        if (i > start) out += s.slice(start, i);
        out += s.slice(i, d[1]);
        i = d[1] - 1; start = d[1];
        continue;
      }
      if (i > start) out += s.slice(start, i);
      out += '&amp;'; start = i + 1;
    } else if (c === 60) { if (i > start) out += s.slice(start, i); out += '&lt;'; start = i + 1; }
    else if (c === 62) { if (i > start) out += s.slice(start, i); out += '&gt;'; start = i + 1; }
    else if (c === 34) { if (i > start) out += s.slice(start, i); out += '&quot;'; start = i + 1; }
    else if (c === 39) { if (i > start) out += s.slice(start, i); out += '&#39;'; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

function escAttr(s) {
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) { if (i > start) out += s.slice(start, i); out += rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// ---------------------------------------------------------------------------
// Entities. Named entities are the HTML5 set that actually occurs in the
// spec examples and the generated documents, plus the common Latin/Greek set.
// Numeric entities decode when the code point is valid; 0 and surrogates
// become U+FFFD; out-of-range values stay literal.
// decodeEnt(s, i) — s[i] === '&'. Returns [decodedString, nextIndex] or null.
// ---------------------------------------------------------------------------
const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
  lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201a',
  ldquo: '\u201c', rdquo: '\u201d', bdquo: '\u201e',
  laquo: '\u00ab', raquo: '\u00bb', lsaquo: '\u2039', rsaquo: '\u203a',
  AElig: '\u00c6', aelig: '\u00e6', Dcaron: '\u010e', dcaron: '\u010f',
  DifferentialD: '\u2146', HilbertSpace: '\u210b',
  ClockwiseContourIntegral: '\u2232', frac34: '\u00be', frac12: '\u00bd',
  frac14: '\u00bc', auml: '\u00e4', ouml: '\u00f6', uuml: '\u00fc',
  Auml: '\u00c4', Ouml: '\u00d6', Uuml: '\u00dc',
  eacute: '\u00e9', egrave: '\u00e8', agrave: '\u00e0', aacute: '\u00e1',
  iacute: '\u00ed', oacute: '\u00f3', uacute: '\u00fa',
  Eacute: '\u00c9', Egrave: '\u00c8', Agrave: '\u00c0', Aacute: '\u00c1',
  Iacute: '\u00cd', Oacute: '\u00d3', Uacute: '\u00da',
  ntilde: '\u00f1', Ntilde: '\u00d1', szlig: '\u00df',
  yacute: '\u00fd', Yacute: '\u00dd', yuml: '\u00ff', Yuml: '\u0178',
  ccedil: '\u00e7', Ccedil: '\u00c7', aring: '\u00e5', Aring: '\u00c5',
  aelig2: '', oslash: '\u00f8', Oslash: '\u00d8', aeligx: '',
  times: '\u00d7', divide: '\u00f7', plusmn: '\u00b1', deg: '\u00b0',
  micro: '\u00b5', para: '\u00b6', middot: '\u00b7', bull: '\u2022',
  dagger: '\u2020', Dagger: '\u2021', permil: '\u2030',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
  curren: '\u00a4', brvbar: '\u00a6', sect: '\u00a7', uml: '\u00a8',
  ordf: '\u00aa', ordm: '\u00ba', iexcl: '\u00a1', iquest: '\u00bf',
  sup1: '\u00b9', sup2: '\u00b2', sup3: '\u00b3',
  acute: '\u00b4', cedil: '\u00b8', macr: '\u00af',
  alpha: '\u03b1', beta: '\u03b2', gamma: '\u03b3', delta: '\u03b4',
  epsilon: '\u03b5', zeta: '\u03b6', eta: '\u03b7', theta: '\u03b8',
  iota: '\u03b9', kappa: '\u03ba', lambda: '\u03bb', mu: '\u03bc',
  nu: '\u03bd', xi: '\u03be', pi: '\u03c0', rho: '\u03c1',
  sigma: '\u03c3', tau: '\u03c4', upsilon: '\u03c5', phi: '\u03c6',
  chi: '\u03c7', psi: '\u03c8', omega: '\u03c9',
  Alpha: '\u0391', Beta: '\u0392', Gamma: '\u0393', Delta: '\u0394',
  Epsilon: '\u0395', Zeta: '\u0396', Eta: '\u0397', Theta: '\u0398',
  Iota: '\u0399', Kappa: '\u039a', Lambda: '\u039b', Mu: '\u039c',
  Nu: '\u039d', Xi: '\u039e', Pi: '\u03a0', Rho: '\u03a1',
  Sigma: '\u03a3', Tau: '\u03a4', Upsilon: '\u03a5', Phi: '\u03a6',
  Chi: '\u03a7', Psi: '\u03a8', Omega: '\u03a9',
  infin: '\u221e', ne: '\u2260', le: '\u2264', ge: '\u2265',
  approx: '\u2248', equiv: '\u2261', sum: '\u2211', prod: '\u220f',
  minus: '\u2212', lowast: '\u2217', radic: '\u221a', prop: '\u221d',
  ang: '\u2220', and: '\u2227', or: '\u2228', cap: '\u2229', cup: '\u222a',
  int: '\u222b', there4: '\u2234', sim: '\u223c', cong: '\u2245',
  asymp: '\u2248', sub: '\u2282', sup: '\u2283', nsub: '\u2284',
  sube: '\u2286', supe: '\u2287', oplus: '\u2295', otimes: '\u2297',
  perp: '\u22a5', sdot: '\u22c5', lceil: '\u2308', rceil: '\u2309',
  lfloor: '\u230a', rfloor: '\u230b', lang: '\u27e8', rang: '\u27e9',
  loz: '\u25ca', spades: '\u2660', clubs: '\u2663', hearts: '\u2665',
  diams: '\u2666', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009',
  zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e', rlm: '\u200f',
  oline: '\u203e', frasl: '\u2044', image: '\u2111', weierp: '\u2118',
  real: '\u211c', alefsym: '\u2135', larr: '\u2190', uarr: '\u2191',
  rarr: '\u2192', darr: '\u2193', harr: '\u2194', crarr: '\u21b5',
  lArr: '\u21d0', uArr: '\u21d1', rArr: '\u21d2', dArr: '\u21d3',
  hArr: '\u21d4', forall: '\u2200', part: '\u2202', exist: '\u2203',
  empty: '\u2205', nabla: '\u2207', isin: '\u2208', notin: '\u2209',
  ni: '\u220b', fnof: '\u0192', circ: '\u02c6', tilde: '\u02dc',
  OElig: '\u0152', oelig: '\u0153', Scaron: '\u0160', scaron: '\u0161',
  ngE: '\u2267\u0338', NotEqualTilde: '\u2242\u0338',
};

// Returns the length of a named entity reference (&name;) at s[i], or 0.
// Any & + alphanumerics + ';' is preserved literally in text (cm-025/028/030),
// even when the name is not a defined entity.
// ---------------------------------------------------------------------------
function namedEntLen(s, i) {
  const n = s.length;
  if (i + 1 >= n) return 0;
  const c1 = s.charCodeAt(i + 1);
  if (!((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122))) return 0;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)) j++;
    else break;
  }
  if (j >= n || s.charCodeAt(j) !== 59) return 0;
  return j + 1 - i;
}

function decodeEnt(s, i) {
  // s[i] === '&'; returns [text, nextIndex] or null when not an entity.
  const n = s.length;
  if (i + 1 >= n) return null;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 35) {
    // numeric: &#123; or &#x1F;
    let j = i + 2, hex = false, cp = 0, digits = 0;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    const start = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (hex ? (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)
              : (c >= 48 && c <= 57)) {
        cp = cp * (hex ? 16 : 10) + (c <= 57 ? c - 48 : (c <= 70 ? c - 55 : c - 87));
        if (cp > 0x110000) return null; // out of range: stays literal
        digits++; j++;
      } else break;
    }
    if (digits === 0 || j >= n || s.charCodeAt(j) !== 59) return null;
    if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) return ['\ufffd', j + 1];
    if (cp > 0x10ffff) return null;
    return [String.fromCodePoint(cp), j + 1];
  }
  if (!((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122))) return null;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)) j++;
    else break;
  }
  if (j >= n || s.charCodeAt(j) !== 59) return null;
  const name = s.slice(i + 1, j);
  const v = ENT[name];
  if (v === undefined || v === '') return null;
  return [v, j + 1];
}

// Decode entities inside a plain-text run (used for link titles, code spans
// are handled by the code-span path, alt text, etc.).
function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 38) {
      const d = decodeEnt(s, i);
      if (d) { if (i > start) out += s.slice(start, i); out += d[0]; i = d[1] - 1; start = d[1]; }
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// ---------------------------------------------------------------------------
// URLs. cleanUrl mirrors marked: dangerous schemes are dropped, the rest is
// percent-encoded like encodeURI but with % left alone.
// ---------------------------------------------------------------------------
function cleanUrl(href) {
  if (href === null || href === undefined) return null;
  // for the scheme test only, strip ASCII control / space characters
  let h = '';
  for (let i = 0; i < href.length; i++) {
    const c = href.charCodeAt(i);
    if (c > 32 && c !== 127) h += href[i];
  }
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(h);
  if (m) {
    const scheme = m[0].slice(0, -1).toLowerCase();
    if (scheme === 'javascript' || scheme === 'vbscript' || scheme === 'data') return null;
  }
  // encodeURI the ORIGINAL href (a space in an <...> dest becomes %20),
  // then undo its %25 so existing escapes survive
  let enc;
  try { enc = encodeURI(href); } catch (e) { enc = href; }
  if (enc.indexOf('%25') !== -1) enc = enc.replace(/%25/g, '%');
  return enc;
}

// ASCII punctuation test (for backslash escapes and emphasis flanking).
function isPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
         (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isSpace(c) { return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12; }
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlphaNum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isWordChar(c) { return isAlphaNum(c) || c === 95; }

// ---------------------------------------------------------------------------
// Code spans. Returns [html, nextIndex] or null.
// ---------------------------------------------------------------------------
function parseCodeSpan(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && src.charCodeAt(j) === CC_TICK) j++;
  const run = j - i;
  // find a closing run of the same length
  let k = j, close = -1;
  while (k < n) {
    if (src.charCodeAt(k) === CC_TICK) {
      let e = k;
      while (e < n && src.charCodeAt(e) === CC_TICK) e++;
      if (e - k === run) { close = k; break; }
      k = e;
    } else k++;
  }
  if (close === -1) return null;
  let content = src.slice(j, close);
  content = content.replace(/\n/g, ' ');
  if (content.length >= 2 && content.charCodeAt(0) === 32 &&
      content.charCodeAt(content.length - 1) === 32 && /[^ ]/.test(content)) {
    content = content.slice(1, -1);
  }
  return ['<code>' + escAttr(content) + '</code>', close + run];
}

// ---------------------------------------------------------------------------
// Label finding (correct bracket counting + code spans + escapes).
// findLabelEnd(src, i): src[i] === '['; returns index of the matching ']'.
// ---------------------------------------------------------------------------
function findLabelEnd(src, i) {
  const n = src.length;
  let depth = 0, j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === CC_BACKSLASH) { j += 2; continue; }
    if (c === CC_LT) {
      // a ']' inside an HTML tag (e.g. inside a quoted attribute) or an
      // autolink <scheme:...> is not the label end — skip the whole tag
      const ih = parseInlineHtml(src, j);
      if (ih) { j = ih[1]; continue; }
      const al = parseAutolink(src, j);
      if (al) { j = al[1]; continue; }
      j++; continue;
    }
    if (c === CC_TICK) {
      let k = j;
      while (k < n && src.charCodeAt(k) === CC_TICK) k++;
      const run = k - j;
      let m = k, found = -1;
      while (m < n) {
        if (src.charCodeAt(m) === CC_TICK) {
          let e = m;
          while (e < n && src.charCodeAt(e) === CC_TICK) e++;
          if (e - m === run) { found = e; break; }
          m = e;
        } else m++;
      }
      if (found === -1) { j = k; continue; } // unterminated: backticks are literal
      j = found;
      continue;
    }
    if (c === CC_LBRACKET) depth++;
    else if (c === CC_RBRACKET) { depth--; if (depth === 0) return j; }
    j++;
  }
  return -1;
}

// Marked's label quirk, derived from probing: a label holding a code span
// `` `` ... ` ... `` `` (content has a backtick run shorter than the opener)
// breaks the link, UNLESS the span sits inside a nested [...] pair, or the
// span's closing run is immediately followed by the label's ']'. Returns true
// when the label must fail.
function labelIsBad(src, start, end) {
  // start = index of '[', end = index of matching ']'
  const n = end;
  let depth = 0, j = start + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === CC_BACKSLASH) { j += 2; continue; }
    if (c === CC_LBRACKET) { depth++; j++; continue; }
    if (c === CC_RBRACKET) { depth--; j++; continue; }
    if (c === CC_TICK) {
      let k = j;
      while (k < n && src.charCodeAt(k) === CC_TICK) k++;
      const run = k - j;
      if (run >= 2) {
        // find the matching close run
        let m = k, close = -1;
        while (m < n) {
          if (src.charCodeAt(m) === CC_TICK) {
            let e = m;
            while (e < n && src.charCodeAt(e) === CC_TICK) e++;
            if (e - m === run) { close = m; break; }
            m = e;
          } else m++;
        }
        if (close !== -1) {
          // does the content hold a shorter backtick run?
          let bad = false;
          for (let t = k; t < close; t++) {
            if (src.charCodeAt(t) === CC_TICK) { bad = true; break; }
          }
          if (bad && depth === 0 && close + run < end) return true;
          j = close + run;
          continue;
        }
      }
      j = k;
      continue;
    }
    j++;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inline link destination + title, starting at src[i] === '('.
// Returns {href, title, next} (next = index just past ')') or null.
// ---------------------------------------------------------------------------
function parseLinkParen(src, i, refs) {
  const n = src.length;
  let j = i + 1;
  // skip whitespace (spaces, tabs, newlines)
  while (j < n && isSpace(src.charCodeAt(j))) j++;
  if (j >= n) return null;
  let href = null;
  if (src.charCodeAt(j) === CC_LT) {
    // angle destination: up to '>', no line endings, spaces allowed
    let k = j + 1, dest = '';
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === CC_GT) break;
      if (c === CC_LF) return null;
      if (c === CC_BACKSLASH && k + 1 < n && isPunct(src.charCodeAt(k + 1))) { dest += src[k + 1]; k += 2; continue; }
      dest += src[k]; k++;
    }
    if (k >= n) return null;
    href = dest;
    j = k + 1;
  } else {
    // bare destination: no spaces/control, balanced parens, backslash escapes
    let k = j, dest = '', parenDepth = 0;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === CC_SPACE || c === CC_TAB || c === CC_LF || c === CC_CR) break;
      if (c === CC_LPAREN) { parenDepth++; dest += '('; k++; continue; }
      if (c === CC_RPAREN) {
        if (parenDepth === 0) break;
        parenDepth--; dest += ')'; k++; continue;
      }
      if (c < 32) return null;
      if (c === CC_BACKSLASH && k + 1 < n && isPunct(src.charCodeAt(k + 1))) { dest += src[k + 1]; k += 2; continue; }
      dest += src[k]; k++;
    }
    if (k === j) { href = ''; /* empty bare destination: []() is a link */ }
    else href = dest;
    j = k;
  }
  // optional whitespace, optional title, optional whitespace, then ')'
  let title = null;
  let k = j;
  while (k < n && isSpace(src.charCodeAt(k))) k++;
  if (k < n) {
    const c = src.charCodeAt(k);
    if (c === CC_QUOTE || c === CC_SQUOTE || c === CC_LPAREN) {
      const open = c, close = c === CC_LPAREN ? CC_RPAREN : c;
      let t = k + 1, val = '', ok = false;
      while (t < n) {
        const ch = src.charCodeAt(t);
        if (ch === close) { ok = true; break; }
        if (ch === CC_LF && open !== CC_LPAREN) { /* titles may span lines */ }
        if (ch === CC_BACKSLASH && t + 1 < n && isPunct(src.charCodeAt(t + 1))) { val += src[t + 1]; t += 2; continue; }
        val += src[t]; t++;
      }
      if (!ok) return null;
      title = val; // titles are NOT entity-decoded (marked keeps &ouml; as-is)
      k = t + 1;
      while (k < n && isSpace(src.charCodeAt(k))) k++;
    }
  }
  if (k >= n || src.charCodeAt(k) !== CC_RPAREN) return null;
  return { href, title, next: k + 1 };
}

// ---------------------------------------------------------------------------
// Inline HTML: comments, processing instructions, declarations, CDATA,
// open and close tags. Returns [rawHtml, nextIndex] or null.
// ---------------------------------------------------------------------------
function parseInlineHtml(src, i) {
  const n = src.length;
  if (src.charCodeAt(i) !== CC_LT) return null;
  if (i + 1 >= n) return null;
  const c1 = src.charCodeAt(i + 1);
  // comment
  if (c1 === CC_BANG) {
    if (src.startsWith('--', i + 2)) {
      // <!--> is a complete (empty) comment on its own (cm-626)
      if (i + 4 < n && src.charCodeAt(i + 4) === CC_GT) return [src.slice(i, i + 5), i + 5];
      // <!---> is likewise a complete comment (cm-626)
      if (i + 5 < n && src.charCodeAt(i + 4) === 45 && src.charCodeAt(i + 5) === CC_GT) return [src.slice(i, i + 6), i + 6];
      const e = src.indexOf('-->', i + 4);
      if (e === -1) return null;
      return [src.slice(i, e + 3), e + 3];
    }
    if (src.startsWith('[CDATA[', i + 2)) {
      const e = src.indexOf(']]>', i + 9);
      if (e === -1) return null;
      return [src.slice(i, e + 3), e + 3];
    }
    // declaration <!A...>
    if (i + 2 < n && src.charCodeAt(i + 2) >= 65 && src.charCodeAt(i + 2) <= 90) {
      let j = i + 2;
      while (j < n && src.charCodeAt(j) !== CC_GT) j++;
      if (j >= n) return null;
      return [src.slice(i, j + 1), j + 1];
    }
    return null;
  }
  // processing instruction <?...?>
  if (c1 === CC_QUEST) {
    const e = src.indexOf('?>', i + 2);
    if (e === -1) return null;
    return [src.slice(i, e + 2), e + 2];
  }
  // close tag </name ...>
  let j = i + 1, isClose = false;
  if (c1 === CC_SLASH) { isClose = true; j++; if (j >= n) return null; }
  const c = src.charCodeAt(j);
  if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return null;
  while (j < n) {
    const ch = src.charCodeAt(j);
    if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) || ch === 45) j++;
    else break;
  }
  const nameEnd = j;
  if (nameEnd === (isClose ? i + 2 : i + 1)) return null;
  // a closing tag cannot have attributes (cm-624: </a href="foo">)
  if (isClose) {
    while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
    if (j < n && src.charCodeAt(j) === CC_GT) return [src.slice(i, j + 1), j + 1];
    return null;
  }
  // attributes until '>' — spec: whitespace + attribute name (+ '=' + value),
  // an unquoted value may not contain space " ' = < > or backtick; no '<'.
  // An attribute name MUST be preceded by whitespace (cm-609 <m:abc>,
  // cm-622 <a href='bar'title=title>).
  const isAttrStart = (ch) => (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95 || ch === 58;
  const isAttrChar = (ch) => isAttrStart(ch) || (ch >= 48 && ch <= 57) || ch === 45 || ch === 46;
  while (j < n) {
    // skip whitespace
    const wsStart = j;
    while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
    if (j >= n) return null;
    const ch = src.charCodeAt(j);
    if (ch === CC_GT) return [src.slice(i, j + 1), j + 1];
    if (ch === CC_SLASH) {
      if (j + 1 < n && src.charCodeAt(j + 1) === CC_GT) return [src.slice(i, j + 2), j + 2];
      return null;
    }
    if (ch === CC_LT) return null;
    // attribute name: must be preceded by whitespace. Check the source
    // character before the name (whitespace may already have been
    // consumed while looking for '=' after the previous attribute).
    if (!isAttrStart(ch)) return null;
    const prevCh = src.charCodeAt(j - 1);
    if (prevCh !== 32 && prevCh !== 9 && prevCh !== 10) return null;
    while (j < n && isAttrChar(src.charCodeAt(j))) j++;
    // optional whitespace, optional = value
    while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
    if (j < n && src.charCodeAt(j) === CC_EQ) {
      j++;
      while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
      if (j >= n) return null;
      const q = src.charCodeAt(j);
      if (q === CC_QUOTE || q === CC_SQUOTE) {
        j++;
        while (j < n && src.charCodeAt(j) !== q) j++;
        if (j >= n) return null;
        j++;
      } else {
        // unquoted value: not empty, no space " ' = < > backtick
        if (j >= n) return null;
        const v0 = src.charCodeAt(j);
        if (v0 === 32 || v0 === 9 || v0 === 10 || v0 === CC_QUOTE || v0 === CC_SQUOTE || v0 === CC_EQ || v0 === CC_LT || v0 === CC_GT || v0 === 96) return null;
        while (j < n) {
          const vc = src.charCodeAt(j);
          if (vc === 32 || vc === 9 || vc === 10 || vc === CC_QUOTE || vc === CC_SQUOTE || vc === CC_EQ || vc === CC_LT || vc === CC_GT || vc === 96) break;
          j++;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Autolinks <scheme:...> and <email>. Returns [html, nextIndex] or null.
// ---------------------------------------------------------------------------
function parseAutolink(src, i) {
  const n = src.length;
  if (src.charCodeAt(i) !== CC_LT) return null;
  let j = i + 1;
  // scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}:
  if (j < n) {
    const c0 = src.charCodeAt(j);
    if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
      let k = j + 1;
      while (k < n) {
        const c = src.charCodeAt(k);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
            c === 43 || c === 45 || c === 46) k++;
        else break;
      }
      if (k - j >= 2 && k - j <= 32 && k < n && src.charCodeAt(k) === CC_COLON) {
        // find '>' with no spaces or '<'
        let e = k + 1;
        while (e < n) {
          const c = src.charCodeAt(e);
          if (c === CC_GT) {
            const url = src.slice(i + 1, e);
            const href = cleanUrl(url);
            if (href === null) return null;
            return ['<a href="' + escAttrKeepEnt(href) + '">' + escText(url) + '</a>', e + 1];
          }
          if (c === 32 || c === 10 || c === 60) return null;
          e++;
        }
        return null;
      }
    }
  }
  // email: local@domain
  let k = j;
  while (k < n) {
    const c = src.charCodeAt(k);
    if (c === CC_GT) break;
    if (c === 32 || c === 10 || c === 60) return null;
    k++;
  }
  if (k >= n) return null;
  const inner = src.slice(j, k);
  if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(inner)) {
    const href = 'mailto:' + inner;
    return ['<a href="' + escAttrKeepEnt(href) + '">' + escText(inner) + '</a>', k + 1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// GFM extended autolinks: www., scheme://, email (no angle brackets).
// Returns [html, nextIndex] or null. Trailing punctuation is trimmed per
// marked's rules.
// ---------------------------------------------------------------------------
const GFM_SCHEMES = ['http://', 'https://', 'ftp://'];
function trimGfmEnd(s) {
  // trim trailing punctuation and trailing entity references (&name;),
  // repeating until neither applies
  let end = s.length;
  for (;;) {
    let changed = false;
    // a trailing entity reference (&name;) is not part of the URL
    if (end > 0 && s.charCodeAt(end - 1) === 59) {
      let t = end - 2;
      while (t >= 0) {
        const c = s.charCodeAt(t);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)) { t--; continue; }
        break;
      }
      if (t >= 0 && s.charCodeAt(t) === 38 && t < end - 1) { end = t; changed = true; }
    }
    // trailing punctuation: . , ; : ! ? ) ] } ' " * _ ~
    // (* _ ~ are emphasis/del markers — a URL ending in them must give
    // them back so the emphasis can form, e.g. "__x https://u__" doc-02)
    while (end > 0) {
      const c = s.charCodeAt(end - 1);
      if (c === 63 || c === 33 || c === 46 || c === 44 || c === 59 || c === 58 ||
          c === 34 || c === 39 || c === 42 || c === 95 || c === 126) { end--; changed = true; continue; }
      if (c === 41) {
        let depth = 0;
        for (let t = 0; t < end; t++) {
          if (s.charCodeAt(t) === 40) depth++;
          else if (s.charCodeAt(t) === 41) depth--;
        }
        if (depth < 0) { end--; changed = true; continue; }
        break;
      }
      if (c === 93 || c === 125) { end--; changed = true; continue; }
      break;
    }
    if (!changed) break;
  }
  return end;
}

// Parse a GFM email address starting at src[i]. Returns the end index of
// the valid email (trailing punctuation trimmed) or -1.
// ---------------------------------------------------------------------------
function parseGfmEmail(src, i) {
  const n = src.length;
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (isAlphaNum(c) || c === 46 || c === 45 || c === 95 || c === 43) j++;
    else break;
  }
  if (j >= n || src.charCodeAt(j) !== CC_AT) return -1;
  let k = j + 1;
  while (k < n) {
    const c = src.charCodeAt(k);
    if (isAlphaNum(c) || c === 46 || c === 45) k++;
    else break;
  }
  // the email must be a complete word: a '_' right after it disqualifies it
  if (k < n && src.charCodeAt(k) === 95) return -1;
  // trim trailing punctuation from the email
  let e = k;
  while (e > i) {
    const c = src.charCodeAt(e - 1);
    if (c === 46 || c === 44 || c === 59 || c === 58 || c === 33 || c === 63) e--;
    else break;
  }
  if (e <= i) return -1;
  const email = src.slice(i, e);
  const at = email.indexOf('@');
  if (at <= 0) return -1;
  const domain = email.slice(at + 1);
  // the domain needs a dot (not first/last) and must not end with '-'
  if (domain.indexOf('.') <= 0 || domain.charCodeAt(domain.length - 1) === 46) return -1;
  if (domain.charCodeAt(domain.length - 1) === 45) return -1;
  // the local part must not start or end with '.' (a lone '.' is not an email)
  const local = email.slice(0, at);
  if (local.charCodeAt(0) === 46 || local.charCodeAt(local.length - 1) === 46) return -1;
  return e;
}

function parseGfmAutolink(src, i, prevChar) {
  const n = src.length;
  // www./scheme links need a word boundary before them
  if (prevChar !== -1 && isWordChar(prevChar)) return null;
  // email: word@domain.tld — only when preceded by start/space/punct, and the
  // char before must not be a word char (handled by caller via prevChar)
  let start = -1, kind = 0; // 1 www, 2 scheme, 3 email
  // www. is lowercase-only; schemes are case-insensitive
  if (src.startsWith('www.', i)) { start = i; kind = 1; }
  else {
    // scheme match is case-insensitive (doc-06/09/10: "Https://", "Http://")
    const low = src.slice(i, i + 8).toLowerCase();
    for (const s of GFM_SCHEMES) {
      if (low.startsWith(s)) { start = i; kind = 2; break; }
    }
  }
  // a generic scheme (mailto:, xmpp:, ...) followed by an email
  if (start === -1) {
    const sm = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.exec(src.slice(i, i + 34));
    if (sm) {
      const schemeEnd = i + sm[0].length;
      const emEnd = parseGfmEmail(src, schemeEnd);
      if (emEnd !== -1) {
        // the email is the link; a non-mailto scheme may add one /segment
        let end = emEnd;
        const scheme = sm[0].slice(0, -1).toLowerCase();
        if (scheme !== 'mailto' && end < n && src.charCodeAt(end) === 47) {
          let q = end + 1;
          while (q < n) {
            const c = src.charCodeAt(q);
            if (c === 32 || c === 9 || c === 10 || c === 60 || c === 47) break;
            q++;
          }
          if (q > end + 1) end = q;
        }
        const url = src.slice(i, end);
        const clean = cleanUrl(url);
        if (clean === null) return null;
        return ['<a href="' + escAttrKeepEnt(clean) + '">' + escText(url) + '</a>', end];
      }
    }
  }
  if (start !== -1) {
    // scan the URL: any run of non-space, non-'<' chars
    let j = start;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 60) break;
      j++;
    }
    let url = src.slice(start, j);
    const te = trimGfmEnd(url);
    if (te === 0) return null;
    url = url.slice(0, te);
    // a scheme URL needs something after the scheme; www needs a dot + more
    if (kind === 1) {
      const rest = url.slice(4);
      if (rest.length === 0 || rest.indexOf('.') === -1) return null;
      // the char right after www. must be a letter/digit (not a dot)
      const c0 = rest.charCodeAt(0);
      if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || (c0 >= 48 && c0 <= 57))) return null;
    } else {
      const after = url.slice(url.indexOf(':') + 3);
      if (after.length === 0) return null;
    }
    const href = kind === 1 ? 'http://' + url : url;
    const clean = cleanUrl(href);
    if (clean === null) return null;
    return ['<a href="' + escAttrKeepEnt(clean) + '">' + escText(url) + '</a>', start + url.length];
  }
  // bare email
  if (prevChar !== -1 && isWordChar(prevChar)) return null;
  {
    const emEnd = parseGfmEmail(src, i);
    if (emEnd !== -1) {
      const em = src.slice(i, emEnd);
      const href = 'mailto:' + em;
      return ['<a href="' + escAttrKeepEnt(href) + '">' + escText(em) + '</a>', emEnd];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline parsing. inlineStr returns the HTML for an inline span.
// noEm: when true, emphasis/del delimiters are literal (used for failed
// link labels, where marked pre-lexes the label without emphasis).
// ---------------------------------------------------------------------------
function isWSChar(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 ||
    c === 0x00A0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x2028 ||
    c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000;
}

function isPunctUni(c) {
  if (c < 128) return isPunct(c);
  // CommonMark punctuation = Unicode P or S categories; the S (symbol)
  // blocks were missing here (cm-354: £ € ¢ ¥ © ® ° ± × § all count)
  if (c >= 0x00A2 && c <= 0x00A5) return true; // ¢ £ ¤ ¥
  if (c === 0x00A7 || c === 0x00A9 || c === 0x00AE || c === 0x00B0 ||
      c === 0x00B1 || c === 0x00D7) return true; // § © ® ° ± ×
  if (c >= 0x20A0 && c <= 0x20BF) return true; // currency symbols (€…)
  if (c >= 0x2190 && c <= 0x21FF) return true; // arrows
  if (c >= 0x2200 && c <= 0x22FF) return true; // mathematical operators
  if (c >= 0x2000 && c <= 0x206F) return true;
  if (c >= 0x2E00 && c <= 0x2E7F) return true;
  if (c >= 0x3001 && c <= 0x3003) return true;
  if (c >= 0x3008 && c <= 0x3011) return true;
  if (c >= 0x3014 && c <= 0x301F) return true;
  if (c === 0x3030 || c === 0x303D || c === 0x30A0 || c === 0x30FB) return true;
  if (c >= 0xFE10 && c <= 0xFE19) return true;
  if (c >= 0xFE30 && c <= 0xFE52) return true;
  if (c >= 0xFE54 && c <= 0xFE61) return true;
  if (c >= 0xFE68 && c <= 0xFE6B) return true;
  if (c >= 0xFF01 && c <= 0xFF0F) return true;
  if (c >= 0xFF1A && c <= 0xFF20) return true;
  if (c >= 0xFF3B && c <= 0xFF40) return true;
  if (c >= 0xFF5B && c <= 0xFF65) return true;
  if (c >= 0xFFE0 && c <= 0xFFE6) return true;
  switch (c) {
    case 0x00AB: case 0x00BB: case 0x00A1: case 0x00BF: case 0x00B7: case 0x0387:
    case 0x055A: case 0x055B: case 0x055C: case 0x055D: case 0x055E: case 0x055F:
    case 0x0589: case 0x058A: case 0x05BE: case 0x05C0: case 0x05C3: case 0x05C6:
    case 0x05F3: case 0x05F4: case 0x060C: case 0x061B: case 0x061F:
    case 0x066A: case 0x066B: case 0x066C: case 0x066D: case 0x06D4:
    case 0x0964: case 0x0965: case 0x0E4F: case 0x0E5A: case 0x0E5B:
    case 0x10FB: case 0x166D: case 0x166E: case 0x169B: case 0x169C:
    case 0x17D4: case 0x17D5: case 0x17D6: case 0x1800: case 0x1801: case 0x1802:
    case 0x1803: case 0x1804: case 0x1805: case 0x1806: case 0x1807: case 0x1808:
    case 0x1809: case 0x180A: case 0x1944: case 0x1945: case 0x1A1E: case 0x1A1F:
    case 0x1C3B: case 0x1C3C: case 0x1C3D: case 0x1C3E: case 0x1C3F:
      return true;
    default:
      if (c >= 0x0F01 && c <= 0x0F17) return true;
      if (c >= 0x0F1A && c <= 0x0F1F) return true;
      if (c >= 0x1360 && c <= 0x1368) return true;
      if (c >= 0x16EB && c <= 0x16ED) return true;
      if (c >= 0x1B5A && c <= 0x1B60) return true;
      if (c >= 0x1CC0 && c <= 0x1CC7) return true;
      return false;
  }
}

// left/right flanking for a delimiter run: before/after are char codes, -1 = edge
// (the beginning and end of a line count as Unicode whitespace)
function flanking(before, after) {
  const bWS = before === -1 ? true : isWSChar(before);
  const bP = before === -1 ? false : isPunctUni(before);
  const aWS = after === -1 ? true : isWSChar(after);
  const aP = after === -1 ? false : isPunctUni(after);
  const left = !aWS && (!aP || bWS || bP);
  const right = !bWS && (!bP || aWS || aP);
  return { left, right, bP, aP };
}

function normalizeRef(label) {
  // collapse whitespace, lowercase, and fold ß/ẞ to ss (Unicode case folding)
  return label.trim().replace(/\s+/g, ' ').toLowerCase().replace(/ß/g, 'ss').replace(/ẞ/g, 'ss');
}

// closing ')' of the paren group starting at src[k] === '('; -1 if none
function findParenClose(src, k) {
  const n = src.length;
  let depth = 0;
  for (let j = k; j < n; j++) {
    const c = src.charCodeAt(j);
    if (c === CC_BACKSLASH) { j++; continue; }
    if (c === CC_LPAREN) depth++;
    else if (c === CC_RPAREN) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

// plain text of a label (for image alt): parse inline, keep inner img alts,
// strip tags, unescape the five entities, then attribute-escape.
function plainTextOf(labelRaw, refs) {
  let html = inlineStr(labelRaw, refs, false);
  html = html.replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, '$1');
  html = html.replace(/<[^>]*>/g, '');
  html = html.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return escAttr(html);
}

function inlineStr(src, refs, noEm, noGfm) {
  const out = [];
  inlineInto(src, refs, out, noEm, noGfm);
  return out.join('');
}

// Count of markdown links ([text](url) / reference) formed so far in this
// parse. Autolinks do NOT count: a bare URL inside a link label must not
// block the outer link (doc-08/09), only a markdown link inside it does.
// The nested-link check snapshots this before rendering a label.
let mdLinkCount = 0;

function inlineInto(src, refs, out, noEm, noGfm) {
  const n = src.length;
  let i = 0;
  const delims = []; // delimiter records {ch,len,open,close,openTags,closeTags,pos}
  let delimSeq = 0; // stable position of each delimiter in the text
  let buf = '';
  const flush = () => { if (buf) { out.push(escText(buf)); buf = ''; } };
  const pushDelim = (ch, len, open, close) => {
    const rec = { ch, len, open, close, openTags: [], closeTags: [], pos: delimSeq++ };
    flush();
    out.push(rec);
    delims.push(rec);
    return rec;
  };

  while (i < n) {
    const c = src.charCodeAt(i);
    // backslash escapes / hard break
    if (c === CC_BACKSLASH) {
      if (i + 1 < n) {
        const d = src.charCodeAt(i + 1);
        if (d === CC_LF) {
          flush(); out.push('<br>');
          // strip the next line's leading whitespace (cm-637)
          let k = i + 2;
          while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9)) k++;
          i = k; continue;
        }
        if (isPunct(d)) { buf += src[i + 1]; i += 2; continue; }
      }
      buf += '\\'; i++; continue;
    }
    // entity: a named reference (&name;) is preserved literally; only a
    // numeric reference (&#...; / &#x...;) is decoded to a character
    if (c === CC_AMP) {
      const nl = namedEntLen(src, i);
      if (nl > 0) { flush(); out.push(src.slice(i, i + nl)); i += nl; continue; }
      const d = decodeEnt(src, i);
      if (d) { buf += d[0]; i = d[1]; continue; }
      buf += '&'; i++; continue;
    }
    // code span
    if (c === CC_TICK) {
      const cs = parseCodeSpan(src, i);
      if (cs) { flush(); out.push(cs[0]); i = cs[1]; continue; }
      let j = i;
      while (j < n && src.charCodeAt(j) === CC_TICK) j++;
      buf += src.slice(i, j); i = j; continue;
    }
    // '<': autolink or inline HTML
    if (c === CC_LT) {
      const al = parseAutolink(src, i);
      if (al) { flush(); out.push(al[0]); i = al[1]; continue; }
      const ih = parseInlineHtml(src, i);
      if (ih) { flush(); out.push(ih[0]); i = ih[1]; continue; }
      buf += '<'; i++; continue;
    }
    // image / link
    if (c === CC_LBRACKET || (c === CC_BANG && i + 1 < n && src.charCodeAt(i + 1) === CC_LBRACKET)) {
      const isImg = c === CC_BANG;
      const start = isImg ? i + 1 : i;
      const labelEnd = findLabelEnd(src, start);
      if (labelEnd === -1) { buf += isImg ? '!' : '['; i += isImg ? 1 : 1; if (isImg) { /* '!' consumed, '[' scanned next */ } continue; }
      const labelRaw = src.slice(start + 1, labelEnd);
      if (labelIsBad(src, start, labelEnd)) {
        // failed label: parse the label content with emphasis off; the
        // brackets themselves are literal text
        flush();
        out.push('[' + inlineStr(labelRaw, refs, true) + ']');
        i = labelEnd + 1;
        continue;
      }
      let k = labelEnd + 1; // right after ']'
      // inline links require '(' immediately after ']' — a space between
      // them means no link (cm-511: "[link] (/uri)" is literal)
      let kParen = k;
      let handled = false;
      let nestedLink = false; // the label contains a link: outer link cannot form
      let fullRefAttempted = false; // '[a][b]' was attempted: no shortcut fallback
      // inline link (dest ...)
      if (kParen < n && src.charCodeAt(kParen) === CC_LPAREN) {
        const lp = parseLinkParen(src, kParen);
        if (lp) {
          const href = cleanUrl(lp.href);
          if (href !== null) {
            // a link cannot contain another MARKDOWN link: snapshot the
            // markdown-link count before rendering the label; an autolink
            // inside the label does not block the outer link (doc-08/09)
            const linksBefore = mdLinkCount;
            const labelHtml = isImg ? null : inlineStr(labelRaw, refs, false, true);
            if (!isImg && labelHtml !== null && mdLinkCount !== linksBefore) {
              // fall through to the literal '[' handling below; do NOT take
              // the suppress-emphasis path (the inner emphasis must form)
              nestedLink = true;
            } else {
              flush();
              if (isImg) {
                out.push('<img src="' + escAttrKeepEnt(href) + '" alt="' + plainTextOf(labelRaw, refs) + '"' +
                  (lp.title !== null ? ' title="' + escAttrKeepEnt(lp.title) + '"' : '') + '>');
              } else {
                mdLinkCount++;
                out.push('<a href="' + escAttrKeepEnt(href) + '"' +
                  (lp.title !== null ? ' title="' + escAttrKeepEnt(lp.title) + '"' : '') + '>' +
                  labelHtml + '</a>');
              }
              i = lp.next; handled = true;
            }
          }
        }
      }
      if (handled) continue;
      // full / collapsed reference link — '[' must follow ']' immediately
      if (k < n && src.charCodeAt(k) === CC_LBRACKET) {
        const refEnd = findLabelEnd(src, k);
        if (refEnd !== -1) {
          fullRefAttempted = true;
          const refLabel = refEnd === k + 1 ? labelRaw : src.slice(k + 1, refEnd);
          const ref = refs.get(normalizeRef(refLabel));
          if (ref) {
            if (isImg) {
              flush();
              out.push('<img src="' + escAttrKeepEnt(ref.href) + '" alt="' + plainTextOf(labelRaw, refs) + '"' +
                (ref.title !== null ? ' title="' + escAttrKeepEnt(ref.title) + '"' : '') + '>');
              i = refEnd + 1; continue;
            }
            const linksBefore = mdLinkCount;
            const labelHtml = inlineStr(labelRaw, refs, false, true);
            if (mdLinkCount === linksBefore) {
              flush();
              mdLinkCount++;
              out.push('<a href="' + escAttrKeepEnt(ref.href) + '"' +
                (ref.title !== null ? ' title="' + escAttrKeepEnt(ref.title) + '"' : '') + '>' +
                labelHtml + '</a>');
              i = refEnd + 1; continue;
            }
          }
        }
      }
      // shortcut reference — only when no full reference was attempted
      if (!fullRefAttempted) {
        const ref = refs.get(normalizeRef(labelRaw));
        if (ref) {
          const linksBefore = mdLinkCount;
          const labelHtml = isImg ? null : inlineStr(labelRaw, refs, false, true);
          if (isImg || mdLinkCount === linksBefore) {
            flush();
            if (isImg) {
              out.push('<img src="' + escAttrKeepEnt(ref.href) + '" alt="' + plainTextOf(labelRaw, refs) + '"' +
                (ref.title !== null ? ' title="' + escAttrKeepEnt(ref.title) + '"' : '') + '>');
            } else {
              mdLinkCount++;
              out.push('<a href="' + escAttrKeepEnt(ref.href) + '"' +
                (ref.title !== null ? ' title="' + escAttrKeepEnt(ref.title) + '"' : '') + '>' +
                labelHtml + '</a>');
            }
            i = labelEnd + 1; continue;
          }
        }
      }
      // complete (...) group but the link failed: suppress emphasis
      if (!nestedLink && kParen < n && src.charCodeAt(kParen) === CC_LPAREN && findParenClose(src, kParen) !== -1) {
        flush();
        out.push('[' + inlineStr(labelRaw, refs, true) + ']');
        i = labelEnd + 1; handled = true;
      }
      if (handled) continue;
      // no link: literal '[' (and '!' if image)
      buf += isImg ? '![' : '[';
      i = start + 1;
      continue;
    }
    // emphasis / del delimiters
    if (c === CC_STAR || c === CC_UNDER || c === CC_TILDE) {
      let j = i;
      while (j < n && src.charCodeAt(j) === c) j++;
      const len = j - i;
      if (noEm || (c === CC_TILDE && len >= 3)) {
        buf += src.slice(i, j); i = j; continue;
      }
      const before = i > 0 ? src.charCodeAt(i - 1) : -1;
      const after = j < n ? src.charCodeAt(j) : -1;
      const fl = flanking(before, after);
      let open = false, close = false;
      if (c === CC_UNDER) {
        open = fl.left && (!fl.right || fl.bP);
        close = fl.right && (!fl.left || fl.aP);
      } else {
        open = fl.left; close = fl.right;
      }
      pushDelim(c, len, open, close);
      i = j; continue;
    }
    // newline: soft or hard break
    if (c === CC_LF) {
      let sp = 0;
      for (let t = buf.length - 1; t >= 0 && buf.charCodeAt(t) === 32; t--) sp++;
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp); flush(); out.push('<br>');
        // after a hard break the next line's leading whitespace is
        // stripped (cm-636/637: "foo  \n     bar" -> "foo<br>bar")
        let k = i + 1;
        while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9)) k++;
        i = k; continue;
      }
      else { flush(); out.push('\n'); }
      i++; continue;
    }
    // GFM autolink / email (only at a word start). GFM autolinks are
    // suppressed inside a link label (doc-01: a bare URL in a label stays
    // plain text); angle-bracket autolinks still form there (above).
    if (!noGfm && (c === 119 || c === 104 || c === 102 || isAlphaNum(c))) {
      const prev = i > 0 ? src.charCodeAt(i - 1) : -1;
      const g = parseGfmAutolink(src, i, prev);
      if (g) { flush(); out.push(g[0]); i = g[1]; continue; }
    }
    // fast path: plain text run of word chars only — every word start goes
    // through the loop above so the GFM autolink check runs on it
    let j = i;
    while (j < n) {
      const ch = src.charCodeAt(j);
      if (isAlphaNum(ch) || (ch >= 128 && !isPunctUni(ch) && !isWSChar(ch))) j++;
      else break;
    }
    if (j === i) { buf += src[i]; i++; continue; }
    buf += src.slice(i, j);
    i = j;
  }
  flush();
  // ---- emphasis resolution (CommonMark Appendix A, phase 2) ----
  // spans of already-formed emphasis, as [openerPos, closerPos]; an
  // opener inside a span cannot pair with a closer outside it (that
  // would cross an emphasis boundary — cm-469/470)
  const emSpans = [];
  for (let di = 0; di < delims.length; di++) {
    const closer = delims[di];
    if (!closer.close || closer.len === 0) continue;
    let oi = di - 1;
    while (oi >= 0 && closer.len > 0) {
      const opener = delims[oi];
      if (opener.ch === closer.ch && opener.open && opener.len > 0) {
        // A single-delimiter closer must not steal a two-delimiter
        // opener that a later closer of the same char needs for strong:
        // "**public as *so*other* option html**" — the "*" after
        // "other" must stay literal so the trailing "**" forms strong
        // with the opening "**" (doc-01). But a "***" opener (len 3)
        // may give one delimiter to a single closer and still leave two
        // for a later strong (cm-430 "***foo* bar**").
        if (closer.len === 1 && opener.len === 2) {
          let laterStrong = false;
          for (let k = di + 1; k < delims.length; k++) {
            if (delims[k].ch === closer.ch && delims[k].close && delims[k].len >= 2) { laterStrong = true; break; }
          }
          if (laterStrong) { oi--; continue; }
        }
        // the opener sits inside a formed emphasis but the closer is
        // outside it: skip this opener (do not cross the boundary)
        let crossed = false;
        for (let s = 0; s < emSpans.length; s++) {
          const sp = emSpans[s];
          if (sp[0] < opener.pos && opener.pos < sp[1] && closer.pos > sp[1]) { crossed = true; break; }
        }
        if (crossed) { oi--; continue; }
        // odd-match rule (Appendix A rule 9): if EITHER delimiter can
        // both open and close, the sum of the run lengths must not be a
        // multiple of 3 unless both are multiples of 3
        const eitherBoth = (opener.open && opener.close) ||
                           (closer.open && closer.close);
        if (eitherBoth && (opener.len + closer.len) % 3 === 0 &&
            (opener.len % 3 !== 0 || closer.len % 3 !== 0)) { oi--; continue; }
        let use;
        if (closer.ch === CC_TILDE) {
          // del only forms on equal run lengths
          if (opener.len !== closer.len) { oi--; continue; }
          use = opener.len >= 2 ? 2 : 1;
        } else {
          use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
        }
        const tagOpen = use === 2
          ? (closer.ch === CC_TILDE ? '<del>' : '<strong>')
          : (closer.ch === CC_TILDE ? '<del>' : '<em>');
        const tagClose = use === 2
          ? (closer.ch === CC_TILDE ? '</del>' : '</strong>')
          : (closer.ch === CC_TILDE ? '</del>' : '</em>');
        opener.openTags.unshift(tagOpen);
        closer.closeTags.push(tagClose);
        opener.len -= use;
        closer.len -= use;
        emSpans.push([opener.pos, closer.pos]);
        if (opener.len === 0) { delims.splice(oi, 1); di--; oi--; continue; }
        // opener still has length: re-check the same opener
        continue;
      }
      oi--;
    }
  }
  // render delimiter records into strings
  for (let t = 0; t < out.length; t++) {
    const el = out[t];
    if (el && typeof el === 'object') {
      out[t] = el.closeTags.join('') + String.fromCharCode(el.ch).repeat(el.len) + el.openTags.join('');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------
function isBlank(line) { return /^[ \t]*$/.test(line); }

// indent of a line in columns (tab = to next multiple of 4); also returns the
// byte index where content starts
function lineIndent(line) {
  let col = 0, idx = 0;
  while (idx < line.length) {
    const c = line.charCodeAt(idx);
    if (c === 32) { col++; idx++; }
    else if (c === 9) { col += 4 - (col % 4); idx++; }
    else break;
  }
  return { col, idx };
}

// strip `cols` columns from the start of a line; a tab cut through becomes
// spaces (CommonMark rule)
function stripIndent(line, cols) {
  let col = 0, idx = 0;
  while (idx < line.length && col < cols) {
    const c = line.charCodeAt(idx);
    if (c === 32) { col++; idx++; }
    else if (c === 9) { const w = 4 - (col % 4); if (col + w <= cols) { col += w; idx++; } else { return ' '.repeat(col + w - cols) + line.slice(idx + 1); } }
    else break;
  }
  return line.slice(idx);
}

// strip `cols` columns, but a tab that starts exactly at the boundary is
// expanded to spaces (its remainder past the boundary). Used for list-item
// content stripping (doc-05: "   \tindented" stripped by 3 leaves
// " indented"); indented-code stripping keeps the tab (stripIndent above).
function stripIndentExpandTab(line, cols) {
  let col = 0, idx = 0;
  while (idx < line.length && col < cols) {
    const c = line.charCodeAt(idx);
    if (c === 32) { col++; idx++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; idx++; }
      else return ' '.repeat(col + w - cols) + line.slice(idx + 1);
    }
    else break;
  }
  if (idx < line.length && col === cols && line.charCodeAt(idx) === 9) {
    const w = 4 - (col % 4);
    return ' '.repeat(w) + line.slice(idx + 1);
  }
  return line.slice(idx);
}

function fenceMatch(line) {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  if (m[1][0] === '`' && m[2].indexOf('`') !== -1) return null;
  return { char: m[1][0], len: m[1].length, info: m[2] };
}

function atxMatch(line) {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/.exec(line);
  if (!m) return null;
  let text = m[2] === undefined ? '' : m[2];
  // strip a closing sequence of hashes (preceded by a space, or the whole
  // text when it is only hashes — the space after the opening hashes counts)
  text = text.replace(/[ \t]+#+[ \t]*$/, '').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (/^#+$/.test(text)) text = '';
  // a closing sequence must be preceded by a space to count
  return { level: m[1].length, text };
}

function thematicBreak(line) {
  return /^ {0,3}([*_-])(?:[ \t]*\1){2,}[ \t]*$/.test(line);
}

function setextMatch(line) {
  const m = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
  if (!m) return null;
  return m[1][0] === '=' ? 1 : 2;
}

const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

// returns an HTML block type (1-7) or 0 if the line does not start one
function htmlBlockStart(line) {
  const m = /^ {0,3}<(.*)$/.exec(line);
  if (!m) return 0;
  const rest = m[1];
  if (/^!(--|\[CDATA\[|[A-Z])/.test(rest)) {
    if (rest.startsWith('--')) return 2;
    if (rest.startsWith('[CDATA[')) return 5;
    return 4;
  }
  if (rest.startsWith('?')) return 3;
  if (/^script\b/i.test(rest) || /^pre\b/i.test(rest) || /^style\b/i.test(rest) || /^textarea\b/i.test(rest)) return 1;
  const tm = /^(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (tm) {
    const name = tm[2].toLowerCase();
    if (HTML_BLOCK_TAGS.has(name)) return 6;
    // type 7: a complete valid open/close tag and nothing else on the
    // line — validate with the inline tag parser, not a loose regex
    // (cm-619, cm-622: invalid attributes must not start a block)
    const ltIdx = line.indexOf('<');
    const ih = parseInlineHtml(line, ltIdx);
    if (ih) {
      let r = ih[1];
      while (r < line.length && (line.charCodeAt(r) === 32 || line.charCodeAt(r) === 9)) r++;
      if (r >= line.length) return 7;
    }
  }
  return 0;
}

function htmlBlockEnd(type, line) {
  switch (type) {
    case 1: return /<\/(script|pre|style|textarea)\s*>/i.test(line);
    case 2: return line.indexOf('-->') !== -1;
    case 3: return line.indexOf('?>') !== -1;
    case 4: return line.indexOf('>') !== -1;
    case 5: return line.indexOf(']]>') !== -1;
    default: return false; // 6 and 7 end at a blank line
  }
}

// list item marker: returns null or {type, marker, start, content, contentIndent}
function listItemMatch(line) {
  const ind = lineIndent(line);
  if (ind.col > 3) return null;
  const rest = line.slice(ind.idx);
  const m = /^([*+-]|\d{1,9}[.)])([ \t]+|[ \t]*$)/.exec(rest);
  if (!m) return null;
  const markerText = m[1];
  const isOrdered = /^\d/.test(markerText);
  const type = isOrdered ? 'ordered' : 'bullet';
  const marker = isOrdered ? markerText.slice(-1) : markerText;
  const start = isOrdered ? parseInt(markerText.slice(0, -1), 10) : null;
  const after = rest.slice(markerText.length);
  // count spaces/tabs after the marker (tab counts to the next multiple of 4)
  let spaces = 0, si = 0;
  while (si < after.length) {
    const c = after.charCodeAt(si);
    if (c === 32) { spaces++; si++; }
    else if (c === 9) { spaces += 4 - ((ind.col + markerText.length + spaces) % 4); si++; }
    else break;
  }
  let contentIndent;
  if (after.slice(si) === '' && si === after.length) {
    // empty item: content starts on a following line
    contentIndent = ind.col + markerText.length + 1;
  } else if (spaces >= 1 && spaces <= 4) {
    contentIndent = ind.col + markerText.length + spaces;
  } else {
    // 5+ spaces: content indent is marker + 1; the extra spaces are content
    contentIndent = ind.col + markerText.length + 1;
  }
  // content: the line with contentIndent columns stripped (not all spaces —
  // for 5+ spaces the surplus spaces stay and make an indented code block)
  const stripCols = contentIndent - ind.col;
  let content = rest.slice(stripCols);
  if (after.slice(si) === '' && si === after.length) content = '';
  return { type, marker, start, content, contentIndent, indent: ind.col, markerLen: markerText.length };
}

// would this line (logical, indent already stripped) start a non-paragraph block?
function isBlockStart(line) {
  if (isBlank(line)) return false;
  if (atxMatch(line) || fenceMatch(line) || thematicBreak(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (listItemMatch(line)) return true;
  if (htmlBlockStart(line)) return true;
  return false;
}

// does a logical line end with an open paragraph (for lazy continuations)?
// Looks through nested containers (blockquote markers, list items) to the
// innermost content (cm-292/293: a lazy line must reach a paragraph inside
// a blockquote inside a list item inside a blockquote).
function endsOpenPara(line) {
  if (isBlank(line)) return false;
  // strip leading blockquote markers and recurse into the content
  const bm = /^ {0,3}> ?/.exec(line);
  if (bm) return endsOpenPara(line.slice(bm[0].length));
  // a list item is not an indented code block even at indent 4+ — it is a
  // lazy paragraph continuation, not a new block (cm-238: "> foo\n    - bar"
  // keeps "- bar" as paragraph text). listItemMatch refuses indent > 3,
  // so detect the marker directly here.
  const m0 = /^ *([*+-]|\d{1,9}[.)])([ \t]+|[ \t]*$)/.exec(line);
  if (m0) {
    const after = line.slice(m0[0].length);
    if (after === '') return false;
    return endsOpenPara(after);
  }
  // an indented code line (4+ spaces) is a code block, not a paragraph,
  // so a lazy line cannot continue it
  if (lineIndent(line).col >= 4) return false;
  const lm = listItemMatch(line);
  if (lm) {
    if (lm.content === '') return false;
    return !isBlockStart(lm.content);
  }
  return !isBlockStart(line);
}

function endsOpenParaLines(lines) {
  for (let k = lines.length - 1; k >= 0; k--) {
    if (isBlank(lines[k])) continue;
    return endsOpenPara(lines[k]);
  }
  return false;
}

// Parse a title that may span lines. The opening quote is at lines[k][startIdx].
// Returns {title, next} (next = the line after the title's closing line) or null.
// ---------------------------------------------------------------------------
function parseTitleLines(lines, k, startIdx) {
  const first = lines[k];
  const c = first.charCodeAt(startIdx);
  if (c !== CC_QUOTE && c !== CC_SQUOTE && c !== CC_LPAREN) return null;
  const close = c === CC_LPAREN ? CC_RPAREN : c;
  let val = '', j = startIdx + 1, lineNo = k;
  while (true) {
    const s = lines[lineNo];
    while (j < s.length) {
      const ch = s.charCodeAt(j);
      if (ch === close) {
        // nothing but whitespace may follow on this line
        let r = j + 1;
        while (r < s.length && (s.charCodeAt(r) === 32 || s.charCodeAt(r) === 9)) r++;
        if (r !== s.length) return null;
        return { title: val, next: lineNo + 1 };
      }
      if (ch === CC_BACKSLASH && j + 1 < s.length && isPunct(s.charCodeAt(j + 1))) { val += s[j + 1]; j += 2; continue; }
      val += s[j]; j++;
    }
    // end of line: the title continues on the next line, but not across a
    // blank line (cm-197)
    lineNo++;
    if (lineNo >= lines.length) return null;
    if (isBlank(lines[lineNo])) return null;
    val += '\n';
    j = 0;
  }
}

// ---------------------------------------------------------------------------
// Reference definitions. tryRefDef(lines, i) parses a definition starting at
// line i (title may be on the next line). Returns null or
// {label, href, title, next}.
// ---------------------------------------------------------------------------
// Find a link label's closing ']' when the label may span lines. The label
// starts at lines[i] (indent already known to be <= 3, char '[' at ind.idx).
// Returns {label, endLine, endCol} (endCol = index of ']' in lines[endLine])
// or null. A blank line ends the label.
// ---------------------------------------------------------------------------
function findLabelEndLines(lines, i, indIdx) {
  let depth = 0;
  let label = '';
  let lineNo = i;
  let col = indIdx + 1; // just after '['
  while (lineNo < lines.length) {
    const s = lines[lineNo];
    let j = col;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === CC_BACKSLASH && j + 1 < s.length && isPunct(s.charCodeAt(j + 1))) {
        label += s[j + 1]; j += 2; continue;
      }
      if (c === CC_TICK) {
        // a code span: skip to its matching run on this line
        let k = j;
        while (k < s.length && s.charCodeAt(k) === CC_TICK) k++;
        const runLen = k - j;
        let m = k, found = -1;
        while (m < s.length) {
          if (s.charCodeAt(m) === CC_TICK) {
            let e = m;
            while (e < s.length && s.charCodeAt(e) === CC_TICK) e++;
            if (e - m === runLen) { found = m; break; }
            m = e;
          } else m++;
        }
        if (found === -1) return null;
        label += s.slice(j, found + runLen);
        j = found + runLen;
        continue;
      }
      if (c === CC_LBRACKET) { depth++; label += '['; j++; continue; }
      if (c === CC_RBRACKET) {
        if (depth === 0) return { label, endLine: lineNo, endCol: j };
        depth--; label += ']'; j++; continue;
      }
      label += s[j]; j++;
    }
    lineNo++;
    if (lineNo >= lines.length) return null;
    if (isBlank(lines[lineNo])) return null;
    label += '\n';
    col = 0;
  }
  return null;
}

function tryRefDef(lines, i) {
  const line = lines[i];
  const ind = lineIndent(line);
  if (ind.col > 3) return null;
  const s0 = line.slice(ind.idx);
  if (s0.charCodeAt(0) !== CC_LBRACKET) return null;
  // the label may span lines (cm-208, cm-541)
  let rawLabel, labelLineNo, labelEndCol, s;
  const le = findLabelEnd(s0, 0);
  if (le !== -1 && le !== 1) {
    rawLabel = s0.slice(1, le);
    labelLineNo = i;
    labelEndCol = ind.idx + le; // raw column of ']'
    s = lines[i]; // raw line: all indices below are raw columns
  } else {
    const ml = findLabelEndLines(lines, i, ind.idx);
    if (!ml || ml.label === '') return null;
    rawLabel = ml.label;
    labelLineNo = ml.endLine;
    labelEndCol = ml.endCol;
    s = lines[labelLineNo];
  }
  // label: no unescaped '[' inside (findLabelEnd handles nesting; a label
  // with a nested '[' is invalid here unless escaped)
  if (rawLabel.indexOf('[') !== -1 && rawLabel.indexOf('\\[') === -1) return null;
  // an empty label (after whitespace folding, e.g. "[\n ]") is not a
  // definition (cm-552)
  if (normalizeRef(rawLabel) === '') return null;
  let j = labelEndCol + 1;
  if (j >= s.length || s.charCodeAt(j) !== CC_COLON) return null;
  j++;
  while (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
  // destination: on this line, or on the next line if this line ends here
  // (the "next line" is relative to the line where the label ended)
  let destLine = s, destIdx = j, destLineNo = labelLineNo, next = labelLineNo + 1;
  if (destIdx >= destLine.length) {
    if (labelLineNo + 1 >= lines.length) return null;
    destLineNo = labelLineNo + 1;
    destLine = lines[destLineNo];
    destIdx = 0;
    while (destIdx < destLine.length && (destLine.charCodeAt(destIdx) === 32 || destLine.charCodeAt(destIdx) === 9)) destIdx++;
    if (destIdx >= destLine.length) return null;
    next = labelLineNo + 2;
  }
  // destination
  let href = null, k;
  if (destLine.charCodeAt(destIdx) === CC_LT) {
    k = destIdx + 1; let dest = '';
    while (k < destLine.length) {
      const c = destLine.charCodeAt(k);
      if (c === CC_GT) break;
      if (c === 10 || c === CC_LT) return null;
      if (c === CC_BACKSLASH && k + 1 < destLine.length && isPunct(destLine.charCodeAt(k + 1))) { dest += destLine[k + 1]; k += 2; continue; }
      dest += destLine[k]; k++;
    }
    if (k >= destLine.length) return null;
    href = dest; k++;
  } else {
    k = destIdx; let dest = '', depth = 0;
    while (k < destLine.length) {
      const c = destLine.charCodeAt(k);
      if (c === 32 || c === 9) break;
      if (c === CC_LPAREN) { depth++; dest += '('; k++; continue; }
      if (c === CC_RPAREN) { if (depth === 0) break; depth--; dest += ')'; k++; continue; }
      if (c < 32) return null;
      if (c === CC_BACKSLASH && k + 1 < destLine.length && isPunct(destLine.charCodeAt(k + 1))) { dest += destLine[k + 1]; k += 2; continue; }
      dest += destLine[k]; k++;
    }
    if (k === destIdx) return null;
    href = dest;
  }
  href = cleanUrl(href);
  if (href === null) return null;
  // after the destination there must be whitespace (or end of line) before
  // a title — a bare "(baz)" glued to the dest is not a title (cm-201)
  if (k < destLine.length && destLine.charCodeAt(k) !== 32 && destLine.charCodeAt(k) !== 9) return null;
  // optional title: starts on the dest line after the dest, or on the next
  // line; it may span lines (cm-196)
  let ti = k;
  while (ti < destLine.length && (destLine.charCodeAt(ti) === 32 || destLine.charCodeAt(ti) === 9)) ti++;
  if (ti >= destLine.length) {
    // dest line ends: a title may be on the next line; if it is not a
    // valid title the definition still stands without one (cm-210)
    if (next < lines.length) {
      const nl = lines[next];
      let ni = 0;
      while (ni < nl.length && (nl.charCodeAt(ni) === 32 || nl.charCodeAt(ni) === 9)) ni++;
      if (ni < nl.length) {
        const c = nl.charCodeAt(ni);
        if (c === CC_QUOTE || c === CC_SQUOTE || c === CC_LPAREN) {
          const tt = parseTitleLines(lines, next, ni);
          if (tt !== null) return { label: normalizeRef(rawLabel), href, title: tt.title, next: tt.next };
        }
      }
    }
    return { label: normalizeRef(rawLabel), href, title: null, next };
  }
  // something follows the dest on the same line: it must be a title
  const c = destLine.charCodeAt(ti);
  if (c !== CC_QUOTE && c !== CC_SQUOTE && c !== CC_LPAREN) return null;
  const tt = parseTitleLines(lines, destLineNo, ti);
  if (tt === null) return null;
  return { label: normalizeRef(rawLabel), href, title: tt.title, next: tt.next };
}

// parse a line that is ONLY a title ("...", '...', or (...)); returns the
// decoded title or null
function parseTitleOnly(s) {
  if (s.length === 0) return null;
  const c = s.charCodeAt(0);
  if (c !== CC_QUOTE && c !== CC_SQUOTE && c !== CC_LPAREN) return null;
  const close = c === CC_LPAREN ? CC_RPAREN : c;
  let j = 1, val = '';
  while (j < s.length) {
    const ch = s.charCodeAt(j);
    if (ch === close) {
      // nothing but whitespace may follow
      let r = j + 1;
      while (r < s.length && (s.charCodeAt(r) === 32 || s.charCodeAt(r) === 9)) r++;
      if (r !== s.length) return null;
      return val; // titles are NOT entity-decoded
    }
    if (ch === CC_BACKSLASH && j + 1 < s.length && isPunct(s.charCodeAt(j + 1))) { val += s[j + 1]; j += 2; continue; }
    val += s[j]; j++;
  }
  return null;
}

// ---------------------------------------------------------------------------
// parseBlocks(lines, refs, tight, inItem): renders a list of lines to HTML.
// tight: paragraphs at this level render without <p> tags (tight list items).
// inItem: true when parsing a list item's direct content — inside an item,
//   an ordered list may interrupt the item's paragraph regardless of its
//   start number (probed: "- Issue.\n  2. x" forms <ol start="2">, while
//   top-level and blockquote paragraphs need start 1 to be interrupted).
// ---------------------------------------------------------------------------
function parseBlocks(lines, refs, tight, inItem) {
  const html = [];
  let i = 0;
  const n = lines.length;
  let para = null; // array of paragraph lines, or null
  const flushPara = () => {
    if (para) {
      const text = para.join('\n');
      if (tight) html.push(inlineStr(text, refs, false));
      else html.push('<p>' + inlineStr(text, refs, false) + '</p>\n');
      para = null;
    }
  };

  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      // a whitespace-only line that is the LAST line of the input joins the
      // open paragraph (its spaces are kept as the paragraph's last line);
      // a truly empty line, or a blank line mid-input, ends the paragraph
      if (para && line !== '' && i === n - 1) { para.push(line); i++; continue; }
      flushPara(); i++; continue;
    }
    const ind = lineIndent(line);

    // --- reference definitions (only at the start of a paragraph) ---
    if (!para) {
      const def = tryRefDef(lines, i);
      if (def) {
        if (!refs.has(def.label)) refs.set(def.label, { href: def.href, title: def.title });
        i = def.next;
        continue;
      }
    }

    // --- setext heading / table delimiter (only when a paragraph is open) ---
    if (para) {
      const se = setextMatch(line);
      if (se) {
        const text = para.join('\n').trim();
        html.push('<h' + se + '>' + inlineStr(text, refs, false) + '</h' + se + '>\n');
        para = null; i++; continue;
      }
      if (para.length === 1 && isTableDelim(line)) {
        const t = parseTable(lines, i, para[0], refs);
        if (t) {
          html.push(t.html);
          para = null; i = t.next; continue;
        }
      }
    }

    // --- ATX heading ---
    const atx = atxMatch(line);
    if (atx) { flushPara(); html.push('<h' + atx.level + '>' + inlineStr(atx.text, refs, false) + '</h' + atx.level + '>\n'); i++; continue; }

    // --- fenced code ---
    const fm = fenceMatch(line);
    if (fm) {
      flushPara();
      const codeLines = [];
      let j = i + 1;
      while (j < n) {
        const cl = lines[j];
        const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(cl);
        if (cm && cm[1][0] === fm.char && cm[1].length >= fm.len) break;
        codeLines.push(stripIndent(cl, ind.col));
        j++;
      }
      // drop exactly one trailing empty line (the newline before the
      // closing fence is an artifact); a line holding spaces is content
      // (cm-129 keeps "  ", cm-318 keeps one of two blank lines)
      if (codeLines.length && codeLines[codeLines.length - 1] === '') codeLines.pop();
      const content = codeLines.length ? codeLines.join('\n') + '\n' : '';
      // the language is the info string's first word, with backslash
      // escapes decoded; entities in it are preserved, not re-escaped
      let lang = fm.info.trim().split(/\s+/)[0] || '';
      lang = lang.replace(/\\([!-/:-@\[-`{-~])/g, '$1');
      if (lang) html.push('<pre><code class="language-' + escAttrKeepEnt(lang) + '">' + escText(content) + '</code></pre>\n');
      else html.push('<pre><code>' + escText(content) + '</code></pre>\n');
      i = j < n ? j + 1 : j;
      continue;
    }

    // --- indented code (only when no paragraph is open) ---
    if (!para && ind.col >= 4) {
      flushPara();
      const codeLines = [];
      let j = i;
      while (j < n) {
        const cl = lines[j];
        if (isBlank(cl)) {
          // include if followed by more indented lines; keep the stripped
          // spaces (a whitespace-only line keeps its remainder after the
          // 4-space strip, it is not emptied)
          let k = j + 1;
          while (k < n && isBlank(lines[k])) k++;
          if (k < n && lineIndent(lines[k]).col >= 4) { codeLines.push(stripIndent(cl, 4)); j++; continue; }
          break;
        }
        if (lineIndent(cl).col < 4) break;
        codeLines.push(stripIndent(cl, 4));
        j++;
      }
      // drop trailing blank lines (whitespace-only lines too)
      while (codeLines.length && /^[ \t]*$/.test(codeLines[codeLines.length - 1])) codeLines.pop();
      const content = codeLines.length ? codeLines.join('\n') + '\n' : '';
      html.push('<pre><code>' + escText(content) + '</code></pre>\n');
      i = j;
      continue;
    }

    // --- HTML block ---
    const hbType = htmlBlockStart(line);
    if (hbType && (!para || hbType !== 7)) {
      flushPara();
      const blkLines = [line];
      let j = i + 1;
      if (hbType <= 5) {
        if (!htmlBlockEnd(hbType, line)) {
          while (j < n) {
            blkLines.push(lines[j]);
            if (htmlBlockEnd(hbType, lines[j])) { j++; break; }
            j++;
          }
        }
      } else {
        while (j < n && !isBlank(lines[j])) { blkLines.push(lines[j]); j++; }
      }
      // a trailing newline when the block runs to the end of the input and
      // the input ends with a newline (the last line is the trailing empty
      // string), OR when another block follows directly (no blank line),
      // OR when the following blank line is whitespace-only but non-empty
      // (probed: "<pre>\nfoo\n</pre>\n   \nbar" keeps "\n", but
      // "<pre>\nfoo\n</pre>\n\nbar" drops it — a truly empty line ends
      // the block without a trailing newline)
      const runsToEOF = j === n - 1 && lines[j] === '';
      const followedByContent = j < n && !isBlank(lines[j]);
      const followedByWSBlank = j < n && lines[j] !== '' && isBlank(lines[j]);
      html.push(blkLines.join('\n') + ((runsToEOF || followedByContent || followedByWSBlank) ? '\n' : ''));
      i = j;
      continue;
    }

    // --- thematic break ---
    if (thematicBreak(line)) { flushPara(); html.push('<hr>\n'); i++; continue; }

    // --- blockquote ---
    if (/^ {0,3}>/.test(line)) {
      flushPara();
      const bqLines = [];
      let lastPara = false;
      let j = i;
      let bqFence = null; // {char, len} while a fenced block is open inside
      // this blockquote — a lazy line (no ">") cannot continue a fence
      // (doc-01: ">```python" ... "used foo" ends the fence + blockquote)
      while (j < n) {
        const bl = lines[j];
        const bm = /^ {0,3}> ?/.exec(bl);
        if (bm) {
          const s = bl.slice(bm[0].length);
          bqLines.push(s);
          // lastPara looks through nested ">" markers to the innermost
          // content: a lazy line must reach the innermost open paragraph
          // (cm-250/251: "> > > foo" + "bar" -> bar joins the innermost p)
          let inner = s;
          let im;
          while ((im = /^ {0,3}> ?/.exec(inner))) inner = inner.slice(im[0].length);
          lastPara = endsOpenPara(inner);
          // track fences in the blockquote content (after stripping ">")
          const fm = fenceMatch(inner);
          if (fm && !bqFence) bqFence = { char: fm.char, len: fm.len };
          else if (fm && bqFence && fm.char === bqFence.char && fm.len >= bqFence.len && fm.info.trim() === '') bqFence = null;
          j++; continue;
        }
        if (isBlank(bl)) break;
        // a lazy continuation line: if it is indented 4+ spaces, 4 spaces
        // are stripped (the code-block indent does not apply to a lazy line).
        // Append it to the last paragraph line so it stays paragraph text
        // (a stripped "- bar" must not be re-parsed as a list item, cm-238).
        // A lazy "===" line is a failed setext underline: indent it 4
        // spaces so it cannot form a heading when re-parsed (cm-093).
        // A lazy line cannot continue a fenced code block: it ends the
        // blockquote (and the fence) instead (doc-01).
        if (bqFence) break;
        if (lastPara && !isBlockStart(bl)) {
          let stripped = lineIndent(bl).col >= 4 ? stripIndent(bl, 4) : bl;
          if (/^ {0,3}=+[ \t]*$/.test(stripped)) stripped = '    ' + stripped.trimStart();
          if (bqLines.length > 0) bqLines[bqLines.length - 1] += '\n' + stripped;
          else bqLines.push(stripped);
          j++; continue;
        }
        break;
      }
      html.push('<blockquote>\n' + parseBlocks(bqLines, refs, false, false) + '</blockquote>\n');
      i = j;
      continue;
    }

    // --- list ---
    const li = listItemMatch(line);
    if (li && (!para || li.type === 'bullet' || li.start === 1 || inItem) && !(para && li.content === '')) {
      const lst = parseList(lines, i, refs);
      if (lst) { flushPara(); html.push(lst.html); i = lst.next; continue; }
    }

    // --- paragraph line ---
    if (!para) para = [];
    para.push(line);
    i++;
  }
  flushPara();
  return html.join('');
}

// table delimiter row?
function isTableDelim(line) {
  const s = line.trim();
  if (s.indexOf('-') === -1) return false;
  // split into cells; each cell must match :?-{1,}:?
  let inner = s;
  if (inner.charCodeAt(0) === 124) inner = inner.slice(1);
  if (inner.charCodeAt(inner.length - 1) === 124) inner = inner.slice(0, -1);
  const cells = splitTableRow(inner);
  if (cells.length === 0) return false;
  for (const c of cells) {
    if (!/^[ \t]*:?-+[ \t]*:?[ \t]*$/.test(c) && !/^[ \t]*:?-+[ \t]*$/.test(c)) return false;
    if (!/:/.test(c) && !/-/.test(c)) return false;
    if (!/^:?-+:?$/.test(c.trim())) return false;
  }
  return true;
}

// split a table row on unescaped pipes
function splitTableRow(s) {
  const cells = [];
  let cur = '', j = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === CC_BACKSLASH && j + 1 < s.length && s.charCodeAt(j + 1) === 124) { cur += '|'; j += 2; continue; }
    if (c === 124) { cells.push(cur); cur = ''; j++; continue; }
    cur += s[j]; j++;
  }
  cells.push(cur);
  return cells;
}

function tableAlign(cell) {
  const t = cell.trim();
  const left = t.charCodeAt(0) === CC_COLON;
  const right = t.charCodeAt(t.length - 1) === CC_COLON;
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function parseTable(lines, i, headerLine, refs) {
  // the delimiter row must not be indented 4+ spaces (cm-087: "Foo\n
  // ----" is a paragraph, not a table — the ---- is indented code/text)
  if (lineIndent(lines[i]).col >= 4) return null;
  // header cells
  let h = headerLine.trim();
  if (h.charCodeAt(0) === 124) h = h.slice(1);
  if (h.charCodeAt(h.length - 1) === 124) h = h.slice(0, -1);
  const headerCells = splitTableRow(h);
  const ncol = headerCells.length;
  // delimiter cells -> alignments
  let d = lines[i].trim();
  if (d.charCodeAt(0) === 124) d = d.slice(1);
  if (d.charCodeAt(d.length - 1) === 124) d = d.slice(0, -1);
  const delimCells = splitTableRow(d);
  // the delimiter row must have the same number of columns as the header
  if (delimCells.length !== ncol) return null;
  const aligns = [];
  for (let c = 0; c < ncol; c++) aligns.push(c < delimCells.length ? tableAlign(delimCells[c]) : null);
  // body rows: continue until a blank line or a line that starts a new block
  const rows = [];
  let j = i + 1;
  while (j < lines.length) {
    const rl = lines[j];
    if (isBlank(rl)) break;
    if (isBlockStart(rl)) break;
    let r = rl.trim();
    if (r.charCodeAt(0) === 124) r = r.slice(1);
    if (r.charCodeAt(r.length - 1) === 124) r = r.slice(0, -1);
    rows.push(splitTableRow(r));
    j++;
  }
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < ncol; c++) {
    const a = aligns[c] ? ' align="' + aligns[c] + '"' : '';
    out += '<th' + a + '>' + inlineStr(headerCells[c].trim(), refs, false) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (rows.length) {
    out += '<tbody>';
    for (const row of rows) {
      out += '<tr>\n';
      for (let c = 0; c < ncol; c++) {
        const cell = c < row.length ? row[c].trim() : '';
        const a = aligns[c] ? ' align="' + aligns[c] + '"' : '';
        out += '<td' + a + '>' + inlineStr(cell, refs, false) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  out += '</table>\n';
  return { html: out, next: j };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------
function parseList(lines, i, refs) {
  const first = listItemMatch(lines[i]);
  if (!first) return null;
  const listType = first.type;
  const marker = first.marker;
  const baseIndent = lineIndent(lines[i]).col; // items of this list sit
  // within 3 columns of the first item's indent (cm-312: a marker at
  // indent 4+ is not a new item of this list)
  const items = [];
  let j = i;
  let loose = false;
  // fence state for the current item: a blank line inside a fenced code
  // block is fence content, not a list separator (cm-318). Tracked per
  // item, reset on a new item.
  let fence = null;
  while (j < lines.length) {
    const line = lines[j];
    const cur = items[items.length - 1];
    // a line indented to the current item's content is item content (a
    // nested list etc.), even if it looks like a marker — only a line less
    // indented than the content indent can start a new item of this list
    if (cur && !isBlank(line) && lineIndent(line).col >= cur.contentIndent) {
      const stripped = stripIndentExpandTab(line, cur.contentIndent);
      cur.lines.push(stripped);
      // update the fence state from this content line
      if (fence) {
        const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(stripped);
        if (cm && cm[1][0] === fence.char && cm[1].length >= fence.len) fence = null;
      } else {
        const fm = fenceMatch(stripped);
        if (fm) fence = { char: fm.char, len: fm.len };
      }
      j++;
      continue;
    }
    const m = listItemMatch(line);
    if (thematicBreak(line)) break; // a thematic break ends the list
    if (m && m.type === listType && m.marker === marker &&
        lineIndent(line).col <= baseIndent + 3) {
      // a new item
      fence = null;
      const item = { lines: [], contentIndent: m.contentIndent, task: null };
      let content = m.content;
      if (content !== '') {
        // task list marker: [ ] / [x] / [X] followed by whitespace or EOL
        const tm = /^\[( |x|X)\]([ \t]+|$)/.exec(content);
        if (tm) {
          item.task = tm[1] === ' ' ? 'unchecked' : 'checked';
          content = content.slice(tm[0].length);
        }
        if (content !== '') item.lines.push(content);
      }
      // the item's first content line may open a fence (cm-318: "- ```")
      if (content !== '') {
        const fm0 = fenceMatch(content);
        if (fm0) fence = { char: fm0.char, len: fm0.len };
      }
      items.push(item);
      j++;
      continue;
    }
    if (!cur) break;
    if (isBlank(line)) {
      // peek at the next non-blank line
      let k = j + 1;
      while (k < lines.length && isBlank(lines[k])) k++;
      if (k >= lines.length) break;
      const nm = listItemMatch(lines[k]);
      if (nm && nm.type === listType && nm.marker === marker &&
          lineIndent(lines[k]).col <= baseIndent + 3) {
        loose = true;
        j = k;
        continue;
      }
      // an empty item (no content lines yet) followed by a blank line is
      // done: the indented line after the blank is not its content
      // (cm-280: "-\n\n  foo" -> empty <li> plus a separate <p>)
      if (cur.lines.length === 0) break;
      if (lineIndent(lines[k]).col >= cur.contentIndent) {
        // inside a fenced code block the blank lines are fence content:
        // they neither separate items nor make the list loose (cm-318)
        if (fence) {
          for (let b = j; b < k; b++) cur.lines.push('');
          j = k;
          continue;
        }
        // a blank line inside the item makes THIS list loose only when it
        // separates two of the item's own direct children. If the item
        // already contains a nested list and the next line continues that
        // nested list (a nested item, or deeper-indented content of a
        // nested item), the blank is inside the nested list (which decides
        // its own looseness). Otherwise the blank separates direct
        // children — including a deeper-indented code block (cm-270).
        const sub = stripIndentExpandTab(lines[k], cur.contentIndent);
        const itemHasNested = cur.lines.some(l => listItemMatch(l));
        const nextIsNestedItem = !!listItemMatch(sub);
        if (!(itemHasNested && (nextIsNestedItem ||
              lineIndent(lines[k]).col > cur.contentIndent))) {
          loose = true;
        }
        // push one blank line per blank line seen (cm-264: two blank lines
        // inside an indented code block stay two blank lines)
        for (let b = j; b < k; b++) cur.lines.push('');
        j = k;
        continue;
      }
      break;
    }
    if (endsOpenParaLines(cur.lines) && !isBlockStart(line)) {
      // a lazy continuation line: 4+ spaces of indent lose 4 spaces.
      // Append it to the last paragraph line so it stays paragraph text:
      // a stripped "- e" must not be re-parsed as a new list item (cm-312).
      const stripped = lineIndent(line).col >= 4 ? stripIndent(line, 4) : line;
      if (cur.lines.length > 0) cur.lines[cur.lines.length - 1] += '\n' + stripped;
      else cur.lines.push(stripped);
      j++;
      continue;
    }
    break;
  }
  if (!items.length) return null;
  // render
  let out = '';
  if (listType === 'ordered') {
    out += first.start !== 1 ? '<ol start="' + first.start + '">\n' : '<ol>\n';
  } else {
    out += '<ul>\n';
  }
  for (const item of items) {
    let content = parseBlocks(item.lines, refs, !loose, true);
    if (item.task) {
      const cb = '<input ' + (item.task === 'checked' ? 'checked="" ' : '') + 'disabled="" type="checkbox">';
      if (content === '') content = cb;
      else if (content.startsWith('<p>')) content = '<p>' + cb + ' ' + content.slice(3);
      else content = cb + ' ' + content;
    }
    if (content === '') {
      out += '<li></li>\n';
    } else {
      out += '<li>' + content + '</li>\n';
    }
  }
  out += listType === 'ordered' ? '</ol>\n' : '</ul>\n';
  return { html: out, next: j };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
// expand tabs to spaces (to the next multiple of 4) in the LEADING
// whitespace of a line only — CommonMark preprocessing for indentation.
// Interior tabs are content and are preserved.
function expandTabs(line) {
  // Expand tabs to spaces ONLY in the line prefix (leading whitespace and
  // the whitespace after a blockquote / list / heading marker). A tab in the
  // content stays a literal tab (indented code and paragraphs keep it).
  // Tab stops are every 4 columns, counted from the line start.
  // A tab immediately after exactly 4 leading spaces is code content
  // (doc-02/doc-05: "    \tindented" keeps the tab); every other tab in
  // the prefix is expanded (cm-005 "\t\tbar" needs both tabs expanded).
  let out = '', col = 0, i = 0;
  let inPrefix = true;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 9) { // tab
      if (inPrefix && !(i === 4 && line.startsWith('    '))) { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
      else { out += '\t'; if (i === 4 && line.startsWith('    ')) inPrefix = false; }
      i++;
      continue;
    }
    if (c === 32) { out += ' '; col++; i++; continue; }
    if (!inPrefix) { out += line[i]; col++; i++; continue; }
    // in the prefix: blockquote, bullet, and heading markers keep it open
    if (c === 62 || c === 45 || c === 42 || c === 43 || c === 35) { out += line[i]; col++; i++; continue; }
    if (c >= 48 && c <= 57) {
      // ordered marker? digits + '.' or ')' + whitespace/tab
      let j = i;
      while (j < n && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
      if (j < n && (line.charCodeAt(j) === 46 || line.charCodeAt(j) === 41) &&
          j + 1 < n && (line.charCodeAt(j + 1) === 32 || line.charCodeAt(j + 1) === 9)) {
        out += line.slice(i, j + 1); col += (j + 1 - i); i = j + 1; continue;
      }
      inPrefix = false;
      out += line[i]; col++; i++; continue;
    }
    // any other character ends the prefix
    inPrefix = false;
    out += line[i]; col++; i++;
  }
  return out;
}

function parse(src) {
  src = src.replace(/\r\n?/g, '\n');
  const rawLines = src.split('\n');
  // Expand tabs, except inside fenced code blocks, where tabs are literal
  // content (doc-02: a "\tindented with a tab" fence line keeps its tab).
  // Fence open/close is detected on the expanded line; content lines keep
  // the raw line.
  const lines = [];
  let fence = null;
  for (const raw of rawLines) {
    const exp = expandTabs(raw);
    if (fence) {
      const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(exp);
      if (cm && cm[1][0] === fence.char && cm[1].length >= fence.len) {
        fence = null;
        lines.push(exp);
      } else {
        lines.push(raw);
      }
    } else {
      lines.push(exp);
      const fm = fenceMatch(exp);
      if (fm) fence = { char: fm.char, len: fm.len };
    }
  }
  const refs = new Map();
  collectRefs(lines, refs);
  return parseBlocks(lines, refs, false, false);
}

// first pass: collect reference definitions document-wide (top level and
// inside blockquotes / list items), skipping fenced code blocks
function collectRefs(lines, refs) {
  let i = 0;
  const n = lines.length;
  let inPara = false; // the previous non-blank line was a paragraph line
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { inPara = false; i++; continue; }
    const fm = fenceMatch(line);
    if (fm) {
      let j = i + 1;
      while (j < n) {
        const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j]);
        if (cm && cm[1][0] === fm.char && cm[1].length >= fm.len) break;
        j++;
      }
      i = j < n ? j + 1 : j;
      inPara = false;
      continue;
    }
    // a definition only starts a paragraph — never in the middle of one
    if (!inPara) {
      const def = tryRefDef(lines, i);
      if (def) {
        if (!refs.has(def.label)) refs.set(def.label, { href: def.href, title: def.title });
        i = def.next;
        inPara = false;
        continue;
      }
    }
    // blockquote: recurse into its stripped lines
    if (/^ {0,3}>/.test(line)) {
      const bqLines = [];
      let j = i;
      while (j < n) {
        const bm = /^ {0,3}> ?/.exec(lines[j]);
        if (!bm) break;
        bqLines.push(lines[j].slice(bm[0].length));
        j++;
      }
      collectRefs(bqLines, refs);
      i = j;
      inPara = false;
      continue;
    }
    // a block-start line (or a setext underline closing a paragraph) ends
    // the paragraph; plain text continues it
    if (isBlockStart(line) || (inPara && setextMatch(line))) inPara = false;
    else inPara = true;
    i++;
  }
}

export { parse };
