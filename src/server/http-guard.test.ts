/**
 * Who the workbench answers (http.ts `refusal`; SECURITY.md "a web page in the user's browser being able to drive it").
 * Against a listening server, with the headers each caller really sends written out:
 *
 *   - refused: a request made to another name than the workbench's own local address (what a page sends whose own
 *     name was made to resolve to 127.0.0.1), a request another origin's page makes (`Origin`, `Sec-Fetch-Site`), a
 *     post that is not `application/json` (the only kind a page can send elsewhere without the browser asking first);
 *   - answered: the three spellings of the local address, a program that sends no `Origin` (`pk`, Node's `fetch`), the
 *     workbench's own pages, an address typed or a link followed to a page of the workbench.
 *
 * The last tests are the real API under a temporary home: what was open before this check is closed where it was found.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from '../util/tmp.test-helpers.ts';

const scratch = mkdtempSync(join(tmpdir(), 'pk-http-guard-'));
process.env.PI_CODING_AGENT_DIR = join(scratch, 'pi-agent');
after(() => { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const { HttpApp } = await import('./http.ts');
const { App } = await import('./app.ts');
const { registerRoutes } = await import('./api.ts');

const SENTENCE = /^The ProjectKeeper workbench answers only at its own local address, http:\/\/127\.0\.0\.1:\d+\/, and only to its own pages\.\n$/;

interface Answer { status: number; type: string; text: string }

/** One request with exactly these headers; `Host` is the server's own address unless the test gives another. */
function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> {
  return new Promise((resolvePromise, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers, ...(body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(body)) }) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Bytes as written, for what `node:http` will not send: HTTP/1.0, and a request with no `Host` line. */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(text));
    let got = '';
    socket.on('data', (c) => { got += c; });
    socket.on('close', () => resolvePromise(got));
    socket.on('error', reject);
  });
}

/** A server with a route that reads, a route that changes something, the event stream and one static page. */
async function small() {
  const pages = mkdtempSync(join(scratch, 'pages-'));
  writeFileSync(join(pages, 'index.html'), '<!doctype html><title>Tern</title>');
  const http = new HttpApp();
  const seen = { reads: 0, posts: [] as unknown[] };
  http.route('GET', '/api/tides', () => { seen.reads++; return { tide: 'ebb' }; });
  http.route('POST', '/api/tides', ({ body }) => { seen.posts.push(body ?? null); return { ok: true }; });
  http.route('GET', '/api/events', ({ res }) => { http.sse.attach(res); });
  http.static('/', pages);
  const server = await http.listen(0);
  const port = server.port;
  const refused = (a: Answer, why: string) => {
    assert.equal(a.status, 403, why);
    assert.match(a.type, /^text\/plain/, why);
    assert.match(a.text, SENTENCE, why);
    assert.ok(a.text.includes(`http://127.0.0.1:${port}/`), 'the sentence names the address that does answer');
  };
  return { http, port, seen, refused, here: `127.0.0.1:${port}`, close: server.close };
}

const JSON_TYPE = { 'Content-Type': 'application/json' };

test('a request line that is no path is checked like any other before it is answered as that', async () => {
  const s = await small();
  try {
    // `//` is not a URL (http.test.ts), so it has no path to tell a page of the workbench from its API by.
    const link = 'Sec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: document\r\n';
    const none = await raw(s.port, `GET // HTTP/1.1\r\nHost: ${s.here}\r\nConnection: close\r\n\r\n`);
    assert.match(none, /^HTTP\/1\.1 400 /, none);
    assert.ok(none.includes('The request names no path.'), none);
    const foreign = await raw(s.port, `GET // HTTP/1.1\r\nHost: attacker.example\r\n${link}Connection: close\r\n\r\n`);
    assert.match(foreign, /^HTTP\/1\.1 403 /, foreign);
    const followed = await raw(s.port, `GET // HTTP/1.1\r\nHost: ${s.here}\r\n${link}Connection: close\r\n\r\n`);
    assert.match(followed, /^HTTP\/1\.1 403 /, followed);
    assert.equal((await send(s.port, 'GET', '/api/tides')).status, 200, 'still answering');
  } finally { await s.close(); }
});

