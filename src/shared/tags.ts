/**
 * Problem tags in the Problems list. The website's topic tags (`/main/list`
 * `.topic-badge`, e.g. ComProg / DataAlgo) are the single-choice pills; every
 * other tag a problem has (e.g. Graph, DFS) is offered in the "Tags" dropdown,
 * several at once, matched with AND or OR. No `vscode` import (shared with the webview).
 */
export type TagMode = 'and' | 'or';

const key = (t: string) => t.trim().toLowerCase();

/**
 * Tags for the dropdown: every tag of the problems that isn't a topic pill
 * (case-insensitive), plus selected tags no problem has any more (so they can
 * be unticked). Sorted by name, natural order.
 */
export function otherTags(problems: { tags?: string[] }[], topics: { name: string }[], selected: string[] = []): string[] {
  const topicKeys = new Set(topics.map((t) => key(t.name)));
  const seen = new Map<string, string>();
  for (const t of [...problems.flatMap((p) => p.tags ?? []), ...selected]) {
    const k = key(t);
    if (k && !topicKeys.has(k) && !seen.has(k)) seen.set(k, t.trim());
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

/** Does a problem pass the tag filter? No tags chosen → yes. OR: any of them; AND: all of them. */
export function matchesTags(problemTags: string[] | undefined, chosen: string[] | undefined, mode: TagMode | undefined): boolean {
  if (!chosen?.length) return true;
  const have = new Set((problemTags ?? []).map(key));
  return mode === 'and' ? chosen.every((t) => have.has(key(t))) : chosen.some((t) => have.has(key(t)));
}

/** A stored filter's tag part, cleaned (strings only, no duplicates, at most 50). */
export function cleanTagFilter(tags: unknown, mode: unknown): { tags: string[]; tagMode: TagMode } {
  const list = Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim()) : [];
  const unique = new Map<string, string>(); // the first spelling of each tag wins
  for (const t of list) if (!unique.has(key(t))) unique.set(key(t), t);
  return { tags: [...unique.values()].slice(0, 50), tagMode: mode === 'and' ? 'and' : 'or' };
}
