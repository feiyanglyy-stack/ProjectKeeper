/**
 * The owner's words a piece of work traces up to, and the adjustments made on the way from them to this work (D66;
 * Spec §7.1, §7.4 item 1; CKC-12 AC-40–AC-42). Deterministic; it reads the assets and writes nothing.
 *
 * The way up follows the work's relations: the areas, requirements and designs it serves, the plan it is in, the
 * decisions it carries out, and from each of them `refines`, up to the `Owner's words` layer (§1.3). Owner's words kept
 * in a decision record count too (§1.3): an item on the way that carries the owner's words in `quote` gives them.
 * The product item is where the way stops: what the owner said about the whole product belongs to the start pack's
 * `Purpose`, and comes with a piece of work only when it names that work.
 *
 * An adjustment is a change on the way that altered what the work is — a decision, a hand-over, a change of plan — or a
 * decision on the way that a role made. Building the code, a test result and finishing the work are progress, not
 * adjustments; a proposal nobody adopted altered nothing; an adjustment a later change superseded is not listed (§7.4).
 */
import type { Attribution, ChangeItem, ChangeRecord, EntryMark, ReferenceItem, WorkThread } from '../model/types.ts';
import { OWNER_WORDS } from '../model/vocab.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { itemsOf } from '../keeper/adjustment.ts';
import { materialDate } from '../model/time.ts';

export interface TracedWords {
  /** The `Owner's words` item, or the item on the way whose `quote` holds the owner's words. */
  readonly item: ReferenceItem;
  readonly quote: string;
  /** When the owner said them, from the session they were said in; null when the source gives no time. */
  readonly saidOn: string | null;
}

export interface Adjustment {
  readonly on: string | null;                     // the day it happened, as the material gives it
  readonly material: string | null;
  readonly effect: string | null;
  readonly title: string;
  readonly summary: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly why: string | null;
  readonly changeId: string | null;               // the change record, fetched by id
  readonly refId: string | null;                  // a decision on the way with no change record of its own
  /** Who decided it, in the three layers of §1.9: `decided by the owner`, `decided by <role>, within its remit`,
   *  `decided by <role> without the owner …`; a report or an unnamed author is said as such. */
  readonly decidedBy: string;
  readonly withoutOwner: boolean;
  readonly sourceIds: readonly string[];
  /** The objects it changed (a change item's subjects, or the decision itself). */
  readonly subjects: readonly string[];
}

export interface OwnerWordsTrace {
  readonly words: readonly TracedWords[];
  /** The product descriptions and decisions between the work and the owner's words (never the product item). */
  readonly path: readonly ReferenceItem[];
  readonly adjustments: readonly Adjustment[];
  /** `Layer drift` where what the work rests on departs from the owner's words (§1.3). */
  readonly drift: readonly EntryMark[];
  /** Owner's words the owner later replaced, on the way up: `Do not revive` material, never the direction. */
  readonly replacedWords: readonly ReferenceItem[];
  /** Every asset on the way, for the entries a work pack carries because they bear on this work (§7.4 item 11). */
  readonly related: ReadonlySet<string>;
}

export interface TraceOptions {
  /** Names and numbers of the work and its areas: product-wide words that name one of them come along. */
  readonly scopeWords: readonly string[];
  /** Whether a mark can be written into a pack at all (it says what differs and names what it was checked against). */
  readonly checked: (m: EntryMark) => boolean;
}

const text = (s: string | null | undefined) => (s ?? '').trim();
const GONE = new Set(['Removed', 'Replaced', 'Abandoned']);
const DESCRIPTIONS = new Set(['Goal', 'Area', 'Requirement', 'Design']);

/** The day a time falls on, the same for every channel that delivers the pack: a date stays a date (§1.8). */
export const dayOf = (at: string | null | undefined): string | null => (text(at) ? materialDate(text(at), 'UTC') : null);