test('a request made to another name than the local address is refused: a route, a page, the event stream', async () => {
  const s = await small();
  try {
    for (const host of [
      `attacker.example:${s.port}`,              // a page whose own name was made to resolve to 127.0.0.1
      'attacker.example',
      `127.0.0.1.attacker.example:${s.port}`,
      `localhost.:${s.port}`,
      `127.0.0.1:${s.port + 1}`,                 // the right name, another port
      '127.0.0.1',                               // no port: that is port 80
      `192.168.0.10:${s.port}`,
      `user@127.0.0.1:${s.port}`,
    ]) {
      s.refused(await send(s.port, 'GET', '/api/tides', { Host: host }), `GET a route as ${host}`);
      s.refused(await send(s.port, 'GET', '/', { Host: host }), `GET a page as ${host}`);
      s.refused(await send(s.port, 'GET', '/api/events', { Host: host }), `the event stream as ${host}`);
      s.refused(await send(s.port, 'GET', '/nothing-here', { Host: host }), `what does not exist as ${host}: refused, not "not found"`);
      s.refused(await send(s.port, 'POST', '/api/tides', { Host: host, ...JSON_TYPE }, '{"tide":"flood"}'), `POST as ${host}`);
    }
    assert.deepEqual(s.seen, { reads: 0, posts: [] }, 'no handler ran');
    const text = (await send(s.port, 'GET', '/api/tides', { Host: `attacker.example:${s.port}` })).text;
    assert.ok(!text.includes('attacker'), 'nothing of the request is repeated in the answer');
  } finally { await s.close(); }
});

test('a request with no Host is refused: HTTP/1.0 reaches the check, HTTP/1.1 is turned away by Node before it', async () => {
  const s = await small();
  try {
    const old = await raw(s.port, 'GET /api/tides HTTP/1.0\r\n\r\n');
    assert.match(old, /^HTTP\/1\.1 403 /, old);
    assert.ok(old.includes('answers only at its own local address'), old);
    const oldWithHost = await raw(s.port, `GET /api/tides HTTP/1.0\r\nHost: ${s.here}\r\n\r\n`);
    assert.match(oldWithHost, /^HTTP\/1\.1 200 /, 'HTTP/1.0 that names the local address is answered');
    const bare = await raw(s.port, 'GET /api/tides HTTP/1.1\r\nConnection: close\r\n\r\n');
    assert.match(bare, /^HTTP\/1\.1 400 /, bare);
    assert.equal(s.seen.reads, 1, 'only the request that named the local address was carried out');
  } finally { await s.close(); }
});

test('the three spellings of the local address are answered, in any case of letters', async () => {
  const s = await small();
  try {
    for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, `[::1]:${s.port}`, `LOCALHOST:${s.port}`]) {
      const a = await send(s.port, 'GET', '/api/tides', { Host: host });
      assert.equal(a.status, 200, host);
      assert.deepEqual(JSON.parse(a.text), { tide: 'ebb' });
      assert.equal((await send(s.port, 'GET', '/', { Host: host })).status, 200, `the page as ${host}`);
      // The workbench's own page, opened under that spelling, posting.
      const p = await send(s.port, 'POST', '/api/tides', { Host: host, Origin: `http://${host.toLowerCase()}`, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', ...JSON_TYPE }, '{"tide":"flood"}');
      assert.equal(p.status, 200, `a post from the page at ${host}`);
    }
    assert.equal(s.seen.reads, 4);
    assert.equal(s.seen.posts.length, 4);
  } finally { await s.close(); }
});

