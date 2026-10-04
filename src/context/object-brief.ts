/**
 * What `pk get <id>` returns for an object that is not a context pack, a source or a note (Spec §7.10; CKC-12 AC-23):
 * the same facts the workbench's object detail shows (§6.4), written for an agent to read.
 *
 * The rule (D59): the object's own content goes in whole — its explanation, the owner's words, its validity, progress
 * and acceptance. Everything around it — relations, the change records that reach it, notes and marks — is named by
 * the other end's name and id, and fetched by id when the agent wants it. A change record does not carry its whole
 * propagation list: the objects that have not followed it are named, the rest are counted. None of the workbench's own
 * bookkeeping (the job trace, node flags, internal timestamps) is returned.
 *
 * Basis: on 2026-09-18 `pk get` on one reference item returned 82 KB of raw workbench JSON, 63% of it the full records
 * of the changes that reached it, each with its whole propagation list; the item itself was about 3%. About 70% of the
 * 18.1 MB the CLI produced for a subagent that only used the CLI came from fetching reference items (D59).
 */

import { isCodeLabel } from './code-source.ts';

export interface BriefSource { readonly id: string; readonly title: string; readonly label: string; readonly excerpt?: string; readonly usedAs?: string | null; readonly availability?: string | null }
export interface BriefRelation { readonly id: string; readonly type: string; readonly from: string; readonly to: string; readonly fromLabel?: string; readonly toLabel?: string; readonly claim?: string; readonly basis?: string; readonly assessment?: string }
export interface BriefNote { readonly id: string; readonly title: string; readonly ask?: string }
export interface BriefMark { readonly id: string; readonly kind: string; readonly clue?: string; readonly targetId?: string }
export interface BriefPropagation { readonly nodeId: string; readonly state: string; readonly sourceOrReason?: string }
/** One net change of a piece of work (Spec §1.8): what changed, why, and what it changed. */
export interface BriefChangeItem {
  readonly id: string; readonly at: string; readonly effect: string; readonly material?: string; readonly title: string;
  readonly summary?: string; readonly before?: string | null; readonly after?: string | null; readonly why?: string | null;
  readonly affects?: readonly string[];
}
export interface BriefChange {
  readonly id: string; readonly at: string; readonly effect: string; readonly material?: string; readonly title: string;
  readonly summary?: string; readonly before?: string | null; readonly after?: string | null;
  readonly segment?: { readonly name: string } | null;
  /** The piece of work the record is (Spec §1.8, D56), and its net changes. A record from before pieces of work has neither. */
  readonly work?: { readonly kind: string; readonly label: string; readonly startedAt?: string; readonly endedAt?: string; readonly openEnded?: boolean } | null;
  readonly items?: readonly BriefChangeItem[];
  readonly affectsLabels?: readonly { readonly id: string; readonly label: string }[];
  readonly propagationLabels?: readonly { readonly id: string; readonly label: string }[];
  readonly propagation?: readonly BriefPropagation[];
  /** What the piece of work recorded and no one judges: a finished work item, a session, a commit (§2.10). */
  readonly notJudgedLabels?: readonly { readonly id: string; readonly label: string }[];
  /** What it reached that has since been removed from the current version. */
  readonly removed?: readonly { readonly id: string; readonly label: string }[];
  readonly sources?: readonly { readonly id: string; readonly title: string; readonly label: string }[];
}
export interface BriefNode {
  readonly node?: { readonly id: string; readonly label: string; readonly category: string; readonly refKind: string; readonly refId: string; readonly validity?: string; readonly progress?: string | null; readonly acceptance?: string; readonly basis?: string; readonly attribution?: { readonly holder?: { readonly role: string } | null; readonly author?: { readonly kind: string; readonly name: string | null } | null; readonly identity?: string } | null; readonly updatedAt?: string };
  readonly reference?: { readonly name: string; readonly ids?: readonly string[]; readonly category: string; readonly text: string; readonly quote?: string | null; readonly answers?: string | null; readonly validity?: string; readonly basis?: string; readonly asOf?: string; readonly replacedBy?: string | null; readonly refines?: readonly string[] } | null;
  readonly area?: { readonly effectNow: string; readonly gaps: string; readonly asOf?: string } | null;
  readonly thread?: { readonly title: string; readonly ids?: readonly string[]; readonly doing?: string; readonly changed?: string; readonly results?: string; readonly unresolved?: string; readonly doneMeans?: string; readonly acceptanceMeans?: string; readonly progress?: string; readonly validity?: string; readonly acceptance?: string; readonly servesLabels?: readonly { readonly referenceId: string; readonly name: string; readonly claim: string }[]; readonly dependsOn?: readonly { readonly threadId: string; readonly claim: string }[]; readonly executionFacts?: readonly { readonly type: string; readonly text: string }[]; readonly qcFacts?: readonly { readonly type: string; readonly text: string }[]; readonly facts?: readonly { readonly id: string; readonly title: string }[] } | null;
  readonly change?: BriefChange | null;
  readonly relations?: readonly BriefRelation[];
  readonly notes?: readonly BriefNote[];
  readonly changes?: readonly BriefChange[];
  readonly marks?: readonly BriefMark[];
  readonly sources?: readonly BriefSource[];
  readonly updatePending?: boolean;
  /** The changes `Update pending` waits for (Spec §7.1), each with the parts to read and how it reaches the object. */
  readonly waitsFor?: readonly BriefWait[];
  /** When they will be taken in (§3.8). */
  readonly pendingWhen?: string | null;
}
export interface BriefWait { readonly ref: string; readonly label: string; readonly sourceIds: readonly string[]; readonly reasons: readonly { readonly link: string; readonly detail: string }[] }
export interface BriefFact {
  readonly id: string; readonly title: string; readonly asOf?: string;
  readonly statements?: readonly { readonly type: string; readonly text: string; readonly sourceIds?: readonly string[] }[];
  readonly openQuestions?: readonly string[];
  readonly aboutSourceIds?: readonly string[];
  readonly sources?: readonly BriefSource[];
}

