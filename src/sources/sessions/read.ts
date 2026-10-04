/**
 * Read native Claude Code and Codex session logs into segments (Spec §1.2 "一段会话").
 *
 * A segment is a run of messages with no long pause between them; its excerpt is a compact
 * transcript: the owner's messages in full (they are owner statements), the assistant's
 * text trimmed, tool calls as one-line summaries, tool results left out (they echo what the
 * tool read, which is not what the session said). The native log stays where it is; the
 * anchor points back to message positions.
 *
 * Only what the owner typed is shown as the owner (Spec §1.3, §3.3 "原话整理"). A user-role record is also where the
 * host puts tool results, reminders, command wrappers and their output, background-task notices, the summary written
 * when the context was compacted, and — in a subagent's branch — the parent agent's task; Codex puts the project's
 * instruction files and the environment there. None of those is the owner speaking. A prompt the owner typed while the
 * agent was still working is recorded by Claude Code as a queued command, not as a user record, and is the owner's.
 */
import { readFileSync } from 'node:fs';
import type { Source } from '../../model/types.ts';
import type { SessionHost } from '../../model/vocab.ts';
import { extractIds, makeSessionSource } from '../anchor.ts';
import type { LocatedSession } from './locate.ts';

export interface SessionMessage {
  readonly index: number;
  readonly role: 'user' | 'assistant';
  readonly at: string | null;
  readonly text: string;
  readonly tools: readonly string[];      // "Edit D:\x\y.ts", "Bash: npm test"
  readonly files: readonly string[];      // files written or edited
  readonly sidechain: boolean;
  readonly model: string | null;
  /**
   * A user-role message the owner did not type but that is worth keeping in the transcript — the owner interrupting
   * the agent — says so here; the owner's own messages leave it unset. A subagent's branch is `sidechain`.
   */
  readonly host?: string;
}

export interface ParsedSession {
  readonly host: SessionHost;
  readonly sessionId: string;
  readonly file: string;
  readonly cwd: string | null;
  readonly messages: readonly SessionMessage[];
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly brokenLines: number;
  readonly bytes: number;
  /** A non-interactive run (`codex exec`, a Claude Code SDK run): its prompts are usually written by a program or an agent. */
  readonly headless?: boolean;
}

/** Whether a user-role message is the owner's own words: not a subagent's branch, not something the host put there. */
export function isOwnerMessage(m: SessionMessage): boolean {
  return m.role === 'user' && !m.sidechain && m.host === undefined;
}

const ASSISTANT_TRIM = 900;
const SEGMENT_GAP_MS = 45 * 60 * 1000;
const SEGMENT_MAX_CHARS = 12_000;
const SEGMENT_MAX_MESSAGES = 60;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function summarizeTool(name: string, input: unknown): { line: string; file: string | null } {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const path = text(i.file_path) || text(i.path) || text(i.notebook_path);
  if (name === 'Bash' || name === 'PowerShell' || name === 'bash' || name === 'powershell' || name === 'shell' || name === 'local_shell_call') {
    const cmd = text(i.command) || text(i.cmd) || (Array.isArray(i.command) ? i.command.join(' ') : '');
    return { line: `${name}: ${cmd.slice(0, 160)}`, file: null };
  }
  if (['Write', 'Edit', 'NotebookEdit', 'write', 'edit', 'apply_patch'].includes(name)) return { line: `${name} ${path}`, file: path || null };
  if (['Read', 'read', 'Glob', 'Grep', 'grep', 'find', 'ls'].includes(name)) return { line: `${name} ${path || text(i.pattern) || text(i.query)}`.trim(), file: null };
  if (name === 'Task' || name === 'Agent') return { line: `${name}: ${text(i.description) || text(i.prompt).slice(0, 120)}`, file: null };
  return { line: `${name}${path ? ' ' + path : ''}`, file: null };
}

function isoOf(value: unknown): string | null {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value > 1e12 ? value : value * 1000).toISOString();
  return null;
}

/**
 * Blocks a host wraps around, or puts instead of, the owner's words. Claude Code: reminders, slash-command wrappers and
 * their output, shell-mode input and output, hook output, background-task notices, IDE context. Codex: the environment,
 * the project's instruction files, plugin and app context, the browser context, image wrappers, aborted-turn notices.
 */