/** When the owner said what this item holds: the first session it cites that gives a time. */
function saidOn(store: ProjectStore, r: ReferenceItem): string | null {
  for (const id of r.sourceIds) {
    const a = store.sources.get(id)?.anchor;
    if (a?.kind === 'session' && a.at) return dayOf(a.at);
  }
  return null;
}

const isOwners = (by: Attribution | undefined): boolean => by?.author?.kind === 'owner' || by?.identity === 'Decision';
const nameOf = (by: Attribution | undefined): string | null => by?.author?.name ?? by?.holder?.role ?? by?.author?.host ?? null;

/** Who decided, in the words the pack uses (§1.9's three layers). */
export function decidedBy(by: Attribution | undefined, withoutOwner: EntryMark | undefined): { phrase: string; without: boolean } {
  if (isOwners(by)) return { phrase: 'decided by the owner', without: false };
  const name = nameOf(by);
  if (withoutOwner) return { phrase: `decided by ${withoutOwner.decidedBy?.who ?? name ?? 'a role'} without the owner (also under \`Pending owner decisions\`)`, without: true };
  if (by?.identity === 'Artifact') return { phrase: `decided by ${name ?? 'a role'}, within its remit`, without: false };
  if (by?.identity === 'Report') return { phrase: `as reported by ${name ?? 'a report'}`, without: false };
  return { phrase: name ? `by ${name}` : 'by an author the records do not name', without: false };
}

