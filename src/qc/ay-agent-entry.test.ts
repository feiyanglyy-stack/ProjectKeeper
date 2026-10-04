/**
 * Independent QC (AY) of the execution agent's own entry (CKC-12 AC-45, AC-46; Spec §7.10): against a live workbench
 * serving the Harbor fixture with real breakpoints and send-backs, the REAL CLI is run as a subprocess.
 *
 *   - AC-45: `pk options` lists this project's lit breakpoints, open send-backs and the six things with their ids;
 *     `pk get <id>` returns a breakpoint / send-back with what it is, where, its evidence and where it stands now.
 *   - AC-46: the send-back's `Copy for agent` text embeds a `pk get` command; running it returns the same item, and
 *     the `## Copy for agent` section in that output is byte-identical to the workbench's own copy text.
 *   - Boundary (Spec §7.10): a path is refused, another project's id is named but not read.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = realpathSync(process.cwd());
// The scratch lives in the system's temp directory, not the worktree: a write that lands after cleanup would otherwise
// leave test homes in the repository, where a frozen copy of the project would take them in as material.
const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), 'qc-ay-cli-'));
process.env.PI_CODING_AGENT_DIR = join(scratch, 'pi-agent');
after(() => { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const { App } = await import('../server/app.ts');
const { HttpApp } = await import('../server/http.ts');
const { registerRoutes } = await import('../server/api.ts');
const { buildHarbor } = await import('../process/fixture.test-helpers.ts');
const { runProcess, processEngines } = await import('../process/index.ts');
const { processView, sendBackView } = await import('../server/k-views.ts');

const cli = join(workspace, 'src', 'cli.ts');

function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('node', [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const killer = setTimeout(() => child.kill('SIGTERM'), 60_000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => { clearTimeout(killer); resolvePromise({ code: code ?? 1, out, err }); });
  });
}

test('AY: the agent entry round trip (CKC-12 AC-45, AC-46, boundary)', { timeout: 300_000 }, async () => {
  const h = buildHarbor();
  // Register the fixture's project into a workspace of this home (the store and ledger are already under it).
  const { workspaceFile } = await import('../store/paths.ts');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(h.home), { recursive: true });
  writeFileSync(workspaceFile(h.home), JSON.stringify({ version: 1, projects: [h.project], settings: { port: 4870, model: null, modelBackups: [], keeperAgent: 'pi', watchProjects: false }, lastProjectId: null }));
  const app = new App(h.home);
  // The round's process step computes the breakpoint candidates and records the send-backs; since D99 a candidate lights
  // after a lane looked and the spot-check confirmed it, as two have here.
  const run = runProcess(h.store, h.project, h.ledger, null);
  assert.ok(run.breakpoints.candidates >= 2, `Harbor has breakpoint candidates: ${run.note}`);
  for (const kind of ['Findings open', 'Not merged'] as const) {
    const b = h.store.breakpoints.find((x) => x.kind === kind && !x.lit && !x.out)!;
    h.store.breakpoints.put({ ...b, lit: true, looked: { roundId: 'crd_1', jobId: 'job_lane', where: ['subagent/'], at: b.updatedAt }, checked: { roundId: 'crd_1', jobId: 'job_spot', at: b.updatedAt }, confirmedInRoundId: 'crd_1' });
  }

  const http = new HttpApp();
  registerRoutes(http, app, '', '');
  const server = await http.listen(0);
  const port = server.port;
  try {
    // AC-45: the options list.
    const options = await runCli(['options', '--project', 'harbor', '--port', String(port)]);
    assert.equal(options.code, 0, options.err);
    const view = processView(h.store, h.project, { process: processEngines(app.ledger) });
    const lit = view.breakpoints.filter((b) => b.lit);
    assert.ok(lit.length >= 2, `lit breakpoints: ${lit.map((b) => `${b.kind}@${b.targetId}`).join(', ')}`);
    for (const b of lit) {
      assert.ok(options.out.includes(`${b.id} · ${b.kind}`), `pk options lists the lit breakpoint ${b.id} (${b.kind}) with its id`);
    }
    assert.ok(/Six things/.test(options.out), 'the six things are listed');
    // AC-45: a breakpoint by id — what, where, evidence, where it stands.
    const bp = lit.find((b) => b.kind === 'Findings open') ?? lit[0]!;
    const gotBp = await runCli(['get', bp.id, '--project', 'harbor', '--port', String(port)]);
    assert.equal(gotBp.code, 0, gotBp.err);
    assert.ok(gotBp.out.includes(bp.kind), `the breakpoint kind is in the brief: ${gotBp.out.slice(0, 200)}`);
    for (const e of bp.evidence.slice(0, 2)) if (e.line) assert.ok(gotBp.out.includes(e.line.slice(0, 40)), `the evidence's original line is in the brief`);

    // AC-46: the send-back's copy text and the command in it reach the same item, byte-identical.
    const sb = [...h.store.sendbacks.all()].sort((a, b) => a.id.localeCompare(b.id))[0];
    assert.ok(sb, 'Harbor has send-backs');
    const bench = sendBackView(h.store, 'harbor', sb, {});
    assert.ok(bench.copyForAgent.includes('pk get'), `the copy text carries the CLI command: ${bench.copyForAgent}`);
    const cmd = /pk get (\S+) --project (\S+)/.exec(bench.copyForAgent)!;
    assert.ok(cmd, 'the copy text names the command');
    assert.equal(cmd[1], sb.id);
    assert.equal(cmd[2], 'harbor');
    const gotSb = await runCli(['get', cmd[1]!, '--project', cmd[2]!, '--port', String(port)]);
    assert.equal(gotSb.code, 0, gotSb.err);
    const section = /## Copy for agent\n([\s\S]*?)(?:\n## |\n*$)/.exec(gotSb.out)?.[1]?.trim();
    assert.ok(section, `the brief has the Copy for agent section: ${gotSb.out.slice(0, 300)}`);
    assert.equal(section, bench.copyForAgent.trim(), 'CKC-12 AC-46: the agent reads the same copy text the owner copied, byte for byte');

    // Boundary: a path is refused; another project's id is named but not read.
    const asPath = await runCli(['get', '../harbor/docs/PLAN.md', '--project', 'harbor', '--port', String(port)]);
    assert.equal(asPath.code, 2, `a path is refused: ${asPath.err}`);
    const other = app.addProject('Elsewhere', [mkdtempSync(join(scratch, 'else-'))]);
    const cross = await runCli(['get', bp.id, '--project', other.id, '--port', String(port)]);
    assert.equal(cross.code, 4, `another project's id is not read here: ${cross.err}`);
    assert.ok(cross.err.includes('harbor'), 'and the answer says which project it belongs to');
  } finally {
    await server.close();
    app.stopAll();
  }
});
