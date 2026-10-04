/**
 * Composing the input of a product re-look (Spec §3.4): a context put together for this
 * judgement from the assets, never a session history. What goes in is recorded as the
 * judgement record before the model runs, so `Based on` shows exactly what was received.
 */
import type { AreaUnderstanding, GraphRelation, JudgementRecord, Note, Project, ReferenceItem, WorkThread } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { anchorLabel } from '../../sources/anchor.ts';
import { areaOf } from '../organize/graph.ts';
import { newId } from '../../model/ids.ts';

export interface RelookScope { readonly kind: 'project' | 'area' | 'thread'; readonly id: string | null; readonly label: string }

export interface ComposedRelook {
  readonly judgement: JudgementRecord;
  readonly text: string;
  readonly snapshot: Record<string, string>;
}

const cut = (s: string | null | undefined, n: number) => (s ?? '').length > n ? `${(s ?? '').slice(0, n)}…` : (s ?? '');
const latest = (n: Note) => n.versions[n.versions.length - 1]!;

export function scopeLabel(store: ProjectStore, scope: RelookScope): string {
  if (scope.kind === 'project') return 'Whole project';
  if (scope.kind === 'area') return `Area: ${store.reference.get(scope.id!)?.name ?? scope.id}`;
  return `Work: ${store.threads.get(scope.id!)?.title ?? scope.id}`;
}

