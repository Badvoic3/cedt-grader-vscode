/**
 * Problem tags in the Problems list. The website's topic tags (`/main/list`
 * `.topic-badge`, e.g. ComProg / DataAlgo) are the single-choice pills; every
 * other tag a problem has (e.g. Graph, DFS) is offered in the "Tags" dropdown,
 * several at once, matched with AND or OR. No `vscode` import (shared with the webview).
 */
export type TagMode = 'and' | 'or';

/** Tags compare without case or outer spaces. */
export const tagKey = (t: string): string => t.trim().toLowerCase();

/**
 * Tags for the dropdown: every tag of the problems that isn't a topic pill
 * (case-insensitive), plus selected tags no problem has any more (so they can
 * be unticked). Sorted by name, natural order.
 */
export function otherTags(problems: { tags?: string[] }[], topics: { name: string }[], selected: string[] = []): string[] {
  const topicKeys = new Set(topics.map((t) => tagKey(t.name)));
  const seen = new Map<string, string>();
  for (const t of [...problems.flatMap((p) => p.tags ?? []), ...selected]) {
    const k = tagKey(t);
    if (k && !topicKeys.has(k) && !seen.has(k)) seen.set(k, t.trim());
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

/** Does a problem pass the tag filter? No tags chosen → yes. OR: any of them; AND: all of them. */
export function matchesTags(problemTags: string[] | undefined, chosen: string[] | undefined, mode: TagMode | undefined): boolean {
  if (!chosen?.length) return true;
  const have = new Set((problemTags ?? []).map(tagKey));
  return mode === 'and' ? chosen.every((t) => have.has(tagKey(t))) : chosen.some((t) => have.has(tagKey(t)));
}

/** A stored filter's tag part, cleaned (strings only, no duplicates, at most 50). */
export function cleanTagFilter(tags: unknown, mode: unknown): { tags: string[]; tagMode: TagMode } {
  const list = Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim()) : [];
  const unique = new Map<string, string>(); // the first spelling of each tag wins
  for (const t of list) if (!unique.has(tagKey(t))) unique.set(tagKey(t), t);
  return { tags: [...unique.values()].slice(0, 50), tagMode: mode === 'and' ? 'and' : 'or' };
}

// ------------------------------------------------------------ topic pills

/** A topic pill: not chosen, hide problems with it ('out'), or show only problems with it ('in'). */
export type TopicState = 'off' | 'out' | 'in';

interface TopicFilter {
  /** Older saved filters: one topic, shown only. */
  topic?: string | null;
  topicsIn?: string[];
  topicsOut?: string[];
}

/** Shown-only and hidden topics of a filter (an older `topic` counts as shown-only). */
export function topicSets(f: TopicFilter): { inc: string[]; exc: string[] } {
  const inc = f.topicsIn ?? (f.topic ? [f.topic] : []);
  const exc = f.topicsOut ?? [];
  return { inc, exc: exc.filter((t) => !inc.some((i) => tagKey(i) === tagKey(t))) };
}

export function topicState(f: TopicFilter, name: string): TopicState {
  const { inc, exc } = topicSets(f);
  if (inc.some((t) => tagKey(t) === tagKey(name))) return 'in';
  if (exc.some((t) => tagKey(t) === tagKey(name))) return 'out';
  return 'off';
}

/** Order of the three states on clicks (setting `cedtGrader.panel.topicClickOrder`). */
export type TopicClickOrder = 'showFirst' | 'hideFirst';

/**
 * Click on a pill. `showFirst` (default): not chosen → show only → hide → not chosen;
 * `hideFirst`: not chosen → hide → show only → not chosen. Clears the older single `topic`.
 */
export function cycleTopic(f: TopicFilter, name: string, order: TopicClickOrder = 'showFirst'): { topic: null; topicsIn: string[]; topicsOut: string[] } {
  const steps: TopicState[] = order === 'hideFirst' ? ['off', 'out', 'in'] : ['off', 'in', 'out'];
  const next = steps[(steps.indexOf(topicState(f, name)) + 1) % steps.length];
  const { inc, exc } = topicSets(f);
  const without = (list: string[]) => list.filter((t) => tagKey(t) !== tagKey(name));
  return {
    topic: null,
    topicsIn: next === 'in' ? [...without(inc), name] : without(inc),
    topicsOut: next === 'out' ? [...without(exc), name] : without(exc),
  };
}

/** Does a problem pass the topic pills? At least one shown-only topic (if any), and no hidden one. */
export function matchesTopics(problemTags: string[] | undefined, f: TopicFilter): boolean {
  const { inc, exc } = topicSets(f);
  const have = new Set((problemTags ?? []).map(tagKey));
  if (inc.length && !inc.some((t) => have.has(tagKey(t)))) return false;
  return !exc.some((t) => have.has(tagKey(t)));
}

/** A stored filter's topic part, cleaned (an older `topic` becomes a shown-only topic). */
export function cleanTopicFilter(f: { topic?: unknown; topicsIn?: unknown; topicsOut?: unknown }): { topic: null; topicsIn: string[]; topicsOut: string[] } {
  const legacy = typeof f.topic === 'string' && f.topic.trim() ? [f.topic] : [];
  const inc = cleanTagFilter(f.topicsIn ?? legacy, 'or').tags;
  const exc = cleanTagFilter(f.topicsOut, 'or').tags.filter((t) => !inc.some((i) => tagKey(i) === tagKey(t)));
  return { topic: null, topicsIn: inc, topicsOut: exc };
}
