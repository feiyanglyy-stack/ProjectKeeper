/**
 * What `Copy for agent` puts on the clipboard (Spec §1.18, §7.10; CKC-24 AC-9; D79): where the problem is, the evidence
 * — numbers, commits, files and lines, the report's own line word for word — where it should go back to, and the CLI
 * command that shows the same send-back, so the agent the owner pastes it to sees the same record the owner sees.
 *
 * The fixtures are an invented project, "Tidepool", a tide-table app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvidenceRef, SendBack } from '../model/k-types.ts';
import { materialDate } from '../model/time.ts';
import { cliCommandFor, copyForAgentText, occurredText } from './sendback-text.ts';

/** Dates are shown on the day they fall on where they are shown (model/time.ts); the expectations use the same rule. */
const day = (at: string): string => materialDate(at);

const evidence: EvidenceRef[] = [
  { kind: 'commit', id: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', label: 'a1b2c3d Deliver storm alerts', line: null, occurred: { at: '2026-09-12T02:00:00.000Z', basis: 'Commit', anchor: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' } },
  { kind: 'file', id: 'reports/qc-AF.md', label: 'reports/qc-AF.md', line: 'Verdict: FAIL — 7 findings open', occurred: { at: '2026-09-13T02:00:00.000Z', basis: 'Commit', anchor: 'ffff' } },
  { kind: 'source', id: 'src_receipt', label: 'reports/AB.md › Receipt (L1–L20)', line: 'Done: alerts\nTests: 12 passed', occurred: { at: '2026-09-26T00:00:00.000Z', basis: 'First observed', anchor: 'src_receipt', undated: true } },
  { kind: 'object', id: 'thread_ab', label: 'AB Storm alerts', line: null, occurred: null },
];

const sendBack = (over: Partial<SendBack> = {}): SendBack => ({
  id: 'sb_mz8k1', projectId: 'tidepool', to: 'Work', stage: 'Suggested', targetId: 'thread_ab',
  what: 'The storm-alert work passed with seven QC findings nobody fixed.', suggestion: 'reopen AB to fix the seven findings, then QC again',
  evidence, from: { kind: 'verdict', id: 'src_qc_af' }, returned: null, closed: null, ownerResponse: null, sixThing: 5,
  occurred: { at: '2026-09-12T02:00:00.000Z', basis: 'Commit', anchor: 'a1b2' }, roundId: 'round_1', updatedAt: '2026-09-26T00:00:00.000Z', ...over,
});

test('Copy for agent says where the problem is, gives the evidence word for word, where to send it back and the command that shows it', () => {
  const text = copyForAgentText('tidepool', sendBack(), evidence, { target: { label: 'Storm alerts', number: 'AB' } });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Send-back sb_mz8k1 · Suggested · to Work (project tidepool)');
  assert.ok(lines.includes('Where the problem is: The storm-alert work passed with seven QC findings nobody fixed.'));
  assert.ok(lines.includes('On: AB Storm alerts (thread_ab)'), 'the object with the project’s number');
  assert.ok(lines.includes(`- Commit a1b2c3d Deliver storm alerts (committed ${day('2026-09-12T02:00:00.000Z')})`), 'a commit by its short hash and subject, dated');
  assert.ok(lines.includes(`- File reports/qc-AF.md (committed ${day('2026-09-13T02:00:00.000Z')}): “Verdict: FAIL — 7 findings open”`), 'the report’s own line, word for word');
  const receipt = lines.indexOf(`- Source reports/AB.md › Receipt (L1–L20) (undated · first seen ${day('2026-09-26T00:00:00.000Z')}):`);
  assert.ok(receipt > 0, 'what nothing dates says so');
  assert.deepEqual(lines.slice(receipt + 1, receipt + 3), ['  > Done: alerts', '  > Tests: 12 passed'], 'a stretch of several lines keeps its lines');
  assert.ok(lines.includes('- Record AB Storm alerts (thread_ab)'));
  assert.ok(lines.includes('Send it back to Work — reopen the work or open new work: reopen AB to fix the seven findings, then QC again'));
  assert.equal(lines[lines.length - 1], 'See the same send-back: pk get sb_mz8k1 --project tidepool', 'the command the agent runs to see the same record');
});

test('a send-back to Plan says so, a target with no name is named by its id, and no credential leaves in the text', () => {
  const text = copyForAgentText('tidepool', sendBack({ to: 'Plan', what: 'The plan still names the nightly pull; token=abcdef1234567890abcdef is in its example.', suggestion: 'update docs/PLAN.md to the offline cache', from: { kind: 'breakpoint', id: 'bp_7' } }), []);
  const lines = text.split('\n');
  assert.ok(lines.includes('Send it back to Plan — change the plan or the document: update docs/PLAN.md to the offline cache'));
  assert.ok(lines.includes('On: thread_ab'));
  assert.ok(lines.includes(`Found as: a breakpoint in the process (bp_7) · happened: committed ${day('2026-09-12T02:00:00.000Z')}`));
  assert.ok(lines.includes('- none recorded'));
  assert.ok(!text.includes('abcdef1234567890abcdef'), 'the credential value is gone');
  assert.match(text, /\[credential redacted\]/);
});

test('evidence in another repository says which, once, whether or not its label names it', () => {
  const site = 'D:\\tidepool-site';
  const text = copyForAgentText('tidepool', sendBack(), [
    { kind: 'file', id: 'docs/PLAN.md', label: `docs/PLAN.md (in ${site})`, line: 'Launch page with the tide widget.', repo: site, occurred: null },
    { kind: 'commit', id: 'b'.repeat(40), label: 'bbbbbbb Plan the launch page', line: null, repo: site, occurred: null },
    { kind: 'file', id: 'docs/PLAN.md', label: 'docs/PLAN.md', line: null, occurred: null },
  ]);
  const lines = text.split('\n');
  assert.ok(lines.includes(`- File docs/PLAN.md (in ${site}): “Launch page with the tide widget.”`), 'a label that names the repository is printed as it is');
  assert.ok(lines.includes(`- Commit bbbbbbb Plan the launch page in ${site}`), 'one that does not gets it added');
  assert.ok(lines.includes('- File docs/PLAN.md'), 'evidence in the first repository names none');
});

test('the CLI command is the agent entry’s pk get, quoted only where it has to be', () => {
  assert.equal(cliCommandFor('tidepool', 'sb_mz8k1'), 'pk get sb_mz8k1 --project tidepool');
  assert.equal(cliCommandFor('my project', 'sb_1'), 'pk get sb_1 --project "my project"');
  assert.equal(
    occurredText({ at: '2026-09-10', basis: 'Written in text', anchor: null, other: { at: '2026-09-12T08:00:00.000Z', basis: 'Commit', anchor: 'c' } }),
    `dated in the text 2026-09-10 · committed ${day('2026-09-12T08:00:00.000Z')}`, 'two times that disagree are both said; a date stays its own day',
  );
  assert.equal(occurredText(null), null);
});