const text = (s: string | null | undefined) => (s ?? '').trim();
const line = (label: string, value: string | null | undefined) => (text(value) ? `${label}: ${text(value)}` : null);
const keep = (lines: (string | null | undefined | false)[]) => lines.filter((l): l is string => typeof l === 'string' && l.length > 0).join('\n');

/**
 * An object's sources are part of its own content: each with its id and its excerpt, whole (Spec §7.10; CKC-12 AC-23,
 * AC-31). A code file is named by where it is, never quoted (D65; AC-43): the agent opens the current version. The
 * excerpt used to be shown only under 400 characters, when the workbench cut its excerpts at that length; the workbench
 * gives them whole now, so a longer one no longer turned into a bare id (QC AH #12).
 */
function sourceLines(sources: readonly BriefSource[] | undefined, how: string): string[] {
  if (!sources || !sources.length) return [];
  return [`\n## Sources (${sources.length})`, ...sources.map((s) => {
    const code = isCodeLabel(s.label, s.usedAs);
    const excerpt = code ? '' : text(s.excerpt);
    const history = s.usedAs === 'History only' ? ' · history only, not the current version' : '';
    return `- \`${s.id}\` ${s.title} — ${s.label}${s.availability ? ` · ${s.availability}` : ''}${history}${code ? ' · a code file: open the current version and read it there' : ''}${excerpt ? `\n  “${excerpt.split('\n').join('\n  ')}”` : ''}`;
  }), how];
}

/** What the agent entry receives for a source id (Spec §7.10 item 3; CKC-12 AC-22, AC-43). */
export interface OriginalData {
  readonly title: string;
  readonly kind: string;                          // the anchor's kind: file, session, commit …
  readonly label: string;
  readonly readAt: string;
  readonly commit: string | null;
  readonly fingerprint: string;
  readonly usedAs: string | null;
  readonly origin: { readonly relation: string; readonly path: string } | null;
  readonly availabilityNow: string | null;
  readonly currentState: 'same' | 'changed' | 'missing';
  readonly hasCredential: boolean;
  readonly excerpt: string;
  readonly lineStart: number;
  /** Set for a code file: where it is — repository, file, lines, commit — given in place of its lines (D65). */
  readonly code: { readonly location: string; readonly file: string } | null;
  readonly otherParts: readonly { readonly id: string; readonly label: string }[];
}

