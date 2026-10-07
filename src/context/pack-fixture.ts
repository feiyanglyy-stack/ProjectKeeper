/**
 * A made-up project for the context-pack tests of Spec §7.1–§7.4 and §7.10 (CKC-12 AC-3, AC-4, AC-18, AC-22,
 * AC-35–AC-43; CKC-21 AC-9, AC-10), and for the sample work contexts handed to the Product architect.
 *
 * "Orchard Log" is a field notebook for small orchard growers: record tree inspections under the tree, send the co-op a
 * season report. Nothing here comes from any real project. Its assets are written straight into a store, the way the
 * organizing rounds will write them (fixture first: the owner's words and `refines` get real data from the organizing
 * method later). It holds, on purpose:
 * - the owner's words at three levels — product-wide, a goal's, an area's red line — one of them replaced by later words;
 * - a requirement that drifted from the owner's words (`Layer drift`), a decision a role set without the owner, and
 *   decisions carried out, partly carried out, and recorded as carried out by work that has not started;
 * - adjustments by the owner, by a role within its remit and by a role without the owner, one superseded by a later one;
 * - claims from a receipt, one of them contradicted by the code, and a code observation;
 * - code files, a config file, a QC report with its own code block, commits;
 * - the project's rules in all three groups, one inferred, one replaced, one set without the owner, one obsolete;
 * - history (CKC-12 AC-35): a removed requirement and work item that current work still rests on, the change that took
 *   them out, a history-only source and a change record built only from history — never current content, given as
 *   lineage where they bear on the work — and a mark on a removed object, which no pack writes;
 * - two records that disagree: a plan recorded as done over unfinished work, and one task number on two work items.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../store/project-store.ts';
import type {
  Attribution, ChangeItem, ChangeRecord, EntryMark, FactRecord, GraphRelation, JobInputs, Note, ObjectJudgement, Project,
  ProjectRule, ReferenceItem, Source, Statement, WorkThread,
} from '../model/types.ts';
import type { ChangeEffect, ChangeMaterial, Identity, MaterialRule, Progress, ReferenceCategory, RuleGroup } from '../model/vocab.ts';

export const ORCHARD_ID = 'p_orchard';
export const ORCHARD_AT = '2026-09-12T08:00:00.000Z';
const READ_AT = '2026-09-11T20:00:00.000Z';
const HEAD = 'c0ffee5a1b2c3d4e5f60718293a4b5c6d7e8f901';
/** Where the invented project lies: a rooted path of the system the tests run on, so that what is under it is under it
 *  there too. `D:\orchard` is a path on Windows and one odd file name anywhere else. */
export const ORCHARD_ROOT = process.platform === 'win32' ? 'D:\\orchard' : '/orchard';
const ROOT = ORCHARD_ROOT;

/** What the owner said, word for word, as the sessions hold it. */
export const WORDS = {
  underAMinute: 'An inspection has to be done in under a minute, standing under the tree, with one hand free.',
  csv: 'The season report is a CSV the co-op can open in a spreadsheet.',
  pdfLine1: 'The co-op stopped taking CSV. The season report is a PDF with every inspected tree on it, each with the date it was inspected.',
  pdfLine2: 'And never round the counts: the co-op pays per tree.',
  forWhom: 'Orchard Log is for growers with ten to two hundred trees, not for estates.',
  redLine: 'Nothing that leaves the device may show where a grower’s trees stand unless the grower has said yes.',
  noSignal: 'It has to save with no signal — the orchards have none.',
  todayCount: 'I want to see how many trees I did today, on the first screen.',
} as const;

/** The code files' own lines. None of them may reach an execution agent through a pack, an original or an answer (D65). */
export const CODE_LINES = {
  build: [
    "import { renderPdf } from './pdf';",
    'export function buildSeasonReport(trees: InspectedTree[]): SeasonReport {',
    '  const pages = chunk(trees, BATCH_SIZE);',
    '  const counts = pages.map((p) => Math.round(p.length / 10) * 10);',
    '  return { pages, counts, file: renderPdf(pages, counts) };',
    '}',
  ],
  form: [
    "export const FORM_FIELDS = ['tree', 'health', 'fruit', 'pests', 'note'] as const;",
    'export function saveInspection(entry: Inspection): void { outbox.push(entry); }',
  ],
  config: ['{', '  "batchSize": 500,', '  "roundCounts": true', '}'],
} as const;

/** A QC report's own code block: the report's text, given like any other original (Spec §7.1). */
export const QC_BLOCK_LINE = 'node scripts/sample-report.js --trees 40 --check-dates';

const inputs: JobInputs = { jobId: 'fixture', sourceIds: [], factRecordIds: [], threadIds: [], areaIds: [], referenceIds: [], noteIds: [], location: 'Orchard Log' };
const OWNER: Attribution = { author: { kind: 'owner', name: null, window: null, host: null, model: null }, holder: null, identity: 'Decision' };
const role = (name: string, identity: Identity = 'Artifact', holder: string | null = null): Attribution =>
  ({ author: { kind: 'role', name, window: null, host: null, model: null }, holder: holder ? { role: holder, window: null } : null, identity });

