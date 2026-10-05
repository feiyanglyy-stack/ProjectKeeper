/**
 * The demo: an invented project, "Papertrail" (a one-person read-later list), already organized, opened in the
 * workbench. No key, no model and no network: the Keeper's answers come from a local stand-in.
 *
 *   npm run demo                         build it and serve it at http://127.0.0.1:4880/
 *   npm run demo -- --port 5000          on another port
 *   npm run demo -- --dir <directory>    build it there instead of the system's temporary directory
 *
 * Everything the demo writes goes under one directory (`projectkeeper-demo` in the system's temporary directory unless
 * `--dir` names another), which is emptied and built again on every run: the workbench's own home, the invented
 * project with its git history and two worktrees, and an empty directory for the model library's settings — so
 * nothing of your own ProjectKeeper home, your projects, your logins or your keys is read or changed.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { canonicalPath } from '../src/util/paths.ts';   // node built-ins only: nothing of the workbench is loaded yet

const flag = (name: string): string | null => { const i = process.argv.indexOf(name); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };
const port = Number(flag('--port') ?? 4880);
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('usage: npm run demo -- [--port <number>] [--dir <directory>]'); process.exit(2); }
const free = await new Promise<boolean>((done) => {
  const probe = createServer();
  probe.once('error', () => done(false));
  probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
});
if (!free) { console.error(`Port ${port} is in use; choose another: npm run demo -- --port <number>`); process.exit(1); }

const MARK = '.projectkeeper-demo';
const given = resolve(flag('--dir') ?? join(tmpdir(), 'projectkeeper-demo'));
// Only a directory this script made (or an empty one) is ever emptied.
if (existsSync(given) && readdirSync(given).length > 0 && !existsSync(join(given, MARK))) {
  console.error(`${given} is not empty and was not made by this demo; name another directory with --dir.`);
  process.exit(2);
}
rmSync(given, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(given, { recursive: true });
// From here on the directory goes by the file system's own spelling. The system's temporary directory is often given
// in another one — on Windows a short name (C:\Users\LONGNA~1\…) whenever the user name is longer than eight
// characters or has a space in it — and git reports the project's repository and worktrees in the real one.
const dir = canonicalPath(given);
writeFileSync(join(dir, MARK), 'Made by `npm run demo`; emptied and built again on every run.\n');

const home = join(dir, 'home');
// The model library's own directory, empty: no login and no saved key. And no key from the environment either.
process.env.PI_CODING_AGENT_DIR = join(dir, 'pi-agent');
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
for (const name of Object.keys(process.env)) if (/(?:^|_)(?:KEY|APIKEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i.test(name)) delete process.env[name];

// Loaded only now, after the environment is set.
const { seedUiFixture } = await import('./seed-ui-fixture.ts');
console.log('Building the demo project (a few seconds)…');
const seeded = await seedUiFixture(home, { projectDir: join(dir, 'papertrail'), name: 'Papertrail' });
console.log(`Papertrail: ${seeded.counts.nodes} objects on the graph, ${seeded.counts.workItems} work items, ${seeded.counts.notes} notes — built in ${dir}`);

// Served the way `pk serve --fake-provider` serves a home (src/cli.ts), with automatic organizing off: the demo shows
// what an organized project looks like and answers in the conversation, and starts no round of its own.
const { App } = await import('../src/server/app.ts');
const { HttpApp } = await import('../src/server/http.ts');
const { registerRoutes } = await import('../src/server/api.ts');
const { vendorDir } = await import('../src/server/vendor.ts');
const appRoot = resolve(import.meta.dirname, '..');
const app = new App(home, { organizing: false });
// Three planted jobs show how a queued, a running and a quota-waiting job look on a home nothing serves. A served home
// would take them up and fail them for having no task, so the demo leaves them out.
for (const id of ['job_org_queued', 'job_org_running', 'job_quota']) app.store(seeded.projectId).jobs.remove(id);
const http = new HttpApp();
registerRoutes(http, app, join(appRoot, 'ui'), vendorDir(appRoot));
http.route('GET', '/api/events', ({ res }) => { http.sse.attach(res); });
app.on('event', (event) => http.sse.broadcast('app', event));
app.servedPort = port;
await app.initKeeper({ fakeProvider: true });
const server = await http.listen(port);
const stop = async () => { app.stopAll(); await app.flushAll(); await server.close(); process.exit(0); };
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
console.log(`\nThe demo is open at http://127.0.0.1:${server.port}/#/p/${seeded.projectId}/graph   (Ctrl+C stops it)`);