export function traceOwnerWords(store: ProjectStore, thread: WorkThread, opts: TraceOptions): OwnerWordsTrace {
  const openWithoutOwner = (id: string) => store.marks.find((m) => m.targetId === id && m.kind === 'Decided without owner' && !m.closed);

  // ── the way up ──
  const starts = [
    ...thread.serves.map((s) => s.referenceId),
    ...store.relations.filter((r) => r.from === thread.id && (r.type === 'serves' || r.type === 'refines' || r.type === 'carries out' || r.type === 'implements')).map((r) => r.to),
    ...store.reference.filter((r) => r.carryOut?.workIds.includes(thread.id) === true).map((r) => r.id),
  ];
  const seen = new Set<string>();
  const queue = [...starts];
  const words = new Map<string, TracedWords>();
  const replaced = new Map<string, ReferenceItem>();
  const path: ReferenceItem[] = [];
  const products: ReferenceItem[] = [];
  const addWords = (first: ReferenceItem) => {
    let r = first;
    // Words the owner later replaced lead to the words that replaced them (§1.3: the later ones are current).
    for (let i = 0; r.validity === 'Replaced' && r.replacedBy && i < 8; i++) {
      replaced.set(r.id, r);
      const next = store.reference.get(r.replacedBy);
      if (!next) return;
      r = next;
    }
    if (r.validity !== 'Current' || !text(r.quote) || words.has(r.id)) return;
    words.set(r.id, { item: r, quote: text(r.quote), saidOn: saidOn(store, r) });
  };
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const r = store.reference.get(id);
    if (!r) continue;
    if (r.category === OWNER_WORDS) { addWords(r); continue; }
    if (r.validity === 'Replaced' && r.replacedBy) { queue.push(r.replacedBy); continue; }
    if (GONE.has(r.validity)) continue;
    if (r.category === 'Product') { products.push(r); continue; }
    path.push(r);
    if (text(r.quote) && r.validity === 'Current') words.set(r.id, { item: r, quote: text(r.quote), saidOn: saidOn(store, r) });
    queue.push(...r.refines, ...store.relations.filter((x) => x.from === r.id && x.type === 'refines').map((x) => x.to));
  }
  // What the owner said about the whole product comes along only when it names this work (§7.4 item 1).
  const names = opts.scopeWords.map((w) => w.toLowerCase()).filter((w) => w.length > 2);
  for (const p of products) {
    for (const up of p.refines) {
      const r = store.reference.get(up);
      if (!r || r.category !== OWNER_WORDS || words.has(r.id)) continue;
      const said = `${r.name} ${r.text} ${r.quote ?? ''}`.toLowerCase();
      if (names.some((w) => said.includes(w))) addWords(r);
    }
  }

  // ── adjustments on the way ──
  const onTheWay = new Set<string>([thread.id, ...path.map((r) => r.id), ...words.keys(), ...replaced.keys()]);
  const superseded = new Set(store.propagation.filter((j) => onTheWay.has(j.nodeId)).flatMap((j) => j.closed.filter((c) => c.close === 'Superseded by a later change').map((c) => `${c.changeId}|${c.itemId}`)));
  const validityOf = (id: string) => store.reference.get(id)?.validity ?? store.threads.get(id)?.validity ?? null;
  const adjustments: Adjustment[] = [];
  const covered = new Set<string>();
  const consider = (c: ChangeRecord, it: ChangeItem) => {
    if (!it.affects.some((id) => onTheWay.has(id))) return;
    if (it.effect === 'Completed' || it.material === 'Code change' || it.material === 'Test result') return;
    if (it.by?.identity === 'Proposal') return;
    if (superseded.has(`${c.id}|${it.id}`)) return;
    const states = it.affects.map(validityOf).filter((v): v is NonNullable<typeof v> => v !== null);
    // Everything it set down has since been replaced, given up or removed: a later change took its place.
    if (states.length && states.every((v) => GONE.has(v))) return;
    const sources = it.sourceIds.map((id) => store.sources.get(id)).filter((s) => s !== undefined);
    if (sources.length && sources.every((s) => s.usedAs === 'History only')) return;
    const without = it.affects.map(openWithoutOwner).find((m) => m !== undefined);
    const who = decidedBy(it.by, without);
    for (const id of it.affects) covered.add(id);
    adjustments.push({ on: dayOf(it.at), material: it.material, effect: it.effect, title: text(it.title), summary: text(it.summary), before: it.before, after: it.after, why: text(it.why) || null, changeId: c.id, refId: null, decidedBy: who.phrase, withoutOwner: who.without, sourceIds: it.sourceIds, subjects: it.affects });
  };
  for (const c of store.changes.all()) for (const it of itemsOf(c)) consider(c, it);
  // A decision on the way that a role made is an adjustment even when no change record holds it (for example one
  // that was already in place when the project was taken over: a first judgement is not a change, §2.1).
  for (const r of path) {
    if ((r.category !== 'Decision' && r.category !== 'Boundary') || r.validity !== 'Current' || isOwners(r.attribution) || text(r.quote) || covered.has(r.id)) continue;
    const who = decidedBy(r.attribution, openWithoutOwner(r.id));
    adjustments.push({ on: saidOn(store, r), material: r.category, effect: null, title: r.name, summary: text(r.text), before: null, after: null, why: null, changeId: null, refId: r.id, decidedBy: who.phrase, withoutOwner: who.without, sourceIds: r.sourceIds, subjects: [r.id] });
  }
  adjustments.sort((a, b) => (a.on === null ? 1 : 0) - (b.on === null ? 1 : 0) || (a.on ?? '').localeCompare(b.on ?? ''));

  // ── drift from the owner's words ──
  const wordSources = new Set([...words.values()].flatMap((w) => w.item.sourceIds));
  const describes = new Set(path.filter((r) => DESCRIPTIONS.has(r.category)).map((r) => r.id));
  const planOrWork = new Set([thread.id, ...path.filter((r) => r.category === 'Plan').map((r) => r.id)]);
  const drift = store.marks.filter((m) => !m.closed && m.kind === 'Layer drift' && opts.checked(m)
    && (describes.has(m.targetId) || (planOrWork.has(m.targetId) && m.clueSourceIds.some((s) => wordSources.has(s)))));

  const ordered = [...words.values()].sort((a, b) => (a.saidOn === null ? 1 : 0) - (b.saidOn === null ? 1 : 0) || (a.saidOn ?? '').localeCompare(b.saidOn ?? ''));
  const related = new Set<string>([...onTheWay, ...adjustments.flatMap((a) => a.subjects)]);
  return { words: ordered, path, adjustments, drift, replacedWords: [...replaced.values()], related };
}
