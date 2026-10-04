/**
 * A project's route (Spec §6.10 "每一步用哪个模型", "备用与并行", §3.10; D38, D105; CKC-03 AC-29, AC-35): the main model —
 * which key, which model, how hard it thinks — that the owner's conversation and requests use and that every step of a
 * round follows unless set apart; each step's own model and thinking, or "follows"; and the order of the keys that stand
 * in when one runs out of quota or is rate-limited.
 *
 * Each project chooses its own (U98). A project that has not saved one runs on the machine's settings (`workspace.json`:
 * `model`, `modelBackups`, `steps`), as every project did before D105, so an existing home goes on as it was.
 *
 * Which key runs a job: the keys of the route in order — the main key, then the backups — and after them any other key
 * that carries a model a step is set to. A job that follows the main model goes to the keys that have that model, spread
 * over all of them. A step set to a model on a key, or on a provider's keys (the page's "glm-5.3-flash · Z.AI", "· 2
 * keys"), runs on those; when they are all out of quota or rate-limited it goes on to the other keys of the order that
 * carry the same model (a switch, recorded). Only when no usable key carries the model does it go to the other keys of the
 * order, on the model each has (the stand-in model of that backup). Pure functions: runtime.ts asks them, with what pi
 * knows of the keys.
 */
import type { RoundStepKind } from '../model/k-types.ts';
import type { ProjectRoute, RouteModel as ModelChoice, StepRoute } from '../model/types.ts';
import type { WorkspaceSettings } from '../store/workspace.ts';
import { STEP_SETTING_AS } from './clerk-steps.ts';

export type { ProjectRoute, StepRoute };

/** The route in force for a project: its own, or the machine's. */
export interface Route {
  readonly main: ModelChoice | null;
  readonly backups: readonly ModelChoice[];
  readonly steps: Readonly<Partial<Record<string, StepRoute>>>;
  /** Whether the project saved a route of its own. */
  readonly own: boolean;
}

/** The steps of a round the owner sets apart (Spec §6.10): session drafts, the main agent, its lanes, the synthesis, the spot-check. */
export const ROUTE_STEPS = ['session-drafts', 'main', 'lane', 'synthesis', 'spot-check'] as const satisfies readonly RoundStepKind[];

export function routeOf(project: { readonly route?: ProjectRoute | null } | null | undefined, settings: Pick<WorkspaceSettings, 'model' | 'modelBackups' | 'steps'>, fallbackMain: ModelChoice | null = null): Route {
  const own = project?.route ?? null;
  if (own) return { main: own.model, backups: own.backups, steps: own.steps, own: true };
  return { main: settings.model ?? fallbackMain, backups: settings.modelBackups ?? [], steps: settings.steps ?? {}, own: false };
}

/** What a job wants: a step's own model and thinking, or the main model's. `follows` says whose setting it is when not its own. */
export interface Want {
  readonly provider: string | null;
  readonly model: string | null;
  readonly thinking: string | null;
  /** `null` when the step is set itself; otherwise the step it follows (`main` for the main agent's), or `'main model'`. */
  readonly follows: string | null;
  /**
   * Where a step set to a model of its own runs (or the step it follows, D103): `at` is a key id or a provider, whose keys
   * then all count. A step set by model alone sits on the main key's provider (`loose`), when that provider carries the
   * model. `null` for work that follows the main model: it goes to every key that has the model.
   */
  readonly pin: Pin | null;
}
export interface Pin { readonly at: string; readonly loose: boolean }

/**
 * The model a step runs on (§6.10: a step not set apart says whom it follows; the main model changed, the steps that
 * follow it change with it). Each part a step leaves unset comes from the step it defaults to (D103: the synthesis from
 * the main agent), then from the main model. A job outside a round's steps (the owner's, an investigation) wants the main model.
 */
export function wantOf(route: Route, step: string | null | undefined): Want {
  const main = route.main;
  const own = step ? route.steps[step] : undefined;
  const asKind = step ? STEP_SETTING_AS[step as RoundStepKind] : undefined;
  const as = asKind ? route.steps[asKind] : undefined;
  const model = own?.model ?? as?.model ?? null;
  const provider = own?.model ? own.provider : as?.model ? as.provider : undefined;
  const set = own?.model || as?.model;
  const pin: Pin | null = !set ? null : provider ? { at: provider, loose: false } : main?.provider ? { at: main.provider, loose: true } : null;
  return {
    provider: provider ?? main?.provider ?? null,
    model: model ?? main?.id ?? null,
    thinking: own?.thinking ?? as?.thinking ?? main?.thinking ?? null,
    follows: own?.model ? null : asKind ?? 'main model',
    pin,
  };
}

