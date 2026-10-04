/**
 * `Keeper` → `Model provider` and `Usage` per round (Spec §6.10 "key、模型与路由", §3.10; D38, D105; CKC-03 AC-29,
 * AC-33～AC-37): the owner's own keys — add, replace, remove, check — beside the keys configured outside the product;
 * the project's route — main model, each step's model or whom it follows, the backup order — and each key's jobs at once;
 * and, in `Usage`, one row per round split by model.
 *
 * A key's value comes in on `POST /api/keys` and `POST /api/keys/:id`, goes to the runtime, and never comes back out:
 * every answer here carries the full mask at most. A refused request answers 400 with the reason, so nothing a key was
 * part of reaches the server log (http.ts logs only a 500's stack).
 */
import type { App } from './app.ts';
import { HttpApp, HttpError } from './http.ts';
import type { KeeperJob, Usage } from '../model/types.ts';
import type { ProjectStore } from '../store/project-store.ts';
import { cleanKeyValue } from '../keeper/own-keys.ts';
import { ROUTE_STEPS, wantOf } from '../keeper/route.ts';
import { THINKING_LEVELS } from '../keeper/clerk-steps.ts';
import { roundJobs } from './keeper-page.ts';

const fail = (e: unknown): never => { throw e instanceof HttpError ? e : new HttpError(400, e instanceof Error ? e.message : String(e)); };
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The page's view of the keys and the project's route. */
export async function modelProviderView(app: App, projectId: string) {
  const keeper = app.keeper;
  const keys = await keeper.keysView();
  const name = (id: string) => keys.find((k) => k.id === id)?.name ?? id;
  const usable = (id: string) => { const k = keys.find((x) => x.id === id); return Boolean(k && (k.state.status === 'Usable' || k.state.status === 'Rate-limited')); };
  const route = keeper.routeFor(projectId);
  const state = await keeper.providerState(projectId);
  const lanes = keeper.laneState(projectId);
  // The key the main row shows is the one the project runs on now: its own route's, else the machine's (a provider named
  // where a key is meant is that provider's first usable key), else — no main model set anywhere — the key in use.
  const keyFor = (provider: string): string => (keys.some((k) => k.id === provider) ? provider : keys.find((k) => k.provider === provider && usable(k.id))?.id ?? keys.find((k) => k.provider === provider)?.id ?? provider);
  const mainModel = route.main ? { ...route.main, provider: keyFor(route.main.provider) } : state.model ? { provider: state.model.provider, id: state.model.id, thinking: state.model.thinking } : null;
  const main = mainModel ? { ...mainModel, keyName: name(mainModel.provider), usable: usable(mainModel.provider), chosen: Boolean(route.main) } : null;
  // The models a step can be set to: those of the providers with a usable key (§6.10 可选的模型来自有可用 key 的 provider), one entry per provider and model.
  const offered = new Map<string, { provider: string; providerName: string; model: string; keys: string[]; priced: boolean }>();
  for (const k of keys) {
    if (!usable(k.id)) continue;
    for (const m of k.models) {
      const at = `${k.provider}/${m.id}`;
      const o = offered.get(at) ?? { provider: k.provider, providerName: k.providerName, model: m.id, keys: [], priced: m.priced };
      o.keys.push(k.name);
      offered.set(at, o);
    }
  }
  // The provider a key runs for (an extra key's `like`, an own key's provider); a provider id stays itself.
  const familyOf = (id: string): string => keys.find((k) => k.id === id)?.provider ?? id;
  const mainFamily = main ? familyOf(main.provider) : null;
  /** Where a step's own model sits among the offered ones: the provider it names, else the main key's provider when that
   *  carries it (a step set by model alone runs on the main key first), else the first provider that offers it. */
  const placeOf = (own: { readonly provider?: string; readonly model?: string } | null): string | null => {
    if (!own?.model) return null;
    const family = own.provider ? familyOf(own.provider)
      : mainFamily && offered.has(`${mainFamily}/${own.model}`) ? mainFamily
        : [...offered.values()].find((o) => o.model === own.model)?.provider ?? mainFamily ?? '';
    return `${family}|${own.model}`;
  };
  return {
    keys,
    providers: keeper.keyProviders(),
    thinking: ['off', ...THINKING_LEVELS],
    route: {
      own: route.own,
      main,
      // The main key is first in the order already; a backup naming it again (a machine with no main model set, whose first backup runs) is not listed twice.
      backups: route.backups.filter((b) => b.provider !== main?.provider).map((b) => ({ ...b, keyName: name(b.provider), usable: usable(b.provider) })),
      steps: ROUTE_STEPS.map((kind) => {
        const own = route.steps[kind] ?? null;
        const routeNow = { ...route, main: route.main ?? mainModel };
        const want = wantOf(routeNow, kind);
        // Whom the step follows when it has no model of its own, and the model that gives it — said even while it has one,
        // since the select offers going back to it.
        const steps = { ...routeNow.steps };
        if (own?.thinking) steps[kind] = { thinking: own.thinking }; else delete steps[kind];
        const without = wantOf({ ...routeNow, steps }, kind);
        return { kind, own, model: want.model, provider: want.provider, thinking: want.thinking, follows: want.follows, followsWhom: without.follows, followsModel: without.model, place: placeOf(own) };
      }),
    },
    offered: [...offered.values()],
    inUse: state.model ? { ...state.model, keyName: name(state.model.provider) } : null,
    fallback: state.fallback ? { ...state.fallback, keyName: name(state.fallback.provider), fromName: name(state.fallback.from.provider) } : null,
    connected: state.connected,
    reason: state.reason,
    lanes: { lanesPerKey: lanes.lanesPerKey, total: lanes.total, keys: lanes.keys.map((k) => ({ ...k, keyName: name(k.provider) })) },
    switches: state.switches,
  };
}

