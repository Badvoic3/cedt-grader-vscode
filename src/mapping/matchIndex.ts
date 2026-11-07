import type { Problem } from '../grader/types';
import { resolveProblem } from './match';
import { pathKey } from './paths';

/**
 * ONE matcher for both directions (no `vscode` import, unit tested):
 *  - file → problem: `matchFile` (= `resolveProblem` without a saved link);
 *  - problem → file: `buildMatchIndex` runs the very same function over the
 *    workspace's source files, so clicking a problem finds exactly the files
 *    that would show that problem when opened.
 * Same normalization, confidence score, threshold, tie rule and folder/tag
 * bonus (src/mapping/match.ts, MATCH in src/shared/constants.ts). Saved
 * links are layered on top by the caller (they win).
 */
export interface SourceFile {
  fsPath: string;
  /** Workspace-relative parent folder names (folder/tag bonus). */
  folders: string[];
}

/** Folder names of a workspace-relative directory (`asRelativePath` of the file's folder): no `.`, no drive / outside path. */
export function foldersOf(relDir: string): string[] {
  return relDir.split('/').filter((x) => x && x !== '.' && !x.includes(':'));
}

/**
 * The folder names the matcher sees for a file's folder: the workspace folder's
 * name and the folders below it. Outside a workspace only the immediate parent
 * counts, so OS path segments such as `Users` or `Downloads` never match.
 */
export function folderNames(dir: string, relDir: string, root: { path: string; name: string } | null): string[] {
  if (!root) return dir.split(/[\\/]/).filter(Boolean).slice(-1);
  return pathKey(dir) === pathKey(root.path) ? [root.name] : [root.name, ...foldersOf(relDir)];
}

export interface FileMatch {
  problemId: number;
  /** Exact normalized file name, exact name of the folder it is in, or a confident suggestion. */
  how: 'filename' | 'folder' | 'suggested';
}

/** The problem a file would show when opened (null: none, below the threshold, or a tie). */
export function matchFile(file: SourceFile, problems: Problem[], baseUrl: string, namePattern?: string): FileMatch | null {
  const r = resolveProblem({ savedProblemId: null, filePath: file.fsPath, problems, baseUrl, folders: file.folders, namePattern });
  if (r.kind !== 'match') return null;
  if (r.source !== 'filename' && r.source !== 'folder' && r.source !== 'suggested') return null;
  return { problemId: r.problem.id, how: r.source };
}

export interface IndexedFile {
  fsPath: string;
  how: 'filename' | 'folder' | 'suggested';
}

/** problem id → files, computed with `matchFile` (so both directions always agree). */
export function buildMatchIndex(files: SourceFile[], problems: Problem[], baseUrl: string, namePattern?: string): Map<number, IndexedFile[]> {
  const out = new Map<number, IndexedFile[]>();
  if (!problems.length) return out;
  for (const f of files) {
    const m = matchFile(f, problems, baseUrl, namePattern);
    if (!m) continue;
    const list = out.get(m.problemId) ?? [];
    list.push({ fsPath: f.fsPath, how: m.how });
    out.set(m.problemId, list);
  }
  return out;
}

/**
 * One cached async value (the match index): computed at most once until
 * `invalidate()` (file create / delete / rename, problem list reloaded).
 * A failed computation counts as empty and is cached too (no retry loop).
 */
export class OnceCache<T> {
  private value: Promise<T> | undefined;

  constructor(
    private readonly compute: () => Promise<T>,
    private readonly empty: () => T,
  ) {}

  get(): Promise<T> {
    if (!this.value) this.value = this.compute().catch(() => this.empty());
    return this.value;
  }

  /** The cached value without computing (undefined when not computed yet). */
  peek(): Promise<T> | undefined {
    return this.value;
  }

  invalidate(): void {
    this.value = undefined;
  }
}
