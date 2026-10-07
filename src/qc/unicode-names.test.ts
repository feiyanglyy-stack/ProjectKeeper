/**
 * A document whose name is stored decomposed.
 *
 * A name with an accent, a Korean syllable or a voiced Japanese kana has two Unicode forms: composed (NFC, `é` as one
 * character) and decomposed (NFD, `e` and an accent). Finder and Cocoa applications write the decomposed one; a shell
 * tool writes what was typed; a Mac's usual volume takes either for the same file and lists the one it was written in.
 * git, on a Mac, reports names composed when the repository says `core.precomposeunicode` (which `git init` and
 * `git clone` write there). So the walk over the files and the history can give one document two names. A path's
 * comparison key folds the form on macOS (util/paths.ts `foldForSystem`); whether every place that joins a file on
 * disk to its history does is what this asks, on the system the tests run on:
 *
 * - the file is read once, under one path;
 * - the ledger has one document with both its versions;
 * - asked for the file by its path on disk — as the file walk spells it, and by whichever other form the file system
 *   takes — the ledger gives the document's current text.
 *
 * On Windows and Linux a name is the characters it was written with, the two forms are two files, and all of this
 * holds as a matter of course. The project is invented ("Kestrel", a bird-count sheet).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from '../util/tmp.test-helpers.ts';

// ───────────────────────── isolation from the machine ─────────────────────────

const base = mkdtempSync(join(tmpdir(), 'pk-unicode-'));
const machine = join(base, 'machine');
mkdirSync(join(machine, 'pi-agent'), { recursive: true });
writeFileSync(join(machine, 'gitconfig'), '');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(machine, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  HOME: machine, USERPROFILE: machine, PI_CODING_AGENT_DIR: join(machine, 'pi-agent'),
});
for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[name];
after(() => { try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* the system clears its temporary directory */ } });

const { App } = await import('../server/app.ts');
const { Ledger } = await import('../ledger/index.ts');
const { ledgerPath, rebuildLedgerInPlace } = await import('../ledger/rebuild.ts');

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Kestrel Dev', '-c', 'user.email=dev@kestrel.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const put = (root: string, rel: string, text: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

const COMPOSED = 'Café-가-plan.md';
const DECOMPOSED = COMPOSED.normalize('NFD');
const form = (name: string | undefined): string => (name === DECOMPOSED ? 'decomposed' : name === COMPOSED ? 'composed' : `in another form (${JSON.stringify(name)})`);
const FIRST = '# Plan\n\n- K-1 count by species\n';
const SECOND = '# Plan\n\n- K-1 count by species\n- K-2 count at dusk too\n';

test('a document whose name is stored decomposed is one document: read once, with its history, and found by its path on disk', async (t) => {
  const repo = join(base, 'kestrel');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  put(repo, 'README.md', '# Kestrel\n\nA sheet for counting birds from a hide.\n');
  put(repo, `docs/${DECOMPOSED}`, FIRST);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'K-1: the plan');
  put(repo, `docs/${DECOMPOSED}`, SECOND);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'K-2: dusk');

  // What this system makes of the name: said in the log, since what follows rests on it.
  const listed = readdirSync(join(repo, 'docs')).find((name) => name.endsWith('-plan.md'));
  const tracked = git(repo, 'ls-files', '-z', '--', 'docs').split('\0').map((p) => basename(p)).find((name) => name.endsWith('-plan.md'));
  const takesBoth = existsSync(join(repo, 'docs', COMPOSED));
  t.diagnostic(`written decomposed; listed ${form(listed)}; git lists it ${form(tracked)}; the composed form names the same file: ${takesBoth}`);

  const home = join(base, 'home');
  const app = new App(home, { organizing: false });
  let ledger: { close(): void } | null = null;
  try {
    app.workspace.setSettings({ watchProjects: false });
    const added = app.addProject('Kestrel', [repo]);
    await app.intakeProject(added.id);
    const project = app.project(added.id);
    const store = app.store(added.id);

    // The file walk: the document is read, under one path.
    const read = store.sources.filter((s) => s.anchor.kind === 'file' && basename(s.anchor.path).normalize('NFC') === COMPOSED);
    assert.ok(read.length > 0, 'the document is read from disk');
    const onDisk = [...new Set(read.map((s) => (s.anchor.kind === 'file' ? s.anchor.path : '')))];
    assert.equal(onDisk.length, 1, `under one path: ${onDisk.map((p) => form(basename(p))).join(', ')}`);

    // The history: one document, both versions.
    rebuildLedgerInPlace(ledgerPath(added.id, home), project);
    const history = Ledger.openPath(ledgerPath(added.id, home));
    assert.ok(history, 'the ledger is built');
    ledger = history;
    const versions = history.allVersions().filter((v) => v.path.normalize('NFC') === `docs/${COMPOSED}`);
    assert.equal(new Set(versions.map((v) => v.path)).size, 1, `one name in the history: ${[...new Set(versions.map((v) => form(basename(v.path))))].join(', ')}`);
    assert.equal(versions.length, 2, 'with both its versions');

    // The join: the file as the walk spells it is the document the history has.
    assert.equal(history.currentText(onDisk[0]!), SECOND, `asked by its path on disk (${form(basename(onDisk[0]!))}; the history names it ${form(basename(versions[0]!.path))}), the ledger gives its current text`);
    for (const name of [COMPOSED, DECOMPOSED]) {
      if (!existsSync(join(repo, 'docs', name))) continue;   // on this file system that form names another file, which is not there
      assert.equal(history.currentText(join(repo, 'docs', name)), SECOND, `and by the ${form(name)} form of its name, which this file system takes for the same file`);
    }
  } finally {
    ledger?.close();
    app.stopAll();
    await app.flushAll();
  }
});
