/**
 * The Keeper's word on the project scope (Spec §1.1, §3.9, §6.7; CKC-04 AC-13, AC-16, AC-17; CKC-02 AC-25).
 *
 * The program offers candidates for third-party material and generated output, counts what the ignore rules leave out
 * and measures worktrees against the trunk; what a location *is* when the records cannot tell is the Keeper's
 * judgement, recorded here with a reason, what shows it and a basis, and corrected by the owner in the conversation.
 * A question only the owner can settle goes into the scope questions Project scope already shows (§3.9).
 *
 * These tools write assets only; what is read from a location follows at the next scope pass and intake.
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ScopeItem, ScopeJudgement, ScopeQuestion, Source } from '../model/types.ts';
import type { ScopeRelation } from '../model/vocab.ts';
import { BASIS, isOneOf } from '../model/vocab.ts';
import { stableId } from '../model/ids.ts';
import { anchorLabel, redactCredentials } from '../sources/anchor.ts';
import { canonicalPath, isWithin, normalizePath, pathKey, samePath } from '../util/paths.ts';
import { JUDGED_RELATIONS, applyDecisions, keeperQuestionId } from '../scope/decisions.ts';
import { isDocumentPath, treatmentOf } from '../scope/skip.ts';
import { ruleUseRefusal } from './rules.ts';
import type { ToolContext } from './tools.ts';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const redact = (s: string) => redactCredentials(s).text;
const now = () => new Date().toISOString();
const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }], details: {} });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: `ERROR: ${message}` }], details: {}, isError: true });

/** The id discovery gives the item at this location, so a source's marker names the same item Project scope lists. */
function itemIdAt(scope: readonly ScopeItem[], path: string): string {
  const listed = scope.find((i) => i.category !== 'Session source' && samePath(i.path, path));
  if (listed) return listed.id;
  return stableId('scope', existsSync(join(path, '.git')) ? 'repo' : 'dir', pathKey(path));
}

/**
 * Bring the `Used as` of the sources already read under `path` in line with its classification (§1.1): the documents
 * of third-party material are `Reference only`; when the classification changes, what it set goes with it. What the
 * owner judged one by one stays, and so does what the Keeper judged one by one.
 */
export function syncScopeUsedAs(store: ToolContext['store'], path: string, scopeItemId: string, relation: ScopeRelation, by: 'keeper' | 'owner', trace: { jobId: string | null; summary: string }): { referenceOnly: number; reset: number } {
  let referenceOnly = 0;
  let reset = 0;
  const thirdParty = relation === 'Third-party material';
  for (const s of store.sources.all()) {
    if (s.anchor.kind !== 'file' || !isWithin(path, s.anchor.path)) continue;
    const marker = s.usedAsByScopeItemId ?? null;
    if (thirdParty) {
      if (!isDocumentPath(s.anchor.path) || (s.usedAs === 'Reference only' && marker === scopeItemId)) continue;
      if (s.usedAs !== null && marker === null) continue;   // judged one by one, by the owner or the Keeper: that stands
      store.sources.put({ ...s, usedAs: 'Reference only', usedAsBy: by, usedAsByScopeItemId: scopeItemId } as Source, { jobId: trace.jobId, basisSourceIds: [s.id], summary: `Used as Reference only: ${trace.summary}` });
      referenceOnly += 1;
    } else if (marker === scopeItemId) {
      store.sources.put({ ...s, usedAs: null, usedAsBy: null, usedAsByScopeItemId: null } as Source, { jobId: trace.jobId, basisSourceIds: [s.id], summary: `Used as no longer set by the scope: ${trace.summary}` });
      reset += 1;
    }
  }
  return { referenceOnly, reset };
}

