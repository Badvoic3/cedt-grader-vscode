import { TIMING } from '../shared/constants';
import { CookieJar } from 'tough-cookie';
import { NetworkError, networkErrorFrom } from './errors';
import { Redactor } from './redact';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type Logger = (line: string) => void;

export interface HttpResult {
  status: number;
  /** Final URL after following redirects. */
  url: string;
  /** Path of the final URL (no query). */
  path: string;
  /** Every `Location` we followed, as absolute URLs, in order. */
  redirects: string[];
  body: string;
  contentType: string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: URLSearchParams | FormData;
  headers?: Record<string, string>;
  /** Follow redirects (default true). The submit flow reads the first Location itself. */
  followRedirects?: boolean;
  signal?: AbortSignal;
}

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = TIMING.requestTimeoutMs;

/**
 * Small HTTP session: built-in fetch + in-memory cookie jar + manual redirects.
 *
 * - Cookies live only in memory and are never logged.
 * - We do not set a custom User-Agent and never pretend to be a browser.
 * - Logs contain only method, path and status.
 */
export class HttpSession {
  private jar = new CookieJar();

  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly log: Logger = () => {},
    readonly redactor = new Redactor(),
  ) {}

  resolve(pathOrUrl: string): string {
    return new URL(pathOrUrl, this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/').toString();
  }

  /** Forget all cookies (session + device id). */
  clearCookies(): void {
    this.jar = new CookieJar();
  }

  hasCookie(name: string): boolean {
    return this.jar.getCookiesSync(this.baseUrl).some((c) => c.key === name);
  }

  async request(pathOrUrl: string, opts: RequestOptions = {}): Promise<HttpResult> {
    let url = this.resolve(pathOrUrl);
    let method = opts.method ?? 'GET';
    let body: RequestOptions['body'] | undefined = opts.body;
    const redirects: string[] = [];
    const follow = opts.followRedirects ?? true;

    for (let hop = 0; ; hop++) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      const cookie = await this.jar.getCookieString(url);
      if (cookie) headers['Cookie'] = cookie;
      if (body instanceof URLSearchParams) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      // FormData: let fetch set the multipart boundary.

      let res: Response;
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      try {
        res = await this.fetchImpl(url, { method, headers, body, redirect: 'manual', signal });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        throw networkErrorFrom(err, new URL(url).host);
      }

      for (const sc of getSetCookies(res.headers)) {
        try {
          await this.jar.setCookie(sc, url, { ignoreError: true });
        } catch {
          /* malformed cookie: ignore */
        }
      }

      const path = new URL(url).pathname;
      this.log(`${method} ${path} → ${res.status}`);

      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        const next = new URL(location, url).toString();
        redirects.push(next);
        if (!follow) {
          return { status: res.status, url, path, redirects, body: '', contentType: '' };
        }
        if (hop >= MAX_REDIRECTS) throw new NetworkError('Too many redirects from the grader.');
        await res.body?.cancel().catch(() => {});
        // 301/302/303 after POST → GET (what browsers and Rails expect).
        if (res.status !== 307 && res.status !== 308) {
          method = 'GET';
          body = undefined;
        }
        url = next;
        continue;
      }

      const text = await res.text();
      if (res.status >= 500) {
        throw new NetworkError(`The grader returned an error (HTTP ${res.status}).`, 'server');
      }
      return {
        status: res.status,
        url,
        path,
        redirects,
        body: text,
        contentType: res.headers.get('content-type') ?? '',
      };
    }
  }
}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
