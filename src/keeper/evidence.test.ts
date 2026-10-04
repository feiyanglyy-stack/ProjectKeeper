/**
 * Evidence is named by the model and resolved by the program (Spec v3.0 §2.11, §1.16; D77, D83): the program checks what
 * is named is there, reads its label and when it happened, and finds a cited line as the original has it. A line that is
 * not there, a commit that does not resolve, an object that does not exist, a date or a label handed in are refused, each
 * paired with the resolution that must go through.
 *
 * The fixture is an invented project, "Tidepool", a tide-table app: a real git repository in a temporary directory (a plan
 * revised, a decision record that grows, a design deleted, a file not yet committed), and a Claude Code session log in
 * which the owner says yes to a proposal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import type { Project, ReferenceItem, ScopeItem, Source } from '../model/types.ts';
import type { Breakpoint, Occurred, SemanticPatch } from '../model/k-types.ts';
import { anchorLabel } from '../sources/anchor.ts';
import {
  compareOccurred, earliestOccurred, occurredOf, resolveEvidence, resolveEvidenceList, resolvePath, type EvidenceContext, type LedgerHook,
} from './evidence.ts';

const ENV = { GIT_AUTHOR_NAME: 'Tide Dev', GIT_AUTHOR_EMAIL: 'dev@tidepool.invalid', GIT_COMMITTER_NAME: 'Tide Dev', GIT_COMMITTER_EMAIL: 'dev@tidepool.invalid' };
const AT = '2026-09-26T00:00:00.000Z';

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(root: string, rel: string, body: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), body);
}
function commit(root: string, message: string, date: string): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(root, ['rev-parse', 'HEAD']);
}

interface Fixture {
  readonly base: string; readonly root: string; readonly c: Record<'start' | 'cache' | 'dropSync' | 'alerts', string>;
  /** A second repository of the scope: the project's website, with a plan of its own at the same path. */
  readonly site: string; readonly siteLaunch: string;
}

/** Tidepool's history, oldest first; the times carry +08:00 and are stored as their instants in UTC. */
function buildRepo(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'pk-evidence-'));
  const root = join(base, 'tidepool');
  mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'core.autocrlf', 'false']);
  write(root, 'docs/PLAN.md', '# Plan\n\nPlan v1: show the tide table for one harbour.\n');
  write(root, 'docs/DECISIONS.md', '# Decisions\n\n- D1: tides come from the national feed.\n');
  write(root, 'docs/design/SYNC.md', '# Sync\n\nPull the feed every night.\n');
  write(root, 'src/app.ts', 'export const app = 1;\n');
  const start = commit(root, 'Start Tidepool with the plan', '2026-09-01T09:00:00+08:00');
  write(root, 'docs/DECISIONS.md', '# Decisions\n\n- D1: tides come from the national feed.\n- **D2**: the offline cache replaces the nightly pull (supersedes the sync design).\n');
  const cache = commit(root, 'Decide the offline cache', '2026-09-03T09:00:00+08:00');
  rmSync(join(root, 'docs/design/SYNC.md'));
  const dropSync = commit(root, 'Drop the sync design: not needed', '2026-09-05T09:00:00+08:00');
  write(root, 'docs/PLAN.md', '# Plan\n\nPlan v2: tide table and storm alerts.\n');
  const alerts = commit(root, 'Plan v2 adds alerts\n\nThe owner asked for storm alerts.', '2026-09-07T09:00:00+08:00');
  write(root, 'notes/todo.md', '- ask about the tide gauge\n');
  const site = join(base, 'tidepool-site');
  mkdirSync(site);
  git(site, ['init', '-q', '-b', 'main']);
  git(site, ['config', 'core.autocrlf', 'false']);
  write(site, 'docs/PLAN.md', '# Site plan\n\nLaunch page with the tide widget.\n');
  const siteLaunch = commit(site, 'Plan the launch page', '2026-09-08T09:00:00+08:00');
  return { base, root, c: { start, cache, dropSync, alerts }, site, siteLaunch };
}

const FIX = buildRepo();
const UTC = { start: '2026-09-01T01:00:00.000Z', cache: '2026-09-03T01:00:00.000Z', dropSync: '2026-09-05T01:00:00.000Z', alerts: '2026-09-07T01:00:00.000Z', siteLaunch: '2026-09-08T01:00:00.000Z' };

