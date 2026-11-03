import { W } from '../src/shared/strings';
import type { ProblemFilter, ProblemSort, ProblemView } from '../src/shared/messages';
import { matchesTags, matchesTopics } from '../src/shared/tags';

/** Text search: name, full name, or id ("1360" / "#1360"). */
export function matches(p: ProblemView, q: string): boolean {
  return !q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q) || String(p.id) === q || `#${p.id}` === q;
}

/**
 * Problem-list filters, same rules as the website (main/list.html.haml):
 * All / Unsolved (untried or in progress) / In progress / Solved, the topic
 * pills (show only / hide), the other tags chosen in the "Tags" dropdown (any / all of them), and
 * the text search, combined.
 */
export function filterProblems(items: ProblemView[], f: ProblemFilter, q: string): ProblemView[] {
  return items.filter((p) => {
    if (f.status === 'unsolved' && p.status === 'solved') return false;
    if ((f.status === 'inprogress' || f.status === 'solved') && p.status !== f.status) return false;
    if (!matchesTopics(p.tags, f)) return false;
    if (!matchesTags(p.tags, f.tags, f.tagMode)) return false;
    return matches(p, q);
  });
}

/** Sort choices, labels in the current display language. */
export function sorts(): { key: ProblemSort; label: string }[] {
  return [
    { key: 'default', label: W.defaultOrder },
    { key: 'name-asc', label: W.nameAZ },
    { key: 'name-desc', label: W.nameZA },
    { key: 'latest', label: W.latestSubmission },
    { key: 'score-asc', label: W.bestScoreLowToHigh },
    { key: 'score-desc', label: W.bestScoreHighToLow },
    { key: 'recent', label: W.recentlyOpened },
  ];
}

/**
 * Order for the problem list (after filtering). Stable: ties keep the
 * grader's order. Problems without the sort key (never submitted / opened)
 * go last.
 */
export function sortProblems(items: ProblemView[], sort: ProblemSort = 'default'): ProblemView[] {
  if (sort === 'default') return items;
  const indexed = items.map((p, i) => ({ p, i }));
  const by = (key: (p: ProblemView) => number | null, dir: 1 | -1) =>
    indexed
      .sort((a, b) => {
        const ka = key(a.p);
        const kb = key(b.p);
        if (ka === null && kb === null) return a.i - b.i;
        if (ka === null) return 1;
        if (kb === null) return -1;
        return (ka - kb) * dir || a.i - b.i;
      })
      .map((x) => x.p);
  switch (sort) {
    case 'name-asc':
    case 'name-desc': {
      const dir = sort === 'name-asc' ? 1 : -1;
      return indexed
        .sort((a, b) => a.p.name.localeCompare(b.p.name, undefined, { numeric: true, sensitivity: 'base' }) * dir || a.i - b.i)
        .map((x) => x.p);
    }
    case 'latest':
      return by((p) => (p.lastSubmissionTime ? Date.parse(p.lastSubmissionTime) : null), -1);
    case 'score-asc':
      return by((p) => p.score.counted, 1);
    case 'score-desc':
      return by((p) => p.score.counted, -1);
    case 'recent':
      return by((p) => p.lastOpened, -1);
    default:
      return items;
  }
}
