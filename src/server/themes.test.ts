import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The four WorkflowKeeper themes are frozen: the owner reviewed them there, and the workbench carries byte-for-byte
// copies (D68; Spec §6.16; CKC-09 AC-40). This checks the copies against what was recorded when they were copied.
const themesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'themes');
interface ThemeEntry { id: string; name: string; file: string; bytes: number; sha256: string }
const manifest = JSON.parse(readFileSync(join(themesDir, 'manifest.json'), 'utf8')) as { default: string; copied: string; source: string; themes: ThemeEntry[] };

test('each frozen board.css is byte for byte what was copied from WorkflowKeeper (CKC-09 AC-40)', () => {
  assert.deepEqual(manifest.themes.map((t) => t.id), ['a1', 'b1', 'd2', 'i1']);
  for (const t of manifest.themes) {
    const bytes = readFileSync(join(themesDir, t.file));
    assert.equal(bytes.length, t.bytes, `${t.id}: size differs from the recorded copy`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), t.sha256, `${t.id}: board.css is not the frozen copy; it must never be edited here`);
  }
});

test('the manifest says where the themes came from, when, and which one opens by default', () => {
  assert.match(manifest.source, /WorkflowKeeper/);
  assert.match(manifest.copied, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(manifest.themes.some((t) => t.id === manifest.default), 'the default theme is one of the four');
});

test('every theme folder is in the manifest, so no unrecorded board.css can slip in', () => {
  const folders = readdirSync(themesDir).filter((name) => statSync(join(themesDir, name)).isDirectory()).sort();
  assert.deepEqual(folders, manifest.themes.map((t) => t.id).sort());
});