test('a request that carries an Origin is answered only when the origin is the address it was sent to', async () => {
  const s = await small();
  try {
    for (const origin of [
      'http://attacker.example',
      `http://attacker.example:${s.port}`,
      'null',                                    // a sandboxed frame, a file opened from disk
      `https://${s.here}`,                       // the right address, another scheme
      `http://localhost:${s.port + 1}`,          // another program's page on this machine: same site, another origin
      `http://localhost:${s.port}`,              // a page opened as localhost asking 127.0.0.1: two origins
      `http://${s.here}.attacker.example`,
      '',
    ]) {
      s.refused(await send(s.port, 'POST', '/api/tides', { Origin: origin, ...JSON_TYPE }, '{"tide":"flood"}'), `POST from ${origin || '(empty)'}`);
      s.refused(await send(s.port, 'GET', '/api/tides', { Origin: origin }), `GET from ${origin || '(empty)'}`);
      s.refused(await send(s.port, 'GET', '/api/events', { Origin: origin }), `the event stream from ${origin || '(empty)'}`);
    }
    assert.deepEqual(s.seen, { reads: 0, posts: [] }, 'no handler ran');
    assert.equal((await send(s.port, 'GET', '/api/tides', { Origin: `http://${s.here}` })).status, 200, 'its own origin');
    assert.equal((await send(s.port, 'GET', '/api/tides')).status, 200, 'no Origin: a program, or a page reading its own server');
  } finally { await s.close(); }
});

