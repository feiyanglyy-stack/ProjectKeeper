// Markdown in the Keeper's answers (Spec §6.8; CKC-10 AC-21). Bold, italics, strike-through, inline code, code blocks,
// headings, lists (bulleted, numbered, nested), quotes, rules, tables and links are rendered, so `**` and backticks do
// not show; what is not recognised is shown as written, never swallowed. `[src_…]` citations become chips.
//
// Two layers: parseMarkdown / parseInline turn text into blocks and inline tokens (pure, tested in
// src/ui/markdown.test.ts); fillMarkdown builds DOM from them. The parser follows WorkflowKeeper's renderer/markdown.js
// (the same owner's code), with this product's differences: links open in the browser, citations are tokens, and the
// input is bounded against hostile text.
//
// An answer is untrusted text — a model wrote it, possibly from any file it read:
//   - HTML is never parsed: <b>, <img>, <script> are shown as the characters they are. Only createElement,
//     createTextNode and textContent are used; there is no injection surface.
//   - A link is a link only when its address is plain http(s) (safeHref). It opens in a new window with
//     rel="noopener noreferrer". Any other scheme, and anything relative, is shown as its words and goes nowhere.
//   - Images are not loaded: fetching one would send a request on the answer's behalf, and the address can carry
//     whatever the answer read. `![words](address)` is shown as a link to the address.
//   - Nesting depth and the distance searched for a closing mark are capped, so no input overflows the stack or
//     takes quadratic time; past a cap the text is shown as written.
// While an answer streams it is not finished: an open code fence runs to the end, and an open `**` is shown as it is
// until its other half arrives.

const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
const ESCAPABLE = '\\`*_{}[]()#+-.!|~<>';
// Where a bare address ends: white space, quotes, angle brackets, a backtick, CJK text and full-width punctuation
// (in a Chinese sentence the address is often followed directly by words).
const BARE_URL = /^https?:\/\/[^\s<>"'`⺀-鿿　-〿＀-￯]+/i;
const URL_TAIL = /[.,;:!?\]}'"]+$/;
// A citation of a source. Generated ids are `src_` and 16 hex digits and are taken bare or bracketed; in brackets any
// source id is taken (a project's assets may hold sources with other ids), and `[words][src_…]` cites the words before it.
const CITE = /^\[?(src_[0-9a-f]{16})(?![0-9A-Za-z_])\]?/;
const CITE_BRACKETED = /^\[(src_[A-Za-z0-9_-]{1,64})\]/;
const CITE_LABELLED = /^\[([^[\]\n]{1,300})\]\[(src_[A-Za-z0-9_-]{1,64})\]/;
const WORD = /[\p{L}\p{N}_]/u;
const MAX_DEPTH = 16;      // blocks inside blocks (quotes, lists), and marks inside marks
const MAX_SPAN = 5000;     // how far a closing mark is looked for

const detab = (line) => line.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, '    '));
const indentOf = (line) => /^ */.exec(line)[0].length;
const stripIndent = (line, n) => { let k = 0; while (k < n && line[k] === ' ') k++; return line.slice(k); };
const isOrdered = (marker) => /\d/.test(marker);
const runAt = (s, i) => { let k = i; while (s[k] === s[i]) k++; return s.slice(i, k); };

/** The address a link may go to: plain http(s), nothing else. Returns the normalised address, or null. */
export function safeHref(raw) {
  const s = String(raw ?? '');
  if (!/^https?:\/\/[^/]/i.test(s)) return null;
  // No control characters, white space, quotes, angle brackets or backslashes: an address is one unbroken token.
  if (/[\x00-\x20\x7f-\x9f"'<>`\\]/.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname || u.username || u.password) return null;   // `https://bank.example@evil.example` reads as the wrong place
    return u.href;
  } catch { return null; }
}

/** @returns {Array<object>} blocks: p / h / code / hr / quote / list / table */
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map(detab);
  return parseBlocks(lines, 0);
}

/** An opening code fence: three or more backticks or tildes, then an optional language. */
function fenceAt(line) {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const info = m[3].trim();
  if (m[2][0] === '`' && info.includes('`')) return null;   // that is inline code, not a fence
  return { indent: m[1].length, fence: m[2], lang: info.split(/\s/)[0] ?? '' };
}

