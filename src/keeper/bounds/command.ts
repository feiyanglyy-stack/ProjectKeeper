/**
 * Shell-command read and write preflight (Spec §3.1; CKC-03 AC-23; CKC-26 AC-8). Before a
 * command runs it is parsed with a real tokeniser; file reads are checked against the read
 * boundary and obvious project writes are refused. This is a guardrail against a wandering
 * agent drifting out of the project, not an adversarial sandbox: what a command reads at runtime,
 * once the guardrail has let it start, is beyond it — see the report.
 *
 * A place whose path cannot be worked out before the command runs — a variable in a path position,
 * a command substitution, code piped into an interpreter, `eval` — is refused with advice to write
 * the explicit path, rather than passed through unchecked. A `cd` target is itself a read location
 * (later argument-less commands read the new directory), so a `cd` out of the project is refused.
 * Scripts a command runs or sources, and here-document bodies, are read and scanned too. Runtime
 * writes are checked and undone by shell-write-guard.ts. The tokeniser is shared with reads.ts,
 * which works out, after a command ran, what it showed the agent of each file (Spec §1.11).
 *
 * The check also names the places a command says it writes — its redirection targets, the value of
 * an output option (`--output FILE`, `sort -o FILE`), and the operands of the commands that write
 * theirs (tee, cp and mv, rm, touch, mkdir, rmdir, truncate, sed -i) — through `onWrite`. That
 * never changes a decision; on a live project the write guard undoes only those (BQ).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { sep } from 'node:path';
import { canonicalKey, toAbsolute, type Boundary } from './paths.ts';

export interface CommandDecision {
  readonly ok: boolean;
  /** The refusal message for the model, or null when allowed. */
  readonly reason: string | null;
  /** The path or construct the refusal is about, for the step record. */
  readonly detail: string | null;
}

export type TokKind = 'word' | 'op';
export interface Token {
  readonly kind: TokKind;
  readonly text: string;
  /** A word that contains an expansion whose value is not known before the command runs. */
  readonly dynamic: boolean;
  /** A word that contains a command substitution `$(...)` / backtick, or process substitution. */
  readonly substitution: boolean;
}

const CONTROL_OPS = new Set([';', '&&', '||', '|', '|&', '&', '\n']);
const SEPARATORS = new Set([';', '&&', '||', '|', '|&', '&', '\n', '(', ')', ';;']);
const REDIRECTS = new Set(['<', '>', '>>', '<<', '<<<', '<<-', '&>', '&>>', '2>', '2>>', '1>', '1>>', '0<']);
/** The working directory can no longer be followed (`cd -`, `popd`); any later argument-less or relative read is refused. */
const CWD_UNTRACKABLE = 'PK_CWD_UNTRACKABLE';
const MAX_SCAN_DEPTH = 3;
const MAX_SCAN_BYTES = 512_000;

/**
 * The system whose shell a command runs in, where reading a command depends on it: how an absolute path is written in
 * free text, which tools the system has. Everything else is read the same everywhere.
 */
interface CommandSystem {
  readonly platform: NodeJS.Platform;
  /** Whether a name exists at the file system's root (`/etc`, `/Users`): what makes `/name/…` in free text a path. */
  readonly atRoot: (name: string) => boolean;
}
const rootNames = new Map<string, boolean>();
const THIS_SYSTEM: CommandSystem = {
  platform: process.platform,
  atRoot: (name) => {
    let there = rootNames.get(name);
    if (there === undefined) { there = existsSync(`/${name}`); rootNames.set(name, there); }
    return there;
  },
};
let system: CommandSystem = THIS_SYSTEM;

/**
 * For tests: read commands as `platform` reads them, with `names` the names at the file system's root, until the
 * function returned is called. Paths are still resolved by the system the test runs on.
 */
export function readCommandsAs(platform: NodeJS.Platform, names: readonly string[] = []): () => void {
  const before = system;
  system = { platform, atRoot: (name) => names.includes(name) };
  return () => { system = before; };
}

/** Split off here-document bodies so command structure tokenises cleanly, but keep the bodies to scan for paths. */
export function extractHeredocs(command: string): { stripped: string; bodies: string[] } {
  const lines = command.split('\n');
  const out: string[] = [];
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    out.push(line);
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (m) {
      const delim = m[2]!;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() !== delim) { body.push(lines[j]!); j += 1; }
      bodies.push(body.join('\n'));
      i = j;                                                  // skip the body and the closing delimiter
    }
  }
  return { stripped: out.join('\n'), bodies };
}

/**
 * Tokenise a bash-family command line, tracking quoting, escapes, expansions and substitutions. `literalBackslash`: the
 * line is PowerShell's or cmd's, where a backslash escapes nothing and is the separator of a path — read as bash reads
 * it, `C:\Users\someone` lost its backslashes and was no path to the checks that follow.
 */
export function tokenize(command: string, literalBackslash = false): Token[] {
  const tokens: Token[] = [];
  let buf = '';
  let has = false;
  let dynamic = false;
  let substitution = false;
  const flush = () => {
    if (has) tokens.push({ kind: 'word', text: buf, dynamic, substitution });
    buf = ''; has = false; dynamic = false; substitution = false;
  };
  const op = (text: string) => { flush(); tokens.push({ kind: 'op', text, dynamic: false, substitution: false }); };
  const s = command;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'") {                                          // single quotes: literal, no expansion
      has = true;
      const end = s.indexOf("'", i + 1);
      if (end < 0) { buf += s.slice(i + 1); i = s.length; } else { buf += s.slice(i + 1, end); i = end + 1; }
      continue;
    }
    if (c === '"') {                                          // double quotes: only $ ` " \ newline are escaped; other backslashes are literal
      has = true;
      i += 1;
      while (i < s.length && s[i] !== '"') {
        if (!literalBackslash && s[i] === '\\' && '$`"\\\n'.includes(s[i + 1] ?? '')) { buf += s[i + 1]; i += 2; continue; }
        if (s[i] === '`') { substitution = true; buf += s[i]; i += 1; continue; }
        if (s[i] === '$' && s[i + 1] === '(') { substitution = true; buf += s[i]; i += 1; continue; }
        if (s[i] === '$') { dynamic = true; buf += s[i]; i += 1; continue; }
        buf += s[i]; i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '\\' && !literalBackslash) { has = true; if (i + 1 < s.length) { buf += s[i + 1]; i += 2; } else i += 1; continue; }
    if (c === '`') { has = true; substitution = true; buf += c; i += 1; continue; }
    if (c === '$' && s[i + 1] === '(') { has = true; substitution = true; buf += c; i += 1; continue; }
    if (c === '$' && s[i + 1] === '{') { has = true; dynamic = true; buf += c; i += 1; continue; }
    if (c === '$' && /[A-Za-z_]/.test(s[i + 1] ?? '')) { has = true; dynamic = true; buf += c; i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i += 1; continue; }
    if (c === '\n') { op('\n'); i += 1; continue; }
    if (c === '(' || c === ')') { op(c); i += 1; continue; }
    // Operators, longest match first.
    let matched = '';
    for (const cand of ['<<-', '<<<', '&>>', '>>', '<<', '&>', '2>>', '2>', '1>>', '1>', '0<', '&&', '||', '|&', ';;', ';', '|', '&', '<', '>']) {
      if (s.startsWith(cand, i)) { matched = cand; break; }
    }
    if (matched) { op(matched); i += matched.length; continue; }
    has = true; buf += c; i += 1;
  }
  flush();
  return tokens;
}

export type Node = { readonly kind: 'cmd'; readonly words: Token[] } | { readonly kind: 'op'; readonly op: string };

/** Group tokens into commands and the separators between them; redirection operators stay inside their command. */
export function toNodes(tokens: readonly Token[]): Node[] {
  const nodes: Node[] = [];
  let cur: Token[] = [];
  const flush = () => { if (cur.length) { nodes.push({ kind: 'cmd', words: cur }); cur = []; } };
  for (const t of tokens) {
    if (t.kind === 'op' && SEPARATORS.has(t.text)) { flush(); nodes.push({ kind: 'op', op: t.text }); }
    else cur.push(t);
  }
  flush();
  return nodes;
}

const HOW_TO_STAY_IN_BOUNDS =
  'Read only this project: its own scope, its ProjectKeeper assets, the toolchain its config points at, and the session files that belong to it. '
  + 'To find which of your own records cite a source or an id, use pk_find_references / pk_read_assets — do not look in the file system. '
  + 'Do not read other projects, other ProjectKeeper assets, or credential stores.';

const outOfBounds = (path: string, reason: string): CommandDecision => ({ ok: false, reason, detail: path });
const undeterminable = (what: string): CommandDecision => ({
  ok: false,
  detail: what,
  reason: `Refused: this command reads through ${what}, which cannot be checked before it runs. Write the explicit path you mean. ${HOW_TO_STAY_IN_BOUNDS}`,
});
const refuse = (what: string, why: string): CommandDecision => ({ ok: false, detail: what, reason: `Refused: ${why} ${HOW_TO_STAY_IN_BOUNDS}` });
const OK: CommandDecision = { ok: true, reason: null, detail: null };
/** A sentinel meaning "handled, allowed" so callers can tell it from "not handled". */
const OKnull: CommandDecision = OK;

/** A `~`, `~/…` or `~user…` reference: the shell expands it to a home directory, outside the project. */
function isHomeReference(text: string): boolean {
  return /^~($|[\\/]|[^/\\])/.test(text);
}
/** A `~user` / `~user/…` reference: another user's home, which `boundary.decide` cannot resolve (pi leaves ~user literal). */
function isOtherUserHome(text: string): boolean {
  return /^~[^/\\]/.test(text);
}

/** Does the token look like a filesystem path (rather than a plain word, flag or pattern)? */
function looksLikePath(text: string): boolean {
  if (!text) return false;
  if (/^\\(?:n|r|t|0)$/.test(text)) return false;            // an escape sequence (for example a newline), not a file
  if (text.startsWith('-')) return false;
  if (isHomeReference(text)) return true;                     // home or another user's home
  if (/^\/(?![/])/.test(text)) return true;                   // POSIX absolute or MSYS /c/...
  if (/^[A-Za-z]:[\\/]/.test(text)) return true;              // Windows drive
  if (text.startsWith('\\\\')) return true;                   // UNC
  if (text === '..' || text === '.' || text.startsWith('./') || text.startsWith('../') || text.startsWith('..\\') || text.startsWith('.\\')) return true;
  if (text.includes('/') || text.includes('\\')) return true; // any relative path with a separator
  return false;
}

/**
 * What the value of an option of awk, sed or the grep family is: a file the command reads (`file`), the file that holds
 * its program or its patterns (`program-file`), the program or a pattern itself (`program`), other text that is no path
 * (a field separator, a glob, a type name: `text`), or a count (`count`: its value is the next word only when that word
 * is a number, since some implementations take the count attached or not at all).
 */
