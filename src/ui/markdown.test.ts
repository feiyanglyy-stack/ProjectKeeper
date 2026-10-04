/**
 * The Keeper's answers are drawn as Markdown (Spec §6.8; CKC-10 AC-21): bold, italics, code, lists, links, tables,
 * headings and quotes are rendered and their marks never show; `[src_…]` citations stay chips that open the source.
 * An answer is text a model wrote, possibly from anything it read, so it is untrusted: nothing in it is ever parsed as
 * HTML, a link is only a link when it is plain http(s), and marks left open (an answer still streaming) are shown as
 * they are instead of breaking the rest. The parser is pure and is checked here; the DOM it builds is checked against
 * a stand-in document that refuses `innerHTML`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillMarkdown, parseInline, parseMarkdown, safeHref } from '../../ui/markdown.js';
import type { Block, Inline } from '../../ui/markdown.js';

const SRC = 'src_0123456789abcdef';
const SRC2 = 'src_fedcba9876543210';

/** Every piece of text the reader would see, in order (code included), so a test can say "no mark is left showing". */
function shownText(nodes: readonly (Block | Inline)[]): string {
  const out: string[] = [];
  const walk = (n: Block | Inline): void => {
    const x = n as Record<string, unknown>;
    if (x.t === 'text' || (x.t === 'code' && typeof x.v === 'string')) out.push(String(x.v));
    if (x.t === 'code' && typeof x.text === 'string') out.push(x.text);
    if (x.t === 'cite') out.push(`{${String(x.id)}}`);
    if (x.t === 'br') out.push('\n');
    for (const key of ['kids', 'items', 'head', 'rows'] as const) {
      const v = x[key];
      if (Array.isArray(v)) (v.flat(3) as (Block | Inline)[]).forEach(walk);
    }
  };
  nodes.forEach(walk);
  return out.join('');
}
const kinds = (nodes: readonly (Block | Inline)[]) => nodes.map((n) => n.t);
const first = <T extends Block['t']>(md: string, t: T) => { const b = parseMarkdown(md).find((x) => x.t === t); assert.ok(b, `a ${t} block in ${JSON.stringify(md)}`); return b as Extract<Block, { t: T }>; };

