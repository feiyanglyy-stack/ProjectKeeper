/**
 * D65: source code does not reach an execution agent through ProjectKeeper (Spec §7.1, §7.4, §7.6, §7.10; CKC-12
 * AC-4, AC-22, AC-43). A pack says where the code is, what changed and whether what was reported about it was checked;
 * the agent entry gives a code file's location and version, never its lines; an object page names code sources by
 * location; the Keeper answering an agent is told not to paste code. The owner's own reading in the workbench stays
 * whole, and a code block that a QC report itself contains is that report's text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleContext } from './assemble.ts';
import { nodeBrief } from './object-brief.ts';
import type { BriefNode } from './object-brief.ts';
import { CODE_LINES, ORCHARD_ROOT, QC_BLOCK_LINE, orchardProject, orchardStore, sectionOf } from './pack-fixture.ts';
import { registerRoutes } from '../server/api.ts';
import { nodeDetail } from '../server/graph-view.ts';
import { deriveGraph } from '../keeper/organize/graph.ts';
import { turnPrompt } from '../keeper/jobs/answering.ts';
import { fingerprint } from '../model/ids.ts';
import type { ContextRequest, FileAnchor } from '../model/types.ts';
import type { WorkKind } from '../model/vocab.ts';
import type { ProjectStore } from '../store/project-store.ts';

const startPack = (store: ProjectStore) =>
  assembleContext(store, orchardProject, { scope: { kind: 'project', ids: [] }, purpose: 'Start', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: null } as ContextRequest, 'Idle').markdown;
const workPack = (store: ProjectStore, id: string, kind: WorkKind = 'Implement') =>
  assembleContext(store, orchardProject, { scope: { kind: 'work', ids: [id] }, purpose: 'Work', kind, recipient: 'Incoming agent', lastSessionAt: null } as ContextRequest, 'Idle').markdown;

/** Every line of the code files that says anything (a lone brace says nothing about the code). */
const CODE = [...CODE_LINES.build, ...CODE_LINES.form, ...CODE_LINES.config].map((l) => l.trim()).filter((l) => l.length > 3);
/** All the text an answer carries, whatever its shape: every string in it, however deep. */
const allText = (x: unknown): string => (typeof x === 'string' ? x : Array.isArray(x) ? x.map(allText).join('\n') : x && typeof x === 'object' ? Object.values(x).map(allText).join('\n') : '');
const noCode = (what: string, x: unknown) => { const t = allText(x); for (const line of CODE) assert.ok(!t.includes(line), `${what} carries a line of a code file: ${line}`); };

function routes(store: ProjectStore) {
  const handlers = new Map<string, (ctx: unknown) => unknown>();
  const http = { route: (method: string, path: string, handler: (ctx: unknown) => unknown) => handlers.set(`${method} ${path}`, handler), static: () => undefined };
  const app = { project: () => orchardProject, store: () => store, workspace: { list: () => [orchardProject] } };
  registerRoutes(http as never, app as never, '', '');
  return (sid: string, reader: string | null) => handlers.get('GET /api/projects/:id/sources/:sid')!({ params: { id: orchardProject.id, sid }, query: new URLSearchParams(reader ? { for: reader } : {}), body: null }) as Record<string, unknown>;
}

test('no line of a code file reaches an agent: not in a pack, an original fetched by id, an object page or an answer’s instructions (CKC-12 AC-43, AC-22)', () => {
  // ── packs ──
  const store = orchardStore();
  const r7 = workPack(store, 'thread_r7');
  for (const [what, md] of [['the R-7 work pack', r7], ['the I-2 work pack', workPack(store, 'thread_i2')], ['R-7 for a review', workPack(store, 'thread_r7', 'Review')], ['R-7 for an investigation', workPack(store, 'thread_r7', 'Investigate')], ['the start pack', startPack(store)]] as const) noCode(what, md);

  // ── the agent entry's original of a code file: where it is and which version, never its lines ──
  const home = mkdtempSync(join(tmpdir(), 'pk-orchard-entry-'));
  const onDisk = orchardStore(home);
  const file = join(mkdtempSync(join(tmpdir(), 'pk-orchard-code-')), 'build.ts');
  writeFileSync(file, CODE_LINES.build.join('\n'));
  const code = onDisk.sources.get('src_code_build')!;
  onDisk.sources.put({ ...code, anchor: { ...(code.anchor as FileAnchor), path: file }, version: { ...code.version, fingerprint: fingerprint(readFileSync(file)) } });
  const source = routes(onDisk);
  const agentBuild = source('src_code_build', 'agent');
  noCode('the agent entry’s original of a code file', agentBuild);
  noCode('the agent entry’s original of a config file', source('src_config', 'agent'));
  const text = String(agentBuild.text ?? '');
  assert.match(text, /build\.ts/, 'where it is');
  assert.match(text, /lines 1–6/, 'which lines were read');
  assert.match(text, /commit c0ffee5a1b/, 'the version it was read at');
  assert.match(text, /Unchanged since it was read/, 'whether it changed since');
  assert.match(text, /open the current version/i, 'and to read it there');
  writeFileSync(file, `${CODE_LINES.build.join('\n')}\n// a later edit\n`);
  const changed = String(source('src_code_build', 'agent').text);
  assert.match(changed, /Changed since it was read/);
  assert.doesNotMatch(changed, /Unchanged/);

  // ── what is not code, and the owner's own reading, stay whole ──
  const qc = String(source('src_qc', 'agent').text ?? '');
  assert.ok(qc.includes(QC_BLOCK_LINE), 'a code block a QC report contains is the report’s own text');
  assert.match(qc, /\n\s*\d+ \| Sample run, 40 trees:/, 'with line numbers, as the workbench reads it (AC-22)');
  assert.equal(source('src_code_build', null).excerpt, CODE_LINES.build.join('\n'), 'the workbench’s original reading is the owner’s and stays as it was');

  // ── an object page names its code sources by location ──
  const paged = orchardStore();
  deriveGraph(paged, orchardProject);
  const page = nodeBrief(nodeDetail(paged, orchardProject, 'thread_r7') as unknown as BriefNode);
  noCode('the page of R-7 (`pk get thread_r7`)', page);
  assert.match(page, /`src_code_build`[^\n]*open the current version/i);

  // ── the Keeper answering an execution agent is told to give where and what, not the code ──
  const prompt = turnPrompt({ project: orchardProject, text: 'Why are the tree counts off by a few?', ownerSourceId: 'src_question', context: null, contextSummary: null, first: true, asker: 'agent' });
  noCode('the answering prompt', prompt);
  assert.match(prompt, /do not paste[^.]*code/i);
});