type ValueKind = 'file' | 'program-file' | 'program' | 'text' | 'count';
interface ProgramCommand {
  /** Short options that take a value — attached (`-fprog.awk`) or the next word — and what the value is. */
  readonly short: Readonly<Record<string, ValueKind>>;
  /** Short options whose value, when there is one, is only ever attached (`sed -i.bak`, `gawk -dvars`): the rest of the word. */
  readonly attachedOnly?: string;
  /** Long options that take a value (`--file=x` or `--file x`), and what it is. */
  readonly long: Readonly<Record<string, ValueKind>>;
  /** Options after which no operand is a pattern, so every operand is a file (`rg --files`, `ack -f`). */
  readonly noProgram?: readonly string[];
  /** Operands of the form `name=value` set a variable (awk) and are not files. */
  readonly assignments?: boolean;
}
/**
 * awk, sed and the grep family take a program or a pattern as their first operand — unless an option gives it — and
 * read the files named by the operands after it. The options that take a value are listed so the operands are counted
 * right; an option listed here that another implementation reads as taking no value could hide a file behind it, so
 * only options that take a value wherever they exist are listed, and the others are read as taking none.
 */
// -W is not listed: in mawk `-W exec FILE` makes the word after it the program file, which must stay checked.
const AWK: ProgramCommand = {
  short: { f: 'program-file', E: 'program-file', e: 'program', i: 'file', l: 'file', F: 'text', v: 'text' },
  attachedOnly: 'dDLop',
  long: { '--file': 'program-file', '--exec': 'program-file', '--source': 'program', '--include': 'file', '--load': 'file', '--field-separator': 'text', '--assign': 'text' },
  assignments: true,
};
const SED: ProgramCommand = {
  short: { e: 'program', f: 'program-file' },
  attachedOnly: 'i',
  long: { '--expression': 'program', '--file': 'program-file', '--line-length': 'text' },
};
const GREP: ProgramCommand = {
  short: { e: 'program', f: 'program-file', m: 'count', A: 'count', B: 'count', C: 'count', d: 'text', D: 'text' },
  long: {
    '--regexp': 'program', '--file': 'program-file', '--exclude-from': 'file', '--max-count': 'count', '--after-context': 'count', '--before-context': 'count',
    '--devices': 'text', '--directories': 'text', '--exclude': 'text', '--include': 'text', '--exclude-dir': 'text', '--binary-files': 'text', '--label': 'text', '--group-separator': 'text',
  },
};
const RG: ProgramCommand = {
  short: { e: 'program', f: 'program-file', g: 'text', t: 'text', T: 'text', r: 'text', E: 'text', A: 'count', B: 'count', C: 'count', m: 'count', M: 'count', j: 'count', d: 'count' },
  long: {
    '--regexp': 'program', '--file': 'program-file', '--ignore-file': 'file', '--pre': 'file', '--hostname-bin': 'file',
    '--glob': 'text', '--iglob': 'text', '--type': 'text', '--type-not': 'text', '--type-add': 'text', '--type-clear': 'text', '--replace': 'text', '--encoding': 'text',
    '--engine': 'text', '--color': 'text', '--colors': 'text', '--context-separator': 'text', '--field-context-separator': 'text', '--field-match-separator': 'text',
    '--path-separator': 'text', '--pre-glob': 'text', '--sort': 'text', '--sortr': 'text', '--hyperlink-format': 'text', '--generate': 'text', '--max-filesize': 'text',
    '--dfa-size-limit': 'text', '--regex-size-limit': 'text', '--after-context': 'count', '--before-context': 'count', '--context': 'count', '--max-count': 'count',
    '--max-columns': 'count', '--threads': 'count', '--max-depth': 'count',
  },
  noProgram: ['--files', '--type-list', '--generate'],
};
const AG: ProgramCommand = {
  short: { g: 'program', G: 'text', p: 'file', m: 'count', A: 'count', B: 'count', C: 'count', W: 'count' },
  long: {
    '--path-to-ignore': 'file', '--pager': 'file', '--file-search-regex': 'text', '--ignore': 'text', '--ignore-dir': 'text', '--color-line-number': 'text',
    '--color-match': 'text', '--color-path': 'text', '--depth': 'count', '--max-count': 'count', '--after': 'count', '--before': 'count', '--context': 'count', '--width': 'count',
  },
  noProgram: ['--list-file-types'],
};
const ACK: ProgramCommand = {
  short: { g: 'program', t: 'text', m: 'count', A: 'count', B: 'count', C: 'count' },
  long: {
    '--match': 'program', '--files-from': 'file', '--ackrc': 'file', '--pager': 'file', '--type': 'text', '--ignore-dir': 'text', '--noignore-dir': 'text',
    '--ignore-file': 'text', '--type-add': 'text', '--type-set': 'text', '--type-del': 'text', '--output': 'text', '--range-start': 'text', '--range-end': 'text',
    '--max-count': 'count', '--after-context': 'count', '--before-context': 'count', '--context': 'count',
  },
  noProgram: ['-f'],
};
const PROGRAM_COMMANDS: Readonly<Record<string, ProgramCommand>> = {
  awk: AWK, gawk: AWK, mawk: AWK, nawk: AWK, sed: SED, gsed: SED, grep: GREP, egrep: GREP, fgrep: GREP, rg: RG, ag: AG, ack: ACK,
};
/** Commands that read files or the current directory; after `cd -` / `popd` their target can no longer be placed. */
const BASH_FAMILY = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const INTERPRETERS: Record<string, { flags: string[]; bash: boolean }> = {
  python: { flags: ['-c'], bash: false }, python2: { flags: ['-c'], bash: false }, python3: { flags: ['-c'], bash: false },
  node: { flags: ['-e', '--eval', '-p', '--print'], bash: false }, nodejs: { flags: ['-e', '--eval'], bash: false }, deno: { flags: ['eval'], bash: false },
  bash: { flags: ['-c'], bash: true }, sh: { flags: ['-c'], bash: true }, zsh: { flags: ['-c'], bash: true }, dash: { flags: ['-c'], bash: true }, ksh: { flags: ['-c'], bash: true },
  perl: { flags: ['-e', '-E'], bash: false }, ruby: { flags: ['-e'], bash: false },
  pwsh: { flags: ['-Command', '-c', '-EncodedCommand'], bash: false }, powershell: { flags: ['-Command', '-c', '-EncodedCommand'], bash: false },
};
// Flags whose value names a file/directory that is read (output flags are writes and are left alone, Spec §3.1, D31).
const PATH_VALUE_FLAGS = new Set(['--directory', '--git-dir', '--work-tree', '-f', '--file', '-I', '--include']);
// Environment variables whose value is a path the command reads (checked even when the value is relative).
const PATH_ENV = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_OBJECT_DIRECTORY', 'GIT_INDEX_FILE', 'CDPATH', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']);
const GIT_MUTATORS = new Set(['add', 'am', 'apply', 'bisect', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit', 'fetch', 'gc', 'imap-send', 'init', 'maintenance', 'merge', 'mv', 'pull', 'push', 'rebase', 'repack', 'reset', 'restore', 'revert', 'rm', 'send-email', 'stash', 'switch', 'update-index']);
/** An option whose value is a file or directory the command writes, whatever the command (`--output`, `--outfile`, `--outDir` …). */
const OUTPUT_OPTION = /^--(?:output|out)(?:[-_]?(?:file|document|dir|directory))?$/i;
/** The short option that names the output file of these commands (`sort -o FILE`, `curl -o FILE`, `wget -O FILE`). */
const OUTPUT_SHORT: Readonly<Record<string, string>> = {
  sort: '-o', curl: '-o', gcc: '-o', 'g++': '-o', cc: '-o', 'c++': '-o', clang: '-o', 'clang++': '-o', go: '-o', rustc: '-o', pandoc: '-o', wget: '-O',
};
/** Flags that make a command follow symbolic links out of the tree; refused in favour of the non-following form. */
const FOLLOW_LINK: Record<string, RegExp> = {
  grep: /^--dereference-recursive$|^-[A-Za-qs-z]*R[A-Za-z]*$/, egrep: /^--dereference-recursive$|^-[A-Za-qs-z]*R[A-Za-z]*$/, fgrep: /^--dereference-recursive$|^-[A-Za-qs-z]*R[A-Za-z]*$/,
  rg: /^(--follow|-L)$/, find: /^(-L|-follow|--follow)$/, ls: /^(-L|--dereference)$/,
  cp: /^(-L|--dereference|-H)$/, tar: /^(-h|--dereference)$/, rsync: /^(-L|--copy-links|--copy-unsafe-links|-k|--copy-dirlinks)$/,
};
/**
 * The same for the tools macOS has (BSD's), beside the ones above: its grep follows every link under `-S` (its `-R`
 * alone does not), its tar under `-L`. An `S` after an option that takes a value (`-eSecret`) is the value's.
 */
const BSD_GREP_S = /^-(?![A-Za-z]*[efmABCdD][A-Za-z]*S)[A-Za-z]*S[A-Za-z]*$/;
const FOLLOW_LINK_BSD: Record<string, RegExp> = { grep: BSD_GREP_S, egrep: BSD_GREP_S, fgrep: BSD_GREP_S, tar: /^-[A-Za-z]*L[A-Za-z]*$/ };

/**
 * Commands only macOS has that reach outside the project without naming a path the check could see: AppleScript and
 * the clipboard. Each is refused with why. Spotlight's search (`mdfind`) covers the whole machine unless it is kept to
 * a directory, which is then checked like any other operand. (The keychain's logins are refused with the other
 * programs that print a stored login, on every system: `LOGIN_PRINTERS`.)
 */
const MAC_REACHES_OUTSIDE: Readonly<Record<string, string>> = {
  osascript: 'osascript runs AppleScript, which can read any file and drive any application; what it will do cannot be checked before it runs.',
  pbpaste: 'pbpaste reads the clipboard, which is not part of the project.',
};

/** Base command name without a path or extension (…/usr/bin/python3 → python3). */
export function commandName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

/** Home-derived path constructs in inline interpreter code, which resolve to a home directory at runtime. */
function homeDerivedInCode(code: string): boolean {
  return /Path\.home\s*\(|expanduser|os\.environ|getenv|environ\.get|process\.env|homedir\s*\(|%USERPROFILE%|%HOMEPATH%|%APPDATA%|\$env:(USERPROFILE|HOME|APPDATA|HOMEPATH)|\$HOME\b|~\//i.test(code);
}

/** A token that expands, in the shell, to a home directory through an environment variable. */
function isEnvHomeReference(text: string): boolean {
  return /%(USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH|HOMEDRIVE|HOME)%/i.test(text) || /\$env:(USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH|HOME)/i.test(text);
}

/** Resolve a token's path against the running directory and check it against the boundary (with the home guards). */
function checkPath(text: string, cwd: string, boundary: Boundary): CommandDecision | null {
  if (isOtherUserHome(text)) return outOfBounds(text, `Out of the project's read boundary: ${text} is another user's home directory. ${HOW_TO_STAY_IN_BOUNDS}`);
  if (isEnvHomeReference(text)) return outOfBounds(text, `Out of the project's read boundary: ${text} points at a home directory through an environment variable. ${HOW_TO_STAY_IN_BOUNDS}`);
  const d = boundary.decide(text, cwd);
  return d.ok ? null : outOfBounds(text, d.reason ?? 'out of bounds');
}

/** Device files every program may name: reading them shows nothing of the machine. */
const HARMLESS_DEVICE = /^\/dev\/(?:null|zero|stdin|stdout|stderr|tty|u?random|fd\/\d+)$/;

/**
 * The absolute paths free text names on a system whose paths start at `/` (macOS, Linux): a `/` that starts a word —
 * not one inside a relative path, a URL, a variable's expansion or a glob — followed by a first name that exists at the
 * file system's root (`atRoot`), so `/etc/passwd`, `/Users/sam/x` and `/tmp/out` are paths and `/api/users` or the
 * expression `/^## Plan/` are text. A `file:///…` address is one too. Left out: the interpreter line a script starts
 * with (`#!/usr/bin/env python3`) and the device files every program may name.
 */
export function posixAbsolutePaths(text: string, atRoot: (name: string) => boolean): string[] {
  const out: string[] = [];
  // A path ends at white space, a quote, or a character that separates things on a command line or in a list.
  for (const m of text.replace(/^#![^\n]*/, '').matchAll(/file:\/\/\/[^\s'"`]*|(?<![\w.~})\]$*?\\/])\/(?![/\s])[^\s'"`;|&<>(),:]*/g)) {
    if (m[0].startsWith('file:')) { out.push(m[0]); continue; }
    const path = m[0].replace(/[.\]}]+$/, '');
    const first = /^\/([^/]+)/.exec(path)?.[1];
    if (first === undefined || HARMLESS_DEVICE.test(path) || !atRoot(first)) continue;
    out.push(path);
  }
  return out;
}

/**
 * A home directory named in free text: a `~` where a shell would make one of it, at the start of a word — after white
 * space, a quote, `=` or `:` — up to the separator that follows. A `~` inside a name is the name's own: the short name
 * Windows gives a long one (`LONGNA~1`), a backup's `draft~old`. Taken for a home wherever it stood, `build~1/notes.txt`
 * or a path with a space before its short name was refused as "another user's home directory".
 */
const HOME_IN_TEXT = '(?<![\\w.~/\\\\$})\\]*?@%+,#-])~[^\\s\'"`]*';

/**
 * Scan free text (a here-document body, a script that is not shell) for absolute or home path references, as the
 * system the command runs on writes them: on Windows a drive path, Git Bash's `/c/…` for one, a network path; on macOS
 * and Linux a path from `/`. (Read with the Windows expression alone, `/etc/passwd` or `/Users/sam/…` in a script was
 * no path at all, and one directory name of a single letter anywhere in a path made the rest of it one.)
 */
function scanTextForPaths(text: string, cwd: string, boundary: Boundary): CommandDecision | null {
  const named = system.platform === 'win32'
    ? [...text.matchAll(new RegExp(`(?:\\/(?:mnt\\/|cygdrive\\/)?[A-Za-z]\\/[^\\s'"\`]*|[A-Za-z]:[\\\\/][^\\s'"\`]*|\\\\\\\\[^\\s'"\`]+|${HOME_IN_TEXT}[\\\\/][^\\s'"\`]*)`, 'g'))].map((m) => m[0])
    : [...[...text.matchAll(new RegExp(`${HOME_IN_TEXT}\\/[^\\s'"\`]*`, 'g'))].map((m) => m[0]), ...posixAbsolutePaths(text, system.atRoot)];
  for (const path of named) {
    const d = checkPath(path, cwd, boundary);
    if (d) return d;
  }
  return null;
}

/** Read a script a command runs or sources and check the paths inside it (it may sit in the project but read outside). */
function scanScriptFile(scriptToken: Token, cwd: string, boundary: Boundary, depth: number, writeRoots: readonly string[], scratchDir?: string, onWrite?: WriteSink): CommandDecision | null {
  if (scriptToken.substitution || scriptToken.dynamic) return undeterminable('a computed script path');
  const bad = checkPath(scriptToken.text, cwd, boundary);
  if (bad) return bad;                                        // the script itself is out of bounds
  if (depth >= MAX_SCAN_DEPTH) return undeterminable('a script nested beyond the inspection limit');
  const abs = toAbsolute(scriptToken.text, cwd);
  let content = '';
  try {
    if (statSync(abs).size > MAX_SCAN_BYTES) return undeterminable('a script too large to inspect');
    content = readFileSync(abs, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; // a glob, or a script the shell will find missing
    return undeterminable('a script that cannot be inspected before execution');
  }
  const shellLike = /\.(sh|bash|zsh|ksh)$/i.test(scriptToken.text) || !/\.[A-Za-z0-9]+$/.test(scriptToken.text);
  if (!shellLike) return CREDENTIAL_IN_CODE.test(content) ? CREDENTIAL_REFUSAL : scanTextForPaths(content, cwd, boundary);
  const r = checkBashCommand(content, cwd, boundary, depth + 1, writeRoots, scratchDir, onWrite);
  return r.ok ? null : r;
}

/**
 * Git's credential commands hand out or change the logins stored on this machine: `git credential fill` prints the
 * password or token the user's credential helper keeps for a host. Nothing that reads a project needs them, so they
 * are refused in every spelling: `git credential …` after any of git's own options, a helper as a subcommand
 * (`git credential-manager`) or as its own program (`git-credential-manager`), and an alias made on the spot, which
 * could name either. Every word of a command is looked at, not only the first, so a program put in front that runs
 * the rest (`env`, `command`, `xargs`, `timeout`, `find -exec`) changes nothing; the commands that only print or
 * search text keep their words. A subcommand the shell computes cannot be told from `credential` and is refused too.
 */
const CREDENTIAL_REFUSAL: CommandDecision = {
  ok: false, detail: 'git credential',
  reason: "Refused: this command hands out or changes the logins stored on this machine (git credential, or one of git's credential helpers). Nothing that reads a project needs it.",
};
/** The same commands named in code given to an interpreter, or in a script that is not a shell's: a text match, no more. */
const CREDENTIAL_IN_CODE = /\bgit(?:\.exe)?\b[^A-Za-z0-9\n]{1,12}credential|\bgit-credential\b/i;
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);

function credentialCommand(argv: readonly Token[]): CommandDecision | null {
  const first = commandName(argv[0]!.text).toLowerCase();
  const end = PROGRAM_COMMANDS[first] || first === 'echo' || first === 'printf' ? 1 : argv.length;
  for (let i = 0; i < end; i += 1) {
    if (argv[i]!.kind !== 'word') continue;
    const name = commandName(argv[i]!.text).toLowerCase();
    if (/^git-credential(?:-[\w-]+)?$/.test(name)) return CREDENTIAL_REFUSAL;
    if (name !== 'git') continue;
    for (let j = i + 1; j < argv.length && argv[j]!.kind === 'word'; j += 1) {
      const word = argv[j]!;
      const alias = word.text === '-c' || word.text === '--config-env' ? argv[j + 1]?.text ?? '' : /^--config-env=(.*)$/.exec(word.text)?.[1] ?? '';
      if (/^alias\./i.test(alias)) return CREDENTIAL_REFUSAL;
      if (GIT_OPTIONS_WITH_VALUE.has(word.text)) { j += 1; continue; }
      if (word.text.startsWith('-')) continue;
      if (word.dynamic || word.substitution) return undeterminable('a computed git subcommand');
      if (/^credential(?:-|$)/i.test(word.text)) return CREDENTIAL_REFUSAL;
      break;
    }
  }
  return null;
}

/**
 * Git's trace switches, and its credential manager's, set for a command — before it (`GIT_TRACE_CURL=1 git …`), through
 * `env`, `export` or `declare`, or as PowerShell's `$env:…`. They print what git sends to a remote, and with
 * `GIT_TRACE_REDACT=0` the authorization header as it is. The shell's environment is given none of them (boundary.ts
 * `shellEnv`); this keeps a command from setting one for itself. The commands that only print or search text keep
 * their words, as above.
 */
const TRACE_SWITCH = /(?:^|[^A-Za-z0-9_])(?:GIT_TRACE\w*|GIT_CURL_VERBOSE|GCM_TRACE\w*)=|\$env:(?:GIT_TRACE\w*|GIT_CURL_VERBOSE|GCM_TRACE\w*)\b/i;
const TRACE_REFUSAL: CommandDecision = {
  ok: false, detail: 'git trace',
  reason: "Refused: git's trace switches (GIT_TRACE…, GIT_CURL_VERBOSE, GCM_TRACE…) can print the login git sends to a remote; a command in this shell cannot set them.",
};

/** `words` is the whole simple command, `start` where its program is, after the assignments in front of it. */
function traceSwitch(words: readonly Token[], start: number): CommandDecision | null {
  const name = commandName(words[start]?.text ?? '').toLowerCase();
  const end = PROGRAM_COMMANDS[name] || name === 'echo' || name === 'printf' ? start : words.length;
  return words.slice(0, end).some((w) => w.kind === 'word' && TRACE_SWITCH.test(w.text)) ? TRACE_REFUSAL : null;
}

// ───────────────────────── programs that print a login stored on this machine ─────────────────────────
//
// One row for each: the program's name (without its directory or `.exe` / `.cmd`), and what its arguments, lower-cased
// and joined by one space, look like when it is asked for the login. The list is by name and can miss: a tool that is
// not here, or one that is renamed, passes. It is not meant to cover every command line of every service.
const LOGIN_PRINTERS: readonly (readonly [program: RegExp, args: RegExp])[] = [
  // GitHub's and GitLab's command lines: the token itself, or the status with the token shown.
  [/^gh$/, /^auth (?:token\b|status\b.* (?:--show-token|-t)(?: |$))/],
  [/^glab$/, /^(?:auth (?:token\b|status\b.* (?:--show-token|-t)(?: |$))|config get (?:.* )?token\b)/],
  // Cloud command lines: an access token of the signed-in account, or its keys.
  [/^az$/, /(?:^| )account get-access-token\b/],
  [/^gcloud$/, /(?:^| )auth (?:application-default )?print-(?:access|identity|refresh)-token\b/],
  [/^aws$/, /(?:^| )(?:configure export-credentials|sts get-session-token)\b/],
  // Registries: Docker's credential helpers, npm's tokens and the auth keys of its configuration.
  [/^docker-credential-[\w-]+$/, /^(?:get|list)\b/],
  [/^p?npm$/, /^(?:token\b|(?:(?:config|c) )?get\b.*(?:_authtoken|_auth|_password)\b)/],
  // Windows: the stored logins of the user (listed, added or deleted).
  [/^cmdkey$/, /^/],
  // macOS: the keychain.
  [/^security$/, /(?:^| )(?:find-generic-password|find-internet-password|dump-keychain)\b/],
];
const LOGIN_PRINTER_REFUSAL: CommandDecision = {
  ok: false, detail: 'a stored login',
  reason: 'Refused: this command prints or changes a login stored on this machine (a token, a password, the keys of an account). Nothing that reads a project needs it.',
};

/**
 * Whether one of those programs, asked for the login, is among `words`. Every word is tried as the program, like
 * `git credential` above, so a program in front that runs the rest changes nothing; after a command that only prints
 * or searches text, only the first is.
 */
function printsLogin(words: readonly string[]): boolean {
  const first = commandName(words[0] ?? '').toLowerCase();
  const end = PROGRAM_COMMANDS[first] || first === 'echo' || first === 'printf' ? 1 : words.length;
  for (let i = 0; i < end; i += 1) {
    const program = commandName(words[i]!).toLowerCase();
    const args = words.slice(i + 1, i + 13).join(' ').toLowerCase();
    if (LOGIN_PRINTERS.some(([name, asked]) => name.test(program) && asked.test(args))) return true;
  }
  return false;
}
/** The words of code given to an interpreter on the command line, its punctuation taken for spaces. */
const wordsOfCode = (code: string): string[] => code.split(/[^\w/:.@=-]+/).filter(Boolean);

/** `git config` reads global and system scopes unless kept to the repository; that reaches the home gitconfig. */
function checkGitConfig(argv: Token[], cwd: string, boundary: Boundary): CommandDecision | null {
  let local = false;
  let reads = false;
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i]!.text;
    if (t === '--global' || t === '--system') return refuse(t, `git config ${t} reads outside the repository (the home or system gitconfig).`);
    if (t === '--local' || t === '--worktree') local = true;
    if (t === '--list' || t === '-l' || /^--get/.test(t)) reads = true;
    if (t === '--file' || t === '-f') {
      const val = argv[i + 1];
      if (!val) continue;
      if (val.substitution || val.dynamic) return undeterminable('a computed git config file');
      const d = checkPath(val.text, cwd, boundary);
      return d ?? OKnull;                                     // an explicit file (in or out of bounds) settles it
    }
    const eq = /^(?:--file|-f)=(.+)$/.exec(t);
    if (eq) return checkPath(eq[1]!, cwd, boundary) ?? OKnull;
  }
  const nonFlags = argv.slice(2).filter((w) => !w.text.startsWith('-'));
  const isRead = reads || nonFlags.length <= 1;               // --list/--get, or a bare `git config <key>` get
  if (isRead && !local) return refuse('git config', 'git config without --local reads the global and system scopes (the home gitconfig); use --local or --file <in-project>.');
  return OKnull;
}

/** Told each place a command says it writes, as written and the directory it is resolved against. */
export type WriteSink = (path: string, cwd: string) => void;

interface CommandOptions {
  readonly pipedInto: boolean;
  readonly prevCmd: { readonly words: Token[]; readonly cwd: string } | null;
  readonly depth: number;
  readonly writeRoots: readonly string[];
  readonly scratchDir?: string;
  /** Named the places the command says it writes (see the header); it never changes a decision. */
  readonly onWrite?: WriteSink;
  /** The command is PowerShell's (or cmd's), not a bash-family shell's. */
  readonly powershell?: boolean;
}

/**
 * The value of an output option this word gives, when there is one: `--output=FILE` or `--output FILE` (and the other
 * spellings OUTPUT_OPTION knows) for any command, the output option of the commands in OUTPUT_SHORT, dd's `of=FILE`.
 */
function outputTarget(name: string, word: Token, next: Token | undefined): string | null {
  if (word.dynamic || word.substitution) return null;
  const eq = /^(--[\w-]+)=(.+)$/.exec(word.text);
  if (eq && OUTPUT_OPTION.test(eq[1]!)) return eq[2]!;
  if (name === 'dd') return /^of=(.+)$/.exec(word.text)?.[1] ?? null;
  const takesNext = OUTPUT_OPTION.test(word.text) || OUTPUT_SHORT[name] === word.text;
  return takesNext && next?.kind === 'word' && !next.dynamic && !next.substitution && !next.text.startsWith('-') ? next.text : null;
}

const inWriteRoot = (path: string, cwd: string, roots: readonly string[]): boolean => {
  const key = canonicalKey(path, cwd);
  return roots.some((root) => key === root || key.startsWith(root.endsWith(sep) ? root : root + sep));
};
const projectWrite = (path: string): CommandDecision => ({
  ok: false, detail: path,
  reason: `Refused: shell cannot write project files (${path}). Use the job's scratch directory for temporary files; use pk_* tools for the ProjectKeeper folder.`,
});

/** The shell expands these three variables to this job's scratch directory. Other expansions stay unknown. */
function knownScratch(tokens: Token[], scratchDir?: string): Token[] {
  if (!scratchDir) return tokens;
  return tokens.map((token) => {
    if (token.kind !== 'word' || !token.dynamic || token.substitution) return token;
    const m = /^\$(?:TMPDIR|TEMP|TMP|\{TMPDIR\}|\{TEMP\}|\{TMP\})(?=$|[\\/])/.exec(token.text);
    return m ? { ...token, text: scratchDir + token.text.slice(m[0].length), dynamic: false } : token;
  });
}

// ───────────────────────── commands that run another command ─────────────────────────
//
// Every rule below this section is decided by a command's first word. A command that only runs another one — `env`,
// `timeout 5`, `xargs`, `find … -exec`, the shell's own `if`, `then`, `do`, `{` — used to be judged by its own first
// word, and the command it runs by none: `git push` was refused and `env git push` ran. So the command a wrapper runs
// is found here and judged as a command of its own, by the same rules, as deep as the wrappers go (`checkWrapped`,
// called at the top of `checkSimpleCommand`, is the one place). To find it the wrapper's own options have to be told
// from the command: each wrapper's are listed, and an option that is not listed is refused as undeterminable rather
// than guessed at. What a wrapper adds to the command at run time — the lines `xargs` reads, the file `find` found —
// stands in it as a computed word, which the rules already refuse wherever a computed word cannot be allowed.
//
// The list is by name. A program that runs commands and is not here is judged by its own first word, as before.

/** A wrapper whose own words are options (some with a value), then perhaps a fixed number of operands, then the command. */
interface WrapperOptions {
  /** Options whose value is the next word. */
  readonly valued?: readonly string[];
  /** Options that stand alone, their value attached or none. */
  readonly flags?: RegExp;
  /** Operands of the wrapper's own before the command (`timeout`'s duration). */
  readonly operands?: number;
  /** Options with which the wrapper runs nothing (it describes or lists): it is then judged as an ordinary command. */
  readonly inert?: RegExp;
  /** A word of the shell itself: a `cd` the command makes holds for what follows. */
  readonly sameShell?: boolean;
}
const WRAPPERS: Readonly<Record<string, WrapperOptions>> = {
  command: { flags: /^-p$/, inert: /^-[pvV]*[vV][pvV]*$/, sameShell: true },
  builtin: { sameShell: true },
  exec: { flags: /^-[cl]+$/, valued: ['-a'], sameShell: true },
  time: { flags: /^-p$/, sameShell: true },
  nohup: {},
  setsid: { flags: /^(?:-[cfw]+|--ctty|--fork|--wait)$/ },
  nice: { valued: ['-n', '--adjustment'], flags: /^(?:-\d+|-n-?\d+|--adjustment=\S+)$/ },
  timeout: { valued: ['-s', '--signal', '-k', '--kill-after'], flags: /^(?:--foreground|--preserve-status|-v|--verbose|--signal=\S+|--kill-after=\S+|-[sk]\S+)$/, operands: 1 },
  stdbuf: { valued: ['-i', '-o', '-e'], flags: /^(?:-[ioe]\S+|--(?:input|output|error)=\S+)$/ },
  ionice: { valued: ['-c', '-n', '--class', '--classdata'], flags: /^(?:-[cn]\d+|-t|--ignore|--class(?:data)?=\S+)$/, inert: /^(?:-p|--pid|-P|--pgid|-u|--uid)/ },
  caffeinate: { valued: ['-t', '-w'], flags: /^-[disum]+$/ },
  winpty: { flags: /^(?:-X\S+|--mouse|--showkey)$/ },
  busybox: { inert: /^--/ },
  unbuffer: { flags: /^-p$/ },
  chronic: { flags: /^-[ev]+$/ },
  wsl: { valued: ['-d', '--distribution', '-u', '--user', '--cd'], flags: /^(?:-e|--exec|--shell-type=\S+)$/, inert: /^(?:-l|--list|--status|--shutdown|--version|--help|--install|--update|--set-\S+|--export|--import|--unregister|-t|--terminate)/ },
};
/** Words of the shell's grammar that stand in front of a command, in bash and in PowerShell. */
const SHELL_WORDS = new Set(['!', '{', 'if', 'then', 'elif', 'else', 'while', 'until', 'do', 'coproc', 'function']);
/** Programs refused whatever they are given: they run a command as someone else, or start one nobody waits for. */
const REFUSED_RUNNERS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(['sudo', 'doas', 'su', 'runas', 'pkexec', 'runuser', 'chroot'].map((n) => [n, `${n} runs a command as another user or in another root; the Keeper's shell works as the user who started it, in the project.`])),
  ...Object.fromEntries(['start', 'start-process', 'saps', 'start-job', 'sajb', 'start-threadjob', 'invoke-wmimethod', 'iwmi', 'invoke-cimmethod', 'icim', 'wmic', 'schtasks', 'register-scheduledtask', 'register-scheduledjob']
    .map((n) => [n, `${n} starts a program apart from this command, which can then be neither checked nor undone; run the program itself.`])),
};
/** PowerShell's commands that write the files they are given (and cmd's, which PowerShell and `cmd /c` both know). */
const WRITE_CMDLETS = new Set([
  'remove-item', 'ri', 'del', 'erase', 'rd', 'set-content', 'sc', 'add-content', 'ac', 'clear-content', 'clc', 'out-file', 'new-item', 'ni', 'md',
  'rename-item', 'rni', 'ren', 'tee-object', 'export-csv', 'epcsv', 'export-clixml', 'set-itemproperty', 'clear-item', 'cli', 'remove-itemproperty',
]);
/** The same, for the ones that write their last operand, or the one after `-Destination`. */
const COPY_CMDLETS = new Set(['copy-item', 'cpi', 'copy', 'move-item', 'mi', 'move']);

