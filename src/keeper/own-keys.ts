/**
 * The owner's own keys (Spec §6.10 "key、模型与路由", §3.1; D105; CKC-03 AC-33).
 *
 * A key the owner enters in `Keeper` → `Model provider` is kept on this machine, in ProjectKeeper's own home
 * (`<home>/keys.json`), beside `workspace.json` and outside every project: it belongs to no project, it is there after a
 * restart, and every project can choose it. Its value is written in that one file and nowhere else — not in a project's
 * files, not in the project's ProjectKeeper folder, its assets, exports, trace, session records or context packs, and not
 * in a log (the grep test in own-keys.test.ts). Nothing this module returns to a caller outside the runtime carries the
 * value: `publicKey` is what the workbench sees, with a full mask (U98: not one character shown).
 *
 * Each key runs under a provider id of its own (`<provider>~<n>`), registered with pi like an extra key (runtime.ts
 * `registerOwnKeys`), so it has its own lanes, its own quota window and its own place in a project's backup order.
 */
import { readJson, writeJsonAtomic } from '../store/json-file.ts';
import { join } from 'node:path';

export interface OwnKey {
  /** The provider id the key runs under in pi, e.g. `deepseek~1`. */
  readonly id: string;
  /** The provider whose endpoint and models it uses, e.g. `deepseek`. */
  readonly provider: string;
  readonly name: string;
  readonly value: string;
  readonly addedAt: string;
  readonly replacedAt: string | null;
}

/** What the workbench is told of a key: never the value. */
export interface PublicOwnKey {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly mask: string;
  readonly addedAt: string;
  readonly replacedAt: string | null;
}

/** The mask shown for a saved key: the same for every key, so not one character of it shows (U98). */
export const KEY_MASK = '••••••••••••';

interface KeysFile { readonly version: 1; readonly keys: readonly OwnKey[] }

export const keysFile = (home: string): string => join(home, 'keys.json');

export const publicKey = (k: OwnKey): PublicOwnKey => ({ id: k.id, provider: k.provider, name: k.name, mask: KEY_MASK, addedAt: k.addedAt, replacedAt: k.replacedAt });

/** A key value as pasted: one line, no surrounding space or quotes. Refused when empty or when it has inner spaces. */
export function cleanKeyValue(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('The key is missing');
  const value = raw.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!value) throw new Error('The key is empty');
  if (/\s/.test(value)) throw new Error('A key is one word without spaces or line breaks: paste only the key');
  return value;
}

export class OwnKeyStore {
  private keys: OwnKey[];
  private readonly home: string;
  constructor(home: string) {
    this.home = home;
    this.keys = [...readJson<KeysFile>(keysFile(home), { version: 1, keys: [] }).keys];
  }

  list(): readonly OwnKey[] { return this.keys; }
  get(id: string): OwnKey | undefined { return this.keys.find((k) => k.id === id); }

  /** A new key for `provider`. Several keys of one provider each get an id of their own. */
  add(provider: string, name: string | null, value: string, now = new Date().toISOString()): OwnKey {
    let n = 1;
    while (this.keys.some((k) => k.id === `${provider}~${n}`)) n++;
    const sameProvider = this.keys.filter((k) => k.provider === provider).length;
    const key: OwnKey = { id: `${provider}~${n}`, provider, name: name?.trim() || (sameProvider ? `${provider} key ${sameProvider + 1}` : `${provider} key`), value, addedAt: now, replacedAt: null };
    this.keys = [...this.keys, key];
    this.save();
    return key;
  }

  /** A new value for a saved key (and a new name, when given): it keeps its id, so the routes that name it stand. */
  replace(id: string, value: string | null, name: string | null = null, now = new Date().toISOString()): OwnKey {
    const at = this.keys.findIndex((k) => k.id === id);
    if (at < 0) throw new Error(`No key ${id}`);
    const old = this.keys[at]!;
    const next: OwnKey = { ...old, ...(value ? { value, replacedAt: now } : {}), ...(name?.trim() ? { name: name.trim() } : {}) };
    this.keys = this.keys.map((k, i) => (i === at ? next : k));
    this.save();
    return next;
  }

  remove(id: string): OwnKey | null {
    const old = this.get(id) ?? null;
    if (!old) return null;
    this.keys = this.keys.filter((k) => k.id !== id);
    this.save();
    return old;
  }

  /** Text with every saved key's value taken out (a provider's error message may quote what it was sent). */
  redact(text: string): string {
    let out = text;
    for (const k of this.keys) if (k.value.length >= 6) out = out.split(k.value).join(KEY_MASK);
    return out;
  }

  private save(): void { writeJsonAtomic(keysFile(this.home), { version: 1, keys: this.keys } satisfies KeysFile); }
}
