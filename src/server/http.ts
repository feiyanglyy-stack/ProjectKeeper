/**
 * Minimal HTTP layer: JSON routes, server-sent events, static files. Bound to 127.0.0.1, and answering only requests
 * made to that local address by the workbench's own pages or by a program on this machine (`refusal` below).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly body: unknown;
}
export type Handler = (ctx: RouteContext) => unknown | Promise<unknown>;

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

// ───────────────────────── who is answered ─────────────────────────
//
// Listening on 127.0.0.1 keeps other machines out. It does not keep out a web page open in this machine's browser: the
// browser will send a request to a local port for any page that asks. Its same-origin rule hides the answer from that
// page, but the request has been carried out by then, and a page whose own name is made to resolve to 127.0.0.1 ("DNS
// rebinding") counts as the same origin and reads the answers too. So every request, to a route or to a file, is
// checked before anything is done with it. There is no login: a program running on this machine as the user is
// answered, as docs/privacy.md says. There is no setting that widens this.

/** The names a browser on this machine can reach the workbench by. A name of the user's own (a hosts-file alias, a
 *  proxy in front) is not among them: nothing tells such a name from one an outside page made up. */
const LOCAL_NAMES = ['127.0.0.1', 'localhost', '[::1]'];

/** `Host` as the workbench's own address is written for the port a request arrived on (a browser leaves `:80` out). */
function localHosts(port: number | undefined): string[] {
  return LOCAL_NAMES.flatMap((name) => (port === 80 ? [name, `${name}:80`] : [`${name}:${port}`]));
}

const one = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/**
 * Why a request is not answered, or null when it is. In order:
 *
 *  - `Host` has to be the workbench's own local address with the port the request arrived on. A page reaching this
 *    port under a name of its own sends that name. HTTP/1.0 may send no `Host` at all: refused too.
 *  - `Origin`, when a request carries one, has to be that same address: the page that made the request was served
 *    from here. Browsers send it with every request another origin's script makes and with every POST; a program that
 *    is not a browser (`pk`, a test, curl) sends none.
 *  - `Sec-Fetch-Site`, which browsers add themselves and a page cannot set, has to be `same-origin` (a page of the
 *    workbench) or `none` (the address typed, a bookmark, a link opened from another program). `same-site` is
 *    another origin as well — another port of localhost — and is refused like `cross-site`, which covers what carries
 *    no `Origin`: an image, a script or a frame another page points here. One thing from elsewhere is answered: a
 *    link followed to a page of the workbench, in a tab of its own; that gives the other page nothing to read and
 *    starts nothing. The API is never answered that way, and neither is a frame.
 *  - A request with a body says it is `application/json`. A page can post to another origin without the browser
 *    asking first only as a form or as plain text, so this refuses such a post even where the headers above are absent.
 */
export function refusal(req: IncomingMessage, pathname: string | null): { status: 403 | 415; message: string } | null {
  const port = req.socket.localPort;
  const notHere = { status: 403 as const, message: `The ProjectKeeper workbench answers only at its own local address, http://127.0.0.1:${port}/, and only to its own pages.` };
  const host = one(req.headers.host)?.toLowerCase();
  if (host === undefined || !localHosts(port).includes(host)) return notHere;
  const origin = one(req.headers.origin);
  if (origin !== undefined && origin.toLowerCase() !== `http://${host}`) return notHere;
  const site = one(req.headers['sec-fetch-site'])?.toLowerCase();
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    const method = (req.method ?? 'GET').toUpperCase();
    const followedLink = (method === 'GET' || method === 'HEAD') && one(req.headers['sec-fetch-mode']) === 'navigate' && one(req.headers['sec-fetch-dest']) === 'document';
    if (!followedLink || pathname === null || pathname === '/api' || pathname.startsWith('/api/')) return notHere;
  }
  const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  if (hasBody && (one(req.headers['content-type']) ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json') {
    return { status: 415, message: 'A request with a body must be sent as application/json.' };
  }
  return null;
}

export class SseHub {
  private readonly clients = new Set<ServerResponse>();

  attach(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 25_000);
    ping.unref?.();
    res.on('close', () => { clearInterval(ping); this.clients.delete(res); });
  }

  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      if (!client.writableEnded) client.write(payload);
    }
  }

  get size(): number { return this.clients.size; }
}

export class HttpApp {
  private readonly routes: Route[] = [];
  private readonly statics: { prefix: string; dir: string }[] = [];
  readonly sse = new SseHub();
  private server: Server | null = null;

  route(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/\/:([A-Za-z_]+)/g, (_m, key: string) => { keys.push(key); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, pattern, keys, handler });
  }

  static(prefix: string, dir: string): void {
    this.statics.push({ prefix, dir: resolve(dir) });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A request line that is no path (`GET //`) is not a URL; it is answered as that, after the check of who asks, and
    // never thrown from here, where nothing would catch it and the process would end.
    let url: URL | null = null;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { /* said below */ }
    const method = (req.method ?? 'GET').toUpperCase();
    const refused = refusal(req, url?.pathname ?? null) ?? (url ? null : { status: 400, message: 'The request names no path.' });
    if (refused || !url) {
      // Said in plain text: the one who reads it is a person who opened the workbench under another name. Nothing of
      // the request is repeated in it, and the connection is not kept for a body that was not read.
      res.writeHead(refused?.status ?? 400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
      res.end(`${refused?.message ?? 'The request names no path.'}\n`);
      return;
    }
    try {
      for (const route of this.routes) {
        if (route.method !== method) continue;
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        const params: Record<string, string> = {};
        route.keys.forEach((key, i) => { params[key] = decodeURIComponent(match[i + 1] ?? ''); });
        const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
        const result = await route.handler({ req, res, params, query: url.searchParams, body });
        if (res.writableEnded || res.headersSent) return;
        if (result === undefined) { res.writeHead(204); res.end(); return; }
        const json = JSON.stringify(result);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(json);
        return;
      }
      if (method === 'GET' || method === 'HEAD') {
        for (const s of this.statics) {
          if (!url.pathname.startsWith(s.prefix)) continue;
          const rel = decodeURIComponent(url.pathname.slice(s.prefix.length)) || 'index.html';
          const file = normalize(join(s.dir, rel));
          if (!file.startsWith(s.dir)) { res.writeHead(403); res.end(); return; }
          const target = existsSync(file) && statSync(file).isDirectory() ? join(file, 'index.html') : file;
          if (!existsSync(target) || !statSync(target).isFile()) continue;
          res.writeHead(200, { 'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
          if (method === 'HEAD') { res.end(); return; }
          createReadStream(target).pipe(res);
          return;
        }
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Not found: ${method} ${url.pathname}` }));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: message }));
      } else if (!res.writableEnded) {
        res.end();
      }
      if (status === 500) console.error(`[http] ${method} ${url.pathname}: ${error instanceof Error ? error.stack : String(error)}`);
    }
  }

  /** Always on 127.0.0.1: the address is not a parameter, an option or a setting. */
  listen(port: number): Promise<{ port: number; close: () => Promise<void> }> {
    return new Promise((resolvePromise, reject) => {
      const server = createServer((req, res) => { void this.handle(req, res); });
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        const address = server.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;
        resolvePromise({ port: actualPort, close: () => new Promise((r) => server.close(() => r())) });
      });
    });
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) { resolvePromise(undefined); return; }
      try { resolvePromise(JSON.parse(text)); } catch { reject(new HttpError(400, 'Body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${name} is required`);
  return value.trim();
}

export function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
