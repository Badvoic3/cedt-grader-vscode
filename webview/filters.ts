import type { ProblemFilter, ProblemView } from '../src/shared/messages';

/** Text search: name, full name, or id ("1360" / "#1360"). */
export function matches(p: ProblemView, q: string): boolean {
  return !q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q) || String(p.id) === q || `#${p.id}` === q;
}

/**
 * Problem-list filters, same rules as the website (main/list.html.haml):
 * All / Unsolved (untried or in progress) / In progress / Solved, a topic
 * tag, and the text search, combined.
 */
export function filterProblems(items: ProblemView[], f: ProblemFilter, q: string): ProblemView[] {
  return items.filter((p) => {
    if (f.status === 'unsolved' && p.status === 'solved') return false;
    if ((f.status === 'inprogress' || f.status === 'solved') && p.status !== f.status) return false;
    if (f.topic && !(p.tags ?? []).includes(f.topic)) return false;
    return matches(p, q);
  });
}
