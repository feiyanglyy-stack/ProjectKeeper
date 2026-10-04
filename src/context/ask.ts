/**
 * Query entry for agents without a host integration (Spec §7.6, CKC-12 AC-13/14). The known
 * part is answered at once from the assets, deterministically; what needs investigation runs as
 * a Keeper turn the agent fetches later by job id. Questions in one thread keep their context.
 */
import type { PendingWait, Project } from '../model/types.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { anchorLabel } from '../sources/anchor.ts';
import { isWithin, normalizePath } from '../util/paths.ts';

function terms(question: string): string[] {
  const out = new Set<string>();
  for (const w of question.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []) out.add(w);
  const cjk = question.match(/[㐀-鿿]+/g) ?? [];
  for (const run of cjk) for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  return [...out];
}

function score(text: string, ts: string[]): number {
  const lower = text.toLowerCase();
  let n = 0;
  for (const t of ts) if (lower.includes(t)) n += t.length >= 4 ? 2 : 1;
  return n;
}

export interface KnownPart {
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly hits: number;
  /** Changed material the entries in the known part are still waiting for: the investigation reads it (AC-25). */
  readonly pendingSourceIds: readonly string[];
}

/** What the assets already say about the question: conclusions first, sources after. */
export function knownPart(store: ProjectStore, question: string): KnownPart {
  const ts = terms(question);
  if (ts.length === 0) return { text: '', sourceIds: [], hits: 0, pendingSourceIds: [] };
  const hits: { score: number; line: string; sourceIds: readonly string[]; pending?: readonly string[] }[] = [];
  // Each hit is short and carries its id; `pk get <id>` reads the rest (trial, 2026-09-18: a 39 KB known part, mostly
  // not about the question, buried the few lines that were).
  const short = (text: string | null | undefined) => { const x = (text ?? '').replace(/\s+/g, ' ').trim(); return x.length > 320 ? `${x.slice(0, 320)}…` : x; };
  // An entry waiting for changed material says so, and which changes and how they reach it (Spec §7.6): what is known may
  // be out of date, and the investigation reads them (AC-25). A mark written before the changes were named gives the documents.
  const waiting = (ids: readonly string[] | undefined, waits?: readonly PendingWait[]) => {
    if (waits?.length) return ` [Update pending: waiting for ${waits.slice(0, 4).map((w) => `${w.label}${w.reasons.length ? ` (${w.reasons.map((r) => r.detail).join('; ')})` : ''}`).join(', ')}${waits.length > 4 ? ` and ${waits.length - 4} more` : ''}; this may be out of date]`;
    if (!ids?.length) return '';
    const docs = [...new Set(ids.map((id) => { const a = store.sources.get(id)?.anchor; return !a ? id : a.kind === 'file' ? a.path.split(/[\\/]/).pop()! : a.kind === 'session' ? `${a.host} session ${a.sessionId.slice(0, 8)}` : a.kind === 'commit' ? `commit ${a.commit.slice(0, 8)}` : a.kind; }))];
    return ` [Update pending: waiting for changes in ${docs.slice(0, 4).join(', ')}${docs.length > 4 ? ` and ${docs.length - 4} more` : ''}; this may be out of date]`;
  };
  for (const n of store.notes.filter((x) => x.status === 'Current')) {
    const v = n.versions[n.versions.length - 1]!;
    const s = score(`${v.title} ${v.preview} ${v.body.currentView ?? ''} ${v.body.keepAdjust ?? ''}`, ts);
    if (s) hits.push({ score: s + 1, line: `Note “${v.title}” (\`${n.id}\`, ${v.ask}): ${short(`${v.preview}${v.body.currentView ? ` ${v.body.currentView}` : ''}`)}`, sourceIds: v.body.facts.flatMap((f) => f.sourceIds) });
  }
  for (const t of store.threads.all()) {
    const s = score(`${t.title} ${t.ids.join(' ')} ${t.doing} ${t.results} ${t.unresolved}`, ts);
    if (s) hits.push({ score: s, line: `Work “${t.title}” (\`${t.id}\`, ${t.progress}${t.validity !== 'Current' ? `, ${t.validity}` : ''})${waiting(t.pendingSourceIds, t.waitsFor)}: ${short(t.doing)} Results: ${short(t.results) || '—'} Unresolved: ${short(t.unresolved) || '—'}`, sourceIds: t.factRecordIds.flatMap((f) => store.facts.get(f)?.aboutSourceIds ?? []).slice(0, 6), pending: t.pendingSourceIds });
  }
  for (const r of store.reference.all()) {
    const s = score(`${r.name} ${r.ids.join(' ')} ${r.text} ${r.quote ?? ''}`, ts);
    if (s) hits.push({ score: s, line: `${r.category} “${r.name}” (\`${r.id}\`, ${r.validity}${r.basis === 'Inferred' ? ', Inferred' : ''})${waiting(r.pendingSourceIds, r.waitsFor)}: ${short(r.text)}${r.quote ? ` Owner: “${short(r.quote)}”` : ''}`, sourceIds: r.sourceIds, pending: r.pendingSourceIds ?? [] });
  }
  for (const a of store.areas.all()) {
    const s = score(`${a.effectNow} ${a.gaps}`, ts);
    if (s) hits.push({ score: s, line: `Area ${store.reference.get(a.referenceId)?.name ?? a.referenceId} (\`${a.referenceId}\`)${waiting(a.pendingSourceIds, a.waitsFor)}: effect now — ${short(a.effectNow)} Gaps — ${short(a.gaps)}`, sourceIds: [], pending: a.pendingSourceIds });
  }
  for (const f of store.facts.all()) {
    for (const st of f.statements) {
      const s = score(st.text, ts);
      if (s >= 2) hits.push({ score: s - 1, line: `${st.type} (fact record \`${f.id}\`): ${short(st.text)}`, sourceIds: st.sourceIds });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, 6);
  const sourceIds = [...new Set(top.flatMap((h) => h.sourceIds))].slice(0, 12);
  const lines = top.map((h) => `- ${h.line}`);
  const sources = sourceIds.map((id, i) => { const s = store.sources.get(id); return `[${i + 1}] ${s ? `${s.title} — ${anchorLabel(s.anchor)}` : id}`; });
  const pendingSourceIds = [...new Set(top.flatMap((h) => h.pending ?? []))];
  return { text: top.length ? `${lines.join('\n')}${sources.length ? `\n\nSources:\n${sources.join('\n')}` : ''}` : '', sourceIds, hits: top.length, pendingSourceIds };
}

/** The project a working directory belongs to (§7.2): its scope, including worktrees and subdirectories. */
export function resolveProject(projects: readonly Project[], cwd: string): Project | null {
  const path = normalizePath(cwd);
  for (const p of projects) {
    for (const item of p.scope) {
      if (item.relation === 'Excluded' || item.category === 'Session source' || item.missing) continue;
      if (isWithin(item.path, path)) return p;
    }
    for (const loc of p.locations) if (isWithin(loc, path)) return p;
  }
  return null;
}
