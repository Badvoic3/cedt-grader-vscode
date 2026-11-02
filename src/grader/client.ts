import { ApiClient, type ApiLanguage, type ApiProblem, type ApiSubmission, type ApiSubmissionBrief } from './api';
import { isContestPage } from './contest';
import { AuthError, GraderError, NetworkError, PollTimeoutError, SessionExpiredError } from './errors';
import type { FetchLike, Logger } from './http';
import { parseListScores } from './parsers';
import { Redactor } from './redact';
import type {
  GraderUser,
  Language,
  ListScoreInfo,
  Problem,
  ProblemDetail,
  StoredToken,
  SubmissionBrief,
  SubmissionDetail,
} from './types';
import { parseGraderComment } from './verdicts';
import { WebSession } from './web';

export const DEFAULT_BASE_URL = 'https://cedt-grader.nattee.net';

export interface Credentials {
  username: string;
  password: string;
}

export interface TokenStore {
  load(): Promise<StoredToken | undefined>;
  save(t: StoredToken | undefined): Promise<void>;
}

export interface GraderClientOptions {
  baseUrl?: string;
  /**
   * Stored credentials for a *silent* re-login after the token expires.
   * Return undefined when the password is not remembered.
   */
  getStoredCredentials?: () => Promise<Credentials | undefined>;
  /** Where the API token is kept (SecretStorage); omit to keep it in memory only. */
  tokenStore?: TokenStore;
  fetch?: FetchLike;
  log?: Logger;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface ProblemList {
  problems: Problem[];
  /** Penalty data from `/main/list`: 'loaded', or why it is missing. */
  listStatus: 'loaded' | 'no-web-session' | 'failed';
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (s: SubmissionDetail) => void;
}

/** Final states: the submission will not change any more (safe to cache forever). */
export function isFinalStatus(status: string): boolean {
  return GRADED.has(status);
}

const MIN_POLL_MS = 3_000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 3 * 60_000;
const MAX_BACKOFF_MS = 60_000;
const GRADED = new Set(['done', 'compilation_error', 'grader_error']);

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Grader access. The JSON API (`/api/v1`, JWT) is the primary path; the
 * cookie web session is used only for `/main/list` (penalties, raw-sum mode,
 * exam hint), which the API does not expose.
 *
 * Never requests anything under `/contests` and does not pretend to be a browser.
 */
export class GraderClient {
  readonly baseUrl: string;
  readonly redactor = new Redactor();
  private readonly api: ApiClient;
  private readonly web: WebSession;
  private readonly now: () => Date;
  private readonly sleep: NonNullable<GraderClientOptions['sleep']>;
  private tokenExpiresAt = 0;
  private loginInFlight: Promise<GraderUser> | null = null;
  private languagesCache: Language[] | null = null;
  private listHtml: string | null = null;
  user: GraderUser | null = null;

  constructor(private readonly opts: GraderClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? defaultSleep;
    this.api = new ApiClient(this.baseUrl, opts.fetch ?? ((i, init) => fetch(i, init)), log, this.redactor, this.sleep);
    this.web = new WebSession(this.baseUrl, opts.fetch, log, this.redactor);
  }

  url(path: string): string {
    return this.baseUrl + (path.startsWith('/') ? path : `/${path}`);
  }

  get isLoggedIn(): boolean {
    return this.api.hasToken && this.now().getTime() < this.tokenExpiresAt;
  }

  /** `isContestPage()` on the last `/main/list` we fetched (null if none). */
  get contestPage(): boolean | null {
    return this.listHtml === null ? null : isContestPage(this.listHtml);
  }

  // ---------------------------------------------------------------- auth

  /** Use a stored token if it is still valid (no network). */
  async restore(): Promise<boolean> {
    const t = await this.opts.tokenStore?.load();
    if (!t) return false;
    const exp = Date.parse(t.expiresAt);
    if (!(exp > this.now().getTime() + 60_000)) return false;
    this.api.setToken(t.token);
    this.tokenExpiresAt = exp;
    return true;
  }

  /**
   * Log in to the API (and, best effort, the website for `/main/list`).
   * Explicit credentials come from the login form; otherwise the stored ones are used.
   * A failed login is never retried automatically (the server throttles failures).
   */
  login(creds?: Credentials): Promise<GraderUser> {
    if (!this.loginInFlight) {
      this.loginInFlight = this.doLogin(creds).finally(() => {
        this.loginInFlight = null;
      });
    }
    return this.loginInFlight;
  }

