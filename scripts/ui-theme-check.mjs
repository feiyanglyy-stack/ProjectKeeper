// Browser check for the UI line's batch S2b (D68; Spec §6.16; CKC-09 AC-40, AC-41; CKC-10 AC-21): the theme picker
// and the four themes plus the factory look, what a switch leaves untouched (no request, the graph's zoom and pan, the
// conversation's scroll and half-typed text, the popover, the selection, an open strip row), the fallback when a theme
// cannot be loaded, the guard's layout invariants under every theme, the contrast of body, secondary and small text on
// their surfaces, the graph's four colours through palette-check.py, and the readability mark unchanged by a theme.
// It drives headless Chrome against a workbench that is ALREADY RUNNING on a seeded fixture home (never a real project):
//
//   node scripts/seed-ui-fixture.ts <fixture home>
//   node src/cli.ts serve --home <fixture home> --port 4926
//   node scripts/ui-theme-check.mjs http://127.0.0.1:4926 <dir for screenshots> [--themes i1,factory] [--no-shots]
//
// Colours are measured after CSS transitions are switched off (an unfocused window never composites a frame, so a
// transition stays at its start and getComputedStyle reads the previous theme — WorkflowKeeper's themes/README.md).
// Everything asserted is read off the page; it prints one line per check, writes <dir>/measurements.json, and exits 1
// if any check failed. The screenshots (1280×800: default, popover + docked Keeper, List, a dialog, Project scope) are
// taken for each theme named in --themes.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './ui-cdp.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const [base = 'http://127.0.0.1:4926', outDir = 'ui-theme-shots'] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--no-shots'));
const shotThemes = flag('--themes', 'i1,factory').split(',').map((s) => s.trim()).filter(Boolean);
// The themes measured in sections 3–5 and shot in section 7: `--themes a1,d2` measures those two; `factory` is the empty id.
const MEASURED = shotThemes.map((t) => (t === 'factory' ? '' : t));
const keyOf = (id) => id || 'factory';
const noShots = args.includes('--no-shots');
const PALETTE_CHECK = fileURLToPath(new URL('./palette-check.py', import.meta.url));
mkdirSync(outDir, { recursive: true });

const results = [];
const numbers = { themes: {} };
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

const workspace = await (await fetch(`${base}/api/workspace`)).json();
const projectId = workspace.projects.find((p) => /fixture/i.test(p.name))?.id ?? workspace.projects[0]?.id;
if (!projectId) throw new Error('the fixture home has no project');
const PID = encodeURIComponent(projectId);
const url = (view, rest = '') => `${base}/#/p/${PID}/${view}${rest ? `/${rest}` : ''}`;
const manifest = await (await fetch(`${base}/themes/manifest.json`)).json();
const THEMES = ['', ...manifest.themes.map((t) => t.id)];
const nameOf = (id) => (id === '' ? 'Factory' : manifest.themes.find((t) => t.id === id)?.name ?? id);