test('Code entry and recent changes gives where the code is, what changed and why, and what the code check found — no code (CKC-12 AC-4, AC-43)', () => {
  const code = sectionOf(workPack(orchardStore(), 'thread_r7'), 'Code entry and recent changes');
  // The repository as the fixture places it on this system (`D:\orchard` on Windows), then the file inside it with `/`.
  const repo = ORCHARD_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(code, new RegExp(`- ${repo} · app/src/report/build\\.ts, lines 1–6, as read at commit c0ffee5a1b[^\\n]*implements this work: builds the season report PDF \\(buildSeasonReport\\)`), 'repository, file, lines, commit and the function by name');
  assert.match(code, new RegExp(`- ${repo} · app/report\\.config\\.json, lines 1–4[^\\n]*sets the batch size and whether counts are rounded \\(batchSize, roundCounts\\)`), 'a config file by its settings’ names');
  assert.match(code, /- commit a1b2c3d4e5 · 2026-09-09 · R-7: build the PDF season report — files: app\/src\/report\/build\.ts, app\/src\/report\/pdf\.ts/);
  assert.match(code, /- 2026-09-09 · The PDF season report is built \(`chg_code_r7`\) — why: R-7 needs the PDF path/);
  assert.doesNotMatch(code, /T-1: move the build/, 'a commit of other work is not this work’s recent change');
  assert.match(code, /Reported by Builder, R-7 receipt, 2026-09-10: “The counts are exact; nothing is rounded\.” — does not hold in the code: The code rounds each page’s tree count to the nearest ten/);
  assert.match(code, /Checked in the code: The report is built one batch of pages at a time\./);
  assert.match(code, /1 more report about this work is given as reported/);
  assert.match(code, /open the current version/i);
});

test('the version check reads no code file, nothing that exists only in history and no replaced item as the current version (CKC-12 AC-43, AC-35)', () => {
  const store = orchardStore();
  const code = store.sources.get('src_code_build')!;
  store.sources.put({ ...code, excerpt: `${code.excerpt}\nexport const REPORT_FORMAT = 'v3.1';` });
  const old = store.sources.get('src_old_export')!;
  store.sources.put({ ...old, excerpt: 'HISTORY-ONLY-TEXT: export layout v1.2, every tree on one CSV line.' });
  const fact = store.facts.get('fact_r7')!;
  store.facts.put({ ...fact, aboutSourceIds: [...fact.aboutSourceIds, 'src_old_export'] });
  const g2 = store.reference.get('ref_g2')!;
  store.reference.put({ ...g2, id: 'ref_g2_old', ids: ['G2-OLD'], name: 'G2 (old) · A CSV the co-op opens', text: 'Report format v1.9: one CSV per season.', validity: 'Replaced', replacedBy: 'ref_g2' });
  const req3 = store.reference.get('ref_req3')!;
  store.reference.put({ ...req3, text: `${req3.text} (PRD v2.0)` });
  const md = assembleContext(store, orchardProject, { scope: { kind: 'work', ids: ['thread_r7'] }, purpose: 'Work', kind: 'Implement', recipient: 'Incoming agent', lastSessionAt: null, taskVersion: 'v2.0' } as ContextRequest, 'Idle').markdown;
  const check = sectionOf(md, 'Version check');
  assert.match(check, /Current material for REQ-3 · The season report lists every inspected tree: v2\.0 — same as your task/, 'the current material is checked');
  assert.doesNotMatch(check, /3\.1|build\.ts/, 'a code file is not read for its version: the agent opens the code itself (D65)');
  assert.doesNotMatch(check, /1\.2|export-v1|HISTORY-ONLY/, 'nothing that exists only in history');
  assert.doesNotMatch(check, /1\.9|G2 \(old\)/, 'a replaced item is not the current version');
});
