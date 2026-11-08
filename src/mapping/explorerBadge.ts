import { scoreText, summarize } from '../grader/score';
import type { Problem } from '../grader/types';
import { SERVER_SCORE_CAP } from '../shared/constants';
import { PICK_HOW, S } from '../shared/strings';
import { tagKey } from '../shared/tags';
import { cleanName } from './match';
import type { LinkHow } from './problemFiles';

/**
 * What the Explorer shows for a problem (no `vscode` import). VS Code refuses a
 * badge over 2 characters and then draws nothing, so a full score is one
 * character and other scores are rounded down: 99.9 never reads as full.
 */
export type BadgeMode = 'score' | 'tag' | 'off';

export interface BadgeView {
  badge?: string;
  tooltip: string;
  /** A colour id from `contributes.colors`; null: the theme's normal text colour. */
  color: string | null;
}

const COLOR = 'cedtGrader.explorer';
export const FULL_SCORE_BADGE = '✓';
export const UNTRIED_BADGE = '–';
export const TAG_COLORS = [1, 2, 3, 4, 5, 6].map((n) => `${COLOR}.tag${n}`);

export function scoreBadge(counted: number | null): string {
  if (counted === null) return UNTRIED_BADGE;
  return counted >= SERVER_SCORE_CAP ? FULL_SCORE_BADGE : String(Math.floor(counted));
}

export function scoreColor(counted: number | null): string {
  if (counted === null) return `${COLOR}.untried`;
  if (counted >= SERVER_SCORE_CAP) return `${COLOR}.solved`;
  return counted > 0 ? `${COLOR}.inProgress` : `${COLOR}.zero`;
}

/** The first two letters of a tag, whole graphemes, so a Thai vowel mark stays on its consonant. Nothing printable: undefined. */
export function tagBadge(tag: string): string | undefined {
  // Upper case first: it can make a letter longer (ß → SS), and VS Code counts what it gets.
  const text = tag.replace(/[^\p{L}\p{N}\p{M}]/gu, '').toUpperCase();
  const letters = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].slice(0, 2);
  return letters.map((l) => l.segment).join('') || undefined;
}

/** The same tag gets the same colour everywhere, whatever the order of the list. */
export function tagColor(tag: string): string {
  let hash = 2166136261; // FNV-1a
  for (const c of tag.trim().toLowerCase()) hash = Math.imul(hash ^ (c.codePointAt(0) ?? 0), 16777619) >>> 0;
  return TAG_COLORS[hash % TAG_COLORS.length];
}

/** The tag a badge stands for: the first topic tag, or the first tag when none is a topic. */
export function badgeTag(tags: readonly string[], topics: readonly string[]): string | undefined {
  const isTopic = new Set(topics.map(tagKey));
  return tags.find((t) => isTopic.has(tagKey(t))) ?? tags[0];
}

/** Null when `mode` is off. A suggestion is only a guess, so it never takes a colour. */
export function badgeView(p: Problem, how: LinkHow, mode: BadgeMode, colors: boolean, topics: readonly string[] = []): BadgeView | null {
  if (mode === 'off') return null;
  const { counted, rawSum } = summarize(p);
  const tag = badgeTag(p.tags, topics);
  const isTopic = new Set(topics.map(tagKey));
  const categories = p.tags.filter((t) => isTopic.has(tagKey(t)));
  const others = p.tags.filter((t) => !isTopic.has(tagKey(t)));
  const tooltip = [
    `${cleanName(p.name)} #${p.id}`,
    ...(categories.length ? [S.explorer.category(categories.join(', '))] : []),
    ...(others.length ? [others.join(', ')] : []),
    // The badge is one character at full score: the tooltip has the number.
    counted === null ? S.explorer.notTried : S.explorer.counted(scoreText(counted, rawSum).text),
    PICK_HOW[how],
  ].join(' · ');
  const color = !colors || how === 'suggested' ? null : mode === 'score' ? scoreColor(counted) : tag ? tagColor(tag) : null;
  return { badge: mode === 'score' ? scoreBadge(counted) : tag ? tagBadge(tag) : undefined, tooltip, color };
}