  private async doLogin(given?: Credentials): Promise<GraderUser> {
    const creds = given ?? (await this.opts.getStoredCredentials?.());
    if (!creds?.username || !creds.password) {
      throw new AuthError('Log in to CEDT Grader first.', 'no-credentials');
    }
    this.redactor.add(creds.password);
    const res = await this.api.login(creds.username, creds.password);
    this.tokenExpiresAt = Date.parse(res.expires_at) || this.now().getTime() + 11 * 3600_000;
    this.user = { id: res.user.id, login: res.user.login, fullName: res.user.full_name };
    await this.opts.tokenStore?.save({ token: res.token, expiresAt: new Date(this.tokenExpiresAt).toISOString() });
    // Web session for /main/list (penalties). Its failure does not fail the login.
    try {
      this.listHtml = await this.web.login(creds.username, creds.password);
    } catch (err) {
      this.opts.log?.(`Web login skipped: ${err instanceof Error ? err.message : err}`);
    }
    return this.user;
  }

  async logout(): Promise<void> {
    this.api.setToken(null);
    this.tokenExpiresAt = 0;
    this.web.clear();
    this.user = null;
    this.listHtml = null;
    this.languagesCache = null;
    this.redactor.clear();
    await this.opts.tokenStore?.save(undefined);
  }

  /** Run an API call; on 401 log in again once with the stored password, then retry once. */
  private async authed<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.isLoggedIn) await this.reloginOrThrow();
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) throw err;
      await this.reloginOrThrow();
      return fn();
    }
  }

  private async reloginOrThrow(): Promise<void> {
    this.api.setToken(null);
    this.tokenExpiresAt = 0;
    const creds = await this.opts.getStoredCredentials?.();
    if (!creds) throw new SessionExpiredError('Your grader login has expired. Please log in again.', false);
    await this.login(creds);
  }

  // ------------------------------------------------------------ problems

  async languages(): Promise<Language[]> {
    if (this.languagesCache) return this.languagesCache;
    const list = await this.authed(() => this.api.get<ApiLanguage[]>('/api/v1/languages'));
    this.languagesCache = list.map((l) => ({ id: l.id, name: l.pretty_name || l.name, code: l.name, ext: l.ext }));
    return this.languagesCache;
  }

  /** Languages allowed for a problem (null permitted list = all languages). */
  async languagesFor(p: Pick<Problem, 'permittedLanguageIds'>): Promise<Language[]> {
    const all = await this.languages();
    return p.permittedLanguageIds === null ? all : all.filter((l) => p.permittedLanguageIds!.includes(l.id));
  }

  /**
   * `GET /api/v1/problems`, merged with `/main/list` penalties when the web session works.
   * With `penalties: false` only the API is called and `previous` list data is kept
   * (used right after a submit: penalties don't change by submitting).
   */
  async listProblems(opts: { penalties?: boolean; previous?: Problem[] } = {}): Promise<ProblemList> {
    const api = await this.authed(() => this.api.get<ApiProblem[]>('/api/v1/problems'));
    if (opts.penalties === false) {
      const prev = new Map((opts.previous ?? []).map((p) => [p.id, p.list]));
      return { problems: api.map((p) => toProblem(p, prev.get(p.id) ?? null)), listStatus: 'loaded' };
    }
    let listStatus: ProblemList['listStatus'] = 'loaded';
    let scores: Map<number, ListScoreInfo> | null = null;
    try {
      scores = parseListScores(await this.fetchListPage());
    } catch (err) {
      listStatus = err instanceof SessionExpiredError ? 'no-web-session' : 'failed';
      this.opts.log?.(`Problem list page unavailable: ${err instanceof Error ? err.message : err}`);
    }
    return { problems: api.map((p) => toProblem(p, scores?.get(p.id) ?? null)), listStatus };
  }

  private async fetchListPage(): Promise<string> {
    if (!this.web.isLoggedIn) {
      const creds = await this.opts.getStoredCredentials?.();
      if (!creds) throw new SessionExpiredError('No web session.', false);
      this.listHtml = await this.web.login(creds.username, creds.password);
      return this.listHtml;
    }
    try {
      this.listHtml = await this.web.problemListPage();
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) throw err;
      const creds = await this.opts.getStoredCredentials?.();
      if (!creds) throw err;
      this.listHtml = await this.web.login(creds.username, creds.password);
    }
    return this.listHtml;
  }

  async getProblem(id: number): Promise<ProblemDetail> {
    assertId(id);
    const p = await this.authed(() => this.api.get<ApiProblem>(`/api/v1/problems/${id}`));
    return { ...toProblem(p, null), fullScore: p.full_score ?? null, submissionIds: p.submission_ids ?? [] };
  }

  async listSubmissions(problemId: number): Promise<SubmissionBrief[]> {
    assertId(problemId);
    const list = await this.authed(() => this.api.get<ApiSubmissionBrief[]>(`/api/v1/problems/${problemId}/submissions`));
    return list.map((s) => ({
      id: s.id,
      number: s.number ?? null,
      language: s.language ?? null,
      submittedAt: s.submitted_at ?? null,
      points: s.points ?? null,
      status: s.status,
      comment: s.grader_comment ?? null,
    }));
  }

  // -------------------------------------------------------------- submit

  async submit(problemId: number, languageId: number, source: string, filename: string): Promise<{ id: number; number: number | null }> {
    assertId(problemId);
    if (!source.trim()) throw new GraderError('The file is empty.');
    const r = await this.authed(() => this.api.createSubmission(problemId, languageId, source, filename));
    return { id: r.id, number: r.number ?? null };
  }

  /** `GET /api/v1/submissions/{id}`: status, points, compiler message, source, evaluations. */
  async getSubmission(id: number, signal?: AbortSignal): Promise<SubmissionDetail> {
    assertId(id);
    return toDetail(await this.authed(() => this.api.get<ApiSubmission>(`/api/v1/submissions/${id}`, signal)));
  }

  /** Poll one submission until graded. Waits max(3 s, interval); ×2 back-off on network errors; 3 min cap. */
  async pollSubmission(id: number, opts: PollOptions = {}): Promise<SubmissionDetail> {
    const interval = Math.max(MIN_POLL_MS, opts.intervalMs ?? DEFAULT_POLL_MS);
    const timeout = opts.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const start = this.now().getTime();
    let backoff = interval;
    let last: SubmissionDetail | null = null;
    for (;;) {
      let wait = interval;
      try {
        const s = await this.getSubmission(id, opts.signal);
        last = s;
        opts.onUpdate?.(s);
        if (s.state === 'graded') return s;
        backoff = interval;
      } catch (err) {
        if (!(err instanceof NetworkError)) throw err;
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        wait = backoff;
      }
      if (this.now().getTime() - start + wait > timeout) {
        throw Object.assign(new PollTimeoutError('Still not graded after 3 minutes. Check again later.'), { last });
      }
      await this.sleep(wait, opts.signal);
    }
  }
}

