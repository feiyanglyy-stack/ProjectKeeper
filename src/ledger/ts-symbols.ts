/**
 * Symbol-level TypeScript queries, on demand (Spec §1.16 row 7, CKC-03 AC-27): who references a
 * symbol, who implements it, and its call hierarchy, answered by a LanguageService over the current
 * checkout. Nothing is precomputed into the database; the LanguageService is created lazily per
 * repository and kept for the process. Every other language is answered by the ledger's code engine in the
 * same shape (code-engine.ts `engineSymbol`; D98).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { normalizePath } from '../util/paths.ts';

export interface SymbolLocation {
  readonly file: string;          // repo-relative, forward slashes
  readonly line: number;
  readonly character: number;
  readonly preview: string;
}

export interface SymbolResult {
  readonly symbol: string;
  readonly file: string;
  readonly line: number;
  readonly locations?: readonly SymbolLocation[];
  readonly incoming?: readonly { readonly from: string; readonly file: string; readonly line: number }[];
  readonly outgoing?: readonly { readonly to: string; readonly file: string; readonly line: number }[];
}

export type SymbolQueryKind = 'references' | 'implementations' | 'callers' | 'callees';

interface Host { readonly service: ts.LanguageService; readonly files: readonly string[]; readonly root: string; readonly signature: string }
const hosts = new Map<string, Host>();

/** One LanguageService per checkout, made again when the set of files changes; a file's version is its modification time. */
function serviceFor(root: string, relFiles: readonly string[]): Host {
  const key = normalizePath(root).toLowerCase();
  const signature = `${relFiles.length}:${relFiles.join('\n').length}`;
  const existing = hosts.get(key);
  if (existing && existing.signature === signature) return existing;
  existing?.service.dispose();
  const files = relFiles.map((f) => join(root, ...f.split('/')));
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => ({
      allowJs: true, checkJs: false, noEmit: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2024, strict: false, skipLibCheck: true, allowImportingTsExtensions: true,
    }),
    getScriptFileNames: () => [...files],
    getScriptVersion: (f) => { try { return String(statSync(f).mtimeMs); } catch { return '0'; } },
    getScriptSnapshot: (f) => {
      try { return ts.ScriptSnapshot.fromString(readFileSync(f, 'utf8')); } catch { return undefined; }
    },
    getCurrentDirectory: () => root,
    getDirectories: (d) => {
      try { return ts.sys.getDirectories ? ts.sys.getDirectories(d) : []; } catch { return []; }
    },
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (f) => existsSync(f),
    readFile: (f) => {
      try { return readFileSync(f, 'utf8'); } catch { return undefined; }
    },
    readDirectory: (d, ext, excl, incl, depth) => ts.sys.readDirectory(d, ext, excl, incl, depth),
    directoryExists: (d) => {
      try { return ts.sys.directoryExists(d); } catch { return false; }
    },
    realpath: (p) => p,
    useCaseSensitiveFileNames: () => false,
    getNewLine: () => '\n',
  };
  const created: Host = { service: ts.createLanguageService(host), files, root, signature };
  hosts.set(key, created);
  return created;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A file as a repository-relative path with forward slashes (TypeScript and Windows spell the separator differently). */
const relOf = (root: string, file: string): string => {
  const f = normalizePath(file).split('\\').join('/');
  const r = normalizePath(root).split('\\').join('/');
  return f.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? f.slice(r.length + 1) : f;
};

/** The program's source file for an absolute path (paths compare case-insensitively here). */
function sourceFileOf(service: ts.LanguageService, file: string): ts.SourceFile | undefined {
  const program = service.getProgram();
  const direct = program?.getSourceFile(file);
  if (direct) return direct;
  const wanted = normalizePath(file).toLowerCase();
  return program?.getSourceFiles().find((f) => normalizePath(f.fileName).toLowerCase() === wanted);
}

/** First declaration of a name in a file, via the navigation tree. */
function findByName(service: ts.LanguageService, file: string, name: string): number | null {
  const tree = service.getNavigationTree(file);
  const needle = name.trim();
  let best: number | null = null;
  const visit = (node: ts.NavigationTree): void => {
    if (best !== null) return;
    if (node.text === needle) {
      // The name itself, not the start of the declaration (its `export` keyword): callers and callees are asked at a
      // position, and the declaration's start answered nothing (BM found 0 callers of rebuildLedgerInPlace against 12).
      best = node.nameSpan?.start ?? node.spans[0]?.start ?? null;
      return;
    }
    for (const child of node.childItems ?? []) visit(child);
  };
  if (tree) visit(tree);
  return best;
}

