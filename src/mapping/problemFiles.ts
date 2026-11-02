import { basename } from 'node:path';
import { fileStem, normalizeName } from './match';
import { pathKey, remapPath } from './paths';

/**
 * "Files for this problem": the one answer used by the duplicate notice,
 * the problem-row click and the before-submit check. (No `vscode` import.)
 *
 * Sources, strongest first:
 *  - chosen:   saved links (chosen by the user, or a confirmed suggestion);
 *  - cph / filename: remembered auto-matches (recorded when the file was open
 *    and matched by CPH data or by its name);
 *  - filename: files that would match by name but were never opened (one
 *    cached file search per problem).
 * Excluded: files explicitly "not linked", and files manually linked to a
 * different problem (a manual link always wins).
 */
export type LinkHow = 'chosen' | 'cph' | 'filename';

export interface ProblemFile {
  fsPath: string;
  how: LinkHow;
}

export interface AutoMatch {
  fsPath: string;
  problemId: number;
  how: 'cph' | 'filename';
  /** ms */
  at: number;
}

const RANK: Record<LinkHow, number> = { chosen: 0, cph: 1, filename: 2 };

export function mergeProblemFiles(opts: {
  problemId: number;
  /** Saved links for this problem. */
  chosen: string[];
  /** All remembered auto-matches (any problem). */
  auto: AutoMatch[];
  /** File-search hits for this problem's clean name. */
  searched: string[];
  /** Files explicitly unlinked by the user. */
  unlinked: string[];
  /** Files with a saved link to a different problem. */
  linkedElsewhere: string[];
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
  for (const a of opts.auto) if (a.problemId === opts.problemId) add(a.fsPath, a.how);
  for (const p of opts.searched) add(p, 'filename');
  return [...out.values()].sort((a, b) => RANK[a.how] - RANK[b.how] || a.fsPath.localeCompare(b.fsPath));
}

/** How a file is linked, as shown in the notice. */
export const HOW_TEXT: Readonly<Record<LinkHow, string>> = {
  chosen: 'chosen by you',
  filename: 'matched by file name',
  cph: 'matched from CPH data',
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
  // The current file first, then the rest in the given order.
  list.sort((a, b) => Number(b.current) - Number(a.current));
  const names = new Set(files.map((f) => pathKey(basename(f.fsPath), caseInsensitive)));
  const others = list.filter((f) => !f.current);
  let text: string;
  if (names.size === 1 && others.length === 1) text = `Another file with the same name also matches this problem: ${others[0].path}`;
  else if (names.size === 1) text = `${others.length} other files with the same name also match this problem`;
  else text = `${files.length} files are linked to this problem`;
  return { text, files: list };
}

/**
 * Remembered auto-matches after a rename: an entry follows the file only if
 * it still matches by name (`stillMatches`); CPH matches are dropped (CPH's
 * file belongs to the old path). Returns the new list.
 */
export function autoAfterRename(auto: AutoMatch[], oldPath: string, newPath: string, problemName: (id: number) => string | undefined, caseInsensitive?: boolean): AutoMatch[] {
  const out: AutoMatch[] = [];
  for (const a of auto) {
    const to = remapPath(a.fsPath, oldPath, newPath, caseInsensitive);
    if (to === null) {
      out.push(a);
      continue;
    }
    const name = problemName(a.problemId);
    if (a.how === 'filename' && name && normalizeName(fileStem(to)) === normalizeName(name)) out.push({ ...a, fsPath: to });
  }
  return out;
}

/** Drop remembered auto-matches for a deleted file or folder. */
export function autoAfterDelete(auto: AutoMatch[], deleted: string, caseInsensitive?: boolean): AutoMatch[] {
  return auto.filter((a) => remapPath(a.fsPath, deleted, deleted, caseInsensitive) === null);
}

/**
 * Cached file search per problem. `find` (one workspace.findFiles) runs at
 * most once per problem until `invalidate()` (file create/delete/rename,
 * debounced by the caller).
 */
export class ProblemFileSearch {
  private readonly cache = new Map<number, Promise<string[]>>();

  constructor(private readonly find: (problemId: number) => Promise<string[]>) {}

  get(problemId: number): Promise<string[]> {
    let p = this.cache.get(problemId);
    if (!p) {
      p = this.find(problemId).catch(() => []);
      this.cache.set(problemId, p);
    }
    return p;
  }

  /** Cached result without searching (undefined when never searched). */
  peek(problemId: number): Promise<string[]> | undefined {
    return this.cache.get(problemId);
  }

  invalidate(): void {
    this.cache.clear();
  }
}
