/**
 * CKC-22 AC-10, Spec §2.11: a code file outside version control is dated by its own time as the rebuild read it
 * (`File time`), else `Undated · first seen` at the rebuild that first read it — never by the moment of the query, which is
 * what `resolve('file:…')` and the provenance's `now` step used to give it. Loose documents already worked this way
 * (`loosefirst:`); code files now keep both times in `code_files`, added in place to a ledger built before them.
 *
 * The project is invented ("Tern", a tide-table tool kept outside version control) and lives in the temp directory.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import type { Project, ScopeItem } from '../model/types.ts';

const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-loose-code-'));
process.env.USERPROFILE = scratch;
process.env.HOME = scratch;
const { rebuildLedgerInPlace, ledgerPath } = await import('./rebuild.ts');
const { Ledger } = await import('./index.ts');
const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const dir = mkdtempSync(join(scratch, 'tern-'));
const write = (rel: string, text: string) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
write('src/tide.ts', 'export const tide = 1;\n');
write('src/moon.ts', 'export const moon = 1;\n');
const tideTime = new Date('2026-09-05T07:15:00.000Z');
utimesSync(join(dir, 'src/tide.ts'), tideTime, tideTime);

const item = { id: 'loose', path: dir, category: 'Directory', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'none', missing: null, addedBy: 'owner' } as unknown as ScopeItem;
const project = { id: 'tern', name: 'Tern', locations: [dir], scope: [item], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en', organizingPaused: false, createdAt: '2026-09-01T00:00:00Z', lastOpenedAt: null, lastScopedAt: null } as unknown as Project;
const file = ledgerPath(project.id, join(scratch, 'home'));
const first = rebuildLedgerInPlace(file, project, {});
const open = () => Ledger.openPath(file)!;
const raw = (fn: (db: DatabaseSync) => void) => { const db = new sqlite.DatabaseSync(file); try { fn(db); } finally { db.close(); } };
const column = (name: string) => { const l = open(); try { return (l.db.prepare(`SELECT ${name} v FROM code_files WHERE path = 'src/tide.ts'`).get() as { v: string | null }).v; } finally { l.close(); } };

test('a code file outside version control is dated by its own time; resolve and the provenance say the same', () => {
  const l = open();
  try {
    const entry = l.resolve('file:src/tide.ts');
    assert.ok(entry, 'the file is an entry of the ledger');
    assert.deepEqual([entry.occurred.basis, entry.occurred.at, entry.occurred.undated ?? false], ['File time', tideTime.toISOString(), false], `not the moment of the query: ${JSON.stringify(entry.occurred)}`);
    assert.match(entry.label, /src\/tide\.ts \(outside version control, 1 lines\)/);
    const now = l.provenance({ paths: ['src/tide.ts'] }).steps.find((s) => s.kind === 'now');
    assert.deepEqual(now?.occurred, entry.occurred, 'where it stands now is dated the same way');
    assert.match(now!.title, /is in the current version, outside version control/);
  } finally { l.close(); }
});

test('without a file time, the rebuild that first read the file — kept through later rebuilds', async () => {
  raw((db) => db.prepare("UPDATE code_files SET file_at = NULL WHERE path = 'src/tide.ts'").run());
  const l = open();
  try {
    const o = l.resolve('file:src/tide.ts')!.occurred;
    assert.deepEqual([o.basis, o.at, o.undated], ['First observed', first.startedAt, true], `Undated · first seen at the first reading: ${JSON.stringify(o)}`);
  } finally { l.close(); }
  // The directory changes; the next rebuild reads it again and keeps when it first read the file.
  await new Promise((r) => setTimeout(r, 20));
  write('src/moon.ts', 'export const moon = 2;\n');
  const second = rebuildLedgerInPlace(file, project, {});
  assert.notEqual(second.startedAt, first.startedAt);
  assert.equal(column('first_seen'), first.startedAt, 'the first reading stays the first');
  assert.equal(column('file_at'), tideTime.toISOString(), 'and the file time is recorded again');
});

test('a ledger built before these times were kept: read as it is, it says the last rebuild; the next rebuild adds them in place', () => {
  const lastRebuild = (() => { const l = open(); try { return (l.db.prepare("SELECT value FROM state WHERE key = 'lastRebuildAt'").get() as { value: string }).value; } finally { l.close(); } })();
  // What a ledger of the same schema version looked like before: no such columns, and its loose code recorded as read.
  raw((db) => { db.exec('ALTER TABLE code_files DROP COLUMN file_at'); db.exec('ALTER TABLE code_files DROP COLUMN first_seen'); });
  const old = open();
  try {
    const o = old.resolve('file:src/tide.ts')!.occurred;
    assert.deepEqual([o.basis, o.at, o.undated], ['First observed', lastRebuild, true], `the last rebuild, which had read it — not the moment of the query: ${JSON.stringify(o)}`);
  } finally { old.close(); }
  rebuildLedgerInPlace(file, project, {});
  const l = open();
  try {
    assert.equal((l.db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string }).value, '3', 'the same schema version');
    assert.deepEqual(readdirSync(join(file, '..')).filter((f) => f.includes('.bak')), [], 'the ledger was not set aside to be built anew');
    const o = l.resolve('file:src/tide.ts')!.occurred;
    assert.deepEqual([o.basis, o.at], ['File time', tideTime.toISOString()], `the loose directory was read again and its files' times recorded: ${JSON.stringify(o)}`);
    assert.equal(column('first_seen'), lastRebuild, 'what it had read before stands as first read by its last rebuild');
  } finally { l.close(); }
});
