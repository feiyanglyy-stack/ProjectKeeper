/**
 * What the workbench shows of the assets Spec v2.8 adds (CKC-09 AC-32, AC-33; CKC-21 AC-11, AC-12; Spec §6.3, §6.4,
 * §6.7, §6.9): which objects were removed, the authority layer, a decision's carry-out, who claimed what and when and
 * what the code shows, the project's rules and the organizing plan. It is worked out here, on the server, so the
 * browser only draws it and a new skin does not have to work any of it out again. The fixed words are English and
 * the same for every project (Spec §6.13). Pure reads; nothing here changes an asset.
 */
import type { Attribution, EntryMark, KeeperJob, PendingMaterial, Project, ProjectRule, ScopeClassification, ScopeItem, Source, Statement, WorktreeSummary } from '../model/types.ts';
import { ORGANIZING_LEVEL, OWNER_WORDS, type Basis, type CarryOut, type Identity, type MarkKind, type OrganizingLevel, type Validity } from '../model/vocab.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { anchorLabel } from '../sources/anchor.ts';
import { displayMaterialTime, reportedBy } from '../model/time.ts';
import { rulesByGroup } from '../keeper/rules.ts';
import { worktreeSentence } from '../scope/worktree.ts';
import { ignoredPlaceOf, ruleText, type IgnoredPlace } from '../scope/ignored-place.ts';
import { listMaterials, materialKeyOf, ruleSettlement, settledAwayMaterials } from '../keeper/organize/materials.ts';
import { clerkLevels, clerkPending } from '../keeper/organize/clerk-coverage.ts';

/** The one group the owner's words are drawn in on top of the graph, and listed in above every area (§6.3, D63). */
export const OWNER_WORDS_GROUP = OWNER_WORDS;

/** The organizing plan's id: one plan per project (§3.7). */
const PLAN_ID = 'organizing-plan';

export interface SourceRow { readonly id: string; readonly title: string; readonly label: string }

export function sourceRow(store: ProjectStore, id: string): SourceRow {
  const s = store.sources.get(id);
  return s ? { id, title: s.title, label: anchorLabel(s.anchor) } : { id, title: id, label: id };
}

/** An object's name as the workbench shows it: the graph's label, else the item's own name. */
export function objectLabel(store: ProjectStore, id: string): string {
  const source = store.sources.get(id);
  return store.nodes.get(id)?.label ?? store.reference.get(id)?.name ?? store.threads.get(id)?.title ?? store.rules.get(id)?.summary ?? (source ? anchorLabel(source.anchor) : id);
}

// ───────────────────────── Removed (§2.1, D61) ─────────────────────────

/**
 * Whether the object behind an id was removed from the project's current version. The item's own validity decides;
 * the graph's copy of it is only read for an object that is not a reference item or a work item.
 */
export function isRemoved(store: ProjectStore, id: string): boolean {
  const validity: Validity | undefined = store.reference.get(id)?.validity ?? store.threads.get(id)?.validity ?? store.nodes.get(id)?.validity;
  return validity === 'Removed';
}

// ───────────────────────── the authority layer (§1.9, §6.4) ─────────────────────────

export interface AuthorityView {
  /** The three layers of §1.9: the owner decided it; a role set it within its responsibilities; a role set it in the owner's place. Null for what is none of them (a proposal, a report, an interpretation). */
  readonly layer: 'Owner' | 'Role' | 'Decided without owner' | null;
  readonly label: string;
  /** For `Decided without owner`: whether it is in force now, and that it waits for the owner. */
  readonly detail: string | null;
  readonly identity: Identity | null;
  readonly who: string | null;
  /** When it was set, as the material gives it (a date stays a date, §1.8). */
  readonly at: string | null;
  readonly inForce: boolean;
  readonly markId: string | null;
}

function authorName(a: Attribution): string | null {
  if (a.author.kind === 'owner') return 'the owner';
  return a.author.name?.trim() || a.holder?.role || null;
}

function openMark(store: ProjectStore, targetId: string, kind: MarkKind): EntryMark | undefined {
  return store.marks.find((m) => m.targetId === targetId && m.kind === kind && !m.closed);
}