function toProblem(p: ApiProblem, list: ListScoreInfo | null): Problem {
  return {
    id: p.id,
    name: clean(p.name),
    fullName: clean(p.full_name ?? p.name),
    bestScore: p.best_score ?? null,
    lastScore: p.last_score ?? null,
    lastResult: p.last_result ?? null,
    lastSubmissionId: p.last_submission_id ?? null,
    lastSubmissionTime: p.last_submission_time ?? null,
    submissionCount: p.submission_count ?? 0,
    hasTestcase: !!p.has_testcase,
    hasAttachment: !!p.has_attachment,
    permittedLanguageIds: p.permitted_languages ? p.permitted_languages.map((l) => l.id) : null,
    list,
  };
}

function toDetail(s: ApiSubmission): SubmissionDetail {
  const compileError = s.status === 'compilation_error' || /compil(?:ation|e) error/i.test(s.grader_comment ?? '');
  return {
    source: s.source ?? null,
    sourceFilename: s.source_filename ?? null,
    maxRuntimeMs: s.max_runtime ?? null,
    peakMemoryKb: s.peak_memory ?? null,
    evaluations: (s.evaluations ?? []).map((e) => ({
      testcaseId: e.testcase_id,
      result: e.result ?? null,
      score: e.score ?? null,
      timeMs: e.time ?? null,
      memoryKb: e.memory ?? null,
    })),
    id: s.id,
    number: s.number ?? null,
    problemId: s.problem_id,
    status: s.status,
    state: GRADED.has(s.status) ? 'graded' : 'pending',
    points: s.points ?? null,
    comment: s.grader_comment ?? null,
    compilerMessage: s.compiler_message ?? null,
    compileError,
    verdicts: compileError ? [] : parseGraderComment(s.grader_comment),
    submittedAt: s.submitted_at ?? null,
    language: s.language ?? null,
  };
}

function clean(s: string): string {
  return (s ?? '').replace(/[​‌‍﻿]/g, '').trim();
}

function assertId(id: number): void {
  if (!Number.isInteger(id) || id <= 0) throw new GraderError(`Invalid id: ${id}`);
}
