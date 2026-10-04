/**
 * The coverage keeps what intake could not take in (CKC-07 AC-10: each scope shows its failures with their reasons). The
 * organizing service rewrites the project scope on every pass, and it used to keep only the failed steps of a running
 * round, so a file intake had skipped vanished from the coverage at the next pass. `App.refreshCoverage` writes the same
 * coverage as the organizing service; it used to write intake's count by fact records, which the clerk method's rounds
 * no longer write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'pk-cov-home-'));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pk-cov-pi-'));

const { App } = await import('../../server/app.ts');
const { writeClerkCoverage } = await import('./service.ts');

test('a failure intake recorded stays in the coverage through the next pass and a refresh (CKC-07 AC-10)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pk-cov-app-'));
  const root = mkdtempSync(join(tmpdir(), 'pk-cov-project-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'PLAN.md'), '# Plan\n\nExport invoices as CSV.\n');
  const app = new App(home, { organizing: false });
  app.workspace.setSettings({ watchProjects: false });
  try {
    const added = app.addProject('Ledger', [root]);
    app.markTakeoverStarted(added.id, 'First picture only');   // the owner's Start (D105): adding a project starts nothing
    await app.intakeProject(added.id);
    const store = app.store(added.id);

    app.refreshCoverage(added.id);
    assert.equal(store.coverage.takeover?.stage, 'First usable', 'a refresh writes the organizing service’s coverage, takeover status included');

    const skipped = { ref: join(root, 'exports', 'huge.bin'), reason: 'Not text: binary file', at: '2026-09-27T00:00:00.000Z' };
    const scope = store.coverage.scopes.find((s) => s.id === 'project')!;
    store.setCoverage({ ...store.coverage, scopes: [{ ...scope, failed: [...scope.failed, skipped] }, ...store.coverage.scopes.filter((s) => s.id !== 'project')] });

    writeClerkCoverage(app, added.id);
    const after = store.coverage.scopes.find((s) => s.id === 'project')!;
    assert.ok(after.failed.some((f) => f.ref === skipped.ref && f.reason === skipped.reason), `intake’s failure is kept with its reason: ${JSON.stringify(after.failed)}`);
    assert.equal(after.failed.filter((f) => f.ref === skipped.ref).length, 1, 'once, not once per pass');

    app.refreshCoverage(added.id);
    assert.ok(store.coverage.scopes.find((s) => s.id === 'project')!.failed.some((f) => f.ref === skipped.ref), 'and through a refresh');
  } finally {
    app.stopAll();
    await app.flushAll();
  }
});
