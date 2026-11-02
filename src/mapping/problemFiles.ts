import { basename } from 'node:path';
import { pathKey, remapPath } from './paths';

/**
 * "Files for this problem": the one answer used by the duplicate notice,
 * the problem-row click and the before-submit check. (No `vscode` import.)
 *
 * Sources, strongest first:
 *  - chosen:   saved links (chosen by the user, or a confirmed suggestion);
 *  - cph / filename: remembered auto-matches (recorded when the file was open
 *    and matched by CPH data or by its name);
 *  - filename / suggested: what the one matcher (matchIndex.ts) says for the
 *    workspace's source files, opened or not (cached index), plus confident
 *    suggestions remembered while open (treated like links).
 * Excluded: files explicitly "not linked", and files manually linked to a
 * different problem (a manual link always wins).
 */
export type LinkHow = 'chosen' | 'cph' | 'filename' | 'suggested';

export interface ProblemFile {
  fsPath: string;
  how: LinkHow;
}

export interface AutoMatch {
  fsPath: string;
  problemId: number;
  /** 'suggested': the open file's closest (not exact) match; used only to open files (row click), never counted as linked. */
  how: 'cph' | 'filename' | 'suggested';
  /** ms */
  at: number;
}

const RANK: Record<LinkHow, number> = { chosen: 0, cph: 1, filename: 2, suggested: 3 };

/**
 * The one stable order for files of a problem (notice, go-to-file pick,
 * before-submit check): path A–Z, natural and case-insensitive. It never
 * depends on which file is active, so rows don't move.
 */
export function comparePaths(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
}

export function mergeProblemFiles(opts: {
  problemId: number;
  /** Saved links for this problem. */
  chosen: string[];
  /** All remembered auto-matches (any problem). */
  auto: AutoMatch[];
  /** Files the one matcher (matchIndex.ts) assigns to this problem. */
  matched: { fsPath: string; how: 'filename' | 'suggested' }[];
  /** Files explicitly unlinked by the user. */
  unlinked: string[];
  /** Files with a saved link to a different problem. */
  linkedElsewhere: string[];
  /** Include remembered (confident) suggestions; default true: they count like links. */
  includeSuggested?: boolean;
  caseInsensitive?: boolean;
}): ProblemFile[] {
  const ci = opts.caseInsensitive;
  const blocked = new Set([...opts.unlinked, ...opts.linkedElsewhere].map((p) => pathKey(p, ci)));
  const out = new Map<string, ProblemFile>();
  const add = (fsPath: string, how: LinkHow) => {
    const k = pathKey(fsPath, ci);
    if (how !== 'chosen' && blocked.has(k)) return;
    const prev = out.get(k);
    if (!prev || RANK[how] < RANK[prev.how]) out.set(k, { fsPath, how });
  };
  for (const p of opts.chosen) add(p, 'chosen');
  for (const a of opts.auto) if (a.problemId === opts.problemId && (a.how !== 'suggested' || opts.includeSuggested !== false)) add(a.fsPath, a.how);
  for (const m of opts.matched) if (m.how !== 'suggested' || opts.includeSuggested !== false) add(m.fsPath, m.how);
  return [...out.values()].sort((a, b) => comparePaths(a.fsPath, b.fsPath));
}

/** How a file is linked, as shown in the notice. */
export const HOW_TEXT: Readonly<Record<LinkHow, string>> = {
  chosen: 'chosen by you',
  filename: 'matched by file name',
  cph: 'matched from CPH data',
  suggested: 'suggested',
};

export interface LinkedNotice {
  text: string;
  files: { path: string; fsPath: string; current: boolean; how: LinkHow }[];
}

/**
 * The "files for this problem" notice seen from `currentFsPath`; null with
 * fewer than two files. Same file name in different folders → "Another file
 * with the same name also matches this problem: <path>"; otherwise
 * "N files are linked to this problem".
 */
export function linkedNotice(files: ProblemFile[], currentFsPath: string, rel: (fsPath: string) => string, caseInsensitive?: boolean): LinkedNotice | null {
  if (files.length < 2) return null;
  const cur = pathKey(currentFsPath, caseInsensitive);
  const list = files.map((f) => ({ path: rel(f.fsPath), fsPath: f.fsPath, current: pathKey(f.fsPath, caseInsensitive) === cur, how: f.how }));
  // Fixed order (workspace-relative path); the active file is only marked, never moved.
  list.sort((a, b) => comparePaths(a.path, b.path));
  const names = new Set(files.map((f) => pathKey(basename(f.fsPath), caseInsensitive)));
  const others = list.filter((f) => !f.current);
  let text: string;
  // The files are listed below the sentence, so it doesn't repeat a path.
  if (names.size === 1 && others.length === 1) text = 'Another file with the same name also matches this problem.';
  else if (names.size === 1) text = `${others.length} other files with the same name also match this problem.`;
  else text = `${files.length} files are linked to this problem`;
  return { text, files: list };
}

/**
 * Remembered auto-matches after a rename: an entry follows the file only if
 * the one matcher still gives the same problem for the new path
 * (`stillMatches`); CPH matches are dropped (CPH's file belongs to the old
 * path). Returns the new list.
 */
export function autoAfterRename(
  auto: AutoMatch[],
  oldPath: string,
  newPath: string,
  stillMatches: (fsPath: string, problemId: number) => boolean,
  caseInsensitive?: boolean,
): AutoMatch[] {
  const out: AutoMatch[] = [];
  for (const a of auto) {
    const to = remapPath(a.fsPath, oldPath, newPath, caseInsensitive);
    if (to === null) {
      out.push(a);
      continue;
    }
    if (a.how !== 'cph' && stillMatches(to, a.problemId)) out.push({ ...a, fsPath: to });
  }
  return out;
}

/** Drop remembered auto-matches for a deleted file or folder. */
export function autoAfterDelete(auto: AutoMatch[], deleted: string, caseInsensitive?: boolean): AutoMatch[] {
  return auto.filter((a) => remapPath(a.fsPath, deleted, deleted, caseInsensitive) === null);
}
