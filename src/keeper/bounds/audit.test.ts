/**
 * The independent boundary audit, turned into tests (Spec §3.1; CKC-03 AC-23). Each case is a way a
 * wandering agent could reach outside the project — a path spelling, or a shell command — that the
 * boundary must refuse; every refusal is paired with an in-project case that must still be allowed.
 * The fixture is built in a temp tree with a junction, a script and a path-list file; no real home
 * or ProjectKeeper home is touched, and the "outside" directory is a sibling of the fixture project.
 *
 * These fail on the pre-audit code (cedcfb8): the `@` spelling resolves inside, `cd` outside then a
 * bare `ls` is allowed, `bash -c` with a bare path, piped code, a run script, a here-doc, a followed
 * link, a home-derived path, git env and git config, `~user` and env-home all pass the check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBoundary, type Boundary } from './paths.ts';
import { checkBashCommand, checkPowerShellCommand } from './command.ts';

const base = mkdtempSync(join(tmpdir(), 'pk-audit-'));
const project = join(base, 'ProjectRoot');
const outside = join(base, 'OutsideRoot');
mkdirSync(join(project, 'src'), { recursive: true });
mkdirSync(join(outside, 'repo'), { recursive: true });
writeFileSync(join(project, 'src', 'inside.txt'), 'INSIDE');
writeFileSync(join(outside, 'secret.txt'), 'SECRET');
writeFileSync(join(outside, 'config.ini'), '[a]\n b = 1\n');
const toBash = (p: string) => `/${p[0]!.toLowerCase()}${p.slice(2).replaceAll('\\', '/')}`;
const outsideBash = toBash(outside);
const secretBash = `${outsideBash}/secret.txt`;
writeFileSync(join(project, 'reader.sh'), `cat '${secretBash}'\n`);
writeFileSync(join(project, 'paths.txt'), `${secretBash}\n`);
let junction = false;
try { if (!existsSync(join(project, 'linked-outside'))) symlinkSync(outside, join(project, 'linked-outside'), 'junction'); junction = true; } catch { /* no permission */ }

const boundary: Boundary = makeBoundary({ roots: [{ path: project, label: 'the project directory' }], files: [] });

const allowPath = (p: string) => assert.equal(boundary.decide(p, project).ok, true, `path should be allowed: ${p}`);
const denyPath = (p: string) => assert.equal(boundary.decide(p, project).ok, false, `path should be refused: ${p}`);
const allowCmd = (c: string) => assert.equal(checkBashCommand(c, project, boundary).ok, true, `command should be allowed: ${c} — ${checkBashCommand(c, project, boundary).reason ?? ''}`);
const denyCmd = (c: string) => assert.equal(checkBashCommand(c, project, boundary).ok, false, `command should be refused: ${c}`);
const denyPs = (c: string) => assert.equal(checkPowerShellCommand(c, project, boundary).ok, false, `powershell should be refused: ${c}`);
const allowPs = (c: string) => assert.equal(checkPowerShellCommand(c, project, boundary).ok, true, `powershell should be allowed: ${c}`);

test('A. the @ spelling resolves the same as pi and is refused; a plain in-project path is allowed', () => {
  allowPath(join(project, 'src', 'inside.txt'));
  denyPath(`@${join(outside, 'secret.txt')}`);
  denyPath(`@${outside}`);
  denyPath(`@${secretBash}`);
  // A unicode no-break space, which pi normalises to a plain space, does not smuggle a different path either.
  denyPath(`@${outside} `.replace(' ', '') + '\\secret.txt');
});

test('A. junction and case and MSYS spellings of the outside path are refused', () => {
  if (junction) denyPath(join(project, 'linked-outside', 'secret.txt'));
  denyPath(join(outside, 'secret.txt').toUpperCase());
  denyPath(secretBash);
  denyPath(join('..', 'OutsideRoot', 'secret.txt'));
});

