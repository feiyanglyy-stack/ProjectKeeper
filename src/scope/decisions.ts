/**
 * What changes a scope item after the program has drawn it (Spec §1.1, §1.15, §3.9; CKC-04 AC-1, AC-14, AC-16, AC-17):
 *
 * - the Keeper's classification of a location (`pk_classify_scope`), and a question it put to the owner;
 * - the project's material rules that name a directory or a branch: the listing shows the rule's own words and where
 *   they are written; `Recovery only` takes the location out of the current material (its content is `History only`);
 * - the owner's word: a correction in the conversation, an answer to a scope question.
 *
 * Precedence follows the Spec: the project's rule over the Keeper's inference, the owner over both. A rule marks the
 * places it names and what they hold; it never makes the program read anything more (D1): what a place is read for comes
 * from what it is — the project's own material, a library, build output, a worktree, what the ignore rules or the owner
 * leave out — and a directory only a rule names is read as the location around it is read. Pure: no disk and no git
 * beyond what the caller passes in.
 */
import type { ProjectRule, ScopeItem, ScopeJudgement, ScopeQuestion, ScopeRuleCover } from '../model/types.ts';
import type { ScopeRelation } from '../model/vocab.ts';
import { stableId } from '../model/ids.ts';
import { isWithin, pathKey, relativeDisplay, samePath } from '../util/paths.ts';
import { skippedSegment, treatmentOf } from './skip.ts';

/** The relations a classification can give: judgements about a location, not structural facts drawn from records. */
export const JUDGED_RELATIONS = ['Main project', 'Nested repository', 'Third-party material', 'Generated', 'Experiment', 'Excluded'] as const satisfies readonly ScopeRelation[];

export const ignoredQuestionId = (path: string) => stableId('scopeq', 'ignored-documents', pathKey(path));
export const keeperQuestionId = (path: string) => stableId('scopeq', 'keeper', pathKey(path));

/** Does the owner's answer take ignored material in? Only a clear yes does; anything else leaves it out, as the rules say. */
export function answerIncludes(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (/^(no\b|not\b|don|leave|keep (it |them )?out|exclude|skip|不|别|否)/.test(t)) return false;
  return /^(include|yes\b|y$|ok\b|take|read|纳入|包括|收|要|是)/.test(t);
}

export interface DecisionInput<T extends ScopeItem> {
  readonly locations: readonly string[];
  readonly rules: readonly ProjectRule[];
  readonly judgements: readonly ScopeJudgement[];
  /** Questions already asked, with the owner's answers. */
  readonly questions: readonly ScopeQuestion[];
  readonly sourceLabel: (sourceId: string) => string | null;
  /** Resolve a rule's words for a location to a directory on disk, or null. */
  readonly resolveDir: (words: string) => string | null;
  /** A scope item for a location nothing listed yet. */
  readonly newItem: (path: string, relation: ScopeRelation) => T;
}

const who = (j: ScopeJudgement) => (j.by === 'owner' ? 'the owner’s correction' : 'the Keeper');

function judgementReason(j: ScopeJudgement): string {
  const shows = j.evidence.length ? ` — ${j.evidence.join('; ')}` : '';
  const quote = j.ownerQuote ? ` — “${j.ownerQuote}”` : '';
  return `${j.relation} (${who(j)}, ${j.basis}): ${j.reason}${shows}${quote}`;
}

/** The listing's line for a rule on a location; `part` names the folder inside it the rule is about, when it is not the whole. */
function coverSentence(rule: ProjectRule, labels: readonly string[], part: string | null = null): string {
  const words = rule.excerpt ? `“${rule.excerpt}”` : rule.summary;
  const where = labels.length ? ` (${labels.join('; ')})` : '';
  const holds = part ? `what ${part} holds` : 'what it holds';
  const then = rule.category === 'Recovery only' ? `; ${holds} is History only: kept for tracing history, never current material`
    : rule.category === 'Reference only' ? `; ${part ? `the documents in ${part}` : 'its documents'} are Reference only`
      : rule.category === 'Obsolete' ? `; ${holds} is superseded` : '';
  return `${rule.category ?? 'Rule'}${part ? ` for ${part}, inside this location` : ''} — ${words}${where}${then}`;
}

const BRANCH_WORDS = /^(?:branch(?:es)?|分支)\s*[:：]?\s*(.+)$/i;
const globRe = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

