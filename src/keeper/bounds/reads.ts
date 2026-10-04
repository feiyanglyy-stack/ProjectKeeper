/**
 * What a step read (Spec §1.11: `Read in full` is what a job actually read; CKC-13 AC-8), worked out from the call and its
 * result when the step ends and recorded on the step (`JobStep.reads`), so the coverage counts what reached the agent
 * however it was read, and tells a whole file from some of its lines.
 *
 *  - The file tool (`read`): the lines it showed — from its offset to where its own notice says it stopped (pi cuts a file
 *    at 2000 lines or 50 KB and says where to go on), or to the end.
 *  - A shell command: tokenised the way the command boundary tokenises it (command.ts), each file resolved against the
 *    directory the command runs in the way the boundary resolves paths (paths.ts), and followed down its pipeline: `cat`
 *    and its like show a file whole; `head`, `tail`, `sed -n 'a,bp'` and `awk 'NR>=a && NR<=b'` show some of its lines;
 *    a `| head -50` after them cuts what reached it. Searching (`grep`, `rg` …) is not reading, nor are listing and
 *    counting (`ls`, `find`, `wc`), nor is a program's output (`python -c`, `node -e`, `xargs`) a read of what it opened.
 *    `git show <commit>:<path>` reads a version from the history, `git show <commit>` a commit. Output the shell cut to
 *    its tail showed only a part of what was read. A command the boundary refused read nothing; one that ran and exited
 *    non-zero still showed its output.
 *  - The ledger's document tools: a version of a document and its lines, the current one or one from the history; a
 *    commit, read whole.
 *
 * Only files that exist are kept, so a word that merely looks like a path (a pattern, a branch, a count) never counts. A
 * file's length in lines is taken when a range of it was read, so ranges read in several calls can be seen to cover it.
 */
import { globSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { StepRead } from '../../model/types.ts';
import { commandName, extractHeredocs, tokenize, type Token } from './command.ts';
import { toAbsolute } from './paths.ts';

/** Lines `[from, to]`, 1-based and inclusive; `to` null: to the end. */
type Range = readonly [number, number | null];
/** How much of a file (or of a stream) reaches the agent: all of it, some lines by number, its last lines, or a part. */
type Extent =
  | { readonly kind: 'whole' }
  | { readonly kind: 'lines'; readonly ranges: readonly Range[] }
  | { readonly kind: 'last'; readonly count: number }
  | { readonly kind: 'part' };
const WHOLE: Extent = { kind: 'whole' };
const PART: Extent = { kind: 'part' };
const lines = (ranges: readonly Range[]): Extent | null => (ranges.length ? { kind: 'lines', ranges } : null);

/**
 * What a command does to the lines coming in on its standard input: shows them all (`cat`, `sort`), none of them
 * (searching, counting, a program: `grep`, `wc`, `xargs`), some not by number (`cut`, a pattern `sed`), some by number
 * (`head -50`, `sed -n '5,9p'`), the last ones (`tail -20`), or from a line on (`tail -n +5`).
 */
type Filter =
  | { readonly kind: 'keep' } | { readonly kind: 'none' } | { readonly kind: 'part' }
  | { readonly kind: 'lines'; readonly ranges: readonly Range[] }
  | { readonly kind: 'last'; readonly count: number }
  | { readonly kind: 'from'; readonly line: number };
const KEEP: Filter = { kind: 'keep' };
const NONE: Filter = { kind: 'none' };
const SOME: Filter = { kind: 'part' };

/** A stream that is `e` of a file, after `f`: what of the file still reaches the output (null: nothing). */
function through(e: Extent | null, f: Filter): Extent | null {
  if (!e) return null;
  switch (f.kind) {
    case 'keep': return e;
    case 'none': return null;
    case 'part': return PART;
    case 'lines': return narrow(e, f.ranges);
    case 'last':
      if (e.kind === 'whole') return { kind: 'last', count: f.count };
      if (e.kind === 'last') return { kind: 'last', count: Math.min(e.count, f.count) };
      if (e.kind === 'lines' && e.ranges.length === 1 && e.ranges[0]![1] !== null) {
        const [a, b] = e.ranges[0]! as readonly [number, number];
        return lines([[Math.max(a, b - f.count + 1), b]]);
      }
      return PART;
    case 'from':
      if (e.kind === 'whole') return lines([[f.line, null]]);
      if (e.kind === 'lines' && e.ranges.length === 1) {
        const [a, b] = e.ranges[0]!;
        const start = a + f.line - 1;
        return b !== null && start > b ? null : lines([[start, b]]);
      }
      if (e.kind === 'last') return e.count - f.line + 1 > 0 ? { kind: 'last', count: e.count - f.line + 1 } : null;
      return PART;
  }
}

/** Lines `ranges` of a stream that is `e` of a file (the stream's line n is the file's line n when `e` is whole). */
function narrow(e: Extent, ranges: readonly Range[]): Extent | null {
  if (e.kind === 'whole') return lines(ranges);
  if (e.kind === 'lines' && e.ranges.length === 1) {
    const [a, b] = e.ranges[0]!;
    const out: Range[] = [];
    for (const [x, y] of ranges) {
      const from = a + x - 1;
      const to = y === null ? b : b === null ? a + y - 1 : Math.min(b, a + y - 1);
      if (to === null || from <= to) out.push([from, to]);
    }
    return lines(out);
  }
  // The first N lines of the last C: all of them when N reaches C.
  if (e.kind === 'last' && ranges.length === 1 && ranges[0]![0] === 1 && (ranges[0]![1] === null || ranges[0]![1] >= e.count)) return e;
  return PART;
}

/** One read a shell command makes: a file (or a version of it from the history, `rev`) and how much of it it shows. */
interface Intent { readonly path: string; readonly extent: Extent; readonly rev?: string }

/** What one simple command reads itself, what it does to its standard input, and whether it reads that input at all. */
interface Stage {
  readonly reads: readonly Intent[];
  readonly commits: readonly string[];
  readonly filter: Filter;
  readonly readsStdin: boolean;
  /** Its standard output goes to a file (or nowhere), not down the pipe or to the agent. */
  readonly outputAway: boolean;
}
const nothing = (outputAway: boolean, readsStdin = false): Stage => ({ reads: [], commits: [], filter: NONE, readsStdin, outputAway });

const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };

/** Files a word names: the file itself, or what a glob in it matches. A word that names no file names nothing. */
function filesOf(word: Token, cwd: string | null): string[] {
  if (word.dynamic || word.substitution || !word.text) return [];
  if (cwd === null && !/^([A-Za-z]:[\\/]|\/|~|\\\\)/.test(word.text)) return [];   // relative, and where it is relative to is lost
  const base = cwd ?? process.cwd();
  const abs = toAbsolute(word.text, base);
  if (isFile(abs)) return [abs];
  if (!/[*?[]/.test(word.text)) return [];
  try { return globSync(abs.replace(/\\/g, '/')).slice(0, 500).map((p) => (isAbsolute(p) ? p : resolve(base, p))).filter(isFile); } catch { return []; }
}

/** Where the repository holding `dir` has its root (the nearest directory up with a `.git`), for `git show <rev>:<path>`. */
function repoRootOf(dir: string): string | null {
  let d = dir;
  for (let i = 0; i < 64; i++) {
    try { statSync(join(d, '.git')); return d; } catch { /* go up */ }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/** A command's operands: not options (unless after `--`), and not the values of the options listed as taking one. */
function operandsOf(args: readonly Token[], valued: readonly string[] = []): Token[] {
  const out: Token[] = [];
  let done = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (done || w.text === '-' || !w.text.startsWith('-')) { out.push(w); continue; }
    if (w.text === '--') { done = true; continue; }
    if (valued.includes(w.text)) i += 1;
  }
  return out;
}

/** `head` and `tail`: how many lines, from which line, or bytes (then not by line). */
function headTail(name: 'head' | 'tail', args: readonly Token[]): { filter: Filter; files: Token[] } {
  let count = 10;
  let from: number | null = null;
  let some = false;
  const files: Token[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!.text;
    let v: string;
    if (a === '--') { files.push(...args.slice(i + 1)); break; }
    if (a === '-n' || a === '--lines') v = args[++i]?.text ?? '';
    else if (/^-n.+/.test(a)) v = a.slice(2);
    else if (a.startsWith('--lines=')) v = a.slice(8);
    else if (a === '-c' || a === '--bytes') { some = true; i += 1; continue; }
    else if (/^-c.+/.test(a) || a.startsWith('--bytes=')) { some = true; continue; }
    else if (/^-\d+$/.test(a)) v = a.slice(1);
    else if (name === 'tail' && /^\+\d+$/.test(a)) v = a;
    else if (a.startsWith('-') && a !== '-') continue;                 // -q, -v, -f, -F …
    else { files.push(args[i]!); continue; }
    if (name === 'tail' && v.startsWith('+')) from = Math.max(1, Number(v.slice(1)) || 1);
    else if (/^\d+$/.test(v)) count = Number(v);
    else some = true;                                                   // head -n -5 (all but the last five), a unit
  }
  const filter: Filter = some ? SOME
    : name === 'head' ? (count > 0 ? { kind: 'lines', ranges: [[1, count]] } : NONE)
    : from !== null ? { kind: 'from', line: from }
    : count > 0 ? { kind: 'last', count } : NONE;
  return { filter, files };
}

/**
 * The lines a sed script prints: with `-n`, only `p` at line numbers (`5p`, `5,9p`, `5,$p`, `5,+4p`) give lines by
 * number, and a `q` only stops it; without `-n` every line is printed unless a `q` stops it early, and a script that only
 * substitutes moves no line. Anything else (a pattern address, `d`, `a`, `y` …) prints some lines, not by number. A `$p`
 * alone is the last line.
 */
function sedFilter(script: string, quiet: boolean): Filter {
  const cmds = script.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
  const ranges: Range[] = [];
  let quitAt: number | null = null;
  let lastLine = false;
  for (const c of cmds) {
    let m: RegExpExecArray | null;
    if ((m = /^(\d+)\s*(?:,\s*(\d+|\$|\+\d+))?\s*p$/.exec(c))) {
      const a = Number(m[1]);
      const b = m[2] === undefined ? a : m[2] === '$' ? null : m[2].startsWith('+') ? a + Number(m[2].slice(1)) : Number(m[2]);
      ranges.push([Math.max(1, a), b]);
      continue;
    }
    if (/^\$\s*p$/.test(c)) { lastLine = true; continue; }
    if ((m = /^(\d+)\s*q$/.exec(c))) { quitAt = Number(m[1]); continue; }
    if (!quiet && /^s(.).*\1.*\1[gip0-9]*$/.test(c)) continue;         // substitutes in place: every line still shown
    return SOME;
  }
  if (!quiet) return quitAt !== null ? { kind: 'lines', ranges: [[1, quitAt]] } : KEEP;
  if (lastLine) return ranges.length ? SOME : { kind: 'last', count: 1 };
  const kept = ranges.map(([a, b]): Range => [a, quitAt === null ? b : Math.min(b ?? quitAt, quitAt)]).filter(([a, b]) => b === null || a <= b);
  return kept.length ? { kind: 'lines', ranges: kept } : NONE;
}

/** `sed`: its script (`-n`, `-e`, the first operand) and its files; null for `sed -i`, which writes and shows nothing. */
function sedOf(args: readonly Token[]): { filter: Filter; files: Token[] } | null {
  let quiet = false;
  let fromFile = false;
  const scripts: string[] = [];
  const operands: Token[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!.text;
    if (a === '--') { operands.push(...args.slice(i + 1)); break; }
    if (a === '-n' || a === '--quiet' || a === '--silent') { quiet = true; continue; }
    if (a === '-e' || a === '--expression') { scripts.push(args[++i]?.text ?? ''); continue; }
    if (a.startsWith('--expression=')) { scripts.push(a.slice(13)); continue; }
    if (a === '-f' || a === '--file') { fromFile = true; i += 1; continue; }
    if (a.startsWith('--file=')) { fromFile = true; continue; }
    if (a.startsWith('--in-place')) return null;
    if (/^-[A-Za-z]+/.test(a)) {                                      // a cluster: -n, -ne, -nE, -En, -i.bak
      const letters = /^-([A-Za-z]+)/.exec(a)![1]!;
      if (letters.includes('i')) return null;
      if (letters.includes('n')) quiet = true;
      if (letters.endsWith('e')) scripts.push(args[++i]?.text ?? '');
      else if (letters.endsWith('f')) { fromFile = true; i += 1; }
      continue;
    }
    if (a.startsWith('--')) continue;
    operands.push(args[i]!);
  }
  if (!scripts.length && !fromFile) scripts.push(operands.shift()?.text ?? '');
  return { filter: fromFile ? SOME : sedFilter(scripts.join('\n'), quiet), files: operands };
}

/**
 * The lines an awk program prints of its input: `NR>=a && NR<=b` (either order, `>`/`<` too), `NR==n`, `NR>=a`, `NR<=b`,
 * with or without `{print}`; every line for `1` or `{print}`; none for a program with only an END block (a count, a
 * total); some, not by number, for anything else.
 */
function awkFilter(program: string): Filter {
  const s = program.replace(/\s+/g, ' ').trim();
  if (/^(1|\{ ?print( \$0)? ?;? ?\})$/.test(s)) return KEEP;
  if (/^END ?\{/.test(s)) return NONE;
  const body = s.replace(/ ?\{ ?print( \$0)? ?;? ?\}$/, '');
  const at = (op: string, n: string, low: boolean) => Number(n) + (op === '>' && low ? 1 : op === '<' && !low ? -1 : 0);
  let m: RegExpExecArray | null;
  if ((m = /^NR ?(>=|>) ?(\d+) ?&& ?NR ?(<=|<) ?(\d+)$/.exec(body))) return { kind: 'lines', ranges: [[at(m[1]!, m[2]!, true), at(m[3]!, m[4]!, false)]] };
  if ((m = /^NR ?(<=|<) ?(\d+) ?&& ?NR ?(>=|>) ?(\d+)$/.exec(body))) return { kind: 'lines', ranges: [[at(m[3]!, m[4]!, true), at(m[1]!, m[2]!, false)]] };
  if ((m = /^NR ?== ?(\d+)$/.exec(body))) return { kind: 'lines', ranges: [[Number(m[1]), Number(m[1])]] };
  if ((m = /^NR ?(>=|>) ?(\d+)$/.exec(body))) return { kind: 'from', line: at(m[1]!, m[2]!, true) };
  if ((m = /^NR ?(<=|<) ?(\d+)$/.exec(body))) return { kind: 'lines', ranges: [[1, at(m[1]!, m[2]!, false)]] };
  return SOME;
}

function awkOf(args: readonly Token[]): { filter: Filter; files: Token[] } {
  let program: string | null = null;
  let fromFile = false;
  const operands: Token[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!.text;
    if (a === '--') { operands.push(...args.slice(i + 1)); break; }
    if (a === '-F' || a === '-v') { i += 1; continue; }
    if (a === '-f') { fromFile = true; i += 1; continue; }
    if (a.startsWith('-') && a !== '-') continue;
    if (program === null && !fromFile) { program = a; continue; }
    if (/^[A-Za-z_]\w*=/.test(a)) continue;                          // var=value sets a variable
    operands.push(args[i]!);
  }
  return { filter: fromFile || program === null ? SOME : awkFilter(program), files: operands };
}

/** Commands that show every line of the files they are given, or of their input (reordered or reformatted at most). */
const SHOWS_ALL = new Set(['cat', 'tac', 'nl', 'more', 'less', 'most', 'bat', 'batcat', 'pr', 'fold', 'fmt', 'expand', 'unexpand', 'column', 'sort', 'uniq', 'rev', 'iconv']);
/** Commands that show some of what they read, not by line number. */
const SHOWS_SOME = new Set(['cut', 'strings', 'diff', 'comm', 'colordiff']);
/** The options of those commands that take a value, so the value is not taken for a file. */
const BAT_VALUED = ['-l', '--language', '-H', '--highlight-line', '--style', '--theme', '-m', '--map-syntax', '--tabs', '--wrap', '--terminal-width'];
const VALUED: Readonly<Record<string, readonly string[]>> = {
  nl: ['-b', '-n', '-s', '-v', '-i', '-w', '-l', '-d', '-f', '-h'],
  sort: ['-k', '-t', '-o', '-S', '-T', '--key', '--field-separator', '--output', '--buffer-size', '--temporary-directory'],
  fold: ['-w', '--width'], fmt: ['-w', '--width', '-g', '-p'], column: ['-s', '-c', '-o', '-N', '-W', '-H', '-R', '-E', '-O'],
  uniq: ['-f', '-s', '-w'], pr: ['-l', '-w', '-h', '-o', '-s', '-e', '-i', '-n', '-N'], iconv: ['-f', '-t', '--from-code', '--to-code'],
  expand: ['-t'], unexpand: ['-t'], more: ['-n'], less: ['-x', '-y', '-z', '-b', '-h', '-j', '-k', '-o', '-O', '-p', '-P', '-t', '-T'],
  bat: BAT_VALUED, batcat: BAT_VALUED,
  cut: ['-d', '-f', '-c', '-b', '--delimiter', '--fields', '--characters', '--bytes', '--output-delimiter'],
  diff: ['-U', '-C', '-W', '--label', '-I', '-x', '-X', '-L'], strings: ['-n', '-t', '-e'],
};
/** Searching, counting, checking, encoding, programs: what they read does not reach the agent as text to read. */
const SHOWS_NONE_READS_INPUT = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'findstr', 'wc', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'cmp', 'base64', 'od', 'xxd', 'hexdump', 'xargs', 'python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'perl', 'ruby']);
/** Words that lead into a command without being one. */
const LEADING = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', 'time', '{', 'command', 'builtin', 'exec', 'nohup', 'stdbuf']);
/** A command node that starts with one of these reads nothing itself (a loop header, the end of a block). */
const HEADERS = new Set(['for', 'case', 'select', 'function', 'done', 'fi', 'esac', '}']);
const BASH_FAMILY = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const OUTPUT_REDIRECTS = new Set(['>', '>>', '1>', '1>>', '&>', '&>>']);
const INPUT_REDIRECTS = new Set(['<', '0<']);
const TEXT_INPUT = new Set(['<<', '<<-', '<<<']);

/** A PowerShell command's reads: `Get-Content` and its aliases, and what `Select-Object` keeps of a pipe. */
function powerShellStage(name: string, args: readonly Token[], cwd: string | null): Stage | null {
  const n = name.toLowerCase();
  const value = (flags: readonly string[]): string | null => {
    const i = args.findIndex((a) => flags.includes(a.text.toLowerCase()));
    return i >= 0 ? args[i + 1]?.text ?? null : null;
  };
  const number = (v: string | null) => (v !== null && /^\d+$/.test(v) ? Number(v) : null);
  if (n === 'get-content' || n === 'gc' || n === 'cat' || n === 'type') {
    const head = number(value(['-totalcount', '-head', '-first']));
    const tail = number(value(['-tail', '-last']));
    const extent: Extent = head !== null ? { kind: 'lines', ranges: [[1, head]] } : tail !== null ? { kind: 'last', count: tail } : WHOLE;
    const valued = new Set(['-totalcount', '-head', '-first', '-tail', '-last', '-encoding', '-delimiter', '-readcount', '-stream']);
    const files: Token[] = [];
    for (let i = 0; i < args.length; i++) {
      const t = args[i]!.text.toLowerCase();
      if (t === '-path' || t === '-literalpath') { if (args[i + 1]) files.push(args[i + 1]!); i += 1; continue; }
      if (valued.has(t)) { i += 1; continue; }
      if (!t.startsWith('-')) files.push(args[i]!);
    }
    return { reads: files.flatMap((f) => filesOf(f, cwd)).map((path) => ({ path, extent })), commits: [], filter: KEEP, readsStdin: files.length === 0, outputAway: false };
  }
  if (n === 'select-object' || n === 'select') {
    const first = number(value(['-first']));
    const last = number(value(['-last']));
    const skip = number(value(['-skip']));
    const filter: Filter = first !== null ? { kind: 'lines', ranges: [[1, first]] } : last !== null ? { kind: 'last', count: last } : skip !== null ? { kind: 'from', line: skip + 1 } : SOME;
    return { reads: [], commits: [], filter, readsStdin: true, outputAway: false };
  }
  if (['out-string', 'out-host', 'format-table', 'ft', 'format-list', 'fl', 'oh', 'out-default'].includes(n)) return { reads: [], commits: [], filter: KEEP, readsStdin: true, outputAway: false };
  if (['select-string', 'sls', 'measure-object', 'measure', 'out-null', 'set-content', 'out-file', 'add-content'].includes(n)) return nothing(false, true);
  if (['where-object', 'where', '?', 'foreach-object', 'foreach', '%'].includes(n)) return { reads: [], commits: [], filter: SOME, readsStdin: true, outputAway: false };
  return null;
}

/** `git show <rev>:<path>`, `git cat-file -p <rev>:<path>`, `git show <commit>`, `git blame [-L a,b] <file>`. */
function gitStage(args: readonly Token[], cwd: string | null): Stage {
  let dir = cwd;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!.text;
    if (a === '-C') { const v = args[i + 1]; dir = v && !v.dynamic && !v.substitution && dir !== null ? toAbsolute(v.text, dir) : null; i += 1; continue; }
    if (/^-C./.test(a)) { dir = dir !== null ? toAbsolute(a.slice(2), dir) : null; continue; }
    if (a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') { i += 1; continue; }
    if (a.startsWith('-')) continue;
    break;
  }
  const sub = args[i]?.text ?? '';
  const rest = args.slice(i + 1);
  const reads: Intent[] = [];
  const commits: string[] = [];
  if (sub === 'show' || sub === 'cat-file') {
    for (const w of rest) {
      if (w.text === '--') break;
      if (w.text.startsWith('-') || w.dynamic || w.substitution) continue;
      const m = /^([^:]+):(.+)$/.exec(w.text);
      if (m && !/^[A-Za-z]:[\\/]/.test(w.text)) {
        if (dir === null) continue;
        const rel = m[2]!;
        const root = rel.startsWith('./') || rel.startsWith('../') ? dir : repoRootOf(dir);
        if (root) reads.push({ path: resolve(root, rel), rev: m[1]!, extent: WHOLE });
      } else if (sub === 'show' && /^[0-9a-f]{7,40}$/i.test(w.text)) commits.push(w.text.toLowerCase());
    }
  } else if (sub === 'blame') {
    let range: Range | null = null;
    const files: Token[] = [];
    for (let j = 0; j < rest.length; j++) {
      const t = rest[j]!.text;
      const spec = t === '-L' ? rest[++j]?.text ?? '' : /^-L./.test(t) ? t.slice(2) : null;
      if (spec !== null) {
        const m = /^(\d+),(\d+|\+\d+)?$/.exec(spec);
        range = m ? [Number(m[1]), m[2] === undefined ? null : m[2].startsWith('+') ? Number(m[1]) + Number(m[2].slice(1)) : Number(m[2])] : null;
        continue;
      }
      if (!t.startsWith('-')) files.push(rest[j]!);
    }
    const extent: Extent = range ? { kind: 'lines', ranges: [range] } : WHOLE;
    for (const f of files) for (const path of filesOf(f, dir)) reads.push({ path, extent });
  }
  return { reads, commits, filter: NONE, readsStdin: false, outputAway: false };
}

/** One simple command: its reads, its filter, its redirections; null when it is not a command (a loop header, `done`). */
function stageOf(words: readonly Token[], cwd: string | null, shell: 'bash' | 'powershell', depth: number): Stage | null {
  // Redirections first: their targets are not operands.
  const skip = new Set<Token>();
  let outputAway = false;
  let textInput = false;
  const stdinFiles: Token[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.kind !== 'op') continue;
    skip.add(w);
    const target = words[i + 1];
    if (target?.kind === 'word') skip.add(target);
    if (OUTPUT_REDIRECTS.has(w.text)) outputAway = true;
    else if (INPUT_REDIRECTS.has(w.text) && target?.kind === 'word') stdinFiles.push(target);
    else if (TEXT_INPUT.has(w.text)) textInput = true;
  }
  let argv = words.filter((w) => w.kind === 'word' && !skip.has(w));
  // Assignments, reserved words and wrappers lead into the command.
  for (;;) {
    const first = argv[0];
    if (!first) return null;
    if (/^[A-Za-z_]\w*=/.test(first.text)) { argv = argv.slice(1); continue; }
    const lead = commandName(first.text);
    if (LEADING.has(lead)) { argv = argv.slice(1); continue; }
    if (lead === 'env' || lead === 'timeout' || lead === 'nice') {
      let k = 1;
      while (argv[k] && (argv[k]!.text.startsWith('-') || /^[A-Za-z_]\w*=/.test(argv[k]!.text) || (lead !== 'env' && /^\d/.test(argv[k]!.text)))) k += 1;
      argv = argv.slice(k);
      continue;
    }
    break;
  }
  const name = commandName(argv[0]!.text).toLowerCase();
  const args = argv.slice(1);
  if (HEADERS.has(name)) return null;
  // What it reads on its standard input: a file behind `<` is read through its filter; text (`<<`) is no file.
  const finish = (stage: Stage): Stage => {
    const away = stage.outputAway || outputAway;
    if (textInput) return { ...stage, readsStdin: false, outputAway: away };
    if (!stdinFiles.length || !stage.readsStdin) return { ...stage, outputAway: away };
    const extent = through(WHOLE, stage.filter);
    const fromStdin = extent ? stdinFiles.flatMap((f) => filesOf(f, cwd)).map((path) => ({ path, extent })) : [];
    return { ...stage, reads: [...stage.reads, ...fromStdin], readsStdin: false, outputAway: away };
  };
  if (shell === 'powershell') {
    const ps = powerShellStage(name, args, cwd);
    if (ps) return finish(ps);
  }
  // A command that shows what it reads through `filter`, from its files or else from its standard input.
  const reading = (filter: Filter, files: readonly Token[]): Stage => {
    const named = files.filter((f) => f.text !== '-');
    const extent = through(WHOLE, filter);
    const reads = extent ? named.flatMap((f) => filesOf(f, cwd)).map((path) => ({ path, extent })) : [];
    return finish({ reads, commits: [], filter, readsStdin: named.length === 0 || files.some((f) => f.text === '-'), outputAway: false });
  };
  if (name === 'head' || name === 'tail') { const { filter, files } = headTail(name, args); return reading(filter, files); }
  if (name === 'sed' || name === 'gsed') { const s = sedOf(args); return s ? reading(s.filter, s.files) : nothing(true); }
  if (name === 'awk' || name === 'gawk' || name === 'mawk' || name === 'nawk') { const { filter, files } = awkOf(args); return reading(filter, files); }
  if (name === 'jq' || name === 'yq') {
    const ops = operandsOf(args, ['--arg', '--argjson', '--indent', '--slurpfile', '--rawfile']);
    const program = ops.shift();
    return reading(program?.text.trim() === '.' ? KEEP : SOME, ops);
  }
  if ((name === 'bat' || name === 'batcat') && args.some((a) => a.text === '-r' || a.text.startsWith('--line-range'))) return reading(SOME, operandsOf(args, [...VALUED.bat!, '-r', '--line-range']));
  if (name === 'tee') return finish({ reads: [], commits: [], filter: KEEP, readsStdin: true, outputAway: false });   // its files are copies it writes
  if (SHOWS_ALL.has(name)) return reading(KEEP, operandsOf(args, VALUED[name] ?? []));
  if (SHOWS_SOME.has(name)) return reading(SOME, operandsOf(args, VALUED[name] ?? []));
  if (name === 'git') return finish(gitStage(args, cwd));
  if (BASH_FAMILY.has(name)) {
    // `bash -c '…'`: the code is a command line of its own, read the same way; a script run is not a script read.
    const i = args.findIndex((a) => a.text === '-c');
    const code = i >= 0 ? args[i + 1] : undefined;
    if (code && !code.substitution && cwd !== null && depth < 3) {
      const inner = analyse(code.text, cwd, 'bash', depth + 1);
      return finish({ reads: inner.reads, commits: inner.commits, filter: NONE, readsStdin: false, outputAway: false });
    }
    return finish(nothing(false));
  }
  if (SHOWS_NONE_READS_INPUT.has(name)) return finish(nothing(false, true));
  // Anything else (`ls`, `find`, `echo`, `wc -l < f` aside, a command this does not know) shows nothing it read, and
  // what comes down the pipe to it stops there.
  return finish(nothing(false));
}

/** `2>&1`, `>&2`, `1>&-`: the boundary's tokeniser splits these at the `&`; they only join streams, so they are dropped. */
function dropStreamJoins(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const amp = tokens[i + 1];
    const fd = tokens[i + 2];
    if (t.kind === 'op' && ['>', '1>', '2>', '>>', '1>>', '2>>'].includes(t.text) && amp?.kind === 'op' && amp.text === '&' && fd?.kind === 'word' && /^(\d+|-)$/.test(fd.text)) { i += 2; continue; }
    out.push(t);
  }
  return out;
}

const narrows = (f: Filter): boolean => f.kind !== 'keep';

/** Every file and commit a command line shows the agent, pipeline by pipeline, following `cd` as the boundary does. */
function analyse(command: string, startCwd: string, shell: 'bash' | 'powershell', depth = 0): { reads: Intent[]; commits: string[] } {
  const tokens = dropStreamJoins(tokenize(extractHeredocs(command).stripped));
  const reads: Intent[] = [];
  const commits: string[] = [];
  const cwdStack: (string | null)[] = [startCwd];
  const top = () => cwdStack[cwdStack.length - 1]!;
  let pipeline: { words: Token[]; cwd: string | null }[] = [];
  let current: Token[] = [];
  const flushCommand = () => { if (current.length) { pipeline.push({ words: current, cwd: top() }); current = []; } };
  const flushPipeline = () => {
    flushCommand();
    const stages = pipeline.map((p) => stageOf(p.words, p.cwd, shell, depth));
    stages.forEach((stage, i) => {
      if (!stage) return;
      // What this stage shows reaches the agent through every stage after it — each has to read its standard input.
      const after = stages.slice(i + 1);
      const follow = (e: Extent | null): Extent | null => {
        let x = stage.outputAway ? null : e;
        for (const next of after) {
          if (!x) return null;
          if (!next || !next.readsStdin) return null;
          x = through(x, next.filter);
          if (next.outputAway) return null;
        }
        return x;
      };
      // Several files run into one stream and then cut: which of them the cut kept is not known line by line.
      const mixed = stage.reads.length > 1 && after.some((s) => s && narrows(s.filter));
      for (const r of stage.reads) { const extent = follow(r.extent); if (extent) reads.push({ ...r, extent: mixed ? PART : extent }); }
      for (const c of stage.commits) if (follow(WHOLE)) commits.push(c);
    });
    // `cd` alone moves the directory for what follows (in a pipeline it runs in a subshell of its own).
    if (pipeline.length === 1) {
      const words = pipeline[0]!.words.filter((w) => w.kind === 'word');
      const name = words[0] ? commandName(words[0].text).toLowerCase() : '';
      if (name === 'cd' || name === 'pushd' || name === 'set-location' || name === 'sl' || name === 'chdir') {
        const arg = words.slice(1).find((w) => !w.text.startsWith('-') || w.text === '-');
        const base = top();
        cwdStack[cwdStack.length - 1] = !arg || arg.text === '-' || arg.dynamic || arg.substitution || base === null ? null : toAbsolute(arg.text, base);
      } else if (name === 'popd') cwdStack[cwdStack.length - 1] = null;
    }
    pipeline = [];
  };
  for (const t of tokens) {
    if (t.kind === 'op' && (t.text === '|' || t.text === '|&')) { flushCommand(); continue; }
    if (t.kind === 'op' && t.text === '(') { flushPipeline(); cwdStack.push(top()); continue; }
    if (t.kind === 'op' && t.text === ')') { flushPipeline(); if (cwdStack.length > 1) cwdStack.pop(); continue; }
    if (t.kind === 'op' && [';', '&&', '||', '&', '\n', ';;'].includes(t.text)) { flushPipeline(); continue; }
    current.push(t);
  }
  flushPipeline();
  return { reads, commits };
}

/**
 * A file's length in lines as `sed` and `head` count them (a last line without a newline counts); null when unreadable, or
 * larger than `maxBytes`: it is read as the step ends, on the runtime's event loop, so a large log is not read for it (a range
 * of such a file then stays a range, read in part).
 */
export function lineCount(path: string, maxBytes = 16 * 1024 * 1024): number | null {
  try {
    if (statSync(path).size > maxBytes) return null;
    const buf = readFileSync(path);
    if (buf.length === 0) return 0;
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n += 1;
    return buf[buf.length - 1] === 10 ? n : n + 1;
  } catch { return null; }
}

/** Ranges put in order and joined where they touch or overlap. */
export function mergeRanges(ranges: readonly (readonly [number, number | null])[]): [number, number | null][] {
  const out: [number, number | null][] = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && (last[1] === null || a <= last[1] + 1)) { if (last[1] !== null) last[1] = b === null ? null : Math.max(last[1], b); }
    else out.push([a, b]);
  }
  return out;
}