/** The authority layer of a product reference item (§1.3: every item carries it; §1.9, §6.4). */
export function authorityOf(store: ProjectStore, referenceId: string): AuthorityView | null {
  const item = store.reference.get(referenceId);
  if (!item) return null;
  // An item written without its attribution (older assets) has no layer to show, unless a mark says who set it.
  const identity = item.attribution?.identity ?? null;
  const author = item.attribution ? authorName(item.attribution) : null;
  const inForce = item.validity === 'Current';
  const mark = openMark(store, referenceId, 'Decided without owner');
  if (mark) {
    const who = mark.decidedBy?.who ?? author;
    const at = mark.decidedBy?.at ?? null;
    return {
      layer: 'Decided without owner', identity, who, at, inForce, markId: mark.id,
      label: `Decided without owner: set by ${who ?? 'a role'}${at ? `, ${displayMaterialTime(at)}` : ''}`,
      detail: inForce ? 'In force now. Not decided by the owner; pending the owner’s decision.' : `Not in force: ${item.validity}.`,
    };
  }
  if (identity === 'Decision') {
    return { layer: 'Owner', label: item.category === OWNER_WORDS ? "The owner's own words" : 'Decided by the owner', detail: null, identity, who: 'the owner', at: null, inForce, markId: null };
  }
  if (identity === 'Artifact') {
    return { layer: 'Role', label: `Set by ${author ?? 'a role'} within its responsibilities`, detail: null, identity, who: author, at: null, inForce, markId: null };
  }
  if (!identity) return null;
  return { layer: null, label: author ? `${identity} · ${author}` : identity, detail: null, identity, who: author, at: null, inForce, markId: null };
}

// ───────────────────────── a decision's carry-out (§2.2, §6.4) ─────────────────────────

export interface CarryOutView {
  readonly status: CarryOut | null;          // null when work is linked by `carries out` but no carry-out was recorded
  readonly remaining: string | null;
  readonly work: readonly { readonly id: string; readonly label: string; readonly progress: string | null; readonly validity: string | null; readonly removed: boolean }[];
  readonly evidence: readonly SourceRow[];
  readonly at: string | null;
}

/** Whether a decision that asks for something was carried out, and the work that carries it out (each opens by id). */
export function carryOutOf(store: ProjectStore, referenceId: string): CarryOutView | null {
  const item = store.reference.get(referenceId);
  if (!item) return null;
  const recorded = item.carryOut ?? null;
  const linked = store.relations.filter((r) => r.type === 'carries out' && r.to === referenceId).map((r) => r.from);
  const workIds = [...new Set([...(recorded?.workIds ?? []), ...linked])];
  if (!recorded && workIds.length === 0) return null;
  return {
    status: recorded?.status ?? null,
    remaining: recorded?.remaining ?? null,
    work: workIds.map((id) => {
      const t = store.threads.get(id);
      return { id, label: objectLabel(store, id), progress: t?.progress ?? null, validity: t?.validity ?? null, removed: isRemoved(store, id) };
    }),
    evidence: (recorded?.evidenceSourceIds ?? []).map((id) => sourceRow(store, id)),
    at: recorded?.at ?? null,
  };
}

// ───────────────────────── claims and what the code shows (§2.4, §6.4) ─────────────────────────

export interface StatementView extends Statement {
  /** `Reported by <who>, <date>` for a claim that says whose it is (§2.4); null for anything else. */
  readonly reportedBy: string | null;
  /** The project's `Untrusted` rule that covers the claim's source (§1.15). */
  readonly untrusted: { readonly ruleId: string; readonly summary: string } | null;
  /** For an observation: the code it was observed in, with file, lines and commit. */
  readonly code: readonly { readonly id: string; readonly label: string }[];
}

/**
 * A check that found a material and something else disagreeing — the code, above all (§1.6 `contradicts`, §2.4). It
 * is recorded between the material and the code, not on one statement, so it is shown with the material the claims
 * rest on (`on`), in the check's own words: a receipt usually holds several claims, and the check says which one.
 */
export interface CheckView {
  readonly relationId: string;
  readonly claim: string;
  readonly on: SourceRow;
  readonly otherId: string;
  readonly otherLabel: string;
  readonly otherIsSource: boolean;
  /** Whether the other end is code: this is the check against the code (§2.4). */
  readonly code: boolean;
}

