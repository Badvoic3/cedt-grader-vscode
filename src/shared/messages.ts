/**
 * Typed messages between the extension host and the sidebar webview.
 * Shared by both bundles; must stay free of `vscode` and Node imports.
 *
 * The host is the single source of truth: it pushes a full `ViewState`
 * snapshot, the webview only renders it and sends `FromWebview` actions.
 * No network access happens in the webview.
 */

export interface VerdictView {
  index: number;
  ok: boolean;
  kind: string;
  label: string;
  group?: number;
}

/** Scores as the server counts them (see src/grader/score.ts). */
export interface ScoreView {
  counted: number | null;
  best: number | null;
  latest: number | null;
  attempts: number;
  penaltyLabel: string | null;
  rawSum: boolean;
  /** 'problem-list' = hint/AI penalties read from /main/list; 'api' = API only (penalties unknown). */
  source: 'api' | 'problem-list';
  latestBelowCounted: boolean;
}

export interface ProblemView {
  id: number;
  name: string;
  fullName: string;
  score: ScoreView;
}

export interface LanguageView {
  id: number;
  name: string;
}

export type ResultPhase = 'submitting' | 'grading' | 'done' | 'timeout' | 'error';

export interface ResultView {
  phase: ResultPhase;
  problemId: number;
  problemName: string;
  submissionId: number | null;
  submissionUrl: string | null;
  /** Attempt number for this problem. */
  number: number | null;
  points: number | null;
  comment: string | null;
  verdicts: VerdictView[];
  compileError: boolean;
  compilerMessage: string | null;
  /** e.g. "Counted score improved: 40 → 70." */
  improvement: string | null;
  /** Human readable status or error text. */
  message: string | null;
}

export interface HistoryEntry {
  submissionId: number;
  number: number | null;
  points: number | null;
  status: string;
  comment: string | null;
  submittedAt: string | null;
  /** Display name, e.g. `C++`. */
  language: string | null;
  compileError: boolean;
  /** This submission holds the counted (best) score. */
  counted: boolean;
  verdicts: VerdictView[];
}

export interface EvaluationView {
  index: number;
  kind: string;
  label: string;
  score: number | null;
  timeMs: number | null;
  memoryKb: number | null;
}

/** Loaded on demand when a history entry is expanded. */
export interface SubmissionDetailView {
  submissionId: number;
  url: string;
  status: string;
  compilerMessage: string | null;
  maxRuntimeMs: number | null;
  peakMemoryKb: number | null;
  hasSource: boolean;
  sourceFilename: string | null;
  evaluations: EvaluationView[];
}

export interface ViewState {
  baseUrl: string;
  account: {
    status: 'logged-out' | 'logging-in' | 'logged-in';
    username: string;
    hasSavedPassword: boolean;
    /** Default for the "Remember password on this computer" checkbox. */
    rememberPassword: boolean;
    error: string | null;
  };
  file: {
    path: string;
    name: string;
    /** Language guessed from the extension, e.g. `C++`. */
    languageGuess: string | null;
    supported: boolean;
  } | null;
  problem: (ProblemView & { source: 'mapping' | 'cph' }) | null;
  languages: {
    loading: boolean;
    items: LanguageView[];
    selectedId: number | null;
    /** The mapped problem accepts none of the file's languages (probably the wrong problem). */
    mismatch: { wanted: string; allowed: string[] } | null;
  };
  /** Connection banner at the top of the sidebar (null = no problem). */
  connection: { kind: string; title: string; message: string; action: 'retry' | 'login' } | null;
  submit: {
    enabled: boolean;
    busy: boolean;
    /** Why Submit is disabled (shown under the button). */
    reason: string | null;
    label: string;
  };
  /** Result for the active file only. */
  result: ResultView | null;
  /** Problem name of a submission being graded for another file, if any. */
  gradingElsewhere: string | null;
  history: {
    loading: boolean;
    /** Cached data shown because a refresh failed (offline / rate limited). */
    stale: boolean;
    error: string | null;
    items: HistoryEntry[];
    expanded: { submissionId: number; loading: boolean; error: string | null; detail: SubmissionDetailView | null } | null;
  };
  problems: {
    loading: boolean;
    loaded: boolean;
    stale: boolean;
    items: ProblemView[];
    error: string | null;
    /** Note when hint/AI penalties could not be read from /main/list. */
    penaltyNote: string | null;
  };
}

/** Host → webview. */
export type ToWebview = { type: 'state'; state: ViewState } | { type: 'focus'; target: 'login' | 'problem-search' | 'submit' };

/** Webview → host. The password is only ever carried by `login`. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'login'; username: string; password: string; remember: boolean }
  | { type: 'loginSaved' }
  | { type: 'logout' }
  | { type: 'submit' }
  | { type: 'resubmit' }
  | { type: 'selectLanguage'; languageId: number }
  | { type: 'mapProblem'; problemId: number }
  | { type: 'unmapProblem' }
  | { type: 'refreshProblems' }
  | { type: 'openStatement'; problemId: number }
  | { type: 'openProblemInBrowser'; problemId: number }
  | { type: 'openSubmission'; submissionId: number }
  | { type: 'toggleSubmission'; submissionId: number }
  | { type: 'openSubmissionSource'; submissionId: number }
  | { type: 'compareSubmission'; submissionId: number }
  | { type: 'refreshHistory' }
  | { type: 'retry' }
  | { type: 'showCompilerMessage' }
  | { type: 'openSettings' };

export function isFromWebview(m: unknown): m is FromWebview {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}
