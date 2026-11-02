import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthError,
  GraderClient,
  LanguageNotAllowedError,
  PollTimeoutError,
  SessionExpiredError,
  type StoredToken,
  SubmitRejectedError,
} from '../src/grader';
import { FakeGrader } from './fakeServer';

function setup(opts: { stored?: boolean; password?: string } = {}) {
  const server = new FakeGrader();
  let clock = Date.parse('2026-11-02T12:00:00+07:00');
  const waits: number[] = [];
  const logs: string[] = [];
  let saved: StoredToken | undefined;
  const creds = { username: 'student', password: opts.password ?? 'pw' };
  const client = new GraderClient({
    baseUrl: 'https://grader.test',
    getStoredCredentials: async () => (opts.stored === false ? undefined : creds),
    tokenStore: { load: async () => saved, save: async (t) => void (saved = t) },
    fetch: server.fetch,
    log: (l) => logs.push(l),
    now: () => new Date(clock),
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  lastServer = server;
  return { server, client, waits, logs, creds, saved: () => saved };
}

let lastServer: FakeGrader | null = null;
afterEach(() => {
  // Invariants for every test: never touch /contests, never set a User-Agent.
  for (const r of lastServer?.requests ?? []) {
    expect(r.path.startsWith('/contests')).toBe(false);
    expect(Object.keys(r.headers).map((k) => k.toLowerCase())).not.toContain('user-agent');
  }
  lastServer = null;
});

describe('login', () => {
  it('API login with JSON body, bearer token afterwards, web login for /main/list', async () => {
    const { server, client, creds, saved } = setup();
    const user = await client.login(creds);
    expect(user).toEqual({ id: 4242, login: 'student', fullName: 'Student Name' });
    expect(server.requests[0]).toMatchObject({ method: 'POST', path: '/api/v1/auth/login', body: { login: 'student', password: 'pw' } });
    expect(saved()).toEqual({ token: 'tok1', expiresAt: '2099-01-01T00:00:00.000Z' });
    await client.listProblems();
    const r = server.requests.find((x) => x.path === '/api/v1/problems')!;
    expect(r.headers['Authorization']).toBe('Bearer tok1');
    expect(server.count('POST', '/login/login')).toBe(1); // web login once, at login time
  });

  it('wrong password → AuthError, exactly one attempt', async () => {
    const { server, client } = setup();
    await expect(client.login({ username: 'student', password: 'nope' })).rejects.toMatchObject({ reason: 'wrong-password' });
    expect(server.count('POST', '/api/v1/auth/login')).toBe(1);
  });

  it('throttled → AuthError(throttled), not retried', async () => {
    const { server, client, creds } = setup();
    server.throttled = true;
    await expect(client.login(creds)).rejects.toMatchObject({ reason: 'throttled' });
    expect(server.count('POST', '/api/v1/auth/login')).toBe(1);
  });

  it('restores a stored, unexpired token without network', async () => {
    const { server, client, creds } = setup();
    await client.login(creds);
    const before = server.requests.length;
    const again = new GraderClient({ baseUrl: 'https://grader.test', fetch: server.fetch, tokenStore: { load: async () => ({ token: 'tok1', expiresAt: '2099-01-01T00:00:00Z' }), save: async () => {} } });
    expect(await again.restore()).toBe(true);
    expect(again.isLoggedIn).toBe(true);
    expect(server.requests.length).toBe(before);
  });

  it('logs never contain the password or token', async () => {
    const { client, logs, creds } = setup();
    await client.login(creds);
    await client.listProblems();
    expect(logs.join('\n')).not.toMatch(/\bpw\b|tok1|Bearer/);
  });

  it('logout clears the stored token', async () => {
    const { client, creds, saved } = setup();
    await client.login(creds);
    await client.logout();
    expect(saved()).toBeUndefined();
    expect(client.isLoggedIn).toBe(false);
  });
});

describe('token expiry', () => {
  it('401 → silent re-login with the stored password, retried once', async () => {
    const { server, client, creds } = setup();
    await client.login(creds);
    server.expireTokens();
    const { problems } = await client.listProblems();
    expect(problems).toHaveLength(2);
    expect(server.count('POST', '/api/v1/auth/login')).toBe(2);
  });

  it('401 without a stored password → SessionExpiredError (show the login form)', async () => {
    const { server, client, creds } = setup({ stored: false });
    await client.login(creds);
    server.expireTokens();
    await expect(client.getProblem(201)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(server.count('POST', '/api/v1/auth/login')).toBe(1);
  });

  it('stored password now wrong → one failed login, no loop', async () => {
    const { server, client } = setup({ password: 'old' });
    server.password = 'old';
    await client.login();
    server.password = 'new';
    server.expireTokens();
    await expect(client.getProblem(201)).rejects.toBeInstanceOf(AuthError);
    expect(server.count('POST', '/api/v1/auth/login')).toBe(2);
  });
});

describe('problems and scores', () => {
  it('merges API problems with /main/list penalties', async () => {
    const { client, creds } = setup();
    await client.login(creds);
    const { problems, listStatus } = await client.listProblems();
    expect(listStatus).toBe('loaded');
    expect(problems[0]).toMatchObject({ id: 201, fullName: 'AI_Assisted', bestScore: 100, lastScore: 40, permittedLanguageIds: [2], list: { cost: 10, aiCount: 2 } });
    expect(problems[1]).toMatchObject({ id: 204, permittedLanguageIds: null, list: { cost: 0 } });
  });

  it('without a web session and no stored password: API data only', async () => {
    const { server, client, creds } = setup({ stored: false });
    server.listHtml = '';
    await client.login(creds);
    server.webSessions.clear();
    const { problems, listStatus } = await client.listProblems();
    expect(listStatus).toBe('no-web-session');
    expect(problems[0].list).toBeNull();
  });

  it('languages: pretty names, per-problem filtering, null = all', async () => {
    const { client, creds } = setup();
    await client.login(creds);
    expect((await client.languagesFor({ permittedLanguageIds: [2] })).map((l) => l.name)).toEqual(['C++']);
    expect(await client.languagesFor({ permittedLanguageIds: null })).toHaveLength(3);
  });

  it('isContestPage comes from the list page fetched at login (no extra request)', async () => {
    const { server, client, creds } = setup();
    await client.login(creds);
    const n = server.requests.length;
    expect(client.contestPage).toBe(false);
    expect(server.requests.length).toBe(n);
  });
});

describe('submit and poll', () => {
  it('POSTs JSON {language_id, source, filename}', async () => {
    const { server, client, creds } = setup();
    await client.login(creds);
    expect(await client.submit(201, 2, 'int main(){}', 'a.cpp')).toEqual({ id: 8001, number: 4 });
    expect(server.requests.at(-1)).toMatchObject({ method: 'POST', path: '/api/v1/problems/201/submissions', body: { language_id: 2, source: 'int main(){}', filename: 'a.cpp' } });
  });

  it('422 with permitted_languages → LanguageNotAllowedError', async () => {
    const { server, client, creds } = setup();
    await client.login(creds);
    server.submitError = { status: 422, body: { error: "Language 'python' is not permitted", permitted_languages: [{ id: 2, name: 'cpp' }] } };
    await expect(client.submit(201, 6, 'x', 'a.py')).rejects.toBeInstanceOf(LanguageNotAllowedError);
    server.submitError = { status: 403, body: { error: 'You are not allowed to submit to this problem' } };
    await expect(client.submit(201, 2, 'x', 'a.cpp')).rejects.toBeInstanceOf(SubmitRejectedError);
  });

  it('empty file is refused locally', async () => {
    const { client, creds } = setup();
    await client.login(creds);
    await expect(client.submit(201, 2, '  \n', 'a.cpp')).rejects.toThrow(/empty/);
  });

  it('polls by submission id until graded, every interval', async () => {
    const { server, client, waits, creds } = setup();
    await client.login(creds);
    server.statusSequence = ['submitted', 'evaluating', 'done'];
    const seen: string[] = [];
    const s = await client.pollSubmission(8001, { intervalMs: 5000, onUpdate: (u) => seen.push(u.status) });
    expect(seen).toEqual(['submitted', 'evaluating', 'done']);
    expect(waits).toEqual([5000, 5000]);
    expect(s).toMatchObject({ state: 'graded', points: 70, number: 4, compileError: false });
    expect(s.verdicts.map((v) => v.kind)).toEqual(['correct', 'correct', 'wrong', 'time_limit']);
  });

  it('never faster than 3 s', async () => {
    const { server, client, waits, creds } = setup();
    await client.login(creds);
    server.statusSequence = ['submitted', 'done'];
    await client.pollSubmission(8001, { intervalMs: 100 });
    expect(waits).toEqual([3000]);
  });

  it('compile error carries the compiler message', async () => {
    const { server, client, creds } = setup();
    await client.login(creds);
    server.statusSequence = ['compilation_error'];
    server.compilerMessage = "a.cpp:5: error: 'cout' was not declared";
    const s = await client.pollSubmission(8001);
    expect(s).toMatchObject({ compileError: true, points: 0, verdicts: [], compilerMessage: "a.cpp:5: error: 'cout' was not declared" });
  });

  it('times out after 3 minutes', async () => {
    const { server, client, creds } = setup();
    await client.login(creds);
    server.statusSequence = ['evaluating'];
    await expect(client.pollSubmission(8001, { intervalMs: 5000 })).rejects.toBeInstanceOf(PollTimeoutError);
    expect(server.statusIndex).toBeGreaterThanOrEqual(35);
    expect(server.statusIndex).toBeLessThanOrEqual(37);
  });

  it('backs off ×2 on network errors', async () => {
    const { server, client, waits, creds } = setup();
    await client.login(creds);
    server.networkFailures = 2;
    await client.pollSubmission(8001, { intervalMs: 5000 });
    expect(waits).toEqual([10000, 20000]);
  });

  it('history from /api/v1/problems/{id}/submissions', async () => {
    const { client, creds } = setup();
    await client.login(creds);
    expect(await client.listSubmissions(201)).toEqual([
      { id: 7001, number: 3, language: 'cpp', submittedAt: '2026-11-02T10:00:00+07:00', points: 40, status: 'done', comment: 'PP--' },
    ]);
  });
});
