/**
 * One computation of the process engine over a project (Spec v3.0 §2.12, §2.13 rows 1–5): the ledger's facts read once,
 * the units of work, every work item's process, and which steps the project's own rules expect of which work (§1.15
 * `expects`, D72: a breakpoint for a missing step is lit only where the project expects the step).
 */
import type { Ledger } from '../ledger/index.ts';
import type { Project, ProjectRule, WorkThread } from '../model/types.ts';
import type { ProcessExpectation } from '../model/vocab.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { Facts } from './facts.ts';
import { buildUnits, isArrangementPath, type Unit, type UnitIndex } from './units.ts';
import { processOf, type WorkContext, type WorkProcess } from './work.ts';

export interface Analysis {
  readonly store: ProjectStore;
  readonly project: Project;
  readonly facts: Facts;
  readonly index: UnitIndex;
  readonly ctx: WorkContext;
  /** A work item's process (computed on first use, then kept for this computation). */
  process(threadId: string): WorkProcess | null;
  /** The current rule of `How work is organized` that expects this step of this work, or null (§1.15, D72). */
  expecting(thread: WorkThread, step: ProcessExpectation): ProjectRule | null;
}

export function analyze(store: ProjectStore, project: Project, ledger: Ledger): Analysis {
  const facts = new Facts(ledger);
  const index = buildUnits(store, facts);
  const ctx: WorkContext = { store, project, facts, index };
  const cache = new Map<string, WorkProcess>();
  const rules = store.rules.filter((r) => r.validity === 'Current' && r.group === 'How work is organized' && (r.expects?.length ?? 0) > 0);
  const process = (threadId: string): WorkProcess | null => {
    if (cache.has(threadId)) return cache.get(threadId)!;
    const t = store.threads.get(threadId);
    if (!t) return null;
    const p = processOf(ctx, t);
    cache.set(threadId, p);
    return p;
  };
  return {
    store, project, facts, index, ctx, process,
    expecting(thread: WorkThread, step: ProcessExpectation): ProjectRule | null {
      return rules.find((r) => (r.expects ?? []).includes(step) && appliesTo(r, thread, process(thread.id), index, facts)) ?? null;
    },
  };
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
const singular = (s: string): string => (s.length > 3 ? s.replace(/(?<!s)s$/, '') : s);

/**
 * Whether a rule applies to a piece of work (§1.15 "适用于什么"): a rule with no `appliesTo` applies to all work;
 * otherwise an entry applies when it is the work's number or id, a path its commits touch (a directory or a file), a
 * branch it lies on, or words of its title, or of its task's title, kind or milestone.
 */
export function appliesTo(rule: ProjectRule, thread: WorkThread, p: WorkProcess | null, index: UnitIndex, facts: Facts): boolean {
  if (rule.appliesTo.length === 0) return true;
  const nums = thread.ids.map((x) => x.toLowerCase());
  const units = (p?.own ?? []).map((n) => index.units.get(n)).filter((u): u is Unit => u !== undefined);
  const text = norm([thread.title, ...units.map((u) => `${u.title ?? ''} ${u.fields.kind ?? ''} ${u.fields.milestone ?? ''} ${u.fields.type ?? ''}`)].join(' '));
  for (const raw of rule.appliesTo) {
    const e = raw.trim();
    if (!e) continue;
    const low = e.toLowerCase();
    if (low === thread.id.toLowerCase() || nums.includes(low)) return true;
    if (/[/\\]|\.\w{1,5}$/.test(e)) {
      const prefix = e.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
      if (p?.delivery.commits.some((c) => facts.filesOf(c).some((f) => !isArrangementPath(f.path) && (f.path === prefix || f.path.startsWith(`${prefix}/`))))) return true;
      if (p?.delivery.branches.some((b) => b === prefix || b.startsWith(prefix))) return true;
      continue;
    }
    // An entry shaped like a number (`AP`, `CKC-24`) is a number, never a word; words match whole words.
    if (/^(?:[A-Z]{1,6}(?:-[A-Z]?)?\d{1,4}|[A-Z]{2,6})$/.test(e)) continue;
    const w = singular(norm(e));
    const re = new RegExp(`(?<![a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`);
    if (/[\u3000-\u9fff]/.test(w) ? text.includes(w) : re.test(text)) return true;
  }
  return false;
}
