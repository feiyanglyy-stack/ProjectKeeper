/**
 * The Keeper's ledger tools (Spec §1.16; CKC-22 AC-13; CKC-03 AC-26, AC-27): exact answers from the project's ledger —
 * the history map, commits and merges, document versions and their section diffs, deleted documents and cleanups, the
 * lines that say something was superseded, numbering, verdicts, execution arrangements, words across all history, file
 * and symbol references, code sizes, sessions and the owner's words, how something got here, and what the ledger covers —
 * instead of counting with the shell. Every tool is offered to every step of a round (roles.ts `pk_ledger_*`).
 *
 * The tools are a view on the ledger, not an interpretation: it says "this line reads superseded by", never "this design
 * is superseded"; "no file references this file", never "this is residue". Every row carries its entry id — cite it as
 * evidence `{ kind: 'ledger', id }` and the program reads its label and time back — and when it happened with the basis
 * (§2.11). Lists are paged (limit, offset; `next` says where the next page starts). The ledger is brought up to date by
 * the round's own program step; these tools only read it.
 */
import { join } from 'node:path';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Ledger, type LedgerEntry } from '../ledger/index.ts';
import type { Occurred } from '../model/k-types.ts';
import type { ToolContext } from './tools.ts';

const MAX_CHARS = 120_000;

function ok(value: unknown) {
  const body = typeof value === 'string' ? value : JSON.stringify(compact(value), null, 1);
  return { content: [{ type: 'text' as const, text: body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}\n…(cut at ${MAX_CHARS} characters: ask for a smaller page with limit)` : body }], details: {} };
}
function fail(message: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${message}` }], details: {}, isError: true };
}
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const opt = (v: unknown): string | undefined => str(v) || undefined;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []);

/** When it happened, in one line: `2026-09-11T20:41:22Z Commit` (+ the other time, + undated). */
export function when(o: Occurred | null | undefined): string | null {
  if (!o) return null;
  const at = o.at.replace(/\.000Z$/, 'Z');
  const other = o.other ? `; ${o.other.basis} ${o.other.at.replace(/\.000Z$/, 'Z')}` : '';
  return o.undated ? `Undated · first seen ${at}${other}` : `${at} ${o.basis}${other}`;
}

/** Rows as the model reads them: `occurred` in one line, empty fields left out. */
function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value === null || typeof value !== 'object') return value;
  const o = value as Record<string, unknown>;
  if (typeof o.at === 'string' && typeof o.basis === 'string' && ('anchor' in o || 'undated' in o || 'other' in o)) return when(o as unknown as Occurred);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    out[k === 'occurred' ? 'when' : k] = compact(v);
  }
  return out;
}

const NO_LEDGER = 'This project has no ledger yet: it is built by the program step that opens each round (step 0). Until then, read git and the files directly.';

export function ledgerOf(ctx: Pick<ToolContext, 'store'>): Ledger | null {
  return Ledger.openDir(ctx.store.dir);
}

function withLedger(ctx: ToolContext, fn: (ledger: Ledger) => unknown) {
  const ledger = ledgerOf(ctx);
  if (!ledger) return fail(NO_LEDGER);
  try {
    const r = fn(ledger);
    return typeof r === 'string' ? fail(r) : ok(r);
  } catch (error) {
    return fail(`The ledger could not answer: ${(error as Error).message}`);
  } finally {
    ledger.close();
  }
}

const REPO = { repo: Type.Optional(Type.String({ description: 'a repository of the project: its scope item id or path; default all (or the main one where one is needed)' })) };
const PAGE = {
  limit: Type.Optional(Type.Number({ description: 'rows per page (default 50)' })),
  offset: Type.Optional(Type.Number({ description: 'rows to skip: the `next` of the previous page' })),
};
const RANGE = {
  since: Type.Optional(Type.String({ description: 'from this date or time (a date: the start of that day, UTC)' })),
  until: Type.Optional(Type.String({ description: 'up to this date or time (a date: the end of that day, UTC)' })),
};
const CITE = 'Each row has an id: cite it as evidence { kind: "ledger", id } (with line when you quote one line of it); the program reads its label and when it happened.';