const b = await launch({ width: 1280, height: 800 });
const page = (body) => b.evaluate(`(async () => { const $ = (s) => document.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const cyOf = () => $('#cy')?._cyreg?.cy ?? null;
  const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const parse = (c) => { const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/.exec(c); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  /* the colour behind an element: its ancestors' background colours, composited from the first opaque one up */
  const behind = (el) => { let acc = null; for (let p = el; p; p = p.parentElement) { const c = parse(getComputedStyle(p).backgroundColor); if (!c || c.a === 0) continue; acc = acc ? { r: c.r * c.a + acc.r * (1 - c.a), g: c.g * c.a + acc.g * (1 - c.a), b: c.b * c.a + acc.b * (1 - c.a), a: 1 } : c; if (c.a >= 1 || acc.a >= 1) break; } return acc ?? { r: 0, g: 0, b: 0, a: 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const contrast = (a, bg) => { const l1 = lum(a), l2 = lum(bg); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  /* text colour over what is behind it, with the ratio and the font size */
  const reading = (sel, root = document) => { const el = (root.querySelectorAll ? root : document).querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); const fg = parse(cs.color); const el2 = el.closest('.strip-row.open') && !el.matches('.strip-row.open') ? el : el; const bg = behind(el2); const fgc = fg.a < 1 ? { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) } : fg; return { fg: hex(fgc), bg: hex(bg), ratio: Math.round(contrast(fgc, bg) * 100) / 100, px: parseFloat(cs.fontSize), weight: cs.fontWeight }; };
  const apiRequests = () => performance.getEntriesByType('resource').filter((e) => /\\/api\\//.test(e.name) && !/\\/api\\/events/.test(e.name)).length;
  const still = () => { if (!document.getElementById('pk-still')) { const s = document.createElement('style'); s.id = 'pk-still'; s.textContent = '*{transition:none!important;animation:none!important;caret-color:transparent!important}'; document.head.append(s); } };
  const switchTheme = async (id) => { const sel = $('.theme-pick select'); if (!sel) throw new Error('no theme picker'); if (sel.value === id) return 'same'; const done = new Promise((r) => document.addEventListener('pk:theme', (e) => r(e.detail.id), { once: true })); sel.value = id; sel.dispatchEvent(new Event('change', { bubbles: true })); return await Promise.race([done, new Promise((r) => setTimeout(() => r('timeout'), 12000))]); };
  const links = () => ({ board: $('#theme-board').getAttribute('href'), pk: $('#theme-pk').getAttribute('href') });
  const graphState = () => { const cy = cyOf(); if (!cy) return null; const pan = cy.pan(); return { zoom: Math.round(cy.zoom() * 1e6) / 1e6, pan: { x: Math.round(pan.x * 100) / 100, y: Math.round(pan.y * 100) / 100 }, nodes: cy.nodes().length, positions: cy.nodes().map((n) => n.id() + ':' + Math.round(n.position().x) + ',' + Math.round(n.position().y)).sort().join('|'), pictures: (() => { let h = 0; for (const n of cy.nodes()) for (const u of n.data('imgs') ?? []) for (let i = 0; i < u.length; i += 7) h = (h * 31 + u.charCodeAt(i)) >>> 0; return h; })(), selected: cy.$('node:selected').map((n) => n.id()) }; };
  ${body} })()`);

// ── 0. Start: a fresh profile remembers nothing, so the default opens ────────────────────────────────────────────
await b.navigate(url('graph'));
await b.waitFor(`Boolean(document.querySelector('#cy')?._cyreg?.cy?.nodes().length)`, { timeout: 20000 });
await sleep(1200);
const start = await page(`still(); return { links: links(), picker: $('.theme-pick select')?.value ?? null, options: $$('.theme-pick select option').map((o) => [o.value, o.textContent]), saved: (() => { try { return localStorage.getItem('pk.theme'); } catch { return 'n/a'; } })(), scheme: getComputedStyle(document.documentElement).colorScheme, inTopbar: Boolean($('.topbar .theme-pick')), beside: (() => { const p = $('.theme-pick'), s = $('.search-trigger'); return p && s ? Math.abs(rectOf(p).right - rectOf(s).left) < 20 : null; })() };`);
numbers.start = start;
check('the picker is in the top bar, beside the search, and lists the factory look and the four themes by their manifest names', start.inTopbar && start.beside !== false && JSON.stringify(start.options) === JSON.stringify([['', 'Factory'], ...manifest.themes.map((t) => [t.id, t.name])]), JSON.stringify(start.options));
check(`with nothing remembered the default opens: ${manifest.default}`, start.picker === manifest.default && start.links.board === `/themes/${manifest.default}/board.css` && start.links.pk === `/themes/${manifest.default}/pk.css` && start.saved === null, JSON.stringify({ picker: start.picker, links: start.links, saved: start.saved }));
const SCHEME = { a1: 'light', d2: 'light', b1: 'dark', i1: 'dark' };
check(`the default theme sets the colour scheme the native controls follow (${SCHEME[manifest.default]})`, start.scheme === SCHEME[manifest.default], start.scheme);

