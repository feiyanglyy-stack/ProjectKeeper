// What the tests run on, printed into the CI log for reading a failed run: versions, how the temporary directory is
// spelled, and how this system's file system and git treat a name's case and its Unicode form — the things
// ProjectKeeper's path handling rests on (src/util/paths.ts). It only prints: no answer here fails the run.
//
//   node scripts/ci-environment.mjs            before `npm ci`
//   node scripts/ci-environment.mjs --engine   after it: whether the code engine loads on this system
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const say = (what, answer) => console.log(`${what}: ${answer}`);
const attempt = (what, answer) => { try { say(what, answer()); } catch (error) { say(what, `could not be asked (${String(error?.message ?? error).split('\n')[0]})`); } };
const firstLine = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(/\r?\n/)[0];

if (process.argv.includes('--engine')) {
  // The code engine ships one bundle per system and loads a native part when it can (it reads without it otherwise).
  process.env.CODEGRAPH_KERNEL_DEBUG = '1';
  attempt('code engine', () => {
    const engine = createRequire(import.meta.url)('@colbymchenry/codegraph');
    return `loads (${typeof engine.CodeGraph === 'function' ? 'CodeGraph is there' : 'CodeGraph is missing'}) for ${process.platform}-${process.arch}`;
  });
  process.exit(0);
}

say('system', `${process.platform} ${process.arch}, ${os.type()} ${os.release()}`);
say('node', process.version);
attempt('npm', () => execFileSync('npm --version', { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim());
attempt('git', () => firstLine('git', ['--version']));
if (process.platform !== 'win32') attempt('/bin/bash', () => firstLine('/bin/bash', ['--version']));
for (const tool of ['rg', 'fd']) attempt(`${tool} (the model library fetches it when it is not installed)`, () => firstLine(tool, ['--version']));

// The temporary directory as the environment spells it and as the file system does: a short (8.3) name on a Windows
// runner (C:\Users\RUNNER~1\…), a link on macOS (/var/folders/… is /private/var/folders/…).
say('os.tmpdir()', os.tmpdir());
attempt('its real spelling', () => fs.realpathSync.native(os.tmpdir()));
// No git identity is configured on a runner, on purpose: ProjectKeeper and its tests must work without one.
attempt('git identity', () => { try { return firstLine('git', ['config', '--global', 'user.name']) ? 'configured' : 'none'; } catch { return 'none'; } });

const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'pk-Environment-'));
try {
  // Case: does another case name the same directory, and which spelling do the calls give back?
  const otherCase = path.join(path.dirname(dir), path.basename(dir).toUpperCase());
  const insensitive = fs.existsSync(otherCase);
  say('a name in another case is the same name here', insensitive);
  if (insensitive) {
    attempt('fs.realpathSync.native of the other case gives', () => (fs.realpathSync.native(otherCase) === dir ? 'the case on disk' : `another spelling: ${fs.realpathSync.native(otherCase)}`));
    attempt('fs.realpathSync (JavaScript) of the other case gives', () => (fs.realpathSync(otherCase) === dir ? 'the case on disk' : 'the case it was asked in'));
    attempt('process.cwd() after chdir in the other case gives', () => {
      const before = process.cwd();
      process.chdir(otherCase);
      try { return process.cwd() === dir ? 'the case on disk' : `another spelling: ${process.cwd()}`; } finally { process.chdir(before); }
    });
  }

  // Unicode form: a name written decomposed (NFD), as Finder and Cocoa applications write it.
  const composed = 'caf\u00e9-\uac00.md';
  const decomposed = composed.normalize('NFD');
  const form = (name) => (name === decomposed ? 'decomposed (NFD)' : name === composed ? 'composed (NFC)' : `another form: ${JSON.stringify(name)}`);
  fs.writeFileSync(path.join(dir, decomposed), 'x\n');
  attempt('a name written decomposed is listed', () => form(fs.readdirSync(dir).find((name) => name.endsWith('.md')) ?? ''));
  attempt('it opens by its composed form', () => fs.existsSync(path.join(dir, composed)));
  attempt('fs.realpathSync.native of the composed form gives', () => form(path.basename(fs.realpathSync.native(path.join(dir, composed)))));
  attempt('git init', () => { execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' }); return 'done'; });
  for (const key of ['core.precomposeunicode', 'core.ignorecase', 'core.filemode', 'core.symlinks']) {
    attempt(`git ${key} in a new repository`, () => { try { return firstLine('git', ['-C', dir, 'config', key]) || 'not set'; } catch { return 'not set'; } });
  }
  attempt('git lists the decomposed name', () => form(execFileSync('git', ['-C', dir, '-c', 'core.quotePath=false', 'ls-files', '--others', '-z'], { encoding: 'utf8' }).split('\0').find((name) => name.endsWith('.md')) ?? ''));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the system clears its temporary directory */ }
}
