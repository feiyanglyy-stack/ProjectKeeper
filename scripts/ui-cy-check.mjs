// Every row of the key order chooses its key and its model, like the first (plan K, CY; Spec §6.10 备用与并行; CKC-03
// AC-35; owner 2026-10-03: 「不过既然可以detailed made顺序，下面也应该可以选provider和model。」) — in a real browser. Usage:
//   node scripts/ui-cy-check.mjs <outDir> [--port 4952]
//
// A fresh home on a spare port, with organizing off: nothing runs. The owner's environment keys are stood in for by FAKE
// values under the same variable names; none of them is checked, so no request leaves this machine. Two keys of a test
// double are saved (each checked once, against the double). On `Keeper` → `Model provider` the order "When a key runs out
// of quota or is rate-limited" is used as the owner would: row 2's key changed to a key outside the order, to the key of
// row 3 (they change places), to the key of row 1 (the other becomes the main key, and the main row above shows it), a
// lower row's model changed, and a key added at the bottom. DA: then the main row's `Use` with the key of a lower row —
// the two rows change places and the old main key stays in the order.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './ui-cdp.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const outDir = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) ?? join(tmpdir(), 'pk-cy-shots');
const port = Number(flag('--port', '4952'));
if (port === 4870) throw new Error('4870 is the resident Keeper’s port; choose another');
mkdirSync(outDir, { recursive: true });

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-cy-pi-'));
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
for (const k of Object.keys(process.env)) if (/_API_KEY$|_TOKEN$/.test(k)) delete process.env[k];
for (const k of ['ZAI_CODING_CN_API_KEY', 'DEEPSEEK_API_KEY']) process.env[k] = `pk-ui-fake-env-${k.toLowerCase()}`;
const { App } = await import('../src/server/app.ts');
const { HttpApp } = await import('../src/server/http.ts');
const { registerRoutes } = await import('../src/server/api.ts');
const { startFakeProvider, FAKE_MODEL } = await import('../src/keeper/fake-provider.ts');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const home = mkdtempSync(join(tmpdir(), 'pk-cy-home-'));
const dir = mkdtempSync(join(tmpdir(), 'pk-cy-tern-'));
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
const selectValue = (selector, value) => page(`const s = $(${JSON.stringify(selector)}); s.scrollIntoView({ block: 'center' }); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value;`);
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
/** The order as the page shows it — each row's key and model, and the keys its select offers — and the main row above it. */
const shown = () => page(`return {
  rows: $$('#kp-backups li[data-backup]').map((l) => ({ at: l.dataset.backup, key: $('select.kp-order-key', l)?.value ?? null, model: $('select.kp-order-model', l)?.value ?? null, offers: [...($('select.kp-order-key', l)?.options ?? [])].map((o) => o.value), fixedName: $('b', l) !== null, buttons: $$('button', l).map((x) => x.textContent).join('') })),
  mainRow: { key: $('#kp-main-key').value, model: $('#kp-main-model').value },
  add: [...$('#kp-backup-add').options].map((o) => o.value).filter(Boolean),
};`);
const orderOf = (s) => s.rows.map((r) => `${r.key}/${r.model}`).join(' ');
const rowKey = (n) => `#kp-backups li[data-backup]:nth-of-type(${n}) select.kp-order-key`;
const rowModel = (n) => `#kp-backups li[data-backup]:nth-of-type(${n}) select.kp-order-model`;
const route = () => app.project(project.id).route;
const saved = () => [route().model, ...route().backups].map((x) => `${x.provider}/${x.id}`).join(' ');
const waitOrder = async (want, label) => {
  for (let t = 0; t < 200 && saved() !== want; t++) await sleep(50);
  if (saved() !== want) throw new Error(`timed out: ${label} — saved ${saved()}, wanted ${want}`);
  await b.waitFor(`[...document.querySelectorAll('#kp-backups li[data-backup]')].map((l) => l.dataset.backup).join(' ') === ${JSON.stringify(want.split(' ').map((x) => x.split('/')[0]).join(' '))}`, { label: `${label}: the order redrawn`, timeout: 15000 });
  await settle(600);
};