// ── 1. Every theme can be chosen: its two files load, the page reports no error, body text reads on the ground ───────
const guardNumbers = {};
for (const id of THEMES) {
  const errorsBefore = b.consoleLines.length;
  const r = await page(`const got = await switchTheme(${JSON.stringify(id)}); await new Promise((r) => setTimeout(r, 400)); still();
    const body = reading('.strip .row-text') ?? reading('body');
    const head = $('.section > header, .strip header');
    return { got, links: links(), picker: $('.theme-pick select').value, saved: (() => { try { return localStorage.getItem('pk.theme'); } catch { return 'n/a'; } })(), scheme: getComputedStyle(document.documentElement).colorScheme,
      bodyFont: getComputedStyle(document.body).font, bodyColor: getComputedStyle(document.body).color, bodyText: body,
      guard: { header: head ? getComputedStyle(head).position : null, h1: (() => { const h = document.createElement('h1'); h.textContent = 'x'; document.body.append(h); const s = getComputedStyle(h).fontSize; h.remove(); return s; })(), legendWrap: $('.legend') ? getComputedStyle($('.legend')).flexWrap : null, mk: $('.mk') ? getComputedStyle($('.mk')).fontSize : null, shellRows: getComputedStyle($('.shell')).display, mainOverflow: getComputedStyle($('#main')).overflowY, dockedTop: getComputedStyle(document.documentElement).getPropertyValue('--pk-top') },
      graph: graphState() };`);
  const expected = id === '' ? { board: '', pk: '' } : { board: `/themes/${id}/board.css`, pk: `/themes/${id}/pk.css` };
  const errors = b.consoleLines.slice(errorsBefore).filter((l) => !/wheel sensitivity|font-family/.test(l));
  numbers.themes[id || 'factory'] = { links: r.links, scheme: r.scheme, bodyFont: r.bodyFont, bodyColor: r.bodyColor, bodyText: r.bodyText, guard: r.guard, errors };
  guardNumbers[id || 'factory'] = r.guard;
  check(`${nameOf(id)}: chosen from the picker, its two files are the two links, the choice is remembered, and the page reports no error`, r.got !== 'timeout' && JSON.stringify(r.links) === JSON.stringify(expected) && r.picker === id && r.saved === id && errors.length === 0, JSON.stringify({ links: r.links, saved: r.saved, errors }));
  check(`${nameOf(id)}: body text reads at 4.5:1 or better where it stands`, r.bodyText && r.bodyText.ratio >= 4.5, JSON.stringify(r.bodyText));
  check(`${nameOf(id)}: the guard holds — section heads in the flow, h1 22px, the legend on one line, the strip's marks 10.5px, the shell a grid whose main view scrolls`, (r.guard.header === 'static' || r.guard.header === 'relative') && r.guard.h1 === '22px' && r.guard.legendWrap === 'nowrap' && (r.guard.mk === null || r.guard.mk === '10.5px') && r.guard.shellRows === 'grid' && r.guard.mainOverflow === 'auto', JSON.stringify(r.guard));
  check(`${nameOf(id)}: the colour scheme is the theme's (light for a1 and d2, dark for b1 and i1, the page's own for the factory)`, id === '' ? r.scheme === 'normal' : r.scheme === SCHEME[id], r.scheme);
}

