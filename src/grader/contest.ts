/**
 * Cheap exam/contest hint for a grader page we already fetched.
 *
 * cafe-grader's header (`app/views/layouts/_header.html.haml`) renders a
 * `#countdown` element and fills `Date.parse('<contest end>')` only in
 * contest mode. "ANALYSIS MODE" (after an exam) is not a contest.
 *
 * This is deliberately minimal: the extension is a homework tool and only
 * warns. A fuller implementation (contest windows, per-problem contest
 * membership) could go here if ever needed.
 */
export function isContestPage(html: string): boolean {
  if (/Date\.parse\(\s*'[^']+'\s*\)/.test(html)) return true;
  const text = countdownText(html);
  return text !== null && !/analysis mode/i.test(text);
}

/**
 * The text of the `#countdown` element: the same answer as
 * `/<[^>]*\bid=["']countdown["'][^>]*>([^<]*)</i`, found in one pass. That
 * regex retries every `<` up to the next `>`, so a page with a long run of
 * `<` and no `>` took minutes. An `id="countdown"` counts when the nearest
 * `<` / `>` before it is a `<` (it is inside a tag); the text runs from the
 * next `>` to the next `<`.
 */
function countdownText(html: string): string | null {
  const re = /\bid=["']countdown["']/gi;
  let scanned = 0;
  let inTag = false; // the last `<` / `>` before `scanned` was a `<`
  for (let m = re.exec(html); m; m = re.exec(html)) {
    for (; scanned < m.index; scanned++) {
      const ch = html.charCodeAt(scanned);
      if (ch === 60 /* < */) inTag = true;
      else if (ch === 62 /* > */) inTag = false;
    }
    if (!inTag) continue;
    // Every later candidate shares this `>` or comes after it: one answer either way.
    const close = html.indexOf('>', m.index + m[0].length);
    if (close < 0) return null;
    const end = html.indexOf('<', close + 1);
    return end < 0 ? null : html.slice(close + 1, end);
  }
  return null;
}
