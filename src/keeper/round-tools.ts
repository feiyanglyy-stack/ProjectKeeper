/**
 * Round tools besides the pk_* asset tools (Spec §3.3): what a Follow up round still has to judge (pk_round_pending), a
 * claim checked against the code (pk_record_code_check), and the rules a round inferred, put to the owner
 * (pk_ask_owner_about_rules). Which job is offered which tool is decided in roles.ts.
 */
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { CodeCheck, JudgementRecord, Note, NoteVersion, Source, Statement } from '../model/types.ts';
import { newId } from '../model/ids.ts';
import type { ToolContext } from './tools.ts';
import { clerkRoundOfJob, isRoundMain } from './roles.ts';
import { cameFromFor } from './note-origin.ts';
import { laneNamesOf, ownerTextRefusal } from './owner-text.ts';
import { deriveGraph } from './organize/graph.ts';
import { pendingForRound } from './organize/follow-up.ts';
import { projectRelPath } from './organize/materials.ts';
import { isDocumentPath } from '../scope/skip.ts';

/** The order claims about the code are checked in (Spec §2.4, D63; CKC-06 AC-23) — an order, not a limit. */
export const CHECK_TIER = ["Owner's words or red line", 'Done or verified', 'Other'] as const;
/** What a check of a claim against the code found. */
export const CHECK_RESULT = ['Consistent', 'Inconsistent', 'Partly consistent'] as const;
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|swift|c|cc|cpp|cxx|h|hh|hpp|cs|rb|php|scala|sh|bash|ps1|psm1|sql|vue|svelte|dart|lua|m|mm|r|jl|ex|exs|erl|hs|clj|fs|ml|zig|nim|sol|proto|gradle|json|jsonc|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|less)$/i;
/** Code, tests and the configuration they read: what a claim about the code's behaviour is checked against. */
function isCode(s: Source): boolean {
  if (s.usedAs === 'Code' || s.usedAs === 'Test') return true;
  const path = s.anchor.kind === 'file' || s.anchor.kind === 'revision' ? s.anchor.path : null;
  return path !== null && CODE_EXT.test(path) && !isDocumentPath(path);
}
const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

const text = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }], details: {} });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: `ERROR: ${message}` }], details: {}, isError: true });

export function roundTools(ctx: ToolContext): ToolDefinition[] {
  return [
    defineTool({
      name: 'pk_round_pending', label: 'What this round still has to judge',
      description: 'After recording the changes of this round\'s material (pk_write_change), the objects they reached are found by rule. This lists every object the round still has to judge — the ones given with the round and the ones your changes reached — each with the items that reached it and what it still lacks. Objects already judged in this round are not listed again.',
      parameters: Type.Object({}),
      execute: async () => {
        // The downstream of a change is seeded when the graph is derived, which otherwise happens only after a job
        // ends: without this, what the round's own changes reached would wait for the next round.
        deriveGraph(ctx.store, ctx.project);
        const pending = pendingForRound(ctx.store);
        return ok(pending.objects ? `${pending.objects} object${pending.objects === 1 ? '' : 's'} still to judge in this round:\n${pending.text}` : 'Nothing is left to judge in this round.');
      },
    }),
    codeCheckTool(ctx),
    rulesToOwnerTool(ctx),
  ];
}

/**
 * `pk_record_code_check` (Spec §2.4, D63; CKC-06 AC-23): a claim about what the code does, checked by reading the code,
 * recorded next to the claim in the report's fact record — an Observed statement anchored to the code (repository,
 * commit, file, lines), with which claim it checks, in which order and what it found. The claim itself stays as it
 * was reported. How many claims were checked, in which order and how many did not hold is counted from these.
 * Checking the same claim again replaces the earlier check.
 *
 * Where a check hangs is not settled by the PA yet (asked); this is the most conservative reading: on the fact record
 * that holds the claim, beside it, changing nothing else. What spans objects — the contradicts relation, the Suspected
 * stale mark on the status that rests on the claim — is the main job's to write, and the result tells it so.
 */