const wordToken = (text: string, dynamic = false): Token => ({ kind: 'word', text, dynamic, substitution: false });
/** A word that stands for what a wrapper adds to its command when it runs: nothing is known of it. */
const ADDED_AT_RUN_TIME = wordToken('$ADDED_AT_RUN_TIME', true);
const unknownOption = (wrapper: string, option: string): CommandDecision => undeterminable(`${wrapper} with an option this check does not know (${option}), so the command it runs cannot be told from its own words`);

/** What a command turns out to run. */
interface Wrapped {
  /** Refused as it stands. */
  readonly refusal?: CommandDecision;
  /** The commands it runs, each as its words. */
  readonly commands?: readonly (readonly Token[])[];
  /** The command lines it hands to a shell. */
  readonly lines?: readonly { readonly text: string; readonly powershell?: boolean }[];
  /** The files it writes itself. */
  readonly writes?: readonly Token[];
  /** The directory it runs its command in, when it changes it (`env -C`). */
  readonly chdir?: Token;
  /** What is left for the rules below to judge: the wrapper with its own operands, without the command. Null: nothing. */
  readonly own: Token[] | null;
  readonly sameShell?: boolean;
  /** The wrapper reads standard input itself; its command gets none of it. */
  readonly takesInput?: boolean;
}

