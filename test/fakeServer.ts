import { fixture } from './helpers';

export interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * In-memory cafe-grader imitation for client tests: the JSON API (JWT) and
 * the cookie web login + /main/list. Response shapes follow
 * app/controllers/api/v1/* (SYNTHETIC data).
 */
export class FakeGrader {
  requests: Recorded[] = [];
  password = 'pw';
  validTokens = new Set<string>();
  private nextToken = 1;
  throttled = false;
  networkFailures = 0;
  /** Status sequence served by GET /api/v1/submissions/:id (last repeats). */
  statusSequence: string[] = ['done'];
  statusIndex = 0;
  gradedPoints = 70;
  gradedComment = 'PP-T';
  compilerMessage: string | null = null;
  submitError: { status: number; body: unknown } | null = null;
  webSessions = new Set<string>();
  listHtml = fixture('main_list.penalties.synthetic.html');

  problems = [
    { id: 201, name: 'p_ai', full_name: 'AI_​Assisted', submission_count: 3, best_score: 100, last_score: 40, last_result: 'PP--', last_submission_time: '2026-11-02T10:00:00+07:00', last_submission_id: 7001, has_testcase: true, has_attachment: false, permitted_languages: [{ id: 2, name: 'cpp', ext: 'cpp' }] },
    { id: 204, name: 'p_plain', full_name: 'Plain', submission_count: 0, best_score: null, last_score: null, last_result: null, last_submission_time: null, last_submission_id: null, has_testcase: false, has_attachment: false, permitted_languages: null },
  ];
  languages = [
    { id: 1, name: 'c', pretty_name: 'C', ext: 'c' },
    { id: 2, name: 'cpp', pretty_name: 'C++', ext: 'cpp' },
    { id: 6, name: 'python', pretty_name: 'Python', ext: 'py' },
  ];

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    if (this.networkFailures > 0) {
      this.networkFailures--;
      throw new TypeError('fetch failed');
    }
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = { ...((init.headers ?? {}) as Record<string, string>) };
    let body: unknown = undefined;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    else if (init.body instanceof URLSearchParams) body = Object.fromEntries(init.body);
    this.requests.push({ method, path: url.pathname, headers, body });
    const p = url.pathname;

    if (p.startsWith('/api/v1/')) return this.api(method, p, headers, body as Record<string, unknown>);
    return this.webRoute(method, p, headers, body as Record<string, string>);
  };

  private json(status: number, data: unknown): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  }

  private api(method: string, p: string, headers: Record<string, string>, body: Record<string, unknown>): Response {
    if (method === 'POST' && p === '/api/v1/auth/login') {
      if (this.throttled) return this.json(429, { error: 'Too many failed login attempts; try again later' });
      if (body.password !== this.password) return this.json(401, { error: 'Invalid login or password' });
      const token = `tok${this.nextToken++}`;
      this.validTokens.add(token);
      return this.json(200, { token, expires_at: '2099-01-01T00:00:00Z', user: { id: 4242, login: body.login, full_name: 'Student Name' } });
    }
    const auth = headers['Authorization']?.split(' ').pop();
    if (!auth) return this.json(401, { error: 'Missing authorization token' });
    if (!this.validTokens.has(auth)) return this.json(401, { error: 'Token has expired' });

    if (method === 'GET' && p === '/api/v1/problems') return this.json(200, this.problems);
    if (method === 'GET' && p === '/api/v1/languages') return this.json(200, this.languages);
    let m = /^\/api\/v1\/problems\/(\d+)$/.exec(p);
    if (method === 'GET' && m) {
      const pr = this.problems.find((x) => x.id === Number(m![1]));
      return pr ? this.json(200, { ...pr, full_score: 100, submission_ids: pr.last_submission_id ? [pr.last_submission_id] : [] }) : this.json(404, { error: 'Problem not found' });
    }
    m = /^\/api\/v1\/problems\/(\d+)\/submissions$/.exec(p);
    if (m && method === 'GET') return this.json(200, [{ id: 7001, number: 3, language: 'cpp', submitted_at: '2026-11-02T10:00:00+07:00', points: 40, status: 'done', grader_comment: 'PP--' }]);
    if (m && method === 'POST') {
      if (this.submitError) return this.json(this.submitError.status, this.submitError.body);
      return this.json(201, { id: 8001, number: 4, status: 'submitted' });
    }
    m = /^\/api\/v1\/submissions\/(\d+)$/.exec(p);
    if (m && method === 'GET') {
      const status = this.statusSequence[Math.min(this.statusIndex++, this.statusSequence.length - 1)];
      const graded = status === 'done' || status === 'compilation_error';
      return this.json(200, {
        id: Number(m[1]), problem_id: 201, problem_name: 'p_ai', user_id: 4242, language: 'cpp', source: 'x', source_filename: 'a.cpp',
        submitted_at: '2026-11-02T11:00:00+07:00', number: 4, status,
        points: graded ? (status === 'compilation_error' ? 0 : this.gradedPoints) : null,
        grader_comment: status === 'compilation_error' ? 'Compilation error' : graded ? this.gradedComment : null,
        compiler_message: status === 'compilation_error' ? (this.compilerMessage ?? 'a.cpp:1: error') : null,
        max_runtime: null, peak_memory: null, evaluations: [],
      });
    }
    return this.json(404, { error: 'not found' });
  }

  private webRoute(method: string, p: string, headers: Record<string, string>, form: Record<string, string>): Response {
    const sid = /_cafe_grader_session=([^;]+)/.exec(headers['Cookie'] ?? '')?.[1];
    const loggedIn = sid !== undefined && this.webSessions.has(sid);
    const page = (body: string, setCookie?: string) =>
      new Response(body, { status: 200, headers: setCookie ? { 'content-type': 'text/html', 'set-cookie': setCookie } : { 'content-type': 'text/html' } });
    const redirect = (to: string, setCookie?: string) => {
      const h = new Headers({ location: `https://grader.test${to}` });
      if (setCookie) h.append('set-cookie', setCookie);
      return new Response(null, { status: 302, headers: h });
    };
    const loginHtml = fixture('login_page.synthetic.html').replace(/<div class="alert[\s\S]*?<\/div>/, '');
    if (method === 'GET' && (p === '/' || p === '/main/login')) return loggedIn && p === '/' ? redirect('/main/list') : page(loginHtml);
    if (method === 'POST' && p === '/login/login') {
      if (form.password !== this.password) return redirect('/main/login');
      const s = `w${this.webSessions.size + 1}`;
      this.webSessions.add(s);
      return redirect('/main/list', `_cafe_grader_session=${s}; path=/`);
    }
    if (method === 'GET' && p === '/main/list') return loggedIn ? page(this.listHtml) : redirect('/main/login');
    return new Response('not found', { status: 404 });
  }

  expireTokens(): void {
    this.validTokens.clear();
  }

  count(method: string, path: string | RegExp): number {
    return this.requests.filter((r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path))).length;
  }
}