function codeCheckTool(ctx: ToolContext): ToolDefinition {
  const { store } = ctx;
  return defineTool({
    name: 'pk_record_code_check', label: 'Record a claim checked against the code',
    description: `Record the check of one claim against the code, next to the claim, in the fact record that holds it. Read the code only — never run tests, re-do QC or grade anyone. Give the fact record, the claim (its statement id, or its text as recorded), its tier in the order claims are checked (${CHECK_TIER.join(' → ')}), the result (${CHECK_RESULT.join(', ')}), the code sources you read (codeSourceIds), the lines, and what the code does, in one or two sentences. The commit is the one the source was read at unless you name another. It is written as an Observed statement anchored to the code; the claim stays Claimed. Checking the same claim again replaces the earlier check.`,
    parameters: Type.Object({
      factRecordId: Type.String({ description: 'the fact record that holds the claim (the report’s)' }),
      claim: Type.String({ description: 'the claim: its statement id, or its text as the fact record has it' }),
      tier: Type.String({ description: CHECK_TIER.join(' | ') }),
      result: Type.String({ description: CHECK_RESULT.join(' | ') }),
      codeSourceIds: Type.Array(Type.String(), { description: 'the sources of the code you read' }),
      lines: Type.String({ description: 'the lines you read, e.g. 40-58' }),
      observed: Type.String({ description: 'what the code does, in one or two sentences' }),
      file: Type.Optional(Type.String({ description: 'the file, when it is not the first code source’s own' })),
      commit: Type.Optional(Type.String({ description: 'the commit you read the code at, when it is not the one the source was read at' })),
    }),
    execute: async (_id, p) => {
      const record = store.facts.get(text(p.factRecordId).trim());
      if (!record) return fail(`${text(p.factRecordId)} is not a fact record; give the id of the fact record that holds the claim (the report’s).`);
      const given = text(p.claim).trim();
      const claims = record.statements.filter((s) => s.type === 'Claimed');
      const claim = claims.find((s) => s.id === given) ?? claims.find((s) => squash(s.text) === squash(given));
      if (!claim) {
        return fail(`No claim in ${record.id} reads “${given.slice(0, 160)}”. Name one of its Claimed statements by id or by its text as recorded${claims.length ? `: ${claims.slice(0, 12).map((s) => `${s.id} “${s.text.slice(0, 80)}”`).join('; ')}` : ' — it has none: what a report says it did is written there as Claimed first (pk_write_fact_record)'}.`);
      }
      if (!(CHECK_TIER as readonly string[]).includes(text(p.tier))) return fail(`tier must be one of ${CHECK_TIER.join(', ')} — the order claims are checked in: first what bears on the owner’s words and red lines, then what a Done or verified status rests on, then the rest.`);
      if (!(CHECK_RESULT as readonly string[]).includes(text(p.result))) return fail(`result must be one of ${CHECK_RESULT.join(', ')}.`);
      const ids = [...new Set(arr<string>(p.codeSourceIds).map((id) => text(id).trim()).filter(Boolean))];
      if (ids.length === 0) return fail('Name the code you read (codeSourceIds): the source ids of the code files the check rests on.');
      const sources: Source[] = [];
      for (const id of ids) {
        const s = store.sources.get(id);
        if (!s) return fail(`codeSourceIds: unknown source ${id}`);
        if (!isCode(s)) return fail(`${id} (${s.title}) is not code: a claim about what the code does is checked against the code itself; a document that describes it is another claim.`);
        sources.push(s);
      }
      const lines = text(p.lines).trim();
      if (!lines) return fail('Say which lines you read (lines, e.g. 40-58): the check is anchored to commit, file and lines.');
      const observed = text(p.observed).trim();
      if (!observed) return fail('Say what the code does (observed), in one or two sentences: that is the observation the check records.');
      const first = sources[0]!;
      const a = first.anchor;
      const repo = a.kind === 'revision' ? a.repo : ctx.project.scope.find((i) => i.id === first.scopeItemId && (i.category === 'Repository' || i.category === 'Worktree'))?.path ?? ctx.project.locations[0] ?? null;
      const file = text(p.file).trim() || (a.kind === 'revision' ? a.path : a.kind === 'file' ? projectRelPath(ctx.project, a.path).split('\\').join('/') : first.title);
      const commit = text(p.commit).trim() || (a.kind === 'revision' ? a.commit : first.version.commit) || null;
      const check: CodeCheck = { of: claim.id, tier: text(p.tier), result: text(p.result), anchor: { repo, commit, file, lines } };
      const earlier = record.statements.findIndex((s) => s.check?.of === claim.id);
      const statement: Statement = {
        id: earlier >= 0 ? record.statements[earlier]!.id : newId('st'), type: 'Observed',
        text: `${observed} (${file}:${lines}${commit ? ` at ${commit.slice(0, 10)}` : ''}; checks claim ${claim.id}: ${check.result})`,
        sourceIds: ids, check,
      };
      const statements = earlier >= 0 ? record.statements.map((s, i) => (i === earlier ? statement : s)) : [...record.statements, statement];
      store.facts.put({ ...record, statements, updatedAt: new Date().toISOString() }, { jobId: ctx.jobId, basisSourceIds: [...ids, ...claim.sourceIds], summary: `Code check of claim ${claim.id} (${check.tier}): ${check.result}` });
      ctx.onSaved?.('facts', record.id, `Code check: ${check.result}`);
      const held = check.result === 'Consistent';
      return ok({
        factRecordId: record.id, statementId: statement.id, claim: claim.id, tier: check.tier, result: check.result, anchor: check.anchor, replacedEarlierCheck: earlier >= 0,
        next: held
          ? 'The claim holds as far as this code shows: the check is its observation, and the claim stays as reported.'
          : `The claim does not hold${check.result === 'Partly consistent' ? ' in full' : ''}: the main job writes contradicts from the code source to the report’s source (the claim quoted in the relation’s claim), puts Suspected stale on the status that rests on it — its progress stays as reported — and adds the claim and this check to that work item’s executionFacts. Say it in your report.`,
      });
    },
  });
}