test('bold, italics, strike-through and inline code are tokens, and their marks are not in the text', () => {
  const inl = parseInline('The **index** is *slow*, ~~fast~~ `search.ts` says so, and __this__ too.');
  assert.deepEqual(kinds(inl), ['text', 'b', 'text', 'i', 'text', 's', 'text', 'code', 'text', 'b', 'text']);
  assert.equal(shownText(inl), 'The index is slow, fast search.ts says so, and this too.');
  assert.doesNotMatch(shownText(inl), /\*|`|~~|__/);
});

test('bold next to full-width punctuation, and an underscore inside a name, are read the way they are written', () => {
  assert.equal(shownText(parseInline('**结论**：索引偏慢。')), '结论：索引偏慢。');
  assert.deepEqual(parseInline('the pending_source_ids field'), [{ t: 'text', v: 'the pending_source_ids field' }]);
});

test('headings, bullet and numbered lists (nested), quotes, rules and fenced code are blocks', () => {
  const md = ['# Finding', '', 'Two things:', '', '- first', '  - nested **deep**', '- second', '', '3. third', '4. fourth', '', '> quoted *line*', '', '---', '', '```ts', 'const a = `**not bold**`;', '```'].join('\n');
  const blocks = parseMarkdown(md);
  assert.deepEqual(kinds(blocks), ['h', 'p', 'list', 'list', 'quote', 'hr', 'code']);
  const [h, , ul, ol, , , code] = blocks as [Extract<Block, { t: 'h' }>, Block, Extract<Block, { t: 'list' }>, Extract<Block, { t: 'list' }>, Block, Block, Extract<Block, { t: 'code' }>];
  assert.equal(h.level, 1);
  assert.equal(ul.ordered, false);
  assert.equal(ul.items.length, 2);
  assert.deepEqual(kinds(ul.items[0]!), ['p', 'list'], 'the nested list belongs to the first item');
  assert.equal(ol.ordered, true);
  assert.equal(ol.start, 3);
  assert.equal(code.lang, 'ts');
  assert.equal(code.text, 'const a = `**not bold**`;', 'code is kept exactly, marks and all');
  assert.doesNotMatch(shownText(blocks.filter((b) => b.t !== 'code')), /\*\*|^#|^> |^- /m);
});

test('a heading may end in a run of hashes, which is not part of its text; a hash that belongs to a word stays', () => {
  const text = (md: string) => { const hd = first(md, 'h'); return { level: hd.level, text: shownText(hd.kids) }; };
  assert.deepEqual(text('## Title ##'), { level: 2, text: 'Title' });
  assert.deepEqual(text('### Title \t #####   '), { level: 3, text: 'Title' });
  assert.deepEqual(text('# Written in C#'), { level: 1, text: 'Written in C#' });
  assert.deepEqual(text('# Issue #12 and #13'), { level: 1, text: 'Issue #12 and #13' });
  assert.deepEqual(text('# ##'), { level: 1, text: '' });
  assert.deepEqual(text('####'), { level: 4, text: '' });
});

test('a table is a table: header, alignment, cells with inline marks', () => {
  const t = first(['| Work | State |', '|:-----|------:|', '| **T-2** | `In progress` |', '| T-3 | Replaced |'].join('\n'), 'table');
  assert.deepEqual(t.align, ['left', 'right']);
  assert.equal(shownText(t.head.flat()), 'WorkState');
  assert.equal(t.rows.length, 2);
  assert.deepEqual(kinds(t.rows[0]![0]!), ['b']);
  assert.deepEqual(kinds(t.rows[0]![1]!), ['code']);
});

test('links: a Markdown link, a bare address and an autolink become links to exactly that http(s) address', () => {
  const inl = parseInline('See [the plan](https://example.com/plan?x=1), https://example.com/a_(b). And <http://example.org/>');
  const links = inl.filter((x): x is Extract<Inline, { t: 'a' }> => x.t === 'a');
  assert.deepEqual(links.map((l) => l.href), ['https://example.com/plan?x=1', 'https://example.com/a_(b)', 'http://example.org/']);
  assert.equal(shownText(links[0]!.kids), 'the plan');
});

test('only plain http(s) addresses are links; every other scheme, and anything relative, is shown as text and goes nowhere', () => {
  const bad = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///C:/Windows/win.ini',
    '//evil.example/x', '/api/projects', 'mailto:a@example.com', 'https://user:pw@example.com/', 'https://example.com\\@evil.example/', 'ht\ttps://example.com', 'https://', 'blob:https://example.com/1'];
  for (const href of bad) assert.equal(safeHref(href), null, `not a link: ${JSON.stringify(href)}`);
  assert.equal(safeHref('https://example.com/a b'), null, 'an address with a space in it is not one address');
  assert.equal(safeHref('HTTPS://Example.com/Path'), 'https://example.com/Path');

  for (const md of ['[click me](javascript:alert(1))', '[click me](JAVASCRIPT:alert(1))', '[click me](data:text/html;base64,PHNjcmlwdD4=)', '[click me](//evil.example)', '[click me](/api/x)', '<javascript:alert(1)>']) {
    const inl = parseInline(md);
    const links = inl.filter((x): x is Extract<Inline, { t: 'a' }> => x.t === 'a');
    for (const l of links) assert.equal(l.href, null, `${md} has no address to go to`);
    assert.ok(shownText(inl).includes('click me') || md.startsWith('<'), `${md}: the words are still shown`);
  }
});

test('an image is never loaded: it is shown as a link to it, or as its words', () => {
  const [img] = parseInline('![diagram](https://example.com/d.png)') as [Extract<Inline, { t: 'a' }>];
  assert.equal(img.t, 'a');
  assert.equal(img.img, true);
  assert.equal(img.href, 'https://example.com/d.png');
  assert.equal(shownText(img.kids), 'diagram');
  const [bad] = parseInline('![x](javascript:alert(1))') as [Extract<Inline, { t: 'a' }>];
  assert.equal(bad.href, null);
});

test('HTML in an answer is text, never markup', () => {
  for (const html of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<b>bold</b>', '<iframe src="https://example.com"></iframe>', '<a href="javascript:alert(1)">x</a>', '&lt;script&gt;']) {
    const blocks = parseMarkdown(`before ${html} after`);
    assert.deepEqual(kinds(blocks), ['p']);
    assert.equal(shownText(blocks), `before ${html} after`, 'shown exactly as written');
    // An address written inside the HTML is still an address; everything else is text, and no token is markup.
    assert.ok((blocks[0] as Extract<Block, { t: 'p' }>).kids.every((k) => k.t === 'text' || (k.t === 'a' && k.href === 'https://example.com/' && shownText(k.kids) === 'https://example.com')), `${html}: text only`);
  }
});

test('marks left open are shown as they are, and an open code fence runs to the end (an answer still streaming)', () => {
  assert.equal(shownText(parseInline('**bold without an end')), '**bold without an end');
  assert.equal(shownText(parseInline('a `code without an end')), 'a `code without an end');
  assert.equal(shownText(parseInline('[a link without an end](https://example.com')), '[a link without an end](https://example.com');
  const open = parseMarkdown('Intro\n\n```js\nconst a = 1;\nconst b = **2**;');
  assert.deepEqual(kinds(open), ['p', 'code']);
  assert.equal((open[1] as Extract<Block, { t: 'code' }>).text, 'const a = 1;\nconst b = **2**;');
});

test('every prefix of an answer parses, so it can be drawn while it streams', () => {
  const md = ['## Result', '', `The **index** is slow [${SRC}].`, '', '| a | b |', '|---|---|', '| `x` | [y](https://example.com) |', '', '1. one', '   - *two*', '', '```', 'code', '```', '> done'].join('\n');
  for (let i = 0; i <= md.length; i++) {
    const blocks = parseMarkdown(md.slice(0, i));
    assert.ok(Array.isArray(blocks));
  }
});

test('source citations are chips wherever prose is, with or without brackets, and are left alone inside code', () => {
  const blocks = parseMarkdown([`The test is empty [${SRC}] and **the plan agrees ${SRC2}**.`, '', `- item [${SRC}]`, '', `| cell [${SRC2}] |`, '|---|', `| \`[${SRC}]\` |`, '', '```', `[${SRC}]`, '```'].join('\n'));
  const cites: string[] = [];
  const walk = (n: unknown): void => { if (Array.isArray(n)) { n.forEach(walk); return; } if (!n || typeof n !== 'object') return; const x = n as Record<string, unknown>; if (x.t === 'cite') cites.push(String(x.id)); for (const k of ['kids', 'items', 'head', 'rows']) walk(x[k]); };
  walk(blocks);
  assert.deepEqual(cites, [SRC, SRC2, SRC, SRC2], 'four in prose, none from the inline code or the code block');
  assert.equal(shownText(parseInline(`see [${SRC}].`)), `see {${SRC}}.`, 'the brackets belong to the chip');
  assert.equal(first(`\`\`\`\n[${SRC}]\n\`\`\``, 'code').text, `[${SRC}]`);
  assert.deepEqual(parseInline('src_123 is not an id'), [{ t: 'text', v: 'src_123 is not an id' }]);
});

test('a citation in brackets may carry any source id; a bare one only the generated form; a labelled one keeps its words', () => {
  // Generated ids are src_ plus 16 hex digits, but a project's assets may hold sources with other ids (a command run, an
  // imported record). In brackets the intent is unmistakable; bare, only the generated form is taken, so that a word
  // like src_dir in a sentence stays a word.
  assert.deepEqual(parseInline('ran it [src_cmd_bench1].'), [{ t: 'text', v: 'ran it ' }, { t: 'cite', id: 'src_cmd_bench1' }, { t: 'text', v: '.' }]);
  assert.deepEqual(parseInline('the src_dir folder and src_cmd_bench1'), [{ t: 'text', v: 'the src_dir folder and src_cmd_bench1' }]);
  // `[words][src_…]`: the words are what is cited, the chip follows them, and no bracket is left showing.
  const labelled = parseInline(`see [the **task** list][${SRC}] and [benchmark 记录][src_cmd_bench1].`);
  assert.equal(shownText(labelled), `see the task list{${SRC}} and benchmark 记录{src_cmd_bench1}.`);
  assert.deepEqual(kinds(labelled), ['text', 'text', 'b', 'text', 'cite', 'text', 'text', 'cite', 'text']);
  assert.equal(shownText(parseInline('[not a citation][other]')), '[not a citation][other]');
});

test('hostile input ends: deep nesting and long runs of marks neither overflow the stack nor hang', () => {
  const t0 = Date.now();
  const inputs = [
    `${'*'.repeat(60000)}x`, `${'>'.repeat(6000)} deep`, '*a '.repeat(20000), `${'['.repeat(20000)}x`, `a ${'`'.repeat(30001)} b`,
    Array.from({ length: 300 }, (_, i) => `${' '.repeat(i * 2)}- x`).join('\n'), `${'_'.repeat(40000)}x`, '[x]('.repeat(8000),
    // Lines shaped to make a careless pattern backtrack: a heading, a code fence and a table separator with a long gap.
    `# a${' '.repeat(60000)}b`, `\`\`\`${' '.repeat(60000)}\``, `| a |\n---${' '.repeat(60000)}x`, `a ${'~'.repeat(50000)} x ~`,
    // Ten times longer: work that grows with the square of the length would take minutes here, not milliseconds —
    // marks that open and never close, a heading with a long gap before its last word, brackets with nothing after.
    '*a '.repeat(200000), '**a '.repeat(150000), '_a '.repeat(200000), `# a${' '.repeat(600000)}b`, `## a${' \t'.repeat(200000)}b #`,
    `${'['.repeat(300000)}x`, '[x]('.repeat(100000),
  ];
  for (const input of inputs) {
    const started = Date.now();
    const blocks = parseMarkdown(input);
    assert.ok(blocks.length >= 1);
    assert.ok(shownText(blocks).length > 0, `nothing is swallowed: ${input.slice(0, 12)}…`);
    assert.ok(Date.now() - started < 2500, `${input.slice(0, 12)}… took ${Date.now() - started} ms`);
  }
  assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
});

// ── the DOM it builds ─────────────────────────────────────────────────────
class FakeNode { parent: FakeEl | null = null; }
class FakeText extends FakeNode { data: string; constructor(data: string) { super(); this.data = data; } }
class FakeEl extends FakeNode {
  readonly tagName: string;
  readonly ownerDocument: FakeDoc;
  children: FakeNode[] = [];
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, ((e: unknown) => void)[]>();
  readonly style: Record<string, string> = {};
  className = ''; title = ''; start = 1; type = '';
  constructor(tagName: string, doc: FakeDoc) { super(); this.tagName = tagName.toUpperCase(); this.ownerDocument = doc; }
  append(...nodes: (FakeNode | string)[]) { for (const n of nodes) { const node = typeof n === 'string' ? new FakeText(n) : n; node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes: (FakeNode | string)[]) { this.children = []; this.append(...nodes); }
  setAttribute(k: string, v: string) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  addEventListener(type: string, fn: (e: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  set textContent(v: string) { this.children = [new FakeText(String(v))]; }
  get textContent(): string { return this.children.map((c) => (c instanceof FakeText ? c.data : (c as FakeEl).textContent)).join(''); }
  set innerHTML(_v: string) { throw new Error('innerHTML must not be used for untrusted text'); }
  set outerHTML(_v: string) { throw new Error('outerHTML must not be used for untrusted text'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML must not be used for untrusted text'); }
  all(): FakeEl[] { return this.children.flatMap((c) => (c instanceof FakeEl ? [c, ...c.all()] : [])); }
}
class FakeDoc {
  createElement(tag: string) { return new FakeEl(tag, this); }
  createTextNode(data: string) { return new FakeText(data); }
}
const render = (md: string, opts: { onCite?: (id: string) => void } = {}) => { const root = new FakeDoc().createElement('div'); fillMarkdown(root as never, md, opts); return root; };

test('the DOM is built from elements and text nodes only, and what was written is what is shown', () => {
  const hostile = '<img src=x onerror=alert(1)> **bold** <script>alert(2)</script>';
  const root = render(hostile);
  assert.equal(root.textContent, '<img src=x onerror=alert(1)> bold <script>alert(2)</script>');
  assert.deepEqual([...new Set(root.all().map((e) => e.tagName))].sort(), ['P', 'STRONG'], 'no element comes from the text itself');
});

test('a link opens in a new window without handing over the opener; an address that is not http(s) is not a link at all', () => {
  const root = render('[plan](https://example.com/plan) and [trap](javascript:alert(1)) and ![pic](https://example.com/p.png)');
  const anchors = root.all().filter((e) => e.tagName === 'A');
  assert.equal(anchors.length, 2);
  for (const a of anchors) {
    assert.match(a.getAttribute('href') ?? '', /^https:\/\/example\.com\//);
    assert.equal(a.getAttribute('target'), '_blank');
    assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  }
  assert.equal(root.all().filter((e) => e.tagName === 'IMG').length, 0, 'no image is loaded');
  const trap = root.all().find((e) => e.textContent === 'trap')!;
  assert.notEqual(trap.tagName, 'A');
  assert.equal(trap.getAttribute('href'), null);
  assert.ok(root.all().every((e) => ![...e.attrs.values()].some((v) => /javascript:/i.test(v) && e.attrs.get('href') === v)), 'no href carries a script');
});

test('a citation is a button that opens that source; a table, a list and a code block come out as such', () => {
  const opened: string[] = [];
  const root = render([`Claimed, not shown [${SRC}].`, '', '| a | b |', '|---|:-:|', '| 1 | 2 |', '', '1. one', '2. two', '', '```', '<b>x</b>', '```'].join('\n'), { onCite: (id) => opened.push(id) });
  const chip = root.all().find((e) => e.className.split(' ').includes('cite'))!;
  assert.equal(chip.tagName, 'BUTTON');
  assert.equal(chip.textContent, SRC.slice(0, 10));
  chip.listeners.get('click')![0]!({ preventDefault() { /* a click */ } });
  assert.deepEqual(opened, [SRC]);
  const tags = root.all().map((e) => e.tagName);
  for (const t of ['TABLE', 'THEAD', 'TH', 'TD', 'OL', 'LI', 'PRE', 'CODE']) assert.ok(tags.includes(t), `${t} is built`);
  assert.equal(root.all().find((e) => e.tagName === 'PRE')!.textContent, '<b>x</b>');
  assert.equal(root.all().filter((e) => e.tagName === 'TD')[1]!.style.textAlign, 'center');
});
