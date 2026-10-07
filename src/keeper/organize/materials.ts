/**
 * Materials: the units material organizing works on (Spec §3.3 "一份材料或一段会话"). A file is
 * one material (all its sections), a session segment is one material, the commits of a repository
 * are one material. Materials are tiered: intent material first (product reference), then the
 * active slice the first usable picture is formed from (chosen by relevance, bounded, D37) plus
 * whatever appeared after the takeover started, then history (Spec §3.7 stage 2 and 4, §3.8).
 */
import { statSync } from 'node:fs';
import { sep } from 'node:path';
import type { OrganizingPlanContent, Project, ProjectRule, Source } from '../../model/types.ts';
// The material rules themselves reach the sources they cover in intake/material-rules.ts (a Recovery only place is
// History only, a Reference only one is Reference only); what is left here is how the planner follows them.
import type { ProjectStore } from '../../store/project-store.ts';
import { isRulesSource, isTestFixturePath, selectFirstUsable, type Candidate, type FrameRole } from './takeover.ts';
import { isWithin, samePath } from '../../util/paths.ts';
import { isDocumentPath, readingOf, skippedSegment } from '../../scope/skip.ts';
import { planEntryFor } from '../rules.ts';

export type Tier = 'intent' | 'active' | 'history';

export interface Material {
  readonly key: string;
  readonly kind: 'file' | 'session' | 'commits';
  readonly label: string;
  /** Coverage reference: path, native session file, or repository. */
  readonly ref: string;
  /** Batching group: directory, or host:session. */
  readonly group: string;
  readonly sourceIds: readonly string[];
  readonly chars: number;
  readonly recency: string;
  readonly tier: Tier;
  readonly intent: boolean;
  readonly scopeItemId: string | null;
  /** Path inside its scope item (relevance and level rules look at this, never at the directories above the project). */
  readonly rel: string;
  /** Its part in the round-1 frame (Spec §3.7 stage 2), or null when round 1 does not read it. */
  readonly frame: FrameRole | null;
  /** One of the places the project writes its rules down (Spec §1.15, §3.7): read before anything else in round 1. */
  readonly rulesSource?: boolean;
}

const INTENT_RE = /(^|[\\/])(design|designs|product|docs?|spec|specs|prd|plan|plans|planning|decision|decisions|contracts?|requirements?|adr|rfc|roadmap|vision|readme|agents|claude)([\\/.]|$)|(prd|spec|plan|decision|readme|roadmap|requirement|module|product|design)[^\\/]*\.md$/i;

/** Intent is judged on the path inside the project (root: the scope item's path), never on the directories above it. */
export function isIntentPath(path: string, root: string | null = null): boolean {
  const inside = root && path.toLowerCase().startsWith(root.toLowerCase()) ? path.slice(root.length) : path;
  const lower = inside.replace(/\\/g, '/').toLowerCase();
  // Build output, dependencies and vendored code are the skip list's (scope/skip.ts); archives and trash are this one's;
  // what the tests keep as fixtures is the test side's (takeover.ts).
  if (skippedSegment(lower) !== null || isTestFixturePath(lower) || /(^|\/)(archive|archived|old|legacy|trash|deleted?|superseded)(\/|$)/.test(lower)) return false;
  return INTENT_RE.test(lower);
}

export function materialKeyOf(source: Source): string | null {
  const a = source.anchor;
  if (a.kind === 'file') return `file:${a.path}`;
  if (a.kind === 'session') return `session:${source.id}`;
  if (a.kind === 'commit') return `commits:${a.repo}`;
  return null;
}

function mtimeOf(path: string, fallback: string): string {
  try { return new Date(statSync(path).mtimeMs).toISOString(); } catch { return fallback; }
}

/**
 * When a commit was made: the time intake records on its anchor (sources/gitobs.ts), never parsed out of the excerpt it
 * writes for people to read. A commit source written before the anchor carried the time is not read again — intake
 * reads only the commits since its last pass, and an unchanged source is kept as it is — so for such a record the
 * "at:" line the intake of that time wrote into its excerpt stands in; that excerpt is never rewritten. With no time at
 * all, null: when a commit was read says nothing about when it was made.
 */