/** Whether ranges cover a file from its first line to its end: one run from line 1 to the end, or past its known length. */
export function coversAll(ranges: readonly (readonly [number, number | null])[], total: number | null): boolean {
  const merged = mergeRanges(ranges);
  if (merged.length !== 1 || merged[0]![0] > 1) return false;
  const end = merged[0]![1];
  return end === null || (total !== null && end >= total);
}

/**
 * The reads of one file as the step records them: whole when a read shows all of it, or its ranges together cover it;
 * else its ranges with the file's length; else a part.
 */
function recordFile(path: string, extents: readonly Extent[], rev?: string): StepRead[] {
  const base = rev ? { path, rev } : { path };
  if (extents.some((e) => e.kind === 'whole')) return [base];
  // A version from the history has a length of its own, not the current file's.
  const total = !rev && extents.some((e) => e.kind === 'lines' || e.kind === 'last') ? lineCount(path) : null;
  const ranges: [number, number | null][] = [];
  for (const e of extents) {
    if (e.kind === 'lines') for (const [a, b] of e.ranges) ranges.push([Math.max(1, a), b]);
    else if (e.kind === 'last' && total !== null) ranges.push([Math.max(1, total - e.count + 1), total]);
  }
  if (!ranges.length) return [{ ...base, part: true }];
  if (coversAll(ranges, total)) return [base];
  return mergeRanges(ranges).map(([a, b]) => ({ ...base, from: a, ...(b === null ? {} : { to: total !== null ? Math.min(b, total) : b }), ...(total !== null ? { lines: total } : {}) }));
}