/**
 * `pk_ask_owner_about_rules` (Spec §1.15, §3.9; CKC-21 AC-5): the rules a round inferred from what the project does
 * that change how an agent works, put to the owner in the round's one `For your decision` note — each with the records
 * it rests on and what it changes. A later call in the same round adds to that note; a rule the project writes down,
 * one the owner confirmed, or one an earlier round inferred is refused with the reason.
 */
function rulesToOwnerTool(ctx: ToolContext): ToolDefinition {
  const { store } = ctx;
  return defineTool({
    name: 'pk_ask_owner_about_rules', label: 'Put the rules this round inferred to the owner',
    description: 'The rules you inferred in this round from what the project does (basis Inferred) that change how an agent works on the project, put to the owner in the round’s one For your decision note: each rule with the records it rests on and what it changes for an agent. Call it at the end of the round with all of them; a later call in the same round adds to the same note. Until the owner confirms a rule it stays marked as your inference.',
    parameters: Type.Object({
      rules: Type.Array(Type.Object({ ruleId: Type.String(), changes: Type.String({ description: 'what the rule changes in how an agent works on the project, in one sentence' }) })),
    }),
    execute: async (_id, p) => {
      const job = store.jobs.get(ctx.jobId);
      // By the clerk method the synthesis puts the round's inferred rules to the owner: the rules its orientation and
      // cross-check wrote are this round's (Spec v3.0 §3.3, §3.9). Before it, a round's main job did, with its own.
      const synthesis = job?.step?.kind === 'synthesis' || (job?.step?.kind === 'main' && clerkRoundOfJob(store, job)?.stage === 'synthesis');
      const clerk = synthesis ? clerkRoundOfJob(store, job) : null;
      if (!job || (!isRoundMain(job) && !clerk)) return fail('Only a round’s synthesis (or, before the clerk method, a round’s main job) puts the rules the round inferred to the owner, in the round’s one note; outside a round there is no round note to put them in. Name them in your reply instead.');
      const roundJobs = clerk ? new Set(store.jobs.filter((j) => j.step?.roundId === clerk.id).map((j) => j.id)) : new Set([ctx.jobId]);
      const asked = arr<Record<string, unknown>>(p.rules).map((r) => ({ ruleId: text(r.ruleId).trim(), changes: text(r.changes).trim() }));
      if (asked.length === 0) return fail('Name the rules you inferred in this round: rules: [{ ruleId, changes }].');
      for (const q of asked) {
        const rule = store.rules.get(q.ruleId);
        if (!rule) return fail(`${q.ruleId} is not one of the project’s rules; use the id pk_write_rule returned.`);
        if (rule.ownerConfirmation) return fail(`${rule.id} is already confirmed by the owner: there is nothing to ask.`);
        if (rule.basis === 'Explicit') return fail(`${rule.id} is written in the project (basis Explicit): the project’s own rule needs no confirmation. Only the rules you inferred from what the project does are put to the owner.`);
        if (rule.validity !== 'Current') return fail(`${rule.id} is ${rule.validity}: only a rule in force is put to the owner.`);
        if (!roundJobs.has(rule.jobId ?? '')) return fail(`${rule.id} was not inferred in this round: a round puts to the owner the rules it inferred itself; an earlier round’s rules went into that round’s note.`);
        if (!q.changes) return fail(`Say for ${rule.id} what it changes for an agent working on the project (changes).`);
      }
      const at = new Date().toISOString();
      const noteId = `note_rules-${clerk ? clerk.id : ctx.jobId}`;
      const previous = store.notes.get(noteId);
      // The owner reads this note (§4.2, §6.13; D105): what a rule changes is said without the store's ids.
      const unreadable = ownerTextRefusal('The note that puts the inferred rules to the owner', Object.fromEntries(asked.map((q, i) => [`rules[${i}].changes`, q.changes])), laneNamesOf(store));
      if (unreadable) return fail(unreadable);
      // One fact per rule: a rule asked about again takes the new wording, the others stay as they were. Which rule a
      // fact is about is its link (`ruleId`), not a part of its sentence; a note written before D105 named the rule's id
      // in the sentence, which is read once more here and left out of what is written.
      const factOf = (ruleId: string, changes: string) => {
        const r = store.rules.get(ruleId)!;
        return { text: `${r.summary} — for an agent this means: ${changes} (applies to ${r.appliesTo.join('; ')}; inferred from the records cited)`, sourceIds: [...r.sourceIds], inferred: true, ruleId: r.id };
      };
      const facts = new Map<string, { text: string; sourceIds: string[]; inferred: boolean; ruleId: string }>();
      for (const f of previous?.versions[previous.versions.length - 1]?.body.facts ?? []) {
        const id = f.ruleId ?? /\(rule ([^;)\s]+)/.exec(f.text)?.[1];
        if (id) facts.set(id, { text: f.text.replace(/\(rule [^;)\s]+; /, '('), sourceIds: [...f.sourceIds], inferred: f.inferred, ruleId: id });
      }
      for (const q of asked) facts.set(q.ruleId, factOf(q.ruleId, q.changes));
      const ruleIds = [...facts.keys()];
      let judgementId = ctx.judgementId && store.judgements.has(ctx.judgementId) ? ctx.judgementId : previous?.versions[0]?.judgementRecordId ?? '';
      if (!store.judgements.has(judgementId)) {
        const judgement: JudgementRecord = {
          id: newId('jdg'), projectId: ctx.project.id, jobId: ctx.jobId, at,
          scope: { kind: 'rules', ids: ruleIds, label: `Rules inferred in ${job.scope.label}` },
          inputs: { referenceIds: [], threadIds: [], areaIds: [], relationIds: [], keyEvidenceSourceIds: [...new Set([...facts.values()].flatMap((f) => f.sourceIds))], conflictingSourceIds: [], previousNoteIds: [], investigations: [] },
          excluded: [], outcome: { noteIds: [], assessments: [], reconsideredOnly: false },
        };
        store.judgements.put(judgement, { jobId: ctx.jobId, summary: `Inputs recorded: ${judgement.scope.label}` });
        judgementId = judgement.id;
      }
      const n = ruleIds.length;
      const version: NoteVersion = {
        version: (previous?.versions.length ?? 0) + 1, at,
        title: `Do the rules inferred from how the project works hold?`,
        // The first sentence is the question (§4.2, D105); the title says the same.
        preview: `${n === 1 ? 'Does the rule' : `Do the ${n} rules`} this round inferred from the project’s records hold? ${n === 1 ? 'It' : 'Each'} would change how an agent works on the project. Until you confirm ${n === 1 ? 'it, it stays' : 'them, they stay'} marked as the Keeper’s inference.`,
        body: {
          options: [
            { option: 'Confirm a rule', then: 'it becomes the project’s rule, with your words as its source' },
            { option: 'Correct or reject a rule', then: 'it is recorded as you say, and agents are no longer given the inferred wording' },
            { option: 'Leave them', then: 'each stays in force for agents, marked as the Keeper’s inference' },
          ],
          currentView: `Inferred in ${job.scope.label}. Each rule is listed below with what it changes for an agent and the records it rests on.`,
          whyItMatters: 'An agent working on the project follows the project’s rules. An inferred rule is shown everywhere as the Keeper’s inference, never as the project’s or your rule, until you confirm it.',
          facts: [...facts.values()], otherExplanations: null, keepAdjust: null,
          whatWouldSettleIt: 'Your word in the conversation on each rule: confirmed, it becomes the project’s rule with your words as its source; corrected or rejected, it is recorded as you say.',
        },
        ask: 'For your decision', judgementRecordId: judgementId,
        reason: previous ? `More rules inferred in the same round (${asked.length})` : 'The rules a round infers are put to the owner once per round',
      };
      const note: Note = previous
        ? { ...previous, versions: [...previous.versions, version], status: 'Current', updatedAt: at }
        : { id: noteId, projectId: ctx.project.id, mount: { kind: 'project', ids: [] }, status: 'Current', ownerResponse: null, versions: [version], discussion: [], followUps: [], author: { agent: 'pi', model: ctx.model }, resolvedReason: null, withdrawnReason: null, delegatedTo: null, cameFrom: cameFromFor(store, job, []), language: ctx.project.language, updatedAt: at };
      store.notes.put(note, { jobId: ctx.jobId, basisSourceIds: [...new Set(version.body.facts.flatMap((f) => f.sourceIds))], summary: `${previous ? `Note v${version.version}` : 'Note'}: ${version.title}` });
      const j = store.judgements.get(judgementId)!;
      store.judgements.put({ ...j, outcome: { ...j.outcome, noteIds: [...new Set([...j.outcome.noteIds, noteId])] } });
      ctx.onSaved?.('notes', noteId, `Note: ${version.title}`);
      return ok({ noteId, version: version.version, rules: ruleIds });
    },
  });
}
