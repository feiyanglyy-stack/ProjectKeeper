/**
 * Seed a neutral, invented demo project — "Papertrail", a one-person read-later list — so the
 * workbench can be developed and checked without a model provider, a real project or a real key.
 * Every kind of content the interface can show appears at least once; `--size large` scales the
 * same content past one screen.
 *
 * Usage: node scripts/seed-ui-fixture.ts <home> [--size standard|large] [--project-dir <dir>]
 * `npm run demo` (scripts/demo.ts) seeds it and serves it in one step.
 *
 * Everything is written under <home>; the project directory (a few small invented files as source
 * anchors, a real git history with fixed dates, and one registered worktree) defaults to a fixed
 * path in the system temp directory so repeated runs into an empty home are stable. All asset ids
 * are fixed or stableId-derived; times are relative to now in a fixed order.
 *
 * The material is mostly English with about a quarter Chinese, plus a few deliberately very long
 * names, because the interface has to survive both.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { App } from '../src/server/app.ts';
import { stableId } from '../src/model/ids.ts';
import type {
  Attribution, ChangeItem, ChangeRecord, Coverage, EntryMark, FactRecord, FollowUpRound, GraphRelation, JobInputs,
  KeeperJob, Note, NoteVersion, ObjectJudgement, ProjectRule, ReferenceItem, ScopeItem, Source,
  SourceAnchor, Statement, WorkThread,
} from '../src/model/types.ts';
import type { NoteAsk, Progress, UsedAs } from '../src/model/vocab.ts';
import { makeSessionSource } from '../src/sources/anchor.ts';
import { deriveGraph } from '../src/keeper/organize/graph.ts';
import { writeClerkCoverage } from '../src/keeper/organize/service.ts';
import { incrementalIntake } from '../src/intake/intake.ts';
import { coverageGroups, coverageOf } from '../src/keeper/organize/coverage-tools.ts';
import { shellReads } from '../src/keeper/bounds/reads.ts';
import { roundBaseline, roundNews } from '../src/keeper/organize/round-news.ts';
import { countRound, roundIdOf, roundResultOf } from '../src/keeper/adjustment.ts';
import type { Breakpoint, ClerkRound, ClerkStage, CodeTerritory, EvidenceRef, LaneKind, MaterialAccount, RoundDoc, RoundLane, RoundNews, RoundStepKind, SemanticPatch, SendBack, SlotKind } from '../src/model/k-types.ts';
import { saveVersion } from '../src/store/versions.ts';
import { projectDir as assetDirOf } from '../src/store/paths.ts';
import { canonicalPath, normalizePath, samePath } from '../src/util/paths.ts';

export interface UiFixtureResult {
  readonly projectId: string;
  readonly projectDir: string;
  readonly home: string;
  readonly size: 'standard' | 'large';
  readonly counts: Record<string, number>;
}

// ───────────────────────── time: relative to now, in a fixed order ─────────────────────────

const T0 = Date.now();
/** ISO time `days` days (and `hours` hours) before now. */
const T = (days: number, hours = 0): string => new Date(T0 - days * 86_400_000 - hours * 3_600_000).toISOString();

// ───────────────────────── attributions ─────────────────────────

