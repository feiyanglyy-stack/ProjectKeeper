/**
 * Where a piece of work stands in a plan (Spec v3.0 §2.12 `Planned`, §6.3 execution shape): which `Plan` reference item
 * it belongs to — by the relations the round recorded (`serves`, `implements`, `carries out`) — which batch of that
 * plan it is, by its own arrangement's words (`批次 2`, `batch 6 of 7`, `批次 5b`), and the version of the plan document
 * the plan's section first appears in.
 */
import type { ReferenceItem, WorkThread } from '../model/types.ts';
import type { ProjectStore } from '../store/project-store.ts';
import type { Occurred } from '../model/k-types.ts';
import { pathKey } from '../util/paths.ts';
import type { DocVersionFact, Facts } from './facts.ts';
import type { Unit } from './units.ts';

export interface BatchLabel {
  /** The plan's batch number as the arrangement writes it (`5`). */
  readonly batch: string;
  /** A half or part of the batch (`a`, `b`, `前半`), when the work is one of several. */
  readonly part: string | null;
  /** The line it was read from. */
  readonly line: string;
}

/** `批次 2`, `批次 5a`, `第 3 批`, `batch 6 of 7`, `Batch 5b`, `批次 5 前半`. */
const BATCH = /批次\s*(\d{1,3})\s*([a-z]|[前后上下]半)?|第\s*(\d{1,3})\s*批\s*([a-z])?|\bbatch(?:es)?\s*(\d{1,3})\s*([a-z])?\b(?:\s*of\s*\d{1,3})?/i;

export function batchOf(unit: Unit): BatchLabel | null {
  const latest = unit.prompts[unit.prompts.length - 1];
  const candidates = [unit.title ?? '', unit.fields.milestone ?? '', unit.fields.batch ?? '', ...(latest?.data.batches ?? []).slice(0, 3)];
  for (const text of candidates) {
    const m = BATCH.exec(text);
    if (!m) continue;
    const batch = m[1] ?? m[3] ?? m[5];
    if (!batch) continue;
    const part = m[2] ?? m[4] ?? m[6] ?? null;
    return { batch, part: part ? part.toLowerCase() : null, line: text };
  }
  return null;
}

/** The `Plan` reference items a work item belongs to, by the round's relations. */
export function plansOf(store: ProjectStore, thread: WorkThread): ReferenceItem[] {
  const ids = new Set<string>();
  for (const s of thread.serves) ids.add(s.referenceId);
  for (const r of store.relations.all()) if (r.from === thread.id && (r.type === 'serves' || r.type === 'implements' || r.type === 'carries out' || r.type === 'refines')) ids.add(r.to);
  return [...ids].flatMap((id) => { const r = store.reference.get(id); return r && r.category === 'Plan' ? [r] : []; });
}

/** The work items a plan names, by the round's relations (the thread side and the graph side). */
export function workOfPlan(store: ProjectStore, planId: string): WorkThread[] {
  const out = new Map<string, WorkThread>();
  for (const t of store.threads.all()) if (t.serves.some((s) => s.referenceId === planId)) out.set(t.id, t);
  for (const r of store.relations.all()) {
    if (r.to !== planId || !(r.type === 'serves' || r.type === 'implements' || r.type === 'carries out' || r.type === 'refines')) continue;
    const t = store.threads.get(r.from);
    if (t) out.set(t.id, t);
  }
  return [...out.values()];
}

export interface PlanDocument {
  readonly repo: string;
  readonly path: string;
  /** The heading path of the plan's section in the document ("Title › 11. 实施顺序"), or null for the whole document. */
  readonly section: string | null;
  readonly headingPath: readonly string[];
  /** The version the section first appears in. */
  readonly first: DocVersionFact | null;
  /** The version the checkout has. */
  readonly current: DocVersionFact | null;
}

/** The document (and section) a plan item was read from, located in the ledger's document history. */
export function planDocument(store: ProjectStore, facts: Facts, plan: ReferenceItem): PlanDocument | null {
  const repos = facts.ledger.repos();
  for (const sid of plan.sourceIds) {
    const s = store.sources.get(sid);
    if (!s) continue;
    const a = s.anchor;
    let repo: string | null = null;
    let rel: string | null = null;
    let headingPath: readonly string[] = [];
    if (a.kind === 'file') {
      const at = facts.relPathOf(a.path);
      if (!at) continue;
      repo = at.repo;
      rel = at.path;
      headingPath = a.headingPath;
    } else if (a.kind === 'revision') {
      const r = repos.find((x) => pathKey(x.path) === pathKey(a.repo)) ?? repos.find((x) => facts.relPathOf(a.repo)?.repo === x.id);
      if (!r) continue;
      repo = r.id;
      rel = a.path;
    } else continue;
    const versions = (facts.docsByPath.get(rel) ?? []).filter((d) => d.repo === repo);
    if (versions.length === 0) continue;
    const section = headingPath.length ? headingPath.join(' › ') : null;
    const first = section ? versions.find((d) => d.added.includes(section) || d.changed.includes(section)) ?? versions[0]! : versions[0]!;
    const current = [...versions].reverse().find((d) => d.current) ?? null;
    return { repo, path: rel, section, headingPath, first, current };
  }
  return null;
}

/** When a plan document version happened: the ledger's own time for it. */
export function versionOccurred(facts: Facts, v: DocVersionFact): Occurred {
  return facts.entry(v.id)?.occurred ?? { at: new Date(v.ms).toISOString(), basis: 'Commit', anchor: v.id };
}
