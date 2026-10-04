/**
 * `Update pending` by the clerk method (Spec v3.0 §1.11, §7.1, §7.6, §9; CKC-07 AC-10): an entry — a work item, a product
 * reference item, an area, a fact record kept from before increment K — shows `Update pending` while a change that affects
 * it waits for the next round, and it names each such change and how the change reaches it.
 *
 * What waits is the coverage's own list (clerk-coverage.ts `clerkPending`): what was read since the latest round started,
 * less what the project's rules settle, what is history or reference only, what the scope does not read and the Keeper's
 * own commits of its project folder. The marks are computed from that list on every pass that writes the coverage, never
 * accumulated, so they agree with it: every change a mark names is on the list, and once a round starts — its start is the
 * list's watermark — what it took in leaves the list, and every mark that waited for it is gone at the next pass.
 *
 * How a change reaches an entry. The clerk method's rounds write no fact records (D88), so the old chain — material →
 * fact records → work items → areas — carries nothing for them. These are the links the clerk method's assets hold:
 * - Number: the change names the entry's number — the project's own (`ids`) or the Keeper's (`KeeperNumber`, and the
 *   project's number it later took) — where the ledger indexes numbers: a document's text (in the sections the change
 *   added or changed, or in what a section it changed or removed said before), a commit's message and the paths it
 *   changed, a file's path, the worktree and branch a session ran in (a worktree named after the work); and, beyond what
 *   the ledger indexes, a session's messages. A pending version is not in the ledger yet — the ledger is brought up to
 *   date by the round that takes the change in — so its text is read as intake read it, and numbers are recognised the
 *   ledger's way (ledger/numbering.ts `mentionMatcher`, `nameMatcher`): its families, its word boundaries, its caution
 *   about two capitals that are also ordinary words. Code is read for its path only: the ledger indexes no number in it.
 * - Cited source: the entry cites a part of the material that changed — a work item's statements, what it was written
 *   from, the fact records it rests on; a reference item's own sources and the evidence of its carry-out; a relation that
 *   ties the entry to a source or rests on one; the clue of a mark on it.
 * - Code territory: the change is in a code file of a territory the work item changed — its trunk commits, counted the
 *   way `Built by` counts them (codemap `workTerritories`).
 * - Process: a step of the work item's process (a confirmed or judged link to a dispatch, receipt, report, session), one
 *   of its breakpoints or one of its open send-backs rests on the material.
 * - Recorded change: a change the Change log recorded from this material reached the entry (the item's `affects`, or the
 *   record's own when its items name no sources): the material has changed it before.
 * - Contributing work: an area waits for what the work items that contribute to its understanding wait for.
 *
 * Which parts of a document changed. A changed file is read again whole, so every section of it reads as new. When the
 * ledger holds the version the latest round took in, the new version is compared with it section by section (the
 * ledger's own `diffSections`): a section the change did not touch reaches nothing through its text or its citations; a
 * section it removed still reaches what cited it. Before the first round, without that version, or when the comparison
 * finds no section that differs (the file was read again, so it did change: an edit the round took in and then undone,
 * a file that came back, blank lines or line endings), which part changed is not known and every section counts.
 *
 * Left out: notes (a note is not marked, §1.11 — its re-look updates it); earlier generations' plan documents and
 * semantic patches' anchors (history, and a patch's objects are reached through their own links); a reference item's
 * downstream work (propagation judges that, §5.5). A change only the watcher has seen and intake has not read yet — a
 * file still being written, a session still going — reaches nothing until it is read: what it touches is known only from
 * its content. It is on the coverage's list meanwhile.
 */
import { join, relative } from 'node:path';
import type { App } from '../../server/app.ts';
import type { PendingLink, PendingMaterial, PendingWait, Project, Source } from '../../model/types.ts';
import type { EvidenceRef } from '../../model/k-types.ts';
import type { WorkTerritoryView } from '../../model/views-k.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import type { Ledger } from '../../ledger/index.ts';
import { diffSections, keyedSections, sectionBase } from '../../ledger/docs.ts';
import { familyOf, mentionMatcher, nameMatcher, type Rule } from '../../ledger/numbering.ts';
import { within } from '../../codemap/facts.ts';
import { isDocumentPath } from '../../scope/skip.ts';
import { isWithin, normalizePath, pathKey, samePath } from '../../util/paths.ts';
import { clerkPending, takenInAt, type ClerkPending } from './clerk-coverage.ts';
import { projectRelPath } from './materials.ts';

