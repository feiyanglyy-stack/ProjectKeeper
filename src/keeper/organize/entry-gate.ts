/**
 * The entry completeness gate (CJ; E150 「保证重要事项全量通过」; CKC-23 AC-21, AC-23). What the program can count does not
 * rest on the model's promise: every number a current decision record, plan, task index or execution arrangement defines
 * at an entry position (entries.ts) is carried by an item of the workbench — a reference item or a work item that has the
 * number in its ids, or whose name starts with it — or is accounted for by its number, with why (`pk_account_entries`).
 * An account in bulk ("process records, read in part") is not one: every number is named.
 *
 * Which files: the layer map orientation wrote (`pk_write_layers`), the entries marked current as `Decision record`,
 * `Plan`, `Task index` or `Execution arrangement`. Which numbers: the ledger's current definitions in each (§1.16 row 4),
 * less the points of another numbered entry (entries.ts `entryDefinitions`); a number defined twice in one file is one
 * entry, its supplements (`D100 补`) folded into it and carried by its item.
 *
 * CZ: besides those four layers, a current document that alone defines a number family is counted — whatever layer it is
 * mapped to, or unmapped: two or more numbers of the family at entry positions (headings, a table's first column), and no
 * other current document that defines the family so. The readings a role keeps in a README table, a side decision log the
 * layer map never named: on the flash run neither was counted by any gate, and neither was recorded. Only the numbers of
 * that family count there. A document set aside — under an archive, or mapped not current — is not a current document.
 * A document named by a number (a contract, a prompt) is that item's own document: its rows are the item's points, so it
 * is never counted this way — though it is a definer, and what it defines no other document defines alone. The folder
 * the Keeper itself maintains in the project (project-folder.ts) is its own writing, not the project's.
 *
 * `pk_stage` refuses to leave `reconcile` in a First usable round, and to enter `cross-check` in a Deepen, while a number
 * is neither carried nor accounted for; `pk_round_state.open.entries` lists them by file. Without a ledger (it is built by
 * the round's first step) or a layer map there is nothing to count, and nothing is refused.
 */
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ClerkRound, EntryAccount, LayerKind } from '../../model/k-types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { Ledger } from '../../ledger/index.ts';
import { definitionsInPath } from '../../ledger/numbering.ts';
import { STAGE_WRITERS } from '../clerk-steps.ts';
import { pathKey } from '../../util/paths.ts';
import type { ToolContext } from '../tools.ts';
import { primaryIdentifier } from '../tools.ts';
import { entryDefinitions } from './entries.ts';
import { archiveRootOf } from './generation-check.ts';

/** The layers whose entries must all be on the workbench. */
export const ENTRY_LAYERS: readonly LayerKind[] = ['Decision record', 'Plan', 'Task index', 'Execution arrangement'];

export interface MissingEntry { readonly num: string; readonly line: number; readonly context: string }

/** How many numbers of a family a document defines at entry positions before it is a definer of that family (CZ). */
export const SOLE_DEFINER_MIN = 2;

export interface EntryFile {
  readonly path: string;
  readonly layer: LayerKind;
  /** CZ: the number families this document alone defines, when that is why it is counted (only their numbers count). */
  readonly families?: readonly string[];
  /** How many numbers it defines as entries. */
  readonly defined: number;
  readonly carried: number;
  readonly accounted: number;
  /** Neither carried by an item nor accounted for, in line order. */
  readonly missing: readonly MissingEntry[];
}

export interface EntryGaps {
  /** How many numbers are missing, over every file. */
  readonly count: number;
  readonly files: readonly EntryFile[];
}

const clip = (s: string, n = 140): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const readLines = (file: string): string[] | null => { try { return readFileSync(file, 'utf8').split(/\r?\n/); } catch { return null; } };

