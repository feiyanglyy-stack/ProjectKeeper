/**
 * Whether a key can be used (Spec §6.10 "这把 key 能不能用"; D105; CKC-03 AC-34): checked when it is saved and whenever the
 * owner presses `Check`.
 *
 * The check is ONE request of ONE output token (`maxTokens: 1`, no thinking asked for) to the cheapest priced model the
 * key carries — the request every provider answers the same way a job's request is answered, so a key that passes here
 * passes for the work, and a key that is refused, out of quota or rate-limited says so in the provider's own words. A
 * model list was the other cheap request; the Coding Plan endpoints (Zhipu, Z.ai) do not serve one, so it would not tell
 * a usable key from a refused one there.
 *
 * Quota: where the provider reports what is left, it is read (`QUOTA_REPORTERS`: DeepSeek's balance); a provider that does
 * not report it is said not to, never shown as unlimited.
 */
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

export type KeyStatus = 'Usable' | 'Refused' | 'Out of quota' | 'Rate-limited' | 'Could not check' | 'Not checked';

export interface KeyCheck {
  readonly status: KeyStatus;
  /** The provider's own words when it refused, or why the check could not be made. */
  readonly reason: string | null;
  /** When an exhausted quota comes back, when the provider says. */
  readonly until: string | null;
  readonly at: string;
  /** Which request the check made. */
  readonly how: string;
  /** What is left, in the provider's terms, when it reports it; otherwise null and `quotaReported` false. */
  readonly quota: string | null;
  readonly quotaReported: boolean;
}

export type ErrorClass = 'quota' | 'ratelimit' | 'unavailable' | 'error';

/** A provider that reports what is left on a key: a line to show, and whether anything is left. */
export type QuotaReporter = (baseUrl: string, apiKey: string, signal: AbortSignal) => Promise<{ readonly text: string; readonly available: boolean } | null>;

/** DeepSeek: `GET /user/balance` (https://api-docs.deepseek.com/api/get-user-balance). */
const deepseekBalance: QuotaReporter = async (baseUrl, apiKey, signal) => {
  const res = await fetch(`${new URL(baseUrl).origin}/user/balance`, { headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' }, signal });
  if (!res.ok) return null;
  const body = await res.json() as { is_available?: boolean; balance_infos?: { currency?: string; total_balance?: string }[] };
  const infos = body.balance_infos ?? [];
  const text = infos.length ? `Balance ${infos.map((b) => `${b.total_balance ?? '?'} ${b.currency ?? ''}`.trim()).join(' · ')}` : 'Balance reported, no amount given';
  return { text, available: body.is_available !== false };
};

/** Providers that report what is left on a key, by the provider a key's endpoint belongs to. */
export const QUOTA_REPORTERS: Partial<Record<string, QuotaReporter>> = { deepseek: deepseekBalance };

/** A refusal of the key itself (wrong, revoked, not allowed), as against a limit. */
export function isRefusal(message: string): boolean {
  if (/\b(401|403)\b/.test(message)) return true;
  if (/"code"\s*:\s*"?(1000|1001|1002|1003|1004)"?/.test(message)) return true;   // Zhipu / Z.ai authentication codes
  return /invalid[_ ]?api[_ ]?key|incorrect api key|authentication|unauthori[sz]ed|forbidden|permission denied|api key (is )?(not valid|invalid|expired)|身份验证|令牌已过期|无效的?\s*(api ?key|令牌)/i.test(message);
}

/** The cheapest model of a key that has a price, else its first model: what the one-token check asks. */
export function checkModelOf(models: readonly { readonly id: string; readonly cost: { readonly input: number; readonly output: number } }[]): string | null {
  const priced = models.filter((m) => m.cost.input > 0 || m.cost.output > 0).sort((a, b) => (a.cost.input + a.cost.output) - (b.cost.input + b.cost.output));
  return (priced[0] ?? models[0])?.id ?? null;
}

export async function checkKey(
  models: ModelRuntime,
  keyId: string,
  options: {
    readonly family: string;
    readonly classify: (message: string) => ErrorClass;
    readonly resetFrom: (message: string, provider: string) => string | null;
    readonly redact: (text: string) => string;
    readonly timeoutMs?: number;
  },
): Promise<KeyCheck> {
  const at = new Date().toISOString();
  const list = models.getModels(keyId);
  const modelId = checkModelOf(list);
  const how = modelId ? `one request of one output token to ${modelId}` : 'no request: the key carries no model';
  const base = { at, how, quota: null, quotaReported: false, until: null };
  if (!modelId) return { ...base, status: 'Could not check', reason: 'This key carries no model to ask.' };
  const model = models.getModel(keyId, modelId)!;
  const auth = await models.getAuth(keyId).catch(() => undefined);
  if (!auth) return { ...base, status: 'Refused', reason: 'No key value is configured for this provider.' };
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  // What is left, where the provider reports it; asked beside the request, never instead of it.
  const reporter = QUOTA_REPORTERS[options.family];
  const quotaP = reporter && auth.auth.apiKey ? reporter(auth.auth.baseUrl ?? model.baseUrl, auth.auth.apiKey, signal).catch(() => null) : Promise.resolve(null);
  let message: string | null = null;
  try {
    const reply = await models.completeSimple(model, { messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }] }, { maxTokens: 1, signal });
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted') message = reply.errorMessage ?? 'The provider returned an error';
  } catch (e) { message = e instanceof Error ? e.message : String(e); }
  const quota = await quotaP;
  const q = { quota: quota?.text ?? null, quotaReported: Boolean(reporter) };
  if (!message) {
    if (quota && !quota.available) return { ...base, ...q, status: 'Out of quota', reason: 'The provider reports nothing left on this key.' };
    return { ...base, ...q, status: 'Usable', reason: null };
  }
  const reason = options.redact(message).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (signal.aborted) return { ...base, ...q, status: 'Could not check', reason: `No answer within ${Math.round((options.timeoutMs ?? 30_000) / 1000)} seconds` };
  if (isRefusal(message)) return { ...base, ...q, status: 'Refused', reason };
  const kind = options.classify(message);
  if (kind === 'quota') return { ...base, ...q, status: 'Out of quota', reason, until: options.resetFrom(message, options.family) };
  if (kind === 'ratelimit') return { ...base, ...q, status: 'Rate-limited', reason };
  return { ...base, ...q, status: 'Could not check', reason };
}
