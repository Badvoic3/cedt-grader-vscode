/** A language as the API reports it (`GET /api/v1/languages`). */
export interface Language {
  id: number;
  /** Display name, e.g. `C++` (API `pretty_name`). */
  name: string;
  /** Internal name, e.g. `cpp` (API `name`). */
  code: string;
  /** File extension without dot, e.g. `cpp`. */
  ext: string;
}

/** Hint / AI-assist penalty and dataset mode, read from the `/main/list` HTML (the API lacks it). */
export interface ListScoreInfo {
  /** Raw max points shown by the list (`td[data-order]`). */
  rawMax: number | null;
  /** Adjusted score the list shows in green (null in raw-sum mode). */
  adjusted: number | null;
  /** Total hint + AI-assist cost ("Full score reduced by N"), 0 if none. */
  cost: number;
  hintCount: number;
  aiCount: number;
  /** Live dataset uses "raw sum" scoring: no 100 cap, no penalty. */
  rawSum: boolean;
}

export interface Problem {
  id: number;
  /** Short code name, e.g. `00_Intro_11`. */
  name: string;
  /** Human title. */
  fullName: string;
  /** Max points over regular submissions (API `best_score`), null when untried. */
  bestScore: number | null;
  lastScore: number | null;
  lastResult: string | null;
  lastSubmissionId: number | null;
  lastSubmissionTime: string | null;
  submissionCount: number;
  hasTestcase: boolean;
  hasAttachment: boolean;
  /** Allowed language ids; null = all languages. */
  permittedLanguageIds: number[] | null;
  /** Public tag names (API `tags`). */
  tags: string[];
  /** From the HTML problem list, when it could be loaded. */
  list: ListScoreInfo | null;
}

/** A "topic" tag the website shows as a filter pill (`Tag.where(kind: 'topic')`). */
export interface TopicTag {
  name: string;
  description: string | null;
}

/** Status as on the website's problem list (`main/_problem.html.haml`). */
export type ProblemStatus = 'solved' | 'inprogress' | 'untried';

/** solved = submitted and best >= 100; inprogress = submitted and best < 100; untried = no submission. */
export function problemStatus(p: Pick<Problem, 'submissionCount' | 'bestScore' | 'lastSubmissionId'>): ProblemStatus {
  const submitted = p.submissionCount > 0 || p.lastSubmissionId !== null;
  if (!submitted) return 'untried';
  return (p.bestScore ?? 0) >= 100 ? 'solved' : 'inprogress';
}

export interface ProblemDetail extends Problem {
  fullScore: number | null;
  submissionIds: number[];
}

export interface Verdict {
  /** 1-based test number. */
  index: number;
  ok: boolean;
  /** e.g. `Test 10 of 20: Wrong Answer`. */
  label: string;
  /** cafe-grader result kind, e.g. `correct`, `wrong`, `time_limit` (or `unknown`). */
  kind: string;
  /** Scoring group (1-based) for tests inside `[...]`. */
  group?: number;
}

export type SubmissionApiStatus =
  | 'submitted'
  | 'evaluating'
  | 'done'
  | 'compilation_error'
  | 'compilation_success'
  | 'grader_error'
  | string;

export interface SubmissionResult {
  id: number;
  /** Attempt number for this problem (API `number`). */
  number: number | null;
  problemId: number;
  status: SubmissionApiStatus;
  state: 'pending' | 'graded';
  points: number | null;
  comment: string | null;
  compilerMessage: string | null;
  compileError: boolean;
  verdicts: Verdict[];
  submittedAt: string | null;
  language: string | null;
}

export interface EvaluationResult {
  testcaseId: number;
  /** cafe-grader result kind: correct, wrong, partial, time_limit, ... */
  result: string | null;
  score: number | null;
  /** Milliseconds (the website shows time / 1000 s). */
  timeMs: number | null;
  /** Kilobytes (the website shows memory / 1024 MB). */
  memoryKb: number | null;
}

/** `GET /api/v1/submissions/{id}` in full. */
export interface SubmissionDetail extends SubmissionResult {
  /** Only for your own submissions. */
  source: string | null;
  sourceFilename: string | null;
  maxRuntimeMs: number | null;
  peakMemoryKb: number | null;
  evaluations: EvaluationResult[];
}

export interface SubmissionBrief {
  id: number;
  number: number | null;
  language: string | null;
  submittedAt: string | null;
  points: number | null;
  status: SubmissionApiStatus;
  comment: string | null;
}

/** `GET /api/v1/problems/{id}/testcases` entry. */
export interface TestcaseInfo {
  id: number;
  num: number;
  group: number | null;
  groupName: string | null;
  weight: number | null;
  /** `preview` for students (large files are truncated), `full` for staff. */
  access: string;
  inputBytes: number | null;
  solBytes: number | null;
}

export interface GraderUser {
  id: number;
  login: string;
  fullName: string;
}

export interface StoredToken {
  token: string;
  /** ISO time. */
  expiresAt: string;
}
