import type { CaseRun, CompileFailure, RunnerCase, RunSummary } from './types';

/** One list's run, in memory: after a restart it reads "Not run". */
export interface RunState {
  phase: 'idle' | 'compiling' | 'running';
  runs: Map<string, CaseRun>;
  failure: CompileFailure | null;
  /** Folder mode: files with their own `main()` that weren't compiled. */
  leftOut: string[];
  warnings: string;
}

export const emptyState = (): RunState => ({ phase: 'idle', runs: new Map(), failure: null, leftOut: [], warnings: '' });

/** The pill: what a list's run says now. Cases added since the last run count as not passed. */
export function summarize(cases: readonly Pick<RunnerCase, 'id'>[], s: RunState): RunSummary {
  if (s.phase === 'compiling') return { kind: 'compiling' };
  const runs = cases.flatMap((c) => s.runs.get(c.id) ?? []);
  if (s.phase === 'running') {
    const active = runs.filter((r) => r.state !== 'stopped');
    return { kind: 'running', done: active.filter((r) => r.state === 'done').length, total: active.length };
  }
  if (s.failure) return { kind: 'compile-error' };
  if (!cases.length) return { kind: 'no-cases' };
  const done = runs.filter((r) => r.state === 'done');
  if (!done.length) return { kind: 'not-run' };
  return { kind: 'done', passed: done.filter((r) => r.verdict === 'AC').length, total: cases.length };
}

/** Every case passed: Run tests leaves the split closed. */
export function allPassed(s: RunSummary): boolean {
  return s.kind === 'done' && s.passed === s.total;
}