/** A heading's text without its closing run of hashes (`## Title ##`). By hand: a pattern for it backtracks over a long gap. */
function withoutClosingHashes(text) {
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  if (end === text.length) return text;
  if (end === 0) return '';
  if (text[end - 1] !== ' ' && text[end - 1] !== '\t') return text;   // `C#` ends in a hash that closes nothing
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  return text.slice(0, end);
}

function headingAt(line) {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
  if (!m) return null;
  return { level: m[1].length, text: withoutClosingHashes((m[2] ?? '').trim()) };
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** A table starts here when this line has a bar, the next is a separator row, and both have the same number of cells. */
function tableAt(lines, i) {
  if (i + 1 >= lines.length || !lines[i].includes('|')) return null;
  const sepLine = lines[i + 1].trim();
  if (!sepLine.includes('-') || /[^\s|:-]/.test(sepLine)) return null;
  const sep = splitRow(sepLine);
  if (!sep.every((c) => /^:?-+:?$/.test(c))) return null;
  const head = splitRow(lines[i]);
  return head.length === sep.length ? { head, sep } : null;
}

function startsBlock(lines, i) {
  const l = lines[i];
  return Boolean(fenceAt(l)) || Boolean(headingAt(l)) || HR.test(l) || QUOTE.test(l) || ITEM.test(l) || Boolean(tableAt(lines, i));
}

function parseBlocks(lines, depth) {
  const out = [];
  // Too deep to be anything a person wrote: the rest is shown as written.
  if (depth > MAX_DEPTH) { const rest = lines.join('\n').trim(); return rest ? [{ t: 'p', kids: plain(rest) }] : out; }
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = fenceAt(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length) {
        const c = FENCE_CLOSE.exec(lines[i]);
        if (c && c[1][0] === fence.fence[0] && c[1].length >= fence.fence.length) { i++; break; }
        body.push(stripIndent(lines[i], fence.indent));
        i++;
      }
      out.push({ t: 'code', lang: fence.lang, text: body.join('\n') });
      continue;
    }
    const heading = headingAt(line);
    if (heading) { out.push({ t: 'h', level: heading.level, kids: parseInline(heading.text) }); i++; continue; }
    if (HR.test(line)) { out.push({ t: 'hr' }); i++; continue; }
    const tb = tableAt(lines, i);
    if (tb) {
      const align = tb.sep.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
      const fit = (cells) => tb.head.map((_, k) => parseInline(cells[k] ?? ''));
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(fit(splitRow(lines[i]))); i++; }
      out.push({ t: 'table', align, head: fit(tb.head), rows });
      continue;
    }
    let m;
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && (m = QUOTE.exec(lines[i]))) { inner.push(m[1]); i++; }
      out.push({ t: 'quote', kids: parseBlocks(inner, depth + 1) });
      continue;
    }
    if (ITEM.test(line)) { i = parseList(lines, i, out, depth); continue; }
    // A paragraph: consecutive lines up to a blank line or the start of another block. Line breaks are kept — in a
    // conversation a new line is a new line.
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) { para.push(lines[i].trim()); i++; }
    out.push({ t: 'p', kids: parseInline(para.join('\n')) });
  }
  return out;
}

/** One list: items at the same indent with the same kind of marker; deeper lines belong to the item above them. */
function parseList(lines, i, out, depth) {
  const first = ITEM.exec(lines[i]);
  const base = first[1].length;
  const ordered = isOrdered(first[2]);
  const list = { t: 'list', ordered, start: ordered ? parseInt(first[2], 10) : null, items: [] };
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length !== base || isOrdered(m[2]) !== ordered || HR.test(lines[i])) break;
    const content = m[1].length + m[2].length + m[3].replace(/\t/g, '    ').length;
    const body = [m[4]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && indentOf(lines[j]) > base) { while (i < j) { body.push(''); i++; } continue; }
        break;
      }
      const ind = indentOf(l);
      if (ind > base) { body.push(stripIndent(l, Math.min(ind, content))); i++; continue; }
      if (startsBlock(lines, i)) break;
      body.push(l.trim());   // written straight after, not indented: still this item
      i++;
    }
    list.items.push(parseBlocks(body, depth + 1));
    // A blank line between items: the next one is still the same list.
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j > i && j < lines.length) {
      const n = ITEM.exec(lines[j]);
      if (n && n[1].length === base && isOrdered(n[2]) === ordered && !HR.test(lines[j])) i = j;
    }
  }
  out.push(list);
  return i;
}

