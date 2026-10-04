/** Types for markdown.js, so the node tests under src/ check against them. The browser never loads this file. */
export type Inline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'code'; v: string }
  | { t: 'b' | 'i' | 's'; kids: Inline[] }
  /** `href` is null when the address is not plain http(s): the words are shown, and they go nowhere. */
  | { t: 'a'; href: string | null; raw: string; img?: boolean; kids: Inline[] }
  | { t: 'cite'; id: string };
export type Block =
  | { t: 'p'; kids: Inline[] }
  | { t: 'h'; level: number; kids: Inline[] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'hr' }
  | { t: 'quote'; kids: Block[] }
  | { t: 'list'; ordered: boolean; start: number | null; items: Block[][] }
  | { t: 'table'; align: string[]; head: Inline[][]; rows: Inline[][][] };
export function parseMarkdown(text: string): Block[];
export function parseInline(src: string): Inline[];
export function safeHref(href: string): string | null;
export function fillMarkdown<T>(target: T, text: string, options?: { onCite?: (id: string) => void }): T;