/** `argv` without its redirections; null when the command is no wrapper. */
function unwrap(argv: readonly Token[], powershell: boolean): Wrapped | null {
  const head = argv[0]!;
  const name = commandName(head.text).toLowerCase();
  const rest = argv.slice(1);
  const texts = (tokens: readonly Token[]): string => tokens.map((t) => t.text).join(' ');

  // A command whose name is computed. In PowerShell a variable in front is an expression (`$n -gt 1`), or an
  // assignment whose right side is a command; what `&` calls is refused where `&` is seen (checkPowerShellCommand).
  if (head.dynamic) {
    if (!powershell) return { refusal: undeterminable('a command whose name is computed'), own: null };
    return /^[-+*/%]?=$/.test(rest[0]?.text ?? '') && rest.length > 1 ? { commands: [rest.slice(1)], own: null, sameShell: true } : null;
  }
  const refused = REFUSED_RUNNERS[name];
  if (refused) return { refusal: refuse(name, refused), own: null };

  if (SHELL_WORDS.has(name)) {
    // `function f { … }` and `coproc NAME { … }` name something first.
    let inner = name === 'function' || (name === 'coproc' && rest[1]?.text === '{') ? rest.slice(1) : rest;
    if (name === '{' && inner[inner.length - 1]?.text === '}') inner = inner.slice(0, -1);
    return inner.length ? { commands: [inner], own: null, sameShell: true } : null;
  }
  // PowerShell: a script block anywhere in a command (`ForEach-Object { … }`, `Invoke-Command -ScriptBlock { … }`).
  if (powershell) {
    const open = argv.findIndex((w) => w.text === '{');
    if (open > 0) {
      const close = argv.findIndex((w, i) => i > open && w.text === '}');
      const inner = argv.slice(open + 1, close < 0 ? undefined : close);
      const after = close < 0 ? [] : argv.slice(close + 1);
      return { commands: inner.length ? [inner] : [], own: [...argv.slice(0, open), ...after] };
    }
    // What `[Diagnostics.Process]::Start(…)` or a COM shell object starts is as far from this check as Start-Process.
    if (argv.some((w) => /Diagnostics\.Process|WScript\.Shell|Shell\.Application/i.test(w.text))) return { refusal: refuse(name, REFUSED_RUNNERS['start-process']!), own: null };
  }

  const spec = WRAPPERS[name];
  if (spec) {
    let i = 0;
    for (; i < rest.length; i += 1) {
      const t = rest[i]!.text;
      if (t === '--') { i += 1; break; }
      if (!t.startsWith('-')) break;
      if (spec.inert?.test(t)) return null;
      if (spec.valued?.includes(t)) { i += 1; continue; }
      if (!spec.flags?.test(t) || rest[i]!.dynamic) return { refusal: unknownOption(name, t), own: null };
    }
    const inner = rest.slice(i + (spec.operands ?? 0));
    return inner.length ? { commands: [inner], own: null, sameShell: spec.sameShell } : null;
  }

  if (name === 'env') {
    const words = [...rest];
    const assignments: Token[] = [];
    let chdir: Token | undefined;
    let i = 0;
    for (; i < words.length; i += 1) {
      const w = words[i]!;
      const t = w.text;
      if (/^[A-Za-z_]\w*=/.test(t)) { assignments.push(w); continue; }
      if (t === '--' || t === '-') continue;
      if (!t.startsWith('-')) break;
      if (/^(?:-i|-0|-v|--ignore-environment|--null|--debug|-u.+|--unset=.*|--argv0=.*|--(?:block|default|ignore)-signal(?:=.*)?|--list-signal-handling)$/.test(t)) continue;
      if (t === '-u' || t === '--unset' || t === '-a' || t === '--argv0') { i += 1; continue; }
      const dir = t === '-C' || t === '--chdir' ? words[i + 1] : /^(?:--chdir=|-C)(.+)$/.test(t) ? { ...w, text: t.replace(/^(?:--chdir=|-C)/, '') } : undefined;
      if (dir) { chdir = dir; if (dir === words[i + 1]) i += 1; continue; }
      // `-S` gives the rest of the command in one string, which env splits into words itself.
      const split = t === '-S' || t === '--split-string' ? words[i + 1] : /^(?:--split-string=|-S)(.+)$/.test(t) ? { ...w, text: t.replace(/^(?:--split-string=|-S)/, '') } : undefined;
      const parts = split && !split.dynamic && !split.substitution ? tokenize(split.text) : null;
      if (!parts || parts.some((p) => p.kind !== 'word')) return { refusal: unknownOption('env', t), own: null };
      words.splice(i, split === words[i + 1] ? 2 : 1, ...parts);
      i -= 1;
    }
    const inner = words.slice(i);
    return inner.length ? { commands: [[...assignments, ...inner]], chdir, own: null } : null;
  }

  if (name === 'xargs') {
    let replace: string | null = null;
    let i = 0;
    for (; i < rest.length; i += 1) {
      const t = rest[i]!.text;
      if (t === '--') { i += 1; break; }
      if (!t.startsWith('-')) break;
      if (rest[i]!.dynamic) return { refusal: unknownOption('xargs', t), own: null };
      if (t === '-I') { replace = rest[i + 1]?.text ?? '{}'; i += 1; continue; }
      const attached = /^(?:-I|-i|--replace=)(.+)$/.exec(t);
      if (attached) { replace = attached[1]!; continue; }
      if (t === '-i' || t === '--replace') { replace = '{}'; continue; }
      if (/^(?:-[adELnPs]|--arg-file|--delimiter|--max-args|--max-chars|--max-lines|--max-procs|--process-slot-var)$/.test(t)) { i += 1; continue; }
      if (/^(?:-[0rtpxo]+|-[adEelLnPs].+|--null|--no-run-if-empty|--verbose|--interactive|--exit|--open-tty|--show-limits|--(?:arg-file|delimiter|eof|max-args|max-chars|max-lines|max-procs|process-slot-var)=.*|-[el]|--eof|--max-lines)$/.test(t)) continue;
      return { refusal: unknownOption('xargs', t), own: null };
    }
    const inner = rest.slice(i);
    if (inner.length === 0) return null;
    const marker = replace;
    // The lines xargs reads become words of the command: where the replace string stands, or at the end.
    const command = marker ? inner.map((w) => (w.text.includes(marker) ? { ...w, dynamic: true } : w)) : [...inner, ADDED_AT_RUN_TIME];
    return { commands: [command], own: argv.slice(0, 1 + i), takesInput: true };
  }

  if (name === 'find') {
    const commands: Token[][] = [];
    const writes: Token[] = [];
    const own: Token[] = [head];
    const firstTest = rest.findIndex((w) => /^[-(!]/.test(w.text));
    const starts = rest.slice(0, firstTest < 0 ? rest.length : firstTest);
    for (let i = 0; i < rest.length; i += 1) {
      const t = rest[i]!.text;
      if (/^-(?:exec|execdir|ok|okdir)$/.test(t)) {
        let end = i + 1;
        while (end < rest.length && rest[end]!.text !== ';' && rest[end]!.text !== '+') end += 1;
        // `{}` is the file found.
        const inner = rest.slice(i + 1, end).map((w) => (w.text.includes('{}') ? { ...w, dynamic: true } : w));
        if (inner.length) commands.push(inner);
        i = end;
      } else if (t === '-delete') {
        writes.push(...(starts.length ? starts : [wordToken('.')]));
      } else if (/^-(?:fprint|fprint0|fprintf|fls)$/.test(t) && rest[i + 1]) {
        writes.push(rest[i + 1]!);
        i += 1;
      } else own.push(rest[i]!);
    }
    return commands.length || writes.length ? { commands, writes, own } : null;
  }

  if (name === 'watch') {
    let i = 0;
    for (; i < rest.length; i += 1) {
      const t = rest[i]!.text;
      if (t === '--') { i += 1; break; }
      if (!t.startsWith('-')) break;
      if (t === '-n' || t === '--interval') { i += 1; continue; }
      if (!/^(?:-[bcdegtxprw]+|-n\S+|--interval=\S+|--differences(?:=\S+)?|--\w[\w-]*)$/.test(t) || rest[i]!.dynamic) return { refusal: unknownOption('watch', t), own: null };
    }
    // watch hands its words, joined, to `sh -c`.
    return i < rest.length ? { lines: [{ text: texts(rest.slice(i)) }], own: null } : null;
  }

  if (name === 'parallel') {
    let i = 0;
    for (; i < rest.length; i += 1) {
      const t = rest[i]!.text;
      if (t === '--') { i += 1; break; }
      if (!t.startsWith('-')) break;
      if (/^(?:-j|--jobs|-N|-n|--max-args|-L|-P|--max-procs)$/.test(t)) { i += 1; continue; }
      if (!/^(?:-k|--keep-order|-q|--quote|-X|-m|-u|--ungroup|--dry-run|--will-cite|--bar|--progress|-0|--null|-[jP]\S+|--jobs=\S+|--halt\S*)$/.test(t) || rest[i]!.dynamic) return { refusal: unknownOption('parallel', t), own: null };
    }
    const at = rest.findIndex((w, k) => k >= i && /^:{3,4}\+?$/.test(w.text));
    const template = rest.slice(i, at < 0 ? undefined : at);
    const given = at < 0 ? [] : rest.slice(at).filter((w) => !/^:{3,4}\+?$/.test(w.text));
    // parallel hands a shell the command with each argument put in at `{…}`, or at its end; with no command, the
    // arguments are the commands.
    const line = texts(template).replace(/\{[^}\s]*\}/g, '$ADDED_AT_RUN_TIME');
    const lines = template.length ? [{ text: line === texts(template) ? `${line} $ADDED_AT_RUN_TIME` : line }] : given.map((w) => ({ text: w.text }));
    return { lines, own: [head, ...(template.length ? given : [])] };
  }

  if (name === 'cmd') {
    const at = rest.findIndex((w) => /^\/{1,2}[ck]$/i.test(w.text));
    if (at < 0 || rest.slice(0, at).some((w) => !/^\/{1,2}[a-z](?::\S*)?$/i.test(w.text))) return null;
    return at + 1 < rest.length ? { lines: [{ text: texts(rest.slice(at + 1)), powershell: true }], own: null } : null;   // cmd's line is read with backslashes as they are, like PowerShell's
  }

  if (name === 'powershell' || name === 'pwsh') {
    for (let i = 0; i < rest.length; i += 1) {
      const t = rest[i]!.text.toLowerCase();
      if (/^-(?:c|co\w*)$/.test(t)) return i + 1 < rest.length ? { lines: [{ text: texts(rest.slice(i + 1)), powershell: true }], own: null } : null;
      if (/^-(?:e|ec|en\w*)$/.test(t)) return { refusal: undeterminable('an encoded PowerShell command'), own: null };
      if (/^-(?:f|fi\w*)$/.test(t)) return rest[i + 1] ? { own: [head, rest[i + 1]!] } : null;                       // a script file: read as one below
      if (/^-(?:ex\w*|ep|w|wi\w*|inputformat|if|outputformat|of|o|wd|workingdirectory|config\w*|custompipename|settingsfile|settings|version|v|psconsolefile)$/.test(t)) { i += 1; continue; }
      if (t.startsWith('-')) continue;
      // No -Command and no -File: Windows PowerShell takes the rest for a command, PowerShell 7 for a script file.
      return { lines: [{ text: texts(rest.slice(i)), powershell: true }], own: [head, rest[i]!] };
    }
    return null;
  }

  // The shell's `trap 'commands' SIGNAL…` and `alias name='commands'` keep a command line for later.
  if (name === 'trap') {
    const operands = rest.filter((w) => w.text !== '--');
    if (operands.length < 2 || /^-[lp]/.test(operands[0]!.text) || operands[0]!.text === '-') return null;
    return { lines: [{ text: operands[0]!.text }], own: null };
  }
  if (name === 'alias') {
    const lines = rest.flatMap((w) => { const eq = w.text.indexOf('='); return eq > 0 ? [{ text: w.text.slice(eq + 1) }] : []; });
    return lines.length ? { lines, own: null } : null;
  }

  // An interpreter's option letters written together (`bash -lc '…'`, `python -uc '…'`, `perl -ne '…'`), and `--`
  // before the code: put as the rule for inline code below reads them.
  const interp = INTERPRETERS[name];
  if (interp) {
    const letters = interp.flags.filter((f) => /^-[A-Za-z]$/.test(f)).map((f) => f[1]!);
    let changed = false;
    const own: Token[] = [head];
    for (let i = 0; i < rest.length; i += 1) {
      const w = rest[i]!;
      const cluster = /^-[A-Za-z0-9]+([A-Za-z])$/.exec(w.text);
      if (cluster && w.text.length > 2 && letters.includes(cluster[1]!) && !interp.flags.includes(w.text)) {
        own.push(wordToken(`-${cluster[1]}`));
        if (rest[i + 1]?.text === '--') i += 1;
        changed = true;
      } else if (interp.flags.includes(w.text) && rest[i + 1]?.text === '--') {
        own.push(w);
        i += 1;
        changed = true;
      } else own.push(w);
    }
    return changed ? { own } : null;
  }
  return null;
}

