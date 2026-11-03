import type { SectionId } from './layout';
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
  /** The problem has an attachment (the website's "File": a template file or a zip package). */
  hasAttachment: boolean;
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
  /** Older saved filters: one topic, shown only (read as `topicsIn`; new filters store null). */
  topic: string | null;
  /** Topic pills set to "show only problems with this topic" (any of them). Optional: older saved filters lack it. */
  topicsIn?: string[];
  /** Topic pills set to "hide problems with this topic". */
  topicsOut?: string[];
  /** Other tags chosen in the "Tags" dropdown (none = no tag filter). Optional: older saved filters lack it. */
  tags?: string[];
  /** How several chosen tags combine: 'or' = any of them (default), 'and' = all of them. */
  tagMode?: 'and' | 'or';
  /** List order (default = grader order). */
  sort?: ProblemSort;
}

export type MatchSourceView = 'saved' | 'cph' | 'filename' | 'folder' | 'suggested';

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
  /** Panel layout settings (sections shown and their order, compact mode). */
  layout: { sections: SectionId[]; compact: boolean };
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
    /** Proposed name when the file name doesn't match its problem ("Rename file to match the problem"); null otherwise. */
    renameTo: string | null;
  } | null;
  problem: (ProblemView & { source: MatchSourceView; sourceLabel: string; unavailable: boolean }) | null;
  /** All files linked to the current problem when there are several (duplicate notice). */
  /** Files for the current problem (2+ → notice); current file first. */
  linkedFiles: { path: string; current: boolean; how: 'chosen' | 'cph' | 'filename' | 'folder' | 'suggested' }[];
  /** "Another file with the same name also matches…" / "N files are linked to this problem". */
  linkedNotice: string | null;
  /**
   * Folder mode: the active file is in a folder linked to the problem. `path`
   * is the folder (workspace-relative, ending in "/"); Submit sends
   * `submitFile` only (null: asked on the first submit); `candidates` are the
   * folder's source files.
   */
  folder: {
    path: string;
    /** Only matched by the folder's name (not saved): the match line stays "Matched by folder name"; choosing a file saves the link. */
    matched: boolean;
    submitFile: string | null;
    /** Why this submit file ("named in main.cpp", "student.*", "stub comment", "your choice"…); null when not known. */
    submitWhy: string | null;
    /** The user picked it (else detected): the dropdown's "Automatic" option is not selected. */
    submitChosen: boolean;
    /** The program CPH runs and test cases belong to (the driver with main()). */
    runFile: string | null;
    runWhy: string | null;
    runChosen: boolean;
    /** The folder's source files (submit choices). */
    candidates: string[];
    /** C/C++ sources (run choices). */
    runCandidates: string[];
  } | null;
  /** "Run tests" (CPH installed only; null hides it); disabled with a reason while the run file has no tests. */
  runTests: { disabledReason: string | null } | null;
  /** "Link the whole folder" / "Link only this file" (null: no problem or file); `disabledReason` when it can't be switched on. */
  folderMode: { on: boolean; disabledReason: string | null } | null;
  /** Attachment download in progress (problem id). */
  attachment: { busy: number | null };
  /** Show the dismissible "install CPH" tip. */
  cphTip: boolean;
  /** The file was explicitly unlinked: "Not linked to a problem" (auto-detection off). */
  notLinked: boolean;
  /** Inline question with plain buttons (instead of a modal dialog). */
  /** Inline question; `near: 'submit'` = about submitting, shown right above the Submit button. */
  prompt: { id: number; text: string; detail: string | null; tone: 'info' | 'warn'; buttons: { id: string; label: string; primary?: boolean }[]; near: 'submit' | null } | null;
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
  /** "Load sample cases" is reading the statement; available = false when the cached statement is not a PDF. */
  samples: { busy: boolean; available: boolean };
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
    /** Topic pills: the website's topic tags (empty when unknown; then every tag is in `tags`). */
    topics: { name: string; description: string | null }[];
    /** The "Tags" dropdown: every other tag of the problems (`otherTags`), selected ones included. */
    tags: string[];
    /** What the first click on a topic pill does (setting `cedtGrader.panel.topicClickOrder`). Optional for older test states. */
    topicClickOrder?: 'showFirst' | 'hideFirst';
    /** Note when hint/AI penalties could not be read from /main/list. */
    penaltyNote: string | null;
  };
}

/** Host → webview. */
export type ToWebview = { type: 'state'; state: ViewState } | { type: 'focus'; target: 'login' | 'problem-search' | 'submit' | 'result' };

/** Webview → host. The password is only ever carried by `login`. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'login'; username: string; password: string; remember: boolean }
  | { type: 'loginSaved' }
  | { type: 'logout' }
  | { type: 'submit' }
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
  /** asFiles: "Save test cases as files" (.in / .out even when CPH is installed). */
  | { type: 'loadTestcases'; asFiles?: boolean }
  | { type: 'loadSampleCases' }
  | { type: 'confirmProblem'; problemId: number }
  | { type: 'setFilter'; filter: ProblemFilter }
  | { type: 'autoDetect' }
  | { type: 'promptAnswer'; id: number; button: string | null }
  | { type: 'unlinkLinkedFile'; index: number }
  | { type: 'problemRowClick'; problemId: number }
  | { type: 'openLinkedFile'; index: number }
  | { type: 'keepOnlyThisFile' }
  | { type: 'dismissLinkedNotice' }
  | { type: 'renameFileToProblem' }
  | { type: 'downloadAttachment'; problemId: number }
  | { type: 'toggleFolderMode' }
  | { type: 'setFolderRole'; role: 'submit' | 'run'; file: string }
  | { type: 'runTests' }
  | { type: 'cphTip'; action: 'install' | 'later' | 'never' }
  | { type: 'showCompilerMessage' }
  | { type: 'openSettings' }
  | { type: 'openTroubleshooting' };

export function isFromWebview(m: unknown): m is FromWebview {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}