/**
 * A source as the agent entry gives it: the same as the workbench's original reading — title, kind, location, when it
 * was read, version, the excerpt with line numbers, and what changed since — except for a code file, which gives where
 * it is, the version read and whether it changed since, and tells the agent to open the current version (D65).
 */
export function sourceOriginal(d: OriginalData): string {
  const version = `${d.commit ? `${d.commit.slice(0, 10)} · ` : ''}${d.fingerprint.slice(0, 23)}`;
  const credential = d.hasCredential ? 'Credential: this source contains a credential; its value is not shown or stored.' : null;
  const origin = d.origin ? `Origin: ${d.origin.relation} · ${d.origin.path}` : null;
  const parts = d.otherParts.length ? ['', `Other parts of this document (${d.otherParts.length}), by id:`, ...d.otherParts.map((x) => `- ${x.id}  ${x.label}`)] : [];
  if (d.code) {
    return keep([
      `# ${d.title}`, `Kind: ${d.kind} · code`, `Location: ${d.code.location}`, `Read at: ${d.readAt}`, `Version when read: ${version}`, `Used as: ${d.usedAs ?? 'Not yet judged'}`, origin,
      d.currentState === 'same' ? 'Unchanged since it was read.' : d.currentState === 'changed' ? 'Changed since it was read: the file at this path is no longer the version above.' : 'No longer at this path: it was moved or deleted after it was read.',
      credential,
      `\nThis is a code file. ProjectKeeper gives where code is, not the code: open the current version of ${d.code.file} in the repository and read it there.`,
      ...parts,
    ]);
  }
  const lines = d.excerpt.split('\n');
  const width = String(d.lineStart + lines.length - 1).length;
  return [
    `# ${d.title}`, `Kind: ${d.kind}`, `Location: ${d.label}`, `Read at: ${d.readAt}`, `Version: ${version}`, `Used as: ${d.usedAs ?? 'Not yet judged'}`,
    origin, d.availabilityNow ? `Availability: ${d.availabilityNow}` : null, credential,
    d.currentState === 'changed' ? 'This source changed after it was read; the excerpt below is what was read.' : d.currentState === 'missing' ? 'This source is no longer available at its path; the excerpt below is what was read.' : null,
    '', ...(d.excerpt ? lines.map((l, i) => `${String(d.lineStart + i).padStart(width)} | ${l}`) : ['(No text was read from this source: it is binary or could not be read as text; nothing is reproduced.)']),
    '', 'Excerpts keep the original text. Interpretations and relations built on them can be corrected; the original is never changed.',
    ...parts,
  ].filter((l) => l !== null).join('\n');
}

function relationLines(relations: readonly BriefRelation[] | undefined, selfId: string, alreadyListed: ReadonlySet<string>): string[] {
  // Every change record that reaches an object also hangs off it as an `affects` relation; it is listed once, under
  // the change records, not twice.
  const shown = (relations ?? []).filter((r) => !(r.type === 'affects' && alreadyListed.has(r.from === selfId ? r.to : r.from)));
  if (!shown.length) return [];
  return [`\n## Relations (${shown.length})`, ...shown.map((r) => {
    const outgoing = r.from === selfId;
    const otherId = outgoing ? r.to : r.from;
    const otherLabel = (outgoing ? r.toLabel : r.fromLabel) ?? otherId;
    // Only a questioned assessment is written; `Holds` and `Not assessed` are normal states and stay in the assets (D59).
    return `- ${outgoing ? '' : '← '}${r.type} ${otherLabel} (\`${otherId}\`)${r.basis === 'Inferred' ? ' · Inferred' : ''}${r.assessment === 'Questioned' ? ' · Questioned' : ''}${text(r.claim) ? `: ${text(r.claim)}` : ''}`;
  })];
}

