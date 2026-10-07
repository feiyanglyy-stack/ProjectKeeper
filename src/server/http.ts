/**
 * Minimal HTTP layer: JSON routes, server-sent events, static files. Bound to 127.0.0.1.
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
    // A request line that is no path (`GET //`) is not a URL; it is answered as that, and never thrown from here, where
    // nothing would catch it and the process would end.
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
      res.end('The request names no path.\n');
      return;
    }
    const method = (req.method ?? 'GET').toUpperCase();
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

  listen(port: number, host = '127.0.0.1'): Promise<{ port: number; close: () => Promise<void> }> {
    return new Promise((resolvePromise, reject) => {
      const server = createServer((req, res) => { void this.handle(req, res); });
      server.on('error', reject);
      server.listen(port, host, () => {
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
