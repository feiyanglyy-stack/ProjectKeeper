// The owner's own keys and the routes on the Keeper page, Usage per round per model, the first-run flow — in a real
// browser (plan K, CV; Spec §6.10 key、模型与路由, §3.10; D105; CKC-03 AC-33～AC-37). Usage:
//   node scripts/ui-cv-check.mjs <outDir> --snapshot <home> [--port 4945]
//
// Part 1 serves a COPY of an organized home (the snapshot is copied to a temporary directory first and never opened
// itself) with organizing off and every unfinished job of the copy stopped, so nothing runs and nothing is sent to any
// provider. The owner's environment keys are stood in for by FAKE values under the same variable names
// (ZAI_CODING_CN_API_KEY, ZAI_CODING_CN_TEAM_API_KEY, ZAI_API_KEY, DEEPSEEK_API_KEY): the page shows how such keys
// appear; none of them is checked, so no request leaves this machine. A test double is the provider of the key added on
// the page: add it, see it masked, check it, set the lanes to another model than the main one, set the backup order,
// read Usage split by model for the copy's two recorded rounds.
// Part 2 serves a fresh empty home with no key at all: the Takeover page says to add one and Start is off; a key for the
// test double is added, the main model chosen, the depth chosen, Start pressed; the project is then cleared.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './ui-cdp.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const outDir = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) ?? join(tmpdir(), 'pk-cv-shots');
const snapshot = flag('--snapshot');
const port = Number(flag('--port', '4945'));
if (port === 4870 || port + 1 === 4870) throw new Error('4870 is the resident Keeper’s port; choose another');
mkdirSync(outDir, { recursive: true });

// pi's own directory, empty: no login. No real key variable reaches this process: every *_API_KEY is taken out first.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-cv-pi-'));
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
for (const k of Object.keys(process.env)) if (/_API_KEY$|_TOKEN$/.test(k)) delete process.env[k];
const OWNER_ENV = ['ZAI_CODING_CN_API_KEY', 'ZAI_CODING_CN_TEAM_API_KEY', 'ZAI_API_KEY', 'DEEPSEEK_API_KEY'];
const FAKE_KEY = 'pk-ui-fake-key-4d2a91f0c7e3b58a';
const { App } = await import('../src/server/app.ts');
const { HttpApp } = await import('../src/server/http.ts');
const { registerRoutes } = await import('../src/server/api.ts');
const { startFakeProvider, FAKE_MODEL } = await import('../src/keeper/fake-provider.ts');

const results = [];
const numbers = {};
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

/** Serve a home from this process, with the test double registered as a provider that has no key of its own. */
async function serve(home, onPort, { organizing }) {
  const app = new App(home, { organizing });
  const http = new HttpApp();
  registerRoutes(http, app, join(appRoot, 'ui'), join(appRoot, 'node_modules'));
  http.route('GET', '/api/events', ({ res }) => { http.sse.attach(res); });
  app.on('event', (event) => http.sse.broadcast('app', event));
  app.servedPort = onPort;
  const fake = await startFakeProvider();
  await app.initKeeper();
  app.keeper.models.registerProvider('fake', { name: 'Test double', baseUrl: fake.url, api: 'openai-completions', models: [FAKE_MODEL] });
  const server = await http.listen(onPort);
  const stop = async () => { await Promise.race([b.navigate('about:blank'), sleep(1000)]).catch(() => undefined); await sleep(300); app.stopAll(); await app.flushAll(); fake.close(); await Promise.race([server.close(), sleep(2000)]); };
  return { app, fake, base: `http://127.0.0.1:${server.port}`, stop };
}