/** pi's shell cut its output to the tail: the agent saw only the end of what the command printed. */
const SHELL_OUTPUT_CUT = /\[Showing (?:lines \d+-\d+ of \d+|last [^\]]* of line \d+)[^\]]*Full output: [^\]]*\]/;

/** What a shell command showed the agent: the files (and versions) with how much of each, and the commits. */
export function shellReads(shell: 'bash' | 'powershell', command: string, cwd: string, output = ''): StepRead[] {
  const { reads, commits } = analyse(command, cwd, shell);
  const cut = SHELL_OUTPUT_CUT.test(output);
  const byFile = new Map<string, { path: string; rev?: string; extents: Extent[] }>();
  for (const r of reads) {
    const key = `${r.path}\0${r.rev ?? ''}`;
    const e = byFile.get(key) ?? { path: r.path, ...(r.rev ? { rev: r.rev } : {}), extents: [] };
    e.extents.push(cut ? PART : r.extent);
    byFile.set(key, e);
  }
  const out: StepRead[] = [];
  for (const f of byFile.values()) out.push(...recordFile(f.path, f.extents, f.rev));
  for (const c of new Set(commits)) out.push({ rev: c });
  return out;
}

/** The file tool's read: from its offset to where its notice says it stopped (pi cuts at 2000 lines or 50 KB), or the end. */
export function fileToolReads(args: Record<string, unknown>, text: string, cwd: string): StepRead[] {
  const given = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : null;
  if (!given) return [];
  if (/^\[Line \d+ is [^\]]*exceeds [^\]]*limit\. Use bash: /.test(text)) return [];   // nothing shown: one line too long
  const offset = typeof args.offset === 'number' && args.offset >= 1 ? Math.floor(args.offset) : 1;
  const tail = text.slice(-400);
  const showing = /\[Showing lines (\d+)-(\d+) of \d+[^\]]*\. Use offset=\d+ to continue\.\]\s*$/.exec(tail);
  const more = /\[\d+ more lines in file\. Use offset=(\d+) to continue\.\]\s*$/.exec(tail);
  const from = showing ? Number(showing[1]) : offset;
  const to = showing ? Number(showing[2]) : more ? Number(more[1]) - 1 : null;
  return recordFile(toAbsolute(given, cwd), [from <= 1 && to === null ? WHOLE : { kind: 'lines', ranges: [[from, to]] }]);
}

