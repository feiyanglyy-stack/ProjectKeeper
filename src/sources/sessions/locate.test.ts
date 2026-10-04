/**
 * Codex homes: `.codex` under the user home, plus whatever `PROJECTKEEPER_CODEX_HOMES` names — a second account's home,
 * say. A name is taken under the user home given (so a frozen copy of a home is read the same way), an absolute path as
 * it is. Everything is built in a temporary directory; nothing of the machine's own homes is read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { codexHomes, codexSessionRoots, locateCodexSessions } from './locate.ts';

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
