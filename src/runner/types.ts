import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';

/**
 * The built-in runner's shared data (no `vscode` import). These shapes serve
 * both the runner and the Test split view; `CaseList` is what is stored
 * on disk, everything else lives in memory.
 */

/** Where a case came from (the badge). `sample` = read from the statement PDF. */
export type CaseSource = 'grader' | 'sample' | 'custom';

export interface RunnerCase {
  /** Stable across edits and reorders. */
  id: string;
  source: CaseSource;
  input: string;
  expected: string;
  /** Grader cases: the server's id, so a second Load updates the case instead of adding it again. */
  testcaseId?: number;
}

/** Whose list it is: a problem, or a file with no problem linked. */
export type CaseOwner = { problemId: number } | { file: string };

/**
 * One runner list, as stored on disk: `runner-cases/<host>/<problemId>.json`
 * for a problem, `runner-cases/_unlinked/<hash>.json` for an unlinked file
 * (only `Custom` cases, since there is nothing to load them from).
 */
export interface CaseList {
  version: 1;
  problemId?: number;
  /** Unlinked file: its absolute path. */
  file?: string;
  /** Array order is the display order. */
  cases: RunnerCase[];
  /** Last limits read from the grader, kept for offline use. */
  limits?: { timeMs: number; memoryMB: number; fetchedAt: string };
  sampleTip?: { failedRuns: number; dismissed: boolean };
}

export interface RunLimits {
  timeMs: number;
  memoryMB: number;
  source: 'grader' | 'default';
}

/** Text kept from a stream: cut at the display limit, `truncated` says so. */
export interface Captured {
  text: string;
  truncated: boolean;
}

/** `OLE`: output limit. `MLE` is an estimate (the grader may report the same run differently). */
export type Verdict = 'AC' | 'WA' | 'TLE' | 'MLE' | 'RE' | 'OLE';

export interface CaseRun {
  caseId: string;
  state: 'pending' | 'running' | 'done' | 'stopped';
  verdict?: Verdict;
  timeMs?: number;
  /** Estimate; null shows "—" (Windows, or measuring failed). */
  memoryKB?: number | null;
  exitCode?: number | null;
  signal?: string | null;
  actual?: Captured;
  stderr?: Captured;
}

export type RunSummary =
  | { kind: 'no-cases' }
  | { kind: 'not-run' }
  | { kind: 'compiling' }
  | { kind: 'running'; done: number; total: number }
  | { kind: 'done'; passed: number; total: number }
  | { kind: 'compile-error' };

export interface CompileFailure {
  message: string;
  file: string | null;
  line: number | null;
}

/** The part of a spawned process the runner uses; a fake in tests. */
export type RunnerChild = Pick<ChildProcessWithoutNullStreams, 'pid' | 'stdin' | 'stdout' | 'stderr' | 'on' | 'once' | 'kill'>;

/** Everything that starts or stops a process goes through here, so tests never start one. */
export interface ProcessApi {
  spawn(command: string, args: readonly string[], options: SpawnOptionsWithoutStdio): RunnerChild;
  /** Kill the process and everything it started. Never throws. */
  killTree(child: RunnerChild): void;
}