/**
 * Answer one symbol query. `file` is repo-relative; the symbol is located by 1-based `line` and
 * `character`, or by `name` (first declaration in the file). Returns an error string on misuse.
 */
export function symbolQuery(
  root: string, relFiles: readonly string[], kind: SymbolQueryKind,
  input: { file: string; line?: number; character?: number; name?: string },
): SymbolResult | string {
  const rel = input.file.split('\\').join('/').replace(/^\.?\//, '');
  if (!rel || rel.split('/').some((s) => s === '..')) return `Give a file inside the repository (got “${input.file}”).`;
  const abs = join(root, ...rel.split('/'));
  if (!existsSync(abs)) return `${rel} is not in the current checkout of ${root}. Symbol queries read the working tree.`;
  if (!/\.(tsx?|jsx?|mjs|cts|mts)$/i.test(rel)) return `${rel} is not a TypeScript/JavaScript file; symbol queries cover TS/JS (see ledger coverage for the level of each language).`;

  const { service } = serviceFor(root, relFiles);
  const sf = sourceFileOf(service, abs);
  if (!sf) return `${rel} is not among the project's TypeScript files in the ledger.`;
  let pos: number;
  if (typeof input.line === 'number' && typeof input.character === 'number') {
    pos = sf.getPositionOfLineAndCharacter(input.line - 1, input.character - 1);
  } else if (input.name) {
    const found = findByName(service, abs, input.name);
    if (found === null) return `No declaration named “${input.name}” in ${rel}.`;
    pos = found;
  } else {
    return 'Give either line + character (1-based) or a symbol name.';
  }
  const lc = ts.getLineAndCharacterOfPosition(sf, pos);
  const symbolName = input.name ?? service.getQuickInfoAtPosition(abs, pos)?.displayParts?.map((p) => p.text).join('') ?? '';
  const base: SymbolResult = { symbol: clip(symbolName.trim(), 120), file: rel, line: lc.line + 1 };

  const locOf = (file: string, span: ts.TextSpan): SymbolLocation => {
    const target = sourceFileOf(service, file);
    const l = target ? ts.getLineAndCharacterOfPosition(target, span.start) : { line: 0, character: 0 };
    const lineText = target ? (target.text.split(/\r?\n/)[l.line] ?? '') : '';
    return { file: relOf(root, file), line: l.line + 1, character: l.character + 1, preview: clip(lineText.trim(), 200) };
  };
  const spanStartLine = (file: string, span: ts.TextSpan): number => {
    const target = sourceFileOf(service, file);
    return target ? ts.getLineAndCharacterOfPosition(target, span.start).line + 1 : 0;
  };

  if (kind === 'references') {
    const refs = service.findReferences(abs, pos) ?? [];
    const locations: SymbolLocation[] = [];
    for (const sym of refs) for (const refEntry of sym.references) locations.push(locOf(refEntry.fileName, refEntry.textSpan));
    return { ...base, locations };
  }
  if (kind === 'implementations') {
    const impls = service.getImplementationAtPosition(abs, pos) ?? [];
    return { ...base, locations: impls.map((i) => locOf(i.fileName, i.textSpan)) };
  }
  if (kind === 'callers') {
    const incoming = service.provideCallHierarchyIncomingCalls(abs, pos) ?? [];
    return {
      ...base,
      incoming: incoming.map((c) => ({ from: c.from.name, file: relOf(root, c.from.file), line: spanStartLine(c.from.file, c.from.span) })),
    };
  }
  const outgoing = service.provideCallHierarchyOutgoingCalls(abs, pos) ?? [];
  return {
    ...base,
    outgoing: outgoing.map((c) => ({ to: c.to.name, file: relOf(root, c.to.file), line: spanStartLine(c.to.file, c.to.span) })),
  };
}

/** The tracked TS/JS files of a repo's current version, for the LanguageService. */
export function tsFilesOf(relFiles: readonly string[]): string[] {
  return relFiles.filter((f) => /\.(tsx?|jsx?|mjs|cts|mts)$/i.test(f));
}
