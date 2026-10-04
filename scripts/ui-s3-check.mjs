// Browser check for the UI line's batch S3 (D68; CKC-09 AC-37, AC-38, part of AC-41, and the two leftovers of AC-1):
// the Project graph's controls in one row with the Graph / List / Code switch (§6.17), `Filter` and the readability
// mark, the graph's own buttons floating on
// its corner, the bottom strip one line per item with a full-width reading sheet, its height dragged and remembered, the
// pill clear of text without a reserved column, the popover keeping off the pill, and outline names in full.
// It drives headless Chrome with real mouse and key events against a workbench that is ALREADY RUNNING on a seeded
// fixture home (never a real project):
//
//   node scripts/seed-ui-fixture.ts <fixture home>
//   node src/cli.ts serve --home <fixture home> --port 4924
//   node scripts/ui-s3-check.mjs http://127.0.0.1:4924 <dir for screenshots> [--shots-only]
//
// `Since last visit` has content only the first time a freshly seeded home is opened, so the three-column checks run
// when the strip has three columns and say so when it does not. Everything asserted is measured on the page. It prints
// one line per check with the numbers, writes them to <dir>/measurements.json, and exits 1 if any check failed.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep, PAGE_HELPERS } from './ui-cdp.mjs';

const [base = 'http://127.0.0.1:4924', outDir = 'ui-s3-shots'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const results = [];
const numbers = {};
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const round = (r) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 10) / 10 : v])) : r);
const inside = (a, b2) => Boolean(a && b2) && a.left >= b2.left - 0.5 && a.top >= b2.top - 0.5 && a.right <= b2.right + 0.5 && a.bottom <= b2.bottom + 0.5;
const hit = (a, b2) => Boolean(a && b2) && a.left < b2.right - 0.5 && b2.left < a.right - 0.5 && a.top < b2.bottom - 0.5 && b2.top < a.bottom - 0.5;
const same = (a, b2) => JSON.stringify(round(a)) === JSON.stringify(round(b2));

const workspace = await (await fetch(`${base}/api/workspace`)).json();
const projectId = workspace.projects.find((p) => /fixture/i.test(p.name))?.id ?? workspace.projects[0]?.id;
if (!projectId) throw new Error('the fixture home has no project');
const PID = encodeURIComponent(projectId);
const url = (view, rest = '') => `${base}/#/p/${PID}/${view}${rest ? `/${rest}` : ''}`;