export function composeRelook(store: ProjectStore, project: Project, scope: RelookScope, jobId: string): ComposedRelook {
  const refsAll = store.reference.all();
  let references: ReferenceItem[];
  let threads: WorkThread[];
  let areas: AreaUnderstanding[];
  if (scope.kind === 'project') {
    references = refsAll.filter((r) => r.validity === 'Current' || r.validity === 'Proposed');
    threads = store.threads.filter((t) => t.validity === 'Current' || t.validity === 'Proposed');
    areas = store.areas.all();
  } else if (scope.kind === 'area') {
    const area = store.reference.get(scope.id!);
    const chain = new Set<string>();
    const up = (id: string, d = 0) => { const r = store.reference.get(id); if (!r || chain.has(id) || d > 6) return; chain.add(id); for (const x of r.refines) up(x, d + 1); };
    if (area) up(area.id);
    for (const r of refsAll) if (r.category === 'Goal' && r.validity === 'Current') chain.add(r.id);
    for (const r of refsAll) if (areaOf(store, r.id) === scope.id && r.validity !== 'Replaced' && r.validity !== 'Abandoned') chain.add(r.id);
    references = refsAll.filter((r) => chain.has(r.id));
    threads = store.threads.filter((t) => t.serves.some((s) => areaOf(store, s.referenceId) === scope.id));
    areas = store.areas.filter((a) => a.referenceId === scope.id);
  } else {
    const t = store.threads.get(scope.id!);
    threads = t ? [t] : [];
    const ids = new Set<string>(threads.flatMap((x) => x.serves.map((s) => s.referenceId)));
    for (const id of [...ids]) { const a = areaOf(store, id); if (a) ids.add(a); }
    for (const r of refsAll) if (r.category === 'Goal' && r.validity === 'Current') ids.add(r.id);
    references = refsAll.filter((r) => ids.has(r.id));
    const areaIds = new Set([...ids].map((id) => areaOf(store, id)).filter((x): x is string => x !== null));
    areas = store.areas.filter((a) => areaIds.has(a.referenceId));
  }
  // The judgement starts from the owner's words (Spec §3.4, D63; CKC-08 AC-22): they come first, then the product
  // description that refines them, top down.
  const RANK: Record<string, number> = { "Owner's words": 0, Product: 1, Goal: 2, Area: 3 };
  references = [...references].sort((a, b) => (RANK[a.category] ?? 4) - (RANK[b.category] ?? 4));
  const threadIds = new Set(threads.map((t) => t.id));
  const refIds = new Set(references.map((r) => r.id));
  const relations = store.relations.filter((r) => threadIds.has(r.from) || threadIds.has(r.to) || (refIds.has(r.from) && refIds.has(r.to)));
  const factIds = [...new Set(threads.flatMap((t) => t.factRecordIds))];
  const facts = factIds.map((id) => store.facts.get(id)).filter((f): f is NonNullable<typeof f> => f !== undefined);
  const keyEvidence = [...new Set(facts.flatMap((f) => f.statements.filter((s) => s.type === 'Observed').flatMap((s) => s.sourceIds)))].slice(0, 40);
  const scopeNodeIds = new Set([...threadIds, ...refIds, ...areas.map((a) => a.referenceId), ...relations.map((r) => r.id)]);
  const marks = store.marks.filter((m) => !m.closed && scopeNodeIds.has(m.targetId));
  const conflicting = [...new Set(marks.flatMap((m) => m.clueSourceIds))].slice(0, 20);
  const previousNotes = store.notes.filter((n) => n.status === 'Current' && (scope.kind === 'project' ? n.mount.kind === 'project' || n.mount.ids.some((id) => scopeNodeIds.has(id)) : n.mount.ids.some((id) => scopeNodeIds.has(id))));
  const recentChanges = store.changes.filter((c) => c.affects.some((id) => scopeNodeIds.has(id))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);

  const judgement: JudgementRecord = {
    id: newId('jdg'), projectId: project.id, jobId, at: new Date().toISOString(),
    scope: { kind: scope.kind, ids: scope.id ? [scope.id] : [], label: scopeLabel(store, scope) },
    inputs: { referenceIds: references.map((r) => r.id), threadIds: threads.map((t) => t.id), areaIds: areas.map((a) => a.id), relationIds: relations.map((r) => r.id), keyEvidenceSourceIds: keyEvidence, conflictingSourceIds: conflicting, previousNoteIds: previousNotes.map((n) => n.id), investigations: [] },
    excluded: ['Session histories of implementation or QC work (available through investigation only)'],
    outcome: { noteIds: [], assessments: [], reconsideredOnly: false },
    snapshot: Object.fromEntries(threads.map((t) => [t.id, `${t.progress}/${t.validity}`])),
  };

  const parts: string[] = [];
  parts.push(`Product reference in scope (${references.length}):`);
  for (const r of references) parts.push(`- ${r.id} · ${r.category} · ${r.name}${r.ids.length ? ` [${r.ids.join(', ')}]` : ''} · ${r.validity}${r.basis === 'Inferred' ? ' · Inferred' : ''} · ${r.attribution.identity}${r.attribution.author.kind === 'owner' ? ' (owner)' : r.attribution.author.name ? ` (${r.attribution.author.name})` : ''}\n    ${cut(r.text, 700)}${r.quote ? `\n    Owner's words: “${cut(r.quote, 400)}”` : ''}${r.refines.length ? `\n    refines: ${r.refines.join(', ')}` : ''}${r.replacedBy ? `\n    replaced by: ${r.replacedBy}` : ''}`);
  parts.push('');
  parts.push(`Area understanding (${areas.length}):`);
  for (const a of areas) parts.push(`- ${a.id} · area ${store.reference.get(a.referenceId)?.name ?? a.referenceId} (${a.referenceId}) · as of ${a.asOf}${a.pendingSourceIds.length ? ' · UPDATE PENDING' : ''}\n    Effect now: ${cut(a.effectNow, 800)}\n    Gaps: ${cut(a.gaps, 600)}\n    Contributions: ${a.contributions.map((c) => `${store.threads.get(c.threadId)?.title ?? c.threadId} (${c.basis}: ${cut(c.claim, 120)})`).join('; ') || 'none'}`);
  parts.push('');
  parts.push(`Work threads in scope (${threads.length}):`);
  for (const t of threads) parts.push(`- ${t.id} · ${t.title}${t.ids.length ? ` [${t.ids.join(', ')}]` : ''} · ${t.progress} · ${t.validity} · ${t.attribution.identity}${t.pendingSourceIds.length ? ' · UPDATE PENDING' : ''}\n    Doing: ${cut(t.doing, 600)}\n    Changed: ${cut(t.changed, 400)}\n    Results: ${cut(t.results, 500)}\n    Unresolved: ${cut(t.unresolved, 400)}\n    Serves: ${t.serves.map((s) => `${store.reference.get(s.referenceId)?.name ?? s.referenceId} (${s.basis}: ${cut(s.claim, 120)})`).join('; ') || 'nothing (No established link)'}${t.dependsOn.length ? `\n    Depends on: ${t.dependsOn.map((d) => store.threads.get(d.threadId)?.title ?? d.threadId).join('; ')}` : ''}${t.executionFacts.length || t.qcFacts.length ? `\n    Execution/QC facts: ${[...t.executionFacts, ...t.qcFacts].slice(0, 8).map((s) => `${s.type}${s.claimedBy ? ` by ${s.claimedBy.who}, ${s.claimedBy.at}` : ''}: ${cut(s.text, 160)} [${s.sourceIds.join(', ')}]`).join(' | ')}` : ''}`);
  parts.push('');
  parts.push(`Relations in scope (${relations.length}) — id · type · from → to · basis · assessment · claim · evidence so far:`);
  for (const r of relations.slice(0, 80)) parts.push(`- ${r.id} · ${r.type} · ${nodeName(store, r.from)} → ${nodeName(store, r.to)} · ${r.basis} · ${r.assessment} · ${cut(r.claim, 160)} · ${cut(r.evidence.factsSoFar, 120)}${r.evidence.sourceIds.length ? ` · sources ${r.evidence.sourceIds.slice(0, 4).join(', ')}` : ''}`);
  parts.push('');
  parts.push(`Key observed facts from the fact records of these threads (${facts.length} records; statement · sources):`);
  let count = 0;
  for (const f of facts) {
    parts.push(`- ${f.id} · ${f.title}`);
    for (const s of f.statements.filter((x) => x.type === 'Observed' || x.type === 'Open').slice(0, 6)) { parts.push(`    ${s.type}: ${cut(s.text, 240)} [${s.sourceIds.join(', ')}]`); count++; }
    for (const q of f.openQuestions.slice(0, 3)) parts.push(`    Open: ${cut(q, 200)}`);
    if (count > 160) { parts.push('    … (more in pk_read_assets kind=fact)'); break; }
  }
  parts.push('');
  if (marks.length) { parts.push('Entry marks in scope (facts for judgement, not verdicts):'); for (const m of marks) parts.push(`- ${m.kind} on ${nodeName(store, m.targetId)} (${m.targetId})${m.decidedBy ? ` — set by ${m.decidedBy.who}, ${m.decidedBy.at}` : ''}: ${cut(m.clue, 240)} [${m.clueSourceIds.join(', ')}]`); parts.push(''); }
  if (recentChanges.length) { parts.push('Recent changes touching this scope:'); for (const c of recentChanges) parts.push(`- ${c.id} · ${c.at} · ${c.material} · ${c.effect} · ${c.title}: ${cut(c.summary, 240)}${c.before ? ` · before: ${cut(c.before, 120)}` : ''}${c.after ? ` · after: ${cut(c.after, 120)}` : ''}`); parts.push(''); }
  if (previousNotes.length) {
    parts.push('Previous notes on this scope (earlier views, not evidence; update by id when the judgement changed, leave them when it did not):');
    for (const n of previousNotes) { const v = latest(n); parts.push(`- ${n.id} · v${v.version} · ${v.title} · ${v.ask} · mount ${n.mount.kind} ${n.mount.ids.join(', ')}${n.ownerResponse ? ` · owner: ${n.ownerResponse}` : ''}\n    ${cut(v.preview, 300)}\n    Current view: ${cut(v.body.currentView, 500)}`); }
    parts.push('');
  }
  parts.push(`Sources for the original text: pk_read_source with any id above (e.g. ${keyEvidence.slice(0, 3).join(', ') || 'none listed'}).`);
  return { judgement, text: parts.join('\n'), snapshot: judgement.snapshot ?? {} };
}

function nodeName(store: ProjectStore, id: string): string {
  return store.reference.get(id)?.name ?? store.threads.get(id)?.title ?? store.changes.get(id)?.title ?? (store.sources.get(id) ? anchorLabel(store.sources.get(id)!.anchor) : id);
}

export function relationsFor(store: ProjectStore, ids: readonly string[]): GraphRelation[] { return ids.map((id) => store.relations.get(id)).filter((r): r is GraphRelation => r !== undefined); }
