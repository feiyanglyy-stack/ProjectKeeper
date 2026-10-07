/**
 * Names stored decomposed.
 *
 * A name with an accent, a Korean syllable or a voiced Japanese kana has two Unicode forms: composed (NFC, `é` as one
 * character) and decomposed (NFD, `e` and an accent). Finder and Cocoa applications write the decomposed one; a shell
 * tool writes what was typed. A Mac's usual volume takes either for the same file and lists the one it was written in,
 * and git on a Mac reports every name composed (`core.precomposeunicode`, which `git init` and `git clone` write
 * there). So the walk over the files and the history gave one document two names. On the first macOS run of these
 * tests the ledger, asked for the text of a file by the name the walk had listed, answered that it had none.
 *
 * A name is now brought to one form where it enters from outside git (util/paths.ts `nameForm`): a directory listing,
 * a change the watcher reports, a path somebody wrote, a path made relative to a location. This asks every place that
 * joins a name from the file system with a name from git, on the system the tests run on:
 *
 * - the file walk reads a document once, under one path, and passes over a file the ignore rules leave out;
 * - the ledger has one document with both its versions, and one code file;
 * - asked by a file's path on disk, or by a path as a directory listing writes it, the ledger gives the document's
 *   text and versions, and the code file's text;
 * - a material rule covers a directory whichever form the rule names it in;
 * - a file written while the project is watched is reported under the name the walk would read it under;
 * - git says what became of a file that is gone, asked about under either form;
 * - the history of a path is read whichever form the path is given in.
 *
 * On Windows and Linux a name is the characters it was written with: the two forms are two files, each is asked about
 * only in the form it has, and all of this holds as a matter of course. The project is invented ("Kestrel", a
 * bird-count sheet).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from '../util/tmp.test-helpers.ts';
import type { ProjectRule } from '../model/types.ts';

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
const { applyMaterialRules } = await import('../intake/material-rules.ts');
const { gitFates } = await import('../intake/removal.ts');
const { pathHistory } = await import('../sources/history.ts');
const { nameForm } = await import('../util/paths.ts');

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Kestrel Dev', '-c', 'user.email=dev@kestrel.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const put = (root: string, rel: string, text: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

/** Every name here is written to disk decomposed, as Finder writes it. */
const nfd = (name: string): string => name.normalize('NFD');
const nfc = (name: string): string => name.normalize('NFC');
const PLAN = 'Café-가-plan.md';          // a document with a history
const DRAFT = 'Résumé.draft.md';         // a file the ignore rules leave out
const GONE = 'Ancien-été.md';            // a document a commit deleted
const ATTIC = 'Größe-attic';              // a directory a material rule names
const CODE = 'Zähler.ts';                     // a code file
const LATER = 'Aube-début.md';                // a document written while the project is watched
const form = (name: string | undefined): string => (name === undefined ? 'not at all' : name === nfd(name) && name !== nfc(name) ? 'decomposed' : name === nfc(name) ? 'composed' : `in another form (${JSON.stringify(name)})`);
const FIRST = '# Plan\n\n- K-1 count by species\n';
const SECOND = '# Plan\n\n- K-1 count by species\n- K-2 count at dusk too\n';
const COUNTER = 'export const tally = (seen: number): number => seen + 1;\n';

