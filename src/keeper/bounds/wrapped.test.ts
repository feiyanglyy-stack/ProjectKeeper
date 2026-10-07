/**
 * A command that runs another command (Spec §3.1; CKC-03 AC-23; CKC-26 AC-8). The shell check decides by a command's
 * first word, so a wrapper in front used to hide the command from every rule: `git push`, `git commit`, `rm -rf src`
 * were refused, and `env git push`, `timeout 5 git commit`, `find . -exec rm {} \;`, `if true; then rm -rf src; fi`
 * ran. On a live project the write guard undoes only what the check names as a command's writes, so nothing undid
 * them afterwards either. The command a wrapper runs is now judged as a command of its own.
 *
 * Table-driven: every wrapper with every command that is refused bare — still refused — and with every command that
 * runs bare — still runs, with the same decision. Nothing is run; the check is asked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkShellCommand, planShellCommand } from './command.ts';
import { canonicalKey, makeBoundary } from './paths.ts';

const base = mkdtempSync(join(tmpdir(), 'pk-wrapped-'));
const project = join(base, 'project');
const outside = join(base, 'outside');
mkdirSync(join(project, 'src'), { recursive: true });
mkdirSync(outside);
writeFileSync(join(project, 'src', 'a.ts'), 'x');
writeFileSync(join(project, 'build.sh'), 'git commit -am built\n');
writeFileSync(join(outside, 'secret.txt'), 'x');
const boundary = makeBoundary({ roots: [{ path: project, label: 'the project directory' }], files: [] });
const outsideBash = outside.replaceAll('\\', '/');

const decide = (command: string, shell: 'bash' | 'powershell' = 'bash') => checkShellCommand(shell, command, project, boundary, [project]);
const dq = (c: string) => `"${c.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const sq = (c: string) => `'${c.replaceAll("'", "'\\''")}'`;

/** Refused when typed as they are, each by a rule that looks at the first word. */
const REFUSED = [
  'git push origin main', 'git commit -m x', 'git reset --hard', 'git checkout -b x', 'git config --get user.name',
  'rm -rf src', 'mv src/a.ts src/b.ts', 'cp src/a.ts src/b.ts', 'tee src/a.ts', 'touch src/new.ts', 'sed -i s/x/y/ src/a.ts',
  'git credential fill', 'gh auth token',
  `cat ${outsideBash}/secret.txt`, `python -c "open('${outsideBash}/secret.txt')"`, `bash ${outsideBash}/run.sh`, 'bash build.sh', 'sudo ls',
];
/** These run when typed as they are. */
const ALLOWED = ['git status', 'git log --oneline -3', 'ls', 'ls -la src', 'rg x src', 'cat src/a.ts', 'grep -rn x src', 'node -e "console.log(1)"', 'wc -l src/a.ts'];

/**
 * Each way of putting a command behind another. `transparent`: the wrapper adds nothing to the command it runs.
 * `joins`: it hands a shell its words joined by spaces, so what was quoted for it is not quoted for that shell (as
 * `watch` and `parallel` really do: `watch node -e "f(1)"` does not run either).
 */
