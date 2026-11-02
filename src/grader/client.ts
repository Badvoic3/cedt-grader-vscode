import {
  AuthError,
  GraderError,
  LanguageNotAllowedError,
  NetworkError,
  ParseError,
  PollTimeoutError,
  SessionExpiredError,
  SubmitRejectedError,
} from './errors';
import { HttpSession, type FetchLike, type HttpResult, type Logger } from './http';
import {
  extractAlerts,
  extractCsrf,
  hasLoginForm,
  parseCompilerMessage,
  parseEvaluations,
  parseLoginForm,
  parsePollUrl,
  parseProblemList,
  parseSubmissionStatus,
  parseSubmitPage,
  parseUserId,
} from './parsers';
import type { Evaluation, Problem, SubmissionStatus, SubmitPage } from './types';

export const DEFAULT_BASE_URL = 'https://cedt-grader.nattee.net';

export interface Credentials {
  username: string;
  password: string;
}

export interface GraderClientOptions {
  baseUrl?: string;
  /** Called on (re-)login. Return undefined to abort the login. */
  getCredentials: () => Promise<Credentials | undefined>;
  fetch?: FetchLike;
  log?: Logger;
  /** Injectable clock and sleep for tests. */
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface SubmitOptions {
  /** Path of the source file (for the multipart filename hint). */
  filename?: string;
}

export interface SubmitResult {
  submissionId: number;
  pollUrl: string | null;
}

export interface PollOptions {
  submissionId?: number;
  pollUrl?: string | null;
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (s: SubmissionStatus) => void;
}

/** Server alerts after which a fresh login can help. */
const RELOGIN_ALERTS = [/you need to log in/i, /session is expired/i];

const MIN_POLL_MS = 3_000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 3 * 60_000;
const MAX_BACKOFF_MS = 60_000;

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
 * Talks to a cafe-grader-web server through its HTML forms.
 * It never requests anything under `/contests` and does not pretend to be a browser.
 */
export class GraderClient {
  readonly http: HttpSession;
  readonly baseUrl: string;
  private loggedIn = false;
  private loginInFlight: Promise<void> | null = null;
  /** Discovered after login / submit; never hard-coded. */
  userId: number | null = null;
  /** Problems parsed from the page login landed on (/main/list), if any. */
  landingProblems: Problem[] | null = null;
  private readonly now: () => Date;
  private readonly sleep: NonNullable<GraderClientOptions['sleep']>;

  constructor(private readonly opts: GraderClientOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.http = new HttpSession(this.baseUrl, opts.fetch, opts.log);
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? defaultSleep;
  }

  get isLoggedIn(): boolean {
    return this.loggedIn;
  }

  url(path: string): string {
    return this.http.resolve(path);
  }

  // ---------------------------------------------------------------- login

  /** Log in with fresh credentials. */
  login(): Promise<void> {
    if (!this.loginInFlight) {
      this.loginInFlight = this.doLogin().finally(() => {
        this.loginInFlight = null;
      });
    }
    return this.loginInFlight;
  }

  private async doLogin(): Promise<void> {
    const creds = await this.opts.getCredentials();
    if (!creds || !creds.username || !creds.password) {
      throw new AuthError('No username/password configured. Run "CEDT Grader: Log In".', 'no-credentials');
    }
    this.http.redactor.add(creds.password);
    this.loggedIn = false;

    const page = await this.http.request('/');
    const form = parseLoginForm(page.body);
    if (!form.present) {
      // Already logged in (session still valid): `/` redirected to the problem list.
      if (!hasLoginForm(page.body) && /\/main\/list/.test(page.path)) {
        this.loggedIn = true;
        return this.afterLoggedInPage(page);
      }
      throw new ParseError('Could not find the login form on the grader home page.');
    }
    if (!form.token) throw new ParseError('Could not find the CSRF token on the login page.');
    this.http.redactor.add(form.token);

    const body = new URLSearchParams({
      authenticity_token: form.token,
      login: creds.username,
      password: creds.password,
      commit: 'Login',
    });
    if (form.hasAgreement) {
      throw new AuthError('The grader asks you to accept an agreement first. Log in once through the website.', 'agreement-required');
    }

    const res = await this.http.request('/login/login', { method: 'POST', body });
    if (hasLoginForm(res.body) || /\/main\/login$/.test(res.path)) {
      const alerts = extractAlerts(res.body);
      const alert = alerts[0] ?? '';
      if (/wrong password/i.test(alert)) {
        throw new AuthError('Wrong username or password.', 'wrong-password');
      }
      if (/too many failed/i.test(alert)) {
        throw new AuthError('Too many failed login attempts. Wait a few minutes and try again.', 'throttled');
      }
      if (/accept the agreement/i.test(alert)) {
        throw new AuthError('The grader requires accepting its agreement. Log in through the website.', 'agreement-required');
      }
      throw new AuthError(alert ? `Login failed: ${alert}` : 'Login failed.', 'unknown');
    }
    this.loggedIn = true;
    return this.afterLoggedInPage(res);
  }

