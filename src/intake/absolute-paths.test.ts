/**
 * A whole path the project's own words give — in a material rule, in a brief — on a system whose paths start at `/`.
 *
 * Both were recognised by a Windows drive alone. On macOS a rule that applies to `/Users/sam/orchard/attic` was taken
 * for a path below the project's root, lower-cased, and covered nothing; and a brief that names where the sessions'
 * logs are (`/Users/sam/.claude/projects/-Users-sam-orchard`) named no place at all.
 *
 * The project is invented ("Orchard"); its root is a rooted path of the system the tests run on, and nothing is on disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMaterialRules } from './material-rules.ts';
import { namedInBrief } from '../keeper/organize/reading.ts';
import { ProjectStore } from '../store/project-store.ts';
import type { Project, ProjectRule, Source } from '../model/types.ts';

const AT = '2026-09-18T00:00:00.000Z';
const WIN = process.platform === 'win32';
const ROOT = WIN ? 'D:\\orchard' : '/orchard';
const ELSEWHERE = WIN ? 'D:\\elsewhere' : '/elsewhere';

const project = { id: 'p1', name: 'Orchard', locations: [ROOT], createdAt: AT, scope: [{ id: 'scope_main', path: ROOT, relation: 'Main project', category: 'Directory' }], roles: [], language: 'en' } as unknown as Project;
const store = () => ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-absolute-')));
const src = (s: ProjectStore, id: string, rel: string) =>
  s.sources.put({ id, projectId: 'p1', title: rel, anchor: { kind: 'file', path: join(ROOT, ...rel.split('/')), headingPath: [], lineStart: 1, lineEnd: 9 }, ids: [], version: { fingerprint: 'f', readAt: AT, commit: null }, excerpt: `text of ${rel}`, usedAs: null, usedAsBy: null, availability: null, movedTo: null, scopeItemId: 'scope_main', hasCredential: false, bytes: 10 } as Source);
const rule = (s: ProjectStore, id: string, appliesTo: string[]) =>
  s.rules.put({ id, projectId: 'p1', group: 'Material rules', category: 'Recovery only', summary: 'kept for recovery only', excerpt: 'kept for recovery only', sourceIds: ['src_readme'], appliesTo, basis: 'Explicit', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: 'job_frame', asOf: AT, updatedAt: AT } as ProjectRule);

test('a material rule that names a directory by its whole path covers what lies under it', () => {
  const s = store();
  src(s, 'src_readme', 'README.md');
  src(s, 'src_old', 'attic/plan-2025.md');
  src(s, 'src_sibling', 'attic-notes/today.md');
  rule(s, 'rule_attic', [join(ROOT, 'attic')]);
  assert.equal(applyMaterialRules(s, project), 1, 'one source is under the directory the rule names');
  assert.deepEqual([s.sources.get('src_old')!.usedAs, s.sources.get('src_old')!.usedAsByRuleId], ['History only', 'rule_attic']);
  assert.equal(s.sources.get('src_sibling')!.usedAs, null, 'a directory whose name only starts the same is another directory');
  assert.equal(s.sources.get('src_readme')!.usedAs, null);
});

test('a whole path outside the project covers nothing in it, and a path below the root is still a path below the root', () => {
  const s = store();
  src(s, 'src_readme', 'README.md');
  src(s, 'src_old', 'attic/plan-2025.md');
  rule(s, 'rule_elsewhere', [join(ELSEWHERE, 'attic')]);
  assert.equal(applyMaterialRules(s, project), 0, 'the rule is about another place');
  rule(s, 'rule_attic', ['attic/']);
  assert.equal(applyMaterialRules(s, project), 1);
  assert.equal(s.sources.get('src_old')!.usedAsByRuleId, 'rule_attic');
});

test('a brief names a whole path where paths start at /, when its first name is at the root', () => {
  const brief = 'Read the owner’s words in /Users/sam/.claude/projects/-Users-sam-orchard, then docs/plan/ and src/app.ts:12. The route /api/users/list is not a place, nor is https://example.com/Users/sam/x.';
  const mac = (name: string) => ['Users', 'private', 'tmp'].includes(name);
  const read = namedInBrief(brief, mac);
  assert.deepEqual(read.absolute, ['/Users/sam/.claude/projects/-Users-sam-orchard'], 'the logs’ directory, and neither the route nor the address');
  assert.deepEqual(read.paths, ['docs/plan/', 'src/app.ts'], 'the project’s own paths are read as before');
  assert.deepEqual(namedInBrief('See /private/var/folders/ab/T/logs/ and /Users.', mac).absolute, ['/private/var/folders/ab/T/logs'], 'at least two names; a trailing slash is not part of it');
  // As Windows reads it: a path starts at a drive, and one from / is no path.
  assert.deepEqual(namedInBrief(brief, null).absolute, []);
  if (WIN) assert.deepEqual(namedInBrief(brief).absolute, [], 'on Windows nothing changed');
});
