import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    // A corrupt file is kept next to the fresh one instead of being silently overwritten.
    try { renameSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* keep going */ }
    return fallback;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temp, JSON.stringify(value, null, 1), { encoding: 'utf8', flag: 'wx' });
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) {
        try { unlinkSync(temp); } catch { /* nothing else to do */ }
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

export function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

export function readJsonLines<T>(path: string, limit = Infinity): T[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
  const slice = Number.isFinite(limit) ? lines.slice(-limit) : lines;
  const out: T[] = [];
  for (const line of slice) {
    try { out.push(JSON.parse(line) as T); } catch { /* skip broken line */ }
  }
  return out;
}
