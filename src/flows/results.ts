import type { Problem, SubmissionResult } from '../grader';
import { remapPath } from '../mapping/paths';
import type { ResultView } from '../shared/messages';
import { S } from '../shared/strings';

/**
 * Result section state, per submitted file (no `vscode` import; unit tested).
 * The panel shows only the active file's result.
 */

export function newResult(problem: Pick<Problem, 'id' | 'name'>, phase: ResultView['phase'], message: string | null): ResultView {
  return {
    phase,
    problemId: problem.id,
    problemName: problem.name,
    submissionId: null,
    submissionUrl: null,
    number: null,
    points: null,
    comment: null,
    verdicts: [],
    compileError: false,
    compilerMessage: null,
    improvement: null,
    message,
  };
}

/** What one poll update (or a fetched detail) changes in the result. */
export function submissionPatch(s: SubmissionResult, submissionUrl: string): Partial<ResultView> {
  const graded = s.state === 'graded';
  return {
    phase: graded ? 'done' : 'grading',
    submissionId: s.id,
    submissionUrl,
    number: s.number,
    points: s.points,
    comment: s.comment,
    verdicts: s.verdicts,
    compileError: s.compileError,
    compilerMessage: s.compileError ? (s.compilerMessage ?? '') : null,
    message: graded ? (s.compileError ? S.submit.compilationError : null) : S.submit.waitingStatus(s.status.replace(/_/g, ' ')),
  };
}

/** Latest result per source file (fsPath). */
export class ResultStore {
  private readonly byFile = new Map<string, ResultView>();

  get(file: string | null | undefined): ResultView | undefined {
    return file ? this.byFile.get(file) : undefined;
  }

  set(file: string, r: ResultView): void {
    this.byFile.set(file, r);
  }

  /** Merge into an existing result; false when the file has none. */
  update(file: string, patch: Partial<ResultView>): boolean {
    const r = this.byFile.get(file);
    if (!r) return false;
    this.byFile.set(file, { ...r, ...patch });
    return true;
  }

  clear(): void {
    this.byFile.clear();
  }

  /** A file or folder was renamed: results follow their files. */
  rename(oldPath: string, newPath: string): void {
    for (const key of [...this.byFile.keys()]) {
      const to = remapPath(key, oldPath, newPath);
      if (to) {
        this.byFile.set(to, this.byFile.get(key)!);
        this.byFile.delete(key);
      }
    }
  }
}

/** The file edited after `mine` most recently (before-submit "changed more recently" check), or null. */
export function newestAfter<T extends { t: number }>(mine: number, others: T[]): T | null {
  let newest: T | null = null;
  for (const o of others) if (o.t > mine && (!newest || o.t > newest.t)) newest = o;
  return newest;
}

/** The counted (best) submission in a newest-first history: highest points; on a tie the earliest one. */
export function countedSubmissionId(items: { id: number; points: number | null }[]): number | null {
  let countedId: number | null = null;
  let best = -Infinity;
  for (let i = items.length - 1; i >= 0; i--) {
    const pts = items[i].points;
    if (pts !== null && pts > best) {
      best = pts;
      countedId = items[i].id;
    }
  }
  return best > 0 ? countedId : null;
}
