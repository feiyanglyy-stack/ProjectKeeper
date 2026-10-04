// The Keeper view as two pages, in a real browser (plan K, CT; Spec §6.10, §6.9, §3.7, §3.8; D105). Usage:
//   node scripts/ui-ct-check.mjs <outDir> --snapshot <home> [--port 4935]
//
// Part 1 serves a COPY of an organized home (the snapshot is copied to a temporary directory first and never opened
// itself): the Keeper view opens on Daily; the page's height is measured before any block is opened; Keeper activity
// shows the rounds as rows and a tree opens; the Takeover page says which depth ran and which can still be chosen;
// Clear with DELETE returns the copy to the first-time page.
// Part 2 serves a fresh empty home: adding a project runs nothing until Start; after Start the page fills in.
//
// Both homes are served from this process, on a local port, with pi's own directory pointed at an empty temporary one —
// so no real key is visible and no model quota can be spent — and with a local test double as the only provider. The
// project of the copied home is not watched and none of its rounds is started: nothing is written into that project.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './ui-cdp.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const outDir = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) ?? join(tmpdir(), 'pk-ct-shots');
const snapshot = flag('--snapshot');
const port = Number(flag('--port', '4935'));
if (port === 4870) throw new Error('4870 is the resident Keeper’s port; choose another');
mkdirSync(outDir, { recursive: true });

// pi's own directory, empty: no login, no key. Set before the app is loaded.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-ct-pi-'));
const { App } = await import('../src/server/app.ts');
const { HttpApp } = await import('../src/server/http.ts');
const { registerRoutes } = await import('../src/server/api.ts');
const { startFakeProvider, FAKE_MODEL } = await import('../src/keeper/fake-provider.ts');

const results = [];
const numbers = {};
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

/** Serve a home from this process, as `pk serve` does, with the test double as the only provider. */
async function serve(home, onPort) {
  const app = new App(home);
  const http = new HttpApp();
  registerRoutes(http, app, join(appRoot, 'ui'), join(appRoot, 'node_modules'));
  http.route('GET', '/api/events', ({ res }) => { http.sse.attach(res); });
  app.on('event', (event) => http.sse.broadcast('app', event));
  app.servedPort = onPort;
  const fake = await startFakeProvider();
  await app.initKeeper();
  app.keeper.models.registerProvider('fake', { name: 'Fake provider', baseUrl: fake.url, apiKey: 'fake', api: 'openai-completions', models: [FAKE_MODEL] });
  app.keeper.setModel({ provider: 'fake', id: FAKE_MODEL.id, thinking: null }, []);
  const server = await http.listen(onPort);
  // The page's event stream holds a connection open: the browser leaves first, and closing does not wait for stragglers.
  const stop = async () => { await Promise.race([b.navigate('about:blank'), sleep(1000)]).catch(() => undefined); await sleep(300); app.stopAll(); await app.flushAll(); fake.close(); await Promise.race([server.close(), sleep(2000)]); };
  return { app, fake, base: `http://127.0.0.1:${server.port}`, stop };
}

