import { G } from '../../../shared/strings';
import { TIMING } from '../../../shared/constants';
import { AuthError, checkRedirect, GraderError, NetworkError, LanguageNotAllowedError, networkErrorFrom, ProblemUnavailableError, ServerBusyError, SessionExpiredError, SubmitRejectedError } from '../../errors';
import type { FetchLike, Logger } from './http';
import type { Redactor } from '../../redact';
import { withTimeoutSignal } from '../../timeoutSignal';

/**
 * Thin client for cafe-grader's JSON API (`/api/v1`, JWT bearer auth).
 * Shapes confirmed from `config/routes.rb` and `app/controllers/api/v1/*`
 * (nattee/cafe-grader-web @ 404d3c5).
 */

export interface ApiUser {
  id: number;
  login: string;
  full_name: string;
}

export interface ApiLoginResponse {
  token: string;
  expires_at: string;
  user: ApiUser;
}

export interface ApiLanguageRef {
  id: number;
  name: string;
  ext: string;
}

export interface ApiProblem {
  id: number;
  name: string;
  full_name: string;
  submission_count: number;
  best_score: number | null;
  last_score: number | null;
  last_result: string | null;
  last_submission_time: string | null;
  last_submission_id: number | null;
  has_testcase: boolean;
  has_attachment: boolean;
  /** Public tag names. */
  tags?: string[];
  /** null = all languages allowed. */
  permitted_languages: ApiLanguageRef[] | null;
  /** `show` only. */
  full_score?: number | null;
  submission_ids?: number[];
}

export interface ApiLanguage {
  id: number;
  name: string;
  pretty_name: string;
  ext: string;
}

export interface ApiSubmissionBrief {
  id: number;
  number: number | null;
  language: string | null;
  submitted_at: string | null;
  points: number | null;
  status: string;
  grader_comment: string | null;
}

export interface ApiSubmission extends ApiSubmissionBrief {
  problem_id: number;
  problem_name: string;
  user_id: number;
  source?: string | null;
  source_filename: string | null;
  compiler_message: string | null;
  max_runtime: number | null;
  peak_memory: number | null;
  evaluations: { testcase_id: number; result: string | null; score: number | null; time: number | null; memory: number | null }[];
}

export interface ApiCreatedSubmission {
  id: number;
  number: number | null;
  status: string;
}