test("what the browser says of where a request comes from: another site's page is refused, a followed link to a page is not", async () => {
  const s = await small();
  try {
    const from = (site: string, mode: string, dest: string) => ({ 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': mode, 'Sec-Fetch-Dest': dest });
    for (const site of ['cross-site', 'same-site']) {
      // What carries no Origin: an image, a script, a frame, a link that names the API.
      s.refused(await send(s.port, 'GET', '/api/tides', from(site, 'no-cors', 'image')), `${site}: an image pointed at a route`);
      s.refused(await send(s.port, 'GET', '/api/tides', from(site, 'no-cors', 'script')), `${site}: a script pointed at a route`);
      s.refused(await send(s.port, 'GET', '/', from(site, 'navigate', 'iframe')), `${site}: the workbench in a frame of another page`);
      s.refused(await send(s.port, 'GET', '/', from(site, 'no-cors', 'empty')), `${site}: a page fetched without being opened`);
      s.refused(await send(s.port, 'GET', '/api/tides', from(site, 'navigate', 'document')), `${site}: a link that names the API`);
      s.refused(await send(s.port, 'GET', '/api', from(site, 'navigate', 'document')), `${site}: a link that names the API's root`);
      s.refused(await send(s.port, 'POST', '/api/tides', from(site, 'navigate', 'document')), `${site}: a form with nothing in it`);
      s.refused(await send(s.port, 'POST', '/', from(site, 'navigate', 'document')), `${site}: a form posted to a page`);
      const link = await send(s.port, 'GET', '/', from(site, 'navigate', 'document'));
      assert.equal(link.status, 200, `${site}: a link followed to the workbench opens it`);
      assert.match(link.text, /Tern/);
    }
    s.refused(await send(s.port, 'GET', '/api/tides', from('some-new-word', 'cors', 'empty')), 'a value this check does not know is not taken for its own page');
    assert.deepEqual(s.seen, { reads: 0, posts: [] }, 'no handler ran');
    assert.equal((await send(s.port, 'GET', '/api/tides', from('same-origin', 'cors', 'empty'))).status, 200, "the workbench's own page");
    assert.equal((await send(s.port, 'GET', '/api/tides', from('none', 'navigate', 'document'))).status, 200, 'an address typed into the browser');
    assert.equal((await send(s.port, 'GET', '/', from('none', 'navigate', 'document'))).status, 200, 'the workbench opened from a bookmark or a terminal');
    const events = await new Promise<Answer>((resolvePromise, reject) => {
      const req = request({ host: '127.0.0.1', port: s.port, path: '/api/events', headers: { Host: s.here, ...from('same-origin', 'cors', 'empty') } }, (res) => {
        resolvePromise({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), text: '' });
        res.destroy();
      });
      req.on('error', reject);
      req.end();
    });
    assert.deepEqual([events.status, events.type], [200, 'text/event-stream'], "the event stream opens for the workbench's own page");
  } finally { await s.close(); }
});

test('a request with a body is carried out only as application/json', async () => {
  const s = await small();
  try {
    const body = '{"tide":"flood"}';
    for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', 'text/json', null]) {
      const a = await send(s.port, 'POST', '/api/tides', type === null ? {} : { 'Content-Type': type }, body);
      assert.equal(a.status, 415, `a post sent as ${type ?? 'nothing'}`);
      assert.equal(a.text, 'A request with a body must be sent as application/json.\n');
    }
    // A body sent in pieces declares no length.
    const chunked = await new Promise<number>((resolvePromise, reject) => {
      const req = request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/api/tides', headers: { Host: s.here, 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked' } }, (res) => { res.resume(); resolvePromise(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(chunked, 415, 'a body sent in pieces');
    assert.equal((await send(s.port, 'GET', '/api/tides', { 'Content-Type': 'text/plain' }, body)).status, 415, 'a GET that carries a body');
    assert.deepEqual(s.seen, { reads: 0, posts: [] }, 'no handler ran');

    for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON']) {
      assert.equal((await send(s.port, 'POST', '/api/tides', { 'Content-Type': type }, body)).status, 200, type);
    }
    assert.equal((await send(s.port, 'POST', '/api/tides')).status, 200, 'a post with no body needs no type');
    assert.equal((await send(s.port, 'POST', '/api/tides', { 'Content-Type': 'text/plain' })).status, 200, 'nor does its type matter: there is nothing to read');
    assert.deepEqual(s.seen.posts, [{ tide: 'flood' }, { tide: 'flood' }, { tide: 'flood' }, null, null]);
  } finally { await s.close(); }
});

test("Node's own fetch, as the tests and the check scripts call the workbench, is answered", async () => {
  const s = await small();
  try {
    const base = `http://127.0.0.1:${s.port}`;
    assert.deepEqual(await (await fetch(`${base}/api/tides`)).json(), { tide: 'ebb' });
    assert.deepEqual(await (await fetch(`http://localhost:${s.port}/api/tides`)).json(), { tide: 'ebb' });
    assert.equal((await fetch(`${base}/api/tides`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"tide":"flood"}' })).status, 200);
    assert.equal((await fetch(`${base}/api/tides`, { method: 'POST' })).status, 200);
    // Node gives a string body the type text/plain when none is named: the caller has to say what it sends.
    assert.equal((await fetch(`${base}/api/tides`, { method: 'POST', body: '{"tide":"flood"}' })).status, 415);
    assert.equal((await fetch(`${base}/`)).status, 200);
  } finally { await s.close(); }
});

const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));

function pk(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PROJECTKEEPER_HOME: join(scratch, 'pk-home') }, windowsHide: true });
    let out = '';
    let err = '';
    const killer = setTimeout(() => child.kill('SIGTERM'), 60_000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => { clearTimeout(killer); resolvePromise({ code: code ?? 1, out, err }); });
  });
}

test('pk, the real command, reads from the workbench and posts to it', { timeout: 180_000 }, async () => {
  const http = new HttpApp();
  const asked: unknown[] = [];
  http.route('GET', '/api/resolve', () => ({ projectId: null, message: 'No project of this workbench lives in that directory.' }));
  http.route('POST', '/api/projects/:id/ask', ({ params, body }) => { asked.push({ id: params.id, body }); return { known: 'The tide table is read at dawn.', investigation: { jobId: 'job_tern', thread: 'thr_tern', status: 'Queued' } }; });
  const server = await http.listen(0);
  try {
    const home = join(scratch, 'pk-home');
    const read = await pk(['ask', '--home', home, '--port', String(server.port), '--cwd', scratch, 'When is the tide table read?']);
    assert.equal(read.code, 4, read.err);
    assert.match(read.out, /No project of this workbench lives in that directory\./);
    const post = await pk(['ask', '--home', home, '--port', String(server.port), '--project', 'tern', 'When is the tide table read?']);
    assert.equal(post.code, 0, post.err);
    assert.match(post.out, /The tide table is read at dawn\./);
    assert.deepEqual(asked, [{ id: 'tern', body: { question: 'When is the tide table read?', thread: null } }]);
  } finally { await server.close(); }
});