export const orchardProject: Project = {
  id: ORCHARD_ID, name: 'Orchard Log', locations: [ROOT],
  scope: [{ id: 'scope_main', path: ROOT, category: 'Repository', relation: 'Main project', reason: 'the project the owner added', reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'git', missing: null, addedBy: 'owner' }],
  scopeQuestions: [], keeperFiles: [], roles: ['Lead', 'Builder', 'Checker'], language: 'en', organizingPaused: false,
  createdAt: '2026-09-01T00:00:00.000Z', lastOpenedAt: null, lastScopedAt: null,
};

function fileSource(id: string, rel: string, heading: readonly string[], lines: readonly [number, number], excerpt: string, over: Partial<Source> = {}): Source {
  const path = join(ROOT, ...rel.split('/'));
  return {
    id, projectId: ORCHARD_ID, title: heading.length ? heading[heading.length - 1]! : rel.split('/').pop()!,
    anchor: { kind: 'file', path, headingPath: heading, lineStart: lines[0], lineEnd: lines[1] }, ids: [],
    version: { fingerprint: `sha256:${id}`, readAt: READ_AT, commit: HEAD }, excerpt, usedAs: null, usedAsBy: null,
    availability: null, movedTo: null, scopeItemId: 'scope_main', hasCredential: false, bytes: excerpt.length, ...over,
  };
}
function sessionSource(id: string, sessionId: string, at: string, excerpt: string): Source {
  return {
    id, projectId: ORCHARD_ID, title: `Owner session ${at.slice(0, 10)}`,
    anchor: { kind: 'session', host: 'claude', sessionId, file: `C:\\sessions\\${sessionId}.jsonl`, cwd: ROOT, messageStart: 4, messageEnd: 9, at },
    ids: [], version: { fingerprint: `sha256:${id}`, readAt: READ_AT, commit: null }, excerpt, usedAs: 'Session', usedAsBy: 'keeper',
    availability: null, movedTo: null, scopeItemId: 'scope_main', hasCredential: false, bytes: excerpt.length,
  };
}
function commitSource(id: string, hash: string, subject: string, author: string, at: string, files: readonly string[]): Source {
  const excerpt = `${subject}\n\nauthor: ${author}\nat: ${at}\nfiles:\n${files.map((f) => `  ${f}`).join('\n')}`;
  return {
    id, projectId: ORCHARD_ID, title: `${hash.slice(0, 8)} ${subject}`, anchor: { kind: 'commit', repo: ROOT, commit: hash }, ids: [],
    version: { fingerprint: `sha256:${id}`, readAt: READ_AT, commit: hash }, excerpt, usedAs: 'Code', usedAsBy: 'keeper',
    availability: null, movedTo: null, scopeItemId: 'scope_main', hasCredential: false, bytes: excerpt.length,
  };
}
function ref(id: string, category: ReferenceCategory, name: string, text: string, over: Partial<ReferenceItem> = {}): ReferenceItem {
  return {
    id, projectId: ORCHARD_ID, category, name, ids: [], text, quote: null, basis: 'Explicit', validity: 'Current', progress: null,
    attribution: role('Lead'), sourceIds: [], refines: [], replacedBy: null, inputs: null, asOf: ORCHARD_AT, updatedAt: ORCHARD_AT, ...over,
  };
}
function ownerWords(id: string, name: string, quote: string, sourceId: string, over: Partial<ReferenceItem> = {}): ReferenceItem {
  return ref(id, "Owner's words", name, name, { quote, attribution: OWNER, sourceIds: [sourceId], ...over });
}
function work(id: string, title: string, progress: Progress, serves: readonly (string | readonly [string, string])[], over: Partial<WorkThread> = {}): WorkThread {
  return {
    id, projectId: ORCHARD_ID, title, ids: [title.split(' · ')[0]!], doing: '', changed: '', results: '', unresolved: '',
    executionFacts: [], qcFacts: [], factRecordIds: [],
    serves: serves.map((s) => (typeof s === 'string' ? { referenceId: s, claim: '', basis: 'Explicit' as const } : { referenceId: s[0], claim: s[1], basis: 'Explicit' as const })),
    dependsOn: [], progress, validity: 'Current', replacedBy: null,
    attribution: { author: { kind: 'unknown', name: null, window: null, host: null, model: null }, holder: null, identity: 'Artifact' },
    inputs, asOf: ORCHARD_AT, updatedAt: ORCHARD_AT, pendingSourceIds: [], ...over,
  };
}
function rule(id: string, group: RuleGroup, category: MaterialRule | null, summary: string, over: Partial<ProjectRule> = {}): ProjectRule {
  return {
    id, projectId: ORCHARD_ID, group, category, summary, excerpt: null, sourceIds: ['src_agents'], appliesTo: [], basis: 'Explicit',
    validity: 'Current', replacedBy: null, ownerSystem: null, differsInPractice: [], ownerConfirmation: null, jobId: null, asOf: ORCHARD_AT, updatedAt: ORCHARD_AT, ...over,
  };
}
function item(id: string, at: string, material: ChangeMaterial, effect: ChangeEffect, title: string, summary: string, by: Attribution, affects: readonly string[], sourceIds: readonly string[], why: string | null, before: string | null = null, after: string | null = null): ChangeItem {
  return { id, at, atSource: 'material', material, effect, title, summary, before, after, sourceIds, by, why, affects };
}
function change(id: string, label: string, items: readonly ChangeItem[]): ChangeRecord {
  const first = items[0]!;
  return {
    id, projectId: ORCHARD_ID, at: first.at, atSource: 'material', material: first.material, effect: first.effect, title: label,
    summary: first.summary, before: null, after: null, sourceIds: [...new Set(items.flatMap((i) => i.sourceIds))], by: first.by,
    affects: [...new Set(items.flatMap((i) => i.affects))], propagation: [], segment: null, createdInJobId: null, updatedAt: first.at,
    work: { kind: 'Session', label, sessionId: null, startedAt: first.at, endedAt: first.at, openEnded: false }, items, notJudged: [],
  };
}
function mark(id: string, kind: EntryMark['kind'], targetId: string, clue: string, clueSourceIds: readonly string[], over: Partial<EntryMark> = {}): EntryMark {
  return { id, projectId: ORCHARD_ID, kind, targetId, clueSourceIds, clue, since: ORCHARD_AT, noteId: null, closed: null, ...over };
}
function relation(id: string, type: GraphRelation['type'], from: string, to: string, claim: string, sourceIds: readonly string[]): GraphRelation {
  return { id, projectId: ORCHARD_ID, type, from, to, claim, basis: 'Explicit', evidence: { sourceIds, factRecordIds: [], factsSoFar: '' }, assessment: 'Not assessed', assessedAt: null, assessedInJobId: null, updatedAt: ORCHARD_AT };
}
const claimed = (id: string, text: string, who: string, at: string, sourceIds: readonly string[]): Statement => ({ id, type: 'Claimed', text, sourceIds, claimedBy: { who, at, untrustedRuleId: null } });
const observed = (id: string, text: string, sourceIds: readonly string[]): Statement => ({ id, type: 'Observed', text, sourceIds });

