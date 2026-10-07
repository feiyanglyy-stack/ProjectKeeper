/**
 * Commands as macOS and Linux read them (Spec §3.1; CKC-03 AC-23): what differs from Git Bash on Windows.
 *
 * The check was written against Git Bash. Free text — a here-document body, a script that is not shell — was searched
 * for absolute paths with an expression that knows a Windows drive, Git Bash's `/c/…` for one, and a network path. On a
 * system whose paths start at `/` that expression saw none of `/etc/passwd`, `/Users/sam/.ssh/id_rsa`,
 * `/Volumes/Data/x`: a script written into the scratch directory, or one of the project's own, could name any file of
 * the machine and pass. It hid on a macOS machine, whose temporary directory is `/var/folders/…/T/…`: the one-letter
 * `/T/` matched the drive form, so a test that keeps its "outside" there was refused for the wrong reason.
 *
 * Each rule is checked by reading commands as macOS does (`readCommandsAs`), on whatever system the tests run; paths
 * are still resolved by that system, so the project's own files are written the way its bash writes them. On macOS and
 * Linux the same is checked once more against the real file system.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from '../../util/tmp.test-helpers.ts';
import { makeBoundary, type Boundary } from './paths.ts';
import { checkBashCommand, posixAbsolutePaths, readCommandsAs } from './command.ts';

// The temporary directory in the file system's own spelling: these tests write the project's paths into commands, and
// a spelling of the environment's (a short `RUNNER~1` name on a Windows runner) is another matter, asked on its own below.
const base = mkdtempSync(join(tmpdir(), 'pk-posix-'));
after(() => rmSync(base, { recursive: true, force: true }));
const project = join(base, 'project');
const scratch = join(base, 'scratch');
mkdirSync(join(project, 'src'), { recursive: true });
mkdirSync(scratch);
writeFileSync(join(project, 'src', 'inside.txt'), 'INSIDE');
// Two of the project's own scripts that are not shell: one opens a file of the machine, one only the project's.
writeFileSync(join(project, 'reader.py'), "#!/usr/bin/env python3\nprint(open('/etc/hosts').read())\n");
writeFileSync(join(project, 'tidy.py'), "#!/usr/bin/env python3\nprint(open('src/inside.txt').read())\n");

/** A path as this system's bash writes it: `/c/…` for a Windows drive path, the path itself anywhere else. */
const toBash = (p: string) => { const fwd = p.replaceAll('\\', '/'); return /^[A-Za-z]:\//.test(fwd) ? `/${fwd[0]!.toLowerCase()}${fwd.slice(2)}` : fwd; };
const insideBash = toBash(join(project, 'src', 'inside.txt'));
/** The names a Mac has at its root, and the one this system's own paths start with. */
const ROOT_NAMES = ['etc', 'Users', 'Volumes', 'private', 'tmp', 'usr', 'bin', 'dev', insideBash.split('/')[1]!];

const boundary: Boundary = makeBoundary({ roots: [{ path: project, label: 'the project directory' }, { path: scratch, label: 'scratch' }], files: [] });
const decide = (command: string) => checkBashCommand(command, project, boundary, 0, [], scratch);
const refusedFor = (command: string, path: string) => {
  const d = decide(command);
  assert.equal(d.ok, false, `should be refused: ${command}`);
  assert.equal(d.detail, path, `refused for the path it names, not for something else: ${d.reason}`);
};
const allowed = (command: string) => { const d = decide(command); assert.equal(d.ok, true, `should be allowed: ${command} — ${d.reason ?? ''}`); };
/** Run `body` reading commands as macOS does. */
const asMac = (body: () => void) => { const undo = readCommandsAs('darwin', ROOT_NAMES); try { body(); } finally { undo(); } };

test('free text names an absolute path where a word starts with / and its first name is at the root', () => {
  const at = (...names: string[]) => (name: string) => names.includes(name);
  const mac = at('etc', 'Users', 'Volumes', 'usr', 'opt', 'dev', 'tmp');
  assert.deepEqual(posixAbsolutePaths("cat '/etc/passwd'", mac), ['/etc/passwd']);
  assert.deepEqual(posixAbsolutePaths('print(open("/Users/sam/.ssh/id_rsa").read())', mac), ['/Users/sam/.ssh/id_rsa']);
  assert.deepEqual(posixAbsolutePaths('The notes are in /Volumes/Data/other/notes.md.', mac), ['/Volumes/Data/other/notes.md'], 'the sentence’s full stop is not part of it');
  assert.deepEqual(posixAbsolutePaths('tool --config=/etc/tool.conf', mac), ['/etc/tool.conf'], 'after an option’s =');
  assert.deepEqual(posixAbsolutePaths('PATH=/usr/local/bin:/opt/tools/bin', mac), ['/usr/local/bin', '/opt/tools/bin'], 'each entry of a list');
  assert.deepEqual(posixAbsolutePaths('at /etc/hosts:12, then (/tmp/out)', mac), ['/etc/hosts', '/tmp/out'], 'a line number or a bracket ends it');
  assert.deepEqual(posixAbsolutePaths('see file:///etc/passwd', mac), ['file:///etc/passwd']);
  // Not paths: a first name that is not at the root, and a / inside something else.
  assert.deepEqual(posixAbsolutePaths('GET /api/users returns 200; the heading matches /^## Plan/', mac), [], 'a route and an expression are text');
  assert.deepEqual(posixAbsolutePaths('https://example.com/etc/passwd and src/etc/x.md and docs/usr/', mac), [], 'inside an address or a relative path');
  assert.deepEqual(posixAbsolutePaths('$HOME/etc ${TMPDIR}/etc $(pwd)/etc ./etc ../etc ~/etc */etc', mac), [], 'after an expansion, a dot, a tilde or a glob');
  assert.deepEqual(posixAbsolutePaths('cat /', mac), [], 'the root alone names nothing here');
  // Left out on purpose.
  assert.deepEqual(posixAbsolutePaths('#!/usr/bin/env python3\nimport os\n', mac), [], 'the interpreter line a script starts with');
  assert.deepEqual(posixAbsolutePaths('git log 2>/dev/null >/dev/stderr </dev/stdin', mac), [], 'the device files every program may name');
  assert.deepEqual(posixAbsolutePaths('dd if=/dev/disk0', mac), ['/dev/disk0'], 'but not every device');
});

test('read as macOS: a here-document that names a file of the machine is refused, whatever its path looks like', () => asMac(() => {
  // None of these has a one-letter directory in it: the Git Bash expression saw nothing in them.
  refusedFor("cat > \"$TMPDIR/gen.py\" <<'EOF'\nprint(open('/etc/hosts').read())\nEOF", '/etc/hosts');
  refusedFor("python3 - <<'EOF'\nprint(open('/Users/someone/Documents/secret.txt').read())\nEOF", '/Users/someone/Documents/secret.txt');
  refusedFor("cat > \"$TMPDIR/run.sh\" <<'EOF'\ncp /Volumes/Backup/keys.tar /tmp/keys.tar\nEOF", '/Volumes/Backup/keys.tar');
  refusedFor("cat <<'EOF'\n~/.ssh/id_rsa\nEOF", '~/.ssh/id_rsa');
}));

test('read as macOS: a here-document that names the project’s own files, or no file at all, is allowed', () => asMac(() => {
  allowed(`cat > "$TMPDIR/gen.py" <<'EOF'\nprint(open('${insideBash}').read())\nEOF`);
  allowed("cat > \"$TMPDIR/gen.py\" <<'EOF'\n#!/usr/bin/env python3\nprint(open('src/inside.txt').read())\nEOF");
  allowed("cat > \"$TMPDIR/run.sh\" <<'EOF'\ngit log --oneline 2>/dev/null | head -5\nEOF");
  allowed("cat > \"$TMPDIR/notes.md\" <<'EOF'\nGET /api/users answers with the list; see https://example.com/etc/passwd and docs/a/notes.md.\nEOF");
}));

test('read as macOS: a script of the project that is not shell is refused when it names a file of the machine', () => asMac(() => {
  refusedFor('python3 reader.py', '/etc/hosts');
  allowed('python3 tidy.py');   // its interpreter line is no read of /usr/bin
}));

test('on this system, when its paths start at /: the same, against the real file system', (t) => {
  if (process.platform === 'win32' || !existsSync('/etc/hosts')) { t.skip('this system’s paths do not start at / (or it has no /etc/hosts)'); return; }
  refusedFor("cat > \"$TMPDIR/gen.py\" <<'EOF'\nprint(open('/etc/hosts').read())\nEOF", '/etc/hosts');
  refusedFor('python3 reader.py', '/etc/hosts');
  refusedFor("cat <<'EOF'\nsee file:///etc/hosts\nEOF", 'file:///etc/hosts');   // an address of a file is resolved by this system only
  allowed(`cat > "$TMPDIR/gen.py" <<'EOF'\nprint(open('${insideBash}').read())\nEOF`);
  allowed('python3 tidy.py');
  allowed("cat > \"$TMPDIR/notes.md\" <<'EOF'\nGET /pk-no-such-root/users answers with the list.\nEOF");
});

/** With the project as what the shell must not write, as the Keeper's shell has it. */
const decideWrites = (command: string) => checkBashCommand(command, project, boundary, 0, [project], scratch);

test('read as macOS: sed -i with its empty backup suffix edits the file it names, not its expression', () => asMac(() => {
  // The sed of macOS: `sed -i '' EXPRESSION FILE`. A file in the scratch directory may be edited in place.
  const inScratch = decideWrites("sed -i '' 's/alpha/beta/' \"$TMPDIR/notes.txt\"");
  assert.equal(inScratch.ok, true, `editing a scratch file in place is allowed: ${inScratch.reason ?? ''}`);
  const clustered = decideWrites("sed -Ei '' 's/(alpha)/beta/' \"$TMPDIR/notes.txt\"");
  assert.equal(clustered.ok, true, clustered.reason ?? '');
  // A file of the project may not, and the refusal names the file.
  const inProject = decideWrites("sed -i '' 's/alpha/beta/' src/inside.txt");
  assert.equal(inProject.ok, false);
  assert.equal(inProject.detail, 'src/inside.txt', inProject.reason ?? '');
  assert.match(inProject.reason ?? '', /shell cannot write project files/);
  // The form without the suffix word is read as it always was.
  assert.equal(decideWrites("sed -i 's/alpha/beta/' src/inside.txt").detail, 'src/inside.txt');
  assert.equal(decideWrites("sed -i.bak 's/alpha/beta/' \"$TMPDIR/notes.txt\"").ok, true);
}));

test('read as Windows, nothing changed: Git Bash’s drive form is a path, a path from / is text', (t) => {
  if (process.platform !== 'win32') { t.skip('Git Bash’s drive paths are resolved on Windows only'); return; }
  const outside = toBash(join(base, 'outside', 'secret.txt'));
  refusedFor(`cat <<'EOF'\ncat '${outside}'\nEOF`, outside);
  allowed("cat <<'EOF'\n/etc/passwd is only text here\nEOF");
  // Git Bash's sed has no suffix word: an empty word after -i is its expression, as before.
  assert.equal(decideWrites("sed -i '' 's/alpha/beta/' \"$TMPDIR/notes.txt\"").ok, false);
});