/**
 * The ledger's document read: the version it showed (the current one is the file as it stands; another is the history,
 * with its commit) and its lines. Its result is the version's fields as JSON, read field by field so a result cut short
 * still says what it showed.
 */
export function ledgerDocReads(text: string, repoRoot: (repo: string) => string | null): StepRead[] {
  if (/^ERROR:/.test(text)) return [];
  const head = text.slice(0, 4000);
  const field = (name: string): string | null => new RegExp(`"${name}":\\s*("(?:[^"\\\\]|\\\\.)*"|true|false|\\d+)`).exec(head)?.[1] ?? null;
  const str = (name: string): string | null => { const v = field(name); try { return v?.startsWith('"') ? JSON.parse(v) as string : null; } catch { return null; } };
  const num = (name: string): number | null => { const v = field(name); return v !== null && /^\d+$/.test(v) ? Number(v) : null; };
  const repo = str('repo');
  const rel = str('path');
  const root = repo ? repoRoot(repo) : null;
  if (!root || !rel) return [];
  const path = join(root, ...rel.split('/'));
  const base = field('current') === 'true' ? { path } : { path, rev: str('commit') ?? '' };
  const from = num('fromLine') ?? 1;
  if (from <= 1 && field('nextFromLine') === null) return [base];
  const to = num('toLine');
  const total = num('lines');
  return [{ ...base, from, ...(to !== null ? { to } : {}), ...(total !== null ? { lines: total } : {}) }];
}

