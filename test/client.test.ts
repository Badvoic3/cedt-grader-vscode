import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthError,
  GraderClient,
  LanguageNotAllowedError,
  PollTimeoutError,
  SessionExpiredError,
  SubmitRejectedError,
} from '../src/grader';
import { FakeGrader } from './fakeServer';
import { DURING_CONTEST, fixture } from './helpers';

function setup(opts: { now?: Date; password?: string } = {}) {
  const server = new FakeGrader();
  let clock = (opts.now ?? DURING_CONTEST).getTime();
  const waits: number[] = [];
  const logs: string[] = [];
  const client = new GraderClient({
    baseUrl: 'https://grader.test',
    getCredentials: async () => ({ username: 'student', password: opts.password ?? 'pw' }),
    fetch: server.fetch,
    log: (l) => logs.push(l),
    now: () => new Date(clock),
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  return { server, client, waits, logs };
}

let lastServer: FakeGrader | null = null;
afterEach(() => {
  // Global invariants for every test: never touch /contests, never set a UA.
  if (!lastServer) return;
  for (const r of lastServer.requests) {
    expect(r.path.startsWith('/contests')).toBe(false);
    expect(Object.keys(r.headers).map((k) => k.toLowerCase())).not.toContain('user-agent');
  }
  lastServer = null;
});
function track<T extends { server: FakeGrader }>(x: T): T {
  lastServer = x.server;
  return x;
}

describe('login', () => {
  it('logs in with CSRF token, keeps cookies, finds user id', async () => {
    const { server, client } = track(setup());
    await client.login();
    expect(client.isLoggedIn).toBe(true);
    expect(client.userId).toBe(12345);
    const post = server.requests.find((r) => r.path === '/login/login')!;
    expect(post.form).toEqual({ authenticity_token: 'REDACTED', login: 'student', password: 'pw', commit: 'Login' });
    // The uuid cookie set on GET / was sent with the login POST.
    expect(post.headers['Cookie']).toContain('uuid=device-1');
  });

  it('wrong password → AuthError, no automatic retry', async () => {
    const { server, client } = track(setup({ password: 'wrong' }));
    await expect(client.login()).rejects.toMatchObject({ reason: 'wrong-password' });
    expect(server.count('POST', '/login/login')).toBe(1);
  });

  it('agreement checkbox → refuses and does not tick it', async () => {
    const { server, client } = track(setup());
    server.loginHtml = server.loginHtml.replace('<input type="submit"', '<input type="checkbox" name="accept_agree" value="1" /><input type="submit"');
    await expect(client.login()).rejects.toBeInstanceOf(AuthError);
    expect(server.count('POST', '/login/login')).toBe(0);
  });

  it('logs never contain password, token or cookies', async () => {
    const { client, logs } = track(setup());
    await client.login();
    await client.listProblems();
    const all = logs.join('\n');
    expect(all).not.toMatch(/pw|REDACTED|uuid|session=/);
    expect(logs[0]).toMatch(/^GET \/ → 200$/);
  });
});

describe('session expiry', () => {
  it('re-logs in once and retries', async () => {
    const { server, client } = track(setup());
    await client.login();
    server.expireAllSessions();
    const problems = await client.listProblems();
    expect(problems).toHaveLength(3);
    expect(server.count('POST', '/login/login')).toBe(2);
  });

  it('does not re-login for "two different places"', async () => {
    const { server, client } = track(setup());
    await client.login();
    server.expireAllSessions('You cannot login from two different places');
    const err = await client.listProblems().catch((e) => e);
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('two different places');
    expect(server.count('POST', '/login/login')).toBe(1);
  });

  it('logs in lazily when not logged in yet', async () => {
    const { server, client } = track(setup());
    await client.listProblems();
    expect(server.count('POST', '/login/login')).toBe(1);
  });
});

describe('submit', () => {
  it('submits with a fresh token and reads id + poll URL', async () => {
    const { server, client } = track(setup());
    const r = await client.submit(102, 2, 'int main(){}');
    expect(r.submissionId).toBe(5003);
    expect(r.pollUrl).toBe('/submissions/get_latest_submission_status/12345/102');
    const post = server.requests.find((x) => x.path === '/main/submit')!;
    expect(post.form).toEqual({
      authenticity_token: 'REDACTED',
      'submission[problem_id]': '102',
      language_id: '2',
      editor_text: 'int main(){}',
      commit: 'Submit',
    });
    // The submit page was fetched right before the POST (fresh CSRF token).
    const i = server.requests.findIndex((x) => x.path === '/main/submit');
    expect(server.requests[i - 1].path).toBe('/submissions/direct_edit_problem/102');
  });

  it('rejects a language not in the per-problem list without POSTing', async () => {
    const { server, client } = track(setup());
    await expect(client.submit(102, 99, 'x')).rejects.toBeInstanceOf(LanguageNotAllowedError);
    expect(server.count('POST', '/main/submit')).toBe(0);
  });

  it('maps the server flash after a rejected submit', async () => {
    const { server, client } = track(setup());
    server.submitRedirect = '/main/list';
    server.submitFlash = 'The selected language is not permitted for this problem.';
    await expect(client.submit(102, 2, 'x')).rejects.toBeInstanceOf(LanguageNotAllowedError);
    server.submitFlash = 'Problem p01 is currently not available for you';
    await expect(client.submit(102, 2, 'x')).rejects.toThrow(/not available/);
  });

  it('re-logs in and resubmits once when the session expired before the POST', async () => {
    const { server, client } = track(setup());
    await client.login();
    server.expireAllSessions();
    const r = await client.submit(102, 2, 'x');
    expect(r.submissionId).toBe(5003);
    expect(server.count('POST', '/main/submit')).toBe(1);
  });

  it('refuses an empty file', async () => {
    const { client } = track(setup());
    await expect(client.submit(102, 2, '  \n')).rejects.toBeInstanceOf(SubmitRejectedError);
  });
});

describe('pollLatest', () => {
  const pending = fixture('latest_status_pending.synthetic.html');
  const graded = fixture('latest_status_graded.synthetic.html');

  it('polls every interval until graded', async () => {
    const { server, client, waits } = track(setup());
    await client.login();
    server.pollSequence = [pending, pending, graded];
    const updates: string[] = [];
    const s = await client.pollLatest(102, {
      submissionId: 5003,
      pollUrl: '/submissions/get_latest_submission_status/12345/102',
      intervalMs: 5000,
      onUpdate: (u) => updates.push(u.state),
    });
    expect(s.score).toBe(70);
    expect(updates).toEqual(['pending', 'pending', 'graded']);
    expect(waits).toEqual([5000, 5000]);
  });

  it('never polls faster than 3 s', async () => {
    const { server, client, waits } = track(setup());
    await client.login();
    server.pollSequence = [pending, graded];
    await client.pollLatest(102, { intervalMs: 500 });
    expect(waits).toEqual([3000]);
  });

  it('ignores an older graded submission', async () => {
    const { server, client } = track(setup());
    await client.login();
    server.pollSequence = [graded.replaceAll('5003', '4000'), graded];
    const s = await client.pollLatest(102, { submissionId: 5003 });
    expect(s.id).toBe(5003);
    expect(server.pollIndex).toBe(2);
  });

  it('times out after 3 minutes', async () => {
    const { server, client } = track(setup());
    await client.login();
    server.pollSequence = [pending];
    await expect(client.pollLatest(102, { intervalMs: 5000 })).rejects.toBeInstanceOf(PollTimeoutError);
    expect(server.pollIndex).toBeLessThanOrEqual(37);
    expect(server.pollIndex).toBeGreaterThanOrEqual(35);
  });

  it('backs off on network errors', async () => {
    const { server, client, waits } = track(setup());
    await client.login();
    server.pollSequence = [graded];
    server.networkFailures = 2;
    await client.pollLatest(102, { intervalMs: 5000 });
    expect(waits).toEqual([10000, 20000]);
  });

  it('builds the poll URL from the discovered user id', async () => {
    const { server, client } = track(setup());
    await client.login();
    await client.pollLatest(102);
    expect(server.requests.at(-1)!.path).toBe('/submissions/get_latest_submission_status/12345/102');
    expect(server.requests.at(-1)!.headers['Accept']).toContain('text/vnd.turbo-stream.html');
  });
});

describe('compiler message', () => {
  it('POSTs with X-CSRF-Token and turbo Accept', async () => {
    const { server, client } = track(setup());
    const msg = await client.getCompilerMessage(5004);
    expect(msg).toContain('was not declared');
    const r = server.requests.find((x) => x.path === '/submissions/5004/compiler_msg')!;
    expect(r.method).toBe('POST');
    expect(r.headers['Accept']).toBe('text/vnd.turbo-stream.html');
  });
});
