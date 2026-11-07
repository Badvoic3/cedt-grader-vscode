/**
 * Every tunable in one place (no `vscode` import: used by the host, the
 * grader layer, tests and the webviews). User-adjustable values also have a
 * setting (see package.json `contributes.configuration`); the setting wins.
 */

// ------------------------------------------------------------------ server

/** Default grader (setting `cedtGrader.baseUrl`, user scope only). Keep in sync with package.json. */
export const DEFAULT_BASE_URL = 'https://cedt-grader.nattee.net';

/**
 * Every score is out of 100. cafe-grader normalizes the "sum" and
 * "group_min" score types to 0–100 whatever the number of tests, weights or
 * groups (`app/engine/scorer.rb`); the API's `full_score` is NOT the maximum.
 * The same literal is the penalty cap (`Submission.max_score_report`:
 * `100 - min(100, hint + ai cost)`) and the website's "solved" threshold.
 * Raw-sum problems (`raw_sum` / `custom_testlib_raw`) have no fixed maximum
 * and are shown without "/ 100". Change only if the server changes.
 */
export const SERVER_SCORE_CAP = 100;

/** The extension's GitHub repository (README, troubleshooting). Keep in sync with package.json `repository`. */
export const REPO_URL = 'https://github.com/Badvoic3/cedt-grader-vscode';

/** README troubleshooting section per display language (GitHub heading anchors). */
export const TROUBLESHOOTING = {
  en: { file: 'README.md', anchor: 'troubleshooting' },
  th: { file: 'README.th.md', anchor: 'การแก้ปัญหาเบื้องต้น' },
} as const;

/** Web address of the troubleshooting section (anchor percent-encoded). */
export function troubleshootingUrl(lang: keyof typeof TROUBLESHOOTING): string {
  const t = TROUBLESHOOTING[lang];
  return `${REPO_URL}/blob/main/${t.file}#${encodeURIComponent(t.anchor)}`;
}

/** Crash reports (prefilled GitHub issue). Electron's `shell.openExternal` takes at most 2,081 characters on Windows. */
export const CRASH = {
  issueTemplate: 'crash_report.yml',
  maxPromptsPerSession: 3,
  maxUrlLength: 2000,
  maxFrames: 8,
  maxMessageChars: 500,
  maxPanelErrorChars: 4000,
} as const;

/** URI scheme of the read-only documents serving a past submission's source (diff view; also the CPH reload placeholder). */
export const SUBMISSION_SCHEME = 'cedt-grader-submission';

/** Website paths (opened in the browser; never fetched). */
export const WEB_PATHS = {
  problem: (id: number) => `/submissions/direct_edit_problem/${id}`,
  submission: (id: number) => `/submissions/${id}`,
  statement: (id: number) => `/problems/${id}/download/statement`,
} as const;

// ------------------------------------------------------------------ timing (ms)

export const TIMING = {
  /** Any single HTTP request. */
  requestTimeoutMs: 30_000,
  /** GET retries on 429 / 5xx; waits base × 2^attempt (2 s, 4 s) or Retry-After, capped. */
  getRetries: 2,
  retryBaseMs: 2_000,
  retryAfterCapMs: 30_000,
  /** Poll interval floor (setting `cedtGrader.pollIntervalSeconds`, default 5 s). */
  pollMinMs: 3_000,
  pollDefaultMs: 5_000,
  /** Polling stops after this. */
  pollTimeoutMs: 3 * 60_000,
  /** Poll back-off ceiling on network errors (×2 each time). */
  pollMaxBackoffMs: 60_000,
  /** Consecutive poll network failures before polling pauses (no retry loop offline). */
  pollMaxNetworkFailures: 2,
  /** Submission history counts as fresh this long. */
  historyTtlMs: 5 * 60_000,
  /** Editor switches are debounced this long before any request. */
  switchDebounceMs: 400,
  /** The web landing page (CSRF) is reused for this long. */
  landingReuseMs: 60_000,
  /** A stored token is used only if it is valid at least this much longer. */
  tokenMinValidityMs: 60_000,
  /** File create/delete/rename events are batched this long before name searches rerun. */
  fileEventDebounceMs: 1_000,
  /** Token lifetime assumed when the login response has no expiry (server default is 12 h). */
  tokenFallbackTtlMs: 11 * 3_600_000,
  /** Housekeeping (stale links) runs at most this often. */
  dailyCleanupMs: 86_400_000,
  /** Short confirmations in the status bar ("Copied …"). */
  statusMessageMs: 2_500,
  /** Delay before focusing something in the panel after revealing it. */
  focusDelayMs: 150,
} as const;