const WRAPPERS: readonly { name: string; wrap: (c: string) => string; transparent?: boolean; joins?: boolean }[] = [
  { name: 'env', wrap: (c) => `env ${c}`, transparent: true },
  { name: 'env NAME=value', wrap: (c) => `env FOO=1 BAR=2 ${c}`, transparent: true },
  { name: 'env -i', wrap: (c) => `env -i ${c}`, transparent: true },
  { name: 'env -u NAME', wrap: (c) => `env -u FOO --unset=BAR ${c}`, transparent: true },
  { name: 'env -S', wrap: (c) => `env -S ${dq(c)}` },
  { name: 'env --', wrap: (c) => `env -- ${c}`, transparent: true },
  { name: 'command', wrap: (c) => `command ${c}`, transparent: true },
  { name: 'command -p --', wrap: (c) => `command -p -- ${c}`, transparent: true },
  { name: 'exec', wrap: (c) => `exec ${c}`, transparent: true },
  { name: 'exec -a name', wrap: (c) => `exec -a other ${c}`, transparent: true },
  { name: 'builtin', wrap: (c) => `builtin ${c}`, transparent: true },
  { name: 'nohup', wrap: (c) => `nohup ${c}`, transparent: true },
  { name: 'nice', wrap: (c) => `nice ${c}`, transparent: true },
  { name: 'nice -n 5', wrap: (c) => `nice -n 5 ${c}`, transparent: true },
  { name: 'nice -5', wrap: (c) => `nice -5 ${c}`, transparent: true },
  { name: 'timeout 5', wrap: (c) => `timeout 5 ${c}`, transparent: true },
  { name: 'timeout -s KILL -k 1 5', wrap: (c) => `timeout -s KILL -k 1 --preserve-status 5 ${c}`, transparent: true },
  { name: 'time', wrap: (c) => `time ${c}`, transparent: true },
  { name: 'time -p', wrap: (c) => `time -p ${c}`, transparent: true },
  { name: 'stdbuf -oL', wrap: (c) => `stdbuf -oL -e 0 ${c}`, transparent: true },
  { name: 'setsid', wrap: (c) => `setsid -w ${c}`, transparent: true },
  { name: 'ionice -c3', wrap: (c) => `ionice -c3 ${c}`, transparent: true },
  { name: 'ionice -c 2 -n 7', wrap: (c) => `ionice -c 2 -n 7 ${c}`, transparent: true },
  { name: 'caffeinate -i', wrap: (c) => `caffeinate -i -t 60 ${c}`, transparent: true },
  { name: 'winpty', wrap: (c) => `winpty -Xallow-non-tty ${c}`, transparent: true },
  { name: 'busybox', wrap: (c) => `busybox ${c}`, transparent: true },
  { name: 'unbuffer', wrap: (c) => `unbuffer ${c}`, transparent: true },
  { name: 'a wrapper of a wrapper', wrap: (c) => `env FOO=1 nice -n 5 timeout 5 nohup ${c}`, transparent: true },
  { name: 'an assignment, then a wrapper', wrap: (c) => `FOO=1 env ${c}`, transparent: true },
  { name: 'xargs', wrap: (c) => `echo | xargs ${c}` },
  { name: 'xargs -n1 -P 4 -r', wrap: (c) => `echo | xargs -n1 -P 4 -r ${c}` },
  { name: 'xargs -I{}', wrap: (c) => `echo x | xargs -I{} ${c}`, transparent: true },
  { name: 'find -exec ;', wrap: (c) => `find . -maxdepth 0 -exec ${c} \\;`, transparent: true },
  { name: 'find -exec +', wrap: (c) => `find src -name a.ts -exec ${c} {} +` },
  { name: 'find -execdir', wrap: (c) => `find . -maxdepth 0 -execdir ${c} \\;`, transparent: true },
  { name: 'find -ok', wrap: (c) => `find . -maxdepth 0 -ok ${c} \\;`, transparent: true },
  { name: 'find -exec, twice', wrap: (c) => `find . -maxdepth 0 -exec ls \\; -exec ${c} \\;`, transparent: true },
  { name: 'watch', wrap: (c) => `watch ${c}`, joins: true },
  { name: 'watch -n 1 quoted', wrap: (c) => `watch -n 1 -d ${dq(c)}`, transparent: true },
  { name: 'parallel', wrap: (c) => `parallel ${c} ::: a`, joins: true },
  { name: 'parallel, the commands as arguments', wrap: (c) => `parallel ::: ${dq(c)}`, transparent: true },
  { name: 'bash -c', wrap: (c) => `bash -c ${dq(c)}`, transparent: true },
  { name: 'sh -c', wrap: (c) => `sh -c ${sq(c)}`, transparent: true },
  { name: 'bash -lc', wrap: (c) => `bash -lc ${dq(c)}`, transparent: true },
  { name: 'bash -euxc', wrap: (c) => `bash -euxc ${dq(c)}`, transparent: true },
  { name: 'bash -c --', wrap: (c) => `bash -c -- ${dq(c)}`, transparent: true },
  { name: 'bash --noprofile -c', wrap: (c) => `bash --noprofile --norc -c ${dq(c)}`, transparent: true },
  { name: 'busybox sh -c', wrap: (c) => `busybox sh -c ${dq(c)}`, transparent: true },
  { name: 'env bash -c', wrap: (c) => `env bash -c ${dq(c)}`, transparent: true },
  { name: 'if', wrap: (c) => `if ${c}; then echo y; fi`, transparent: true },
  { name: 'then', wrap: (c) => `if true; then ${c}; fi`, transparent: true },
  { name: 'elif, else', wrap: (c) => `if false; then :; elif ${c}; then :; else ${c}; fi`, transparent: true },
  { name: 'while', wrap: (c) => `while ${c}; do break; done`, transparent: true },
  { name: 'until', wrap: (c) => `until ${c}; do break; done`, transparent: true },
  { name: 'do', wrap: (c) => `for i in 1 2; do ${c}; done`, transparent: true },
  { name: '!', wrap: (c) => `! ${c}`, transparent: true },
  { name: '{ }', wrap: (c) => `{ ${c}; }`, transparent: true },
  { name: 'a function, then its call', wrap: (c) => `f() { ${c}; }; f`, transparent: true },
  { name: 'function f { }', wrap: (c) => `function f { ${c}; }; f`, transparent: true },
  { name: 'coproc', wrap: (c) => `coproc ${c}`, transparent: true },
  { name: 'a subshell', wrap: (c) => `( ${c} )`, transparent: true },
  { name: 'after &&, ||, ; and |', wrap: (c) => `true && ${c} || ${c}; echo x | ${c}` },
  { name: 'in the background', wrap: (c) => `${c} &`, transparent: true },
  { name: 'trap', wrap: (c) => `trap ${sq(c)} EXIT`, transparent: true },
  { name: 'alias', wrap: (c) => `alias g=${sq(c)}; g`, transparent: true },
  { name: 'cmd /c', wrap: (c) => `cmd /c ${c}`, joins: true },
  { name: 'cmd //c quoted', wrap: (c) => `cmd //c ${dq(c)}` },
  { name: 'powershell -Command', wrap: (c) => `powershell -NoProfile -Command ${dq(c)}` },
  { name: 'pwsh -c', wrap: (c) => `pwsh -c ${dq(c)}` },
  { name: 'powershell, the command with no option', wrap: (c) => `powershell ${dq(c)}` },
];