/** A Claude Code log: the owner asks, the agent proposes, the owner says yes. */
function writeSessionLog(file: string): void {
  const rec = (type: 'user' | 'assistant', timestamp: string, content: unknown) => JSON.stringify({
    type, timestamp, sessionId: 'sess-tide-1', cwd: FIX.root, message: type === 'user' ? { role: 'user', content } : { role: 'assistant', model: 'claude-opus', content },
  });
  writeFileSync(file, [
    rec('user', '2026-09-02T01:00:10.000Z', 'Can the app work offline?'),
    rec('assistant', '2026-09-02T01:05:20.000Z', [{ type: 'text', text: 'I propose an offline cache that replaces the nightly pull.' }]),
    rec('user', '2026-09-02T03:30:45.000Z', 'yes, go with the cache'),
  ].join('\n'));
}
const TRANSCRIPT = '[0] OWNER 2026-09-02 01:00\nCan the app work offline?\n\n[1] AGENT (claude-opus) 2026-09-02 01:05\nI propose an offline cache that replaces the nightly pull.\n\n[2] OWNER 2026-09-02 03:30\nyes, go with the cache';

const scopeItem: ScopeItem = {
  id: 'scope_main', path: FIX.root, category: 'Repository', relation: 'Main project', reason: 'Owner-given location', reasonSourceIds: [],
  sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner',
};
const siteItem: ScopeItem = { ...scopeItem, id: 'scope_site', path: FIX.site, relation: 'Nested repository', reason: 'The project’s website', addedBy: 'keeper' };
const project = { id: 'p1', name: 'Tidepool', language: 'en', locations: [FIX.root], scope: [scopeItem, siteItem], scopeQuestions: [], keeperFiles: [], roles: [], organizingPaused: false, createdAt: AT, lastOpenedAt: null, lastScopedAt: null } as Project;

const base = (id: string, anchor: Source['anchor'], excerpt: string, commitAt: string | null = null): Source => ({
  id, projectId: 'p1', title: id, anchor, ids: [], version: { fingerprint: 'f', readAt: AT, commit: commitAt }, excerpt,
  usedAs: null, usedAsBy: null, availability: null, movedTo: null, scopeItemId: 'scope_main', hasCredential: false, bytes: excerpt.length,
});

function withStore(ledger: LedgerHook | null = null): EvidenceContext & { store: ProjectStore; log: string } {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-evidence-store-')));
  const log = join(FIX.base, `sess-${Math.random().toString(36).slice(2)}.jsonl`);
  writeSessionLog(log);
  store.sources.put(base('src_plan', { kind: 'file', path: join(FIX.root, 'docs', 'PLAN.md'), headingPath: ['Plan'], lineStart: 1, lineEnd: 3 }, '# Plan\n\nPlan v2: tide table and storm alerts.', FIX.c.alerts));
  store.sources.put(base('src_dec', { kind: 'file', path: join(FIX.root, 'docs', 'DECISIONS.md'), headingPath: ['Decisions'], lineStart: 1, lineEnd: 4 }, '# Decisions\n\n- D1: tides come from the national feed.\n- **D2**: the offline cache replaces the nightly pull (supersedes the sync design).', FIX.c.alerts));
  store.sources.put(base('src_session', { kind: 'session', host: 'claude', sessionId: 'sess-tide-1', file: log, cwd: FIX.root, messageStart: 0, messageEnd: 2, at: '2026-09-02T01:00:10.000Z' }, TRANSCRIPT));
  store.sources.put(base('src_lost', { kind: 'session', host: 'claude', sessionId: 'sess-tide-0', file: join(FIX.base, 'gone.jsonl'), cwd: FIX.root, messageStart: 0, messageEnd: 2, at: '2026-09-02T01:00:10.000Z' }, TRANSCRIPT));
  store.sources.put(base('src_commit', { kind: 'commit', repo: FIX.root, commit: FIX.c.cache }, 'Decide the offline cache'));
  store.sources.put(base('src_rev', { kind: 'revision', repo: FIX.root, commit: FIX.c.cache, path: 'docs/design/SYNC.md' }, '# Sync\n\nPull the feed every night.\n'));
  return { store, project, ledger, log };
}

