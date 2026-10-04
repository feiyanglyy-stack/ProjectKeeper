/**
 * Takeover depth (Spec v2.1 §1.11, §3.7; CKC-13 AC-1, AC-2, AC-8, AC-10, AC-19～AC-24; D36, D37).
 *
 * The first usable picture is formed from a bounded slice of the material chosen by relevance to the current
 * direction and the work in progress, so its time does not grow with the project's history (D37). Everything
 * older than the takeover that the slice leaves out is history; how much of it gets organized is the owner's
 * choice (`Full`, `Focused`, `First picture only`), made on the `Takeover` page before `Start` (D105; takeover-state.ts).
 * The organizing level of each material is computed from the planner's own record of what it did.
 */
import type { Project } from '../../model/types.ts';
import type { OrganizingLevel, TakeoverDepth } from '../../model/vocab.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { skippedSegment } from '../../scope/skip.ts';

/**
 * Round 1 reads documents only (owner 2026-09-17): first the places the project writes its own rules down (D62), then
 * the product overview, the plan, design, decision and contract documents, and the documents that report how the plan
 * went. Counts, never minutes, bound it, so the first picture does not grow with history (D37). Code, sessions,
 * commits and run records wait for the deepening rounds, however few documents a project has, and so do the documents
 * the tests keep as fixtures, which are the test side's as code is: the owner's own words reach round 1 through
 * pk_owner_utterances, never as whole sessions (Spec §3.7).
 */
export const FIRST_USABLE_LIMITS = { rules: 30, overview: 6, intent: 80, status: 40 } as const;

/**
 * A document's part in the frame: the product overview (stage 0), a plan/design/decision/contract (stage 1), a report
 * on how the plan went (stage 2), or — for a note that plays none of those parts — a place the project writes its rules
 * down (`rules`: what an archive, recovery or deletion place holds). A document of the first three kinds can also be a
 * rules source; `isRulesSource` says so.
 */
export type FrameRole = 'overview' | 'intent' | 'status' | 'rules';

export interface Candidate {
  readonly key: string;
  readonly kind: 'file' | 'session' | 'commits';
  readonly ref: string;
  /** Path inside the scope item: the rules below look at it, never at the directories above the project. */
  readonly rel: string;
  readonly group: string;
  readonly recency: string;
  readonly chars: number;
  readonly intent: boolean;
  /** In a worktree or copy of the main project: its documents duplicate the main project's and do not frame the project. */
  readonly secondary?: boolean;
}

const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|scala|sh|ps1|psm1|bat|cmd|sql|css|scss|less|html|htm|vue|svelte|lock|json|jsonl|yaml|yml|toml|ini|cfg|xml|csv|tsv|map|svg)$/i;
/** Material whose name says it carries conclusions: handovers, summaries, reports, decisions, status, reviews, QC. */
const CONCLUSION_RE = /(^|[\\/_.\- ])(handoffs?|handover|takeover|summary|summaries|milestones?|reports?|decisions?|status|progress|changelog|retro|retrospective|reviews?|qc|conclusions?|results?|findings|postmortem|verdict|acceptance)([\\/_.\- ]|$)/i;
/** Execution records: prompts, runs, logs, traces, outputs. Their conclusions matter; their course does not (Spec §3.7 `Conclusions only`). */
const EXECUTION_RE = /(^|[\\/_.\- ])(runs?|logs?|prompts?|execution|executions|dispatch|queue|jobs?|traces?|outputs?|artifacts?|scratch|tmp|temp)([\\/_.\- ]|$)/i;
const DOC_RE = /\.(md|markdown|mdx|txt|rst|adoc|org)$/i;
const ARCHIVED_RE = /(^|\/)(archive|archived|old|legacy|superseded[^/]*|deprecated)(\/|$)/i;
/** A place for what is thrown away or scratch; build output, dependencies and vendored code are the skip list's (scope/skip.ts). */
const TRASH_RE = /(^|\/)(delete|deleted|trash|tmp|temp)(\/|$)/i;
const trashed = (p: string) => TRASH_RE.test(p) || skippedSegment(p) !== null;
/** A place a project keeps what it archived, keeps for recovery or deleted: the note that says what it holds is a rules source. */
const KEPT_PLACE_RE = /(^|\/)(archive|archived|old|legacy|superseded[^/]*|deprecated|delete|deleted|trash|recycle|attic|归档|删除|废弃|作废|回收)(\/|$)/i;
/** The instruction files a project writes for agents (AGENTS.md, CLAUDE.md and the like) and its contribution rules. */
const INSTRUCTION_RE = /^(agents|claude|gemini|copilot-instructions|conventions|contributing)(\.[a-z]+)?$/i;
const INDEX_RE = /(^|[-_. ])(index|catalog|catalogue)([-_. ]|$)|索引/i;
const HANDOVER_RE = /(^|[-_. /])(handoffs?|handover|takeover)([-_. /]|$)|交接/i;
/** The name of a note that says what a place holds: a README, an index, notes, an explanation. */
const NOTE_NAME_RE = /^(readme|index|notes?|about|说明|索引|介绍)([-_. ]|$)/i;
/** A document at the top whose name says it is about what was archived, withdrawn or deleted. */
const DISPOSAL_NAME_RE = /(archive|deprecat|obsolete|superseded|deleted?|withdrawn|归档|删除|废弃|作废)/i;

