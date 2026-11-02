import { fixture } from './helpers';

export interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  form: Record<string, string>;
}

/**
 * A tiny in-memory cafe-grader imitation for client tests: login with CSRF,
 * session cookie, redirects to /main/login when logged out, submit, poll.
 */
export class FakeGrader {
  requests: Recorded[] = [];
  sessions = new Set<string>();
  private nextSession = 1;
  password = 'pw';
  listHtml = fixture('main_list.normal.synthetic.html');
  submitPageHtml = fixture('direct_edit_problem.normal.synthetic.html');
  loginHtml = fixture('login_page.synthetic.html').replace(/<div class="alert[\s\S]*?<\/div>/, '');
  /** Alert shown when a logged-out request is bounced. */
  bounceAlert = 'You need to log in';
  /** Poll responses served in order (last one repeats). */
  pollSequence: string[] = [fixture('latest_status_graded.synthetic.html')];
  pollIndex = 0;
  newSubmissionId = 5003;
  submitRedirect: string | null = null;
  submitFlash = '';
  networkFailures = 0;

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    if (this.networkFailures > 0) {
      this.networkFailures--;
      throw new TypeError('fetch failed');
    }
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const form: Record<string, string> = {};
    if (init.body instanceof URLSearchParams) for (const [k, v] of init.body) form[k] = v;
    if (init.body instanceof FormData) for (const [k, v] of init.body) form[k] = String(v);
    this.requests.push({ method, path: url.pathname, headers, form });

    const cookie = headers['Cookie'] ?? '';
    const sid = /_cafe_grader_session=([^;]+)/.exec(cookie)?.[1];
    const loggedIn = sid !== undefined && this.sessions.has(sid);
    const setCookies: string[] = [];
    if (!/uuid=/.test(cookie)) setCookies.push('uuid=device-1; path=/; HttpOnly');

    const html = (body: string, status = 200) => this.respond(status, body, setCookies);
    const redirect = (to: string) => this.respond(302, '', setCookies, to);
    const bounce = () => {
      this.flash = this.bounceAlert;
      return redirect('/main/login');
    };

    const p = url.pathname;
    if (method === 'GET' && (p === '/' || p === '/main/login')) {
      if (loggedIn && p === '/') return redirect('/main/list');
      const alert = this.flash ? `<div class="alert alert-danger">${this.flash}</div>` : '';
      this.flash = '';
      return html(this.loginHtml.replace('<body>', `<body>${alert}`));
    }
    if (method === 'POST' && p === '/login/login') {
      if (form.authenticity_token !== 'REDACTED') return redirect('/main/list'); // null session
      if (this.loginHtml.includes('accept_agree') && form.accept_agree !== '1') {
        this.flash = 'You must accept the agreement before logging in';
        return redirect('/main/login');
      }
      if (form.password !== this.password) {
        this.flash = 'Wrong password';
        return redirect('/main/login');
      }
      const s = `s${this.nextSession++}`;
      this.sessions.add(s);
      setCookies.push(`_cafe_grader_session=${s}; path=/; HttpOnly`);
      return redirect('/main/list');
    }
    if (!loggedIn) return bounce();

    if (method === 'GET' && p === '/main/list') {
      const alert = this.flash ? `<div class="alert alert-danger">${this.flash}</div>` : '';
      this.flash = '';
      return html(this.listHtml.replace('<div class="container-fluid">\n', `<div class="container-fluid">\n${alert}`));
    }
    if (method === 'GET' && /^\/submissions\/direct_edit_problem\/\d+$/.test(p)) return html(this.submitPageHtml);
    if (method === 'POST' && p === '/main/submit') {
      if (form.authenticity_token !== 'REDACTED') return bounce();
      if (this.submitRedirect) {
        this.flash = this.submitFlash;
        return redirect(this.submitRedirect);
      }
      return redirect(`/submissions/${this.newSubmissionId}/edit`);
    }
    if (method === 'GET' && /^\/submissions\/\d+\/edit$/.test(p)) {
      return html(
        this.submitPageHtml.replace(
          '</form>',
          `</form><a id="refresh" href="/submissions/get_latest_submission_status/12345/102">r</a>`,
        ),
      );
    }
    if (method === 'GET' && p.startsWith('/submissions/get_latest_submission_status/')) {
      const body = this.pollSequence[Math.min(this.pollIndex++, this.pollSequence.length - 1)];
      return html(body);
    }
    if (method === 'POST' && /^\/submissions\/\d+\/compiler_msg$/.test(p)) {
      if (headers['X-CSRF-Token'] !== 'REDACTED') return bounce();
      return html(fixture('compiler_msg.synthetic.html'));
    }
    return html('not found', 404);
  };

  private flash = '';

  private respond(status: number, body: string, setCookies: string[], location?: string): Response {
    const h = new Headers({ 'content-type': 'text/html; charset=utf-8' });
    for (const c of setCookies) h.append('set-cookie', c);
    if (location) h.set('location', `https://grader.test${location}`);
    return new Response(status === 302 ? null : body, { status, headers: h });
  }

  expireAllSessions(alert = 'Your session is expired, please login again.'): void {
    this.sessions.clear();
    this.bounceAlert = alert;
  }

  count(method: string, path: string | RegExp): number {
    return this.requests.filter((r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path))).length;
  }
}