const HARNESS_TAGS = [
  'environment_context', 'user_instructions', 'recommended_plugins', 'permissions_instructions', 'apps_instructions', 'collaboration_mode',
  'plugin_instructions', 'available_skills', 'skills', 'skills_instructions', 'system-reminder', 'command-name', 'command-message', 'command-args',
  'local-command-stdout', 'local-command-stderr', 'local-command-caveat', 'bash-input', 'bash-stdout', 'bash-stderr', 'user-prompt-submit-hook',
  'ide_opened_file', 'ide_selection', 'INSTRUCTIONS', 'task-notification', 'ci-monitor-event', 'persisted-output', 'in-app-browser-context',
  'app-context', 'image', 'turn_aborted', 'user_shell_command', 'context_window', 'multi_agent_mode', 'multi_agent_role', 'model_switch',
  'image_resize_notice',
];
const HARNESS_RE = new RegExp(`<(${HARNESS_TAGS.join('|')})(?:\\s[^>]*)?>[\\s\\S]*?</\\1>`, 'g');
/** What a host writes when the context was compacted: a summary of the conversation, never the owner's words. */
const COMPACTION_RE = /^(This session is being continued from a previous conversation|Another language model started to solve this problem)/;
/** The marker Claude Code leaves when the owner stops the agent: an act of the owner's, not words. */
const INTERRUPTION_RE = /^\[Request interrupted by user(?: for tool use)?\]\s*$/gm;

/** Remove blocks the host wraps around the owner's words (environment, plugin lists, reminders). */
function stripHarnessBlocks(t: string): string {
  return t.replace(HARNESS_RE, '').replace(/^# AGENTS\.md instructions(?: for [^\n]*)?\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Strip system-reminder / harness wrappers that Claude Code embeds in user messages. */
function cleanUserText(t: string): string {
  return stripHarnessBlocks(t);
}

/**
 * The owner's words in a user-role text, or how the host is to be shown instead: null when nothing of the owner's is
 * left (a compaction summary, a message that was only wrapping), `{ host }` for an interruption marker on its own.
 */
function userSpeech(raw: string): { text: string; host?: string } | null {
  const cleaned = cleanUserText(raw);
  if (!cleaned || COMPACTION_RE.test(cleaned)) return null;
  const words = cleaned.replace(INTERRUPTION_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!words) return { text: cleaned, host: 'the owner interrupted the agent' };
  return { text: words };
}

/** The text blocks of a Claude Code content value (a string, or blocks of which only the text ones are words). */
function textOf(content: unknown): { text: string; toolResultOnly: boolean } {
  if (typeof content === 'string') return { text: content, toolResultOnly: false };
  if (!Array.isArray(content)) return { text: '', toolResultOnly: false };
  const parts: string[] = [];
  let toolResult = false;
  for (const block of content as Record<string, unknown>[]) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'tool_result') toolResult = true;
  }
  return { text: parts.join('\n'), toolResultOnly: toolResult && parts.length === 0 };
}

