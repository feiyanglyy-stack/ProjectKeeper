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
import { readFileSync, statSync } from 'node:fs';
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

/** Tokenise a bash-family command line, tracking quoting, escapes, expansions and substitutions. */
export function tokenize(command: string): Token[] {
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
        if (s[i] === '\\' && '$`"\\\n'.includes(s[i + 1] ?? '')) { buf += s[i + 1]; i += 2; continue; }
        if (s[i] === '`') { substitution = true; buf += s[i]; i += 1; continue; }
        if (s[i] === '$' && s[i + 1] === '(') { substitution = true; buf += s[i]; i += 1; continue; }
        if (s[i] === '$') { dynamic = true; buf += s[i]; i += 1; continue; }
        buf += s[i]; i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '\\') { has = true; if (i + 1 < s.length) { buf += s[i + 1]; i += 2; } else i += 1; continue; }
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
const GIT_MUTATORS = new Set(['add', 'am', 'apply', 'bisect', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit', 'fetch', 'gc', 'init', 'maintenance', 'merge', 'mv', 'pull', 'push', 'rebase', 'repack', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch', 'update-index']);
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

/** Scan free text (a here-document body, an unknown script) for absolute or home path references. */
function scanTextForPaths(text: string, cwd: string, boundary: Boundary): CommandDecision | null {
  const re = /(?:\/(?:mnt\/|cygdrive\/)?[A-Za-z]\/[^\s'"`]*|[A-Za-z]:[\\/][^\s'"`]*|\\\\[^\s'"`]+|~[^\s'"`]*[\\/][^\s'"`]*)/g;
  for (const m of text.matchAll(re)) {
    const d = checkPath(m[0], cwd, boundary);
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
  const argv = words.slice(start);
  const trace = traceSwitch(words, start);
  if (trace) return { decision: trace, cwd };
  if (argv.length === 0) return { decision: null, cwd };
  const name = commandName(argv[0]!.text);
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
  if (followRe && argv.slice(1).some((w) => followRe.test(w.text))) {
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
 */
export function checkPowerShellCommand(command: string, cwd: string, boundary: Boundary, writeRoots: readonly string[] = [], scratchDir?: string, onWrite?: WriteSink): CommandDecision {
  if (/\$\(|`|\biex\b|\bInvoke-Expression\b/i.test(command)) return undeterminable('a PowerShell subexpression or Invoke-Expression');
  const tokens = knownScratch(tokenize(command), scratchDir);
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
  for (const node of nodes) {
    if (node.kind === 'op') { pipedInto = node.op === '|' || node.op === '|&'; if (!pipedInto) prevCmd = null; continue; }
    const { decision } = checkSimpleCommand(node.words, cwd, boundary, { pipedInto, prevCmd, depth: 0, writeRoots: writeRoots.map((root) => canonicalKey(root, root)), scratchDir, onWrite });
    if (decision && !decision.ok) return decision;
    prevCmd = { words: node.words, cwd };
    pipedInto = false;
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