test('a command refused as it stands is refused behind every wrapper; behind one that adds nothing to it, for the same reason', () => {
  for (const command of REFUSED) {
    const bare = decide(command);
    assert.equal(bare.ok, false, `refused as it stands: ${command}`);
    for (const { name, wrap, transparent } of WRAPPERS) {
      const wrapped = decide(wrap(command));
      assert.equal(wrapped.ok, false, `${name}: ${wrap(command)}`);
      if (transparent && command !== 'sudo ls') assert.equal(wrapped.reason, bare.reason, `${name}: ${wrap(command)}`);
    }
  }
});

test('a command that runs as it stands runs behind every wrapper', () => {
  for (const command of ALLOWED) {
    assert.deepEqual(decide(command), { ok: true, reason: null, detail: null }, command);
    for (const { name, wrap, joins } of WRAPPERS) {
      if (joins && /["']/.test(command)) continue;
      assert.deepEqual(decide(wrap(command)), { ok: true, reason: null, detail: null }, `${name}: ${wrap(command)}`);
    }
  }
});

test('the writes of a wrapped command are named for the write guard like the bare command’s', () => {
  const written = (command: string) => planShellCommand('bash', command, project, boundary, [], join(base, 'scratch')).writePaths;
  const key = (rel: string) => canonicalKey(rel, project);
  for (const { name, wrap, transparent } of WRAPPERS) {
    if (!transparent) continue;
    assert.deepEqual(written(wrap('rm -rf src/gen')), [key('src/gen')], `${name}: rm`);
    assert.deepEqual(written(wrap('cp src/a.ts out/b.ts')), [key('out/b.ts')], `${name}: cp`);
  }
  assert.deepEqual(written('find src -name "*.tmp" -delete'), [key('src')], 'find -delete writes where it starts');
  assert.deepEqual(written('find . -type f -fprint list.txt'), [key('list.txt')]);
});

test('a wrapper’s own words are told from its command, and where they cannot be the command is refused', () => {
  const undeterminable = (command: string, what: RegExp) => { const d = decide(command); assert.equal(d.ok, false, command); assert.match(d.reason ?? '', what, command); };
  // An option the check does not know could take the next word as its value.
  undeterminable('env --frobnicate git status', /env with an option this check does not know \(--frobnicate\)/);
  undeterminable('timeout --frobnicate 5 git status', /timeout with an option this check does not know/);
  undeterminable('xargs --frobnicate git status', /xargs with an option this check does not know/);
  undeterminable('/usr/bin/time -o src/t.txt git status', /time with an option this check does not know \(-o\)/);
  // A command whose name, or whose git subcommand, is computed.
  undeterminable('G=git; $G push origin main', /a command whose name is computed/);
  undeterminable('"$TOOL" src/a.ts', /a command whose name is computed/);
  undeterminable('echo push | xargs git', /a computed git subcommand/);
  undeterminable('echo a.ts | xargs rm', /a computed output path/);
  undeterminable('find src -name "*.ts" -exec rm {} \\;', /a computed output path/);
  undeterminable('echo x | xargs -I{} {} status', /a command whose name is computed/);
  undeterminable('parallel git ::: push status', /a computed git subcommand/);
  // The wrapper's own operands are still read: a directory to change to, a file of arguments, the places find starts.
  assert.match(decide(`env -C ${outsideBash} ls`).reason ?? '', /read boundary/);
  assert.match(decide(`find ${outsideBash} -name x -exec ls {} \\;`).reason ?? '', /read boundary/);
  assert.match(decide(`xargs -a ${outsideBash}/list.txt ls`).reason ?? '', /read boundary/);
  assert.match(decide(`parallel cat ::: ${outsideBash}/secret.txt`).reason ?? '', /read boundary/);
  assert.match(decide('env GIT_TRACE_CURL=1 git ls-remote origin').reason ?? '', /trace switches/);
  assert.match(decide(`env GIT_DIR=${outsideBash}/.git git log`).reason ?? '', /read boundary/);
  assert.match(decide('find src -name "*.tmp" -delete').reason ?? '', /shell cannot write project files \(src\)/);
  // A wrapper that is asked something, or given nothing to run, is an ordinary command.
  for (const command of ['command -v git', 'command -V ls', 'env', 'nice', 'timeout 5', 'busybox --list', 'ionice -p 1', 'xargs', 'find src -name "*.ts"', 'trap - EXIT', 'alias', 'exec 3< src/a.ts', 'time', 'echo a | xargs']) {
    assert.equal(decide(command).ok, true, `${command}: ${decide(command).reason}`);
  }
  // A cd made behind a word of the shell holds; one made by a program does not exist.
  assert.equal(decide('command cd src && cat a.ts').ok, true);
  assert.match(decide('builtin cd .. && ls').reason ?? '', /read boundary/);
  assert.match(decide('if cd ..; then ls; fi').reason ?? '', /read boundary/);
  assert.equal(decide('{ cd src; cat a.ts; }').ok, true);
});

test('programs that run a command as someone else, or start one apart from the command, are refused outright', () => {
  for (const command of ['sudo git status', 'sudo -u someone ls', 'doas ls', 'su -c "ls"', 'runas /user:someone cmd', 'pkexec ls', 'chroot / ls', 'start notepad', 'schtasks /create /tn x /tr "git push"', 'wmic process call create "git push"']) {
    const d = decide(command);
    assert.equal(d.ok, false, command);
    assert.match(d.reason ?? '', /runs a command as another user|starts a program apart from this command/, command);
  }
});

test('code given to an interpreter under its letters written together is read as code: bash -lc, python -uc, perl -ne, node -pe', () => {
  for (const command of [
    `python -uc "open('${outsideBash}/secret.txt')"`, `python3 -Bc "open('${outsideBash}/secret.txt')"`, `perl -ne 'open(F, "${outsideBash}/secret.txt")'`,
    `node -pe "require('fs').readFileSync('${outsideBash}/secret.txt')"`, `ruby -ne 'File.read("${outsideBash}/secret.txt")'`, `python -c -- "open('${outsideBash}/secret.txt')"`,
  ]) {
    const d = decide(command);
    assert.equal(d.ok, false, command);
    assert.match(d.reason ?? '', /read boundary/, command);
  }
  for (const command of ['bash -lc "ls src"', 'python -uc "print(1)"', 'perl -ne "print" src/a.ts', 'node -pe "1+1"', 'bash -x build.sh'.replace('build.sh', 'src/none.sh')]) assert.equal(decide(command).ok, true, `${command}: ${decide(command).reason}`);
});