const ref = (r: ReturnType<typeof resolveEvidence>) => { assert.notEqual(typeof r, 'string', String(r)); return r as Exclude<typeof r, string>; };
const refused = (r: ReturnType<typeof resolveEvidence>, reason: RegExp) => { assert.equal(typeof r, 'string', `expected a refusal, got ${JSON.stringify(r)}`); assert.match(r as string, reason); };

// ───────────────────────── sources ─────────────────────────

test('a source is labelled by its anchor and dated by its own material: a session by the message, a document by its version’s commit', () => {
  const ctx = withStore();
  const session = ref(resolveEvidence(ctx, { kind: 'source', id: 'src_session' }));
  assert.equal(session.label, anchorLabel(ctx.store.sources.get('src_session')!.anchor));
  assert.deepEqual(session.occurred, { at: '2026-09-02T01:00:10.000Z', basis: 'Session', anchor: 'src_session' }, 'a segment cited whole: its first message');

  // A cited line is found however the caller spelled it, stored as the source has it, and dated by its own message.
  const yes = ref(resolveEvidence(ctx, { kind: 'source', id: 'src_session', line: 'Yes — go with the cache!' }));
  assert.equal(yes.line, 'yes, go with the cache', 'the line as the original has it, never the caller’s rendering');
  assert.deepEqual(yes.occurred, { at: '2026-09-02T03:30:45.000Z', basis: 'Session', anchor: 'src_session' }, 'the time of the message the line is in, from the log');
  const lost = ref(resolveEvidence(ctx, { kind: 'source', id: 'src_lost', line: 'yes, go with the cache' }));
  assert.equal(lost.occurred?.at, '2026-09-02T03:30:00.000Z', 'with the log gone, the minute the transcript shows for that message');

  const plan = ref(resolveEvidence(ctx, { kind: 'source', id: 'src_plan' }));
  assert.deepEqual(plan.occurred, { at: UTC.alerts, basis: 'Commit', anchor: FIX.c.alerts }, 'the commit that made the version read');
  const d2 = ref(resolveEvidence(ctx, { kind: 'source', id: 'src_dec', line: 'D2: the offline cache replaces the nightly pull' }));
  assert.equal(d2.line, '**D2**: the offline cache replaces the nightly pull', 'Markdown marks make no difference to finding it; the stored words are the source’s, marks and all');
  assert.deepEqual(d2.occurred, { at: UTC.cache, basis: 'Commit', anchor: FIX.c.cache }, 'a cited line is dated by the commit it first appeared in, not the file’s last change');
  const d1 = ref(resolveEvidence(ctx, { kind: 'source', id: 'src_dec', line: 'D1: tides come from the national feed.' }));
  assert.equal(d1.occurred?.at, UTC.start);

  assert.deepEqual(ref(resolveEvidence(ctx, { kind: 'source', id: 'src_commit' })).occurred, { at: UTC.cache, basis: 'Commit', anchor: FIX.c.cache }, 'a commit source: its author time, as an instant in UTC');
  assert.deepEqual(ref(resolveEvidence(ctx, { kind: 'source', id: 'src_rev' })).occurred, { at: UTC.start, basis: 'Commit', anchor: FIX.c.start }, 'an old version: the commit that made that version');
});

test('a section read while its file had uncommitted changes is dated by its words in the history, not by the day the file was saved (CM)', () => {
  const ctx = withStore();
  // The same decision record, read with no commit recorded (the working tree was dirty): the gated run dated such a
  // section at the file's time, the day of the run, and refused a generation whose start then came after its end.
  ctx.store.sources.put(base('src_dec_dirty', { kind: 'file', path: join(FIX.root, 'docs', 'DECISIONS.md'), headingPath: ['Decisions'], lineStart: 1, lineEnd: 4 }, '# Decisions\n\n- D1: tides come from the national feed.\n- **D2**: the offline cache replaces the nightly pull (supersedes the sync design).', null));
  const d2 = ref(resolveEvidence(ctx, { kind: 'source', id: 'src_dec_dirty', line: 'D2: the offline cache replaces the nightly pull' }));
  assert.deepEqual(d2.occurred, { at: UTC.cache, basis: 'Commit', anchor: FIX.c.cache }, 'the commit the cited line first appeared in');
  const whole = ref(resolveEvidence(ctx, { kind: 'source', id: 'src_dec_dirty' }));
  assert.deepEqual(whole.occurred, { at: UTC.start, basis: 'Commit', anchor: FIX.c.start }, 'with no line cited, the commit the section’s heading first appeared in');
  // Words no commit has yet keep the file's own time.
  ctx.store.sources.put(base('src_todo', { kind: 'file', path: join(FIX.root, 'notes', 'todo.md'), headingPath: [], lineStart: 1, lineEnd: 1 }, '- ask about the tide gauge', null));
  assert.equal(ref(resolveEvidence(ctx, { kind: 'source', id: 'src_todo', line: 'ask about the tide gauge' })).occurred?.basis, 'File time');
});

