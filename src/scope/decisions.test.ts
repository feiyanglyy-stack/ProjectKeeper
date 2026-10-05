/**
 * A project rule marks the places it names and what they hold; it never widens what the program reads (D1, left over
 * from subagent/DECISIONS.md E75; Spec §1.1, §1.15; CKC-04 AC-13, AC-14, AC-17). A directory a rule names is read as
 * the location around it is read — a vendored library's subdirectory gives only its documents; generated output, what
 * the ignore rules leave out and what the owner excluded give nothing; a registered worktree gives only what it adds to
 * the trunk — and the listing still shows the rule on it, with its words and where they are written.
 *
 * Seen while the scope and history batches were merged: a subdirectory of a third-party location that a Reference only
 * rule named became a scope item of its own, as the project's own material, and the scan read its code.
 *
 * The fixture is an invented project, "Atlas", a small map-tile viewer, in a real git repository built in a temporary
 * directory: a vendored tile library with documents and code, a build output nobody ignored, notes the ignore rules
 * leave out, drafts, a merged worktree with an uncommitted change and a new file, and a folder left behind under
 * `.worktrees/` that no worktree is registered at. Each test was run on the code before this change first and failed
 * there for the reason it names, except the last, which guards the order the decisions are applied in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from '../util/tmp.test-helpers.ts';
import { dirname, join, relative } from 'node:path';
import { discoverScope, type DiscoveredItem } from './discover.ts';
import { applyDecisions } from './decisions.ts';
import { treatmentOf } from './skip.ts';
import { scanFiles } from '../sources/files.ts';
import type { ProjectRule, ScopeItem, ScopeJudgement, Source } from '../model/types.ts';

// The machine's own git configuration and home stay out of it.
const HOME = mkdtempSync(join(tmpdir(), 'pk-marks-home-'));
writeFileSync(join(HOME, 'gitconfig'), '');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(HOME, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  HOME, USERPROFILE: HOME,
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

interface Atlas { readonly repo: string; readonly labels: string }

function atlas(): Atlas {
  const repo = join(mkdtempSync(join(tmpdir(), 'pk-marks-')), 'atlas');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  put(repo, '.gitignore', 'notes/\n');
  put(repo, 'README.md', '# Atlas\n\nA small map-tile viewer.\n');
  put(repo, 'docs/plan.md', '# Plan\n\n- A-1 pan and zoom\n');
  put(repo, 'docs/design.md', '# Design\n\nTiles are drawn on a canvas.\n');
  put(repo, 'src/viewer.ts', 'export const zoom = 1;\n');
  put(repo, 'attic/old-plan.md', '# Old plan\n\nPrint the map.\n');
  put(repo, 'vendor/tilekit/README.md', '# tilekit\n\nFetch and cache map tiles.\n');
  put(repo, 'vendor/tilekit/docs/guide.md', '# Guide\n\nHow to request a tile.\n');
  put(repo, 'vendor/tilekit/docs/build-docs.js', 'module.exports = () => "docs";\n');
  put(repo, 'vendor/tilekit/src/tile.js', 'module.exports = {};\n');
  put(repo, 'vendor/tilekit/legacy/NOTES.md', '# Notes\n\nThe 0.x loader.\n');
  put(repo, 'vendor/tilekit/legacy/old-loader.js', 'module.exports = 0;\n');
  put(repo, 'dist/bundle.js', 'var a=1;\n');
  put(repo, 'dist/report.md', '# Build report\n');
  put(repo, 'drafts/sketch.md', '# Sketch\n\nA minimap.\n');
  put(repo, 'drafts/sketch.ts', 'export const minimap = true;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Atlas: first version');
  put(repo, 'notes/idea.md', '# Idea\n\nOffline tiles.\n');
  // A merged worktree: the same plan as the trunk, an uncommitted change to the design, a new document.
  const labels = join(repo, '.worktrees', 'labels');
  git(repo, 'worktree', 'add', '-q', '-b', 'labels', labels);
  put(labels, 'docs/design.md', '# Design\n\nTiles are drawn on a canvas.\n\nDraft: place names on top.\n');
  put(labels, 'docs/labels.md', '# Labels\n\nPlace names over the tiles.\n');
  // Left behind under .worktrees/: no worktree is registered here.
  put(repo, '.worktrees/old-copy/notes.md', '# Old copy\n\nLeft behind.\n');
  return { repo, labels };
}

let shared: Atlas | null = null;
const fixture = () => (shared ??= atlas());

const rule = (id: string, category: ProjectRule['category'], appliesTo: string[], excerpt: string): ProjectRule => ({
  id, projectId: 'p1', group: 'Material rules', category, summary: `${category} rule`, excerpt, sourceIds: ['src_readme'], appliesTo,
  basis: 'Explicit', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: 'job_1', asOf: '2026-09-21', updatedAt: '2026-09-21',
});
const ownerSays = (path: string, relation: ScopeJudgement['relation'], quote: string): ScopeJudgement => ({
  id: `scopej_${relation}`, projectId: 'p1', path, relation, reason: `The owner: ${quote}`, sourceIds: ['src_owner'], evidence: [], basis: 'Explicit', ruleId: null,
  by: 'owner', ownerQuote: quote, question: null, previous: null, jobId: null, at: '2026-09-21T10:00:00.000Z',
});
const labels = (id: string) => (id === 'src_readme' ? 'README.md › Atlas (L1–L3)' : null);
const discover = (locations: readonly string[], options: Parameters<typeof discoverScope>[1] = {}) =>
  discoverScope({ id: 'p1', name: 'Atlas', locations }, { home: HOME, sourceLabel: labels, ...options });
const strip = (items: readonly DiscoveredItem[]): ScopeItem[] => items.map(({ reasonRef: _r, sessions: _s, ...rest }) => rest);
const at = <T extends { path: string }>(items: readonly T[], path: string): T | undefined => items.find((i) => i.path.toLowerCase() === path.toLowerCase());
const rel = (root: string, path: string) => relative(root, path).split('\\').join('/');
const filesRead = (sources: readonly Source[], root: string) =>
  [...new Set(sources.filter((s) => s.anchor.kind === 'file').map((s) => rel(root, (s.anchor as { path: string }).path)))].sort();
const coveredBy = (item: ScopeItem | undefined) => item?.coveredBy ?? [];

test('a subdirectory of a vendored library that a rule names gives only its documents, which are Reference only; the listing shows the rule on it (D1; CKC-04 AC-13, AC-14)', () => {
  const f = fixture();
  const rules = [
    rule('rule_guide', 'Reference only', ['vendor/tilekit/docs/'], 'vendor/tilekit/docs/ is for reference only.'),
    rule('rule_legacy', 'Recovery only', ['vendor/tilekit/legacy/'], 'vendor/tilekit/legacy/ is kept only to restore the old loader.'),
  ];
  const result = discover([f.repo], { rules });
  const scan = scanFiles('p1', strip(result.items));
  const read = filesRead(scan.sources, f.repo);
  assert.ok(!read.includes('vendor/tilekit/docs/build-docs.js'), 'the code in the directory the Reference only rule names is not read');
  assert.ok(!read.includes('vendor/tilekit/legacy/old-loader.js'), 'nor the code in the directory the Recovery only rule names');
  assert.ok(!read.includes('vendor/tilekit/src/tile.js'), 'nor the rest of the library’s code');
  const guide = scan.sources.find((s) => s.anchor.kind === 'file' && rel(f.repo, s.anchor.path) === 'vendor/tilekit/docs/guide.md');
  assert.ok(guide, 'its documents are read');
  assert.equal(guide.usedAs, 'Reference only', 'as Reference only: citable, never this project’s requirement or plan');
  assert.ok(read.includes('vendor/tilekit/legacy/NOTES.md'), 'the documents under the Recovery only rule are read, for the rule to make them History only');

  const vendor = at(result.items, join(f.repo, 'vendor'));
  assert.equal(vendor?.relation, 'Third-party material');
  const docs = at(result.items, join(f.repo, 'vendor', 'tilekit', 'docs'));
  assert.ok(docs, 'the directory the rule names has its own line in the listing');
  assert.deepEqual(coveredBy(docs).map((c) => c.ruleId), ['rule_guide']);
  assert.match(docs.reason, /is for reference only/, 'with the rule’s own words');
  assert.match(docs.reason, /README\.md/, 'and where they are written');
  assert.equal(docs.relation, 'Third-party material', 'it is read as the library around it is read');
  assert.equal(treatmentOf(docs), 'documents');
  const legacy = at(result.items, join(f.repo, 'vendor', 'tilekit', 'legacy'));
  assert.deepEqual(coveredBy(legacy).map((c) => c.ruleId), ['rule_legacy']);
  assert.equal(treatmentOf(legacy!), 'documents', 'kept for recovery or not, a library gives only its documents');
});

test('a Recovery only rule makes nothing readable that the place leaves out by itself: build output, what the ignore rules or the owner leave out, a library’s code (D1; CKC-04 AC-13, AC-14, AC-17)', () => {
  const f = fixture();
  const rules = [
    rule('rule_dist', 'Recovery only', ['dist/'], 'dist/ keeps the last release build, only to restore it.'),
    rule('rule_notes', 'Recovery only', ['notes/'], 'notes/ holds old notes, kept for recovery.'),
    rule('rule_drafts', 'Recovery only', ['drafts/'], 'drafts/ is kept for recovery only.'),
    rule('rule_vendor', 'Recovery only', ['vendor/'], 'vendor/ keeps libraries we no longer build against, for recovery only.'),
    rule('rule_attic', 'Recovery only', ['attic/'], 'attic/ keeps retired files so they can be restored.'),
  ];
  const result = discover([f.repo], { rules, judgements: [ownerSays(join(f.repo, 'drafts'), 'Excluded', 'leave drafts/ out')] });
  const read = filesRead(scanFiles('p1', strip(result.items)).sources, f.repo);
  assert.deepEqual(read.filter((p) => p.startsWith('dist/')), [], 'build output stays unread');
  assert.deepEqual(read.filter((p) => p.startsWith('drafts/')), [], 'what the owner excluded stays unread');
  assert.deepEqual(read.filter((p) => p.startsWith('notes/')), [], 'what the ignore rules leave out stays unread: only the owner’s answer takes it in');
  assert.deepEqual(read.filter((p) => p.startsWith('vendor/')), ['vendor/tilekit/README.md', 'vendor/tilekit/docs/guide.md', 'vendor/tilekit/legacy/NOTES.md'], 'a library gives its documents and never its code');
  // The place of the project's own material that the rule keeps for recovery is read as before: what it holds is History only.
  assert.ok(read.includes('attic/old-plan.md'), 'the project’s own folder kept for recovery stays readable, for the three uses of history');
  assert.equal(at(result.items, join(f.repo, 'attic'))?.relation, 'Excluded', 'and out of the current material');

  for (const [dir, id] of [['dist', 'rule_dist'], ['notes', 'rule_notes'], ['drafts', 'rule_drafts'], ['vendor', 'rule_vendor'], ['attic', 'rule_attic']] as const) {
    const item = at(result.items, join(f.repo, dir));
    assert.deepEqual(coveredBy(item).map((c) => c.ruleId), [id], `${dir}/ carries the rule in the listing`);
    assert.match(item!.reason, /History only/, `${dir}/: the listing says what the rule makes of it`);
  }
  assert.equal(at(result.items, join(f.repo, 'dist'))?.relation, 'Generated', 'build output stays what it is');
  assert.equal(at(result.items, join(f.repo, 'vendor'))?.relation, 'Third-party material', 'and so does the library');
});

test('a rule naming a folder inside a registered worktree, or the worktrees’ own folder, reads no more than what the worktree adds to the trunk (D1; CKC-04 AC-15)', () => {
  const f = fixture();
  const rules = [
    rule('rule_wt_docs', 'Reference only', ['.worktrees/labels/docs/'], '.worktrees/labels/docs/ is for reference only.'),
    rule('rule_worktrees', 'Recovery only', ['.worktrees/'], '.worktrees/ keeps finished work, for recovery only.'),
  ];
  const result = discover([f.repo], { rules });
  const read = filesRead(scanFiles('p1', strip(result.items)).sources, f.repo);
  assert.deepEqual(read.filter((p) => p.startsWith('.worktrees/')), ['.worktrees/labels/docs/design.md', '.worktrees/labels/docs/labels.md'],
    'only what the worktree adds — its uncommitted change and its new document — not the plan it shares with the trunk, and not a folder left behind under .worktrees/');

  const worktree = at(result.items, f.labels)!;
  assert.equal(worktree.relation, 'Worktree of main repo', 'a rule naming a folder inside the worktree does not change what the worktree is');
  const onIt = coveredBy(worktree).find((c) => c.ruleId === 'rule_wt_docs');
  assert.equal(onIt?.target, '.worktrees/labels/docs/', 'the listing shows the rule on the worktree, with the rule’s own words for where');
  assert.match(worktree.reason, /is for reference only/);
  const root = at(result.items, f.repo)!;
  assert.ok(coveredBy(root).some((c) => c.ruleId === 'rule_worktrees' && c.target === '.worktrees/'), 'a folder no walk enters shows its rule on the location around it');
  assert.equal(at(result.items, join(f.repo, '.worktrees')), undefined, 'and gets no line of its own that would be read');
});

test('a directory a rule names that no location in scope holds is read only as far as the rule allows (D1; Spec §1.1, §1.15)', () => {
  const root = join(tmpdir(), 'pk-marks-nowhere');   // pure: the decision reads no disk
  const newItem = (path: string, relation: ScopeItem['relation']): ScopeItem => ({
    id: `scope_${rel(root, path)}`, path, category: 'Directory', relation, reason: '', reasonSourceIds: [], sessionHost: null, readOnly: false,
    copyOf: null, worktreeOf: null, versionControl: 'none', missing: null, addedBy: 'keeper',
  });
  const decide = (r: ProjectRule) => applyDecisions<ScopeItem>([], {
    locations: [root], rules: [r], judgements: [], questions: [], sourceLabel: () => null,
    resolveDir: (words) => join(root, words.replace(/[\\/]+$/, '')), newItem,
  }).items;
  const [reference] = decide(rule('rule_shelf_ref', 'Reference only', ['shelf/'], 'shelf/ is for reference only.'));
  assert.ok(reference);
  assert.equal(treatmentOf(reference), 'none', 'a Reference only rule alone makes nothing readable');
  assert.deepEqual(coveredBy(reference).map((c) => c.ruleId), ['rule_shelf_ref'], 'the listing still shows the rule on it');
  const [obsolete] = decide(rule('rule_shelf_old', 'Obsolete', ['shelf/'], 'Everything in shelf/ is superseded.'));
  assert.equal(treatmentOf(obsolete!), 'none', 'nor does an Obsolete rule');
  const [recovery] = decide(rule('rule_shelf_rec', 'Recovery only', ['shelf/'], 'shelf/ is kept for recovery only.'));
  assert.equal(treatmentOf(recovery!), 'history', 'a Recovery only rule lets what it holds be read as History only, for the three uses of history (Spec §1.2)');
});

test('what the owner decides about the location around it reaches the directory a rule names inside it (guards the order decisions are applied in)', () => {
  const f = fixture();
  const rules = [rule('rule_guide', 'Reference only', ['vendor/tilekit/docs/'], 'vendor/tilekit/docs/ is for reference only.')];
  const result = discover([f.repo], { rules, judgements: [ownerSays(join(f.repo, 'vendor'), 'Main project', 'vendor/ is our own code now')] });
  assert.equal(at(result.items, join(f.repo, 'vendor'))?.relation, 'Main project', 'the owner’s word on the library stands');
  const docs = at(result.items, join(f.repo, 'vendor', 'tilekit', 'docs'));
  assert.deepEqual(coveredBy(docs).map((c) => c.ruleId), ['rule_guide']);
  const read = filesRead(scanFiles('p1', strip(result.items)).sources, f.repo);
  assert.ok(read.includes('vendor/tilekit/docs/build-docs.js'), 'the directory the rule names is read as the owner’s own material too, code and all');
  assert.ok(read.includes('vendor/tilekit/src/tile.js'));
});
