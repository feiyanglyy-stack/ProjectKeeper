/**
 * The process engine's test project, "Harbor": an invented shipment tracker with an orchestrator's `subagent/` folder, a
 * plan in batches, decisions and a spec, built with git in a temporary directory. Every scenario of Spec §2.12 and §1.18
 * has its unit of work here; `stage2()` adds what later puts breakpoints out and moves the send-backs on.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, ProjectRule, ReferenceItem, ScopeItem, Source, WorkThread } from '../model/types.ts';
import type { ProcessExpectation } from '../model/vocab.ts';
import { Ledger } from '../ledger/index.ts';
import { ledgerPath, rebuildLedgerInPlace } from '../ledger/rebuild.ts';
import { ProjectStore } from '../store/project-store.ts';

const ENV = { GIT_AUTHOR_NAME: 'Harbor Dev', GIT_AUTHOR_EMAIL: 'dev@harbor.invalid', GIT_COMMITTER_NAME: 'Harbor Dev', GIT_COMMITTER_EMAIL: 'dev@harbor.invalid' };
export function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function write(root: string, rel: string, text: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}
export function commit(cwd: string, message: string, date: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '--allow-empty', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(cwd, ['rev-parse', 'HEAD']);
}
export function merge(cwd: string, branch: string, message: string, date: string): string {
  git(cwd, ['merge', '-q', '--no-ff', '-m', message, branch], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(cwd, ['rev-parse', 'HEAD']);
}

const prompt = (id: string, title: string, fields: Record<string, string>, body = ''): string =>
  `---\nid: "${id}"\n${Object.entries(fields).map(([k, v]) => `${k}: "${v}"`).join('\n')}\n---\n\n# ${id} — ${title}\n\n${body}\n`;

const UNITS = ['AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ', 'AK', 'AL', 'AM', 'AN', 'AO', 'AP', 'AQ', 'AR', 'AS', 'AT'];
const index = (): string => `# Harbor subagent coordination\n\n| ID | Executor | Prompt |\n| --- | --- | --- |\n${UNITS.map((u) => `| ${u} | kimi | [${u}](${u}.md) |`).join('\n')}\n`;

export interface Harbor {
  readonly root: string;
  readonly home: string;
  readonly project: Project;
  readonly c: Record<string, string>;
  ledger: Ledger;
  readonly store: ProjectStore;
  /** Rebuild the ledger (incrementally) after new commits, and reopen it. */
  rebuild(): Ledger;
}

