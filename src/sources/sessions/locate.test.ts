/**
 * Codex homes: `.codex` under the user home, plus whatever `PROJECTKEEPER_CODEX_HOMES` names — a second account's home,
 * say. A name is taken under the user home given (so a frozen copy of a home is read the same way), an absolute path as
 * it is. Everything is built in a temporary directory; nothing of the machine's own homes is read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { claudeSessionFolders, codexHomes, codexSessionRoots, locateClaudeSessions, locateCodexSessions, locateSessions } from './locate.ts';
import { canonicalPath, claudeProjectDirName, sameDirectory } from '../../util/paths.ts';

test('the default Codex home is .codex alone; more homes are named in PROJECTKEEPER_CODEX_HOMES', () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-codex-homes-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'pk-codex-elsewhere-'));
  const before = process.env.PROJECTKEEPER_CODEX_HOMES;
  try {
    const project = join(home, 'work', 'heron');
    const log = (dir: string, id: string) => {
      const day = join(dir, 'sessions', '2026', '09', '22');
      mkdirSync(day, { recursive: true });
      writeFileSync(join(day, `rollout-2026-09-22T10-00-00-${id}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: project } })}\n`);
    };
    log(join(home, '.codex'), 'first');
    log(join(home, '.codex-2'), 'second');
    log(join(elsewhere, 'codex-home'), 'third');

    delete process.env.PROJECTKEEPER_CODEX_HOMES;
    assert.deepEqual(codexHomes(home), [join(home, '.codex')]);
    assert.deepEqual(locateCodexSessions([project], home).map((s) => s.sessionId), ['first'], 'a second home is not read unless it is named');

    process.env.PROJECTKEEPER_CODEX_HOMES = ['.codex-2', join(elsewhere, 'codex-home'), '', '.codex'].join(delimiter);
    assert.deepEqual(codexHomes(home), [join(home, '.codex'), join(home, '.codex-2'), join(elsewhere, 'codex-home')], 'a name under the home, an absolute path as it is, each once');
    assert.equal(codexSessionRoots(home).length, 3);
    assert.deepEqual(locateCodexSessions([project], home).map((s) => s.sessionId).sort(), ['first', 'second', 'third']);

    process.env.PROJECTKEEPER_CODEX_HOMES = '.codex-missing';
    assert.deepEqual(codexSessionRoots(home), [join(home, '.codex', 'sessions')], 'a named home that does not exist is passed over');
  } finally {
    if (before === undefined) delete process.env.PROJECTKEEPER_CODEX_HOMES; else process.env.PROJECTKEEPER_CODEX_HOMES = before;
    rmSync(home, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

/**
 * The spelling a log records. Both hosts write the working directory as the agent's shell spelled it, and Claude Code
 * names its folder after that spelling; the directories asked for are in the file system's own. An invented project,
 * "Heron" (a tide table), is built under its real name and worked in through a junction (a link, on other systems).
 */