function isCodeSource(store: ProjectStore, id: string): boolean {
  const s = store.sources.get(id);
  return s !== undefined && (s.usedAs === 'Code' || s.anchor.kind === 'commit');
}

function codeLocation(store: ProjectStore, id: string): string {
  const s = store.sources.get(id)!;
  return `${anchorLabel(s.anchor)}${s.version.commit && s.anchor.kind !== 'commit' ? ` @ ${s.version.commit.slice(0, 10)}` : ''}`;
}

/**
 * One statement of a fact record or a work item as the details show it: a claim says who made it and when, and that
 * its source is one the project marks untrusted; an observation made in the code carries where. A claim nothing was
 * checked against stays as it was reported (§2.4).
 */
export function statementView(store: ProjectStore, s: Statement): StatementView {
  const ruleId = s.claimedBy?.untrustedRuleId ?? null;
  return {
    ...s,
    reportedBy: s.type === 'Claimed' && s.claimedBy ? reportedBy(s.claimedBy) : null,
    untrusted: ruleId ? { ruleId, summary: store.rules.get(ruleId)?.summary ?? ruleId } : null,
    code: s.type === 'Observed' ? s.sourceIds.filter((id) => isCodeSource(store, id)).map((id) => ({ id, label: codeLocation(store, id) })) : [],
  };
}

/**
 * The checks recorded on the materials claims rest on (`contradicts`, §1.6, §2.4), each shown once. When both ends are
 * among them, the claim's side is the one that is not code.
 */
export function checksOn(store: ProjectStore, materialIds: readonly string[]): CheckView[] {
  const materials = new Set(materialIds);
  return store.relations
    .filter((r) => r.type === 'contradicts' && (materials.has(r.from) || materials.has(r.to)))
    .map((r) => {
      const fromIn = materials.has(r.from);
      const toIn = materials.has(r.to);
      const onId = fromIn && !toIn ? r.from : toIn && !fromIn ? r.to : isCodeSource(store, r.from) ? r.to : r.from;
      const otherId = onId === r.from ? r.to : r.from;
      const other = store.sources.get(otherId);
      return { relationId: r.id, claim: r.claim, on: sourceRow(store, onId), otherId, otherLabel: other ? codeLocation(store, otherId) : objectLabel(store, otherId), otherIsSource: other !== undefined, code: isCodeSource(store, otherId) };
    });
}

/** The materials the claims among these statements rest on. */
export function claimMaterials(statements: readonly Statement[]): string[] {
  return [...new Set(statements.filter((s) => s.type === 'Claimed').flatMap((s) => s.sourceIds))];
}

// ───────────────────────── How this project works (§1.15, §6.7; CKC-21 AC-11) ─────────────────────────

export const CONFIRMED = 'Confirmed by the owner';
export const WAITING = 'Waiting for the owner to confirm';
export const WRITTEN = 'Written in the project';

/** A mark on a rule, as the rule's row shows it; for `Decided without owner`, who set it, when, and whether it is in force. */
export interface RuleMarkView { readonly id: string; readonly kind: MarkKind; readonly clue: string; readonly who: string | null; readonly at: string | null; readonly inForce: boolean; readonly label: string; readonly detail: string }
export interface RuleView {
  readonly id: string;
  readonly group: ProjectRule['group'];
  readonly category: ProjectRule['category'];
  readonly summary: string;
  readonly excerpt: string | null;
  readonly sources: readonly SourceRow[];
  readonly appliesTo: readonly string[];
  readonly basis: ProjectRule['basis'];
  readonly validity: Validity;
  /** Whether the owner confirmed it, it waits for them (inferred), or the project writes it down. */
  readonly confirmation: { readonly state: typeof CONFIRMED | typeof WAITING | typeof WRITTEN; readonly quote: string | null; readonly at: string | null; readonly source: SourceRow | null };
  readonly ownerSystem: string | null;
  readonly differsInPractice: readonly { readonly text: string; readonly sources: readonly SourceRow[] }[];
  readonly replacedBy: { readonly id: string; readonly summary: string } | null;
  readonly marks: readonly RuleMarkView[];
}

