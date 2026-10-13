/**
 * `pk sessions`: the session material a takeover's first step reads the owner's words from (template/FILLING-IN.md).
 * Every owner message of the project's agent sessions, oldest first, each after the agent's last answer it replies to,
 * written twice: `session-material.md` for the agent that fills `ownerWants`, `session-material.jsonl` for `pk check`
 * and `pk import` to hold its citations to (check.ts `readSessionMaterial`). A session is named `host:session id` and a
 * message by the ledger's number for it, which is how the table cites one: { "session": "claude:…", "message": 12 }.
 *
 * Read from the project's ledger, which already keeps the owner's messages and the agent messages they answer, redacted
 * as they were recorded; nothing more is redacted here. Headless runs are left out: their prompt is a program's, not the
 * owner's. The material carries the owner's words and whatever else was said in the sessions, so it is written into
 * ProjectKeeper's own folder for the project and never into the project, which may be a public repository (D107).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Ledger, MessageRow } from '../ledger/index.ts';
import { projectDir as homeProjectDir, tableDir } from '../store/paths.ts';
import { canonicalPath, isWithin } from '../util/paths.ts';
import { withTableProject } from './project-home.ts';

export const MARKDOWN_FILE = 'session-material.md';
export const JSONL_FILE = 'session-material.jsonl';

/** One record of the JSONL: what `pk check` reads (check.ts `SessionMessage`) and who said it. */
export interface SessionRecord {
  readonly session: string;
  readonly message: number;
  readonly role: 'agent' | 'owner';
  readonly text: string;
}

export interface SessionMaterialCounts {
  /** Owner messages written. */
  readonly ownerMessages: number;
  /** JSONL records: the owner messages and the agent answers before them. */
  readonly records: number;
  /** Sessions with at least one owner message written. */
  readonly sessions: number;
}

/** An owner message as the ledger's ownerWords query gives it: with its session's host and id, and the answer before it. */
export type OwnerRow = MessageRow & { readonly host: string; readonly sessionId: string };

/** The name the material and the table give a session: `host:session id`. */
export const sessionName = (r: Pick<OwnerRow, 'host' | 'sessionId'>): string => `${r.host}:${r.sessionId}`;

/** `2026-09-20 01:00 UTC` for a recorded time; a message the log gave no time keeps saying so. */
function when(row: MessageRow): string {
  if (row.occurred.undated) return 'time not recorded';
  const ms = Date.parse(row.occurred.at);
  return Number.isNaN(ms) ? row.occurred.at : `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Every owner message of the ledger outside headless runs, oldest first (by time, then session, then number); with
 * `since`, those from then on (the table follow-up's new messages since the table was filled in, D107).
 */
export function ownerMessages(ledger: Ledger, since?: string | null): OwnerRow[] {
  const rows: OwnerRow[] = [];
  for (let offset: number | null = 0; offset !== null;) {
    const page = ledger.ownerWords({ offset, limit: 500, ...(since ? { since } : {}) });
    if (typeof page === 'string') throw new Error(page);   // only a named session can fail, and none is named
    rows.push(...(page.rows as OwnerRow[]));
    offset = page.next;
  }
  const key = (r: OwnerRow) => (r.occurred.undated ? Number.POSITIVE_INFINITY : Date.parse(r.occurred.at));
  const name = sessionName;
  return rows.sort((a, b) => key(a) - key(b) || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0) || a.index - b.index);
}

/** The JSONL records of owner messages: each agent answer before an owner message, then the message; each once. */
export function materialRecords(owners: readonly OwnerRow[]): SessionRecord[] {
  const records: SessionRecord[] = [];
  const written = new Set<string>();
  const record = (r: SessionRecord) => {
    const key = `${r.session}#${r.message}`;
    if (written.has(key)) return;
    written.add(key);
    records.push(r);
  };
  for (const m of owners) {
    const session = sessionName(m);
    if (m.answers) record({ session, message: m.answers.index, role: 'agent', text: m.answers.text ?? '' });
    record({ session, message: m.index, role: 'owner', text: m.text ?? '' });
  }
  return records;
}