test('a cited line is kept with the marks that enclose or end it, and not a word more — in Chinese as in English', () => {
  const ctx = withStore();
  ctx.store.sources.put(base('src_zh', { kind: 'file', path: join(FIX.root, 'docs', 'ZH.md'), headingPath: [], lineStart: 1, lineEnd: 1 }, '- D3：离线缓存取代每晚拉取（取代同步设计）。下一步再说。'));
  const cite = (line: string) => ref(resolveEvidence(ctx, { kind: 'source', id: 'src_zh', line })).line;
  assert.equal(cite('离线缓存取代每晚拉取'), '离线缓存取代每晚拉取', 'the bracket that opens the next clause is not taken');
  assert.equal(cite('取代同步设计'), '（取代同步设计）。', 'the brackets around the clause and the full stop after it are');
  assert.equal(cite('D3: 离线缓存'), 'D3：离线缓存', 'the source’s own punctuation, not the caller’s');
});

test('a source that does not exist, or a line it does not hold, is refused and says so', () => {
  const ctx = withStore();
  refused(resolveEvidence(ctx, { kind: 'source', id: 'src_nowhere' }), /src_nowhere is not a source of this project/);
  const fabricated = resolveEvidence(ctx, { kind: 'source', id: 'src_dec', line: 'D3: the cache is kept for a year' });
  refused(fabricated, /The line “D3: the cache is kept for a year” is not in src_dec/);
  assert.match(fabricated as string, /nothing was written/);
  refused(resolveEvidence(ctx, { kind: 'source', id: 'src_session', line: 'yes, go with the feed' }), /is not in src_session/);
});

// ───────────────────────── commits ─────────────────────────

test('a commit is named by its hash, labelled by its subject and dated by its author time', () => {
  const ctx = withStore();
  const c = ref(resolveEvidence(ctx, { kind: 'commit', id: FIX.c.cache.slice(0, 7) }));
  assert.equal(c.id, FIX.c.cache, 'the short hash resolves to the full one');
  assert.equal(c.label, `${FIX.c.cache.slice(0, 7)} Decide the offline cache`);
  assert.deepEqual(c.occurred, { at: UTC.cache, basis: 'Commit', anchor: FIX.c.cache });
  const body = ref(resolveEvidence(ctx, { kind: 'commit', id: FIX.c.alerts, line: 'the owner asked for storm alerts' }));
  assert.equal(body.line, 'The owner asked for storm alerts.', 'a line of the commit message, as it stands, with the full stop that closes it');
  assert.equal(ref(resolveEvidence(ctx, { kind: 'commit', id: FIX.c.cache.toUpperCase(), repo: 'scope_main' })).id, FIX.c.cache);

  refused(resolveEvidence(ctx, { kind: 'commit', id: 'main' }), /is not a commit hash/);
  refused(resolveEvidence(ctx, { kind: 'commit', id: 'HEAD~1' }), /is not a commit hash/);
  refused(resolveEvidence(ctx, { kind: 'commit', id: 'deadbeef1234' }), /names no commit in/);
  refused(resolveEvidence(ctx, { kind: 'commit', id: FIX.c.cache, repo: 'scope_elsewhere' }), /is not a git repository of this project’s scope/);
  refused(resolveEvidence(ctx, { kind: 'commit', id: FIX.c.cache, line: 'Decide the online cache' }), /is not in the message of commit/);
});

// ───────────────────────── files ─────────────────────────