/**
 * Judge what a command runs, when it runs another: null when it is no wrapper; a refusal; or what is left of the
 * wrapper for the rules below (`own`, null when nothing is), with the directory the shell is in afterwards.
 */
function checkWrapped(argv: readonly Token[], cwd: string, boundary: Boundary, opts: CommandOptions): { decision: CommandDecision | null; cwd: string; own: Token[] | null } | null {
  // Redirections belong to the command that is run in the end; they go with it.
  const plain: Token[] = [];
  const redirections: Token[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i]!.kind === 'op' && REDIRECTS.has(argv[i]!.text)) { redirections.push(argv[i]!, ...(argv[i + 1] ? [argv[i + 1]!] : [])); i += 1; } else plain.push(argv[i]!);
  }
  if (plain.length === 0) return null;
  const name = commandName(plain[0]!.text).toLowerCase();
  const stop = (decision: CommandDecision) => ({ decision, cwd, own: null });

  // PowerShell's and cmd's commands that write the files they name: said as writes, and refused in the project.
  if (opts.powershell && (WRITE_CMDLETS.has(name) || COPY_CMDLETS.has(name))) {
    const operands = plain.slice(1).filter((w) => !w.text.startsWith('-'));
    const named = plain.findIndex((w) => /^-dest/i.test(w.text));
    const targets = WRITE_CMDLETS.has(name) ? operands : named >= 0 && plain[named + 1] ? [plain[named + 1]!] : operands.slice(-1);
    for (const target of targets) {
      if (target.dynamic || target.substitution) return stop(undeterminable('a computed output path'));
      opts.onWrite?.(target.text, cwd);
      if (inWriteRoot(target.text, cwd, opts.writeRoots)) return stop(projectWrite(target.text));
    }
    if (/^(?:move-item|mi|move)$/.test(name)) for (const source of operands) if (!source.dynamic && !targets.includes(source)) opts.onWrite?.(source.text, cwd);
  }

  const wrapped = unwrap(plain, opts.powershell === true);
  if (!wrapped) return null;
  if (wrapped.refusal) return stop(wrapped.refusal);
  let inside = cwd;
  if (wrapped.chdir) {
    if (wrapped.chdir.dynamic || wrapped.chdir.substitution) return stop(undeterminable('a computed directory'));
    const d = checkPath(wrapped.chdir.text, cwd, boundary);
    if (d) return stop(d);
    inside = toAbsolute(wrapped.chdir.text, cwd);
  }
  for (const target of wrapped.writes ?? []) {
    if (target.dynamic || target.substitution) return stop(undeterminable('a computed output path'));
    opts.onWrite?.(target.text, cwd);
    if (inWriteRoot(target.text, cwd, opts.writeRoots)) return stop(projectWrite(target.text));
  }
  for (const line of wrapped.lines ?? []) {
    const d = line.powershell
      ? checkPowerShellCommand(line.text, inside, boundary, opts.writeRoots, opts.scratchDir, opts.onWrite)
      : checkBashCommand(line.text, inside, boundary, opts.depth + 1, opts.writeRoots, opts.scratchDir, opts.onWrite);
    if (!d.ok) return stop(d);
  }
  let next = cwd;
  const input = wrapped.takesInput ? { pipedInto: false, prevCmd: null } : {};
  for (const command of wrapped.commands ?? []) {
    const r = checkSimpleCommand([...command, ...redirections], inside, boundary, { ...opts, ...input });
    if (r.decision && !r.decision.ok) return stop(r.decision);
    if (wrapped.sameShell) next = r.cwd;
  }
  return { decision: null, cwd: next, own: wrapped.own };
}