export function parseClaudeSession(file: string): ParsedSession {
  const raw = readFileSync(file, 'utf8');
  const messages: SessionMessage[] = [];
  let broken = 0;
  let sessionId = file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '');
  let cwd: string | null = null;
  let entrypoint: string | null = null;
  let index = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; } catch { broken += 1; continue; }
    const type = rec.type;
    if (type !== 'user' && type !== 'assistant' && type !== 'attachment') continue;
    if (typeof rec.sessionId === 'string') sessionId = rec.sessionId;
    if (typeof rec.cwd === 'string' && !cwd) cwd = rec.cwd;
    if (typeof rec.entrypoint === 'string' && !entrypoint) entrypoint = rec.entrypoint;
    const sidechain = rec.isSidechain === true;
    const at = isoOf(rec.timestamp);
    if (type === 'attachment') {
      // A prompt the owner typed while the agent was working reaches the conversation as a queued command.
      const a = rec.attachment as Record<string, unknown> | undefined;
      const origin = a?.origin as { kind?: string } | undefined;
      if (a?.type !== 'queued_command' || a.commandMode !== 'prompt' || (origin && origin.kind !== 'human')) continue;
      const speech = userSpeech(textOf(a.prompt).text);
      if (!speech || speech.host) continue;
      messages.push({ index, role: 'user', at: at ?? isoOf(a.timestamp), text: speech.text, tools: [], files: [], sidechain, model: null });
      index += 1;
      continue;
    }
    const message = rec.message as Record<string, unknown> | undefined;
    if (!message) continue;
    if (type === 'user') {
      // Reminders and skill text the host injects (isMeta), the summary written at a compaction, and prompts of any
      // origin but the owner's (background-task notices) are not the owner speaking.
      if (rec.isMeta === true || rec.isCompactSummary === true) continue;
      const origin = rec.origin as { kind?: string } | undefined;
      if (origin && typeof origin.kind === 'string' && origin.kind !== 'human') continue;
      const { text: body, toolResultOnly } = textOf(message.content);
      if (toolResultOnly) continue;   // tool echoes, not owner speech
      const speech = userSpeech(body);
      if (!speech) continue;
      messages.push({ index, role: 'user', at, text: speech.text, tools: [], files: [], sidechain, model: null, ...(speech.host && !sidechain ? { host: speech.host } : {}) });
      index += 1;
      continue;
    }
    const parts: string[] = [];
    const tools: string[] = [];
    const files: string[] = [];
    if (typeof message.content === 'string') parts.push(message.content);
    else if (Array.isArray(message.content)) {
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
        else if (block.type === 'tool_use') {
          const s = summarizeTool(text(block.name) || '?', block.input);
          tools.push(s.line);
          if (s.file) files.push(s.file);
        }
      }
    }
    const body = parts.join('\n').trim();
    if (body.length === 0 && tools.length === 0) continue;
    messages.push({ index, role: 'assistant', at, text: body, tools, files, sidechain, model: typeof message.model === 'string' ? message.model : null });
    index += 1;
  }
  return {
    host: 'claude', sessionId, file, cwd, messages, startedAt: messages[0]?.at ?? null, endedAt: messages[messages.length - 1]?.at ?? null,
    brokenLines: broken, bytes: Buffer.byteLength(raw), headless: entrypoint !== null && /^sdk/i.test(entrypoint),
  };
}

export function parseCodexSession(file: string): ParsedSession {
  const raw = readFileSync(file, 'utf8');
  const messages: SessionMessage[] = [];
  let broken = 0;
  let sessionId = file.split(/[\\/]/).pop()!.replace(/^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-/, '').replace(/\.jsonl$/, '');
  let cwd: string | null = null;
  let sub = false;
  let headless = false;
  let metaSeen = false;
  let index = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; } catch { broken += 1; continue; }
    const payload = rec.payload as Record<string, unknown> | undefined;
    if (!payload) continue;
    const at = isoOf(rec.timestamp);
    if (rec.type === 'session_meta') {
      // The first header is this session's; a later one (a fork's copied history) does not change who is speaking.
      if (metaSeen) continue;
      metaSeen = true;
      if (typeof payload.id === 'string') sessionId = payload.id;
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      const source = payload.source;
      if (payload.thread_source === 'subagent' || source === 'subagent' || (source !== null && typeof source === 'object' && 'subagent' in (source as object))) sub = true;
      if (source === 'exec' || (typeof payload.originator === 'string' && /exec/i.test(payload.originator))) headless = true;
      continue;
    }
    if (rec.type !== 'response_item') continue;
    const itemType = payload.type;
    if (itemType === 'function_call' || itemType === 'local_shell_call' || itemType === 'custom_tool_call') {
      const name = text(payload.name) || String(itemType);
      let args: unknown = payload.arguments ?? payload.input;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { command: args }; } }
      const s = summarizeTool(name, args);
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        messages[messages.length - 1] = { ...last, tools: [...last.tools, s.line], files: s.file ? [...last.files, s.file] : last.files };
      } else {
        messages.push({ index, role: 'assistant', at, text: '', tools: [s.line], files: s.file ? [s.file] : [], sidechain: sub, model: null });
        index += 1;
      }
      continue;
    }
    if (itemType !== 'message') continue;
    const role = payload.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = payload.content;
    const parts: string[] = [];
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) for (const p of content as Record<string, unknown>[]) { const t = text(p.text) || text(p.input_text) || text(p.output_text); if (t) parts.push(t); }
    const body = parts.join('\n').trim();
    if (!body) continue;
    if (role === 'user') {
      // Codex wraps harness context in tags and puts the instruction files and the environment in user messages; keep
      // the owner's own words, and nothing of a compaction summary.
      const speech = userSpeech(body);
      if (!speech) continue;
      messages.push({ index, role, at, text: speech.text, tools: [], files: [], sidechain: sub, model: null, ...(speech.host && !sub ? { host: speech.host } : {}) });
    } else {
      messages.push({ index, role, at, text: body, tools: [], files: [], sidechain: sub, model: null });
    }
    index += 1;
  }
  return { host: 'codex', sessionId, file, cwd, messages, startedAt: messages[0]?.at ?? null, endedAt: messages[messages.length - 1]?.at ?? null, brokenLines: broken, bytes: Buffer.byteLength(raw), headless };
}