export interface UpdatePendingInput {
  readonly store: ProjectStore;
  readonly project: Project;
  /** What waits for the next round, with the sources behind each entry (`clerkPending`). */
  readonly pending: ClerkPending;
  /** The list's watermark: when the latest round started; '' before the first round. */
  readonly takenInAt: string;
  /** The project's ledger (read-only), for the version the latest round took in, commits and worktrees; null without one. */
  readonly ledger: Ledger | null;
  /** The territories each work item changed (codemap `workTerritories`); called only when a change is in code. */
  readonly workTerritories?: (() => Readonly<Record<string, readonly WorkTerritoryView[]>> | null) | null;
}

/** The changes each entry waits for, by collection and id (areas by their area's reference id). */
export interface UpdatePendingMarks {
  readonly threads: ReadonlyMap<string, readonly PendingWait[]>;
  readonly references: ReadonlyMap<string, readonly PendingWait[]>;
  readonly areas: ReadonlyMap<string, readonly PendingWait[]>;
  readonly facts: ReadonlyMap<string, readonly PendingWait[]>;
}

type ObjectKey = string;   // `thread:<id>` · `ref:<id>` · `fact:<id>`
interface Holder { readonly key: ObjectKey; readonly link: PendingLink; readonly how: string }

/** One change as the marks read it: the coverage's entry and what it is made of. */
interface ChangeView {
  readonly entry: PendingMaterial;
  readonly fresh: readonly Source[];
  /** The fresh sources whose content changed: all of them unless a section diff said which. */
  readonly changed: readonly Source[];
  /** A section diff against the version the latest round took in said which parts changed. */
  readonly precise: boolean;
  /** The sections the change removed, by their base key (`sectionBase`), when precise. */
  readonly removed: ReadonlySet<string>;
  /** A file's path on disk. */
  readonly path: string | null;
  /** Where numbers are read: new text, and what changed or removed sections said before (`gone`). */
  readonly texts: readonly { readonly text: string; readonly where: string; readonly sourceIds: readonly string[]; readonly gone?: 'removed' | 'changed'; readonly now?: string }[];
  /** Names numbers are read in: a path, a commit's files, a session's working directory and branch. */
  readonly names: readonly { readonly name: string; readonly where: string }[];
  /** The files on disk the change is in: a file itself; a commit's changed files. */
  readonly files: readonly string[];
}