test('a file is found where it is now or in its history, and dated by the commit of the version cited', () => {
  const ctx = withStore();
  const plan = ref(resolveEvidence(ctx, { kind: 'file', id: 'docs/PLAN.md' }));
  assert.deepEqual({ id: plan.id, label: plan.label, line: plan.line }, { id: 'docs/PLAN.md', label: 'docs/PLAN.md', line: null });
  assert.deepEqual(plan.occurred, { at: UTC.alerts, basis: 'Commit', anchor: FIX.c.alerts }, 'unchanged since HEAD: the last commit that touched it');
  const d2 = ref(resolveEvidence(ctx, { kind: 'file', id: 'docs\\DECISIONS.md', line: 'the offline cache replaces the nightly pull (supersedes the sync design)' }));
  assert.equal(d2.id, 'docs/DECISIONS.md');
  assert.equal(d2.occurred?.at, UTC.cache, 'a line is dated by the commit it first appeared in');
  assert.equal(ref(resolveEvidence(ctx, { kind: 'file', id: join(FIX.root, 'docs', 'PLAN.md') })).id, 'docs/PLAN.md', 'an absolute path inside the repository is made relative');

  const sync = ref(resolveEvidence(ctx, { kind: 'file', id: 'docs/design/SYNC.md' }));
  assert.match(sync.label, /^docs\/design\/SYNC\.md @ [0-9a-f]{7} \(version history\)$/, 'a deleted file is labelled as history');
  assert.deepEqual(sync.occurred, { at: UTC.start, basis: 'Commit', anchor: FIX.c.start }, 'its last version, made in the first commit');
  assert.equal(ref(resolveEvidence(ctx, { kind: 'file', id: 'docs/design/SYNC.md', line: 'Pull the feed every night.' })).line, 'Pull the feed every night.');

  const todo = ref(resolveEvidence(ctx, { kind: 'file', id: 'notes/todo.md', line: 'ask about the tide gauge' }));
  assert.equal(todo.occurred?.basis, 'File time', 'a file no commit is behind has only its file time');

  refused(resolveEvidence(ctx, { kind: 'file', id: 'docs/NOPE.md' }), /not in .* now, and no commit in its history ever touched that path/);
  refused(resolveEvidence(ctx, { kind: 'file', id: '../outside.md' }), /leaves/);
  const fabricated = resolveEvidence(ctx, { kind: 'file', id: 'docs/PLAN.md', line: 'Plan v3: tides, alerts and surf reports' });
  refused(fabricated, /The line “Plan v3: tides, alerts and surf reports” is not in docs\/PLAN\.md as it is now/);
  refused(resolveEvidence(ctx, { kind: 'file', id: 'docs/design/SYNC.md', line: 'Pull the feed every hour.' }), /as its last version had it/);
  refused(resolveEvidence(ctx, { kind: 'file', id: 'docs', line: 'Plan v2' }), /is a directory/);
});

test('evidence in a repository other than the first says which, and the same path in two repositories is two pieces of evidence', () => {
  const ctx = withStore();
  const main = ref(resolveEvidence(ctx, { kind: 'file', id: 'docs/PLAN.md' }));
  assert.equal('repo' in main, false, 'what is in the first repository names none');
  const site = ref(resolveEvidence(ctx, { kind: 'file', id: 'docs/PLAN.md', repo: 'scope_site', line: 'Launch page with the tide widget.' }));
  assert.deepEqual(
    { id: site.id, repo: site.repo, label: site.label, line: site.line, occurred: site.occurred },
    { id: 'docs/PLAN.md', repo: FIX.site, label: `docs/PLAN.md (in ${FIX.site})`, line: 'Launch page with the tide widget.', occurred: { at: UTC.siteLaunch, basis: 'Commit', anchor: FIX.siteLaunch } },
    'the path stays repository-relative; the repository is its own field, and the label still names it for views that print the label alone',
  );
  assert.equal(ref(resolveEvidence(ctx, { kind: 'file', id: join(FIX.site, 'docs', 'PLAN.md') })).repo, FIX.site, 'an absolute path finds its repository');
  const both = resolveEvidenceList(ctx, [{ kind: 'file', id: 'docs/PLAN.md' }, { kind: 'file', id: 'docs/PLAN.md', repo: FIX.site }, { kind: 'file', id: 'docs/PLAN.md', repo: 'scope_main' }]);
  assert.ok(Array.isArray(both));
  assert.deepEqual(both.map((e) => e.repo ?? null), [null, FIX.site], 'the same path in two repositories is two pieces of evidence; the first repository named is the first');

  const launch = ref(resolveEvidence(ctx, { kind: 'commit', id: FIX.siteLaunch.slice(0, 8) }));
  assert.deepEqual({ id: launch.id, repo: launch.repo, label: launch.label }, { id: FIX.siteLaunch, repo: FIX.site, label: `${FIX.siteLaunch.slice(0, 7)} Plan the launch page (in ${FIX.site})` }, 'a commit found only in the second repository says so');
  assert.equal('repo' in ref(resolveEvidence(ctx, { kind: 'commit', id: FIX.c.cache })), false);
});