/** The ledger's one-commit read: the commit, by the full hash it answered with (or else the one asked for). */
export function ledgerCommitReads(args: Record<string, unknown>, text: string): StepRead[] {
  if (/^ERROR:/.test(text)) return [];
  const full = /"hash":\s*"([0-9a-f]{7,40})"/.exec(text.slice(0, 2000))?.[1];
  const asked = typeof args.hash === 'string' ? args.hash.trim().replace(/^commit:/, '').toLowerCase() : '';
  const hash = full ?? (/^[0-9a-f]{7,40}$/.test(asked) ? asked : '');
  return hash ? [{ rev: hash }] : [];
}

/**
 * The ledger's session read (`pk_ledger_sessions` with a session): the session, by the ledger's id, and the positions of
 * the messages it showed (the ledger's message index plus one) — out of how many there are when the page was taken by
 * offset, since then its total is the session's. A page taken by speaker shows some of the messages, not a run of them.
 * The result is read for its row indexes, so a page cut at the tool's size limit still says what reached the agent. A
 * list of sessions (no session asked for) reads none of them.
 */
export function ledgerSessionReads(args: Record<string, unknown>, text: string): StepRead[] {
  if (/^ERROR:/.test(text) || typeof args.session !== 'string' || !args.session.trim()) return [];
  const session = /"session":\s*\{\s*"id":\s*"(session:[^"]+)"/.exec(text.slice(0, 2000))?.[1] ?? /"session":\s*"(session:[^"]+)"/.exec(text)?.[1];
  if (!session) return [];
  const speaker = typeof args.speaker === 'string' && args.speaker.trim() !== '';
  const indexes = [...text.matchAll(/"index":\s*(\d+)/g)].map((m) => Number(m[1]));
  if (!indexes.length) return [];
  if (speaker) return [{ session, part: true }];
  const from = Math.min(...indexes) + 1;
  const to = Math.max(...indexes) + 1;
  const byIndex = typeof args.fromIndex === 'number' || (typeof args.fromIndex === 'string' && args.fromIndex.trim() !== '');
  const total = /"total":\s*(\d+)/.exec(text)?.[1];
  return [{ session, from, to, ...(!byIndex && total !== undefined ? { lines: Number(total) } : {}) }];
}

/** Where a step's reads are resolved: the directory the tools run in, and the ledger's repositories by id. */
export interface StepReadContext {
  readonly cwd: string;
  readonly repoRoot?: (repo: string) => string | null;
}

/**
 * The tools whose reads are recorded; the others read nothing a coverage counts this way (`pk_read_source` counts by its
 * target). A session read through the ledger is recorded by the session (`StepRead.session`).
 */
export const READING_TOOLS: ReadonlySet<string> = new Set(['read', 'bash', 'powershell', 'pk_ledger_doc_read', 'pk_ledger_commit', 'pk_ledger_sessions']);

/**
 * What a step read, from its call and its result (`JobStep.reads`); null for a tool not in `READING_TOOLS`. A failed call
 * read nothing — except a shell command that ran and exited non-zero, whose output the agent saw all the same.
 */
export function stepReads(tool: string, args: Record<string, unknown> | null | undefined, text: string, isError: boolean, ctx: StepReadContext): StepRead[] | null {
  if (!READING_TOOLS.has(tool)) return null;
  const a = args ?? {};
  try {
    if (tool === 'bash' || tool === 'powershell') {
      const ran = !isError || /Command exited with code \d+\s*$/.test(text);
      const command = typeof a.command === 'string' ? a.command : '';
      return ran && command ? shellReads(tool, command, ctx.cwd, text) : [];
    }
    if (isError) return [];
    if (tool === 'read') return fileToolReads(a, text, ctx.cwd);
    if (tool === 'pk_ledger_doc_read') return ctx.repoRoot ? ledgerDocReads(text, ctx.repoRoot) : [];
    if (tool === 'pk_ledger_commit') return ledgerCommitReads(a, text);
    if (tool === 'pk_ledger_sessions') return ledgerSessionReads(a, text);
  } catch { /* what a step read is evidence; a call it cannot make out records nothing rather than failing the job */ }
  return [];
}