const b = await launch({ width: 1440, height: 900 });
const page = (body) => b.evaluate(`(async () => { const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)]; ${body} })()`);
const settle = async (ms = 400) => { await sleep(ms); await b.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'); };
const shot = async (name) => { const file = join(outDir, name); await b.shot(file); console.log(`     ${file}`); return file; };
const mainHeight = () => page(`const m = $('#main'); return { scroll: m.scrollHeight, client: m.clientHeight };`);
const blocks = () => page(`return $$('#main .section, #main details.kp-fold').filter((e) => e.parentElement.closest('.section, details.kp-fold') === null).map((e) => [e.id || e.querySelector('header, summary')?.textContent.slice(0, 40), Math.round(e.getBoundingClientRect().height)]);`);

const servers = [];
try {
  // ───────────────────────── Part 1: a copy of an organized home ─────────────────────────
  if (snapshot) {
    const home = mkdtempSync(join(tmpdir(), 'pk-ct-home-'));
    cpSync(snapshot, home, { recursive: true });
    // The copy takes in no new change and watches nothing: it works through what it holds.
    const wsFile = join(home, 'workspace.json');
    const ws = JSON.parse(readFileSync(wsFile, 'utf8'));
    ws.settings = { ...ws.settings, watchProjects: false, extraKeys: [], modelBackups: [], steps: {} };
    writeFileSync(wsFile, JSON.stringify(ws, null, 2));
    const before = JSON.parse(readFileSync(join(snapshot, 'workspace.json'), 'utf8')).projects[0];
    const s = await serve(home, port);
    servers.push(s);
    const pid = s.app.workspace.list()[0].id;
    const location = before.locations[0];
    const gitState = () => { try { return execFileSync('git', ['--no-optional-locks', '-C', location, 'status', '--porcelain'], { encoding: 'utf8' }) + execFileSync('git', ['--no-optional-locks', '-C', location, 'rev-parse', 'HEAD'], { encoding: 'utf8' }); } catch { return 'not a git repository'; } };
    const projectBefore = gitState();
    const assetsBefore = { rounds: s.app.store(pid).clerkRounds.size, sources: s.app.store(pid).sources.size, notes: s.app.store(pid).notes.size };

    await b.navigate(`${s.base}/#/p/${encodeURIComponent(pid)}/keeper`);
    await b.waitFor(`document.querySelector('#kp-page') !== null`, { label: 'the Keeper view', timeout: 30000 });
    await settle(800);
    const opened = await page(`return { page: $('#kp-page').dataset.page, state: $('#kp-state').textContent, tabs: $$('.kp-tabs button').map((x) => [x.textContent, x.classList.contains('active')]), schedule: $('#kp-frequency')?.value, time: $('#kp-time')?.value, next: $('#kp-next')?.textContent, followUp: Boolean($('#kp-follow-up-btn')) && !$('#kp-follow-up-btn').disabled, status: $('#kp-daily-status')?.textContent, activityInPage: Boolean($('#keeper-activity')), roundsInPage: Boolean($('#k-rounds-body')), dock: $('.dock-follow')?.disabled };`);
    check('an organized home opens the Keeper view on Daily', opened.page === 'daily' && opened.state === 'Daily', JSON.stringify(opened.tabs));
    check('its old rhythm reads as a schedule: every day, with a time and the next time said', opened.schedule === 'Every day' && /^\d\d:\d\d$/.test(opened.time ?? '') && /next:/.test(opened.next ?? ''), `${opened.schedule} ${opened.time} · ${opened.next}`);
    check('Follow up is available on the Daily page and in the dock', opened.followUp && opened.dock === false);
    check('the Daily page has one line of status, with the last round and what waits', /Last round: round \d+/.test(opened.status ?? '') && /waiting for the next round/.test(opened.status ?? ''), (opened.status ?? '').slice(0, 160));
    check('the page holds no work list and no round tree', !opened.activityInPage && !opened.roundsInPage);
    const h1 = await mainHeight();
    numbers.dailyPage = { ...h1, blocks: await blocks(), viewport: '1440x900' };
    check('the Keeper page before any block is opened is short (it was 26,935 px)', h1.scroll < 3000, `${h1.scroll} px, the view shows ${h1.client} px`);
    const folded = await page(`return $$('#main details.kp-fold').map((d) => [d.id, d.open, d.querySelector('summary').textContent]);`);
    numbers.folded = folded;
    check('the folded blocks are closed, each with a head that says what is inside and how much', folded.length >= 5 && folded.every((f) => f[1] === false) && folded.some((f) => /Capabilities \(\d+\) and resources loaded in this project \(\d+\)/.test(f[2])) && folded.some((f) => /Usage of each piece of work \(\d+\)/.test(f[2])), folded.map((f) => f[0]).join(', '));
    await shot('daily-page.png');

    // Changing the schedule without saving has no effect; saving says when the next one is.
    await page(`const f = $('#kp-frequency'); f.value = 'On selected days'; f.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await settle(200);
    const unsaved = await page(`return { hint: $('#kp-unsaved').textContent, save: !$('#kp-save').disabled, days: !$('#kp-days').closest('.field').hidden };`);
    check('a changed schedule says it is not saved, and shows the days to choose', /not saved/.test(unsaved.hint) && unsaved.save && unsaved.days);
    check('…and has no effect until saved', (s.app.project(pid).schedule?.frequency ?? 'Every day') === 'Every day');
    await page(`$('#kp-days input[value="1"]').click(); $('#kp-days input[value="4"]').click(); $('#kp-time').value = '07:30'; $('#kp-time').dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await b.clickOn('#kp-save');
    await b.waitFor(`/On Monday, Thursday at 07:30/.test(document.querySelector('#kp-next')?.textContent ?? '')`, { label: 'the saved schedule', timeout: 15000 });
    const saved = s.app.project(pid).schedule;
    check('Save keeps the schedule and the page says the next time', saved?.frequency === 'On selected days' && saved.time === '07:30' && JSON.stringify(saved.days) === '[1,4]', await page(`return $('#kp-next').textContent;`));
    await shot('daily-page-schedule-saved.png');

    // Keeper activity: the rounds as rows, a tree on a click.
    await b.clickOn('#kp-activity');
    await b.waitFor(`document.querySelectorAll('#dialog .ka-round').length > 0`, { label: 'Keeper activity', timeout: 30000 });
    await settle(500);
    const rows = await page(`return $$('#dialog .ka-round').map((r) => ({ id: r.dataset.round, kind: r.dataset.kind, open: r.open, text: r.querySelector('summary').textContent, height: Math.round(r.getBoundingClientRect().height) }));`);
    numbers.activityRows = rows;
    check('Keeper activity lists each round as one row', rows.length === assetsBefore.rounds && rows.every((r) => !r.open && r.height < 80), rows.map((r) => `${r.kind} ${r.height}px`).join(' · '));
    check('a row says which kind, when, its status, its time and cost', rows.every((r) => /Round \d+/.test(r.text) && /Done|Running|Stopped|Failed/.test(r.text) && /(min|h) · (\$|cost)/.test(r.text)), rows[0]?.text.slice(0, 140));
    await shot('keeper-activity-rows.png');
    await b.clickOn(`#dialog .ka-round[data-kind="Deepen"] > summary, #dialog .ka-round > summary`);
    await b.waitFor(`document.querySelector('#dialog .ka-round[open] .kv-round') !== null`, { label: 'the round tree', timeout: 15000 });
    await settle(600);
    const tree = await page(`const r = $('#dialog .ka-round[open]'); return { steps: r.querySelectorAll('.kv-step').length, lanes: r.querySelectorAll('.kv-lane').length, stages: r.querySelectorAll('.kv-stages tr').length, docs: r.querySelectorAll('.kv-docs .kv-btn').length, openDocs: r.querySelectorAll('.kv-doc-panel').length };`);
    numbers.tree = tree;
    check('a click opens the round’s tree: its steps, the main agent’s stages, its lanes', tree.steps > 3 && tree.lanes > 0 && tree.stages > 2, JSON.stringify(tree));
    check('briefs and reports stay closed until clicked', tree.docs > 0 && tree.openDocs === 0, `${tree.docs} documents, ${tree.openDocs} open`);
    await shot('keeper-activity-round-open.png');
    await page(`$('#dialog').close(); return true;`);

    // A `For your decision` note's options, each with what follows (CU's note form, D105): shown on the note's page. The
    // note is put into the copy here; the snapshot's notes were written before notes carried options.
    const at = new Date().toISOString();
    s.app.store(pid).notes.put({ id: 'note_ct_options', projectId: pid, mount: { kind: 'project', ids: [] }, status: 'Current', ownerResponse: null,
      versions: [{ version: 1, at, title: 'Record D13 and D20 as replaced by v0.4?', preview: 'Should the decision log say that D13 and D20 were replaced when v0.4 was adopted?', body: { currentView: 'v0.4 replaced the four-block structure of D13 and D20, but the decision log has no line saying so.', whyItMatters: 'Whoever reads the log alone takes the four blocks as current.', facts: [], otherExplanations: null, keepAdjust: '', whatWouldSettleIt: 'Your answer.', options: [{ option: 'Record the replacement', then: 'the Main agent adds a replacement line to D13 and D20, and both show as Replaced here' }, { option: 'Leave it as it is', then: 'D13 and D20 stay current on the workbench' }] }, ask: 'For your decision', judgementRecordId: 'jdg_ct', reason: 'browser check' }],
      discussion: [], followUps: [], author: { agent: 'pi', model: 'fake-1' }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, language: 'en', updatedAt: at });
    await s.app.store(pid).flush();
    await b.navigate(`${s.base}/#/p/${encodeURIComponent(pid)}/notes`);
    await b.waitFor(`document.querySelector('[data-note="note_ct_options"]') !== null`, { label: 'the note in the Notes log', timeout: 30000 });
    await b.clickOn('[data-note="note_ct_options"]', { scroll: true });
    // The popover beside the note gives its first lines; `Details` opens its page, where the parts are.
    await b.waitFor(`[...document.querySelectorAll('.popover button')].some((x) => x.textContent.trim() === 'Details')`, { label: 'the note’s popover', timeout: 15000 });
    await page(`[...document.querySelectorAll('.popover button')].find((x) => x.textContent.trim() === 'Details').click(); return true;`);
    await b.waitFor(`[...document.querySelectorAll('.note-options li')].length === 2`, { label: 'the note’s options', timeout: 15000 });
    await settle(500);
    const options = await page(`return $$('.note-options li').map((li) => li.textContent);`);
    check('a note for decision shows its options, each with what follows', options.length === 2 && /^Record the replacement — the Main agent adds/.test(options[0]), options.join(' | '));
    await shot('note-options.png');
    await page(`document.querySelector('#dialog')?.close(); return true;`);
    await b.navigate(`${s.base}/#/p/${encodeURIComponent(pid)}/keeper`);
    await b.waitFor(`document.querySelector('#kp-page') !== null`, { label: 'the Keeper view again', timeout: 30000 });
    await settle(600);

    // The Takeover page of a project that is done.
    await b.clickOn('.kp-tabs button[data-page="takeover"]');
    await b.waitFor(`document.querySelector('#kp-page')?.dataset.page === 'takeover'`, { label: 'the Takeover page' });
    await settle(600);
    const tk = await page(`return { ran: $('#kp-ran')?.textContent, depths: $$('.kp-depth').map((d) => [d.dataset.depth, d.querySelector('input').disabled, d.querySelector('.tag')?.textContent ?? null]), start: Boolean($('#kp-start')), clear: Boolean($('#kp-clear')), briefing: $$('#kp-briefing h4').map((x) => x.textContent), waiting: $$('#kp-briefing .kp-waiting li').length, reading: $('#kp-reading') ? [$('#kp-reading').open, $('#kp-reading summary').textContent] : null };`);
    numbers.takeoverDone = tk;
    check('the Takeover page says which depth ran, when, with which model, how long and what it cost', /^Full ran · finished .* · .*(min|h) · \$\d/.test(tk.ran ?? ''), tk.ran);
    check('Full is marked as run and every depth is disabled', tk.depths.every((d) => d[1] === true) && tk.depths.find((d) => d[0] === 'Full')?.[2] === 'ran' && !tk.start, JSON.stringify(tk.depths));
    check('the briefing has its five parts', tk.briefing.length === 5 && /What this project is/.test(tk.briefing[0]) && /Its areas/.test(tk.briefing[1]) && /Where the work stands/.test(tk.briefing[2]) && /Waiting for your decision/.test(tk.briefing[3]) && /What was read/.test(tk.briefing[4]), tk.briefing.join(' | '));
    check('the reading table is folded', tk.reading && tk.reading[0] === false, tk.reading?.[1]);
    const internal = await page(`return ($('#kp-briefing').textContent.match(/\\b(?:mark|sb|note|thread|ref|src|job|crd)_[0-9a-z]{6,}\\b/g) ?? []);`);
    check('the briefing shows no internal identifier', internal.length === 0, internal.slice(0, 5).join(', '));
    numbers.takeoverPage = { ...(await mainHeight()), blocks: await blocks() };
    await shot('takeover-page-done.png');

    // Clear: the dialog, a wrong word, then DELETE.
    await b.clickOn('#kp-clear');
    await b.waitFor(`document.querySelector('#kp-clear-word') !== null`, { label: 'the Clear dialog', timeout: 15000 });
    await settle(400);
    const dlg = await page(`return { removed: $$('.kp-clear-removed tr').map((r) => r.textContent), kept: $$('.kp-clear-kept li').map((r) => r.textContent), ownerOnly: $('#kp-clear-owner-only').textContent, confirm: $('#kp-clear-confirm').disabled };`);
    numbers.clearDialog = dlg;
    check('the Clear dialog says what goes, each with how many, and what stays', dlg.removed.length >= 10 && dlg.kept.length === 5 && /ProjectKeeper folder inside the project/.test(dlg.kept.join(' ')) && /only to the Keeper/.test(dlg.ownerOnly), `${dlg.removed.length} removed, ${dlg.kept.length} kept`);
    await shot('clear-dialog.png');
    await b.clickOn('#kp-clear-word');
    await b.type('delete');
    await settle(150);
    check('a wrong word leaves Clear disabled', await page(`return $('#kp-clear-confirm').disabled;`));
    check('…and nothing changed', s.app.store(pid).clerkRounds.size === assetsBefore.rounds && s.app.store(pid).sources.size === assetsBefore.sources);
    await page(`const w = $('#kp-clear-word'); w.value = ''; w.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await b.clickOn('#kp-clear-word');
    await b.type('DELETE');
    await settle(150);
    await shot('clear-dialog-delete-typed.png');
    await b.clickOn('#kp-clear-confirm');
    await b.waitFor(`!document.querySelector('#dialog').open && document.querySelector('#kp-state')?.textContent === 'Not taken over'`, { label: 'the cleared project', timeout: 60000 });
    await settle(900);
    const cleared = await page(`return { page: $('#kp-page').dataset.page, state: $('#kp-state').textContent, intro: $('#kp-intro')?.textContent, depths: $$('.kp-depth').map((d) => [d.dataset.depth, d.querySelector('input').disabled]), start: $('#kp-start')?.disabled, why: $('#kp-start-why')?.textContent, pill: $('.coverage-pill').textContent, failed: $('#cov-failed')?.hidden, dock: $('.dock-follow').disabled, dockTitle: $('.dock-follow').title, clear: Boolean($('#kp-clear')), before: $('#kp-usage-before')?.textContent };`);
    numbers.cleared = cleared;
    const st = s.app.store(pid);
    check('Clear with DELETE returns the copy to the first-time Takeover page', cleared.page === 'takeover' && cleared.state === 'Not taken over' && /Nothing runs until you press Start/.test(cleared.intro ?? ''), cleared.state);
    check('every depth can be chosen again, and Start waits for a choice', cleared.depths.every((d) => d[1] === false) && cleared.start === true && /Choose a depth/.test(cleared.why ?? ''), cleared.why);
    check('the top bar says Not organized yet, with no counts', cleared.pill.trim() === 'Not organized yet' && cleared.failed !== false, cleared.pill);
    check('Follow up is not available until the takeover is done, and says so', cleared.dock === true && /Start the takeover/.test(cleared.dockTitle), cleared.dockTitle);
    check('the organized assets are gone from the copy', st.clerkRounds.size === 0 && st.sources.size === 0 && st.notes.size === 0 && st.jobs.size === 0 && st.threads.size === 0);
    check('what was spent stays as one total, named as from before the clear', /Before the last clear/.test(cleared.before ?? ''), cleared.before);
    check('the project’s own files and git state are untouched', gitState() === projectBefore);
    check('the project keeps its name, its locations and the saved schedule', s.app.project(pid).name === before.name && s.app.project(pid).locations[0] === location && s.app.project(pid).schedule?.frequency === 'On selected days');
    numbers.firstTimePage = { ...(await mainHeight()), blocks: await blocks() };
    await shot('takeover-page-first-time.png');
    await b.navigate(`${s.base}/#/p/${encodeURIComponent(pid)}/graph`);
    await b.waitFor(`document.querySelector('#graph-to-takeover') !== null`, { label: 'the empty graph', timeout: 15000 });
    check('the empty graph says the project is not organized and leads to the Takeover page', await page(`return /has not been organized yet/.test($('.graph-empty').textContent);`));
    await shot('graph-not-organized.png');
    await s.stop();
    servers.splice(servers.indexOf(s), 1);
  }

  // ───────────────────────── Part 2: a fresh empty home ─────────────────────────
  {
    const home = mkdtempSync(join(tmpdir(), 'pk-ct-fresh-'));
    const dir = mkdtempSync(join(tmpdir(), 'pk-ct-tern-'));
    const write = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
    write('README.md', '# Tern\n\nPrints tide tables for the harbour office.\n');
    write('docs/PLAN.md', '# Plan\n\n## T-1 Read the gauge feed\n\n## T-2 Print the weekly table\n');
    write('docs/DECISIONS.md', '# Decisions\n\n**D1 · Tables are printed on Mondays.**\n');
    const git = (a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'Tern Dev', GIT_AUTHOR_EMAIL: 'dev@tern.invalid', GIT_COMMITTER_NAME: 'Tern Dev', GIT_COMMITTER_EMAIL: 'dev@tern.invalid' } });
    git(['init', '-q', '-b', 'main']); git(['add', '-A']); git(['commit', '-q', '-m', 'Start Tern']);
    const s = await serve(home, port + 1);
    servers.push(s);
    await b.navigate(`${s.base}/`);
    await b.waitFor(`document.querySelector('.empty .btn.primary') !== null`, { label: 'the empty workspace', timeout: 30000 });
    await b.clickOn('.empty .btn.primary');
    await b.waitFor(`document.querySelector('#dialog input.input') !== null`, { label: 'the Add project dialog' });
    await b.clickOn('#dialog input.input');
    await b.type('Tern');
    await b.clickOn('#dialog textarea.input');
    await b.type(dir);
    await b.clickOn('#dialog .dialog-foot .btn.primary');
    await b.waitFor(`document.querySelector('#kp-page')?.dataset.page === 'takeover'`, { label: 'the new project’s Takeover page', timeout: 30000 });
    await settle(1500);
    const pid = s.app.workspace.list()[0].id;
    const store = s.app.store(pid);
    const added = await page(`return { hash: location.hash, state: $('#kp-state').textContent, key: $('#kp-key').textContent, start: $('#kp-start').disabled, why: $('#kp-start-why')?.textContent, blocks: $$('#kp-settings > *').map((e) => e.id), pill: $('.coverage-pill').textContent.trim() };`);
    numbers.added = added;
    check('adding a project opens its Takeover page', /\/keeper\/takeover$/.test(added.hash) && added.state === 'Not taken over', added.hash);
    check('…with the key and model this takeover runs on, and Model provider first among the settings', /key usable/.test(added.key) && /fake-1/.test(added.key) && added.blocks[0] === 'kp-model', added.key.slice(0, 90));
    check('…and nothing has run: no boundary, nothing read, no round, no Keeper work', store.clerkRounds.size === 0 && store.jobs.size === 0 && store.sources.size === 0 && s.app.project(pid).scope.length === 0 && s.app.project(pid).lastScopedAt === null);
    check('Start is disabled until a depth is chosen', added.start === true && /Choose a depth/.test(added.why ?? ''));
    await shot('fresh-takeover-first-time.png');
    await sleep(2500);
    check('still nothing after a while', store.clerkRounds.size === 0 && store.jobs.size === 0 && store.sources.size === 0);

    // Choose Focused and Start. The double answers the first model steps, then stops answering, so the round stays
    // under way with its steps on the page.
    await b.clickOn('.kp-depth[data-depth="Focused"] input');
    await settle(300);
    check('with a depth chosen, Start can be pressed', await page(`return !$('#kp-start').disabled && $('.kp-depth[data-depth="Focused"]').classList.contains('selected');`));
    await shot('fresh-takeover-depth-chosen.png');
    let holdAt = null;
    const hold = setInterval(() => { if (!holdAt && store.jobs.find((j) => j.step?.kind === 'main')) { holdAt = Date.now(); s.fake.mode.value = 'hang'; } }, 20);
    s.fake.mode.value = 'normal';
    await b.clickOn('#kp-start');
    await b.waitFor(`document.querySelector('#kp-state')?.textContent === 'Takeover under way'`, { label: 'the takeover under way', timeout: 30000 });
    for (let i = 0; i < 300 && !store.jobs.find((j) => j.step?.kind === 'main' && j.status === 'Running'); i++) await sleep(100);
    clearInterval(hold);
    await b.waitFor(`document.querySelectorAll('#kp-progress .kp-steps li').length >= 2`, { label: 'the steps on the page', timeout: 30000 }).catch(() => undefined);
    await settle(2500);
    const under = await page(`return { state: $('#kp-state').textContent, ran: $('#kp-ran')?.textContent, depths: $$('.kp-depth').map((d) => [d.dataset.depth, d.querySelector('input').disabled, d.querySelector('.tag')?.textContent ?? null]), start: Boolean($('#kp-start')), clear: Boolean($('#kp-clear')), stage: $('#kp-progress b')?.textContent, steps: $$('#kp-progress .kp-steps li').map((l) => l.textContent.trim()), soFar: $('#kp-so-far')?.textContent, daily: null };`);
    numbers.underWay = under;
    check('after Start the page says the takeover is under way, at the depth chosen', under.state === 'Takeover under way' && /^Focused chosen · started/.test(under.ran ?? ''), under.ran);
    check('the depths cannot be pressed, and Clear is there', under.depths.every((d) => d[1] === true) && under.depths.find((d) => d[0] === 'Focused')?.[2] === 'chosen' && !under.start && under.clear, JSON.stringify(under.depths));
    check('the page fills in as the Keeper works: the stage, the round’s steps, the time and cost so far', /First usable picture/.test(under.stage ?? '') && under.steps.length >= 2 && /So far:/.test(under.soFar ?? ''), `${under.stage}: ${under.steps.join(' | ')}`);
    check('the boundary was drawn and the material read by Start', s.app.project(pid).scope.length > 0 && store.sources.size > 0 && store.clerkRounds.size === 1);
    await shot('fresh-takeover-under-way.png');
    await b.clickOn('.kp-tabs button[data-page="daily"]');
    await b.waitFor(`document.querySelector('#kp-daily-unavailable') !== null`, { label: 'the Daily page while the takeover runs' });
    const daily = await page(`return { why: $('#kp-daily-unavailable').textContent, follow: $('#kp-follow-up-btn').disabled, frequency: $('#kp-frequency').disabled };`);
    check('Daily says to finish the takeover first; the schedule and Follow up are not available', /still under way/.test(daily.why) && daily.follow && daily.frequency, daily.why.slice(0, 120));
    await shot('fresh-daily-unavailable.png');
    // Stop here: the round is stopped and the home cleared, so nothing is left running.
    await s.app.clearProject(pid, 'DELETE');
    check('clearing the fresh project stops the round under way and leaves nothing running', store.jobs.size === 0 && store.clerkRounds.size === 0);
    await s.stop();
    servers.splice(servers.indexOf(s), 1);
  }
} catch (e) {
  check('the check ran to its end', false, e.stack ?? String(e));
  await shot('failure.png').catch(() => undefined);
} finally {
  if (b.consoleLines.length) console.log(`console:\n${b.consoleLines.slice(0, 20).join('\n')}`);
  check('no error in the browser console', b.consoleLines.filter((l) => !/favicon|ERR_ABORTED/.test(l)).length === 0, b.consoleLines.slice(0, 3).join(' | '));
  for (const s of servers) await s.stop().catch(() => undefined);
  await b.close();
}
writeFileSync(join(outDir, 'numbers.json'), JSON.stringify({ results, numbers }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed; screenshots and numbers.json in ${outDir}`);
process.exit(failed.length ? 1 : 0);
