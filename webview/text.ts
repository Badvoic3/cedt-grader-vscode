/**
 * Shorten `s` to at most `max` characters by cutting the middle ("…"), so
 * both the start and the end (e.g. a file extension) stay readable:
 * "Link to hw01_longest_common_subsequence.cpp" → "Link to hw01_l…bsequence.cpp" (28 characters).
 */
export function middleEllipsis(s: string, max: number): string {
  if (max < 5 || s.length <= max) return s;
  const keep = max - 1;
  const tail = Math.floor(keep / 2);
  const head = keep - tail;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/** Characters that fit in a menu at this panel width (≈7 px per character, icon and padding excluded). */
export function menuLabelMax(viewportWidth: number): number {
  return Math.max(20, Math.floor((Math.min(viewportWidth, 420) - 60) / 7));
}