/**
 * `Update pending` says which changes the object waits for and when they are taken in (Spec §7.1, §7.6): each change by
 * name with the id to read it now and how it reaches the object. Nobody has to wait for the round to check.
 */
function pendingLines(d: BriefNode): string[] {
  const waits = d.waitsFor ?? [];
  if (!waits.length) return [];
  return [
    `\n## Update pending (${waits.length})`,
    ...waits.map((w) => `- ${w.label} (${w.sourceIds.length ? w.sourceIds.map((id) => `\`${id}\``).join(', ') : `\`${w.ref}\``})${w.reasons.length ? ` — ${w.reasons.map((r) => r.detail).join('; ')}` : ''}`),
    `What is written above may be out of date until these are taken in${d.pendingWhen ? `, ${d.pendingWhen}` : ''}. Read any of them now with \`pk get <id>\`; asking the Keeper about this object reads them in.`,
  ];
}

function neighbourLines(d: BriefNode): string[] {
  const out: string[] = [];
  if (d.changes && d.changes.length) {
    out.push(`\n## Change records that reach it (${d.changes.length})`, ...d.changes.map((c) => `- ${c.at.slice(0, 10)} · ${c.effect} · ${c.title} (\`${c.id}\`)`), 'Each by id with `pk get`; the record says what changed, why, and which objects have not followed it.');
  }
  if (d.notes && d.notes.length) out.push(`\n## Notes on it (${d.notes.length})`, ...d.notes.map((n) => `- ${n.title} (\`${n.id}\`${n.ask ? ` · ${n.ask}` : ''})`), 'The whole note: `pk get <note id>`.');
  const marks = (d.marks ?? []).filter((m) => text(m.clue).length > 0);
  if (marks.length) out.push(`\n## Entry marks on it (${marks.length})`, ...marks.map((m) => `- ${m.kind} (\`${m.id}\`): ${text(m.clue)}`));
  return out;
}

/**
 * A change record, without its whole propagation list (D59; Spec §7.10): the piece of work it is and each of its net
 * changes — what changed, why, what it changed (QC AH #4: only the record's first line reached the agent) — then what
 * has not followed it, and the rest counted.
 */
