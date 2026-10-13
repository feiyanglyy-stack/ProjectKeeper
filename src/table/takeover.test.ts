/**
 * `pk takeover` (src/table/takeover.ts): the three-step takeover by the table (D107). A small project — a git
 * repository with a nested repository of its own, files git ignores, a node_modules, an earlier table and a new file —
 * with a Claude Code session planted under a scratch user home is laid out in a fresh home: the owner folder holds the
 * session material and nothing of the project, the reader folder a copy of the project with its histories and without
 * what git ignores, the instructions name the real HEADs and paths, and nothing is written into the project. Then the
 * steps are run by a stand-in for Codex that writes canned outputs: a merged table that checks clean lands at its
 * destination and is taken in, and one that does not stops the run with nothing taken in.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

// The ledger reads the session stores of the user's home, and the model library its settings: both point into the scratch.
const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'pk-takeover-'));
process.env.USERPROFILE = scratch;
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(scratch, 'pi-'));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const { git } = await import('../util/git.ts');
const { canonicalPath, claudeProjectDirName, isWithin } = await import('../util/paths.ts');
const { prepareTakeover, runTakeover, pkCommand, MAIN_TABLE_FILE } = await import('./takeover.ts');

const SESSION = '11111111-1111-4111-8111-111111111111';
const claude = `claude:${SESSION}`;
const commitAll = (dir: string) => {
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-q', '-m', 'first']]) assert.ok(git(dir, args).ok);
  return git(dir, ['rev-parse', '--short', 'HEAD']).out.trim();
};
const put = (dir: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); }
};

/** The project: its own repository, `app/` a repository of its own (and ignored by the outer one), and what is not kept. */
function project(): { dir: string; commit: string; app: string } {
  const dir = canonicalPath(mkdtempSync(join(scratch, 'tiny-')));
  put(dir, { 'README.md': '# Tiny\n\nA read-later list for one person.\n', 'src/capture.ts': 'export const capture = 1;\n', '.gitignore': 'dist/\nlocal/\napp/\n*.log\n' });
  const commit = commitAll(dir);
  put(join(dir, 'app'), { 'main.ts': 'export const main = 1;\n' });
  const app = commitAll(join(dir, 'app'));
  put(dir, {
    'NEW.md': 'Written after the last commit.\n',
    'node_modules/lib/index.js': 'module.exports = 1;\n',
    'dist/out.js': 'built\n',
    'local/words.md': 'The owner\'s exported words.\n',
    'debug.log': 'log\n',
    'projectkeeper/project.json': '{ "earlier": true }\n',
  });
  return { dir, commit, app };
}

