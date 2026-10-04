/**
 * `How this project works` in the context packs (Spec §1.15, §7.3 item 3, §7.4 item 10; CKC-21 AC-9, AC-10; CKC-12
 * AC-18, AC-39), and the page an agent reads for one rule by its id (§7.10). Deterministic; no model.
 *
 * The start pack says where the rules come from — the owner's own summary of how work runs, by name and id, or what the
 * Keeper dug out of the records — then gives the rules in force in the three fixed groups, one line each with its id.
 * An inferred rule says on its line that it waits for the owner; where practice differs from the owner's summary, the
 * line says so; a rule a role set without the owner says that too (and sits in `Pending owner decisions`). The project's
 * own wording is not pasted (it is read by id), obsolete material is in `Do not revive`, replaced rules are not given.
 *
 * A work pack carries the rules that bear on the work. What a rule applies to is what the rule itself records
 * (`appliesTo`): a material rule bears on the work when it covers material the work rests on or decided something in
 * it; a rule about how work is done bears on every piece of work unless it names a role, a kind of work or another work
 * item that this one is not.
 */
import type { EntryMark, ProjectRule } from '../model/types.ts';
import { WORK_KIND } from '../model/vocab.ts';
import { rulesByGroup } from '../keeper/rules.ts';
import { dayOf } from './owner-words.ts';

const text = (s: string | null | undefined) => (s ?? '').trim();
const oneLine = (s: string | null | undefined) => text(s).replace(/\s*\n+\s*/g, ' ');

export interface RuleRowHelp {
  /** Citation numbers for sources, as the pack writes them. */
  cite(ids: readonly string[]): string;
  /** The open `Decided without owner` mark on this rule, when a role set it in the owner's place. */
  withoutOwner(ruleId: string): EntryMark | undefined;
}

/** One rule on one line: what it says, its id, and what the reader has to know about it (§7.3). */
export function ruleRow(rule: ProjectRule, help: RuleRowHelp): string {
  const summary = oneLine(rule.summary);
  const prefix = rule.group === 'Material rules' && rule.category ? `${rule.category} · ` : '';
  const parts = [`- ${prefix}${summary} (\`${rule.id}\`)`];
  if (rule.basis === 'Inferred') parts.push(' · Inferred, awaiting the owner’s confirmation');
  const beyond = rule.appliesTo.filter((t) => text(t) && !summary.toLowerCase().includes(text(t).toLowerCase()));
  if (beyond.length) parts.push(` — applies to: ${beyond.map(text).join(', ')}`);
  const without = help.withoutOwner(rule.id);
  if (without) parts.push(` — set by ${without.decidedBy?.who ?? 'a role'}${without.decidedBy?.at ? ` on ${dayOf(without.decidedBy.at)}` : ''} without the owner: followed while it stands, see \`Pending owner decisions\``);
  for (const d of rule.differsInPractice) parts.push(` — in practice: ${oneLine(d.text)}${help.cite(d.sourceIds)}`);
  parts.push(help.cite(rule.sourceIds));
  return parts.join('');
}

/** The rules a pack gives: in force, obsolete ones aside (they are in `Do not revive`). */
export function rulesInForce(rules: readonly ProjectRule[]): ProjectRule[] {
  return rules.filter((r) => r.validity === 'Current' && r.category !== 'Obsolete');
}

/** The section's lines: optionally an opening saying where the rules come from, then the three groups. */
export function rulesLines(rules: readonly ProjectRule[], help: RuleRowHelp, opening: string | null): string[] {
  const shown = rulesInForce(rules);
  if (!shown.length) return [];
  const lines: string[] = opening ? [opening] : [];
  for (const g of rulesByGroup(shown)) {
    if (!g.rules.length) continue;
    lines.push(`${g.group}:`);
    for (const r of g.rules) lines.push(ruleRow(r, help));
  }
  return lines;
}

/** Where the rules come from (§7.3 item 3): the owner's summarized way of working by name and id, or the Keeper's digging. */
export function rulesOpening(rules: readonly ProjectRule[], help: RuleRowHelp, obsolete: number): string {
  const shown = rulesInForce(rules);
  const systems = [...new Set(shown.map((r) => text(r.ownerSystem)).filter((s) => s.length))];
  const dug = shown.filter((r) => !text(r.ownerSystem));
  const inferred = shown.filter((r) => r.basis === 'Inferred').length;
  const parts: string[] = [];
  if (systems.length) {
    parts.push(systems.map((s) => `From the owner’s own summary of how work runs here, **${s}**${help.cite([...new Set(shown.filter((r) => text(r.ownerSystem) === s).flatMap((r) => r.sourceIds))])}`).join('; '));
    if (dug.length) parts.push(`the other ${dug.length} the Keeper dug out of the project’s records`);
  } else {
    parts.push('The Keeper dug these out of the project’s own records; the project has no way of working the owner summarized');
  }
  const tail = [
    inferred ? `${inferred} inferred, awaiting the owner’s confirmation` : '',
    obsolete ? `what the project marks obsolete is in \`Do not revive\`` : '',
    'each rule in full, with where it is written: `pk get <rule id>`',
  ].filter((x) => x.length);
  return `${parts.join('; ')}. ${tail.join('; ')}.`;
}

