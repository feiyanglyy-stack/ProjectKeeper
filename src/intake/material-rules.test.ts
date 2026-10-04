/**
 * Material in a place a project rule covers is judged by that rule (Spec §1.15; CKC-04 AC-14, CKC-02 AC-23): what a
 * `Recovery only` rule covers — a directory or a branch — is `History only`, what a `Reference only` rule covers is
 * `Reference only`, and the source names the rule. Rules are usually written after intake, by the framing round, so
 * writing or changing a rule applies it again to what is already read, after the scope is decided again. The owner's own
 * judgement stands, of a source and of a location; the Keeper's own inference gives way to the project's written rule;
 * a rule the Keeper inferred fills in only where the project's rules say nothing. The scope's own marks — third-party
 * documents are Reference only by their location — and the rules' marks live side by side, neither overwriting the other.
 *
 * The fixture is an invented project, "Ledger", a small invoicing tool.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'pk-rules-home-'));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-rules-pi-'));

const { App } = await import('../server/app.ts');
const { ProjectStore } = await import('../store/project-store.ts');
const { fullIntake, incrementalIntake, recomputeCoverage } = await import('./intake.ts');
const { keeperTools } = await import('../keeper/tools.ts');
const { listMaterials } = await import('../keeper/organize/materials.ts');
type Project = import('../model/types.ts').Project;
type ScopeItem = import('../model/types.ts').ScopeItem;
type Store = import('../store/project-store.ts').ProjectStore;

const AT = '2026-09-17T00:00:00.000Z';
// Every rule a test writes as Explicit quotes these words, so they are all here (an Explicit rule's excerpt is the
// project's own words, E80) — including the narrower and later rules the tests go on to write.
const AGENTS = '# Agents\n\nattic/ is kept for recovery only; nothing in it is a requirement.\n\nreference/ holds material we only consult; it never defines our requirements.\n\nOnly attic/keep/ is kept for recovery; the rest of attic/ is ordinary material again.\n\ndocs/ is only consulted; the plan lives in the tracker.\n';

function write(root: string, rel: string, text: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}
function tree(root: string): void {
  write(root, 'AGENTS.md', AGENTS);
  write(root, 'docs/PLAN.md', '# Plan\n\nExport invoices as CSV.\n');
  write(root, 'attic/old-plan.md', '# Old plan\n\nSync with the bank every night.\n');
  write(root, 'attic/keep/notes.md', '# Notes\n\nKeep invoices for ten years.\n');
  write(root, 'reference/tax-tables.md', '# Tax tables\n\nRates by region, as the tax office publishes them.\n');
}
const item = (id: string, path: string, extra: Partial<ScopeItem> = {}): ScopeItem => ({
  id, path, category: 'Directory', relation: 'Main project', reason: 'Owner-given location', reasonSourceIds: [], sessionHost: null,
  readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'none', missing: null, addedBy: 'owner', ...extra,
});
const projectOf = (root: string, scope: ScopeItem[]): Project => ({ id: 'p1', name: 'Ledger', language: 'en', locations: [root], scope, scopeQuestions: [], keeperFiles: [], roles: [], organizingPaused: false, createdAt: AT, lastOpenedAt: null, lastScopedAt: null }) as Project;

const fileIds = (store: Store, root: string, rel: string): string[] =>
  store.sources.filter((s) => s.anchor.kind === 'file' && s.anchor.path.toLowerCase() === join(root, rel).toLowerCase()).map((s) => s.id);
const one = (store: Store, root: string, rel: string) => { const ids = fileIds(store, root, rel); assert.ok(ids.length > 0, `read ${rel}`); return store.sources.get(ids[0]!)!; };

function tools(store: Store, project: Project) {
  const all = keeperTools({ store, project, jobId: 'job_frame', jobKind: 'Organizing', model: null });
  return async (name: string, args: Record<string, unknown>) => {
    const tool = all.find((t) => t.name === name)!;
    const run = tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
    const r = await run('call', args);
    const text = r.content.map((c) => c.text).join('\n');
    assert.notEqual(r.isError, true, text);
    return JSON.parse(text) as Record<string, unknown>;
  };
}

async function writeRules(call: ReturnType<typeof tools>, store: Store, root: string) {
  const agents = fileIds(store, root, 'AGENTS.md');
  const recovery = await call('pk_write_rule', { group: 'Material rules', category: 'Recovery only', summary: 'attic/ is kept for recovery only.', excerpt: 'attic/ is kept for recovery only; nothing in it is a requirement.', sourceIds: agents, appliesTo: ['attic/'], basis: 'Explicit' });
  const reference = await call('pk_write_rule', { group: 'Material rules', category: 'Reference only', summary: 'reference/ is only consulted.', excerpt: 'reference/ holds material we only consult; it never defines our requirements.', sourceIds: agents, appliesTo: ['reference/'], basis: 'Explicit' });
  return { recovery: String(recovery.id), reference: String(reference.id) };
}

test('writing a rule applies it to the material already read once the scope is decided again: a Recovery only place is History only, a Reference only place is Reference only, each naming the rule (CKC-04 AC-14; CKC-02 AC-23)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-rules-app-'));
  const root = mkdtempSync(join(tmpdir(), 'ledger-'));
  tree(root);
  const app = new App(home, { organizing: false });
  app.workspace.setSettings({ watchProjects: false });
  try {
    const added = app.addProject('Ledger', [root]);
    await app.intakeProject(added.id);
    const store = app.store(added.id);
    const project = app.project(added.id);
    assert.equal(one(store, root, 'attic/old-plan.md').usedAs, null, 'read, not yet judged');
    const rules = await writeRules(tools(store, project), store, root);
    await store.flush();   // the rules reach the store's change event; the scope is decided again once the writes settle
    for (let i = 0; i < 100 && one(store, root, 'attic/old-plan.md').usedAs === null; i += 1) await new Promise((r) => setTimeout(r, 100));

    const attic = one(store, root, 'attic/old-plan.md');
    assert.equal(attic.usedAs, 'History only', 'what a Recovery only rule covers exists only as history');
    assert.equal(attic.usedAsByRuleId, rules.recovery);
    assert.equal(one(store, root, 'attic/keep/notes.md').usedAs, 'History only', 'everything under the directory');
    assert.equal(app.project(added.id).scope.find((i) => i.path.toLowerCase() === join(root, 'attic').toLowerCase())?.relation, 'Excluded', 'the scope took the place out of the current material first');
    const tables = one(store, root, 'reference/tax-tables.md');
    assert.equal(tables.usedAs, 'Reference only');
    assert.equal(tables.usedAsByRuleId, rules.reference);
    assert.equal(one(store, root, 'docs/PLAN.md').usedAs, null, 'material no rule covers is left to the Keeper');

    // A file that appears later in a covered place is judged by the rule when it is read.
    write(root, 'attic/older-plan.md', '# Older plan\n\nPrint invoices only.\n');
    incrementalIntake(store, app.project(added.id), [{ kind: 'file', ref: join(root, 'attic/older-plan.md'), label: 'attic/older-plan.md', since: AT, lastEventAt: 0, scopeItemId: project.scope[0]!.id }]);
    assert.equal(one(store, root, 'attic/older-plan.md').usedAs, 'History only');

    // No round claims what a rule set aside, and coverage does not wait for it: history, and material that is for
    // reference only. Material no rule covers is still planned and pending. Reference material can still be looked up.
    const pending = recomputeCoverage(store, project).scopes.find((s) => s.id === 'project')!.pending.map((m) => m.ref.toLowerCase());
    assert.ok(!pending.some((ref) => ref.includes(`${join(root, 'attic').toLowerCase()}`)), 'nothing under attic/ is pending');
    assert.ok(!pending.some((ref) => ref.includes(`${join(root, 'reference').toLowerCase()}`)), 'nothing under reference/ is pending');
    assert.ok(pending.some((ref) => ref.endsWith(join('docs', 'PLAN.md').toLowerCase())), 'the plan is still pending');
    const materials = listMaterials(store, app.project(added.id)).map((m) => m.ref.toLowerCase());
    assert.ok(!materials.some((ref) => ref.includes(join(root, 'attic').toLowerCase())), 'nothing under attic/ is planned for organizing');
    assert.ok(!materials.some((ref) => ref.includes(join(root, 'reference').toLowerCase())), 'reference-only documents are not claimed by a round as material to organize');
    assert.ok(materials.some((ref) => ref.endsWith(join('docs', 'PLAN.md').toLowerCase())), 'the plan is');
    const listed = (await tools(store, project)('pk_list_sources', { usedAs: 'Reference only' })) as unknown as { id: string }[];
    assert.ok(listed.some((s) => s.id === tables.id), 'reference-only documents can still be looked up and cited');
    // A repo-relative path with forward slashes finds a file whatever separator the platform stored (Windows: backslashes).
    const plan = one(store, root, 'docs/PLAN.md').id;
    const byPath = (await tools(store, project)('pk_list_sources', { path: 'docs/PLAN.md' })) as unknown as { id: string }[];
    assert.ok(byPath.some((s) => s.id === plan), 'a path filter with forward slashes finds the file');
    const byQuery = (await tools(store, project)('pk_list_sources', { query: 'docs/plan.md' })) as unknown as { id: string }[];
    assert.ok(byQuery.some((s) => s.id === plan), 'so does a query naming its path');
  } finally {
    app.stopAll();
    await app.flushAll();
  }
});

test('the owner’s own judgement of a source stands; the Keeper’s own inference gives way to the rule; a rule replaced by a narrower one gives back what it no longer covers (Spec §1.15)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-'));
  tree(root);
  write(root, 'attic/decided.md', '# Decided\n\nThe owner keeps this one as a design.\n');
  write(root, 'attic/guessed.md', '# Guessed\n\nThe Keeper thought this was a plan.\n');
  const project = projectOf(root, [item('scope_main', root)]);
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-rules-store-')));
  await fullIntake(store, project);
  const decided = fileIds(store, root, 'attic/decided.md');
  const guessed = fileIds(store, root, 'attic/guessed.md');
  for (const id of decided) store.sources.put({ ...store.sources.get(id)!, usedAs: 'Design', usedAsBy: 'owner' });
  for (const id of guessed) store.sources.put({ ...store.sources.get(id)!, usedAs: 'Plan', usedAsBy: 'keeper' });
  const call = tools(store, project);
  const rules = await writeRules(call, store, root);
  await fullIntake(store, project);   // intake applies the rules in force to what it has read

  for (const id of decided) assert.equal(store.sources.get(id)!.usedAs, 'Design', 'the owner judged this source; a rule does not override the owner');
  for (const id of guessed) {
    assert.equal(store.sources.get(id)!.usedAs, 'History only', 'the project’s written rule prevails over the Keeper’s own inference (§1.15)');
    assert.equal(store.sources.get(id)!.usedAsByRuleId, rules.recovery);
  }

  // The rule is replaced by one that covers attic/keep/ only.
  const agents = fileIds(store, root, 'AGENTS.md');
  const narrower = await call('pk_write_rule', { group: 'Material rules', category: 'Recovery only', summary: 'Only attic/keep/ is kept for recovery.', excerpt: 'Only attic/keep/ is kept for recovery; the rest of attic/ is ordinary material again.', sourceIds: agents, appliesTo: ['attic/keep/'], basis: 'Explicit', replaces: [rules.recovery] });
  await fullIntake(store, project);
  const oldPlan = one(store, root, 'attic/old-plan.md');
  assert.equal(oldPlan.usedAs, null, 'a source the program judged by a rule that no longer covers it is Not yet judged again');
  assert.equal(oldPlan.usedAsByRuleId ?? null, null);
  const notes = one(store, root, 'attic/keep/notes.md');
  assert.equal(notes.usedAs, 'History only');
  assert.equal(notes.usedAsByRuleId, narrower.id, 'it now names the rule in force');

  // A rule the Keeper inferred fills in where the project's rules say nothing; the source names it, and it says Inferred.
  const inferred = await call('pk_write_rule', { group: 'Material rules', category: 'Recovery only', summary: 'docs/ looks like old material.', sourceIds: agents, appliesTo: ['docs/'], basis: 'Inferred' });
  await fullIntake(store, project);
  const plan = one(store, root, 'docs/PLAN.md');
  assert.equal(plan.usedAs, 'History only', 'the Keeper’s inference fills in where no written rule covers the material (§1.15)');
  assert.equal(plan.usedAsByRuleId, inferred.id);
  assert.equal(store.rules.get(String(inferred.id))!.basis, 'Inferred', 'and the rule it names says it is an inference');
  // Where a written rule covers the same material, the written rule prevails, however narrowly the inference is put.
  write(root, 'docs/old/draft.md', '# Draft\n\nAn early draft of the plan.\n');
  await call('pk_write_rule', { group: 'Material rules', category: 'Recovery only', summary: 'docs/old/ looks retired.', sourceIds: agents, appliesTo: ['docs/old/'], basis: 'Inferred' });
  const written = await call('pk_write_rule', { group: 'Material rules', category: 'Reference only', summary: 'docs/ is only consulted.', excerpt: 'docs/ is only consulted; the plan lives in the tracker.', sourceIds: agents, appliesTo: ['docs/'], basis: 'Explicit' });
  await fullIntake(store, project);
  for (const rel of ['docs/PLAN.md', 'docs/old/draft.md']) {
    const s = one(store, root, rel);
    assert.equal(s.usedAs, 'Reference only', `${rel}: the project’s written rule prevails over the Keeper’s inference (§1.15)`);
    assert.equal(s.usedAsByRuleId, written.id);
  }
});

test('a Recovery only rule naming a branch covers the worktree checked out on it (CKC-04 AC-14)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-rules-git-'));
  const root = join(base, 'ledger');
  mkdirSync(root);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Ledger Dev', GIT_AUTHOR_EMAIL: 'dev@ledger.invalid', GIT_COMMITTER_NAME: 'Ledger Dev', GIT_COMMITTER_EMAIL: 'dev@ledger.invalid' };
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(root, ['init', '-q', '-b', 'main']);
  write(root, 'AGENTS.md', '# Agents\n\nThe old-ui branch is kept for recovery only.\n');
  write(root, 'docs/PLAN.md', '# Plan\n\nExport invoices as CSV.\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'Start']);
  git(root, ['branch', 'old-ui']);
  const wt = join(base, 'ledger-old-ui');
  git(root, ['worktree', 'add', '-q', wt, 'old-ui']);
  write(wt, 'docs/UI.md', '# Old UI\n\nA sidebar with every invoice.\n');
  const project = projectOf(root, [
    item('scope_main', root, { category: 'Repository', versionControl: 'git' }),
    item('scope_old_ui', wt, { category: 'Worktree', relation: 'Worktree of main repo', worktreeOf: root, versionControl: 'git', addedBy: 'keeper' }),
  ]);
  const store = ProjectStore.open('p1', mkdtempSync(join(tmpdir(), 'pk-rules-store-')));
  await fullIntake(store, project);
  const call = tools(store, project);
  const rule = await call('pk_write_rule', { group: 'Material rules', category: 'Recovery only', summary: 'The old-ui branch is kept for recovery only.', excerpt: 'The old-ui branch is kept for recovery only.', sourceIds: fileIds(store, root, 'AGENTS.md'), appliesTo: ['branch old-ui'], basis: 'Explicit' });
  await fullIntake(store, project);
  const ui = one(store, wt, 'docs/UI.md');
  assert.equal(ui.usedAs, 'History only', 'what is only on a recovery branch is history');
  assert.equal(ui.usedAsByRuleId, rule.id);
  assert.equal(one(store, root, 'docs/PLAN.md').usedAs, null, 'main is not covered');
});

test('the scope’s marks and the rules’ marks live side by side: neither overwrites the other, and the owner’s and the Keeper’s own judgements keep their place (Spec §1.1, §1.15; CKC-04 AC-13, AC-14)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-rules-both-'));
  const root = mkdtempSync(join(tmpdir(), 'ledger-'));
  write(root, 'AGENTS.md', '# Agents\n\nattic/ and vendor/pdflib/legacy/ are kept for recovery only.\n\nvendor/ holds libraries we did not write; their documents are only consulted.\n\nOnly attic/ is kept for recovery.\n');
  write(root, 'docs/PLAN.md', '# Plan\n\nExport invoices as CSV.\n');
  write(root, 'attic/old.md', '# Old\n\nPrint invoices only.\n');
  write(root, 'vendor/chartlib/README.md', '# chartlib\n\nRoadmap: 3D charts next quarter.\n');
  write(root, 'vendor/chartlib/GUIDE.md', '# Guide\n\nHow we theme the charts.\n');
  write(root, 'vendor/pdflib/README.md', '# pdflib\n\nRelease plan: 2.0 in spring.\n');
  write(root, 'vendor/pdflib/legacy/NOTES.md', '# Notes\n\nThe 1.x font loader.\n');
  const app = new App(home, { organizing: false });
  app.workspace.setSettings({ watchProjects: false });
  try {
    const added = app.addProject('Ledger', [root]);
    await app.intakeProject(added.id);
    const store = app.store(added.id);
    const id = added.id;
    // The scope decided again, then a full read with what it decided, so nothing is still being read when we look.
    const settle = async () => {
      await store.flush();
      app.rescope(id);
      await new Promise((r) => setImmediate(r));
      for (let i = 0; i < 200 && (await app.intakeProject(id)) === null; i += 1) await new Promise((r) => setTimeout(r, 25));
      await store.flush();
    };
    const get = (rel: string) => one(store, root, rel);
    const vendorItem = app.project(id).scope.find((i) => i.path.toLowerCase() === join(root, 'vendor').toLowerCase());
    assert.equal(vendorItem?.relation, 'Third-party material', 'the scope lists the vendored libraries apart');
    for (const rel of ['vendor/chartlib/README.md', 'vendor/pdflib/legacy/NOTES.md']) {
      assert.equal(get(rel).usedAs, 'Reference only', `${rel}: a third-party document is Reference only by its location`);
      assert.equal(get(rel).usedAsByScopeItemId, vendorItem!.id);
    }

    // The Keeper judges one document by hand; the owner another.
    const run = async (name: string, args: Record<string, unknown>, ownerSourceId: string | null = null) => {
      const all = keeperTools({ store, project: app.project(id), jobId: ownerSourceId ? 'job_talk' : 'job_frame', jobKind: ownerSourceId ? 'Your request' : 'Organizing', model: null, ownerSourceId } as Parameters<typeof keeperTools>[0]);
      const r = await (all.find((t) => t.name === name)!.execute as unknown as (i: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)('call', args);
      const text = r.content.map((c) => c.text).join('\n');
      assert.notEqual(r.isError, true, text);
      return JSON.parse(text) as Record<string, unknown>;
    };
    await run('pk_set_used_as', { sourceId: get('vendor/chartlib/GUIDE.md').id, usedAs: 'Design' });
    const pdfReadme = get('vendor/pdflib/README.md');
    store.sources.put({ ...pdfReadme, usedAs: 'Other', usedAsBy: 'owner', usedAsByScopeItemId: null });
    await settle();
    assert.equal(get('vendor/chartlib/GUIDE.md').usedAs, 'Design', 'the Keeper’s own judgement of a document stands over its location’s classification');
    assert.equal(get('vendor/pdflib/README.md').usedAs, 'Other', 'so does the owner’s');

    // A Recovery only rule: its places are History only by the rule, also inside the third-party location.
    const agents = fileIds(store, root, 'AGENTS.md');
    const recovery = await run('pk_write_rule', { group: 'Material rules', category: 'Recovery only', summary: 'attic/ and vendor/pdflib/legacy/ are kept for recovery only.', excerpt: 'attic/ and vendor/pdflib/legacy/ are kept for recovery only.', sourceIds: agents, appliesTo: ['attic/', 'vendor/pdflib/legacy/'], basis: 'Explicit' });
    await settle();
    assert.equal(get('attic/old.md').usedAs, 'History only');
    assert.equal(get('attic/old.md').usedAsByRuleId, recovery.id);
    const legacy = get('vendor/pdflib/legacy/NOTES.md');
    assert.equal(legacy.usedAs, 'History only', 'the project’s written rule prevails over the classification of the location around it');
    assert.equal(legacy.usedAsByRuleId, recovery.id);
    assert.equal(legacy.usedAsByScopeItemId ?? null, null, 'and the scope’s mark goes, so the scope does not take it back');
    assert.equal(get('vendor/chartlib/README.md').usedAsByScopeItemId, vendorItem!.id, 'the rest of the location keeps the scope’s mark');
    assert.equal(get('vendor/chartlib/GUIDE.md').usedAs, 'Design');
    assert.equal(get('vendor/pdflib/README.md').usedAs, 'Other');

    // The rule narrowed to attic/: what it no longer covers goes back to what its location makes it.
    const narrower = await run('pk_write_rule', { group: 'Material rules', category: 'Recovery only', summary: 'Only attic/ is kept for recovery.', excerpt: 'Only attic/ is kept for recovery.', sourceIds: agents, appliesTo: ['attic/'], basis: 'Explicit', replaces: [recovery.id] });
    await settle();
    const back = get('vendor/pdflib/legacy/NOTES.md');
    assert.equal(back.usedAs, 'Reference only', 'no rule covers it now: its location makes it Reference only again');
    assert.equal(back.usedAsByScopeItemId, vendorItem!.id);
    assert.equal(back.usedAsByRuleId ?? null, null);
    assert.equal(get('attic/old.md').usedAsByRuleId, narrower.id);

    // A Reference only rule over the whole location says what the scope says: the scope's marks stay as they are.
    await run('pk_write_rule', { group: 'Material rules', category: 'Reference only', summary: 'vendor/ documents are only consulted.', excerpt: 'vendor/ holds libraries we did not write; their documents are only consulted.', sourceIds: agents, appliesTo: ['vendor/'], basis: 'Explicit' });
    await settle();
    for (const rel of ['vendor/chartlib/README.md', 'vendor/pdflib/legacy/NOTES.md']) {
      assert.equal(get(rel).usedAs, 'Reference only');
      assert.equal(get(rel).usedAsByScopeItemId, vendorItem!.id, `${rel}: the rule agrees, so the scope's mark is not overwritten`);
    }
    assert.equal(get('vendor/pdflib/README.md').usedAs, 'Other', 'the owner’s judgement stands over the rule');
    assert.equal(get('vendor/chartlib/GUIDE.md').usedAs, 'Reference only', 'the Keeper’s own judgement gives way to the project’s written rule (§1.15)');

    // The owner says attic/ is the project's own material: over the rule, what it holds is current material again.
    await run('pk_classify_scope', { path: 'attic', relation: 'Main project', reason: 'The owner keeps working from it.', ownerCorrection: { quote: 'attic is still ours, keep reading it' } }, 'src_owner_message');
    await settle();
    assert.equal(app.project(id).scope.find((i) => i.path.toLowerCase() === join(root, 'attic').toLowerCase())?.relation, 'Main project');
    assert.equal(get('attic/old.md').usedAs, null, 'the owner’s word on the location stands over the Recovery only rule');
    assert.equal(get('attic/old.md').usedAsByRuleId ?? null, null);
  } finally {
    app.stopAll();
    await app.flushAll();
  }
});