const LEADING_NUMBER = /^[\s[(（*_`]*([A-Z]{1,6}-[A-Z]?\d{1,4}|[A-Z]\d{1,4})(?![A-Za-z0-9_]|\.\d)/;

/** Every number an item of the workbench carries: in its ids, or at the start of its name (reference items and work items). */
export function carriedNumbers(store: ProjectStore): Set<string> {
  const out = new Set<string>();
  const add = (ids: readonly string[], name: string) => {
    for (const i of ids) if (i.trim()) out.add(i.trim().toUpperCase());
    const p = primaryIdentifier(ids, name);
    if (p) out.add(p);
    // CZ: the number a name opens with, as the document writes it — also one of a family that counts only in its own
    // document (a side decision log's `V3 · …`), which is never an item's primary identifier.
    const lead = LEADING_NUMBER.exec(name);
    if (lead) out.add(lead[1]!.toUpperCase());
  };
  for (const r of store.reference.all()) add(r.ids, r.name);
  for (const t of store.threads.all()) add(t.ids, t.title);
  return out;
}

/** The accounts the main agent gave by number, in every round, by file (a number accounted once stays accounted). */
export function accountedEntries(store: ProjectStore): Map<string, Map<string, EntryAccount>> {
  const out = new Map<string, Map<string, EntryAccount>>();
  for (const round of store.clerkRounds.all()) {
    for (const a of round.entryAccounts ?? []) {
      const m = out.get(a.path) ?? new Map<string, EntryAccount>();
      for (const n of a.numbers) m.set(n, a);
      out.set(a.path, m);
    }
  }
  return out;
}

export interface RequiredFile { readonly path: string; readonly repo: string; readonly layer: LayerKind; readonly entries: MissingEntry[]; readonly families?: readonly string[] }

const slash = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** The layer entry that covers a path: the file's own, else the longest directory above it. */
function layerOver(store: ProjectStore, repo: string, path: string): { readonly layer: LayerKind; readonly current: boolean } | null {
  const hits = store.layers.filter((l) => (!l.repo || pathKey(l.repo) === pathKey(repo)) && (slash(l.path) === path || path.startsWith(`${slash(l.path)}/`)));
  return hits.sort((x, y) => slash(y.path).length - slash(x.path).length)[0] ?? null;
}

/**
 * CZ: the current documents that alone define a number family (see the module comment), each with the families it alone
 * defines. One query over the ledger's current definitions; a document set aside is neither counted nor a definer.
 */
export function soleDefiners(store: ProjectStore, ledger: Ledger): { repo: string; path: string; families: string[] }[] {
  let rows: { repo: string | null; path: string | null; rule: string; num: string }[] = [];
  try {
    rows = ledger.db.prepare("SELECT DISTINCT repo, path, rule, num FROM nums WHERE kind = 'doc' AND place = 'definition' AND current = 1 AND position IN ('heading', 'table first column')").all() as typeof rows;
  } catch { return []; }
  const repos = new Map(ledger.repos().map((r) => [r.id, r.path]));
  const aside = new Map<string, boolean>();
  // The Keeper's own folder in the project, whether or not its authorization still stands.
  const own = store.authorizations.all().flatMap((a) => (a.projectFolder ? [pathKey(a.projectFolder.path)] : []));
  const keepers = (repo: string, path: string): boolean => { const abs = pathKey(join(repos.get(repo) ?? repo, ...path.split('/'))); return own.some((f) => abs === f || abs.startsWith(`${f}${sep}`)); };
  const setAside = (repo: string, path: string): boolean => {
    const k = `${repo}\u0000${path}`;
    if (!aside.has(k)) aside.set(k, archiveRootOf(path) !== null || layerOver(store, repos.get(repo) ?? repo, path)?.current === false || keepers(repo, path));
    return aside.get(k)!;
  };
  // family → document → the numbers of it the document defines at entry positions
  const byFamily = new Map<string, Map<string, Set<string>>>();
  for (const r of rows) {
    if (!r.repo || !r.path || setAside(r.repo, r.path)) continue;
    const docs = byFamily.get(r.rule) ?? new Map<string, Set<string>>();
    const k = `${r.repo}\u0000${r.path}`;
    docs.set(k, (docs.get(k) ?? new Set<string>()).add(r.num));
    byFamily.set(r.rule, docs);
  }
  let named = new Set<string>();
  try { named = new Set((ledger.db.prepare("SELECT DISTINCT repo, path FROM nums WHERE kind = 'file-name' AND place = 'definition' AND current = 1").all() as { repo: string | null; path: string | null }[]).map((r) => `${r.repo}\u0000${r.path}`)); } catch { named = new Set(); }
  /** A document named by a number: that item's own document. */
  const numberNamed = (k: string, path: string): boolean => named.has(k) && definitionsInPath(path.split('/').pop() ?? path).length > 0;
  const out = new Map<string, { repo: string; path: string; families: string[] }>();
  for (const [family, docs] of byFamily) {
    const definers = [...docs].filter(([, nums]) => nums.size >= SOLE_DEFINER_MIN);
    if (definers.length !== 1) continue;
    const [k] = definers[0]!;
    const [repo, path] = k.split('\u0000') as [string, string];
    if (numberNamed(k, path)) continue;
    const d = out.get(k) ?? { repo, path, families: [] };
    d.families.push(family);
    out.set(k, d);
  }
  return [...out.values()].sort((x, y) => x.path.localeCompare(y.path));
}

/** The entries each gated file defines now: `{ num, line, context }` per number, first definition only. */
export function requiredEntries(store: ProjectStore, ledger: Ledger): RequiredFile[] {
  const out: RequiredFile[] = [];
  const POSITIONS = new Set(['heading', 'bold entry', 'table first column']);
  type Def = { readonly num: string; readonly rule: string; readonly position: string; readonly line: number; readonly context: string };
  /** A file's own entries, read from the text the ledger's definitions were read from (the file on disk otherwise). */
  const ownOf = (repoPath: string, path: string, fileDefs: readonly Def[]): Def[] => {
    const abs = join(repoPath, ...path.split('/'));
    const taken = ledger.currentText(abs);
    return entryDefinitions(fileDefs.map((d) => ({ ...d, position: d.position as 'heading' })), taken !== null ? taken.split(/\r?\n/) : readLines(abs));
  };
  const firsts = (own: readonly Def[]): MissingEntry[] => {
    const seen = new Map<string, MissingEntry>();
    for (const d of own) if (!seen.has(d.num)) seen.set(d.num, { num: d.num, line: d.line, context: clip(d.context) });
    return [...seen.values()].sort((x, y) => x.line - y.line);
  };
  const counted = new Set<string>();
  const layers = store.layers.filter((l) => l.current && ENTRY_LAYERS.includes(l.layer));
  for (const l of layers) {
    if (!l.repo) continue;
    const defs = ledger.definitionsIn(l.repo, l.path).filter((d) => POSITIONS.has(d.position));
    const byFile = new Map<string, typeof defs>();
    for (const d of defs) byFile.set(d.path, [...(byFile.get(d.path) ?? []), d]);
    for (const [path, fileDefs] of byFile) {
      counted.add(`${pathKey(l.repo)}\u0000${path}`);
      const entries = firsts(ownOf(l.repo, path, fileDefs));
      if (entries.length) out.push({ path, repo: l.repo, layer: l.layer, entries });
    }
  }
  // CZ: a current document that alone defines a number family, whatever its layer: the numbers of that family.
  const repos = new Map(ledger.repos().map((r) => [r.id, r.path]));
  for (const d of soleDefiners(store, ledger)) {
    const repoPath = repos.get(d.repo);
    if (!repoPath || counted.has(`${pathKey(repoPath)}\u0000${d.path}`)) continue;
    const own = ownOf(repoPath, d.path, ledger.definitionsIn(d.repo, d.path).filter((x) => x.path === d.path && POSITIONS.has(x.position)));
    // What stands under a numbered heading of another family is a point of that entry, so a family may fall short here.
    const families = d.families.filter((f) => new Set(own.filter((x) => x.rule === f && x.position !== 'bold entry').map((x) => x.num)).size >= SOLE_DEFINER_MIN);
    if (!families.length) continue;
    out.push({ path: d.path, repo: repoPath, layer: layerOver(store, repoPath, d.path)?.layer ?? 'Other', entries: firsts(own.filter((x) => families.includes(x.rule))), families });
  }
  return out;
}

/** What the gate holds against now (see the module comment). */
export function entryGaps(store: ProjectStore, ledger: Ledger | null): EntryGaps {
  if (!ledger) return { count: 0, files: [] };
  const carried = carriedNumbers(store);
  const accounts = accountedEntries(store);
  const files: EntryFile[] = requiredEntries(store, ledger).map((f) => {
    const acc = accounts.get(f.path);
    const isCarried = (n: string) => carried.has(n.toUpperCase());
    const missing = f.entries.filter((e) => !isCarried(e.num) && !acc?.has(e.num));
    return {
      path: f.path, layer: f.layer, ...(f.families ? { families: f.families } : {}), defined: f.entries.length,
      carried: f.entries.filter((e) => isCarried(e.num)).length,
      accounted: f.entries.filter((e) => !isCarried(e.num) && acc?.has(e.num)).length,
      missing,
    };
  });
  return { count: files.reduce((n, f) => n + f.missing.length, 0), files };
}

/** `entryGaps` with the project's ledger opened and closed here. */
export function entryGapsNow(store: ProjectStore): EntryGaps {
  const ledger = Ledger.openDir(store.dir);
  try { return entryGaps(store, ledger); } finally { ledger?.close(); }
}

/** The refusal `pk_stage` gives while entries are missing, or null. */
export function entryGateRefusal(gaps: EntryGaps, leaving: string): string | null {
  if (gaps.count === 0) return null;
  const shown = gaps.files.filter((f) => f.missing.length).map((f) => `${f.path} (${f.families ? `the only current document defining ${f.families.join(', ')}` : f.layer}): ${f.missing.length} of ${f.defined} — ${f.missing.slice(0, 12).map((m) => m.num).join(', ')}${f.missing.length > 12 ? `, and ${f.missing.length - 12} more` : ''}`);
  return `Every number a current decision record, plan, task index or execution arrangement defines at an entry position — and every number of a family that one current document alone defines — is on the workbench before you ${leaving}: carried by an item — in its ids, or at the start of its name, as the document names it — or accounted for by its number, with why (pk_account_entries). ${gaps.count} number${gaps.count === 1 ? ' is' : 's are'} neither:\n${shown.join('\n')}\npk_round_state lists them all (open.entries). Fill each log whole (pk_fill_from_headings, pk_fill_from_bold, pk_fill_from_table), give a lane with its slot the rest, or account for a number that is not an item, by number. Nothing changed.`;
}

// ───────────────────────── the account, by number ─────────────────────────

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }], details: {} });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: `ERROR: ${message}` }], details: {}, isError: true });
const stagesOf = (tool: string): string[] => Object.entries(STAGE_WRITERS).filter(([, tools]) => tools.includes(tool)).map(([s]) => s);

export function entryGateTools(ctx: ToolContext): ToolDefinition[] {
  const { store } = ctx;
  return [defineTool({
    name: 'pk_account_entries', label: 'Account for entries by number',
    description: 'Account for numbers a current decision record, plan, task index or execution arrangement defines — or a current document that alone defines their family — that are not items of the workbench and should not be: each by its number, with why — a point of a table that is not an item of its own, a heading that only groups others. The numbers a document defines at an entry position must each be carried by an item (its ids, or the start of its name) or accounted for here before the round leaves reconcile (First usable) or enters the cross-check (Deepen); pk_round_state lists the ones still open (open.entries). An account in bulk is not one: numbers names every number, as open.entries lists it, and a range or a family is refused. What should be an item, fill instead.',
    parameters: Type.Object({
      path: Type.String({ description: 'the document, as open.entries names it (repository-relative)' }),
      numbers: Type.Array(Type.String(), { description: 'every number accounted for, one by one, as the document writes it' }),
      why: Type.String({ description: 'why these are not items of the workbench' }),
    }),
    execute: async (_id, raw) => {
      const p = raw as Record<string, unknown>;
      const step = ctx.step;
      if (!step || step.kind !== 'main') return fail('pk_account_entries is the main agent’s account of its round’s entries; this job is not a round’s main agent, so nothing was recorded.');
      const round = store.clerkRounds.get(step.roundId);
      if (!round) return fail(`The round ${step.roundId} is not in the assets.`);
      const allowed = stagesOf('pk_account_entries');
      if (round.stage && !allowed.includes(round.stage)) return fail(`pk_account_entries is written in the ${allowed.join(', ')} stage; this round is in ${round.stage}, so nothing was recorded.`);
      const path = text(p.path).replace(/\\/g, '/');
      const why = text(p.why);
      if (!why) return fail('why is empty: say why these numbers are not items of the workbench.');
      const numbers = [...new Set((Array.isArray(p.numbers) ? p.numbers : []).map(text).filter(Boolean))];
      if (!numbers.length) return fail('numbers is empty: name every number you account for, one by one.');
      const bulk = numbers.filter((n) => /[～~–—]|\.\.|…|\*|<n>|\ball\b|全部|其余/i.test(n) || /\s/.test(n));
      if (bulk.length) return fail(`An account names each number (an account in bulk is not one); ${bulk.map((b) => `“${b}”`).join(', ')} ${bulk.length === 1 ? 'is' : 'are'} not one number. Write them out one by one. Nothing was recorded.`);
      const ledger = Ledger.openDir(store.dir);
      try {
        if (!ledger) return fail('This project has no ledger yet, so there are no counted entries to account for.');
        const gaps = entryGaps(store, ledger);
        const file = gaps.files.find((f) => f.path === path) ?? gaps.files.find((f) => f.path.toLowerCase() === path.toLowerCase());
        if (!file) return fail(`${path || '(empty)'} is not a file whose entries are counted: ${gaps.files.map((f) => f.path).join(', ') || 'none — the layer map marks no current decision record, plan, task index or execution arrangement, and no current document alone defines a number family'}.`);
        const missing = new Set(file.missing.map((m) => m.num));
        const defined = new Set(requiredEntries(store, ledger).find((f) => f.path === file.path)?.entries.map((e) => e.num) ?? []);
        const chosen = numbers.filter((n) => missing.has(n));
        const already = numbers.filter((n) => !missing.has(n) && defined.has(n));
        const unknown = numbers.filter((n) => !defined.has(n));
        if (!chosen.length) return fail(`None of these is an open entry of ${file.path}${unknown.length ? `; not defined there as an entry: ${unknown.join(', ')}` : ''}${already.length ? `; already carried or accounted for: ${already.join(', ')}` : ''}. Nothing was recorded.`);
        const account: EntryAccount = { path: file.path, numbers: chosen, why, at: new Date().toISOString() };
        const current = store.clerkRounds.get(round.id) ?? round;
        const next: ClerkRound = { ...current, entryAccounts: [...(current.entryAccounts ?? []), account], updatedAt: account.at };
        store.clerkRounds.put(next, { jobId: ctx.jobId, basisSourceIds: [], summary: `Entries accounted for by number in ${file.path}: ${chosen.join(', ')} — ${why}` });
        const left = entryGaps(store, ledger);
        return ok({ accounted: chosen.length, path: file.path, left: left.count, ...(unknown.length ? { notEntries: unknown } : {}), ...(already.length ? { alreadySettled: already } : {}) });
      } finally {
        ledger?.close();
      }
    },
  })];
}
