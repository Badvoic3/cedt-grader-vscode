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
  /** "Out of": 100 (SERVER_SCORE_CAP); null for raw-sum problems. */
  outOf: number | null;
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
  /** Clean name (zero-width characters removed). */
  name: string;
  fullName: string;
  score: ScoreView;
  /** At least one file is mapped to this problem (enables "go to file"). */
  hasFile: boolean;
  hasTestcase: boolean;
  /** As on the website: solved (best ≥ 100) / inprogress / untried. */
  status: 'solved' | 'inprogress' | 'untried';
  tags: string[];
  /** ISO time of the latest submission (sorting). */
  lastSubmissionTime: string | null;
  /** When a file for this problem was last opened (ms; "Recently opened" sorting). */
  lastOpened: number | null;
}

export type ProblemSort = 'default' | 'name-asc' | 'name-desc' | 'latest' | 'score-asc' | 'score-desc' | 'recent';

export interface ProblemFilter {
  status: 'all' | 'unsolved' | 'inprogress' | 'solved';
  /** Topic tag name, or null for all topics. */
  topic: string | null;
  /** List order (default = grader order). */
  sort?: ProblemSort;
}

export type MatchSourceView = 'saved' | 'cph' | 'filename' | 'suggested';

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
    /** From the grader (`full_name`), e.g. a Thai name. */
    fullName: string | null;
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
  problem: (ProblemView & { source: MatchSourceView; sourceLabel: string; unavailable: boolean }) | null;
  /** All files linked to the current problem when there are several (duplicate notice). */
  /** Files for the current problem (2+ → notice); current file first. */
  linkedFiles: { path: string; current: boolean; how: 'chosen' | 'cph' | 'filename' | 'suggested' }[];
  /** "Another file with the same name also matches…" / "N files are linked to this problem". */
  linkedNotice: string | null;
  /** Show the dismissible "install CPH" tip. */
  cphTip: boolean;
  /** The file was explicitly unlinked: "Not linked to a problem" (auto-detection off). */
  notLinked: boolean;
  /** Inline question with plain buttons (instead of a modal dialog). */
  prompt: { id: number; text: string; detail: string | null; tone: 'info' | 'warn'; buttons: { id: string; label: string; primary?: boolean }[] } | null;
  /** How the active file was (or wasn't) matched. */
  matching: {
    /** Closest candidates, shown first in the picker (never saved automatically). */
    suggestions: ProblemView[];
    /** Several problems matched equally well; the user must choose. */
    ambiguous: ProblemView[] | null;
    /** Explanation, e.g. a saved mapping whose problem no longer exists. */
    note: string | null;
  };
  testcases: { busy: boolean };
  /** CPH (optional) installed and enabled. */
  cph: { installed: boolean };
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
    /** Persisted per workspace. */
    filter: ProblemFilter;
    /** Topic pills (the website's topic tags, or all tags when unknown). */
    topics: { name: string; description: string | null }[];
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
  | { type: 'copyName'; problemId: number }
  | { type: 'newFile'; problemId: number }
  | { type: 'goToFile'; problemId: number }
  | { type: 'findFile'; problemId: number }
  | { type: 'loadTestcases' }
  | { type: 'confirmProblem'; problemId: number }
  | { type: 'setFilter'; filter: ProblemFilter }
  | { type: 'autoDetect' }
  | { type: 'promptAnswer'; id: number; button: string | null }
  | { type: 'unlinkLinkedFile'; index: number }
  | { type: 'problemRowClick'; problemId: number }
  | { type: 'openLinkedFile'; index: number }
  | { type: 'keepOnlyThisFile' }
  | { type: 'cphTip'; action: 'install' | 'later' | 'never' }
  | { type: 'showCompilerMessage' }
  | { type: 'openSettings' };

export function isFromWebview(m: unknown): m is FromWebview {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}