// ───────────────────────── the real API: what was open before ─────────────────────────

async function workbench() {
  const home = mkdtempSync(join(scratch, 'home-'));
  const dir = mkdtempSync(join(scratch, 'petrel-'));
  const app = new App(home, { organizing: false });
  const http = new HttpApp();
  registerRoutes(http, app, '', '');
  http.route('GET', '/api/events', ({ res }) => { http.sse.attach(res); });
  const server = await http.listen(0);
  return { app, dir, port: server.port, close: async () => { app.stopAll(); await server.close(); } };
}

test("the workspace is not read out to a page under another name, and another site's post adds no project", async () => {
  const w = await workbench();
  try {
    const body = JSON.stringify({ name: 'Petrel', locations: [w.dir] });
    // A page whose name resolves to 127.0.0.1 reads the API as its own.
    const read = await send(w.port, 'GET', '/api/workspace', { Host: `attacker.example:${w.port}`, Origin: `http://attacker.example:${w.port}` });
    assert.equal(read.status, 403);
    assert.ok(!read.text.includes('home') && !read.text.includes('projects'), read.text);
    // Any page posts a form or plain text to another origin without the browser asking first.
    const blind = await send(w.port, 'POST', '/api/projects', { Origin: 'http://attacker.example', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'empty', 'Content-Type': 'text/plain' }, body);
    assert.equal(blind.status, 403);
    // The same post from a browser that sends neither header, or through anything that drops them.
    const untyped = await send(w.port, 'POST', '/api/projects', { 'Content-Type': 'text/plain' }, body);
    assert.equal(untyped.status, 415);
    // And as JSON from another origin: the browser asks first (OPTIONS), and the post itself is refused as well.
    const asked = await send(w.port, 'OPTIONS', '/api/projects', { Origin: 'http://attacker.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' });
    assert.equal(asked.status, 403);
    const typed = await send(w.port, 'POST', '/api/projects', { Origin: 'http://attacker.example', 'Content-Type': 'application/json' }, body);
    assert.equal(typed.status, 403);
    assert.equal(w.app.workspace.list().length, 0, 'no project was added');

    // The workbench's own page adds it.
    const own = await send(w.port, 'POST', '/api/projects', { Origin: `http://127.0.0.1:${w.port}`, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', 'Content-Type': 'application/json' }, body);
    assert.equal(own.status, 200, own.text);
    assert.deepEqual(w.app.workspace.list().map((p) => p.name), ['Petrel']);
    const listed = await send(w.port, 'GET', '/api/workspace', { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' });
    assert.deepEqual((JSON.parse(listed.text) as { projects: { name: string }[] }).projects.map((p) => p.name), ['Petrel']);
  } finally { await w.close(); }
});

test('no answer carries a header that would let another origin read it', async () => {
  const w = await workbench();
  try {
    for (const headers of [{}, { Origin: `http://127.0.0.1:${w.port}` }, { Origin: 'http://attacker.example' }] as Record<string, string>[]) {
      const allowed = await new Promise<string[]>((resolvePromise, reject) => {
        const req = request({ host: '127.0.0.1', port: w.port, path: '/api/workspace', headers: { Host: `127.0.0.1:${w.port}`, ...headers } }, (res) => { res.resume(); resolvePromise(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))); });
        req.on('error', reject);
        req.end();
      });
      assert.deepEqual(allowed, []);
    }
  } finally { await w.close(); }
});
