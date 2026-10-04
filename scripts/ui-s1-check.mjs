// Browser check for the UI line's batch S1 (D67): the details popover and `Details`, the Keeper conversation docked
// on the right with `Pop out` / `Dock`, Markdown in answers, the pill clear of text, and the narrow-window overlays.
// It drives headless Chrome with real mouse and key events against a workbench that is ALREADY RUNNING on a seeded
// fixture home (never a real project):
//
//   node scripts/seed-ui-fixture.ts <fixture home> --project-dir <fixture project dir>
//   node src/cli.ts serve --home <fixture home> --port 4921
//   node scripts/ui-s1-check.mjs http://127.0.0.1:4921 <dir for screenshots>
//
// Everything it asserts is measured on the page (rectangles, element identity, focus), not judged by eye. It prints one
// line per check with the numbers it measured, writes them to <dir>/measurements.json, and exits 1 if any check failed.
// It works on either fixture; the checks of particular rich objects (section 12) run when the fixture has them.
// Section 10 answers one note (`No action needed`) to see the popover update in place, then sets that answer to
// `Discussed`, so the check can be run again on the same home; seed the home again for a pristine fixture.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep, PAGE_HELPERS } from './ui-cdp.mjs';

const [base = 'http://127.0.0.1:4921', outDir = 'ui-s1-shots'] = process.argv.slice(2);
const results = [];
const numbers = {};
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const round = (r) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 10) / 10 : v])) : r);
const inside = (a, b2) => Boolean(a && b2) && a.left >= b2.left - 0.5 && a.top >= b2.top - 0.5 && a.right <= b2.right + 0.5 && a.bottom <= b2.bottom + 0.5;
const hit = (a, b2) => Boolean(a && b2) && a.left < b2.right - 0.5 && b2.left < a.right - 0.5 && a.top < b2.bottom - 0.5 && b2.top < a.bottom - 0.5;

const workspace = await (await fetch(`${base}/api/workspace`)).json();
const projectId = workspace.projects[0]?.id;
if (!projectId) throw new Error('the fixture home has no project');
const PID = encodeURIComponent(projectId);
const get = async (path) => (await fetch(`${base}/api/projects/${PID}${path}`)).json();
const graphData = await get('/graph');
const notesData = await get('/notes');
const has = (id) => graphData.nodes.some((n) => n.id === id);
const labelOf = (id) => graphData.nodes.find((n) => n.id === id)?.label;
const url = (view, rest = '') => `${base}/#/p/${PID}/${view}${rest ? `/${rest}` : ''}`;