try {
  const keys = await app.keeper.keysView();
  const deepseek = keys.find((k) => k.id === 'deepseek');
  const glm = keys.find((k) => k.id === 'zai-coding-cn');
  const ds = deepseek.models[0].id;
  app.keeper.setRoute(project.id, { model: { provider: 'zai-coding-cn', id: 'glm-5.3', thinking: 'high' }, backups: [{ provider: 'fake~1', id: 'fake-1', thinking: 'high' }, { provider: 'deepseek', id: ds, thinking: 'high' }] });
  const sentBefore = fake.requests.length;
  await b.navigate(`${base}/#/p/${encodeURIComponent(project.id)}/keeper`);
  await b.waitFor(`document.querySelector('#kp-backups li[data-main]') !== null`, { label: 'the key order', timeout: 30000 });
  await settle(1000);
  let s = await shown();
  const all = ['zai-coding-cn', 'deepseek', 'fake~1', 'fake~2'];
  check('every row has a key select and a model select; no row shows its key as fixed text', s.rows.length === 3 && s.rows.every((r) => r.key === r.at && r.model && !r.fixedName && r.buttons === '↑↓×'), JSON.stringify(s.rows.map((r) => [r.at, r.key, r.model, r.fixedName, r.buttons])));
  check('each row’s key select offers every usable key, those of the other rows too', s.rows.every((r) => all.every((k) => r.offers.includes(k))), JSON.stringify(s.rows.map((r) => r.offers)));
  check('the add select at the bottom offers the key outside the order', s.add.join() === 'fake~2', s.add.join());
  await shotOf('#kp-backups', 'key-order-before.png');

  // Row 2's key changed to a key outside the order: it takes the row; Double A leaves the order.
  await selectValue(rowKey(2), 'fake~2');
  await waitOrder(`zai-coding-cn/glm-5.3 fake~2/fake-1 deepseek/${ds}`, 'row 2 to an unused key');
  s = await shown();
  check('row 2’s key changed to an unused key: it takes the row, on a model it carries; the key that was there can be added again', orderOf(s) === `zai-coding-cn/glm-5.3 fake~2/fake-1 deepseek/${ds}` && s.add.join() === 'fake~1' && s.mainRow.key === 'zai-coding-cn', JSON.stringify({ order: orderOf(s), add: s.add, main: s.mainRow }));

  // Row 2's key changed to the key of row 3: they change places, each on its model.
  await selectValue(rowKey(2), 'deepseek');
  await waitOrder(`zai-coding-cn/glm-5.3 deepseek/${ds} fake~2/fake-1`, 'row 2 to the key of row 3');
  s = await shown();
  check('row 2’s key changed to the key of row 3: the two rows change places; no key is listed twice; the main key is as it was', orderOf(s) === `zai-coding-cn/glm-5.3 deepseek/${ds} fake~2/fake-1` && new Set(s.rows.map((r) => r.key)).size === 3 && s.mainRow.key === 'zai-coding-cn', JSON.stringify({ order: orderOf(s), main: s.mainRow }));
  await shotOf('#kp-backups', 'key-order-after-rows-2-and-3-changed-places.png');

  // Row 2's key changed to the key of row 1: DeepSeek is the main key, and the main row above shows it.
  await selectValue(rowKey(2), 'zai-coding-cn');
  await waitOrder(`deepseek/${ds} zai-coding-cn/glm-5.3 fake~2/fake-1`, 'row 2 to the key of row 1');
  await b.waitFor(`document.querySelector('#kp-main-key')?.value === 'deepseek'`, { label: 'the main row redrawn', timeout: 15000 });
  s = await shown();
  check('row 2’s key changed to the key of row 1: they change places, and the main row above shows the new main key and its model', orderOf(s) === `deepseek/${ds} zai-coding-cn/glm-5.3 fake~2/fake-1` && s.mainRow.key === 'deepseek' && s.mainRow.model === ds, JSON.stringify({ order: orderOf(s), main: s.mainRow }));
  check('saved as the main model, with the main thinking', route().model.provider === 'deepseek' && route().model.thinking === 'high', JSON.stringify(route().model));
  await shotOf('#kp-route', 'route-after-row-2-took-the-main-key.png');

  // A lower row's model, chosen there.
  const other = glm.models.map((m) => m.id).find((id) => id !== 'glm-5.3');
  await selectValue(rowModel(2), other);
  await waitOrder(`deepseek/${ds} zai-coding-cn/${other} fake~2/fake-1`, 'row 2’s model');
  s = await shown();
  check(`row 2’s model changed there (${other}); the main row is as it was`, s.rows[1].model === other && s.mainRow.key === 'deepseek' && s.mainRow.model === ds, JSON.stringify({ order: orderOf(s), main: s.mainRow }));

  // The add select at the bottom still adds a row.
  await selectValue('#kp-backup-add', 'fake~1');
  await waitOrder(`deepseek/${ds} zai-coding-cn/${other} fake~2/fake-1 fake~1/fake-1`, 'a key added at the bottom');
  s = await shown();
  check('the add select adds a row at the end, with its own key and model selects', s.rows.length === 4 && s.rows[3].key === 'fake~1' && s.rows[3].model === 'fake-1' && s.add.length === 0, JSON.stringify({ order: orderOf(s), add: s.add }));
  // DA: the main row's `Use` with a key that sits in a lower row of the order — the two rows change places, as the list's
  // own select does; before, the old main key left the order.
  await selectValue('#kp-main-key', 'fake~2');
  await page(`$('#kp-main-use').click(); return true;`);
  await waitOrder(`fake~2/fake-1 zai-coding-cn/${other} deepseek/${ds} fake~1/fake-1`, 'the main row’s Use with the key of row 3');
  await b.waitFor(`document.querySelector('#kp-main-key')?.value === 'fake~2'`, { label: 'the main row redrawn', timeout: 15000 });
  s = await shown();
  check('the main row’s Use with the key of a lower row: the two rows change places, and the old main key stays in the order', orderOf(s) === `fake~2/fake-1 zai-coding-cn/${other} deepseek/${ds} fake~1/fake-1` && s.rows.length === 4 && s.mainRow.key === 'fake~2' && route().model.thinking === 'high', JSON.stringify({ order: orderOf(s), main: s.mainRow, saved: saved() }));
  const shot = await shotOf('#kp-backups', 'key-order.png');
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