function ruleMark(m: EntryMark, validity: Validity): RuleMarkView {
  const inForce = validity === 'Current';
  const who = m.decidedBy?.who ?? null;
  const at = m.decidedBy?.at ?? null;
  if (m.kind !== 'Decided without owner') return { id: m.id, kind: m.kind, clue: m.clue, who, at, inForce, label: m.kind, detail: m.clue };
  return {
    id: m.id, kind: m.kind, clue: m.clue, who, at, inForce,
    label: `Decided without owner: set by ${who ?? 'a role'}${at ? `, ${displayMaterialTime(at)}` : ''}`,
    detail: inForce ? 'In force now. Not decided by the owner; pending the owner’s decision.' : `Not in force: ${validity}.`,
  };
}

function ruleView(store: ProjectStore, r: ProjectRule): RuleView {
  return {
    id: r.id, group: r.group, category: r.category, summary: r.summary, excerpt: r.excerpt,
    sources: r.sourceIds.map((id) => sourceRow(store, id)),
    appliesTo: r.appliesTo, basis: r.basis, validity: r.validity,
    confirmation: r.ownerConfirmation
      ? { state: CONFIRMED, quote: r.ownerConfirmation.quote, at: r.ownerConfirmation.at, source: sourceRow(store, r.ownerConfirmation.sourceId) }
      : { state: r.basis === 'Inferred' ? WAITING : WRITTEN, quote: null, at: null, source: null },
    ownerSystem: r.ownerSystem,
    differsInPractice: r.differsInPractice.map((d) => ({ text: d.text, sources: d.sourceIds.map((id) => sourceRow(store, id)) })),
    replacedBy: r.replacedBy ? { id: r.replacedBy, summary: store.rules.get(r.replacedBy)?.summary ?? r.replacedBy } : null,
    marks: store.marks.filter((m) => m.targetId === r.id && !m.closed).map((m) => ruleMark(m, r.validity)),
  };
}

export interface HowThisProjectWorksView {
  /** The ways of working the owner summarized that the rules come from, listed first (§1.15, §6.7). */
  readonly ownerSystems: readonly string[];
  readonly groups: readonly { readonly group: ProjectRule['group']; readonly rules: readonly RuleView[]; readonly replaced: readonly RuleView[] }[];
  readonly counts: { readonly rules: number; readonly waiting: number; readonly replaced: number };
}

/**
 * Every rule of the project in the three fixed groups (§1.15, §6.7; CKC-21 AC-11): what the owner summarized first in
 * its group, each with its sources, what it applies to, its basis and whether the owner confirmed it; replaced rules
 * apart, each pointing to the one that replaced it. A group the project has no rule in is left out.
 */
export function howThisProjectWorks(store: ProjectStore): HowThisProjectWorksView {
  const groups = rulesByGroup(store.rules.all()).map((g) => ({ group: g.group, rules: g.rules.map((r) => ruleView(store, r)), replaced: g.replaced.map((r) => ruleView(store, r)) }));
  const shown = groups.flatMap((g) => g.rules);
  return {
    ownerSystems: [...new Set(shown.map((r) => r.ownerSystem).filter((s): s is string => Boolean(s)))],
    groups,
    counts: { rules: shown.length, waiting: shown.filter((r) => r.confirmation.state === WAITING).length, replaced: groups.reduce((n, g) => n + g.replaced.length, 0) },
  };
}

// ───────────────────────── the organizing plan and focus (§3.7, §6.7) ─────────────────────────

export interface OrganizingPlanView {
  readonly byRule: readonly { readonly what: string; readonly targets: readonly string[]; readonly treatment: string; readonly rule: { readonly id: string; readonly summary: string; readonly category: string | null; readonly validity: Validity | null } }[];
  readonly readClosely: readonly { readonly what: string; readonly targets: readonly string[]; readonly why: string }[];
  readonly focus: readonly { readonly what: string; readonly why: string; readonly sources: readonly SourceRow[] }[];
  readonly order: readonly string[];
  readonly corrections: readonly { readonly at: string; readonly quote: string; readonly changed: string; readonly source: SourceRow; readonly previous: { readonly byRule: readonly { readonly what: string; readonly targets: readonly string[]; readonly treatment: string }[]; readonly readClosely: readonly { readonly what: string }[]; readonly focus: readonly { readonly what: string }[]; readonly order: readonly string[] } }[];
  readonly jobId: string | null;
  readonly asOf: string;
  readonly updatedAt: string;
}

