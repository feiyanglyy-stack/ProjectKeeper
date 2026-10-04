/**
 * Where one job's time went (Spec §3.10, D81; CKC-23 AC-10, CKC-03 AC-19): model generation, tool execution, queueing,
 * parsing and retries, and what cannot be told apart.
 *
 * pi's session events carry no times, so the runtime stamps them as they arrive. An assistant message carries the moment
 * its request was sent (`timestamp`); its end is when `message_end` arrives, so generation includes building the request,
 * the network, the provider's queue, time to first token and streaming — pi does not separate them. Parallel tool calls
 * of one turn count once, as the span from the first start to the last end.
 *
 * Parsing and retrying, counted the way the test-B-1 baseline counted them (E106), so the two runs compare:
 *   - a request that ended in an error or was aborted, and the wait before pi sent it again (`auto_retry_start`);
 *   - the turn right after a turn whose tool calls were all refused (bad or incomplete arguments, an unknown tool),
 *     when it sends a tool call again: it re-sends them. The refused turn itself stays generation, and so does a next
 *     turn that only answers (QC AX-1: a final answer after a refusal was counted as a re-send).
 */
import { createHash } from 'node:crypto';
import type { StepTiming } from '../model/k-types.ts';

/** A tool result that says the call never ran: its arguments failed validation or did not arrive complete (pi's
 *  "was not executed" — cut off at the output limit, or not complete JSON), or no tool has that name. A pk_* write
 *  tool's own refusal of a call that leaves out what a new item needs says "Invalid arguments" (`incompleteCall`). */
const REFUSED = /validation failed|invalid (tool )?arguments|must have required property|unknown tool|tool .{0,80} not found|no tool named|was not executed/i;
/** pi's refusal of a call whose arguments did not arrive whole (cut off at the output limit, or not complete JSON). */
const CUT_OFF = /was not executed/i;

/** The call behind this tool result never ran. */
export function isRefusal(isError: boolean, resultText: string): boolean {
  return isError && REFUSED.test(resultText);
}

/**
 * How a pk_* write tool refuses a call that would create an item but leaves out what a new item needs (a work item's
 * title and progress, a round document's markdown …). Those fields used to be required by the tools' schemas, so pi
 * refused such a call before it ran; they are optional now, because an update gives only what it changes, and the tool
 * refuses the incomplete create itself, before it writes anything. It throws, so pi records the result as an error,
 * and its words begin "Invalid arguments", so the timer and the refusal guard read it as the refusal of a call that
 * never ran — as they read pi's own refusal of the same call before. `message` says what is missing and how to update.
 */
export function incompleteCall(message: string): Error {
  return new Error(`Invalid arguments: ${message}`);
}

/** The message sends at least one tool call. */
function sendsToolCall(message: { readonly stopReason?: string; readonly content?: readonly { readonly type: string }[] }): boolean {
  return message.stopReason === 'toolUse' || (message.content ?? []).some((c) => c.type === 'toolCall');
}

export class StepTimer {
  private generationMs = 0;
  private toolMs = 0;
  private parseRetryMs = 0;
  private openTools = 0;
  private toolSpanStart = 0;
  private turnCalls = 0;
  private turnRefused = 0;
  private reissuePending = false;

  /** An assistant message ended at `at`; its `timestamp` is when its request was sent. */
  assistantEnded(message: { readonly timestamp?: number | string; readonly stopReason?: string; readonly content?: readonly { readonly type: string }[] }, at: number): void {
    const sent = typeof message.timestamp === 'number' ? message.timestamp : typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : Number.NaN;
    const ms = Number.isFinite(sent) ? Math.max(0, at - sent) : 0;
    const resends = this.reissuePending && sendsToolCall(message);
    if (message.stopReason === 'error' || message.stopReason === 'aborted' || resends) this.parseRetryMs += ms;
    else this.generationMs += ms;
    this.reissuePending = false;
    this.turnCalls = 0;
    this.turnRefused = 0;
  }

  toolStarted(at: number): void {
    if (this.openTools === 0) this.toolSpanStart = at;
    this.openTools += 1;
    this.turnCalls += 1;
  }

  toolEnded(at: number, isError: boolean, resultText: string): void {
    if (isRefusal(isError, resultText)) this.turnRefused += 1;
    this.openTools = Math.max(0, this.openTools - 1);
    if (this.openTools === 0) {
      this.toolMs += Math.max(0, at - this.toolSpanStart);
      if (this.turnCalls > 0 && this.turnRefused === this.turnCalls) this.reissuePending = true;
    }
  }

  /** pi waits before re-sending a failed request (`auto_retry_start`). */
  retryWait(delayMs: number): void {
    if (Number.isFinite(delayMs) && delayMs > 0) this.parseRetryMs += delayMs;
  }

  /** The job's timing, given when it was queued, started and ended (ISO times or epoch milliseconds). */
  finish(queuedAt: string | number, startedAt: string | number, endedAt: string | number): StepTiming {
    const t = (v: string | number) => (typeof v === 'number' ? v : Date.parse(v));
    const wallMs = Math.max(0, t(endedAt) - t(startedAt));
    const queueMs = Math.max(0, t(startedAt) - t(queuedAt));
    const known = this.generationMs + this.toolMs + this.parseRetryMs;
    return {
      wallMs, queueMs,
      generationMs: Math.round(this.generationMs), toolMs: Math.round(this.toolMs), parseRetryMs: Math.round(this.parseRetryMs),
      otherMs: Math.max(0, Math.round(wallMs - known)),
    };
  }
}

