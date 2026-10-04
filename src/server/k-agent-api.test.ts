/** The actual CLI reads the same increment K text and copy command as the workbench view. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Breakpoint, CodeTerritory, Occurred, SemanticPatch, SendBack } from '../model/k-types.ts';
import type { EntryMark, WorkThread } from '../model/types.ts';
import { App } from './app.ts';
import { HttpApp } from './http.ts';
import { registerRoutes } from './api.ts';
import { registerKAgentRoutes } from './k-agent-api.ts';
import { processView } from './k-views.ts';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));
const root = dirname(dirname(cli));
const occurred = (at: string): Occurred => ({ at, basis: 'Commit', anchor: 'ledger_commit_7' });

test('pk get and options read the saved K objects and the same Copy for agent item', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-au-home-'));
  const piDir = mkdtempSync(join(tmpdir(), 'pk-au-pi-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'pk-au-project-'));
  const otherDir = mkdtempSync(join(tmpdir(), 'pk-au-other-'));
  const app = new App(home, { organizing: false });
  const project = app.addProject('AU demo', [projectDir]);
  const other = app.addProject('Other project', [otherDir]);
  const store = app.store(project.id);
  const at = '2026-09-21T10:00:00Z';
  store.threads.put({ id: 'thread_a', projectId: project.id, title: 'Export reports', ids: ['AU-1'], doing: '', changed: '', results: '', unresolved: '', executionFacts: [], qcFacts: [], factRecordIds: [], serves: [], dependsOn: [], progress: 'In progress', validity: 'Current', replacedBy: null, attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' }, inputs: { jobId: '', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: '' }, asOf: at, updatedAt: at, pendingSourceIds: [] } satisfies WorkThread);
  store.numbers.put({ id: 'num_7', projectId: project.id, number: 'K-7', objectId: 'terr_1', objectKind: 'other', projectNumber: null, at });
  const evidence = [{ kind: 'ledger' as const, id: 'ledger_qc_7', label: 'QC verdict', line: 'Verdict: fail at src/report.ts:18', occurred: occurred('2026-09-10') }, { kind: 'source' as const, id: 'src_report_7', label: 'reports/QC.md:12', line: 'The export drops the final row.' }];
  store.breakpoints.put({ id: 'bp_1', projectId: project.id, kind: 'Findings open', targetId: 'thread_a', why: 'QC failed and no fix followed', evidence, basis: 'Explicit', since: occurred('2026-09-10'), lit: true, out: null, ownerResponse: null, confirmedInRoundId: null, sixThing: 5, sendBackId: 'sb_1', roundId: null, updatedAt: at } satisfies Breakpoint);
  store.breakpoints.put({ id: 'bp_out', projectId: project.id, kind: 'Not checked', targetId: 'thread_a', why: 'Old marker', evidence: [], basis: 'Explicit', since: occurred('2026-09-01'), lit: false, out: { at, by: 'evidence', evidence: [] }, ownerResponse: null, confirmedInRoundId: null, sixThing: null, sendBackId: null, roundId: null, updatedAt: at } satisfies Breakpoint);
  store.breakpoints.put({ ...store.breakpoints.get('bp_out')!, id: 'bp_secret', evidence: [{ kind: 'source', id: 'src_key', label: 'local config', line: 'api_key=abcdefghijklmnop12345678' }] });
  store.sendbacks.put({ id: 'sb_1', projectId: project.id, to: 'Work', stage: 'Suggested', targetId: 'thread_a', what: 'The export drops the final row', suggestion: 'Reopen AU-1 or create a fix task', evidence, from: { kind: 'breakpoint', id: 'bp_1' }, returned: null, closed: null, ownerResponse: null, sixThing: 5, occurred: occurred('2026-09-10'), roundId: null, updatedAt: at } satisfies SendBack);
  store.sendbacks.put({ id: 'sb_closed', projectId: project.id, to: 'Plan', stage: 'Closed', targetId: 'thread_a', what: 'Old plan issue', suggestion: 'Update plan', evidence: [], from: { kind: 'owner-judgement', id: 'judgement_1' }, returned: null, closed: null, ownerResponse: null, sixThing: null, occurred: occurred('2026-09-01'), roundId: null, updatedAt: at } satisfies SendBack);
  store.patches.put({ id: 'patch_1', projectId: project.id, number: 'SP-3', title: 'Export rule changed', invalidated: 'CSV only', replacedBy: 'CSV and JSON', affects: ['thread_a'], affectsText: 'the report export', mustNotPassAsCurrent: 'CSV is the only format', oldAnchor: { kind: 'source', id: 'src_old', label: 'PLAN.md:4', line: 'Export CSV only.' }, newAnchor: { kind: 'source', id: 'src_new', label: 'PLAN.md:9', line: 'Export CSV and JSON.' }, decision: { kind: 'commit', id: 'abcdef1234567890', label: 'Decision commit' }, candidate: { kind: 'ledger', id: 'ledger_sup_3', label: 'Explicit supersession', line: 'CSV only superseded by CSV and JSON.' }, partial: true, occurred: { at: '2026-09-10', basis: 'Written in text', anchor: 'src_new', other: { at: '2026-09-12', basis: 'Commit', anchor: 'ledger_sup_3' } }, status: 'Confirmed', writtenToFolder: null, roundId: null, jobId: null, updatedAt: at } satisfies SemanticPatch);
  store.territories.put({ id: 'terr_1', projectId: project.id, name: 'Report engine', summary: 'Builds the export files.', repo: 'app', paths: ['src/reports', 'src/export.ts'], kind: 'area', areaId: 'area_1', alsoServes: ['area_2'], anomalies: [{ kind: 'Docs disagree', text: 'The guide says CSV only.', evidence: [{ kind: 'ledger', id: 'ledger_code_1', label: 'Code scan', line: 'JSON exporter is live.' }], basis: 'Explicit', sendBackId: 'sb_1', noteIds: [] }], roundId: null, jobId: null, updatedAt: at } satisfies CodeTerritory);
  const markKinds: EntryMark['kind'][] = ['Suspected stale', 'Layer drift', 'Scope question', 'Undocumented decision'];
  for (const thing of [1, 2, 3, 4] as const) store.marks.put({ id: `mark_${thing}`, projectId: project.id, kind: markKinds[thing - 1]!, targetId: 'thread_a', clueSourceIds: [], clue: `thing ${thing}`, since: at, noteId: null, closed: null, sixThing: thing } satisfies EntryMark);
  // Process view tags six thing 6 from these anomaly kinds.
  store.territories.put({ ...store.territories.get('terr_1')!, anomalies: [...store.territories.get('terr_1')!.anomalies, { kind: 'Unreferenced', text: 'One old file is unreferenced.', evidence: [{ kind: 'ledger', id: 'ledger_code_2', label: 'Reference scan', line: 'No imports of old.ts.' }], basis: 'Explicit', sendBackId: null, noteIds: [] }] });
  app.store(other.id).breakpoints.put({ ...store.breakpoints.get('bp_1')!, id: 'bp_other', projectId: other.id });
  await app.flushAll();

  const http = new HttpApp();
  registerRoutes(http, app, '', '');
  registerKAgentRoutes(http, app);
  const server = await http.listen(0);
  const base = `http://127.0.0.1:${server.port}`;
  const run = async (command: string, ...parts: string[]) => exec(process.execPath, [cli, command, ...parts, '--home', home, '--project', project.id, '--port', String(server.port)], { cwd: root, timeout: 20_000, env: { ...process.env, PI_CODING_AGENT_DIR: piDir, PROJECTKEEPER_HOME: home } });
  try {
    const view = processView(store, project);
    for (const id of ['bp_1', 'sb_1', 'patch_1', 'terr_1']) {
      const response = await fetch(`${base}/api/projects/${project.id}/k-briefs/${id}`);
      assert.equal(response.status, 200);
      const { text } = await response.json() as { text: string };
      const { stdout, stderr } = await run('get', id);
      assert.equal(stderr, '');
      assert.equal(stdout.replace(/\r\n/g, '\n'), `${text}\n`, `${id}: CLI prints server text byte for byte`);
    }
    const copy = view.sendBacks.find((s) => s.id === 'sb_1')!.copyForAgent;
    const command = view.sendBacks.find((s) => s.id === 'sb_1')!.cliCommand;
    assert.ok(copy.includes('Verdict: fail at src/report.ts:18'));
    assert.ok(copy.includes(command));
    const copiedGet = command.split(' ');
    assert.equal(copiedGet[0], 'pk');
    const { stdout: copied } = await exec(process.execPath, [cli, ...copiedGet.slice(1), '--home', home, '--port', String(server.port)], { cwd: root, timeout: 20_000, env: { ...process.env, PI_CODING_AGENT_DIR: piDir, PROJECTKEEPER_HOME: home } });
    const { stdout: direct } = await run('get', 'sb_1');
    assert.equal(copied, direct, 'the command in Copy for agent fetches the same item');
    assert.ok(direct.includes(copy), 'the full workbench copy text appears unchanged in CLI output');

    for (const [alias, id] of [['SP-3', 'patch_1'], ['K-7', 'terr_1']] as const) {
      const a = await run('get', alias);
      const b = await run('get', id);
      assert.equal(a.stdout, b.stdout, `${alias} resolves to ${id}`);
    }
    const patch = (await run('get', 'SP-3')).stdout;
    assert.ok(patch.includes('Written in text 2026-09-10'));
    assert.ok(patch.includes('Commit 2026-09-12'));
    assert.ok(patch.includes('Original line: Export CSV only.'));
    const territory = (await run('get', 'terr_1')).stdout;
    assert.ok(territory.includes('the ledger is not connected yet'));
    assert.ok(territory.includes('Undated · first seen 2026-09-21'));
    const credential = (await run('get', 'bp_secret')).stdout;
    assert.ok(credential.includes('api_key=[credential redacted]'));
    assert.ok(!credential.includes('abcdefghijklmnop12345678'));

    const { stdout: options } = await run('options');
    assert.ok(options.includes('Lit breakpoints:\n- bp_1 · Findings open · on Export reports (thread_a)'));
    assert.ok(!options.includes('bp_out'));
    assert.ok(options.includes('Open send-backs:\n- sb_1 · Suggested · to Work · The export drops the final row'));
    assert.ok(!options.includes('sb_closed'));
    for (let thing = 1; thing <= 6; thing++) assert.match(options, new RegExp(`(?:^|\\n)${thing} [^\\n]+:\\n- `), `six thing ${thing} lists an object`);
    assert.ok(options.includes('- terr_1  Report engine'));

    await assert.rejects(run('get', 'missing_1'), (error: unknown) => {
      const e = error as Error & { code: number; stderr: string };
      assert.equal(e.code, 4);
      assert.ok(e.stderr.includes(`missing_1 is not an id of project ${project.id}.`));
      return true;
    });
    await assert.rejects(run('get', 'bp_other'), (error: unknown) => {
      const e = error as Error & { code: number; stderr: string };
      assert.equal(e.code, 4);
      assert.ok(e.stderr.includes(`bp_other belongs to project ${other.name} (${other.id})`));
      return true;
    });
  } finally { await server.close(); app.stopAll(); }
});
