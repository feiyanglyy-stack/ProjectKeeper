/**
 * The program's check of a process link's evidence, as the link is written (CM, E151; CK fix 6). The cross-check used to
 * confirm every link by hand: on the gated run 82 links were "confirmed" in 26 seconds without one file opened, after a
 * 25K-character turn spent untangling link ids. What can be checked is checked here, at no cost to the model:
 *
 * - the fact resolves (evidence.ts already refuses a commit that is not there and a line its source does not hold);
 * - a commit is in the ledger, and touches what the link claims: its message names the work item's number (a range
 *   written in it counts, `AC-25-AC-31`), a file it changed is the work item's own (its path carries the number, or the
 *   work item's material is that file), a file the link's why names is among its changes, or a parent it merged names the
 *   number;
 * - a line of a document names the work item's number, or the document is the work item's own.
 *
 * A link that passes is lane-checked: it counts like a confirmed one, the distinction kept visible (Spec §2.12; the process
 * view says `Lane-checked`). One that fails is suspect: the cross-check rejects it, or confirms it after reading the
 * original. The synthesis gate counts the suspect links neither confirmed nor rejected, not every unconfirmed link.
 */
import { Ledger } from '../ledger/index.ts';
import { definitionsInPath } from '../ledger/numbering.ts';
import { rangeMembers } from '../ledger/ranges.ts';
import type { EvidenceRef, LinkCheck } from '../model/k-types.ts';
import type { WorkThread } from '../model/types.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { pathKey } from '../util/paths.ts';
import { isNumberShaped } from './numbers-check.ts';
import { primaryIdentifier } from './tools.ts';

