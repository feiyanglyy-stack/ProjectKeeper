/**
 * The Keeper's word on a scope item (Spec §1.1, §3.9, §6.7; CKC-04 AC-13, AC-16, AC-17; CKC-02 AC-25): what the
 * program offers as third-party material or generated output is judged by the Keeper, with a reason, what shows it and
 * a basis; the owner corrects it in the conversation; a question the Keeper cannot settle goes to the owner through the
 * scope questions Project scope already has. Every refusal is paired with the write that must go through.
 *
 * The fixture is an invented project, "Desk", a small booking tool, in a directory without version control.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProjectStore } from '../store/project-store.ts';
import { keeperTools, type ToolContext } from './tools.ts';
import { discoverScope, type DiscoveredItem } from '../scope/discover.ts';
import { scanFiles } from '../sources/files.ts';
import type { Project, ScopeItem, ScopeQuestion, Source } from '../model/types.ts';

const HOME = mkdtempSync(join(tmpdir(), 'pk-scopetools-home-'));
writeFileSync(join(HOME, 'gitconfig'), '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(HOME, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', HOME, USERPROFILE: HOME });

const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

function desk(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pk-scopetools-'));
  put(dir, 'README.md', '# Desk\n\nBook a desk for a day.\n');
  put(dir, 'docs/booking.md', '# Booking\n\nOne desk per person per day.\n');
  put(dir, 'tools/gen-out/api.ts', '// GENERATED CODE - DO NOT EDIT\nexport const api = {};\n');
  put(dir, 'libs/chart/README.md', '# chart\n\nDraw charts.\n');
  put(dir, 'libs/chart/docs/usage.md', '# Usage\n\nCall draw().\n');
  put(dir, 'libs/chart/chart.js', 'module.exports = {};\n');
  mkdirSync(join(dir, 'experiments', 'spike'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: join(dir, 'experiments', 'spike'), stdio: 'ignore' });
  put(dir, 'experiments/spike/NOTES.md', '# Spike\n\nTrying a calendar view.\n');
  return dir;
}

const discover = (dir: string, options: Parameters<typeof discoverScope>[1] = {}) => discoverScope({ id: 'p1', name: 'Desk', locations: [dir] }, { home: HOME, ...options });
const strip = (items: readonly DiscoveredItem[]): ScopeItem[] => items.map(({ reasonRef: _r, sessions: _s, ...rest }) => rest);
const at = <T extends { path: string }>(items: readonly T[], path: string): T | undefined => items.find((i) => i.path.toLowerCase() === path.toLowerCase());
type Classification = { by: string; basis: string; evidence: string[]; sourceIds: string[] };
const classification = (item: unknown) => (item as { classification?: Classification } | undefined)?.classification;

interface Harness {
  readonly store: ProjectStore;
  call(name: string, args: Record<string, unknown>, extra?: Partial<ToolContext>): Promise<{ text: string; error: boolean; json: Record<string, unknown> }>;
}

function harness(dir: string, scope: readonly ScopeItem[]): Harness {
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-scopetools-store-')));
  const project = { id: 'p1', name: 'Desk', language: 'en', locations: [dir], scope, scopeQuestions: [], roles: [] } as unknown as Project;
  return {
    store,
    async call(name, args, extra = {}) {
      const ctx: ToolContext = { store, project, jobId: 'job_1', jobKind: 'Organizing', model: null, ...extra };
      const tool = keeperTools(ctx).find((t) => t.name === name);
      assert.ok(tool, `no tool ${name}`);
      const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
      const result = await run('call', args);
      const text = result.content.map((c) => c.text).join('\n');
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a refusal is prose */ }
      return { text, error: result.isError === true, json };
    },
  };
}

const fileSource = (store: ProjectStore, id: string, path: string, extra: Partial<Source> = {}) =>
  store.sources.put({ id, projectId: 'p1', title: path.split(/[\\/]/).pop()!, anchor: { kind: 'file', path, headingPath: [], lineStart: 1, lineEnd: 3 }, ids: [], version: { fingerprint: 'f', readAt: '2026-09-21', commit: null }, excerpt: 'x', usedAs: null, usedAsBy: null, availability: null, movedTo: null, scopeItemId: 'scope_root', hasCredential: false, bytes: 1, ...extra } as Source);