const byOwner: Attribution = { author: { kind: 'owner', name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' };
const byKeeper: Attribution = { author: { kind: 'agent', name: 'Keeper', window: null, host: 'pi', model: null }, holder: null, identity: 'Interpretation' };
const byRole = (name: string, identity: Attribution['identity'] = 'Artifact'): Attribution => ({ author: { kind: 'role', name, window: null, host: null, model: null }, holder: { role: name, window: null }, identity });

// ───────────────────────── the invented project directory ─────────────────────────

/** The files of the invented project, by relative path. Small, neutral, and all made up. */
function projectFiles(): Record<string, string> {
  return {
    'README.md': `# Papertrail

A one-person read-later list. Save a page in one motion, read it offline, find it again with one query.

## Goal

Save in one motion, read anywhere, find in one query. The list belongs to the owner: plain files, export anytime.

## 当前状态

搜索与导出正在打磨；同步推迟到 v1 之后。阅读视图的排版刚重做了一版。
`,
    'AGENTS.md': `# How we work

Every task gets the next number in docs/TASKS.md.

A task is done by one Worker agent; a QC reviewer checks the receipts in docs/receipts/ before the task is called done.

## 约定

- 推送前跑测试。
- The lead agent may push to main when the tests are green.
- 收据先整理，供应商的文档最后再说。
`,
    'docs/PRODUCT.md': `# Papertrail product

## Goal

G1 · Save in one motion, find in one query. G2 · Read anywhere, offline first. G3 · 数据永远属于自己.

## Areas

- A1 · Capture 快速收藏: one shortcut, no dialog.
- A2 · Reading 阅读体验: offline, calm typography.
- A3 · Search 搜索与找回: full text, under a second.
- A4 · Sync 同步: deferred until after v1.
- A5 · Tags 标签与整理: tags suggest themselves.
- A6 · Sharing 分享: proposed, not scheduled.
- A7 · Import & export 导入导出: plain text only.

## Boundaries

B-1 · v1 不做任何社交功能。B-2 · No server of our own in v1.
`,
    'docs/PLAN.md': `# Plan

## PLAN-1 · v1 milestone: save, read, find

Done: capture, reader, first search. 

## PLAN-2 · 秋季打磨：搜索、导出与中文体验

In progress: Chinese tokenization, export attachments, search filters.

## PLAN-3 · Sync evaluation 同步评估

Deferred until the owner reviews v1.
`,
    'docs/TASKS.md': `# Task index

| id | task | status |
| --- | --- | --- |
| T-1 | Global hotkey capture | done |
| T-2 | Save with note field | done |
| T-3 | Clipboard URL detection | done |
| T-5 | 收藏时的标题补全 | in progress |
| T-15 | SQLite FTS index | done |
| T-18 | Search index incremental rebuild | in progress |
| T-19 | 中文分词接入 | in progress |
| T-24 | Tag browser v1 | replaced by T-18 |
| T-25 | Sync protocol spike | deferred |
| T-31 | Markdown export | done |
| T-40 | v1 sync prototype | removed |
`,
    'docs/DECISIONS.md': `# Decisions

- DEC-1 · No accounts 不做账号 (owner, 2026-08-22).
- DEC-2 · 搜索取代标签浏览器 (owner, 2026-09-13): full-text search replaces the tag browser.
- DEC-3 · Export is a folder of Markdown files (owner, 2026-09-06).
- DEC-5 · Word counts are part of the search index — replaced by DEC-6.
- DEC-6 · Word counts stay out of the search index (2026-09-16).
`,
    'docs/CHANGELOG.md': `# Changelog

The changelog is the authoritative record of progress (see AGENTS.md).

## 2026-09-16

- Search tokenizer corrected for mixed Chinese and English text.

## 2026-09-10

- Benchmark: 5,120 items, first query 812 ms, warm 96 ms.
`,
    'docs/阅读笔记.md': `# 阅读笔记

## 火车上的阅读

离线阅读要安静：没有加载圈，没有弹窗。字体用系统的就好。

## 关于标签

标签应该自己长出来，不应该让使用者维护体系。
`,
    'docs/research-notes.md': `# Research notes

## 分词调研

中文分词看了两种做法：内置的小词表，和接入一个分词库。倾向后者，但词表体积是个问题。

## Export formats

A folder of Markdown files stays readable forever; a single JSON dump does not.
`,
    'docs/receipts/batch-1.md': `# Receipt · batch 1

Worker agent report, 2026-09-08.

- T-1 global hotkey capture is done and was tried on two machines.
- T-2 note field is done; notes save together with the page.
`,
    'docs/receipts/batch-2.md': `# Receipt · batch 2

Worker agent report, 2026-09-17.

- The search index now refreshes itself every minute in the background.
- Result ranking was adjusted; longer documents are no longer favoured.
- Batch 2 was signed off by the reviewer.
`,
    'docs/design/reader-layout.md': `# Reader layout v2

Single column, 68 characters per line, system fonts only. 中文与英文混排时行高一致。

Margins grow on wide screens; nothing else moves.
`,
    'docs/design/search-index.md': `# Search index design

SQLite FTS5, one table for title and one for body. The index rebuilds when the app opens; incremental rebuild is T-18.

Tokenizer: unicode61 for English, a small word table for 中文.
`,
    'docs/review-search.md': `# QC review · search

QC reviewer, 2026-09-11.

The ranking change in T-17 is verified against the benchmark set. The refresh claim in batch 2 could not be confirmed from the code.
`,
    'docs/bench-2026-09-10.md': `# Benchmark 2026-09-10

5,120 items. First query 812 ms, warm 96 ms. Index build 41 s on open.
`,
    'docs/bench-lint.txt': `lint run 2026-09-12\n0 errors, 14 warnings (12 of them in vendor/chart-lib)\n`,
    'vendor/chart-lib/README.md': `# chart-lib (vendored)

Third-party charting library, vendored for the statistics page. Its documents are for reference only.
`,
    'vendor/chart-lib/guide.md': `# chart-lib guide

Axes, series, and theming. Reference only — not project requirements.
`,
    'dist/bundle.js': `// Bundled build output (generated, committed once by mistake).
`,
    'dist/index.html': `<html><body>Papertrail bundle shell (generated)</body></html>
`,
    '.gitignore': `# Scratch space and personal drafts stay out of the project record
/scratch/
/drafts/
`,
    'scratch/run-cache.json': `{"scratch": true, "runs": 3}
`,
    'scratch/blob.dat': `scratch intermediate data
`,
    'drafts/ideas.md': `# Ideas (personal drafts)

Half-formed thoughts on the reading view. Not decided project material.
`,
    'drafts/roadmap-sketch.md': `# Roadmap sketch (draft)

A personal sketch of where v2 could go. Not the agreed plan.
`,
    'docs/supplier-notes/pricing.md': `# Supplier pricing notes

Pricing material the search library's supplier sent along. For reference, not a requirement source.
`,
    'docs/supplier-notes/terms.md': `# Supplier terms

The license terms the supplier sent with the pricing material. For reference.
`,
    'archive/README.md': `# archive

Old v1 designs, kept for reference. Nothing here is current.
`,
    'archive/v1-design.md': `# v1 design (archived)

The v1 sync prototype design. Superseded; sync was deferred after v1.
`,
    'src/capture.ts': `// Capture: one shortcut, no dialog.
export function capture(url: string, note = '') { return { url, note, savedAt: Date.now() }; }
`,
    'src/reader.ts': `// Reader: offline first, system fonts only.
export function render(article: string) { return article.length; }
`,
    'src/search.ts': `// Search: SQLite FTS5. The index rebuilds when the app opens; there is no background refresh yet.
export function rebuildIndex() { return 0; }
export function search(q: string) { return [q]; }
`,
    'src/sync.ts': `// Sync: deferred until after v1. Nothing here runs.
export const enabled = false;
`,
    'src/export.ts': `// Export: a folder of Markdown files (DEC-3). Attachments are still todo.
export function exportAll(items: string[]) { return items.length; }
`,
    'src/search.test.ts': `test('finds a saved page by title', () => {});
test('finds 中文 by word', () => {});
`,
    'src/search.perf.test.ts': `test('first query under 1s for 5k items', () => {});
`,
    'src/export.test.ts': `test('export writes one markdown file per item', () => {});
`,
    'sessions/claude-2026-09-15.jsonl': `{"type":"summary","text":"work session: capture note field and title completion"}\n`,
    'sessions/claude-2026-09-13.jsonl': `{"type":"summary","text":"work session: search replaces the tag browser"}\n`,
    'sessions/owner-2026-08-22.jsonl': `{"type":"summary","text":"owner conversation: what Papertrail is for"}\n`,
  };
}

/** Extra tiny test/bench files for the large size, so observed results scale past one screen. */
function largeExtraFiles(count: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i += 1) {
    out[`src/gen/gen-${i}.test.ts`] = `test('generated case ${i}', () => {});\n`;
  }
  return out;
}

/** A git invocation pinned to fixed identity and dates, so commit hashes are stable across runs. */
function gitEnv(root: string, at: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig.empty'),
    GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at,
  };
}
function git(root: string, cwd: string, at: string, args: string[]): void {
  gitOut(root, cwd, at, args);
}
/** The same, with what git printed (a hash), and extra environment (a separate index file). */
function gitOut(root: string, cwd: string, at: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', ['-c', 'user.name=Papertrail Owner', '-c', 'user.email=owner@papertrail.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, env: { ...gitEnv(root, at), ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Write the project tree, give it a real three-commit history with fixed dates, and register two worktrees. */
function writeProjectTree(home: string, projectDir: string, wtDir: string, wt2Dir: string, size: 'standard' | 'large'): void {
  const files = { ...projectFiles(), ...(size === 'large' ? largeExtraFiles(24) : {}) };
  writeFileSync(join(home, 'gitconfig.empty'), '');
  for (const [rel, content] of Object.entries(files)) {
    const path = join(projectDir, ...rel.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  // The toolchain the build config points at (invented paths only): an SDK outside the project, and a declared
  // location too broad to open — the fixture root itself, which contains the project.
  const sdkDir = `${projectDir}-sdk`;
  mkdirSync(join(sdkDir, 'tools'), { recursive: true });
  writeFileSync(join(sdkDir, 'tools', 'README.txt'), 'Invented SDK for the fixture; nothing here is a real toolchain.\n');
  const escaped = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  writeFileSync(join(projectDir, 'local.properties'), `# Local toolchain locations\nsdk.dir = ${escaped(sdkDir)}\ntoolchain.home = ${escaped(dirname(projectDir))}\n`);
  git(home, projectDir, '2026-08-20T10:00:00.000Z', ['init', '-q', '-b', 'main']);
  const commit = (at: string, msg: string, paths: string[]) => {
    git(home, projectDir, at, ['add', '--', ...paths]);
    git(home, projectDir, at, ['commit', '-q', '-m', msg]);
  };
  commit('2026-08-20T10:00:00.000Z', 'Papertrail: first version (capture, reader, documents)', ['README.md', 'AGENTS.md', 'docs/PRODUCT.md', 'docs/PLAN.md', 'docs/TASKS.md', 'docs/DECISIONS.md', 'src/capture.ts', 'src/reader.ts']);
  commit('2026-08-28T10:00:00.000Z', 'Search: FTS index, tests, and the index design', ['src/search.ts', 'src/search.test.ts', 'docs/design/search-index.md', 'docs/CHANGELOG.md', 'docs/阅读笔记.md']);
  git(home, projectDir, '2026-09-05T10:00:00.000Z', ['add', '-A']);
  git(home, projectDir, '2026-09-05T10:00:00.000Z', ['commit', '-q', '-m', 'Export, receipts, review, vendor and the archive']);
  // A receipt the review tool exported in a binary format, committed on a branch nobody merged: the ledger keeps that
  // version without its text and says so (Project scope; ScopeKView ledger.notRead). Written with git's plumbing into an
  // index of its own, so neither the working tree nor the trunk ever holds it.
  const at0 = '2026-09-06T10:00:00.000Z';
  const exported = join(home, 'receipt-batch-0.export');
  writeFileSync(exported, Buffer.concat([Buffer.from('# Receipt · batch 0 (review tool export)\n'), Buffer.from([0, 1, 2, 0, 255, 254, 0]), Buffer.from('\nverdict: pass\n')]));
  const index = { GIT_INDEX_FILE: join(home, 'receipt-batch-0.index') };
  const blob = gitOut(home, projectDir, at0, ['hash-object', '-w', exported]);
  gitOut(home, projectDir, at0, ['read-tree', 'HEAD'], index);
  gitOut(home, projectDir, at0, ['update-index', '--add', '--cacheinfo', `100644,${blob},docs/receipts/batch-0.md`], index);
  const tree = gitOut(home, projectDir, at0, ['write-tree'], index);
  const exportCommit = gitOut(home, projectDir, at0, ['commit-tree', tree, '-p', 'HEAD', '-m', 'Receipt batch 0, exported by the review tool']);
  gitOut(home, projectDir, at0, ['update-ref', 'refs/heads/receipts-export', exportCommit]);
  rmSync(exported, { force: true });
  rmSync(index.GIT_INDEX_FILE, { force: true });
  git(home, projectDir, '2026-09-18T10:00:00.000Z', ['worktree', 'add', '-q', '-b', 'wt-reader-themes', wtDir]);
  mkdirSync(join(wtDir, 'src'), { recursive: true });
  writeFileSync(join(wtDir, 'src', 'reader-themes.ts'), '// Reader themes from system fonts (work in progress on the branch).\nexport const theme = "system";\n');
  // A second registered worktree: its branch has a commit the trunk does not have, plus an uncommitted change.
  git(home, projectDir, '2026-09-19T10:00:00.000Z', ['worktree', 'add', '-q', '-b', 'wt-export-attachments', wt2Dir]);
  mkdirSync(join(wt2Dir, 'src'), { recursive: true });
  writeFileSync(join(wt2Dir, 'src', 'export-attachments.ts'), '// Attachments export, first pass on the branch.\nexport const attachments = false;\n');
  git(home, wt2Dir, '2026-09-19T11:00:00.000Z', ['add', '--', 'src/export-attachments.ts']);
  git(home, wt2Dir, '2026-09-19T11:00:00.000Z', ['commit', '-q', '-m', 'Attachments export: first pass on the branch']);
  writeFileSync(join(wt2Dir, 'src', 'export-images.ts'), '// Image attachments, uncommitted sketch.\n');
}

// ───────────────────────── the seed ─────────────────────────

export async function seedUiFixture(home: string, options: { size?: 'standard' | 'large'; projectDir?: string; name?: string } = {}): Promise<UiFixtureResult> {
  const size = options.size ?? 'standard';
  // The fixture's directory in the file system's own spelling (the temporary directory is often given in another one,
  // a short name on Windows): the worktrees are registered, and looked up below, under the spelling git reports.
  const root = canonicalPath(options.projectDir ? resolve(options.projectDir) : join(tmpdir(), `pk-ui-fixture-papertrail-${size}`));
  const projectDir = options.projectDir ? root : join(root, 'papertrail');
  const wtDir = `${projectDir}-wt`;
  const wt2Dir = `${projectDir}-wt2`;
  mkdirSync(home, { recursive: true });
  if (!options.projectDir) rmSync(root, { recursive: true, force: true });
  mkdirSync(projectDir, { recursive: true });
  writeProjectTree(home, projectDir, wtDir, wt2Dir, size);

  const app = new App(home, { organizing: false });
  app.workspace.setSettings({ watchProjects: false });
  const name = options.name ?? 'Papertrail 阅读清单 (UI fixture)';
  const existing = app.workspace.list().find((p) => p.name === name);
  if (existing) {
    app.workspace.remove(existing.id);
    rmSync(assetDirOf(existing.id, home), { recursive: true, force: true });
  }
  const project = app.addProject(name, [projectDir]);
  await app.intakeProject(project.id);
  app.stopAll();
  const store = app.store(project.id);
  const pid = project.id;

  const inputs = (sourceIds: readonly string[], jobId = 'job_frame'): JobInputs => ({ jobId, sourceIds, factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: projectDir });
  const putSrc = (s: Source, summary: string) => store.sources.put(s, { jobId: 'job_frame', summary });

  // ---- source lookup and Used as ----
  const fileSources = (suffix: string) => store.sources.all().filter((s) => s.anchor.kind === 'file' && s.anchor.path.replaceAll('\\', '/').endsWith(suffix));
  const one = (suffix: string, heading?: string): Source => {
    const hit = fileSources(suffix).find((s) => !heading || (s.anchor.kind === 'file' && s.anchor.headingPath.join(' / ').includes(heading)));
    if (!hit) throw new Error(`fixture source missing: ${suffix} ${heading ?? ''}`);
    return hit;
  };

  // Scope: what discovery itself found in the fixture tree — the vendored library, the build output, the ignored
  // directories, and both registered worktrees measured against the trunk. Judgements and the project's rules are
  // applied to it later (below), and only what discovery cannot produce is written by hand (the sessions item, the
  // archive's Excluded override, and the 阅读笔记 question — each is marked where it happens).
  const discovered = () => app.project(pid).scope;
  const byPath = (path: string) => discovered().find((i) => samePath(i.path, path));
  const mainItem = byPath(projectDir) ?? discovered()[0];
  if (!mainItem) throw new Error('fixture: discovery found no main scope item');
  // One fresh discovery before failing: a transient read hiccup (a directory listing that came back empty under
  // load) must not fail the seed; a product regression still does.
  let rediscovered = false;
  const found = (path: string, what: string): ScopeItem => {
    let item = byPath(path);
    if (!item && !rediscovered) { rediscovered = true; app.scopeProject(pid); item = byPath(path); }
    if (!item) throw new Error(`fixture: discovery found no ${what} at ${path}`);
    return item;
  };
  const wtItem = found(wtDir, 'worktree scope item');
  const wt2Item = found(wt2Dir, 'second worktree scope item');
  const vendorItem = found(join(projectDir, 'vendor'), 'third-party candidate');
  const distItem = found(join(projectDir, 'dist'), 'generated candidate');
  const archiveItem = found(join(projectDir, 'archive'), 'archive item');
  const scratchItem = found(join(projectDir, 'scratch'), 'ignored directory');
  const draftsItem = found(join(projectDir, 'drafts'), 'ignored directory with documents');
  const mkScope = (id: string, path: string, category: ScopeItem['category'], relation: ScopeItem['relation'], reason: string, extra: Partial<ScopeItem> = {}): ScopeItem => ({
    id, path: normalizePath(path), category, relation, reason, reasonSourceIds: [], sessionHost: null, readOnly: false,
    copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'keeper', ...extra,
  });
  const sessionsItem = mkScope('scope_sessions', join(projectDir, 'sessions'), 'Directory', 'Session source', 'Work sessions for this project are kept here.', { sessionHost: 'claude', readOnly: true });
  const sqNotes = {
    id: 'sq_notes', question: 'docs/阅读笔记.md 是工作材料还是个人笔记？',
    whyItMatters: '个人笔记不应该进入整理与引用；工作材料要。',
    clues: ['它放在 docs/ 下，但内容是阅读感想', 'PLAN 没有提到它'],
    options: ['工作材料', '个人笔记，只索引不引用'], answer: null,
  };
  app.updateProject({ ...app.project(pid), scopeQuestions: [sqNotes], lastOpenedAt: T(1, 12) });

  // Used as, by path. A few sources stay null (Not yet judged).
  const usedAsOf = (s: Source): { usedAs: UsedAs | null } | null => {
    if (s.anchor.kind !== 'file') return null;
    const p = s.anchor.path.replaceAll('\\', '/');
    if (p.includes('/vendor/chart-lib/')) return { usedAs: 'Reference only' };
    if (p.includes('/archive/')) return { usedAs: 'History only' };
    if (p.endsWith('/README.md')) return { usedAs: 'Purpose' };
    if (p.endsWith('/AGENTS.md')) return { usedAs: 'Other' };
    if (p.endsWith('/docs/PRODUCT.md')) return { usedAs: 'Requirement' };
    if (p.endsWith('/docs/PLAN.md')) return { usedAs: 'Plan' };
    if (p.endsWith('/docs/TASKS.md')) return { usedAs: 'Task' };
    if (p.endsWith('/docs/DECISIONS.md')) return { usedAs: 'Decision' };
    if (p.endsWith('/docs/CHANGELOG.md')) return { usedAs: 'Status' };
    if (p.includes('/docs/receipts/')) return { usedAs: 'Status' };
    if (p.includes('/docs/design/')) return { usedAs: 'Design' };
    if (p.endsWith('/docs/review-search.md')) return { usedAs: 'QC' };
    if (p.endsWith('/docs/bench-2026-09-10.md') || p.endsWith('/docs/bench-lint.txt')) return { usedAs: 'Run result' };
    if (p.endsWith('.test.ts')) return { usedAs: 'Test' };
    if (p.endsWith('.ts')) return { usedAs: 'Code' };
    if (p.endsWith('/docs/阅读笔记.md') || p.endsWith('/docs/research-notes.md')) return { usedAs: null };
    return null;
  };
  for (const s of store.sources.all()) {
    const u = usedAsOf(s);
    if (!u) continue;
    store.sources.put({
      ...s, usedAs: u.usedAs, usedAsBy: u.usedAs === null ? null : 'keeper',
      ...(u.usedAs === 'Reference only' ? { usedAsByScopeItemId: vendorItem.id, scopeItemId: vendorItem.id } : {}),
      ...(u.usedAs === 'History only' ? { scopeItemId: archiveItem.id } : {}),
    }, { jobId: 'job_frame', summary: `Used as: ${u.usedAs ?? 'not judged'}` });
  }
  // One file changed on disk after it was read: the tokenizer research got an addendum in its 分词调研 section — the one
  // the Change log's “分词调研补记” records. It is read again after the last Follow up round started (below).
  const notesPath = join(projectDir, 'docs', 'research-notes.md');
  const tokenizerLine = '倾向后者，但词表体积是个问题。';
  const notesText = readFileSync(notesPath, 'utf8');
  if (!notesText.includes(tokenizerLine)) throw new Error('fixture: the research notes have no 分词调研 paragraph to add to');
  writeFileSync(notesPath, notesText.replace(tokenizerLine, `${tokenizerLine}\n\n补记：分词库的许可证看过了，没有问题。`));
  for (const s of fileSources('docs/research-notes.md')) store.sources.put({ ...s, availability: 'Changed since read' }, { jobId: null, summary: 'File changed since it was read' });

  // ---- sources intake cannot produce: sessions, gone/moved files ----
  const session = (host: 'claude' | 'pi', sessionId: string, msgStart: number, msgEnd: number, at: string, title: string, excerpt: string, usedAs: UsedAs | null = 'Session', file = join(projectDir, 'sessions', `${sessionId}.jsonl`)): Source =>
    putSrc({ ...makeSessionSource({ projectId: pid, host, sessionId, file, cwd: projectDir, messageStart: msgStart, messageEnd: msgEnd, at, excerpt, title, scopeItemId: sessionsItem.id, readAt: at }), usedAs, usedAsBy: usedAs ? 'owner' : null }, `Session segment: ${title}`);
  // The owner's three conversations are real Claude Code logs (kept in the fixture home, outside the project), so the
  // program takes the owner's words out of them the way it does in any project (sources/sessions/utterances.ts): the
  // ground of the first usable round's session drafts planted below, and the "of 12" of its owner's-words step.
  const ownerLog = (sessionId: string, at: string, lead: number, lines: readonly string[]) => {
    const dir = join(home, 'fixture-sessions');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sessionId}.jsonl`);
    const records: string[] = [];
    const said: { index: number; at: string; text: string }[] = [];
    let index = 0;
    const rec = (type: 'user' | 'assistant', text: string) => {
      const ts = new Date(Date.parse(at) + index * 60_000).toISOString();
      records.push(JSON.stringify({ type, timestamp: ts, sessionId, cwd: projectDir, isSidechain: false, userType: 'external', entrypoint: 'cli', message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', model: 'fixture', content: [{ type: 'text', text }] } }));
      if (type === 'user') said.push({ index, at: ts, text });
      index += 1;
    };
    for (let i = 0; i < lead; i++) rec('assistant', i === 0 ? 'What should the list do for you?' : 'Go on.');
    lines.forEach((l, i) => { rec('user', l); if (i < lines.length - 1) rec('assistant', 'Noted.'); });
    writeFileSync(file, `${records.join('\n')}\n`);
    return { file, start: lead, end: index - 1, said };
  };
  const own1 = ownerLog('sess_fixture_own1', T(25), 2, ['Saving has to be faster than deciding where it goes.', 'If it needs an account, it is dead to me.', 'Read comfortably on the train, offline.', 'The list is mine: plain files, export anytime.']);
  const own2 = ownerLog('sess_fixture_own2', T(18), 3, ['搜索要在一秒内出结果，不然我不会用。', '我不想维护标签体系，它自己长出来。', '导入导出必须是纯文本能看懂的格式。', '可以，先做搜索。']);
  const own3 = ownerLog('sess_fixture_own3', T(9), 4, ['Never lose the list, even if sync breaks.', 'Sharing is a nice-to-have; nobody asked for it.', '先整理收据，供应商的文档最后再说。', '对，编号以 TASKS.md 为准。']);
  const src_own_1 = session('claude', 'sess_fixture_own1', own1.start, own1.end, T(25), 'Owner conversation · what Papertrail is for', own1.said.map((l) => l.text).join(' '), 'Session', own1.file);
  const src_own_2 = session('claude', 'sess_fixture_own2', own2.start, own2.end, T(18), 'Owner conversation · 搜索与标签', own2.said.map((l) => l.text).join(''), 'Session', own2.file);
  const src_own_3 = session('claude', 'sess_fixture_own3', own3.start, own3.end, T(9), 'Owner conversation · sharing and rules', own3.said.map((l) => l.text).join(' '), 'Session', own3.file);
  const src_sess_capture = session('claude', 'sess_fixture_04', 1, 30, T(6), 'Work session · capture note field', 'Session in which T-2 and T-5 were built.');
  const src_sess_search = session('claude', 'sess_fixture_05', 1, 42, T(4), 'Work session · search replaces tag browser', 'Session in which the tag browser was replaced by full-text search.');
  const fileAnchor = (path: string, heading: string, from: number, to: number): SourceAnchor => ({ kind: 'file', path, headingPath: [heading], lineStart: from, lineEnd: to });
  const manualFile = (idParts: string, path: string, heading: string, excerpt: string, over: Partial<Source>): Source =>
    putSrc({ id: stableId('src', 'fixture', idParts), projectId: pid, title: heading, anchor: fileAnchor(path, heading, 1, 12), ids: [], version: { fingerprint: `sha256:${idParts.length.toString(16).padStart(4, '0')}${'0'.repeat(60)}`, readAt: T(20), commit: null }, excerpt, usedAs: 'Design', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: mainItem.id, hasCredential: false, bytes: excerpt.length, ...over }, `Source: ${heading}`);
  const src_old_doc = manualFile('gone-v1', join(projectDir, 'docs', 'design', 'sync-v1.md'), 'Sync v1 design (deleted)', 'The v1 sync prototype design. Deleted when sync was deferred.', { availability: 'No longer available' });
  manualFile('moved-notes', join(projectDir, 'docs', 'reading-notes.md'), 'Reading notes (moved)', 'The reading notes, before they moved to docs/阅读笔记.md.', { availability: 'Moved', movedTo: join(projectDir, 'docs', '阅读笔记.md') });

  // The owner's messages in the Keeper conversation are session sources of their own (Spec §6.8).
  const ownerMsg = (conv: string, turn: number, at: string, text: string): Source =>
    putSrc({ ...makeSessionSource({ projectId: pid, host: 'pi', sessionId: conv, file: '', cwd: projectDir, messageStart: turn, messageEnd: turn, at, excerpt: `[owner ${at}]\n${text}`, title: `Keeper conversation · message ${turn}`, scopeItemId: mainItem.id, readAt: at }), usedAs: null, usedAsBy: null }, 'Owner message in the Keeper conversation');
  const src_msg_1 = ownerMsg('conv_fixture_main', 1, T(0, 5), '搜索现在到底有多快？ receipts 说每分钟刷新，代码里看不到。');
  const src_msg_2 = ownerMsg('conv_fixture_main', 2, T(0, 4), '把 T-19 的进度更新到 TASKS.md，顺便看看导出。');
  const src_msg_3 = ownerMsg('conv_fixture_main', 3, T(0, 3), 'Investigate this note ("搜索速度的验证只是个占位基准", note_search_speed): what needs adjusting, why, and where it affects.');
  const src_msg_4 = ownerMsg('conv_fixture_side', 1, T(3, 2), '导出格式为什么是 Markdown？');

  const commandSrc = (id: string, command: string, at: string, title: string, excerpt: string): Source =>
    putSrc({ id, projectId: pid, title, anchor: { kind: 'command', command, cwd: projectDir, ranAt: at }, ids: [], version: { fingerprint: `sha256:cmd${id.length}`, readAt: at, commit: null }, excerpt, usedAs: 'Run result', usedAsBy: 'keeper', availability: null, movedTo: null, scopeItemId: mainItem.id, hasCredential: false, bytes: excerpt.length }, `Run: ${title}`);
  const cmd_bench_1 = commandSrc('src_cmd_bench1', 'node bench.js --case search', T(2, 3), 'Benchmark run · search', '5,120 items. First query 812 ms.');
  const cmd_bench_2 = commandSrc('src_cmd_bench2', 'node bench.js --case search --warm', T(1, 2), 'Benchmark run · warm queries', 'Warm query 96 ms.');
  const cmd_lint = commandSrc('src_cmd_lint', 'npm run lint', T(3, 5), 'Lint run', '0 errors, 14 warnings.');

  const src_readme_goal = one('README.md', 'Goal');
  const src_search_code = one('src/search.ts');
  const src_search_test = one('src/search.test.ts');
  const src_search_perf = one('src/search.perf.test.ts');
  const src_export_code = one('src/export.ts');
  const src_export_test = one('src/export.test.ts');
  const src_capture_code = one('src/capture.ts');
  const src_receipt_1 = one('docs/receipts/batch-1.md');
  const src_receipt_2 = one('docs/receipts/batch-2.md');
  const src_review_search = one('docs/review-search.md');
  const src_bench_doc = one('docs/bench-2026-09-10.md');
  const src_lint_out = one('docs/bench-lint.txt');
  const src_notes_zh = one('docs/阅读笔记.md', '阅读笔记');
  const src_research = one('docs/research-notes.md', '分词调研');
  const src_tasks = one('docs/TASKS.md');
  const src_agents = one('AGENTS.md', 'How we work');

  // ---- product reference (Spec §1.3) ----
  const ref = (id: string, category: ReferenceItem['category'], name: string, text: string, extra: Partial<ReferenceItem> = {}): string => {
    store.reference.put({
      id, projectId: pid, category, name, ids: extra.ids ?? [], text, quote: extra.quote ?? null,
      basis: extra.basis ?? 'Explicit', validity: extra.validity ?? 'Current', progress: extra.progress ?? null,
      attribution: extra.attribution ?? byRole('Product architect'), sourceIds: extra.sourceIds ?? [src_readme_goal.id],
      refines: extra.refines ?? [], replacedBy: extra.replacedBy ?? null, inputs: inputs(extra.sourceIds ?? []),
      asOf: T(20), updatedAt: extra.updatedAt ?? T(20), ...(extra.supersededParts ? { supersededParts: extra.supersededParts } : {}),
      ...(extra.carryOut !== undefined ? { carryOut: extra.carryOut } : {}),
      ...(extra.validityByRuleId ? { validityByRuleId: extra.validityByRuleId } : {}),
    }, { jobId: 'job_frame', summary: `Reference item: ${name}` });
    return id;
  };

  // The owner's own words, each with the words and where they were said (D63).
  const ow_save_fast = ref('ow_save_fast', "Owner's words", 'Save faster than filing', 'Saving has to be faster than deciding where it goes.', { quote: 'Saving has to be faster than deciding where it goes', attribution: byOwner, sourceIds: [src_own_1.id] });
  const ow_offline = ref('ow_offline', "Owner's words", 'Read offline on the train', 'Read comfortably on the train, offline.', { quote: 'Read comfortably on the train, offline', attribution: byOwner, sourceIds: [src_own_1.id] });
  const ow_no_account = ref('ow_no_account', "Owner's words", 'No accounts', 'If it needs an account, it is dead to me.', { quote: 'If it needs an account, it is dead to me', attribution: byOwner, sourceIds: [src_own_1.id] });
  const ow_search_fast = ref('ow_search_fast', "Owner's words", '搜索要在一秒内出结果', '搜索要在一秒内出结果，不然我不会用。', { quote: '搜索要在一秒内出结果，不然我不会用', attribution: byOwner, sourceIds: [src_own_2.id] });
  const ow_tags_grow = ref('ow_tags_grow', "Owner's words", '标签自己长出来', '我不想维护标签体系，它自己长出来。', { quote: '我不想维护标签体系，它自己长出来', attribution: byOwner, sourceIds: [src_own_2.id] });
  const ow_plain_text = ref('ow_plain_text', "Owner's words", '导入导出用纯文本格式', '导入导出必须是纯文本能看懂的格式。', { quote: '导入导出必须是纯文本能看懂的格式', attribution: byOwner, sourceIds: [src_own_2.id] });
  const ow_never_lose = ref('ow_never_lose', "Owner's words", 'Never lose the list', 'Never lose the list, even if sync breaks.', { quote: 'Never lose the list, even if sync breaks', attribution: byOwner, sourceIds: [src_own_3.id] });
  const ow_sharing = ref('ow_sharing', "Owner's words", 'Sharing stays a nice-to-have for later; nobody who uses the list has ever asked for it, and it must not slow down capture or reading', 'Sharing is a nice-to-have; nobody asked for it.', { quote: 'Sharing is a nice-to-have; nobody asked for it', attribution: byOwner, sourceIds: [src_own_3.id] });
  ref('ow_long_zh', "Owner's words", '超长标题也要显示正常：这一句 owner 的原话故意写得非常非常长，用来检查界面在中文长标题下的换行、省略与悬浮提示', '长标题不能顶破布局。', { quote: '长标题不能顶破布局', attribution: byOwner, sourceIds: [src_own_3.id] });

  const ref_product = ref('ref_product', 'Product', 'Papertrail — a one-person read-later list 稍后读清单', 'Save in one motion, read anywhere, find in one query. The list belongs to the owner.', { refines: [ow_save_fast, ow_offline], attribution: byOwner });
  const ref_g1 = ref('ref_g1', 'Goal', 'G1 · Save in one motion, find in one query', 'Save in one motion, find in one query.', { ids: ['G1'], refines: [ref_product, ow_save_fast, ow_search_fast] });
  const ref_g2 = ref('ref_g2', 'Goal', 'G2 · Read anywhere, offline first', 'Read anywhere, offline first.', { ids: ['G2'], refines: [ref_product, ow_offline] });
  const ref_g3 = ref('ref_g3', 'Goal', 'G3 · 数据永远属于自己：纯文本、可导出、不依赖账号', '数据永远属于自己。', { ids: ['G3'], refines: [ref_product, ow_no_account, ow_never_lose, ow_plain_text] });

  const ref_capture = ref('ref_capture', 'Area', 'A1 · Capture 快速收藏', 'One shortcut, no dialog.', { ids: ['A1'], refines: [ref_g1, ow_save_fast] });
  const ref_reading = ref('ref_reading', 'Area', 'A2 · Reading 阅读体验', 'Offline, calm typography.', { ids: ['A2'], refines: [ref_g2, ow_offline] });
  const ref_search = ref('ref_search', 'Area', 'A3 · Search 搜索与找回', 'Full text, under a second.', { ids: ['A3'], refines: [ref_g1, ow_search_fast] });
  const ref_sync = ref('ref_sync', 'Area', 'A4 · Sync 同步', 'Deferred until after v1.', { ids: ['A4'], refines: [ref_g2, ow_never_lose], validity: 'Deferred' });
  const ref_tags = ref('ref_tags', 'Area', 'A5 · Tags 标签与整理', 'Tags suggest themselves.', { ids: ['A5'], refines: [ref_g1, ow_tags_grow] });
  const ref_sharing = ref('ref_sharing', 'Area', 'A6 · Sharing 分享', 'Proposed, not scheduled.', { ids: ['A6'], refines: [ow_sharing] });
  const ref_export = ref('ref_export', 'Area', 'A7 · Import & export 导入导出', 'Plain text only.', { ids: ['A7'], refines: [ref_g3, ow_plain_text] });

  const ref_req_hotkey = ref('ref_req_hotkey', 'Requirement', 'REQ-C1 · One shortcut saves the current page', 'A global shortcut saves the current page without a dialog.', { ids: ['REQ-C1'], refines: [ref_capture], sourceIds: [one('docs/PRODUCT.md', 'Areas').id] });
  ref('ref_req_note', 'Requirement', 'REQ-C2 · Save with a note attached 收藏时可附注', 'A note can be saved together with the page.', { ids: ['REQ-C2'], refines: [ref_capture] });
  ref('ref_dsn_clip', 'Design', 'Clipboard URL detection 剪贴板检测设计', 'On open, a URL on the clipboard is offered as a one-key save.', { basis: 'Inferred', refines: [ref_capture] });
  ref('ref_dec_accounts', 'Decision', 'DEC-1 · No accounts 不做账号', 'No accounts in v1; the list is local files.', { ids: ['DEC-1'], quote: 'If it needs an account, it is dead to me', attribution: byOwner, refines: [ow_no_account], sourceIds: [src_own_1.id] });

  const ref_req_offline = ref('ref_req_offline', 'Requirement', 'REQ-R1 · Every saved article reads offline 离线可读', 'Every saved article reads offline, with no spinner and no dialog.', { ids: ['REQ-R1'], refines: [ref_reading] });
  ref('ref_req_typography', 'Requirement', 'REQ-R2 · Reading typography must keep mixed Chinese and English paragraphs readable on a narrow screen 中英文混排在窄屏上也要清楚', 'Mixed Chinese and English paragraphs keep one line height on a narrow screen.', { ids: ['REQ-R2'], refines: [ref_reading] });
  ref('ref_dsn_reader', 'Design', 'Reader layout v2 阅读版式 v2', 'Single column, 68 characters per line, system fonts only.', { refines: [ref_req_offline], sourceIds: [one('docs/design/reader-layout.md').id] });
  ref('ref_dsn_reader_v1', 'Design', 'Reader layout v1 · server-rendered 服务端渲染版', 'The first reader was server-rendered; abandoned with DEC-1.', { refines: [ref_reading], validity: 'Abandoned' });

  const ref_req_speed = ref('ref_req_speed', 'Requirement', 'REQ-S1 · Search returns in under one second for 5,000 items 五千条一秒内出结果', 'Search returns within one second for 5,000 items.', { ids: ['REQ-S1'], refines: [ref_search, ow_search_fast] });
  const ref_req_zh = ref('ref_req_zh', 'Requirement', 'REQ-S2 · 中文搜索按词匹配而不是按字', '中文搜索按词而不是按字匹配。', { ids: ['REQ-S2'], basis: 'Inferred', refines: [ref_search], sourceIds: [src_notes_zh.id] });
  const ref_req_tagbrowser = ref('ref_req_tagbrowser', 'Requirement', 'REQ-S0 · Tag browser 标签浏览器', 'Browse saved pages by tag.', { ids: ['REQ-S0'], refines: [ref_search], validity: 'Replaced', replacedBy: 'ref_req_fulltext' });
  const ref_req_fulltext = ref('ref_req_fulltext', 'Requirement', 'REQ-S3 · Full-text search with filters 全文搜索带筛选', 'Full-text search with tag, date and domain filters replaces the tag browser.', { ids: ['REQ-S3'], refines: [ref_search] });
  ref('ref_dsn_fts', 'Design', 'Search index design · SQLite FTS5 索引设计', 'One table for title, one for body; unicode61 for English, a small word table for 中文.', { refines: [ref_req_speed], sourceIds: [one('docs/design/search-index.md').id] });

  ref('ref_req_sync2', 'Requirement', 'REQ-Y1 · Sync between two machines 两台机器之间同步', 'Sync the list between two machines without an account.', { ids: ['REQ-Y1'], refines: [ref_sync], validity: 'Deferred' });
  ref('ref_req_autotag', 'Requirement', 'REQ-T1 · Tags suggest themselves 标签自荐', 'Tags are suggested from the text; the owner never maintains a tag system.', { ids: ['REQ-T1'], refines: [ref_tags] });
  ref('ref_req_share', 'Requirement', 'REQ-H1 · Share a list by link 按链接分享清单', 'A read-only link shares one list.', { ids: ['REQ-H1'], refines: [ref_sharing], validity: 'Proposed' });
  ref('ref_req_plaintext', 'Requirement', 'REQ-E1 · 导出必须是纯文本可读的格式', '导出必须是纯文本能看懂的格式。', { ids: ['REQ-E1'], refines: [ref_export, ow_plain_text] });
  ref('ref_req_pocket', 'Requirement', 'REQ-E2 · Import from Pocket CSV 从 Pocket 导入', 'Import a Pocket CSV export.', { ids: ['REQ-E2'], refines: [ref_export] });

  ref('ref_dec_search', 'Decision', 'DEC-2 · 搜索取代标签浏览器', 'Full-text search replaces the tag browser.', { ids: ['DEC-2'], quote: '搜索做好之后，标签浏览器就不用做了', attribution: byOwner, refines: [ref_search], sourceIds: [src_own_2.id] });
  ref('ref_dec_export', 'Decision', 'DEC-3 · Export is a folder of Markdown files 导出为一组 Markdown 文件', 'Export writes a folder of Markdown files; attachments included.', {
    ids: ['DEC-3'], attribution: byOwner, refines: [ref_export], sourceIds: [one('docs/DECISIONS.md').id],
    carryOut: { status: 'Partly carried out', remaining: '导出附件（图片）还没有做；Pocket 导入未开始', workIds: ['thread_export_md'], evidenceSourceIds: [src_export_code.id], at: T(2), jobId: 'job_relook' },
  });
  ref('ref_dec_font', 'Decision', 'DEC-4 · 阅读主题只用系统字体', '阅读主题只用系统字体，不打包字体文件。', { ids: ['DEC-4'], attribution: byRole('Lead agent', 'Artifact'), refines: [ref_reading] });
  ref('ref_dec_wc_old', 'Decision', 'DEC-5 · Word counts are part of the search index 字数进索引', 'Word counts were indexed; DEC-6 took that back.', { ids: ['DEC-5'], refines: [ref_search], validity: 'Replaced', replacedBy: 'ref_dec_wc' });
  ref('ref_dec_wc', 'Decision', 'DEC-6 · Word counts stay out of the search index 字数统计不进索引', 'Word counts stay out of the search index.', { ids: ['DEC-6'], refines: [ref_search] });
  ref('ref_dec_attach', 'Decision', 'DEC-7 · 附件先存原图链接不下载', '附件先存原图链接，不下载。owner 在对话里说的，DECISIONS.md 里还没有。', { ids: ['DEC-7'], attribution: byOwner, refines: [ref_export], sourceIds: [src_own_3.id] });

  ref('ref_bound_social', 'Boundary', 'B-1 · v1 不做任何社交功能', 'v1 不做任何社交功能。', { ids: ['B-1'], refines: [ref_sharing] });
  ref('ref_bound_server', 'Boundary', 'B-2 · No server of our own in v1 v1 不自建服务器', 'No server of our own in v1.', { ids: ['B-2'], basis: 'Inferred', refines: [ref_sync] });

  ref('ref_plan1', 'Plan', 'PLAN-1 · v1 milestone: save, read, find', 'v1: capture, reader, first search.', { ids: ['PLAN-1'], refines: [ref_product], progress: 'Done', sourceIds: [one('docs/PLAN.md', 'PLAN-1').id] });
  ref('ref_plan2', 'Plan', 'PLAN-2 · 秋季打磨：搜索、导出与中文体验', '秋季打磨：搜索、导出与中文体验。', { ids: ['PLAN-2'], refines: [ref_g3], progress: 'In progress', sourceIds: [one('docs/PLAN.md', 'PLAN-2').id] });
  ref('ref_plan3', 'Plan', 'PLAN-3 · Sync evaluation 同步评估', 'Sync evaluation after the v1 review.', { ids: ['PLAN-3'], refines: [ref_g2], progress: 'Planned', validity: 'Deferred' });
  ref('ref_gone_sync', 'Requirement', 'REQ-X9 · v1 sync prototype 同步原型', 'The v1 sync prototype requirement; its material was deleted.', { ids: ['REQ-X9'], refines: [ref_sync], validity: 'Removed', sourceIds: [src_old_doc.id] });

  // ---- work threads and area understanding (§1.4) ----
  const st = (id: string, type: Statement['type'], text: string, sourceIds: readonly string[], claimedBy?: Statement['claimedBy']): Statement => ({ id, type, text, sourceIds, ...(claimedBy ? { claimedBy } : {}) });
  const thread = (id: string, title: string, numIds: readonly string[], progress: Progress, serves: WorkThread['serves'], extra: Partial<WorkThread> = {}): string => {
    store.threads.put({
      id, projectId: pid, title, ids: numIds, doing: extra.doing ?? `${title}: what this work does now.`,
      changed: extra.changed ?? '', results: extra.results ?? '', unresolved: extra.unresolved ?? '',
      ...(extra.doneMeans !== undefined ? { doneMeans: extra.doneMeans } : {}),
      ...(extra.acceptanceMeans !== undefined ? { acceptanceMeans: extra.acceptanceMeans } : {}),
      ...(extra.acceptance !== undefined ? { acceptance: extra.acceptance } : {}),
      executionFacts: extra.executionFacts ?? [], qcFacts: extra.qcFacts ?? [], factRecordIds: extra.factRecordIds ?? [],
      serves, dependsOn: extra.dependsOn ?? [], progress, validity: extra.validity ?? 'Current', replacedBy: extra.replacedBy ?? null,
      attribution: extra.attribution ?? byRole('Worker agent'), inputs: inputs([], 'job_round_1'), asOf: extra.asOf ?? T(20), updatedAt: extra.updatedAt ?? T(6),
      pendingSourceIds: extra.pendingSourceIds ?? [],
      ...(extra.validityByRuleId ? { validityByRuleId: extra.validityByRuleId } : {}),
      ...(extra.progressByRuleId ? { progressByRuleId: extra.progressByRuleId } : {}),
    }, { jobId: 'job_round_1', summary: `Thread: ${title}` });
    return id;
  };
  const serve = (referenceId: string, claim: string, basis: 'Explicit' | 'Inferred' = 'Explicit') => ({ referenceId, claim, basis });

  // A1 · Capture (8)
  thread('thread_hotkey', 'Global hotkey capture', ['T-1'], 'Done', [serve(ref_capture, 'gives one-shortcut saving')], {
    results: 'The hotkey saves the current page on two machines.', doneMeans: 'One shortcut saves without a dialog.',
    acceptance: 'Accepted', acceptanceMeans: 'The owner tried it on both machines.', factRecordIds: ['fact_batch1'], updatedAt: T(9),
    executionFacts: [st('st_ex_c1', 'Claimed', 'T-1 global hotkey capture is done and was tried on two machines', [src_receipt_1.id], { who: 'Worker agent, batch 1 receipt', at: '2026-09-08', untrustedRuleId: null })],
  });
  thread('thread_save_note', 'Save with note field 收藏附注', ['T-2'], 'Done', [serve(ref_capture, 'a note saves with the page')], {
    results: 'The note field saves together with the page.', doneMeans: 'A note survives export and re-import.',
    acceptance: 'Accepted', acceptanceMeans: 'The owner accepted it in conversation.', factRecordIds: ['fact_batch1'], updatedAt: T(8),
  });
  thread('thread_clipboard', 'Clipboard URL detection', ['T-3'], 'Done', [serve(ref_capture, 'one-key save from the clipboard', 'Inferred')], {
    results: 'Offers a one-key save when the clipboard holds a URL.', acceptance: 'Not yet accepted', acceptanceMeans: 'Only the owner can say the prompt is not annoying.', updatedAt: T(7),
  });
  thread('thread_bookmarklet', 'Browser bookmarklet', ['T-4'], 'Done', [serve(ref_capture, 'saves from browsers without an extension')], { results: 'Works in two browsers.', updatedAt: T(12) });
  thread('thread_title_zh', '收藏时的标题补全（中文页面标题乱码处理）', ['T-5'], 'In progress', [serve(ref_capture, '中文页面的标题不再乱码')], {
    doing: '补全被截断或乱码的中文标题。', unresolved: '少数 GBK 页面的编码嗅探还不稳。', factRecordIds: ['fact_reading'], updatedAt: T(0, 3),
  });
  thread('thread_share_sheet', 'Capture from share sheet 系统分享面板收藏', ['T-6'], 'Planned', [serve(ref_capture, 'saves from the phone share sheet')], { updatedAt: T(6) });
  thread('thread_duplicates', 'Duplicate detection on save', ['T-7'], 'Planned', [serve(ref_capture, 'the same page is not saved twice')], { updatedAt: T(6) });
  thread('thread_capture_queue', 'Capture queue draining', ['T-8'], 'On hold', [serve(ref_capture, 'offline saves drain when back online')], { unresolved: 'Waiting on the sync decision.', updatedAt: T(10) });

  // A2 · Reading (6)
  thread('thread_offline_store', 'Offline article store 离线文章库', ['T-9'], 'Done', [serve(ref_reading, 'every saved article reads offline')], {
    results: 'Saved articles open with no network.', doneMeans: 'No spinner with the network off.',
    acceptance: 'Accepted', acceptanceMeans: 'The owner reads on the train.', updatedAt: T(11),
  });
  thread('thread_typography', 'Reader typography v2 阅读排版 v2', ['T-10'], 'Done', [serve(ref_reading, 'mixed Chinese and English stay readable')], {
    results: 'One line height for mixed paragraphs.', acceptance: 'Not yet accepted', acceptanceMeans: 'Only the owner can judge the reading feel.', updatedAt: T(9),
  });
  thread('thread_reader_themes', 'Reader themes from system fonts', ['T-11'], 'In progress', [serve(ref_reading, 'themes without bundled fonts')], { doing: 'Themes built on system fonts (DEC-4).', updatedAt: T(2, 4) });
  thread('thread_reading_progress', '阅读进度记忆与滚动位置恢复', ['T-12'], 'In progress', [serve(ref_reading, '继续阅读时回到上次的位置')], { doing: '记录每篇的滚动位置。', updatedAt: T(1, 6) });
  thread('thread_print_css', 'Print stylesheet 打印样式', ['T-13'], 'Planned', [serve(ref_reading, 'prints read cleanly')], { updatedAt: T(6) });
  thread('thread_reader_v1', 'Reader layout v1 (server-rendered)', ['T-14'], 'On hold', [serve(ref_reading, 'the first reader')], { changed: 'Abandoned with DEC-1; kept for reference.', updatedAt: T(15) });

  // A3 · Search (10)
  thread('thread_fts', 'SQLite FTS index', ['T-15'], 'Done', [serve(ref_search, 'full-text search over title and body')], {
    results: 'FTS5 tables exist and answer queries.', factRecordIds: ['fact_search'], updatedAt: T(10),
  });
  thread('thread_query_parser', 'Query parser 查询解析', ['T-16'], 'Done', [serve(ref_search, 'field filters parse')], { results: 'tag:, date: and domain: parse.', updatedAt: T(10) });
  thread('thread_result_ranking', 'Result ranking 结果排序', ['T-17'], 'Done', [serve(ref_search, 'longer documents no longer favoured')], {
    results: 'Ranking adjusted; warm query 96 ms.', acceptance: 'Not yet accepted', acceptanceMeans: 'The owner judges whether the order feels right.',
    progressByRuleId: 'rule_changelog', updatedAt: T(5),
  });
  thread('thread_search_index', 'Search index incremental rebuild 增量重建', ['T-18'], 'In progress', [serve(ref_search, 'the index refreshes without a full rebuild')], {
    doing: 'Incremental rebuild instead of rebuilding on open.', unresolved: 'The receipt claims a one-minute background refresh; the code does not have it.',
    factRecordIds: ['fact_batch2'], dependsOn: [{ threadId: 'thread_fts', claim: 'builds on the FTS tables', basis: 'Explicit' }],
    qcFacts: [st('st_qc_s4', 'Observed', 'The ranking change is verified against the benchmark set; the refresh claim is not confirmed from the code', [src_review_search.id])],
    updatedAt: T(0, 8),
  });
  thread('thread_zh_tokenizer', '中文分词接入（jieba 分词与自造词表）', ['T-19'], 'In progress', [serve(ref_search, '中文按词匹配'), serve(ref_g3, '词表是项目自己的数据', 'Inferred')], {
    doing: '接入分词库，并维护项目自己的词表。', unresolved: '词表体积与更新频率未定。',
    dependsOn: [{ threadId: 'thread_search_index', claim: '分词在索引重建之后接入', basis: 'Explicit' }],
    pendingSourceIds: [src_research.id], factRecordIds: ['fact_reading'], updatedAt: T(0, 2),
  });
  thread('thread_search_filters', 'Search filters (tag, date, domain) 搜索筛选', ['T-20'], 'In progress', [serve(ref_search, 'filters narrow the result'), serve(ref_tags, '标签成为筛选条件而不是浏览页', 'Inferred')], {
    dependsOn: [{ threadId: 'thread_search_index', claim: 'filters read the incremental index', basis: 'Inferred' }], updatedAt: T(1, 4),
  });
  thread('thread_empty_state', '搜索结果页在没有任何匹配时要给出有用的空状态而不是一片空白（含最近搜索与建议）', ['T-21'], 'Planned', [serve(ref_search, 'an empty result still helps')], { updatedAt: T(6) });
  thread('thread_highlight', 'Highlight matches in preview 预览高亮', ['T-22'], 'Planned', [serve(ref_search, 'matches are visible before opening')], { updatedAt: T(6) });
  thread('thread_search_history', 'Search history 搜索历史', ['T-23'], 'Planned', [serve(ref_search, 'recent queries are one key away')], { updatedAt: T(6) });
  thread('thread_tagbrowser', 'Tag browser v1 标签浏览器 v1', ['T-24'], 'On hold', [serve(ref_tags, 'browse by tag')], {
    validity: 'Replaced', replacedBy: 'thread_search_index', validityByRuleId: 'rule_archive', changed: 'Replaced by full-text search (DEC-2).', updatedAt: T(4),
  });

  // A4 · Sync (2, deferred)
  thread('thread_sync_spike', 'Sync protocol spike 同步协议原型', ['T-25'], 'On hold', [serve(ref_sync, 'a protocol candidate exists')], { validity: 'Deferred', updatedAt: T(12) });
  thread('thread_sync_merge', '合并冲突规则调研', ['T-26'], 'Planned', [serve(ref_sync, '冲突合并的规则候选')], { validity: 'Deferred', updatedAt: T(12) });

  // A5 · Tags (4)
  thread('thread_tag_storage', 'Tag storage 标签存储', ['T-27'], 'Done', [serve(ref_tags, 'tags persist with the items')], { results: 'Tags persist; no UI yet.', updatedAt: T(9) });
  thread('thread_tag_suggest', 'Auto-tag suggestions 标签自荐', ['T-28'], 'In progress', [serve(ref_tags, 'tags suggest themselves from the text')], {
    doing: 'Suggest tags from saved text.', unresolved: 'Suggestions after the tag browser replacement have not been re-judged.', updatedAt: T(3),
  });
  thread('thread_tag_merge', 'Tag merge tool 标签合并', ['T-29'], 'Planned', [serve(ref_tags, 'near-duplicate tags merge')], { updatedAt: T(6) });
  thread('thread_tag_cloud', '标签云页面', ['T-30'], 'On hold', [serve(ref_tags, '标签云')], { unresolved: '标签浏览器被取代后，标签云是否还有意义未定。', updatedAt: T(8) });

  // A7 · Import & export (4)
  thread('thread_export_md', 'Markdown export Markdown 导出', ['T-31'], 'Done', [serve(ref_export, 'the list exports as Markdown files')], {
    results: 'Every item exports as one Markdown file.', doneMeans: 'A folder of Markdown files, readable without the app (DEC-3).',
    factRecordIds: ['fact_export'], updatedAt: T(2),
  });
  thread('thread_export_attach', 'Export with attachments 导出附件', ['T-32'], 'In progress', [serve(ref_export, 'images export alongside the text')], { updatedAt: T(0, 6) });
  thread('thread_pocket_import', 'Pocket CSV import 从 Pocket 导入', ['T-33'], 'Planned', [serve(ref_export, 'a Pocket export imports cleanly')], { updatedAt: T(6) });
  thread('thread_import_encoding', '导入时的编码嗅探（GBK 页面）', ['T-34'], 'Planned', [serve(ref_export, 'GBK 页面导入不乱码')], { updatedAt: T(6) });

  // Project-wide (5) and the removed one
  thread('thread_scaffold', 'Repo scaffolding 仓库脚手架', ['T-35'], 'Done', [], { results: 'Build and test run out of the box.', updatedAt: T(20) });
  thread('thread_ci', 'CI pipeline 持续集成', ['T-36'], 'Done', [], { results: 'Tests run on every push.', updatedAt: T(18) });
  thread('thread_side_prototype', '侧边栏原型（不服务于任何区域）', ['T-37'], 'In progress', [], { doing: 'A sidebar prototype nobody has placed.', updatedAt: T(0, 4) });
  thread('thread_dep_audit', 'Dependency audit 依赖审计', ['T-38'], 'Planned', [], { updatedAt: T(6) });
  thread('thread_telemetry', 'Telemetry opt-in prompt 遥测开关', ['T-39'], 'On hold', [], { updatedAt: T(9) });
  thread('thread_gone_sync', 'v1 sync prototype 同步原型实现', ['T-40'], 'On hold', [serve(ref_sync, 'the v1 sync attempt')], { validity: 'Removed', updatedAt: T(1) });
  thread('thread_merge_csv', 'First attempt at CSV import 首次 CSV 导入尝试', ['T-41'], 'Planned', [serve(ref_export, 'first CSV import attempt')], { updatedAt: T(14) });

  // Area understanding (§1.4): effect now, gaps, contributions.
  const areaRow = (id: string, referenceId: string, effectNow: string, gaps: string, contributions: readonly { threadId: string; claim: string; basis?: 'Explicit' | 'Inferred' }[], pending: readonly string[] = []) =>
    store.areas.put({ id, projectId: pid, referenceId, effectNow, gaps, contributions: contributions.map((c) => ({ threadId: c.threadId, claim: c.claim, basis: c.basis ?? 'Explicit' })), inputs: inputs([], 'job_round_1'), asOf: T(2), updatedAt: T(1), pendingSourceIds: pending }, { jobId: 'job_round_1', summary: `Area understanding: ${referenceId}` });
  areaRow('area_capture', ref_capture, 'One-shortcut saving works; notes save with the page; Chinese title completion is mid-work.', 'GBK pages still garble sometimes.', [{ threadId: 'thread_hotkey', claim: 'one-shortcut saving' }, { threadId: 'thread_save_note', claim: 'a note saves with the page' }, { threadId: 'thread_title_zh', claim: '中文标题补全' }]);
  areaRow('area_reading', ref_reading, 'Saved articles read offline; typography v2 is in daily use.', 'Themes are mid-work; print is not started.', [{ threadId: 'thread_offline_store', claim: 'offline reading' }, { threadId: 'thread_typography', claim: '排版 v2' }, { threadId: 'thread_reader_themes', claim: 'themes' }]);
  areaRow('area_search', ref_search, 'Full-text search answers in well under a second for 5,120 items; incremental rebuild and 中文分词 are mid-work.', 'The one-minute background refresh is claimed but not in the code.', [{ threadId: 'thread_fts', claim: 'FTS tables' }, { threadId: 'thread_search_index', claim: 'incremental rebuild' }, { threadId: 'thread_zh_tokenizer', claim: '中文分词' }, { threadId: 'thread_search_filters', claim: 'filters' }], [src_research.id]);
  areaRow('area_sync', ref_sync, 'Nothing runs; the spike is archived.', 'The whole area waits for the post-v1 review.', [{ threadId: 'thread_sync_spike', claim: 'a protocol candidate' }]);
  areaRow('area_tags', ref_tags, 'Tags persist; suggestions are mid-work.', 'What the tag browser replacement leaves for tags is not re-judged.', [{ threadId: 'thread_tag_storage', claim: 'tags persist' }, { threadId: 'thread_tag_suggest', claim: 'suggestions' }]);
  areaRow('area_sharing', ref_sharing, 'Nothing is built.', 'The requirement is only Proposed.', []);
  areaRow('area_export', ref_export, 'Markdown export works; attachments and import are ahead.', 'Attachments and GBK import remain.', [{ threadId: 'thread_export_md', claim: 'markdown export' }, { threadId: 'thread_export_attach', claim: 'attachments' }]);

  // ---- relations the Keeper wrote directly (§1.6) ----
  const rel = (id: string, type: GraphRelation['type'], from: string, to: string, claim: string, basis: 'Explicit' | 'Inferred', assessment: GraphRelation['assessment'], evidenceSourceIds: readonly string[] = [], factRecordIds: readonly string[] = [], factsSoFar = ''): string => {
    store.relations.put({
      id, projectId: pid, type, from, to, claim, basis,
      evidence: { sourceIds: evidenceSourceIds, factRecordIds, factsSoFar },
      assessment, assessedAt: assessment === 'Not assessed' ? null : T(1), assessedInJobId: assessment === 'Not assessed' ? null : 'job_relook', updatedAt: T(1),
    }, { jobId: 'job_relook', summary: `Relation: ${type} ${from} → ${to}` });
    return id;
  };
  rel('rel_impl_search', 'implements', src_search_code.id, 'thread_search_index', 'search.ts implements the index rebuild', 'Explicit', 'Holds', [src_search_code.id], ['fact_search'], 'implemented; incremental part mid-work');
  rel('rel_impl_capture', 'implements', src_capture_code.id, 'thread_hotkey', 'capture.ts implements the hotkey save', 'Inferred', 'Not assessed', [src_capture_code.id]);
  rel('rel_impl_export', 'implements', src_export_code.id, 'thread_export_md', 'export.ts writes one Markdown file per item', 'Explicit', 'Holds', [src_export_code.id], ['fact_export']);
  rel('rel_verify_search', 'verifies', src_search_test.id, 'thread_search_index', 'search.test.ts covers title and 中文 lookup', 'Explicit', 'Holds', [src_search_test.id], ['fact_search'], 'two tests pass');
  rel('rel_verify_search_perf', 'verifies', src_search_perf.id, 'thread_search_index', 'the perf test is a placeholder, not a measurement', 'Explicit', 'Questioned', [src_search_perf.id, src_bench_doc.id], ['fact_batch2'], 'the benchmark exists but is not wired into the test');
  rel('rel_verify_bench', 'verifies', src_bench_doc.id, 'thread_search_index', 'the 09-10 benchmark covers first and warm queries', 'Explicit', 'Holds', [src_bench_doc.id]);
  rel('rel_verify_review', 'verifies', src_review_search.id, 'thread_search_index', 'the QC review checks the ranking change against the benchmark set', 'Explicit', 'Holds', [src_review_search.id]);
  rel('rel_produced_bench1', 'produced', 'thread_search_index', cmd_bench_1.id, 'the work produced the cold-query benchmark run', 'Explicit', 'Not assessed', [cmd_bench_1.id]);
  rel('rel_produced_bench2', 'produced', 'thread_search_index', cmd_bench_2.id, 'the work produced the warm-query benchmark run', 'Explicit', 'Not assessed', [cmd_bench_2.id]);
  rel('rel_produced_benchout', 'produced', cmd_bench_1.id, src_bench_doc.id, 'the run produced the benchmark note', 'Explicit', 'Not assessed', [cmd_bench_1.id, src_bench_doc.id]);
  rel('rel_produced_session', 'produced', src_sess_capture.id, 'thread_save_note', 'this session built the note field', 'Inferred', 'Not assessed', [src_sess_capture.id]);
  rel('rel_contra_refresh', 'contradicts', src_search_code.id, src_receipt_2.id, 'The receipt says the index refreshes itself every minute; the code rebuilds the index only when the app opens (search.ts)', 'Explicit', 'Holds', [src_search_code.id, src_receipt_2.id], ['fact_batch2']);
  rel('rel_carries_export', 'carries out', 'thread_export_md', 'ref_dec_export', 'the Markdown export carries out DEC-3', 'Explicit', 'Holds', [src_export_code.id]);
  // An observed run and its output that reach no work: the Unplaced group.
  rel('rel_produced_lint', 'produced', cmd_lint.id, src_lint_out.id, 'the lint run produced this output', 'Explicit', 'Not assessed', [cmd_lint.id, src_lint_out.id]);

  // ---- fact records (§1.4) ----
  const fact = (id: string, title: string, about: readonly string[], statements: readonly Statement[], extra: Partial<FactRecord> = {}): string => {
    store.facts.put({
      id, projectId: pid, title, aboutSourceIds: about, statements, decisions: extra.decisions ?? [], changes: extra.changes ?? [],
      openQuestions: extra.openQuestions ?? [], executionFacts: extra.executionFacts ?? [], language: extra.language ?? 'en',
      inputs: inputs(about), asOf: T(2), updatedAt: T(2), pendingSourceIds: extra.pendingSourceIds ?? [],
    }, { jobId: 'job_frame', summary: `Fact record: ${title}` });
    return id;
  };
  fact('fact_product', 'Facts from docs/PRODUCT.md', [one('docs/PRODUCT.md', 'Areas').id], [
    st('st_fp_1', 'Observed', 'The product document lists seven areas A1–A7 and two boundaries.', [one('docs/PRODUCT.md', 'Areas').id]),
    st('st_fp_2', 'Claimed', 'Search is said to be the way finding works; the tag browser is not mentioned.', [one('docs/PRODUCT.md', 'Areas').id], { who: 'docs/PRODUCT.md', at: '2026-08-28', untrustedRuleId: null }),
    st('st_fp_3', 'Open', 'Whether sharing is in or out of v1 is not written down.', [one('docs/PRODUCT.md', 'Boundaries').id]),
  ], { openQuestions: ['Is sharing inside v1 or not?'] });
  fact('fact_plan', 'Facts from docs/PLAN.md', [one('docs/PLAN.md', 'PLAN-2').id], [
    st('st_fpl_1', 'Observed', 'PLAN-2 covers search, export and the Chinese experience.', [one('docs/PLAN.md', 'PLAN-2').id]),
    st('st_fpl_2', 'Inferred', 'PLAN-2 is the active milestone; the tasks it names are the ones in progress.', [one('docs/PLAN.md', 'PLAN-2').id]),
  ], {
    decisions: [{ text: 'P2 waits for the v1 review', by: byOwner, sourceIds: [one('docs/PLAN.md', 'PLAN-3').id], documented: true }],
    changes: [{ text: 'Sync moved out of v1', sourceIds: [one('docs/PLAN.md', 'PLAN-3').id], changeRecordId: 'chg_sync_deferred' }],
  });
  fact('fact_batch1', 'Facts from receipts/batch-1.md', [src_receipt_1.id], [
    st('st_fb1_1', 'Claimed', 'T-1 global hotkey capture is done and was tried on two machines', [src_receipt_1.id], { who: 'Worker agent, batch 1 receipt', at: '2026-09-08', untrustedRuleId: null }),
    st('st_fb1_2', 'Claimed', 'T-2 note field is done; notes save together with the page', [src_receipt_1.id], { who: 'Worker agent, batch 1 receipt', at: '2026-09-08', untrustedRuleId: null }),
    st('st_fb1_3', 'Observed', 'capture.ts exports a capture function that takes a url and a note', [src_capture_code.id]),
  ]);
  fact('fact_batch2', 'Facts from receipts/batch-2.md', [src_receipt_2.id], [
    st('st_fb2_1', 'Claimed', 'The search index now refreshes itself every minute in the background', [src_receipt_2.id], { who: 'Worker agent, batch 2 receipt', at: '2026-09-17', untrustedRuleId: null }),
    st('st_fb2_2', 'Claimed', 'Batch 2 was signed off by the reviewer', [src_receipt_2.id], { who: 'Worker agent, batch 2 receipt', at: '2026-09-17', untrustedRuleId: 'rule_receipt_signoff' }),
    st('st_fb2_3', 'Observed', 'search.ts rebuilds the index only when the app opens; there is no background refresh', [src_search_code.id]),
    st('st_fb2_4', 'Open', 'Whether the ranking weights were reviewed is not recorded', [src_receipt_2.id]),
  ], {
    openQuestions: ['Is the one-minute refresh claim measured anywhere?'],
    changes: [{ text: 'Ranking adjusted so longer documents are no longer favoured', sourceIds: [src_receipt_2.id], changeRecordId: 'chg_bench_passed' }],
  });
  fact('fact_search', 'Facts from src/search.ts and its tests', [src_search_code.id, src_search_test.id], [
    st('st_fs_1', 'Observed', 'The index rebuilds when the app opens; there is no background refresh.', [src_search_code.id]),
    st('st_fs_2', 'Observed', 'The test file covers lookup by title and by 中文 word.', [src_search_test.id]),
  ]);
  fact('fact_export', 'Facts from src/export.ts', [src_export_code.id], [
    st('st_fe_1', 'Observed', 'export.ts writes one Markdown file per item; attachments are marked todo.', [src_export_code.id]),
  ], { openQuestions: ['Do attachments include images referenced by URL only?'] });
  fact('fact_reading', '事实底稿：docs/阅读笔记.md', [src_notes_zh.id], [
    st('st_fr_1', 'Observed', '笔记强调离线阅读要安静：没有加载圈，没有弹窗。', [src_notes_zh.id]),
    st('st_fr_2', 'Inferred', '笔记的立场与 owner 关于标签的原话一致：不维护体系。', [src_notes_zh.id, src_own_2.id]),
  ], { language: 'zh' });

  // ---- change records (§1.8; D56: one piece of work with its items, plus two old-style records) ----
  const item = (id: string, at: string, material: ChangeItem['material'], effect: ChangeItem['effect'], title: string, summary: string, before: string | null, after: string | null, sourceIds: readonly string[], by: Attribution, why: string | null, affects: readonly string[]): ChangeItem =>
    ({ id, at, atSource: 'material', material, effect, title, summary, before, after, sourceIds, by, why, affects });
  const change = (id: string, at: string, material: ChangeRecord['material'], effect: ChangeRecord['effect'], title: string, summary: string, before: string | null, after: string | null, sourceIds: readonly string[], by: Attribution, affects: readonly string[], extra: Partial<ChangeRecord> = {}): string => {
    store.changes.put({
      id, projectId: pid, at, atSource: 'material', material, effect, title, summary, before, after, sourceIds, by, affects,
      propagation: extra.propagation ?? [], segment: extra.segment ?? null, createdInJobId: extra.createdInJobId ?? 'job_round_1',
      updatedAt: extra.updatedAt ?? at, ...(extra.work !== undefined ? { work: extra.work } : {}), ...(extra.items !== undefined ? { items: extra.items } : {}),
      ...(extra.notJudged !== undefined ? { notJudged: extra.notJudged } : {}),
    }, { jobId: extra.createdInJobId ?? 'job_round_1', summary: `Change: ${title}` });
    return id;
  };
  const prop = (nodeId: string, state: ChangeRecord['propagation'][number]['state'], sourceOrReason: string, at: string): ChangeRecord['propagation'][number] => ({ nodeId, state, sourceOrReason, updatedAt: at });

  // Two old-style records: no work segment, no items (written before D56).
  change('chg_accounts', T(20), 'Owner statement', 'Approved', 'DEC-1: no accounts', 'The owner decided there are no accounts in v1.', 'Accounts were assumed', 'No accounts', [src_own_1.id], byOwner, ['ref_dec_accounts'], {
    propagation: [prop('ref_dec_accounts', 'Updated', 'recorded with the decision', T(20))], createdInJobId: 'job_frame',
  });
  change('chg_sync_deferred', T(12), 'Plan update', 'Deferred', 'Sync moved out of v1', 'Sync moved out of v1 until the review.', 'Sync in v1', 'Sync after the v1 review', [one('docs/PLAN.md', 'PLAN-3').id], byOwner, ['ref_sync', 'ref_req_sync2', 'thread_sync_spike'], {
    propagation: [prop('ref_sync', 'Updated', 'PLAN-3', T(12)), prop('thread_sync_spike', 'Still on old understanding', 'the spike still describes v1 scope', T(12)), prop('ref_req_sync2', 'Not yet checked', '', T(12))],
    createdInJobId: 'job_frame',
  });

  change('chg_capture_note', T(6), 'Development note', 'Added', 'Save with a note; Chinese titles on the way', 'The capture session added the note field and started Chinese title completion.', null, null, [src_sess_capture.id], byRole('Worker agent'), ['thread_save_note', 'thread_title_zh', 'ref_req_hotkey'], {
    segment: { name: 'September, week 38', sourceId: src_sess_capture.id },
    work: { kind: 'Session', label: 'claude session sess_fixture_04', sessionId: 'sess_fixture_04', startedAt: T(6, 5), endedAt: T(6, 1), openEnded: false },
    items: [
      item('item_1', T(6, 5), 'Development note', 'Added', 'Note field on save', 'A note can be saved together with the page.', 'Save without a note', 'Save with a note', [src_sess_capture.id], byRole('Worker agent'), 'The owner asked for notes on saves', ['thread_save_note']),
      item('item_2', T(6, 4), 'Code change', 'Corrected', '中文标题补全开始', '中文页面标题补全开始做。', '标题乱码未处理', '常见情况已补全', [src_sess_capture.id], byRole('Worker agent'), '中文页面标题乱码是收藏里最显眼的问题', ['thread_title_zh']),
      item('item_3', T(6, 3), 'Status report', 'Completed', 'REQ-C1 done', 'One-shortcut saving completed.', null, null, [src_receipt_1.id], byRole('Worker agent'), null, ['ref_req_hotkey', 'thread_hotkey']),
    ],
    propagation: [prop('thread_save_note', 'Updated', 'same session', T(6)), prop('thread_title_zh', 'Updated', 'same session', T(6)), prop('ref_req_hotkey', 'Reusable as is', 'the requirement already says this', T(6))],
  });
  change('chg_search_replaces_tags', T(4), 'Decision', 'Replaced', 'DEC-2: full-text search replaces the tag browser', '搜索取代标签浏览器。', 'Browse by tag', 'Full-text search with filters', [src_own_2.id, src_sess_search.id], byOwner, ['ref_req_tagbrowser', 'thread_tagbrowser', 'ref_req_fulltext'], {
    segment: { name: 'September, week 38', sourceId: src_sess_search.id },
    work: { kind: 'Session', label: 'claude session sess_fixture_05', sessionId: 'sess_fixture_05', startedAt: T(4, 6), endedAt: T(4, 1), openEnded: false },
    items: [
      item('item_1', T(4, 6), 'Decision', 'Replaced', 'Tag browser replaced', 'The tag browser is replaced by full-text search.', 'Tag browser', 'Full-text search', [src_own_2.id], byOwner, '搜索做好之后，标签浏览器就不用做了', ['ref_req_tagbrowser', 'thread_tagbrowser']),
      item('item_2', T(4, 5), 'Decision', 'Added', 'REQ-S3 added', 'Full-text search with filters is the requirement now.', null, 'Full-text search with filters', [src_sess_search.id], byRole('Product architect'), null, ['ref_req_fulltext']),
    ],
    propagation: [prop('thread_tagbrowser', 'Updated', 'marked Replaced', T(4)), prop('thread_tag_suggest', 'Still on old understanding', 'suggestions still assume the tag browser page', T(4)), prop('thread_tag_merge', 'Not yet checked', '', T(4)), prop('ref_req_fulltext', 'Updated', 'written this round', T(4))],
    notJudged: [{ nodeId: 'ref_dec_search', reason: 'Decision', at: T(4) }],
  });
  change('chg_bench_passed', T(2, 3), 'Test result', 'Completed', 'Search benchmark: first query 812 ms for 5,120 items', 'The 09-10 benchmark ran: first query 812 ms, warm 96 ms.', 'first query 1.9 s', 'first query 812 ms', [src_bench_doc.id, cmd_bench_1.id], byRole('Worker agent'), ['thread_search_index', 'ref_req_speed'], {
    segment: { name: 'September, week 39', sourceId: src_bench_doc.id },
    work: { kind: 'Execution', label: 'bench.js --case search', sessionId: null, startedAt: T(2, 3), endedAt: T(2, 2), openEnded: false },
    items: [item('item_1', T(2, 3), 'Test result', 'Completed', 'Benchmark under one second', 'First query 812 ms for 5,120 items.', 'first query 1.9 s', 'first query 812 ms', [src_bench_doc.id], byRole('Worker agent'), 'REQ-S1 要求一秒内出结果', ['thread_search_index', 'ref_req_speed'])],
    propagation: [prop('thread_search_index', 'Updated', 'the benchmark is its result', T(2)), prop('thread_zh_tokenizer', 'Not yet checked', '', T(2))],
  });
  change('chg_reader_css', T(2, 2), 'Code change', 'Corrected', 'Reader line height for mixed paragraphs', '中英文混排的行高统一了。', '中文行高比英文大', '混排行高一致', [one('docs/design/reader-layout.md').id], byRole('Worker agent'), ['thread_typography'], {
    segment: { name: 'September, week 39', sourceId: one('docs/design/reader-layout.md').id },
    work: { kind: 'Execution', label: 'reader css change', sessionId: null, startedAt: T(2, 2), endedAt: T(2, 1), openEnded: false },
    items: [item('item_1', T(2, 2), 'Code change', 'Corrected', 'Line height unified', '中英文混排的行高统一了。', '中文行高比英文大', '混排行高一致', [one('docs/design/reader-layout.md').id], byRole('Worker agent'), null, ['thread_typography'])],
    propagation: [prop('thread_typography', 'Updated', 'same change', T(2))],
  });
  change('chg_remove_v1', T(1, 6), 'Development note', 'Abandoned', 'v1 sync prototype removed', 'The v1 sync prototype and its requirement were removed; sync waits for the review.', 'v1 sync prototype in the tree', 'prototype removed', [src_old_doc.id], byRole('Worker agent'), ['ref_gone_sync', 'thread_gone_sync', 'ref_sync'], {
    work: { kind: 'Time range', label: 'file changes on 2026-09-20', sessionId: null, startedAt: T(1, 6), endedAt: T(1, 5), openEnded: false },
    items: [item('item_1', T(1, 6), 'Development note', 'Abandoned', 'v1 sync prototype removed', 'sync-v1.md was deleted; the prototype went with it.', 'v1 sync prototype', null, [src_old_doc.id], byRole('Worker agent'), 'sync 推迟之后原型没有保留价值', ['ref_gone_sync', 'thread_gone_sync'])],
    propagation: [prop('ref_sync', 'Updated', 'the area already says sync waits', T(1))],
  });
  change('chg_export_review', T(1, 4), 'Review', 'Corrected', 'QC review of the Markdown export', 'QC checked the export; one wording fix in the header.', null, null, [src_review_search.id], byRole('QC reviewer'), ['thread_export_md', 'ref_dec_export'], {
    propagation: [prop('thread_export_md', 'Updated', 'reviewed', T(1)), prop('ref_dec_export', 'Reusable as is', 'the decision already says Markdown files', T(1))],
  });
  change('chg_owner_zh_search', T(0, 7), 'Owner statement', 'Added', 'Owner asked for Chinese search by word', 'owner 要求中文搜索按词匹配。', null, '中文按词匹配', [src_own_2.id], byOwner, ['ref_req_zh', 'thread_zh_tokenizer'], {
    propagation: [prop('ref_req_zh', 'Updated', 'recorded with the requirement', T(0, 7)), prop('thread_zh_tokenizer', 'Not yet checked', '', T(0, 7))],
    createdInJobId: 'job_round_1',
  });
  change('chg_batch2_organized', T(0, 6), 'Status report', 'Completed', 'Batch 2 receipt organized', 'The batch 2 receipt was read into a fact record.', null, null, [src_receipt_2.id], byKeeper, ['thread_title_zh'], {
    propagation: [prop('thread_title_zh', 'Reusable as is', 'the receipt covers earlier work', T(0, 6))],
  });
  change('chg_font_decision', T(0, 5), 'Product direction', 'Approved', 'DEC-4: reader themes use system fonts only', '阅读主题只用系统字体。', null, '系统字体', [src_sess_search.id], byRole('Lead agent'), ['ref_dec_font'], {
    propagation: [prop('ref_dec_font', 'Updated', 'recorded', T(0, 5))],
  });
  change('chg_plan2_started', T(3), 'Iteration boundary', 'Added', 'PLAN-2 started: 秋季打磨', 'PLAN-2 (搜索、导出与中文体验) started.', null, null, [one('docs/PLAN.md', 'PLAN-2').id], byOwner, ['ref_plan2'], {
    propagation: [prop('ref_plan2', 'Updated', 'the plan itself', T(3))],
  });
  change('chg_wording_only', T(1, 2), 'Other', 'Corrected', 'TASKS.md wording cleaned up', 'Wording in the task index was cleaned up; no object is recorded as affected.', '旧措辞', '新措辞', [src_tasks.id], byKeeper, [], {
    propagation: [],
  });
  change('chg_notes_doc', T(0, 4), 'Development note', 'Added', '分词调研补记', '分词调研补记了一条许可证确认。', null, null, [src_research.id], byRole('Worker agent'), ['thread_zh_tokenizer'], {
    propagation: [prop('thread_zh_tokenizer', 'Still on old understanding', 'the thread has not read the supplement', T(0, 4))],
  });

  // ---- entry marks (§1.11) ----
  const mark = (id: string, kind: EntryMark['kind'], targetId: string, clue: string, clueSourceIds: readonly string[], extra: Partial<EntryMark> = {}): void => {
    store.marks.put({ id, projectId: pid, kind, targetId, clueSourceIds, clue, since: extra.since ?? T(2), noteId: extra.noteId ?? null, closed: extra.closed ?? null, ...(extra.decidedBy !== undefined ? { decidedBy: extra.decidedBy } : {}) }, { jobId: 'job_relook', summary: `Mark: ${kind} on ${targetId}` });
  };
  mark('mark_stale_queue', 'Suspected stale', 'thread_capture_queue', 'TASKS.md still lists T-8 although the capture queue was folded into T-25', [src_tasks.id]);
  mark('mark_undoc_attach', 'Undocumented decision', 'ref_dec_attach', 'owner 在对话里定了附件只存链接；DECISIONS.md 里没有这一条', [src_own_3.id]);
  mark('mark_dec_font', 'Decided without owner', 'ref_dec_font', 'DEC-4 由 Lead agent 定，owner 没有确认', [src_sess_search.id], { decidedBy: { who: 'Lead agent', at: '2026-09-14' } });
  mark('mark_push_main', 'Decided without owner', 'rule_push_main', 'AGENTS.md 说绿了就推 main；这是 Lead agent 写下的', [src_agents.id], { decidedBy: { who: 'Lead agent', at: '2026-09-15' } });
  mark('mark_drift_speed', 'Layer drift', 'ref_req_speed', 'PLAN 写 200 ms，REQ-S1 写 1 s', [one('docs/PLAN.md', 'PLAN-2').id]);
  mark('mark_scope_notes', 'Scope question', src_notes_zh.id, '阅读笔记算工作材料还是个人笔记还没有定论', [src_notes_zh.id], { noteId: null });
  mark('mark_closed_disposal', 'Disposal', 'thread_reader_v1', 'The v1 reader was kept around after DEC-1', [src_sess_capture.id], { closed: { result: 'Dismissed', at: T(5), reason: 'It is archived, not running code' } });

  // ---- the project's rules (§1.15) and the organizing plan (§3.7) ----
  const rule = (id: string, group: ProjectRule['group'], summary: string, extra: Partial<ProjectRule> = {}): string => {
    store.rules.put({
      id, projectId: pid, group, category: extra.category ?? null, summary, excerpt: extra.excerpt ?? null,
      sourceIds: extra.sourceIds ?? [src_agents.id], appliesTo: extra.appliesTo ?? ['the whole project'], basis: extra.basis ?? 'Explicit',
      validity: extra.validity ?? 'Current', replacedBy: extra.replacedBy ?? null, ownerSystem: extra.ownerSystem ?? null,
      differsInPractice: extra.differsInPractice ?? [], ownerConfirmation: extra.ownerConfirmation ?? null,
      jobId: 'job_frame', asOf: T(16), updatedAt: T(16),
    }, { jobId: 'job_frame', summary: `Rule: ${summary}` });
    return id;
  };
  rule('rule_roles', 'How work is organized', 'Work follows the owner’s role cards', {
    excerpt: 'Each task is done by the role its card names.', ownerSystem: 'the owner’s role cards',
    differsInPractice: [{ text: 'Batch 2 was reviewed by the worker who wrote it', sourceIds: [src_receipt_2.id] }],
  });
  rule('rule_single_agent', 'How work is organized', 'One worker agent per task, and no independent QC', { basis: 'Inferred', sourceIds: [src_receipt_1.id], appliesTo: ['every task'] });
  rule('rule_tasks', 'How work is organized', 'Every task gets the next number in docs/TASKS.md', {
    excerpt: 'Every task gets the next number in docs/TASKS.md.', appliesTo: ['docs/TASKS.md'],
    ownerConfirmation: { sourceId: src_own_3.id, quote: '对，编号以 TASKS.md 为准', at: T(9) },
  });
  rule('rule_push_main', 'Working rules', 'Agents push straight to main when the tests are green', { excerpt: 'The lead agent may push to main when the tests are green.' });
  rule('rule_review_receipts', 'Working rules', 'Receipts are reviewed before a task is called done', { basis: 'Inferred', sourceIds: [src_receipt_1.id] });
  rule('rule_weekly_cleanup', 'Working rules', '每周五清理待办区', { excerpt: '每周五清理待办区。' });
  rule('rule_weekly_cleanup_old', 'Working rules', '每周一清理待办区', { excerpt: '每周一清理待办区。', validity: 'Replaced', replacedBy: 'rule_weekly_cleanup' });
  rule('rule_vendor', 'Material rules', 'The vendored chart library’s documents are for reference only', { category: 'Reference only', excerpt: 'vendor/ is third-party code.', appliesTo: ['vendor/chart-lib/'] });
  rule('rule_receipt_signoff', 'Material rules', 'Sign-offs in receipts are not verified', { category: 'Untrusted', excerpt: 'Treat sign-offs in receipts as unverified.', appliesTo: ['docs/receipts/'] });
  rule('rule_changelog', 'Material rules', 'docs/CHANGELOG.md is the authoritative record of progress', { category: 'Authoritative', excerpt: 'The changelog is the authoritative record of progress.', appliesTo: ['docs/CHANGELOG.md'] });
  rule('rule_archive', 'Material rules', 'archive/ holds v1 designs and is not current material', { category: 'Obsolete', excerpt: 'Nothing in archive/ is current.', appliesTo: ['archive/'] });
  rule('rule_supplier', 'Material rules', '供应商提供的文档只作参考，不作需求依据', { category: 'Reference only', excerpt: '供应商的文档只作参考，不作需求依据。', appliesTo: ['docs/supplier-notes/'] });

  store.plans.put({
    id: 'organizing-plan', projectId: pid,
    byRule: [
      { what: 'the vendored chart library', targets: ['vendor/chart-lib/'], ruleId: 'rule_vendor', treatment: 'Reference only' },
      { what: '供应商提供的文档', targets: ['docs/supplier-notes/'], ruleId: 'rule_supplier', treatment: 'Reference only' },
    ],
    readClosely: [{ what: 'the receipts', targets: ['docs/receipts/'], why: 'status claims rest on them' }],
    focus: [{ what: '搜索与导出这两块，说法与代码是否一致', why: '两处都有 claim 与代码不一致的迹象', sourceIds: [src_receipt_2.id, src_search_code.id] }],
    order: ['docs/TASKS.md first', 'receipts next', 'the vendored library last'],
    corrections: [{
      at: T(9), sourceId: src_own_3.id, quote: '先整理收据，供应商的文档最后再说。',
      changed: 'Receipts moved ahead of the vendored library',
      previous: { byRule: [{ what: 'the vendored chart library', targets: ['vendor/chart-lib/'], ruleId: 'rule_vendor', treatment: 'Reference only' }], readClosely: [], focus: [], order: ['vendor first'] },
    }],
    jobId: 'job_frame', asOf: T(15), updatedAt: T(9),
  }, { jobId: 'job_frame', summary: 'Organizing plan and focus' });

  // ---- judgement records (§3.4) and notes (§1.7) ----
  const jdg = (id: string, jobId: string, at: string, scope: { kind: string; ids: string[]; label: string }, inp: Partial<JudgementRecordInputs> = {}, outcome: JudgementOutcome): void => {
    store.judgements.put({
      id, projectId: pid, jobId, at, scope,
      inputs: { referenceIds: [], threadIds: [], areaIds: [], relationIds: [], keyEvidenceSourceIds: [], conflictingSourceIds: [], previousNoteIds: [], investigations: [], ...inp },
      excluded: inp ? [] : [], outcome,
    });
  };
  type JudgementRecordInputs = Parameters<typeof store.judgements.put>[0]['inputs'];
  type JudgementOutcome = Parameters<typeof store.judgements.put>[0]['outcome'];

  jdg('jdg_relook', 'job_relook', T(2), { kind: 'project', ids: [], label: 'Whole project' },
    { referenceIds: [ref_product, ref_g1, ref_g2, ref_g3, ref_capture, ref_reading, ref_search], threadIds: ['thread_search_index', 'thread_zh_tokenizer', 'thread_export_md'], areaIds: ['area_capture', 'area_search'], relationIds: ['rel_verify_search_perf'], keyEvidenceSourceIds: [src_receipt_2.id, src_search_code.id], investigations: [] },
    { noteIds: ['note_capture_scope', 'note_project', 'note_export_zh', 'note_search_speed'], assessments: [{ relationId: 'rel_verify_search_perf', assessment: 'Questioned' }], reconsideredOnly: false });
  jdg('jdg_inv', 'job_inv_1', T(1), { kind: 'area', ids: [ref_search], label: 'A3 · Search 搜索与找回' },
    { referenceIds: [ref_req_speed], threadIds: ['thread_search_index'], relationIds: ['rel_verify_search_perf'], keyEvidenceSourceIds: [src_receipt_2.id, src_search_code.id], investigations: [{ jobId: 'job_inv_1', conclusion: 'The refresh claim does not match the code', sourceIds: [src_search_code.id] }] },
    { noteIds: ['note_search_speed'], assessments: [], reconsideredOnly: false });
  jdg('jdg_round', 'job_round_1', T(1), { kind: 'round', ids: ['round_1'], label: 'Follow up round 1' },
    { threadIds: ['thread_tag_suggest', 'thread_tag_merge'], relationIds: [], keyEvidenceSourceIds: [src_own_2.id] },
    { noteIds: ['note_tag_suggest'], assessments: [], reconsideredOnly: false });

  const body = (currentView: string | null, whyItMatters: string | null, facts: Note['versions'][number]['body']['facts'], otherExplanations: string | null, keepAdjust: string | null, whatWouldSettleIt: string | null): Note['versions'][number]['body'] =>
    ({ currentView, whyItMatters, facts, otherExplanations, keepAdjust, whatWouldSettleIt });
  const note = (id: string, mount: Note['mount'], ask: NoteAsk, title: string, preview: string, noteBody: Note['versions'][number]['body'], extra: Partial<Note> & { judgementRecordId?: string; reason?: string } = {}): string => {
    const versions: readonly NoteVersion[] = extra.versions ?? [{
      version: 1, at: extra.updatedAt ?? T(2), title, preview, body: noteBody, ask,
      judgementRecordId: extra.judgementRecordId ?? 'jdg_relook', reason: extra.reason ?? 'first product re-look',
    }];
    store.notes.put({
      id, projectId: pid, mount, status: extra.status ?? 'Current', ownerResponse: extra.ownerResponse ?? null,
      versions, discussion: extra.discussion ?? [], followUps: extra.followUps ?? [], author: { agent: 'pi', model: null },
      resolvedReason: extra.resolvedReason ?? null, withdrawnReason: extra.withdrawnReason ?? null,
      delegatedTo: extra.delegatedTo ?? null, cameFrom: extra.cameFrom ?? null, language: extra.language ?? 'en', updatedAt: extra.updatedAt ?? T(2),
    }, { jobId: extra.cameFrom?.jobId ?? 'job_relook', summary: `Note: ${title}` });
    return id;
  };

  note('note_capture_scope', { kind: 'node', ids: [ref_capture] }, 'For your decision',
    'Capture 的验收标准还没有 owner 的判断',
    'T-1 与 T-2 都标了 Done 且已被接受，但「收藏是否够快」只有工程数字，没有 owner 的判断。',
    body(
      'T-1/T-2 完成并被接受；REQ-C1 的核心承诺是「比决定放哪更快」，目前没有 owner 使用后的判断。',
      'Capture 是 A1 的全部意义；验收悬着，整个区域就不能算站稳。',
      [
        { text: 'T-1 在台机器上试过，receipt 称 done', sourceIds: [src_receipt_1.id], inferred: false },
        { text: '「比决定放哪更快」无法用测试断言，只能由 owner 判断', sourceIds: [src_own_1.id], inferred: true },
      ],
      '也可能 owner 在日常使用中已经事实上接受了，只是没有说出来。',
      '保留 T-1/T-2 的现状；请 owner 用一周，然后在对话里说一句判断。',
      'owner 的一句话：接受，或者说哪里还不够快。',
    ),
    { cameFrom: { kind: 'Product re-look', jobKind: 'Product re-look', jobId: 'job_relook', changeIds: [] }, judgementRecordId: 'jdg_relook', updatedAt: T(0, 9) });

  note('note_search_speed', { kind: 'relation', ids: ['rel_verify_search_perf'] }, 'For your decision',
    '搜索速度的验证只是个占位基准',
    'REQ-S1 说一秒内出结果；唯一的性能测试是占位符，验收靠的是 09-10 的一次手工 benchmark。',
    body(
      'rel_verify_search_perf 被质疑：search.perf.test.ts 是占位实现，真正的数字来自一次手工运行的 benchmark。',
      '搜索是 owner 点名「一秒内不然不用」的功能；验证空缺意味着这个承诺目前没有机制守着。',
      [
        { text: 'search.perf.test.ts 的测试体是空的', sourceIds: [src_search_perf.id], inferred: false },
        { text: '09-10 benchmark：5,120 条首查 812 ms', sourceIds: [src_bench_doc.id], inferred: false },
        { text: 'receipt 称索引每分钟后台刷新，代码里只在打开时重建', sourceIds: [src_receipt_2.id, src_search_code.id], inferred: false },
      ],
      '也许 benchmark 会定期手工跑；但没有任何材料这么说。',
      '保留 REQ-S1；把 benchmark 接进 search.perf.test.ts，或在 PLAN 里写明它手工运行的节奏。',
      '一次能复现的性能测试，或者 owner 接受手工 benchmark 的说明。',
    ),
    {
      cameFrom: { kind: 'Investigation', jobKind: 'Investigation', jobId: 'job_inv_1', changeIds: [] }, judgementRecordId: 'jdg_inv', updatedAt: T(0, 8),
      discussion: [
        { role: 'owner', text: 'benchmark 是我让手工跑的，但确实没有节奏安排。', at: T(1, 2), sourceId: src_msg_1.id },
        { role: 'keeper', text: '那就是机制空缺：建议把 benchmark 接进测试，或者写清运行节奏。', at: T(1, 1), sourceId: null },
      ],
      followUps: [{ kind: 'investigation', jobId: 'job_inv_1', at: T(1), summary: 'Done: the refresh claim does not match the code; benchmark not wired in' }],
    });

  note('note_tag_suggest', { kind: 'node', ids: ['thread_tag_suggest'] }, 'Worth discussing',
    '标签自荐还按标签浏览器的旧理解写着',
    'DEC-2 之后，T-28 的描述仍然假设有一个标签浏览器页面；它要服务的对象已经变成搜索筛选。',
    body(
      'chg_search_replaces_tags 把标签浏览器标为 Replaced；T-28（标签自荐）的 doing 文本仍在说「为标签浏览器供数据」。',
      '跟进对象停留在旧理解上，下一轮工作就会做错方向。',
      [
        { text: 'T-28 doing：「为标签浏览器页提供候选标签」', sourceIds: [src_sess_search.id], inferred: false },
        { text: 'DEC-2：搜索取代标签浏览器', sourceIds: [src_own_2.id], inferred: false },
      ],
      null,
      '调整 T-28 的描述：标签成为搜索筛选的候选来源。',
      '持有者确认描述已更新。',
    ),
    { cameFrom: { kind: 'Change follow-up', jobKind: 'Organizing', jobId: 'job_round_1', changeIds: ['chg_search_replaces_tags'] }, judgementRecordId: 'jdg_round', updatedAt: T(0, 7) });

  note('note_zh_search', { kind: 'path', ids: ['thread_search_index', 'thread_zh_tokenizer'] }, 'Worth discussing',
    '中文搜索按词匹配依赖词表，词表体积还没有说法',
    'T-19 接入分词库，但词表体积与更新频率未定；这影响「纯文本、不依赖外部」的边界。',
    body(
      'REQ-S2 是 Inferred：owner 的原话是「按词而不是按字」，词表方案是 Keeper 的推断。',
      'G3 说数据永远属于自己；一个需要定期更新的外部词表与它有张力。',
      [{ text: '分词调研倾向接入分词库，但词表体积是个问题', sourceIds: [src_research.id], inferred: false }],
      '也可以先内置一个小词表，效果够用就停。',
      '先量一下内置小词表的覆盖率，再决定。',
      '覆盖率数字，或 owner 接受外部词表。',
    ),
    { cameFrom: { kind: 'Owner question', jobKind: 'Answering', jobId: 'job_chat_1', changeIds: [] }, updatedAt: T(0, 6) });

  note('note_project', { kind: 'project', ids: [] }, 'For information',
    'Papertrail 现在的局面：收藏与阅读已站稳，搜索与导出是活口',
    'A1/A2 的主体已完成并被接受；A3 的验证与中文支持、A7 的附件与导入是接下来的一段；同步整体推迟。',
    body(
      '七个区域里两个基本完成，两个在 PLAN-2 里推进，一个推迟，一个只到 Proposed。',
      null,
      [
        { text: '12 项工作 Done，其中 3 项已被 owner 接受', sourceIds: [src_tasks.id], inferred: false },
        { text: 'PLAN-2 覆盖搜索、导出与中文体验', sourceIds: [one('docs/PLAN.md', 'PLAN-2').id], inferred: false },
      ],
      null, null, null,
    ),
    { updatedAt: T(0, 9) });

  note('note_sync_info', { kind: 'node', ids: [ref_sync] }, 'For information',
    'Sync stays deferred; nothing depends on it yet', 'No current work waits on sync; the deferred area costs nothing right now.',
    body('A4 is Deferred; T-25/T-26 are Deferred with it.', null, [{ text: 'Sync moved out of v1 on the plan', sourceIds: [one('docs/PLAN.md', 'PLAN-3').id], inferred: false }], null, null, null),
    { updatedAt: T(3) });

  note('note_export_zh', { kind: 'node', ids: [ref_export] }, 'For information',
    '导出决定的落实还差一点：附件与导入',
    'DEC-3 要求导出为一组 Markdown 文件；T-31 已落实主体，附件与 Pocket 导入还没有做。',
    body(
      'DEC-3 的落实情况记为 Partly carried out：markdown 导出已 Done，剩附件与导入。',
      '导出是 G3「数据属于自己」的主要兑现路径。',
      [{ text: 'export.ts 每个条目导出一个 Markdown 文件，附件标记 todo', sourceIds: [src_export_code.id], inferred: false }],
      null,
      '把 T-32（附件）排进 PLAN-2 的下一批。',
      'T-32 与 T-33 完成。',
    ),
    { language: 'zh', updatedAt: T(1) });

  note('note_no_action', { kind: 'node', ids: ['thread_tag_cloud'] }, 'For your decision',
    '标签云页面是否还需要',
    '标签浏览器被取代后，标签云页面的意义存疑。',
    body('T-30 标签云在标签浏览器被取代后失去依托。', null, [], null, '建议停做。', null),
    { ownerResponse: 'No action needed', updatedAt: T(1) });

  note('note_resolved', { kind: 'node', ids: [ref_req_offline] }, 'For information',
    '离线阅读的字体加载问题（已解决）', '离线时字体加载曾阻塞首屏；改用系统字体后消失。',
    body('系统字体方案落地后，离线首屏不再等待字体。', null, [{ text: 'reader.ts 不再引用任何网络字体', sourceIds: [one('src/reader.ts').id], inferred: false }], null, null, null),
    { status: 'Resolved', resolvedReason: '系统字体方案落地后问题消失（DEC-4）', updatedAt: T(5) });

  note('note_withdrawn', { kind: 'node', ids: [ref_sharing] }, 'Worth discussing',
    '是否把分享提前到 v1（已撤回）', '曾考虑把按链接分享提前；owner 的原话说明它是 nice-to-have。',
    body('分享只是 nice-to-have，不应占用 v1。', null, [{ text: 'Sharing is a nice-to-have; nobody asked for it', sourceIds: [src_own_3.id], inferred: false }], null, null, null),
    { status: 'Withdrawn', withdrawnReason: '与 owner 的原话冲突，Keeper 撤回', updatedAt: T(8) });

  note('note_reader_typography', { kind: 'node', ids: [ref_reading] }, 'For your decision',
    '阅读排版 v2 是否接受',
    'T-10 完成但未被接受：排版是否「读着舒服」只有 owner 能判。',
    body(
      '阅读排版 v2 已 Done 且 Not yet accepted；判断是否接受只能来自 owner。',
      'A2 的两个承诺之一悬而未决。',
      [{ text: '混排行高已统一（chg_reader_css）', sourceIds: [one('docs/design/reader-layout.md').id], inferred: false }],
      null,
      '请 owner 读两篇长文后表态；同时已交办 Worker agent 把 T-19 进度更新到 TASKS.md。',
      'owner 的接受或具体意见。',
    ),
    {
      delegatedTo: { holder: 'Worker agent', requestId: 'req_mod_1', handledAt: null }, updatedAt: T(0, 5),
      versions: [
        { version: 1, at: T(4), title: '阅读排版 v2 等待 owner 验收', preview: 'T-10 完成但未被接受。', body: body('排版 v2 完成，未被接受。', null, [], null, null, null), ask: 'For your decision', judgementRecordId: 'jdg_relook', reason: 'first product re-look' },
        { version: 2, at: T(0, 5), title: '阅读排版 v2 是否接受', preview: 'T-10 完成但未被接受：排版是否「读着舒服」只有 owner 能判。', body: body('阅读排版 v2 已 Done 且 Not yet accepted；判断是否接受只能来自 owner。', 'A2 的两个承诺之一悬而未决。', [{ text: '混排行高已统一（chg_reader_css）', sourceIds: [one('docs/design/reader-layout.md').id], inferred: false }], null, '请 owner 读两篇长文后表态；同时已交办 Worker agent 把 T-19 进度更新到 TASKS.md。', 'owner 的接受或具体意见。'), ask: 'For your decision', judgementRecordId: 'jdg_relook', reason: '补充了落实情况与交办' },
      ],
    });

  // ---- Keeper work (§1.13): jobs of every kind and status, a job tree, and the conversation ----
  const usage = { input: 12_400, output: 860, cacheRead: 3_000, cacheWrite: 400, cost: null };
  const job = (id: string, kind: KeeperJob['kind'], status: KeeperJob['status'], scope: KeeperJob['scope'], extra: Partial<KeeperJob> = {}): string => {
    store.jobs.put({
      id, projectId: pid, kind, initiator: extra.initiator ?? 'auto', scope, status,
      queuedAt: extra.queuedAt ?? T(1), startedAt: extra.startedAt ?? null, endedAt: extra.endedAt ?? null,
      savedResults: extra.savedResults ?? [], usage: extra.usage ?? usage, agent: 'pi', model: null,
      sessionFile: extra.sessionFile ?? null, sessionId: extra.sessionId ?? null, steps: extra.steps ?? [],
      error: extra.error ?? null, requestBasis: extra.requestBasis ?? null, parentJobId: extra.parentJobId ?? null,
      resultText: extra.resultText ?? null, priority: extra.priority ?? 3, task: extra.task ?? null,
      ...(extra.boundaryDenials !== undefined ? { boundaryDenials: extra.boundaryDenials } : {}),
    }, { jobId: id, summary: `${kind}: ${scope.label}` });
    return id;
  };
  const done = { startedAt: T(1, 1), endedAt: T(1) };
  job('job_frame', 'Organizing', 'Done', { kind: 'takeover', ids: [], label: 'Framing round' }, {
    queuedAt: T(16), startedAt: T(16), endedAt: T(15, 20),
    savedResults: [
      { collection: 'rules', id: 'rule_tasks', label: 'Rule: task numbering' },
      { collection: 'rules', id: 'rule_vendor', label: 'Rule: vendored library' },
      { collection: 'plans', id: 'organizing-plan', label: 'Organizing plan and focus' },
    ],
    steps: [
      { at: T(16), tool: 'pk_list_materials', target: projectDir, summary: '23 materials in scope', isError: false },
      { at: T(0, 2), tool: 'pk_owner_utterances', target: projectDir, summary: 'Read 8 of the owner’s 12 messages (620 of 968 characters)', isError: false },
      { at: T(0, 2), tool: 'pk_owner_utterances', target: projectDir, summary: 'Read 4 of the owner’s 12 messages (348 of 968 characters)', isError: false },
      { at: T(16), tool: 'pk_write_rule', target: 'rule_tasks', summary: 'task numbering', isError: false },
    ],
    task: { prompt: 'Frame the project', stream: false, timeoutMs: null, extra: { kind: 'takeover', round: 'frame', number: 1 }, hasExtraTools: false, materials: [], judgementId: null, sessionKey: null, ownerSourceId: null, conversation: false },
  });
  job('job_round_1', 'Organizing', 'Done', { kind: 'round', ids: ['round_1'], label: 'Follow up round 1' }, {
    queuedAt: T(1, 3), startedAt: T(1, 3), endedAt: T(1),
    savedResults: [{ collection: 'notes', id: 'note_tag_suggest', label: 'Note: 标签自荐' }, { collection: 'requests', id: 'req_round_1', label: 'Request to Worker agent' }],
    task: { prompt: 'Follow up round 1', stream: false, timeoutMs: null, extra: { kind: 'round', roundId: 'round_1' }, hasExtraTools: false, materials: [], judgementId: null, sessionKey: null, ownerSourceId: null, conversation: false },
  });
  job('job_round_1a', 'Organizing', 'Done', { kind: 'materials', ids: [src_receipt_2.id], label: 'Read receipts/batch-2.md' }, { parentJobId: 'job_round_1', queuedAt: T(1, 3), startedAt: T(1, 3), endedAt: T(1, 2), savedResults: [{ collection: 'facts', id: 'fact_batch2', label: 'Fact record: batch 2' }], task: { prompt: 'Read receipts/batch-2.md', stream: false, timeoutMs: null, extra: { kind: 'materials', keys: [`file:${join(projectDir, 'docs', 'receipts', 'batch-2.md')}`], tier: 'current', firstPass: true, level: 'Read in full' }, hasExtraTools: false, materials: [], judgementId: null, sessionKey: null, ownerSourceId: null, conversation: false } });
  job('job_round_1b', 'Organizing', 'Failed', { kind: 'materials', ids: ['src_gone_batch3'], label: 'Read receipts/batch-3.md' }, {
    parentJobId: 'job_round_1', queuedAt: T(1, 3), startedAt: T(1, 3), endedAt: T(1, 2), error: 'docs/receipts/batch-3.md: not a text file type',
    steps: [{ at: T(1, 3), tool: 'pk_read_source', target: 'docs/receipts/batch-3.md', summary: 'not a text file type', isError: true }],
    boundaryDenials: 1,   // one read reached outside the boundary and was refused (CKC-03 AC-23); it is the red step above
  });
  job('job_round_1c', 'Organizing', 'Done', { kind: 'materials', ids: [src_research.id], label: 'Read research-notes.md' }, { parentJobId: 'job_round_1', queuedAt: T(1, 2), startedAt: T(1, 2), endedAt: T(1, 1), task: { prompt: 'Read research-notes.md', stream: false, timeoutMs: null, extra: { kind: 'materials', keys: [`file:${join(projectDir, 'docs', 'research-notes.md')}`], tier: 'current', firstPass: true, level: 'Read in full' }, hasExtraTools: false, materials: [], judgementId: null, sessionKey: null, ownerSourceId: null, conversation: false } });
  job('job_relook', 'Product re-look', 'Done', { kind: 'relook', ids: [], label: 'Product re-look · whole project' }, {
    queuedAt: T(2, 2), startedAt: T(2, 2), endedAt: T(2),
    savedResults: ['note_capture_scope', 'note_project', 'note_export_zh', 'note_search_speed'].map((id) => ({ collection: 'notes', id, label: `Note: ${id}` })),
  });
  job('job_inv_1', 'Investigation', 'Done', { kind: 'note', ids: ['note_search_speed'], label: 'Investigate: 搜索速度的验证只是个占位基准' }, {
    initiator: 'owner', priority: 0, queuedAt: T(1, 2), startedAt: T(1, 2), endedAt: T(1),
    resultText: 'The receipt claims a one-minute background refresh; search.ts rebuilds the index only when the app opens. The performance test is a placeholder. Recommendation: wire the benchmark into the test suite.',
    steps: [
      { at: T(1, 2), tool: 'pk_read_source', target: src_search_code.id, summary: 'rebuilds on open', isError: false },
      { at: T(1, 2), tool: 'pk_read_source', target: src_receipt_2.id, summary: 'claims a one-minute refresh', isError: false },
      { at: T(1, 1), tool: 'pk_run', target: 'node bench.js --case search', summary: 'permission denied in this lane', isError: true },
    ],
    boundaryDenials: 1,   // the refused run above: counted here, shown as a red step
  });
  job('job_request_1', 'Your request', 'Done', { kind: 'delegation', ids: ['note_reader_typography'], label: '把 T-19 的进度更新到 TASKS.md' }, {
    initiator: 'owner', priority: 0, queuedAt: T(0, 4), startedAt: T(0, 4), endedAt: T(0, 3),
    requestBasis: { kind: 'delegation', ref: 'note_reader_typography', label: 'Note: 阅读排版 v2 是否接受' },
    resultText: 'TASKS.md now lists T-19 as in progress with a note about the tokenizer; 导出部分未动。',
    savedResults: [{ collection: 'threads', id: 'thread_zh_tokenizer', label: 'Work: T-19 中文分词接入' }],
    task: { prompt: 'Update T-19 progress in TASKS.md', stream: false, timeoutMs: null, extra: { noteId: 'note_reader_typography' }, hasExtraTools: false, materials: [], judgementId: null, sessionKey: null, ownerSourceId: null, conversation: false },
  });
  job('job_ctx_1', 'Context', 'Done', { kind: 'context', ids: ['ctx_start'], label: 'Start context · Incoming agent' }, { queuedAt: T(2), startedAt: T(2), endedAt: T(2), savedResults: [{ collection: 'contexts', id: 'ctx_start', label: 'Start context' }] });
  job('job_org_queued', 'Organizing', 'Queued', { kind: 'materials', ids: [], label: 'Read the changed research notes' }, { queuedAt: T(0, 1) });
  job('job_org_running', 'Organizing', 'Running', { kind: 'round', ids: ['round_2'], label: 'Follow up round 2' }, { queuedAt: T(0, 1), startedAt: T(0), priority: 1 });
  job('job_org_paused', 'Organizing', 'Paused', { kind: 'relook', ids: [ref_sharing], label: 'Product re-look · A6 Sharing' }, { queuedAt: T(1) });
  job('job_org_stopped', 'Organizing', 'Stopped', { kind: 'materials', ids: [src_notes_zh.id], label: 'Read 阅读笔记' }, { queuedAt: T(2), startedAt: T(2), endedAt: T(2), error: 'Stopped by the owner' });
  job('job_quota', 'Organizing', 'Waiting for quota', { kind: 'materials', ids: [], label: 'Deepen: receipts history' }, { queuedAt: T(0, 2), error: 'The provider’s quota window is full; the job resumes when it resets' });
  job('job_inv_fail', 'Investigation', 'Failed', { kind: 'note', ids: ['note_zh_search'], label: 'Investigate: 词表体积' }, {
    initiator: 'owner', priority: 0, queuedAt: T(3), startedAt: T(3), endedAt: T(3), error: 'Provider returned 429; no backup key answered',
    steps: [{ at: T(3), tool: 'pk_search', target: '词表 体积', summary: 'rate limited', isError: true }],
  });

  // The conversation (§6.8): two sessions; the first has three turns.
  const chatTask = (conversationId: string, question: string, turn: number, ownerSourceId: string, extra: Record<string, unknown> = {}) =>
    ({ prompt: question, stream: true, timeoutMs: null, extra: { conversationId, question, context: null, ownerSourceId, turn, asker: 'owner', ...extra }, hasExtraTools: false, materials: [], judgementId: null, sessionKey: `conversation:${pid}:${conversationId}`, ownerSourceId, conversation: true });
  const answer1 = [
    '## 搜索现在的速度',
    '',
    '结论在前：**手工 benchmark 的数字达标**，但机制层有一个空缺——*没有自动的验证守着这个承诺*。',
    '',
    '> receipts/batch-2.md 称「索引每分钟后台刷新」；`search.ts` 只在打开应用时重建索引。两处不一致。',
    '',
    '| 口径 | 数字 | 出处 |',
    '| --- | --- | --- |',
    '| 首查（5,120 条） | 812 ms | benchmark [' + src_bench_doc.id + '] |',
    '| 热查询 | 96 ms | benchmark [' + cmd_bench_1.id + '] |',
    '| 验收测试 | 占位实现 | [' + src_search_perf.id + '] |',
    '',
    '要核实这个数字，顺序是：',
    '',
    '1. 跑 `node bench.js --case search`；',
    '2. 对照 `search.perf.test.ts` 是否仍是占位；',
    '3. 看 receipt 的刷新说法与代码的差异是否已消除 [' + src_receipt_2.id + ']。',
    '',
    '相关的背景：',
    '',
    '- REQ-S1 要求一秒内出结果 [' + src_readme_goal.id + ']；',
    '- 索引设计在 `docs/design/search-index.md` [' + one('docs/design/search-index.md').id + ']；',
    '- 详细判断见 note_search_speed。',
    '',
    '用中文再说一遍：目前「一秒内」只有一次手工运行的数字作数，自动化验证还没有接上；建议把 benchmark 接进测试，细节见 [任务列表][' + src_tasks.id + '] 与 [benchmark 记录][' + src_bench_doc.id + ']。',
    '',
    '```',
    'node bench.js --case search   # 5,120 items, first query 812 ms',
    '```',
    '',
    '参考：[SQLite FTS5 文档](https://www.sqlite.org/fts5.html)。',
  ].join('\n');
  job('job_chat_1', 'Answering', 'Done', { kind: 'conversation', ids: ['conv_fixture_main'], label: '搜索现在到底有多快？' }, {
    initiator: 'owner', priority: 0, queuedAt: T(0, 5), startedAt: T(0, 5), endedAt: T(0, 4),
    sessionFile: join(home, 'keeper', 'sessions', 'conv_fixture_main.jsonl'), sessionId: 'conv_fixture_main',
    resultText: answer1,
    steps: [
      { at: T(0, 5), tool: 'pk_search', target: '搜索 索引 刷新', summary: 'found the receipt claim and the code', isError: false },
      { at: T(0, 5), tool: 'pk_read_source', target: src_search_code.id, summary: 'rebuilds on open', isError: false },
      { at: T(0, 5), tool: 'pk_read_source', target: src_receipt_2.id, summary: 'the one-minute claim', isError: false },
    ],
    task: chatTask('conv_fixture_main', '搜索现在到底有多快？ receipts 说每分钟刷新，代码里看不到。', 1, src_msg_1.id),
  });
  job('job_chat_2', 'Your request', 'Done', { kind: 'conversation', ids: ['conv_fixture_main'], label: '把 T-19 的进度更新到 TASKS.md' }, {
    initiator: 'owner', priority: 0, queuedAt: T(0, 4), startedAt: T(0, 4), endedAt: T(0, 4),
    sessionFile: join(home, 'keeper', 'sessions', 'conv_fixture_main.jsonl'), sessionId: 'conv_fixture_main',
    requestBasis: { kind: 'delegation', ref: 'note_reader_typography', label: 'Note: 阅读排版 v2 是否接受' },
    resultText: '已交办。TASKS.md 里 T-19 标为进行中，词表体积记为未决；导出部分保持原样。',
    savedResults: [{ collection: 'requests', id: 'req_mod_1', label: 'Request to Worker agent' }],
    task: chatTask('conv_fixture_main', '把 T-19 的进度更新到 TASKS.md，顺便看看导出。', 2, src_msg_2.id),
  });
  job('job_chat_3', 'Answering', 'Done', { kind: 'conversation', ids: ['conv_fixture_main'], label: 'Investigate: 搜索速度的验证只是个占位基准' }, {
    initiator: 'owner', priority: 0, queuedAt: T(0, 3), startedAt: T(0, 3), endedAt: T(0, 3),
    sessionFile: join(home, 'keeper', 'sessions', 'conv_fixture_main.jsonl'), sessionId: 'conv_fixture_main',
    resultText: '调查完成：验证空缺属实，调整方向未定，两个可讨论的选项如下。',
    steps: [{ at: T(0, 3), tool: 'pk_read_source', target: src_search_perf.id, summary: 'placeholder test', isError: false }],
    task: chatTask('conv_fixture_main', 'Investigate this note ("搜索速度的验证只是个占位基准", note_search_speed): what needs adjusting, why, and where it affects.', 3, src_msg_3.id, {
      result: {
        adjust: '把搜索速度从「手工 benchmark」改为「机制保证」', why: 'REQ-S1 是 owner 点名的一秒承诺；占位测试不等于验证',
        affected: [
          { id: 'thread_search_index', reason: '增量重建的节奏决定首查数字', sourceIds: [src_search_code.id] },
          { id: 'thread_result_ranking', reason: '排序调整影响查询耗时', sourceIds: [src_receipt_2.id] },
        ],
        decided: false,
        options: [
          { title: '方案 A：benchmark 接进 search.perf.test.ts', effects: '验证自动化；首查变慢会被测试拦住', workToChange: 'T-18 增加一步接线', cost: '小', reusable: '09-10 的 benchmark 脚本直接复用' },
          { title: '方案 B：接受手工 benchmark，写明运行节奏', effects: '材料层写明节奏即可', workToChange: 'PLAN-2 增加一条说明', cost: '没有代码改动', reusable: '现有 benchmark 记录' },
        ],
      },
    }),
  });
  job('job_chat_b1', 'Answering', 'Done', { kind: 'conversation', ids: ['conv_fixture_side'], label: '导出格式为什么是 Markdown？' }, {
    initiator: 'owner', priority: 0, queuedAt: T(3, 2), startedAt: T(3, 2), endedAt: T(3, 1),
    sessionFile: join(home, 'keeper', 'sessions', 'conv_fixture_side.jsonl'), sessionId: 'conv_fixture_side',
    resultText: '因为 DEC-3 定了导出为一组 Markdown 文件：纯文本、永远可读 [' + src_export_code.id + ']。',
    steps: [],
    task: chatTask('conv_fixture_side', '导出格式为什么是 Markdown？', 1, src_msg_4.id),
  });

  // ---- Follow up round 1, its per-object judgements, requests and authorizations (§5.5, §5.4, §1.14) ----
  const judg = (nodeId: string, state: ObjectJudgement['state'], reason: string, covers: readonly { changeId: string; itemId: string }[], lacks: readonly { changeId: string; itemId: string; what: string }[]): void => {
    store.propagation.put({
      id: `round_1:${nodeId}`, projectId: pid, nodeId, roundId: 'round_1', state, sourceOrReason: reason,
      covers, followed: [], lacks, closed: [], objectUpdatedAt: T(1), jobId: 'job_round_1', at: T(1),
    });
  };
  judg('thread_tag_suggest', 'Still on old understanding', 'suggestions still assume the tag browser page', [{ changeId: 'chg_search_replaces_tags', itemId: 'item_1' }], [{ changeId: 'chg_search_replaces_tags', itemId: 'item_1', what: '标签自荐要改向搜索筛选供数' }]);
  judg('thread_tag_merge', 'Not yet checked', '', [{ changeId: 'chg_search_replaces_tags', itemId: 'item_1' }], []);
  judg('thread_zh_tokenizer', 'Still on old understanding', 'the thread has not read the supplement', [{ changeId: 'chg_notes_doc', itemId: '' }], [{ changeId: 'chg_notes_doc', itemId: '', what: '读分词调研的补记' }]);
  const round: FollowUpRound = {
    id: 'round_1', projectId: pid, number: 1, startedAt: T(1, 3), endedAt: T(1), mainJobId: 'job_round_1', seenAt: null,
    result: {
      at: T(1), summary: '本轮跟进了 3 个变化，判了 12 个对象：2 个还停留在旧理解（标签自荐、中文分词），其余已跟上或无需处理。',
      counts: { objectsJudged: 12, byState: { Updated: 7, 'Still on old understanding': 2, 'Reusable as is': 2, 'Not yet checked': 1 }, behind: 2, itemsLacked: 2, notJudged: 1, requests: 1, notes: 1, decisionsReplaced: 1, decisionsSuspected: 0 },
      behind: [{ nodeId: 'thread_tag_suggest', holder: 'Worker agent', lacks: 1 }, { nodeId: 'thread_reading_progress', holder: null, lacks: 1 }],
      byHolder: [{ holder: 'Worker agent', requestId: 'req_round_1', nodeIds: ['thread_tag_suggest'] }],
      noteIds: ['note_tag_suggest'], unassigned: ['thread_reading_progress'],
    },
  };
  store.rounds.put(round, { jobId: 'job_round_1', summary: 'Follow up round 1 result' });

  store.authorizations.put({ id: 'auth_daily', projectId: pid, scope: '每天整理一次新进来的材料并跟进变化', sourceId: src_own_3.id, quote: '每天帮我整理一次新进来的东西', at: T(10), revokedAt: null }, { jobId: null, summary: 'Standing authorization' });
  store.authorizations.put({ id: 'auth_temp', projectId: pid, scope: 'trial: organize the receipts ahead of everything', sourceId: src_own_3.id, quote: '先整理收据', at: T(12), revokedAt: T(4) }, { jobId: null, summary: 'Standing authorization revoked' });
  store.requests.put({ id: 'req_mod_1', projectId: pid, holder: 'Worker agent', what: '把 T-19 的进度更新到 TASKS.md', why: 'T-19 已在进行，TASKS.md 没有反映', basisSourceIds: [src_msg_2.id], impact: ['thread_zh_tokenizer'], noteId: 'note_reader_typography', at: T(0, 4), handled: null, roundId: null }, { jobId: 'job_chat_2', summary: 'Request to Worker agent' });
  store.requests.put({ id: 'req_round_1', projectId: pid, holder: 'Worker agent', what: '跟进标签自荐的旧理解', why: 'DEC-2 之后 T-28 的描述停留在旧理解', basisSourceIds: [src_own_2.id], impact: ['thread_tag_suggest'], noteId: 'note_tag_suggest', at: T(1), handled: null, roundId: 'round_1', lines: [{ nodeId: 'thread_tag_suggest', what: '标签自荐要改向搜索筛选供数', changeIds: ['chg_search_replaces_tags'] }] }, { jobId: 'job_round_1', summary: 'Request to Worker agent' });
  store.requests.put({ id: 'req_old', projectId: pid, holder: 'QC reviewer', what: '核对 batch 1 的验收说法', why: 'T-1 的验收只有 receipt', basisSourceIds: [src_receipt_1.id], impact: ['thread_hotkey'], noteId: null, at: T(8), handled: { at: T(7), evidenceSourceIds: [src_review_search.id] } }, { jobId: 'job_frame', summary: 'Request to QC reviewer' });

  // ---- the scope, re-decided with the Keeper's and the owner's classifications and the project's rules (§1.1, §1.15) ----
  // The classifications the program's candidates waited for: the Keeper judged the vendored library (its inference,
  // marked); the owner said what dist/ is. Written as ScopeJudgements, then applied by re-drawing the boundary —
  // the same path the product takes; the ignored-directory summaries, the worktree measurements, the covered
  // locations and the toolchain all come out of that, not out of the fixture's hand.
  store.scopeJudgements.put({
    id: 'sj_vendor', projectId: pid, path: vendorItem.path, relation: 'Third-party material',
    reason: 'A vendored charting library distributed with the project; its documents are for reference only, its code and history are not organized.',
    sourceIds: [], evidence: ['vendor/ is a usual name for vendored third-party code', 'its own README names it a vendored library'],
    basis: 'Inferred', ruleId: 'rule_vendor', by: 'keeper', ownerQuote: null, question: null, previous: null, jobId: 'job_frame', at: T(15),
  }, { jobId: 'job_frame', summary: 'Scope classification: the vendored library' });
  store.scopeJudgements.put({
    id: 'sj_dist', projectId: pid, path: distItem.path, relation: 'Generated',
    reason: 'Build output committed once by mistake; it is generated, not material to organize.',
    sourceIds: [], evidence: ['dist/ is a usual name for build output'],
    basis: 'Explicit', ruleId: null, by: 'owner', ownerQuote: 'dist 是构建产物，不要当项目材料整理。',
    question: null, previous: null, jobId: null, at: T(10),
  }, { jobId: null, summary: 'Scope classification: build output, by the owner' });
  app.scopeProject(pid);
  const rescoped = app.project(pid);
  app.updateProject({
    ...rescoped,
    // Hand-written, discovery cannot produce it: the owner excluded the archive, and the sessions directory is kept as a session source.
    scope: [
      ...rescoped.scope.map((i) => (samePath(i.path, archiveItem.path) ? { ...i, relation: 'Excluded' as const, reason: 'Old v1 designs, kept for reference only; not current material.' } : i)),
      sessionsItem,
    ],
    scopeQuestions: rescoped.scopeQuestions.some((q) => q.id === sqNotes.id) ? rescoped.scopeQuestions : [...rescoped.scopeQuestions, sqNotes],
    // The takeover started before the frame round: createdAt leads the planted timeline (the planner shows it).
    createdAt: T(20),
    lastOpenedAt: T(1, 12),
  });
  // Fail loudly at seed time when the product's discovery no longer produces what the workbench is checked against.
  const finalScope = app.project(pid).scope;
  const finalItem = (id: string) => finalScope.find((i) => i.id === id);
  if (!finalItem(wtItem.id)?.worktree || !finalItem(wt2Item.id)?.worktree) throw new Error('fixture: a registered worktree was not measured against the trunk');
  if (finalItem(vendorItem.id)?.classification?.by !== 'keeper') throw new Error('fixture: the vendored library is not classified by the Keeper');
  if (finalItem(distItem.id)?.classification?.by !== 'owner') throw new Error('fixture: the build output is not classified by the owner');
  if (!finalItem(scratchItem.id)?.ignoredBy) throw new Error('fixture: the ignored directory lost its ignore rule');
  if (!(finalItem(draftsItem.id)?.ignoredBy?.documents ?? 0)) throw new Error('fixture: the ignored directory holding documents lost them');
  if (!finalScope.some((i) => (i.coveredBy ?? []).length > 0)) throw new Error('fixture: no location is covered by a material rule');
  const toolchainNow = app.project(pid).toolchain ?? [];
  if (!toolchainNow.some((t) => t.used !== false) || !toolchainNow.some((t) => t.used === false)) throw new Error('fixture: the toolchain needs a used entry and a too-broad one');

  // ---- context packages (§1.12) ----
  const ctxMarkdown = `# Papertrail 阅读清单 — Start context\n\n## What this project is\n\nA one-person read-later list. Save in one motion, read offline, find in one query.\n\n## Where things stand\n\nCapture and reading are done and accepted; search and export are the active work [${src_readme_goal.id}].\n`;
  store.contexts.put({
    id: 'ctx_start', projectId: pid,
    request: { scope: { kind: 'project', ids: [] }, purpose: 'Start', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: null },
    asOf: T(2), commit: null, keeperStatus: 'Idle', markdown: ctxMarkdown, citedSourceIds: [src_readme_goal.id, one('docs/PRODUCT.md', 'Areas').id],
    generatedAt: T(2), deliveries: [{ sessionRef: 'pi session ctx-demo-1', state: 'Delivered', at: T(2) }],
  }, { jobId: 'job_ctx_1', summary: 'Start context' });
  store.contexts.put({
    id: 'ctx_search_work', projectId: pid,
    request: { scope: { kind: 'area', ids: [ref_search] }, purpose: 'Work', kind: 'Implement', recipient: 'Worker agent', lastSessionAt: T(2) },
    asOf: T(1), commit: null, keeperStatus: 'Idle',
    markdown: `# A3 · Search 搜索与找回 — Work context\n\n## The work\n\nT-18 incremental rebuild, T-19 中文分词 [${src_search_code.id}].\n`,
    citedSourceIds: [src_search_code.id, src_search_test.id], generatedAt: T(1),
    deliveries: [{ sessionRef: 'pi session ctx-demo-2', state: 'Pending next read', at: T(1) }],
  }, { jobId: 'job_ctx_1', summary: 'Work context for A3' });

  // ---- large: the same content, scaled past one screen ----
  if (size === 'large') {
    const enNames = ['Backfill', 'Migration', 'Polish pass on', 'Retry logic for', 'Cleanup of', 'Instrumentation for', 'Spike: replace', 'Harden'];
    const zhNames = ['打磨', '重做', '补全', '梳理', '收敛', '加固'];
    const objects = ['the list view', 'the settings page', 'the import pipeline', 'the archive reader', 'the nightly job', '索引压缩', '缓存失效', '快捷键冲突', '导出命名', '空状态文案'];
    const extraAreas: string[] = [];
    const areaSpecs = [
      ['ref_x1', 'A8 · Plugins 插件', 'Third-party plugins, sandboxed.'],
      ['ref_x2', 'A9 · Statistics 阅读统计', 'Reading statistics on the vendored chart library.'],
      ['ref_x3', 'A10 · Notifications 提醒', 'Gentle reminders for saved-but-unread pages.'],
      ['ref_x4', 'A11 · Onboarding 上手引导', 'First-run guidance.'],
      ['ref_x5', 'A12 · Accessibility 无障碍', 'Keyboard-only flows and contrast.'],
      ['ref_x6', 'A13 · Performance 性能', 'Startup time and memory.'],
      ['ref_x7', 'A14 · Distribution 打包分发', 'Packaging and updates.'],
    ] as const;
    const goalFor = [ref_g1, ref_g2, ref_g3];
    areaSpecs.forEach(([id, name, text], i) => {
      extraAreas.push(ref(id, 'Area', name, text, { ids: [id.replace('ref_', 'A').toUpperCase()], refines: [goalFor[i % 3]!] }));
      ref(`${id}_req_a`, 'Requirement', `${name.slice(0, 6)} · first requirement of ${name.replace(/ /g, ' ')}`, `${name}: the first requirement.`, { refines: [id] });
      ref(`${id}_req_b`, 'Requirement', `${name.slice(0, 6)} · 第二要求：${text}`, `${name}: 第二要求。`, { refines: [id] });
    });
    const workAreas = [ref_capture, ref_reading, ref_search, ref_export, ...extraAreas.filter((a) => a !== 'ref_x3')];
    const progressOf = (i: number): Progress => (['Done', 'Done', 'Done', 'In progress', 'In progress', 'In progress', 'Planned', 'Planned', 'On hold', 'Done'] as const)[i % 10]!;
    const extraThreads: string[] = [];
    for (let i = 0; i < 108; i += 1) {
      const id = `thread_gen_${i}`;
      extraThreads.push(id);
      const zh = i % 7 === 0;
      const longName = i % 11 === 0;
      const base = zh ? `${zhNames[i % zhNames.length]}${objects[i % objects.length]}` : `${enNames[i % enNames.length]} ${objects[i % objects.length]}`;
      const title = longName
        ? (zh ? `${base}——这是一个故意写得非常长的工作项名称，用来检查列表与图节点在超长中文标题下的表现是否正常` : `${base} — a deliberately very long work item title that keeps going well past sixty characters to check wrapping`)
        : base;
      thread(id, title, [`T-${100 + i}`], progressOf(i), [serve(workAreas[i % workAreas.length]!, `${base} contributes`, i % 5 === 0 ? 'Inferred' : 'Explicit')], {
        acceptance: progressOf(i) === 'Done' && i % 20 === 0 ? 'Accepted' : progressOf(i) === 'Done' && i % 20 === 10 ? 'Not yet accepted' : undefined,
        updatedAt: T(i % 25, i % 24),
      });
    }
    // Observed results at scale: benchmark runs and generated tests linked to the work.
    const threadPool = ['thread_search_index', 'thread_export_md', 'thread_zh_tokenizer', ...extraThreads];
    for (let j = 0; j < 190; j += 1) {
      const at = T(j % 30, j % 24);
      const cmd = commandSrc(`src_cmd_gen_${j}`, `node bench.js --case ${j}`, at, `Generated run ${j}`, `case ${j}: ok`);
      rel(`rel_gen_run_${j}`, 'produced', threadPool[j % threadPool.length]!, cmd.id, `the work produced run ${j}`, 'Explicit', 'Not assessed', [cmd.id]);
    }
    for (let j = 0; j < 24; j += 1) {
      const test = one(`src/gen/gen-${j}.test.ts`);
      rel(`rel_gen_test_${j}`, 'verifies', test.id, threadPool[(j * 7) % threadPool.length]!, `generated test ${j} covers its work`, 'Explicit', j % 6 === 0 ? 'Questioned' : 'Holds', [test.id]);
    }
    for (let j = 0; j < 8; j += 1) {
      change(`chg_gen_${j}`, T(j % 12, j % 20), 'Development note', j % 2 === 0 ? 'Corrected' : 'Added', `Generated change ${j}`, `Generated change ${j} in the scaled fixture.`, null, null, [], byRole('Worker agent'), [threadPool[(j * 13) % threadPool.length]!], {
        work: { kind: 'Time range', label: `generated window ${j}`, sessionId: null, startedAt: T(j % 12, j % 20), endedAt: T(j % 12, (j % 20) - 1 < 0 ? 0 : (j % 20) - 1), openEnded: false },
        items: [item(`gen_${j}_1`, T(j % 12, j % 20), 'Development note', j % 2 === 0 ? 'Corrected' : 'Added', `Generated item ${j}`, '', null, null, [], byRole('Worker agent'), null, [threadPool[(j * 13) % threadPool.length]!])],
      });
    }
    for (let j = 0; j < 3; j += 1) {
      note(`note_gen_${j}`, { kind: 'node', ids: [extraThreads[j * 3]!] }, 'For information', `Generated note ${j}: ${zhNames[j]}进展`, `第 ${j} 条生成的 note。`, body(`生成内容 ${j}。`, null, [], null, null, null), { updatedAt: T(j, j) });
    }
  }

  // ---- derive the graph, keep a version, change five kinds of things, keep a second version (§6.3, D45) ----
  const projectNow = () => app.project(pid);
  const derived1 = deriveGraph(store, projectNow());
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  saveVersion(assetDirOf(pid, home), store, 'Opened');

  const mergedThread = store.threads.get('thread_merge_csv');
  if (!mergedThread) throw new Error('fixture: thread_merge_csv missing before merge');
  store.threads.remove('thread_merge_csv', { jobId: 'job_round_1', summary: 'Merged into thread_pocket_import' });
  store.merges.put({
    id: 'merge_csv', projectId: pid, kind: 'thread', mergedId: 'thread_merge_csv', keptId: 'thread_pocket_import',
    reason: '同一个导入工作写了两次：先按 CSV 试做，后按 Pocket 导入立项', sourceIds: [src_tasks.id], merged: mergedThread,
    at: T(2), jobId: 'job_round_1', roundId: 'round_1',
  }, { jobId: 'job_round_1', summary: 'Merged duplicate work item' });
  const ranking = store.threads.get('thread_result_ranking');
  if (!ranking) throw new Error('fixture: thread_result_ranking missing');
  store.threads.put({ ...ranking, results: 'Ranking adjusted again after the benchmark: warm query 88 ms.', updatedAt: T(0, 1) }, { jobId: 'job_round_1', summary: 'Result ranking: new numbers' });
  const highlight = store.threads.get('thread_highlight');
  if (!highlight) throw new Error('fixture: thread_highlight missing');
  store.threads.put({ ...highlight, serves: [serve(ref_reading, '高亮出现在阅读视图'), ...highlight.serves], updatedAt: T(0, 1) }, { jobId: 'job_round_1', summary: 'Highlight preview reassigned to Reading' });
  rel('rel_verify_export_late', 'verifies', src_export_test.id, 'thread_export_md', 'export.test.ts covers one file per item', 'Explicit', 'Holds', [src_export_test.id], ['fact_export']);
  thread('thread_saved_searches', 'Saved searches 存取常用搜索', ['T-42'], 'Planned', [serve(ref_search, '常用搜索一键重跑')], { updatedAt: T(0, 1) });
  const derived2 = deriveGraph(store, projectNow());
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  saveVersion(assetDirOf(pid, home), store, 'Organized');

  // ---- the takeover's two rounds by the clerk method (Spec §3.3, §3.7; QC AY) ----
  // Planted as the product records them — a round, its steps as jobs in fresh sessions, the drafts, the documents — so
  // the coverage below is what the product computes from them (the owner's-words step, the organizing levels, the depth
  // options), here and in a workbench served on this home, whose planner then has nothing to start: the first usable
  // round and the Focused deepening are done, and the deepening ended within the day. A served home used to start a
  // first usable round of its own and overwrite hand-written figures (QC AY, s6).
  //
  // The ledger is there too, as after any round (its step 0 brings it up to date): built here once from the fixture
  // project's history, so the depth question counts each path by the question list and says how (DeepeningPlan.paths[].
  // basis), the deepening's coverage check plans from it, and Project scope says what the ledger keeps without reading
  // it — the review tool's binary export of a receipt on the `receipts-export` branch (QC AY package C).
  app.ledger.rebuildNow(app.project(pid));
  const minutes = (at: string, m: number) => new Date(Date.parse(at) + m * 60_000).toISOString();
  const timing = (ms: number, program: boolean) => ({ wallMs: ms, generationMs: program ? 0 : Math.round(ms * 0.7), toolMs: program ? ms : Math.round(ms * 0.25), queueMs: 0, parseRetryMs: 0, otherMs: program ? 0 : ms - Math.round(ms * 0.7) - Math.round(ms * 0.25) });
  const stepJob = (id: string, round: ClerkRound, kind: RoundStepKind, label: string, from: string, to: string, over: { path?: string | null; steps?: { tool: string; target: string; reads?: KeeperJob['steps'][number]['reads'] }[]; program?: boolean; parent?: string | null; assignment?: string } = {}): string => {
    const program = over.program === true;
    store.jobs.put({
      id, projectId: pid, kind: kind === 'synthesis' ? 'Product re-look' : 'Organizing', initiator: 'auto', status: 'Done',
      scope: { kind: over.parent === null ? 'clerk-round' : 'clerk-step', ids: [round.id], label }, queuedAt: from, startedAt: from, endedAt: to,
      savedResults: [], usage: program ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } : usage, agent: program ? 'program' : 'pi', model: program ? null : { provider: 'zai', id: 'glm-5.3', thinking: null },
      sessionFile: program ? null : join(home, 'keeper', 'sessions', `${id}.jsonl`), sessionId: program ? null : id,
      steps: (over.steps ?? []).map((s) => ({ at: from, summary: '', isError: false, ...s })), error: null, requestBasis: null,
      parentJobId: over.parent === undefined ? round.rootJobId : over.parent, resultText: null, priority: 1, task: null,
      step: over.parent === null ? null : { roundId: round.id, kind, path: over.path ?? null, ...(over.assignment ? { assignment: over.assignment } : {}) }, timing: timing(Date.parse(to) - Date.parse(from), program),
    } as KeeperJob, { jobId: id, summary: `${label} (planted)` });
    return id;
  };
  const clerkRound = (id: string, kind: ClerkRound['kind'], number: number, from: string, to: string, over: Partial<ClerkRound> = {}): ClerkRound => ({
    id, projectId: pid, kind, number, startedAt: from, endedAt: to, status: 'Done', rootJobId: `job_${id}`, questionsDocId: null, paths: [],
    outputs: [], groundwork: [], unplaced: { count: 0, reasons: [] }, spotCheck: null, ledger: { ms: 1_400, commitsAdded: 0 }, followUpRoundId: null, updatedAt: to, ...over,
  });
  const roundDoc = (round: ClerkRound, jobId: string | null, kind: RoundDoc['kind'], path: string | null, title: string, markdown: string, at: string): string => {
    const id = stableId('rdoc', round.id, kind, path ?? '');
    store.roundDocs.put({ id, projectId: pid, roundId: round.id, jobId, kind, path, title, markdown, at }, { jobId, summary: `Wrote ${kind}${path ? ` · ${path}` : ''}` });
    return id;
  };

  // The first usable round: step 0, the session drafts in two calls over four minutes, orientation, the skeleton (which
  // wrote the nine Owner's words items from the drafts), the process step, the synthesis.
  const fu0 = T(16);
  const fu = clerkRound('crd_fixture_1', 'First usable', 1, fu0, T(15, 20), { ledger: { ms: 1_800, commitsAdded: 9 } });
  stepJob(fu.rootJobId, fu, 'ledger', 'Takeover round 1: the first usable picture', fu0, fu.endedAt!, { program: true, parent: null });
  stepJob('job_fu_ledger', fu, 'ledger', 'Ledger: bring it up to date', fu0, minutes(fu0, 1), { program: true });
  const draftJob1 = stepJob('job_fu_drafts_1', fu, 'session-drafts', 'Session drafts: batch 1 of 2', minutes(fu0, 1), minutes(fu0, 3), { steps: [{ tool: 'pk_owner_utterances', target: '' }, { tool: 'pk_write_session_draft', target: 'sess_fixture_own1' }, { tool: 'pk_write_session_draft', target: 'sess_fixture_own2' }] });
  const draftJob2 = stepJob('job_fu_drafts_2', fu, 'session-drafts', 'Session drafts: batch 2 of 2', minutes(fu0, 3), minutes(fu0, 5), { steps: [{ tool: 'pk_owner_utterances', target: '' }, { tool: 'pk_write_session_draft', target: 'sess_fixture_own3' }] });
  const orientationJob = stepJob('job_fu_orientation', fu, 'orientation', 'Orientation', minutes(fu0, 5), minutes(fu0, 40), { steps: [{ tool: 'pk_ledger_overview', target: '' }, { tool: 'read', target: 'README.md' }, { tool: 'read', target: 'AGENTS.md' }, { tool: 'read', target: 'docs/PRODUCT.md' }, { tool: 'read', target: 'docs/TASKS.md' }, { tool: 'pk_write_layers', target: '' }] });
  const skeletonJob = stepJob('job_fu_skeleton', fu, 'skeleton', 'Skeleton', minutes(fu0, 40), minutes(fu0, 150), { steps: [{ tool: 'read', target: 'docs/PLAN.md' }, { tool: 'read', target: 'docs/DECISIONS.md' }, { tool: 'pk_write_reference', target: 'ow_save_fast' }, { tool: 'pk_write_thread', target: 'thread_search_index' }] });
  stepJob('job_fu_process', fu, 'process', 'Process and breakpoints', minutes(fu0, 150), minutes(fu0, 151), { program: true });
  stepJob('job_fu_synthesis', fu, 'synthesis', 'Synthesis', minutes(fu0, 151), fu.endedAt!, { steps: [{ tool: 'pk_record_judgement', target: '' }, { tool: 'pk_write_note', target: 'Where Papertrail stands' }] });
  // The drafts: the owner's lines verbatim, each marked (§3.11), from the three logs above.
  const draftOf = (id: string, jobId: string, log: ReturnType<typeof ownerLog>, sessionId: string, kinds: readonly ('Chat' | 'Decision' | 'Confirmation')[], at: string) =>
    store.drafts.put({
      id, projectId: pid, session: { host: 'claude', sessionId, file: log.file, startedAt: log.said[0]!.at, endedAt: log.said[log.said.length - 1]!.at },
      ownerLines: log.said.map((l, i) => ({ ref: `msg:fixture-${sessionId}-${l.index}`, at: l.at, text: l.text, kind: kinds[i] ?? 'Chat', answers: kinds[i] === 'Confirmation' ? 'Noted.' : null, confirms: kinds[i] === 'Confirmation' ? 'the owner confirmed the proposal to build search first' : null })),
      agentSummary: [{ at: log.said[0]!.at, who: 'Claude Code', summary: 'Asked what the list should do; took notes.' }], jobId, at,
    }, { jobId, summary: `Session draft: ${sessionId}` });
  draftOf('draft_own1', draftJob1, own1, 'sess_fixture_own1', ['Decision', 'Decision', 'Decision', 'Decision'], minutes(fu0, 2));
  draftOf('draft_own2', draftJob1, own2, 'sess_fixture_own2', ['Decision', 'Decision', 'Decision', 'Confirmation'], minutes(fu0, 3));
  draftOf('draft_own3', draftJob2, own3, 'sess_fixture_own3', ['Decision', 'Chat', 'Decision', 'Decision'], minutes(fu0, 5));
  // The skeleton wrote the Owner's words items from the drafts' decisions and confirmations.
  for (const r of store.reference.filter((x) => x.category === "Owner's words")) store.reference.put(r, { jobId: skeletonJob, summary: `Owner's words: ${r.name}` });
  roundDoc(fu, orientationJob, 'Questions', null, 'What the deepening asks', '# Questions\n\nWhat is Papertrail now, and what got buried on the way? Which search promise holds? Where did export and sync stop?\n', minutes(fu0, 30));
  // Orientation set three of the four kinds of question; the deepening adds the fourth (below).
  const briefs: [string, string][] = [
    ["The owner's meaning", 'Read the owner’s conversations in `sessions/` and the decisions in `docs/DECISIONS.md`.'],
    ['The document chain and decisions', 'Read every version of `docs/PRODUCT.md`, `docs/PLAN.md`, `docs/TASKS.md` and `docs/DECISIONS.md`.'],
    ["Each work item's process and checks", 'Read `docs/receipts/`, `docs/review-search.md` and the benchmark `docs/bench-2026-09-10.md`.'],
  ];
  for (const [path, read] of briefs) roundDoc(fu, orientationJob, 'Brief', path, `Brief: ${path}`, `# Brief: ${path}\n\n1. Background: a one-person read-later list; sync deferred.\n2. Rules: read only, cite everything.\n3. ${read}\n4. Verdicts: present now / cancelled or replaced / no follow-up.\n5. Clues: 以后, 后续, TBD.\n6. Report: complete, citations dense.\n`, minutes(fu0, 35));
  store.clerkRounds.put({ ...fu, paths: briefs.map(([p]) => p), outputs: [{ position: 'Product intent (graph, List, popovers)', count: 24 }, { position: 'Work items (process view)', count: 41 }, { position: 'Notes (attention, log, popovers)', count: 1 }], groundwork: [{ kind: 'Session drafts', count: 3 }, { kind: 'Round documents (history map, questions, briefs, reports, adoption, result, spot check)', count: 5 }] }, { jobId: fu.rootJobId, summary: 'First usable round 1 Done (planted)' });

  // The Full deepening, the way D99 runs it (Spec §3.3, §3.7; CKC-23): the ledger, the session drafts, then one main
  // agent in one session through orientation, dig, the coverage check, the cross-check and the synthesis, sending its
  // lanes from its own session; then the spot check and the process. It ended an hour ago. Orientation's round set briefs
  // for three of the four kinds of question; the main agent writes the lanes' briefs in its dig and sends one lane for
  // each kind, the code as it stands among them (E148 D-g). The lanes read what their briefs name, some of it only in
  // part (src/capture.ts past its first line, the first section of docs/PLAN.md, the verdict of docs/receipts/batch-2.md)
  // and some not at all (src/sync.ts, src/export.test.ts); the coverage check — the product's own `coverageOf` — lists
  // what no lane read whole, and the main agent accounts for each group. The process lane looks for DEC-3's attachments
  // and does not find them, and the spot check confirms the breakpoint: the only way one lights (CKC-24 AC-7).
  const dp0 = T(0, 3);
  const atD = (m: number) => minutes(dp0, m);
  const dp = clerkRound('crd_fixture_2', 'Deepen', 2, dp0, T(0, 1), { spotCheck: { sampled: 8, wrong: 1, byKind: { progress: 1 }, corrected: 1 } });
  stepJob(dp.rootJobId, dp, 'ledger', 'Takeover round 2: deepening (Full)', dp0, dp.endedAt!, { program: true, parent: null });
  stepJob('job_dp_ledger', dp, 'ledger', 'Ledger: bring it up to date', dp0, atD(1), { program: true });
  stepJob('job_dp_drafts', dp, 'session-drafts', 'Session drafts: nothing to do', atD(1), atD(1), { program: true });
  const dpMain = stepJob('job_dp_main', dp, 'main', 'Main agent', atD(1), atD(110), {
    steps: [{ tool: 'pk_ledger_overview', target: '' }, { tool: 'pk_stage', target: 'dig' }, { tool: 'pk_send_lanes', target: '4 lanes' }, { tool: 'pk_stage', target: 'coverage' },
      { tool: 'pk_coverage_check', target: '' }, { tool: 'pk_account_material', target: '' }, { tool: 'pk_stage', target: 'cross-check' },
      { tool: 'read', target: 'src/search.ts', reads: [{ path: join(projectDir, 'src', 'search.ts') }] }, { tool: 'pk_write_territory', target: '' }, { tool: 'pk_stage', target: 'synthesis' }, { tool: 'pk_suggest_sendback', target: 'thread_export_attach' }],
  });
  type Step = { tool: string; target: string; reads?: KeeperJob['steps'][number]['reads'] };
  const read = (rel: string): Step => ({ tool: 'read', target: rel, reads: [{ path: join(projectDir, ...rel.split('/')) }] });
  const shell = (command: string): Step => ({ tool: 'bash', target: command, reads: shellReads('bash', command, projectDir) });
  const dpLanes: (RoundLane & { from: number; to: number })[] = [];
  const dpLane = (id: string, name: string, kind: LaneKind, slots: SlotKind[], from: number, to: number, brief: string, steps: Step[]) => {
    const briefDocId = roundDoc(dp, dpMain, 'Brief', name, `Brief: ${name}`, `# Brief: ${name}\n\n${name}.\n\n1. Background: a one-person read-later list; sync deferred until after v1 — do not report it as dropped.\n2. Rules: read only, this project only; cite path and line, or commit.\n3. ${brief}\n4. Verdicts: present now / cancelled or replaced / no follow-up.\n5. Clues: 以后, 后续, TBD.\n6. Report: complete, citations dense.\n7. Slots: ${slots.join(', ') || 'none — report only'}.\n`, atD(4));
    const jobId = stepJob(id, dp, 'lane', `Lane: ${name}`, atD(from), atD(to), { path: name, steps, parent: dpMain });
    const job = store.jobs.get(jobId)!;
    store.jobs.put({ ...job, step: { ...job.step!, lane: { kind, slots } } }, { jobId, summary: `Lane ${name} (planted)` });
    roundDoc(dp, jobId, 'Report', name, `Report: ${name}`, `# Report: ${name}\n\n## Present now\n- Cited where it stands.\n\n## No follow-up\n- Nothing left open without a trace.\n`, atD(to));
    dpLanes.push({ name, kind, slots, briefDocId, jobId, stage: 'dig', sentAt: atD(from), reportDocId: stableId('rdoc', dp.id, 'Report', name), from, to });
  };
  dpLane('job_dp_lane_owner', "The owner's meaning", 'topic', ["reference:Owner's words"], 5, 30,
    'Read the decisions in `docs/DECISIONS.md` and what the owner said of search, export and sync.', [read('docs/DECISIONS.md')]);
  dpLane('job_dp_lane_chain', 'The document chain and decisions', 'plan', ['reference:Requirement', 'reference:Decision', 'patches'], 5, 45,
    'Read `docs/PRODUCT.md`, `docs/PLAN.md` and `docs/TASKS.md` as they stand, and what replaced what.', [read('docs/PRODUCT.md'), shell('head -6 docs/PLAN.md'), read('docs/TASKS.md')]);
  dpLane('job_dp_lane_process', "Each work item's process and checks", 'plan', ['threads', 'links'], 5, 55,
    'Read `docs/receipts/`, `docs/review-search.md` and the benchmark `docs/bench-2026-09-10.md`; look for DEC-3’s attachments.', [shell("sed -n '1,3p' docs/receipts/batch-2.md"), read('docs/review-search.md'), read('docs/bench-2026-09-10.md'), { tool: 'pk_record_looked', target: 'bp_export_images' }]);
  dpLane('job_dp_lane_code', 'The code as it stands', 'topic', ['territories'], 5, 50,
    'Read the code under `src/`, followed through the ledger’s references.', [read('src/search.ts'), read('src/export.ts'), read('src/reader.ts'), shell('head -1 src/capture.ts')]);
  store.clerkRounds.put({ ...dp, paths: dpLanes.map((l) => l.name), stage: 'coverage', lanes: dpLanes.map(({ from: _f, to: _t, ...l }) => l) }, { jobId: dpMain, summary: 'Round 2: four lanes sent' });
  // The coverage check as the main agent ran it: what no lane read whole, by the product's own count, and its account of each group.
  const dpLedger = app.ledger.ledger(pid)!;
  const listed = coverageOf(store, store.clerkRounds.get(dp.id)!, dpLedger, app.project(pid));
  const groups = coverageGroups(listed, null);
  if (!groups.length) throw new Error('fixture: the deepening’s coverage check lists nothing no lane read');
  const accounted: MaterialAccount[] = groups.map((g) => ({
    keys: g.keys, group: g.group, outcome: g.read === 'part' ? 'part' : 'not needed', by: 'main', at: atD(68),
    why: g.read === 'part' ? 'The part read carries what this round asks: the first section, the verdict, the entry point; the rest repeats it.'
      : g.category === 'code files' ? 'The deferred sync switch and a test the code lane’s territory already covers: nothing this round asks rests on them.'
        : `Nothing of ${g.dir} bears on this round's four questions; it stays in the ledger for a later question.`,
  }));
  const dpCoverage = { at: atD(68), accounted, settled: true, untouched: coverageGroups(listed) };
  if (!coverageOf(store, { ...store.clerkRounds.get(dp.id)!, coverage: dpCoverage }, dpLedger, app.project(pid)).settled) throw new Error('fixture: the deepening’s accounts do not settle its coverage');
  roundDoc(dp, dpMain, 'Adoption', null, 'What was adopted', '# Adoption\n\n- Every lane’s report: adopted after checking it against the files and the code.\n- The process lane’s missing attachments of DEC-3: kept as a candidate for the spot check.\n', atD(100));
  // The cross-check drew the code territories (§1.19): the judged half — name, what it is for, the area it serves; the
  // numbers come from the ledger when `Code` is assembled.
  const territory = (id: string, name: string, summary: string, paths: readonly string[], areaId: string) => store.territories.put({
    id, projectId: pid, name, summary, repo: projectDir, paths, kind: 'area', areaId, alsoServes: [], anomalies: [], roundId: dp.id, jobId: dpMain, updatedAt: atD(100),
  } satisfies CodeTerritory, { jobId: dpMain, summary: `Code territory: ${name}` });
  territory('terr_capture', 'Capture', 'One shortcut saves the current page.', ['src/capture.ts'], ref_capture);
  territory('terr_reader', 'Reader', 'Offline reading on system fonts.', ['src/reader.ts'], ref_reading);
  territory('terr_search', 'Search', 'The SQLite FTS5 index, rebuilt when the app opens, and its tests.', ['src/search.ts', 'src/search.test.ts', 'src/search.perf.test.ts'], ref_search);
  territory('terr_export', 'Export', 'A folder of Markdown files, and its test.', ['src/export.ts', 'src/export.test.ts'], ref_export);
  territory('terr_sync', 'Sync (deferred)', 'The v1 sync switch.', ['src/sync.ts'], ref_sync);
  // The synthesis sends the missing attachments back to the work that owns them (§1.18) and writes the round's result.
  const exportTodo: EvidenceRef = { kind: 'file', id: 'src/export.ts', label: 'src/export.ts', line: '// Export: a folder of Markdown files (DEC-3). Attachments are still todo.' };
  const decExport: EvidenceRef = { kind: 'file', id: 'docs/DECISIONS.md', label: 'docs/DECISIONS.md · DEC-3', line: '- DEC-3 · Export is a folder of Markdown files (owner, 2026-09-06).' };
  roundDoc(dp, dpMain, 'Result', null, 'Result of the round', '# Result\n\nThe search promise holds only by a hand-run benchmark; sync stays deferred; DEC-3’s attachments are not exported yet.\n', atD(110));
  // The spot check: the candidate the process lane looked for, checked and lit; a sample of the rest, one wrong and corrected.
  const dpSpot = stepJob('job_dp_spot', dp, 'spot-check', 'Spot-check', atD(110), atD(117), { steps: [{ tool: 'pk_confirm', target: 'bp_export_images' }, { tool: 'pk_record_spot_check', target: '' }] });
  roundDoc(dp, dpSpot, 'Spot check', null, 'Spot check', '# Spot check\n\n8 sampled, 1 wrong and corrected. DEC-3’s attachments: looked for by the process lane, not found — confirmed and lit.\n', atD(117));
  store.breakpoints.put({
    id: 'bp_export_images', projectId: pid, kind: 'Not carried out', targetId: 'thread_export_attach', why: 'DEC-3 includes the attachments; export.ts still marks them todo, and no commit on the trunk carries them.',
    evidence: [decExport, exportTodo], basis: 'Explicit', since: { at: '2026-09-06', basis: 'Written in text', anchor: 'docs/DECISIONS.md' }, lit: true, out: null, ownerResponse: null,
    confirmedInRoundId: dp.id, sixThing: null, sendBackId: 'sb_export_images', roundId: dp.id, updatedAt: atD(116),
    looked: { roundId: dp.id, jobId: 'job_dp_lane_process', where: ['docs/DECISIONS.md · DEC-3', 'src/export.ts', 'docs/receipts/batch-2.md', 'the trunk since 2026-09-06'], at: atD(50) },
    checked: { roundId: dp.id, jobId: dpSpot, at: atD(116) },
  } satisfies Breakpoint, { jobId: dpSpot, summary: 'Breakpoint: Not carried out on T-32, looked for and confirmed' });
  store.sendbacks.put({
    id: 'sb_export_images', projectId: pid, to: 'Work', stage: 'Suggested', targetId: 'thread_export_attach', what: 'DEC-3 says export includes the attachments; export.ts still marks them todo.',
    suggestion: 'Carry T-32 through: export the images with the text, as DEC-3 decided.', evidence: [decExport, exportTodo], from: { kind: 'breakpoint', id: 'bp_export_images' },
    returned: null, closed: null, ownerResponse: null, sixThing: null, occurred: { at: '2026-09-06', basis: 'Written in text', anchor: 'docs/DECISIONS.md' }, roundId: dp.id, updatedAt: atD(108),
  } satisfies SendBack, { jobId: dpMain, summary: 'Send-back to Work on T-32' });
  stepJob('job_dp_process', dp, 'process', 'Process and breakpoints', atD(117), dp.endedAt!, { program: true });
  const dpStage = (stage: ClerkStage, from: number, to: number) => {
    const ms = (to - from) * 60_000;
    return { stage, startedAt: atD(from), endedAt: atD(to), timing: { wallMs: ms, generationMs: Math.round(ms * 0.3), toolMs: Math.round(ms * 0.65), queueMs: 0, parseRetryMs: 0, otherMs: ms - Math.round(ms * 0.3) - Math.round(ms * 0.65) } };
  };
  store.clerkRounds.put({
    ...dp, paths: dpLanes.map((l) => l.name), stage: 'synthesis',
    stageLog: [dpStage('orientation', 1, 5), dpStage('dig', 5, 58), dpStage('coverage', 58, 70), dpStage('cross-check', 70, 100), dpStage('synthesis', 100, 110)],
    lanes: dpLanes.map(({ from: _f, to: _t, ...l }) => l), coverage: dpCoverage,
    outputs: [{ position: 'Work items (process view)', count: 6 }, { position: 'Code territories (Code view)', count: 5 }, { position: 'Breakpoints (objects, top bar)', count: 1 }, { position: 'Send-backs (Reality, Copy for agent)', count: 1 }, { position: 'Notes (attention, log, popovers)', count: 1 }],
    groundwork: [{ kind: 'Round documents (history map, questions, briefs, reports, adoption, result, spot check)', count: store.roundDocs.filter((d) => d.roundId === dp.id).length }],
  } satisfies ClerkRound, { jobId: dp.rootJobId, summary: 'Deepening round 2 Done (planted)' });
  app.updateProject({ ...app.project(pid), takeoverDepth: 'Full', takeoverDepthChosenAt: T(15) });

  // ---- two Follow up rounds after the takeover (Spec §3.8, §5.5; D79; CKC-07 AC-26, AC-27; CKC-24 AC-15) ----
  // Planted as the product records them (clerk.ts startRound, closeFollowUpRecord): a Follow up round opens its record and
  // keeps where the five kinds of news stood at its start (`roundBaseline`); its steps write as jobs of the round; at its
  // close the program counts what they made new against that baseline (`roundNews`) into the record's result
  // (`roundResultOf`), and the baseline goes. Round 3 finds something of every kind — a breakpoint newly lit, a send-back
  // new and one moved, two things newly among the six, a semantic patch confirmed, a note updated — so its item in
  // `Notes (attention)` lists them with their positions and jumps; round 4 finds nothing new and is the last, so the top
  // bar says so (`coverage.lastFollowUp`) and it has no item. Both ended within the hour: a served home starts no round.
  const openRecord = (number: number, from: string, mainJobId: string): FollowUpRound => {
    const record: FollowUpRound = { id: roundIdOf(number), projectId: pid, number, startedAt: from, endedAt: null, mainJobId, result: null, seenAt: null };
    store.rounds.put(record, { jobId: mainJobId, summary: `Follow up round ${number} started` });
    return record;
  };
  const closeRecord = (record: FollowUpRound, round: ClerkRound, summary: string): RoundNews => {
    const at = round.endedAt!;
    const news = roundNews(store, round, countRound(store, record.id).counts.behind, at);
    store.rounds.put({ ...record, endedAt: at, result: roundResultOf(store, record.id, summary, at, news) }, { jobId: round.rootJobId, summary: `Follow up record ${record.number} closed with round ${round.number}: ${news.statement}` });
    return news;
  };

  // Round 3: 54 to 45 minutes ago.
  const f30 = T(0, 0.9);
  const rec3 = openRecord(2, f30, 'job_crd_fixture_3');
  const f3: ClerkRound = { ...clerkRound('crd_fixture_3', 'Follow up', 3, f30, T(0, 0.75), { ledger: { ms: 900, commitsAdded: 0 }, followUpRoundId: rec3.id }), baseline: roundBaseline(store) };
  const at3 = (m: number) => minutes(f30, m);
  stepJob(f3.rootJobId, f3, 'ledger', 'Follow up round 3', f30, f3.endedAt!, { program: true, parent: null });
  stepJob('job_f3_ledger', f3, 'ledger', 'Ledger: bring it up to date', f30, at3(1), { program: true });
  const f3Orientation = stepJob('job_f3_orientation', f3, 'orientation', 'Orientation', at3(1), at3(2), { steps: [{ tool: 'pk_ledger_overview', target: '' }] });
  roundDoc(f3, f3Orientation, 'Brief', "Each work item's process and checks", "Brief: Each work item's process and checks", '# Brief: Each work item’s process and checks\n\n3. Read `docs/receipts/batch-2.md` and `docs/review-search.md` against `src/search.ts`; read the branch `wt-export-attachments`.\n', at3(2));
  stepJob('job_f3_dig', f3, 'dig', "Deep sweep: Each work item's process and checks", at3(2), at3(5), { path: "Each work item's process and checks", steps: [{ tool: 'read', target: 'docs/review-search.md' }, { tool: 'read', target: 'docs/receipts/batch-2.md' }, { tool: 'pk_ledger_commits', target: 'wt-export-attachments' }] });
  const f3Cross = stepJob('job_f3_cross', f3, 'cross-check', 'Cross-check', at3(5), at3(6), { steps: [{ tool: 'read', target: 'src/sync.ts' }, { tool: 'pk_ledger_refs', target: 'src/sync.ts' }] });
  const f3Process = stepJob('job_f3_process', f3, 'process', 'Process and breakpoints', at3(6), at3(6), { program: true });
  const f3Synthesis = stepJob('job_f3_synthesis', f3, 'synthesis', 'Synthesis', at3(6), at3(8));
  stepJob('job_f3_spot', f3, 'spot-check', 'Spot-check', at3(8), f3.endedAt!, { steps: [{ tool: 'pk_record_spot_check', target: '' }] });
  // The cross-check: nothing in the current code reaches src/sync.ts — looks residual (§2.13, six things 6) — and DEC-2's
  // withdrawal of the tag browser, drafted from the ledger's written supersession, is confirmed as a semantic patch.
  const sync = store.territories.get('terr_sync')!;
  store.territories.put({ ...sync, anomalies: [{
    kind: 'Unreferenced', text: 'Nothing in the current code imports src/sync.ts; it holds only a switch that is off, and A4 Sync is deferred until after v1.',
    evidence: [{ kind: 'file', id: 'src/sync.ts', label: 'src/sync.ts', line: '// Sync: deferred until after v1. Nothing here runs.' }], basis: 'Explicit', sendBackId: null, noteIds: [], sixThing: 6,
  }], roundId: f3.id, jobId: f3Cross, updatedAt: at3(6) } satisfies CodeTerritory, { jobId: f3Cross, summary: 'Code anomaly: src/sync.ts is unreferenced' });
  store.patches.put({
    id: 'sp_tag_browser', projectId: pid, number: 'SP-1', title: 'The tag browser is withdrawn: search with filters replaces it',
    invalidated: 'Finding saved pages by browsing tags on a page of their own (REQ-S0, T-24 Tag browser v1)', replacedBy: 'Full-text search with tag, date and domain filters (REQ-S3), as DEC-2 decided',
    affects: ['ref_req_tagbrowser', 'thread_tagbrowser', 'thread_tag_suggest'], affectsText: 'REQ-S0 and T-24 are withdrawn; T-28 now feeds the search filters rather than a tag page.',
    mustNotPassAsCurrent: 'A tag browser page as the way to find saved pages.',
    oldAnchor: { kind: 'file', id: 'docs/TASKS.md', label: 'docs/TASKS.md · T-24', line: '| T-24 | Tag browser v1 | replaced by T-18 |' },
    newAnchor: { kind: 'file', id: 'docs/DECISIONS.md', label: 'docs/DECISIONS.md · DEC-2', line: '- DEC-2 · 搜索取代标签浏览器 (owner, 2026-09-13): full-text search replaces the tag browser.' },
    decision: { kind: 'object', id: 'ref_dec_search', label: 'DEC-2 · 搜索取代标签浏览器' },
    candidate: { kind: 'file', id: 'docs/TASKS.md', label: 'docs/TASKS.md: “replaced by T-18”', line: '| T-24 | Tag browser v1 | replaced by T-18 |' },
    partial: false, occurred: { at: '2026-09-13', basis: 'Written in text', anchor: 'docs/DECISIONS.md' }, status: 'Confirmed', writtenToFolder: null, roundId: f3.id, jobId: f3Cross, updatedAt: at3(6),
  } satisfies SemanticPatch, { jobId: f3Cross, summary: 'Semantic patch SP-1 confirmed' });
  // The process step: the review's finding on the refresh claim has no answer — a breakpoint newly lit and a send-back to
  // T-18, which the review let pass (six things 5); the attachments branch picks up T-32's send-back (Returned).
  const reviewLine: EvidenceRef = { kind: 'file', id: 'docs/review-search.md', label: 'docs/review-search.md', line: 'The refresh claim in batch 2 could not be confirmed from the code.' };
  const claimLine: EvidenceRef = { kind: 'file', id: 'docs/receipts/batch-2.md', label: 'docs/receipts/batch-2.md', line: '- The search index now refreshes itself every minute in the background.' };
  store.breakpoints.put({
    id: 'bp_search_refresh', projectId: pid, kind: 'Findings open', targetId: 'thread_search_index', why: 'The review could not confirm batch 2’s background refresh from the code, and nothing since answers that finding.',
    evidence: [reviewLine, claimLine], basis: 'Explicit', since: { at: '2026-09-11', basis: 'Written in text', anchor: 'docs/review-search.md' }, lit: true, out: null, ownerResponse: null,
    confirmedInRoundId: f3.id, sixThing: null, sendBackId: 'sb_search_refresh', roundId: f3.id, updatedAt: at3(6),
  } satisfies Breakpoint, { jobId: f3Process, summary: 'Breakpoint: Findings open on T-18' });
  store.sendbacks.put({
    id: 'sb_search_refresh', projectId: pid, to: 'Work', stage: 'Suggested', targetId: 'thread_search_index', what: 'Batch 2 says the index refreshes every minute; the review could not confirm it from the code, and batch 2 was signed off anyway.',
    suggestion: 'Reopen T-18: make the index refresh in the background, or correct the receipt.', evidence: [reviewLine, claimLine], from: { kind: 'breakpoint', id: 'bp_search_refresh' },
    returned: null, closed: null, ownerResponse: null, sixThing: 5, occurred: { at: '2026-09-11', basis: 'Written in text', anchor: 'docs/review-search.md' }, roundId: f3.id, updatedAt: at3(6),
  } satisfies SendBack, { jobId: f3Process, summary: 'Send-back to Work on T-18' });
  const attachCommit = gitOut(home, projectDir, '2026-09-19T11:00:00.000Z', ['rev-parse', 'wt-export-attachments']);
  const attachEvidence: EvidenceRef = { kind: 'commit', id: attachCommit, label: `${attachCommit.slice(0, 7)} Attachments export: first pass on the branch (wt-export-attachments)`, occurred: { at: '2026-09-19T11:00:00.000Z', basis: 'Commit', anchor: `commit:${attachCommit.slice(0, 12)}` } };
  store.sendbacks.put({ ...store.sendbacks.get('sb_export_images')!, stage: 'Returned', returned: { by: attachEvidence, at: at3(6), basis: 'Explicit' }, updatedAt: at3(6) }, { jobId: f3Process, summary: 'Send-back on T-32: Returned' });
  store.breakpoints.put({ ...store.breakpoints.get('bp_export_images')!, lit: false, out: { at: at3(6), by: 'evidence', evidence: [attachEvidence] }, updatedAt: at3(6) }, { jobId: f3Process, summary: 'Breakpoint on T-32 put out by the attachments branch' });
  // The synthesis updated the note on Chinese search: the word list still has no answer.
  const zh = store.notes.get('note_zh_search')!;
  const zhLast = zh.versions[zh.versions.length - 1]!;
  store.notes.put({ ...zh, versions: [...zh.versions, { ...zhLast, version: zhLast.version + 1, at: at3(8), title: '中文搜索按词匹配仍依赖词表：体积与更新都还没有说法', preview: 'T-19 仍在进行；这一轮查过 T-18 的刷新说法，词表的体积与更新频率仍没有材料回答。', reason: 'Follow up round 3' }], updatedAt: at3(8) }, { jobId: f3Synthesis, summary: 'Note updated: Chinese search word list' });
  roundDoc(f3, f3Synthesis, 'Result', null, 'Result of the round', '# Result\n\nThe review’s finding on the index refresh is still open and goes back to T-18; the attachments branch picks up T-32; src/sync.ts is unreferenced; SP-1 withdraws the tag browser; the Chinese search note is updated.\n', at3(8));
  const news3 = closeRecord(rec3, f3, store.roundDocs.find((d) => d.roundId === f3.id && d.kind === 'Result')!.markdown.trim());
  store.clerkRounds.put({ ...f3, baseline: null, paths: ["Each work item's process and checks"], outputs: [{ position: 'Breakpoints (objects, top bar)', count: 2 }, { position: 'Send-backs (Reality, Copy for agent)', count: 2 }, { position: 'Code territories (Code view)', count: 1 }, { position: 'Semantic patches (Change log, strike-throughs, project folder)', count: 1 }, { position: 'Notes (attention, log, popovers)', count: 1 }], groundwork: [{ kind: 'Round documents (history map, questions, briefs, reports, adoption, result, spot check)', count: 2 }] }, { jobId: f3.rootJobId, summary: 'Follow up round 3 Done (planted)' });

  // Round 4: 36 to 30 minutes ago, when nothing had changed since round 3.
  const f40 = T(0, 0.6);
  const rec4 = openRecord(3, f40, 'job_crd_fixture_4');
  const f4: ClerkRound = { ...clerkRound('crd_fixture_4', 'Follow up', 4, f40, T(0, 0.5), { ledger: { ms: 700, commitsAdded: 0 }, followUpRoundId: rec4.id }), baseline: roundBaseline(store) };
  const at4 = (m: number) => minutes(f40, m);
  stepJob(f4.rootJobId, f4, 'ledger', 'Follow up round 4', f40, f4.endedAt!, { program: true, parent: null });
  stepJob('job_f4_ledger', f4, 'ledger', 'Ledger: bring it up to date', f40, at4(1), { program: true });
  stepJob('job_f4_orientation', f4, 'orientation', 'Orientation', at4(1), at4(2), { steps: [{ tool: 'pk_ledger_overview', target: '' }] });
  stepJob('job_f4_process', f4, 'process', 'Process and breakpoints', at4(2), at4(2), { program: true });
  const f4Synthesis = stepJob('job_f4_synthesis', f4, 'synthesis', 'Synthesis', at4(2), at4(5));
  roundDoc(f4, f4Synthesis, 'Result', null, 'Result of the round', '# Result\n\nNo change since round 3 reached a position on the workbench.\n', at4(5));
  const news4 = closeRecord(rec4, f4, store.roundDocs.find((d) => d.roundId === f4.id && d.kind === 'Result')!.markdown.trim());
  store.clerkRounds.put({ ...f4, baseline: null, outputs: [], groundwork: [{ kind: 'Round documents (history map, questions, briefs, reports, adoption, result, spot check)', count: 1 }] }, { jobId: f4.rootJobId, summary: 'Follow up round 4 Done (planted)' });
  // The figures a check holds the page to, from the product's own count: fail at seed time, not in a browser.
  const kinds3 = [news3.breakpoints, news3.sendbacks, news3.sixThings, news3.patches, news3.notes].map((x) => x.length);
  if (!news3.complete || news3.nothingNew || kinds3.some((n) => n === 0) || news3.sendbacks.length !== 2 || news3.sixThings.length !== 2) throw new Error(`fixture: Follow up round 3 does not have news of every kind: ${JSON.stringify(kinds3)} · ${news3.statement}`);
  if (!news4.nothingNew) throw new Error(`fixture: Follow up round 4 found something new: ${news4.statement}`);

  // ---- a round run by the main agent (D99; Spec §3.3, §3.8, §3.10, §6.9) ----
  // Round 5, 29 to 7 minutes ago, the way D99 runs a round: the ledger, the session drafts, then one main agent in one
  // session through the stages of a Follow up — orientation; the document chain had not changed, so it skipped the
  // skeleton and reconciling; dig by question, coverage check, cross-check, synthesis — sending its lanes from its own
  // session; the spot check; the process. Three lanes answer a plan and two topics at once; the coverage check lists what
  // no lane touched, the main agent accounts for it and sends a follow-up lane for the receipts; a lane looks for the
  // missing answer to the review's finding on T-18, and the spot check confirms it. It is planted as a Follow up so the
  // takeover's deepening stays round 2 (run by the main agent too, above). It has no Follow up record, so Notes (attention)
  // and the top bar still end with round 4. It starts before the research notes were read again (T(0, 0.3)), so they still wait for the next round.
  // Shaped by the W0 contract (k-types.ts ClerkRound.stage, stageLog, lanes, coverage; types.ts KeeperJob.step.lane).
  const d50 = T(0, 0.48);
  const at5 = (m: number) => minutes(d50, m);
  const d5 = clerkRound('crd_fixture_5', 'Follow up', 5, d50, at5(22), { ledger: { ms: 800, commitsAdded: 0 }, spotCheck: { sampled: 6, wrong: 0, byKind: {}, corrected: 0 } });
  stepJob(d5.rootJobId, d5, 'ledger', 'Follow up round 5, by the main agent', d50, d5.endedAt!, { program: true, parent: null });
  stepJob('job_d5_ledger', d5, 'ledger', 'Ledger: bring it up to date', d50, at5(0.5), { program: true });
  stepJob('job_d5_drafts', d5, 'session-drafts', 'Session drafts: nothing to do', at5(0.5), at5(0.5), { program: true });
  const d5Main = stepJob('job_d5_main', d5, 'main', 'Main agent', at5(0.5), at5(19), {
    steps: [{ tool: 'pk_ledger_overview', target: '' }, { tool: 'read', target: 'README.md', reads: [{ path: join(projectDir, 'README.md') }] }, { tool: 'pk_stage', target: 'dig' },
      { tool: 'pk_send_lanes', target: '3 lanes' }, { tool: 'pk_coverage_check', target: '' }, { tool: 'pk_account_material', target: 'code files · src' }, { tool: 'pk_send_lanes', target: '1 lane' },
      { tool: 'pk_stage', target: 'cross-check' }, { tool: 'read', target: 'src/search.ts', reads: [{ path: join(projectDir, 'src', 'search.ts') }] }, { tool: 'pk_stage', target: 'synthesis' }, { tool: 'pk_write_note', target: '' }],
  });
  const fileRead = (rel: string) => ({ tool: 'read', target: rel, reads: [{ path: join(projectDir, ...rel.split('/')) }] });
  // A lane: a job of the round the main agent sent (parentJobId = the main job), its step naming the lane and its slots.
  const lane = (id: string, name: string, kind: import('../src/model/k-types.ts').LaneKind, slots: readonly import('../src/model/k-types.ts').SlotKind[], from: number, to: number, steps: { tool: string; target: string; reads?: KeeperJob['steps'][number]['reads'] }[]): string => {
    const jobId = stepJob(id, d5, 'lane', `Lane: ${name}`, at5(from), at5(to), { path: name, steps, parent: d5Main });
    const job = store.jobs.get(jobId)!;
    store.jobs.put({ ...job, step: { ...job.step!, lane: { kind, slots } } }, { jobId, summary: `Lane ${name} (planted)` });
    return jobId;
  };
  const brief5 = (name: string, question: string, read: string) => roundDoc(d5, d5Main, 'Brief', name, `Brief: ${name}`, `# Brief: ${name}\n\n${question}\n\n1. Background: a one-person read-later list; sync deferred until after v1 — do not report it as dropped.\n2. Rules: read only, this project only; cite path and line, or commit.\n3. ${read}\n4. Verdicts: present now / cancelled or replaced / no follow-up.\n5. Clues: 以后, 后续, TBD.\n6. Report: complete, citations dense.\n7. Slots: as sent.\n`, at5(3));
  const lanes5: { name: string; kind: import('../src/model/k-types.ts').LaneKind; slots: import('../src/model/k-types.ts').SlotKind[]; stage: import('../src/model/k-types.ts').ClerkStage; jobId: string; briefDocId: string; from: number; to: number }[] = [];
  const addLane = (id: string, name: string, kind: import('../src/model/k-types.ts').LaneKind, slots: import('../src/model/k-types.ts').SlotKind[], stage: import('../src/model/k-types.ts').ClerkStage, from: number, to: number, question: string, read: string, steps: { tool: string; target: string; reads?: KeeperJob['steps'][number]['reads'] }[]) => {
    const briefDocId = brief5(name, question, read);
    lanes5.push({ name, kind, slots, stage, jobId: lane(id, name, kind, slots, from, to, steps), briefDocId, from, to });
  };
  addLane('job_d5_lane_plan', 'PLAN and its batches', 'plan', ['threads', 'links'], 'dig', 3.5, 9,
    'Was each batch of docs/PLAN.md done, where is the evidence, and what is still open?', 'Read `docs/PLAN.md`, `docs/TASKS.md` and the receipts; the attachments branch in the ledger.',
    [fileRead('docs/PLAN.md'), fileRead('docs/TASKS.md'), fileRead('docs/receipts/batch-2.md'), { tool: 'pk_ledger_commit', target: attachCommit, reads: [{ rev: attachCommit }] }, { tool: 'pk_record_looked', target: 'bp_d5_print' }]);
  addLane('job_d5_lane_search', 'The search promise and its checks', 'topic', ['links', 'territories'], 'dig', 3.5, 10,
    'Does the one-minute background refresh batch 2 claims exist in the code, and did anyone answer the review’s finding?', 'Read `docs/review-search.md`, `docs/bench-2026-09-10.md` and `src/search.ts`; the commits since 2026-09-11.',
    [fileRead('docs/review-search.md'), fileRead('docs/bench-2026-09-10.md'), fileRead('src/search.ts'), { tool: 'pk_investigate', target: 'search tests' }, { tool: 'pk_record_looked', target: 'bp_search_refresh' }]);
  addLane('job_d5_lane_owner', "The owner's meaning", 'topic', ["reference:Owner's words"], 'dig', 3.5, 8,
    'What did the owner decide or confirm about search, export and sync, and what of it got buried?', 'Read `docs/DECISIONS.md` and `docs/PRODUCT.md` as it stood on the attachments branch.',
    [fileRead('docs/DECISIONS.md'), { tool: 'pk_ledger_doc_read', target: 'docs/PRODUCT.md', reads: [{ path: join(projectDir, 'docs', 'PRODUCT.md'), rev: attachCommit.slice(0, 12) }] }]);
  // The search lane sent an investigation of the tests; its read counts as the lane's.
  store.jobs.put({ ...store.jobs.get('job_d5_lane_search')!, id: 'job_d5_inv_tests', kind: 'Investigation', scope: { kind: 'investigation', ids: [], label: 'Do the search tests cover the refresh?' }, parentJobId: 'job_d5_lane_search', step: null, startedAt: at5(6), endedAt: at5(8), queuedAt: at5(6), steps: [{ at: at5(6), summary: '', isError: false, ...fileRead('src/search.test.ts') }] } as KeeperJob, { jobId: 'job_d5_inv_tests', summary: 'Investigation (planted)' });
  addLane('job_d5_lane_receipts', 'Receipts no lane read', 'follow-up', ['links'], 'coverage', 12, 14,
    'The coverage check lists batch 1’s receipt as untouched: what does it say, and does anything hang on it?', 'Read `docs/receipts/batch-1.md`.',
    [fileRead('docs/receipts/batch-1.md')]);
  // Each lane's report, the adoption record, the result, the spot check's record.
  for (const l of lanes5) roundDoc(d5, l.jobId, 'Report', l.name, `Report: ${l.name}`, `# Report: ${l.name}\n\n## Present now\n- Cited where it stands.\n\n## No follow-up\n- Nothing left open without a trace.\n`, at5(l.to));
  roundDoc(d5, d5Main, 'Adoption', null, 'What was adopted', '# Adoption\n\n- The search lane’s finding: adopted after reading src/search.ts again — no background refresh.\n- The PLAN lane’s “no trace of done” on T-13: not adopted — T-13 is planned, not done.\n', at5(17));
  roundDoc(d5, d5Main, 'Result', null, 'Result of the round', '# Result\n\nThe review’s finding on the index refresh is still unanswered; export and the owner’s search decisions hold.\n', at5(19));
  const d5Spot = stepJob('job_d5_spot', d5, 'spot-check', 'Spot-check', at5(19), at5(21.5), { steps: [{ tool: 'pk_confirm', target: 'bp_search_refresh' }, { tool: 'pk_record_spot_check', target: '' }] });
  roundDoc(d5, d5Spot, 'Spot check', null, 'Spot check', '# Spot check\n\n6 sampled, 0 wrong. The missing answer to the review’s finding on T-18: confirmed.\n', at5(21.5));
  stepJob('job_d5_process', d5, 'process', 'Process and breakpoints', at5(21.5), d5.endedAt!, { program: true });
  // The missing steps: the search lane looked for an answer to the review's finding and found none, and the spot check
  // confirmed it — the breakpoint stays lit; the PLAN lane looked for T-13's delivery, which is planned, not done — a
  // candidate looked at, not lit.
  const refresh = store.breakpoints.get('bp_search_refresh')!;
  store.breakpoints.put({ ...refresh, looked: { roundId: d5.id, jobId: 'job_d5_lane_search', where: ['docs/review-search.md', 'src/search.ts', 'commits since 2026-09-11'], at: at5(9) }, checked: { roundId: d5.id, jobId: d5Spot, at: at5(21) } }, { jobId: d5Spot, summary: 'Breakpoint on T-18: looked for and confirmed' });
  store.breakpoints.put({
    id: 'bp_d5_print', projectId: pid, kind: 'No trace of done', targetId: 'thread_print_css', why: 'No commit names T-13.', evidence: [], basis: 'Inferred', since: { at: '2026-09-20', basis: 'Written in text', anchor: 'docs/TASKS.md' },
    lit: false, out: null, ownerResponse: null, confirmedInRoundId: null, sixThing: null, sendBackId: null, roundId: d5.id, updatedAt: at5(8),
    looked: { roundId: d5.id, jobId: 'job_d5_lane_plan', where: ['docs/TASKS.md', 'docs/PLAN.md', 'the trunk'], at: at5(8) }, checked: null,
  } satisfies Breakpoint, { jobId: 'job_d5_lane_plan', summary: 'Candidate on T-13 looked for' });
  const d5Coverage: import('../src/model/k-types.ts').RoundCoverage = {
    at: at5(14.5), settled: true,
    untouched: [
      { group: 'code files · src', category: 'code files', dir: 'src', count: 2, bytes: 1_820, keys: ['file:src/sync.ts', 'file:src/export.test.ts'] },
      { group: 'documents · docs/receipts', category: 'documents', dir: 'docs/receipts', count: 1, bytes: 640, keys: ['file:docs/receipts/batch-1.md'] },
    ],
    accounted: [
      { group: 'code files · src', outcome: 'not needed', why: 'src/sync.ts is the deferred sync switch round 3 judged unreferenced; export.test.ts was read by round 2’s code lane and has not changed since.', by: 'main', at: at5(12) },
      { keys: ['file:docs/receipts/batch-1.md'], outcome: 'part', why: 'The follow-up lane read its verdict and its table; the rest repeats the plan.', by: 'main', at: at5(14.5) },
    ],
  };
  const stageEntry = (stage: import('../src/model/k-types.ts').ClerkStage, from: number, to: number) => {
    const ms = (to - from) * 60_000;
    return { stage, startedAt: at5(from), endedAt: at5(to), timing: { wallMs: ms, generationMs: Math.round(ms * 0.3), toolMs: Math.round(ms * 0.65), queueMs: 0, parseRetryMs: 0, otherMs: ms - Math.round(ms * 0.3) - Math.round(ms * 0.65) } };
  };
  store.clerkRounds.put({
    ...d5, paths: lanes5.map((l) => l.name),
    stage: 'synthesis',
    stageLog: [stageEntry('orientation', 0.5, 3.5), stageEntry('dig', 3.5, 10.5), stageEntry('coverage', 10.5, 14.5), stageEntry('cross-check', 14.5, 17), stageEntry('synthesis', 17, 19)],
    lanes: lanes5.map((l) => ({ name: l.name, kind: l.kind, briefDocId: l.briefDocId, slots: l.slots, jobId: l.jobId, stage: l.stage, sentAt: at5(l.from), reportDocId: stableId('rdoc', d5.id, 'Report', l.name) })),
    coverage: d5Coverage,
    outputs: [{ position: 'Breakpoints (objects, top bar)', count: 1 }, { position: 'Work items (process view)', count: 2 }],
    groundwork: [{ kind: 'Round documents (history map, questions, briefs, reports, adoption, result, spot check)', count: store.roundDocs.filter((d) => d.roundId === d5.id).length }],
  } satisfies ClerkRound, { jobId: d5.rootJobId, summary: 'Follow up round 5 Done (planted)' });

  // The research notes are read again after the last Follow up round started, the way intake reads a settled file
  // (intake.ts `incrementalIntake`), and what it reads is the addendum their 分词调研 section got: they wait for the next
  // round, and that section differs from the version round 4 took in — the committed one, which the ledger its first
  // step brought up to date holds — so the work and the area resting on it show `Update pending`. Moving their read time
  // alone would leave their text what round 4 had taken in: no change to compare, now that the fixture has its ledger.
  // The file then changes on disk once more, and that is not read yet.
  incrementalIntake(store, app.project(pid), [{ kind: 'file', ref: notesPath, label: 'docs/research-notes.md', since: T(0, 0.3), lastEventAt: 0, scopeItemId: '' }]);
  const readNotes = readFileSync(notesPath, 'utf8');
  writeFileSync(notesPath, readNotes.replace('补记：分词库的许可证看过了，没有问题。', '补记：分词库的许可证看过了，没有问题。\n\n补记二：词表按月更新，体积先控制在 2 MB 以内。'));
  for (const s of fileSources('docs/research-notes.md')) store.sources.put({ ...s, availability: 'Changed since read' }, { jobId: null, summary: 'File changed since it was read' });
  // Everything else was read before the rounds took it in.
  for (const s of store.sources.all()) {
    const research = s.anchor.kind === 'file' && s.anchor.path.replaceAll('\\', '/').endsWith('/docs/research-notes.md');
    const at = research ? T(0, 0.3) : s.version.readAt > fu0 ? T(16, 2) : null;
    if (at && at !== s.version.readAt) store.sources.put({ ...s, version: { ...s.version, readAt: at } });
  }

  // ---- coverage (§1.11) ----
  // The takeover's progress is the product's own computation from the rounds above (service.ts `writeClerkCoverage`);
  // the scope rows under it are the fixture's, so each kind of row shows (pending, organizing, failed). A served home
  // computes both again from the assets.
  writeClerkCoverage(app, pid);
  const takeover = store.coverage.takeover!;
  const scopeCov = (id: string, kind: 'project' | 'area' | 'thread', label: string, coverage: 'Up to date' | 'Organizing' | 'Changes pending' | 'Organizing paused', over: Partial<CoverageScopeRow> = {}) => ({
    id, kind, label, coverage, asOf: over.asOf ?? T(1), commit: null,
    pending: over.pending ?? [], organizing: over.organizing ?? [], failed: over.failed ?? [], lastRelookAt: over.lastRelookAt ?? T(1),
  });
  interface CoverageScopeRow { pending: readonly { kind: 'file' | 'session' | 'commit' | 'worktree' | 'task' | 'qc' | 'other'; ref: string; label: string; since: string }[]; organizing: readonly { kind: 'file' | 'session' | 'commit' | 'worktree' | 'task' | 'qc' | 'other'; ref: string; label: string; since: string }[]; failed: readonly { ref: string; reason: string; at: string }[]; asOf: string | null; lastRelookAt: string | null }
  store.setCoverage({
    projectId: pid, state: store.coverage.state,
    scopes: [
      scopeCov('project', 'project', name, 'Changes pending', {
        asOf: T(0, 1),
        pending: [
          { kind: 'file', ref: join(projectDir, 'docs', 'research-notes.md'), label: 'docs/research-notes.md', since: T(0, 4) },
          { kind: 'session', ref: join(projectDir, 'sessions', 'claude-2026-09-21.jsonl'), label: 'claude session 2026-09-21', since: T(0, 2) },
        ],
        organizing: [{ kind: 'file', ref: join(projectDir, 'docs', 'receipts', 'batch-3.md'), label: 'docs/receipts/batch-3.md', since: T(0, 1) }],
        failed: [{ ref: join(projectDir, 'docs', 'receipts', 'batch-0.md'), reason: 'not a text file type', at: T(2) }],
        lastRelookAt: T(1),
      }),
      scopeCov(ref_search, 'area', 'A3 · Search 搜索与找回', 'Up to date'),
      scopeCov(ref_capture, 'area', 'A1 · Capture 快速收藏', 'Organizing', { organizing: [{ kind: 'file', ref: join(projectDir, 'docs', 'receipts', 'batch-3.md'), label: 'docs/receipts/batch-3.md', since: T(0, 1) }] }),
    ],
    missingSourceKinds: [], processedByKind: { file: 40, session: 7, commit: 3 }, pendingByKind: { file: 1, session: 1 }, takeover, lastFollowUp: store.coverage.lastFollowUp ?? null, updatedAt: T(0),
  }, { jobId: null, summary: 'Fixture coverage' });
  // The figures a check can hold the product to, from the planted rounds: fail at seed time, not in a browser.
  const ow = takeover.firstUsable.ownerWords;
  if (!ow || ow.calls !== 2 || ow.minutes !== 4 || ow.utterances !== 12 || ow.total !== 12 || ow.items !== 9) throw new Error(`fixture: the first usable round's owner's-words step is not what was planted: ${JSON.stringify(ow)}`);
  if ((takeover.levels.find((l) => l.level === 'Settled by rule')?.materials ?? 0) !== 2) throw new Error(`fixture: the supplier's two documents are not settled by their rule: ${JSON.stringify(takeover.levels)}`);
  if (takeover.stage !== 'Daily' || store.coverage.state !== 'Takeover complete') throw new Error(`fixture: the takeover is not complete: ${takeover.stage} / ${store.coverage.state}`);
  // What the deepening read against its plan, lane by lane and the round together, and what was read only in part, are
  // the product's own counts from the lanes' recorded reads (CKC-13 AC-8): the planted lanes read some files whole and
  // some in part.
  const asRun = takeover.deepening?.actual ?? null;
  const lanesRead = (takeover.deepening?.progress ?? []).filter((p) => p.reads && p.reads.planned !== null);
  if (!asRun || asRun.whole < 1 || asRun.part < 1 || lanesRead.length !== 4 || !takeover.readInPart?.materials) throw new Error(`fixture: the deepening's reads against its plan are not counted: ${JSON.stringify({ asRun, lanes: lanesRead.length, readInPart: takeover.readInPart })}`);
  // The tokenizer research changed after the last round: T-19 and A3 Search wait for it, by the product's own marks
  // (keeper/organize/update-pending.ts, written with the coverage above), through the change the Change log recorded from it.
  const zhWaits = store.threads.get('thread_zh_tokenizer')?.waitsFor ?? [];
  if (!zhWaits.some((w) => w.label === 'docs/research-notes.md' && w.reasons.some((r) => r.link === 'Recorded change' && r.detail.includes('分词调研'))) || !store.areas.get('area_search')?.pendingSourceIds.length) {
    throw new Error(`fixture: the tokenizer research changed after the last round, and T-19 or A3 Search does not wait for it: ${JSON.stringify(zhWaits)}`);
  }

  await app.flushAll();

  const refs = store.reference.all();
  const count = (pred: (r: ReferenceItem) => boolean) => refs.filter(pred).length;
  const observed = store.sources.filter((s) => s.usedAs === 'Test' || s.usedAs === 'QC' || s.usedAs === 'Run result' || s.anchor.kind === 'command' || s.anchor.kind === 'commit' || s.anchor.kind === 'session' || s.anchor.kind === 'status').length;
  const counts: Record<string, number> = {
    ownerWords: count((r) => r.category === "Owner's words"), product: count((r) => r.category === 'Product'),
    goals: count((r) => r.category === 'Goal'), areas: count((r) => r.category === 'Area'),
    requirements: count((r) => r.category === 'Requirement'), designs: count((r) => r.category === 'Design'),
    decisions: count((r) => r.category === 'Decision'), boundaries: count((r) => r.category === 'Boundary'),
    plans: count((r) => r.category === 'Plan'), workItems: store.threads.size + count((r) => r.category === 'Plan'),
    observed, relations: store.relations.size, notes: store.notes.size, changes: store.changes.size,
    marks: store.marks.size, facts: store.facts.size, rules: store.rules.size, organizingPlans: store.plans.size,
    sources: store.sources.size, jobs: store.jobs.size, rounds: store.rounds.size, contexts: store.contexts.size,
    authorizations: store.authorizations.size, requests: store.requests.size,
    scopeItems: app.project(pid).scope.length, scopeQuestions: app.project(pid).scopeQuestions.length,
    conversations: 2, versions: 2, nodes: derived2.nodes, removedNodes: derived1.removedNodes + derived2.removedNodes,
  };
  return { projectId: pid, projectDir, home, size, counts };
}

// ───────────────────────── CLI ─────────────────────────

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url : false;
if (invoked) {
  const home = process.argv[2];
  const flag = (name: string): string | null => { const i = process.argv.indexOf(name); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };
  const size = flag('--size') ?? 'standard';
  if (!home || (size !== 'standard' && size !== 'large')) {
    console.error('usage: node scripts/seed-ui-fixture.ts <home> [--size standard|large] [--project-dir <dir>]');
    process.exit(2);
  }
  const result = await seedUiFixture(home, { size, projectDir: flag('--project-dir') ?? undefined });
  console.log(JSON.stringify(result, null, 2));
}