test('a name stored decomposed is one name everywhere a file on disk meets its history', async (t) => {
  const repo = join(base, 'kestrel');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  put(repo, '.gitignore', '*.draft.md\n');
  put(repo, 'README.md', '# Kestrel\n\nA sheet for counting birds from a hide.\n');
  put(repo, `docs/${nfd(PLAN)}`, FIRST);
  put(repo, `docs/${nfd(GONE)}`, '# Last summer\n\nCounted from the old hide.\n');
  put(repo, `${nfd(ATTIC)}/notes.md`, '# Notes\n\nKept from the first season.\n');
  put(repo, `src/${nfd(CODE)}`, COUNTER);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'K-1: the plan');
  put(repo, `docs/${nfd(PLAN)}`, SECOND);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'K-2: dusk');
  rmSync(join(repo, 'docs', nfd(GONE)));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Last summer’s sheet goes');
  put(repo, `docs/${nfd(DRAFT)}`, '# Draft\n\nNot for the history.\n');

  // What this system makes of a name: said in the log, since what follows rests on it.
  const listed = readdirSync(join(repo, 'docs')).find((name) => name.endsWith('-plan.md'));
  const tracked = git(repo, 'ls-files', '-z', '--', 'docs').split('\0').map((p) => basename(p)).find((name) => name.endsWith('-plan.md'));
  /** Whether the file system takes the composed form for the file that was written decomposed. */
  const takesBoth = existsSync(join(repo, 'docs', nfc(PLAN)));
  t.diagnostic(`written decomposed; listed ${form(listed)}; git lists it ${form(tracked)}; the composed form names the same file: ${takesBoth}`);
  /** The forms a name may be asked about in here: the one it was written in, and the other where the file system takes both. */
  const forms = (name: string): string[] => (takesBoth ? [nfd(name), nfc(name)] : [nfd(name)]);

  const home = join(base, 'home');
  const app = new App(home, { organizing: false });
  let ledger: { close(): void } | null = null;
  try {
    app.workspace.setSettings({ watchProjects: false });
    const added = app.addProject('Kestrel', [repo]);
    await app.intakeProject(added.id);
    const project = app.project(added.id);
    const store = app.store(added.id);
    const filesNamed = (name: string) => store.sources.filter((s) => s.anchor.kind === 'file' && nfc(basename(s.anchor.path)) === nfc(name));
    const pathsOf = (name: string) => [...new Set(filesNamed(name).map((s) => (s.anchor.kind === 'file' ? s.anchor.path : '')))];

    // ── the file walk ──
    assert.ok(filesNamed(PLAN).length > 0, 'the document is read from disk');
    const onDisk = pathsOf(PLAN);
    assert.equal(onDisk.length, 1, `under one path: ${onDisk.map((p) => form(basename(p))).join(', ')}`);
    assert.equal(basename(onDisk[0]!), nameForm(nfd(PLAN)), 'in the form names are kept in on this system');
    assert.deepEqual(filesNamed(DRAFT), [], 'a file the ignore rules leave out is not read, whichever form git and the listing give its name in');
    assert.ok(filesNamed('notes.md').length > 0, 'a file in a directory with such a name is read');

    // ── the history ──
    rebuildLedgerInPlace(ledgerPath(added.id, home), project);
    const history = Ledger.openPath(ledgerPath(added.id, home));
    assert.ok(history, 'the ledger is built');
    ledger = history;
    const versions = history.allVersions().filter((v) => nfc(v.path) === `docs/${nfc(PLAN)}`);
    assert.equal(new Set(versions.map((v) => v.path)).size, 1, `one name in the history: ${[...new Set(versions.map((v) => form(basename(v.path))))].join(', ')}`);
    assert.equal(versions.length, 2, 'with both its versions');
    const codeFiles = history.allCodeFiles().filter((f) => nfc(f.key).endsWith(`src/${nfc(CODE)}`));
    assert.equal(codeFiles.length, 1, 'and the code file once');

    // ── a file on disk, asked of the ledger ──
    assert.equal(history.currentText(onDisk[0]!), SECOND, `asked by the path the walk read it under (${form(basename(onDisk[0]!))}; the history names it ${form(basename(versions[0]!.path))}), the ledger gives the document's current text`);
    for (const name of forms(PLAN)) {
      const how = `asked by the ${form(name)} form of the name`;
      assert.equal(history.currentText(join(repo, 'docs', name)), SECOND, `${how}, the ledger gives the document's current text`);
      const asked = history.docVersions(`docs/${name}`);
      assert.ok(typeof asked !== 'string', `${how}, the ledger finds the document's versions: ${String(asked)}`);
      assert.equal(asked.versions.length, 2, `${how}: both versions`);
      const commits = pathHistory(project, { path: `docs/${name}` });
      assert.ok(typeof commits !== 'string', `${how}, git gives the path's history: ${String(commits)}`);
      assert.equal(commits.rows.length, 2, `${how}: both commits`);
    }
    for (const name of forms(CODE)) {
      const refs = history.fileRefs(`src/${name}`);
      assert.ok(typeof refs !== 'string', `asked by the ${form(name)} form of its name, the ledger knows the code file: ${String(refs)}`);
      assert.equal(refs.lines, 1);
    }

    // ── a material rule that names the directory ──
    const notes = () => store.sources.filter((s) => s.anchor.kind === 'file' && basename(s.anchor.path) === 'notes.md');
    forms(ATTIC).forEach((name, i) => {
      for (const old of store.rules.all()) store.rules.put({ ...old, validity: 'Replaced', replacedBy: `rule_attic_${i}` });
      store.rules.put({ id: `rule_attic_${i}`, projectId: added.id, group: 'Material rules', category: 'Recovery only', summary: 'the attic is kept for recovery only', excerpt: 'the attic is kept for recovery only', sourceIds: [], appliesTo: [`${name}/`], basis: 'Explicit', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: 'job_frame', asOf: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' } as ProjectRule);
      applyMaterialRules(store, project);
      assert.deepEqual(notes().map((s) => [s.usedAs, s.usedAsByRuleId]), notes().map(() => ['History only', `rule_attic_${i}`]), `a rule that names the directory in the ${form(name)} form covers what lies in it`);
    });

    // ── a change the watcher reports ──
    const watcher = app.startWatching(added.id);
    await new Promise((r) => setTimeout(r, 300));
    put(repo, `docs/${nfd(LATER)}`, '# Dawn\n\n- K-3 count at dawn too\n');
    const reported = () => watcher.list().find((c) => c.kind === 'file' && nfc(basename(c.ref)) === nfc(LATER));
    for (let i = 0; i < 50 && !reported(); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.equal(basename(reported()?.ref ?? ''), nameForm(nfd(LATER)), 'a new file is reported under the name the walk would read it under');
    watcher.stop();

    // ── what became of a file that is gone ──
    for (const name of forms(GONE)) {
      const gone = join(repo, 'docs', name);
      const fate = gitFates(project, [gone]).get(gone);
      assert.equal(fate?.fate.kind, 'deleted', `asked about under the ${form(name)} form of its name, git says a commit deleted it`);
    }
  } finally {
    ledger?.close();
    app.stopAll();
    await app.flushAll();
  }
});