test('the Keeper classifies a directory the program did not offer: refused without a reason, what shows it, or a path in the project; recorded with them (CKC-04 AC-17)', async () => {
  const dir = desk();
  const h = harness(dir, strip(discover(dir).items));
  const gen = join(dir, 'tools', 'gen-out');
  const base = { path: gen, relation: 'Generated', reason: 'The files here are written by the API generator, not by hand.', evidence: ['api.ts begins with “GENERATED CODE - DO NOT EDIT”'] };

  const unknown = await h.call('pk_classify_scope', { ...base, relation: 'Vendor code' });
  assert.equal(unknown.error, true);
  assert.match(unknown.text, /Third-party material/);
  assert.match(unknown.text, /Generated/);
  const noReason = await h.call('pk_classify_scope', { ...base, reason: '  ' });
  assert.equal(noReason.error, true);
  assert.match(noReason.text, /reason/);
  const nothingShows = await h.call('pk_classify_scope', { ...base, evidence: [] });
  assert.equal(nothingShows.error, true);
  assert.match(nothingShows.text, /what shows it/);
  const outside = await h.call('pk_classify_scope', { ...base, path: tmpdir() });
  assert.equal(outside.error, true);
  assert.match(outside.text, /not in this project/);
  const notARepo = await h.call('pk_classify_scope', { ...base, relation: 'Nested repository' });
  assert.equal(notARepo.error, true);
  assert.match(notARepo.text, /not a git repository/);
  const explicitWithoutWords = await h.call('pk_classify_scope', { ...base, basis: 'Explicit' });
  assert.equal(explicitWithoutWords.error, true);
  assert.match(explicitWithoutWords.text, /Explicit/);
  assert.equal(h.store.scopeJudgements.all().length, 0, 'nothing refused was recorded');

  const ok = await h.call('pk_classify_scope', { ...base, path: 'tools/gen-out' });
  assert.equal(ok.error, false, ok.text);
  assert.equal(h.store.scopeJudgements.all().length, 1);

  const result = discover(dir, { judgements: h.store.scopeJudgements.all() } as Parameters<typeof discoverScope>[1]);
  const item = at(result.items, gen);
  assert.ok(item, 'Project scope lists the directory the Keeper classified');
  assert.equal(item.relation, 'Generated');
  assert.equal(classification(item)?.by, 'keeper');
  assert.equal(classification(item)?.basis, 'Inferred');
  assert.match(item.reason, /API generator/);
  assert.match(item.reason, /GENERATED CODE/);
  const read = scanFiles('p1', strip(result.items)).sources.filter((s) => s.anchor.kind === 'file' && s.anchor.path.includes('gen-out'));
  assert.equal(read.length, 0, 'generated output is not read');
});

test('third-party material: its documents become Reference only, and go back when the Keeper takes the classification back; the owner’s own Used as stays (CKC-02 AC-25)', async () => {
  const dir = desk();
  const h = harness(dir, strip(discover(dir).items));
  const chart = join(dir, 'libs', 'chart');
  fileSource(h.store, 'src_chart_readme', join(chart, 'README.md'));
  fileSource(h.store, 'src_chart_usage', join(chart, 'docs', 'usage.md'), { usedAs: 'Design', usedAsBy: 'owner' });
  fileSource(h.store, 'src_chart_code', join(chart, 'chart.js'));
  fileSource(h.store, 'src_booking', join(dir, 'docs', 'booking.md'));

  const r = await h.call('pk_classify_scope', { path: chart, relation: 'Third-party material', reason: 'A charting library copied into the project; its README names its own authors.', sourceIds: ['src_chart_readme'] });
  assert.equal(r.error, false, r.text);
  const readme = h.store.sources.get('src_chart_readme') as Source & { usedAsByScopeItemId?: string | null };
  assert.equal(readme.usedAs, 'Reference only');
  assert.ok(readme.usedAsByScopeItemId, 'it says which scope item made it Reference only');
  assert.equal(h.store.sources.get('src_chart_usage')?.usedAs, 'Design', 'what the owner judged stays');
  assert.equal(h.store.sources.get('src_chart_code')?.usedAs, null, 'code is not a document');
  assert.equal(h.store.sources.get('src_booking')?.usedAs, null, 'outside the library nothing changes');

  const back = await h.call('pk_classify_scope', { path: chart, relation: 'Main project', reason: 'On a closer look the project wrote it: the README is the project’s own.', sourceIds: ['src_chart_readme'] });
  assert.equal(back.error, false, back.text);
  const again = h.store.sources.get('src_chart_readme') as Source & { usedAsByScopeItemId?: string | null };
  assert.equal(again.usedAs, null, 'Reference only came from the classification, so it goes with it');
  assert.equal(again.usedAsByScopeItemId ?? null, null);
  assert.equal(h.store.sources.get('src_chart_usage')?.usedAs, 'Design');
});