/** The framing round's plan for the organizing that follows, with the owner's corrections and what each replaced (§3.7). */
export function organizingPlanView(store: ProjectStore): OrganizingPlanView | null {
  const plan = store.plans.get(PLAN_ID) ?? store.plans.all()[0];
  if (!plan) return null;
  const rule = (id: string) => { const r = store.rules.get(id); return { id, summary: r?.summary ?? id, category: r?.category ?? null, validity: r?.validity ?? null }; };
  return {
    byRule: plan.byRule.map((e) => ({ what: e.what, targets: e.targets, treatment: e.treatment, rule: rule(e.ruleId) })),
    readClosely: plan.readClosely.map((e) => ({ what: e.what, targets: e.targets, why: e.why })),
    focus: plan.focus.map((f) => ({ what: f.what, why: f.why, sources: f.sourceIds.map((id) => sourceRow(store, id)) })),
    order: plan.order,
    corrections: plan.corrections.map((c) => ({ at: c.at, quote: c.quote, changed: c.changed, source: sourceRow(store, c.sourceId), previous: c.previous })),
    jobId: plan.jobId, asOf: plan.asOf, updatedAt: plan.updatedAt,
  };
}

/**
 * What the assets say about a rule or about the plan, for the conversation opened on it (§6.8): the owner confirms or
 * corrects it there, and the Keeper starts from what is recorded.
 */
export function ruleOrPlanSummary(store: ProjectStore, kind: string, id: string): { text: string; sourceIds: string[] } | null {
  if (kind === 'rule') {
    const r = store.rules.get(id);
    if (!r) return null;
    const v = ruleView(store, r);
    const lines = [
      v.summary,
      [v.group, v.category, v.basis, v.confirmation.state, v.validity === 'Current' ? null : v.validity].filter(Boolean).join(' · '),
      v.excerpt ? `The project’s words: “${v.excerpt}”` : null,
      v.appliesTo.length ? `Applies to: ${v.appliesTo.join(', ')}` : null,
      v.ownerSystem ? `From the way of working the owner summarized: ${v.ownerSystem}` : null,
      ...v.differsInPractice.map((d) => `Differs in practice: ${d.text}`),
      v.confirmation.quote ? `The owner confirmed it: “${v.confirmation.quote}”` : null,
      v.replacedBy ? `Replaced by ${v.replacedBy.id}: ${v.replacedBy.summary}` : null,
      ...v.marks.map((m) => `${m.label}. ${m.detail}`),
    ];
    return { text: lines.filter((l): l is string => Boolean(l)).join('\n'), sourceIds: [...r.sourceIds] };
  }
  if (kind === 'plan') {
    const p = organizingPlanView(store);
    if (!p) return null;
    const lines = [
      ...p.byRule.map((e) => `Settled by a rule: ${e.what} (${e.targets.join(', ')}) → ${e.treatment}, by “${e.rule.summary}”`),
      ...p.readClosely.map((e) => `Read closely: ${e.what}${e.targets.length ? ` (${e.targets.join(', ')})` : ''}${e.why ? ` — ${e.why}` : ''}`),
      ...p.focus.map((f) => `Focus: ${f.what}${f.why ? ` — ${f.why}` : ''}`),
      p.order.length ? `Order: ${p.order.join(' → ')}` : null,
      ...p.corrections.map((c) => `The owner corrected it (${displayMaterialTime(c.at)}): “${c.quote}” — ${c.changed}`),
    ];
    return { text: lines.filter((l): l is string => Boolean(l)).join('\n'), sourceIds: [...new Set(p.focus.flatMap((f) => f.sources.map((s) => s.id)))] };
  }
  return null;
}

// ───────────────────────── the scope list (§1.1, §6.7; CKC-04 AC-13–AC-17) ─────────────────────────

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export interface WorktreeView {
  readonly merged: boolean | null;
  /** `Merged into main · 15 files: 14 the same as main, skipped · took 1: src/a.ts (uncommitted change)` — the facts AC-15 asks the listing to give, in one line. */
  readonly sentence: string;
  readonly taken: readonly { readonly path: string; readonly kind: string; readonly deleted: boolean }[];
  readonly takenMore: number;
}

