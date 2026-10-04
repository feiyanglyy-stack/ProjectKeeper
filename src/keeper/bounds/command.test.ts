/**
 * Shell-command read boundary (Spec §3.1; CKC-03 AC-23). The build, tests, git log and an in-project
 * grep run; listing the owner's home, reading another directory, `git -C` outside, an out-of-scope
 * path inside `python -c`, a read after `cd ..`, a command substitution and `find /` are refused.
 * Every refusal is matched to its reason, and each is paired with a legal command that must pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBashCommand, checkShellCommand, planShellCommand } from './command.ts';
import { canonicalKey, makeBoundary, type Boundary } from './paths.ts';

let project = '';
let outside = '';
/** The out-of-scope directory written the way a bash user would (forward slashes, or /c/… on Windows). */
let outsideBash = '';
let boundary: Boundary;

function toBash(p: string): string {
  const fwd = p.replaceAll('\\', '/');
  return /^[A-Za-z]:\//.test(fwd) ? `/${fwd[0]!.toLowerCase()}${fwd.slice(2)}` : fwd;
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'pk-cmd-'));
  project = join(base, 'project');
  outside = join(base, 'outside');
  outsideBash = toBash(outside);
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(project, 'src', 'a.ts'), 'x');
  writeFileSync(join(outside, 'secret.txt'), 'x');
  boundary = makeBoundary({ roots: [{ path: project, label: 'the project directory' }], files: [] });
}
setup();

const ok = (command: string, cwd = project) => {
  const d = checkBashCommand(command, cwd, boundary);
  assert.equal(d.ok, true, `expected allowed: ${command} — got ${d.reason ?? ''}`);
};
const denied = (command: string, reason: RegExp, cwd = project) => {
  const d = checkBashCommand(command, cwd, boundary);
  assert.equal(d.ok, false, `expected refused: ${command}`);
  assert.match(d.reason ?? '', reason, command);
};

// ---- should be allowed ----
test('the build and the tests run', () => { ok('npm run build'); ok('npm test'); ok('node --test "src/**/*.test.ts"'); });
test('git log runs', () => { ok('git log -n5 --oneline'); ok('git -C . status'); });
test('an in-project grep runs', () => { ok('grep -rn "pattern" src'); ok('grep -r "D:\\\\looks\\\\like\\\\a\\\\path" .'); });
test('reading a file inside the project runs', () => { ok('cat src/a.ts'); ok('sed -n 1,5p ./src/a.ts'); });
test('a pipeline of in-project commands runs', () => { ok('cat src/a.ts | grep x | wc -l'); });
test('a command with no path arguments runs', () => { ok('echo hello'); ok('pwd'); });

// ---- should be refused ----
test('listing the owner home is refused', () => { denied('ls ~', /read boundary/); ok('ls .'); });
test('reading a file in another directory is refused', () => {
  denied(`cat ${outsideBash}/secret.txt`, /read boundary/);
  ok('cat src/a.ts');
});
test('git -C into a directory outside the project is refused', () => {
  denied(`git -C ${outsideBash} log`, /read boundary/);
  ok('git -C src log');
});
test('an out-of-scope path inside python -c is refused', () => {
  denied(`python -c "open('${outsideBash}/secret.txt').read()"`, /read boundary/);
  ok(`python -c "open('src/a.ts').read()"`);
});
test('a read after cd .. is refused; a read after cd into a subdir is allowed', () => {
  denied('cd .. && cat secret.txt', /read boundary/);
  ok('cd src && cat a.ts');
});
test('a command substitution is refused', () => {
  denied('cat $(ls ~)', /cannot be checked before it runs|command substitution/);
  denied('echo `cat /etc/passwd`', /cannot be checked before it runs/);
  ok('echo done');
});
test('find / is refused; find in the project is allowed', () => {
  denied('find / -name "*.pem"', /read boundary/);
  ok('find src -name "*.ts"');
});