function plantClaude(cwd: string): void {
  const dir = join(scratch, '.claude', 'projects', claudeProjectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const user = (at: string, content: string) => ({ sessionId: SESSION, cwd, type: 'user', timestamp: at, origin: { kind: 'human' }, message: { role: 'user', content } });
  const agent = (at: string, text: string) => ({ sessionId: SESSION, cwd, type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  writeFileSync(join(dir, `${SESSION}.jsonl`), [
    user('2026-09-20T01:00:00.000Z', 'I want a read-later list that saves in one keystroke.'),
    agent('2026-09-20T01:01:00.000Z', 'Shall I build search before anything else, and leave the polish for later?'),
    user('2026-09-20T01:02:00.000Z', 'Yes: search first, polish later.'),
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/** Every path under a folder, `.git` internals left out (git may touch its own index). */
function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      out.push(relative(dir, full).split('\\').join('/'));
      if (e.isDirectory() && e.name !== '.git') walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

test('pk takeover --prepare: three isolated folders, the instructions with the real HEADs and paths, nothing in the project', async () => {
  const p = project();
  plantClaude(p.dir);
  const before = listing(p.dir);
  const home = join(scratch, 'home-prepare');
  const t = await prepareTakeover({ projectDir: p.dir, home, now: new Date('2026-10-13T17:30:20Z') });

  // The work folder is in ProjectKeeper's own folder for the project, never in the project.
  assert.equal(t.workDir, join(canonicalPath(home), 'projects', t.projectId, 'table', 'takeover-20261013-173020'));
  assert.ok(!isWithin(p.dir, t.workDir));
  assert.deepEqual(listing(p.dir), before, 'nothing was written inside the project');
  assert.equal(readFileSync(join(p.dir, 'projectkeeper', 'project.json'), 'utf8'), '{ "earlier": true }\n');

  // owner/: the session material, the template and the instructions, and nothing of the project.
  const { owner, reader, main } = t.steps;
  assert.deepEqual(readdirSync(owner.folder).sort(), ['instructions.md', 'session-material.jsonl', 'session-material.md', 'template']);
  assert.ok(existsSync(join(owner.folder, 'template', 'FILLING-IN.md')) && existsSync(join(owner.folder, 'template', 'projectkeeper.schema.json')));
  assert.match(readFileSync(join(owner.folder, 'session-material.md'), 'utf8'), /Yes: search first, polish later\./);
  assert.equal(t.ownerMessages, 2);

  // project-reader/: a copy of the project with each repository's history, without what git ignores or node_modules.
  assert.deepEqual(readdirSync(reader.folder).sort(), ['instructions.md', 'project', 'template']);
  const copy = t.readerProject;
  for (const kept of ['README.md', 'src/capture.ts', '.gitignore', 'NEW.md', 'app/main.ts', '.git/HEAD', 'app/.git/HEAD']) assert.ok(existsSync(join(copy, kept)), `${kept} is copied`);
  for (const left of ['node_modules', 'dist', 'local', 'debug.log', 'projectkeeper']) assert.ok(!existsSync(join(copy, left)), `${left} is left out`);
  assert.equal(git(copy, ['rev-parse', '--short', 'HEAD']).out.trim(), p.commit);
  assert.equal(git(join(copy, 'app'), ['rev-parse', '--short', 'HEAD']).out.trim(), p.app);
  assert.deepEqual(t.repos, [{ path: '.', commit: p.commit }, { path: 'app', commit: p.app }]);
  assert.ok(t.skipped.includes('node_modules/') && t.skipped.includes('dist/') && t.skipped.includes('debug.log') && t.skipped.includes('projectkeeper/'));

  // The instructions: the trials' text with the real HEADs, the paths and the exact check commands.
  const pk = pkCommand();
  const ownerText = readFileSync(owner.instructions, 'utf8');
  assert.match(ownerText, /只读原话这一路/);
  assert.ok(ownerText.includes('全部 2 句话（来自 1 个会话）'));
  assert.ok(ownerText.includes(`${pk} check --owner-part owner-part.json --sessions session-material.jsonl`));
  const readerText = readFileSync(reader.instructions, 'utf8');
  assert.match(readerText, /只读项目这一路/);
  assert.ok(readerText.includes(`- \`project/\` 本身，HEAD 是 \`${p.commit}\`；`));
  assert.ok(readerText.includes(`- \`project/app/\`，HEAD 是 \`${p.app}\`。`));
  assert.ok(readerText.includes(`[{ "path": ".", "commit": "${p.commit}" }, { "path": "app", "commit": "${p.app}" }]`));
  assert.ok(readerText.includes('时间停在 2026-10-13'));
  assert.ok(readerText.includes(`${pk} check project/projectkeeper/project.json --project project`));
  assert.equal(main.folder, t.workDir);
  const mainText = readFileSync(main.instructions, 'utf8');
  assert.match(mainText, /main agent/);
  assert.ok(mainText.includes(`${pk} check ${MAIN_TABLE_FILE} --project project-reader/project --sessions owner/session-material.jsonl`));
  assert.ok(mainText.includes('只在这个文件夹（`takeover-20261013-173020/`）里活动'));
  // The trials' commits never reach another project's instructions. The check command names this install's own pk,
  // which may well be D:/ProjectKeeper on the machine the trials ran on, so it is held to pkCommand() above instead.
  for (const text of [ownerText, readerText, mainText]) assert.doesNotMatch(text, /b93d4ae|eba65bb/, 'no commit of the trials is hard-coded');

  // The table goes into ProjectKeeper's own folder by default, and into the project only when asked.
  assert.equal(t.tableIn, 'home');
  assert.equal(t.destination, join(canonicalPath(home), 'projects', t.projectId, 'table', 'project.json'));
  assert.ok(t.importCommand.startsWith(`${pk} import `) && t.importCommand.includes('--sessions') && t.importCommand.includes(t.destination));
  const again = await prepareTakeover({ projectDir: p.dir, home, tableIn: 'project', now: new Date('2026-10-13T17:30:20Z') });
  assert.equal(again.destination, join(p.dir, 'projectkeeper', 'project.json'));
  assert.equal(again.workDir, `${t.workDir}-2`, 'a second takeover in the same second gets its own folder');
  assert.deepEqual(listing(p.dir), before, 'still nothing in the project');
});

// ───────────────────────── run, with a stand-in for Codex ─────────────────────────

/** Writes the canned output of whichever step it is run on, as Codex would, and records how it was called. */
const STAND_IN = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const folder = at('-C');
const stdin = readFileSync(0, 'utf8');
const step = existsSync(join(folder, 'main-instructions.md')) ? 'main' : existsSync(join(folder, 'project')) ? 'reader' : 'owner';
const out = step === 'main' ? join(folder, 'project.json') : step === 'reader' ? join(folder, 'project', 'projectkeeper', 'project.json') : join(folder, 'owner-part.json');
const canned = process.env.PK_TEST_CANNED;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, readFileSync(join(canned, step + '.json')));
writeFileSync(join(canned, step + '.call.json'), JSON.stringify({ args, cwd: process.cwd(), stdin: stdin.slice(0, 40) }));
process.stdout.write(JSON.stringify({ type: 'thread.started' }) + '\\n');
writeFileSync(at('-o'), step + ' done\\n');
`;

function cannedOutputs(p: { commit: string; app: string }, dir: string, badQuote: boolean): void {
  const readme = { file: 'README.md', lines: '3', quote: 'A read-later list' };
  const route2 = {
    format: 'projectkeeper.table/1',
    project: { name: 'Tiny', asOf: { date: '2026-10-13', repos: [{ path: '.', commit: p.commit }, { path: 'app', commit: p.app }] }, filledBy: { agent: 'stand-in', at: '2026-10-13' } },
    ownerWants: [],
    product: { id: 'Tiny', name: 'Tiny', summary: 'A read-later list.', forWhom: 'One person.', sources: [readme] },
    goals: [], areas: [{ id: 'A1', name: 'Capture', summary: 'Saving a page.', status: 'Current', sources: [readme] }],
    requirements: [], designs: [], decisions: [], plans: [], work: [],
    code: [{ id: 'capture', name: 'Capture', summary: 'Saving.', area: 'A1', paths: ['src/capture.ts', 'app/main.ts'] }],
    notes: [{ id: 'N-P1', title: 'No plan is written down.', kind: 'Anomaly', ask: 'For information', by: 'Project', on: ['A1'], text: 'Only a README.', sources: [readme] }],
  };
  const want = {
    id: 'W1', want: 'Search comes first.', kind: 'Product', status: 'Current',
    said: [{ session: claude, message: 2, quote: badQuote ? 'accounts first' : 'search first, polish later' }],
    approvedProposal: { part: 'build search before anything else', source: { session: claude, message: 1 } }, reflectedIn: [] as string[],
  };
  const ownerNote = { id: 'N-O1', title: 'Search is all the owner has asked for.', kind: 'Question', ask: 'Worth discussing', by: "Owner's words", on: ['W1'], text: 'Nothing else is said.', sources: [{ session: claude, message: 0 }] };
  const ownerPart = { ownerWants: [{ ...want, said: [{ session: claude, message: 2, quote: 'search first, polish later' }] }], notes: [ownerNote] };
  const merged = {
    ...route2,
    ownerWants: [{ ...want, reflectedIn: ['A1'] }],
    notes: [...route2.notes, ownerNote, {
      id: 'N-M1', title: 'The owner wants search first; the project has no search.', kind: 'Owner and project differ', ask: 'For your decision', by: 'Main agent',
      on: ['W1', 'A1'], text: 'Only capture is built.', sources: [{ session: claude, message: 2 }, readme],
    }],
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'owner.json'), JSON.stringify(ownerPart, null, 2));
  writeFileSync(join(dir, 'reader.json'), JSON.stringify(route2, null, 2));
  writeFileSync(join(dir, 'main.json'), JSON.stringify(merged, null, 2));
}

const standIn = join(scratch, 'stand-in-codex.mjs');
writeFileSync(standIn, STAND_IN);
const workspaceRecord = (home: string, id: string) => JSON.parse(readFileSync(join(canonicalPath(home), 'workspace.json'), 'utf8')).projects.find((x: { id: string }) => x.id === id);

test('pk takeover --run codex: the routes, then the main agent; a merged table that checks clean is placed and taken in', async () => {
  const p = project();
  plantClaude(p.dir);
  const before = listing(p.dir);
  const home = join(scratch, 'home-run');
  const canned = join(scratch, 'canned-good');
  cannedOutputs(p, canned, false);
  process.env.PK_TEST_CANNED = canned;
  const lines: string[] = [];
  const r = await runTakeover({ projectDir: p.dir, home, agentCommand: [process.execPath, standIn], log: (l) => lines.push(l) });
  const t = r.prepared;
  assert.equal(r.stopped, null, JSON.stringify(r.problems));
  assert.deepEqual(r.routeProblems, { owner: [], reader: [] });

  // Each step ran in its own folder, with Codex's arguments as the trials gave them and the instructions on stdin.
  const call = (step: string) => JSON.parse(readFileSync(join(canned, `${step}.call.json`), 'utf8')) as { args: string[]; cwd: string; stdin: string };
  for (const [step, folder] of [['owner', t.steps.owner.folder], ['reader', t.steps.reader.folder], ['main', t.workDir]] as const) {
    const c = call(step);
    assert.equal(canonicalPath(c.cwd), canonicalPath(folder));
    assert.equal(c.args[c.args.indexOf('-C') + 1], folder);
    assert.match(c.stdin, /^# 任务/);
    assert.deepEqual(c.args.slice(0, 1), ['exec']);
    assert.ok(!c.args.includes('-m'), 'no model given: Codex uses its own default');
    for (const a of ['model_reasoning_effort=high', 'memories.use_memories=false', 'memories.generate_memories=false', 'workspace-write', '--skip-git-repo-check', '--json']) assert.ok(c.args.includes(a), a);
    assert.equal(c.args.at(-1), '-');
  }
  for (const step of ['owner', 'project-reader', 'main']) {
    for (const f of ['events.jsonl', 'stderr.txt', 'started.txt', 'ended.txt', 'last-message.md']) assert.ok(existsSync(join(t.workDir, 'runs', step, f)), `${step}/${f}`);
  }
  assert.deepEqual(r.runs.map((x) => [x.step, x.exitCode]), [['owner', 0], ['project-reader', 0], ['main', 0]]);
  assert.equal(r.runs[2]!.lastMessage, 'main done\n');

  // The table at its destination, taken in, and the project's record pointing at the destination.
  assert.equal(t.destination, join(canonicalPath(home), 'projects', t.projectId, 'table', 'project.json'));
  assert.equal(readFileSync(t.destination, 'utf8'), readFileSync(join(canned, 'main.json'), 'utf8'));
  assert.deepEqual(r.imported!.problems, []);
  assert.ok(r.imported!.counts!.graph.nodes > 0);
  const record = workspaceRecord(home, t.projectId);
  assert.equal(record.takenOverByTable.file, t.destination);
  assert.equal(record.takenOverByTable.by, 'stand-in');
  assert.deepEqual(listing(p.dir), before, 'nothing was written inside the project');
  assert.ok(lines.some((l) => l.startsWith('Routes 1 and 2 running')) && lines.some((l) => l.startsWith('Main agent running')));

  // Given a model and an effort, they pass through.
  const second = await runTakeover({ projectDir: p.dir, home, agentCommand: [process.execPath, standIn], model: 'gpt-test', effort: 'medium' });
  assert.equal(second.stopped, null);
  const args = call('main').args;
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-test');
  assert.ok(args.includes('model_reasoning_effort=medium'));
  // The table it replaced at the destination is kept in the new work folder.
  assert.equal(second.previousTable, join(second.prepared.workDir, 'previous-project.json'));
  assert.ok(existsSync(second.previousTable!));
});

test('pk takeover --run codex: a merged table that fails the check stops the run, and nothing is placed or taken in', async () => {
  const p = project();
  plantClaude(p.dir);
  const home = join(scratch, 'home-fail');
  const canned = join(scratch, 'canned-bad');
  cannedOutputs(p, canned, true);
  process.env.PK_TEST_CANNED = canned;
  const r = await runTakeover({ projectDir: p.dir, home, tableIn: 'project', agentCommand: [process.execPath, standIn] });
  const t = r.prepared;
  assert.deepEqual(r.stopped?.after, 'check');
  assert.match(r.problems.map((x) => `${x.at} ${x.problem}`).join('\n'), /\/ownerWants\/0\/said\/0\/quote the quote does not stand word for word in message 2 of claude:/);
  assert.equal(r.imported, null);
  // The merged table stays in the work folder; the project's own earlier table is untouched and nothing was taken in.
  assert.ok(existsSync(t.steps.main.output));
  assert.equal(t.destination, join(p.dir, 'projectkeeper', 'project.json'));
  assert.equal(readFileSync(t.destination, 'utf8'), '{ "earlier": true }\n');
  assert.equal(workspaceRecord(home, t.projectId).takenOverByTable, undefined);
});

test('pk takeover --run codex: a route that writes nothing stops the run before the main agent', async () => {
  const p = project();
  plantClaude(p.dir);
  const home = join(scratch, 'home-missing');
  const r = await runTakeover({ projectDir: p.dir, home, agentCommand: [process.execPath, '-e', 'process.exit(3)'] });
  assert.equal(r.stopped?.after, 'owner');
  assert.match(r.stopped!.why, /owner-part\.json and .*project\.json were not written/);
  assert.deepEqual(r.runs.map((x) => [x.step, x.exitCode]), [['owner', 3], ['project-reader', 3]]);
  assert.equal(r.imported, null);
});
