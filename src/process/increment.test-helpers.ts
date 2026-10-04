/**
 * "Kiln": a test project shaped like ContextKeeper's increment K as test-C-1 read it — an integration branch that
 * feature branches are merged into and that is then merged into the trunk; one feature branch carries its task number
 * (`Merge branch 'k-ledger' (AP: …)`), the others carry none (the clerk tools, a QC fix package, a fix made on the
 * integration branch itself); a QC report numbers its items (`**B13 · …**`) and later commits name them (`(QC AY B13)`);
 * the trunk's merge mentions the QC in passing (`…, QC AY fixes)`).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, ScopeItem } from '../model/types.ts';
import { Ledger } from '../ledger/index.ts';
import { ledgerPath, rebuildLedgerInPlace } from '../ledger/rebuild.ts';
import { ProjectStore } from '../store/project-store.ts';
import { commit, git, merge, thread, write } from './fixture.test-helpers.ts';

export interface Kiln {
  readonly root: string;
  readonly home: string;
  readonly project: Project;
  readonly c: Record<string, string>;
  readonly ledger: Ledger;
  readonly store: ProjectStore;
}

const prompt = (id: string, title: string, fields: Record<string, string>): string =>
  `---\nid: "${id}"\n${Object.entries(fields).map(([k, v]) => `${k}: "${v}"`).join('\n')}\n---\n\n# ${id} — ${title}\n`;

export function buildKiln(): Kiln {
  const base = mkdtempSync(join(tmpdir(), 'pk-kiln-'));
  const root = join(base, 'kiln');
  const home = join(base, 'home');
  mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  const c: Record<string, string> = {};
  const at = (d: number, h = 9) => `2026-09-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00+00:00`;

  write(root, 'README.md', '# Kiln\n\nFires pots.\n');
  write(root, 'src/app.ts', 'export const app = 1;\n');
  write(root, 'subagent/INDEX.md', '# Kiln subagents\n\n| ID | Executor | Prompt |\n| --- | --- | --- |\n| AP | kimi | [AP](AP-kimi-ledger.md) |\n| AT | sol | [AT](AT-sol-folder.md) |\n| AY | kimi | [AY](AY-kimi-qc.md) |\n');
  write(root, 'subagent/AP-kimi-ledger.md', prompt('AP', 'the ledger', { executor: 'kimi', status: 'running' }));
  c.start = commit(root, 'Start Kiln', at(1));

  // The integration branch, and a feature branch merged into it that carries its task number in the merge.
  git(root, ['checkout', '-q', '-b', 'k-int']);
  git(root, ['checkout', '-q', '-b', 'k-ledger']);
  write(root, 'src/ledger.ts', 'export const ledger = 1;\n');
  c.led1 = commit(root, 'WIP: the ledger as the first run left it', at(2));
  write(root, 'src/ledger.ts', 'export const ledger = 2;\n');
  c.led2 = commit(root, 'Finish the ledger', at(2, 12));
  git(root, ['checkout', '-q', 'k-int']);
  c.ledMerge = merge(root, 'k-ledger', "Merge branch 'k-ledger' (AP: the ledger)", at(3));

  // A feature branch with no number: the clerk tools.
  git(root, ['checkout', '-q', '-b', 'k-tools']);
  write(root, 'src/tools.ts', 'export const tools = 1;\n');
  write(root, 'src/tools.test.ts', 'import { tools } from "./tools.ts";\nconsole.log(tools);\n');
  c.tools1 = commit(root, 'Add the clerk method\'s position-writing tools', at(4));
  git(root, ['checkout', '-q', 'k-int']);
  c.toolsMerge = merge(root, 'k-tools', "Merge branch 'k-tools' (the clerk method's position writers)", at(4, 12));

  // A direct fix on the integration branch.
  write(root, 'src/app.ts', 'export const app = 2;\n');
  c.intFix = commit(root, 'Fix what the cleanup found in the planner', at(5));

  // AY: an independent QC whose report numbers its items; B13 lists low-severity leftovers.
  git(root, ['checkout', '-q', 'main']);
  write(root, 'subagent/AY-kimi-qc.md', prompt('AY', 'independent QC of increment K', { executor: 'kimi', status: 'complete', kind: 'independent QC' }));
  write(root, 'subagent/runs/AY-1/result.md', '# AY · QC of increment K\n\n**B11 · earlier plans** are not shown.\n\n**B12 · the narrow window** loses its control row.\n\n**B13 · 其余低危项**：执行安排的行数上限只静默截断；文件级语言的 basis 由模型自报。\n');
  c.ayReport = commit(root, "Record AY's verdict", at(6));
  git(root, ['checkout', '-q', 'k-int']);
  git(root, ['merge', '-q', '--no-ff', '-m', 'Merge main (AY) into k-int', 'main'], { GIT_AUTHOR_DATE: at(6, 12), GIT_COMMITTER_DATE: at(6, 12) });

  // QC AY's package A: no number of its own; its commits say which items they answer.
  git(root, ['checkout', '-q', '-b', 'k-ayfix-a']);
  write(root, 'src/ledger.ts', 'export const ledger = 3; // says N more\n');
  c.fixA1 = commit(root, 'Arrangements say how many rows they left out (QC AY B13)', at(7));
  write(root, 'src/window.ts', 'export const window = 1;\n');
  c.fixA2 = commit(root, 'Keep the narrow control row inside the window (QC AY B12)', at(7, 12));
  git(root, ['checkout', '-q', 'k-int']);
  c.fixAMerge = merge(root, 'k-ayfix-a', 'Merge k-ayfix-a (QC AY package A: rows, window)', at(8));

  // The trunk takes the integration branch; its subject mentions the QC in passing.
  git(root, ['checkout', '-q', 'main']);
  c.trunkMerge = merge(root, 'k-int', 'Merge k-int: increment K (ledger, clerk tools, QC AY fixes)', at(9));

  const item: ScopeItem = { id: 'kiln', path: root, category: 'Repository', relation: 'Main project', reason: 'test', reasonSourceIds: [], sessionHost: null, readOnly: true, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' } as ScopeItem;
  const project = { id: 'kiln', name: 'Kiln', locations: [root], scope: [item], scopeQuestions: [], keeperFiles: [], roles: [], language: 'en', organizingPaused: false, createdAt: '2026-09-01T00:00:00Z', lastOpenedAt: null, lastScopedAt: null } as unknown as Project;
  const file = ledgerPath('kiln', home);
  rebuildLedgerInPlace(file, project, {});
  const store = ProjectStore.open('kiln', home);
  for (const t of [thread('AP', 'The ledger'), thread('AY', 'Independent QC of increment K')]) store.threads.put({ ...t, projectId: 'kiln' });
  return { root, home, project, c, store, ledger: Ledger.openPath(file)! };
}
