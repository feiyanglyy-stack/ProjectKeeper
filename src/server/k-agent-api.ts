/** Read-only increment K material for `pk get` and `pk options` (Spec §7.10). */
import type { App } from './app.ts';
import { HttpError, type HttpApp } from './http.ts';
import { processView } from './k-views.ts';
import { breakpointBrief, patchBrief, sendBackBrief, territoryBrief } from '../context/k-briefs.ts';
import { redactCredentials } from '../sources/anchor.ts';
import type { ProjectStore } from '../store/project-store.ts';

function objectName(store: ProjectStore, id: string): string {
  return store.threads.get(id)?.title ?? store.reference.get(id)?.name ?? store.nodes.get(id)?.label
    ?? store.territories.get(id)?.name ?? store.patches.get(id)?.title ?? id;
}

const safe = (text: string) => redactCredentials(text).text;

export function registerKAgentRoutes(http: HttpApp, app: App): void {
  http.route('GET', '/api/projects/:id/k-briefs/:oid', ({ params }) => {
    const project = app.project(params.id!);
    const store = app.store(project.id);
    const id = params.oid!;
    const b = store.breakpoints.get(id);
    if (b) {
      const view = processView(store, project, app.kEngines).breakpoints.find((item) => item.id === id)!;
      return { text: breakpointBrief(view, objectName(store, view.targetId)) };
    }
    const sb = store.sendbacks.get(id);
    if (sb) {
      const view = processView(store, project, app.kEngines).sendBacks.find((item) => item.id === id)!;
      return { text: sendBackBrief(view, objectName(store, view.targetId)) };
    }
    const patch = store.patches.get(id);
    if (patch) return { text: patchBrief(patch, (oid) => objectName(store, oid)) };
    const territory = store.territories.get(id);
    if (territory) {
      const code = app.kEngines.ledger?.code(store, project) ?? null;
      const view = code?.territories.find((item) => item.id === id);
      const ledger = code && view ? { view, version: code.version } : null;
      // CodeTerritory has no Occurred field. Use its first trace when kept, or the first observation retained in the
      // saved record, and never claim `updatedAt` is a commit or a date in the code's history.
      const firstSeen = (store.traceFor('territories', id, Number.MAX_SAFE_INTEGER)[0]?.at ?? territory.updatedAt).slice(0, 10) || 'unknown';
      return { text: territoryBrief(territory, (oid) => objectName(store, oid), ledger, firstSeen) };
    }
    throw new HttpError(404, `No breakpoint, send-back, semantic patch or code territory has the id ${id}`);
  });

  http.route('GET', '/api/projects/:id/k-options', ({ params }) => {
    const project = app.project(params.id!);
    const store = app.store(project.id);
    const view = processView(store, project, app.kEngines);
    return {
      breakpoints: view.breakpoints.filter((b) => b.lit).map((b) => ({ id: b.id, kind: b.kind, targetId: b.targetId, targetName: safe(objectName(store, b.targetId)) })),
      sendBacks: view.sendBacks.filter((s) => s.lit).map((s) => ({ id: s.id, stage: s.stage, to: s.to, what: safe(s.what), targetId: s.targetId, targetName: safe(objectName(store, s.targetId)) })),
      sixThings: view.sixThings.map((s) => ({ thing: s.thing, objects: s.objectIds.map((id) => ({ id, name: safe(objectName(store, id)) })) })),
    };
  });
}