// ───────────────────────── Usage per round per model (§3.10, §6.10 `Usage`; CKC-03 AC-37) ─────────────────────────

export interface ModelUsage {
  /** The model, as the owner reads it: provider and model id. */
  readonly model: string;
  readonly keys: readonly string[];
  readonly steps: readonly { readonly kind: string; readonly count: number }[];
  /** The time its jobs ran, added up (jobs that ran side by side each count). */
  readonly timeMs: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** Null when the provider reports no price for it: the tokens are what there is. */
  readonly cost: number | null;
  readonly priced: boolean;
}
export interface RoundUsage {
  readonly id: string;
  readonly number: number;
  readonly kind: string;
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly wallMs: number;
  readonly cost: number | null;
  readonly input: number;
  readonly output: number;
  readonly byModel: readonly ModelUsage[];
}

/** Steps in the order a round runs them; a subagent a step sent comes last. */
const STEP_ORDER = ['session-drafts', 'orientation', 'skeleton', 'main', 'lane', 'dig', 'cross-check', 'synthesis', 'spot-check'];
const stepOrder = (kind: string): number => { const i = STEP_ORDER.indexOf(kind); return i < 0 ? STEP_ORDER.length : i; };
const jobTime = (j: KeeperJob, now: number): number => j.timing?.wallMs ?? (j.startedAt ? (j.endedAt ? Date.parse(j.endedAt) : now) - Date.parse(j.startedAt) : 0);

/**
 * One row per round, newest first: its wall time and cost, split by the model each job ran on — the steps each model
 * carried, their time, input and output tokens and cost. A model the provider gives no price for says so (`priced`
 * false, cost null) and gives its tokens. Read from the jobs as recorded: the model a job ran on is on the job.
 */
export function usageByRound(
  store: ProjectStore,
  look: { readonly keyName: (id: string) => string; readonly familyOf: (id: string) => string; readonly priced: (provider: string, model: string) => boolean | null },
  now = Date.now(),
): RoundUsage[] {
  const rounds = store.clerkRounds.all().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return rounds.map((round) => {
    const jobs = roundJobs(store, round).filter((j) => j.agent !== 'program' && j.model);
    const groups = new Map<string, { keys: Set<string>; steps: Map<string, number>; timeMs: number; usage: Usage; priced: boolean }>();
    for (const j of jobs) {
      const family = look.familyOf(j.model!.provider);
      const at = `${family}/${j.model!.id}`;
      const g = groups.get(at) ?? { keys: new Set<string>(), steps: new Map<string, number>(), timeMs: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, priced: false };
      g.keys.add(look.keyName(j.model!.provider));
      const kind = j.step?.kind ?? 'subagent';
      g.steps.set(kind, (g.steps.get(kind) ?? 0) + 1);
      g.timeMs += Math.max(0, jobTime(j, now));
      const listed = look.priced(j.model!.provider, j.model!.id);
      const priced = listed ?? (j.usage.cost !== null && j.usage.cost > 0);
      g.priced = g.priced || priced;
      g.usage = { input: g.usage.input + j.usage.input, output: g.usage.output + j.usage.output, cacheRead: g.usage.cacheRead + j.usage.cacheRead, cacheWrite: g.usage.cacheWrite + j.usage.cacheWrite, cost: priced && j.usage.cost !== null ? (g.usage.cost ?? 0) + j.usage.cost : g.usage.cost };
      groups.set(at, g);
    }
    const byModel: ModelUsage[] = [...groups.entries()].map(([model, g]) => ({
      model, keys: [...g.keys].sort(), steps: [...g.steps.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => stepOrder(a.kind) - stepOrder(b.kind)), timeMs: g.timeMs,
      input: g.usage.input, output: g.usage.output, cacheRead: g.usage.cacheRead, cost: g.priced ? g.usage.cost ?? 0 : null, priced: g.priced,
    })).sort((a, b) => b.timeMs - a.timeMs);
    const costs = byModel.filter((m) => m.cost !== null);
    return {
      id: round.id, number: round.number, kind: round.kind, status: round.status, startedAt: round.startedAt, endedAt: round.endedAt,
      wallMs: (round.endedAt ? Date.parse(round.endedAt) : now) - Date.parse(round.startedAt),
      cost: costs.length ? costs.reduce((n, m) => n + (m.cost ?? 0), 0) : null,
      input: byModel.reduce((n, m) => n + m.input, 0), output: byModel.reduce((n, m) => n + m.output, 0),
      byModel,
    };
  });
}

