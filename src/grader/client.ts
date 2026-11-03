import { G } from '../shared/strings';
import { ApiClient, type ApiLanguage, type ApiProblem, type ApiSubmission, type ApiSubmissionBrief } from './api';
import { type Attachment, parseContentDisposition } from './attachment';
import { isContestPage } from './contest';
import { AuthError, GraderError, NetworkError, PollTimeoutError, SessionExpiredError } from './errors';
import type { FetchLike, Logger } from './http';
import { parseListScores, parseTopicTags } from './parsers';
import { Redactor } from './redact';
import type {
  GraderUser,
  Language,
  ListScoreInfo,
  Problem,
  StoredToken,
  SubmissionBrief,
  SubmissionDetail,
  TestcaseInfo,
  TopicTag,
} from './types';
import { parseGraderComment } from './verdicts';
import { WebSession } from './web';

export { DEFAULT_BASE_URL } from '../shared/constants';
import { ATTACHMENT, DEFAULT_BASE_URL, TIMING } from '../shared/constants';

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
  /** Topic tags shown as filter pills on the website; null when the list page was unavailable (use all tags). */
  topics: TopicTag[] | null;
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

const MIN_POLL_MS = TIMING.pollMinMs;
const DEFAULT_POLL_MS = TIMING.pollDefaultMs;
const DEFAULT_POLL_TIMEOUT_MS = TIMING.pollTimeoutMs;
const MAX_BACKOFF_MS = TIMING.pollMaxBackoffMs;
/** Consecutive network failures tolerated while polling; then polling stops (no retry loop while offline). */
const MAX_POLL_NETWORK_FAILURES = TIMING.pollMaxNetworkFailures;
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
  /** When `listHtml` was fetched; the login landing page is reused for the first list load. */
  private listHtmlAt = 0;
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
    if (!(exp > this.now().getTime() + TIMING.tokenMinValidityMs)) return false;
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
      throw new AuthError(G.logInFirst, 'no-credentials');
    }
    this.redactor.add(creds.password);
    const res = await this.api.login(creds.username, creds.password);
    this.tokenExpiresAt = Date.parse(res.expires_at) || this.now().getTime() + TIMING.tokenFallbackTtlMs;
    this.user = { id: res.user.id, login: res.user.login, fullName: res.user.full_name };
    await this.opts.tokenStore?.save({ token: res.token, expiresAt: new Date(this.tokenExpiresAt).toISOString() });
    // Web session for /main/list (penalties). Its failure does not fail the login.
    try {
      this.setListHtml(await this.web.login(creds.username, creds.password));
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
    if (!creds) throw new SessionExpiredError(G.loginExpired, false);
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
  async listProblems(opts: { penalties?: boolean; previous?: Problem[]; previousTopics?: TopicTag[] | null } = {}): Promise<ProblemList> {
    const api = await this.authed(() => this.api.get<ApiProblem[]>('/api/v1/problems'));
    if (opts.penalties === false) {
      const prev = new Map((opts.previous ?? []).map((p) => [p.id, p.list]));
      return { problems: api.map((p) => toProblem(p, prev.get(p.id) ?? null)), listStatus: 'loaded', topics: opts.previousTopics ?? null };
    }
    let listStatus: ProblemList['listStatus'] = 'loaded';
    let scores: Map<number, ListScoreInfo> | null = null;
    let topics: TopicTag[] | null = null;
    try {
      const html = await this.fetchListPage();
      scores = parseListScores(html);
      topics = parseTopicTags(html);
    } catch (err) {
      listStatus = err instanceof SessionExpiredError ? 'no-web-session' : 'failed';
      this.opts.log?.(`Problem list page unavailable: ${err instanceof Error ? err.message : err}`);
    }
    return { problems: api.map((p) => toProblem(p, scores?.get(p.id) ?? null)), listStatus, topics };
  }

  private setListHtml(html: string): string {
    this.listHtml = html;
    this.listHtmlAt = this.now().getTime();
    return html;
  }

  private async fetchListPage(): Promise<string> {
    // Login just landed on /main/list: reuse it instead of fetching the ~700 KB page again.
    if (this.listHtml !== null && this.now().getTime() - this.listHtmlAt < TIMING.landingReuseMs) {
      this.opts.log?.('cache hit  /main/list (login landing page)');
      return this.listHtml;
    }
    if (!this.web.isLoggedIn) {
      const creds = await this.opts.getStoredCredentials?.();
      if (!creds) throw new SessionExpiredError(G.noWebSession, false);
      return this.setListHtml(await this.web.login(creds.username, creds.password));
    }
    try {
      return this.setListHtml(await this.web.problemListPage());
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) throw err;
      const creds = await this.opts.getStoredCredentials?.();
      if (!creds) throw err;
      return this.setListHtml(await this.web.login(creds.username, creds.password));
    }
  }

  /** `GET /api/v1/me` (users_controller.rb#me): `full_name`, `login`, … */
  async me(): Promise<GraderUser> {
    const m = await this.authed(() => this.api.get<{ id: number; login: string; full_name: string | null }>('/api/v1/me'));
    this.user = { id: m.id, login: m.login, fullName: m.full_name ?? '' };
    return this.user;
  }

  /** `GET /api/v1/problems/{id}/testcases`; null when not allowed (403) or not found. */
  async listTestcases(problemId: number): Promise<TestcaseInfo[] | null> {
    assertId(problemId);
    try {
      const list = await this.authed(() =>
        this.api.get<{ id: number; num: number; group: number | null; group_name: string | null; weight: number | null; access: string; input_bytes: number | null; sol_bytes: number | null }[]>(
          `/api/v1/problems/${problemId}/testcases`,
        ),
      );
      return list.map((t) => ({
        id: t.id,
        num: t.num,
        group: t.group ?? null,
        groupName: t.group_name ?? null,
        weight: t.weight ?? null,
        access: t.access,
        inputBytes: t.input_bytes ?? null,
        solBytes: t.sol_bytes ?? null,
      }));
    } catch (err) {
      if (err instanceof GraderError && !(err instanceof NetworkError) && !(err instanceof SessionExpiredError) && !(err instanceof AuthError)) return null;
      throw err;
    }
  }

  /** `GET /api/v1/testcases/{id}/input|sol` as text, with the preview truncation flag. */
  async getTestcaseFile(testcaseId: number, which: 'input' | 'sol'): Promise<{ text: string; truncated: boolean; byteSize: number | null }> {
    assertId(testcaseId);
    return this.authed(() => this.api.getText(`/api/v1/testcases/${testcaseId}/${which}`));
  }

  /** `GET /api/v1/problems/{id}/files/pdf`: 403 = PDF hidden for this problem, 404 = none. */
  async getStatementPdf(id: number): Promise<{ status: 200; bytes: Uint8Array } | { status: 403 | 404; error: string | null }> {
    assertId(id);
    const r = await this.authed(() => this.api.getBytes(`/api/v1/problems/${id}/files/pdf`));
    return r.status === 200 ? { status: 200, bytes: r.bytes } : r;
  }

  /**
   * `GET /api/v1/problems/{id}/files/attachment` (only on click): the file,
   * its name (Content-Disposition) and type; 404 = no attachment.
   */
  async getAttachment(id: number): Promise<({ status: 200 } & Attachment) | { status: 403 | 404; error: string | null }> {
    assertId(id);
    const r = await this.authed(() => this.api.getBytes(`/api/v1/problems/${id}/files/attachment`, ATTACHMENT.maxDownloadBytes));
    if (r.status !== 200) return r;
    return { status: 200, bytes: r.bytes, filename: parseContentDisposition(r.disposition), contentType: r.contentType?.split(';')[0].trim().toLowerCase() || null };
  }

  /** `GET /api/v1/problems/{id}/description` → null on 403 / 404. */
  async getDescription(id: number): Promise<{ markdown: boolean; description: string } | null> {
    assertId(id);
    try {
      const d = await this.authed(() => this.api.get<{ markdown: boolean; description: string | null }>(`/api/v1/problems/${id}/description`));
      return d.description ? { markdown: !!d.markdown, description: d.description } : null;
    } catch (err) {
      if (err instanceof GraderError && !(err instanceof NetworkError) && !(err instanceof SessionExpiredError) && !(err instanceof AuthError)) return null;
      throw err;
    }
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
    if (!source.trim()) throw new GraderError(G.fileEmpty);
    const r = await this.authed(() => this.api.createSubmission(problemId, languageId, source, filename));
    return { id: r.id, number: r.number ?? null };
  }

  /** `GET /api/v1/submissions/{id}`: status, points, compiler message, source, evaluations. */
  async getSubmission(id: number, signal?: AbortSignal): Promise<SubmissionDetail> {
    assertId(id);
    return toDetail(await this.authed(() => this.api.get<ApiSubmission>(`/api/v1/submissions/${id}`, signal)));
  }

  /**
   * Poll one submission until graded. Waits max(3 s, interval); ×2 back-off on
   * up to 2 consecutive network errors, then gives up (the caller resumes later); 3 min cap.
   */
  async pollSubmission(id: number, opts: PollOptions = {}): Promise<SubmissionDetail> {
    const interval = Math.max(MIN_POLL_MS, opts.intervalMs ?? DEFAULT_POLL_MS);
    const timeout = opts.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const start = this.now().getTime();
    let backoff = interval;
    let failures = 0;
    let last: SubmissionDetail | null = null;
    for (;;) {
      let wait = interval;
      try {
        const s = await this.getSubmission(id, opts.signal);
        last = s;
        failures = 0;
        opts.onUpdate?.(s);
        if (s.state === 'graded') return s;
        backoff = interval;
      } catch (err) {
        if (!(err instanceof NetworkError) || ++failures > MAX_POLL_NETWORK_FAILURES) throw err;
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        wait = backoff;
      }
      if (this.now().getTime() - start + wait > timeout) {
        throw Object.assign(new PollTimeoutError(G.pollTimeout), { last });
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
    tags: (p.tags ?? []).map((t) => clean(t)).filter(Boolean),
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
  if (!Number.isInteger(id) || id <= 0) throw new GraderError(G.invalidId(id));
}