export function buildHarbor(): Harbor {
  const base = mkdtempSync(join(tmpdir(), 'pk-process-'));
  const root = join(base, 'harbor');
  const home = join(base, 'home');
  mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  const c: Record<string, string> = {};
  const day = (d: number, h = 9) => `2026-08-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00+00:00`;

  // ── the documents: a plan in batches, decisions (one superseded), a spec still citing the old one ──
  write(root, 'README.md', '# Harbor\n\nTracks shipments.\n');
  write(root, 'docs/PLAN.md', '# Plan\n\n## Batches\n\n1. **Scanner**：扫描入口。\n2. **Map**：地图（和 3 并行）。\n3. **Alerts**：提醒。\n4. **Cleanup**：清理旧代码。\n');
  write(root, 'docs/DECISIONS.md', '# Decisions\n\n**D1 · Tracks are stored as CSV** (superseded by D2)\n\n**D2 · Tracks are stored in SQLite**\n\n**D3 · 旧的 CSV 导出在 2026-08-20 之前删掉**\n');
  write(root, 'docs/SPEC.md', '# Spec\n\n## Storage\n\nThe tracks follow D1: one CSV file per day.\n\n## Export\n\nExports go to the share sheet.\n');
  write(root, 'subagent/INDEX.md', index());
  write(root, 'src/app.ts', 'export const app = 1;\n');
  c.start = commit(root, 'Start Harbor', day(1));

  // ── AB: delivered on its branch without a receipt; the host sends it back; AC repairs it; merged together ──
  write(root, 'subagent/AB-kimi-parser.md', prompt('AB', 'parser', { executor: 'kimi', status: 'ready', report: 'D:\\\\harbor\\\\subagent\\\\reports\\\\AB-report.md' }));
  c.abDispatch = commit(root, 'subagent: dispatch AB', day(2));
  git(root, ['checkout', '-q', '-b', 'wip/AB-parser']);
  write(root, 'src/parser.ts', 'export const parse = (s: string) => s;\n');
  c.ab1 = commit(root, 'AB: add the parser', day(3));
  write(root, 'src/parser-util.ts', 'export const trim = (s: string) => s.trim();\n');
  c.ab2 = commit(root, 'feat: parser helpers', day(3, 11));
  git(root, ['checkout', '-q', 'main']);
  write(root, 'subagent/AB-kimi-parser.md', prompt('AB', 'parser', { executor: 'kimi', status: 'needs-repair', root_review: '2026-08-04, root = Claude; tests missing', report: 'D:\\\\harbor\\\\subagent\\\\reports\\\\AB-report.md' }));
  write(root, 'subagent/reports/AB-evidence-host.md', 'This is the host\'s evidence, not a QC.\nAB left no receipt; this is rebuilt from the diff.\n');
  write(root, 'subagent/AC-grok-fix-ab.md', prompt('AC', '修复 AB 的缺陷', { executor: 'grok', status: 'running', upstream: 'AB' }));
  c.abReview = commit(root, 'subagent: AB needs repair; dispatch AC', day(4));
  git(root, ['checkout', '-q', 'wip/AB-parser']);
  write(root, 'src/parser.test.ts', "import { test } from 'node:test';\ntest('parses', () => {});\n");
  c.ac1 = commit(root, 'AC: add the missing parser tests', day(5));
  git(root, ['checkout', '-q', 'main']);
  c.abMerge = merge(root, 'wip/AB-parser', 'Merge AB+AC: the parser', day(5, 12));
  write(root, 'subagent/AB-kimi-parser.md', prompt('AB', 'parser', { executor: 'kimi', status: 'complete', resolved_by: 'AC', report: 'D:\\\\harbor\\\\subagent\\\\reports\\\\AB-report.md' }));
  write(root, 'subagent/AC-grok-fix-ab.md', prompt('AC', '修复 AB 的缺陷', { executor: 'grok', status: 'complete', upstream: 'AB' }));
  write(root, 'subagent/reports/AC-report.md', 'status: submitted\n\n## 做了什么\n\nAdded the parser tests; 3/3 通过.\n');
  write(root, 'subagent/AD-kimi-qc-ab.md', prompt('AD', '独立 QC：AB', { executor: 'kimi', status: 'running', kind: 'independent QC', reviewed_commit: '' }));
  c.adDispatch = commit(root, 'subagent: AB and AC accepted; dispatch AD', day(6));
  // AD: the independent QC fails with three findings; the root comment sends F-1 and F-2 to AE, F-3 is never mentioned again.
  write(root, 'subagent/AD-kimi-qc-ab.md', prompt('AD', '独立 QC：AB', { executor: 'kimi', status: 'complete', kind: 'independent QC', reviewed_commit: c.abMerge.slice(0, 7) }));
  write(root, 'subagent/reports/AD-report.md', '# AD — QC report\n\n**结论：`fail`**\n\n### F-1【严重】the parser drops quoted fields\n\n### F-2【轻微】no error for an empty line\n\n### F-3【提示】the log is noisy\n\n## Root comment\n\nF-1、F-2 进 AE 修。\n');
  c.adReport = commit(root, 'subagent: AD returns fail', day(7));
  write(root, 'subagent/AE-grok-fix-ad.md', prompt('AE', '修 AD 判 fail 的缺陷', { executor: 'grok', status: 'running', upstream: 'AB -> AD' }, 'Fix F-1 and F-2 from AD.'));
  c.aeDispatch = commit(root, 'subagent: dispatch AE', day(8));
  git(root, ['checkout', '-q', '-b', 'wip/AE-fix']);
  write(root, 'src/parser.ts', 'export const parse = (s: string) => s.split(",");\n');
  c.ae1 = commit(root, 'Fix AD findings: quoted fields and empty lines', day(9));
  git(root, ['checkout', '-q', 'main']);
  c.aeMerge = merge(root, 'wip/AE-fix', 'Merge AE: parser fixes', day(9, 12));
  write(root, 'subagent/AE-grok-fix-ad.md', prompt('AE', '修 AD 判 fail 的缺陷', { executor: 'grok', status: 'complete', upstream: 'AB -> AD' }, 'Fix F-1 and F-2 from AD.'));
  c.aeDone = commit(root, 'subagent: AE complete', day(9, 13));

  // ── AG: a walkthrough that passes and leaves two items for later ──
  write(root, 'subagent/AG-grok-walkthrough.md', prompt('AG', '真机走查', { executor: 'grok', status: 'complete' }));
  write(root, 'subagent/reports/AG-report.md', 'status: submitted\n\n## 1. 登录 — pass\n\n## 2. 地图 — pass\n\n## 给 root 的缺口\n\n1. `TileCache` 离线时不刷新。\n2. 模拟器剪贴板不可靠（产品未改）。\n\n## Root comment\n\n缺口照实记下，不单开一轮。\n');
  c.agReport = commit(root, 'subagent: AG walkthrough', day(10));

  // ── AH: delivered on a branch that never merges, and marked complete ──
  write(root, 'subagent/AH-grok-export.md', prompt('AH', 'export', { executor: 'grok', status: 'running' }));
  c.ahDispatch = commit(root, 'subagent: dispatch AH', day(11));
  git(root, ['checkout', '-q', '-b', 'wip/AH-export']);
  write(root, 'src/export.ts', 'export const toCsv = () => "";\n');
  c.ah1 = commit(root, 'AH: export to CSV', day(12));
  git(root, ['checkout', '-q', 'main']);
  write(root, 'subagent/AH-grok-export.md', prompt('AH', 'export', { executor: 'grok', status: 'complete' }));
  // Its own receipt tells the state before its change in a heading: a delivery's account, not a failed check.
  write(root, 'subagent/reports/AH-report.md', 'status: submitted\n\n## Before the change — fail\n\nThe export crashed on an empty track.\n\n## After\n\nIt writes the CSV.\n');
  c.ahDone = commit(root, 'subagent: AH complete', day(12, 12));

  // ── AI: reported complete, nothing in the ledger ──
  write(root, 'subagent/AI-kimi-alerts.md', prompt('AI', 'alerts copy', { executor: 'kimi', status: 'complete' }));
  c.aiDone = commit(root, 'subagent: AI complete', day(13));

  // ── AJ: delivered and merged; the rules want an independent check and there is none ──
  write(root, 'subagent/AJ-kimi-map.md', prompt('AJ', 'map view', { executor: 'kimi', status: 'running' }));
  c.ajDispatch = commit(root, 'subagent: dispatch AJ', day(14));
  write(root, 'src/map.ts', 'export const map = 1;\n');
  c.aj1 = commit(root, 'AJ: the map view', day(14, 12));

  // ── AK → AL (QC fail) → AM (fix, merged); the rules want a re-check and there is none ──
  write(root, 'subagent/AK-kimi-sync.md', prompt('AK', 'sync', { executor: 'kimi', status: 'running' }));
  c.akDispatch = commit(root, 'subagent: dispatch AK', day(15));
  write(root, 'src/sync.ts', 'export const sync = 1;\n');
  c.ak1 = commit(root, 'AK: sync', day(15, 12));
  write(root, 'subagent/AL-kimi-qc-ak.md', prompt('AL', '独立 QC：AK', { executor: 'kimi', status: 'complete', kind: 'independent QC' }));
  write(root, 'subagent/reports/AL-report.md', '# AL — QC report\n\n**结论：`fail`**\n\n### S-1【严重】sync loses the last row\n\n### S-2【轻微】no retry\n\n### S-3【提示】naming\n\n## Root comment\n\nS-1、S-2、S-3 都进 AM 修。\n');
  c.alReport = commit(root, 'subagent: AL returns fail', day(16));
  write(root, 'subagent/AM-grok-fix-al.md', prompt('AM', '修 AL 判 fail 的缺陷', { executor: 'grok', status: 'running', upstream: 'AK -> AL' }));
  c.amDispatch = commit(root, 'subagent: dispatch AM', day(17));
  git(root, ['checkout', '-q', '-b', 'wip/AM-fix']);
  write(root, 'src/sync.ts', 'export const sync = 2;\n');
  c.am1 = commit(root, 'AM: sync keeps the last row', day(18));
  git(root, ['checkout', '-q', 'main']);
  c.amMerge = merge(root, 'wip/AM-fix', 'Merge AM: sync fixes', day(18, 12));

  // ── the plan's batches: AN (1) runs, AO (1) is only queued, AQ (4) runs early, AR ∥ AS (2a, 2b), AT (3) last ──
  write(root, 'subagent/AN-grok-scanner.md', prompt('AN', '批次 1：Scanner', { executor: 'grok', status: 'running' }));
  write(root, 'subagent/AO-grok-scanner-ui.md', prompt('AO', '批次 1：Scanner UI', { executor: 'grok', status: 'queued' }));
  c.anDispatch = commit(root, 'subagent: dispatch AN; queue AO', day(19));
  write(root, 'src/scanner.ts', 'export const scan = 1;\n');
  c.an1 = commit(root, 'AN: scanner', day(19, 12));
  write(root, 'subagent/AQ-grok-cleanup.md', prompt('AQ', '批次 4：Cleanup（提前）', { executor: 'grok', status: 'running', upstream: 'AN' }));
  c.aqDispatch = commit(root, 'subagent: dispatch AQ early', day(20));
  write(root, 'src/old.ts', '');
  c.aq1 = commit(root, 'AQ: remove the old tracker', day(20, 12));
  write(root, 'subagent/AR-grok-map-a.md', prompt('AR', '批次 2a：Map tiles', { executor: 'grok', status: 'running' }));
  write(root, 'subagent/AS-grok-map-b.md', prompt('AS', '批次 2b：Map layers', { executor: 'grok', status: 'running' }));
  c.arsDispatch = commit(root, 'subagent: dispatch AR and AS', day(21));
  git(root, ['checkout', '-q', '-b', 'wip/AR-tiles']);
  write(root, 'src/tiles.ts', 'export const tiles = 1;\n');
  c.ar1 = commit(root, 'AR: tiles', day(21, 12));
  git(root, ['checkout', '-q', 'main']);
  git(root, ['checkout', '-q', '-b', 'wip/AS-layers']);
  write(root, 'src/layers.ts', 'export const layers = 1;\n');
  c.as1 = commit(root, 'AS: layers', day(21, 13));
  git(root, ['checkout', '-q', 'main']);
  c.arMerge1 = merge(root, 'wip/AR-tiles', 'Merge AR: tiles', day(21, 18));
  git(root, ['checkout', '-q', 'wip/AR-tiles']);
  write(root, 'src/tiles.ts', 'export const tiles = 1; // cached\n');
  c.ar2 = commit(root, 'AR: cache the tiles', day(21, 20));
  git(root, ['checkout', '-q', 'main']);
  c.arMerge = merge(root, 'wip/AR-tiles', 'Merge AR: tile cache', day(22));
  c.asMerge = merge(root, 'wip/AS-layers', 'Merge AS: layers', day(22, 11));
  write(root, 'subagent/AT-grok-alerts.md', prompt('AT', '批次 3：Alerts', { executor: 'grok', status: 'running' }));
  c.atDispatch = commit(root, 'subagent: dispatch AT', day(23));
  write(root, 'src/alerts.ts', 'export const alerts = 1;\n');
  c.at1 = commit(root, 'AT: alerts', day(23, 12));

  // ── AP: merged work that traces to no plan ──
  write(root, 'subagent/AP-grok-hotpatch.md', prompt('AP', 'quick export patch', { executor: 'grok', status: 'running' }));
  c.apDispatch = commit(root, 'subagent: dispatch AP', day(24));
  write(root, 'src/patch.ts', 'export const patch = 1;\n');
  c.ap1 = commit(root, 'AP: quick export patch', day(24, 12));
  // ── AX: an independent review of AP that has not concluded (as ContextKeeper's AJ review wrote it) ──
  write(root, 'subagent/AX-kimi-review-ap.md', prompt('AX', '独立审核：AP', { executor: 'kimi', status: 'running', kind: 'independent review', reviewed_commit: c.ap1.slice(0, 7) }));
  write(root, 'subagent/reports/AX-report.md', '# AX — 独立审核报告\n\n> 状态：审核进行中；本文件会随证据收敛持续更新。若流程中断，以 `incomplete` 处理。\n\n## 结论\n\n**incomplete（审核进行中）**\n\n## 1. 导出\n\n待补。\n');
  c.axReport = commit(root, 'subagent: dispatch AX; its report so far', day(24, 18));
  c.last = commit(root, 'docs: note the patch', day(25));

  const item: ScopeItem = { id: 'harbor', path: root, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' } as ScopeItem;
  const project = { id: 'harbor', name: 'Harbor', locations: [root], scope: [item], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en', organizingPaused: false, createdAt: '2026-08-01T00:00:00Z', lastOpenedAt: null, lastScopedAt: null } as unknown as Project;
  const file = ledgerPath('harbor', home);
  rebuildLedgerInPlace(file, project, {});
  const store = ProjectStore.open('harbor', home);
  const h: Harbor = {
    root, home, project, c, store, ledger: Ledger.openPath(file)!,
    rebuild() {
      h.ledger.close();
      rebuildLedgerInPlace(file, project, {});
      h.ledger = Ledger.openPath(file)!;
      return h.ledger;
    },
  };
  seed(h);
  return h;
}

// ───────────────────────── the store: work items, the plan, the rules ─────────────────────────

const now = '2026-08-26T00:00:00Z';
const inputs = { jobId: '', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' };
const attribution = { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' } as const;

export function thread(num: string, title: string, serves: string[] = [], progress = 'Done'): WorkThread {
  return {
    id: `thr_${num}`, projectId: 'harbor', title, ids: [num], doing: '', changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [],
    serves: serves.map((referenceId) => ({ referenceId, claim: 'planned in it', basis: 'Explicit' as const })), dependsOn: [], progress, validity: 'Current', replacedBy: null,
    attribution, inputs, asOf: now, updatedAt: now, pendingSourceIds: [],
  } as unknown as WorkThread;
}

export function source(h: Harbor, id: string, rel: string, headingPath: string[], lineStart: number, lineEnd: number): Source {
  return {
    id, projectId: 'harbor', title: `${rel} § ${headingPath[headingPath.length - 1] ?? ''}`, anchor: { kind: 'file', path: join(h.root, rel), headingPath, lineStart, lineEnd },
    ids: [], version: { fingerprint: '', readAt: now, commit: null }, excerpt: '', usedAs: null, usedAsBy: null, availability: null, movedTo: null, scopeItemId: 'harbor', hasCredential: false, bytes: 0,
  } as unknown as Source;
}

export function reference(id: string, category: ReferenceItem['category'], name: string, sourceIds: string[], extra: Partial<ReferenceItem> = {}): ReferenceItem {
  return { id, projectId: 'harbor', category, name, ids: [], text: name, quote: null, basis: 'Explicit', validity: 'Current', progress: null, attribution, sourceIds, refines: [], replacedBy: null, inputs: null, asOf: now, updatedAt: now, ...extra } as ReferenceItem;
}

export function rule(id: string, expects: ProcessExpectation[], appliesTo: string[]): ProjectRule {
  return {
    id, projectId: 'harbor', group: 'How work is organized', category: null, summary: `expects ${expects.join(', ')}`, excerpt: `The project expects ${expects.join(', ')}`, sourceIds: [], appliesTo,
    basis: 'Explicit', validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], expects, ownerConfirmation: null, jobId: null, asOf: now, updatedAt: now,
  } as ProjectRule;
}

function seed(h: Harbor): void {
  const { store } = h;
  store.sources.put(source(h, 'src_plan', 'docs/PLAN.md', ['Plan', 'Batches'], 3, 9));
  store.sources.put(source(h, 'src_spec_storage', 'docs/SPEC.md', ['Spec', 'Storage'], 3, 6));
  store.sources.put(source(h, 'src_decisions', 'docs/DECISIONS.md', ['Decisions'], 1, 8));
  store.reference.put(reference('ref_plan', 'Plan', 'Harbor plan in batches', ['src_plan']));
  store.reference.put(reference('ref_storage', 'Design', 'Storage', ['src_spec_storage']));
  store.reference.put(reference('ref_d3', 'Decision', '旧的 CSV 导出在 2026-08-20 之前删掉', ['src_decisions'], { ids: ['D3'], text: '旧的 CSV 导出在 2026-08-20 之前删掉' }));
  store.sources.put({ ...source(h, 'src_owner_offline', 'README.md', [], 1, 1), title: 'claude session s1 [4]', anchor: { kind: 'session', host: 'claude', sessionId: 's1', file: 's1.jsonl', cwd: h.root, messageStart: 4, messageEnd: 4, at: '2026-08-01T10:00:00.000Z' } } as unknown as Source);
  store.reference.put(reference('ref_owner_offline', "Owner's words", 'Maps must work offline', ['src_owner_offline'], { quote: 'the maps have to work offline' }));
  for (const t of [
    thread('AB', 'Parser'), thread('AG', 'Walkthrough'), thread('AH', 'Export'), thread('AI', 'Alerts copy'), thread('AJ', 'Map view'), thread('AK', 'Sync'), thread('AP', 'Quick export patch'),
    thread('AN', 'Scanner', ['ref_plan']), thread('AO', 'Scanner UI', ['ref_plan'], 'Planned'), thread('AQ', 'Cleanup', ['ref_plan']), thread('AR', 'Map tiles', ['ref_plan']), thread('AS', 'Map layers', ['ref_plan']), thread('AT', 'Alerts', ['ref_plan']),
  ]) store.threads.put(t);
  store.rules.put(rule('rule_check', ['Independent check'], ['AB', 'AJ']));
  store.rules.put(rule('rule_recheck', ['Re-check after fix'], ['AB', 'AK']));
  store.rules.put(rule('rule_plan', ['Written plan'], ['AP', "owner's words"]));
}

/** Later material: AH merged, `TileCache` fixed, AO dispatched, a re-check of AM's fix passes, F-3 dealt with. */
export function stage2(h: Harbor): void {
  const { root, c } = h;
  const day = (d: number, hh = 9) => `2026-09-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:00:00+00:00`;
  c.ahMerge = merge(root, 'wip/AH-export', 'Merge AH: export', day(1));
  write(root, 'src/tiles.ts', 'export const tiles = 2; // TileCache refreshes offline\n');
  c.tileFix = commit(root, 'Fix TileCache offline refresh', day(2));
  write(root, 'subagent/AO-grok-scanner-ui.md', prompt('AO', '批次 1：Scanner UI', { executor: 'grok', status: 'running' }));
  c.aoDispatch = commit(root, 'subagent: dispatch AO', day(3));
  write(root, 'subagent/AU-kimi-qc-am.md', prompt('AU', '独立 QC：AM', { executor: 'kimi', status: 'complete', kind: 'independent QC' }));
  write(root, 'subagent/reports/AU-report.md', '# AU — QC report\n\n**结论：`pass`**\n');
  c.auReport = commit(root, 'subagent: AU passes AM', day(4));
  write(root, 'subagent/AV-grok-log.md', prompt('AV', '修 AD 的 F-3：日志', { executor: 'grok', status: 'running', upstream: 'AD' }, 'F-3 from AD: the log is noisy.'));
  c.avDispatch = commit(root, 'subagent: dispatch AV for F-3', day(5));
  // The owner pasted a send-back's `Copy for agent` text to the orchestrator, who opened a check for AJ carrying its id.
  write(root, 'subagent/AW-kimi-qc-aj.md', prompt('AW', '独立 QC：AJ', { executor: 'kimi', status: 'running', kind: 'independent QC' }, 'Picks up send-back sb_testaj from the workbench.'));
  c.awDispatch = commit(root, 'subagent: dispatch AW', day(6));
  h.rebuild();
}
