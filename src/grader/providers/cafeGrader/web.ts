import { AuthError, ParseError, SessionExpiredError } from '../../errors';
import { HttpSession, type FetchLike, type Logger } from './http';
import { extractAlerts, extractCsrf, hasLoginForm, parseLoginForm } from './parsers';
import type { Redactor } from '../../redact';
import { G } from '../../../shared/strings';

/**
 * Cookie-based web session, used only for what the JSON API does not offer:
 * the `/main/list` page (hint / AI-assist penalties, raw-sum mode, and the
 * page-header exam hint). Never touches `/contests`.
 */
export class WebSession {
  readonly http: HttpSession;
  private loggedIn = false;

  constructor(baseUrl: string, fetchImpl: FetchLike | undefined, log: Logger, redactor: Redactor) {
    this.http = new HttpSession(baseUrl, fetchImpl, log, redactor);
  }

  get isLoggedIn(): boolean {
    return this.loggedIn;
  }

  clear(): void {
    this.http.clearCookies();
    this.loggedIn = false;
  }

  /** Web form login. Returns the landing page HTML (`/main/list`). Never retried on failure. */
  async login(username: string, password: string): Promise<string> {
    this.loggedIn = false;
    const page = await this.http.request('/');
    if (!hasLoginForm(page.body) && /\/main\/list$/.test(page.path)) {
      this.loggedIn = true;
      return page.body;
    }
    const form = parseLoginForm(page.body);
    if (!form.present || !form.token) throw new ParseError('Could not find the web login form.');
    if (form.hasAgreement) throw new AuthError('The website asks you to accept an agreement first; log in there once.', 'agreement-required');
    this.http.redactor.add(form.token);
    const res = await this.http.request('/login/login', {
      method: 'POST',
      body: new URLSearchParams({ authenticity_token: form.token, login: username, password, commit: 'Login' }),
    });
    if (hasLoginForm(res.body) || /\/main\/login$/.test(res.path)) {
      const alert = extractAlerts(res.body)[0] ?? '';
      if (/wrong password/i.test(alert)) throw new AuthError(G.wrongPassword, 'wrong-password');
      if (/too many failed/i.test(alert)) throw new AuthError(G.loginThrottled, 'throttled');
      throw new AuthError(alert ? `Web login failed: ${alert}` : 'Web login failed.', 'unknown');
    }
    this.loggedIn = true;
    this.http.redactor.add(extractCsrf(res.body));
    return res.body;
  }

  /** `GET /main/list`; throws SessionExpiredError when bounced to the login page. */
  async problemListPage(): Promise<string> {
    const res = await this.http.request('/main/list');
    if (hasLoginForm(res.body) || /\/main\/login$/.test(res.path)) {
      this.loggedIn = false;
      throw new SessionExpiredError('Web session expired.', true);
    }
    this.http.redactor.add(extractCsrf(res.body));
    return res.body;
  }
}