test('a path is resolved in the repository the call names, and nowhere outside the scope', () => {
  const place = resolvePath(project, { path: 'docs/PLAN.md', repo: 'scope_main' });
  assert.ok(typeof place !== 'string' && place.rel === 'docs/PLAN.md' && place.root.id === 'scope_main');
  assert.match(String(resolvePath(project, { path: 'docs/PLAN.md', repo: 'scope_other' })), /is not a repository or directory of this project’s scope/);
  assert.match(String(resolvePath(project, { path: join(tmpdir(), 'x.md') })), /is not inside this project’s scope/);
});

// ───────────────────────── the ledger ─────────────────────────

test('a ledger entry is resolved through the ledger when the build has one, and refused when it has none', () => {
  const without = withStore();
  refused(resolveEvidence(without, { kind: 'ledger', id: 'led_verdict_7' }), /the ledger is not available in this build/);

  const entry = { label: 'QC report AF · verdict', occurred: { at: '2026-09-10', basis: 'Written in text', anchor: 'led_verdict_7' } as Occurred, text: 'Verdict: FAIL — 7 findings open' };
  const ledger: LedgerHook = { resolve: (id) => (id === 'led_verdict_7' ? entry : id === 'led_bare' ? { label: 'bare', occurred: entry.occurred } : null) };
  const ctx = withStore(ledger);
  const v = ref(resolveEvidence(ctx, { kind: 'ledger', id: 'led_verdict_7', line: 'verdict: fail - 7 findings open' }));
  assert.deepEqual(v, { kind: 'ledger', id: 'led_verdict_7', label: 'QC report AF · verdict', line: 'Verdict: FAIL — 7 findings open', occurred: entry.occurred });
  assert.equal(v.occurred?.at, '2026-09-10', 'a date stays a date');
  refused(resolveEvidence(ctx, { kind: 'ledger', id: 'led_nowhere' }), /is not an entry of the ledger/);
  refused(resolveEvidence(ctx, { kind: 'ledger', id: 'led_verdict_7', line: 'Verdict: PASS' }), /is not in the ledger entry led_verdict_7/);
  refused(resolveEvidence(ctx, { kind: 'ledger', id: 'led_bare', line: 'anything' }), /holds no text/);
});

// ───────────────────────── objects ─────────────────────────