// ── 2. A switch leaves everything but the colours: set up a rich state under i1, switch to the factory look and back ──
await page(`await switchTheme('i1'); return true;`);
await sleep(300);
// select a work item from the outline (its popover opens beside it), dock the Keeper, scroll its stream, type half a message, open a strip row
await b.clickOn('.outline .ol-work');
await b.waitFor(`Boolean(document.querySelector('.popover') && !document.querySelector('.popover').hidden)`);
await b.clickOn('#keeper-dock .dock-robot');
await b.waitFor(`document.querySelector('#keeper.open.docked') !== null`);
await sleep(600);
await page(`const st = $('#keeper-stream'); if (st) st.scrollTop = 140; const ta = $('.composer textarea'); if (ta) { ta.disabled = false; ta.value = 'half a question, not yet sent'; } return true;`);
await page(`const row = $$('.strip .item').find((el) => el.closest('[data-row]')?.dataset.row?.startsWith('change:')) ?? $('.strip .item'); row?.click(); return true;`);
await sleep(900);
const before = await page(`still(); return { requests: apiRequests(), graph: graphState(), popover: rectOf($('.popover')), popoverKey: $('.popover-title')?.textContent, stream: $('#keeper-stream')?.scrollTop ?? null, typed: $('.composer textarea')?.value ?? null, openRow: $('.strip-row.open')?.dataset.row ?? null, selection: $('#focus-crumb')?.textContent, outlineSel: $('#outline .sel')?.dataset.node ?? null, mainScroll: $('#main').scrollTop, stripScroll: $$('.strip .items').map((e) => e.scrollTop), keeperW: rectOf($('#keeper'))?.width, links: links() };`);
const switched = await page(`const got = await switchTheme(''); await new Promise((r) => setTimeout(r, 500)); still(); return { got, requests: apiRequests(), graph: graphState(), popover: rectOf($('.popover')), popoverKey: $('.popover-title')?.textContent, stream: $('#keeper-stream')?.scrollTop ?? null, typed: $('.composer textarea')?.value ?? null, openRow: $('.strip-row.open')?.dataset.row ?? null, selection: $('#focus-crumb')?.textContent, outlineSel: $('#outline .sel')?.dataset.node ?? null, mainScroll: $('#main').scrollTop, stripScroll: $$('.strip .items').map((e) => e.scrollTop), keeperW: rectOf($('#keeper'))?.width, links: links() };`);
const back = await page(`const got = await switchTheme('i1'); await new Promise((r) => setTimeout(r, 500)); still(); return { got, requests: apiRequests(), graph: graphState(), popover: rectOf($('.popover')), stream: $('#keeper-stream')?.scrollTop ?? null, typed: $('.composer textarea')?.value ?? null, openRow: $('.strip-row.open')?.dataset.row ?? null, links: links() };`);
numbers.switch = { before, switched, back };
const sameRect = (a, c) => JSON.stringify(a) === JSON.stringify(c);
check('a theme switch makes no /api/ request (the event stream aside), there and back', switched.requests === before.requests && back.requests === before.requests, `${before.requests} → ${switched.requests} → ${back.requests}`);
check('the graph keeps its zoom and pan and every object its position; only the pictures change', switched.graph.zoom === before.graph.zoom && sameRect(switched.graph.pan, before.graph.pan) && switched.graph.positions === before.graph.positions && switched.graph.nodes === before.graph.nodes && switched.graph.pictures !== before.graph.pictures && back.graph.pictures === before.graph.pictures && back.graph.zoom === before.graph.zoom && sameRect(back.graph.pan, before.graph.pan), JSON.stringify({ zoom: [before.graph.zoom, switched.graph.zoom, back.graph.zoom], pan: [before.graph.pan, switched.graph.pan, back.graph.pan], positionsSame: switched.graph.positions === before.graph.positions, picturesChanged: switched.graph.pictures !== before.graph.pictures }));
check('the selection stays: on the graph, in the crumb and in the outline', JSON.stringify(switched.graph.selected) === JSON.stringify(before.graph.selected) && switched.selection === before.selection && switched.outlineSel === before.outlineSel, JSON.stringify({ selected: before.graph.selected, crumb: before.selection }));
check('the conversation is untouched: #keeper-stream scrollTop, the half-typed message, the docked width', switched.stream === before.stream && back.stream === before.stream && switched.typed === before.typed && back.typed === before.typed && switched.keeperW === before.keeperW, JSON.stringify({ scrollTop: [before.stream, switched.stream, back.stream], typed: switched.typed, width: [before.keeperW, switched.keeperW] }));
check('the popover stays open beside the same object, in the same place', switched.popover && sameRect(switched.popover, before.popover) && switched.popoverKey === before.popoverKey && back.popover && sameRect(back.popover, before.popover), JSON.stringify({ before: before.popover, after: switched.popover }));
check('the open strip row stays open and no list is scrolled', switched.openRow === before.openRow && back.openRow === before.openRow && switched.mainScroll === before.mainScroll && JSON.stringify(switched.stripScroll) === JSON.stringify(before.stripScroll), JSON.stringify({ row: before.openRow, strip: before.stripScroll }));