const TIMEOUT_MS = TIMING.requestTimeoutMs;
/** Same-origin redirects followed per request (`raw`). */
const MAX_REDIRECTS = 5;
/** GET retries on 429 / 5xx: waits 2 s, then 4 s (or the server's Retry-After, capped at 30 s). */
const GET_RETRIES = TIMING.getRetries;

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ApiClient {
  private token: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike,
    private readonly log: Logger,
    private readonly redactor: Redactor,
    private readonly sleep: Sleep = realSleep,
  ) {}

  setToken(token: string | null): void {
    this.token = token;
    this.redactor.add(token);
  }

  get hasToken(): boolean {
    return this.token !== null;
  }

  /** `POST /api/v1/auth/login`. Never retried: the server throttles failed logins. */
  async login(login: string, password: string): Promise<ApiLoginResponse> {
    this.redactor.add(password);
    const res = await this.raw('POST', '/api/v1/auth/login', { login, password }, false);
    const body = (await this.json(res)) as Partial<ApiLoginResponse> & { error?: string };
    if (res.status === 401) throw new AuthError(G.wrongPassword, 'wrong-password');
    if (res.status === 429) throw new AuthError(G.loginThrottled, 'throttled');
    if (res.status === 403) throw new AuthError(body.error ?? G.loginRefused, 'unknown');
    if (!res.ok || !body.token) throw new AuthError(body.error ?? G.loginFailedHttp(res.status), 'unknown');
    this.setToken(body.token);
    return body as ApiLoginResponse;
  }

  /** Idempotent GET: retried with back-off on 429 / 5xx (never for POSTs or login). */
  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.raw('GET', path, undefined, true, signal, true);
      if (res.status !== 429 && res.status < 500) return this.handle<T>(res, path);
      await res.body?.cancel().catch(() => {});
      if (attempt >= GET_RETRIES) {
        throw new ServerBusyError(
          res.status === 429 ? G.rateLimited : G.httpError(res.status),
          res.status,
        );
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      await this.sleep(Math.min(TIMING.retryAfterCapMs, retryAfter > 0 ? retryAfter * 1000 : TIMING.retryBaseMs * 2 ** attempt), signal);
    }
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.raw('POST', path, body, true);
    return this.handle<T>(res, path);
  }

  /**
   * Binary GET (statement PDF, attachment). 403 / 404 are returned as statuses, not thrown.
   * Retries 429 / 5xx like `get`. `maxBytes`: a larger body is refused (Content-Length first, then
   * counted while reading: a body without Content-Length, or compressed, stops at the cap).
   */
  async getBytes(
    path: string,
    maxBytes: number,
  ): Promise<{ status: 200; bytes: Uint8Array; contentType: string | null; disposition: string | null } | { status: 403 | 404; error: string | null }> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.raw('GET', path, undefined, true, undefined, true);
      if (res.ok) {
        const declared = Number(res.headers.get('content-length'));
        if (declared > maxBytes) {
          await res.body?.cancel().catch(() => {});
          throw new GraderError(G.downloadTooLarge(Math.ceil(maxBytes / 1048576)));
        }
        const bytes = await readCapped(res, maxBytes);
        return { status: 200, bytes, contentType: res.headers.get('content-type'), disposition: res.headers.get('content-disposition') };
      }
      if (res.status === 403 || res.status === 404) {
        const body = (await this.json(res)) as { error?: string } | null;
        return { status: res.status, error: body?.error ?? null };
      }
      if (res.status === 401) throw new SessionExpiredError(G.loginExpiredShort, true);
      if (res.status !== 429 && res.status < 500) throw new GraderError(G.httpRefused(res.status));
      await res.body?.cancel().catch(() => {});
      if (attempt >= GET_RETRIES) throw new ServerBusyError(G.httpError(res.status), res.status);
      await this.sleep(TIMING.retryBaseMs * 2 ** attempt);
    }
  }

  /**
   * Plain-text GET (test case input / sol). Student ("preview") access cuts
   * large files and sets `X-Testcase-Truncated: true` and `X-Testcase-Byte-Size`.
   */
  async getText(path: string): Promise<{ text: string; truncated: boolean; byteSize: number | null }> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.raw('GET', path, undefined, true, undefined, true);
      if (res.ok) {
        const size = Number(res.headers.get('x-testcase-byte-size'));
        return {
          text: await res.text(),
          truncated: (res.headers.get('x-testcase-truncated') ?? '').toLowerCase() === 'true',
          byteSize: Number.isFinite(size) && size > 0 ? size : null,
        };
      }
      if (res.status !== 429 && res.status < 500) return this.handle(res, path);
      await res.body?.cancel().catch(() => {});
      if (attempt >= GET_RETRIES) throw new ServerBusyError(G.httpError(res.status), res.status);
      await this.sleep(TIMING.retryBaseMs * 2 ** attempt);
    }
  }

  /** Create a submission; maps 403/422 to readable errors. */
  async createSubmission(problemId: number, languageId: number, source: string, filename: string): Promise<ApiCreatedSubmission> {
    const res = await this.raw('POST', `/api/v1/problems/${problemId}/submissions`, { language_id: languageId, source, filename }, true);
    if (res.status === 201 || res.ok) return (await this.json(res)) as ApiCreatedSubmission;
    const body = (await this.json(res)) as { error?: string; errors?: string[]; permitted_languages?: { id: number; name: string }[] };
    if (res.status === 401) throw new SessionExpiredError(G.loginExpiredShort, true);
    if (res.status === 422 && body.permitted_languages) {
      throw new LanguageNotAllowedError(
        G.languageNotAllowed(body.permitted_languages.map((l) => l.name).join(', ')),
      );
    }
    const msg = body.error ?? body.errors?.join('; ') ?? `HTTP ${res.status}`;
    if (res.status === 404 || res.status === 403) throw new ProblemUnavailableError(G.problemUnavailableDetail(msg), res.status);
    throw new SubmitRejectedError(G.submissionRejected(msg));
  }

  private async handle<T>(res: Response, path = ''): Promise<T> {
    const body = await this.json(res);
    if (res.ok) return body as T;
    const msg = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new SessionExpiredError(G.loginExpiredShort, true);
    // Problem endpoints: 404 = gone, 403 = no longer open to you.
    if ((res.status === 404 || res.status === 403) && /^\/api\/v1\/problems\/\d+/.test(path)) {
      throw new ProblemUnavailableError(G.problemUnavailable, res.status);
    }
    if (res.status === 404) throw new GraderError(G.notFound(msg));
    throw new GraderError(G.refused(msg));
  }

  private async json(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      if (res.status >= 500) throw new ServerBusyError(G.httpError(res.status), res.status);
      return null;
    }
  }

  private async raw(method: 'GET' | 'POST', path: string, body: unknown, auth: boolean, signal?: AbortSignal, passErrors = false): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      if (!this.token) throw new SessionExpiredError(G.notLoggedIn, true);
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    const limited = withTimeoutSignal(TIMEOUT_MS, signal);
    let res: Response;
    // Redirects are followed here, not by fetch (`redirect: 'manual'`), and only within the
    // grader's origin: fetch would re-send a 307/308 login body (the password) to any host,
    // and whether it drops the Authorization header across origins depends on the Node version.
    let url = this.baseUrl + path;
    let sendBody = body === undefined ? undefined : JSON.stringify(body);
    let verb: 'GET' | 'POST' = method;
    let shown = path; // logged path (no query)
    for (let hop = 0; ; hop++) {
      try {
        res = await this.fetchImpl(url, {
          method: verb,
          headers,
          body: sendBody,
          redirect: 'manual',
          signal: limited,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw networkErrorFrom(err, new URL(this.baseUrl).host);
      }
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !location) break;
      this.log(`${verb} ${shown} → ${res.status}`);
      await res.body?.cancel().catch(() => {});
      url = checkRedirect(this.baseUrl, url, location);
      shown = new URL(url).pathname;
      if (hop >= MAX_REDIRECTS) throw new NetworkError(G.tooManyRedirects);
      // 301/302/303 → GET without a body (as fetch does); 307/308 keep both.
      if (res.status !== 307 && res.status !== 308) {
        verb = 'GET';
        sendBody = undefined;
        delete headers['Content-Type'];
      }
    }
    this.log(`${verb} ${shown} → ${res.status}`);
    if (res.status >= 500 && !passErrors) {
      await res.body?.cancel().catch(() => {});
      throw new ServerBusyError(G.httpError(res.status), res.status);
    }
    return res;
  }
}

/**
 * The body as bytes, read chunk by chunk; the read is cancelled as soon as it
 * passes `maxBytes` (the whole body is never buffered first).
 */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const tooBig = () => new GraderError(G.downloadTooLarge(Math.ceil(maxBytes / 1048576)));
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