export function parseSession(located: LocatedSession): ParsedSession {
  return located.host === 'codex' ? parseCodexSession(located.file) : parseClaudeSession(located.file);
}

export interface Segment {
  readonly messageStart: number;
  readonly messageEnd: number;
  readonly at: string | null;
  readonly endAt: string | null;
  readonly excerpt: string;
  readonly ownerTurns: number;
  readonly assistantTurns: number;
  readonly filesTouched: readonly string[];
}

function renderMessage(m: SessionMessage): string {
  const time = m.at ? m.at.slice(0, 16).replace('T', ' ') : '';
  const trim = (t: string) => (t.length > ASSISTANT_TRIM ? `${t.slice(0, ASSISTANT_TRIM)}…` : t);
  if (m.role === 'user') {
    // Only the owner's own words are shown as the owner's: a subagent's task comes from the agent that sent it.
    if (m.sidechain) return `[${m.index}] SUBAGENT TASK ${time}\n${trim(m.text)}`;
    if (m.host !== undefined) return `[${m.index}] HOST ${time}\n(${m.host})`;
    return `[${m.index}] OWNER ${time}\n${m.text}`;
  }
  const body = trim(m.text);
  const tools = m.tools.length ? `\n  tools: ${m.tools.slice(0, 12).join(' | ')}${m.tools.length > 12 ? ` | +${m.tools.length - 12} more` : ''}` : '';
  return `[${m.index}] ${m.sidechain ? 'SUBAGENT' : 'AGENT'}${m.model ? ` (${m.model})` : ''} ${time}${body ? `\n${body}` : ''}${tools}`;
}

/** Cut a session into segments by pauses and size. Every message lands in exactly one segment. */
export function segmentSession(session: ParsedSession): Segment[] {
  const segments: Segment[] = [];
  let buf: SessionMessage[] = [];
  let size = 0;
  const flush = () => {
    if (buf.length === 0) return;
    const excerpt = buf.map(renderMessage).join('\n\n');
    segments.push({
      messageStart: buf[0]!.index, messageEnd: buf[buf.length - 1]!.index, at: buf[0]!.at, endAt: buf[buf.length - 1]!.at, excerpt,
      ownerTurns: buf.filter(isOwnerMessage).length, assistantTurns: buf.filter((m) => m.role === 'assistant').length,
      filesTouched: [...new Set(buf.flatMap((m) => m.files))].sort(),
    });
    buf = [];
    size = 0;
  };
  let lastAt: number | null = null;
  for (const m of session.messages) {
    const t = m.at ? Date.parse(m.at) : null;
    const gap = t !== null && lastAt !== null ? t - lastAt : 0;
    const rendered = renderMessage(m).length;
    if (buf.length > 0 && (gap > SEGMENT_GAP_MS || size + rendered > SEGMENT_MAX_CHARS || buf.length >= SEGMENT_MAX_MESSAGES) && m.role === 'user') flush();
    else if (buf.length > 0 && size + rendered > SEGMENT_MAX_CHARS * 1.4) flush();
    buf.push(m);
    size += rendered + 2;
    if (t !== null) lastAt = t;
  }
  flush();
  return segments;
}

export function sessionSources(projectId: string, located: LocatedSession, scopeItemId: string): { sources: Source[]; parsed: ParsedSession } {
  const parsed = parseSession(located);
  const sources = segmentSession(parsed).map((seg, i, all) => makeSessionSource({
    projectId, host: located.host, sessionId: parsed.sessionId, file: located.file, cwd: parsed.cwd,
    messageStart: seg.messageStart, messageEnd: seg.messageEnd, at: seg.at, excerpt: seg.excerpt,
    title: `${located.host === 'claude' ? 'Claude Code' : 'Codex'} session ${parsed.sessionId.slice(0, 8)}${all.length > 1 ? ` · segment ${i + 1}/${all.length}` : ''}${seg.at ? ` · ${seg.at.slice(0, 10)}` : ''}`,
    scopeItemId, ids: extractIds(seg.excerpt),
  }));
  return { sources, parsed };
}