/**
 * How many turns in a row the same call may be refused the same way before the step is ended. pi's tool loop has no
 * bound of its own: a model that keeps re-sending a refused call goes on until the step's time limit (30 minutes for
 * automatic work, none for the owner's). QC AX-1 observed exactly that — a call re-sent with the same missing field
 * turn after turn, ended only by the test double's own six-turn safety valve. Eight is generous: a model that fixes its
 * call within a few tries, or moves on to other calls, never reaches it.
 */
export const REPEATED_REFUSAL_LIMIT = 8;

/** A call refused the same way in `turns` turns in a row; `alongside`: how many other calls reached the limit with it. */
export interface RepeatedRefusal { readonly tool: string; readonly error: string; readonly turns: number; readonly alongside: number }

/** One tool call of a turn as the guard reads it: the tool, the arguments the model sent, and how the call ended. */
export interface TurnCall { readonly tool: string; readonly args: unknown; readonly isError: boolean; readonly resultText: string }

/** One turn: how the reply stopped, and every tool call it sent with its result. */
export interface GuardTurn { readonly stopReason?: string; readonly calls: readonly TurnCall[] }

/** A refusal's error, without the arguments pi echoes after a validation error, whitespace collapsed. */
function refusalError(resultText: string): string {
  return (resultText.split(/\n\s*\nReceived arguments:/)[0] ?? resultText).replace(/\s+/g, ' ').trim();
}

/** The arguments with their keys in one order, so the same call sent twice reads the same however its keys came. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Which refused call this is: its tool, its error, and — when they arrived whole — its arguments. */
function refusedCallKey(call: TurnCall, error: string): string {
  const refusal = `${call.tool}\u0000${error.replace(/\d+/g, '#')}`;
  if (CUT_OFF.test(call.resultText)) return refusal;
  return `${refusal}\u0000${createHash('sha256').update(stableJson(call.args)).digest('hex')}`;
}

/**
 * The guard against a model that re-sends a refused call turn after turn (QC AX-1). It reads each turn whole — the
 * reply and the result of every call it sent — at the turn's end. The rule:
 *   - A refused call is itself: its tool, its arguments and its error (pi's echo of the arguments left off, numbers in
 *     the error ignored). A call whose arguments did not arrive whole (pi's "was not executed": cut off at the output
 *     limit, or not complete JSON) is its tool and its error alone: what arrived is not the call the model sent, and it
 *     differs from one cut to the next, so a call re-sent cut off at another length is the same refused call.
 *   - A turn in which every call was refused counts once for each distinct call in it: one refused in the turn before
 *     too goes on counting, any other starts at one. The same call twice in one turn counts once.
 *   - A turn in which any call ran, or that sent none, starts every count again: the model is doing something else.
 *     A request that failed or was aborted is no turn of the model's and changes no count.
 *   - The step ends when one call reaches REPEATED_REFUSAL_LIMIT turns.
 * So calls to different targets refused for the same reason in one turn are that many calls counted once each, not
 * one call refused that many times: test-D-1's skeleton ended Failed on ten parallel updates of ten work items, refused
 * for one missing field, when the count was kept per result and keyed on the tool and the error alone. The same call,
 * or the same batch, re-sent turn after turn still ends the step at the limit.
 */
export class RefusalStreak {
  private counts = new Map<string, { readonly tool: string; readonly error: string; readonly turns: number }>();

  /** A turn has ended: its reply's stop reason, and each call it sent with its result. */
  turnEnded(turn: GuardTurn): void {
    if (turn.stopReason === 'error' || turn.stopReason === 'aborted') return;
    const refused = turn.calls.filter((c) => isRefusal(c.isError, c.resultText));
    const next = new Map<string, { readonly tool: string; readonly error: string; readonly turns: number }>();
    if (refused.length > 0 && refused.length === turn.calls.length) {
      for (const call of refused) {
        const error = refusalError(call.resultText);
        const key = refusedCallKey(call, error);
        if (!next.has(key)) next.set(key, { tool: call.tool, error, turns: (this.counts.get(key)?.turns ?? 0) + 1 });
      }
    }
    this.counts = next;
  }

  /** The refused call that has now come back `REPEATED_REFUSAL_LIMIT` or more turns in a row, if there is one. */
  get reached(): RepeatedRefusal | null {
    const over = [...this.counts.values()].filter((c) => c.turns >= REPEATED_REFUSAL_LIMIT);
    return over.length ? { ...over[0]!, alongside: over.length - 1 } : null;
  }
}

/** pi's view of a finished turn, as far as the guard reads it (`finishTurn`'s argument). */
interface PiTurn {
  readonly message: { readonly stopReason?: string; readonly content?: readonly unknown[] };
  readonly toolResults?: readonly { readonly toolCallId?: string; readonly isError?: boolean; readonly content?: readonly { readonly type: string; readonly text?: string }[] }[];
}

/** The guard's reading of a turn pi finished: each tool call of the reply, matched to its result by the call's id. */
export function guardTurn(turn: PiTurn): GuardTurn {
  const results = new Map((turn.toolResults ?? []).map((r) => [r.toolCallId, r]));
  const calls = (turn.message.content ?? [])
    .filter((c): c is { type: 'toolCall'; id: string; name: string; arguments?: unknown } => (c as { type?: unknown } | null)?.type === 'toolCall')
    .map((c) => {
      const result = results.get(c.id);
      return { tool: c.name, args: c.arguments ?? {}, isError: result?.isError === true, resultText: result?.content?.find((x) => x.type === 'text')?.text ?? '' };
    });
  return { stopReason: turn.message.stopReason, calls };
}

/** Every pi built-in tool, on in every step (D87: 「自带的几个命令全部打开，grep find」; CKC-03 AC-25). */
export function keeperBuiltinTools(platform: string = process.platform): string[] {
  return ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', ...(platform === 'win32' ? ['powershell'] : [])];
}
