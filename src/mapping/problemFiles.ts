import { basename, dirname } from 'node:path';
import { isAtOrInside, pathKey, remapPath } from './paths';
import { S } from '../shared/strings';

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
 * different problem (a manual link always wins); both also for folders.
 *
 * Folder mode: a linked folder, and files matched by the name of the folder
 * they are in, count as ONE item (the folder), so a package (main.cpp +
 * headers) is one "file" for the notice, the row click and the submit check.
 */
export type LinkHow = 'chosen' | 'cph' | 'filename' | 'folder' | 'suggested';

export interface ProblemFile {
  fsPath: string;
  how: LinkHow;
  /** A folder (folder link, or files matched by their folder's name). */
  folder?: boolean;
}

export interface AutoMatch {
  fsPath: string;
  problemId: number;
  /** 'suggested': the open file's closest (not exact) match; used only to open files (row click), never counted as linked. */
  how: 'cph' | 'filename' | 'folder' | 'suggested';
  /** ms */
  at: number;
}

const RANK: Record<LinkHow, number> = { chosen: 0, cph: 1, filename: 2, folder: 3, suggested: 4 };

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
  /** Saved folder links for this problem (folder mode). */
  chosenFolders?: string[];
  /** All remembered auto-matches (any problem). */
  auto: AutoMatch[];
  /** Files the one matcher (matchIndex.ts) assigns to this problem. */
  matched: { fsPath: string; how: 'filename' | 'folder' | 'suggested' }[];
  /** Files (or folders) explicitly unlinked by the user. */
  unlinked: string[];
  /** Files (or folders) with a saved link to a different problem. */
  linkedElsewhere: string[];
  /** Include remembered (confident) suggestions; default true: they count like links. */
  includeSuggested?: boolean;
  caseInsensitive?: boolean;
}): ProblemFile[] {
  const ci = opts.caseInsensitive;
  const blockedPaths = [...opts.unlinked, ...opts.linkedElsewhere];
  const blocked = (p: string) => blockedPaths.some((b) => isAtOrInside(p, b, ci));
  const out = new Map<string, ProblemFile>();
  const add = (fsPath: string, how: LinkHow, folder = false) => {
    if (how !== 'chosen' && blocked(fsPath)) return;
    // Matched by its folder's name: the folder is the item.
    const path = how === 'folder' && !folder ? dirname(fsPath) : fsPath;
    const isFolder = folder || how === 'folder';
    const k = pathKey(path, ci);
    const prev = out.get(k);
    if (!prev || RANK[how] < RANK[prev.how]) out.set(k, { fsPath: path, how, ...(isFolder || prev?.folder ? { folder: true } : {}) });
  };
  for (const p of opts.chosen) add(p, 'chosen');
  for (const p of opts.chosenFolders ?? []) add(p, 'chosen', true);
  for (const a of opts.auto) if (a.problemId === opts.problemId && (a.how !== 'suggested' || opts.includeSuggested !== false)) add(a.fsPath, a.how);
  for (const m of opts.matched) if (m.how !== 'suggested' || opts.includeSuggested !== false) add(m.fsPath, m.how);
  // A file inside one of the folders is already covered by it (unless chosen on its own).
  const folders = [...out.values()].filter((f) => f.folder).map((f) => f.fsPath);
  return [...out.values()]
    .filter((f) => f.folder || f.how === 'chosen' || !folders.some((d) => isAtOrInside(f.fsPath, d, ci)))
    .sort((a, b) => comparePaths(a.fsPath, b.fsPath));
}

/**
 * Identity of a notice: the set of files and how each is linked. A dismissed
 * notice stays hidden while this is unchanged; a new file, a removed one or a
 * changed link (e.g. a match that gets linked) shows it again.
 */
export function noticeSignature(files: ProblemFile[], caseInsensitive?: boolean): string {
  return files
    .map((f) => `${pathKey(f.fsPath, caseInsensitive)}|${f.how}`)
    .sort()
    .join('\n');
}

/** Is the notice for `problemId` dismissed for exactly this set of files? */
export function noticeDismissed(dismissed: Record<string, string>, problemId: number, files: ProblemFile[], caseInsensitive?: boolean): boolean {
  return files.length > 1 && dismissed[String(problemId)] === noticeSignature(files, caseInsensitive);
}


export interface LinkedNotice {
  text: string;
  files: { path: string; fsPath: string; current: boolean; how: LinkHow; folder?: boolean }[];
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
  const list = files.map((f) => ({
    path: f.folder ? `${rel(f.fsPath)}/` : rel(f.fsPath),
    fsPath: f.fsPath,
    current: f.folder ? isAtOrInside(currentFsPath, f.fsPath, caseInsensitive) : pathKey(f.fsPath, caseInsensitive) === cur,
    how: f.how,
    ...(f.folder ? { folder: true } : {}),
  }));
  // Fixed order (workspace-relative path); the active file is only marked, never moved.
  list.sort((a, b) => comparePaths(a.path, b.path));
  const names = new Set(files.map((f) => pathKey(basename(f.fsPath), caseInsensitive)));
  const others = list.filter((f) => !f.current);
  let text: string;
  // The files are listed below the sentence, so it doesn't repeat a path.
  if (names.size === 1 && others.length === 1) text = S.notice.sameNameOne;
  else if (names.size === 1) text = S.notice.sameNameMany(others.length);
  else text = S.notice.linked(files.length);
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
