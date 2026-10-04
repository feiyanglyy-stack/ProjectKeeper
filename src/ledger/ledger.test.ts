/**
 * The ledger over real repositories (Spec §1.16, §2.11, §3.11; CKC-22 AC-1…AC-16): every ref's commits with no cap,
 * merges and the trunk, branches that never merged, a worktree with uncommitted work, a tag, the stash; document versions
 * across a move, a cleanup commit and the deleted documents; an import-style root commit in a nested repository whose
 * decisions are dated by what they say (AC-15); the lines that say something was superseded and the project's obsolete
 * list; numbering recognised from an index, names and headings; verdicts in a report; the execution arrangements;
 * file references and tests; sessions, the owner's words and the agent message each answers, and a log that disappears;
 * an incremental rebuild that adds only what is new and keeps every entry id; the adapters the app wires in; the tools.
 *
 * The fixture is an invented project, "Harbor", a shipment tracker: a code repository with a nested notes repository,
 * built in a temporary directory with git. The ledger only ever reads them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Nothing here may look at the real home: sessions are read from a home of our own.
const fakeHome = mkdtempSync(join(tmpdir(), 'pk-ledger-home-'));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
process.env.PROJECTKEEPER_HOME = join(fakeHome, '.projectkeeper');

const { rebuildLedger, rebuildLedgerInPlace, ledgerPath, sessionInputOf } = await import('./rebuild.ts');
const { Ledger } = await import('./index.ts');
const { LedgerService, runNote } = await import('./adapters.ts');
const { ledgerTools } = await import('../keeper/ledger-tools.ts');
const { ProjectStore } = await import('../store/project-store.ts');
const { claudeProjectDirName } = await import('../util/paths.ts');
const { resolveEvidence } = await import('../keeper/evidence.ts');
type Project = import('../model/types.ts').Project;
type ScopeItem = import('../model/types.ts').ScopeItem;

const ENV = { GIT_AUTHOR_NAME: 'Harbor Dev', GIT_AUTHOR_EMAIL: 'dev@harbor.invalid', GIT_COMMITTER_NAME: 'Harbor Dev', GIT_COMMITTER_EMAIL: 'dev@harbor.invalid' };
function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(root: string, rel: string, text: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}
function commit(cwd: string, message: string, date: string, only: string[] | null = null): string {
  git(cwd, ['add', ...(only ?? ['-A'])]);
  git(cwd, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(cwd, ['rev-parse', 'HEAD']);
}

const base = mkdtempSync(join(tmpdir(), 'pk-ledger-'));
const app = join(base, 'harbor');
const notes = join(app, 'notes');
const wt = join(base, 'harbor-wt');
const c: Record<string, string> = {};

// ── the code repository ──
mkdirSync(app);
git(app, ['init', '-q', '-b', 'main']);
write(app, '.gitignore', 'notes/\n');
write(app, 'README.md', '# Harbor\n\nTracks shipments.\n');
write(app, 'docs/PRODUCT.md', '# Harbor product\n\n## 1. What it is\n\nA tracker.\n\n## 2. Home\n\nThe home page is the chat.\n');
const PLAN_SCOPE = '## Scope\n\nEvery shipment of every customer, from the harbour to the warehouse, with its papers.\nThe clerk enters each one by hand at the gate and checks the seal number twice.\n';
write(app, 'docs/PLAN.md', `# Plan\n\nPlan v1: track by hand.\n\n${PLAN_SCOPE}`);
for (const n of [1, 2, 3, 4, 5]) write(app, `docs/old/note-${n}.md`, `# Old note ${n}\n\nScratch.\n`);
write(app, 'src/util.ts', 'export const pad = (s: string) => s.padStart(2);\n');
write(app, 'src/app.ts', "import { pad } from './util.ts';\nexport const main = () => pad('x');\n");
write(app, 'src/app.test.ts', "import { test } from 'node:test';\ntest('pads', () => {});\ntest('runs', () => {});\n");
write(app, 'subagent/INDEX.md', '# Index\n\n| ID | Executor | Prompt |\n|---|---|---|\n| AA | kimi | [AA](AA-kimi-scaffold.md) |\n| AB | glm | [AB](AB-glm-parser.md) |\n| AC | grok | [AC](AC-grok-map.md) |\n');
write(app, 'subagent/AA-kimi-scaffold.md', '---\nid: "AA"\nexecutor: "kimi"\nstatus: "queued"\n---\n# AA — scaffold\n');
c.root = commit(app, 'Start Harbor', '2026-08-10T09:00:00+08:00');
git(app, ['tag', '-a', 'v0.1', '-m', 'first cut'], { GIT_COMMITTER_DATE: '2026-08-10T10:00:00+08:00' });
git(app, ['checkout', '-q', '-b', 'wip/AB-parser']);
write(app, 'src/parser.ts', "import { pad } from './util.ts';\nexport const parse = (s: string) => pad(s);\n");
write(app, 'subagent/AA-kimi-scaffold.md', '---\nid: "AA"\nexecutor: "kimi"\nstatus: "running"\nworktree: "harbor-wt"\nbase_commit: "' + c.root.slice(0, 7) + '"\n---\n# AA — scaffold\n');
c.parser = commit(app, 'AB: add the parser', '2026-08-12T09:00:00+08:00');
git(app, ['checkout', '-q', 'main']);
git(app, ['merge', '-q', '--no-ff', '-m', 'Merge AB: parser', 'wip/AB-parser'], { GIT_AUTHOR_DATE: '2026-08-13T09:00:00+08:00', GIT_COMMITTER_DATE: '2026-08-13T09:00:00+08:00' });
c.merge = git(app, ['rev-parse', 'HEAD']);
mkdirSync(join(app, 'docs', 'plan'), { recursive: true });
git(app, ['mv', 'docs/PLAN.md', 'docs/plan/PLAN.md']);
write(app, 'docs/plan/PLAN.md', `# Plan\n\nPlan v1: track by hand.\n\n${PLAN_SCOPE}\n## Next\n\nPlan v2: track by barcode.\n`);
c.move = commit(app, 'Move the plan into docs/plan\n\nThe old export used api_key=abcdefghijklmnopqrstuvwx for the carrier.', '2026-08-14T09:00:00+08:00');
for (const n of [1, 2, 3, 4, 5]) rmSync(join(app, `docs/old/note-${n}.md`));
c.cleanup = commit(app, 'Clean up the old notes', '2026-08-15T09:00:00+08:00');
write(app, 'docs/PRODUCT.md', [
  '# Harbor product', '', '## 1. What it is', '', 'A tracker.', '', '## 2. Home', '', 'The home page is the harbour map. The chat home is superseded by the map (D2).', '',
  '## 5. 已纠正的旧规则', '', '以下规则曾写在旧计划里，**已作废**。', '', '| 旧规则 | 问题 | 现在 |', '|---|---|---|', '| 聊天当首页 | 看不到船 | 地图当首页 |', '| 每天手动录入 | 太慢 | 扫码 |', '',
].join('\n'));
write(app, 'subagent/reports/AA-report.md', '# AA — QC report\n\n**结论：`fail`**\n\nTests: 12/14 pass\n\n### F-1【严重】the map does not load\n');
c.product = commit(app, 'Product: the map is the home page', '2026-08-16T09:00:00+08:00');
git(app, ['checkout', '-q', '-b', 'wip/AC-map']);
write(app, 'src/map.ts', 'export const map = 1;\n');
c.side = commit(app, 'AC: map prototype (never merged)', '2026-08-17T09:00:00+08:00');
git(app, ['checkout', '-q', 'main']);
git(app, ['worktree', 'add', '-q', wt, 'wip/AC-map']);
write(wt, 'src/map.ts', 'export const map = 2;\n');   // uncommitted in the worktree
write(app, 'docs/DRAFT.md', '# Draft\n\n日期：2026-08-18\n\nNot committed yet. The old export is deprecated.\n');
write(app, 'src/app.ts', "import { pad } from './util.ts';\nexport const main = () => pad('y');\n");
git(app, ['stash', 'push', '-q', '-m', 'wip app'], { GIT_AUTHOR_DATE: '2026-08-18T09:00:00+08:00', GIT_COMMITTER_DATE: '2026-08-18T09:00:00+08:00' });

// ── the nested notes repository: an import-style root commit (AC-15) ──
mkdirSync(notes);
git(notes, ['init', '-q', '-b', 'main']);
write(notes, 'DECISIONS.md', [
  '# Decisions', '', '编写：Main agent。最后更新：2026-09-01。', '',
  '**D1 · Track every shipment.**', '日期：2026-08-01。Owner confirmed.', '',
  '**D2 · The map is the home page.**', '日期：2026-08-03。', '> 「首页要看得到船」', '',
  '**D3 · No date here.**', 'The owner said it once.', '',
].join('\n'));
for (const n of [1, 2, 3, 4]) write(notes, `meeting-${n}.md`, `# Meeting ${n}\n\n日期：2026-07-2${n}\n\nNotes.\n`);
c.importRoot = commit(notes, 'Put the notes under version control', '2026-09-01T09:00:00+08:00');
write(notes, 'DECISIONS.md', `${[
  '# Decisions', '', '编写：Main agent。最后更新：2026-09-02。', '',
  '**D1 · Track every shipment.**', '日期：2026-08-01。Owner confirmed.', '',
  '**D2 · The map is the home page.**', '日期：2026-08-03。', '> 「首页要看得到船」', '',
  '**D3 · No date here.**', 'The owner said it once.', '',
  '**D4 · Scan barcodes.**', '日期：2026-09-02。', '',
].join('\n')}`);
c.d4 = commit(notes, 'D4: scan barcodes', '2026-09-02T09:00:00+08:00');

// ── a Claude Code session of the project ──
const sessionFile = join(fakeHome, '.claude', 'projects', claudeProjectDirName(app), '11111111-2222-4333-8444-555555555555.jsonl');
const at = (m: number) => new Date(Date.UTC(2026, 7, 16, 1, m)).toISOString();
const rec = (r: Record<string, unknown>) => JSON.stringify({ sessionId: '11111111-2222-4333-8444-555555555555', cwd: app, isSidechain: false, userType: 'external', entrypoint: 'cli', ...r });
mkdirSync(join(sessionFile, '..'), { recursive: true });
writeFileSync(sessionFile, [
  rec({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'Make the map the home page. api_key=abcdefghijklmnopqrstuvwx' } }),
  rec({ type: 'assistant', timestamp: at(1), message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'Shall I also drop the chat home (D2)?' }] } }),
  rec({ type: 'assistant', timestamp: at(2), message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'docs/PRODUCT.md' } }] } }),
  rec({ type: 'user', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '# Harbor product' }] } }),
  rec({ type: 'user', timestamp: at(4), message: { role: 'user', content: '可以' } }),
  rec({ type: 'user', timestamp: at(5), isSidechain: true, message: { role: 'user', content: 'Subagent: read the plan.' } }),
].join('\n'));

function project(id: string): Project {
  const item = (i: Partial<ScopeItem> & { id: string; path: string }): ScopeItem => ({
    category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null,
    versionControl: 'git', missing: null, addedBy: 'owner', ...i,
  } as ScopeItem);
  return {
    id, name: 'Harbor', locations: [app], language: 'en', organizingPaused: false, createdAt: '2026-08-10T00:00:00Z', lastOpenedAt: null, lastScopedAt: null,
    scopeQuestions: [], keeperFiles: [], roles: [],
    scope: [item({ id: 'si-app', path: app }), item({ id: 'si-notes', path: notes, relation: 'Nested repository' })],
  } as Project;
}

const home = join(fakeHome, '.projectkeeper');
const P = project('harbor');
const file = ledgerPath(P.id, home);
const first = rebuildLedgerInPlace(file, P, { sessions: sessionInputOf(P) });
const L = Ledger.openPath(file)!;
const page = <T>(r: T | string): T => { if (typeof r === 'string') throw new Error(r); return r; };

test('every ref, no cap: commits, merges, the trunk, a branch that never merged, the tag, the stash, the worktree', () => {
  assert.equal(first.kind, 'full');
  const [a] = L.overview({ repo: 'si-app' });
  assert.ok(a);
  const all = Number(git(app, ['rev-list', '--all', '--count']));
  assert.equal(a.commits.all, all, 'every commit reachable from any ref');
  assert.equal(a.commits.trunk, Number(git(app, ['rev-list', '--count', 'main'])));
  assert.equal(a.commits.merges, Number(git(app, ['rev-list', '--all', '--merges', '--count'])), 'the stash commit has two parents too');
  assert.equal(a.trunk, 'main');
  assert.deepEqual(a.branches.notMerged.map((b) => [b.name, b.aheadOfTrunk]), [['wip/AC-map', 1]]);
  assert.ok(a.branches.merged_names.includes('wip/AB-parser'));
  assert.equal(a.refs.tags, 1);
  assert.equal(a.refs.stash, 1);
  const w = a.worktrees.find((x) => x.path.toLowerCase().endsWith('harbor-wt'))!;
  assert.deepEqual([w.branch, w.mergedIntoTrunk, w.uncommitted], ['wip/AC-map', false, 1]);
  const side = page(L.commits({ repo: 'si-app', sideOnly: true, limit: 50 }));
  assert.ok(side.rows.some((r) => r.hash === c.side), 'the side branch commit is in the ledger');
  const merged = page(L.commit(c.parser!));
  assert.equal(merged.mergedIntoTrunkBy?.id, `commit:${c.merge!.slice(0, 12)}`, 'the merge that brought it into the trunk');
  assert.deepEqual(merged.numbers, ['AB']);
  assert.equal(merged.occurred.at, '2026-08-12T01:00:00.000Z', 'author time as an instant in UTC');
});

test('document versions follow a move; the section diff is what the commit changed; the cleanup and the deleted documents', () => {
  const v = page(L.docVersions('docs/plan/PLAN.md', { repo: 'si-app' }));
  assert.deepEqual(v.names.sort(), ['docs/PLAN.md', 'docs/plan/PLAN.md']);
  assert.deepEqual(v.versions.map((x) => x.change), ['Added', 'Renamed']);
  assert.deepEqual(v.versions[1]!.diff, { added: ['Plan › Next'], removed: [], changed: [] });
  assert.equal(v.versions[1]!.from, 'docs/PLAN.md');
  assert.equal(v.versions[1]!.current, true);
  const cl = page(L.cleanups({ repo: 'si-app' }));
  assert.equal(cl.cleanups.length, 1);
  assert.equal(cl.cleanups[0]!.deletedDocuments, 5);
  assert.deepEqual(cl.cleanups[0]!.removed.sort(), [1, 2, 3, 4, 5].map((n) => `docs/old/note-${n}.md`));
  const del = page(L.deletedDocs({ repo: 'si-app', dir: 'docs/old' }));
  assert.equal(del.total, 5);
  assert.equal(del.rows[0]!.readableAt, `commit:${c.move!.slice(0, 12)}`, 'the commit whose tree still has the full text');
  const moved = page(L.commit(c.move!));
  assert.match(moved.body, /\[credential redacted\]/, 'a credential in a commit message never enters the ledger');
  assert.doesNotMatch(JSON.stringify(L.resolve(moved.id)), /abcdefghijklmnop/);
  const text = page(L.docText({ path: 'docs/old/note-3.md', commit: c.move! }));
  assert.match(text.text, /Old note 3/);
});

test('any two versions compared by section; the versions a period made', () => {
  const v = page(L.docVersions('docs/PRODUCT.md', { repo: 'si-app' })).versions;
  const cmp = page(L.docCompare({ id: v[0]!.id }, { id: v[v.length - 1]!.id }));
  assert.deepEqual(cmp.sections, { added: ['Harbor product › 5. 已纠正的旧规则'], removed: [], changed: ['Harbor product › 2. Home'] });
  const period = page(L.docChanges({ repo: 'si-app', since: '2026-08-14', until: '2026-08-16' }));
  assert.deepEqual(period.rows.map((r) => r.path).sort(), ['docs/PRODUCT.md', 'docs/plan/PLAN.md', 'subagent/reports/AA-report.md']);
});

test('an import-style root commit dates its content by what the text says, else by the file time (AC-15)', () => {
  const cov = L.coverage();
  const n = cov.repos.find((r) => r.repo === 'si-notes')!;
  assert.equal(n.importRoots.length, 1, 'the notes root commit is import-style: its documents state earlier dates');
  assert.equal(n.historyFrom, '2026-09-01');
  assert.equal(cov.repos.find((r) => r.repo === 'si-app')!.importRoots.length, 0, 'the code repository starts with its own history');
  const d1 = page(L.nums({ num: 'D1', kind: 'doc', place: 'definition' })).rows[0]!;
  assert.deepEqual([d1.occurred.at, d1.occurred.basis, d1.occurred.other?.basis], ['2026-08-01', 'Written in text', 'Commit']);
  const d2 = page(L.nums({ num: 'D2', repo: 'si-notes', place: 'definition' })).rows[0]!;
  assert.equal(d2.occurred.at, '2026-08-03');
  const d3 = page(L.nums({ num: 'D3', place: 'definition' })).rows[0]!;
  assert.equal(d3.occurred.basis, 'File time', 'no date in the text: the file time, a weak basis');
  const d4 = page(L.nums({ num: 'D4', place: 'definition' })).rows[0]!;
  assert.deepEqual([d4.occurred.basis, d4.occurred.at], ['Commit', '2026-09-02T01:00:00.000Z'], 'after the import, a line is dated by the commit that added it');
});

test('explicit supersession: the obsolete list row by row, the line that says superseded, the name, the commit line', () => {
  const rows = page(L.supersessions({ path: 'docs/PRODUCT.md', obsoleteOnly: true }));
  assert.deepEqual(rows.rows.map((r) => r.target), ['聊天当首页', '每天手动录入']);
  assert.ok(rows.rows.every((r) => r.current && r.firstIn === `commit:${c.product!.slice(0, 12)}`));
  assert.equal(rows.rows[0]!.occurred.at, '2026-08-16T01:00:00.000Z');
  assert.deepEqual([rows.rows[0]!.replaced, rows.rows[0]!.replacement, rows.rows[0]!.syntax], ['聊天当首页', '地图当首页', 'obsolete-list-row']);
  const said = page(L.supersessions({ path: 'docs/PRODUCT.md', pattern: 'superseded by' })).rows[0]!;
  assert.equal(said.target, 'the map (D2)');
  assert.deepEqual([said.replaced, said.replacement, said.syntax], ['The chat home', 'the map (D2)', 'passive']);
  const loose = page(L.supersessions({ source: 'loose' })).rows;
  assert.ok(loose.some((r) => r.pattern === 'deprecated' && r.occurred.basis === 'Written in text' && r.occurred.at === '2026-08-18'), 'an uncommitted document: its written date');
});

test('numbering: rules from an index, names and headings, with the basis; every place a number shows up', () => {
  const rules = L.numRules().rules;
  const two = rules.find((r) => r.rule === 'two letters')!;
  assert.ok(two && /table first column: 3/.test(two.basis), two?.basis);
  assert.ok(rules.some((r) => r.rule === 'D<n>'));
  const ab = page(L.nums({ num: 'AB', limit: 100 }));
  const kinds = new Set(ab.rows.map((r) => `${r.kind}:${r.place}`));
  // One branch and one subject with AB: too few to define two-letter numbers there; the index defines them, the names mention them.
  for (const k of ['doc:definition', 'branch:mention', 'commit:mention']) assert.ok(kinds.has(k), `AB ${k}`);
  const ac = page(L.nums({ num: 'AC', kind: 'worktree' })).rows;
  assert.equal(ac.length, 0, 'the worktree folder name harbor-wt names no number');
  assert.ok(page(L.nums({ num: 'AC', kind: 'branch' })).rows.some((r) => r.path === 'wip/AC-map'));
});

test('verdicts, counts and findings stated in a report; the arrangements and how a work item\'s fields changed', () => {
  const v = page(L.verdicts({ path: 'subagent/reports/AA-report.md' })).rows;
  assert.deepEqual(v.map((x) => `${x.kind}:${x.verdict}:${x.confidence}`).sort(), ['count:12/14:stated', 'finding:F-1:stated', 'verdict:fail:stated']);
  const h = page(L.arrangementHistory('AA'));
  assert.deepEqual(h.versions.filter((x) => x.path.endsWith('AA-kimi-scaffold.md')).map((x) => x.status), ['queued', 'running']);
  assert.ok(h.indexRows.some((r) => r.row.Executor === 'kimi'));
});

test('code: file references, since when a reference exists, tests, sizes and what each merge changed', () => {
  const refs = page(L.fileRefs('src/util.ts', { repo: 'si-app' }));
  assert.deepEqual(refs.referencedBy.map((r) => r.path).sort(), ['src/app.ts', 'src/parser.ts']);
  const since = page(L.refHistory('src/parser.ts', 'util.ts', { repo: 'si-app' }));
  assert.equal(since.changes[0]!.id, `commit:${c.parser!.slice(0, 12)}`);
  assert.equal(since.firstOnTrunk, `commit:${c.parser!.slice(0, 12)}`);
  const src = page(L.dirs({ repo: 'si-app', under: '' })).rows.find((d) => d.dir === 'src')!;
  assert.deepEqual([src.testFiles, src.testCases], [1, 2]);
  const merges = page(L.merges({ repo: 'si-app' })).rows;
  assert.ok(merges[0]!.dirs.some((d) => d.dir === 'src'));
  const un = page(L.unreferenced({ repo: 'si-app' })).rows.map((r) => r.path);
  assert.ok(un.includes('src/app.ts') && !un.includes('src/util.ts'));
  const sym = page(L.symbol('references', { file: 'src/util.ts', name: 'pad' }, { repo: 'si-app' }));
  assert.ok((sym.locations ?? []).some((l) => l.file === 'src/parser.ts'), 'symbol level for TypeScript');
});

test('sessions: speakers by structure, the owner\'s words redacted, each with the agent message it answers', () => {
  const s = page(L.sessions({}));
  assert.equal(s.total, 1);
  const msgs = page(L.sessionMessages(s.rows[0]!.id));
  assert.deepEqual(msgs.rows.map((m) => m.speaker), ['owner', 'agent', 'agent', 'owner', 'subagent']);
  const words = page(L.ownerWords({}));
  assert.equal(words.total, 2);
  assert.match(words.rows[0]!.text!, /\[credential redacted\]/);
  assert.doesNotMatch(words.rows[0]!.text!, /abcdefghijkl/);
  assert.equal(words.rows[1]!.text, '可以');
  assert.equal(words.rows[1]!.answers?.text, 'Shall I also drop the chat home (D2)?', 'the nearest earlier agent message with text, not the tool call');
});

test('words across all history: first and last appearance, and a two-character word', () => {
  const span = page(L.wordSpan('harbour map'));
  assert.equal(span.first?.kind, 'doc');
  const hits = page(L.word('首页', { limit: 50 }));
  assert.ok(hits.rows.some((h) => h.kind === 'owner' || h.kind === 'doc'));
  assert.ok(hits.rows.every((h, i, all) => i === 0 || Date.parse(all[i - 1]!.occurred.at) <= Date.parse(h.occurred.at)), 'oldest first');
});

test('How it got here: dated steps oldest first, history marked, the current state last', () => {
  const p = L.provenance({ paths: ['docs/PRODUCT.md'], nums: ['AB'], repo: 'si-app' });
  const times = p.steps.map((s) => Date.parse(s.occurred.at));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(p.steps[p.steps.length - 1]!.kind, 'now');
  const firstVersion = p.steps.find((s) => s.entry.startsWith('doc:docs/PRODUCT.md@'))!;
  assert.equal(firstVersion.history, true, 'the first version is history now');
  assert.ok(firstVersion.replacedBy?.startsWith('doc:docs/PRODUCT.md@'));
  assert.ok(p.steps.some((s) => s.kind === 'obsolete-list row'));
  assert.ok(p.steps.some((s) => s.kind === 'arrangement' || s.kind === 'first appeared'));
});

test('every entry id reads back with its label, time and text; the evidence resolver accepts it and checks a line', () => {
  const sup = page(L.supersessions({ obsoleteOnly: true })).rows[0]!;
  const e = L.resolve(sup.id)!;
  assert.equal(e.occurred.at, sup.occurred.at);
  assert.match(e.text!, /聊天当首页/);
  for (const id of [`commit:${c.merge!.slice(0, 12)}`, page(L.docVersions('docs/PRODUCT.md')).versions[0]!.id, page(L.nums({ num: 'D1' })).rows[0]!.id, page(L.verdicts({})).rows[0]!.id, page(L.ownerWords({})).rows[0]!.id, 'rule:D<n>']) {
    const r = L.resolve(id);
    assert.ok(r && r.label && r.occurred.at, id);
  }
  assert.equal(L.resolve('sup:000000000000'), null);
  const service = new LedgerService({ home });
  const hook = service.hook(P.id);
  const store = ProjectStore.open(P.id, home);
  const ref = resolveEvidence({ store, project: P, ledger: hook }, { kind: 'ledger', id: sup.id, line: '| 聊天当首页 | 看不到船 | 地图当首页 |' });
  assert.ok(typeof ref !== 'string', String(ref));
  assert.equal(ref.occurred?.at, sup.occurred.at, 'the time is the ledger\'s, never the model\'s');
  assert.equal(typeof resolveEvidence({ store, project: P, ledger: hook }, { kind: 'ledger', id: sup.id, line: 'a line it does not have' }), 'string');
  service.release();
});

test('incremental: a new commit is all that is read; entry ids and times stay the same; a vanished log stays read', () => {
  const before = page(L.supersessions({ obsoleteOnly: true })).rows.map((r) => `${r.id}@${r.occurred.at}`);
  write(app, 'docs/plan/PLAN.md', `# Plan\n\nPlan v1: track by hand.\n\n${PLAN_SCOPE}\n## Next\n\nPlan v2: track by barcode, replaced by plan v3.\n`);
  c.plan3 = commit(app, 'Plan: v2 replaced by v3', '2026-08-19T09:00:00+08:00', ['docs/plan/PLAN.md']);
  rmSync(sessionFile);
  const second = rebuildLedgerInPlace(file, P, { sessions: sessionInputOf(P) });
  assert.equal(second.kind, 'incremental');
  assert.equal(second.commitsAdded, 1, JSON.stringify(second.repos.map((r) => [r.repo, r.commitsAdded])));
  assert.equal(second.repos.find((r) => r.repo === 'si-app')!.docs.versionsAdded, 1);
  const L2 = Ledger.openPath(file)!;
  assert.deepEqual(page(L2.supersessions({ obsoleteOnly: true })).rows.map((r) => `${r.id}@${r.occurred.at}`), before);
  const v = page(L2.docVersions('docs/plan/PLAN.md')).versions;
  assert.deepEqual(v[v.length - 1]!.diff, { added: [], removed: [], changed: ['Plan › Next'] });
  const s = page(L2.sessions({})).rows[0]!;
  assert.equal(s.missing, true, 'the log is gone: listed as missing');
  assert.equal(page(L2.ownerWords({})).total, 2, 'what was read from it stays');
  assert.ok(L2.coverage().sessions.missing.some((m) => /gone/.test(m.why)));
  // The long-lived reader answered PLAN.md's versions before the rebuild and keeps answers until the next one: the
  // rebuild retires what it kept, so it gives the new version too.
  assert.equal(page(L.docVersions('docs/plan/PLAN.md', { repo: 'si-app' })).versions.length, page(L2.docVersions('docs/plan/PLAN.md', { repo: 'si-app' })).versions.length, 'no answer from before the rebuild is served after it');
  L2.close();
});

test('the service: step 0 on a worker thread, the hook for session drafts, the views, the tools', async () => {
  const service = new LedgerService({ home });
  write(app, 'README.md', '# Harbor\n\nTracks shipments by barcode.\n');
  commit(app, 'README: barcodes', '2026-08-20T09:00:00+08:00', ['README.md']);
  const r = await service.runner.run(P);
  assert.equal(r.commitsAdded, 1);
  assert.match(r.note ?? '', /brought up to date/);
  const hook = service.hook(P.id);
  const s = hook.session('claude', '11111111')!;
  assert.equal(s.missing, true);
  const owner = s.messages.filter((m) => m.speaker === 'owner');
  assert.equal(owner.length, 2);
  assert.equal(hook.agentBefore(owner[1]!.id)?.text, 'Shall I also drop the chat home (D2)?');
  const store = ProjectStore.open(P.id, home);
  const engines = service.engines();
  const cov = engines.coverage(P)!;
  assert.ok(cov.repos.some((x) => x.historyFrom === '2026-09-01'));
  assert.ok(cov.languages.some((l) => l.language === 'typescript' && l.level === 'symbol'));
  assert.ok(cov.unversionedDocs >= 1);
  // A reference item whose source is the product document: its versions, its current version, how it got here.
  const productPath = join(app, 'docs', 'PRODUCT.md');
  store.sources.put({ id: 'src-product', projectId: P.id, title: 'PRODUCT', anchor: { kind: 'file', path: productPath, headingPath: [], lineStart: 1, lineEnd: 5 }, ids: [], version: { fingerprint: 'x', readAt: '2026-08-20T00:00:00Z', commit: null }, excerpt: '# Harbor product', usedAs: null, usedAsBy: null, availability: null, movedTo: null, scopeItemId: 'si-app', hasCredential: false, bytes: 10 } as never);
  store.reference.put({ id: 'ref-product', projectId: P.id, category: 'Product', name: 'Harbor product', ids: [], text: '', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution: null, sourceIds: ['src-product'], refines: [], replacedBy: null, inputs: null, asOf: '', updatedAt: '' } as never);
  const versions = engines.versions(store, P, 'ref-product')!;
  assert.equal(versions.versions.length, 2);
  assert.deepEqual(versions.versions.map((v) => v.current), [false, true]);
  assert.deepEqual(versions.versions[1]!.sections.changed, ['Harbor product › 2. Home']);
  const cur = engines.docCurrent(store, P, 'ref-product')!;
  assert.equal(cur.versions, 2);
  const lineage = engines.lineage(store, P, 'ref-product')!;
  assert.equal(lineage.steps[0]!.kind, 'First appeared');
  assert.ok(lineage.steps.some((s) => s.kind === 'Replaces'), 'its own obsolete list: it replaces those rules');
  assert.equal(lineage.steps[lineage.steps.length - 1]!.kind, 'Now');
  // Which document the history is of; the whole document is the product itself, so its trace is its own.
  assert.equal(versions.document, 'docs/PRODUCT.md');
  assert.equal(lineage.document, 'docs/PRODUCT.md');
  assert.ok(lineage.steps.every((s) => s.about === 'object'), 'an object that is the whole document owns its history');
  // A numbered item in a section of the same document: the document's versions are the document's, not the item's
  // (owner 2026-09-30: D1's popover read DECISIONS.md's history as the decision's own).
  store.sources.put({ id: 'src-home', projectId: P.id, title: 'Home', anchor: { kind: 'file', path: productPath, headingPath: ['Harbor product', '2. Home'], lineStart: 3, lineEnd: 5 }, ids: ['HB-2'], version: { fingerprint: 'y', readAt: '2026-08-20T00:00:00Z', commit: null }, excerpt: '## 2. Home', usedAs: null, usedAsBy: null, availability: null, movedTo: null, scopeItemId: 'si-app', hasCredential: false, bytes: 10 } as never);
  store.reference.put({ id: 'ref-home', projectId: P.id, category: 'Decision', name: 'HB-2', ids: ['HB-2'], text: 'Home is the dock.', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution: null, sourceIds: ['src-home'], refines: [], replacedBy: null, inputs: null, asOf: '', updatedAt: '' } as never);
  const homeLineage = engines.lineage(store, P, 'ref-home')!;
  assert.equal(homeLineage.document, 'docs/PRODUCT.md');
  const docSteps = homeLineage.steps.filter((s) => s.about === 'document');
  assert.ok(docSteps.some((s) => s.kind === 'Now' && /docs\/PRODUCT\.md/.test(s.title)), `where the document stands now is the document's: ${JSON.stringify(homeLineage.steps.map((s) => [s.kind, s.about, s.title.slice(0, 60)]))}`);
  assert.ok(docSteps.every((s) => /docs\/PRODUCT\.md/.test(s.title) || s.kind === 'Commit'), 'only the document’s own steps are marked as the document’s');
  store.territories.put({ id: 'ter-src', projectId: P.id, name: 'Core', summary: 'the code', repo: 'si-app', paths: ['src'], kind: 'area', areaId: 'ref-product', alsoServes: [], anomalies: [], roundId: null, jobId: null, updatedAt: '' } as never);
  const code = engines.code(store, P)!;
  const t = code.territories[0]!;
  assert.deepEqual([t.size.files, t.tests], [4, 2]);
  assert.ok(t.builtBy.some((b) => b.commits.includes(c.merge!.slice(0, 12))));
  const detail = engines.territory(store, P, 'ter-src')!;
  assert.deepEqual(detail.files.find((f) => f.path === 'src/util.ts')!.importedBy, ['src/app.ts', 'src/parser.ts']);
  // The tools read the ledger from the store's directory.
  const tools = ledgerTools({ store, project: P, jobId: 'job-1', jobKind: 'Organizing', model: null });
  const names = tools.map((x) => x.name);
  assert.ok(names.every((n) => n.startsWith('pk_ledger_')));
  const run = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((x) => x.name === name)!;
    const out = await (tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }).execute('call', args);
    return { text: out.content[0]!.text, error: out.isError === true };
  };
  const ov = await run('pk_ledger_overview', {});
  assert.equal(ov.error, false);
  assert.match(ov.text, /"all": \d+/);
  const sup = await run('pk_ledger_supersessions', { obsoleteOnly: true, limit: 1 });
  const parsed = JSON.parse(sup.text) as { rows: { id: string; when: string; replaced: string; replacement: string; syntax: string }[]; next: number };
  assert.match(parsed.rows[0]!.id, /^sup:/);
  assert.match(parsed.rows[0]!.when, /Z Commit$/);
  assert.deepEqual([parsed.rows[0]!.replaced, parsed.rows[0]!.replacement, parsed.rows[0]!.syntax], ['聊天当首页', '地图当首页', 'obsolete-list-row']);
  assert.equal(parsed.next, 1, 'paged');
  const entry = await run('pk_ledger_entry', { id: parsed.rows[0]!.id });
  assert.match(entry.text, /聊天当首页/);
  const none = ledgerTools({ store: ProjectStore.open('nothing-here', home), project: { ...P, id: 'nothing-here' }, jobId: 'j', jobKind: 'Organizing', model: null });
  const missing = await (none[0] as unknown as { execute: (id: string, p: unknown) => Promise<{ isError?: boolean }> }).execute('c', {});
  assert.equal(missing.isError, true, 'no ledger yet: said, not invented');
  service.release();
});

test('the worker thread rebuild gives the same ledger as the in-place one', async () => {
  const other = ledgerPath('harbor-worker', home);
  const stats = await rebuildLedger(other, { ...P, id: 'harbor-worker' }, {});
  const W = Ledger.openPath(other)!;
  assert.equal(stats.kind, 'full');
  assert.equal(W.overview()[0]!.commits.all, Ledger.openPath(file)!.overview()[0]!.commits.all);
  assert.equal(runNote(stats).includes('sessions not read'), true);
  W.close();
});

test('a repository the scope no longer holds leaves the ledger', () => {
  const both = { ...P, id: 'harbor-drop' };
  const f = ledgerPath(both.id, home);
  rebuildLedgerInPlace(f, both, {});
  const appOnly = { ...both, scope: both.scope.filter((i) => i.id === 'si-app') };
  const s = rebuildLedgerInPlace(f, appOnly, {});
  assert.ok(s.notes.some((n) => n.startsWith('si-notes')));
  const D = Ledger.openPath(f)!;
  assert.deepEqual(D.repos().map((r) => r.id), ['si-app']);
  assert.equal(page(D.nums({ num: 'D1' })).total, 0, 'the notes repository\'s numbers are gone with it');
  assert.equal((D.db.prepare("SELECT count(*) c FROM texts WHERE repo = 'si-notes'").get() as { c: number }).c, 0);
  D.close();
});

test.after(() => {
  L.close();
  try { git(app, ['worktree', 'remove', '--force', wt]); } catch { /* best effort */ }
  // Windows keeps a just-closed SQLite or WAL file busy for a moment: leaving a temporary folder behind is harmless.
  for (const dir of [base, fakeHome]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});