/** After the scope is drawn: every third-party location's documents are Reference only, and a location no longer third-party takes back what it set. */
export function syncAllScopeUsedAs(store: ToolContext['store'], scope: readonly ScopeItem[]): void {
  const reading = scope.filter((i) => treatmentOf(i) === 'documents');
  for (const item of reading) syncScopeUsedAs(store, item.path, item.id, 'Third-party material', item.classification?.by === 'owner' ? 'owner' : 'keeper', { jobId: null, summary: `${item.path}: Third-party material` });
  const ids = new Set(reading.map((i) => i.id));
  for (const s of store.sources.all()) {
    if (!s.usedAsByScopeItemId || ids.has(s.usedAsByScopeItemId)) continue;
    store.sources.put({ ...s, usedAs: null, usedAsBy: null, usedAsByScopeItemId: null } as Source, { jobId: null, basisSourceIds: [s.id], summary: 'Used as no longer set by the scope: its location is not third-party material any more' });
  }
}

export function scopeTools(ctx: ToolContext): ToolDefinition[] {
  const { store, project } = ctx;
  const saved = (collection: string, id: string, label: string) => ctx.onSaved?.(collection, id, label);
  const locations = project.locations.map((l) => canonicalPath(l));
  const resolve = (raw: string): string | null => {
    const p = raw.trim().replace(/^[`'"“”]+|[`'"“”]+$/g, '');
    if (!p) return null;
    if (isAbsolute(p)) return canonicalPath(p);
    for (const l of locations) { const full = normalizePath(join(l, p.replace(/[\\/]+$/, ''))); if (existsSync(full)) return full; }
    return locations[0] ? normalizePath(join(locations[0], p.replace(/[\\/]+$/, ''))) : null;
  };
  const inProject = (path: string) => locations.some((l) => isWithin(l, path)) || project.scope.some((i) => i.category !== 'Session source' && isWithin(i.path, path));
  const current = () => applyDecisions<ScopeItem>(project.scope.map((i) => ({ ...i })), {
    locations, rules: store.rules.all(), judgements: store.scopeJudgements.all(), questions: project.scopeQuestions,
    sourceLabel: (id) => { const s = store.sources.get(id); return s ? anchorLabel(s.anchor) : null; },
    resolveDir: (words) => { const full = resolve(words); try { return full && inProject(full) && statSync(full).isDirectory() ? full : null; } catch { return null; } },
    newItem: (path, relation) => ({ id: itemIdAt(project.scope, path), path, category: existsSync(join(path, '.git')) ? 'Repository' : 'Directory', relation, reason: '', reasonSourceIds: [], sessionHost: null, readOnly: false, copyOf: null, worktreeOf: null, versionControl: 'unknown', missing: null, addedBy: 'keeper' }),
  });

  return [
    defineTool({
      name: 'pk_classify_scope', label: 'Classify a scope location',
      description: `Record what a location in the project is, when the records alone cannot tell: ${JUDGED_RELATIONS.join(', ')}. Third-party material is what the project uses but did not write — SDKs, libraries, templates distributed with it; its documents become Reference only (citable, never this project's requirement, plan or work) and its code and history are not organized. Generated is build output, caches, exports: not organized. Main project (or Nested repository for a repository of its own) takes a candidate back as the project's own material; Experiment is for what the project calls an experiment; Excluded leaves a location out. Project scope lists the program's candidates ("candidate, not yet judged by the Keeper") — see pk_scope_items — and you can classify any other directory inside the project. Give the reason in your words, what shows it (sourceIds of material that says it; evidence for what shows it when no source does: a marker file, an upstream remote, file headers), and the basis: Explicit only when the project itself says so (a document, or the project's rule — ruleId), otherwise Inferred. When you cannot tell and it would change the result — for example an unmerged worktree you cannot tie to any work — record your best reading and put the question to the owner with askOwner. In the owner's conversation, ownerCorrection records the owner correcting it; the owner's word then stands over yours.`,
      parameters: Type.Object({
        path: Type.String({ description: 'the directory: absolute, or relative to the project root' }),
        relation: Type.String({ description: JUDGED_RELATIONS.join(' | ') }),
        reason: Type.String({ description: 'why, in your words; Project scope shows it' }),
        sourceIds: Type.Optional(Type.Array(Type.String(), { description: 'sources that show it: the directory’s README or LICENSE, a project document naming it' })),
        evidence: Type.Optional(Type.Array(Type.String(), { description: 'what shows it when no source does: a marker file, an upstream remote, a link target, generated-file headers' })),
        basis: Type.Optional(Type.String({ description: 'Explicit (the project says so) | Inferred (default: you conclude it)' })),
        ruleId: Type.Optional(Type.String({ description: 'the project’s rule that settles it' })),
        askOwner: Type.Optional(Type.Object({ question: Type.String(), whyItMatters: Type.String(), clues: Type.Optional(Type.Array(Type.String())), options: Type.Array(Type.String()) }, { description: 'a question only the owner can settle; name the relations as options when the answer is one of them' })),
        ownerCorrection: Type.Optional(Type.Object({ quote: Type.String({ description: 'the owner’s words' }) })),
      }),
      execute: async (_id, p) => {
        const path = resolve(text(p.path));
        if (!path) return fail('path: the directory to classify, absolute or relative to the project root.');
        if (!inProject(path)) return fail(`${text(p.path)} is not in this project (its locations: ${locations.join(', ')}; or a listed scope item). Classify a location inside the project.`);
        if (locations.some((l) => samePath(l, path))) return fail(`${path} is one of the project’s own locations, given by the owner; what the project is changes in Project scope, by the owner. Classify a location inside it.`);
        if (!existsSync(path) && !project.scope.some((i) => samePath(i.path, path))) return fail(`${path} is not on disk.`);
        if (!isOneOf(JUDGED_RELATIONS, p.relation)) return fail(`relation must be one of ${JUDGED_RELATIONS.join(', ')}. Third-party material and Generated are listed apart from the project's own material.`);
        const relation = p.relation;
        const reason = redact(text(p.reason)).trim();
        if (!reason) return fail('Give the reason in your words (reason); Project scope shows it beside the location.');
        if (relation === 'Nested repository' && !existsSync(join(path, '.git'))) return fail(`${path} is not a git repository of its own (no .git), so it cannot be a Nested repository; its own material is Main project.`);
        const correction = p.ownerCorrection;
        if (correction !== undefined && !ctx.ownerSourceId) return fail('Only the owner’s message in the conversation can correct a classification. Outside it, record your own reading; if the owner should settle it, use askOwner.');
        const quote = correction ? redact(text(correction.quote)).trim() : '';
        if (correction && !quote) return fail('ownerCorrection.quote: the owner’s words.');
        const by = correction ? 'owner' as const : 'keeper' as const;
        const unknown = arr<string>(p.sourceIds).filter((s) => !store.sources.has(s));
        if (unknown.length) return fail(`sourceIds names no source in the assets: ${unknown.join(', ')}`);
        const ruleId = text(p.ruleId).trim() || null;
        if (ruleId) { const refusal = ruleUseRefusal(store, ruleId, 'Validity'); if (refusal) return fail(refusal); }
        const sourceIds = [...new Set([...arr<string>(p.sourceIds), ...(ruleId ? store.rules.get(ruleId)!.sourceIds : []), ...(correction ? [ctx.ownerSourceId!] : [])])].filter((s) => store.sources.has(s));
        const evidence = arr<string>(p.evidence).map((e) => redact(text(e)).trim()).filter(Boolean);
        const basisGiven = correction || ruleId ? 'Explicit' : (text(p.basis) || 'Inferred');
        if (!isOneOf(BASIS, basisGiven)) return fail('basis must be Explicit (the project itself says so) or Inferred (you conclude it)');
        if (basisGiven === 'Explicit' && !correction && !ruleId && arr<string>(p.sourceIds).length === 0) {
          return fail('Explicit is for what the project itself says: cite the material that says it (sourceIds) or the project’s rule (ruleId). What you conclude from how the location looks is Inferred.');
        }
        if (basisGiven === 'Inferred' && sourceIds.length === 0 && evidence.length === 0) {
          return fail('Say what shows it (the reason comes with its source): sourceIds of material that shows it, or evidence — a marker file, an upstream remote, a link target, file headers — when no source does.');
        }
        const id = stableId('scopej', project.id, pathKey(path));
        const previous = store.scopeJudgements.get(id);
        if (previous?.by === 'owner' && !correction) {
          return fail(`The owner corrected this location on ${previous.at.slice(0, 10)}${previous.ownerQuote ? `: “${previous.ownerQuote}”` : ''} (${previous.relation}). The owner’s word stands; if the material says otherwise, write a note to the owner.`);
        }
        let question: ScopeJudgement['question'] = null;
        if (p.askOwner !== undefined) {
          if (correction) return fail('askOwner is for a question you put to the owner; the owner’s correction already settles it.');
          const q = p.askOwner;
          const options = arr<string>(q.options).map((o) => text(o).trim()).filter(Boolean);
          if (!text(q.question).trim() || !text(q.whyItMatters).trim() || options.length < 2) return fail('askOwner needs the question, whyItMatters (what changes with the answer) and at least two options.');
          question = { id: keeperQuestionId(path), question: redact(text(q.question)).trim(), whyItMatters: redact(text(q.whyItMatters)).trim(), clues: arr<string>(q.clues).map((c) => redact(text(c)).trim()).filter(Boolean), options };
        }
        const at = now();
        const judgement: ScopeJudgement = {
          id, projectId: project.id, path, relation, reason, sourceIds, evidence, basis: basisGiven, ruleId, by, ownerQuote: quote || null, question,
          previous: previous ? { relation: previous.relation, reason: previous.reason, by: previous.by, at: previous.at } : null, jobId: ctx.jobId, at,
        };
        const summary = `${path}: ${relation} (${by}, ${basisGiven})`;
        store.scopeJudgements.put(judgement, { jobId: ctx.jobId, basisSourceIds: sourceIds, summary: `Scope classification — ${summary}` });
        const synced = syncScopeUsedAs(store, path, itemIdAt(project.scope, path), relation, by, { jobId: ctx.jobId, summary });
        saved('scopeJudgements', id, `Scope: ${relation} — ${path}`);
        return ok({
          path, relation, by, basis: basisGiven, ...(question ? { askedOwner: question.question } : {}),
          documentsNowReferenceOnly: synced.referenceOnly, usedAsReset: synced.reset,
          note: 'Project scope shows it once the scope is drawn again, in a few seconds; what is read from the location follows.',
        });
      },
    }),
    defineTool({
      name: 'pk_scope_items', label: 'Read the project scope',
      description: 'The project scope with what the records say about each location: which: candidates — third-party material and generated output the program offered and you have not judged yet, with its evidence; worktrees — each registered worktree measured against the trunk (merged or not, commits the trunk lacks, files skipped as the same or older, files taken); ignored — what the project’s ignore rules leave out, by directory, with the rule and how many documents; rules — locations a project rule covers; judged — what you or the owner classified; all (default). Also the scope questions put to the owner, with their answers.',
      parameters: Type.Object({ which: Type.Optional(Type.String({ description: 'all | candidates | worktrees | ignored | rules | judged' })) }),
      execute: async (_id, p) => {
        const which = text(p.which) || 'all';
        const view = current();
        const pick = (i: ScopeItem) => which === 'all' ? true
          : which === 'candidates' ? i.classification?.by === 'program'
            : which === 'worktrees' ? i.worktree != null
              : which === 'ignored' ? i.ignoredBy != null
                : which === 'rules' ? (i.coveredBy ?? []).length > 0
                  : which === 'judged' ? i.classification != null && i.classification.by !== 'program' : false;
        const items = view.items.filter((i) => i.category !== 'Session source' && pick(i)).map((i) => ({
          id: i.id, path: i.path, category: i.category, relation: i.relation, reason: i.reason, read: treatmentOf(i),
          ...(i.classification ? { classification: i.classification } : {}),
          ...(i.worktree ? { worktree: i.worktree } : {}),
          ...(i.ignoredBy ? { ignoredBy: i.ignoredBy } : {}),
          ...((i.coveredBy ?? []).length ? { coveredBy: i.coveredBy } : {}),
        }));
        const questions: ScopeQuestion[] = [...project.scopeQuestions, ...view.questions.filter((q) => !project.scopeQuestions.some((x) => x.id === q.id))];
        return ok({ items, questions: questions.map((q) => ({ id: q.id, question: q.question, options: q.options, answer: q.answer?.text ?? null })) });
      },
    }),
  ];
}