/**
 * A worktree in a place the project's ignore rules leave out (§1.1, D105; CKC-04 AC-17): its working files are not
 * pending — how many there are, and how many of them are uncommitted changes, as counts — and its branch and commits are
 * still read from version control.
 */
function ignoredPlaceSentence(w: WorktreeSummary, place: IgnoredPlace): string {
  const uncommitted = w.taken.filter((t) => t.kind === 'Uncommitted change').length;
  return `In a directory the project’s ignore rules leave out (${ruleText(place.rule)}): its ${plural(w.files, 'working file')} (${plural(uncommitted, 'uncommitted change')} among them) are not counted as pending; its branch and commits are read from version control`;
}

function worktreeViewOf(w: WorktreeSummary, place: IgnoredPlace | null = null): WorktreeView {
  if (place && !w.error) { const plain = worktreeViewOf(w); return { ...plain, sentence: `${plain.sentence} · ${ignoredPlaceSentence(w, place)}` }; }
  if (w.error) return { merged: w.merged, sentence: `Could not be measured against the trunk: ${w.error}; nothing taken from it`, taken: [], takenMore: 0 };
  const trunk = w.trunk?.ref ?? 'the trunk';
  const state = w.merged === null ? `Merge with ${trunk} unknown (git could not tell)`
    : w.merged ? `Merged into ${trunk}`
      : `Not merged into ${trunk}: ${plural(w.uniqueCommits, 'commit')} ${trunk} does not have (work in progress, not ${trunk}’s current state)`;
  const skipped = `${plural(w.files, 'file')}: ${w.sameAsTrunk} the same as ${trunk}, skipped${w.olderVersions ? `; ${plural(w.olderVersions, 'older version')} ${trunk} has moved past, left to the version history` : ''}`;
  const taken = w.taken.slice(0, 12).map((t) => ({ path: t.path, kind: t.kind as string, deleted: t.deleted === true }));
  const takenText = w.taken.length === 0 ? 'nothing taken'
    : `took ${w.taken.length}: ${taken.map((t) => `${t.path} (${t.kind.toLowerCase()}${t.deleted ? ', removed' : ''})`).join(', ')}${w.taken.length > 12 ? `, and ${w.taken.length - 12} more` : ''}`;
  return { merged: w.merged, sentence: `${state} · ${skipped} · ${takenText}`, taken, takenMore: Math.max(0, w.taken.length - taken.length) };
}

export interface IgnoredView {
  /** Which ignore file, line and pattern leaves this out: `.gitignore line 4: drafts/`. */
  readonly rule: string;
  /** The directory's contents summed up, with any documents named: those may carry intent, so the owner decides (AC-17). */
  readonly sentence: string;
  readonly files: number;
  readonly documents: number;
  readonly documentNames: readonly string[];
}

function ignoredViewOf(ig: NonNullable<ScopeItem['ignoredBy']>): IgnoredView {
  const rule = ig.file === 'git' && ig.line === 0 ? 'git’s ignore rules' : `${ig.file} line ${ig.line}: ${ig.pattern}`;
  const docs = ig.documents
    ? `, ${ig.documents} of them ${ig.documents === 1 ? 'a document' : 'documents'} (${ig.documentNames.join(', ')}${ig.documents > ig.documentNames.length ? ', …' : ''}) — the owner decides whether to include ${ig.documents === 1 ? 'it' : 'them'}`
    : '';
  // What the ignore rules leave out is not pending (§1.1, D105): said with the count, in the same line.
  return { rule, files: ig.files, documents: ig.documents, documentNames: ig.documentNames, sentence: `${plural(ig.files, 'file')} left out${docs} · not counted as pending` };
}

export interface ClassificationView {
  readonly by: 'program' | 'keeper' | 'owner';
  readonly basis: Basis;
  readonly kind: string | null;
  /** Who classified the location, marked when it is an inference: a program candidate waits for the Keeper's judgement. */
  readonly sentence: string;
}

function classificationViewOf(c: ScopeClassification): ClassificationView {
  const who = c.by === 'owner' ? 'Classified by the owner' : c.by === 'keeper' ? 'Classified by the Keeper' : 'Offered by the program — not yet judged by the Keeper';
  return { by: c.by, basis: c.basis, kind: c.kind, sentence: `${who} (${c.basis})${c.kind ? `: ${c.kind}` : ''}${c.evidence.length ? ` — ${c.evidence.join('; ')}` : ''}` };
}