/** Analyse one simple command with the working directory it runs in; returns the next directory (after `cd`). */
function checkSimpleCommand(words: Token[], cwd: string, boundary: Boundary, opts: CommandOptions): { decision: CommandDecision | null; cwd: string } {
  // Leading VAR=value assignments set the command's environment; their path values are checked, then skipped as operands.
  let start = 0;
  while (start < words.length && words[start]!.kind === 'word' && /^[A-Za-z_]\w*=/.test(words[start]!.text)) {
    const w = words[start]!;
    const eq = /^([A-Za-z_]\w*)=(.*)$/.exec(w.text)!;
    const name = eq[1]!;
    const value = eq[2]!;
    if (w.substitution) return { decision: undeterminable('a command substitution in an environment assignment'), cwd };
    if (value && (PATH_ENV.has(name) || looksLikePath(value))) {
      if (w.dynamic) return { decision: undeterminable('a computed path in an environment assignment'), cwd };
      const d = checkPath(value, cwd, boundary);
      if (d) return { decision: d, cwd };
    }
    start += 1;
  }
  let argv = words.slice(start);
  const trace = traceSwitch(words, start);
  if (trace) return { decision: trace, cwd };
  if (argv.length === 0) return { decision: null, cwd };
  // A command that runs another command: that one is judged first, as a command of its own (see `checkWrapped`).
  const wrapped = checkWrapped(argv, cwd, boundary, opts);
  if (wrapped && (wrapped.decision || !wrapped.own)) return { decision: wrapped.decision, cwd: wrapped.cwd };
  if (wrapped?.own) argv = wrapped.own;
  const name = commandName(argv[0]!.text);
  // The sed of macOS takes the backup suffix of -i as a word of its own, usually an empty one: `sed -i '' 's/a/b/' file`.
  // That word is no operand. Counted as one, it made the expression a file sed writes — inside the project, so refused,
  // whichever file was edited. (Git Bash's sed has no such word; there the command is read as before.)
  if (name === 'sed' && system.platform !== 'win32') argv = argv.filter((w, i, all) => !(w.text === '' && i > 0 && /^-[A-Za-z]*i$/.test(all[i - 1]!.text)));
  const interp = INTERPRETERS[name];
  const credential = credentialCommand(argv);
  if (credential) return { decision: credential, cwd };
  if (printsLogin(argv.filter((w) => w.kind === 'word').map((w) => w.text))) return { decision: LOGIN_PRINTER_REFUSAL, cwd };

  // Code piped into an interpreter runs without ever being an argument the check can see.
  if (opts.pipedInto && interp && !argv.slice(1).some((w) => interp.flags.includes(w.text))) {
    return { decision: refuse(`${name} (piped input)`, `code piped into ${name} cannot be checked; run the commands directly, or a script the boundary can read.`), cwd };
  }

  // Redirection targets are filenames, not command operands. Refuse known project writes before spawning;
  // the post-command snapshot also catches writes hidden in scripts and tools.
  const redirectTargets = new Set<Token>();
  for (let i = 0; i < words.length; i += 1) {
    if (words[i]!.kind !== 'op' || !REDIRECTS.has(words[i]!.text)) continue;
    const target = words[i + 1];
    if (!target || target.kind !== 'word') continue;
    redirectTargets.add(target);
    if (words[i]!.text === '<' || words[i]!.text === '0<') {
      if (target.substitution || target.dynamic) return { decision: undeterminable('a redirection from a computed path'), cwd };
      const d = checkPath(target.text, cwd, boundary);
      if (d) return { decision: d, cwd };
    } else if (!['<<', '<<-', '<<<'].includes(words[i]!.text)) {
      if (target.dynamic || target.substitution) return { decision: undeterminable('a computed output path'), cwd };
      opts.onWrite?.(target.text, cwd);
      if (inWriteRoot(target.text, cwd, opts.writeRoots)) return { decision: projectWrite(target.text), cwd };
    }
  }

  if (name === 'eval') return { decision: undeterminable('eval'), cwd };

  // macOS's own tools, by the name the shell finds them under (a script of the project that happens to be called
  // `pbpaste` is given by its path, and is read as a script).
  if (system.platform === 'darwin' && (!/[\\/]/.test(argv[0]!.text) || /^\/usr\/s?bin\//.test(argv[0]!.text))) {
    const why = MAC_REACHES_OUTSIDE[name];
    if (why) return { decision: refuse(name, why), cwd };
    if (name === 'mdfind' && !argv.slice(1).some((w) => w.text === '-onlyin')) {
      return { decision: refuse('mdfind', 'mdfind searches the whole machine; keep it to a directory of the project with -onlyin, or use grep or find in the project.'), cwd };
    }
  }

  // These commands have literal destination operands. Unknown or indirect writes are caught by the snapshot.
  if (new Set(['tee', 'cp', 'mv', 'rm', 'touch', 'mkdir', 'rmdir', 'truncate']).has(name)
      || (name === 'sed' && argv.slice(1).some((w) => /^-.*i/.test(w.text)))) {
    const operands = argv.slice(1).filter((w) => w.kind === 'word' && !w.text.startsWith('-') && !redirectTargets.has(w));
    const destinations = name === 'cp' || name === 'mv' ? operands.slice(-1) : name === 'sed' ? operands.slice(1) : operands;
    for (const target of destinations) {
      if (target.dynamic || target.substitution) return { decision: undeterminable('a computed output path'), cwd };
      opts.onWrite?.(target.text, cwd);
      if (inWriteRoot(target.text, cwd, opts.writeRoots)) return { decision: projectWrite(target.text), cwd };
    }
    // mv also removes its sources, so they are written too (the refusal above stays about the destination).
    if (name === 'mv') for (const source of operands.slice(0, -1)) if (!source.dynamic && !source.substitution) opts.onWrite?.(source.text, cwd);
  }

  if (name === 'cd' || name === 'pushd') {
    const arg = argv.slice(1).find((w) => !w.text.startsWith('-') || w.text === '-');
    if (!arg) return { decision: name === 'cd' ? refuse('cd', 'cd with no directory goes to the home directory, outside the project.') : null, cwd: name === 'cd' ? cwd : CWD_UNTRACKABLE };
    if (arg.text === '-') return { decision: null, cwd: CWD_UNTRACKABLE };   // cd - : the previous directory, which we cannot follow
    if (arg.substitution || arg.dynamic) return { decision: undeterminable('a computed directory in cd'), cwd };
    const d = checkPath(arg.text, cwd, boundary);             // a cd target is a read location (later commands read it)
    if (d) return { decision: d, cwd };
    return { decision: null, cwd: toAbsolute(arg.text, cwd) };
  }
  if (name === 'popd') return { decision: null, cwd: CWD_UNTRACKABLE };
  if (name === 'tr') return { decision: null, cwd };          // both operands are character sets, never paths

  if (name === 'source' || name === '.') {
    const arg = argv.slice(1).find((w) => !w.text.startsWith('-'));
    if (arg) { const d = scanScriptFile(arg, cwd, boundary, opts.depth, opts.writeRoots, opts.scratchDir, opts.onWrite); if (d) return { decision: d, cwd }; }
    return { decision: null, cwd };
  }

  // Follow-symlink flags on a recursive command can leave the tree through a link inside it.
  const followRe = FOLLOW_LINK[name];
  const followBsd = system.platform === 'win32' ? undefined : FOLLOW_LINK_BSD[name];
  if ((followRe && argv.slice(1).some((w) => followRe.test(w.text))) || (followBsd && argv.slice(1).some((w) => followBsd.test(w.text)))) {
    return { decision: refuse(`${name} (follow symlinks)`, `${name} here follows symbolic links, which can leave the project; use the non-following form (for example grep -r, find without -L).`), cwd };
  }

  // A list of paths read from a file (tar --files-from, xargs --arg-file, or `cat file | xargs`).
  if (name === 'tar' || name === 'xargs') {
    for (let i = 1; i < argv.length; i += 1) {
      const t = argv[i]!.text;
      const listFlag = (name === 'tar' && (t === '-T' || t === '--files-from')) || (name === 'xargs' && (t === '-a' || t === '--arg-file'));
      const eq = /^(?:--files-from|--arg-file)=(.+)$/.exec(t);
      if (listFlag && argv[i + 1]) { const d = scanListFile(argv[i + 1]!, cwd, boundary); if (d) return { decision: d, cwd }; i += 1; }
      else if (eq) { const d = scanListFile({ kind: 'word', text: eq[1]!, dynamic: false, substitution: false }, cwd, boundary); if (d) return { decision: d, cwd }; }
    }
    if (name === 'xargs' && opts.pipedInto && opts.prevCmd) {
      const src = stdinFileOf(opts.prevCmd.words);
      if (src) { const d = scanListFile(src, opts.prevCmd.cwd, boundary); if (d) return { decision: d, cwd }; }
    }
  }

  // git subcommands that move the working tree elsewhere, and git config's scope.
  let gitCwd = cwd;
  if (name === 'git') {
    let subcommand = '';
    let subcommandIndex = -1;
    for (let i = 1; i < argv.length; i += 1) {
      const word = argv[i]!.text;
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(word)) { i += 1; continue; }
      if (word.startsWith('-')) continue;
      subcommand = word; subcommandIndex = i; break;
    }
    const rest = argv.slice(subcommandIndex + 1).filter((w) => w.kind === 'word' && !redirectTargets.has(w)).map((w) => w.text);
    const configWrites = subcommand === 'config' && (
      rest.some((word) => /^--(?:add|unset|replace-all|rename-section|remove-section|edit)$/.test(word))
      || rest.filter((word) => !word.startsWith('-')).length > 1
    );
    const branchWrites = subcommand === 'branch' && rest.some((word) => !word.startsWith('-') || /^-(?:[dDmMcCfF]|-delete|-move|-copy|-force)/.test(word));
    const tagWrites = subcommand === 'tag' && rest.some((word) => !word.startsWith('-') || /^-(?:[daf]|-delete|-annotate|-force)/.test(word));
    if (GIT_MUTATORS.has(subcommand) || configWrites || branchWrites || tagWrites
        || (subcommand === 'reflog' && ['expire', 'delete'].includes(rest[0] ?? ''))
        || (subcommand === 'worktree' && rest[0] !== 'list')
        || (subcommand === 'submodule' && rest[0] !== 'status')) {
      return { decision: projectWrite(`git ${subcommand}`), cwd };
    }
    if (subcommand === 'config') {
      const d = checkGitConfig(argv, cwd, boundary);
      if (d && !d.ok) return { decision: d, cwd };
    }
    for (let i = 1; i < argv.length; i += 1) {
      const w = argv[i]!;
      const attached = /^-C(.+)$/.exec(w.text);
      const eq = /^(--git-dir|--work-tree)=(.+)$/.exec(w.text);
      if (w.text === '-C' || w.text === '--git-dir' || w.text === '--work-tree') {
        const val = argv[i + 1];
        if (val) {
          if (val.substitution || val.dynamic) return { decision: undeterminable('a computed path in git'), cwd };
          const d = checkPath(val.text, gitCwd, boundary);
          if (d) return { decision: d, cwd };
          if (w.text === '-C') gitCwd = toAbsolute(val.text, gitCwd);
          i += 1;
        }
      } else if (attached) {
        const d = checkPath(attached[1]!, gitCwd, boundary);
        if (d) return { decision: d, cwd };
        gitCwd = toAbsolute(attached[1]!, gitCwd);
      } else if (eq) {
        if (w.substitution || w.dynamic) return { decision: undeterminable('a computed path in git'), cwd };
        const d = checkPath(eq[2]!, gitCwd, boundary);
        if (d) return { decision: d, cwd };
      }
    }
    // The files git's output options write (`git log --output=F`, `git format-patch -o DIR`, `git archive -o F`).
    for (let i = subcommandIndex + 1; i < argv.length; i += 1) {
      const w = argv[i]!;
      if (w.kind !== 'word' || redirectTargets.has(w)) continue;
      const next = argv[i + 1];
      const shortOutput = w.text === '-o' && (subcommand === 'format-patch' || subcommand === 'archive')
        && next?.kind === 'word' && !next.dynamic && !next.substitution ? next.text : null;
      const target = outputTarget('git', w, next) ?? shortOutput;
      if (target) opts.onWrite?.(target, gitCwd);
    }
    return { decision: null, cwd };
  }

  // Interpreters running inline code, or a script file.
  if (interp) {
    for (let i = 1; i < argv.length; i += 1) {
      if (interp.flags.includes(argv[i]!.text)) {
        const code = argv[i + 1];
        if (!code) continue;
        if (code.substitution) return { decision: undeterminable('a command substitution in inline code'), cwd };
        if (interp.bash) { const r = checkBashCommand(code.text, cwd, boundary, opts.depth + 1, opts.writeRoots, opts.scratchDir, opts.onWrite); if (!r.ok) return { decision: r, cwd }; }
        else {
          if (CREDENTIAL_IN_CODE.test(code.text)) return { decision: CREDENTIAL_REFUSAL, cwd };
          if (printsLogin(['', ...wordsOfCode(code.text)])) return { decision: LOGIN_PRINTER_REFUSAL, cwd };
          if (homeDerivedInCode(code.text)) return { decision: refuse('inline code', 'the inline code builds a path from the home directory, which is outside the project.'), cwd };
          const d = checkInlineCode(code.text, cwd, boundary); if (d) return { decision: d, cwd };
        }
        return { decision: null, cwd };
      }
    }
    // No inline-code flag: an interpreter with a script-file argument runs that file.
    const script = argv.slice(1).find((w) => !w.text.startsWith('-'));
    if (script) { const d = scanScriptFile(script, cwd, boundary, opts.depth, opts.writeRoots, opts.scratchDir, opts.onWrite); if (d) return { decision: d, cwd }; return { decision: null, cwd }; }
  }

  // A script or binary given by path (not a PATH-resolved name) is itself read, and its contents scanned, when it runs.
  if (looksLikePath(argv[0]!.text)) {
    const d = scanScriptFile(argv[0]!, cwd, boundary, opts.depth, opts.writeRoots, opts.scratchDir, opts.onWrite);
    if (d) return { decision: d, cwd };
  }

  // awk, sed and the grep family: the program or the pattern is not a path; the files they read are.
  const program = PROGRAM_COMMANDS[name];
  if (program) return { decision: checkProgramCommand(program, argv, redirectTargets, cwd, boundary), cwd };

  // General arguments: flag values that take a read path, and every operand (resolved against the running directory).
  for (let i = 1; i < argv.length; i += 1) {
    const w = argv[i]!;
    if (w.kind !== 'word' || redirectTargets.has(w)) continue;
    // An output option's value is a file the command writes; it is still checked below like any other operand.
    const output = outputTarget(name, w, argv[i + 1]);
    if (output) opts.onWrite?.(output, gitCwd);
    if (PATH_VALUE_FLAGS.has(w.text)) {
      const val = argv[i + 1];
      if (val && val.kind === 'word') {
        if (val.substitution || val.dynamic) return { decision: undeterminable('a computed path'), cwd };
        const d = checkPath(val.text, gitCwd, boundary);
        if (d) return { decision: d, cwd };
        i += 1;
      }
      continue;
    }
    const eqFlag = /^--[\w-]+=(.+)$/.exec(w.text);
    if (eqFlag) {
      if (w.substitution) return { decision: undeterminable('a command substitution'), cwd };
      if (w.dynamic && looksLikePath(eqFlag[1]!)) return { decision: undeterminable('a computed path'), cwd };
      if (!w.dynamic) { const d = checkPath(eqFlag[1]!, gitCwd, boundary); if (d) return { decision: d, cwd }; }
      continue;
    }
    if (w.text.startsWith('-')) continue;                     // other flags
    if (w.substitution) return { decision: undeterminable('a command substitution'), cwd };
    if (w.dynamic && looksLikePath(w.text)) return { decision: undeterminable('a computed path'), cwd };
    if (w.dynamic) continue;                                   // a dynamic bare word is not a path position
    const d = checkPath(w.text, gitCwd, boundary);
    if (d) return { decision: d, cwd };
  }
  return { decision: null, cwd };
}

