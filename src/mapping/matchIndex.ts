import type { Problem } from '../grader/types';
import { resolveProblem } from './match';

/**
 * ONE matcher for both directions (no `vscode` import, unit tested):
 *  - file → problem: `matchFile` (= `resolveProblem` without a saved link or CPH data);
 *  - problem → file: `buildMatchIndex` runs the very same function over the
 *    workspace's source files, so clicking a problem finds exactly the files
 *    that would show that problem when opened.
 * Same normalization, confidence score, threshold, tie rule and folder/tag
 * bonus (src/mapping/match.ts, MATCH in src/shared/constants.ts). Saved
 * links and CPH data are layered on top by the caller (they win).
 */
export interface SourceFile {
  fsPath: string;
  /** Workspace-relative parent folder names (folder/tag bonus). */
  folders: string[];
}

export interface FileMatch {
  problemId: number;
  /** Exact normalized name, or a confident suggestion. */
  how: 'filename' | 'suggested';
}

/** The problem a file would show when opened (null: none, below the threshold, or a tie). */
export function matchFile(file: SourceFile, problems: Problem[], baseUrl: string, namePattern?: string): FileMatch | null {
  const r = resolveProblem({ savedProblemId: null, cph: null, filePath: file.fsPath, problems, baseUrl, folders: file.folders, namePattern });
  if (r.kind !== 'match') return null;
  if (r.source !== 'filename' && r.source !== 'suggested') return null;
  return { problemId: r.problem.id, how: r.source };
}

export interface IndexedFile {
  fsPath: string;
  how: 'filename' | 'suggested';
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
