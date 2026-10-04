/** Text for the agent entry's increment K objects. The server hands these views to the CLI as-is. */
import type { CodeTerritory, EvidenceRef, Occurred, SemanticPatch } from '../model/k-types.ts';
import type { BreakpointView, CodeView, SendBackView, TerritoryView } from '../model/views-k.ts';
import { redactCredentials } from '../sources/anchor.ts';

function safe(text: string): string { return redactCredentials(text).text; }

export function occurredText(value: Occurred): string {
  if (value.undated) return `Undated · first seen ${value.at.slice(0, 10)}`;
  const one = (at: string, basis: string, anchor: string | null) => `${basis} ${at}${anchor ? ` (${anchor})` : ''}`;
  const primary = one(value.at, value.basis, value.anchor);
  return value.other ? `${primary} · ${one(value.other.at, value.other.basis, value.other.anchor)}` : primary;
}

function evidenceLines(evidence: readonly EvidenceRef[]): string[] {
  if (!evidence.length) return ['- None recorded'];
  return evidence.flatMap((e) => [
    `- ${e.kind} · ${e.label} (${e.id})${e.occurred ? ` · ${occurredText(e.occurred)}` : ''}`,
    ...(e.line == null ? [] : [`  Original line: ${e.line}`]),
  ]);
}

function finish(lines: (string | null)[]): string { return safe(lines.filter((line) => line !== null).join('\n')); }

export function breakpointBrief(view: BreakpointView, targetName: string): string {
  return finish([
    `# Breakpoint · ${view.kind} (${view.id})`,
    `Where: ${targetName} (${view.targetId})`,
    `What: ${view.why}`,
    `Status: ${view.lit ? 'Lit' : view.state === 'Candidate' ? 'Candidate (a lead, not a finding: it lights only after a lane looked for the step and the spot-check confirmed it)' : 'Out'}${view.ownerResponse ? ` · No action needed at ${view.ownerResponse.at}: ${view.ownerResponse.reason}` : ''}`,
    view.looked ? `Looked for, not found: ${view.looked.where.join('; ')} (${view.looked.at.slice(0, 10)})` : null,
    `Occurred: ${occurredText(view.since)} (next step became due)`,
    `Basis: ${view.basis}`,
    view.sixThing ? `Six thing: ${view.sixThing}` : null,
    view.sendBackId ? `Send-back: ${view.sendBackId}` : null,
    '', '## Evidence', ...evidenceLines(view.evidence),
  ]);
}

export function sendBackBrief(view: SendBackView, targetName: string): string {
  return finish([
    `# Send-back · ${view.id}`,
    `Where: ${targetName} (${view.targetId})`,
    `What: ${view.what}`,
    `Send back to: ${view.to} · ${view.suggestion}`,
    `Status: ${view.stage}${view.lit ? ' · Open' : ' · Not lit'}${view.ownerResponse ? ` · No action needed at ${view.ownerResponse.at}: ${view.ownerResponse.reason}` : ''}`,
    `Occurred: ${occurredText(view.occurred)}`,
    view.returned ? `Returned: ${view.returned.label} · ${occurredText(view.returned.occurred)}` : null,
    view.closed ? `Closed: ${view.closed.label} · ${occurredText(view.closed.occurred)}` : null,
    view.sixThing ? `Six thing: ${view.sixThing}` : null,
    '', '## Evidence', ...evidenceLines(view.evidence),
    '', '## Copy for agent', view.copyForAgent,
  ]);
}

export function patchBrief(patch: SemanticPatch, objectName: (id: string) => string): string {
  return finish([
    `# Semantic patch · ${patch.title} (${patch.number}; ${patch.id})`,
    `Where: ${patch.writtenToFolder ? patch.writtenToFolder.path : 'Workbench only; not written to the project folder'}`,
    `Status: ${patch.status}${patch.partial ? ' · Partial replacement' : ''}`,
    `Occurred: ${occurredText(patch.occurred)}`,
    `Invalidated: ${patch.invalidated}`,
    `Replaced by: ${patch.replacedBy}`,
    `Affects: ${patch.affectsText}`,
    ...patch.affects.map((id) => `- ${objectName(id)} (${id})`),
    `Must not pass as current: ${patch.mustNotPassAsCurrent}`,
    '', '## Evidence',
    'Old anchor:', ...evidenceLines([patch.oldAnchor]),
    'New anchor:', ...evidenceLines(patch.newAnchor ? [patch.newAnchor] : []),
    'Decision or commit:', ...evidenceLines(patch.decision ? [patch.decision] : []),
    'Ledger supersession:', ...evidenceLines([patch.candidate]),
  ]);
}

export function territoryBrief(
  territory: CodeTerritory,
  objectName: (id: string) => string,
  ledger: { view: TerritoryView; version: CodeView['version'] } | null,
  firstSeen: string,
): string {
  const view = ledger?.view;
  const areaId = view?.row.kind === 'area' ? view.row.areaId : territory.areaId;
  const also = view?.alsoServes.map((a) => ({ id: a.areaId, name: a.areaName })) ?? territory.alsoServes.map((id) => ({ id, name: objectName(id) }));
  const anomalies = view?.anomalies ?? territory.anomalies;
  const lines: (string | null)[] = [
    `# Code territory · ${view?.name ?? territory.name} (${territory.id})`,
    `What: ${view?.summary ?? territory.summary}`,
    `Where: ${view?.repo ?? territory.repo}`,
    ...(view?.paths ?? territory.paths).map((path) => `- ${path}`),
    `Kind: ${view?.row.kind ?? territory.kind}`,
    `Main area: ${areaId ? `${objectName(areaId)} (${areaId})` : 'None'}`,
    `Also serves: ${also.length ? also.map((a) => `${a.name} (${a.id})`).join('; ') : 'None'}`,
    `Occurred: ${ledger ? occurredText(ledger.version.occurred) : `Undated · first seen ${firstSeen}`}`,
    `Current state: ${view ? view.currentUse : 'the ledger is not connected yet'}`,
  ];
  if (view) {
    lines.push(
      `Size: ${view.size.files} files, ${view.size.lines} lines; generated ${view.size.generatedFiles} files, ${view.size.generatedLines} lines`,
      `Depends on: ${view.dependsOn.join(', ') || 'None'}`,
      `Depended on by: ${view.dependedBy.join(', ') || 'None'}`,
      `Built by: ${view.builtBy.map((b) => `${b.label} (${b.workId ?? 'unattributed'}): ${b.files} files; ${b.commits.join(', ')}`).join('; ') || 'None recorded'}`,
      `Generations: ${view.generations.map((g) => `${g.name}: ${g.share}`).join('; ') || 'None recorded'}`,
      `Tests: ${view.tests}`,
      view.lastChange ? `Last change: ${view.lastChange.commit} · ${occurredText(view.lastChange.occurred)} · ${view.lastChange.subject}` : 'Last change: None recorded',
    );
  } else lines.push('Size, dependencies, who built it, generations, tests and last change: the ledger is not connected yet');
  lines.push('', '## Anomalies');
  if (!anomalies.length) lines.push('- None recorded');
  else for (const anomaly of anomalies) lines.push(
    `- ${anomaly.kind} · ${anomaly.text} · ${anomaly.basis}${anomaly.sendBackId ? ` · send-back ${anomaly.sendBackId}` : ''}`,
    ...evidenceLines(anomaly.evidence).map((line) => `  ${line}`),
  );
  return finish(lines);
}