/** From `from`, a run of exactly `len` backticks (the end of inline code); -1 when there is none. */
function codeClose(s, from, len) {
  for (let k = s.indexOf('`', from); k >= 0; k = s.indexOf('`', k)) {
    const run = runAt(s, k);
    if (run.length === len) return k;
    k += run.length;
  }
  return -1;
}

/** Past a piece of inline code starting at i: the position after it; i unchanged when no code starts there. */
function skipCode(s, i) {
  if (s[i] !== '`') return i;
  const run = runAt(s, i);
  const e = codeClose(s, i + run.length, run.length);
  return e >= 0 ? e + run.length : i + run.length;
}

/**
 * `[words](address)` with s[i] === '['. Brackets nest; brackets inside inline code do not count. `last` says where the
 * text's last `](` and last `)` are: past them no link can be, so a long run of brackets is not searched again and
 * again for an ending that is not there.
 */
function linkAt(s, i, last) {
  if (i > last.mid) return null;
  const limit = Math.min(s.length, i + MAX_SPAN);
  let depth = 0;
  let k = i;
  for (; k < limit; k++) {
    if (s[k] === '\\') { k++; continue; }
    if (s[k] === '`') { k = skipCode(s, k) - 1; continue; }
    if (s[k] === '[') depth++;
    else if (s[k] === ']' && --depth === 0) break;
  }
  if (k >= limit || s[k] !== ']' || s[k + 1] !== '(' || k + 2 > last.close) return null;
  const end = Math.min(s.length, k + 2 + MAX_SPAN);
  let p = k + 2;
  let par = 1;
  for (; p < end; p++) {
    if (s[p] === '\\') { p++; continue; }
    if (s[p] === '\n') return null;
    if (s[p] === '(') par++;
    else if (s[p] === ')' && --par === 0) break;
  }
  if (p >= end || s[p] !== ')') return null;
  const inside = s.slice(k + 2, p).trim();
  const m = /^(<[^<>\n]*>|\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'))?$/.exec(inside);
  if (!m) return null;
  return { label: s.slice(i + 1, k), href: m[1].replace(/^<|>$/g, ''), end: p + 1 };
}

/**
 * Bold, italics or strike-through starting at i: the inner side of the mark is not white space, and it closes.
 * `tried` remembers, for each kind of mark, how far an earlier one looked for its closing mark and found none. What
 * closes a mark does not depend on where it opened, so a later one looks on from there: a long run of marks that
 * never close is read once, not once per mark.
 */
function emphasisAt(s, i, tried) {
  const c = s[i];
  let d;
  if (c === '~') { if (s[i + 1] !== '~') return null; d = '~~'; }
  else d = s[i + 1] === c ? c + c : c;
  const open = i + d.length;
  if (!s[open] || /\s/.test(s[open])) return null;
  if (c === '_' && WORD.test(s[i - 1] ?? '')) return null;   // the underscore in snake_case is not a mark
  const limit = Math.min(s.length - d.length, open + MAX_SPAN);
  let j = Math.max(open + 1, tried[d] ?? 0);
  for (; j <= limit; j++) {
    if (s[j] === '`') { j = skipCode(s, j) - 1; continue; }
    if (s[j] === '\\') { j++; continue; }
    if (s[j] !== c) continue;
    const run = runAt(s, j);
    if (d.length === 1 && run.length !== 1) { j += run.length - 1; continue; }   // a single mark does not close on half of a double one
    if (run.length < d.length) continue;
    if (/\s/.test(s[j - 1])) { j += run.length - 1; continue; }
    const at = j + run.length - d.length;   // `***x***`: the last two close the bold, what is left inside is italics
    if (c === '_' && WORD.test(s[at + d.length] ?? '')) { j += run.length - 1; continue; }
    return { t: d === '~~' ? 's' : d.length === 2 ? 'b' : 'i', inner: s.slice(open, at), end: at + d.length };
  }
  tried[d] = Math.max(tried[d] ?? 0, j);
  return null;
}

function pushText(out, str) {
  str.split('\n').forEach((part, k) => {
    if (k) out.push({ t: 'br' });
    if (part) out.push({ t: 'text', v: part });
  });
}
const plain = (str) => { const out = []; pushText(out, str); return out; };

/**
 * @param {string} src
 * @param {{ depth?: number, cites?: boolean }} [o] `cites: false` inside a link's words, where a chip cannot go
 * @returns {Array<object>} inline tokens: text / br / code / b / i / s / a / cite
 */
export function parseInline(src, { depth = 0, cites = true } = {}) {
  const s = String(src ?? '');
  if (depth > MAX_DEPTH) return plain(s);
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { pushText(out, buf); buf = ''; } };
  const last = { mid: s.lastIndexOf(']('), close: s.lastIndexOf(')') };
  const tried = {};
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && s[i + 1] && ESCAPABLE.includes(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (c === '`') {
      const run = runAt(s, i);
      const end = codeClose(s, i + run.length, run.length);
      if (end < 0) { buf += run; i += run.length; continue; }
      let v = s.slice(i + run.length, end).replace(/\n/g, ' ');
      if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ') && v.trim()) v = v.slice(1, -1);
      flush();
      out.push({ t: 'code', v });
      i = end + run.length;
      continue;
    }
    // A citation of a source, with or without its brackets (after code, so one inside code is left alone).
    if (cites && (c === '[' || (c === 's' && !WORD.test(s[i - 1] ?? '')))) {
      const near = s.slice(i, i + 400);
      const m = CITE.exec(near) ?? (c === '[' ? CITE_BRACKETED.exec(near) : null);
      if (m) { flush(); out.push({ t: 'cite', id: m[1] }); i += m[0].length; continue; }
      const labelled = c === '[' ? CITE_LABELLED.exec(near) : null;
      if (labelled) { flush(); out.push(...parseInline(labelled[1], { depth: depth + 1, cites: false }), { t: 'cite', id: labelled[2] }); i += labelled[0].length; continue; }
    }
    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const img = c === '!';
      const link = linkAt(s, img ? i + 1 : i, last);
      if (link) {
        flush();
        const kids = img ? plain(link.label || link.href) : parseInline(link.label, { depth: depth + 1, cites: false });
        out.push({ t: 'a', href: safeHref(link.href), raw: link.href, ...(img ? { img: true } : {}), kids });
        i = link.end;
        continue;
      }
    }
    if (c === '<') {
      const m = /^<(https?:\/\/[^\s<>]{1,2000})>/i.exec(s.slice(i, i + 2010));
      if (m && safeHref(m[1])) { flush(); out.push({ t: 'a', href: safeHref(m[1]), raw: m[1], kids: [{ t: 'text', v: m[1] }] }); i += m[0].length; continue; }
    }
    if ((c === 'h' || c === 'H') && !/[A-Za-z0-9]/.test(s[i - 1] ?? '')) {
      const m = BARE_URL.exec(s.slice(i, i + 2000));
      if (m) {
        let url = m[0];
        for (let prev = ''; prev !== url;) {
          prev = url;
          url = url.replace(URL_TAIL, '');
          // A closing bracket left over at the end is not part of the address (paired ones inside it are).
          if (url.endsWith(')') && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) url = url.slice(0, -1);
        }
        if (safeHref(url)) { flush(); out.push({ t: 'a', href: safeHref(url), raw: url, kids: [{ t: 'text', v: url }] }); i += url.length; continue; }
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      const em = emphasisAt(s, i, tried);
      if (em) { flush(); out.push({ t: em.t, kids: parseInline(em.inner, { depth: depth + 1, cites }) }); i = em.end; continue; }
      const run = runAt(s, i);   // a run of marks that is not recognised is shown as written
      buf += run;
      i += run.length;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/**
 * Draw `text` as Markdown into `target`, replacing what it held.
 * @param {HTMLElement} target
 * @param {string} text
 * @param {{ onCite?: (id: string) => void }} [o] called when a source citation is pressed
 */
export function fillMarkdown(target, text, { onCite = null } = {}) {
  target.replaceChildren(...blocksDom(target.ownerDocument, parseMarkdown(text), onCite));
  return target;
}

function blocksDom(doc, blocks, onCite) {
  const mk = (tag, cls) => { const n = doc.createElement(tag); if (cls) n.className = cls; return n; };
  const inl = (n, kids) => { n.append(...inlineDom(doc, kids, onCite)); return n; };
  return blocks.map((b) => {
    if (b.t === 'p') return inl(mk('p'), b.kids);
    if (b.t === 'h') return inl(mk(`h${Math.min(6, Math.max(1, b.level))}`), b.kids);
    if (b.t === 'hr') return mk('hr');
    if (b.t === 'code') {
      const pre = mk('pre');
      const code = mk('code');
      code.textContent = b.text;
      if (b.lang) pre.title = b.lang;
      pre.append(code);
      return pre;
    }
    if (b.t === 'quote') { const n = mk('blockquote'); n.append(...blocksDom(doc, b.kids, onCite)); return n; }
    if (b.t === 'list') {
      const n = mk(b.ordered ? 'ol' : 'ul');
      if (b.ordered && b.start != null && b.start !== 1) n.start = b.start;
      for (const it of b.items) { const li = mk('li'); li.append(...blocksDom(doc, it, onCite)); n.append(li); }
      return n;
    }
    // A table too wide for a narrow panel scrolls sideways inside its own box; its cells are not squeezed to one letter a line.
    const wrap = mk('div', 'md-table');
    const t = mk('table');
    const row = (cells, tag) => {
      const tr = mk('tr');
      cells.forEach((cell, k) => { const td = inl(mk(tag), cell); if (b.align[k]) td.style.textAlign = b.align[k]; tr.append(td); });
      return tr;
    };
    const thead = mk('thead');
    thead.append(row(b.head, 'th'));
    const tbody = mk('tbody');
    for (const r of b.rows) tbody.append(row(r, 'td'));
    t.append(thead, tbody);
    wrap.append(t);
    return wrap;
  });
}

function inlineDom(doc, toks, onCite) {
  const out = [];
  for (const k of toks) {
    if (k.t === 'text') out.push(doc.createTextNode(k.v));
    else if (k.t === 'br') out.push(doc.createElement('br'));
    else if (k.t === 'code') { const n = doc.createElement('code'); n.textContent = k.v; out.push(n); }
    else if (k.t === 'cite') {
      const n = doc.createElement('button');
      n.type = 'button';
      n.className = 'cite';
      n.title = 'Open this source';
      n.textContent = k.id.slice(0, 10);
      if (onCite) n.addEventListener('click', (e) => { e.preventDefault(); onCite(k.id); });
      out.push(n);
    } else if (k.t === 'a') {
      // Checked again here, so a token from anywhere else cannot carry an address the parser would have refused.
      const href = safeHref(k.href);
      const n = doc.createElement(href ? 'a' : 'span');
      if (href) {
        n.setAttribute('href', href);
        n.setAttribute('target', '_blank');
        n.setAttribute('rel', 'noopener noreferrer');
        n.className = k.img ? 'md-link md-img' : 'md-link';
        n.title = k.img ? `${href} — image, not loaded` : href;
      } else {
        n.className = 'md-nolink';
        n.title = `Not a web link, so it is not opened: ${String(k.raw ?? '').slice(0, 200)}`;
      }
      n.append(...inlineDom(doc, k.kids, onCite));
      out.push(n);
    } else {
      const n = doc.createElement(k.t === 'b' ? 'strong' : k.t === 'i' ? 'em' : 'del');
      n.append(...inlineDom(doc, k.kids, onCite));
      out.push(n);
    }
  }
  return out;
}