test('the owner corrects a classification only in the conversation, and the Keeper does not overwrite the owner’s word (CKC-04 AC-17)', async () => {
  const dir = desk();
  const h = harness(dir, strip(discover(dir).items));
  const chart = join(dir, 'libs', 'chart');
  fileSource(h.store, 'src_owner', join(dir, 'owner-message.txt'));
  const correction = { path: chart, relation: 'Main project', reason: 'The owner says the chart code is the project’s own fork.', ownerCorrection: { quote: 'libs/chart 是我们自己改过的版本，算项目自己的代码' } };

  const fromJob = await h.call('pk_classify_scope', correction);
  assert.equal(fromJob.error, true);
  assert.match(fromJob.text, /owner’s message/);
  const fromConversation = await h.call('pk_classify_scope', correction, { ownerSourceId: 'src_owner' });
  assert.equal(fromConversation.error, false, fromConversation.text);
  const judged = h.store.scopeJudgements.all()[0] as unknown as { by: string; basis: string; sourceIds: string[] };
  assert.equal(judged.by, 'owner');
  assert.equal(judged.basis, 'Explicit');
  assert.ok(judged.sourceIds.includes('src_owner'));

  const overwrite = await h.call('pk_classify_scope', { path: chart, relation: 'Third-party material', reason: 'It has its own README.', evidence: ['README.md names other authors'] });
  assert.equal(overwrite.error, true);
  assert.match(overwrite.text, /owner/);
  const result = discover(dir, { judgements: h.store.scopeJudgements.all() } as Parameters<typeof discoverScope>[1]);
  assert.equal(at(result.items, chart)?.relation, 'Main project');
  assert.equal(classification(at(result.items, chart))?.by, 'owner');
});

test('a question the Keeper cannot settle goes to the owner as a scope question, and the owner’s answer settles it (CKC-04 AC-16, Spec §3.9)', async () => {
  const dir = desk();
  const h = harness(dir, strip(discover(dir).items));
  const spike = join(dir, 'experiments', 'spike');
  const incomplete = await h.call('pk_classify_scope', { path: spike, relation: 'Experiment', reason: 'A spike with a calendar view.', evidence: ['NOTES.md: “Trying a calendar view.”'], askOwner: { question: 'Is the calendar spike still going?' } });
  assert.equal(incomplete.error, true);
  assert.match(incomplete.text, /whyItMatters|options/);
  const asked = await h.call('pk_classify_scope', {
    path: spike, relation: 'Experiment', reason: 'A spike with a calendar view; nothing links it to planned work.', evidence: ['NOTES.md: “Trying a calendar view.”'],
    askOwner: { question: 'Is experiments/spike an experiment, or work that belongs to the project now?', whyItMatters: 'Only a project repository’s notes are organized as current work.', options: ['Experiment', 'Nested repository'] },
  });
  assert.equal(asked.error, false, asked.text);

  const first = discover(dir, { judgements: h.store.scopeJudgements.all() } as Parameters<typeof discoverScope>[1]);
  const question = first.questions.find((q) => q.question.includes('experiments/spike'));
  assert.ok(question, 'the Keeper’s question reaches the owner among the scope questions');
  assert.equal(at(first.items, spike)?.relation, 'Experiment');
  const answered: ScopeQuestion = { ...question, answer: { text: 'Nested repository', at: '2026-09-21T11:00:00.000Z', sourceId: null } };
  const second = discover(dir, { judgements: h.store.scopeJudgements.all(), existingQuestions: [answered] } as Parameters<typeof discoverScope>[1]);
  assert.equal(at(second.items, spike)?.relation, 'Nested repository');
  assert.equal(classification(at(second.items, spike))?.by, 'owner');
});

test('pk_scope_items shows what awaits the Keeper’s judgement, with the program’s evidence', async () => {
  const dir = desk();
  put(dir, 'node_modules/left-pad/index.js', 'module.exports = 1;\n');
  const h = harness(dir, strip(discover(dir).items));
  const r = await h.call('pk_scope_items', { which: 'candidates' });
  assert.equal(r.error, false, r.text);
  const items = r.json.items as { path: string; relation: string; classification?: Classification }[];
  const deps = items.find((i) => i.path.toLowerCase().endsWith('node_modules'));
  assert.ok(deps);
  assert.equal(deps.relation, 'Third-party material');
  assert.equal(deps.classification?.by, 'program');
  assert.ok((deps.classification?.evidence ?? []).length > 0);
});