/** Extract quoted string literals from inline interpreter code and check those that look like paths. */
function checkInlineCode(code: string, cwd: string, boundary: Boundary): CommandDecision | null {
  for (const m of code.matchAll(/'([^']*)'|"([^"]*)"/g)) {
    const literal = (m[1] ?? m[2] ?? '');
    if (looksLikePath(literal)) { const d = checkPath(literal, cwd, boundary); if (d) return d; }
  }
  return null;
}

/** The file a command reads its stdin from: `cat FILE`, `type FILE`, or a `< FILE` redirection. */
function stdinFileOf(words: readonly Token[]): Token | null {
  for (let i = 0; i < words.length; i += 1) {
    if ((words[i]!.text === '<' || words[i]!.text === '0<') && words[i + 1]?.kind === 'word') return words[i + 1]!;
  }
  const name = commandName(words[0]?.text ?? '');
  if (name === 'cat' || name === 'type') { const f = words.slice(1).find((w) => w.kind === 'word' && !w.text.startsWith('-')); return f ?? null; }
  return null;
}

/**
 * awk, sed and the grep family: the program or pattern is not a path — `/^## Heading/{f=1} f` or `/api/` names no file
 * — so it is not checked as one; the files the command reads are, whether an operand names them or an option does
 * (`awk -f`, `sed -f`, `grep -f`, attached or not). Options are read as getopt reads them: a cluster of short options,
 * a value attached or in the next word, `--name=value` or `--name value`, `--` ending the options. A command
 * substitution anywhere — a pattern included — runs a command that cannot be checked, and is refused.
 */