function commitTime(s: Source): string | null {
  if (s.anchor.kind !== 'commit') return null;
  const recorded = s.anchor.at !== undefined ? s.anchor.at : /^at: (.+)$/m.exec(s.excerpt)?.[1]?.trim();
  const at = Date.parse(recorded ?? '');
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

export function listMaterials(store: ProjectStore, project: Project, options: { readonly now?: number } = {}): Material[] {
  const now = options.now ?? Date.now();
  const byKey = new Map<string, { kind: Material['kind']; label: string; ref: string; group: string; ids: string[]; chars: number; recency: string; intent: boolean; scopeItemId: string | null; rel: string }>();
  const roots = new Map(project.scope.map((i) => [i.id, i.path]));
  // The project's own root comes first: a file inside the project keeps its place in it (design/archive/… stays
  // archived) even when a directory below it is also a scope item of its own.
  const under = (path: string, root: string) => root.length > 0 && path.toLowerCase().startsWith(root.toLowerCase());
  const relOf = (path: string, scopeItemId: string): string => {
    const own = project.locations.filter((l) => under(path, l)).sort((a, b) => a.length - b.length)[0];
    const root = own ?? roots.get(scopeItemId);
    return root && under(path, root) ? path.slice(root.length).replace(/^[\\/]+/, '') : fromTheDrive(path);
  };
  // A directory the owner excluded is out of the project even when its files were read before it was excluded
  // (2026-09-18: copies of the Keeper's own context packs under subagent/runs were organized as project material).
  const excluded = project.scope.filter((i) => i.relation === 'Excluded').map((i) => i.path);
  for (const s of store.sources.all()) {
    // What exists only in history (kept for recovery only, or read from version history) is never material to organize
    // (§1.2, D61); nor is what is for reference only, which is looked up and cited when needed (§1.2, §1.15).
    if (s.availability === 'No longer available' || s.usedAs === 'History only' || s.usedAs === 'Reference only') continue;
    const filePath = s.anchor.kind === 'file' ? s.anchor.path : null;
    if (filePath !== null && excluded.some((root) => isWithin(root, filePath))) continue;
    // What the scope reads from where (Spec §1.1; scope/skip.ts): nothing from generated output or a place left out,
    // nothing current from a place kept for recovery only, and only the documents of third-party material.
    if (filePath !== null && !readAsMaterial(project, filePath)) continue;
    const key = materialKeyOf(s);
    if (!key) continue;
    const a = s.anchor;
    let entry = byKey.get(key);
    if (!entry) {
      if (a.kind === 'file') {
        const dir = a.path.replace(/[\\/][^\\/]*$/, '');
        entry = { kind: 'file', label: a.path, ref: a.path, group: dir, ids: [], chars: 0, recency: mtimeOf(a.path, s.version.readAt), intent: isIntentPath(relOf(a.path, s.scopeItemId)), scopeItemId: s.scopeItemId, rel: relOf(a.path, s.scopeItemId) };
      } else if (a.kind === 'session') {
        // The owner's messages in the Keeper conversation are handled in the turn itself, not organized again.
        if (a.host === 'pi') continue;
        entry = { kind: 'session', label: s.title, ref: a.file, group: `${a.host}:${a.sessionId}`, ids: [], chars: 0, recency: a.at ?? s.version.readAt, intent: false, scopeItemId: s.scopeItemId, rel: s.title };
      } else if (a.kind === 'commit') {
        entry = { kind: 'commits', label: `Commits of ${a.repo}`, ref: a.repo, group: `commits:${a.repo}`, ids: [], chars: 0, recency: '', intent: false, scopeItemId: s.scopeItemId, rel: `commits of ${a.repo}` };
      } else continue;
      byKey.set(key, entry);
    }
    entry.ids.push(s.id);
    entry.chars += s.excerpt.length;
    // A repository's commits are as recent as its latest commit, not as the intake that read them: commits made before
    // the takeover are history, and wait for the depth the owner chooses like any other (Spec §3.7).
    if (a.kind === 'commit') { const at = commitTime(s); if (at !== null && at > entry.recency) entry.recency = at; }
  }
  // The first usable slice (Spec §3.7 stage 2, D37): chosen by relevance, bounded in count. Material that appeared after
  // the takeover started is daily work, not history; older material outside the slice is history and waits for the depth.
  // A worktree, copy or experiment beside the main project repeats the main project's documents, so they do not frame
  // it. One of the project's own locations is the project, whatever its relation says: a project may itself be a copy of
  // another repository (CKC-04 AC-2), and then its documents are the only ones there are (trial of 2026-09-21: none of
  // them reached round 1).
  const ownLocation = (path: string) => project.locations.some((l) => samePath(l, path));
  const secondaryItems = new Set(project.scope.filter((i) => (i.relation === 'Worktree of main repo' || i.relation === 'Copy of another project' || i.relation === 'Experiment') && !ownLocation(i.path)).map((i) => i.id));
  const candidates: Candidate[] = [...byKey].map(([key, e]) => ({ key, kind: e.kind, ref: e.ref, rel: e.rel, group: e.group, recency: e.recency, chars: e.chars, intent: e.intent, secondary: e.scopeItemId !== null && secondaryItems.has(e.scopeItemId) }));
  const chosen = selectFirstUsable(candidates, now);
  const takeoverStart = project.createdAt;
  const out: Material[] = [];
  for (const [key, e] of byKey) {
    const tier: Tier = e.intent && chosen.has(key) ? 'intent' : chosen.has(key) || e.recency >= takeoverStart ? 'active' : 'history';
    out.push({ key, kind: e.kind, label: e.label, ref: e.ref, group: e.group, sourceIds: e.ids, chars: e.chars, recency: e.recency, tier, intent: e.intent, scopeItemId: e.scopeItemId, rel: e.rel, frame: chosen.get(key) ?? null, rulesSource: e.kind === 'file' && isRulesSource(e.rel) });
  }
  return sortMaterials(out);
}

/** Whether a file is read as material, given what the scope reads from where (Spec §1.1; scope/skip.ts `treatmentOf`). */
function readAsMaterial(project: Project, path: string): boolean {
  const { treatment } = readingOf(project.scope, path);
  if (treatment === 'none' || treatment === 'history') return false;
  return treatment !== 'documents' || isDocumentPath(path);
}

/** A file's path inside the project: from the project's own location that holds it, else from the drive. */
export function projectRelPath(project: Project, path: string): string {
  const under = (root: string) => root.length > 0 && path.toLowerCase().startsWith(root.toLowerCase());
  const own = project.locations.filter(under).sort((a, b) => a.length - b.length)[0];
  return own ? path.slice(own.length).replace(/^[\\/]+/, '') : fromTheDrive(path);
}

/** A path of no project location, without what it starts from: the drive on Windows, the root where paths start at `/`. */
function fromTheDrive(path: string): string {
  return sep === '/' ? path.replace(/^\/+/, '') : path.replace(/^[A-Za-z]:[\\/]+/, '');
}

// ───────────────────────── what the project's rules settle (Spec §1.15, §3.7; D62) ─────────────────────────

/** The `Used as` values a rule settles a material into without anyone reading it closely (§1.2, §1.15). */
const SETTLING_USED_AS: ReadonlySet<string> = new Set(['Reference only', 'History only']);

/** Whether a rule is in force: only such a rule settles anything. */
const inForce = (rule: ProjectRule | undefined): rule is ProjectRule => rule !== undefined && rule.validity === 'Current';

/** Sources that state one of the project's rules in force: a rule's own text is read again whenever it changes (§3.3). */
function ruleTextSources(store: ProjectStore): Set<string> {
  return new Set(store.rules.filter((r) => r.validity === 'Current').flatMap((r) => r.sourceIds));
}

/**
 * Whether the project's own rules settle this material directly, so no one reads it closely (Spec §3.7 "按规矩直接
 * 判定"; CKC-13 AC-30): the organizing plan names its place under a rule in force (`plan`), or a rule in force set how
 * every one of its sources is used — reference only, history only (`sources`). A material that states one of the rules
 * is never settled away: when it changes, the rules are recognised again. Null when no rule settles it.
 */
export function ruleSettlement(store: ProjectStore, plan: OrganizingPlanContent | undefined | null, material: { readonly kind: string; readonly rel: string; readonly sourceIds: readonly string[] }): { ruleId: string; via: 'plan' | 'sources' } | null {
  if (material.sourceIds.length === 0) return null;
  const ruleText = ruleTextSources(store);
  if (material.sourceIds.some((id) => ruleText.has(id))) return null;
  if (plan && material.kind === 'file') {
    const entry = planEntryFor(plan, material.rel);
    if (entry && inForce(store.rules.get(entry.ruleId))) return { ruleId: entry.ruleId, via: 'plan' };
  }
  const sources = material.sourceIds.map((id) => store.sources.get(id));
  const ruleIds = [...new Set(sources.map((s) => (s && SETTLING_USED_AS.has(s.usedAs ?? '') ? s.usedAsByRuleId ?? '' : '')))];
  if (ruleIds.length === 1 && ruleIds[0] && inForce(store.rules.get(ruleIds[0]))) return { ruleId: ruleIds[0], via: 'sources' };
  return null;
}

/**
 * Material the project's rules took out of what is organized — its place is kept for recovery only, or a rule set every
 * one of its sources reference only or history only — as the coverage counts it (`Settled by rule`, §1.11): it is the
 * project's material, judged by a rule, not waiting for anyone. Only file material; what `listMaterials` lists is not
 * repeated here. It runs on every planning pass, so it reads no file: `recency` is when the material was last read.
 */
export function settledAwayMaterials(store: ProjectStore, project: Project, listed: ReadonlySet<string>): { key: string; kind: 'file'; rel: string; chars: number; recency: string; ruleId: string }[] {
  const byKey = new Map<string, { rel: string; chars: number; recency: string; ruleIds: Set<string>; unsettled: boolean }>();
  const ruleText = ruleTextSources(store);
  for (const s of store.sources.all()) {
    if (s.anchor.kind !== 'file' || s.availability === 'No longer available') continue;
    const key = `file:${s.anchor.path}`;
    if (listed.has(key)) continue;
    const { item, treatment } = readingOf(project.scope, s.anchor.path);
    const recovery = treatment === 'history' ? (item?.coveredBy ?? []).find((c) => c.category === 'Recovery only' && inForce(store.rules.get(c.ruleId)))?.ruleId ?? null : null;
    const byRule = SETTLING_USED_AS.has(s.usedAs ?? '') && s.usedAsByRuleId && inForce(store.rules.get(s.usedAsByRuleId)) ? s.usedAsByRuleId : null;
    const ruleId = ruleText.has(s.id) ? null : recovery ?? byRule;
    const e = byKey.get(key) ?? { rel: projectRelPath(project, s.anchor.path), chars: 0, recency: s.version.readAt, ruleIds: new Set<string>(), unsettled: false };
    e.chars += s.excerpt.length;
    if (s.version.readAt > e.recency) e.recency = s.version.readAt;
    if (ruleId) e.ruleIds.add(ruleId); else e.unsettled = true;
    byKey.set(key, e);
  }
  const out: { key: string; kind: 'file'; rel: string; chars: number; recency: string; ruleId: string }[] = [];
  for (const [key, e] of byKey) if (!e.unsettled && e.ruleIds.size > 0) out.push({ key, kind: 'file', rel: e.rel, chars: e.chars, recency: e.recency, ruleId: [...e.ruleIds][0]! });
  return out;
}

const TIER_ORDER: Record<Tier, number> = { intent: 0, active: 1, history: 2 };

export function sortMaterials(materials: readonly Material[]): Material[] {
  return [...materials].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.group.localeCompare(b.group) || b.recency.localeCompare(a.recency) || a.key.localeCompare(b.key));
}

export type OrganizedState = 'none' | 'current' | 'pending';

/** Is this material covered by fact records that are still current? */
export function organizedState(store: ProjectStore, material: Material): OrganizedState {
  const ids = new Set(material.sourceIds);
  const facts = store.facts.filter((f) => f.aboutSourceIds.some((id) => ids.has(id)));
  if (facts.length === 0) return 'none';
  if (facts.some((f) => f.pendingSourceIds.length > 0)) return 'pending';
  const covered = new Set(facts.flatMap((f) => f.aboutSourceIds));
  return material.sourceIds.every((id) => covered.has(id)) ? 'current' : 'pending';
}