/**
 * Whether a document is one of the places a project writes its own rules down (Spec §1.15, §3.7; CKC-13 AC-25): its
 * instruction files for agents, its README (at the top or one level down), its indexes, its hand-over documents, and
 * the notes that say what an archive, recovery or deletion place holds. The first round reads these before anything
 * else, so every later material is judged by the rules they state. Judged on the path inside the project.
 */
export function isRulesSource(rel: string): boolean {
  const p = slash(rel).replace(/^\.\//, '');
  if (!DOC_RE.test(p) || skippedSegment(p) !== null || RUN_DIR_RE.test(p) || TEST_FIXTURE_RE.test(p)) return false;
  const parts = p.split('/');
  const name = parts[parts.length - 1]!;
  const depth = parts.length;
  if (KEPT_PLACE_RE.test(parts.slice(0, -1).join('/'))) return NOTE_NAME_RE.test(name) && depth <= 4;
  if (INSTRUCTION_RE.test(name)) return depth <= 3;
  if (/^readme([-_. ]|$)/i.test(name)) return depth <= 2;
  if (HANDOVER_RE.test(p) || INDEX_RE.test(name)) return depth <= 4;
  return depth === 1 && DISPOSAL_NAME_RE.test(name);
}
const RUN_DIR_RE = /(^|\/)(runs?|logs?|outputs?|artifacts?|scratch|traces?)\//i;
/**
 * Folders a project's tests keep their fixtures in, by the usual names. What is there — often a whole made-up project
 * with its own plan, status and README — belongs to the tests, as the code beside it does: it is read, but it never
 * frames the project, is never where the project writes its rules, and is organized as code is (Spec §3.7: code does
 * not enter round 1). Unlike the skip list (scope/skip.ts), nothing here is left unread.
 */
const TEST_FIXTURE_RE = /(^|\/)(fixtures?|__fixtures__|testdata|test[-_]data)\//i;
/** Whether a path inside the project lies in a folder the tests keep fixtures in. */
export const isTestFixturePath = (rel: string): boolean => TEST_FIXTURE_RE.test(slash(rel));
/** A document that reports how the plan went: status, summaries, handovers, execution plans, QC and review reports. */
const STATUS_RE = /(^|[\/_.\- ])(handoffs?|handover|summary|summaries|milestones?|reports?|status|progress|changelog|retro|retrospective|reviews?|qc|findings|postmortem|verdict|observations?|execution)([\/_.\- ]|$)/i;
/** A product overview's own name starts with the word: `product.md`, `4-PRODUCT-AND-MODULES.md`, `PRD.md`, `README.md`. */
const OVERVIEW_RE = /^(\d+[-_. ])?(product|prd|vision|overview|readme)([-_. ]|$)/i;
/** Task contracts, requirements and specs are intent whatever their file name says (a contract named "handover" is not a status report). */
const CONTRACT_DIR_RE = /(^|\/)(contracts?|requirements?|specs?|tasks?|adr|rfcs?)\//i;

export const isCodePath = (path: string): boolean => CODE_RE.test(path);
const slash = (p: string) => p.replace(/\\/g, '/');

/** The part a file plays in the frame, from its path inside the project; null when it is not a frame document. */
export function frameRole(rel: string, intent: boolean): FrameRole | null {
  const p = slash(rel);
  if (!DOC_RE.test(p) || trashed(p) || RUN_DIR_RE.test(p) || ARCHIVED_RE.test(p) || TEST_FIXTURE_RE.test(p)) return null;
  const name = p.split('/').pop()!;
  const contract = CONTRACT_DIR_RE.test(p);
  const status = STATUS_RE.test(p) && !contract;
  if (!intent && !status) return null;
  if (!status && !contract && OVERVIEW_RE.test(name) && p.split('/').length <= 3) return 'overview';
  return status ? 'status' : 'intent';
}
const overviewRank = (rel: string): number => { const n = slash(rel).split('/').pop()!.toLowerCase(); return (/product/.test(n) ? 0 : /prd/.test(n) ? 1 : /vision|overview/.test(n) ? 2 : 3) * 10 + slash(rel).split('/').length; };

/**
 * The first usable slice: the frame documents, bounded per role and newest first, and the places the project writes
 * its own rules down (`isRulesSource`), which the first round reads before anything else (D62). A note that plays no
 * other part in the frame — what an archive or deletion place holds — joins as `rules`. Nothing else joins it, however
 * few documents there are: a project with almost none is framed from those, its rules and the owner's words, and a
 * fallback that once added its commit history and latest sessions went when the Spec kept them out of round 1 (§3.7).
 */
export function selectFirstUsable(candidates: readonly Candidate[], now = Date.now()): Map<string, FrameRole | null> {
  const chosen = selectFrameDocuments(candidates, now);
  const rules = candidates.filter((c) => c.kind === 'file' && !c.secondary && !chosen.has(c.key) && isRulesSource(c.rel))
    .sort((a, b) => slash(a.rel).split('/').length - slash(b.rel).split('/').length || b.recency.localeCompare(a.recency));
  for (const c of rules.slice(0, FIRST_USABLE_LIMITS.rules)) chosen.set(c.key, 'rules');
  return chosen;
}

function selectFrameDocuments(candidates: readonly Candidate[], _now: number): Map<string, FrameRole | null> {
  const chosen = new Map<string, FrameRole | null>();
  const byRecency = (a: Candidate, b: Candidate) => b.recency.localeCompare(a.recency);
  const docs = candidates.filter((c) => c.kind === 'file' && !c.secondary).map((c) => ({ c, role: frameRole(c.rel, c.intent) })).filter((x) => x.role !== null);
  const overview = docs.filter((x) => x.role === 'overview').sort((a, b) => overviewRank(a.c.rel) - overviewRank(b.c.rel) || byRecency(a.c, b.c));
  for (const x of overview.slice(0, FIRST_USABLE_LIMITS.overview)) chosen.set(x.c.key, 'overview');
  const intent = [...overview.slice(FIRST_USABLE_LIMITS.overview), ...docs.filter((x) => x.role === 'intent')].sort((a, b) => byRecency(a.c, b.c));
  for (const x of intent.slice(0, FIRST_USABLE_LIMITS.intent)) chosen.set(x.c.key, 'intent');
  for (const x of docs.filter((d) => d.role === 'status').sort((a, b) => byRecency(a.c, b.c)).slice(0, FIRST_USABLE_LIMITS.status)) chosen.set(x.c.key, 'status');
  return chosen;
}

// ---- levels under `Focused` ------------------------------------------------------------

export interface SampledGroup { readonly rule: string; readonly samples: readonly string[]; readonly members: readonly string[] }

const patternOf = (path: string): string => path.replace(/\\/g, '/').split('/').pop()!.replace(/\d+/g, '#').toLowerCase();

/**
 * Structurally similar history files (same directory, same name pattern) are read by sample: the newest and the
 * oldest are organized, the rest are classified by the rule (Spec §3.7 `Sampled`). Files that duplicate the main
 * project inside a worktree or copy are one such group.
 */
export function sampledGroups(store: ProjectStore, project: Project, history: readonly { key: string; kind: string; ref: string; group: string; recency: string; sourceIds: readonly string[] }[]): SampledGroup[] {
  const out: SampledGroup[] = [];
  const groups = new Map<string, typeof history[number][]>();
  for (const m of history.filter((x) => x.kind === 'file')) { const k = `${m.group}::${patternOf(m.ref)}`; const list = groups.get(k) ?? []; list.push(m); groups.set(k, list); }
  for (const [k, members] of groups) {
    if (members.length < 6) continue;
    const sorted = [...members].sort((a, b) => b.recency.localeCompare(a.recency));
    out.push({ rule: `${members.length} files like ${k.split('::')[1]} in ${members[0]!.group}: the newest and the oldest are read, the rest follow the rule`, samples: [sorted[0]!.key, sorted[sorted.length - 1]!.key], members: members.map((m) => m.key) });
  }
  // Worktree or copy files identical to the main project: the main project's copy is the sample.
  const main = project.scope.find((i) => i.relation === 'Main project' && !i.missing);
  const secondary = project.scope.filter((i) => (i.worktreeOf || i.copyOf) && i.relation !== 'Excluded');
  if (main && secondary.length) {
    const fingerprints = new Map<string, string>();   // relative path → joined fingerprints of the main project's file
    for (const s of store.sources.all()) if (s.anchor.kind === 'file' && s.scopeItemId === main.id) fingerprints.set(rel(main.path, s.anchor.path), `${fingerprints.get(rel(main.path, s.anchor.path)) ?? ''}|${s.version.fingerprint}`);
    const grouped = new Set(out.flatMap((g) => g.members));
    for (const item of secondary) {
      const dup: string[] = [];
      for (const m of history) {
        if (m.kind !== 'file' || grouped.has(m.key) || !m.ref.startsWith(item.path)) continue;
        const own = m.sourceIds.map((id) => store.sources.get(id)?.version.fingerprint ?? '').reduce((acc, f) => `${acc}|${f}`, '');
        if (fingerprints.get(rel(item.path, m.ref)) === own) dup.push(m.key);
      }
      if (dup.length) out.push({ rule: `${dup.length} files in ${item.path} identical to the main project: the main project's copies are the samples`, samples: [], members: dup });
    }
  }
  return out;
}
const rel = (root: string, path: string): string => path.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');

/** The level `Focused` organizes a history material to (Spec §3.7 rules). */
export function focusedLevel(m: { kind: string; rel: string; key: string }, sampled: readonly SampledGroup[]): OrganizingLevel {
  const g = sampled.find((x) => x.members.includes(m.key));
  if (g) return g.samples.includes(m.key) ? 'Read in full' : 'Sampled';
  if (m.kind === 'commits') return 'Read in full';
  if (m.kind === 'session') return 'Conclusions only';    // the owner's own words stay in full; the agent's course is reduced to conclusions
  if (isCodePath(m.rel) || isTestFixturePath(m.rel)) return 'Indexed';   // a test fixture's documents go as the code beside them
  if (CONCLUSION_RE.test(m.rel)) return 'Read in full';
  if (EXECUTION_RE.test(m.rel)) return 'Conclusions only';
  return 'Indexed';
}

/**
 * Which level the chosen depth plans for a history material; `Indexed` means it is not organized under this depth.
 * Material the project's rules settle (`settled`) is `Settled by rule` at every depth: it is not read closely (§3.7).
 */
export function plannedLevel(depth: TakeoverDepth | null, m: { kind: string; rel: string; key: string; settled?: boolean }, sampled: readonly SampledGroup[]): OrganizingLevel {
  if (m.settled) return 'Settled by rule';
  if (depth === 'Full') return 'Read in full';
  if (depth === 'Focused') return focusedLevel(m, sampled);
  return 'Indexed';
}
export const READ_LEVELS: readonly OrganizingLevel[] = ['Read in full', 'Conclusions only'];

/**
 * The depth question's note of a home from before D105 (§3.7, D36): the depth was asked once the first picture existed.
 * Since D105 the depth is chosen on the `Takeover` page before `Start` and no note asks for it; one left in an existing
 * home is withdrawn when the home is opened (App `migrateTakeover`).
 */
export const DEPTH_NOTE_ID = 'note_takeover-depth';
