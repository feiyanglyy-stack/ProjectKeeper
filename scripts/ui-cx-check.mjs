// The key order's first row is the main key and is chosen like the others (plan K, CX; Spec §6.10 备用与并行; CKC-03
// AC-35; owner 2026-10-03: 「第二个截图索性第一个也可以自选吧」) — in a real browser. Usage:
//   node scripts/ui-cx-check.mjs <outDir> [--port 4951]
//
// A fresh home on a spare port, with organizing off: nothing runs. The owner's environment keys are stood in for by FAKE
// values under the same variable names; none of them is checked, so no request leaves this machine. Two keys of a test
// double are saved (each checked once, against the double). On `Keeper` → `Model provider` the order "When a key runs out
// of quota or is rate-limited" is used as the owner would: row 1 moved down, row 1's key and model changed there, then
// the main row's `Use` — and each time the main row and the order show the same setting. (The lower rows' own key selects,
// and a key changing places with the row that has it, are checked in ui-cy-check.mjs.)
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './ui-cdp.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const outDir = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) ?? join(tmpdir(), 'pk-cx-shots');
const port = Number(flag('--port', '4951'));
if (port === 4870) throw new Error('4870 is the resident Keeper’s port; choose another');
mkdirSync(outDir, { recursive: true });

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-cx-pi-'));
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
for (const k of Object.keys(process.env)) if (/_API_KEY$|_TOKEN$/.test(k)) delete process.env[k];
for (const k of ['ZAI_CODING_CN_API_KEY', 'ZAI_API_KEY', 'DEEPSEEK_API_KEY']) process.env[k] = `pk-ui-fake-env-${k.toLowerCase()}`;
const { App } = await import('../src/server/app.ts');
const { HttpApp } = await import('../src/server/http.ts');
const { registerRoutes } = await import('../src/server/api.ts');
const { startFakeProvider, FAKE_MODEL } = await import('../src/keeper/fake-provider.ts');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const home = mkdtempSync(join(tmpdir(), 'pk-cx-home-'));
const dir = mkdtempSync(join(tmpdir(), 'pk-cx-tern-'));
writeFileSync(join(dir, 'README.md'), '# Tern\n\nPrints tide tables for the harbour office.\n');
const app = new App(home, { organizing: false });
const http = new HttpApp();
registerRoutes(http, app, join(appRoot, 'ui'), join(appRoot, 'node_modules'));
http.route('GET', '/api/events', ({ res }) => { http.sse.attach(res); });
app.on('event', (event) => http.sse.broadcast('app', event));
app.servedPort = port;
const fake = await startFakeProvider();
await app.initKeeper();
app.keeper.models.registerProvider('fake', { name: 'Test double', baseUrl: fake.url, api: 'openai-completions', models: [FAKE_MODEL] });
const project = app.addProject('Tern', [dir]);
await app.keeper.addKey('fake', 'Double A', 'pk-ui-fake-key-a-51c0e2');
await app.keeper.addKey('fake', 'Double B', 'pk-ui-fake-key-b-7d93f4');
const server = await http.listen(port);
const base = `http://127.0.0.1:${server.port}`;