let b = await launch({ width: 1280, height: 800 });
const pageErrors = [];
const page = (body) => b.evaluate(`(async () => { ${PAGE_HELPERS}\n const $ = (s) => document.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)]; const views = (await import('/views.js')).views; const app = await import('/app.js'); const cyOf = () => $('#cy')._cyreg.cy; const button = (root, text) => $$('button', root).find((x) => x.textContent.trim() === text);\n ${body} })()`);
const settle = async (ms = 350) => { await sleep(ms); await b.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'); };
// A fresh browser each time a section wants a fresh page. Reloading in one browser leaves each earlier page's event
// stream open for a while, and at six of them (the per-host connection limit of HTTP/1.1) every further request of the
// page waits for ever — a limit of the check's own making, not something the owner meets with one window.
const openGraph = async ({ width = 1280, height = 800, mobile = false } = {}) => { pageErrors.push(...b.consoleLines); await b.close(); b = await launch({ width, height, mobile }); await b.navigate(url('graph')); await b.waitFor("document.querySelector('#cy canvas') && document.querySelector('.strip')"); await settle(900); };
const popoverOpen = async (label) => { try { await b.waitFor("!document.querySelector('#popover').hidden", { label }); } catch (e) { const seen = await page(`const p = $('#popover'); return JSON.stringify({ hidden: p.hidden, className: p.className, open: app.popover.isOpen(), key: app.popover.key(), selection: app.state.selection, view: app.state.view, dialog: $('#dialog').open, width: innerWidth });`); throw new Error(`${e.message} — ${seen}`); } };
const nodeRect = (id) => page(`return views.graph.anchorRect({ kind: 'node', id: ${JSON.stringify(id)} });`);
/** A test's own move, not the product's: put a node in the middle of the canvas so that a press can reach it. */
const bring = async (id) => { await page(`const cy = cyOf(); cy.center(cy.getElementById(${JSON.stringify(id)})); return true;`); await settle(200); };
const clickNode = async (id) => { const r = await nodeRect(id); if (!r) throw new Error(`node ${id} is not on the graph`); await b.click((r.left + r.right) / 2, (r.top + r.bottom) / 2); await popoverOpen(`popover for ${id}`); await settle(); return r; };
const pick = async (sel, opts = '{ trigger: null, reveal: true }') => { await page(`app.select(${JSON.stringify(sel)}, ${opts}); return true;`); await popoverOpen(`popover for ${sel.id}`); await settle(450); };
const layout = () => page(`
  const pop = $('#popover');
  return { main: rectOf($('#main')), body: rectOf($('#body')), area: (() => { const m = rectOf($('#main')); const k = $('#keeper'); if (k?.classList.contains('open') && k.classList.contains('docked')) m.right = Math.min(m.right, rectOf(k).left); return m; })(),
    popover: pop.hidden ? null : rectOf(pop), side: pop.dataset.side ?? null, keeper: $('#keeper')?.classList.contains('open') ? rectOf($('#keeper')) : null, pill: rectOf($('#keeper-dock .dock-pill')),
    columns: $('#body').children.length, details: Boolean($('#details')), scrollW: document.documentElement.scrollWidth, innerW: innerWidth };`);
const popoverContent = () => page(`const p = $('#popover'); const on = p.querySelector('.on-line'); return { title: p.querySelector('.popover-title')?.textContent, sub: p.querySelector('.popover-sub')?.textContent, back: p.querySelector('.popover-back')?.textContent ?? null, tags: $$('.popover-body > .row .tag', p).map((t) => t.textContent), sentence: p.querySelector('.popover-sentence')?.textContent ?? null, notes: $$('.popover-notes .note-card b', p).map((x) => x.textContent), cameFrom: Boolean(p.querySelector('.came-from')), choice: $$('.popover-body > .stack > .row > button.btn', p).map((x) => x.textContent), actions: $$('.popover-actions button', p).map((x) => x.textContent), openAll: p.querySelector('.popover-foot .btn')?.textContent, index: $$('.index-item, .popover-index', p).map((x) => x.textContent.trim()), onButtons: on ? $$('button, a', on).map((x) => x.textContent.trim()) : [] };`);
const openAll = async () => { await page(`$('#popover .popover-foot .btn').click(); return true;`); await b.waitFor("document.querySelector('#dialog').open && document.querySelector('#dialog .full-details')", { label: 'full details' }); await settle(300); };
const fullContent = () => page(`const d = $('#dialog'); return { title: d.querySelector('h2').textContent, sections: $$('[data-section]', d).map((s) => s.dataset.section), text: d.querySelector('.full-details')?.textContent ?? '', actions: $$('.full-details > .row button', d).map((x) => x.textContent), back: Boolean($$('.dialog-head button', d).find((x) => /Back/.test(x.textContent))) };`);
const closeDialog = async () => { await page(`if ($('#dialog').open) $('#dialog').close(); return true;`); await settle(200); };

// Which objects to try it on: a piece of work that is drawn and carries a note, and an area.
const workWithNote = graphData.nodes.filter((n) => n.category === 'Work item' && n.validity === 'Current' && n.noteCount > 0).map((n) => n.id);
const anyWork = graphData.nodes.filter((n) => n.category === 'Work item' && n.validity === 'Current').map((n) => n.id);
const areas = graphData.nodes.filter((n) => n.category === 'Area' && n.validity === 'Current').map((n) => n.id);
let WORK = null;
let AREA = null;

try {
  // ── 1 · A node on the graph: the popover beside it, no column, nothing moves (CKC-09 AC-34) ────────────────
  await openGraph();
  await b.shot(join(outDir, '00-default-view.png'));
  const drawn = await page(`const ids = ${JSON.stringify([...workWithNote, ...anyWork, ...areas])}; return ids.filter((id) => cyOf().getElementById(id).length > 0);`);
  WORK = workWithNote.find((id) => drawn.includes(id)) ?? anyWork.find((id) => drawn.includes(id));
  AREA = areas.find((id) => drawn.includes(id));
  if (!WORK || !AREA) throw new Error('the default graph draws no work item or no area to try the popover on');
  numbers.objects = { work: `${WORK} · ${labelOf(WORK)}`, area: `${AREA} · ${labelOf(AREA)}` };
  await bring(WORK);
  const before = await layout();
  const nodeBefore = await clickNode(WORK);
  const nodeAfter = await nodeRect(WORK);
  const l1 = await layout();
  check('no details column: the body holds the main view alone', l1.columns === 1 && !l1.details, `children of .body: ${l1.columns}`);
  check('picking a node on the graph moves nothing: the main view and the node are where they were', JSON.stringify(round(before.main)) === JSON.stringify(round(l1.main)) && JSON.stringify(round(nodeBefore)) === JSON.stringify(round(nodeAfter)), `node ${JSON.stringify(round(nodeAfter))}`);
  check('the popover is wholly inside the main view', inside(l1.popover, l1.area), `popover ${JSON.stringify(round(l1.popover))} in ${JSON.stringify(round(l1.area))}`);
  check('the popover does not cover the node it belongs to', !hit(l1.popover, nodeAfter), `side: ${l1.side}`);
  const content = await popoverContent();
  numbers.popoverContent = content;
  check('the popover holds the name and kind, one sentence, the state, the notes, the actions and Details', content.title === labelOf(WORK) && content.sub && content.tags.length > 0 && content.sentence && (workWithNote.includes(WORK) ? content.notes.length > 0 : true) && content.actions.includes('Ask Keeper') && content.actions.includes('Prepare context') && content.openAll === 'Details' && content.index.length === 0, JSON.stringify(content));
  await b.shot(join(outDir, '01-node-popover.png'));
  numbers.nodePopover = { main: round(l1.area), popover: round(l1.popover), node: round(nodeAfter), side: l1.side };

  // A second tap on the same node puts it away; another node moves it over.
  await b.click((nodeAfter.left + nodeAfter.right) / 2, (nodeAfter.top + nodeAfter.bottom) / 2);
  await settle();
  check('a second tap on the same node puts the popover away', (await layout()).popover === null);
  await settle(800);   // past the moment in which a press on the same node counts as the one that put it away
  await clickNode(WORK);
  await settle(750);
  // Another node that can be pressed right now: on screen, not under the popover, nothing drawn over its middle.
  const other = await page(`
    const pop = rectOf($('#popover')); const box = rectOf($('#cy')); const cy = cyOf(); const known = new Set(${JSON.stringify(graphData.nodes.map((n) => n.id))});
    const leaves = cy.nodes().filter((n) => !n.isParent());
    for (const n of leaves) {
      if (n.id() === ${JSON.stringify(WORK)} || !known.has(n.id())) continue;
      const r = views.graph.anchorRect({ kind: 'node', id: n.id() }); if (!r) continue;
      const c = { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
      if (c.x < box.left + 12 || c.x > box.right - 12 || c.y < box.top + 12 || c.y > box.bottom - 12 || hit(r, pop)) continue;
      if (!document.elementFromPoint(c.x, c.y)?.closest('#cy')) continue;
      if (leaves.some((m) => { if (m === n) return false; const o = views.graph.anchorRect({ kind: 'node', id: m.id() }); return o && c.x >= o.left && c.x <= o.right && c.y >= o.top && c.y <= o.bottom; })) continue;
      return { id: n.id(), ...c };
    }
    return null;`);
  if (other) {
    await b.click(other.x, other.y);
    await b.waitFor(`document.querySelector('#popover .popover-title')?.textContent === ${JSON.stringify(labelOf(other.id))}`, { label: `the popover moving to ${other.id}` }).catch(() => null);
    await settle(400);
    const moved = await page(`return { title: $('#popover .popover-title')?.textContent, open: !$('#popover').hidden };`);
    const movedLayout = await layout();
    check('picking another object moves the popover to it', moved.open && moved.title === labelOf(other.id) && inside(movedLayout.popover, movedLayout.area) && !hit(movedLayout.popover, await nodeRect(other.id)), `${other.id}: ${moved.title}`);
  } else check('picking another object moves the popover to it', false, 'no second node can be pressed in this layout');

  // ── 2 · Near all four edges, and following a pan and a zoom (Spec §6.4) ─────────────────────────────────────
  await b.key('Escape');   // a popover may lie over the node: a press on it would not reach the graph
  await settle(200);
  await bring(WORK);
  await clickNode(WORK);
  numbers.edges = {};
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    await page(`
      const cy = cyOf(); const el = cy.getElementById(${JSON.stringify(WORK)}); const p = el.renderedPosition(); const w = el.renderedWidth(), hgt = el.renderedHeight();
      const to = { left: { x: w / 2 + 4, y: cy.height() / 2 }, right: { x: cy.width() - w / 2 - 4, y: cy.height() / 2 }, top: { x: cy.width() / 2, y: hgt / 2 + 4 }, bottom: { x: cy.width() / 2, y: cy.height() - hgt / 2 - 4 } }[${JSON.stringify(edge)}];
      cy.panBy({ x: to.x - p.x, y: to.y - p.y }); return true;`);
    await settle(200);
    const l = await layout();
    const n = await nodeRect(WORK);
    numbers.edges[edge] = { node: round(n), popover: round(l.popover), side: l.side };
    check(`node at the ${edge} edge of the graph: popover wholly inside the main view, off the node`, inside(l.popover, l.area) && !hit(l.popover, n), `side ${l.side}, popover ${JSON.stringify(round(l.popover))}`);
  }
  const zoomBefore = await layout();
  await b.wheel((zoomBefore.main.left + zoomBefore.main.right) / 2, 300, -240);
  await settle(300);
  const zoomed = await layout();
  check('it follows the node when the graph is zoomed', zoomed.popover && inside(zoomed.popover, zoomed.area) && !hit(zoomed.popover, await nodeRect(WORK)), JSON.stringify(round(zoomed.popover)));

  // ── 3 · Popover and Keeper together: the conversation docks on the right and nothing is covered (AC-36, CKC-10 AC-19)
  await openGraph();
  await bring(WORK);
  await clickNode(WORK);
  const wide = await layout();
  await b.clickOn('#keeper-dock .dock-robot');
  await b.waitFor("document.querySelector('#keeper')?.classList.contains('open')", { label: 'keeper open' });
  await settle(700);
  const docked = await layout();
  const covered = await page(`const k = rectOf($('#keeper')); return textBoxes($('#app')).filter((t) => hit(t, k)).map((t) => t.text).slice(0, 5);`);
  check('Pi opens the conversation docked on the right, from under the top bar to the bottom', docked.keeper && Math.abs(docked.keeper.right - docked.innerW) < 1 && Math.abs(docked.keeper.bottom - 800) < 1 && Math.abs(docked.keeper.top - docked.body.top) < 1.5, JSON.stringify(round(docked.keeper)));
  check('the main view gives way by the panel’s width: the two do not intersect', !hit(docked.main, docked.keeper) && Math.abs(docked.main.right - docked.keeper.left) < 1.5, `main.right ${round(docked.main).right} · keeper.left ${round(docked.keeper).left} · main was ${round(wide.main).right}`);
  check('not one piece of text of the workbench lies under the panel', covered.length === 0, covered.join(' | '));
  check('the pill moved with the main view and is not under the panel', !hit(docked.pill, docked.keeper) && inside(docked.pill, { ...docked.body, bottom: 800 }), JSON.stringify(round(docked.pill)));
  check('the popover is still open and wholly inside what is left of the main view', docked.popover && inside(docked.popover, docked.area), `popover ${JSON.stringify(round(docked.popover))} in ${JSON.stringify(round(docked.area))}`);
  check('the popover does not cover its node with the Keeper docked', !hit(docked.popover, await nodeRect(WORK)), `side ${docked.side}`);
  const canvas = await page(`const c = $('#cy'); return { container: c.clientWidth, cy: cyOf().width() };`);
  check('the graph’s canvas followed its container', Math.abs(canvas.container - canvas.cy) < 1, JSON.stringify(canvas));
  // The session with the most turns, so that the measurements below are made on real content.
  await page(`const s = $('#keeper select'); const best = $$('option', s).filter((o) => o.value).sort((x, y) => (Number(/(\\d+) turn/.exec(y.textContent)?.[1] ?? 0)) - Number(/(\\d+) turn/.exec(x.textContent)?.[1] ?? 0))[0]; if (best && s.value !== best.value) { s.value = best.value; s.dispatchEvent(new Event('change')); } return true;`);
  await settle(900);
  await page(`$('#keeper-stream').scrollTop = 0; return true;`);
  await b.shot(join(outDir, '02-popover-and-keeper-docked.png'));
  numbers.docked = { main: round(docked.main), keeper: round(docked.keeper), pill: round(docked.pill), popover: round(docked.popover), area: round(docked.area) };

  // Wider by dragging its edge: the main view follows.
  await b.drag(docked.keeper.left + 3, 400, docked.keeper.left - 117, 400);
  await settle(500);
  const wider = await layout();
  check('dragging the panel’s edge makes it wider and the main view follows', wider.keeper.left < docked.keeper.left - 100 && !hit(wider.main, wider.keeper) && Math.abs(wider.main.right - wider.keeper.left) < 1.5 && (!wider.popover || inside(wider.popover, wider.area)), `keeper.left ${round(wider.keeper).left} · main.right ${round(wider.main).right}`);
  numbers.dockedWider = { main: round(wider.main), keeper: round(wider.keeper), popover: round(wider.popover) };
  await b.drag(wider.keeper.left + 3, 400, docked.keeper.left + 3, 400);
  await settle(400);

  // What only ProjectKeeper's conversation has is fed through the page's own functions where the fixture lacks it: a
  // turn that can be branched from, and an answer made of HTML and a link that is not a web address.
  await page(`
    const s = $('#keeper-stream'); views.conversation._branching = true;
    views.conversation.appendMessage(s, { role: 'user', text: 'What if an answer contains HTML or an odd link?' });
    views.conversation.appendMessage(s, { role: 'keeper', id: 'fed-hostile', canBranch: true, steps: [{ tool: 'read', target: 'docs/notes.md', summary: 'fed by the check' }], text: ['Things an answer can carry that must stay text:', '', '- a script tag: <script>alert("x")</script>', '- an image with a handler: <img src=x onerror=alert(1)>', '- a link that is not a web address: [open me](javascript:alert(1))', '- a frame: <iframe src="https://example.com/frame"></iframe>'].join('\\n') });
    return true;`);
  await settle(200);
  // Everything of the conversation is on show (CKC-10 AC-22): measured, in this form and again popped out.
  const conv = () => page(`
    const k = $('#keeper'); const kr = rectOf(k); const stream = $('#keeper-stream'); const sr = rectOf(stream);
    const within = (el) => { if (!el || !el.getClientRects().length) return false; const r = rectOf(el); return r.left >= kr.left - 0.5 && r.right <= kr.right + 0.5; };
    const onShow = (el) => { if (!el) return false; el.scrollIntoView({ block: 'nearest' }); const r = rectOf(el); return within(el) && r.bottom > sr.top && r.top < sr.bottom; };
    const headButtons = $$('.keeper-head button', k).filter((e) => e.getClientRects().length && inside(rectOf(e), kr)).map((e) => e.textContent.trim());
    const out = { form: k.classList.contains('floating') ? 'floating' : 'docked', who: k.querySelector('.keeper-who')?.textContent, usage: k.querySelector('[data-chat-context]')?.textContent, model: k.querySelector('[data-chat-model]')?.textContent, duplicateState: Boolean(k.querySelector('.keeper-agent,.keeper-state,.keeper-status')), ctx: k.querySelector('.ctx')?.textContent,
      session: within(k.querySelector('select')) && inside(rectOf(k.querySelector('select')), kr), headButtons, headOverflow: k.querySelector('.keeper-head').scrollWidth - k.querySelector('.keeper-head').clientWidth,
      turns: $$('.msg.user', stream).length, answers: $$('.msg.keeper', stream).length, streamOverflow: stream.scrollWidth - stream.clientWidth,
      investigated: $$('details.fold > summary', stream).filter((x) => /How the Keeper investigated/.test(x.textContent)).length, investigatedOnShow: onShow($$('details.fold > summary', stream).find((x) => /How the Keeper investigated/.test(x.textContent))),
      result: $$('.result', stream).length, resultOnShow: stream.querySelector('.result') ? onShow(stream.querySelector('.result')) && $$('.result .option', stream).every((o) => within(o)) : null, resultOptions: $$('.result .option', stream).length, resultText: stream.querySelector('.result')?.textContent.slice(0, 120) ?? null,
      branch: $$('button', stream).filter((x) => x.textContent === 'Branch here').length, branchOnShow: onShow($$('button', stream).find((x) => x.textContent === 'Branch here')),
      composer: inside(rectOf(k.querySelector('textarea')), kr), send: inside(rectOf(k.querySelector('.composer .btn')), kr), foot: k.querySelector('.composer .foot span')?.textContent };
    return out;`);
  const convDocked = await conv();
  numbers.conversationDocked = convDocked;
  const convOk = (c, formButton) => c.usage && c.model && !c.duplicateState && /Context/.test(c.ctx) && c.session && [formButton, 'Close', 'New session', 'Open in pi'].every((x) => c.headButtons.includes(x)) && c.headOverflow <= 0 && c.streamOverflow <= 0 && c.turns > 0 && c.investigated > 0 && c.investigatedOnShow && c.branch > 0 && c.branchOnShow && (c.result === 0 || c.resultOnShow) && c.composer && c.send;
  check('docked, all of the conversation is on show: context use, model, attached object, sessions, New session, Open in pi, Pop out, every turn with How the Keeper investigated, an investigation result, Branch here, the input', convOk(convDocked, 'Pop out'), JSON.stringify(convDocked));

  const md = await page(`
    const s = $('#keeper-stream'); const answers = $$('.msg.keeper .md', s);
    const prose = answers.map((a) => { const c = a.cloneNode(true); c.querySelectorAll('pre, code').forEach((x) => x.remove()); return c.textContent; }).join('\\n');
    const link = s.querySelector('a.md-link');
    return { marks: prose.match(/\\*\\*|\`|^#+ |~~|\\[src_/gm) ?? [], tags: ['strong', 'em', 'code', 'pre', 'ol', 'ul', 'table', 'th', 'blockquote', 'h2', 'a'].filter((t) => s.querySelector('.md ' + t)),
      link: link ? { href: link.getAttribute('href'), target: link.target, rel: link.rel } : null, made: s.querySelectorAll('script, img, iframe').length, unsafe: $$('.md-nolink', s).map((x) => ({ tag: x.tagName, text: x.textContent, href: x.getAttribute('href') })),
      hostileShown: /<script>alert\\("x"\\)<\\/script>/.test(s.textContent) && /<img src=x onerror=alert\\(1\\)>/.test(s.textContent), chips: $$('.md button.cite', s).length, chipsInCode: $$('.md pre .cite, .md code .cite', s).length,
      tableScrollsInside: $$('.md .md-table', s).every((t) => rectOf(t).right <= rectOf(s).right + 0.5),
      color: getComputedStyle(s.querySelector('.msg.keeper .md')).color, userColor: getComputedStyle(s.querySelector('.msg.user')).color, textVar: (() => { const probe = document.createElement('span'); probe.style.color = 'var(--pk-text-strong, var(--pk-text, #e7e7df))'; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; })() };`);
  numbers.markdown = md;
  check('answers are drawn as Markdown: bold, italics, code, a code block, both kinds of list, a table, a quote, a heading, links', ['strong', 'em', 'code', 'pre', 'ol', 'ul', 'table', 'th', 'blockquote', 'h2', 'a'].every((t) => md.tags.includes(t)), md.tags.join(' '));
  check('no mark is left showing in the answers, and every citation is a chip (none inside code)', md.marks.length === 0 && md.chips > 0 && md.chipsInCode === 0, `${md.chips} chips · marks ${JSON.stringify(md.marks)}`);
  check('a link opens in a new window with rel noopener noreferrer, and only for http(s)', md.link && /^https?:\/\//.test(md.link.href) && md.link.target === '_blank' && md.link.rel === 'noopener noreferrer' && md.unsafe.length === 1 && md.unsafe[0].tag === 'SPAN' && md.unsafe[0].href === null, JSON.stringify({ link: md.link, unsafe: md.unsafe }));
  check('HTML in an answer is shown as text: no script, image or frame element was made', md.made === 0 && md.hostileShown);
  check('a wide table stays inside the panel', md.tableScrollsInside);
  check('answers and the owner’s messages take the strongest text colour (the theme’s --pk-text-strong, or the body colour when it has none)', md.color === md.textVar && md.userColor === md.textVar, `${md.color} / ${md.userColor} / strongest ${md.textVar}`);
  await page(`$('#keeper-stream .md button.cite').click(); return true;`);
  await b.waitFor("document.querySelector('#dialog').open", { label: 'source dialog' });
  check('a citation chip opens the source', await page(`return Boolean($('#dialog .source-quote'));`));
  await b.key('Escape');
  await settle(200);

  // Streaming: fed through the page's own event handler, as the server would; the marks must not pile up on screen.
  const streamed = await page(`
    const text = 'Looking at **the index** now.\\n\\n- \`search.ts\` builds it\\n- the *test* is empty [src_0123456789abcdef]\\n\\n| a | b |\\n|---|---|\\n| 1 | **2** |\\n';
    const seen = [];
    for (let i = 0; i < text.length; i += 3) {
      views.conversation.onEvent({ type: 'chat', data: { kind: 'delta', data: { messageId: 'stream-check', text: text.slice(i, i + 3) } } });
      await new Promise((r) => requestAnimationFrame(() => r()));
      const el = document.querySelector('[data-id="stream-check"] .md'); const c = el.cloneNode(true); c.querySelectorAll('code').forEach((x) => x.remove());
      seen.push((c.textContent.match(/\\*\\*|\`/g) ?? []).length);
    }
    const el = document.querySelector('[data-id="stream-check"]');
    const out = { maxMarksAtOnce: Math.max(...seen), finalMarks: seen[seen.length - 1], tags: ['strong', 'em', 'code', 'ul', 'table'].filter((t) => el.querySelector(t)), chip: Boolean(el.querySelector('button.cite')) };
    el.remove();
    return out;`);
  numbers.streaming = streamed;
  check('while an answer streams, at most the one mark still open shows, and none once it is complete', streamed.maxMarksAtOnce <= 1 && streamed.finalMarks === 0 && streamed.tags.length === 5 && streamed.chip, JSON.stringify(streamed));

  // ── 4 · Pop out and Dock: the same conversation (CKC-10 AC-20) ─────────────────────────────────────────────
  await page(`const s = $('#keeper-stream'); const ta = $('#keeper textarea'); window.__s = s; window.__ta = ta; ta.value = 'half a mess'; s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) / 2); return true;`);
  const hold = () => page(`const s = $('#keeper-stream'); const top = s.getBoundingClientRect().top; const first = [...s.children].find((m) => m.getBoundingClientRect().bottom > top + 1); return { same: window.__s === s && window.__ta === $('#keeper textarea'), value: $('#keeper textarea').value, first: [...s.children].indexOf(first), offset: Math.round(first.getBoundingClientRect().top - top), scrollTop: s.scrollTop, max: s.scrollHeight - s.clientHeight };`);
  const held = await hold();
  await page(`button($('#keeper .keeper-head'), 'Pop out').click(); return true;`);
  await sleep(60);
  const anim = await page(`const k = $('#keeper'); return { floating: k.classList.contains('floating'), dropping: k.classList.contains('dropping'), animation: getComputedStyle(k).animationName };`);
  await sleep(1100);
  const popped = await layout();
  const heldPopped = await hold();
  check('Pop out makes it the window, dropping in from the top', anim.floating && anim.dropping && anim.animation === 'pk-drop', JSON.stringify(anim));
  check('popped out, the main view is back to its full width', Math.abs(popped.main.right - wide.main.right) < 1 && popped.keeper.right < popped.innerW - 1, `main.right ${round(popped.main).right}`);
  check('it is the same conversation: same elements, the half-typed message, the same message at the top of the view', heldPopped.same && heldPopped.value === 'half a mess' && heldPopped.first === held.first && Math.abs(heldPopped.offset - held.offset) <= 2, `${JSON.stringify(held)} → ${JSON.stringify(heldPopped)}`);
  await b.shot(join(outDir, '04-popped-out.png'));
  const convFloating = await conv();
  numbers.conversationFloating = convFloating;
  check('popped out, all of the conversation is on show too, with Dock in place of Pop out', convOk(convFloating, 'Dock'), JSON.stringify(convFloating));
  numbers.poppedOut = { keeper: round(popped.keeper), main: round(popped.main) };
  // Dragged by its header, remembered, and back to the middle on a double-click of the header.
  const headAt = () => page(`const r = rectOf($('#keeper .keeper-head .ctx')); return { x: r.right - 12, y: (r.top + r.bottom) / 2 };`);
  const h1 = await headAt();
  await b.drag(h1.x, h1.y, h1.x - 200, h1.y + 60);
  await settle(200);
  const draggedTo = await layout();
  const remembered = await page(`return JSON.parse(localStorage.getItem('pk.keeper.pos'));`);
  check('the window is dragged by its header and remembers where it was put', Math.abs(draggedTo.keeper.left - (popped.keeper.left - 200)) < 3 && Math.abs(draggedTo.keeper.top - (popped.keeper.top + 60)) < 3 && Math.abs(remembered.left - draggedTo.keeper.left) < 2, `${JSON.stringify(round(draggedTo.keeper))} remembered ${JSON.stringify(remembered)}`);
  const h2 = await headAt();
  await b.click(h2.x, h2.y);
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: h2.x, y: h2.y, button: 'left', buttons: 1, clickCount: 2 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: h2.x, y: h2.y, button: 'left', buttons: 0, clickCount: 2 });
  await settle(200);
  const centred = await layout();
  check('a double-click on its header puts it back in the middle', Math.abs((centred.keeper.left + centred.keeper.right) / 2 - centred.innerW / 2) < 2, JSON.stringify(round(centred.keeper)));
  await page(`const k = $('#keeper'); k.style.width = '640px'; k.style.height = '520px'; return true;`);   // as the corner grip would
  await settle(300);
  const resized = await page(`return { rect: rectOf($('#keeper')), resize: getComputedStyle($('#keeper')).resize, remembered: JSON.parse(localStorage.getItem('pk.keeper.pos')) };`);
  check('the window can be resized from its corner, and its size is remembered', resized.resize === 'both' && Math.abs(resized.rect.width - 640) < 1 && resized.remembered?.width === 640 && resized.remembered?.height === 520, JSON.stringify(resized.remembered));
  await b.reducedMotion(true);
  await page(`button($('#keeper .keeper-head'), 'Dock').click(); return true;`);
  await settle(300);
  const heldDocked = await hold();
  const redocked = await layout();
  check('Dock puts it back on the right, the main view gives way again, and it is still the same conversation', redocked.keeper && Math.abs(redocked.keeper.right - redocked.innerW) < 1 && !hit(redocked.main, redocked.keeper) && heldDocked.same && heldDocked.value === 'half a mess', JSON.stringify(heldDocked));
  await page(`button($('#keeper .keeper-head'), 'Pop out').click(); return true;`);
  await sleep(40);
  const fade = await page(`return getComputedStyle($('#keeper')).animationName;`);
  check('with reduced motion the window fades in instead of dropping', fade === 'pk-fade', fade);
  await b.reducedMotion(false);
  // A change of view leaves it as it is; closed and opened again, it is docked.
  await b.evaluate(`location.hash = ${JSON.stringify(url('notes').split('#')[1])}`);
  await b.waitFor("document.querySelector('#main h1')?.textContent === 'Notes log'");
  await settle(300);
  const afterView = await hold();
  check('a change of view does not rebuild the conversation', afterView.same && afterView.value === 'half a mess' && (await page(`return $('#keeper').classList.contains('floating') && $('#keeper').classList.contains('open');`)));
  await page(`button($('#keeper .keeper-head'), 'Close').click(); return true;`);
  await settle(200);
  const closed = await layout();
  check('closing it gives the main view its full width back', closed.keeper === null && Math.abs(closed.main.right - wide.main.right) < 1);
  await b.clickOn('#keeper-dock .dock-robot');
  await settle(500);
  const reopened = await page(`const k = $('#keeper'); return { docked: k.classList.contains('docked') && !k.classList.contains('floating'), value: k.querySelector('textarea').value, same: window.__ta === k.querySelector('textarea') };`);
  check('closed and opened again, it is docked on the right, with what was being typed', reopened.docked && reopened.same && reopened.value === 'half a mess', JSON.stringify(reopened));
  await b.clickOn('#keeper-dock .dock-robot');
  await settle(300);
  check('Pi puts the conversation away again', (await layout()).keeper === null);

  // ── 5 · Details: every part, links that lead somewhere, and the way back (AC-12, AC-33, AC-35) ────────────
  await openGraph();
  await bring(WORK);
  await clickNode(WORK);
  await openAll();
  const full = await fullContent();
  numbers.fullDetailsWork = { title: full.title, sections: full.sections, actions: full.actions };
  check('Details shows every part of a work item’s details', ['work', 'fact-records', 'sessions', 'sources', 'relations', 'notes', 'why'].every((s) => full.sections.includes(s)) && ['Ask Keeper', 'Prepare context', 'Show on graph'].every((a) => full.actions.includes(a)), full.sections.join(' '));
  await b.shot(join(outDir, '03-open-all.png'));
  await page(`const body = $('#dialog .dialog-body'); body.scrollTop = 160; $$('details', $('#dialog')).find((f) => /fact records/.test(f.textContent)).open = true; return true;`);
  const leftAt = await page(`return $('#dialog .dialog-body').scrollTop;`);
  await page(`$('#dialog [data-section="relations"] button').click(); return true;`);
  await b.waitFor("document.querySelector('#dialog h2')?.textContent.includes('→')", { label: 'relation details on top' });
  const rel = await fullContent();
  numbers.fullDetailsRelation = { title: rel.title, sections: rel.sections };
  check('a relation in the full details opens that relation’s full details on top, with a way back', ['claim', 'evidence', 'assessment', 'notes', 'why'].every((s) => rel.sections.includes(s)) && rel.back, JSON.stringify(rel.sections));
  const hasSource = await page(`const bt = $('#dialog [data-section="evidence"] button.text-btn'); if (bt) bt.click(); return Boolean(bt);`);
  if (hasSource) {
    await b.waitFor("document.querySelector('#dialog .source-quote, #dialog ul.stmts')", { label: 'a source or a fact record on top of the relation' });
    await b.key('Escape');
    await settle(250);
    check('Escape closes one layer: from the source back to the relation', await page(`return $('#dialog').open && $('#dialog h2').textContent.includes('→');`));
  }
  await page(`$$('.dialog-head button', $('#dialog')).find((x) => /Back/.test(x.textContent)).click(); return true;`);
  await settle(250);
  const backAt = await page(`const d = $('#dialog'); return { title: d.querySelector('h2').textContent, scrollTop: d.querySelector('.dialog-body').scrollTop, foldOpen: $$('details', d).find((f) => /fact records/.test(f.textContent)).open };`);
  check('Back returns to the first object as it was left: scrolled where it was, its fold still open', backAt.title === full.title && Math.abs(backAt.scrollTop - leftAt) <= 1 && backAt.foldOpen, JSON.stringify(backAt));
  await page(`button($('#dialog .dialog-head'), 'Close').click(); return true;`);
  await settle(250);
  const afterDone = await page(`return { open: $('#dialog').open, popover: !$('#popover').hidden, focusInPopover: $('#popover').contains(document.activeElement) || document.activeElement === $('#popover'), index: $$('.popover-index, .index-item').length, details: $('#popover .popover-foot .btn')?.textContent };`);
  check('Close closes the dialog and the owner is back at the popover, focus inside it', !afterDone.open && afterDone.popover && afterDone.focusInPopover, JSON.stringify(afterDone));
  check('the popover has no section index; Details opens the full details', afterDone.details === 'Details' && afterDone.index === 0, JSON.stringify(afterDone));

  // ── 6 · A note in the popover, and back (Spec §6.4) ────────────────────────────────────────────────────────
  if (workWithNote.includes(WORK)) {
    await page(`$('#popover .note-card').click(); return true;`);
    await b.waitFor("document.querySelector('#popover .popover-sub')?.textContent.startsWith('Keeper note')", { label: 'note page' });
    await settle(300);
    const notePage = await popoverContent();
    const noteLayout = await layout();
    numbers.notePage = notePage;
    check('a note of the object opens in the same popover with its response actions, Details and a way back', notePage.back && notePage.actions.includes('Discuss with Keeper') && notePage.actions.includes('Confirm') && !notePage.actions.includes('Investigate') && !notePage.actions.includes('Show on graph') && notePage.onButtons.includes('Show on graph') && notePage.openAll === 'Details' && notePage.index.length === 0 && inside(noteLayout.popover, noteLayout.area), JSON.stringify(notePage));
    await b.shot(join(outDir, '06-note-in-popover.png'));
    await page(`$('#popover .popover-back').click(); return true;`);
    await b.waitFor("!document.querySelector('#popover .popover-back') && document.querySelector('#popover .popover-title')", { label: 'back on the object page' });
    check('the way back returns to the object', (await page(`return $('#popover .popover-title').textContent;`)) === labelOf(WORK));
  }
  await b.key('Escape');
  await settle(200);
  // Straight from Notes (attention): a row opens the one full-width reading sheet, with the same ways to answer the
  // popover's note page has; scripts/ui-s3-check.mjs measures the sheet itself.
  await b.clickOn('.strip [data-note]');
  await b.waitFor("document.querySelector('.strip-sheet .more-actions')", { label: 'the note opened in the reading sheet' });
  await settle(300);
  const fromStrip = await page(`const sheet = $('.strip-sheet'); const on = sheet.querySelector('.on-line'); return { note: $('.strip .strip-row.open [data-note]').dataset.note, popoverHidden: $('#popover').hidden, actions: $$('.more-actions button', sheet).map((x) => x.textContent), details: Boolean(button(sheet, 'Details')), onButtons: on ? $$('button, a', on).map((x) => x.textContent.trim()) : [], width: rectOf(sheet).width, stripWidth: rectOf($('.strip')).width };`);
  const stripNote = notesData.notes.find((n) => n.id === fromStrip.note);
  const stripConfirms = stripNote && stripNote.status === 'Current' && stripNote.ownerResponse !== 'Decided' && stripNote.id !== 'note_takeover-depth';
  check('a note picked in Notes (attention) opens the full-width sheet with its response actions and Details, and no popover', fromStrip.popoverHidden && Math.abs(fromStrip.width - fromStrip.stripWidth) < 2 && fromStrip.actions.includes('Discuss with Keeper') && !fromStrip.actions.includes('Investigate') && !fromStrip.actions.includes('Show on graph') && fromStrip.details && (stripConfirms ? fromStrip.actions.includes('Confirm') : !fromStrip.actions.includes('Confirm')) && (stripNote?.mount.kind === 'project' ? fromStrip.onButtons.length === 0 : fromStrip.onButtons.length === 1 && fromStrip.onButtons[0] === 'Show on graph'), JSON.stringify(fromStrip));
  // Show on graph, from that note: the note's popover stands beside what the note is mounted on.
  if (stripNote?.mount.kind !== 'project' && stripNote?.mount.ids?.length) {
    await b.clickOn('.strip-sheet .on-line button');
    await settle(1200);
    const onGraph = await page(`const pop = $('#popover'); return { open: !pop.hidden, popover: rectOf(pop), rects: ${JSON.stringify(stripNote.mount.ids)}.map((id) => views.graph.anchorRect({ kind: 'node', id })).filter(Boolean) };`);
    const gap = (a, r) => Math.hypot(Math.max(0, r.left - a.right, a.left - r.right), Math.max(0, r.top - a.bottom, a.top - r.bottom));
    const gaps = onGraph.rects.map((r) => Math.round(gap(onGraph.popover, r)));
    numbers.noteShownOnGraph = { note: stripNote.id, popover: round(onGraph.popover), mountedOn: onGraph.rects.map(round), gaps };
    check('Show on graph from a note: the popover stands beside an object the note is mounted on', onGraph.open && gaps.some((g) => g > 0 && g <= 12) && inside(onGraph.popover, (await layout()).area), `${stripNote.id}: gaps ${JSON.stringify(gaps)}`);
  }
  await b.key('Escape');
  await settle(200);

  // ── 7 · Keyboard: the outline opens it, Tab stays inside it, Escape closes it and focus goes back (AC-34) ───
  await page(`$('#outline .ol-work').focus(); return true;`);
  await b.key('Enter');
  await popoverOpen('popover from the keyboard');
  await settle(500);
  const focusIn = await page(`return $('#popover').contains(document.activeElement) || document.activeElement === $('#popover');`);
  const stops = await page(`return $('#popover').querySelectorAll('button').length;`);
  let stayed = true;
  for (let i = 0; i < stops + 2; i++) { await b.key('Tab'); stayed = stayed && (await page(`return $('#popover').contains(document.activeElement);`)); }
  await b.key('Escape');
  await settle(200);
  const afterEsc = await page(`return { closed: $('#popover').hidden, focus: document.activeElement?.className ?? '', isOutline: document.activeElement === $('#outline .ol-work') };`);
  check('from the keyboard: Enter on an outline item opens it and takes the focus, Tab walks its items and stays in it, Escape closes it and focus returns to the item', focusIn && stayed && afterEsc.closed && afterEsc.isOutline, `${stops} buttons · after Escape focus on "${afterEsc.focus}"`);
  const keyboardWays = await page(`return { outline: $$('#outline [data-node]').every((e) => e.tagName === 'BUTTON'), strip: $$('.strip .item').every((e) => e.tabIndex === 0 && e.getAttribute('role') === 'button') };`);
  check('the outline and the bottom strip can be reached with Tab and pressed with Enter or Space', keyboardWays.outline && keyboardWays.strip, JSON.stringify(keyboardWays));

  // ── 8 · List: a pick in the middle of the table opens the popover and nothing else happens (AC-31) ──────────
  await b.clickOn('.graph-tools > .segmented:nth-child(2) > button:nth-child(2)');
  await b.waitFor("document.querySelector('.list-wrap table')", { label: 'List' });
  await settle(500);
  // The owner's own scroll to the middle of the table, before the pick.
  await page(`const rows = $$('.list-wrap tbody tr'); rows[Math.floor(rows.length / 2)].scrollIntoView({ block: 'center' }); return true;`);
  await settle(300);
  const listState = () => page(`const w = $('.list-wrap'); window.__table = window.__table ?? w.querySelector('table'); return { same: window.__table === w.querySelector('table'), scrollTop: w.scrollTop, rows: $$('tr', w).map((r) => { const x = rectOf(r); return [Math.round(x.top), Math.round(x.height), Math.round(x.width)]; }), cells: $$('td', w).map((c) => Math.round(rectOf(c).height)) };`);
  const listBefore = await listState();
  const target = await page(`const rows = $$('.list-wrap tbody tr'); const row = rows[Math.floor(rows.length / 2)]; const wrap = rectOf($('.list-wrap')); const at = (r) => ({ x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 }); const btn = $$('button[data-node]', row).find((e) => { const r = rectOf(e); const p = at(r); return r.top > wrap.top && r.bottom < wrap.bottom && e.contains(document.elementFromPoint(p.x, p.y)); }); const r = rectOf(btn); return { id: btn.dataset.node, ...at(r), rect: r, row: rows.indexOf(row), of: rows.length };`);
  await b.click(target.x, target.y);
  await popoverOpen('popover in the List');
  await settle(400);
  const listAfter = await listState();
  const listLayout = await layout();
  check('in the List a pick rebuilds nothing, scrolls nothing and moves no row', listAfter.same && listAfter.scrollTop === listBefore.scrollTop && JSON.stringify(listAfter.rows) === JSON.stringify(listBefore.rows) && JSON.stringify(listAfter.cells) === JSON.stringify(listBefore.cells), `row ${target.row + 1} of ${target.of}; ${listBefore.rows.length} rows and ${listBefore.cells.length} cells compared; scrollTop ${listBefore.scrollTop}`);
  check('the popover stands beside the cell that was picked, inside the main view', inside(listLayout.popover, listLayout.area) && !hit(listLayout.popover, target.rect), `side ${listLayout.side} · ${JSON.stringify(round(listLayout.popover))}`);
  await b.shot(join(outDir, '05-list-popover.png'));
  numbers.list = { cell: round(target.rect), popover: round(listLayout.popover), side: listLayout.side, row: `${target.row + 1} of ${target.of}` };
  // Near the List's corners too.
  numbers.listEdges = {};
  for (const name of ['topLeft', 'bottomRight']) {
    await b.key('Escape');
    await settle(150);
    await page(`$('.list-wrap').scrollTop = ${name === 'topLeft' ? 0 : 1e6}; return true;`);
    await settle(200);
    // Only a cell a press can reach: the table's header stays on top of the rows that are scrolled under it.
    const at = await page(`const wrap = rectOf($('.list-wrap')); const at = (r) => ({ x: r.left + Math.min(12, r.width / 2), y: r.top + r.height / 2 }); const all = $$('.list-wrap button[data-node]').filter((e) => { if (!e.getClientRects().length) return false; const r = rectOf(e); const p = at(r); return r.top >= wrap.top && r.bottom <= wrap.bottom && e.contains(document.elementFromPoint(p.x, p.y)); }); const score = (e) => rectOf(e).top + rectOf(e).left; const e = all.sort((x, y) => ${name === 'topLeft' ? 'score(x) - score(y)' : 'score(y) - score(x)'})[0]; const r = rectOf(e); return { ...at(r), rect: r, id: e.dataset.node };`);
    await b.click(at.x, at.y);
    await popoverOpen(`popover at the List's ${name}`);
    await settle(350);
    const l = await layout();
    numbers.listEdges[name] = { cell: round(at.rect), popover: round(l.popover), side: l.side };
    check(`List, ${name} cell: popover wholly inside the main view, off the cell`, inside(l.popover, l.area) && !hit(l.popover, at.rect), `side ${l.side}`);
  }
  await b.key('Escape');

  // ── 9 · The pill lies on no text, in any view, wherever the view is scrolled (AC-1) ────────────────────────
  numbers.pill = {};
  const pillCheck = async (name) => {
    const r = await page(`
      const pill = rectOf($('#keeper-dock .dock-pill')); const scrollers = [$('#main'), $('.list-wrap'), ...$$('.strip .items')].filter(Boolean);
      const found = []; let boxes = 0;
      for (const at of [0, 0.5, 1]) {
        for (const s of scrollers) s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) * at);
        await new Promise((r) => requestAnimationFrame(() => r()));
        const all = textBoxes($('#app')); boxes += all.length;
        for (const t of all) if (hit(t, pill)) found.push(\`\${at}: \${t.text}\`);
      }
      for (const s of scrollers) s.scrollTop = 0;
      return { pill, under: found, boxes };`);
    numbers.pill[name] = { pill: round(r.pill), textBoxesChecked: r.boxes, under: r.under };
    check(`the pill lies on no text: ${name}`, r.under.length === 0, r.under.length ? r.under.slice(0, 4).join(' | ') : `${r.boxes} text boxes checked at the top, the middle and the end of each scroll`);
  };
  await openGraph();
  await pillCheck('Project graph · Graph');
  await b.clickOn('.graph-tools > .segmented:nth-child(2) > button:nth-child(2)');
  await b.waitFor("document.querySelector('.list-wrap table')");
  await settle(400);
  await pillCheck('Project graph · List');
  await b.clickOn('.graph-tools > .segmented:nth-child(2) > button:first-child');
  for (const [view, title] of [['notes', 'Notes log'], ['changes', 'Change log'], ['context', 'Agent context'], ['scope', 'Project scope'], ['keeper', 'Keeper']]) {
    await b.evaluate(`location.hash = ${JSON.stringify(url(view).split('#')[1])}`);
    await b.waitFor(`document.querySelector('#main h1')?.textContent === ${JSON.stringify(title)}`, { label: title });
    await settle(1000);
    await pillCheck(title);
  }
  // …and with the Keeper docked, where the pill sits beside the panel.
  await b.evaluate(`location.hash = ${JSON.stringify(url('scope').split('#')[1])}`);
  await b.waitFor("document.querySelector('#main h1')?.textContent === 'Project scope'");
  await b.clickOn('#keeper-dock .dock-robot');
  await settle(800);
  await pillCheck('Project scope with the Keeper docked');
  const scopeDocked = await layout();
  check('in a page view too the main view and the docked panel do not intersect', !hit(scopeDocked.main, scopeDocked.keeper) && !hit(scopeDocked.pill, scopeDocked.keeper), `main.right ${round(scopeDocked.main).right} · keeper.left ${round(scopeDocked.keeper).left}`);
  await b.clickOn('#keeper-dock .dock-robot');
  await settle(300);

  // ── 10 · Assets change: the popover stays where it is and only changed content is redrawn (AC-34) ──────────
  const answerable = notesData.notes.find((n) => n.status === 'Current' && n.ownerResponse !== 'No action needed' && n.mount.kind !== 'project' && n.mount.ids.some((id) => drawn.includes(id) || id === WORK));
  if (answerable) {
    await openGraph();
    await pick({ kind: 'note', id: answerable.id, label: answerable.versions.at(-1).title }, '{ trigger: null }');
    const still = await page(`
      const p = $('#popover'); const body = p.querySelector('.popover-body'); const r0 = rectOf(p);
      await app.popover.refresh(); await new Promise((r) => setTimeout(r, 300));
      return { sameNodes: body === p.querySelector('.popover-body'), sameRect: JSON.stringify(r0) === JSON.stringify(rectOf(p)) };`);
    check('nothing changed in the assets: the popover is not redrawn and does not move', still.sameNodes && still.sameRect, JSON.stringify(still));
    const posBefore = await layout();
    await page(`button($('#popover .popover-actions'), 'No action needed').click(); return true;`);
    await b.waitFor("[...document.querySelectorAll('#popover .tag')].some((t) => t.textContent === 'No action needed')", { label: 'the note shows the answer', timeout: 6000 });
    await sleep(1600);   // the server's asset event, coalesced once a second, arrives too
    const posAfter = await layout();
    const updated = await page(`const p = $('#popover'); return { open: !p.hidden, tags: $$('.tag', p).map((t) => t.textContent), button: Boolean(button(p, 'No action needed')) };`);
    check('the assets changed: the popover shows the new content in place, where it was', updated.open && updated.tags.includes('No action needed') && !updated.button && posAfter.side === posBefore.side && Math.abs(posAfter.popover.left - posBefore.popover.left) < 1, `${answerable.id}: ${JSON.stringify(round(posBefore.popover))} → ${JSON.stringify(round(posAfter.popover))}`);
    await b.key('Escape');
    // So that the check can be run again on the same home: a `Discussed` note offers `No action needed` again
    // (there is no route that clears an answer).
    await fetch(`${base}/api/projects/${PID}/notes/${encodeURIComponent(answerable.id)}/response`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ response: 'Discussed' }) });
  }

  // ── 11 · A narrow window (about a phone): no sideways scroll, everything opens as an overlay (AC-21) ───────
  await openGraph({ width: 390, height: 844, mobile: true });
  const narrow0 = await layout();
  // Against the window's own width, not only the page's: a page wider than a phone makes the browser zoom out, and
  // innerWidth then grows with it, so `scrollW ≤ innerW` alone held while the row ran past the window (QC AY B12).
  check('narrow: no horizontal scroll', narrow0.scrollW <= narrow0.innerW && narrow0.innerW === 390, `${narrow0.scrollW} ≤ ${narrow0.innerW} (window 390)`);
  await pick({ kind: 'node', id: WORK, label: labelOf(WORK) }, '{ trigger: null }');
  const sheet = await page(`const p = $('#popover'); return { sheet: p.classList.contains('sheet'), rect: rectOf(p), scrim: !$('.popover-scrim').hidden, scrollW: document.documentElement.scrollWidth, innerW: innerWidth, innerH: innerHeight };`);
  check('narrow: the popover is an overlay along the bottom, inside the window', sheet.sheet && sheet.scrim && sheet.rect.left >= 0 && sheet.rect.right <= sheet.innerW && sheet.rect.bottom <= sheet.innerH && sheet.scrollW <= sheet.innerW, JSON.stringify(round(sheet.rect)));
  await b.shot(join(outDir, '07-narrow-popover.png'));
  const bar = await page(`return { bar: rectOf($('.topbar')), crumb: rectOf($('#focus-crumb')) };`);
  check('narrow: the selected object’s name stays inside the top bar', inside(bar.crumb, bar.bar), `${JSON.stringify(round(bar.crumb))} in ${JSON.stringify(round(bar.bar))}`);
  await openAll();
  const narrowDialog = await page(`return { rect: rectOf($('#dialog')), scrollW: document.documentElement.scrollWidth, innerW: innerWidth };`);
  check('narrow: the full details open as an overlay inside the window', narrowDialog.rect.left >= 0 && narrowDialog.rect.right <= narrowDialog.innerW && narrowDialog.scrollW <= narrowDialog.innerW, JSON.stringify(round(narrowDialog.rect)));
  await b.shot(join(outDir, '07-narrow-open-all.png'));
  await closeDialog();
  await b.key('Escape');
  await settle(200);
  await b.clickOn('#keeper-dock .dock-robot');
  await settle(700);
  const narrowKeeper = await layout();
  const narrowConv = await page(`const k = $('#keeper'); const s = $('#keeper-stream'); return { headOverflow: k.querySelector('.keeper-head').scrollWidth - k.querySelector('.keeper-head').clientWidth, streamOverflow: s.scrollWidth - s.clientWidth };`);
  check('narrow: the conversation opens over the main view, the width of the window, and nothing scrolls sideways', narrowKeeper.keeper && narrowKeeper.keeper.left <= 0.5 && Math.abs(narrowKeeper.keeper.right - narrowKeeper.innerW) < 1 && Math.abs(narrowKeeper.main.right - narrow0.main.right) < 1 && narrowKeeper.scrollW <= narrowKeeper.innerW && narrowConv.headOverflow <= 0 && narrowConv.streamOverflow <= 0, JSON.stringify({ ...round(narrowKeeper.keeper), ...narrowConv }));
  await b.shot(join(outDir, '07-narrow-keeper.png'));
  numbers.narrow = { popover: round(sheet.rect), dialog: round(narrowDialog.rect), keeper: round(narrowKeeper.keeper), scrollWidth: narrowKeeper.scrollW, innerWidth: narrowKeeper.innerW };

  // ── 12 · The richer objects of the UI fixture: every part of the old column is found (AC-33, AC-35) ────────
  if (has('ref_dec_font')) {
    await openGraph();
    numbers.rich = {};
    const rich = async (name, sel, expectPopover, expectFull, shot) => {
      await pick(sel);
      const p = await popoverContent();
      const l = await layout();
      if (shot) await b.shot(join(outDir, shot));
      await openAll();
      const f = await fullContent();
      numbers.rich[name] = { popover: p, side: l.side, sections: f.sections, actions: f.actions };
      const okPopover = expectPopover(p);
      const okFull = expectFull(f);
      check(`${name}: the popover shows its summary inside the main view, and Details holds the rest`, inside(l.popover, l.area) && okPopover && okFull, `popover ${okPopover ? 'ok' : JSON.stringify(p)} · full ${okFull ? f.sections.join(' ') : JSON.stringify({ sections: f.sections, text: f.text.slice(0, 300) })}`);
      return f;
    };
    // A decision nobody asked the owner about: the mark is on the popover, who decided and when is in the full details.
    await rich('decision made without the owner', { kind: 'node', id: 'ref_dec_font', label: labelOf('ref_dec_font') },
      (p) => p.tags.some((t) => /Decided without owner/.test(t)) && p.sentence && p.openAll === 'Details' && p.index.length === 0,
      (f) => f.sections.includes('authority') && /Decided without owner/.test(f.text) && f.sections.includes('description') && f.sections.includes('sources'), '08-decision-without-owner.png');
    await closeDialog();
    // A decision that asks for something: how far it was carried out, and the work that carries it out opens.
    await rich('decision with carry-out', { kind: 'node', id: 'ref_dec_export', label: labelOf('ref_dec_export') },
      (p) => p.openAll === 'Details' && p.index.length === 0 && p.sentence,
      (f) => f.sections.includes('carry-out') && /Partly carried out/.test(f.text) && /Still left/.test(f.text));
    await page(`$('#dialog [data-section="carry-out"] button.text-btn').click(); return true;`);
    await b.waitFor("document.querySelectorAll('#dialog .dialog-head button').length === 2 && document.querySelector('#dialog [data-section=\"work\"]')", { label: 'the work that carries it out, on top' });
    check('decision with carry-out: the work that carries it out opens from it, with a way back', (await fullContent()).back);
    await closeDialog();
    // A piece of work with fact records: who reported what, and what the check against the code found.
    let fact = null;
    for (const n of graphData.nodes.filter((x) => x.category === 'Work item')) {
      const d = await get(`/nodes/${encodeURIComponent(n.id)}`);
      const f = d.thread?.facts?.find((x) => x.id === 'fact_batch2');
      if (f) { fact = { node: n.id, title: f.title }; break; }
    }
    if (fact) {
      const f = await rich('work item with fact records', { kind: 'node', id: fact.node, label: labelOf(fact.node) },
        (p) => p.actions.includes('Prepare context') && p.openAll === 'Details' && p.index.length === 0,
        (full) => ['work', 'fact-records', 'sources', 'relations', 'why'].every((s) => full.sections.includes(s)));
      await page(`const f = $('#dialog [data-section="fact-records"] details'); f.open = true; $$('button.text-btn', f).find((x) => x.textContent === ${JSON.stringify(fact.title)}).click(); return true;`);
      await b.waitFor("document.querySelector('#dialog ul.stmts') && document.querySelectorAll('#dialog .dialog-head button').length === 2", { label: 'a fact record on top of the work item' });
      await settle(200);
      const facts = await page(`return { text: $('#dialog .dialog-body').textContent, back: Boolean($$('.dialog-head button', $('#dialog')).find((x) => /Back/.test(x.textContent))) };`);
      numbers.rich.factRecord = { node: fact.node, title: fact.title, reportedBy: /Reported by/.test(facts.text), differsInRecord: /Differs from the code/.test(facts.text), differsInDetails: /Differs from the code/.test(f.text) };
      check('work item with fact records: the record opens on top of the details with who reported what and what the check against the code found, and there is a way back', facts.back && numbers.rich.factRecord.reportedBy && (numbers.rich.factRecord.differsInRecord || numbers.rich.factRecord.differsInDetails), JSON.stringify(numbers.rich.factRecord));
      await closeDialog();
    }
    // A questioned relation with a note on it; it is not drawn in the overview, so the popover stands by one of its ends.
    await rich('questioned relation', { kind: 'relation', id: 'rel_verify_search_perf', label: 'verifies' },
      (p) => p.tags.includes('Questioned') && p.sentence && p.notes.length === 1 && p.actions.includes('Ask Keeper'),
      (f) => ['claim', 'evidence', 'assessment', 'notes', 'why'].every((s) => f.sections.includes(s)), '09-questioned-relation.png');
    await closeDialog();
    // A note a change follow-up brought: where it came from, and the walk through the change.
    await rich('change follow-up note', { kind: 'note', id: 'note_tag_suggest', label: 'note' },
      (p) => p.cameFrom && p.actions.includes('▶ Walk through the change') && ['Discuss with Keeper', 'Confirm', 'No action needed'].every((a) => p.actions.includes(a)) && !p.actions.includes('Investigate') && !p.actions.includes('Show on graph') && p.onButtons.includes('Show on graph') && p.openAll === 'Details',
      (f) => ['current-view', 'why-it-matters', 'facts', 'keep-or-adjust', 'what-would-settle-it'].every((s) => f.sections.includes(s)) && f.actions.includes('▶ Walk through the change'));
    await page(`button($('#dialog .full-details'), '▶ Walk through the change').click(); return true;`);
    await b.waitFor("document.querySelector('#dialog .walk-root')", { label: 'the walkthrough on top of the note' });
    check('change follow-up note: the walkthrough opens on top of the note, with a way back', await page(`return Boolean($$('.dialog-head button', $('#dialog')).find((x) => /Back/.test(x.textContent)));`));
    await closeDialog();
    await rich('note with an earlier version', { kind: 'note', id: 'note_reader_typography', label: 'note' },
      (p) => p.openAll === 'Details' && p.index.length === 0, (f) => f.sections.includes('earlier-versions'));
    await closeDialog();
    if (notesData.notes.some((n) => n.id === 'note_takeover-depth')) {
      await rich('the takeover-depth note', { kind: 'note', id: 'note_takeover-depth', label: 'note' },
        (p) => ['Full', 'Focused', 'First picture only'].every((d) => p.choice.some((c) => c.replace('✓ ', '') === d)),
        (f) => /Your choice/.test(f.text), '10-depth-note.png');
      await closeDialog();
    }
  }

  const errors = [...pageErrors, ...b.consoleLines].filter((l) => !/wheel sensitivity|font-family/.test(l));
  check('the page reported no error', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (e) {
  check('the check ran to the end', false, e.message);
  try { await b.shot(join(outDir, 'zz-where-it-stopped.png')); } catch { /* the page is gone */ }
} finally {
  await b.close();
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(outDir, 'measurements.json'), JSON.stringify({ at: new Date().toISOString(), base, project: projectId, viewport: '1280x800 (narrow: 390x844)', checks: results, numbers }, null, 2));
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