export function changeBrief(c: BriefChange): string {
  const prop = c.propagation ?? [];
  // An object that has not followed the change is usually not one the change itself altered, so its name comes from
  // the propagation labels; `affects` covers the ones it did alter.
  const labelOf = (id: string) => c.propagationLabels?.find((a) => a.id === id)?.label ?? c.affectsLabels?.find((a) => a.id === id)?.label ?? c.removed?.find((a) => a.id === id)?.label ?? id;
  // What it reached that has since been removed from the current version is named as removed (CKC-12 AC-35).
  const named = (id: string) => `${labelOf(id)} (\`${id}\`${c.removed?.some((r) => r.id === id) ? ', removed from the current version' : ''})`;
  const behind = prop.filter((p) => p.state === 'Still on old understanding');
  const rest = new Map<string, number>();
  for (const p of prop) if (p.state !== 'Still on old understanding') rest.set(p.state, (rest.get(p.state) ?? 0) + 1);
  const items = c.items ?? [];
  const byWork = c.work && items.length > 0;
  const itemLines = (it: BriefChangeItem) => keep([
    `- ${it.at} · ${it.effect}${it.material ? ` · ${it.material}` : ''} · **${text(it.title)}**`,
    text(it.summary) && text(it.summary) !== text(it.title) ? `  ${text(it.summary).split('\n').join('\n  ')}` : null,
    it.before || it.after ? `  Before: ${text(it.before) || '—'} → after: ${text(it.after) || '—'}` : null,
    text(it.why) ? `  Why: ${text(it.why)}` : null,
    it.affects && it.affects.length ? `  Affects: ${it.affects.map(named).join('; ')}` : null,
  ]);
  return keep([
    `# ${c.title} (\`${c.id}\`)`,
    byWork
      ? `Change record of one piece of work · ${c.work!.kind}: ${c.work!.label}${c.work!.startedAt ? ` · ${c.work!.startedAt}${c.work!.endedAt && c.work!.endedAt !== c.work!.startedAt ? ` → ${c.work!.endedAt}` : ''}` : ''}${c.work!.openEnded ? ' · still going when its round began' : ''}`
      : `Change · ${c.effect}${c.material ? ` · ${c.material}` : ''} · ${c.at}${c.segment ? ` · from ${c.segment.name}` : ''}`,
    '',
    ...(byWork
      ? [`## Its net changes (${items.length})`, ...items.map(itemLines)]
      : [
        text(c.summary),
        c.before || c.after ? `\nBefore: ${text(c.before) || '—'} → after: ${text(c.after) || '—'}` : null,
        c.affectsLabels && c.affectsLabels.length ? `\nAffects: ${[...new Map(c.affectsLabels.map((a) => [a.id, a])).values()].map((a) => named(a.id)).join('; ')}` : null,
      ]),
    c.notJudgedLabels && c.notJudgedLabels.length ? `\nRecorded at the time, not judged: ${c.notJudgedLabels.map((a) => named(a.id)).join('; ')}` : null,
    c.sources && c.sources.length ? `${byWork ? '\n' : ''}Sources: ${c.sources.map((s) => `${s.title} (\`${s.id}\`) — ${s.label}`).join('; ')}` : null,
    behind.length ? `\n## Not followed yet (${behind.length})\n${behind.map((p) => `- ${labelOf(p.nodeId)} (\`${p.nodeId}\`)${text(p.sourceOrReason) ? ` — ${text(p.sourceOrReason)}` : ''}`).join('\n')}` : null,
    rest.size ? `\nThe other ${[...rest.values()].reduce((a, b) => a + b, 0)} object(s) this record reached: ${[...rest].map(([state, n]) => `${state} ${n}`).join(', ')}. Those are the normal states; they stay in the assets, and \`pk get <id>\` reads any one of them.` : (behind.length ? null : '\nNo object is recorded as still on the old understanding of this change.'),
  ]);
}

/** A fact record: its statements and open questions in full, its sources by id. */
export function factBrief(f: BriefFact): string {
  return keep([
    `# ${f.title} (\`${f.id}\`)`,
    `Fact record${f.asOf ? ` · as of ${f.asOf}` : ''}`,
    '',
    ...(f.statements ?? []).map((s) => `- ${s.type}: ${text(s.text)}${s.sourceIds && s.sourceIds.length ? ` [${s.sourceIds.join(', ')}]` : ''}`),
    (f.openQuestions ?? []).length ? `\n## Still open\n${(f.openQuestions ?? []).map((q) => `- ${q}`).join('\n')}` : null,
    ...sourceLines(f.sources, 'Each source by id with `pk get`, which gives the original with line numbers.'),
  ]);
}

