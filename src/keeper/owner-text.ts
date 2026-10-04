/**
 * The form of text the owner reads, checked by the program (Spec §4.2, §6.13; D105; CKC-08 AC-26, AC-27). The owner, of
 * a note whose body carried a store id, a lane report's section number and a run of decision numbers, and that opened
 * with no question: 「这个可读性太差了。」
 *
 * Two checks, each a refusal that costs the model one retry rather than a rule it has to keep in mind:
 *
 * 1. **No internal identifiers** in a note, a round's Result, or any other text written for the owner: ProjectKeeper's
 *    own store ids (`mark_…`, `ref_…`, `rule_…`, `note_…` and the rest the store mints), a lane named as a lane, and a
 *    lane report's or brief's section reference. The project's own numbers (D13, CKC-08, E151) are the project's words
 *    and pass. The refusal names each one found and says where the evidence goes instead: the sources and links.
 * 2. **A `For your decision` note opens with the question and gives the options**: the first sentence is the question
 *    the owner is asked to decide; at least two options, each with what follows from it.
 *
 * What the program cannot tell — whether a numbered thing is said in plain words before its number is used — stays with
 * the skill and the spot-check (U96).
 */
import type { NoteOption } from '../model/types.ts';
import type { ProjectStore } from '../store/project-store.ts';

/**
 * The prefixes the store mints ids with (model/ids.ts `newId`, `stableId`; every call site in src/). A test holds this
 * list against those call sites, so a new collection's ids are recognised too.
 */
export const STORE_ID_PREFIXES = [
  'mark', 'ref', 'rule', 'note', 'thread', 'rel', 'sb', 'bp', 'rdoc', 'draft', 'job', 'gen', 'terr', 'crd',
  'scope', 'scopeq', 'scopej', 'src', 'fact', 'chg', 'jdg', 'item', 'step', 'link', 'st', 'msg', 'auth', 'patch', 'merge',
  'layer', 'knum', 'area', 'req', 'ctx',
] as const;

/**
 * A store id as it is minted: the prefix, an underscore, then hex (a stable id: 16 of them) or base36 time and hex (a
 * new id), at least twelve characters with a digit among them — so `rule_based` or `thread_safety` is no id.
 */
const STORE_ID = new RegExp(`(?<![A-Za-z0-9_])(?:${[...STORE_ID_PREFIXES].sort((a, b) => b.length - a.length).join('|')})_(?=[0-9a-z]*[0-9])[0-9a-z]{12,}(?![A-Za-z0-9])`, 'g');

/** `§3`, `§ 一`, `section 2.1`, `第三节`: a section of a document. */
const SECTION = String.raw`(?:§\s*[0-9一二三四五六七八九十百]+(?:\.[0-9]+)*|[Ss]ection\s+[0-9]+(?:\.[0-9]+)*|第\s*[0-9一二三四五六七八九十百]+\s*[节章])`;
/** A lane's report or brief, named as such: `路报告`, `路的任务书`, `lane report`, `lane's brief`. */
const LANE_DOCUMENT = String.raw`(?:路(?:的)?(?:报告|任务书)|[Ll]anes?(?:['’]s)?\s+(?:report|brief))`;
/** A lane report's or brief's section: the document named as a lane's, then the section within a few characters. */
const LANE_SECTION = new RegExp(`${LANE_DOCUMENT}[^\\n。；;，,]{0,12}?${SECTION}`, 'g');

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The names of the lanes this project's rounds sent (their briefs and reports are filed under them): internal names. */
export function laneNamesOf(store: ProjectStore): string[] {
  const names = new Set<string>();
  for (const r of store.clerkRounds.all()) {
    for (const p of r.paths) names.add(p);
    for (const s of r.sweepsAdded ?? []) names.add(s.path);
  }
  for (const d of store.roundDocs.all()) if (d.path) names.add(d.path);
  return [...names].map((n) => n.trim()).filter((n) => n.length >= 3).sort((a, b) => b.length - a.length);
}

export interface InternalRef {
  readonly kind: 'store id' | 'lane report section' | 'lane name';
  /** The text found, as written. */
  readonly text: string;
  /** Which part of the writing holds it: `title`, `preview`, `currentView`, `facts[2]` … */
  readonly where: string;
}

/**
 * The internal identifiers in a piece of writing, part by part. `laneNames` are the names the project's rounds gave
 * their lanes: one is found where it is used as a lane (`<name> 路`, `the <name> lane`) or as the owner of a report or a
 * brief (`<name> 报告 §6`), never as an ordinary word of the sentence.
 */