function checkProgramCommand(spec: ProgramCommand, argv: readonly Token[], skip: ReadonlySet<Token>, cwd: string, boundary: Boundary): CommandDecision | null {
  let programGiven = false;
  const operands: Token[] = [];
  /** An option's value: a file it reads is checked; the program, a pattern or other text is not a path. */
  const value = (kind: ValueKind | null, text: string, word: Token): CommandDecision | null => {
    if (word.substitution) return undeterminable('a command substitution');
    if (kind === 'program' || kind === 'program-file') programGiven = true;
    if (kind === 'program' || kind === 'text' || kind === 'count') return null;
    if (kind === null) {                                        // a long option this list does not know: checked as before
      if (word.dynamic) return looksLikePath(text) ? undeterminable('a computed path') : null;
      return checkPath(text, cwd, boundary);
    }
    if (word.dynamic) return undeterminable('a computed path');
    return checkPath(text, cwd, boundary);
  };
  const takes = (kind: ValueKind, next: Token | undefined): next is Token =>
    next !== undefined && next.kind === 'word' && !skip.has(next) && (kind !== 'count' || /^\d+$/.test(next.text));
  let optionsDone = false;
  for (let i = 1; i < argv.length; i += 1) {
    const w = argv[i]!;
    if (w.kind !== 'word' || skip.has(w)) continue;
    if (optionsDone || w.text === '-' || !w.text.startsWith('-')) { operands.push(w); continue; }
    if (w.text === '--') { optionsDone = true; continue; }
    if (spec.noProgram?.includes(w.text.replace(/=.*$/, ''))) programGiven = true;
    if (w.text.startsWith('--')) {
      const eq = w.text.indexOf('=');
      const kind = spec.long[eq < 0 ? w.text : w.text.slice(0, eq)] ?? null;
      if (eq >= 0) { const d = value(kind, w.text.slice(eq + 1), w); if (d) return d; }
      else if (kind && takes(kind, argv[i + 1])) { const d = value(kind, argv[i + 1]!.text, argv[i + 1]!); if (d) return d; i += 1; }
      continue;
    }
    // A cluster of short options: the first that takes a value takes the rest of the word, or else the next word.
    for (let j = 1; j < w.text.length; j += 1) {
      const letter = w.text[j]!;
      if (spec.attachedOnly?.includes(letter)) break;
      const kind = spec.short[letter];
      if (!kind) continue;
      const rest = w.text.slice(j + 1);
      if (rest) { const d = value(kind, rest, w); if (d) return d; }
      else if (takes(kind, argv[i + 1])) { const d = value(kind, argv[i + 1]!.text, argv[i + 1]!); if (d) return d; i += 1; }
      break;
    }
  }
  for (const [n, w] of operands.entries()) {
    if (w.substitution) return undeterminable('a command substitution');
    if (n === 0 && !programGiven) continue;                     // the program or the pattern
    if (w.text === '-') continue;                               // standard input
    if (spec.assignments && /^[A-Za-z_]\w*=/.test(w.text)) continue;   // awk: var=value sets a variable
    if (w.dynamic) { if (looksLikePath(w.text)) return undeterminable('a computed path'); continue; }
    const d = checkPath(w.text, cwd, boundary);
    if (d) return d;
  }
  return null;
}

/** Read a file that lists paths (one per line) and check each against the boundary. */
function scanListFile(fileToken: Token, cwd: string, boundary: Boundary): CommandDecision | null {
  if (fileToken.substitution || fileToken.dynamic) return undeterminable('a computed list file');
  const bad = checkPath(fileToken.text, cwd, boundary);
  if (bad) return bad;
  const abs = toAbsolute(fileToken.text, cwd);
  let content = '';
  try {
    if (statSync(abs).size > MAX_SCAN_BYTES) return undeterminable('a path list too large to inspect');
    content = readFileSync(abs, 'utf8');
  } catch { return undeterminable('a path list that cannot be inspected before execution'); }
  for (const line of content.split(/\r?\n/)) {
    const p = line.trim();
    if (!p) continue;
    const d = checkPath(p, cwd, boundary);
    if (d) return d;
  }
  return null;
}

/**
 * Check a whole command line (bash family). `cwd` is where the command starts; a `cd` on the line moves the directory
 * for the commands after it, a subshell `( … )` keeps its `cd` to itself, and a here-document body is scanned for paths.
 */
export function checkBashCommand(command: string, cwd: string, boundary: Boundary, depth = 0, writeRoots: readonly string[] = [], scratchDir?: string, onWrite?: WriteSink): CommandDecision {
  const { stripped, bodies } = extractHeredocs(command);
  for (const body of bodies) { const d = scanTextForPaths(body, cwd, boundary); if (d) return d; }
  const nodes = toNodes(knownScratch(tokenize(stripped), scratchDir));
  const canonicalWriteRoots = writeRoots.map((root) => canonicalKey(root, root));
  const cwdStack = [cwd];
  const top = () => cwdStack[cwdStack.length - 1]!;
  let pipedInto = false;
  let prevCmd: { words: Token[]; cwd: string } | null = null;
  for (const node of nodes) {
    if (node.kind === 'op') {
      if (node.op === '(') cwdStack.push(top());
      else if (node.op === ')') { if (cwdStack.length > 1) cwdStack.pop(); prevCmd = null; pipedInto = false; }
      else if (node.op === '|' || node.op === '|&') { pipedInto = true; continue; }
      else { prevCmd = null; pipedInto = false; }
      continue;
    }
    const runningCwd = top();
    if (runningCwd === CWD_UNTRACKABLE) {
      // The working directory is unknown after `cd -` / `popd`. Only an explicit directory change can recover it.
      const firstWord = node.words.find((w) => w.kind === 'word');
      const cmd = firstWord ? commandName(firstWord.text) : '';
      if (cmd !== 'cd' && cmd !== 'pushd') return undeterminable('a directory this guardrail can no longer follow (after cd - or popd)');
    }
    if (node.words.some((w) => w.substitution)) return undeterminable('a command substitution');
    const { decision, cwd: next } = checkSimpleCommand(node.words, runningCwd, boundary, { pipedInto, prevCmd, depth, writeRoots: canonicalWriteRoots, scratchDir, onWrite });
    if (decision && !decision.ok) return decision;
    cwdStack[cwdStack.length - 1] = next;
    prevCmd = { words: node.words, cwd: runningCwd };
    pipedInto = false;
  }
  return OK;
}

/**
 * PowerShell command boundary. PowerShell's own dynamic forms ($(...), backticks, subexpressions, Invoke-Expression)
 * are refused outright; the attached `-Param:value` form is split so its value is checked; otherwise path-looking
 * tokens are checked. pi runs bash by default, so this is the conservative fallback for the powershell tool.
 *
 * The line is read with its backslashes as they are, and the braces of a script block as words of their own, so the
 * command inside a block is judged like any other (`checkWrapped`). `&` calls what follows it: a command there that a
 * variable names cannot be known.
 */
export function checkPowerShellCommand(command: string, cwd: string, boundary: Boundary, writeRoots: readonly string[] = [], scratchDir?: string, onWrite?: WriteSink): CommandDecision {
  if (/\$\(|`|\biex\b|\bInvoke-Expression\b/i.test(command)) return undeterminable('a PowerShell subexpression or Invoke-Expression');
  const tokens = knownScratch(tokenize(command, true), scratchDir).flatMap((t): Token[] => {
    const braces = t.kind === 'word' ? /^(\{*)([^]*?)(\}*)$/.exec(t.text) : null;
    if (!braces || (!braces[1] && !braces[3])) return [t];
    return [...[...braces[1]!].map(() => wordToken('{')), ...(braces[2] ? [{ ...t, text: braces[2] }] : []), ...[...braces[3]!].map(() => wordToken('}'))];
  });
  for (const t of tokens) {
    if (t.kind !== 'word') continue;
    const attached = /^-[A-Za-z]+:(.+)$/.exec(t.text);        // -Path:'C:\…' attaches the value to the parameter
    if (attached) {
      if (t.substitution || t.dynamic) return undeterminable('a computed PowerShell parameter');
      const d = checkPath(attached[1]!, cwd, boundary);
      if (d) return d;
    }
  }
  const nodes = toNodes(tokens);
  let pipedInto = false;
  let prevCmd: { words: Token[]; cwd: string } | null = null;
  let called = false;
  for (const node of nodes) {
    if (node.kind === 'op') { pipedInto = node.op === '|' || node.op === '|&'; called = node.op === '&'; if (!pipedInto) prevCmd = null; continue; }
    if (called && node.words[0]?.dynamic) return undeterminable('a command named by a variable');
    const { decision } = checkSimpleCommand(node.words, cwd, boundary, { pipedInto, prevCmd, depth: 0, writeRoots: writeRoots.map((root) => canonicalKey(root, root)), scratchDir, onWrite, powershell: true });
    if (decision && !decision.ok) return decision;
    prevCmd = { words: node.words, cwd };
    pipedInto = false;
    called = false;
  }
  return OK;
}

export function checkShellCommand(shell: 'bash' | 'powershell', command: string, cwd: string, boundary: Boundary, writeRoots: readonly string[] = [], scratchDir?: string, onWrite?: WriteSink): CommandDecision {
  return shell === 'powershell' ? checkPowerShellCommand(command, cwd, boundary, writeRoots, scratchDir, onWrite) : checkBashCommand(command, cwd, boundary, 0, writeRoots, scratchDir, onWrite);
}

/** Locations actually resolved by the preflight, plus the shell's starting directory. The write
 * journal uses these same decisions instead of guessing paths with a second parser. */
export interface ShellCommandPlan {
  readonly decision: CommandDecision;
  readonly locations: readonly string[];
  readonly explicitPaths: readonly string[];
  /** The places the command says it writes (see the header), as canonical keys: on a live project the write guard
   *  undoes only changes at or under these (BQ). */
  readonly writePaths: readonly string[];
}

export function planShellCommand(
  shell: 'bash' | 'powershell', command: string, cwd: string, boundary: Boundary,
  writeRoots: readonly string[], scratchDir: string, excludedRoots: readonly string[] = [],
): ShellCommandPlan {
  const start = canonicalKey(cwd, cwd);
  const excluded = excludedRoots.map((path) => canonicalKey(path, path));
  const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
  const explicit = new Set<string>();
  const observed: Boundary = {
    decide(path, from) {
      const key = canonicalKey(path, from);
      explicit.add(key);
      if (excluded.some((root) => within(key, root))) {
        return { ok: false, reason: `Refused: ${path} is an Excluded project location and is outside Keeper's shell boundary.` };
      }
      if (key.split(sep).includes('.git')) {
        return { ok: false, reason: `Refused: ${path} is Git metadata; shell cannot change it.` };
      }
      return boundary.decide(path, from);
    },
    describe: () => boundary.describe(),
  };
  const writes = new Set<string>();
  const decision = excluded.some((root) => within(start, root))
    ? refuse(cwd, 'the shell starts in an Excluded project location.')
    : checkShellCommand(shell, command, cwd, observed, writeRoots, scratchDir, (path, from) => { writes.add(canonicalKey(path, from)); });
  return { decision, locations: [...new Set([start, ...explicit])], explicitPaths: [...explicit], writePaths: [...writes] };
}