// ── 3. The readability mark does not change with the theme (D46; AC-41) ──────────────────────────────────────────
const marks = {};
for (const id of MEASURED) {
  marks[keyOf(id)] = await page(`await switchTheme(${JSON.stringify(id)}); await new Promise((r) => setTimeout(r, 400)); const m = $('.read-mark'); return { text: m?.textContent, count: m?.dataset.count, title: (m?.title ?? '').slice(0, 80) };`);
}
numbers.readabilityMark = marks;
check(`the readability mark reads the same number under every theme measured (${MEASURED.map(keyOf).join(', ')})`, (() => { const all = Object.values(marks); return all.length >= 1 && all.every((m) => m.count === all[0].count && m.text === all[0].text); })(), JSON.stringify(marks));

// ── 4. Contrast: body, secondary and small text on their surfaces, under i1 and the factory look (AC-41) ───────────
const READINGS = [
  ['body on the card (popover sentence)', '.popover-sentence'], ['body in a strip row', '.strip .row-text'], ['body on the ground/rail (outline area)', '.outline .ol-area > span'],
  ['the Keeper\'s answer (strongest text)', '.msg.keeper .md, .msg.keeper'], ['the owner\'s message', '.msg.user'],
  ['secondary: the object of a strip row', '.strip .row-object'], ['secondary: outline work', '.outline .ol-work > span'], ['secondary: the crumb', '.crumb'], ['secondary: a legend item', '.legend .lg-item > span:not(.lg-icon)'],
  ['label: rail section (10.5px uppercase)', '.rail-section'], ['label: a strip row\'s time (10.5px)', '.strip .row-time'], ['label: the strip head\'s why line (10.5px)', '.strip-why'], ['label: popover sub (10.5px mono)', '.popover-sub'], ['label: a legend count chip', '.legend .lg-count'], ['label: a tag', '.popover .tag'], ['count: the rail\'s work count', '.outline .ol-area > small'],
  ['head: a strip column\'s title', '.strip header .strip-title > span'], ['control: a segment that is on', '.graph-tools .segmented button.active'], ['control: a segment that is off', '.graph-tools .segmented button:not(.active):not(:disabled)'], ['control: a button', '.graph-tools .btn'], ['the readability mark (alert)', '.read-mark'],
];
for (const id of MEASURED) {
  const rows = await page(`await switchTheme(${JSON.stringify(id)}); await new Promise((r) => setTimeout(r, 400)); still(); const probe = document.createElement('span'); probe.style.color = 'var(--pk-text-strong, var(--pk-text, #e7e7df))'; document.body.append(probe); const strongest = hex(parse(getComputedStyle(probe).color)); probe.remove(); return [['strongest', { fg: strongest }], ...${JSON.stringify(READINGS)}.map(([what, sel]) => [what, reading(sel)])];`);
  const strongest = rows.shift()[1].fg;
  numbers.contrast = numbers.contrast ?? {};
  numbers.contrast[keyOf(id)] = Object.fromEntries(rows);
  const body = rows.filter(([w, r]) => r && /^body|^the Keeper|^the owner/.test(w));
  const small = rows.filter(([w, r]) => r && /^label|^count|^secondary/.test(w));
  check(`${nameOf(id)}: body text and the conversation read at 4.5:1 or better on their surfaces (${body.length} readings)`, body.length >= 4 && body.every(([, r]) => r.ratio >= 4.5), body.map(([w, r]) => `${w.split(':')[0].slice(0, 22)} ${r.fg}/${r.bg} ${r.ratio}`).join('; '));
  check(`${nameOf(id)}: labels, counts and secondary text read at 4.5:1 or better (${small.length} readings)`, small.length >= 8 && small.every(([, r]) => r.ratio >= 4.5), small.map(([w, r]) => `${w.replace(/^(label|count|secondary): /, '').slice(0, 18)} ${r.ratio}`).join('; '));
  check(`${nameOf(id)}: the Keeper's answer and the owner's message take the theme's strongest text colour`, (() => { const a = rows.find(([w]) => w.startsWith('the Keeper'))?.[1], u = rows.find(([w]) => w.startsWith('the owner'))?.[1]; return a && u && a.fg === strongest && u.fg === strongest && rows.every(([, r]) => !r || r.ratio <= Math.max(a.ratio, u.ratio) + 0.01 || r.bg !== a.bg); })(), JSON.stringify({ strongest, answer: rows.find(([w]) => w.startsWith('the Keeper'))?.[1]?.fg, owner: rows.find(([w]) => w.startsWith('the owner'))?.[1]?.fg }));
}

