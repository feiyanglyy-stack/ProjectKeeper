// How the project graph sits in its window, measured in a real browser (CKC-09 AC-39; Spec §6.3 "布局").
//
// usage: node scripts/graph-fit-check.mjs <fixture-home> <env-dir> <out-dir> [--port 4923] [--tag after] [--mode full|open]
//
// It starts the workbench itself on a seeded fixture home (scripts/seed-ui-fixture.ts in either
// size) and stops it again when it is done. The workbench gets an environment with nothing in it but the system's own
// variables: its user profile, its temp folder and the model library's agent directory all point into <env-dir>, so no
// key and no real home can reach it. Before anything is measured the Keeper has to say it is not connected; otherwise
// the run stops. Chrome's own files for the run go into <env-dir>/tmp and are removed at the end.
//
// Headless Chrome is driven through the DevTools protocol (Node's own WebSocket). `--mode full` (a project that fits,
// like the demo): 1280x800, 1000x700 and 1600x1000, then with the graph's container 440px narrower (a panel docked on
// the right), after the owner's own wheel zoom and drag, the wheel turned all the way out, through Focus path, Show
// affected, an object reached by its link, Compare, a click on an object and on a folder, and last a large made-up
// graph fed through the page's own `fetch`, so the real render, layout, fit and self-check run on it. `--mode open`
// (any project): how it opens at the three window sizes and over a range of container sizes, and, when it does not
// fit, that a drag moves the picture, that the owner's wheel goes below the floor down to the hard limit, that `Show
// all anyway` shows the whole picture and a change of size does not snap it back, and that the readability mark's panel
// leads to the List.
// Writes <out-dir>/<tag>-*.png and <out-dir>/<tag>-measurements.json, prints every expectation as PASS or FAIL, and
// exits with 1 when one does not hold.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fitMod from '../ui/graph-fit.js';   // the sums the page itself uses: the floor, the hard limit, the smallest text

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [home, envDir, outDir] = positional;
if (!home || !envDir || !outDir) { console.error('usage: node scripts/graph-fit-check.mjs <fixture-home> <env-dir> <out-dir> [--port 4923] [--tag after] [--mode full|open]'); process.exit(2); }
const port = Number(flag('--port', '4923'));
const tag = flag('--tag', 'after');
// `open`: only how the project opens, at the three window sizes and over a range of sizes of the graph's container (the
// band the graph gets grows and shrinks with the rest of the interface); `full`: everything described above.
const mode = flag('--mode', 'full');
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Chrome where each system usually has it; CHROME_PATH names another.
const CHROME = process.env.CHROME_PATH ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome');
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── What is expected (CKC-09 AC-39) ──────────────────────────────────────
// A view the graph chooses — opening, fitting again while the view is still its own, `Fit`, a scale, what a change
// touched — is never below the floor. The owner's own wheel goes below it, down to a hard limit that always leaves the
// whole picture within reach, and `Show all anyway` shows the whole picture; after either the view is the owner's until
// they press `Fit`. Every expectation is printed as PASS or FAIL; one FAIL makes the run exit with 1.
const checks = [];
const expect = (what, ok, got) => { checks.push({ what, ok: Boolean(ok), ...(got === undefined ? {} : { got }) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${got === undefined ? '' : `  ${JSON.stringify(got)}`}`); };
const FLOOR = fitMod.ZOOM_FLOOR;
const near = (a, b, eps = 0.002) => Math.abs(a - b) <= eps;
const sameView = (a, b) => near(a.zoom, b.zoom) && Math.abs(a.pan.x - b.pan.x) <= 2 && Math.abs(a.pan.y - b.pan.y) <= 2;
const view = (m) => ({ zoom: m.zoom, pan: m.pan });
/** A view the graph chose: at or above the floor, so names are at least the smallest body text. */
const chosenByGraph = (what, m) => expect(`${what}: not below the floor, names at least ${fitMod.MIN_TEXT_PX}px`, m.zoom >= FLOOR - 0.001 && m.nameOnScreen >= fitMod.MIN_TEXT_PX - 0.02, { zoom: m.zoom, name: m.nameOnScreen });
/** The mark is honest: "too big to read at once" is said exactly when the view the graph opened on does not hold the whole picture. */
const honestMark = (what, m) => expect(`${what}: "Too big to read at once" is said exactly when the whole picture is not in the window`, m.wholeBoxVisible === !/Too big to read at once/.test(m.selfCheck), { whole: m.wholeBoxVisible, mark: m.selfCheck.slice(0, 60) });
/** The owner's wheel, turned out as far as it goes: below the floor, at the hard limit, where the whole picture fits the window. */
const wheeledOut = (what, m) => {
  const limit = fitMod.hardMinZoom?.(m.picture, { w: m.container[0], h: m.container[1] }, m.padTop ? { padTop: m.padTop } : {});
  expect(`${what}: the owner's wheel goes below the floor`, m.zoom < FLOOR - 0.001, { zoom: m.zoom, floor: FLOOR });
  expect(`${what}: and stops at the hard limit — ${fitMod.ZOOM_HARD_MIN}, or less when the whole picture needs less`, limit !== undefined && near(m.zoom, m.minZoom) && near(m.minZoom, limit), { zoom: m.zoom, minZoom: m.minZoom, limit });
  expect(`${what}: at that zoom the whole picture fits the window`, m.box.w * m.zoom <= m.container[0] && m.box.h * m.zoom <= m.container[1], { picture: [Math.round(m.box.w * m.zoom), Math.round(m.box.h * m.zoom)], window: m.container });
};
for (const d of [outDir, join(envDir, 'userprofile'), join(envDir, 'pi-agent'), join(envDir, 'tmp')]) mkdirSync(d, { recursive: true });

// Nothing of the caller's environment reaches the workbench except what Windows and Node need to run at all.
const profile = join(envDir, 'userprofile');
const cleanEnv = {
  PATH: process.env.PATH ?? process.env.Path ?? '', SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', windir: process.env.windir ?? 'C:\\Windows',
  USERPROFILE: profile, HOME: profile, APPDATA: join(profile, 'AppData', 'Roaming'), LOCALAPPDATA: join(profile, 'AppData', 'Local'),
  TEMP: join(envDir, 'tmp'), TMP: join(envDir, 'tmp'), PI_CODING_AGENT_DIR: join(envDir, 'pi-agent'),
};

// ── What is read off the page ────────────────────────────────────────────
// The box of the objects as laid out, whether it lies inside what the window shows, the zoom and its floor, and the size
// on screen of the words drawn on the objects (the pictures are SVG, so their font sizes are read from the pictures).
const MEASURE = `(() => {
  const el = document.querySelector('#cy');
  const cy = el && el._cyreg && el._cyreg.cy;
  if (!cy) return { error: 'no graph on the page' };
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  let markTop = Infinity, countRight = -Infinity;   // with what stands out of objects: corner marks above, link counts to the right
  const nameSizes = [], allSizes = [];
  cy.nodes().forEach((n) => {
    const p = n.position(), w = n.data('w'), h = n.data('h');
    x1 = Math.min(x1, p.x - w / 2); x2 = Math.max(x2, p.x + w / 2); y1 = Math.min(y1, p.y - h / 2); y2 = Math.max(y2, p.y + h / 2);
    markTop = Math.min(markTop, p.y - h / 2 - (n.data('overTop') ?? 0)); countRight = Math.max(countRight, p.x + w / 2 + (n.data('overRight') ?? 0));
    const imgs = n.data('imgs') ?? (n.data('img') ? [n.data('img')] : []);   // the words are the first picture; a theme's material is a second one with no text
    const img = imgs[0]; if (!img) return;
    const svg = decodeURIComponent(img.slice(img.indexOf(',') + 1));
    // A name stands under the line of kind and progress: 30px or more from the object's top, before this batch and
    // after it. \`No established link\` and the link count beside the object (↗n) stand that low too and are not
    // names; groups and folders carry no name.
    const re = /<text x="[^"]*" y="([\\d.-]+)"[^>]*font-size="([\\d.]+)"[^>]*>([^<]*)<\\/text>/g;
    let m;
    while ((m = re.exec(svg))) {
      const y = Number(m[1]), size = Number(m[2]);
      allSizes.push(size);
      // Small print is not a name (the kind line, No established link, the ↗ link count, and the process view's
      // folded line, marked data-print="small" — graph-fit.js sanctions it at MIN_LABEL_PX, names at MIN_TEXT_PX).
      if (!n.data('kind') && y >= 30 && m[3] !== 'No established link' && !m[3].startsWith('↗') && !m[0].includes('data-print="small"')) nameSizes.push(size);
    }
  });
  const ext = cy.extent(), zoom = cy.zoom(), pan = cy.pan();
  // One Observed reality folder stands at the foot of every column: a column is in view across when its folder is.
  const folders = cy.nodes().filter((n) => n.data('kind') === 'folder');
  const columnsInView = folders.filter((n) => { const p = n.position(), w = n.data('w'); return p.x - w / 2 >= ext.x1 && p.x + w / 2 <= ext.x2; }).length;
  const round = (v) => Math.round(v * 1000) / 1000;
  // What the self-check says is on the readability mark in the control row: its number, and in its hover the kinds.
  const mark = document.querySelector('.read-mark');
  return {
    window: [innerWidth, innerHeight], container: [el.clientWidth, el.clientHeight],
    zoom: round(zoom), minZoom: round(cy.minZoom()), pan: { x: Math.round(pan.x), y: Math.round(pan.y) },
    columns: folders.length, columnsInView,
    picture: { x1, y1: markTop, x2: countRight, y2 },
    nodes: cy.nodes().length, box: { x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2), w: Math.round(x2 - x1), h: Math.round(y2 - y1) },
    boxOnScreen: { left: Math.round(x1 * zoom + pan.x), top: Math.round(y1 * zoom + pan.y), right: Math.round(x2 * zoom + pan.x), bottom: Math.round(y2 * zoom + pan.y) },
    wholeBoxVisible: x1 >= ext.x1 && y1 >= ext.y1 && x2 <= ext.x2 && y2 <= ext.y2,
    nameFont: nameSizes.length ? Math.min(...nameSizes) : null, nameOnScreen: nameSizes.length ? round(Math.min(...nameSizes) * zoom) : null,
    smallestFont: allSizes.length ? Math.min(...allSizes) : null, smallestOnScreen: allSizes.length ? round(Math.min(...allSizes) * zoom) : null,
    selfCheck: !mark ? 'no readability mark on the page' : Number(mark.dataset.count) > 0 ? (mark.textContent + ' — ' + mark.title).replace(/\\s+/g, ' ').trim().slice(0, 600) : 'nothing to report (the mark says 0)',
    // The band the page keeps clear under the graph's floating buttons; the sums below take it off as the page does.
    padTop: Number(el.dataset.fitPadTop) || 0,
  };
})()`;
// A point of the graph's window with no object under it and none near, to drag the picture by.
const EMPTY_POINT = `(() => {
  const el = document.querySelector('#cy'), cy = el._cyreg.cy, r = el.getBoundingClientRect();
  const boxes = cy.nodes().map((n) => n.renderedBoundingBox());
  for (let fy = 0.5; fy < 0.98; fy += 0.04) for (let fx = 0.5; fx < 0.98; fx += 0.04) {
    const x = r.width * fx, y = r.height * fy;
    if (!boxes.some((b) => x > b.x1 - 12 && x < b.x2 + 12 && y > b.y1 - 12 && y < b.y2 + 12)) return { x: Math.round(r.left + x), y: Math.round(r.top + y) };
  }
  return null;
})()`;
// The object nearest the middle of the graph's window: where on screen it is, and where in the picture.
const OBJECT_NEAR_CENTRE = `(() => {
  const el = document.querySelector('#cy'), cy = el._cyreg.cy, r = el.getBoundingClientRect();
  let best = null, bestD = Infinity;
  cy.nodes().forEach((n) => { const p = n.renderedPosition(), d = Math.hypot(p.x - r.width / 2, p.y - r.height / 2); if (d < bestD) { bestD = d; best = n; } });
  const p = best.renderedPosition(), m = best.position();
  return { id: best.id(), x: Math.round(r.left + p.x), y: Math.round(r.top + p.y), model: { x: m.x, y: m.y } };
})()`;
// Click the last work item of the rail's outline, as the owner would, and say where the graph put it.
const PICK_LAST_WORK = `(async () => {
  const rows = [...document.querySelectorAll('.outline .ol-work')];
  const row = rows[rows.length - 1];
  if (!row) return { error: 'the outline lists no work' };
  row.click();
  await new Promise((r) => setTimeout(r, 1200));
  const el = document.querySelector('#cy'), cy = el._cyreg.cy, sel = cy.$('node:selected');
  if (!sel.length) return { error: 'nothing is selected on the graph', row: row.textContent };
  const p = sel.renderedPosition(), w = sel.data('w') * cy.zoom(), h = sel.data('h') * cy.zoom();
  return { label: row.textContent, zoom: Math.round(cy.zoom() * 1000) / 1000, onScreen: p.x - w / 2 >= 0 && p.y - h / 2 >= 0 && p.x + w / 2 <= el.clientWidth && p.y + h / 2 <= el.clientHeight };
})()`;
// Whether the List has taken the graph's place, waiting up to five seconds for it (it is drawn after two requests);
// otherwise what the page said instead.
const LIST_SHOWN = `(async () => {
  for (let i = 0; i < 50; i++) { if (document.querySelector('.list-wrap')) return true; await new Promise((r) => setTimeout(r, 100)); }
  return { shown: false, toast: document.querySelector('#toast')?.textContent ?? '', main: (document.querySelector('main')?.className ?? '') + ' | ' + [...(document.querySelector('main')?.children ?? [])].map((c) => c.className).join(', ') };
})()`;
const CY_CENTRE = `(() => { const r = document.querySelector('#cy').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`;

// ── A large project, made up ─────────────────────────────────────────────
// Runs in the page before its own scripts: with `?synthetic=big` in the address, the graph the page asks the workbench
// for is replaced by one of 14 areas and 150 pieces of work, shaped like the real answer. Names are invented.
function syntheticBig() {
  if (!location.search.includes('synthetic=big')) return;
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const old = '2026-01-05T09:00:00.000Z';
  const node = (id, category, label, extra = {}) => ({ id, projectId: 'synthetic', category, label, refKind: 'reference', refId: id, validity: 'Current', progress: null, basis: 'Explicit', attribution: null, sourceIds: [], areaId: null, parentWorkId: null, replacedBy: null, createdAt: old, updatedAt: old, noteCount: 0, noteAsk: null, marks: [], updatePending: false, noEstablishedLink: false, group: null, recentChange: false, changedAt: null, parentId: null, summary: null, ...extra });
  const AREAS = ['Accounts and sign-in', 'Billing', 'Catalogue', 'Checkout', 'Delivery tracking', 'Email and notices', 'Imports and exports', 'Inventory', 'Mobile shell', 'Order history', 'Reports', 'Search and filters', 'Settings and roles', '订单对账与退款'];
  const WORK = ['Rework the list so it pages from the server', 'Validate the file before anything is written', 'Show what changed since the last visit', 'Retry with backoff and say why it failed', '导入设置并校验格式', 'Keep the draft when the window closes', 'One screen for roles, with who granted them', 'Move the totals into the header row', 'Rate limits per key, shown to the owner', '把重复的记录合并成一条并保留来源'];
  const nodes = [node('p', 'Product', 'Storefront operations console')], relations = [];
  const rel = (from, to, type, basis = 'Explicit') => relations.push({ id: `r${relations.length}`, projectId: 'synthetic', type, from, to, claim: '', basis, evidence: { sourceIds: [], factRecordIds: [], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: old, noteCount: 0 });
  ['Orders never get lost between systems', 'A new shop is selling within a day', 'Support answers from one screen'].forEach((g, i) => { nodes.push(node(`g${i}`, 'Goal', g)); rel(`g${i}`, 'p', 'refines'); });
  AREAS.forEach((a, i) => { nodes.push(node(`a${i}`, 'Area', a)); rel(`a${i}`, `g${i % 3}`, 'refines'); });
  const PROGRESS = ['In progress', 'Planned', 'Planned', 'Done', 'Done', 'On hold'];
  for (let i = 0; i < 150; i++) {
    const projectWide = i % 13 === 0, area = projectWide ? null : `a${Math.floor(rnd() * AREAS.length)}`;
    const plan = i % 15 === 1, progress = PROGRESS[Math.floor(rnd() * PROGRESS.length)];
    const id = `w${i}`, label = `${plan ? 'PL' : 'WI'}-${String(i + 1).padStart(3, '0')} · ${WORK[i % WORK.length]}`;
    // Done work nothing recent touches is folded into Existing foundation by the workbench; the same here.
    nodes.push(node(id, plan ? 'Plan' : 'Work item', label, { refKind: 'thread', progress, acceptance: progress === 'Done' ? (i % 2 ? 'Accepted' : 'Not yet accepted') : '', areaId: area, parentId: area, group: !plan && progress === 'Done' && i % 3 ? 'Existing foundation' : null, noteCount: i % 17 === 0 ? 1 : 0, noteAsk: i % 34 === 0 ? 'For your decision' : null, marks: i % 23 === 0 ? [{ kind: 'Suspected stale', clue: '' }] : [], updatePending: i % 29 === 0, basis: i % 11 === 0 ? 'Inferred' : 'Explicit' }));
    if (area) rel(id, area, 'serves', i % 11 === 0 ? 'Inferred' : 'Explicit'); else if (plan) rel(id, 'p', 'serves');
    if (i % 7 === 3 && i > 10) rel(id, `w${i - 9}`, 'depends on');
    if (i % 4 === 0) { nodes.push(node(`res${i}`, i % 8 ? 'Result' : 'Test', `Run ${i + 1}: outcome recorded`, { refKind: 'fact', parentId: id, parentWorkId: id, areaId: area })); rel(id, `res${i}`, 'produced'); }
  }
  const big = { nodes, relations, marks: [], recentChangeIds: [], changes: [], categories: [...new Set(nodes.map((n) => n.category))], relationTypes: [...new Set(relations.map((r) => r.type))], markKinds: [], counts: { existingFoundation: nodes.filter((n) => n.group === 'Existing foundation').length, unplaced: 0, replacedOrDeferred: 0 } };
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => (/\/api\/projects\/[^/]+\/graph$/.test(typeof input === 'string' ? input : input.url)
    ? Promise.resolve(new Response(JSON.stringify(big), { status: 200, headers: { 'content-type': 'application/json' } }))
    : real(input, init));
}

// ── Run ──────────────────────────────────────────────────────────────────
const server = spawn(process.execPath, ['src/cli.ts', 'serve', '--home', home, '--port', String(port)], { cwd: appRoot, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
let chrome = null;
let chromeProfile = null;   // Chrome's own files for this run; removed at the end
const results = { tag, at: new Date().toISOString(), home, port };
let failed = false;
try {
  let workspace = null;
  for (let i = 0; i < 80 && !workspace; i++) { try { workspace = await (await fetch(`${base}/api/workspace`)).json(); } catch { await sleep(250); } }
  if (!workspace) throw new Error(`the workbench did not start:\n${serverLog}`);
  if (resolve(workspace.home) !== resolve(home)) throw new Error(`the workbench on port ${port} serves ${workspace.home}, not the fixture home`);
  const project = workspace.projects?.[0];
  if (!project) throw new Error('the fixture home holds no project; seed it first with scripts/seed-ui-fixture.ts');
  const activity = await (await fetch(`${base}/api/projects/${project.id}/activity`)).json();
  if (activity.connected !== false) throw new Error('the Keeper reports a connected model; this check only runs with nothing connected');
  results.project = project.id; results.keeper = 'Not connected';

  const debugPort = 9300 + Math.floor(Math.random() * 500);
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${chromeProfile = mkdtempSync(join(envDir, 'tmp', 'chrome-'))}`, '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 60 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === 'page'); } catch { await sleep(200); } }
  if (!target) throw new Error('Chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const waiting = new Map();
  const pageErrors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
    else if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
    else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') pageErrors.push(d.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, `${tag}-${name}.png`), Buffer.from(s.result.data, 'base64')); console.log(`saved ${join(outDir, `${tag}-${name}.png`)}`); };
  // The graph's own area at twice the size, to look at the words, the marks and the link counts closely.
  const detail = async (name) => {
    const r = await evaluate(`(() => { const b = document.querySelector('#cy').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
    const s = await send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 2 } });
    writeFileSync(join(outDir, `${tag}-${name}.png`), Buffer.from(s.result.data, 'base64')); console.log(`saved ${join(outDir, `${tag}-${name}.png`)}`);
  };
  const open = async (width, height, query = '') => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'about:blank' });
    await send('Page.navigate', { url: `${base}/${query}#/p/${encodeURIComponent(project.id)}/graph` });
    for (let i = 0; i < 60; i++) { if (await evaluate(`Boolean(document.querySelector('#cy')?._cyreg?.cy?.nodes().length)`).catch(() => false)) break; await sleep(250); }
    await sleep(1200);
  };
  const wheel = async (at, deltaY, times) => { for (let i = 0; i < times; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY }); await sleep(120); } await sleep(400); };
  // Turn the wheel out until the zoom stops changing. (cytoscape sizes its step from the first deltas it sees, a few per
  // cent a tick, so "all the way" is a matter of turning long enough, not of a number of ticks.)
  const wheelOutFully = async (at) => {
    const zoomNow = () => evaluate(`document.querySelector('#cy')._cyreg.cy.zoom()`);
    let last = await zoomNow();
    for (let round = 0; round < 60; round++) {
      for (let i = 0; i < 10; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: 400 }); await sleep(25); }
      await sleep(150);
      const z = await zoomNow();
      if (Math.abs(z - last) < 1e-9) break;
      last = z;
    }
    await sleep(400);
  };
  const drag = async (from, dx, dy) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 8; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (dx * i) / 8, y: from.y + (dy * i) / 8, button: 'left', buttons: 1 }); await sleep(30); }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x + dx, y: from.y + dy, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(400);
  };
  const narrow = (px) => evaluate(`(() => { document.querySelector('.graph-wrap').style.marginRight = '${px}px'; })()`);
  /** Press a button of the control row, or of the group floating on the graph's corner, by its label, as the owner would. */
  const press = (label) => evaluate(`(() => { const b = [...document.querySelectorAll('.graph-tools button, .graph-float button')].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
  /** Open the panel behind the readability mark and press one of the buttons under "Too big to read at once"; says which buttons are there. */
  const pressInBar = (label) => evaluate(`(async () => {
    const mark = document.querySelector('.read-mark'); if (!mark || !(Number(mark.dataset.count) > 0)) return { error: 'the readability mark reports nothing' };
    if (mark.getAttribute('aria-expanded') !== 'true') { mark.click(); await new Promise((r) => setTimeout(r, 600)); }
    const issue = [...document.querySelectorAll('.read-panel .read-issue')].find((e) => /windows/.test(e.textContent));
    const buttons = [...(issue?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    const b = [...(issue?.querySelectorAll('button') ?? [])].find((x) => x.textContent === ${JSON.stringify(label)});
    b?.click();
    return { buttons, hint: issue?.querySelector('small')?.textContent ?? '', pressed: Boolean(b) };
  })()`);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${syntheticBig.toString()})()` });
  // PK_THEME=a1 runs the check with that theme in force (the same switch scripts/ui-cdp.mjs gives the other checks).
  if (process.env.PK_THEME !== undefined) await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('pk.theme', ${JSON.stringify(process.env.PK_THEME === 'factory' ? '' : process.env.PK_THEME)}); } catch {}` });

  // 1. Opening the project's Overview at three window sizes.
  results.open = {};
  for (const [w, h] of [[1280, 800], [1000, 700], [1600, 1000]]) {
    await open(w, h);
    const m = results.open[`${w}x${h}`] = await evaluate(MEASURE);
    chosenByGraph(`opening at ${w}x${h}`, m);
    honestMark(`opening at ${w}x${h}`, m);
    await shot(`open-${w}x${h}`);
    if (w === 1280) await detail('open-1280x800-detail');
  }
  const opened = results.open['1280x800'];

  if (mode === 'open') {
    // The band the graph gets, over a range. Today's short one at 1280x800 is measured above; a taller window stands in
    // for the band once the toolbar and the bottom strip have been made smaller, and 440px of margin for a docked panel.
    results.containers = {};
    for (const [w, h, dock] of [[1280, 1050, 0], [1280, 1050, 440], [1280, 800, 440]]) {
      await open(w, h);
      if (dock) { await narrow(dock); await sleep(900); }
      const m = await evaluate(MEASURE);
      results.containers[`${m.container[0]}x${m.container[1]}`] = m;
      chosenByGraph(`opening with the graph at ${m.container[0]}x${m.container[1]}`, m);
      await shot(`container-${m.container[0]}x${m.container[1]}`);
      if (!dock) await detail(`container-${m.container[0]}x${m.container[1]}-detail`);
    }
    // A project that does not fit at 1280x800.
    if (!opened.wholeBoxVisible) {
      // A drag that starts on an object moves the picture and not the object; a panel docking afterwards leaves the
      // owner's view alone.
      await open(1280, 800);
      const held = await evaluate(OBJECT_NEAR_CENTRE);
      await drag(held, -300, -120);
      const dragged = results.floorDragged = { ...(await evaluate(MEASURE)), dragStartedOn: held.id, objectMovedInPicture: await evaluate(`(() => { const p = document.querySelector('#cy')._cyreg.cy.getElementById(${JSON.stringify(held.id)}).position(); return Math.round(p.x) !== ${Math.round(held.model.x)} || Math.round(p.y) !== ${Math.round(held.model.y)}; })()`) };
      expect('a drag begun on an object moves the picture by the drag, and the object keeps its place in it', Math.abs(dragged.pan.x - (opened.pan.x - 300)) <= 2 && Math.abs(dragged.pan.y - (opened.pan.y - 120)) <= 2 && dragged.objectMovedInPicture === false, { before: opened.pan, after: dragged.pan, objectMoved: dragged.objectMovedInPicture });
      await shot('floor-dragged-1280x800');
      await narrow(440); await sleep(900);
      results.floorDraggedDocked = await evaluate(MEASURE);
      expect('a panel docking after the owner dragged leaves their view alone', sameView(results.floorDraggedDocked, dragged), { before: view(dragged), after: view(results.floorDraggedDocked) });
      await narrow(0); await sleep(900);

      // The owner's own wheel goes below the floor, as far as the whole picture needs; the view is then theirs, and
      // `Fit` gives it back to the graph.
      await wheelOutFully(await evaluate(CY_CENTRE));
      results.ownWheelOut = await evaluate(MEASURE);
      wheeledOut('wheel turned all the way out', results.ownWheelOut);
      await shot('wheel-out-1280x800');
      await narrow(440); await sleep(900);
      results.ownWheelOutDocked = await evaluate(MEASURE);
      expect('a panel docking after the owner zoomed out does not snap the zoom back', near(results.ownWheelOutDocked.zoom, results.ownWheelOut.zoom), { before: results.ownWheelOut.zoom, after: results.ownWheelOutDocked.zoom });
      await narrow(0); await sleep(900);
      await press('Fit'); await sleep(700);
      results.ownWheelOutThenFit = await evaluate(MEASURE);
      expect('`Fit` gives the view back to the graph: the readable view it opened on', sameView(results.ownWheelOutThenFit, opened), { opened: view(opened), now: view(results.ownWheelOutThenFit) });

      // `Show all anyway`, from the readability mark's panel: the whole picture whatever the size of its words. The view is then
      // the owner's — a change of size does not snap it back — until they press `Fit`.
      await open(1280, 800);
      results.showAll = { bar: await pressInBar('Show all anyway') };
      await sleep(900);
      results.showAll = { ...results.showAll, ...(await evaluate(MEASURE)) };
      expect('the readability panel offers `Show all anyway` beside `Open List`', results.showAll.bar.pressed && results.showAll.bar.buttons?.includes('Open List'), results.showAll.bar);
      expect('`Show all anyway` shows the whole picture, below the floor', results.showAll.wholeBoxVisible === true && results.showAll.zoom < FLOOR - 0.001 && results.showAll.zoom >= results.showAll.minZoom - 0.001, { zoom: results.showAll.zoom, whole: results.showAll.wholeBoxVisible, minZoom: results.showAll.minZoom });
      expect('the mark still says "Too big to read at once": it is judged on the view the graph would choose, not on the owner\'s', /Too big to read at once/.test(results.showAll.selfCheck), results.showAll.selfCheck.slice(0, 60));
      await shot('show-all-1280x800');
      await narrow(440); await sleep(900);
      results.showAllDocked = await evaluate(MEASURE);
      expect('a change of size after `Show all anyway` does not snap the view back', sameView(results.showAllDocked, results.showAll), { before: view(results.showAll), after: view(results.showAllDocked) });
      await narrow(0); await sleep(900);
      await press('Fit'); await sleep(700);
      results.showAllThenFit = await evaluate(MEASURE);
      expect('`Fit` after `Show all anyway` brings back the readable fit, at the floor', near(results.showAllThenFit.zoom, FLOOR) && results.showAllThenFit.nameOnScreen >= fitMod.MIN_TEXT_PX - 0.02, view(results.showAllThenFit));
      await narrow(440); await sleep(900);
      results.showAllThenFitDocked = await evaluate(MEASURE);
      chosenByGraph('and the view follows the window again', results.showAllThenFitDocked);

      // The self-check's other way out: the List, from the panel itself. (Here, on a real project: the made-up one of the
      // full run carries a graph only, not what the List is drawn from.)
      await open(1280, 800);
      results.remedy = await pressInBar('Open List');
      results.remedy.listShown = await evaluate(LIST_SHOWN);
      expect('`Open List` in the readability panel opens the List', results.remedy.listShown === true, results.remedy);
    }
    results.pageErrors = pageErrors;
    expect('the page reported no error', pageErrors.length === 0, pageErrors.slice(0, 3));
    ws.close();
    throw { done: true };
  }

  // 2. A panel docked on the right takes 440px of the graph's container: untouched, the picture is fitted again; and
  //    fitted once more when the panel goes away.
  // A project that fits the window (the demo) shows whole and reports nothing; one that does not (the UI fixture, 8 columns)
  // opens at the floor with its first column at the left edge and says so. Which it is, is read off the picture.
  expect(opened.wholeBoxVisible
    ? 'the project fits at 1280x800: the whole picture is in the window and nothing is reported'
    : 'the project does not fit at 1280x800: it opens at the floor, on its top left, and the mark says "Too big to read at once"',
  opened.wholeBoxVisible ? /nothing to report/.test(opened.selfCheck) : near(opened.zoom, FLOOR) && Math.abs(opened.boxOnScreen.left - fitMod.FIT_PAD) <= 2 && /Too big to read at once/.test(opened.selfCheck),
  { whole: opened.wholeBoxVisible, zoom: opened.zoom, left: opened.boxOnScreen.left, mark: opened.selfCheck.slice(0, 60) });
  await open(1280, 800);
  await narrow(440); await sleep(900);
  results.docked = await evaluate(MEASURE);
  chosenByGraph('a panel docked beside the untouched graph', results.docked);
  expect('docking fits the picture again for the narrower window', !sameView(results.docked, opened), { opened: view(opened), docked: view(results.docked) });
  await shot('docked-440-1280x800');
  await narrow(0); await sleep(900);
  results.undocked = await evaluate(MEASURE);
  expect('and once more when the panel goes away: the view it opened on', sameView(results.undocked, opened), { opened: view(opened), undocked: view(results.undocked) });

  // 3. After the owner's own wheel zoom and drag, a change of size leaves their view alone.
  const centre = await evaluate(CY_CENTRE);
  await wheel(centre, -240, 3);
  const empty = await evaluate(EMPTY_POINT);
  if (empty) await drag(empty, -60, -40);
  results.ownView = await evaluate(MEASURE);
  await narrow(440); await sleep(900);
  results.ownViewDocked = await evaluate(MEASURE);
  expect('after the owner zoomed in and dragged, a panel docking leaves their view alone', sameView(results.ownViewDocked, results.ownView) && !sameView(results.ownView, opened), { own: view(results.ownView), docked: view(results.ownViewDocked) });
  await narrow(0); await sleep(600);
  // … and Fit hands the view back to the graph.
  await press('Fit'); await sleep(600);
  results.afterFit = await evaluate(MEASURE);
  expect('`Fit` gives the view back to the graph: the view it opened on', sameView(results.afterFit, opened), { opened: view(opened), now: view(results.afterFit) });
  // The owner's own wheel goes below the floor, down to the hard limit; the view is then theirs until `Fit`.
  await wheelOutFully(centre);
  results.wheelOut = await evaluate(MEASURE);
  wheeledOut('the demo, wheel turned all the way out', results.wheelOut);
  await narrow(440); await sleep(900);
  results.wheelOutDocked = await evaluate(MEASURE);
  expect('a panel docking after the owner zoomed out does not snap the zoom back', near(results.wheelOutDocked.zoom, results.wheelOut.zoom), { before: results.wheelOut.zoom, after: results.wheelOutDocked.zoom });
  await narrow(0); await sleep(900);
  await press('Fit'); await sleep(600);
  results.wheelOutThenFit = await evaluate(MEASURE);
  expect('`Fit` after zooming out brings back the view it opened on', sameView(results.wheelOutThenFit, opened), { opened: view(opened), now: view(results.wheelOutThenFit) });

  // 4. Selecting an object from the outline (which opens its details beside the graph): the whole picture stays in view.
  await open(1280, 800);
  results.select = { picked: await evaluate(PICK_LAST_WORK), ...(await evaluate(MEASURE)) };
  chosenByGraph('an object selected from the outline', results.select);
  expect('the selected object is on screen', results.select.picked?.onScreen === true, results.select.picked);
  await shot('selected-1280x800');

  // 4b. The other ways a view is chosen for the owner: Focus path (the Work scale), a change's affected objects, an
  //     object arrived at by its link (as search does), and Compare. None may go below the floor or lose the picture.
  const scaleNow = `document.querySelector('.graph-tools .segmented button.active')?.textContent`;
  results.focusPath = { pressed: await press('Focus path') };
  await sleep(900);
  results.focusPath = { ...results.focusPath, scale: await evaluate(scaleNow), faded: await evaluate(`document.querySelector('#cy')._cyreg.cy.nodes('.faded').length`), ...(await evaluate(MEASURE)) };
  chosenByGraph('Focus path (the Work scale)', results.focusPath);
  expect('Focus path switches to the Work scale and fades what is off the path', results.focusPath.scale === 'Work' && results.focusPath.faded > 0, { scale: results.focusPath.scale, faded: results.focusPath.faded });
  await shot('work-scale-1280x800');
  results.clearFocus = { pressed: await press('Clear focus') };
  await sleep(900);
  results.clearFocus = { ...results.clearFocus, scale: await evaluate(scaleNow), ...(await evaluate(MEASURE)) };
  chosenByGraph('Clear focus (back to Overview)', results.clearFocus);
  const graphData = await (await fetch(`${base}/api/projects/${project.id}/graph`)).json();
  // A change whose affected objects are drawn on the Overview: an area, a plan or a work item that is current and not folded
  // into a group. (Decisions and requirements sit folded under their area; results under their work item.)
  const drawnById = new Map(graphData.nodes.filter((n) => ['Area', 'Work item', 'Plan', 'Goal', 'Product'].includes(n.category) && n.validity === 'Current' && !n.group).map((n) => [n.id, n]));
  const change = graphData.changes.find((c) => c.affects?.some((id) => drawnById.has(id)));
  if (change) {
    await send('Page.navigate', { url: 'about:blank' });
    await send('Page.navigate', { url: `${base}/#/p/${encodeURIComponent(project.id)}/graph/change/${encodeURIComponent(change.id)}` });
    for (let i = 0; i < 60; i++) { if (await evaluate(`Boolean(document.querySelector('#cy')?._cyreg?.cy?.nodes('.hit').length)`).catch(() => false)) break; await sleep(250); }
    await sleep(800);
    results.showAffected = { affects: change.affects.length, marked: await evaluate(`document.querySelector('#cy')._cyreg.cy.nodes('.hit').length`), markedOnScreen: await evaluate(`(() => { const el = document.querySelector('#cy'), cy = el._cyreg.cy; return cy.nodes('.hit').filter((n) => { const p = n.renderedPosition(); return p.x > 0 && p.y > 0 && p.x < el.clientWidth && p.y < el.clientHeight; }).length; })()`), ...(await evaluate(MEASURE)) };
    chosenByGraph('Show affected', results.showAffected);
    // Show affected now opens folds first, so a change can mark objects that were not drawn. The zoom stays at or
    // above the floor: when those objects are too far apart to fit there, the middle of them is on screen.
    const atFloor = results.showAffected.zoom <= Math.round((11 / 14) * 1000) / 1000 + 0.002;
    expect('what the change touched is marked and on screen', results.showAffected.marked > 0 && results.showAffected.markedOnScreen > 0 && (results.showAffected.markedOnScreen === results.showAffected.marked || atFloor), { marked: results.showAffected.marked, onScreen: results.showAffected.markedOnScreen, zoom: results.showAffected.zoom });
    await shot('show-affected-1280x800');
  }
  const someWork = graphData.nodes.find((n) => n.category === 'Work item' && n.validity === 'Current' && !n.group);
  if (someWork) {
    await send('Page.navigate', { url: 'about:blank' });
    await send('Page.navigate', { url: `${base}/#/p/${encodeURIComponent(project.id)}/graph/sel/node/${encodeURIComponent(someWork.id)}` });
    for (let i = 0; i < 60; i++) { if (await evaluate(`Boolean(document.querySelector('#cy')?._cyreg?.cy?.$('node:selected').length)`).catch(() => false)) break; await sleep(250); }
    await sleep(800);
    results.arriveByLink = { object: someWork.label, selectedOnScreen: await evaluate(`(() => { const el = document.querySelector('#cy'), cy = el._cyreg.cy, s = cy.$('node:selected'); if (!s.length) return null; const p = s.renderedPosition(); return p.x > 0 && p.y > 0 && p.x < el.clientWidth && p.y < el.clientHeight; })()`), ...(await evaluate(MEASURE)) };
    chosenByGraph('an object arrived at by its link', results.arriveByLink);
    expect('the object arrived at is selected and on screen', results.arriveByLink.selectedOnScreen === true, results.arriveByLink.selectedOnScreen);
  }
  await open(1280, 800);
  await evaluate(`(() => { [...document.querySelectorAll('.graph-tools .segmented button')].find((b) => b.textContent === 'Compare')?.click(); })()`);
  await sleep(2500);
  results.compare = { bar: await evaluate(`(document.querySelector('.compare-bar')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)`), ...(await evaluate(MEASURE)) };
  chosenByGraph('the Compare scale', results.compare);
  await shot('compare-1280x800');

  // 4c. Objects pan the picture when dragged, so a plain click has to go on doing what it did: pointing at an object
  //     shows its tooltip, a click selects it, and a click on a folder opens the same cell in the List (AC-30).
  await open(1280, 800);
  // The object is brought into the window first when it is not in it (a folder stands at the foot of a picture that may be
  // taller than the window): the owner would drag to it before clicking.
  const at = (pick) => evaluate(`(() => { const el = document.querySelector('#cy'), cy = el._cyreg.cy, r = el.getBoundingClientRect(); const n = cy.nodes().filter(${pick}).first(); if (!n.length) return null; let p = n.renderedPosition(); if (p.x < 20 || p.y < 20 || p.x > el.clientWidth - 20 || p.y > el.clientHeight - 20) { cy.center(n); p = n.renderedPosition(); } return { id: n.id(), x: Math.round(r.left + p.x), y: Math.round(r.top + p.y) }; })()`);
  const click = async (p) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }); await sleep(900); };
  const work = await at(`(n) => n.data('category') === 'Work item'`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: work.x, y: work.y });
  await sleep(500);
  results.pointAndClick = { tooltip: await evaluate(`(() => { const t = document.querySelector('.graph-tip'); return t && !t.hidden ? t.textContent.slice(0, 80) : null; })()`) };
  await click(work);
  results.pointAndClick.selected = await evaluate(`document.querySelector('#cy')._cyreg.cy.$('node:selected').map((n) => n.id())`);
  results.pointAndClick.clickedObject = work.id;
  // In a freshly opened view: the selection above opened the details beside the graph, and the row of folders may then
  // be below the window's foot.
  await open(1280, 800);
  const folder = await at(`(n) => n.data('kind') === 'folder' && n.data('total') > 0`);
  if (folder) { await click(folder); results.pointAndClick.folderOpensList = await evaluate(LIST_SHOWN); }
  expect('pointing at an object shows its tooltip, and a click selects it', Boolean(results.pointAndClick.tooltip) && results.pointAndClick.selected?.length === 1 && results.pointAndClick.selected[0] === work.id, results.pointAndClick);
  expect('a click on an Observed reality folder opens the List', results.pointAndClick.folderOpensList === true, results.pointAndClick.folderOpensList);
  await evaluate(`(() => { [...document.querySelectorAll('.segmented button')].find((b) => b.textContent === 'Graph')?.click(); })()`);
  await sleep(800);

  // 5. The large synthetic project.
  await open(1280, 800, '?synthetic=big');
  const big = results.big = await evaluate(MEASURE);
  chosenByGraph('a project of 14 areas and 150 pieces of work', big);
  honestMark('the large project', big);
  expect('it stops at the floor and starts at its top left: the first column at the window\'s left edge', near(big.zoom, FLOOR) && big.wholeBoxVisible === false && Math.abs(big.boxOnScreen.left - fitMod.FIT_PAD) <= 2, { zoom: big.zoom, left: big.boxOnScreen.left });
  await shot('big-1280x800');
  await detail('big-1280x800-detail');
  // At the floor a large project leaves hardly any background to drag by, so the drag starts on an object, as the
  // owner's would: the picture moves by the drag, the object keeps its place in it.
  const held = await evaluate(OBJECT_NEAR_CENTRE);
  await drag(held, -300, -160);
  const dragged = results.bigDragged = { ...(await evaluate(MEASURE)), dragStartedOn: held.id, objectMovedInPicture: await evaluate(`(() => { const p = document.querySelector('#cy')._cyreg.cy.getElementById(${JSON.stringify(held.id)}).position(); return Math.round(p.x) !== ${Math.round(held.model.x)} || Math.round(p.y) !== ${Math.round(held.model.y)}; })()`) };
  expect('a drag begun on an object moves the picture by the drag, and the object keeps its place in it', Math.abs(dragged.pan.x - (big.pan.x - 300)) <= 2 && Math.abs(dragged.pan.y - (big.pan.y - 160)) <= 2 && dragged.objectMovedInPicture === false, { before: big.pan, after: dragged.pan, objectMoved: dragged.objectMovedInPicture });
  await shot('big-dragged-1280x800');
  await narrow(440); await sleep(900);
  results.bigDraggedDocked = await evaluate(MEASURE);
  expect('a panel docking after the owner dragged leaves their view alone', sameView(results.bigDraggedDocked, dragged), { before: view(dragged), after: view(results.bigDraggedDocked) });
  // Bringing a work item of the last area into view from the outline: the zoom is not touched and the object ends up
  // on screen.
  await narrow(0); await sleep(600);
  results.bigReveal = { picked: await evaluate(PICK_LAST_WORK), ...(await evaluate(MEASURE)) };
  expect('an object brought into view from the outline ends up on screen, and the zoom is not touched', results.bigReveal.picked?.onScreen === true && near(results.bigReveal.zoom, dragged.zoom), results.bigReveal.picked);
  await shot('big-revealed-1280x800');
  // The owner's own wheel: below the floor, as far as the whole of it needs — far less than the constant here.
  await wheelOutFully(await evaluate(CY_CENTRE));
  results.bigWheelOut = await evaluate(MEASURE);
  wheeledOut('the large project, wheel turned all the way out', results.bigWheelOut);
  await shot('big-wheel-out-1280x800');
  await press('Fit'); await sleep(700);
  results.bigWheelOutThenFit = await evaluate(MEASURE);
  chosenByGraph('`Fit` after zooming out of the large project', results.bigWheelOutThenFit);
  // `Show all anyway`: the whole of it in the window; a change of size afterwards does not snap back; `Fit` does.
  await open(1280, 800, '?synthetic=big');
  results.bigShowAll = { bar: await pressInBar('Show all anyway') };
  await sleep(900);
  results.bigShowAll = { ...results.bigShowAll, ...(await evaluate(MEASURE)) };
  expect('`Show all anyway` shows the whole of the large project, below the floor', results.bigShowAll.bar.pressed && results.bigShowAll.wholeBoxVisible === true && results.bigShowAll.zoom < FLOOR - 0.001, { bar: results.bigShowAll.bar, zoom: results.bigShowAll.zoom, whole: results.bigShowAll.wholeBoxVisible });
  await shot('big-show-all-1280x800');
  await narrow(440); await sleep(900);
  results.bigShowAllDocked = await evaluate(MEASURE);
  expect('a change of size after `Show all anyway` does not snap the view back', sameView(results.bigShowAllDocked, results.bigShowAll), { before: view(results.bigShowAll), after: view(results.bigShowAllDocked) });
  await narrow(0); await sleep(900);
  await press('Fit'); await sleep(700);
  results.bigShowAllThenFit = await evaluate(MEASURE);
  expect('`Fit` after `Show all anyway` brings back the readable fit, at the floor', near(results.bigShowAllThenFit.zoom, FLOOR), view(results.bigShowAllThenFit));
  results.pageErrors = pageErrors;
  expect('the page reported no error', pageErrors.length === 0, pageErrors.slice(0, 3));
  ws.close();
} catch (e) {
  if (!e?.done) { failed = true; console.error(`graph-fit-check failed: ${e.message}`); }
} finally {
  chrome?.kill();
  if (chromeProfile) { await sleep(800); try { rmSync(chromeProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* still held by Chrome: left in the env folder's tmp */ } }
  server.kill();
}
results.checks = checks;
writeFileSync(join(outDir, `${tag}-measurements.json`), JSON.stringify(results, null, 2));
const bad = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - bad.length} of ${checks.length} expectations hold${bad.length ? `; not holding:\n${bad.map((c) => `  FAIL  ${c.what}`).join('\n')}` : ''}`);
console.log(`measurements: ${join(outDir, `${tag}-measurements.json`)}`);
process.exit(failed || bad.length ? 1 : 0);