const b = await launch({ width: 1440, height: 900 });
const page = (body) => b.evaluate(`(async () => { const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)]; ${body} })()`);
const settle = async (ms = 400) => { await sleep(ms); await b.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'); };
const shot = async (name) => { const file = join(outDir, name); await b.shot(file); console.log(`     ${file}`); return file; };
/** A screenshot of one element whole: the viewport is made tall enough for it, then put back. */
const shotOf = async (selector, name) => {
  const r = await page(`const el = $(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'start' }); const r = el.getBoundingClientRect(); return { top: r.top, height: Math.ceil(r.height), width: Math.ceil(r.width), left: r.left };`);
  await b.setViewport(1440, Math.max(900, Math.ceil(r.top + r.height + 240)));
  await settle(300);
  const at = await page(`const r = $(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height };`);
  const file = join(outDir, name);
  const res = await b.send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, at.x - 8), y: Math.max(0, at.y - 8), width: at.width + 16, height: at.height + 16, scale: 1 } });
  writeFileSync(file, Buffer.from(res.result.data, 'base64'));
  await b.setViewport(1440, 900);
  await settle(200);
  console.log(`     ${file}`);
  return file;
};
const mainHeight = () => page(`const m = $('#main'); return { scroll: m.scrollHeight, client: m.clientHeight };`);
const blocks = () => page(`return $$('#main .section, #main details.kp-fold').filter((e) => e.parentElement.closest('.section, details.kp-fold') === null).map((e) => [e.id || e.querySelector('header, summary')?.textContent.slice(0, 40), Math.round(e.getBoundingClientRect().height)]);`);
const selectValue = (selector, value) => page(`const s = $(${JSON.stringify(selector)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value;`);
const pageHolds = (value) => page(`return document.documentElement.outerHTML.includes(${JSON.stringify(value)}) || [...document.querySelectorAll('input')].some((i) => i.value.includes(${JSON.stringify(value)}));`);