let b = await launch({ width: 1280, height: 800 });
const pageErrors = [];
const page = (body) => b.evaluate(`(async () => { ${PAGE_HELPERS}\n const $ = (s) => document.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)]; const views = (await import('/views.js')).views; const app = await import('/app.js'); const cyOf = () => $('#cy')._cyreg.cy; const button = (root, text) => $$('button', root).find((x) => x.textContent.trim() === text);\n ${body} })()`);
const settle = async (ms = 350) => { await sleep(ms); await b.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'); };
// A fresh browser for each section that wants a fresh page (see ui-s1-check.mjs: six event streams is the limit).
const openGraph = async ({ width = 1280, height = 800, mobile = false, keep = false } = {}) => {
  pageErrors.push(...b.consoleLines); await b.close(); b = await launch({ width, height, mobile });
  await b.navigate(url('graph'));
  if (!keep) { await b.waitFor("document.querySelector('#cy canvas') && document.querySelector('.strip')"); await page(`for (const k of ['pk.strip.height', 'pk.graph.stars']) localStorage.removeItem(k); return true;`); }
  await b.waitFor("document.querySelector('#cy canvas') && document.querySelector('.strip')");
  await settle(900);
};
const dock = async (on) => { const open = await page(`return Boolean($('#keeper')?.classList.contains('open'));`); if (open !== on) { await b.clickOn('#keeper-dock .dock-robot'); await settle(900); } };
/** The main view's visible area: what the docked Keeper leaves of it. */
const AREA = `(() => { const m = rectOf($('#main')); const k = $('#keeper'); if (k?.classList.contains('open') && k.classList.contains('docked')) m.right = Math.min(m.right, rectOf(k).left); return m; })()`;

// ── The control row, measured ──────────────────────────────────────────────────────────────────────────────────
const rowMeasure = () => page(`
  const row = $('.graph-tools'); const kids = [...row.children].filter((e) => e.getClientRects().length);
  const next = $('#main').firstElementChild;
  return { area: ${AREA}, header: rectOf($('.topbar')), inTop: Boolean(row.closest('.topbar')), row: rectOf(row), kids: kids.map((e) => ({ what: e.className.split(' ')[0], text: e.textContent.trim().slice(0, 40), rect: rectOf(e) })),
    controls: $$('button, select, input', row).filter((e) => e.getClientRects().length).map((e) => e.textContent.trim()),
    contentTop: rectOf(next).top, content: next.className, cy: $('#cy') ? rectOf($('#cy')) : null, strip: rectOf($('.strip')), readBar: Boolean($('.read-bar')),
    scrollW: document.documentElement.scrollWidth, innerW: innerWidth };`);
const oneRow = (m) => { const tops = m.kids.map((k) => Math.round(k.rect.top + k.rect.height / 2)); return Math.max(...tops) - Math.min(...tops) <= 2 && m.row.height <= 56 && m.kids.every((k) => inside(k.rect, m.row)); };
const floatMeasure = () => page(`
  const f = $('.graph-float'); if (!f) return null;
  const cy = cyOf(); const fr = rectOf(f); const box = rectOf($('#cy'));
  // An object as the graph's own fit sees it: its body, with the marks that stand over its top and the link count to its right.
  const z = cy.zoom(), pan = cy.pan();
  const under = cy.nodes().map((n) => { const p = n.position(), w = n.data('w') ?? n.width(), hgt = n.data('h') ?? n.height(); return { id: n.id(), left: box.left + (p.x - w / 2) * z + pan.x, top: box.top + (p.y - hgt / 2 - (n.data('overTop') ?? 0)) * z + pan.y, right: box.left + (p.x + w / 2 + (n.data('overRight') ?? 0)) * z + pan.x, bottom: box.top + (p.y + hgt / 2) * z + pan.y }; }).filter((r) => hit(r, fr)).map((r) => r.id);
  return { rect: fr, stage: rectOf($('.graph-stage')), area: ${AREA}, buttons: $$('button', f).map((x) => ({ text: x.textContent.trim(), disabled: x.disabled, active: x.classList.contains('active') })), under, padTop: Number($('#cy').dataset.fitPadTop), zoom: cy.zoom(), pan: cy.pan() };`);
const FLOAT_BUTTONS = ['Focus path', 'Expand upstream', 'Expand downstream', 'Fit', '↗ Link counts', 'All links'];

const controlRowChecks = async (where) => {
  const m = await rowMeasure();
  numbers[`row ${where}`] = { row: round(m.row), controls: m.controls, contentTop: m.contentTop, cy: round(m.cy), strip: round(m.strip) };
  // The row's contract since increment K (§6.17, CKC-24): the scale, Graph / List / Code, then the process view's
  // Expand all when it has expandable works (not on this fixture), then Filter, then the readability mark.
  const core = m.controls.filter((t) => !/^Expand all$|^Fold all$/.test(t));
  check(`${where}: the controls are one row — the scale, Graph / List / Code, Filter, the readability mark`, oneRow(m) && core.length === 8 && ['Overview', 'Work', 'Compare', 'Graph', 'List', 'Code'].every((t, i) => core[i] === t) && /^Filter( · \d+)?$/.test(core[6]) && /^◐ \d+$/.test(core[7]), `row ${Math.round(m.row.height)}px high · ${m.controls.join(' | ')}`);
  check(`${where}: the graph follows the top bar with no standalone control row`, m.inTop && Math.abs(m.contentTop - m.header.bottom) < 2 && /graph-wrap/.test(m.content) && !m.readBar && Math.abs(m.cy.top - m.header.bottom) < 2, `header ends ${Math.round(m.header.bottom)} · ${m.content} starts ${Math.round(m.contentTop)} · canvas ${Math.round(m.cy.top)}…${Math.round(m.cy.bottom)} (${Math.round(m.cy.height)}px)`);
  check(`${where}: the controls stay inside the top bar and the page has no horizontal overflow`, inside(m.row, m.header) && m.kids.every((k) => inside(k.rect, m.header)) && m.scrollW <= m.innerW, `header ${Math.round(m.header.left)}…${Math.round(m.header.right)}`);

  // The graph's own buttons float on its corner.
  const f = await floatMeasure();
  numbers[`float ${where}`] = { rect: round(f.rect), padTop: f.padTop, under: f.under, zoom: Math.round(f.zoom * 1000) / 1000 };
  check(`${where}: the graph's operations and the links switch float over its top right corner, wholly inside the main view`, FLOAT_BUTTONS.every((t) => f.buttons.some((x) => x.text === t)) && inside(f.rect, f.stage) && inside(f.rect, f.area) && f.stage.right - f.rect.right <= 12 && f.rect.top - f.stage.top <= 12, `${JSON.stringify(round(f.rect))} in stage ${JSON.stringify(round(f.stage))}`);
  check(`${where}: what needs a selected object is out of use without one; Fit and the links switch are not`, f.buttons.filter((x) => ['Focus path', 'Expand upstream', 'Expand downstream'].includes(x.text)).every((x) => x.disabled) && f.buttons.filter((x) => ['Fit', '↗ Link counts', 'All links'].includes(x.text)).every((x) => !x.disabled), JSON.stringify(f.buttons.map((x) => `${x.text}${x.disabled ? ' (off)' : ''}`)));
  check(`${where}: the view the graph opens on puts no object under the floating buttons`, f.under.length === 0 && f.padTop >= f.rect.bottom - f.stage.top, `band kept clear ${f.padTop}px · group ends ${Math.round(f.rect.bottom - f.stage.top)}px below the graph's top · under it: ${f.under.join(', ') || 'nothing'}`);

  // Filter: a floating panel.
  const before = await page(`return { wrap: rectOf($('.graph-wrap')), cy: rectOf($('#cy')), strip: rectOf($('.strip')), nodes: cyOf().nodes().length };`);
  await b.clickOn('.filter-btn');
  await b.waitFor("!document.querySelector('.flyout').hidden", { label: 'the Filter panel' });
  await settle(250);
  const fp = await page(`
    const p = $('.flyout'); const texts = (sel) => $$(sel, p).map((e) => e.textContent.trim());
    return { rect: rectOf(p), area: ${AREA}, button: rectOf($('.filter-btn')), expanded: $('.filter-btn').getAttribute('aria-expanded'), focusInside: p.contains(document.activeElement),
      selects: $$('select', p).map((x) => x.previousElementSibling?.textContent ?? x.id), ticks: texts('label.chk'), period: texts('.segmented button'), note: p.querySelector('.star-note')?.textContent ?? '', clear: p.querySelector('.flyout-foot button')?.textContent ?? null, clearOff: p.querySelector('.flyout-foot button')?.disabled ?? null,
      wrap: rectOf($('.graph-wrap')), cy: rectOf($('#cy')), strip: rectOf($('.strip')), pill: rectOf($('#keeper-dock .dock-pill')) };`);
  numbers[`filter panel ${where}`] = { rect: round(fp.rect), selects: fp.selects, ticks: fp.ticks, period: fp.period, note: fp.note };
  check(`${where}: Filter opens a floating panel — nothing under it moves — wholly inside the main view, under its button`, same(fp.wrap, before.wrap) && same(fp.cy, before.cy) && same(fp.strip, before.strip) && inside(fp.rect, fp.area) && fp.rect.top >= fp.button.bottom && fp.expanded === 'true' && fp.focusInside && !hit(fp.rect, fp.pill), `${JSON.stringify(round(fp.rect))} in ${JSON.stringify(round(fp.area))}`);
  check(`${where}: the panel holds the five choices, With notes, ★ only, Show replaced & deferred, the period the stars mark with its sentence, and Clear filters`, ['Category', 'Validity', 'Progress', 'Assessment'].every((t) => fp.selects.includes(t)) && fp.selects.length >= 4 && fp.ticks.includes('With notes') && fp.ticks.includes('★ only') && fp.ticks.some((t) => /^Show replaced & deferred/.test(t)) && fp.period.join('|') === '★ Since last visit|★ Last days' && fp.note.length > 0 && fp.clear === 'Clear filters' && fp.clearOff === true, JSON.stringify({ selects: fp.selects, ticks: fp.ticks, period: fp.period, note: fp.note.slice(0, 50) }));
  return { before };
};

try {
  // ── 1 · 1280 wide: one row, the panels float, every old control is within one more press (AC-37) ────────────
  await openGraph();
  await b.shot(join(outDir, '01-default.png'));
  const { before } = await controlRowChecks('1280 wide');
  // Two filters, with the keyboard and the mouse: the button carries the number and the picture has fewer objects.
  await page(`const s = $('#filter-progress'); s.value = 'Done'; s.dispatchEvent(new Event('change')); return true;`);
  await settle(500);
  await page(`const t = $$('.flyout label.chk input')[0]; t.click(); return true;`);
  await settle(600);
  const filtered = await page(`return { label: $('.filter-btn').textContent, title: $('.filter-btn').title, active: $('.filter-btn').classList.contains('active'), nodes: cyOf().nodes().length, open: !$('.flyout').hidden, clearOff: $('.flyout .flyout-foot button').disabled, progress: $('#filter-progress').value };`);
  check('two filters in force: the button says Filter · 2, names them on hover, the panel stays open, and the picture holds fewer objects', filtered.label === 'Filter · 2' && /Progress: Done/.test(filtered.title) && /With notes/.test(filtered.title) && filtered.active && filtered.open && filtered.nodes < before.nodes && !filtered.clearOff && filtered.progress === 'Done', JSON.stringify({ ...filtered, before: before.nodes }));
  await b.shot(join(outDir, '02-filter-open.png'));
  // What is shown is not a filter: the number stays.
  await page(`const t = $$('.flyout label.chk input').find((x) => /Show replaced/.test(x.parentElement.textContent)); t.click(); return true;`);
  await settle(600);
  await page(`button($('.flyout'), '★ Last days').click(); return true;`);
  await settle(600);
  const shown = await page(`return { label: $('.filter-btn').textContent, replaced: app.state.filters.showReplaced, stars: localStorage.getItem('pk.graph.stars'), note: $('.flyout .star-note')?.textContent ?? '' };`);
  check('Show replaced & deferred and the period of the stars are not filters: they take effect and the number stays 2', shown.label === 'Filter · 2' && shown.replaced === true && shown.stars === 'days' && /last|Nothing|Almost/i.test(shown.note), JSON.stringify(shown));
  await page(`button($('.flyout'), 'Clear filters').click(); return true;`);
  await settle(700);
  const cleared = await page(`return { label: $('.filter-btn').textContent, nodes: cyOf().nodes().length, replaced: app.state.filters.showReplaced, clearOff: $('.flyout .flyout-foot button').disabled, progress: $('#filter-progress').value };`);
  check('Clear filters puts every filter out of force in one press and leaves what is shown alone', cleared.label === 'Filter' && cleared.progress === '' && cleared.clearOff && cleared.replaced === true && cleared.nodes >= before.nodes, JSON.stringify({ ...cleared, before: before.nodes }));
  await page(`const t = $$('.flyout label.chk input').find((x) => /Show replaced/.test(x.parentElement.textContent)); t.click(); button($('.flyout'), '★ Since last visit').click(); return true;`);
  await settle(600);
  // Escape closes it and focus is back on the button; a press elsewhere closes it too; the keyboard opens it.
  await b.key('Escape');
  await settle(200);
  const afterEsc = await page(`return { hidden: $('.flyout').hidden, focus: document.activeElement === $('.filter-btn'), expanded: $('.filter-btn').getAttribute('aria-expanded') };`);
  check('Escape closes the panel and focus returns to the Filter button', afterEsc.hidden && afterEsc.focus && afterEsc.expanded === 'false', JSON.stringify(afterEsc));
  await b.key('Enter');
  await settle(300);
  const byKey = await page(`const p = $('.flyout'); return { open: !p.hidden, focusInside: p.contains(document.activeElement), stops: $$('select, input, button:not([disabled])', p).length };`);
  let stayed = true;
  for (let i = 0; i < byKey.stops + 2; i++) { await b.key('Tab'); stayed = stayed && (await page(`return $('.flyout').contains(document.activeElement);`)); }
  check('from the keyboard: Enter on the button opens the panel with focus inside, and Tab walks its items without leaving it', byKey.open && byKey.focusInside && stayed, `${byKey.stops} stops`);
  const stripAt = await page(`const r = rectOf($('.strip header')); return { x: r.left + 40, y: r.top + r.height / 2 };`);
  await b.click(stripAt.x, stripAt.y);
  await settle(250);
  check('a press elsewhere closes the panel', await page(`return $('.flyout').hidden;`));

  // The readability mark.
  const mark = await page(`
    const mk = $('.read-mark'); const tools = await import('/graph-tools.js');
    return { text: mk.textContent, title: mk.title, alert: mk.classList.contains('alert'), count: Number(mk.dataset.count), color: getComputedStyle(mk).color, quiet: getComputedStyle($('.graph-tools .segmented button:not(.active)')).color, amber: getComputedStyle(document.documentElement).getPropertyValue('--amber').trim(), cy: rectOf($('#cy')) };`);
  numbers.readabilityMark = mark;
  check('the readability mark says how many places are hard to read, and names the kinds on hover', /^◐ \d+$/.test(mark.text) && Number(mark.text.slice(2)) === mark.count && (mark.count === 0 ? /nothing/i.test(mark.title) && !mark.alert : /Hard to read in \d+ place/.test(mark.title) && mark.alert), `${mark.text} · ${mark.title.slice(0, 110)}`);
  await b.clickOn('.read-mark');
  await b.waitFor("!document.querySelector('.flyout').hidden", { label: 'the readability panel' });
  await settle(250);
  const rp = await page(`const p = $('.flyout'); return { rect: rectOf(p), area: ${AREA}, cy: rectOf($('#cy')), head: p.querySelector('.read-head')?.textContent ?? '', issues: $$('.read-issue', p).map((i) => ({ text: i.querySelector('b').textContent.slice(0, 70), buttons: $$('button', i).map((x) => x.textContent) })), kinds: $$('.read-head .tag', p).map((t) => t.textContent) };`);
  numbers.readabilityPanel = { rect: round(rp.rect), head: rp.head, issues: rp.issues };
  check('the mark opens a floating panel, wholly inside the main view, and the graph keeps its height', inside(rp.rect, rp.area) && same(rp.cy, mark.cy), `${JSON.stringify(round(rp.rect))} · canvas ${Math.round(rp.cy.height)}px before and after`);
  if (mark.count > 0) {
    const sizeIssue = rp.issues.find((i) => /windows/.test(i.text));
    check('the panel holds what the readability details held: each kind of problem with its objects and the ways out', rp.issues.length === rp.kinds.length && rp.issues.length > 0 && (!sizeIssue || (sizeIssue.buttons.includes('Show all anyway') && sizeIssue.buttons.includes('Open List'))), JSON.stringify(rp.issues));
  } else check('at 0 the panel says nothing is hard to read, and what was checked', /Nothing is hard to read/.test(rp.head));
  await b.shot(join(outDir, '03-readability-open.png'));
  await b.key('Escape');
  await settle(200);
  check('Escape closes the readability panel and focus returns to the mark', await page(`return $('.flyout').hidden && document.activeElement === $('.read-mark');`));

  // A selected object puts the graph's operations in use; Focus path toggles.
  const work = await page(`const n = cyOf().nodes().filter((x) => x.data('category') === 'Work item')[0]; app.select({ kind: 'node', id: n.id(), label: n.data('rawLabel'), category: 'Work item' }, { popover: false }); return n.id();`);
  await settle(500);
  const inUse = await floatMeasure();
  check('with an object selected, Focus path and the two Expand buttons are in use', inUse.buttons.filter((x) => ['Focus path', 'Expand upstream', 'Expand downstream'].includes(x.text)).every((x) => !x.disabled), work);
  await page(`button($('.graph-float'), 'Focus path').click(); return true;`);
  await settle(900);
  const focused = await page(`return { scale: $('.graph-tools .segmented button.active').textContent, button: $$('.graph-float button').map((x) => x.textContent).find((t) => /focus/i.test(t)), faded: cyOf().nodes('.faded').length };`);
  check('Focus path, from the corner of the graph: the Work scale, the rest faded, and the button now clears the focus', focused.scale === 'Work' && focused.button === 'Clear focus' && focused.faded > 0, JSON.stringify(focused));
  await page(`button($('.graph-float'), 'Clear focus').click(); return true;`);
  await settle(700);
  await page(`button($('.graph-float'), 'All links').click(); return true;`);
  await settle(700);
  const allLinks = await page(`return { links: app.state.graphLinks, drawn: cyOf().edges('.all-links').length };`);
  check('the links switch on the corner draws every link', allLinks.links === 'lines' && allLinks.drawn > 0, JSON.stringify(allLinks));
  await page(`button($('.graph-float'), '↗ Link counts').click(); app.select(null); return true;`);
  await settle(500);

  // ── 2 · The same with the Keeper docked: the main view is about 630px wide ─────────────────────────────────
  await openGraph();
  await dock(true);
  await controlRowChecks('Keeper docked');
  await b.shot(join(outDir, '07-keeper-docked.png'));
  await b.key('Escape');
  await settle(200);
  await b.clickOn('.read-mark');
  await settle(400);
  const rpDocked = await page(`return { rect: rectOf($('.flyout')), area: ${AREA}, keeper: rectOf($('#keeper')) };`);
  check('Keeper docked: the readability panel is wholly inside what is left of the main view', inside(rpDocked.rect, rpDocked.area) && !hit(rpDocked.rect, rpDocked.keeper), JSON.stringify(round(rpDocked.rect)));
  await b.key('Escape');
  await dock(false);

  // ── 3 · List: the same row in the same place; no graph, so no mark and no floating buttons ─────────────────
  const graphRow = await rowMeasure();
  await page(`button($('.graph-tools'), 'List').click(); return true;`);
  await b.waitFor("document.querySelector('.list-wrap table')", { label: 'List' });
  await settle(500);
  const listRow = await page(`const row = $('.graph-tools'); return { row: rectOf(row), kids: [...row.children].map((e) => ({ text: e.textContent.trim().slice(0, 40), rect: rectOf(e) })), mark: Boolean($('.read-mark')), float: Boolean($('.graph-float')), scalesOff: $$('.graph-tools .segmented')[0].querySelectorAll('button:disabled').length, listTop: rectOf($('.list-wrap')).top, inWrap: Boolean($('.list-wrap .graph-tools')), inTop: Boolean(row.closest('.topbar')) };`);
  check('List: the scale, Graph / List and Filter keep their top-bar positions without a second control row', listRow.inTop && !listRow.inWrap && Math.abs(listRow.row.top - graphRow.row.top) < 1 && [0, 1, 2].every((i) => same(listRow.kids[i].rect, graphRow.kids[i].rect)) && listRow.listTop >= listRow.row.bottom - 1, `row ${JSON.stringify(round(listRow.row))}`);
  check('List: there is no picture to check or to operate on, so no readability mark and no floating buttons; the scales are out of use', !listRow.mark && !listRow.float && listRow.scalesOff === 3);
  await b.clickOn('.filter-btn');
  await settle(350);
  const listPanel = await page(`const p = $('.flyout'); return { rect: rectOf(p), area: ${AREA}, selects: $$('select', p).length, ticks: $$('label.chk', p).map((e) => e.textContent.trim()), period: $$('.segmented button', p).map((e) => e.textContent), table: $('.list-wrap table') };`);
  check('List: the Filter panel holds what acts on the List — Show replaced & deferred and the period of the stars', inside(listPanel.rect, listPanel.area) && listPanel.selects === 0 && listPanel.ticks.length === 1 && /^Show replaced & deferred/.test(listPanel.ticks[0]) && listPanel.period.length === 2, JSON.stringify({ ticks: listPanel.ticks, period: listPanel.period }));
  const rowsBefore = await page(`return $$('.list-wrap s').length;`);
  await page(`$('.flyout label.chk input').click(); return true;`);
  await settle(800);
  const listAfter = await page(`return { open: !$('.flyout').hidden, struck: $$('.list-wrap s').length, row: Boolean($('.graph-tools .filter-btn')) };`);
  check('List: Show replaced & deferred redraws the table and the panel stays open over it', listAfter.open && listAfter.row && listAfter.struck > rowsBefore, `${rowsBefore} → ${listAfter.struck} struck-through names`);
  await b.shot(join(outDir, '08-list.png'));
  await page(`$('.flyout label.chk input').click(); return true;`);
  await b.key('Escape');
  await page(`button($('.graph-tools'), 'Graph').click(); return true;`);
  await settle(600);

  // ── 4 · The bottom strip: one line per item, the tags are leading marks, the header says why (AC-38, AC-1) ──
  await openGraph();
  const ov = await (await fetch(`${base}/api/projects/${PID}/overview?since=&selection=`)).json();
  const stripMeasure = () => page(`
    const strip = $('.strip'); const sr = rectOf(strip);
    return { strip: sr, main: rectOf($('#main')), cy: $('#cy') ? rectOf($('#cy')) : null, stored: localStorage.getItem('pk.strip.height'), columns: $$(':scope > section', strip).map((s) => {
      const list = s.querySelector('.items'); const lr = rectOf(list); const lines = $$('.item', list);
      return { col: s.dataset.col, rect: rectOf(s), header: rectOf(s.querySelector('header')), headerText: s.querySelector('header').innerText.replace(/\\s+/g, ' ').trim(), list: lr, rows: lines.length,
        whole: lines.filter((e) => { const r = rectOf(e); return r.top >= lr.top - 0.5 && r.bottom <= lr.bottom + 0.5; }).length,
        heights: [...new Set(lines.map((e) => Math.round(rectOf(e).height)))],
        oneLine: lines.every((e) => { const kids = [...e.children].map(rectOf); const mid = kids.map((k) => k.top + k.height / 2); return Math.max(...mid) - Math.min(...mid) <= 3 && kids.every((k) => k.left >= rectOf(e).left - 0.5 && k.right <= rectOf(e).right + 0.5); }),
        slots: lines.slice(0, 40).map((e) => ({ marks: $$('.mk', e).map((m) => ({ glyph: m.textContent, title: m.title, tone: m.className })), text: e.querySelector('.row-text')?.textContent ?? '', cut: (() => { const t = e.querySelector('.row-text'); return t.scrollWidth > t.clientWidth; })(), object: e.querySelector('.row-object')?.textContent ?? '', time: e.querySelector('.row-time')?.textContent ?? '' })) };
    }) };`);
  const s0 = await stripMeasure();
  const col = (m, name) => m.columns.find((c) => c.col === name);
  numbers.strip = { height: Math.round(s0.strip.height), graph: Math.round(s0.cy.height), columns: s0.columns.map((c) => ({ col: c.col, width: Math.round(c.rect.width), header: Math.round(c.header.height), list: Math.round(c.list.height), rows: c.rows, whollyVisible: c.whole, rowHeights: c.heights })) };
  check('every row of the strip is one line: mark · one sentence · object · time, side by side', s0.columns.every((c) => c.oneLine && c.heights.every((x) => x <= 30)), JSON.stringify(numbers.strip.columns.map((c) => `${c.col}: ${c.rows} rows of ${c.rowHeights.join('/')}px`)));
  const att = col(s0, 'attention'), chg = col(s0, 'changes');
  const wasInSight = { attention: 2, changes: 3, since: 4 };   // measured on 8d15264, 1280×800, the same fixture (shots/S3/before)
  check('at the default height about twice as many rows are in sight as before (2 notes, 3 changes, 4 since the last visit), in a lower strip', s0.strip.height < 288 && att.whole >= 2 * wasInSight.attention && chg.whole >= 2 * wasInSight.changes && (!col(s0, 'since') || col(s0, 'since').whole >= 1.5 * wasInSight.since), `strip ${Math.round(s0.strip.height)}px (was 288) · ${s0.columns.map((c) => `${c.col} ${c.whole}`).join(' · ')} · graph ${Math.round(s0.cy.height)}px high (was 271)`);
  // The marks stand for the words the tags had, and say them on hover.
  const firstNote = ov.needsYou.find((x) => x.kind === 'note' && x.cameFrom?.kind);
  const noteSlots = att.slots[ov.needsYou.indexOf(firstNote)];
  check('a note’s tags are its leading marks, and the hover says the words: what it asks, and how it came about', noteSlots.marks.length === 2 && noteSlots.marks[0].title === firstNote.ask && noteSlots.marks[1].title.startsWith(`Came from: ${firstNote.cameFrom.kind}`) && noteSlots.text === firstNote.label && noteSlots.object.length > 0 && / ago|just now/.test(noteSlots.time), JSON.stringify(noteSlots));
  const tones = await page(`const css = (sel) => { const e = $(sel); return e ? { bg: getComputedStyle(e).backgroundColor, color: getComputedStyle(e).color } : null; }; return { decide: css('.strip .mk-decide'), discuss: css('.strip .mk-discuss'), origin: css('.strip .mk-origin'), amber: getComputedStyle(document.documentElement).getPropertyValue('--amber').trim() };`);
  const kindsOfMark = new Map(att.slots.map((x, i) => [ov.needsYou[i].kind + (ov.needsYou[i].kind === 'note' ? `/${ov.needsYou[i].ask}` : ''), x.marks[0].glyph]));
  numbers.marks = { attention: Object.fromEntries(kindsOfMark), tones };
  check('the marks tell the kinds apart — a decision, a discussion, a scope question, a finished request, a Follow up result — and the one that waits for a decision is the only filled one', new Set(kindsOfMark.values()).size === kindsOfMark.size && tones.decide && tones.decide.bg !== 'rgba(0, 0, 0, 0)' && (!tones.discuss || tones.discuss.bg === 'rgba(0, 0, 0, 0)'), JSON.stringify(Object.fromEntries(kindsOfMark)));
  const workChange = ov.recentChanges.find((c) => c.work), oldChange = ov.recentChanges.find((c) => !c.work), removedChange = ov.recentChanges.find((c) => c.removed?.length);
  const chgSlot = (c) => chg.slots[ov.recentChanges.indexOf(c)];
  check('Recent changes: the kind of work is the mark, then the work and how many changes, and the time; an older record by its effect and title; the newest at the bottom', (!workChange || (chgSlot(workChange).marks[0].title === workChange.work.kind && chgSlot(workChange).text === workChange.work.label && /^\d+ changes?$/.test(chgSlot(workChange).object))) && (!oldChange || (chgSlot(oldChange).marks[0].title === oldChange.effect && chgSlot(oldChange).text === oldChange.title)) && ov.recentChanges.every((c, i, all) => i === 0 || all[i - 1].at <= c.at), JSON.stringify({ work: workChange && chgSlot(workChange), old: oldChange && chgSlot(oldChange) }));
  if (removedChange) check('a change that removed objects carries a mark whose hover names them', chgSlot(removedChange).marks.some((m) => m.title === `Removed: ${removedChange.removed.map((x) => x.label).join(', ')}`), JSON.stringify(chgSlot(removedChange).marks));
  // The header of Notes (attention) is one line, as tall as its neighbours'; why it holds fewer notes than exist (D50)
  // opens in a card on hover or focus of the header (owner 2026-09-22), the full sentences under the two lines.
  const nc = ov.noteCounts, waiting = ov.needsYou.filter((x) => x.kind === 'note').length;
  const headSeen = await page(`const hd = $('.strip section[data-col="attention"] header'); const hr = rectOf(hd); const why = $('.strip-why', hd); const closed = getComputedStyle(why).display; hd.focus(); const open = getComputedStyle(why).display; const inMain = inside(rectOf(why), rectOf($('.shell'))); hd.blur(); return { text: hd.innerText.replace(/\\s+/g, ' ').trim(), why: why.textContent.replace(/\\s+/g, ' ').trim(), closed, open, inMain, sameHeight: Math.abs(hr.height - rectOf($('.strip section[data-col="changes"] header')).height) < 1, inSight: textBoxes(hd).every((t) => inside(t, hr)) && textBoxes(hd).length > 0, clipped: $$('*', hd).filter((e) => e.scrollWidth > e.clientWidth + 1 && !e.closest('.strip-why')).map((e) => e.className) };`);
  numbers.attentionHeader = headSeen;
  check('the header of Notes (attention) is one line, as tall as the next column\'s, with the count in sight', headSeen.text.includes(`${waiting} of ${nc.current} notes`) && headSeen.sameHeight && headSeen.inSight && headSeen.clipped.length === 0, JSON.stringify({ text: headSeen.text, sameHeight: headSeen.sameHeight }));
  check('its hover card (closed until hovered or focused) says why it holds fewer notes than exist, counts what is not a note apart, and has the sentences in full', headSeen.closed === 'none' && headSeen.open !== 'none' && headSeen.inMain && (nc.information === 0 || headSeen.why.includes(`${nc.information} for information`)) && (nc.answered === 0 || headSeen.why.includes(`${nc.answered} answered`)) && /Also here: .*scope question/.test(headSeen.why) && /request/.test(headSeen.why) && /Follow up result/.test(headSeen.why) && /Notes log has all of them/.test(headSeen.why), headSeen.why.slice(0, 160));
  // The default view on a later open: `Since last visit` is spent, two columns. (01-default.png is the first open.)
  await b.shot(join(outDir, '01b-default-later-open.png'));

  // ── 5 · A note opens the full-width sheet, with all its content and its objects found on the graph ────────
  const walkNote = ov.needsYou.find((x) => x.kind === 'note' && x.cameFrom?.kind === 'Change follow-up' && x.cameFrom.changes?.length) ?? firstNote;
  // The same note can have a row in two columns (Notes (attention) and Since last visit): a row is named with its column.
  const rowSel = (key) => `.strip section[data-col="${key.startsWith('change:') ? 'changes' : 'attention'}"] [data-row="${key}"]`;
  const closeSheet = async () => {
    if (await page(`return Boolean($('.strip-sheet'));`)) {
      await b.clickOn('.strip-sheet-close');
      await b.waitFor("!document.querySelector('.strip-sheet')");
      await settle(200);
    }
  };
  const otherCols = () => page(`return $$('.strip > section').map((s) => rectOf(s));`);
  const colsBefore = await otherCols();
  await page(`$(${JSON.stringify(rowSel(`note:${walkNote.id}`))}).scrollIntoView({ block: 'nearest' }); return true;`);
  await b.clickOn(`${rowSel(`note:${walkNote.id}`)} > .item`);
  await b.waitFor("document.querySelector('.strip-sheet .more-actions')", { label: 'the note opened in the reading sheet' });
  await settle(500);
  const opened = await page(`
    const row = $(${JSON.stringify(rowSel(`note:${walkNote.id}`))}); const more = $('.strip-sheet-body'); const list = row.closest('.items');
    const on = more.querySelector('.on-line');
    return { popover: !$('#popover').hidden, dialog: $('#dialog').open, expanded: row.querySelector('.item').getAttribute('aria-expanded'), text: more.innerText, tags: $$('.tag', more).map((t) => t.textContent), buttons: $$('button', more).map((x) => x.textContent.trim()),
      names: on ? $$('.on-name', on).map((x) => x.textContent) : [], onButtons: on ? $$('button, a', on).map((x) => x.textContent.trim()) : [], inList: inside(rectOf(row.querySelector('.item')), rectOf(list)), selection: app.state.selection, crumb: $('#focus-crumb').textContent,
      marked: cyOf().nodes('.hit').map((n) => n.id()), sheet: rectOf($('.strip-sheet')), strip: rectOf($('.strip')), sheetCount: $$('.strip-sheet').length };`);
  numbers.noteOpened = { id: walkNote.id, tags: opened.tags, buttons: opened.buttons, names: opened.names, marked: opened.marked };
  check('a press on a note opens one sheet across all columns, without a popover or centered dialog', !opened.popover && !opened.dialog && opened.expanded === 'true' && opened.sheetCount === 1 && Math.abs(opened.sheet.width - opened.strip.width) < 2 && opened.sheet.height >= 260, JSON.stringify({ popover: opened.popover, expanded: opened.expanded, width: opened.sheet.width, height: opened.sheet.height }));
  const mustHold = [walkNote.label, walkNote.detail, walkNote.ask, walkNote.cameFrom.kind, ...(walkNote.cameFrom.changes ?? []).map((c) => c.title)];
  check('opened, nothing is missing that the two-line item showed: the whole title, the preview, what it asks, how it came about and the changes it is about', mustHold.every((t) => opened.text.includes(t)), mustHold.filter((t) => !opened.text.includes(t)).join(' | ') || `${mustHold.length} pieces found`);
  const hung = walkNote.object.objects.map((o) => o.label);
  check('and it holds what the popover behind the item held: the ways to answer, Show on graph on the On line, the walk through the change, Details, and the objects it hangs on as text', ['Discuss with Keeper', 'Confirm', 'No action needed', 'Show on graph', 'Details'].every((t) => opened.buttons.includes(t)) && !opened.buttons.includes('Investigate') && (walkNote.cameFrom.kind !== 'Change follow-up' || opened.buttons.includes('▶ Walk through the change')) && !opened.buttons.some((t) => /^Current view/.test(t)) && opened.names.length === hung.length && opened.names.every((t, i) => t === hung[i]) && opened.onButtons.length === 1 && opened.onButtons[0] === 'Show on graph', JSON.stringify({ buttons: opened.buttons, names: opened.names }));
  check('the note is what the owner is on, and the objects it hangs on are found on the graph', opened.selection?.kind === 'note' && opened.selection.id === walkNote.id && opened.crumb === walkNote.label && walkNote.object.objects.filter((o) => o.kind === 'node').every((o) => opened.marked.includes(o.id)), `marked on the graph: ${opened.marked.join(', ')}`);
  await b.shot(join(outDir, '04-note-open.png'));
  // The names on the On line are not links. Details opens the whole note.
  const onLineQuiet = await page(`const on = $('.strip-sheet .on-line'); return { controls: $$('button, a, [role="button"]', on).map((x) => x.textContent.trim()), names: $$('.on-name', on).every((x) => x.tagName === 'SPAN') };`);
  check('the On line names what the note hangs on as text; the only control there is Show on graph', onLineQuiet.names && onLineQuiet.controls.length === 1 && onLineQuiet.controls[0] === 'Show on graph', JSON.stringify(onLineQuiet));
  await b.clickOn('.strip-sheet .more-foot > .btn');
  await b.waitFor("document.querySelector('#dialog').open && document.querySelector('#dialog .full-details')", { label: 'the whole note' });
  check('Details opens the whole note in the full details', await page(`return $('#dialog h2').textContent === ${JSON.stringify(walkNote.label)} && $$('#dialog [data-section]').length >= 3 && $$('#dialog .popover-index, #dialog .index-item').length === 0;`));
  await page(`$('#dialog').close(); return true;`);
  await settle(250);
  // Close the sheet to reach the index, then another note takes the one reading surface.
  await closeSheet();
  const secondNote = ov.needsYou.find((x) => x.kind === 'note' && x.id !== walkNote.id);
  await page(`$(${JSON.stringify(rowSel(`note:${secondNote.id}`))}).scrollIntoView({ block: 'nearest' }); return true;`);
  await b.clickOn(`${rowSel(`note:${secondNote.id}`)} > .item`);
  await settle(900);
  const two = await page(`return { open: $$('.strip section[data-col="attention"] .strip-row.open').map((r) => r.dataset.row), marked: cyOf().nodes('.hit').map((n) => n.id()) };`);
  check('only the new note is open and the marks follow it', two.open.length === 1 && two.open[0] === `note:${secondNote.id}`, JSON.stringify(two));
  await closeSheet();
  await settle(500);
  check('Close returns to the index and clears the graph marks', await page(`return !$('.strip-sheet') && $$('.strip .strip-row.open').length === 0 && cyOf().nodes('.hit').length === 0;`));
  // What is not a note: the second line it had, and the way on.
  // A Follow up result with news opens as its news by kind, each entry with its jump (ui-s6-check.mjs holds it to that);
  // the one this row contract is about is a result from before rounds counted their news, which keeps this display.
  for (const [kind, action] of [['scope-question', 'Answer in Project scope'], ['job', 'Open Keeper activity'], ['round', 'Open the result']]) {
    const x = ov.needsYou.find((i) => i.kind === kind && !i.news);
    if (!x) continue;
    await closeSheet();
    await page(`$(${JSON.stringify(rowSel(`${kind}:${x.id}`))}).scrollIntoView({ block: 'nearest' }); return true;`);
    await b.clickOn(`${rowSel(`${kind}:${x.id}`)} > .item`);
    await settle(400);
    const got = await page(`const m = $('.strip-sheet-body'); return { text: m?.innerText ?? '', buttons: $$('button', m ?? document.createElement('i')).map((e) => e.textContent) };`);
    check(`a ${kind} row opens in the sheet with its full content and the way on (${action})`, got.text.includes(x.label) && (!x.detail || got.text.includes(x.detail.slice(0, 60))) && got.buttons.includes(action), got.buttons.join(' | '));
  }
  await closeSheet();
  await settle(300);

  // ── 6 · A change opens in place ─────────────────────────────────────────────────────────────────────────────
  const target = removedChange ?? workChange ?? ov.recentChanges[0];
  await page(`$(${JSON.stringify(rowSel(`change:${target.id}`))}).scrollIntoView({ block: 'nearest' }); return true;`);
  await b.clickOn(`${rowSel(`change:${target.id}`)} > .item`);
  await settle(700);
  const chOpen = await page(`const more = $('.strip-sheet-body'); return { popover: !$('#popover').hidden, text: more.innerText, struck: $$('s', more).map((x) => x.textContent), buttons: $$('button', more).map((x) => x.textContent.trim()), marked: cyOf().nodes('.hit').map((n) => n.id()) };`);
  numbers.changeOpened = { id: target.id, struck: chOpen.struck, buttons: chOpen.buttons, marked: chOpen.marked };
  const propagation = Object.entries(target.propagationSummary).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ') || 'no downstream entries';
  check('a press on a change opens it in place with each of its changes by title, what it removed struck through, how far it was followed, Show affected and the way to the Change log', !chOpen.popover && (target.items ?? []).every((i) => chOpen.text.includes(i.title)) && (target.removed ?? []).every((x) => chOpen.struck.includes(x.label)) && chOpen.text.includes(propagation) && chOpen.text.includes(target.work ? target.work.label : target.title) && chOpen.text.includes(target.work ? target.work.kind : target.effect) && chOpen.buttons.includes('Show affected') && chOpen.buttons.includes('Open in Change log'), JSON.stringify({ struck: chOpen.struck, buttons: chOpen.buttons }));
  await b.shot(join(outDir, '05-change-open.png'));
  await b.clickOn('.strip-sheet .more-actions > button:first-child');
  await settle(700);
  const drawnAffected = target.affectsLabels.filter((a) => !a.removed).map((a) => a.id);
  const affected = await page(`return { marked: cyOf().nodes('.hit').map((n) => n.id()), toast: $('#toast').textContent };`);
  check('Show affected marks what the change reached on the graph, as the press on the item did before', drawnAffected.length === 0 ? /not on the graph|None/.test(affected.toast) : drawnAffected.some((id) => affected.marked.includes(id)), `${affected.toast} · ${affected.marked.join(', ')}`);
  await closeSheet();
  await b.clickOn(`${rowSel(`change:${target.id}`)} > .item`, { scroll: true });
  await b.waitFor("document.querySelector('.strip-sheet-body')");

  // ── 7 · Assets change: what is open stays open, what is scrolled stays scrolled, what did not change is not redrawn ──
  const scrolledTo = await page(`const l = $('.strip section[data-col="attention"] .items'); l.scrollTop = 40; window.__cols = $$('.strip > section'); window.__open = $('.strip .strip-row.open'); return l.scrollTop;`);
  await page(`await views.graph.onAssets(); await new Promise((r) => setTimeout(r, 700)); return true;`);
  const kept = await page(`return { sameColumns: $$('.strip > section').every((s, i) => s === window.__cols[i]), sameOpenRow: $('.strip .strip-row.open') === window.__open, scrollTop: $('.strip section[data-col="attention"] .items').scrollTop };`);
  check('an asset event that changes nothing redraws nothing: the same columns, the same open row, scrolled where it was', kept.sameColumns && kept.sameOpenRow && kept.scrollTop === scrolledTo && scrolledTo > 0, JSON.stringify({ ...kept, scrolledTo }));
  const discussed = ov.needsYou.find((x) => x.kind === 'note' && x.ask === 'Worth discussing');
  if (discussed) {
    await fetch(`${base}/api/projects/${PID}/notes/${encodeURIComponent(discussed.id)}/response`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ response: 'Discussed' }) });
    await b.waitFor(`!document.querySelector(${JSON.stringify(rowSel(`note:${discussed.id}`))})`, { label: 'the answered note leaving Notes (attention)', timeout: 8000 });
    await settle(500);
    const after = await page(`return { changesSame: $('.strip section[data-col="changes"]') === window.__cols[1], openRow: $('.strip section[data-col="changes"] .strip-row.open')?.dataset.row ?? null, head: $('.strip section[data-col="attention"] header').textContent.replace(/\\s+/g, ' '), scrollTop: $('.strip section[data-col="attention"] .items').scrollTop };`);
    check('a note that is answered leaves the list and the header counts it as answered; the column that did not change is not touched, and the open change stays open', after.changesSame && after.openRow === `change:${target.id}` && after.head.includes(`${waiting - 1} of ${nc.current} notes`) && after.head.includes(`${nc.answered + 1} answered`), after.head);
    // No route clears an answer, so the note stays answered on this home; every number above is read again on each run.
  }

  // ── 8 · The strip's height: lower by default, dragged by its top edge, remembered here, the graph follows ────
  await openGraph();
  const h0 = await stripMeasure();
  const edge = { x: (h0.strip.left + h0.strip.right) / 2, y: h0.strip.top };
  await b.drag(edge.x, edge.y, edge.x, edge.y - 130);
  await settle(700);
  const h1 = await stripMeasure();
  numbers.stripDragged = { from: Math.round(h0.strip.height), to: Math.round(h1.strip.height), stored: h1.stored, graphFrom: Math.round(h0.cy.height), graphTo: Math.round(h1.cy.height), rows: h1.columns.map((c) => `${c.col} ${c.whole}`) };
  check('dragging the strip’s top edge makes it taller, the graph gives the height, and more rows are in sight', Math.abs(h1.strip.height - (h0.strip.height + 130)) <= 2 && Math.abs((h0.cy.height - h1.cy.height) - 130) <= 2 && col(h1, 'changes').whole > col(h0, 'changes').whole && Number(h1.stored) === Math.round(h1.strip.height), JSON.stringify(numbers.stripDragged));
  await b.shot(join(outDir, '06-strip-dragged.png'));
  const canvasFollows = await page(`const c = $('#cy'); return { container: c.clientHeight, cy: cyOf().height() };`);
  check('the graph’s canvas followed its container', Math.abs(canvasFollows.container - canvasFollows.cy) < 1, JSON.stringify(canvasFollows));
  await b.send('Page.reload');
  await b.waitFor("document.querySelector('#cy canvas') && document.querySelector('.strip')", { label: 'the page loaded again' });
  await settle(1200);
  const h2 = await stripMeasure();
  check('the height is remembered in this browser: the page opens with it', Math.abs(h2.strip.height - h1.strip.height) <= 1, `${Math.round(h2.strip.height)}px`);
  await page(`$('.strip-resizer').focus(); return true;`);
  await b.key('ArrowDown');
  await settle(300);
  const h3 = await stripMeasure();
  check('with focus on the edge the arrow keys move it, a row at a time', Math.abs((h2.strip.height - h3.strip.height) - 27) <= 1 && Number(h3.stored) === Math.round(h3.strip.height), `${Math.round(h2.strip.height)} → ${Math.round(h3.strip.height)}`);
  await b.drag(edge.x, h3.strip.top, edge.x, 60);
  await settle(500);
  const hMax = await stripMeasure();
  await b.drag(edge.x, hMax.strip.top, edge.x, 790);
  await settle(500);
  const hMin = await stripMeasure();
  numbers.stripLimits = { max: Math.round(hMax.strip.height), min: Math.round(hMin.strip.height), mainHeight: Math.round(hMax.main.height), graphAtMax: Math.round(hMax.cy.height) };
  check('it stops at its limits: tall, the view above keeps 240px; low, 120px of the strip stay', Math.abs(hMax.strip.height - (hMax.main.height - 240)) <= 1 && hMax.cy.height >= 120 && Math.abs(hMin.strip.height - 120) <= 1, JSON.stringify(numbers.stripLimits));
  await page(`const e = $('.strip-resizer'); e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true;`);
  await settle(400);
  check('a double-click on the edge brings the default height back', Math.abs((await stripMeasure()).strip.height - 260) <= 1);

  // The List has the same strip under it.
  await page(`button($('.graph-tools'), 'List').click(); return true;`);
  await b.waitFor("document.querySelector('.list-wrap table')", { label: 'List' });
  await settle(500);
  const listStrip = await stripMeasure();
  check('under the List the strip is the same: one line per item, the same height, its edge dragged the same way', listStrip.columns.every((c) => c.oneLine) && Math.abs(listStrip.strip.height - 260) <= 1 && (await page(`return Boolean($('#main > .strip-resizer'));`)));
  await page(`button($('.graph-tools'), 'Graph').click(); return true;`);
  await settle(500);

  // ── 9 · The pill: no column kept empty for it, and still on no text wherever the strip is scrolled (AC-1) ────
  const dockMeasure = () => page(`
    const strip = $('.strip'); const pill = rectOf($('#keeper-dock .dock-pill')); const cols = $$(':scope > section', strip);
    return { strip: rectOf(strip), area: ${AREA}, pill, padRight: getComputedStyle(strip).paddingRight, columns: cols.map((s) => ({ col: s.dataset.col, rect: rectOf(s), overDock: s.classList.contains('over-dock'), list: rectOf(s.querySelector('.items')), header: rectOf(s.querySelector('header')), underPill: rectOf(s).left < pill.right && pill.left < rectOf(s).right })) };`);
  /** Every piece of text of the strip against the pill, with each column scrolled to its top, its middle and its end. */
  const pillOnText = () => page(`
    const pill = rectOf($('#keeper-dock .dock-pill')); const lists = $$('.strip .items'); const found = []; let boxes = 0;
    for (const at of [0, 0.25, 0.5, 0.75, 1]) {
      for (const l of lists) l.scrollTop = Math.round((l.scrollHeight - l.clientHeight) * at);
      await new Promise((r) => requestAnimationFrame(() => r()));
      const all = textBoxes($('.strip')); boxes += all.length;
      for (const t of all) if (hit(t, pill)) found.push(at + ': ' + t.text);
    }
    for (const l of lists) l.scrollTop = 0;
    return { under: found, boxes };`);
  const dockChecks = async (where) => {
    const d = await dockMeasure();
    const last = d.columns[d.columns.length - 1];
    numbers[`pill ${where}`] = { strip: round(d.strip), pill: round(d.pill), columns: d.columns.map((c) => ({ col: c.col, left: Math.round(c.rect.left), right: Math.round(c.rect.right), overDock: c.overDock, listEnds: Math.round(c.list.bottom) })) };
    check(`${where}: the strip takes the whole width of the main view — no column is kept empty for the pill`, d.padRight === '0px' && Math.abs(last.rect.right - d.area.right) < 1 && Math.abs(d.columns[0].rect.left - d.area.left) < 1 && d.columns.every((c, i) => i === 0 || Math.abs(c.rect.left - d.columns[i - 1].rect.right) < 1), `columns ${d.columns.map((c) => `${Math.round(c.rect.left)}…${Math.round(c.rect.right)}`).join(' | ')} in ${Math.round(d.area.left)}…${Math.round(d.area.right)}`);
    check(`${where}: only a column the pill stands over ends its list above it; the others run to the strip's foot`, d.columns.every((c) => c.overDock === c.underPill && (c.overDock ? c.list.bottom <= d.pill.top - 4 : Math.abs(c.list.bottom - d.strip.bottom) < 1)), JSON.stringify(numbers[`pill ${where}`].columns));
    const t = await pillOnText();
    check(`${where}: the pill lies on no text of the strip, wherever its columns are scrolled`, t.under.length === 0, t.under.length ? t.under.slice(0, 4).join(' | ') : `${t.boxes} text boxes checked at five scroll positions`);
  };
  // `Since last visit` is there only the first time a freshly seeded home is opened. The check's own move, to measure
  // the strip with three columns on any home: the page is told the last visit was three days ago, and reads again.
  const threeColumns = async () => { await page(`app.state.lastVisit = new Date(Date.now() - 3 * 86400000).toISOString(); await views.graph.onAssets(); return true;`); await b.waitFor("document.querySelector('.strip.three')", { label: 'Since last visit' }); await settle(400); };
  await openGraph();
  await dockChecks(`1280 wide, ${(await dockMeasure()).columns.length} columns`);
  await threeColumns();
  await dockChecks('1280 wide, 3 columns');
  await b.shot(join(outDir, '10-three-columns.png'));
  // With a row open at the end of the column under the pill, and the strip at its lowest.
  await page(`const l = $$('.strip > section.over-dock .items')[0]; const rows = $$('.item', l); rows[rows.length - 1].scrollIntoView({ block: 'nearest' }); rows[rows.length - 1].click(); return true;`);
  await settle(900);
  const openUnderPill = await pillOnText();
  check('with a row open at the end of the column under the pill, the pill still lies on no text', openUnderPill.under.length === 0, openUnderPill.under.slice(0, 4).join(' | ') || `${openUnderPill.boxes} text boxes checked`);
  await closeSheet();
  await page(`$('.strip-resizer').focus(); return true;`);
  await b.key('End');
  await settle(500);
  const lowest = await pillOnText();
  const lowestStrip = await dockMeasure();
  check('with the strip at its lowest the pill still lies on no text, and the column under it keeps a row in sight', lowest.under.length === 0 && lowestStrip.columns.filter((c) => c.overDock).every((c) => c.list.height >= 26), `${Math.round(lowestStrip.strip.height)}px · ${lowest.boxes} text boxes checked`);
  await closeSheet();
  await page(`const e = $('.strip-resizer'); e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true;`);
  await settle(400);
  await dock(true);
  await dockChecks('Keeper docked, 3 columns');
  const dockedRows = await page(`return $$('.strip > section').map((s) => { const e = s.querySelector('.item'); return { col: s.dataset.col, width: Math.round(rectOf(s).width), text: Math.round(rectOf(e.querySelector('.row-text')).width), object: Boolean(e.querySelector('.row-object')?.getClientRects().length), time: Boolean(e.querySelector('.row-time')?.getClientRects().length) }; });`);
  numbers.dockedRows = dockedRows;
  check('Keeper docked, three columns of about 210px: a row is still one line and the sentence keeps the room — the object and the time give way to it, and stay in the hover', dockedRows.every((r) => r.text >= 120 && !r.object && !r.time) && (await page(`return $$('.strip .item .row-text').every((t) => t.title.length >= t.textContent.length);`)), JSON.stringify(dockedRows));
  await b.shot(join(outDir, '11-three-columns-docked.png'));
  await dock(false);
  await page(`button($('.graph-tools'), 'List').click(); return true;`);
  await b.waitFor("document.querySelector('.list-wrap table')", { label: 'List' });
  await settle(500);
  await dockChecks('List');
  await page(`button($('.graph-tools'), 'Graph').click(); return true;`);
  await settle(700);

  // ── 10 · The popover keeps off the pill (what S1 left: an object low on the page) ──────────────────────────
  const lowNode = await page(`const n = cyOf().nodes().filter((x) => x.data('category') === 'Work item')[0]; return { id: n.id(), label: n.data('rawLabel') };`);
  await page(`
    const cy = cyOf(); const el = cy.getElementById(${JSON.stringify(lowNode.id)}); const p = el.renderedPosition();
    cy.panBy({ x: 560 - p.x, y: cy.height() - 14 - p.y }); return true;`);   // the check's own move: low, with room for the popover on its right. 14, not 34: Details no longer carries the section index, so the popover is shorter and has to sit lower before it would lie on the pill.
  await settle(300);
  const lowRect = await page(`return views.graph.anchorRect({ kind: 'node', id: ${JSON.stringify(lowNode.id)} });`);
  await b.click((lowRect.left + lowRect.right) / 2, (lowRect.top + lowRect.bottom) / 2);
  await b.waitFor("!document.querySelector('#popover').hidden", { label: 'the popover of an object low on the page' });
  await settle(500);
  const low = await page(`
    const pop = rectOf($('#popover')); const pill = rectOf($('#keeper-dock .dock-pill')); const placed = await import('/popover-place.js');
    const plain = placed.placePopover({ anchor: ${JSON.stringify(lowRect)}, size: { width: pop.width, height: pop.height }, bounds: ${AREA} });
    return { popover: pop, pill, area: ${AREA}, side: $('#popover').dataset.side, wouldHaveHit: hit({ left: plain.left, top: plain.top, right: plain.left + plain.width, bottom: plain.top + plain.height }, pill) };`);
  numbers.popoverAndPill = { node: round(lowRect), popover: round(low.popover), pill: round(low.pill), side: low.side, wouldHaveLainOnThePill: low.wouldHaveHit };
  check('an object low on the page: its popover keeps off the pill, beside the object and wholly inside the main view', !hit(low.popover, low.pill) && inside(low.popover, low.area) && !hit(low.popover, lowRect) && low.wouldHaveHit, JSON.stringify(numbers.popoverAndPill));
  await b.shot(join(outDir, '09-popover-off-the-pill.png'));
  await b.key('Escape');
  await settle(200);

  // ── 11 · The outline shows names in full: a second line when one is not enough, the whole name on hover (AC-41) ──
  const graphNodes = (await (await fetch(`${base}/api/projects/${PID}/graph`)).json()).nodes;
  const outline = await page(`
    return $$('#outline [data-node]').map((row) => { const name = row.querySelector('span'); const cs = getComputedStyle(name); const lh = parseFloat(cs.lineHeight);
      return { id: row.dataset.node, area: row.classList.contains('ol-area'), text: name.textContent, title: row.title, lines: Math.round(name.getBoundingClientRect().height / lh), cut: name.scrollHeight > name.clientHeight + 1, nowrap: cs.whiteSpace === 'nowrap', inRail: rectOf(row).right <= rectOf($('.rail')).right + 0.5, count: row.querySelector('small')?.textContent ?? null }; });`);
  const twoLines = outline.filter((r) => r.lines === 2);
  numbers.outline = { entries: outline.length, onTwoLines: twoLines.length, stillCut: outline.filter((r) => r.cut).map((r) => r.text), example: twoLines[0] ?? null };
  check('an outline entry whose name does not fit one line takes a second one; none is cut off on a single line any more', outline.length > 0 && outline.every((r) => !r.nowrap && r.lines <= 2 && r.inRail) && twoLines.length > 0, `${outline.length} entries · ${twoLines.length} on two lines · ${numbers.outline.stillCut.length} still longer than two lines`);
  check('the hover gives every entry’s whole name; an area’s says its name and, under it, how much of its work is open', outline.every((r) => { const n = graphNodes.find((x) => x.id === r.id); return n && r.text === n.label && (r.area ? r.title.split('\n')[0] === n.label && (r.count === '' || /work items are still open/.test(r.title)) : r.title === n.label); }), JSON.stringify(outline.find((r) => r.area)));
  const navBefore = await page(`return $$('nav.views .nav-item').map((x) => x.childNodes[0].textContent);`);
  check('the view navigation is as it was', navBefore.join('|') === 'Project graph|Notes log|Change log|Agent context|Project scope|Keeper', navBefore.join(' | '));

  // ── 12 · A narrow window: the controls wrap, the strip is one stacked list of one-line rows, nothing scrolls sideways ──
  await openGraph({ width: 390, height: 844, mobile: true });
  const narrow = await page(`
    const row = rectOf($('.graph-tools')); const strip = $('.strip'); const pill = rectOf($('#keeper-dock .dock-pill'));
    return { scrollW: document.documentElement.scrollWidth, innerW: innerWidth, rowInside: [...$('.graph-tools').children].every((e) => rectOf(e).right <= innerWidth + 0.5 && rectOf(e).left >= -0.5), rowHeight: Math.round(row.height),
      columnsStacked: $$(':scope > section', strip).every((s, i, all) => i === 0 || rectOf(s).top >= rectOf(all[i - 1]).bottom - 0.5), oneLine: $$('.strip .item').every((e) => rectOf(e).height <= 30), resizer: getComputedStyle($('.strip-resizer')).display,
      float: rectOf($('.graph-float')), stage: rectOf($('.graph-stage')), pillOverStrip: hit(pill, rectOf(strip)) };`);
  numbers.narrow = narrow;
  check('narrow: nothing scrolls sideways, the controls wrap inside the window, the floating buttons stay inside the graph', narrow.scrollW <= narrow.innerW && narrow.rowInside && inside(narrow.float, narrow.stage), JSON.stringify({ row: narrow.rowHeight, float: round(narrow.float) }));
  check('narrow: the strip is stacked into one list as before, every row still one line, no edge to drag, and the pill stands under it', narrow.columnsStacked && narrow.oneLine && narrow.resizer === 'none' && !narrow.pillOverStrip);
  await b.clickOn('.strip [data-col="attention"] .item');
  await settle(900);
  const narrowOpen = await page(`const m = $('.strip-sheet'); return { open: Boolean(m), inside: m ? rectOf(m).right <= innerWidth + 0.5 && rectOf(m).left >= -0.5 && rectOf(m).bottom <= innerHeight + 0.5 : false, scrollW: document.documentElement.scrollWidth, innerW: innerWidth };`);
  check('narrow: the reading sheet stays inside the window', narrowOpen.open && narrowOpen.inside && narrowOpen.scrollW <= narrowOpen.innerW, JSON.stringify(narrowOpen));
  await b.shot(join(outDir, '12-narrow.png'));
  await b.clickOn('.filter-btn');
  await settle(400);
  const narrowPanel = await page(`return { rect: rectOf($('.flyout')), innerW: innerWidth, innerH: innerHeight };`);
  check('narrow: the Filter panel lies inside the window', narrowPanel.rect.left >= 0 && narrowPanel.rect.right <= narrowPanel.innerW + 0.5 && narrowPanel.rect.bottom <= narrowPanel.innerH + 0.5, JSON.stringify(round(narrowPanel.rect)));
  await b.key('Escape');

  const errors = [...pageErrors, ...b.consoleLines].filter((l) => !/wheel sensitivity|font-family/.test(l));
  check('the page reported no error', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (e) {
  check('the check ran to the end', false, e.message);
  try { await b.shot(join(outDir, 'zz-where-it-stopped.png')); } catch { /* the page is gone */ }
} finally {
  await b.close();
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(outDir, 'measurements.json'), JSON.stringify({ at: new Date().toISOString(), base, project: projectId, viewport: '1280x800', checks: results, numbers }, null, 2));
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