  private afterLoggedInPage(page: HttpResult): void {
    const uid = parseUserId(page.body);
    if (uid !== null) this.userId = uid;
    this.http.redactor.add(extractCsrf(page.body));
    // Login lands on /main/list: keep its problems so callers need no second fetch.
    this.landingProblems = /\/main\/list$/.test(page.path) ? parseProblemList(page.body) : null;
  }

  /** Forget the session locally (cookies are only in memory). */
  logout(): void {
    this.http.clearCookies();
    this.http.redactor.clear();
    this.loggedIn = false;
    this.userId = null;
    this.landingProblems = null;
  }

  // ------------------------------------------------------- session helpers

  /** Throw SessionExpiredError when a response is the login page. */
  private checkSession(res: HttpResult): void {
    if (!hasLoginForm(res.body) && !/\/main\/login$/.test(res.path)) return;
    this.loggedIn = false;
    const alert = extractAlerts(res.body)[0] ?? '';
    const retryable = alert === '' || RELOGIN_ALERTS.some((re) => re.test(alert));
    throw new SessionExpiredError(
      retryable ? 'Your grader session has expired.' : `The grader logged you out: ${alert}`,
      retryable,
    );
  }

  /** Run `fn`; on a retryable session expiry log in once and retry once. */
  private async withSession<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.loggedIn) await this.login();
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SessionExpiredError && err.retryable) {
        await this.login();
        try {
          return await fn();
        } catch (err2) {
          if (err2 instanceof SessionExpiredError) {
            throw new SessionExpiredError('Session expired again right after logging in. Try "CEDT Grader: Log In".', false);
          }
          throw err2;
        }
      }
      throw err;
    }
  }

  private async getPage(path: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<HttpResult> {
    const res = await this.http.request(path, { headers, signal });
    this.checkSession(res);
    const token = extractCsrf(res.body);
    this.http.redactor.add(token);
    return res;
  }

  // ------------------------------------------------------------- reading

  async listProblems(): Promise<Problem[]> {
    return this.withSession(async () => {
      const res = await this.getPage('/main/list');
      const uid = parseUserId(res.body);
      if (uid !== null) this.userId = uid;
      return parseProblemList(res.body);
    });
  }

  /** Fresh submit page (languages, CSRF token, exam hint). */
  async getSubmitPage(problemId: number): Promise<SubmitPage> {
    assertId(problemId);
    return this.withSession(() => this.fetchSubmitPage(problemId));
  }

  private async fetchSubmitPage(problemId: number): Promise<SubmitPage> {
    const res = await this.getPage(`/submissions/direct_edit_problem/${problemId}`);
    if (/\/main\/list$/.test(res.path)) {
      const alert = extractAlerts(res.body)[0];
      throw new SubmitRejectedError(alert ? alert : `Problem #${problemId} is not available for you.`);
    }
    const uid = parseUserId(res.body);
    if (uid !== null) this.userId = uid;
    return parseSubmitPage(res.body, problemId);
  }

  async getLanguages(problemId: number) {
    return (await this.getSubmitPage(problemId)).languages;
  }

  // -------------------------------------------------------------- submit

  /** Submit `source` as `languageId` for `problemId` (fetches the submit page first for a fresh CSRF token). */
  async submit(problemId: number, languageId: number, source: string, _opts: SubmitOptions = {}): Promise<SubmitResult> {
    assertId(problemId);
    if (!source.trim()) throw new SubmitRejectedError('The file is empty.');

    return this.withSession(async () => {
      const page = await this.fetchSubmitPage(problemId);
      if (!page.canSubmit) {
        throw new SubmitRejectedError('This problem is not open for your submissions.');
      }
      if (!page.languages.some((l) => l.id === languageId)) {
        throw new LanguageNotAllowedError(
          `That language is not allowed for this problem. Allowed: ${page.languages.map((l) => l.name).join(', ') || 'none'}.`,
        );
      }
      if (!page.csrfToken) throw new ParseError('Could not find the CSRF token on the submit page.');

      const form = new FormData();
      form.set('authenticity_token', page.csrfToken);
      form.set('submission[problem_id]', String(page.problemId));
      form.set('language_id', String(languageId));
      form.set('editor_text', source);
      form.set('commit', 'Submit');

      const res = await this.http.request('/main/submit', { method: 'POST', body: form, followRedirects: false });
      const location = res.redirects[0];
      if (!location) {
        throw new SubmitRejectedError(`Unexpected response from the grader after submitting (HTTP ${res.status}).`);
      }
      const locPath = new URL(location).pathname;
      const m = /^\/submissions\/(\d+)\/edit$/.exec(locPath);
      if (!m) {
        // Error → follow to read the flash alert.
        const follow = await this.http.request(location);
        this.checkSession(follow); // throws (retryable → resubmit once is safe: nothing was saved)
        const alert = extractAlerts(follow.body)[0] ?? '';
        if (/language is not permitted/i.test(alert)) throw new LanguageNotAllowedError('That language is not allowed for this problem.');
        throw new SubmitRejectedError(alert ? `Submission rejected: ${alert}` : 'Submission rejected by the grader.');
      }
      const submissionId = Number(m[1]);

      // The page we are redirected to renders the poll URL (with the user id).
      let pollUrl: string | null = null;
      try {
        const edit = await this.http.request(locPath);
        if (!hasLoginForm(edit.body)) {
          pollUrl = parsePollUrl(edit.body);
          const uid = parseUserId(edit.body);
          if (uid !== null) this.userId = uid;
        }
      } catch (err) {
        if (!(err instanceof NetworkError)) throw err;
      }
      return { submissionId, pollUrl };
    });
  }

  // ---------------------------------------------------------------- poll

  pollUrlFor(problemId: number): string {
    if (this.userId === null) {
      throw new ParseError('Could not discover your user id from the grader pages.');
    }
    return `/submissions/get_latest_submission_status/${this.userId}/${problemId}`;
  }

  /** One status request. */
  async getLatestStatus(problemId: number, pollUrl?: string | null, signal?: AbortSignal): Promise<SubmissionStatus> {
    assertId(problemId);
    return this.withSession(async () => {
      const res = await this.getPage(
        pollUrl ?? this.pollUrlFor(problemId),
        { Accept: 'text/vnd.turbo-stream.html, text/html' },
        signal,
      );
      if (/\/main\/list$/.test(res.path)) {
        throw new SubmitRejectedError(extractAlerts(res.body)[0] ?? 'Not allowed to view this submission.');
      }
      return parseSubmissionStatus(res.body);
    });
  }

  /**
   * Poll until the submission is graded or the timeout passes.
   * Waits max(intervalMs, server suggested delay); backs off ×2 on network errors.
   */
  async pollLatest(problemId: number, opts: PollOptions = {}): Promise<SubmissionStatus> {
    const interval = Math.max(MIN_POLL_MS, opts.intervalMs ?? DEFAULT_POLL_MS);
    const timeout = opts.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const start = this.now().getTime();
    let backoff = interval;
    let last: SubmissionStatus | null = null;
    let pollUrl = opts.pollUrl ?? null;

    for (;;) {
      let wait = interval;
      try {
        const s = await this.getLatestStatus(problemId, pollUrl, opts.signal);
        last = s;
        opts.onUpdate?.(s);
        const ours = opts.submissionId === undefined || (s.id !== null && s.id >= opts.submissionId);
        if (ours && s.state === 'graded') return s;
        if (s.refreshUrl) pollUrl = s.refreshUrl;
        if (s.refreshDelayMs) wait = Math.max(interval, s.refreshDelayMs);
        backoff = interval;
      } catch (err) {
        if (err instanceof NetworkError) {
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          wait = backoff;
        } else {
          throw err;
        }
      }
      if (this.now().getTime() - start + wait > timeout) {
        throw Object.assign(
          new PollTimeoutError('Still not graded after 3 minutes. Use "CEDT Grader: Show Last Result" to check again.'),
          { last },
        );
      }
      await this.sleep(wait, opts.signal);
    }
  }

  // ---------------------------------------------------- turbo endpoints

  /** POST a Turbo endpoint (compiler_msg / evaluations) and return the raw turbo-stream. */
  async postTurbo(path: string): Promise<string> {
    return this.withSession(async () => {
      // Fresh token from a logged-in page we are allowed to see.
      const page = await this.getPage('/main/list');
      const token = extractCsrf(page.body);
      if (!token) throw new ParseError('Could not find a CSRF token.');
      const res = await this.http.request(path, {
        method: 'POST',
        headers: { 'X-CSRF-Token': token, Accept: 'text/vnd.turbo-stream.html' },
        body: new URLSearchParams(),
      });
      this.checkSession(res);
      if (/\/main\/list$/.test(res.path)) {
        throw new SubmitRejectedError(extractAlerts(res.body)[0] ?? 'Not allowed to view this submission.');
      }
      return res.body;
    });
  }

  async getCompilerMessage(submissionId: number): Promise<string> {
    assertId(submissionId);
    return parseCompilerMessage(await this.postTurbo(`/submissions/${submissionId}/compiler_msg`));
  }

  async getEvaluations(submissionId: number): Promise<Evaluation[]> {
    assertId(submissionId);
    return parseEvaluations(await this.postTurbo(`/submissions/${submissionId}/evaluations`));
  }

  /** Raw GET of a logged-in page (used by the probe to save fixtures). */
  async getRaw(path: string, headers?: Record<string, string>): Promise<HttpResult> {
    return this.withSession(() => this.getPage(path, headers));
  }
}

function assertId(id: number): void {
  if (!Number.isInteger(id) || id <= 0) throw new GraderError(`Invalid id: ${id}`);
}
