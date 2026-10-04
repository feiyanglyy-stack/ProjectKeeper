/**
 * What `Copy for agent` puts on the clipboard for a send-back (Spec §1.18, §7.10; CKC-24 AC-9; D79): where the problem
 * is, the evidence — numbers, commits, files and lines, the report's own line word for word — where it should go back
 * to, and the CLI command that shows the same send-back. The owner pastes it to an execution agent or an orchestrator;
 * the agent runs the command and sees the same record the owner sees.
 *
 * Built only from the record and its resolved evidence: nothing here reads the assets, and nothing the model wrote
 * becomes a date or a label (§2.11). Credential values never leave in it (§3.1).
 */
import type { EvidenceRef, Occurred, SendBack } from '../model/k-types.ts';
import { materialDate } from '../model/time.ts';
import { redactCredentials } from '../sources/anchor.ts';

/** The command an execution agent runs to see the same send-back (§7.10): the CLI's `pk get <id>`. */
export function cliCommandFor(projectId: string, id: string): string {
  const quote = (v: string) => (/^[A-Za-z0-9._:-]+$/.test(v) ? v : `"${v.replace(/"/g, '\\"')}"`);
  return `pk get ${quote(id)} --project ${quote(projectId)}`;
}

const BASIS_WORDS: Record<Occurred['basis'], string> = {
  Commit: 'committed',
  Session: 'said',
  'Written in text': 'dated in the text',
  'File time': 'file time',
  'First observed': 'first seen',
};

/** When a piece of evidence happened, as the text says it: "committed 2026-09-12", "undated · first seen 2026-09-26". */
export function occurredText(o: Occurred | null | undefined): string | null {
  if (!o) return null;
  const main = o.undated ? `undated · first seen ${materialDate(o.at)}` : `${BASIS_WORDS[o.basis] ?? o.basis} ${materialDate(o.at)}`;
  return o.other ? `${main} · ${BASIS_WORDS[o.other.basis] ?? o.other.basis} ${materialDate(o.other.at)}` : main;
}

const KIND_WORDS: Record<EvidenceRef['kind'], string> = { commit: 'Commit', file: 'File', source: 'Source', ledger: 'Ledger', object: 'Record' };

/** One piece of evidence: what it is (and in which repository, outside the first), when it happened, the original line. */
function evidenceLine(e: EvidenceRef): string {
  const named = e.kind === 'object' ? `${e.label} (${e.id})` : e.label;
  const what = e.repo && !named.includes(e.repo) ? `${named} in ${e.repo}` : named;
  const when = occurredText(e.occurred);
  const head = `- ${KIND_WORDS[e.kind]} ${what}${when ? ` (${when})` : ''}`;
  if (!e.line) return head;
  const lines = e.line.split(/\r?\n/);
  // One line stays on the entry; a cited stretch of several lines keeps its lines, each quoted.
  return lines.length === 1 ? `${head}: “${e.line}”` : `${head}:\n${lines.map((l) => `  > ${l}`).join('\n')}`;
}

const FROM_WORDS: Record<SendBack['from']['kind'], string> = {
  breakpoint: 'a breakpoint in the process',
  verdict: 'a QC, review or walkthrough verdict',
  'owner-judgement': 'one of the things the owner judges',
  'code-anomaly': 'a code territory anomaly',
};

export interface CopyForAgentOptions {
  /** The object it hangs on, by name and the project's number (or the Keeper's), when the caller knows them. */
  readonly target?: { readonly label: string; readonly number?: string | null } | null;
}

/**
 * The text `Copy for agent` puts on the clipboard. `resolvedEvidence` is the send-back's evidence as it resolves now
 * (normally its own `evidence`).
 */
export function copyForAgentText(projectId: string, sendBack: SendBack, resolvedEvidence: readonly EvidenceRef[] = sendBack.evidence, options: CopyForAgentOptions = {}): string {
  const target = options.target;
  const on = target ? `${target.number ? `${target.number} ` : ''}${target.label} (${sendBack.targetId})` : sendBack.targetId;
  const back = sendBack.to === 'Work'
    ? `Send it back to Work — reopen the work or open new work: ${sendBack.suggestion}`
    : `Send it back to Plan — change the plan or the document: ${sendBack.suggestion}`;
  const since = occurredText(sendBack.occurred);
  const lines = [
    `Send-back ${sendBack.id} · ${sendBack.stage} · to ${sendBack.to} (project ${projectId})`,
    `Where the problem is: ${sendBack.what}`,
    `On: ${on}`,
    `Found as: ${FROM_WORDS[sendBack.from.kind]} (${sendBack.from.id})${since ? ` · happened: ${since}` : ''}`,
    'Evidence:',
    ...(resolvedEvidence.length ? resolvedEvidence.map(evidenceLine) : ['- none recorded']),
    back,
    `See the same send-back: ${cliCommandFor(projectId, sendBack.id)}`,
  ];
  return redactCredentials(lines.join('\n')).text;
}