// ── 5. The graph's four colours, from the palette in force, through palette-check.py (D53; AC-41) ────────────────
numbers.palette = {};
for (const id of MEASURED) {
  const p = await page(`await switchTheme(${JSON.stringify(id)}); await new Promise((r) => setTimeout(r, 300)); const g = await import('/graph.js'); return g.currentPalette();`);
  numbers.palette[keyOf(id)] = p;
  if (!existsSync(PALETTE_CHECK)) { check(`${nameOf(id)}: palette-check.py is at hand`, false, PALETTE_CHECK); continue; }
  const out = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [PALETTE_CHECK, `intent=${p.intent}`, `plan=${p.plan}`, `work=${p.work}`, `reality=${p.reality}`, '--bg', p.nodeBg], { encoding: 'utf8' });
  const text = out.stdout || out.stderr || '';
  const pair = /plan \/ work\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(text);
  const spread = /L\* spread ([\d.]+)/.exec(text);
  const contrasts = [...text.matchAll(/^(intent|plan|work|reality)\s+#\w+\s+([\d.]+)\s+([\d.]+)/gm)].map((m) => [m[1], Number(m[2]), Number(m[3])]);
  numbers.palette[keyOf(id) + 'Check'] = { pair: pair ? pair.slice(1).map(Number) : null, spread: spread ? Number(spread[1]) : null, contrasts, raw: text.slice(0, 1200) };
  check(`${nameOf(id)}: Plan / Work item apart under protan and deutan, not below the factory's 25.2 / 21.1`, pair && Number(pair[2]) >= 25.2 - 0.05 && Number(pair[3]) >= 21.1 - 0.05, pair ? `normal ${pair[1]}, protan ${pair[2]}, deutan ${pair[3]}; L* spread ${spread?.[1]}; contrast on ${p.nodeBg}: ${contrasts.map((c) => `${c[0]} ${c[2]}`).join(', ')}` : text.slice(0, 200));
}

// ── 6. A theme that cannot be loaded falls back to the factory look, the page stays usable, the choice is kept ─────
const fallback = await page(`const t = await import('/theme.js'); const done = new Promise((r) => document.addEventListener('pk:theme', (e) => r(e.detail.id), { once: true })); void t.applyTheme('nosuchtheme', { remember: false }); const got = await Promise.race([done, new Promise((r) => setTimeout(() => r('timeout'), 15000))]); await new Promise((r) => setTimeout(r, 300)); return { got, current: t.currentTheme(), links: links(), toast: $('#toast')?.textContent ?? '', picker: $('.theme-pick select').value, saved: localStorage.getItem('pk.theme'), body: reading('.strip .row-text') ?? reading('body'), graph: graphState() };`);
numbers.fallback = fallback;
check('a theme whose files do not load falls back to the factory look, says so, and the picker shows the factory look', fallback.got === '' && fallback.current === '' && fallback.links.board === '' && fallback.links.pk === '' && /could not be loaded/.test(fallback.toast) && fallback.picker === '' && fallback.body?.ratio >= 4.5 && fallback.graph?.nodes > 0, JSON.stringify({ toast: fallback.toast, links: fallback.links, picker: fallback.picker }));
await page(`await switchTheme('i1'); return true;`);

// ── 7. Screenshots (1280×800) per theme: default view, popover + docked Keeper, List, a dialog, Project scope ──────
if (!noShots) {
  for (const t of shotThemes) {
    const id = t === 'factory' ? '' : t;
    const dir = join(outDir, t);
    mkdirSync(dir, { recursive: true });
    // Remember the choice, then switch in place: navigating to the URL the app already shows changed nothing, so the
    // shots of every theme but the default were of the default (found by the d2 batch).
    // A fresh page for each theme, so nothing the last theme's shots left behind (a selection, the docked Keeper, an
    // open row) shapes this one; then the theme is switched in place.
    await b.navigate(`${base}/`);
    await sleep(300);
    await b.evaluate(`(() => { try { localStorage.removeItem('pk.theme'); } catch {} return location.reload(), true; })()`);
    await sleep(600);
    await b.navigate(url('graph'));
    await b.waitFor(`Boolean(document.querySelector('#cy')?._cyreg?.cy?.nodes().length)`, { timeout: 20000 });
    await page(`await switchTheme(${JSON.stringify(id)}); return true;`);
    await sleep(1500);
    await page(`still(); return true;`);
    const inForce = await page(`return { picker: $('.theme-pick select')?.value ?? null, board: links().board };`);
    check(`${nameOf(id)}: in force for its screenshots`, inForce.picker === id && (id === '' ? inForce.board === '' : inForce.board.includes(`/themes/${id}/`)), JSON.stringify(inForce));
    await b.shot(join(dir, '01-default.png'));
    await b.clickOn('.outline .ol-work');
    await b.waitFor(`Boolean(document.querySelector('.popover') && !document.querySelector('.popover').hidden)`);
    await b.clickOn('#keeper-dock .dock-robot');
    await b.waitFor(`document.querySelector('#keeper.open.docked') !== null`);
    await sleep(1200);
    await b.shot(join(dir, '02-popover-keeper.png'));
    await b.key('Escape');
    await b.clickOn('#keeper-dock .dock-robot');
    await sleep(500);
    await page(`$$('.graph-tools .segmented button').find((x) => x.textContent === 'List')?.click(); return true;`);
    await b.waitFor(`document.querySelector('.list-wrap') !== null`);
    await sleep(800);
    await b.shot(join(dir, '03-list.png'));
    await page(`$$('.top-actions button').find((x) => x.textContent === 'Vocabulary')?.click(); return true;`);
    await b.waitFor(`document.querySelector('#dialog')?.open === true`);
    await sleep(800);
    await b.shot(join(dir, '04-dialog.png'));
    await b.key('Escape');
    await sleep(300);
    await b.navigate(url('scope'));
    await b.waitFor(`document.querySelector('#in-scope') !== null`, { timeout: 20000 });
    await sleep(1200);
    await page(`still(); return true;`);
    await b.shot(join(dir, '05-scope.png'));
    console.log(`shots: ${dir}`);
  }
}

numbers.consoleLines = b.consoleLines.filter((l) => !/wheel sensitivity|font-family/.test(l));
check('the page reported no error through the whole run', numbers.consoleLines.length === 0, numbers.consoleLines.slice(0, 3).join(' | '));
await b.close();
writeFileSync(join(outDir, 'measurements.json'), JSON.stringify({ base, projectId, at: new Date().toISOString(), results, numbers }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  FAIL ${f.name}`).join('\n')}` : ''}`);
console.log(`measurements: ${join(outDir, 'measurements.json')}`);
process.exit(failed.length ? 1 : 0);