/** A relation on its own: what it claims, on what evidence, and both ends by name and id. */
export function relationBrief(r: BriefRelation & { readonly evidence?: { readonly factsSoFar?: string; readonly sourceIds?: readonly string[] }; readonly evidenceSources?: readonly BriefSource[]; readonly notes?: readonly BriefNote[]; readonly assessedAt?: string | null }): string {
  return keep([
    `# ${r.fromLabel ?? r.from} ${r.type} ${r.toLabel ?? r.to} (\`${r.id}\`)`,
    `From ${r.fromLabel ?? r.from} (\`${r.from}\`) to ${r.toLabel ?? r.to} (\`${r.to}\`)${r.basis === 'Inferred' ? ' · Inferred' : ''}${r.assessment === 'Questioned' ? ` · Questioned${r.assessedAt ? ` on ${r.assessedAt}` : ''}` : ''}`,
    '',
    text(r.claim),
    line('So far', r.evidence?.factsSoFar),
    ...sourceLines(r.evidenceSources, 'Each source by id with `pk get`.'),
    (r.notes ?? []).length ? `\n## Notes on it (${(r.notes ?? []).length})\n${(r.notes ?? []).map((n) => `- ${n.title} (\`${n.id}\`)`).join('\n')}` : null,
  ]);
}

/**
 * Any other object of the graph — a product reference item, an area, a work item, a change, a session or a result —
 * as the workbench's object detail says it, in prose.
 */
export function nodeBrief(d: BriefNode): string {
  const n = d.node;
  const selfId = n?.id ?? '';
  if (d.change) return changeBrief(d.change);
  const r = d.reference;
  const t = d.thread;
  const name = r?.name ?? t?.title ?? n?.label ?? selfId;
  const ids = r?.ids ?? t?.ids ?? [];
  const category = r?.category ?? n?.category ?? 'Object';
  const validity = r?.validity ?? t?.validity ?? n?.validity ?? '';
  const progress = t?.progress ?? n?.progress ?? '';
  const acceptance = t?.acceptance ?? n?.acceptance ?? '';
  const holder = n?.attribution?.holder?.role ?? (n?.attribution?.author?.kind === 'role' ? n.attribution.author.name : null);
  const head = [
    category,
    validity && validity !== 'Current' ? validity : '',   // `Current` is the normal state and is not written (D59)
    progress,
    acceptance,
    holder ? `held by ${holder}` : '',
    (r?.basis ?? n?.basis) === 'Inferred' ? 'Inferred' : '',
    d.updatePending ? 'Update pending' : '',
  ].filter((x) => text(x).length).join(' · ');
  return keep([
    `# ${name}${ids.length ? ` (${ids.join(', ')})` : ''} (\`${selfId}\`)`,
    head,
    r?.asOf || n?.updatedAt ? `As of ${r?.asOf ?? n?.updatedAt}` : null,
    '',
    // The object's own content, whole (AC-31).
    text(r?.text),
    r?.quote ? `Owner’s words: “${text(r.quote)}”${r.answers ? ` — in answer to: “${text(r.answers)}”` : ''}` : null,
    r?.replacedBy ? `Replaced by \`${r.replacedBy}\` — \`pk get ${r.replacedBy}\` reads it.` : null,
    d.area ? keep(['\n## Area understanding', line('Now', d.area.effectNow), line('Still missing', d.area.gaps)]) : null,
    t ? keep([
      line('Doing', t.doing), line('Done means', t.doneMeans), line('Owner acceptance means', t.acceptanceMeans),
      line('Changed on the way', t.changed), line('Results', t.results), line('Unresolved', t.unresolved),
      (t.servesLabels ?? []).length ? `Serves: ${(t.servesLabels ?? []).map((s) => `${s.name} (\`${s.referenceId}\`)${text(s.claim) ? ` — ${text(s.claim)}` : ''}`).join('; ')}` : null,
      (t.dependsOn ?? []).length ? `Depends on: ${(t.dependsOn ?? []).map((x) => `\`${x.threadId}\`${text(x.claim) ? ` — ${text(x.claim)}` : ''}`).join('; ')}` : null,
      [...(t.executionFacts ?? []), ...(t.qcFacts ?? [])].length ? `\n## Results and failures recorded\n${[...(t.executionFacts ?? []), ...(t.qcFacts ?? [])].map((s) => `- ${s.type}: ${text(s.text)}`).join('\n')}` : null,
      (t.facts ?? []).length ? `\nFact records behind it: ${(t.facts ?? []).map((f) => `${f.title} (\`${f.id}\`)`).join('; ')}` : null,
    ]) : null,
    ...pendingLines(d),
    ...sourceLines(d.sources, 'Each source by id with `pk get`, which gives the original with line numbers and says whether it changed since it was read.'),
    ...relationLines(d.relations, selfId, new Set((d.changes ?? []).map((c) => c.id))),
    ...neighbourLines(d),
    '\nEvery id above is read with `pk get <id>`. A work item or an area gives its context pack; anything else gives a page like this one.',
  ]);
}
