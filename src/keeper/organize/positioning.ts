/**
 * "Project positioning": the small block every organizing job gets so it knows which project
 * it is in, what the product reference and areas currently are, and which roles exist. It is
 * deliberately short (Spec §3.3: each job takes only the input it needs, never the whole history).
 */
import type { Project } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';

export function positioningBlock(store: ProjectStore, project: Project): string {
  const lines: string[] = [];
  lines.push(`Project: ${project.name} (root ${project.locations[0]})`);
  if (project.roles.length) lines.push(`Roles recognised in this project: ${project.roles.join(', ')}`);
  const scope = project.scope.filter((i) => i.relation !== 'Excluded' && i.category !== 'Session source');
  lines.push(`In scope: ${scope.map((i) => `${i.category} ${i.path} (${i.relation})`).join('; ')}`);
  const refs = store.reference.all();
  if (refs.length) {
    lines.push('Product reference (id · category · name · validity):');
    for (const r of refs.filter((x) => x.validity === 'Current' || x.validity === 'Proposed').slice(0, 80)) lines.push(`- ${r.id} · ${r.category} · ${r.name}${r.ids.length ? ` [${r.ids.join(', ')}]` : ''} · ${r.validity}${r.basis === 'Inferred' ? ' (Inferred)' : ''}`);
    const replaced = refs.filter((x) => x.validity === 'Replaced' || x.validity === 'Abandoned' || x.validity === 'Deferred');
    if (replaced.length) lines.push(`- (${replaced.length} more items are Replaced, Deferred or Abandoned; read them with pk_read_assets kind=reference if needed)`);
  } else {
    lines.push('Product reference: none yet.');
  }
  const areas = store.reference.filter((r) => r.category === 'Area' && r.validity === 'Current');
  if (areas.length) lines.push(`Areas: ${areas.map((a) => `${a.name} (${a.id})`).join('; ')}`);
  const threads = store.threads.all().filter((t) => t.validity === 'Current' || t.validity === 'Proposed');
  if (threads.length) {
    lines.push(`Work items (${threads.length}; id · project ids · title · progress · serves):`);
    for (const t of threads.slice(0, 120)) lines.push(`- ${t.id} · [${t.ids.join(', ')}] · ${t.title.slice(0, 70)} · ${t.progress} · ${t.serves.map((s) => store.reference.get(s.referenceId)?.name.slice(0, 24) ?? s.referenceId).join(', ') || 'serves nothing yet'}`);
    if (threads.length > 120) lines.push(`- (${threads.length - 120} more; pk_read_assets kind=thread lists them)`);
  }
  return lines.join('\n');
}