export function internalRefs(parts: Readonly<Record<string, string | null | undefined>>, laneNames: readonly string[] = []): InternalRef[] {
  const found: InternalRef[] = [];
  const seen = new Set<string>();
  const add = (kind: InternalRef['kind'], text: string, where: string) => {
    const key = `${kind}\n${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ kind, text: text.trim(), where });
  };
  const names = laneNames.map(escaped);
  const edge = String.raw`[A-Za-z0-9_-]`;
  const laneSection = names.length ? new RegExp(`(?<!${edge})(?:${names.join('|')})(?!${edge})[^\\n。；;，,]{0,10}?(?:报告|任务书|[Rr]eport|[Bb]rief)[^\\n。；;，,]{0,12}?${SECTION}`, 'g') : null;
  const laneName = names.length ? new RegExp(`(?<!${edge})(?:${names.join('|')})(?!${edge})\\s*(?:路(?![由径线])|\\s(?:lane|sweep)\\b)|\\b(?:lane|sweep)\\s+(?:${names.join('|')})(?!${edge})`, 'g') : null;
  for (const [where, value] of Object.entries(parts)) {
    const text = value ?? '';
    if (!text) continue;
    for (const m of text.matchAll(STORE_ID)) add('store id', m[0], where);
    // A section reference found both ways (`路报告 §一`, `generations 路报告 §一`) is said once, by the longer.
    const all = [LANE_SECTION, laneSection].flatMap((re) => (re ? [...text.matchAll(re)].map((m) => m[0]) : []));
    const sections = all.filter((s) => !all.some((o) => o !== s && o.includes(s)));
    for (const s of sections) add('lane report section', s, where);
    // A lane named inside a section reference is said by that reference.
    if (laneName) for (const m of text.matchAll(laneName)) if (!sections.some((s) => s.includes(m[0].trim()))) add('lane name', m[0], where);
  }
  return found;
}

const KIND_WORDS: Record<InternalRef['kind'], string> = {
  'store id': 'a ProjectKeeper store id',
  'lane report section': 'a section of a lane’s report or brief',
  'lane name': 'the name of a lane',
};

/** The found identifiers in one sentence: each as written, with what it is and where. */
function refsSentence(refs: readonly InternalRef[]): string {
  const shown = refs.slice(0, 10).map((r) => `“${r.text}” in ${r.where} (${KIND_WORDS[r.kind]})`);
  return `${shown.join('; ')}${refs.length > 10 ? `; and ${refs.length - 10} more` : ''}`;
}

/** The first sentence of a text: up to its first sentence mark or line break. A leading `[As far as read — …]` is the program's stamp, not the sentence. */
export function firstSentence(text: string): string {
  const bare = text.replace(/^\[As far as read — [^\]]*\]\s*/, '').trim();
  const m = /^[\s\S]*?(?:[？?！!。]|\.(?=\s|$)|\n|$)/.exec(bare);
  return (m ? m[0] : bare).trim();
}

const isQuestion = (sentence: string) => /[?？]$/.test(sentence);

export interface OwnerNoteText {
  readonly ask: string;
  readonly title: string;
  readonly preview: string;
  /** The rest of the note the owner reads, by part: `currentView`, `facts[0]` … */
  readonly body: Readonly<Record<string, string | null | undefined>>;
  readonly options: readonly NoteOption[];
}

/**
 * Why a note may not be written in this form, or null: everything wrong with it in one answer, so one retry sets it
 * right. `how` says how the note is written again (the tool and its id), for the last sentence.
 */
export function noteFormRefusal(n: OwnerNoteText, laneNames: readonly string[], how = 'Write it again'): string | null {
  const problems: string[] = [];
  const optionParts = Object.fromEntries(n.options.flatMap((o, i) => [[`options[${i}].option`, o.option], [`options[${i}].then`, o.then]]));
  const refs = internalRefs({ title: n.title, preview: n.preview, ...n.body, ...optionParts }, laneNames);
  if (refs.length) {
    problems.push(`It carries ${refs.length === 1 ? 'an internal identifier' : `${refs.length} internal identifiers`}, which the owner cannot read: ${refsSentence(refs)}. Say what each thing is — its name, or the project’s own number (a decision, contract or task number) after saying what that is — and leave these out. The evidence goes in the note’s sources and links, not in its sentences: sourceIds on the facts, the objects it hangs on (mountIds), looked, changeIds, codeAnomalies.`);
  }
  if (n.ask === 'For your decision') {
    const first = firstSentence(n.preview);
    if (!isQuestion(first)) {
      problems.push(`A For your decision note opens with the question: the first sentence of preview is what the owner is asked to decide, as one clear question ending in a question mark. This one opens with “${first.length > 140 ? `${first.slice(0, 140)}…` : first}”. Put the question first; what happened and why it comes up now follows in the body, in plain words.`);
    }
    const whole = n.options.filter((o) => o.option.trim() && o.then.trim());
    if (whole.length < 2) {
      problems.push(`A For your decision note gives the owner the options: at least two in options, one per choice, each with what follows from it (then) — what is changed and where; what happens if it is left alone is an option too. This one gives ${whole.length}${n.options.length > whole.length ? ` (${n.options.length - whole.length} without option or then)` : ''}.`);
    }
  }
  if (problems.length === 0) return null;
  return `The owner reads this note, and it is not in the form a note is read in. ${problems.join(' ')} ${how}. Nothing was written.`;
}

/** A decision note's options as lines, one per choice with what follows from it (§4.2): for the places that show a note as text. */
export function optionsLines(options: readonly NoteOption[] | undefined): string[] {
  return (options ?? []).map((o) => `- ${o.option} — ${o.then}`);
}

/**
 * Why a text written for the owner that is no note — a round's Result — may not be written, or null: it carries
 * internal identifiers. The reader reaches an object by its name on the workbench; the round's records keep the ids.
 */
export function ownerTextRefusal(what: string, parts: Readonly<Record<string, string | null | undefined>>, laneNames: readonly string[]): string | null {
  const refs = internalRefs(parts, laneNames);
  if (refs.length === 0) return null;
  return `${what} is read by the owner, and it carries ${refs.length === 1 ? 'an internal identifier' : `${refs.length} internal identifiers`}: ${refsSentence(refs)}. Name each object by what it is — its title, or the project’s own number — and say what the lanes found without naming a lane or a section of its report: the workbench opens an object from its name, and the round’s own records (the reports, the adoption record, the handover) keep the ids. Write it again without them. Nothing was written.`;
}