export function ledgerTools(ctx: ToolContext): ToolDefinition[] {
  return [
    defineTool({
      name: 'pk_ledger_overview', label: 'History map',
      description: `The orientation map of the whole history, per repository, in one call: commits on all refs and on the trunk, merges, refs by namespace (heads, tags, remotes, stash, others such as refs/codex/…), the time span and commits per day, every branch that never entered the trunk (with how far ahead it is), the worktrees and their uncommitted changes, cleanup commits, deleted documents by directory, import-style root commits and the day document version history starts. Exact and complete — no recent-N cap. ${CITE}`,
      parameters: Type.Object({ ...REPO }),
      execute: async (_id, p) => withLedger(ctx, (l) => l.overview({ repo: opt(p.repo) })),
    }),
    defineTool({
      name: 'pk_ledger_commits', label: 'Find commits',
      description: `Commits of the whole history (every ref), newest first unless oldestFirst. Filters: path (a file, or a directory and everything under it; a move counts), keyword in the message, num (a project number the message names: D83, T-22, AB …), author, since/until, merges, trunk (reachable from the trunk), sideOnly (never reached the trunk), importRoots. Each row: id, subject, author, when (author time; the committer time too when it differs), parents, merge, onTrunk, which ref namespaces reach it, files changed. ${CITE}`,
      parameters: Type.Object({
        ...REPO, ...PAGE, ...RANGE,
        path: Type.Optional(Type.String()), keyword: Type.Optional(Type.String()), num: Type.Optional(Type.String()), author: Type.Optional(Type.String()),
        merges: Type.Optional(Type.Boolean()), trunk: Type.Optional(Type.Boolean()), sideOnly: Type.Optional(Type.Boolean()), importRoots: Type.Optional(Type.Boolean()),
        oldestFirst: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, p) => withLedger(ctx, (l) => l.commits({
        repo: opt(p.repo), path: opt(p.path), keyword: opt(p.keyword), num: opt(p.num), author: opt(p.author), since: opt(p.since), until: opt(p.until),
        merges: p.merges === true, trunk: p.trunk === true, sideOnly: p.sideOnly === true, importRoots: p.importRoots === true, oldestFirst: p.oldestFirst === true,
        limit: num(p.limit), offset: num(p.offset),
      })),
    }),
    defineTool({
      name: 'pk_ledger_commit', label: 'One commit',
      description: `One commit in full: its message, author and committer time, parents, the project numbers it names, every file it changed against its first parent (status, move source, lines added and deleted — for a merge, what it brought in; paged), the branches that contain it, and the merge that brought it into the trunk. ${CITE}`,
      parameters: Type.Object({ hash: Type.String({ description: 'full or short hash, or its ledger id commit:<hash>' }), ...REPO, ...PAGE }),
      execute: async (_id, p) => withLedger(ctx, (l) => l.commit(str(p.hash), { repo: opt(p.repo), limit: num(p.limit) ?? 300, offset: num(p.offset) })),
    }),
    defineTool({
      name: 'pk_ledger_doc_versions', label: 'Versions of documents',
      description: `With path: every version of that document, oldest first, followed across moves — the commit and when, Added / Modified / Renamed / Copied, which Markdown sections (by heading path) that version added, removed or changed against the version before it, whether it is on the trunk, which one is current — and each deletion with the commit whose tree still has the full text. With compare: [from, to] (two version ids, or commits of the path): the sections that differ between any two versions. Without path: the document versions made in a period (since/until) or under a directory (dir), oldest first, paged. Read a version with pk_ledger_doc_read. ${CITE}`,
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: 'repository-relative path' })), ...REPO, ...PAGE, ...RANGE,
        dir: Type.Optional(Type.String()), change: Type.Optional(Type.String({ description: 'Added | Modified | Renamed | Copied' })),
        compare: Type.Optional(Type.Array(Type.String(), { description: 'two versions: ids (doc:<path>@<commit>) or commits of path' })),
      }),
      execute: async (_id, p) => withLedger(ctx, (l) => {
        const cmp = strs(p.compare);
        const ref = (v: string) => (v.startsWith('doc:') ? { id: v } : { path: str(p.path), commit: v, repo: opt(p.repo) });
        if (cmp.length === 2) return l.docCompare(ref(cmp[0]!), ref(cmp[1]!));
        if (cmp.length) return 'compare takes two versions.';
        if (opt(p.path)) return l.docVersions(str(p.path), { repo: opt(p.repo) });
        return l.docChanges({ repo: opt(p.repo), dir: opt(p.dir), since: opt(p.since), until: opt(p.until), change: opt(p.change), limit: num(p.limit), offset: num(p.offset) });
      }),
    }),
    defineTool({
      name: 'pk_ledger_doc_read', label: 'Read a document version',
      description: `The full text of one version of a document — a deleted design, an earlier plan, a version on a side branch — by its version id (doc:<path>@<commit>) or by path and commit (for a deleted document, its readableAt commit). Paged by lines: fromLine, toLine; nextFromLine says where the next page starts. Says whether it is the current version. What only history has is history: mark it so wherever you use it. Cite a line of it as { kind: "ledger", id, line }.`,
      parameters: Type.Object({
        id: Type.Optional(Type.String()), path: Type.Optional(Type.String()), commit: Type.Optional(Type.String()), ...REPO,
        fromLine: Type.Optional(Type.Number()), toLine: Type.Optional(Type.Number()),
      }),
      execute: async (_id, p) => withLedger(ctx, (l) => l.docText({ id: opt(p.id), path: opt(p.path), commit: opt(p.commit), repo: opt(p.repo) }, { from: num(p.fromLine), to: num(p.toLine) })),
    }),
    defineTool({
      name: 'pk_ledger_deleted', label: 'Deleted documents and cleanups',
      description: `Documents the history deleted that the current version does not have again, newest deletion first (paged; dir narrows to a directory), each with the deleting commit and readableAt, the commit whose tree still has the full text. With cleanups: true, the cleanup commits instead (one commit deleting many documents), each with the documents removed and the catalogue size before and after; with cleanup set to one cleanup's id, its whole catalogue before and after. ${CITE}`,
      parameters: Type.Object({ ...REPO, ...PAGE, dir: Type.Optional(Type.String()), cleanups: Type.Optional(Type.Boolean()), cleanup: Type.Optional(Type.String()), onlyInCleanups: Type.Optional(Type.Boolean()) }),
      execute: async (_id, p) => withLedger(ctx, (l) => (p.cleanups === true || opt(p.cleanup)
        ? l.cleanups({ repo: opt(p.repo), id: opt(p.cleanup) })
        : l.deletedDocs({ repo: opt(p.repo), dir: opt(p.dir), cleanupsOnly: p.onlyInCleanups === true, limit: num(p.limit), offset: num(p.offset) }))),
    }),
    defineTool({
      name: 'pk_ledger_supersessions', label: 'Lines that say superseded',
      description: `Every line of the material that says something was superseded, replaced, deprecated, withdrawn — superseded by, replaced by, deprecated, 取代, 被…取代, 作废, 废弃, 不再使用, 撤回, V1 → V2 — and every row of the project's own obsolete lists (a section headed or introduced as obsolete, e.g. 已纠正的旧规则), in document bodies (every version), file and directory names, and commit messages. Each with where it is, the first version it appears in (its time), the last, and whether the current version still has it. It records what the line says; whether it really supersedes something, and what, is your judgement. Filters: path, pattern, obsoleteOnly, currentOnly, source (content | commit | filename | loose), keyword. ${CITE}`,
      parameters: Type.Object({
        ...REPO, ...PAGE, ...RANGE, path: Type.Optional(Type.String()), pattern: Type.Optional(Type.String()), obsoleteOnly: Type.Optional(Type.Boolean()),
        currentOnly: Type.Optional(Type.Boolean()), source: Type.Optional(Type.String()), keyword: Type.Optional(Type.String()),
      }),
      execute: async (_id, p) => withLedger(ctx, (l) => l.supersessions({
        repo: opt(p.repo), path: opt(p.path), pattern: opt(p.pattern), obsoleteOnly: p.obsoleteOnly === true, currentOnly: p.currentOnly === true,
        source: opt(p.source), keyword: opt(p.keyword), since: opt(p.since), until: opt(p.until), limit: num(p.limit), offset: num(p.offset),
      })),
    }),
    defineTool({
      name: 'pk_ledger_numbers', label: 'Numbering',
      description: `The project's numbering. Without num: the rules the program recognised (D<n>, CKC-<n>, two-letter prompt or task numbers …), each with the basis it was recognised by and how often it occurs. With num: every place that number shows up — documents (each line once, with the first and last version it is in and whether the current version has it; place definition or mention), commit messages, branch, worktree and file names — oldest first. Filters: kind (doc | commit | branch | worktree | file-name | loose), place, path, currentOnly, since/until. A two-letter number that is also an ordinary word (AI, AM …) is a candidate in prose. ${CITE}`,
      parameters: Type.Object({
        num: Type.Optional(Type.String({ description: 'the number as written: D83, T-22, AB' })), rule: Type.Optional(Type.String()), ...REPO, ...PAGE, ...RANGE,
        kind: Type.Optional(Type.String()), place: Type.Optional(Type.String()), path: Type.Optional(Type.String()), currentOnly: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, p) => withLedger(ctx, (l) => (!opt(p.num) && !opt(p.rule) && !opt(p.path)
        ? l.numRules()
        : l.nums({ num: opt(p.num), rule: opt(p.rule), repo: opt(p.repo), kind: opt(p.kind), place: opt(p.place), path: opt(p.path), currentOnly: p.currentOnly === true, since: opt(p.since), until: opt(p.until), limit: num(p.limit), offset: num(p.offset) }))),
    }),
    defineTool({
      name: 'pk_ledger_verdicts', label: 'Verdicts in reports',
      description: `What QC, review, walkthrough and test reports state: verdicts (pass, fail, incomplete, needs-repair, partial …, as normalised from 通过 / 不通过 / 需修复 / 做到 / 不成立 …), test counts (511/511, "12 passed"), and numbered findings (F-1, D-3 …), each with its line, where it is, the first version it appears in and whether the current version still has it. confidence: stated (a verdict field such as 结论：fail) or candidate (a verdict word in a table row or a heading — yours to confirm). Filters: path, verdict, kind (verdict | count | finding), confidence, keyword (a work number, a scenario), currentOnly. ${CITE}`,
      parameters: Type.Object({
        ...REPO, ...PAGE, ...RANGE, path: Type.Optional(Type.String()), verdict: Type.Optional(Type.String()), kind: Type.Optional(Type.String()),
        confidence: Type.Optional(Type.String()), keyword: Type.Optional(Type.String()), currentOnly: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, p) => withLedger(ctx, (l) => l.verdicts({
        repo: opt(p.repo), path: opt(p.path), verdict: opt(p.verdict), kind: opt(p.kind), confidence: opt(p.confidence), keyword: opt(p.keyword),
        currentOnly: p.currentOnly === true, since: opt(p.since), until: opt(p.until), limit: num(p.limit), offset: num(p.offset),
      })),
    }),
    defineTool({
      name: 'pk_ledger_arrangements', label: 'Execution arrangements',
      description: `What the orchestrator wrote down, every committed version: the prompt index (its rows by work number), each prompt's front matter (status, executor, model, worktree, baseline, accepted commit), execution plans (tables, batches, dependencies, what may run in parallel), run status files (agent, model, worktree, base commit, result), receipts. parsed:false means the program could not read its structure — read the file whole and judge it. With ident (a work number such as AK), how that work's fields changed version by version and its rows in the index. Filters: kind (index | prompt | plan | status | receipt), path, status, currentOnly, unparsedOnly. ${CITE}`,
      parameters: Type.Object({
        ...REPO, ...PAGE, ...RANGE, ident: Type.Optional(Type.String()), kind: Type.Optional(Type.String()), path: Type.Optional(Type.String()),
        status: Type.Optional(Type.String()), currentOnly: Type.Optional(Type.Boolean()), unparsedOnly: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, p) => withLedger(ctx, (l) => (opt(p.ident) && !opt(p.kind) && !opt(p.path)
        ? l.arrangementHistory(str(p.ident), opt(p.repo))
        : l.arrangements({ repo: opt(p.repo), ident: opt(p.ident), kind: opt(p.kind), path: opt(p.path), status: opt(p.status), currentOnly: p.currentOnly === true, unparsedOnly: p.unparsedOnly === true, since: opt(p.since), until: opt(p.until), limit: num(p.limit), offset: num(p.offset) }))),
    }),
    defineTool({
      name: 'pk_ledger_word', label: 'A word across all history',
      description: `Where a word or phrase appears across everything the ledger read — every version of every document (per document: the first and last version that has it, and whether the current version does), every commit message, the owner's words and the agent messages they answered, documents outside version control — oldest first. span: true gives only the first and the last appearance and the count. Three characters or more: case-insensitive; shorter (a two-character Chinese word): exact. Filters: kinds (doc | commit | owner | agent | loose), since/until. ${CITE}`,
      parameters: Type.Object({ word: Type.String(), span: Type.Optional(Type.Boolean()), kinds: Type.Optional(Type.Array(Type.String())), ...REPO, ...PAGE, ...RANGE }),
      execute: async (_id, p) => withLedger(ctx, (l) => (p.span === true
        ? l.wordSpan(str(p.word), { repo: opt(p.repo) })
        : l.word(str(p.word), { kinds: strs(p.kinds), repo: opt(p.repo), since: opt(p.since), until: opt(p.until), limit: num(p.limit), offset: num(p.offset) }))),
    }),
    defineTool({
      name: 'pk_ledger_refs', label: 'File references',
      description: 'File-level references in the current version: who references a file and what it references, with the kind (import, calls, references, instantiates, extends …), its size and last change. TypeScript and JavaScript are read by the compiler\'s pre-parser; every other language by the ledger\'s code engine, counting only references it resolved through an import, a path, a qualified name, a function reference or an instance method (never a name alone); its unresolved imports are listed as external. A file whose references no reader reads says so in level. Without path: the code files no other file references — a fact; an entry point, a test or a script is referenced by nothing and is not residue, the judgement is yours (dir narrows it). namedBy on a file: other files name it though no counted reference reaches it — entryPoint when a build or manifest file names it (AndroidManifest.xml, CMakeLists.txt, a Gradle or Xcode project …: a named entry point, not residue), otherwise code that names it (an include directive, a worker started by its path); mentionedBy lists documents and data that only mention it. Read them before calling it unreferenced. Symbols: pk_ledger_symbol; since when a reference exists: pk_ledger_ref_history.',
      parameters: Type.Object({ path: Type.Optional(Type.String()), dir: Type.Optional(Type.String()), includeTests: Type.Optional(Type.Boolean()), ...REPO, ...PAGE }),
      execute: async (_id, p) => withLedger(ctx, (l) => (opt(p.path)
        ? l.fileRefs(str(p.path), { repo: opt(p.repo) })
        : l.unreferenced({ repo: opt(p.repo), dir: opt(p.dir), includeTests: p.includeTests === true, limit: num(p.limit), offset: num(p.offset) }))),
    }),
    defineTool({
      name: 'pk_ledger_ref_history', label: 'Since when a file references another',
      description: 'Follows one file back through every commit that changed it and says in which commits its reference to another file appears and disappears (the target matched by file name — by its stem in an import specifier — so a moved target is still found), the first such commit on the trunk, and whether it references it now. Each version is read the way the file\'s language is read now: TypeScript and JavaScript by the compiler\'s pre-parser, every other language by the code engine\'s extraction of that version\'s imports. Read-only git.',
      parameters: Type.Object({ src: Type.String({ description: 'the referencing file, repository-relative' }), dst: Type.String({ description: 'the referenced file (its name is enough)' }), ...REPO }),
      execute: async (_id, p) => withLedger(ctx, (l) => l.refHistory(str(p.src), str(p.dst), { repo: opt(p.repo) })),
    }),
    defineTool({
      name: 'pk_ledger_symbol', label: 'Symbol references',
      description: 'Symbol level in every language whose references the ledger reads: kind references (every place the symbol is used), implementations, callers or callees (the call hierarchy). TypeScript and JavaScript are answered by the TypeScript language service on the checkout, compiler-exact; every other language by the ledger\'s code engine on the current version. Every hit says how it was resolved (how, confidence) and whether it counts — a hit the engine matched only by a name counts when its file reaches the declaring file through imports (through). Locate the symbol by name (its first declaration in the file; a member as Class.member) or by 1-based line and character.',
      parameters: Type.Object({
        file: Type.String({ description: 'repository-relative file of the current version' }),
        kind: Type.String({ description: 'references | implementations | callers | callees' }),
        name: Type.Optional(Type.String()), line: Type.Optional(Type.Number()), character: Type.Optional(Type.Number()), ...REPO,
      }),
      execute: async (_id, p) => {
        const kind = str(p.kind);
        if (!['references', 'implementations', 'callers', 'callees'].includes(kind)) return fail('kind must be references, implementations, callers or callees.');
        return withLedger(ctx, (l) => l.symbol(kind as 'references', { file: str(p.file), name: opt(p.name), line: num(p.line), character: num(p.character) }, { repo: opt(p.repo) }));
      },
    }),
    defineTool({
      name: 'pk_ledger_code', label: 'Code sizes, tests and merges',
      description: 'The current version\'s directories: files and lines split into product code, generated code (how it was recognised) and other classified material (third-party), test files and test cases, and the last change of each (under narrows to a directory, depth limits how deep). With merges: true, which directories each merge changed instead (dir narrows it; trunkOnly). The numbers a code territory is made of.',
      parameters: Type.Object({ ...REPO, ...PAGE, under: Type.Optional(Type.String()), depth: Type.Optional(Type.Number()), merges: Type.Optional(Type.Boolean()), dir: Type.Optional(Type.String()), trunkOnly: Type.Optional(Type.Boolean()) }),
      execute: async (_id, p) => withLedger(ctx, (l) => (p.merges === true
        ? l.merges({ repo: opt(p.repo), dir: opt(p.dir), trunkOnly: p.trunkOnly === true, limit: num(p.limit), offset: num(p.offset) })
        : l.dirs({ repo: opt(p.repo), under: opt(p.under), depth: num(p.depth), limit: num(p.limit), offset: num(p.offset) }))),
    }),
    defineTool({
      name: 'pk_ledger_sessions', label: 'Sessions',
      description: `The sessions of the project's working directories the ledger read: host, native id, start and end, messages, the owner's messages, headless or subagent, and what cannot be read (a log gone since it was read, a log that fails to parse — missingOnly lists those). With session (its id, native id or a prefix): its messages in order, every speaker as the session's structure says (owner, agent, subagent, host), with the text of the owner's messages and of the agent messages they answer. ${CITE}`,
      parameters: Type.Object({ session: Type.Optional(Type.String()), host: Type.Optional(Type.String()), speaker: Type.Optional(Type.String()), fromIndex: Type.Optional(Type.Number()), withOwnerWords: Type.Optional(Type.Boolean()), missingOnly: Type.Optional(Type.Boolean()), ...PAGE, ...RANGE }),
      execute: async (_id, p) => withLedger(ctx, (l) => (opt(p.session)
        ? l.sessionMessages(str(p.session), { host: opt(p.host), speaker: opt(p.speaker), fromIndex: num(p.fromIndex), limit: num(p.limit), offset: num(p.offset) })
        : l.sessions({ host: opt(p.host), withOwnerWords: p.withOwnerWords === true, missingOnly: p.missingOnly === true, since: opt(p.since), until: opt(p.until), limit: num(p.limit), offset: num(p.offset) }))),
    }),
    defineTool({
      name: 'pk_ledger_owner_words', label: 'The owner\'s own words',
      description: `Every message the owner typed in the project's sessions, verbatim (credentials redacted), oldest first, each with the agent message right before it that it answers — the owner's "ok" or "可以" is read against what it said yes to; the agent's text is only there to understand what the owner confirmed. Filters: since/until, keyword, session, host; headless runs (a program's prompts) are left out unless includeHeadless. ${CITE}`,
      parameters: Type.Object({ keyword: Type.Optional(Type.String()), session: Type.Optional(Type.String()), host: Type.Optional(Type.String()), includeHeadless: Type.Optional(Type.Boolean()), ...PAGE, ...RANGE }),
      execute: async (_id, p) => withLedger(ctx, (l) => l.ownerWords({ keyword: opt(p.keyword), session: opt(p.session), host: opt(p.host), includeHeadless: p.includeHeadless === true, since: opt(p.since), until: opt(p.until), limit: num(p.limit), offset: num(p.offset) })),
    }),
    defineTool({
      name: 'pk_ledger_provenance', label: 'How it got here',
      description: `The dated steps of how something got here, assembled from the ledger, oldest first: where it first appeared, each version that changed it (with the sections), lines that say it was superseded or list it as obsolete, the plans and arrangements that name it (status by version), commits and merges, verdicts, the owner's words that name it, and where it stands now. Anchors: nums (project numbers), paths (documents or files), commits, words, entries (ledger ids). Steps whose material exists only in history are marked history: write them as history, with what replaced them. ${CITE}`,
      parameters: Type.Object({
        nums: Type.Optional(Type.Array(Type.String())), paths: Type.Optional(Type.Array(Type.String())), commits: Type.Optional(Type.Array(Type.String())),
        words: Type.Optional(Type.Array(Type.String())), entries: Type.Optional(Type.Array(Type.String())), ...REPO,
      }),
      execute: async (_id, p) => {
        const input = { nums: strs(p.nums), paths: strs(p.paths), commits: strs(p.commits), words: strs(p.words), entries: strs(p.entries), repo: opt(p.repo) };
        if (!input.nums.length && !input.paths.length && !input.commits.length && !input.words.length && !input.entries.length) return fail('Give at least one anchor: nums, paths, commits, words or entries.');
        return withLedger(ctx, (l) => l.provenance(input));
      },
    }),
    defineTool({
      name: 'pk_ledger_entry', label: 'Read a ledger entry',
      description: 'One entry of the ledger by its id (commit:…, doc:…, del:…, cleanup:…, sup:…, num:…, rule:…, verdict:…, plan:…, session:…, msg:…, file:…): its label, when it happened and its text (a document version\'s whole text, paged by lines with fromLine / toLine), exactly as a citation of it is read.',
      parameters: Type.Object({ id: Type.String(), fromLine: Type.Optional(Type.Number()), toLine: Type.Optional(Type.Number()) }),
      execute: async (_id, p) => withLedger(ctx, (l) => {
        const e: LedgerEntry | null = l.resolve(str(p.id));
        if (!e) return `${str(p.id)} is not an entry of the ledger.`;
        if (e.text === undefined) return e;
        const lines = e.text.split(/\r?\n/);
        const from = Math.max(1, Math.floor(num(p.fromLine) ?? 1));
        const to = Math.min(lines.length, Math.floor(num(p.toLine) ?? lines.length));
        let size = 0;
        let end = from - 1;
        const out: string[] = [];
        for (let i = from - 1; i < to; i++) { if (out.length && size + lines[i]!.length > 60_000) break; out.push(lines[i]!); size += lines[i]!.length + 1; end = i + 1; }
        return { ...e, text: out.join('\n'), lines: lines.length, fromLine: from, toLine: end, ...(end < to ? { nextFromLine: end + 1 } : {}) };
      }),
    }),
    defineTool({
      name: 'pk_ledger_coverage', label: 'What the ledger covers',
      description: 'What the ledger covers and what it does not: per repository the commits, branches, merges, the time span and the day document version history starts (content before an import commit is dated by what it says, else file time); per language who reads its code references (the TypeScript compiler, the code engine, or no one) and what that reached, measured — imports resolved and not, references by resolution method, counted and matched by a name only, and where references went unresolved (gaps); the code engine\'s last run (time, peak memory, index size); generated and third-party material kept apart; sessions read, the ones that cannot be read and the commit days no session covers; documents outside version control; the rules the program used (import-style root commit, cleanup commit, numbering, verdicts, occurred time); the last rebuild and how long it took.',
      parameters: Type.Object({}),
      execute: async () => withLedger(ctx, (l) => l.coverage()),
    }),
  ];
}

/** Where a project's ledger file is, for a caller that has the store's directory. */
export const ledgerFileOf = (projectDirPath: string): string => join(projectDirPath, 'ledger.sqlite');
