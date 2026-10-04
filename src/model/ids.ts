import { createHash, randomBytes } from 'node:crypto';

/** Time-ordered random id with a collection prefix, e.g. `note_m1k3…`. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36);
  const random = randomBytes(4).toString('hex');
  return `${prefix}_${time}${random}`;
}

/** Deterministic id from stable parts: re-scanning the same anchor yields the same id. */
export function stableId(prefix: string, ...parts: readonly (string | number | null | undefined)[]): string {
  const hash = createHash('sha1').update(parts.map((p) => String(p ?? '')).join(String.fromCharCode(0))).digest('hex');
  return `${prefix}_${hash.slice(0, 16)}`;
}

export function fingerprint(text: string | Buffer): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

export function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '');
  return s.length > 0 ? s.slice(0, 40) : 'project';
}