const THREAD = (id: string): ObjectKey => `thread:${id}`;
const REF = (id: string): ObjectKey => `ref:${id}`;
const FACT = (id: string): ObjectKey => `fact:${id}`;
const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const slash = (p: string) => p.split('\\').join('/');
/** A split long section's source ends its heading path in `part n` (sources/files.ts `splitLong`). */
const baseOf = (headingPath: readonly string[]) => sectionBase(headingPath.length && /^part \d+$/.test(headingPath[headingPath.length - 1]!) ? headingPath.slice(0, -1) : headingPath);
const noDuplicateMark = (key: string) => key.replace(/ #\d+$/, '');

/** A part of the material as a reader finds it: `docs/PLAN.md › W-2 Count by ear`, a session's messages, a commit. */
function partLabel(project: Project, s: Source): string {
  const a = s.anchor;
  if (a.kind === 'file') return `${slash(projectRelPath(project, a.path))}${a.headingPath.length ? ` › ${a.headingPath.join(' › ')}` : ''}`;
  if (a.kind === 'session') return `${a.host} session ${a.sessionId.slice(0, 8)} · messages ${a.messageStart}–${a.messageEnd}`;
  if (a.kind === 'commit') return `commit ${a.commit.slice(0, 8)}`;
  return s.title;
}

/** The document as intake read it, from its sections, each at its own lines (sections cover the file from the first heading on). */
function textOfSections(fresh: readonly Source[]): string {
  const lines: string[] = [];
  for (const s of [...fresh].sort((a, b) => (a.anchor.kind === 'file' ? a.anchor.lineStart : 0) - (b.anchor.kind === 'file' ? b.anchor.lineStart : 0))) {
    if (s.anchor.kind !== 'file') continue;
    const at = Math.max(0, s.anchor.lineStart - 1);
    while (lines.length < at) lines.push('');
    s.excerpt.split('\n').forEach((l, i) => { lines[at + i] = l; });
  }
  return lines.join('\n');
}

// ───────────────────────── numbers, recognised the ledger's way ─────────────────────────

interface NumberIndex {
  /** The numbers an entry is known by, as the project writes them, and the entries each names. */
  readonly holders: ReadonlyMap<string, readonly ObjectKey[]>;
  inText(text: string): string[];
  inName(name: string): string[];
}

function numberIndex(store: ProjectStore): NumberIndex | null {
  const holders = new Map<string, ObjectKey[]>();
  const add = (num: string | null | undefined, key: ObjectKey) => {
    const n = (num ?? '').trim();
    if (!n || /^v\d/i.test(n)) return;   // a version label is not a number of the work (tools.ts reads it the same way)
    const written = familyOf(n.toUpperCase()) ? n.toUpperCase() : n;
    const list = holders.get(written) ?? [];
    if (!list.includes(key)) list.push(key);
    holders.set(written, list);
  };
  for (const t of store.threads.all()) if (t.validity !== 'Removed') for (const id of t.ids ?? []) add(id, THREAD(t.id));
  for (const r of store.reference.all()) if (r.validity !== 'Removed') for (const id of r.ids ?? []) add(id, REF(r.id));
  for (const n of store.numbers.all()) {
    const key = store.threads.has(n.objectId) ? THREAD(n.objectId) : store.reference.has(n.objectId) ? REF(n.objectId) : null;
    if (!key) continue;
    add(n.number, key);
    add(n.projectNumber, key);
  }
  if (holders.size === 0) return null;
  // The families of the numbers entries are known by, as the ledger defines a family (two capitals: only the ones named).
  const byFamily = new Map<string, { shape: Rule['shape']; defined: Set<string> }>();
  const literal: string[] = [];
  for (const num of holders.keys()) {
    const f = familyOf(num);
    if (!f) { literal.push(num); continue; }
    const r = byFamily.get(f.family) ?? { shape: f.shape, defined: new Set<string>() };
    if (f.shape === 'two-letters') r.defined.add(num);
    byFamily.set(f.family, r);
  }
  const rules: Rule[] = [...byFamily].map(([family, r]) => ({ family, shape: r.shape, defined: r.defined }));
  const mentions = mentionMatcher(rules);
  const names = rules.length ? nameMatcher(rules) : null;
  const literalRe = literal.length ? new RegExp(`(?<![\\p{L}\\p{N}_-])(${literal.sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`, 'gu') : null;
  const known = (nums: Iterable<string>) => [...new Set([...nums].filter((n) => holders.has(n)))];
  const literals = (text: string) => (literalRe ? [...text.matchAll(literalRe)].map((m) => m[1]!) : []);
  return {
    holders,
    inText: (text) => known([...(mentions ? mentions(text).filter((m) => m.confidence === 'stated').map((m) => m.num) : []), ...literals(text)]),
    inName: (name) => known([...(names ? names(name) : []), ...literals(name)]),
  };
}

// ───────────────────────── what each change is ─────────────────────────

function fileView(input: UpdatePendingInput, entry: PendingMaterial, fresh: readonly Source[]): ChangeView {
  const { project, ledger } = input;
  const path = entry.ref;
  const rel = slash(projectRelPath(project, path));
  const document = isDocumentPath(path);
  let changed: readonly Source[] = fresh;
  let precise = false;
  const removed = new Set<string>();
  const was: { text: string; where: string; sourceIds: string[]; gone: 'removed' | 'changed'; now?: string }[] = [];
  const before = /\.(md|markdown)$/i.test(path) && input.takenInAt && ledger ? ledger.currentText(path) : null;
  const after = before !== null ? textOfSections(fresh) : '';
  const diff = before !== null ? diffSections(before, after) : null;
  // What the latest round took in against what intake read since: which sections were added, changed or removed. A
  // comparison that finds none cannot say which part changed. The file was read again after the round started because
  // its content differed from what intake last read, so the difference lies outside what the ledger's version shows: an
  // edit the round took in and that was then undone (the committed version is what the ledger holds), a file that came
  // back, a change of blank lines or line endings. Every section then counts, as with no version to compare with.
  if (before !== null && diff && (diff.added.length || diff.changed.length || diff.removed.length)) {
    const touched = new Set([...diff.added, ...diff.changed]);
    const sections = keyedSections(after);
    const keyOf = (s: Source) => (s.anchor.kind === 'file' ? sections.find((k) => s.anchor.kind === 'file' && s.anchor.lineStart >= k.lineStart && s.anchor.lineStart <= k.lineEnd)?.key ?? null : null);
    changed = fresh.filter((s) => { const k = keyOf(s); return k === null || touched.has(k); });
    precise = true;
    for (const k of diff.removed) removed.add(noDuplicateMark(k));
    if (document) {
      const newText = new Map(sections.map((k) => [k.key, k.text]));
      for (const k of keyedSections(before)) {
        if (diff.removed.includes(k.key)) was.push({ text: k.text, where: `${rel} › ${k.base}`, sourceIds: [], gone: 'removed' });
        else if (diff.changed.includes(k.key)) was.push({ text: k.text, where: `${rel} › ${k.base}`, sourceIds: [], gone: 'changed', now: newText.get(k.key) ?? '' });
      }
    }
  }
  // A document's text is where the ledger reads numbers; code is read for its path only (the ledger indexes no numbers in it).
  const texts = document ? [...changed.map((s) => ({ text: s.excerpt, where: partLabel(project, s), sourceIds: [s.id] })), ...was] : [];
  return { entry, fresh, changed, precise, removed, path, texts, names: [{ name: rel, where: `its path ${rel}` }], files: [path] };
}

function commitView(input: UpdatePendingInput, entry: PendingMaterial, fresh: readonly Source[]): ChangeView {
  const texts: { text: string; where: string; sourceIds: string[] }[] = [];
  const names: { name: string; where: string }[] = [];
  const files: string[] = [];
  for (const s of fresh) {
    if (s.anchor.kind !== 'commit') continue;
    const lines = s.excerpt.split('\n');
    const short = s.anchor.commit.slice(0, 8);
    // The message as the ledger keeps it (subject and body) when it has read the commit; else the subject intake read.
    const message = input.ledger?.resolve(`commit:${s.anchor.commit.slice(0, 12)}`)?.text ?? lines[0] ?? '';
    texts.push({ text: message, where: `the message of commit ${short}`, sourceIds: [s.id] });
    const listed = lines.indexOf('files:');
    for (const f of listed >= 0 ? lines.slice(listed + 1).map((l) => l.trim()).filter(Boolean) : []) {
      names.push({ name: f, where: `${f}, a file commit ${short} changed` });
      files.push(join(s.anchor.repo, ...f.split('/')));
    }
  }
  return { entry, fresh, changed: fresh, precise: true, removed: new Set(), path: null, texts, names, files };
}

function sessionView(input: UpdatePendingInput, entry: PendingMaterial, fresh: readonly Source[]): ChangeView {
  const { project, ledger } = input;
  const texts = fresh.map((s) => ({ text: s.excerpt, where: partLabel(project, s), sourceIds: [s.id] }));
  const names: { name: string; where: string }[] = [];
  const cwd = fresh.map((s) => (s.anchor.kind === 'session' ? s.anchor.cwd : null)).find((c): c is string => Boolean(c)) ?? null;
  if (cwd && !project.locations.some((l) => samePath(l, cwd))) {
    // A session in a worktree named after the work (`.worktrees/AB-byok`), on a branch named after it (`wip/AB-byok`).
    const home = project.locations.filter((l) => isWithin(l, cwd)).sort((a, b) => b.length - a.length)[0];
    const dir = home ? slash(relative(normalizePath(home), normalizePath(cwd))) : slash(normalizePath(cwd)).split('/').slice(-2).join('/');
    names.push({ name: dir, where: `its working directory ${dir}` });
    const branch = ledger?.worktreeBranch(cwd) ?? null;
    if (branch) names.push({ name: branch, where: `the branch ${branch} checked out there` });
  }
  return { entry, fresh, changed: fresh, precise: true, removed: new Set(), path: null, texts, names, files: [] };
}

// ───────────────────────── the marks ─────────────────────────

/** The changes each entry waits for, computed from the pending list (see the module comment). */
export function updatePendingMarks(input: UpdatePendingInput): UpdatePendingMarks {
  const { store, project, pending, ledger } = input;
  const waits = new Map<ObjectKey, Map<string, { entry: PendingMaterial; sourceIds: Set<string>; reasons: Map<string, { link: PendingLink; detail: string }> }>>();
  const reach = (key: ObjectKey, entry: PendingMaterial, link: PendingLink, detail: string, sourceIds: readonly string[]) => {
    const byRef = waits.get(key) ?? new Map();
    const w = byRef.get(entry.ref) ?? { entry, sourceIds: new Set<string>(), reasons: new Map() };
    for (const id of sourceIds) w.sourceIds.add(id);
    w.reasons.set(`${link}|${detail}`, { link, detail });
    byRef.set(entry.ref, w);
    waits.set(key, byRef);
  };
  const live = (key: ObjectKey) => {
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (kind === 'thread') return (store.threads.get(id)?.validity ?? 'Removed') !== 'Removed';
    if (kind === 'ref') return (store.reference.get(id)?.validity ?? 'Removed') !== 'Removed';
    return store.facts.has(id);
  };
  const entries = new Map(pending.pending.map((p) => [p.ref, p]));
  const changes: ChangeView[] = [];
  for (const [ref, fresh] of pending.fresh) {
    const entry = entries.get(ref);
    if (!entry || fresh.length === 0) continue;
    changes.push(entry.kind === 'commit' ? commitView(input, entry, fresh) : entry.kind === 'session' ? sessionView(input, entry, fresh) : fileView(input, entry, fresh));
  }

  if (changes.length) {
    // ── what holds each source: citations, recorded changes, process evidence given as a source ──
    const holdersOf = new Map<string, Holder[]>();
    const cite = (sourceId: string, key: ObjectKey, link: PendingLink, how: string) => push(holdersOf, sourceId, { key, link, how });
    for (const t of store.threads.all()) {
      const key = THREAD(t.id);
      for (const s of [...(t.executionFacts ?? []), ...(t.qcFacts ?? [])]) for (const id of s.sourceIds ?? []) cite(id, key, 'Cited source', `a ${s.type} statement of it cites`);
      for (const id of t.inputs?.sourceIds ?? []) cite(id, key, 'Cited source', 'it was written from');
      for (const f of t.factRecordIds ?? []) for (const id of store.facts.get(f)?.aboutSourceIds ?? []) cite(id, key, 'Cited source', `the fact record ${f} it rests on is about`);
    }
    for (const r of store.reference.all()) {
      const key = REF(r.id);
      for (const id of r.sourceIds ?? []) cite(id, key, 'Cited source', 'it rests on');
      for (const id of r.inputs?.sourceIds ?? []) cite(id, key, 'Cited source', 'it was written from');
      for (const id of r.carryOut?.evidenceSourceIds ?? []) cite(id, key, 'Cited source', 'the evidence of its carry-out is');
    }
    for (const f of store.facts.all()) for (const id of f.aboutSourceIds ?? []) cite(id, FACT(f.id), 'Cited source', 'it is about');
    const objectKey = (id: string): ObjectKey | null => (store.threads.has(id) ? THREAD(id) : store.reference.has(id) ? REF(id) : null);
    for (const rel of store.relations.all()) {
      if (rel.type === 'affects') continue;   // a change record's own relation: its sources come in as a recorded change
      for (const [end, other] of [[rel.from, rel.to], [rel.to, rel.from]] as const) {
        const key = objectKey(end);
        if (!key) continue;
        if (store.sources.has(other)) cite(other, key, 'Cited source', `the relation “${rel.type}” ties it to`);
        for (const id of rel.evidence?.sourceIds ?? []) cite(id, key, 'Cited source', `the relation “${rel.type}” rests on`);
      }
    }
    for (const m of store.marks.all()) {
      const key = m.closed ? null : objectKey(m.targetId);
      if (key) for (const id of m.clueSourceIds ?? []) cite(id, key, 'Cited source', `the clue of its mark ${m.kind} is`);
    }
    for (const c of store.changes.all()) {
      const items = (c.items ?? []).filter((it) => (it.sourceIds ?? []).length);
      const recorded = items.length ? items.map((it) => ({ sources: it.sourceIds, affects: it.affects ?? [], title: it.title })) : [{ sources: c.sourceIds ?? [], affects: c.affects ?? [], title: c.title }];
      for (const r of recorded) for (const target of r.affects) {
        const key = objectKey(target);
        if (key) for (const id of r.sources) cite(id, key, 'Recorded change', `the change “${r.title}” (${c.id}) that reached it came from`);
      }
    }

    // ── what a work item's process rests on: its steps, breakpoints and open send-backs (a plan's too) ──
    const byPlace = new Map<string, Holder[]>();   // pathKey of a file or a session log
    const roots = [...new Set([...(ledger?.repos().map((r) => r.path) ?? []), ...project.scope.filter((i) => !i.missing && i.category !== 'Session source').map((i) => i.path), ...project.locations])];
    const evidencePlaces = (e: EvidenceRef): string[] => {
      if (e.kind === 'file') {
        const rel = e.id.replace(/^file:/, '');
        const own = e.repo ? ledger?.repos().find((x) => x.id === e.repo)?.path ?? roots.find((r) => samePath(r, e.repo!)) : undefined;
        return (own ? [own] : roots).map((r) => join(r, ...rel.split('/')));
      }
      if (e.kind !== 'ledger') return [];
      const place = ledger?.entryPlace(e.id);
      if (place) return ['file' in place ? place.file : place.sessionFile];
      // Without the ledger, what the id itself says: `doc:<path>@<commit>`, `plan:<path>`, `file:<path>`, `loose:<path>`.
      const m = /^(doc|del|plan|file|loose):(.+?)(?:@[0-9a-f]{6,40})?$/i.exec(e.id);
      if (!m) return [];
      return /^[A-Za-z]:[\\/]|^\//.test(m[2]!) ? [m[2]!] : roots.map((r) => join(r, ...m[2]!.split('/')));
    };
    const onProcess = (targetId: string, e: EvidenceRef | null | undefined, how: string) => {
      const key = e ? objectKey(targetId) : null;
      if (!e || !key) return;
      if (e.kind === 'source') { cite(e.id, key, 'Process', how); return; }
      for (const p of evidencePlaces(e)) push(byPlace, pathKey(p), { key, link: 'Process', how });
    };
    // A link records its evidence; one written before it did names it by `ledgerRef` alone (`source:<id>` for a source).
    const linkEvidence = (ref: string): EvidenceRef => (ref.startsWith('source:') ? { kind: 'source', id: ref.slice(7), label: ref } : ref.startsWith('file:') && !ledger ? { kind: 'file', id: ref.slice(5), label: ref } : { kind: 'ledger', id: ref, label: ref });
    for (const l of store.links.all()) onProcess(l.workId, l.evidence ?? linkEvidence(l.ledgerRef), `its ${l.stepKind} step${l.confirmed ? '' : l.check?.passed ? ' (lane-checked)' : ' (not yet confirmed)'} rests on`);
    // A breakpoint candidate rests on its evidence as a lit one does (D99: nothing is lit after the first usable round).
    for (const b of store.breakpoints.all()) if (!b.out) for (const e of b.evidence ?? []) onProcess(b.targetId, e, `its breakpoint ${b.lit ? '' : 'candidate '}${b.kind} rests on`);
    for (const sb of store.sendbacks.all()) if (sb.stage !== 'Closed') for (const e of sb.evidence ?? []) onProcess(sb.targetId, e, `its send-back to ${sb.to} rests on`);

    // ── the cited sources of each file, to find what a change removed or could not tell apart ──
    const heldByPath = new Map<string, Source[]>();
    for (const id of holdersOf.keys()) {
      const s = store.sources.get(id);
      if (s?.anchor.kind === 'file') push(heldByPath, pathKey(s.anchor.path), s);
    }

    // ── territories: which works changed which, and where each one's code is ──
    let territoryWorks: Map<string, string[]> | null | undefined;
    const territoriesOf = () => {
      if (territoryWorks !== undefined) return territoryWorks;
      const byWork = store.territories.size ? input.workTerritories?.() ?? null : null;
      if (!byWork) return (territoryWorks = null);
      territoryWorks = new Map();
      for (const [workId, rows] of Object.entries(byWork)) for (const r of rows) push(territoryWorks, r.territoryId, workId);
      return territoryWorks;
    };
    const repos = ledger?.repos() ?? [];
    const rootOf = (repo: string) => (repos.find((r) => r.id === repo || samePath(r.path, repo) || slash(r.path).toLowerCase().endsWith(`/${repo.toLowerCase()}`)) ?? repos[0])?.path ?? null;

    const numbers = numberIndex(store);
    for (const change of changes) {
      const { entry } = change;
      const parts = (change.changed.length ? change.changed : change.fresh).map((s) => s.id);
      const freshIds = new Set(change.fresh.map((s) => s.id));

      // Number
      if (numbers) {
        for (const t of change.texts) {
          const found = numbers.inText(t.text);
          if (t.gone === 'changed') {
            const still = new Set(numbers.inText(t.now ?? ''));
            for (const num of found) if (!still.has(num)) for (const key of numbers.holders.get(num) ?? []) reach(key, entry, 'Number', `no longer names ${num} in ${t.where}`, parts);
            continue;
          }
          for (const num of found) for (const key of numbers.holders.get(num) ?? []) {
            reach(key, entry, 'Number', t.gone === 'removed' ? `names ${num} in ${t.where}, a section the change removed` : `names ${num} in ${t.where}`, t.sourceIds.length ? t.sourceIds : parts);
          }
        }
        for (const n of change.names) for (const num of numbers.inName(n.name)) for (const key of numbers.holders.get(num) ?? []) reach(key, entry, 'Number', `names ${num} in ${n.where}`, parts);
      }

      // Cited source, recorded change, and process evidence given as a source: the parts that changed
      const reached = new Map<string, string>();   // source id → where it is, as the reason says it
      for (const s of change.changed) reached.set(s.id, partLabel(project, s));
      if (change.path) {
        for (const s of heldByPath.get(pathKey(change.path)) ?? []) {
          if (reached.has(s.id)) continue;
          if (!change.precise) reached.set(s.id, partLabel(project, s));
          else if (!freshIds.has(s.id) && s.anchor.kind === 'file' && change.removed.has(baseOf(s.anchor.headingPath))) reached.set(s.id, `${partLabel(project, s)}, which the change removed`);
        }
      }
      for (const [id, where] of reached) for (const h of holdersOf.get(id) ?? []) reach(h.key, entry, h.link, `${h.how} ${where}`, freshIds.has(id) ? [id] : parts);

      // Process: a step, breakpoint or send-back resting on the file or the session that changed
      const places = change.path ? [change.path] : entry.kind === 'session' ? [entry.ref] : [];
      for (const place of places) for (const h of byPlace.get(pathKey(place)) ?? []) reach(h.key, entry, h.link, `${h.how} ${entry.kind === 'session' ? entry.label : slash(projectRelPath(project, place))}`, parts);

      // Code territory: a code file of a territory the work changed
      const code = change.files.filter((f) => !isDocumentPath(f));
      if (code.length && store.territories.size) {
        const works = territoriesOf();
        if (works) for (const t of store.territories.all()) {
          const root = rootOf(t.repo);
          const doers = works.get(t.id);
          if (!root || !doers?.length) continue;
          for (const f of code) {
            if (!isWithin(root, f)) continue;
            const rel = slash(relative(normalizePath(root), normalizePath(f)));
            if (!within(t.paths, rel)) continue;
            for (const w of doers) reach(THREAD(w), entry, 'Code territory', `${rel} is in the code territory “${t.name}”, which it changed`, parts);
          }
        }
      }
    }
  }

  const out = (key: ObjectKey): PendingWait[] => {
    if (!live(key)) return [];
    return [...(waits.get(key)?.values() ?? [])]
      .sort((a, b) => a.entry.since.localeCompare(b.entry.since) || a.entry.label.localeCompare(b.entry.label))
      .map((w) => ({ ref: w.entry.ref, kind: w.entry.kind, label: w.entry.label, since: w.entry.since, sourceIds: [...w.sourceIds], reasons: [...w.reasons.values()] }));
  };
  const threads = new Map<string, PendingWait[]>();
  for (const t of store.threads.all()) { const w = out(THREAD(t.id)); if (w.length) threads.set(t.id, w); }
  const references = new Map<string, PendingWait[]>();
  for (const r of store.reference.all()) { const w = out(REF(r.id)); if (w.length) references.set(r.id, w); }
  const facts = new Map<string, PendingWait[]>();
  for (const f of store.facts.all()) { const w = out(FACT(f.id)); if (w.length) facts.set(f.id, w); }
  // An area waits for what its own item waits for, and for what the work items its understanding is made of wait for.
  const areas = new Map<string, PendingWait[]>();
  for (const a of store.areas.all()) {
    const merged = new Map<string, { w: PendingWait; sourceIds: Set<string>; reasons: Map<string, { link: PendingLink; detail: string }> }>();
    const add = (w: PendingWait, reasons: readonly { link: PendingLink; detail: string }[]) => {
      const m = merged.get(w.ref) ?? { w, sourceIds: new Set<string>(), reasons: new Map() };
      for (const id of w.sourceIds) m.sourceIds.add(id);
      for (const r of reasons) m.reasons.set(`${r.link}|${r.detail}`, r);
      merged.set(w.ref, m);
    };
    for (const w of references.get(a.referenceId) ?? []) add(w, w.reasons);
    for (const c of a.contributions ?? []) {
      const t = store.threads.get(c.threadId);
      for (const w of threads.get(c.threadId) ?? []) add(w, [{ link: 'Contributing work', detail: `its work ${t?.title ?? c.threadId} (${c.threadId}) waits for it` }]);
    }
    if (merged.size) areas.set(a.referenceId, [...merged.values()].sort((x, y) => x.w.since.localeCompare(y.w.since) || x.w.label.localeCompare(y.w.label)).map((m) => ({ ...m.w, sourceIds: [...m.sourceIds], reasons: [...m.reasons.values()] })));
  }
  return { threads, references, areas, facts };
}

// ───────────────────────── writing them ─────────────────────────

const idsOf = (waits: readonly PendingWait[]) => [...new Set(waits.flatMap((w) => w.sourceIds))];
const sameMark = (ids: readonly string[] | undefined, had: readonly PendingWait[] | undefined, waits: readonly PendingWait[]) =>
  JSON.stringify(ids ?? []) === JSON.stringify(idsOf(waits)) && JSON.stringify(had ?? []) === JSON.stringify(waits);
const traceOf = (name: string, waits: readonly PendingWait[]) => ({
  jobId: null,
  basisSourceIds: idsOf(waits).slice(0, 50),
  summary: waits.length ? `Update pending: ${name} waits for ${waits.map((w) => w.label).join(', ')}` : `Update pending cleared: ${name}; what it waited for was taken in by a round`,
});

/**
 * Write the marks: every entry's `pendingSourceIds` and `waitsFor` become what the pending list gives it now, cleared
 * where it gives nothing. Only what differs is written; an entry's own time is left alone, since a change it waits for is
 * not a change of the entry (§2.10). Returns how many entries changed.
 */
export function writeUpdatePending(store: ProjectStore, marks: UpdatePendingMarks): number {
  let n = 0;
  for (const t of store.threads.all()) {
    const waits = marks.threads.get(t.id) ?? [];
    if (sameMark(t.pendingSourceIds, t.waitsFor, waits)) continue;
    const { waitsFor: _drop, ...rest } = t;
    store.threads.put({ ...rest, pendingSourceIds: idsOf(waits), ...(waits.length ? { waitsFor: waits } : {}) }, traceOf(t.title, waits));
    n += 1;
  }
  for (const r of store.reference.all()) {
    const waits = marks.references.get(r.id) ?? [];
    if (sameMark(r.pendingSourceIds, r.waitsFor, waits)) continue;
    const { waitsFor: _drop, pendingSourceIds: _ids, ...rest } = r;
    store.reference.put({ ...rest, ...(waits.length ? { pendingSourceIds: idsOf(waits), waitsFor: waits } : {}) }, traceOf(r.name, waits));
    n += 1;
  }
  for (const a of store.areas.all()) {
    const waits = marks.areas.get(a.referenceId) ?? [];
    if (sameMark(a.pendingSourceIds, a.waitsFor, waits)) continue;
    const { waitsFor: _drop, ...rest } = a;
    store.areas.put({ ...rest, pendingSourceIds: idsOf(waits), ...(waits.length ? { waitsFor: waits } : {}) }, traceOf(`the area ${store.reference.get(a.referenceId)?.name ?? a.referenceId}`, waits));
    n += 1;
  }
  for (const f of store.facts.all()) {
    const ids = idsOf(marks.facts.get(f.id) ?? []);
    if (JSON.stringify(f.pendingSourceIds ?? []) === JSON.stringify(ids)) continue;
    store.facts.put({ ...f, pendingSourceIds: ids }, { jobId: null, basisSourceIds: ids.slice(0, 50), summary: ids.length ? `Update pending: ${f.title} waits for changed material` : `Update pending cleared: ${f.title}` });
    n += 1;
  }
  return n;
}

/**
 * Bring a project's `Update pending` marks in line with what waits for the next round: the list the coverage shows
 * (`pending`, when the caller computed it; else computed now, the watcher's changes included), the project's ledger and
 * the code map's territories. Returns how many entries changed.
 */
export function refreshUpdatePending(app: App, projectId: string, pending?: ClerkPending): number {
  const store = app.store(projectId);
  const project = app.project(projectId);
  const list = pending ?? clerkPending(store, project, app.pendingChanges(projectId));
  const marks = updatePendingMarks({
    store, project, pending: list, takenInAt: takenInAt(store), ledger: app.ledger.ledger(projectId),
    workTerritories: () => app.kEngines.codemap?.workTerritories(store, project) ?? null,
  });
  return writeUpdatePending(store, marks);
}