const servers = [];
try {
  // ───────────────────────── Part 1: a copy of an organized home ─────────────────────────
  if (snapshot) {
    const home = mkdtempSync(join(tmpdir(), 'pk-cv-home-'));
    cpSync(snapshot, home, { recursive: true });
    const wsFile = join(home, 'workspace.json');
    const ws = JSON.parse(readFileSync(wsFile, 'utf8'));
    ws.settings = { ...ws.settings, watchProjects: false };
    writeFileSync(wsFile, JSON.stringify(ws, null, 2));
    const pid = ws.projects[0].id;
    // Nothing of the copy runs: work it left unfinished is stopped in the copy before it is served.
    const jobsFile = join(home, 'projects', pid, 'jobs.json');
    const jobs = JSON.parse(readFileSync(jobsFile, 'utf8'));
    const unfinished = jobs.filter((j) => ['Queued', 'Running', 'Waiting for quota', 'Paused'].includes(j.status)).length;
    writeFileSync(jobsFile, JSON.stringify(jobs.map((j) => (['Queued', 'Running', 'Waiting for quota', 'Paused'].includes(j.status) ? { ...j, status: 'Stopped' } : j))));
    numbers.copy = { unfinishedStopped: unfinished };
    for (const k of OWNER_ENV) process.env[k] = `pk-ui-fake-env-${k.toLowerCase()}`;
    const s = await serve(home, port, { organizing: false });
    servers.push(s);
    const sentBefore = s.fake.requests.length;

    await b.navigate(`${s.base}/#/p/${encodeURIComponent(pid)}/keeper`);
    await b.waitFor(`document.querySelector('#kp-keys') !== null`, { label: 'the Keeper view with its keys', timeout: 30000 });
    await settle(1000);
    const daily = await mainHeight();
    numbers.dailyPage = { ...daily, blocks: await blocks(), viewport: '1440x900' };
    const keys = await page(`return $$('#kp-keys tbody tr').map((r) => ({ id: r.dataset.key, name: r.cells[0].textContent, from: r.cells[3].textContent, mask: r.cells[2].textContent, state: r.querySelector('[data-key-state]').dataset.keyState, actions: [...r.querySelectorAll('[data-act]')].map((x) => x.dataset.act) }));`);
    numbers.keysAsServed = keys;
    const env = keys.filter((k) => /Environment variable/.test(k.from));
    check('the owner’s environment keys appear, each saying where it comes from, usable without being entered again', env.length >= 4 && env.every((k) => k.state === 'Usable' && k.mask === '—' && k.actions.join() === 'check'), env.map((k) => `${k.name}: ${k.from}`).join(' | '));
    check('the team key of the settings is listed as the Zhipu provider’s', keys.some((k) => k.id === 'zai-coding-cn-team' && /CK|ZAI_CODING_CN_TEAM_API_KEY/.test(k.from)));
    check('the machine’s route stands until changed here: glm-5.3 on Zhipu, backups Z.ai and the team key', await page(`return $('#kp-main-key').value === 'zai-coding-cn' && $('#kp-main-model').value === 'glm-5.3' && $$('#kp-backups li[data-backup]').map((l) => l.dataset.backup).join() === 'zai,zai-coding-cn-team';`));

    // Add a key for the test double: masked once saved, checked at once.
    await selectValue('#kp-add-provider', 'fake');
    await b.clickOn('#kp-add-name', { scroll: true });
    await b.type('Test double key');
    await b.clickOn('#kp-add-key');
    await b.type(FAKE_KEY);
    await shot('model-provider-adding-a-key.png');
    await b.clickOn('#kp-add-save');
    await b.waitFor(`document.querySelector('#kp-keys tr[data-key="fake~1"]') !== null`, { label: 'the saved key', timeout: 30000 });
    await settle(800);
    const saved = await page(`const r = $('#kp-keys tr[data-key="fake~1"]'); return { mask: r.cells[2].textContent, state: r.querySelector('[data-key-state]').dataset.keyState, stateText: r.cells[4].textContent, input: $('#kp-add-key').value };`);
    check('the saved key shows only its name, provider and a full mask', /^•+$/.test(saved.mask) && saved.input === '', saved.mask);
    check('it was checked on save, with one request of one output token', saved.state === 'Usable' && /one request of one output token/.test(saved.stateText), saved.stateText.slice(0, 160));
    check('the key’s value is nowhere on the page', !(await pageHolds(FAKE_KEY)));
    await b.clickOn('#kp-keys tr[data-key="fake~1"] [data-act="check"]', { scroll: true });
    await b.waitFor(`/checked/.test(document.querySelector('#kp-keys tr[data-key="fake~1"] .kp-key-state')?.textContent ?? '') && !document.querySelector('#kp-keys tr[data-key="fake~1"] [data-act="check"]').disabled`, { label: 'the key checked', timeout: 30000 });
    check('Check asks again and says the key is usable', await page(`return $('#kp-keys tr[data-key="fake~1"] [data-key-state]').dataset.keyState === 'Usable';`));

    // The lanes on another model than the main agent: DeepSeek's flash while the main model is glm-5.3.
    await selectValue('#steps-settings tr[data-step="lane"] select', 'deepseek|deepseek-flash');
    await b.waitFor(`document.querySelector('#steps-settings tr[data-step="lane"] select')?.value === 'deepseek|deepseek-flash' && document.querySelector('#steps-settings tr[data-step="synthesis"]') !== null`, { label: 'the lanes’ model saved', timeout: 15000 });
    await settle(600);
    // The spot-check, set apart in the machine's settings, is given back to the main model.
    await selectValue('#steps-settings tr[data-step="spot-check"] select', '');
    await b.waitFor(`/follows the main model/.test(document.querySelector('#steps-settings tr[data-step="spot-check"]')?.textContent ?? '')`, { label: 'the spot-check following the main model', timeout: 15000 });
    await settle(600);
    const route = s.app.project(pid).route;
    const rows = await page(`return Object.fromEntries($$('#steps-settings tbody tr').map((r) => [r.dataset.step, r.cells[0].textContent + ' | ' + r.querySelector('select').selectedOptions[0].textContent]));`);
    numbers.stepRows = rows;
    check('the lanes run on DeepSeek flash while the main model is glm-5.3, saved for this project', route?.steps?.lane?.model === 'deepseek-flash' && route?.steps?.lane?.provider === 'deepseek' && route?.model?.id === 'glm-5.3', JSON.stringify(route?.steps));
    check('a step not set apart says whom it follows', /follows the main model \(glm-5\.3\)/.test(rows['spot-check'] ?? '') && /follows Main agent/.test(rows.synthesis ?? '') && !route.steps['spot-check']?.model, `${rows['spot-check']} · ${rows.synthesis}`);
    // The backup order: the test double's key added, then moved first.
    await selectValue('#kp-backup-add', 'fake~1');
    await b.waitFor(`document.querySelector('#kp-backups li[data-backup="fake~1"]') !== null`, { label: 'the key in the backup order', timeout: 15000 });
    await settle(500);
    for (let i = 0; i < 2; i++) {
      const before = s.app.project(pid).route.backups.map((x) => x.provider).join();
      await b.clickOn('#kp-backups li[data-backup="fake~1"] button[title="Earlier"]', { scroll: true });
      for (let t = 0; t < 100 && s.app.project(pid).route.backups.map((x) => x.provider).join() === before; t++) await sleep(50);
      await b.waitFor(`document.querySelector('#kp-backups li[data-backup="fake~1"]') !== null`, { label: 'the order redrawn', timeout: 15000 });
      await settle(500);
    }
    const order = s.app.project(pid).route.backups.map((x) => x.provider);
    check('the backup order is the owner’s: the test double’s key first, then Z.ai, then the team key', order.join() === 'fake~1,zai,zai-coding-cn-team', order.join(' → '));
    check('the page says how many jobs run at once, in all', await page(`return /Up to \\d+ jobs at once/.test($('#kp-lanes').textContent);`), await page(`return $('#kp-lanes').textContent;`));
    numbers.route = s.app.project(pid).route;
    await shotOf('#kp-model', 'model-provider-keys-and-routes.png');

    // Usage: the two recorded rounds, each split by model.
    const usage = await page(`return $$('#kp-usage-rounds details.kp-round-usage').map((d) => ({ head: d.querySelector('summary').textContent, open: d.open, rows: [...d.querySelectorAll('tbody tr')].map((r) => [...r.cells].map((c) => c.textContent)) }));`);
    numbers.usage = usage;
    check('Usage has one row per round, both open', usage.length === 2 && usage.every((u) => u.open), usage.map((u) => u.head).join(' | '));
    check('each round is split by model: glm-5.3 on the two Zhipu keys, with the steps it carried, its time, tokens and cost', usage.every((u) => u.rows.length === 1 && /glm-5\.3/.test(u.rows[0][0]) && /,/.test(u.rows[0][1]) && /Main agent/.test(u.rows[0][2]) && /\$/.test(u.rows[0][6])), usage.map((u) => u.rows[0].join(' · ')).join(' || '));
    check('the total stays in view', await page(`return /In all: input/.test($('#kp-usage-total').textContent);`));
    await shotOf('#kp-usage', 'usage-by-round-and-model.png');

    // The Takeover page of the copy, for its height.
    await b.clickOn('.kp-tabs button[data-page="takeover"]', { scroll: true });
    await b.waitFor(`document.querySelector('#kp-page')?.dataset.page === 'takeover'`, { label: 'the Takeover page' });
    await settle(800);
    numbers.takeoverPage = { ...(await mainHeight()), blocks: await blocks() };
    await b.clickOn('.kp-tabs button[data-page="daily"]', { scroll: true });
    await b.waitFor(`document.querySelector('#kp-page')?.dataset.page === 'daily'`, { label: 'the Daily page again' });
    await settle(800);
    await b.evaluate(`document.querySelector('#main').scrollTop = 0`);
    numbers.dailyPageAfter = { ...(await mainHeight()), blocks: await blocks() };
    await shot('daily-page-with-model-provider.png');
    check('nothing was sent to any provider but the one-token checks of the test double’s key', s.fake.requests.length - sentBefore === 2, `${s.fake.requests.length - sentBefore} requests to the test double`);
    check('the copy wrote the key in keys.json only', !readFileSync(wsFile, 'utf8').includes(FAKE_KEY) && readFileSync(join(home, 'keys.json'), 'utf8').includes(FAKE_KEY));
    await s.stop();
    servers.splice(servers.indexOf(s), 1);
    for (const k of OWNER_ENV) delete process.env[k];
  }

  // ───────────────────────── Part 2: a fresh home, no key ─────────────────────────
  {
    const home = mkdtempSync(join(tmpdir(), 'pk-cv-fresh-'));
    const dir = mkdtempSync(join(tmpdir(), 'pk-cv-tern-'));
    writeFileSync(join(dir, 'README.md'), '# Tern\n\nPrints tide tables for the harbour office.\n');
    const s = await serve(home, port + 1, { organizing: true });
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
    await b.waitFor(`document.querySelector('#kp-page')?.dataset.page === 'takeover' && document.querySelector('#kp-model') !== null`, { label: 'the new project’s Takeover page', timeout: 30000 });
    await settle(1200);
    const none = await page(`return { key: $('#kp-key').textContent, start: $('#kp-start').disabled, why: $('#kp-start-why')?.textContent, first: $$('#kp-settings > *')[0]?.id, noKeys: $('#kp-no-keys')?.textContent };`);
    numbers.fresh = { none, height: await mainHeight() };
    check('with no usable key the Takeover page says to add one, and Start is off', /no usable key/.test(none.key) && /Add a key/.test(none.key) && none.start === true && /No usable key/.test(none.why ?? ''), none.key.slice(0, 120));
    check('Model provider comes first, saying there is no key yet', none.first === 'kp-model' && /No key yet/.test(none.noKeys ?? ''));
    await shot('fresh-no-key.png');
    await b.clickOn('.kp-depth[data-depth="First picture only"] input');
    await settle(300);
    check('a depth chosen, Start stays off without a key', await page(`return $('#kp-start').disabled && /No usable key/.test($('#kp-start-why').textContent);`));
    // Add the key, choose the key and the model, then Start.
    await selectValue('#kp-add-provider', 'fake');
    await b.clickOn('#kp-add-key', { scroll: true });
    await b.type(FAKE_KEY);
    await b.clickOn('#kp-add-save');
    await b.waitFor(`document.querySelector('#kp-keys tr[data-key="fake~1"]') !== null`, { label: 'the saved key', timeout: 30000 });
    await settle(800);
    await selectValue('#kp-main-key', 'fake~1');
    await settle(100);
    await page(`const m = $('#kp-main-model'); m.value = 'fake-1'; return true;`);
    await b.clickOn('#kp-main-use', { scroll: true });
    await b.waitFor(`/takeover runs on the key/.test(document.querySelector('#kp-key')?.textContent ?? '')`, { label: 'the key named on the Takeover page', timeout: 15000 });
    await settle(500);
    const ready = await page(`return { key: $('#kp-key').textContent, change: Boolean($('#kp-change-key')), depth: $('.kp-depth.selected')?.dataset.depth ?? null };`);
    numbers.fresh.ready = ready;
    check('with the key, the page names the key and model the takeover runs on, and links to change them', /runs on the key fake key with the model fake-1/.test(ready.key) && ready.change, ready.key.slice(0, 160));
    if (!ready.depth) await b.clickOn('.kp-depth[data-depth="First picture only"] input');
    await settle(300);
    check('…and Start can be pressed', await page(`return !$('#kp-start').disabled;`));
    await b.evaluate(`document.querySelector('#main').scrollTop = 0`);
    await shot('fresh-key-chosen-start-ready.png');
    await b.clickOn('#kp-start', { scroll: true });
    await b.waitFor(`document.querySelector('#kp-state')?.textContent !== 'Not taken over'`, { label: 'the takeover started', timeout: 30000 });
    await settle(1500);
    const started = await page(`return $('#kp-state').textContent;`);
    const pid = s.app.workspace.list()[0].id;
    check('Start runs the takeover on the chosen key', /Takeover under way|Daily/.test(started) && s.app.store(pid).jobs.all().some((j) => j.model?.provider === 'fake~1'), started);
    await shot('fresh-takeover-started.png');
    await s.app.clearProject(pid, 'DELETE').catch(() => undefined);
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
