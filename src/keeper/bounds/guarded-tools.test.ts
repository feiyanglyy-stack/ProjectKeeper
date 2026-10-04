/**
 * The tool-level boundary layer (Spec §3.1; CKC-03 AC-23). read / edit / grep / ls are re-provided through pi's own
 * definitions with boundary-enforcing Operations, so a call goes through pi's real resolver and is refused on the
 * absolute path pi has already resolved — independent of the gate and of the resolver copy in paths.ts. This is the
 * probe's raw-tool escape (`read` / `grep` / `edit` with the `@` form, called straight on the tool definition), now
 * pointed at these definitions: it is refused, and no outside content comes back, while an in-project read still works.
 *
 * On the pre-layer code these definitions did not exist, so this test is red for the right reason (nothing to import).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardedFileTool } from './boundary.ts';
import { makeBoundary, type Boundary } from './paths.ts';

const base = mkdtempSync(join(tmpdir(), 'pk-guard-'));
const project = join(base, 'ProjectRoot');
const outside = join(base, 'OutsideRoot');
mkdirSync(join(project, 'src'), { recursive: true });
mkdirSync(outside, { recursive: true });
const MARKER = 'AJ_TEMP_OUTSIDE_MARKER';
writeFileSync(join(project, 'src', 'inside.txt'), 'INSIDE_CONTENT');
writeFileSync(join(outside, 'secret.txt'), MARKER);
writeFileSync(join(outside, 'edit-target.txt'), MARKER);

const boundary: Boundary = makeBoundary({ roots: [{ path: project, label: 'the project directory' }], files: [] });
const ctx = { cwd: project } as never;
const textOf = (r: { content?: { type: string; text?: string }[] }) => (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');

test('read: the @ form is refused on pi\'s resolved path; an in-project read still returns content', async () => {
  const read = guardedFileTool('read', project, boundary);
  await assert.rejects(read.execute('c', { path: `@${join(outside, 'secret.txt')}` } as never, undefined, undefined, ctx),
    (e: Error) => /read boundary/.test(e.message), 'the @ read is refused');
  const inside = await read.execute('c', { path: join(project, 'src', 'inside.txt') } as never, undefined, undefined, ctx);
  assert.match(textOf(inside), /INSIDE_CONTENT/, 'an in-project read still works');
});

test('grep: the @ form directory is refused before ripgrep runs (no outside content)', async () => {
  const grep = guardedFileTool('grep', project, boundary);
  // grep replaces any isDirectory error with its own "Path not found", so the guard shows as a rejection: the search
  // never runs and no outside match is returned.
  await assert.rejects(grep.execute('c', { pattern: MARKER, path: `@${outside}`, literal: true } as never, undefined, undefined, ctx));
  const inside = await grep.execute('c', { pattern: 'INSIDE', path: project, literal: true } as never, undefined, undefined, ctx);
  assert.match(textOf(inside), /inside\.txt/, 'an in-project grep still finds the match');
});

test('edit: the @ form does not modify the outside file', async () => {
  const edit = guardedFileTool('edit', project, boundary);
  await assert.rejects(edit.execute('c', { path: `@${join(outside, 'edit-target.txt')}`, edits: [{ oldText: MARKER, newText: 'CHANGED' }] } as never, undefined, undefined, ctx),
    (e: Error) => /read boundary/.test(e.message));
  assert.equal(readFileSync(join(outside, 'edit-target.txt'), 'utf8'), MARKER, 'the outside file is unchanged');
});

test('ls: the @ form directory is refused; an in-project directory is listed', async () => {
  const ls = guardedFileTool('ls', project, boundary);
  await assert.rejects(ls.execute('c', { path: `@${outside}` } as never, undefined, undefined, ctx),
    (e: Error) => /read boundary/.test(e.message));
  const inside = await ls.execute('c', { path: join(project, 'src') } as never, undefined, undefined, ctx);
  assert.match(textOf(inside), /inside\.txt/, 'an in-project directory is listed');
});

test('a denial is counted through onDeny', async () => {
  let denials = 0;
  const read = guardedFileTool('read', project, boundary, () => { denials += 1; });
  await assert.rejects(read.execute('c', { path: `@${join(outside, 'secret.txt')}` } as never, undefined, undefined, ctx));
  assert.equal(denials, 1, 'the guard reports the refusal so the job can count it');
});