export interface WorkFacts {
  /** Names and numbers of the work, its areas and what it serves. */
  readonly words: readonly string[];
  /** The work's holder and the pack's recipient. */
  readonly roles: readonly string[];
  readonly kind: string;
  /** Normalized paths of the material the work rests on. */
  readonly paths: readonly string[];
  /** Rules that decided something about the work or its material (validity, progress, `Used as`, an untrusted claim). */
  readonly decidedBy: ReadonlySet<string>;
  /** The project's recognized roles, and every work item's own number. */
  readonly knownRoles: readonly string[];
  readonly workNumbers: ReadonlySet<string>;
}

const norm = (s: string) => text(s).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
/** Singular and case-folded, so `Reviews` names `Review`. */
const word = (s: string) => text(s).toLowerCase().replace(/s$/, '');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (hay: string, needle: string) => {
  const h = hay.toLowerCase();
  const n = needle.toLowerCase().trim();
  if (!n) return false;
  return n.length > 3 ? h.includes(n) : new RegExp(`(^|[^a-z0-9])${escape(n)}([^a-z0-9]|$)`).test(h);
};

/** Whether a path the rule names covers one of the work's paths: the file itself, or a directory it is under. */
export function pathCovers(target: string, paths: readonly string[]): boolean {
  const t = norm(target);
  if (!t || /\s/.test(t)) return false;
  return paths.some((p) => p === t || p.endsWith(`/${t}`) || p.startsWith(`${t}/`) || p.includes(`/${t}/`));
}

export function ruleBearsOnWork(rule: ProjectRule, w: WorkFacts): boolean {
  if (rule.validity !== 'Current') return false;
  const namesWork = (t: string) => w.words.some((x) => mentions(t, x) || mentions(x, t));
  if (rule.group === 'Material rules') {
    if (w.decidedBy.has(rule.id)) return true;
    return rule.appliesTo.some((t) => pathCovers(t, w.paths) || namesWork(t));
  }
  if (rule.appliesTo.length === 0) return true;
  const isRole = (t: string) => w.knownRoles.some((r) => word(r) === word(t));
  const isKind = (t: string) => WORK_KIND.some((k) => word(k) === word(t));
  const isWork = (t: string) => w.workNumbers.has(text(t).toUpperCase());
  const restricting = rule.appliesTo.filter((t) => isRole(t) || isKind(t) || isWork(t));
  // Branches, directories and plain words say what the rule is about, not whom it is for.
  if (restricting.length === 0) return true;
  return restricting.some((t) => w.roles.some((r) => word(r) === word(t)) || word(w.kind) === word(t) || namesWork(t));
}

export interface RulePage {
  readonly rule: ProjectRule;
  readonly sources: readonly { readonly id: string; readonly title: string; readonly label: string }[];
  readonly replacedBy: { readonly id: string; readonly summary: string } | null;
  readonly withoutOwner: EntryMark | null;
}

/** What `pk get <rule id>` reads: the rule whole, with where it is written (Spec §7.10, §1.15). */
export function rulePage(p: RulePage): string {
  const r = p.rule;
  const head = [r.group, r.category ?? '', r.basis === 'Inferred' ? 'Inferred, awaiting the owner’s confirmation' : '', r.validity !== 'Current' ? r.validity : ''].filter((x) => x.length).join(' · ');
  const lines = [
    `# ${oneLine(r.summary)} (\`${r.id}\`)`,
    head,
    '',
    r.excerpt ? `The project’s own words: “${text(r.excerpt)}”` : 'The project gives no wording of its own for this rule; it was inferred from the records below.',
    r.appliesTo.length ? `Applies to: ${r.appliesTo.join(', ')}` : '',
    r.ownerSystem ? `Part of the owner’s own summary of how work runs here: ${r.ownerSystem}` : '',
    ...r.differsInPractice.map((d) => `In practice it differs: ${oneLine(d.text)}${d.sourceIds.length ? ` (${d.sourceIds.map((s) => `\`${s}\``).join(', ')})` : ''}`),
    r.ownerConfirmation ? `The owner confirmed it on ${dayOf(r.ownerConfirmation.at)}: “${text(r.ownerConfirmation.quote)}” (\`${r.ownerConfirmation.sourceId}\`)` : '',
    p.withoutOwner ? `Decided without owner (\`${p.withoutOwner.id}\`): set by ${p.withoutOwner.decidedBy?.who ?? 'a role'}${p.withoutOwner.decidedBy?.at ? ` on ${dayOf(p.withoutOwner.decidedBy.at)}` : ''}; ${oneLine(p.withoutOwner.clue)}` : '',
    p.replacedBy ? `Replaced by ${oneLine(p.replacedBy.summary)} (\`${p.replacedBy.id}\`) — \`pk get ${p.replacedBy.id}\` reads it.` : '',
    p.sources.length ? `\n## Where it is written (${p.sources.length})\n${p.sources.map((s) => `- \`${s.id}\` ${s.title} — ${s.label}`).join('\n')}\nEach source by id with \`pk get\`.` : '',
  ];
  return lines.filter((l, i) => l.length || i === 2).join('\n');
}
