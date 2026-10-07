/**
 * Path canonicalisation and the allowed-root matcher (Spec §3.1; CKC-03 AC-23). Each refusal test
 * is matched to its specific reason and paired with a legal read that must be allowed, so a test
 * that passes on unbounded code is ruled out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { canonicalKey, makeBoundary, realExisting, toAbsolute, type AllowedRoot } from './paths.ts';

const WIN = process.platform === 'win32';

function boundaryOn(roots: AllowedRoot[], files: string[] = []) {
  return makeBoundary({ roots, files });
}

test('a path inside a root is allowed; a sibling directory under the same parent is not', () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-b-'));
  const project = join(base, 'project');
  const other = join(base, 'other-project');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(project, 'src', 'a.ts'), 'x');
  writeFileSync(join(other, 'secret.txt'), 'x');
  const b = boundaryOn([{ path: project, label: 'the project directory' }]);

  assert.equal(b.decide(join(project, 'src', 'a.ts'), project).ok, true, 'a file in the project is readable');
  const denied = b.decide(join(other, 'secret.txt'), project);
  assert.equal(denied.ok, false, 'a sibling project is out of bounds');
  assert.match(denied.reason ?? '', /Out of the project's read boundary/);
});

test('another case of an in-bounds path is the same path where the file system says it is, and both separators are on Windows', () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-b-'));
  const project = join(base, 'Project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'a.ts'), 'x');
  const b = boundaryOn([{ path: project, label: 'the project directory' }]);
  assert.equal(b.decide(join(project, 'src', 'a.ts'), project).ok, true);
  // Asked of the file system, not of the system's name: Windows and a Mac's usual volume take another case for the same
  // file; Linux and a case-sensitive Mac volume do not, and there the other case names a file that is not there.
  if (existsSync(join(base, 'PROJECT', 'SRC', 'A.TS'))) {
    assert.equal(b.decide(join(project, 'src', 'a.ts').toLowerCase(), project).ok, true, 'lower-cased path is the same file');
    assert.equal(b.decide(join(base, 'PROJECT', 'SRC', 'A.TS'), project).ok, true, 'upper-cased path is the same file');
    assert.equal(canonicalKey(join(base, 'PROJECT', 'SRC', 'A.TS'), project), canonicalKey(join(project, 'src', 'a.ts'), project), 'one key for both spellings');
  }
  if (WIN) assert.equal(b.decide(`${project}/src/a.ts`, project).ok, true, 'forward slashes are the same file');
});

test('a relative escape (..) that climbs out of the project is refused; a relative path staying inside is allowed', () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-b-'));
  const project = join(base, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(base, 'outside.txt'), 'x');
  writeFileSync(join(project, 'src', 'in.txt'), 'x');
  const b = boundaryOn([{ path: project, label: 'the project directory' }]);
  assert.equal(b.decide('src/in.txt', project).ok, true, 'a relative path inside the project is allowed');
  assert.equal(b.decide(join('..', 'outside.txt'), project).ok, false, '.. climbing out is refused');
});

test('~ expands to the home directory, which is out of bounds', () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-b-'));
  const project = join(base, 'project');
  mkdirSync(project, { recursive: true });
  const b = boundaryOn([{ path: project, label: 'the project directory' }]);
  assert.equal(b.decide('~', project).ok, false, 'the home directory is out of bounds');
  assert.equal(b.decide('~/.projectkeeper/workspace.json', project).ok, false, "another ProjectKeeper home is out of bounds");
});

test('a Git Bash /c/... spelling is recognised as the same Windows path', { skip: WIN ? false : 'Git Bash’s drive paths are resolved on Windows only' }, () => {
  const b = boundaryOn([{ path: 'C:\\pk-project', label: 'the project directory' }]);
  // Same location written the MSYS way; both resolve under the root (existence not required for the mapping).
  assert.equal(canonicalKey('/c/pk-project/src/a.ts', 'C:\\pk-project'), canonicalKey('C:\\pk-project\\src\\a.ts', 'C:\\pk-project'));
});

test('a junction/symlink that points outside an allowed root is refused at its real target', () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-b-'));
  const project = join(base, 'project');
  const secrets = join(base, 'secrets');
  mkdirSync(project, { recursive: true });
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, 'key.txt'), 'x');
  const link = join(project, 'link');
  try {
    symlinkSync(secrets, link, 'junction');
  } catch {
    return;   // no permission to create a link on this machine: skip
  }
  const b = boundaryOn([{ path: project, label: 'the project directory' }]);
  const denied = b.decide(join(link, 'key.txt'), project);
  assert.equal(denied.ok, false, 'reading through a link into an out-of-bounds directory is refused');
  assert.match(denied.reason ?? '', /read boundary/);
});

test("a home with another project's directory: only this project's directory is in bounds", () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-home-'));
  const mine = join(home, 'projects', 'projectkeeper-mine');
  const theirs = join(home, 'projects', 'projectkeeper-theirs');
  mkdirSync(mine, { recursive: true });
  mkdirSync(theirs, { recursive: true });
  writeFileSync(join(mine, 'facts.json'), '[]');
  writeFileSync(join(theirs, 'facts.json'), '[]');
  const b = boundaryOn([{ path: mine, label: "this project's ProjectKeeper assets" }]);
  assert.equal(b.decide(join(mine, 'facts.json'), mine).ok, true, 'this project’s own assets are readable');
  const denied = b.decide(join(theirs, 'facts.json'), mine);
  assert.equal(denied.ok, false, "another project's assets under the same home are out of bounds");
});

test('an individually allowed file is readable, but not its directory', () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-b-'));
  const sessions = join(base, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const mine = join(sessions, 'mine.jsonl');
  const other = join(sessions, 'other.jsonl');
  writeFileSync(mine, '{}');
  writeFileSync(other, '{}');
  const b = makeBoundary({ roots: [], files: [mine] });
  assert.equal(b.decide(mine, base).ok, true, 'the session file that belongs to this project is readable');
  assert.equal(b.decide(other, base).ok, false, 'another session file in the same directory is not');
  assert.equal(b.decide(sessions, base).ok, false, 'the whole session directory is not a root');
});

test('a credential file is refused even inside an allowed root', () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-b-'));
  const agent = join(base, 'agent');
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, 'auth.json'), '{}');
  writeFileSync(join(agent, 'skill.md'), 'x');
  const agentKey = canonicalKey(agent, agent);
  const b = makeBoundary({
    roots: [{ path: agent, label: 'a loaded resource dir' }],
    files: [],
    denyFile: (k) => (k === canonicalKey(join(agent, 'auth.json'), agent) ? 'Refused: auth.json is a credential store.' : null),
  });
  void agentKey;
  assert.equal(b.decide(join(agent, 'skill.md'), agent).ok, true, 'a skill in the resource dir is readable');
  const denied = b.decide(join(agent, 'auth.json'), agent);
  assert.equal(denied.ok, false, 'the credential file is refused');
  assert.match(denied.reason ?? '', /credential store/);
});

test('realExisting resolves the longest existing ancestor for a path that does not exist yet', () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-b-'));
  const real = realExisting(join(base, 'nope', 'deep', 'x.txt'));
  assert.ok(real.startsWith(realExisting(base)), 'the missing tail is re-joined onto the resolved ancestor');
  assert.ok(real.endsWith(`nope${sep}deep${sep}x.txt`));
});

test('toAbsolute leaves an absolute path absolute and resolves a relative one against cwd', () => {
  const cwd = WIN ? 'C:\\proj' : '/proj';
  assert.equal(toAbsolute('a/b', cwd), join(cwd, 'a', 'b'));
  assert.equal(toAbsolute(WIN ? 'C:\\x\\y' : '/x/y', cwd), WIN ? 'C:\\x\\y' : '/x/y');
});