test('an object of the assets is named by its id (or the number the Keeper gave it) and dated by what it rests on', () => {
  const ctx = withStore();
  ctx.store.reference.put({ id: 'ref_d2', projectId: 'p1', category: 'Decision', name: 'D2 Offline cache', ids: ['D2'], text: 'x', quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution: { author: { kind: 'owner', name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' }, sourceIds: ['src_session', 'src_plan'], refines: [], replacedBy: null, inputs: null, asOf: AT, updatedAt: AT } as ReferenceItem);
  const since: Occurred = { at: UTC.dropSync, basis: 'Commit', anchor: FIX.c.dropSync };
  ctx.store.breakpoints.put({ id: 'bp_1', projectId: 'p1', kind: 'Findings open', targetId: 'ref_d2', why: 'x', evidence: [], basis: 'Explicit', since, lit: true, out: null, ownerResponse: null, confirmedInRoundId: null, sixThing: null, sendBackId: null, roundId: null, updatedAt: AT } as Breakpoint);
  ctx.store.patches.put({ id: 'patch_1', number: 'SP-1', title: 'The sync design is withdrawn', occurred: since } as unknown as SemanticPatch);

  const d2 = ref(resolveEvidence(ctx, { kind: 'object', id: 'ref_d2' }));
  assert.deepEqual({ label: d2.label, occurred: d2.occurred }, { label: 'D2 Offline cache', occurred: { at: '2026-09-02T01:00:10.000Z', basis: 'Session', anchor: 'src_session' } }, 'the earliest of the sources it rests on');
  assert.deepEqual(ref(resolveEvidence(ctx, { kind: 'object', id: 'bp_1' })).occurred, since, 'a breakpoint: since when the step was due');
  const byNumber = ref(resolveEvidence(ctx, { kind: 'object', id: 'SP-1' }));
  assert.deepEqual({ id: byNumber.id, label: byNumber.label }, { id: 'patch_1', label: 'SP-1 The sync design is withdrawn' });

  refused(resolveEvidence(ctx, { kind: 'object', id: 'ref_nowhere' }), /is not an object of this project’s assets/);
  refused(resolveEvidence(ctx, { kind: 'object', id: 'src_plan' }), /is a source: cite it with kind "source"/);
  refused(resolveEvidence(ctx, { kind: 'object', id: 'ref_d2', line: 'Offline cache' }), /a line quotes original material/);
});

// ───────────────────────── what the model may not hand in ─────────────────────────

test('a label or a date handed in with the evidence is refused: the program reads both', () => {
  const ctx = withStore();
  refused(resolveEvidence(ctx, { kind: 'commit', id: FIX.c.cache, label: 'The decision to cache' }), /gives label, which the program reads/);
  refused(resolveEvidence(ctx, { kind: 'file', id: 'docs/PLAN.md', occurred: { at: '2026-09-01', basis: 'Commit', anchor: null } }), /gives occurred/);
  refused(resolveEvidence(ctx, { kind: 'source', id: 'src_plan', at: '2026-09-01' }), /gives at/);
  refused(resolveEvidence(ctx, '2026-09-05', 'ended'), /^ended is not evidence: .*“2026-09-05” written out is not evidence/);
  refused(resolveEvidence(ctx, { kind: 'url', id: 'https://example.invalid' }), /kind must be one of ledger, source, commit, file, object/);
  refused(resolveEvidence(ctx, { kind: 'commit', id: ' ' }), /id is empty/);
  const list = resolveEvidenceList(ctx, [{ kind: 'commit', id: FIX.c.start }, { kind: 'commit', id: FIX.c.start.slice(0, 9) }, { kind: 'source', id: 'src_plan' }], 'evidence');
  assert.ok(Array.isArray(list) && list.length === 2, 'the same evidence twice is one');
  assert.match(String(resolveEvidenceList(ctx, [{ kind: 'source', id: 'src_plan' }, { kind: 'source', id: 'src_x' }], 'evidence')), /^evidence\[1\]: src_x/);
  const when = occurredOf(ctx, { kind: 'commit', id: FIX.c.dropSync });
  assert.deepEqual(when, { at: UTC.dropSync, basis: 'Commit', anchor: FIX.c.dropSync });
});

test('times are ordered by the instant they name, and an undated time is the answer only when nothing is dated', () => {
  const beijing: Occurred = { at: '2026-09-01T09:00:00+08:00', basis: 'Commit', anchor: 'a' };
  const utc: Occurred = { at: '2026-09-01T02:00:00Z', basis: 'Commit', anchor: 'b' };
  assert.ok(compareOccurred(beijing, utc) < 0, '09:00 in Beijing is 01:00 UTC, before 02:00 UTC');
  const firstSeen: Occurred = { at: '2026-08-01T00:00:00.000Z', basis: 'First observed', anchor: 'c', undated: true };
  assert.equal(earliestOccurred([firstSeen, utc, beijing]), beijing, 'a dated time wins over an earlier first-seen one');
  assert.equal(earliestOccurred([null, firstSeen]), firstSeen);
  assert.equal(earliestOccurred([]), null);
  const day: Occurred = { at: '2026-09-01', basis: 'Written in text', anchor: 'd' };
  assert.equal(earliestOccurred([utc, day]), day, 'a date sorts at the start of its day');
});