export interface ScopeItemView {
  readonly item: ScopeItem;
  /** The item's reason as shown: for a measured worktree, without the measured sentence the discovery appended to it, which `worktree.sentence` says in its own line (V15). */
  readonly reason: string;
  readonly worktree: WorktreeView | null;
  readonly ignored: IgnoredView | null;
  readonly classification: ClassificationView | null;
  /** The project's material rules that cover this location, with their words; each opens its rule in How this project works. */
  readonly covers: readonly { readonly ruleId: string; readonly summary: string; readonly category: string | null; readonly excerpt: string | null }[];
}

export interface ScopeListView {
  readonly inScope: readonly ScopeItemView[];
  /** What the project uses, not its own intent: listed apart (AC-13). */
  readonly thirdParty: readonly ScopeItemView[];
  /** Build output, caches and exports: listed apart (AC-13). */
  readonly generated: readonly ScopeItemView[];
  /** Directories the ignore rules leave out that hold documents: intent may be in them, so the owner decides (AC-17). */
  readonly ignoredDocuments: readonly ScopeItemView[];
  readonly excluded: readonly ScopeItemView[];
}

/**
 * A worktree's reason without the measured sentence the discovery puts at its end (`… · merged into main · 34 files: …`,
 * src/scope/discover.ts): the listing says those facts in the worktree's own line, so the reason keeps what comes before.
 * A reason that does not end that way (an older store, one the owner wrote) is left whole.
 */
export function reasonShown(item: ScopeItem): string {
  if (!item.worktree) return item.reason;
  const tail = ` · ${worktreeSentence(item.worktree)}`;
  return item.reason.endsWith(tail) ? item.reason.slice(0, -tail.length) : item.reason;
}

/** The scope list sectioned for Project scope: third-party material and generated output apart, ignored directories holding documents apart (§6.7; CKC-04 AC-13, AC-17). */
export function scopeListView(project: Project): ScopeListView {
  const view = (item: ScopeItem): ScopeItemView => ({
    item,
    reason: reasonShown(item),
    worktree: item.worktree ? worktreeViewOf(item.worktree, ignoredPlaceOf(project.scope, item)) : null,
    ignored: item.ignoredBy ? ignoredViewOf(item.ignoredBy) : null,
    classification: item.classification ? classificationViewOf(item.classification) : null,
    covers: (item.coveredBy ?? []).map((c) => ({ ruleId: c.ruleId, summary: c.summary, category: c.category, excerpt: c.excerpt })),
  });
  const all = project.scope.map(view);
  const holdsDocuments = (x: ScopeItemView) => x.item.relation === 'Excluded' && (x.item.ignoredBy?.documents ?? 0) > 0;
  return {
    inScope: all.filter((x) => x.item.relation !== 'Excluded' && x.item.relation !== 'Third-party material' && x.item.relation !== 'Generated'),
    thirdParty: all.filter((x) => x.item.relation === 'Third-party material'),
    generated: all.filter((x) => x.item.relation === 'Generated'),
    ignoredDocuments: all.filter(holdsDocuments),
    excluded: all.filter((x) => x.item.relation === 'Excluded' && !holdsDocuments(x)),
  };
}

// ───────────────────────── the toolchain (§3.1, §6.7; CKC-03 AC-23) ─────────────────────────

export interface ToolchainView {
  readonly entries: readonly { readonly path: string; readonly reason: string; readonly configPath: string; readonly used: boolean; readonly notUsedReason: string | null }[];
  /** What the Keeper uses these locations for, and how the owner corrects a wrong one. */
  readonly note: string;
}

/** The toolchain locations the project's own configuration points at (§6.7); a location too broad to open is listed with why, never used. */
export function toolchainView(project: Project): ToolchainView | null {
  const entries = (project.toolchain ?? []).map((t) => ({ path: t.path, reason: t.reason, configPath: t.configPath, used: t.used !== false, notUsedReason: t.notUsedReason ?? null }));
  if (entries.length === 0) return null;
  return {
    entries,
    note: 'Locations the project’s own configuration points at (an SDK, a compiler). The Keeper may read them to make sense of the build environment; they are not project material. A wrong entry is corrected through Ask Keeper.',
  };
}