export function registerKeyRoutes(http: HttpApp, app: App): void {
  http.route('GET', '/api/projects/:id/model-provider', ({ params }) => modelProviderView(app, params.id!));

  // A key in: provider, an optional name, the key. Saved on this machine, checked at once; only the mask comes back.
  http.route('POST', '/api/keys', async ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    try {
      const provider = str(b.provider);
      if (!provider) throw new Error('Choose the provider the key is for');
      const value = cleanKeyValue(b.key);
      const r = await app.keeper.addKey(provider, str(b.name), value);
      return { key: r.key, check: r.check };
    } catch (e) { return fail(e); }
  });
  http.route('POST', '/api/keys/:key', async ({ params, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    try {
      if (!app.keeper.ownKeys.get(params.key!)) throw new HttpError(404, 'Only a key saved here can be replaced; a key configured outside ProjectKeeper is changed where it is set');
      const value = b.key === undefined || b.key === '' ? null : cleanKeyValue(b.key);
      return await app.keeper.replaceKey(params.key!, value, str(b.name));
    } catch (e) { return fail(e); }
  });
  http.route('DELETE', '/api/keys/:key', async ({ params }) => {
    if (!app.keeper.ownKeys.get(params.key!)) throw new HttpError(404, 'Only a key saved here can be removed; a key configured outside ProjectKeeper is removed where it is set');
    return app.keeper.removeKey(params.key!);
  });
  http.route('POST', '/api/keys/:key/check', async ({ params }) => {
    if (!app.keeper.models.getProvider(params.key!)) throw new HttpError(404, `No key ${params.key}`);
    return { check: await app.keeper.checkKeyNow(params.key!) };
  });
  // A key's own number of jobs at once; `null` gives it back to the setting for every key.
  http.route('POST', '/api/keys/:key/lanes', ({ params, body }) => {
    const raw = (body as { lanes?: unknown } | null)?.lanes;
    if (raw === null) return { lanes: app.keeper.setKeyLanes(params.key!, null) };
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || n > 32) throw new HttpError(400, 'lanes must be a number from 1 to 32');
    return { lanes: app.keeper.setKeyLanes(params.key!, n) };
  });

  // The project's route: { model?: {provider, id, thinking}, backups?: [{provider, id, thinking}], steps?: { kind: {provider?, model?, thinking?} | null } }.
  http.route('POST', '/api/projects/:id/route', ({ params, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const model = (m: unknown) => { const o = (m ?? {}) as Record<string, unknown>; const provider = str(o.provider); const id = str(o.id); if (!provider || !id) throw new HttpError(400, 'A model is a key (provider) and a model id'); return { provider, id, thinking: str(o.thinking) }; };
    try {
      app.project(params.id!);
      const steps = b.steps === undefined ? undefined : (() => {
        if (!b.steps || typeof b.steps !== 'object' || Array.isArray(b.steps)) throw new HttpError(400, 'steps must be an object keyed by step');
        return Object.fromEntries(Object.entries(b.steps as Record<string, unknown>).map(([k, v]) => {
          if (v === null) return [k, null];
          const o = (v ?? {}) as Record<string, unknown>;
          return [k, { ...(str(o.provider) ? { provider: str(o.provider)! } : {}), ...(str(o.model) ? { model: str(o.model)! } : {}), ...(str(o.thinking) ? { thinking: str(o.thinking)! } : {}) }];
        }));
      })();
      app.keeper.setRoute(params.id!, {
        ...(b.model !== undefined ? { model: model(b.model) } : {}),
        ...(Array.isArray(b.backups) ? { backups: b.backups.map(model) } : {}),
        ...(steps ? { steps } : {}),
      });
      return modelProviderView(app, params.id!);
    } catch (e) { return fail(e); }
  });

  http.route('GET', '/api/projects/:id/usage-rounds', async ({ params }) => {
    const keys = await app.keeper.keysView().catch(() => []);
    const keyName = (id: string) => keys.find((k) => k.id === id)?.name ?? id;
    const priced = (provider: string, model: string): boolean | null => {
      try { const m = app.keeper.models.getModel(provider, model) ?? app.keeper.models.getModel(app.keeper.familyOf(provider), model); return m ? m.cost.input > 0 || m.cost.output > 0 : null; } catch { return null; }
    };
    return { rounds: usageByRound(app.store(params.id!), { keyName, familyOf: (id) => app.keeper.familyOf(id), priced }) };
  });
}
