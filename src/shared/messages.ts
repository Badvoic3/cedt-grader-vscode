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

export interface ProblemView {
  id: number;
  name: string;
  fullName: string;
  bestScore: number | null;
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
  score: number | null;
  /** Server hides the score (`ui.show_score` off). */
  scoreHidden: boolean;
  tries: number | null;
  time: string | null;
  comment: string | null;
  verdicts: VerdictView[];
  compileError: boolean;
  compilerMessage: string | null;
  /** Human readable status or error text. */
  message: string | null;
}

export interface HistoryEntry {
  submissionId: number;
  url: string;
  score: number | null;
  comment: string | null;
  time: string;
  compileError: boolean;
}

export interface ViewState {
  baseUrl: string;
  account: {
    status: 'logged-out' | 'logging-in' | 'logged-in';
    username: string;
    hasSavedPassword: boolean;
    error: string | null;
  };
  file: {
    path: string;
    name: string;
    /** Language guessed from the extension, e.g. `C++`. */
    languageGuess: string | null;
    supported: boolean;
  } | null;
  problem: (ProblemView & { source: 'mapping' | 'cph'; statementUrl: string | null }) | null;
  languages: {
    loading: boolean;
    items: LanguageView[];
    selectedId: number | null;
    forced: boolean;
    error: string | null;
  };
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
  history: HistoryEntry[];
  problems: {
    loading: boolean;
    loaded: boolean;
    items: ProblemView[];
    error: string | null;
  };
}

/** Host → webview. */
export type ToWebview = { type: 'state'; state: ViewState } | { type: 'focus'; target: 'login' | 'problem-search' | 'submit' };

/** Webview → host. The password is only ever carried by `login`. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'login'; username: string; password: string }
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
  | { type: 'showCompilerMessage' }
  | { type: 'openSettings' };

export function isFromWebview(m: unknown): m is FromWebview {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}