export function applyDecisions<T extends ScopeItem>(start: readonly T[], input: DecisionInput<T>): { items: T[]; questions: ScopeQuestion[] } {
  const items: T[] = [...start];
  const questions: ScopeQuestion[] = [];
  const find = (path: string) => items.findIndex((i) => i.category !== 'Session source' && samePath(i.path, path));
  const set = (idx: number, patch: Partial<ScopeItem>) => { items[idx] = { ...items[idx]!, ...patch } as T; };
  /** Add a clause to an item's reason once (decisions may be applied again to a scope that already carries them). */
  const note = (idx: number, clause: string) => { if (!items[idx]!.reason.includes(clause)) set(idx, { reason: [items[idx]!.reason, clause].filter(Boolean).join(' · ') }); };
  const locate = (path: string, relation: ScopeRelation) => {
    const idx = find(path);
    if (idx >= 0) return idx;
    items.push(input.newItem(path, relation));
    return items.length - 1;
  };

  const judge = (j: ScopeJudgement) => {
    const idx = locate(j.path, j.relation);
    const before = items[idx]!;
    const applied = before.classification?.at === j.at && before.classification.by === j.by;   // already carries this judgement
    if (!applied) {
      set(idx, {
        relation: j.relation, reason: judgementReason(j),
        reasonSourceIds: [...new Set([...j.sourceIds, ...before.reasonSourceIds])],
        classification: { by: j.by, basis: j.basis, kind: before.relation === j.relation ? before.classification?.kind ?? null : null, evidence: j.evidence, sourceIds: j.sourceIds, ruleId: j.ruleId, jobId: j.jobId, at: j.at },
      });
    }
    if (!j.question) return;
    const asked = input.questions.find((q) => q.id === j.question!.id);
    const q: ScopeQuestion = { ...j.question, answer: asked?.answer ?? null };
    questions.push(q);
    if (!q.answer) { note(idx, `asked the owner: ${q.question}`); return; }
    const said = q.answer.text.trim();
    const named = JUDGED_RELATIONS.find((r) => said.toLowerCase() === r.toLowerCase() || said.toLowerCase().startsWith(`${r.toLowerCase()}`));
    if (named) {
      set(idx, {
        relation: named, reason: `${named} (the owner’s answer, Explicit): “${said}” — to “${q.question}”`,
        classification: { by: 'owner', basis: 'Explicit', kind: null, evidence: [`the owner answered “${said}”`], sourceIds: q.answer.sourceId ? [q.answer.sourceId] : [], ruleId: null, jobId: null, at: q.answer.at },
      });
    } else {
      note(idx, `the owner answered: “${said}”`);
    }
  };

  // 1. The Keeper's classifications.
  const byTime = [...input.judgements].sort((a, b) => a.at.localeCompare(b.at));
  for (const j of byTime.filter((x) => x.by === 'keeper')) judge(j);

  // 2. The project's material rules that name a directory or a branch (§1.15): over the Keeper's inference.
  const labelsOf = (rule: ProjectRule) => [...new Set(rule.sourceIds.map((id) => input.sourceLabel(id)).filter((l): l is string => Boolean(l)))];
  /**
   * Put a rule on a location: its words and where they are written go on the location's line. `part` is the folder
   * inside the location the rule names, when the rule's words go on the location around that folder (step 5).
   *
   * A Recovery only rule takes the location out of the current material, and what is read from it stays what it was,
   * now History only (skip.ts `treatmentOf`). So it turns `Excluded` only a location read in full, or a worktree read
   * for what it adds to the trunk; every other keeps what it is — a library still gives only its documents, build output
   * and what is left out give nothing — and what the Keeper or the owner judged a location stays as they judged it.
   */
  const cover = (rule: ProjectRule, idx: number, target: string, part: string | null = null) => {
    const item = items[idx]!;
    if ((item.coveredBy ?? []).some((c) => c.ruleId === rule.id)) return;
    const entry: ScopeRuleCover = { ruleId: rule.id, category: rule.category, summary: rule.summary, excerpt: rule.excerpt, sourceIds: rule.sourceIds, basis: rule.basis, target };
    const read = treatmentOf(item);
    const out = part === null && rule.category === 'Recovery only' && item.addedBy === 'keeper' && item.classification == null && (read === 'read' || read === 'changes');
    set(idx, {
      coveredBy: [...(item.coveredBy ?? []), entry],
      relation: out ? 'Excluded' : item.relation,
      reason: [coverSentence(rule, labelsOf(rule), part), item.reason].filter(Boolean).join(' · '),
      reasonSourceIds: [...new Set([...rule.sourceIds, ...item.reasonSourceIds])],
    });
  };
  /** Directories only a rule names: listed in step 5, once the owner's word on the locations around them is in too. */
  const named: { rule: ProjectRule; raw: string; words: string; dir: string }[] = [];
  for (const rule of input.rules) {
    if (rule.group !== 'Material rules' || rule.validity !== 'Current') continue;
    for (const raw of rule.appliesTo) {
      const words = raw.trim().replace(/^[`'"“”]+|[`'"“”]+$/g, '');
      const branch = BRANCH_WORDS.exec(words)?.[1]?.trim().replace(/^[`'"“”]+|[`'"“”]+$/g, '') ?? null;
      const onBranch = (name: string) => items.map((i, idx) => ({ i, idx })).filter(({ i }) => i.worktree?.branch && globRe(name).test(i.worktree.branch));
      if (branch) {
        const hits = onBranch(branch);
        if (hits.length) for (const h of hits) cover(rule, h.idx, raw);
        else for (const [idx, i] of items.entries()) if (i.category === 'Repository' && i.relation === 'Main project') {
          // A branch without a worktree lives only in the history: the repository's line says what the rule makes of it.
          if ((i.coveredBy ?? []).some((c) => c.ruleId === rule.id)) continue;
          set(idx, { coveredBy: [...(i.coveredBy ?? []), { ruleId: rule.id, category: rule.category, summary: rule.summary, excerpt: rule.excerpt, sourceIds: rule.sourceIds, basis: rule.basis, target: raw }], reason: `${i.reason} · branch ${branch}: ${coverSentence(rule, labelsOf(rule))}`, reasonSourceIds: [...new Set([...i.reasonSourceIds, ...rule.sourceIds])] });
        }
        continue;
      }
      const dir = input.resolveDir(words);
      if (dir && !input.locations.some((l) => samePath(l, dir))) {
        const idx = find(dir);
        if (idx >= 0) cover(rule, idx, raw);
        else named.push({ rule, raw, words, dir });
        continue;
      }
      const hits = onBranch(words);
      for (const h of hits) cover(rule, h.idx, raw);
    }
  }

  // 3. The owner's corrections, over everything.
  for (const j of byTime.filter((x) => x.by === 'owner')) judge(j);

  // 4. The owner's answer about ignored documents.
  for (const [idx, item] of items.entries()) {
    if (!item.ignoredBy || item.addedBy !== 'keeper' || (item.classification && item.classification.by !== 'program')) continue;
    const answer = input.questions.find((q) => q.id === ignoredQuestionId(item.path))?.answer;
    if (!answer) continue;
    if (answerIncludes(answer.text)) { set(idx, { relation: 'Main project' }); note(idx, `the owner chose to include it: “${answer.text.trim()}”`); }
    else note(idx, `the owner chose to leave it out: “${answer.text.trim()}”`);
  }

  // 5. The directories only a rule names, outer ones first (D1). Each is read as the location around it is read, so the
  //    rule marks what it holds and the program reads nothing more for it.
  const around = (path: string): number => {
    let best = -1;
    for (const [idx, i] of items.entries()) {
      if (i.category === 'Session source' || samePath(i.path, path) || !isWithin(i.path, path)) continue;
      if (best < 0 || pathKey(i.path).length > pathKey(items[best]!.path).length) best = idx;
    }
    return best;
  };
  /**
   * Whether the directory gets a line of its own. Under a location nothing is read from, it may: it is not read either.
   * Where a directory read on its own could not be read the way the location around it reads it — a worktree, read for
   * what it adds to the trunk; a location kept for recovery; a folder below one no walk of it enters (.git, .worktrees,
   * build output …) — the rule's words go on the location around it instead, naming the folder.
   */
  const ownLine = (outer: ScopeItem, dir: string): boolean => {
    const read = treatmentOf(outer);
    if (read === 'none') return true;
    if (read === 'changes' || read === 'history') return false;
    return skippedSegment(relativeDisplay(outer.path, dir)) === null;
  };
  /**
   * A directory's own line, read as the location around it is read: its relation and its classification (a library's
   * folder gives its documents; one under build output, or under what the ignore rules or the owner leave out, gives
   * nothing). One of the project's own locations is the project, whatever its relation says (a project may itself be a
   * copy of another repository), so a folder inside it is the project's own material. It is a plain directory: a
   * repository only a rule names does not bring its own history in. With no location around it, only what the rule
   * allows is read — what a Recovery only rule keeps is History only (Spec §1.2); the other rules make nothing readable.
   */
  const lineFor = (dir: string, outer: ScopeItem | null): T => {
    const made = input.newItem(dir, 'Excluded');
    if (!outer) return { ...made, category: 'Directory', relation: 'Excluded', classification: null, reason: 'no location in scope holds it: only what the rule allows is read' } as T;
    const own = input.locations.some((l) => samePath(l, outer.path));
    return {
      ...made, category: 'Directory', relation: own ? 'Main project' : outer.relation, classification: outer.classification ?? null,
      reason: `read as ${outer.path} around it is read (${outer.relation})`,
    } as T;
  };
  for (const n of [...named].sort((a, b) => pathKey(a.dir).length - pathKey(b.dir).length)) {
    const idx = find(n.dir);
    if (idx >= 0) { cover(n.rule, idx, n.raw); continue; }
    const outer = around(n.dir);
    if (outer >= 0 && !ownLine(items[outer]!, n.dir)) { cover(n.rule, outer, n.raw, n.words); continue; }
    items.push(lineFor(n.dir, outer >= 0 ? items[outer]! : null));
    cover(n.rule, items.length - 1, n.raw);
  }
  return { items, questions };
}