function heron(): { home: string; real: string; link: string; cleanup: () => void } {
  const base = canonicalPath(mkdtempSync(join(tmpdir(), 'pk-locate-spelling-')));
  const home = join(base, 'home');
  const real = join(base, 'work', 'heron');
  mkdirSync(real, { recursive: true });
  mkdirSync(home);
  symlinkSync(join(base, 'work'), join(base, 'through'), 'junction');
  return { home, real, link: join(base, 'through', 'heron'), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
function claudeLog(home: string, cwd: string, id: string, recorded: string | null = cwd): string {
  const dir = join(home, '.claude', 'projects', claudeProjectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', sessionId: id, ...(recorded ? { cwd: recorded } : {}), message: { role: 'user', content: 'High water at six.' } })}\n`);
  return join(dir, `${id}.jsonl`);
}
function codexLog(home: string, cwd: string, id: string): string {
  const day = join(home, '.codex', 'sessions', '2026', '09', '22');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-09-22T10-00-00-${id}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id, cwd } })}\n`);
  return join(day, `rollout-2026-09-22T10-00-00-${id}.jsonl`);
}
const found = (sessions: readonly { sessionId: string; cwd: string | null; matchedCwd: string | null }[]) => sessions.map((s) => [s.sessionId, s.cwd, s.matchedCwd]);

test('a session recorded through a junction is a session of the directory the junction leads to; the spelling it records is kept', () => {
  const { home, real, link, cleanup } = heron();
  try {
    assert.notEqual(link, real);
    assert.equal(canonicalPath(link), real, 'two spellings of one directory');
    claudeLog(home, real, 'claude-real');
    claudeLog(home, link, 'claude-link');
    codexLog(home, real, 'codex-real');
    codexLog(home, link, 'codex-link');
    // Sessions of other directories, recorded through the junction too: one inside the project, one beside it.
    mkdirSync(join(real, 'docs'));
    mkdirSync(join(dirname(real), 'heron-lab'));
    [join(link, 'docs'), join(dirname(link), 'heron-lab')].forEach((other, i) => { claudeLog(home, other, `claude-elsewhere-${i}`); codexLog(home, other, `codex-elsewhere-${i}`); });

    assert.deepEqual(found(locateClaudeSessions([real], home)).sort(), [['claude-link', link, real], ['claude-real', real, real]]);
    assert.deepEqual(found(locateCodexSessions([real], home)).sort(), [['codex-link', link, real], ['codex-real', real, real]]);
    assert.deepEqual(claudeSessionFolders([real], home).map((f) => [basename(f.dir), f.cwd]).sort(), [[claudeProjectDirName(link), real], [claudeProjectDirName(real), real]].sort(), 'both folders are the directory’s');
    assert.equal(sameDirectory(link, real), true);
    assert.equal(sameDirectory(join(link, 'docs'), real), false, 'a directory inside it is another directory');
  } finally { cleanup(); }
});

test('a recorded directory that no longer exists is compared as text: sessions recorded through a junction that is gone are not found', () => {
  const { home, real, link, cleanup } = heron();
  try {
    claudeLog(home, link, 'claude-link');
    codexLog(home, link, 'codex-link');
    assert.equal(locateSessions([real], home).length, 2, 'found while the junction stands');
    rmSync(dirname(link));   // the junction itself; what it led to stays
    assert.ok(existsSync(real));
    assert.deepEqual(locateSessions([real], home), [], 'the file system can no longer say what that spelling named');
  } finally { cleanup(); }
});

test('a project directory that is gone: the part of a recorded spelling that still exists is asked, the rest compared as text', () => {
  const { home, real, link, cleanup } = heron();
  try {
    claudeLog(home, real, 'claude-real');
    claudeLog(home, link, 'claude-link');
    codexLog(home, link, 'codex-link');
    claudeLog(home, join(dirname(link), 'heron-lab'), 'claude-lab');   // never there, and under another name
    rmSync(real, { recursive: true });   // moved away, say; the junction above it stands
    assert.deepEqual(found(locateSessions([real], home)).sort(), [['claude-link', link, real], ['claude-real', real, real], ['codex-link', link, real]]);
  } finally { cleanup(); }
});

test('a Claude Code folder is taken for another spelling of a directory only on its own log’s word', () => {
  const { home, real, link, cleanup } = heron();
  try {
    // A folder named after the junction whose log names no directory, and one whose log names a directory the folder is not named after.
    claudeLog(home, link, 'claude-silent', null);
    assert.deepEqual(locateClaudeSessions([real], home), [], 'a folder no log speaks for is not the directory’s');
    const strange = join(home, '.claude', 'projects', 'some-other-folder');
    mkdirSync(strange);
    writeFileSync(join(strange, 'claude-strange.jsonl'), `${JSON.stringify({ type: 'user', sessionId: 'claude-strange', cwd: link })}\n`);
    assert.deepEqual(locateClaudeSessions([real], home), [], 'nor a folder that is not named after the directory its log records');
    // The folder named after the directory asked for holds its sessions whatever each log records, as before; a log
    // there that records some other directory is located, and belongs to none of the directories asked for.
    const elsewhere = join(dirname(real), 'heron-lab');
    claudeLog(home, real, 'claude-silent-real', null);
    writeFileSync(join(home, '.claude', 'projects', claudeProjectDirName(real), 'claude-elsewhere.jsonl'), `${JSON.stringify({ type: 'user', sessionId: 'claude-elsewhere', cwd: elsewhere })}\n`);
    assert.deepEqual(found(locateClaudeSessions([real], home)).sort(), [['claude-elsewhere', elsewhere, null], ['claude-silent-real', real, real]]);
  } finally { cleanup(); }
});

test('a session recorded under another case, or the other Unicode form, of the directory’s name is its session where the file system takes them for one name', (t) => {
  // A Mac's usual volume takes `Café` in either case and in either Unicode form — composed, as a shell tool writes it,
  // or decomposed, as Finder does — for one name; Windows takes either case. An agent's log records whichever its shell
  // had, and Claude Code names its folder from those very characters, so the two forms give two folder names.
  const base = canonicalPath(mkdtempSync(join(tmpdir(), 'pk-locate-forms-')));
  try {
    const home = join(base, 'home');
    mkdirSync(home);
    const composed = 'Café-가';
    mkdirSync(join(base, 'work', composed.normalize('NFD')), { recursive: true });
    const real = canonicalPath(join(base, 'work', composed.normalize('NFD')));   // as the file system spells it
    const spellings = [
      ['in another case', join(base, 'WORK', composed.normalize('NFD').toUpperCase())],
      ['in the composed form', join(base, 'work', composed)],
      ['in the decomposed form', join(base, 'work', composed.normalize('NFD'))],
    ].filter(([, spelling]) => spelling !== real && existsSync(spelling!)) as [string, string][];
    if (spellings.length === 0) { t.skip('this file system takes a name in another case or Unicode form for another name'); return; }
    const expected: string[][] = [];
    spellings.forEach(([how, spelling], i) => {
      t.diagnostic(`asked: ${how}`);
      claudeLog(home, spelling, `claude-${i}`);
      codexLog(home, spelling, `codex-${i}`);
      expected.push([`claude-${i}`, spelling, real], [`codex-${i}`, spelling, real]);
    });
    claudeLog(home, join(base, 'work', 'Cafe'), 'claude-other');   // another name altogether
    assert.deepEqual(found(locateSessions([real], home)).sort(), expected.sort(), 'each is found, keeps the spelling its log records, and is the directory’s');
    for (const [, spelling] of spellings) assert.equal(sameDirectory(spelling, real), true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