// ---- further guardrail cases ----
test('an absolute path input redirection out of scope is refused; an in-scope one is allowed', () => {
  denied(`cat < ${outsideBash}/secret.txt`, /read boundary/);
  ok('cat < src/a.ts');
});
test('eval and a variable in a path position are refused', () => {
  denied('eval "cat /etc/passwd"', /eval/);
  denied('cat $HOME/.netrc', /cannot be checked before it runs/);
  ok('echo $HOME');   // a bare variable that is not a path is fine
  ok('cat src/a.ts');
});
test('git --git-dir outside the project is refused', () => {
  denied(`git --git-dir=${outsideBash}/.git log`, /read boundary/);
  ok('git --git-dir=.git log');
});
test('output redirection into the project is refused; scratch output is allowed', () => {
  const writes = [project];
  const blocked = checkBashCommand('git ls-files src > src_list.txt', project, boundary, 0, writes);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason ?? '', /shell.*write|project.*write/i);
  const permitted = checkBashCommand(`git ls-files src > ${toBash(outside)}/out.txt`, project, boundary, 0, writes);
  assert.equal(permitted.ok, true);
});
test('literal tee, cp, rm and sed -i project writes are refused before execution', () => {
  for (const command of ['tee src/a.ts', 'cp src/a.ts src/copy.ts', 'rm src/a.ts', "sed -i 's/x/y/' src/a.ts"]) {
    const d = checkBashCommand(command, project, boundary, 0, [project]);
    assert.equal(d.ok, false, command);
    assert.match(d.reason ?? '', /shell cannot write project files/, command);
  }
});
test('git mutations that can change a linked worktree or its shared metadata are refused', () => {
  for (const command of ['git commit -m x', 'git -C . checkout main', 'git worktree add ../new', 'git config --local user.name Someone']) {
    const d = checkBashCommand(command, project, boundary, 0, [project]);
    assert.equal(d.ok, false, command);
    assert.match(d.reason ?? '', /shell cannot write project files/, command);
  }
  ok('git status');
  ok('git worktree list');
  ok('git config --local --get user.name');
});
test('git arguments containing command substitution are refused even after an output redirection', () => {
  denied('git ls-files src > src_list.txt && git blame --line-porcelain main -- $(head -30 src_list.txt)', /command substitution/);
});
test('tr character classes containing a literal backslash n are data, not paths', () => {
  ok("ls src | tr '\\n' ' '");
  ok("git ls-files src/keeper/organize | tr '\\n' ' '");
  ok("for f in graph-fit graph-tools; do echo $f; done | tr '\\n' ' '");
  ok("ls src | sort | tr '\\n' ' '; echo");
});
test('running a script by an out-of-scope path is refused', () => {
  denied(`bash ${outsideBash}/x.sh`, /read boundary/);
  denied(`${outsideBash}/x.sh`, /read boundary/);
  ok('bash src/build.sh');
});
test('a heredoc body is data, not a command or path', () => {
  ok('cat <<EOF\n/etc/passwd is only text here\nEOF');
});

// ---- what a command says it writes (BQ) ----
test('the check names what a command writes and nothing it only reads, and naming them changes no decision', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pk-cmd-scratch-'));
  const bounds = makeBoundary({ roots: [{ path: project, label: 'the project directory' }, { path: scratch, label: 'scratch' }], files: [] });
  const key = (name: string) => canonicalKey(join(project, name), project);
  const inScratch = (name: string) => canonicalKey(join(scratch, name), scratch);
  const written = (command: string, writeRoots: readonly string[] = []) => {
    const plan = planShellCommand('bash', command, project, bounds, writeRoots, scratch);
    assert.deepEqual(plan.decision, checkShellCommand('bash', command, project, bounds, writeRoots, scratch), `the same decision as without naming: ${command}`);
    return [...plan.writePaths].sort();
  };
  // A redirection into the project is refused as before; it is still named, for a refusal that misjudged one.
  assert.deepEqual(written('git ls-files src > list.txt'), [key('list.txt')]);
  assert.equal(planShellCommand('bash', 'git ls-files src > list.txt', project, bounds, [project], scratch).decision.ok, false);
  assert.deepEqual(written('printf x > "$TMPDIR/out.txt"', [project]), [inScratch('out.txt')]);
  // The operands of the commands that write theirs; mv's sources too, since it removes them.
  assert.deepEqual(written('tee a.txt b.txt'), [key('a.txt'), key('b.txt')].sort());
  assert.deepEqual(written('cp src/a.ts copy.ts'), [key('copy.ts')]);
  assert.deepEqual(written('mv src/a.ts moved.ts'), [key('moved.ts'), key('src/a.ts')].sort());
  assert.deepEqual(written('mv src/a.ts "$TMPDIR/away.ts"', [project]), [inScratch('away.ts'), key('src/a.ts')].sort());
  assert.deepEqual(written("sed -i 's/x/y/' src/a.ts"), [key('src/a.ts')]);
  // Output options: any command's --output (and its spellings), the few whose -o names the output file, dd's of=, git's.
  assert.deepEqual(written('sort -o sorted.txt src/a.ts'), [key('sorted.txt')]);
  assert.deepEqual(written('npx esbuild src/a.ts --outfile=dist/a.js'), [key('dist/a.js')]);
  assert.deepEqual(written('pandoc --output notes.html src/a.ts'), [key('notes.html')]);
  assert.deepEqual(written('dd if=src/a.ts of=copy.bin'), [key('copy.bin')]);
  assert.deepEqual(written('git log --output=log.txt -1'), [key('log.txt')]);
  assert.deepEqual(written('git format-patch -o patches HEAD~1'), [key('patches')]);
  // What a command only reads is not named, nor what inline code or a program might open.
  for (const command of ['cat src/a.ts', 'head -5 src/a.ts', 'grep -rn x src', 'grep -o x src/a.ts', 'ls -o src', 'sed -n 1,5p src/a.ts',
    'wc -l src/a.ts', 'git log --oneline -1 -- src/a.ts', 'git diff --stat', 'node -e "require(\'fs\').readFileSync(\'src/a.ts\')"', 'npm run build']) {
    assert.deepEqual(written(command), [], command);
  }
});