/**
 * Write the session material of a project's ledger into `outDir`: the Markdown an agent reads and the JSONL the checks
 * read. Returns what was written.
 */
export function exportSessionMaterial(ledger: Ledger, outDir: string): SessionMaterialCounts & { readonly markdown: string; readonly jsonl: string } {
  const owners = ownerMessages(ledger);
  const md: string[] = [
    '# Session material',
    '',
    'The owner\'s messages in the project\'s agent sessions, oldest first. Each owner message comes after the agent\'s last answer it replies to (its text only: the tool calls are left out). '
      + 'Cite a message as { "session": "<name>", "message": <number> }: the name is the first part of its heading and the number is the message\'s own.',
  ];
  const records = materialRecords(owners);
  const sessions = new Set<string>();
  for (const m of owners) {
    const session = sessionName(m);
    sessions.add(session);
    md.push('', `## ${session} · message ${m.index} · ${when(m)}`, '');
    const a = m.answers;
    if (a) md.push(`Agent, message ${a.index}:`, '', '<agent>', a.text ?? '', '</agent>', '');
    else md.push('(No agent answer before it: the session starts here.)', '');
    md.push(`Owner, message ${m.index}:`, '', '<owner>', m.text ?? '', '</owner>');
  }
  mkdirSync(outDir, { recursive: true });
  const markdown = join(outDir, MARKDOWN_FILE);
  const jsonl = join(outDir, JSONL_FILE);
  writeFileSync(markdown, `${md.join('\n')}\n`);
  writeFileSync(jsonl, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  return { ownerMessages: owners.length, records: records.length, sessions: sessions.size, markdown, jsonl };
}

export interface SessionsOptions {
  /** The project folder. */
  readonly projectDir: string;
  /** The ProjectKeeper home; by default the user's. */
  readonly home?: string;
  /** The project's name when it is added; by default the folder's. */
  readonly name?: string;
  /** Where to write; by default `<home>/projects/<project id>/table`. Never inside the project (D107). */
  readonly out?: string;
}

export interface SessionsResult extends SessionMaterialCounts {
  readonly projectId: string;
  readonly projectName: string;
  readonly home: string;
  readonly added: boolean;
  readonly outDir: string;
  readonly markdown: string;
  readonly jsonl: string;
  readonly warnings: readonly string[];
}

/** Why an output folder inside the project is refused, in a sentence; null when it is outside every location. */
export function refusedOut(out: string, locations: readonly string[]): string | null {
  const dir = canonicalPath(out);
  const inside = locations.find((l) => isWithin(canonicalPath(l), dir));
  return inside === undefined ? null
    : `${dir} is inside the project folder ${inside}. The session material carries the owner's words and whatever else was said in the sessions, and the project may be a public repository, so it is written only outside the project: leave out --out to write it into ProjectKeeper's own folder for the project (D107).`;
}

/**
 * Open the project (found by its folder or added and read in; its ledger brought up to date; nothing organizing) and
 * write its session material. An output folder inside the project is refused before anything is opened.
 */
export async function exportProjectSessions(options: SessionsOptions): Promise<SessionsResult> {
  const projectDir = canonicalPath(options.projectDir);
  const out = options.out === undefined ? null : resolve(options.out);
  const refused = out ? refusedOut(out, [projectDir]) : null;
  if (refused) throw new Error(refused);
  return withTableProject({ projectDir, home: options.home, name: options.name ?? basename(projectDir) }, async ({ app, project, home, added, warnings }) => {
    // The project may have more locations than the folder given: the material lands in none of them.
    const elsewhere = out ? refusedOut(out, project.locations) : null;
    if (elsewhere) throw new Error(elsewhere);
    const ledger = app.ledger.ledger(project.id);
    if (!ledger) throw new Error(`The ledger of ${project.name} could not be built, so there are no sessions to export.${warnings.length ? ` ${warnings.join(' ')}` : ''}`);
    const outDir = out ?? tableDir(project.id, home);
    const written = exportSessionMaterial(ledger, outDir);
    return { projectId: project.id, projectName: project.name, home, added, outDir, warnings, ...written };
  });
}
