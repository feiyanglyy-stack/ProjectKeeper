/**
 * `pk sessions` (src/table/sessions.ts): the session material written from a project's ledger. A small git project with
 * its agent sessions planted where Claude Code and Codex keep them under a scratch user home — an interactive Claude
 * Code session, a Codex session, and two headless runs that must stay out — is opened in a fresh home; the material
 * names each session `host:id` and each message by the ledger's number, puts the agent's answer before the owner's
 * message, lands in ProjectKeeper's own folder for the project, and `pk check` holds a table's citation against it.
 * An output folder inside the project is refused before anything is opened (D107).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The ledger reads the session stores of the user's home, and the model library its settings: both point into the scratch.
const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-sessions-'));
process.env.USERPROFILE = scratch;
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(scratch, 'pi-'));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const { git } = await import('../util/git.ts');
const { canonicalPath, claudeProjectDirName, isWithin } = await import('../util/paths.ts');
const { exportProjectSessions, JSONL_FILE, MARKDOWN_FILE } = await import('./sessions.ts');
const { checkFacts, readSessionMaterial } = await import('./check.ts');
const { Ledger } = await import('../ledger/index.ts');

const CLAUDE = '11111111-1111-4111-8111-111111111111';
const CLAUDE_SDK = '33333333-3333-4333-8333-333333333333';
const CODEX = '22222222-2222-4222-8222-222222222222';
const CODEX_EXEC = '44444444-4444-4444-8444-444444444444';

function project(): { dir: string; commit: string } {
  const dir = canonicalPath(mkdtempSync(join(scratch, 'tiny-')));
  writeFileSync(join(dir, 'README.md'), '# Tiny\n\nA read-later list for one person.\n');
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-q', '-m', 'first']]) assert.ok(git(dir, args).ok);
  return { dir, commit: git(dir, ['rev-parse', 'HEAD']).out.trim() };
}

const jsonl = (lines: readonly object[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

/** Claude Code logs under `~/.claude/projects/<the folder's name>`: an interactive session and an SDK (headless) run. */
function plantClaude(cwd: string): void {
  const dir = join(scratch, '.claude', 'projects', claudeProjectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const user = (id: string, at: string, content: string, extra: object = {}) => ({ sessionId: id, cwd, type: 'user', timestamp: at, origin: { kind: 'human' }, message: { role: 'user', content }, ...extra });
  const agent = (id: string, at: string, text: string, extra: object = {}) => ({ sessionId: id, cwd, type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });
  writeFileSync(join(dir, `${CLAUDE}.jsonl`), jsonl([
    user(CLAUDE, '2026-09-20T01:00:00.000Z', 'I want a read-later list that saves in one keystroke.'),
    agent(CLAUDE, '2026-09-20T01:01:00.000Z', 'Shall I build search before anything else, and leave the polish for later?'),
    user(CLAUDE, '2026-09-20T01:02:00.000Z', 'Yes: search first, polish later.'),
  ]));
  const sdk = { entrypoint: 'sdk-cli' };
  writeFileSync(join(dir, `${CLAUDE_SDK}.jsonl`), jsonl([
    user(CLAUDE_SDK, '2026-09-20T02:00:00.000Z', 'Headless prompt: audit the capture code.', sdk),
    agent(CLAUDE_SDK, '2026-09-20T02:01:00.000Z', 'Audited.', sdk),
  ]));
}

/** Codex logs under `~/.codex/sessions/<y>/<m>/<d>`: an interactive session and an `exec` (headless) run. */
function plantCodex(cwd: string): void {
  const dir = join(scratch, '.codex', 'sessions', '2026', '09', '21');
  mkdirSync(dir, { recursive: true });
  const meta = (id: string, source: string) => ({ timestamp: '2026-09-21T01:00:00.000Z', type: 'session_meta', payload: { id, cwd, source } });
  const said = (at: string, role: 'user' | 'assistant', text: string) => ({ timestamp: at, type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
  writeFileSync(join(dir, `rollout-2026-09-21T01-00-00-${CODEX}.jsonl`), jsonl([
    meta(CODEX, 'cli'),
    said('2026-09-21T01:01:00.000Z', 'assistant', 'The import is done. Do you want the tag browser next?'),
    said('2026-09-21T01:02:00.000Z', 'user', 'No tag browser; drop it.'),
  ]));
  writeFileSync(join(dir, `rollout-2026-09-21T02-00-00-${CODEX_EXEC}.jsonl`), jsonl([
    meta(CODEX_EXEC, 'exec'),
    said('2026-09-21T02:01:00.000Z', 'user', 'Exec prompt: list the defects.'),
  ]));
}

test('pk sessions: the owner messages with the answers before them, named as the table cites them, outside the project', async () => {
  const p = project();
  plantClaude(p.dir);
  plantCodex(p.dir);
  const home = join(scratch, 'home');
  const r = await exportProjectSessions({ projectDir: p.dir, home });
  assert.equal(r.added, true);
  assert.deepEqual(r.warnings, []);

  // Into ProjectKeeper's own folder for the project, never into the project (D107).
  assert.equal(r.outDir, join(canonicalPath(home), 'projects', r.projectId, 'table'));
  assert.ok(!isWithin(p.dir, r.outDir));
  assert.ok(existsSync(join(r.outDir, MARKDOWN_FILE)) && existsSync(join(r.outDir, JSONL_FILE)));

  const records = readFileSync(r.jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { session: string; message: number; role: string; text: string });
  const claude = `claude:${CLAUDE}`;
  const codex = `codex:${CODEX}`;
  // Oldest first; each owner message after the agent's answer it replies to; numbered as the ledger numbers them.
  assert.deepEqual(records.map((x) => [x.session, x.message, x.role]), [
    [claude, 0, 'owner'], [claude, 1, 'agent'], [claude, 2, 'owner'], [codex, 0, 'agent'], [codex, 1, 'owner'],
  ]);
  assert.equal(records.find((x) => x.session === claude && x.message === 1)!.text, 'Shall I build search before anything else, and leave the polish for later?');
  // Headless runs are a program's prompts, not the owner's: the ledger has them, the material leaves them out.
  const ledger = Ledger.openDir(join(canonicalPath(home), 'projects', r.projectId))!;
  try {
    const recorded = ledger.sessions({ limit: 50 }).rows.map((s) => [`${s.host}:${s.sessionId}`, s.headless]).sort();
    assert.deepEqual(recorded, [[claude, false], [`claude:${CLAUDE_SDK}`, true], [codex, false], [`codex:${CODEX_EXEC}`, true]]);
  } finally { ledger.close(); }
  const all = readFileSync(r.jsonl, 'utf8') + readFileSync(r.markdown, 'utf8');
  for (const left of [CLAUDE_SDK, CODEX_EXEC, 'Headless prompt', 'Exec prompt']) assert.ok(!all.includes(left), `${left} is left out`);
  assert.deepEqual([r.ownerMessages, r.records, r.sessions], [3, 5, 2]);

  // The Markdown: a heading per owner message, the answer before it, or a word that the session starts there.
  const md = readFileSync(r.markdown, 'utf8');
  assert.match(md, /^# Session material\n/);
  assert.match(md, /\{ "session": "<name>", "message": <number> \}/);
  assert.ok(md.includes(`## ${claude} · message 0 · 2026-09-20 01:00 UTC\n\n(No agent answer before it: the session starts here.)\n\nOwner, message 0:\n\n<owner>\nI want a read-later list that saves in one keystroke.\n</owner>`));
  assert.ok(md.includes(`## ${claude} · message 2 · 2026-09-20 01:02 UTC\n\nAgent, message 1:\n\n<agent>\nShall I build search before anything else, and leave the polish for later?\n</agent>\n\nOwner, message 2:\n\n<owner>\nYes: search first, polish later.\n</owner>`));
  assert.ok(md.includes(`## ${codex} · message 1 · 2026-09-21 01:02 UTC`));

  // `pk check` holds a table's citation of an exported message against the material: the quote stands, a wrong one does not.
  const sessions = readSessionMaterial(r.jsonl);
  const table = (quote: string) => ({
    project: { name: 'Tiny', asOf: { date: '2026-10-13', repos: [{ path: '.', commit: p.commit }] }, filledBy: { agent: 'test', at: '2026-10-13' } },
    product: { id: 'Tiny', sources: [{ file: 'README.md', lines: '3', quote: 'A read-later list' }] },
    ownerWants: [{
      id: 'W1', want: 'Search comes first.', kind: 'Product', status: 'Current',
      said: [{ session: claude, message: 2, quote }],
      approvedProposal: { part: 'build search before anything else', source: { session: claude, message: 1 } },
    }],
  });
  assert.deepEqual(checkFacts(table('search first, polish later'), p.dir, sessions), []);
  assert.match(checkFacts(table('accounts first'), p.dir, sessions).map((x) => x.problem).join('\n'), /does not stand word for word in message 2 of claude:/);

  // Exported again into the same home: the same project, the same material.
  const again = await exportProjectSessions({ projectDir: p.dir, home });
  assert.deepEqual([again.added, again.projectId, again.records], [false, r.projectId, 5]);
});

test('pk sessions refuses an output folder inside the project, before anything is opened', async () => {
  const p = project();
  const home = join(scratch, 'home-refused');
  await assert.rejects(exportProjectSessions({ projectDir: p.dir, home, out: join(p.dir, 'projectkeeper') }), /inside the project folder.*owner's words.*public repository.*D107/s);
  await assert.rejects(exportProjectSessions({ projectDir: p.dir, home, out: p.dir }), /inside the project folder/);
  assert.equal(existsSync(home), false, 'no home was made');
  assert.equal(existsSync(join(p.dir, 'projectkeeper')), false, 'nothing was written into the project');
  // An --out outside the project is taken as given.
  const out = join(scratch, 'material');
  const r = await exportProjectSessions({ projectDir: p.dir, home, out });
  assert.equal(r.outDir, out);
  assert.equal(r.ownerMessages, 0);
  assert.equal(readFileSync(join(out, JSONL_FILE), 'utf8'), '');
});
