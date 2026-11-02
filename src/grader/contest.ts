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
  const m = /<[^>]*\bid=["']countdown["'][^>]*>([^<]*)</i.exec(html);
  return m !== null && !/analysis mode/i.test(m[1]);
}