const b = await launch({ width: 1440, height: 900 });
const page = (body) => b.evaluate(`(async () => { const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)]; ${body} })()`);
const settle = async (ms = 400) => { await sleep(ms); await b.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'); };
const selectValue = (selector, value) => page(`const s = $(${JSON.stringify(selector)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value;`);
const shotOf = async (selector, name) => {
  const r = await page(`const el = $(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'start' }); const r = el.getBoundingClientRect(); return { top: r.top, height: Math.ceil(r.height) };`);
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
/** The order as the page shows it, and the main row above it. */
const shown = () => page(`return {
  order: $$('#kp-backups li[data-backup]').map((l) => l.dataset.backup),
  first: { key: $('#kp-order-main-key')?.value ?? null, model: $('#kp-order-main-model')?.value ?? null, down: $('#kp-backups li[data-main] button[title^="Later"]')?.disabled === false },
  mainRow: { key: $('#kp-main-key').value, model: $('#kp-main-model').value },
};`);
const route = () => app.project(project.id).route;
const waitRoute = async (ok, label) => { for (let t = 0; t < 200 && !ok(route()); t++) await sleep(50); if (!ok(route())) throw new Error(`timed out: ${label}`); await settle(800); };

try {
  app.keeper.setRoute(project.id, { model: { provider: 'zai-coding-cn', id: 'glm-5.3', thinking: 'high' }, backups: [{ provider: 'fake~1', id: 'fake-1', thinking: 'high' }, { provider: 'zai', id: 'glm-5.3', thinking: 'high' }] });
  const sentBefore = fake.requests.length;
  await b.navigate(`${base}/#/p/${encodeURIComponent(project.id)}/keeper`);
  await b.waitFor(`document.querySelector('#kp-backups li[data-main]') !== null`, { label: 'the key order', timeout: 30000 });
  await settle(1000);
  let s = await shown();
  check('row 1 of the order is the main key, with its key and model to choose and ↓ to move it', s.first.key === 'zai-coding-cn' && s.first.model === 'glm-5.3' && s.first.down && s.order.join() === 'zai-coding-cn,fake~1,zai', JSON.stringify(s));
  await shotOf('#kp-backups', 'backup-list-before.png');

  // Row 1 moved down: the test double's first key is the main key now.
  await b.clickOn('#kp-backups li[data-main] button[title^="Later"]', { scroll: true });
  await waitRoute((r) => r?.model?.provider === 'fake~1', 'row 1 moved down');
  await b.waitFor(`document.querySelector('#kp-main-key')?.value === 'fake~1'`, { label: 'the main row redrawn', timeout: 15000 });
  s = await shown();
  check('moved down, row 1 is the next key, and the main row above shows it', s.order.join() === 'fake~1,zai-coding-cn,zai' && s.first.key === 'fake~1' && s.mainRow.key === 'fake~1' && s.mainRow.model === 'fake-1', JSON.stringify(s));
  check('saved as the main model with the main thinking; the old main key is the first backup', route().model.thinking === 'high' && route().backups.map((x) => `${x.provider}/${x.id}`).join() === 'zai-coding-cn/glm-5.3,zai/glm-5.3', JSON.stringify(route()));
  const shot = await shotOf('#kp-backups', 'backup-list-after-moving-row-1-down.png');
  await shotOf('#kp-route', 'route-after-moving-row-1-down.png');

  // Row 1's key changed there: Z.ai is the main key; its model then changed there too.
  await selectValue('#kp-order-main-key', 'zai');
  await waitRoute((r) => r?.model?.provider === 'zai', 'row 1’s key changed');
  s = await shown();
  check('row 1’s key chosen there is the main key; the main row shows it; it changed places with the key that was there', s.mainRow.key === 'zai' && s.order.join() === 'zai,zai-coding-cn,fake~1' && s.mainRow.model === 'glm-5.3', JSON.stringify(s));
  const other = await page(`return [...$('#kp-order-main-model').options].map((o) => o.value).find((v) => v !== 'glm-5.3') ?? null;`);
  await selectValue('#kp-order-main-model', other);
  await waitRoute((r) => r?.model?.id === other, 'row 1’s model changed');
  await b.waitFor(`document.querySelector('#kp-main-model')?.value === ${JSON.stringify(other)}`, { label: 'the main row’s model', timeout: 15000 });
  s = await shown();
  check(`row 1’s model changed there (${other}) shows in the main row`, s.mainRow.model === other && s.first.model === other, JSON.stringify(s));

  // The main row's Use: the order's row 1 follows.
  await selectValue('#kp-main-key', 'fake~2');
  await settle(100);
  await page(`$('#kp-main-model').value = 'fake-1'; return true;`);
  await b.clickOn('#kp-main-use', { scroll: true });
  await waitRoute((r) => r?.model?.provider === 'fake~2', 'the main row’s Use');
  await b.waitFor(`document.querySelector('#kp-order-main-key')?.value === 'fake~2'`, { label: 'the order redrawn', timeout: 15000 });
  s = await shown();
  check('the main row’s Use shows in the order’s row 1', s.first.key === 'fake~2' && s.order[0] === 'fake~2', JSON.stringify(s));
  await shotOf('#kp-backups', 'backup-list-after-main-row-use.png');
  check('nothing was sent to any provider but the two keys’ one-token checks', fake.requests.length - sentBefore === 0, `${fake.requests.length - sentBefore} requests after the checks`);
  console.log(`screenshot: ${shot}`);
} catch (e) {
  check('the check ran to its end', false, e.stack ?? String(e));
} finally {
  if (b.consoleLines.length) console.log(`console:\n${b.consoleLines.slice(0, 20).join('\n')}`);
  check('no error in the browser console', b.consoleLines.filter((l) => !/favicon|ERR_ABORTED/.test(l)).length === 0, b.consoleLines.slice(0, 3).join(' | '));
  await Promise.race([b.navigate('about:blank'), sleep(1000)]).catch(() => undefined);
  await b.close();
  app.stopAll();
  await app.flushAll();
  fake.close();
  await Promise.race([server.close(), sleep(2000)]);
}
writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed; screenshots in ${outDir}`);
process.exit(failed.length ? 1 : 0);
