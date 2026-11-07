import { RUNNER } from '../shared/constants';
import type { CaseList, CaseRun, CompileFailure, RunnerCase, RunSummary } from './types';

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

type Tip = CaseList['sampleTip'];
type Results = ReadonlyMap<string, CaseRun>;

/** Something failed, and every failing case came from the statement's PDF. */
function onlySamplesFail(cases: readonly RunnerCase[], runs: Results): boolean {
  const failing = cases.filter((c) => {
    const r = runs.get(c.id);
    return r?.state === 'done' && r.verdict !== 'AC';
  });
  return failing.length > 0 && failing.every((c) => c.source === 'sample');
}

/** After a run: count runs in a row where only PDF samples fail. */
export function nextSampleTip(tip: Tip, cases: readonly RunnerCase[], runs: Results): NonNullable<Tip> {
  return { dismissed: tip?.dismissed ?? false, failedRuns: onlySamplesFail(cases, runs) ? (tip?.failedRuns ?? 0) + 1 : 0 };
}

/** "PDF samples can be misread": never beside a failing Grader or Custom case. */
export function sampleTipShown(tip: Tip, cases: readonly RunnerCase[], runs: Results): boolean {
  return !tip?.dismissed && (tip?.failedRuns ?? 0) >= RUNNER.sampleTipRuns && onlySamplesFail(cases, runs);
}