/** Whether a key is one a pin names: the key itself, or a key of the provider it names (of the main key's provider, for a loose pin). */
export function onPin(pin: Pin, key: string, familyOf: (key: string) => string = (k) => k): boolean {
  return pin.loose ? familyOf(key) === familyOf(pin.at) : key === pin.at || familyOf(key) === pin.at;
}

/** A key of the route, in order, with the model it runs when the wanted one is not among its models. */
export interface RouteKey { readonly provider: string; readonly id: string; readonly thinking: string | null }

/**
 * The keys of a route in order: the main key, the backups, then any other key (from `others`, in the order given) that
 * carries a model one of the steps is set to — a step set to a provider's model runs there even when that key is not in
 * the backup order. One entry per key.
 */
export function routeKeys(route: Route, others: readonly string[], hasModel: (key: string, model: string) => boolean): RouteKey[] {
  const out: RouteKey[] = [];
  const add = (c: { provider: string; id: string; thinking?: string | null }) => { if (!out.some((x) => x.provider === c.provider)) out.push({ provider: c.provider, id: c.id, thinking: c.thinking ?? route.main?.thinking ?? null }); };
  if (route.main) add(route.main);
  for (const b of route.backups) add(b);
  const stepModels = [...new Set(Object.values(route.steps).map((s) => s?.model).filter((m): m is string => Boolean(m)))];
  for (const key of others) for (const m of stepModels) if (hasModel(key, m)) { add({ provider: key, id: m, thinking: null }); break; }
  return out;
}

export interface JobKeys {
  readonly keys: readonly RouteKey[];
  /** No usable key carries the wanted model: the keys run it on their own stand-in model. */
  readonly standIn: boolean;
  /** The keys the step is set to cannot be used now: it runs on other keys of the order that carry the same model. */
  readonly switched: boolean;
}
export interface KeyLook {
  /** The provider a key runs for (an own key's provider, an extra key's `like`); a provider id stays itself. */
  readonly familyOf?: (key: string) => string;
  /** Whether a usable key can take work now: not resting after a rate limit. */
  readonly ready?: (key: string) => boolean;
  /** Every key with credentials, usable or not: a loose pin holds only while its provider has a key that carries the model. */
  readonly all?: readonly string[];
}

/**
 * The keys a job may go to now, best first (§3.10 路由), from the usable keys (credentials, not out of quota) in the
 * route's order. Work that follows the main model: the keys that have the model it wants. A step set to a model on a key
 * or a provider's keys: those; when none of them can take work now (out of quota, rate-limited, removed), the other keys
 * that carry the same model and can (`switched`); when every key with the model is resting, those, to wait for the first
 * back. Only when no usable key carries the model: every usable key of the order, on its own stand-in model.
 */
export function keysForJob(usable: readonly RouteKey[], want: Want, hasModel: (key: string, model: string) => boolean, look: KeyLook = {}): JobKeys {
  const withModel = want.model ? usable.filter((k) => hasModel(k.provider, want.model!)) : [...usable];
  if (!withModel.length) return { keys: usable, standIn: true, switched: false };
  const familyOf = look.familyOf ?? ((k: string) => k);
  const ready = look.ready ?? (() => true);
  let pin = want.pin;
  // A step set by model alone sits on the main key's provider only when that provider carries the model at all.
  if (pin?.loose && want.model && !(look.all ?? usable.map((k) => k.provider)).some((k) => onPin(pin!, k, familyOf) && hasModel(k, want.model!))) pin = null;
  if (!pin) return { keys: withModel, standIn: false, switched: false };
  const pinned = withModel.filter((k) => onPin(pin!, k.provider, familyOf));
  if (pinned.some((k) => ready(k.provider))) return { keys: pinned, standIn: false, switched: false };
  const others = withModel.filter((k) => !onPin(pin!, k.provider, familyOf) && ready(k.provider));
  if (others.length) return { keys: others, standIn: false, switched: true };
  return { keys: pinned.length ? pinned : withModel, standIn: false, switched: false };
}

/** The model and thinking a job runs on, on the key it was given. */
export function modelOnKey(key: RouteKey, want: Want, hasModel: (key: string, model: string) => boolean): { readonly id: string; readonly thinking: string | null; readonly standIn: boolean } {
  if (want.model && hasModel(key.provider, want.model)) return { id: want.model, thinking: want.thinking ?? key.thinking, standIn: false };
  return { id: key.id, thinking: key.thinking, standIn: true };
}
