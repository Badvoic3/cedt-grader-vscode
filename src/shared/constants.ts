/**
 * Every tunable in one place (no `vscode` import: used by the host, the
 * grader layer, tests and the webviews). User-adjustable values also have a
 * setting (see package.json `contributes.configuration`); the setting wins.
 */

// ------------------------------------------------------------------ server

/** Default grader (setting `cedtGrader.baseUrl`, user scope only). Keep in sync with package.json. */
export const DEFAULT_BASE_URL = 'https://cedt-grader.nattee.net';

/**
 * The cap penalties are taken from. cafe-grader hard-codes 100 here
 * (`Submission.max_score_report`: `100 - min(100, hint + ai cost)`) and
 * the website calls a problem solved at best ≥ 100, whatever the
 * problem's `full_score`. Change only if the server changes.
 */
export const SERVER_SCORE_CAP = 100;

/** Website paths (opened in the browser; never fetched). */
export const WEB_PATHS = {
  problem: (id: number) => `/submissions/direct_edit_problem/${id}`,
  submission: (id: number) => `/submissions/${id}`,
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
} as const;

/** Links of deleted files are kept (stale) this many days, so a moved file can reconnect. */
export const STALE_LINK_DAYS = 30;

// ------------------------------------------------------------------ limits

export const LIMITS = {
  /** workspace.findFiles result cap ("Find file by name", name search). */
  findFilesMax: 50,
  /** Candidates kept after filtering. */
  findFilesKept: 20,
  /** Remembered auto-matches (oldest dropped). */
  autoMatchesMax: 500,
} as const;
