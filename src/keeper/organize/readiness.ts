/**
 * A readiness word is not progress (DB; Spec §2.2; the lane skill: 「"ready" is readiness: don't map it」).
 *
 * A project's table writes a status per row. Some of those words say how far the work is — done, in progress, blocked,
 * deferred. Others say how far the *document* is: that the contract or plan row is drafted, ready to be picked up,
 * approved, accepted, final. The second kind says nothing about the work: a contract that is "ready" may be untouched or
 * long delivered, and only the execution records tell which.
 *
 * On the DeepSeek run (2026-10-04) the main agent's brief gave the plan lane 「statusMap：ready→Planned」; the fill took
 * it, and none of the 27 contracts showed `Done` although the execution plan counted most of them delivered. The six-run
 * read-through had already listed that reading as one no check points at. So the program holds the list, and the fill
 * tool takes no mapping from one of these words to a progress: the word stays the row's written status, and the row's
 * progress is the lane's to judge from the execution records.
 *
 * One list, used by the fill tool and printed in its description; the lane skill names the same words.
 */

/** The words, as a status cell opens with them: English as whole words, Chinese as written. */
export const READINESS_WORDS: readonly string[] = [
  'ready', 'draft', 'drafted', 'approved', 'accepted', 'final', 'finalized', 'finalised',
  '就绪', '已就绪', '准备就绪', '草案', '草稿', '初稿', '已批准', '批准', '已核准', '已审批', '已接受', '已采纳', '定稿', '已定稿', '终稿', '最终版',
];

/** The words the rule is stated with, for a sentence that names it. */
export const READINESS_EXAMPLES = 'ready, draft, approved, accepted, final, 就绪, 草案, 已批准, 定稿';

const LATIN = READINESS_WORDS.filter((w) => /^[a-z]+$/.test(w));
const CJK = READINESS_WORDS.filter((w) => !/^[a-z]+$/.test(w)).sort((a, b) => b.length - a.length);
/** A status cell as it is compared: no emphasis or code marks, one space, lower case. */
const plain = (s: string): string => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The readiness word a written status opens with, or null: `ready`, `Ready (review after K)`, `draft`, `已批准（D12）`.
 * A status that opens with another word — `not ready`, `done`, `deferred (D79)`, `in progress` — states no readiness here.
 */
export function readinessWord(status: string): string | null {
  const s = plain(status);
  if (!s) return null;
  const first = /^[a-z]+/.exec(s)?.[0];
  if (first) return LATIN.includes(first) ? first : null;
  return CJK.find((w) => s.startsWith(w)) ?? null;
}

/** The rule in one sentence, for a refusal and for a tool's description. */
export const READINESS_RULE = `a word for the readiness or approval of the document itself (${READINESS_EXAMPLES}) is not progress: it is kept as the row’s written status and maps to no progress`;
/** The same, as a sentence of its own. */
export const READINESS_SENTENCE = `${READINESS_RULE[0]!.toUpperCase()}${READINESS_RULE.slice(1)}`;