/** A work item's own numbers: its ids, the identifier its title starts with, an internal id that is a project number. */
export function workNumbers(t: WorkThread): Set<string> {
  const out = new Set<string>([...t.ids, ...(isNumberShaped(t.id.toUpperCase()) ? [t.id] : [])].map((x) => x.trim().toUpperCase()).filter(Boolean));
  const p = primaryIdentifier(t.ids, t.title);
  if (p) out.add(p.toUpperCase());
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The numbers of `nums` a text names, ranges included (`CKC-03 AC-25-AC-31` names AC-28). */
export function namesNumber(text: string, nums: ReadonlySet<string>): string | null {
  if (!text) return null;
  const upper = text.toUpperCase();
  for (const n of nums) if (new RegExp(`(?<![A-Z0-9_])${esc(n)}(?![A-Z0-9_]|\\.\\d)`).test(upper)) return n;
  for (const m of rangeMembers(text)) if (nums.has(m.toUpperCase())) return m;
  return null;
}

/** The repository-relative files a work item's material is in (its fact records' sources, and the reference items it serves). */
function workFiles(store: ProjectStore, t: WorkThread): Set<string> {
  const ids = [
    ...t.factRecordIds.flatMap((f) => store.facts.get(f)?.aboutSourceIds ?? []),
    ...[...t.executionFacts, ...t.qcFacts].flatMap((s) => s.sourceIds),
  ];
  const out = new Set<string>();
  for (const id of ids) {
    const a = store.sources.get(id)?.anchor;
    if (a?.kind === 'file') out.add(pathKey(a.path));
  }
  return out;
}

const ok = (why: string): LinkCheck => ({ passed: true, why, at: new Date().toISOString() });
const no = (why: string): LinkCheck => ({ passed: false, why, at: new Date().toISOString() });

/**
 * Check the links written before the program checked links (or by a writer that did not): each gets its check now, from
 * its evidence as recorded. Returns how many were checked. The synthesis gate and `pk_round_state` run it first.
 */
export function checkUncheckedLinks(store: ProjectStore, jobId: string | null = null): number {
  const todo = store.links.filter((l) => l.check == null && !l.confirmed && l.evidence != null);
  if (!todo.length) return 0;
  let ledger: Ledger | null = null;
  try { ledger = Ledger.openDir(store.dir); } catch { ledger = null; }
  try {
    for (const l of todo) {
      const work = store.threads.get(l.workId);
      if (!work) continue;
      const check = checkLink(store, work, l.evidence!, l.why, ledger);
      store.links.put({ ...l, check }, { jobId, basisSourceIds: [], summary: `Link ${l.stepKind} → ${work.title}: ${check.passed ? 'lane-checked' : 'suspect'} (${check.why})` });
    }
  } finally { ledger?.close(); }
  return todo.length;
}

/** The commit a fact is, when it is one: a commit evidence, or a ledger entry of a commit. */
function commitOf(fact: EvidenceRef): string | null {
  if (fact.kind === 'commit') return fact.id.toLowerCase();
  if (fact.kind === 'ledger' && /^commit:[0-9a-f]{7,40}$/i.test(fact.id)) return fact.id.slice(7).toLowerCase();
  return null;
}

/**
 * The numbers that stand for the same work beside its own (CM): the tickets that implement it when it is a contract, and
 * the contracts it implements when it is a ticket — a delivery of CKC-22 is the merge that names AP, the ticket that
 * implements it.
 */
function relatedNumbers(store: ProjectStore, work: WorkThread): Map<string, string> {
  const out = new Map<string, string>();
  const add = (t: WorkThread | undefined, how: string) => { if (t) for (const n of workNumbers(t)) if (!out.has(n)) out.set(n, how); };
  const byRef = (id: string): WorkThread | undefined => {
    const direct = store.threads.get(id);
    if (direct) return direct;
    const r = store.reference.get(id);
    const ids = (r?.ids ?? []).map((i) => i.toUpperCase());
    return ids.length ? store.threads.find((x) => x.ids.some((i) => ids.includes(i.toUpperCase()))) : undefined;
  };
  for (const r of store.relations.filter((x) => x.type === 'implements')) {
    if (byRef(r.to)?.id === work.id) add(store.threads.get(r.from), `a ticket implementing ${work.ids[0] ?? work.title}`);
    if (r.from === work.id) add(byRef(r.to), `the contract ${work.ids[0] ?? work.title} implements`);
  }
  for (const n of workNumbers(work)) out.delete(n);
  return out;
}

/** A path as the ledger writes it: relative to the repository that holds it. */
function relOf(ledger: Ledger, path: string): string {
  const norm = path.replace(/\\/g, '/');
  for (const r of ledger.repos()) {
    const root = r.path.replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return norm.slice(root.length + 1);
  }
  return norm;
}

/**
 * The check (see the module comment). `ledger` is the project's ledger, or null when this build has none: a commit is then
 * checked by its message alone, as far as the evidence's label gives it.
 */
export function checkLink(store: ProjectStore, work: WorkThread, fact: EvidenceRef, why: string, ledger: Ledger | null): LinkCheck {
  const nums = workNumbers(work);
  const label = work.ids[0] ?? work.title;
  if (nums.size === 0) return no(`${work.title} has no number of its own, so the program cannot tell whether the fact is its step: check it against the original.`);
  const related = relatedNumbers(store, work);
  const all = new Set([...nums, ...related.keys()]);
  const said = (n: string) => (nums.has(n.toUpperCase()) ? n : `${n}, ${related.get(n.toUpperCase()) ?? 'related work'}`);
  const files = workFiles(store, work);
  const ownFile = (path: string) => definitionsInPath(path.replace(/\\/g, '/')).some((d) => nums.has(d.num.toUpperCase())) || [...files].some((f) => f.endsWith(`/${pathKey(path)}`) || f === pathKey(path));
  const list = [...all];
  const marks = list.map(() => '?').join(',');
  const hash = commitOf(fact);
  if (hash) {
    if (!ledger) {
      const n = namesNumber(`${fact.label}\n${fact.line ?? ''}`, all);
      return n ? ok(`the commit's subject names ${said(n)}`) : no(`the commit's subject names no number of ${label}, and the ledger is not available to read its files`);
    }
    const row = ledger.db.prepare('SELECT repo, hash, subject, body, parents FROM commits WHERE hash LIKE ? LIMIT 2').all(`${hash}%`) as { repo: string; hash: string; subject: string; body: string; parents: string }[];
    if (row.length === 0) return no(`commit ${hash.slice(0, 12)} is not in the ledger`);
    const c = row[0]!;
    const named = namesNumber(`${c.subject}\n${c.body}`, all);
    if (named) return ok(`the commit's message names ${said(named)}`);
    const changed = (ledger.db.prepare('SELECT path FROM commit_files WHERE repo = ? AND hash = ?').all(c.repo, c.hash) as { path: string }[]).map((r) => r.path);
    const own = changed.find(ownFile);
    if (own) return ok(`the commit changed ${own}, ${label}'s own material`);
    const inWhy = changed.find((x) => why.includes(x));
    if (inWhy) return ok(`the commit changed ${inWhy}, which the link's why names`);
    for (const parent of c.parents.split(' ').slice(1).filter(Boolean)) {
      const pr = ledger.db.prepare('SELECT subject, body FROM commits WHERE repo = ? AND hash = ?').get(c.repo, parent) as { subject: string; body: string } | undefined;
      const n = pr ? namesNumber(`${pr.subject}\n${pr.body}`, all) : null;
      if (n) return ok(`the merge brought in ${parent.slice(0, 7)}, whose message names ${said(n)}`);
    }
    // The project's own records tie them: a line of a document that names the work item's number and this commit.
    const short = c.hash.slice(0, 7);
    const line = ledger.db.prepare(`SELECT num, path, line FROM nums WHERE num IN (${marks}) AND kind IN ('doc', 'loose') AND context LIKE ? ORDER BY current DESC LIMIT 1`).get(...list, `%${short}%`) as { num: string; path: string | null; line: number | null } | undefined;
    if (line) return ok(`${line.path ?? 'a document'}${line.line ? `:${line.line}` : ''} names ${said(line.num)} and ${short} on one line`);
    return no(`commit ${short} “${c.subject.slice(0, 80)}” names no number of ${label}, changed none of its files, and no line of the project's documents names both${changed.length ? ` (it changed ${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ` and ${changed.length - 3} more` : ''})` : ''}`);
  }
  // A line of a document, a file, a source.
  const path = fact.kind === 'file' ? fact.id
    : fact.kind === 'source' ? (() => { const x = store.sources.get(fact.id)?.anchor; return x?.kind === 'file' ? x.path : null; })()
      : fact.kind === 'ledger' && ledger ? ledger.pathOfEntry(fact.id)?.path ?? null : null;
  if (fact.line) {
    const n = namesNumber(fact.line, all);
    if (n) return ok(`the cited line names ${said(n)}`);
  }
  if (path && ownFile(path)) return ok(`${path.replace(/\\/g, '/').split('/').slice(-2).join('/')} is ${label}'s own material`);
  if (fact.kind === 'source' && fact.line) {
    const n = namesNumber(store.sources.get(fact.id)?.title ?? '', all);
    if (n) return ok(`the cited line stands in a section titled with ${said(n)}`);
  }
  // The document the line stands in is about the work item: it names its number (a QC report's verdict line seldom does).
  if (path && fact.line && ledger) {
    const rel = relOf(ledger, path);
    const row = ledger.db.prepare(`SELECT num, line FROM nums WHERE num IN (${marks}) AND path = ? AND kind IN ('doc', 'loose') ORDER BY current DESC, line LIMIT 1`).get(...list, rel) as { num: string; line: number | null } | undefined;
    if (row) return ok(`the line is cited from ${rel.split('/').slice(-2).join('/')}, which names ${said(row.num)}${row.line ? ` (line ${row.line})` : ''}`);
  }
  return no(fact.line ? `the cited line names no number of ${label}, and ${path ? 'the document does not name it either' : 'it names no file of its own'}` : `no line is cited, and ${path ? `${path.replace(/\\/g, '/').split('/').pop()} is not ${label}'s own material` : 'the fact names no file'}`);
}
