/**
 * Source identity and credential redaction shared by every reader (files, sessions, git).
 */
import type { FileAnchor, SessionAnchor, Source, SourceAnchor } from '../model/types.ts';
import { fingerprint, stableId } from '../model/ids.ts';
import { pathKey } from '../util/paths.ts';

export function fileSourceId(path: string, headingPath: readonly string[]): string {
  return stableId('src', 'file', pathKey(path), headingPath.join(' / '));
}

export function sessionSourceId(host: string, sessionId: string, messageStart: number): string {
  return stableId('src', 'session', host, sessionId, messageStart);
}

export function commitSourceId(repo: string, commit: string): string {
  return stableId('src', 'commit', pathKey(repo), commit);
}

/** A file as it was at a commit (§1.2 `History only`): one source per repository, commit and path. */
export function revisionSourceId(repo: string, commit: string, path: string): string {
  return stableId('src', 'revision', pathKey(repo), commit, path.split('\\').join('/'));
}

export function anchorId(anchor: SourceAnchor): string {
  switch (anchor.kind) {
    case 'file': return fileSourceId(anchor.path, anchor.headingPath);
    case 'session': return sessionSourceId(anchor.host, anchor.sessionId, anchor.messageStart);
    case 'commit': return commitSourceId(anchor.repo, anchor.commit);
    case 'command': return stableId('src', 'command', anchor.cwd, anchor.command, anchor.ranAt);
    case 'status': return stableId('src', 'status', anchor.description, anchor.at);
    case 'revision': return revisionSourceId(anchor.repo, anchor.commit, anchor.path);
  }
}

/** Human-readable locator, e.g. `design/DECISIONS.md › 一 · 已定 › D14 (L102–L107)`. */
export function anchorLabel(anchor: SourceAnchor): string {
  switch (anchor.kind) {
    case 'file': {
      const heading = anchor.headingPath.length ? ` › ${anchor.headingPath.join(' › ')}` : '';
      return `${anchor.path}${heading} (L${anchor.lineStart}–L${anchor.lineEnd})`;
    }
    case 'session': return `${anchor.host} session ${anchor.sessionId.slice(0, 8)} · messages ${anchor.messageStart}–${anchor.messageEnd}${anchor.at ? ` · ${anchor.at}` : ''}`;
    case 'commit': return `${anchor.repo} @ ${anchor.commit.slice(0, 10)}`;
    case 'command': return `${anchor.command} (in ${anchor.cwd}, ${anchor.ranAt})`;
    case 'status': return `${anchor.description} (${anchor.at})`;
    case 'revision': return `${anchor.path} @ ${anchor.commit.slice(0, 10)} in ${anchor.repo} (version history)`;
  }
}

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{16,})/g,                                   // OpenAI-style keys
  /\b(sk-ant-[A-Za-z0-9_-]{16,})/g,
  /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,        // GitHub tokens
  /\b(AKIA[0-9A-Z]{16})\b/g,                                        // AWS access key id
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})/g,                               // Slack
  /\b(AIza[0-9A-Za-z_-]{30,})/g,                                     // Google API key
  /((?:api[_-]?key|apikey|secret|token|password|passwd|authorization)\s*[:=]\s*["']?)([A-Za-z0-9_\-./+=]{12,})/gi,
  /(Bearer\s+)([A-Za-z0-9_\-.=]{20,})/g,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, // JWT
];

export const REDACTED = '[credential redacted]';

/** Replace credential values with a marker; the fact that a credential is there stays visible (§3.1). */
export function redactCredentials(text: string): { text: string; found: boolean } {
  let found = false;
  let out = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    out = out.replace(pattern, (...args: unknown[]) => {
      found = true;
      // The replacer gets the match, the capture groups, then the offset and the whole input: only the groups count.
      // Counting the input as a group kept every token-shaped credential (sk-…, ghp_…, AKIA…) in the text.
      const groups = args.slice(1, args.findIndex((a, i) => i > 0 && typeof a === 'number'));
      const captured = groups.filter((g): g is string => typeof g === 'string');
      if (captured.length >= 2) return `${captured[0]}${REDACTED}`;
      return REDACTED;
    });
  }
  return { text: out, found };
}

export function makeFileSource(input: {
  projectId: string; path: string; headingPath: readonly string[]; lineStart: number; lineEnd: number;
  excerpt: string; fileText: string; scopeItemId: string; title?: string; ids?: readonly string[];
  commit?: string | null; readAt?: string; tableRow?: number;
}): Source {
  const anchor: FileAnchor = {
    kind: 'file', path: input.path, headingPath: input.headingPath, lineStart: input.lineStart,
    lineEnd: input.lineEnd, ...(input.tableRow === undefined ? {} : { tableRow: input.tableRow }),
  };
  const redacted = redactCredentials(input.excerpt);
  return {
    id: fileSourceId(input.path, input.headingPath), projectId: input.projectId,
    title: input.title ?? (input.headingPath.length ? input.headingPath[input.headingPath.length - 1]! : input.path.split(/[\\/]/).pop()!),
    anchor, ids: input.ids ?? [],
    version: { fingerprint: fingerprint(input.fileText), readAt: input.readAt ?? new Date().toISOString(), commit: input.commit ?? null },
    excerpt: redacted.text, usedAs: null, usedAsBy: null, availability: null, movedTo: null,
    scopeItemId: input.scopeItemId, hasCredential: redacted.found, bytes: Buffer.byteLength(input.excerpt, 'utf8'),
  };
}

export function makeSessionSource(input: {
  projectId: string; host: SessionAnchor['host']; sessionId: string; file: string; cwd: string | null;
  messageStart: number; messageEnd: number; at: string | null; excerpt: string; title: string;
  scopeItemId: string; ids?: readonly string[]; readAt?: string;
}): Source {
  const anchor: SessionAnchor = {
    kind: 'session', host: input.host, sessionId: input.sessionId, file: input.file, cwd: input.cwd,
    messageStart: input.messageStart, messageEnd: input.messageEnd, at: input.at,
  };
  const redacted = redactCredentials(input.excerpt);
  return {
    id: sessionSourceId(input.host, input.sessionId, input.messageStart), projectId: input.projectId,
    title: input.title, anchor, ids: input.ids ?? [],
    version: { fingerprint: fingerprint(input.excerpt), readAt: input.readAt ?? new Date().toISOString(), commit: null },
    excerpt: redacted.text, usedAs: null, usedAsBy: null, availability: null, movedTo: null,
    scopeItemId: input.scopeItemId, hasCredential: redacted.found, bytes: Buffer.byteLength(input.excerpt, 'utf8'),
  };
}

/** Numbers the material itself uses: DEC-020, TASK-7.2, CKC-01, REQ-3, #18, D14, PA-6 … */
export function extractIds(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z]{2,6}-\d{1,3}(?:\.\d{1,3})?)\b/g)) out.add(m[1]!);
  for (const m of text.matchAll(/(?<![\w-])(#\d{1,5})\b/g)) out.add(m[1]!);
  for (const m of text.matchAll(/(?<![A-Za-z])(D\d{1,2}|PA-\d{1,2}|U\d{1,2}|S\d{1,2}|G\d)(?![\w.])/g)) out.add(m[1]!);
  return [...out].sort();
}