/** The section titles of a pack, in order. */
export function headings(md: string): string[] {
  return md.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim());
}
/** One section's body (without its title), or '' when the pack has no such section. */
export function sectionOf(md: string, title: string): string {
  const start = md.indexOf(`\n## ${title}\n`);
  if (start < 0) return '';
  const body = md.slice(start + title.length + 5);
  const end = body.indexOf('\n## ');
  return end < 0 ? body : body.slice(0, end);
}

/** The Orchard Log assets in a fresh store (a temporary home unless one is given). */
export function orchardStore(home: string = mkdtempSync(join(tmpdir(), 'pk-orchard-'))): ProjectStore {
  const store = ProjectStore.open(ORCHARD_ID, home);

  // ── sources ──
  store.sources.putMany([
    sessionSource('src_sess_0901', 'a1f0-0901', '2026-09-01T09:12:00.000Z', `Owner: ${WORDS.underAMinute}\nOwner: ${WORDS.forWhom}\nOwner: ${WORDS.noSignal}\nOwner: ${WORDS.todayCount}`),
    sessionSource('src_sess_0903', 'b2e1-0903', '2026-09-03T14:05:00.000Z', `Owner: ${WORDS.csv}\nOwner: ${WORDS.redLine}`),
    sessionSource('src_sess_0906', 'c3d2-0906', '2026-09-06T10:30:00.000Z', `Owner: ${WORDS.pdfLine1}\n${WORDS.pdfLine2}\nOwner: and the form has to work for left-handed growers too.`),
    fileSource('src_prd_intro', 'docs/PRD.md', ['1 · Product'], [1, 12], 'Orchard Log is a field notebook for small orchard growers.'),
    fileSource('src_prd_a1', 'docs/PRD.md', ['2 · Inspections'], [13, 39], 'Inspections: a short form under the tree.'),
    fileSource('src_prd_req3', 'docs/PRD.md', ['3 · Season reports', 'REQ-3'], [40, 58], 'REQ-3: the PDF lists each inspected tree with its date; counts per page are rounded to the nearest ten.'),
    fileSource('src_plan', 'docs/PLAN.md', ['Plan'], [1, 40], 'P1 · Field inspections — done. P2 · Season reports — in progress.'),
    fileSource('src_tasks', 'docs/TASKS.md', ['Tasks'], [1, 30], '| R-7 | Build the season report | In progress |\n| R-8 | Send the report to the co-op server | Planned |'),
    fileSource('src_decisions', 'docs/DECISIONS.md', ['DEC-4'], [30, 41], 'DEC-4 (Lead, 2026-09-08): reports are built in batches of 500 trees.'),
    fileSource('src_receipt', 'runs/R-7-receipt.md', ['Receipt', 'Counts'], [1, 8], 'The counts are exact; nothing is rounded. — Builder, 2026-09-10'),
    fileSource('src_receipt_trees', 'runs/R-7-receipt.md', ['Receipt', 'Trees'], [9, 16], 'The PDF lists every inspected tree with its date. — Builder, 2026-09-10'),
    fileSource('src_qc', 'runs/R-7-qc.md', ['Findings'], [1, 14], `Sample run, 40 trees:\n\n\`\`\`\n${QC_BLOCK_LINE}\n\`\`\`\n\nAll 40 trees listed with their dates.`, { usedAs: 'QC', usedAsBy: 'keeper' }),
    fileSource('src_code_build', 'app/src/report/build.ts', [], [1, 6], CODE_LINES.build.join('\n'), { usedAs: 'Code', usedAsBy: 'keeper' }),
    fileSource('src_code_form', 'app/src/inspect/form.ts', [], [1, 2], CODE_LINES.form.join('\n')),
    fileSource('src_config', 'app/report.config.json', [], [1, 4], CODE_LINES.config.join('\n')),
    commitSource('src_commit_r7', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', 'R-7: build the PDF season report', 'Builder', '2026-09-09T16:20:00+00:00', ['app/src/report/build.ts', 'app/src/report/pdf.ts']),
    commitSource('src_commit_i2', 'b2c3d4e5f60718293a4b5c6d7e8f901234567890', 'I-2: cut the inspection form to five fields', 'Builder', '2026-09-05T11:00:00+00:00', ['app/src/inspect/form.ts']),
    commitSource('src_commit_other', 'd4e5f60718293a4b5c6d7e8f9012345678901234', 'T-1: move the build to the new toolchain', 'Builder', '2026-09-11T09:00:00+00:00', ['tools/build.sh']),
    fileSource('src_crew', 'CREW.md', ['Crew'], [1, 25], 'One Lead plans; Builders build; the Checker checks every item once, on a fresh clone, before the owner sees it.'),
    fileSource('src_agents', 'AGENTS.md', ['Working here'], [1, 40], 'New tasks take the next free number in TASKS.md. Do not push to main; the Lead merges. Put what you built in dist/, named after the task.'),
    fileSource('src_handover', 'HANDOVER.md', ['Next'], [1, 10], 'R-5 went through review twice; the second round was the Lead’s.'),
    fileSource('src_vendor', 'docs/vendor-pdf/api.md', ['Pages'], [1, 30], 'renderPdf(pages) renders one page per item.', { usedAs: 'Reference only', usedAsBy: 'keeper', usedAsByRuleId: 'rule_vendor' }),
    fileSource('src_old_export', 'docs/old/export-v1.md', ['Layout'], [1, 20], 'HISTORY-ONLY-TEXT: the v1 export put every tree on one CSV line.', { usedAs: 'History only', usedAsBy: 'keeper', usedAsByRuleId: 'rule_recovery' }),
    fileSource('src_sync_gone', 'docs/SYNC.md', ['Sync'], [1, 12], 'REMOVED-TEXT: two-way sync with the co-op server.', { availability: 'No longer available' }),
    fileSource('src_build_doc', 'docs/BUILD.md', ['Pipeline'], [1, 18], 'The build runs through the new toolchain script.'),
    fileSource('src_layout_v1', 'docs/LAYOUT-v1.md', ['Layout'], [1, 16], 'The first report layout: one table, no dates.'),
  ]);

  // ── the owner's words and the product reference hanging from them ──
  store.reference.putMany([
    ownerWords('ref_ow_minute', 'Inspections take under a minute', WORDS.underAMinute, 'src_sess_0901'),
    ownerWords('ref_ow_csv', 'The season report is a CSV', WORDS.csv, 'src_sess_0903', { validity: 'Replaced', replacedBy: 'ref_ow_pdf' }),
    ownerWords('ref_ow_pdf', 'The season report is a PDF with exact counts', `${WORDS.pdfLine1}\n${WORDS.pdfLine2}`, 'src_sess_0906'),
    ownerWords('ref_ow_whom', 'For small growers, not estates', WORDS.forWhom, 'src_sess_0901'),
    ownerWords('ref_ow_redline', 'Tree locations leave the device only with a yes', WORDS.redLine, 'src_sess_0903'),
    ref('ref_product', 'Product', 'Orchard Log', 'A field notebook for small orchard growers: record tree inspections in the field and send the co-op a season report it accepts.', { attribution: role('Lead'), sourceIds: ['src_prd_intro'], refines: ['ref_ow_whom'] }),
    ref('ref_g1', 'Goal', 'G1 · Record an inspection in under a minute', 'A grower records a tree’s inspection before walking to the next tree.', { ids: ['G1'], sourceIds: ['src_prd_a1'], refines: ['ref_product', 'ref_ow_minute'] }),
    ref('ref_g2', 'Goal', 'G2 · Send the co-op a season report it accepts', 'The co-op pays on the season report, so it has to accept it as sent.', { ids: ['G2'], sourceIds: ['src_prd_req3'], refines: ['ref_product'] }),
    ref('ref_g3', 'Goal', 'G3 · Keep the app buildable by one person', 'One person can build and ship the app.', { ids: ['G3'], sourceIds: ['src_build_doc'], refines: ['ref_product'] }),
    ref('ref_a1', 'Area', 'A1 · Inspections', 'Recording an inspection under the tree.', { ids: ['A1'], sourceIds: ['src_prd_a1'], refines: ['ref_g1'] }),
    ref('ref_a2', 'Area', 'A2 · Season reports', 'Building the season report and getting it to the co-op.', { ids: ['A2'], sourceIds: ['src_prd_req3'], refines: ['ref_g2', 'ref_ow_redline'] }),
    ref('ref_a3', 'Area', 'A3 · Tooling', 'The build and release tooling.', { ids: ['A3'], sourceIds: ['src_build_doc'], refines: ['ref_g3'] }),
    ref('ref_req3', 'Requirement', 'REQ-3 · The season report lists every inspected tree', 'The PDF lists each inspected tree with its inspection date; tree counts per page are rounded to the nearest ten so the summary reads easily.', { ids: ['REQ-3'], sourceIds: ['src_prd_req3'], refines: ['ref_a2', 'ref_ow_pdf'] }),
    ref('ref_des7', 'Design', 'DES-7 · Build pipeline', 'The app is built by one script on the new toolchain.', { ids: ['DES-7'], attribution: role('Builder'), sourceIds: ['src_build_doc'], refines: ['ref_a3'] }),
    ref('ref_p1', 'Plan', 'P1 · Field inspections', 'The inspection form and saving without a network.', { ids: ['P1'], progress: 'Done', sourceIds: ['src_plan'], refines: ['ref_g1'] }),
    ref('ref_p2', 'Plan', 'P2 · Season reports', 'The PDF season report, then sending it to the co-op.', { ids: ['P2'], progress: 'In progress', sourceIds: ['src_plan'], refines: ['ref_g2'] }),
    ref('ref_dec2', 'Decision', 'DEC-2 · Inspections save without a network', 'An inspection is saved on the device first and sent when there is a network.', { ids: ['DEC-2'], quote: WORDS.noSignal, attribution: OWNER, sourceIds: ['src_sess_0901'], refines: ['ref_a1'], carryOut: { status: 'Carried out', remaining: null, workIds: ['thread_i1'], evidenceSourceIds: ['src_code_form'], at: ORCHARD_AT, jobId: null } }),
    ref('ref_dec4', 'Decision', 'DEC-4 · Reports are built in batches of 500 trees', 'The report is built 500 trees at a time.', { ids: ['DEC-4'], attribution: role('Lead'), sourceIds: ['src_decisions'], refines: ['ref_a2'], carryOut: { status: 'Partly carried out', remaining: 'the summary page still counts all trees in one batch', workIds: ['thread_r7'], evidenceSourceIds: ['src_code_build'], at: ORCHARD_AT, jobId: null } }),
    ref('ref_dec5', 'Decision', 'DEC-5 · Today’s count on the first screen', 'The first screen shows how many trees were inspected today.', { ids: ['DEC-5'], quote: WORDS.todayCount, attribution: OWNER, sourceIds: ['src_sess_0901'], refines: ['ref_a1'], carryOut: { status: 'Carried out', remaining: null, workIds: ['thread_i5'], evidenceSourceIds: [], at: ORCHARD_AT, jobId: null } }),
    ref('ref_bound', 'Boundary', 'Not in v1: e-mailing the report', 'The report is not e-mailed from the app in v1.', { attribution: OWNER, sourceIds: ['src_sess_0903'], refines: ['ref_a2'] }),
    ref('ref_layout1', 'Design', 'DES-2 · First report layout', 'One table, no dates.', { ids: ['DES-2'], validity: 'Replaced', replacedBy: 'ref_req3', validityByRuleId: 'rule_obsolete', sourceIds: ['src_layout_v1'], refines: ['ref_a2'] }),
    ref('ref_photos', 'Requirement', 'REQ-11 · Photos in the season report', 'Each tree’s photo is embedded in the report.', { ids: ['REQ-11'], validity: 'Deferred', sourceIds: ['src_plan'], refines: ['ref_a2'] }),
    ref('ref_sync', 'Requirement', 'REQ-9 · Two-way sync with the co-op server', 'REMOVED-TEXT: inspections sync both ways.', { ids: ['REQ-9'], validity: 'Removed', sourceIds: ['src_sync_gone'], refines: ['ref_a2'] }),
  ]);

  // ── work ──
  store.facts.put({
    id: 'fact_r7', projectId: ORCHARD_ID, title: 'R-7 receipt and code', aboutSourceIds: ['src_receipt', 'src_vendor', 'src_code_build'],
    statements: [claimed('st_r7_exact', 'The counts are exact; nothing is rounded.', 'Builder, R-7 receipt', '2026-09-10', ['src_receipt'])],
    decisions: [], changes: [], openQuestions: ['Does the co-op accept a report split into batches?'], executionFacts: [], language: 'en', inputs, asOf: ORCHARD_AT, updatedAt: ORCHARD_AT, pendingSourceIds: [],
  } satisfies FactRecord);
  store.facts.put({
    id: 'fact_i2', projectId: ORCHARD_ID, title: 'I-2 form', aboutSourceIds: ['src_tasks', 'src_code_form'],
    statements: [], decisions: [], changes: [], openQuestions: [], executionFacts: [], language: 'en', inputs, asOf: ORCHARD_AT, updatedAt: ORCHARD_AT, pendingSourceIds: [],
  } satisfies FactRecord);
  store.threads.putMany([
    work('thread_i1', 'I-1 · Save inspections offline', 'Done', ['ref_a1', 'ref_p1']),
    work('thread_i2', 'I-2 · One-hand inspection form', 'In progress', [['ref_a1', 'lets a grower finish an inspection with one thumb'], 'ref_p1'], {
      attribution: role('Lead', 'Artifact', 'Builder'), progressByRuleId: 'rule_authority', factRecordIds: ['fact_i2'],
      doneMeans: 'Five fields, one thumb, saved in under a minute on a mid-range handset.', results: 'The form has five fields; a trial inspection takes about fifty seconds.',
      executionFacts: [observed('st_i2_fields', 'The form has five fields.', ['src_code_form']), claimed('st_i2_time', 'A trial inspection takes about fifty seconds.', 'Builder, I-2 note', '2026-09-05', ['src_tasks'])],
    }),
    work('thread_i4', 'I-4 · A photo per tree', 'Done', ['ref_a1']),
    work('thread_i4b', 'I-4 · Photos (from the hand-over)', 'Planned', ['ref_a1'], { ids: ['I-4'] }),
    work('thread_i5', 'I-5 · Today’s count on the first screen', 'Planned', ['ref_a1']),
    work('thread_r7', 'R-7 · Build the season report', 'In progress', [['ref_req3', 'lists every inspected tree for the co-op'], 'ref_p2'], {
      attribution: role('Lead', 'Artifact', 'Builder'), progressByRuleId: 'rule_authority', factRecordIds: ['fact_r7'],
      doneMeans: 'The PDF lists every inspected tree with its date and exact counts, and the co-op’s sample file opens.',
      results: 'The PDF builds for the 40-tree sample; the summary page is in place.', unresolved: 'Whether the counts are exact is in question.',
      executionFacts: [
        claimed('st_r7_exact', 'The counts are exact; nothing is rounded.', 'Builder, R-7 receipt', '2026-09-10', ['src_receipt']),
        claimed('st_r7_every', 'The PDF lists every inspected tree with its date.', 'Builder, R-7 receipt', '2026-09-10', ['src_receipt_trees']),
        observed('st_r7_batches', 'The report is built one batch of pages at a time.', ['src_code_build']),
      ],
      qcFacts: [observed('st_r7_qc', 'The Checker’s run of the 40-tree sample listed all 40 trees with their dates.', ['src_qc'])],
    }),
    work('thread_r8', 'R-8 · Send the report to the co-op server', 'Planned', ['ref_a2', 'ref_p2', 'ref_sync'], {
      dependsOn: [{ threadId: 'thread_r7', claim: 'needs the finished report', basis: 'Explicit' }, { threadId: 'thread_s1', claim: 'needs the sync engine', basis: 'Explicit' }],
    }),
    work('thread_s1', 'S-1 · Sync engine', 'In progress', ['ref_sync'], { validity: 'Removed', doing: 'REMOVED-TEXT: the sync engine.' }),
    work('thread_t1', 'T-1 · Move the build to the new toolchain', 'In progress', ['ref_des7']),
    work('thread_r2', 'R-2 · CSV export', 'Done', ['ref_a2'], { validity: 'Replaced', replacedBy: 'thread_r7' }),
  ]);

  // ── the project's rules ──
  store.rules.putMany([
    rule('rule_crew', 'How work is organized', null, 'Multi-agent: a Lead plans, Builders implement, and a Checker reviews each item once before the owner sees it', {
      ownerSystem: 'Crew handbook', sourceIds: ['src_crew'], excerpt: 'One Lead plans; Builders build; the Checker checks every item once, on a fresh clone, before the owner sees it.',
      differsInPractice: [{ text: 'R-5 went through review twice, the second round by the Lead', sourceIds: ['src_handover'] }],
    }),
    rule('rule_qc', 'How work is organized', null, 'Independent QC: one round by the Checker, on a fresh clone of the repository', { ownerSystem: 'Crew handbook', sourceIds: ['src_crew'], excerpt: 'the Checker checks every item once, on a fresh clone', appliesTo: ['Review'] }),
    rule('rule_who', 'How work is organized', null, 'The Lead sets the order of tasks; product scope and anything a grower sees is the owner’s call', { basis: 'Inferred', sourceIds: ['src_decisions', 'src_handover'] }),
    rule('rule_numbers', 'Working rules', null, 'Task numbers come from docs/TASKS.md; the next free number is R-9', { appliesTo: ['docs/TASKS.md'], excerpt: 'New tasks take the next free number in TASKS.md.' }),
    rule('rule_push', 'Working rules', null, 'Builders never push to main; the Lead merges', { appliesTo: ['main branch'], excerpt: 'Do not push to main; the Lead merges.' }),
    rule('rule_push_old', 'Working rules', null, 'Builders push straight to main', { validity: 'Replaced', replacedBy: 'rule_push' }),
    rule('rule_deliver', 'Working rules', null, 'A finished build goes into dist/, named after its task', { appliesTo: ['Builder'], excerpt: 'Put what you built in dist/, named after the task.' }),
    rule('rule_findings', 'Working rules', null, 'The Checker files findings in runs/<task>-qc.md', { appliesTo: ['Checker'] }),
    rule('rule_skip', 'Working rules', null, 'The Checker may skip the review of a one-line fix', { appliesTo: ['Checker'], sourceIds: ['src_handover'] }),
    rule('rule_vendor', 'Material rules', 'Reference only', 'docs/vendor-pdf/ is the PDF library’s own documentation, for reference only', { appliesTo: ['docs/vendor-pdf/'] }),
    rule('rule_recovery', 'Material rules', 'Recovery only', 'The archive branch and docs/old/ are kept for recovery only', { appliesTo: ['archive branch', 'docs/old/'] }),
    rule('rule_authority', 'Material rules', 'Authoritative', 'The Status column of docs/TASKS.md decides a task’s progress', { appliesTo: ['docs/TASKS.md'], sourceIds: ['src_tasks'] }),
    rule('rule_untrusted', 'Material rules', 'Untrusted', 'Receipts signed “auto” were written by a script and are unverified', { appliesTo: ['runs/'] }),
    rule('rule_obsolete', 'Material rules', 'Obsolete', 'The first report layout (docs/LAYOUT-v1.md) is withdrawn; REQ-3 replaces it', { appliesTo: ['docs/LAYOUT-v1.md'] }),
    rule('rule_open', 'Material rules', 'Declared open', 'Whether season reports go out weekly or once at the end of the season is still open', { appliesTo: ['season reports'] }),
  ]);

  // ── what changed on the way ──
  const by = { lead: role('Lead'), builder: role('Builder'), owner: OWNER };
  store.changes.putMany([
    change('chg_round', 'Lead session, 5 Sep', [item('it_round', '2026-09-05', 'Decision', 'Added', 'Counts on the summary page are rounded to tens', 'The summary page rounds each count to the nearest ten.', by.lead, ['ref_req3'], ['src_prd_req3'], 'the summary read badly with odd counts')]),
    change('chg_ow_pdf', 'Owner session, 6 Sep', [item('it_pdf', '2026-09-06', 'Owner statement', 'Replaced', 'The season report becomes a PDF; CSV is dropped', 'The owner said the co-op no longer takes CSV and that the counts must never be rounded.', by.owner, ['ref_ow_pdf', 'ref_ow_csv', 'ref_req3'], ['src_sess_0906'], 'the co-op stopped taking CSV and pays per tree', 'a CSV the co-op opens in a spreadsheet', 'a PDF listing every inspected tree with its date, counts exact')]),
    change('chg_photos', 'Lead session, 7 Sep', [item('it_photos', '2026-09-07', 'Plan update', 'Deferred', 'Photos leave the season report for P3', 'R-7 no longer embeds photos; REQ-11 moves to P3.', by.lead, ['thread_r7', 'ref_photos'], ['src_plan'], 'the PDF grew past 20 MB on the 40-tree sample', 'photos embedded in the PDF', 'no photos; REQ-11 deferred to P3')]),
    change('chg_dec4', 'Lead session, 8 Sep', [item('it_dec4', '2026-09-08', 'Decision', 'Added', 'DEC-4: reports are built in batches of 500 trees', 'The report is built 500 trees at a time.', by.lead, ['ref_dec4', 'thread_r7'], ['src_decisions'], 'the PDF library runs out of memory past 600 pages')]),
    change('chg_code_r7', 'Builder run, 9 Sep', [item('it_code_r7', '2026-09-09', 'Code change', 'Added', 'The PDF season report is built', 'report/build.ts and report/pdf.ts build the PDF.', by.builder, ['thread_r7'], ['src_commit_r7'], 'R-7 needs the PDF path')]),
    change('chg_form', 'Lead session, 4 Sep', [item('it_form', '2026-09-04', 'Decision', 'Replaced', 'The inspection form goes from nine fields to five', 'Four fields leave the form.', by.lead, ['thread_i2'], ['src_plan'], 'the nine-field form took two minutes in the field trial', 'nine fields', 'five fields')]),
    change('chg_mirror', 'Owner session, 6 Sep (form)', [item('it_mirror', '2026-09-06', 'Owner statement', 'Corrected', 'The form works for left-handed growers too', 'The owner asked for the form to work with either hand.', by.owner, ['ref_a1', 'thread_i2'], ['src_sess_0906'], 'left-handed growers could not reach the save button')]),
    change('chg_code_i2', 'Builder run, 5 Sep', [item('it_code_i2', '2026-09-05', 'Code change', 'Added', 'The five-field form is built', 'inspect/form.ts has the five fields.', by.builder, ['thread_i2'], ['src_commit_i2'], 'the field trial')]),
    change('chg_done_i1', 'Builder run, 2 Sep', [item('it_done_i1', '2026-09-02', 'Status report', 'Completed', 'Offline save is done', 'I-1 is finished.', by.builder, ['thread_i1'], ['src_tasks'], null)]),
    change('chg_history', 'History, November', [item('it_history', '2025-11-03', 'Decision', 'Replaced', 'HISTORY-ONLY-CHANGE: the v1 export layout was dropped', 'HISTORY-ONLY-TEXT', by.lead, [], ['src_old_export'], null)]),
    change('chg_sync_gone', 'Lead session, 4 Sep (sync)', [item('it_sync_gone', '2026-09-04', 'Plan update', 'Abandoned', 'Sync leaves the plan', 'Two-way sync and its engine leave the plan.', by.lead, ['ref_sync', 'thread_s1'], ['src_plan'], 'the co-op server takes no uploads')]),
  ]);
  // The round that judged R-7 closed the rounding item: the owner's later words superseded it (Spec §2.10).
  store.rounds.put({ id: 'round_1', projectId: ORCHARD_ID, number: 1, startedAt: ORCHARD_AT, endedAt: ORCHARD_AT, mainJobId: null, result: null });
  store.propagation.put({
    id: 'round_1:thread_r7', projectId: ORCHARD_ID, nodeId: 'thread_r7', roundId: 'round_1', state: 'Updated', sourceOrReason: 'R-7 follows the owner’s PDF words',
    covers: [{ changeId: 'chg_round', itemId: 'it_round' }], followed: [], lacks: [],
    closed: [{ changeId: 'chg_round', itemId: 'it_round', close: 'Superseded by a later change', reason: 'the owner said never round the counts', supersededByChangeId: 'chg_ow_pdf' }],
    objectUpdatedAt: ORCHARD_AT, jobId: null, at: ORCHARD_AT,
  } satisfies ObjectJudgement);

  // ── relations, marks, notes ──
  store.relations.putMany([
    relation('rel_impl_r7', 'implements', 'src_code_build', 'thread_r7', 'builds the season report PDF (buildSeasonReport)', ['src_code_build']),
    relation('rel_config_r7', 'implements', 'src_config', 'thread_r7', 'sets the batch size and whether counts are rounded (batchSize, roundCounts)', ['src_config']),
    relation('rel_qc_r7', 'verifies', 'src_qc', 'thread_r7', 'the Checker’s 40-tree sample run', ['src_qc']),
    relation('rel_impl_i2', 'implements', 'src_code_form', 'thread_i2', 'the inspection form and its save (FORM_FIELDS, saveInspection)', ['src_code_form']),
    relation('rel_contra_r7', 'contradicts', 'src_code_build', 'thread_r7', 'The code rounds each page’s tree count to the nearest ten before it prints it (buildSeasonReport, app/src/report/build.ts line 4).', ['src_code_build', 'src_receipt']),
  ]);
  store.marks.putMany([
    mark('mark_drift_req3', 'Layer drift', 'ref_req3', 'REQ-3 has the counts rounded to the nearest ten; the owner said never round the counts', ['src_prd_req3', 'src_sess_0906']),
    mark('mark_stale_r7', 'Suspected stale', 'thread_r7', 'R-7’s progress rests on the receipt’s word that the counts are exact; the code rounds them', ['src_code_build']),
    mark('mark_dwo_dec4', 'Decided without owner', 'ref_dec4', 'The batch size decides what a grower with more than 500 trees gets in one report — something a grower sees, which is the owner’s call unless the crew handbook gives it to the Lead', ['src_decisions'], { decidedBy: { who: 'Lead', at: '2026-09-08' } }),
    mark('mark_dwo_skip', 'Decided without owner', 'rule_skip', 'Skipping a review changes the QC arrangement the owner set in the crew handbook', ['src_handover'], { decidedBy: { who: 'Lead', at: '2026-09-12' } }),
    mark('mark_hist_a2', 'Suspected stale', 'ref_a2', 'The area still speaks of a CSV layout the history shows was dropped', ['src_old_export']),
    mark('mark_on_removed', 'Suspected stale', 'thread_s1', 'REMOVED-MARK: the sync engine is behind', ['src_sync_gone']),
  ]);
  const note = (id: string, title: string, preview: string, mountIds: readonly string[], ask: Note['versions'][number]['ask']): Note => ({
    id, projectId: ORCHARD_ID, mount: { kind: mountIds.length ? 'node' : 'project', ids: mountIds }, status: 'Current', ownerResponse: null,
    versions: [{ version: 1, at: ORCHARD_AT, title, preview, body: { currentView: null, whyItMatters: null, facts: [], otherExplanations: null, keepAdjust: null, whatWouldSettleIt: null }, ask, judgementRecordId: 'jdg_fixture', reason: 'first' }],
    discussion: [], followUps: [], author: { agent: 'pi', model: null }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, language: 'en', updatedAt: ORCHARD_AT,
  });
  store.notes.putMany([
    note('note_round', 'Should the season report round counts?', 'REQ-3 rounds them; the owner said never round.', ['thread_r7'], 'For your decision'),
    note('note_wide', 'The co-op’s own file format may change next season', 'Nothing to do yet.', [], 'For information'),
  ]);

  store.setCoverage({ ...store.coverage, scopes: [{ id: 'project', kind: 'project', label: 'Orchard Log', coverage: 'Up to date', asOf: ORCHARD_AT, commit: null, pending: [], organizing: [], failed: [], lastRelookAt: null }] });
  return store;
}