// ───────────────────────── what the project's rules settle directly (§1.11, §3.7) ─────────────────────────

export interface SettledByRuleView {
  readonly materials: number;
  readonly byRule: readonly {
    readonly ruleId: string;
    readonly summary: string;
    /** `plan`: the organizing plan names the material under the rule; `sources`: the rule set how every one of its sources is used; `away`: the rule took it out of what is organized altogether. */
    readonly via: 'plan' | 'sources' | 'away';
    readonly count: number;
    readonly names: readonly string[];
  }[];
}

/**
 * The materials the project's own rules settle directly — judged, never read closely (Spec §3.7; CKC-13 AC-30) —
 * grouped by the rule that settles them, so the coverage's `Settled by rule` level says which rule or plan decided it.
 * Derived from the assets the way the planner derives it; null when no rule settles anything.
 */
export function settledByRuleView(store: ProjectStore, project: Project): SettledByRuleView | null {
  const materials = listMaterials(store, project);
  const plan = store.plans.get(PLAN_ID) ?? null;
  const groups = new Map<string, { via: 'plan' | 'sources' | 'away'; count: number; names: string[] }>();
  const add = (ruleId: string, via: 'plan' | 'sources' | 'away', name: string) => {
    const g = groups.get(ruleId) ?? { via, count: 0, names: [] };
    g.count += 1;
    if (g.names.length < 4 && !g.names.includes(name)) g.names.push(name);
    groups.set(ruleId, g);
  };
  for (const m of materials) { const s = ruleSettlement(store, plan, m); if (s) add(s.ruleId, s.via, m.rel); }
  for (const m of settledAwayMaterials(store, project, new Set(materials.map((x) => x.key)))) add(m.ruleId, 'away', m.rel);
  if (groups.size === 0) return null;
  const byRule = [...groups]
    .map(([ruleId, g]) => ({ ruleId, summary: store.rules.get(ruleId)?.summary ?? ruleId, via: g.via, count: g.count, names: g.names }))
    .sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));
  return { materials: byRule.reduce((n, r) => n + r.count, 0), byRule };
}

// ───────────────────────── each material's organizing level (§1.11, §6.7) ─────────────────────────

export interface OrganizingLevels {
  /** The fixed level names, for the sources list's filter: from the vocabulary, not written into the interface. */
  readonly levels: readonly OrganizingLevel[];
  /** The level of one source, or null when it is not an organized material (a command run, a status record, a moved-away or deleted file). */
  readonly ofSource: (source: Source) => OrganizingLevel | null;
}

/**
 * The organizing level of every material, computed the way the coverage table counts it (`clerkLevels`, fed the same
 * pending list), so the sources list's level filter and the coverage table always agree: settled by a rule, not
 * organized while a change waits, read in full by a step, conclusions only for a drafted session, sampled through a
 * read series, indexed otherwise. What a rule took out of the material altogether is settled by that rule.
 */
export function organizingLevels(store: ProjectStore, project: Project, watcher: readonly PendingMaterial[] = []): OrganizingLevels {
  const materials = listMaterials(store, project);
  const { keys: pendingKeys } = clerkPending(store, project, watcher, materials);
  const { levelOf } = clerkLevels(store, project, pendingKeys, materials);
  const awayPaths = new Set(settledAwayMaterials(store, project, new Set(materials.map((m) => m.key))).map((m) => m.key.slice('file:'.length)));
  const ofSource = (source: Source): OrganizingLevel | null => {
    if (source.anchor.kind === 'file' && awayPaths.has(source.anchor.path)) return 'Settled by rule';
    const key = materialKeyOf(source);
    return key ? levelOf.get(key) ?? null : null;
  };
  return { levels: ORGANIZING_LEVEL, ofSource };
}

// ───────────────────────── Keeper activity (§6.9) ─────────────────────────

/** What a job's saved results open in Project scope: the rules it recorded and the plan and focus (§6.9, §3.7). */
export function jobOpens(job: KeeperJob): { rules: number; plan: boolean } {
  return {
    rules: new Set(job.savedResults.filter((r) => r.collection === 'rules').map((r) => r.id)).size,
    plan: job.savedResults.some((r) => r.collection === 'plans'),
  };
}