test('B1. cd/pushd/subshell/cd- to outside are refused; cd into a subdir then a read is allowed', () => {
  denyCmd(`cd '${outsideBash}' && ls`);
  denyCmd(`pushd '${outsideBash}' >/dev/null && ls`);
  denyCmd('cd - >/dev/null && ls');
  denyCmd(`(cd '${outsideBash}'; ls)`);
  denyCmd('cd .. && cat secret.txt');
  allowCmd('cd src && cat inside.txt');
  allowCmd('(cd src && cat inside.txt); cat src/inside.txt');   // the subshell cd does not leak past )
});

test('B2. recursive commands that follow symlinks are refused; the non-following forms are allowed', () => {
  denyCmd('find -L . -type f -exec cat {} +');
  denyCmd(`grep -R 'x' .`);
  allowCmd('grep -r "pattern" src');
  allowCmd('find . -type f -name "*.txt"');
});

test('B3. code piped into an interpreter is refused', () => {
  denyCmd('cat reader.sh | bash');
  denyCmd(`printf 'cat ${secretBash}\\n' | bash`);
  denyCmd('cat reader.sh | sh');
  allowCmd('cat src/inside.txt | grep IN | wc -l');            // a normal pipeline of readers stays allowed
});

test('B3. bash -c with a bare outside path in the code is refused; in-project code is allowed', () => {
  denyCmd(`bash -c "cat ${secretBash}"`);
  allowCmd('bash -c "cat src/inside.txt"');
});

test('B4. a run or sourced script that reads outside is refused (its contents are scanned)', () => {
  denyCmd('source reader.sh');
  denyCmd('bash reader.sh');
  denyCmd(`cat > gen.sh <<'EOF'\ncat '${secretBash}'\nEOF\nbash gen.sh`);
});

test('B5. inline code that builds a path from the home directory is refused', () => {
  denyCmd(`python -c "from pathlib import Path; print((Path.home() / 'x').read_text())"`);
  denyCmd(`node -e "console.log(require('os').homedir())"`);
  allowCmd(`python -c "print(open('src/inside.txt').read())"`);
});

test('B6. an environment assignment naming an outside path is refused', () => {
  denyCmd(`GIT_DIR='${outsideBash}/repo/.git' git rev-parse --git-dir`);
  denyCmd(`GIT_WORK_TREE='${outsideBash}' git status`);
  allowCmd('GIT_DIR=.git git rev-parse --git-dir');
});

test('B7. git config reaching outside the repository is refused; a repo-local read is allowed', () => {
  denyCmd(`git config --file '${outsideBash}/config.ini' --get a.b`);
  denyCmd('git config --global --get a.b');
  denyCmd('git config --list');
  allowCmd('git config --local --get a.b');
  allowCmd('git log -n5 --oneline');
});

test('B8/B5. a ~user or env-home path is refused', () => {
  denyCmd('cat ~otheruser/whatever');
  denyCmd('cat $HOME/secret.txt');
  denyCmd('cmd.exe /d /c type %USERPROFILE%\\secret.txt');
});

test('B9. a list of paths read from an in-project file is checked', () => {
  denyCmd('cat paths.txt | xargs cat');
  denyCmd('tar -cf bundle.tar -T paths.txt');
});

test('git -C to outside, attached or separate, is refused', () => {
  denyCmd(`git -C '${outsideBash}/repo' status`);
  denyCmd(`git -C'${outsideBash}/repo' status`);
  allowCmd('git -C src status');
});

test('B10. PowerShell reaching outside, including the attached -Path:value form, is refused', () => {
  denyPs(`Get-Content '${join(outside, 'secret.txt')}'`);
  denyPs(`Get-Content -Path:'${join(outside, 'secret.txt')}'`);
  denyPs('Get-Content $HOME/secret.txt');
  allowPs('Get-Content src/inside.txt');
});

test('the everyday in-project commands still run', () => {
  allowCmd('npm run build');
  allowCmd('npm test');
  allowCmd('cat src/inside.txt');
  allowCmd('grep -rn "x" src');
  allowCmd('echo done');
});