/** The built-in runner. */
export const RUNNER = {
  /** Output kept for showing, per stream. The compare limit is `max(this, 2 × expected size)`. */
  displayBytes: 64 * 1024,
  defaultTimeSeconds: 10,
  defaultMemoryMB: 1024,
  /** Kill at the limit plus this, so the real time can be shown (the grader does the same). */
  graceMs: 500,
  /** No run lasts longer, whatever the limit. */
  hardStopMs: 60_000,
  compileTimeoutMs: 60_000,
  /** Compiler text kept; the grader cuts at the same length. */
  compileMessageChars: 15_000,
  /** After `'exit'`, wait this long for the streams to end. */
  closeDeadlineMs: 2_000,
  /** Peak memory sampling on Linux, and the safety check on macOS. */
  memoryPollLinuxMs: 100,
  memoryPollMacMs: 500,
  /** A run with no saved limits waits this long for the grader's before using the defaults. */
  limitsWaitMs: 3_000,
  /** The panels hear about run progress at most this often. */
  updateMs: 100,
  /** Builds kept in the build folder. */
  keepBuilds: 30,
  /** Stack for C / C++ where the linker sets it: the grader limits the stack only by memory. */
  stackBytes: 512 * 1024 * 1024,
} as const;

/** Webview timings and sizes (sidebar and statement viewer). */
export const PANEL = {
  /** Hover / focus delay before a tooltip appears. */
  tooltipDelayMs: 300,
  /** Problem list viewport height cap (px); the list scrolls inside it. */
  listMaxHeightPx: 420,
  /** Saving the list scroll position is batched this long. */
  scrollSaveMs: 150,
  /** An editor switch within this time after a row click never scrolls the list. */
  rowClickWindowMs: 3_000,
  /** Statement viewer: page / zoom / scroll saved this long after the last change. */
  statementStateSaveMs: 400,
} as const;

/**
 * Downloaded files in globalStorage (statements, test cases). The size limit
 * is also the setting `cedtGrader.cacheMaxMB`; least recently used files go
 * first. The daily cleanup removes files unused this long and leftover
 * temporary files (`*.tmp`, from an interrupted write).
 */
export const CACHE = {
  maxMbDefault: 100,
  maxMbMinimum: 10,
  unusedDays: 30,
  tempDays: 30,
} as const;

/**
 * Problem attachments (`GET /api/v1/problems/{id}/files/attachment`), saved
 * into the workspace on click. A zip is extracted into a new folder; these
 * caps are checked on the declared sizes before inflating and again on the
 * real output (zip bombs).
 */
export const ATTACHMENT = {
  /** Largest download accepted (counted while downloading, see `readCapped` in src/grader/api.ts). */
  maxDownloadBytes: 20 * 1024 * 1024,
  /** Most files extracted from one zip. */
  maxEntries: 500,
  /** Largest total size of the extracted files. */
  maxTotalBytes: 50 * 1024 * 1024,
  /** Submit-file question: inline buttons up to this many files, a quick pick above. */
  maxInlineChoices: 6,
  /** Folder mode: C/C++ files larger than this are not read for submit / run file detection. */
  maxRoleFileBytes: 512 * 1024,
} as const;

/**
 * Statement PDFs (`GET /api/v1/problems/{id}/files/pdf`): a larger answer is
 * refused while it downloads (course statements are well under 5 MB). The PDF
 * is cached and, for "Load sample cases", read in the extension host.
 */
export const STATEMENT = {
  maxPdfBytes: 50 * 1024 * 1024,
} as const;

/** Links of deleted files are kept (stale) this many days, so a moved file can reconnect. */
export const STALE_LINK_DAYS = 30;

// ------------------------------------------------------------------ matching

/**
 * Suggestions (file name close to, but not exactly, a problem name).
 * Scores are 0..1 (name similarity, + a bonus when a parent folder is named
 * like one of the problem's tags).
 */
export const MATCH = {
  /** At or above: the top candidate is used as "Suggested" (treated like a link for viewing). */
  suggestMinScore: 0.6,
  /** The top candidate must lead the next one by this much; otherwise "Several problems could match". */
  suggestMinMargin: 0.08,
  /** Candidates shown in the picker ("Suggested for this file") from this score. */
  pickerMinScore: 0.34,
  /** Added when a parent folder's name matches one of the problem's tags. */
  folderTagBonus: 0.1,
  /** Candidates listed in the picker. */
  maxCandidates: 5,
} as const;

// ------------------------------------------------------------------ limits

export const LIMITS = {
  /** Accepted grader addresses remembered; an older one is just checked again. */
  verifiedServers: 20,
  /** Remembered auto-matches (oldest dropped). */
  autoMatchesMax: 500,
  /** "Recently opened" problems remembered for sorting. */
  recentlyOpenedMax: 300,
  /** Source files read for the match index (problem → file). */
  indexMaxFiles: 5_000,
} as const;
