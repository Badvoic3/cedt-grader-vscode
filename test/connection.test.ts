import { describe, expect, it } from 'vitest';
import {
  AuthError,
  classifyConnectionError,
  describeSubmitFailure,
  GraderClient,
  LanguageNotAllowedError,
  networkErrorFrom,
  ServerBusyError,
  SessionExpiredError,
} from '../src/grader';
import { FakeGrader } from './fakeServer';

/** What Node's fetch (undici) rejects with. */
const fetchFailed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

describe('classifyConnectionError: each error type → its banner message', () => {
  const cases: [string, unknown, string, string, 'retry' | 'login'][] = [
    ['no internet (DNS)', networkErrorFrom(fetchFailed('ENOTFOUND'), 'h'), 'offline', 'No internet connection', 'retry'],
    ['network down', networkErrorFrom(fetchFailed('ENETUNREACH'), 'h'), 'offline', 'No internet connection', 'retry'],
    ['server unreachable', networkErrorFrom(fetchFailed('ECONNREFUSED'), 'h'), 'unreachable', 'Cannot reach the grader', 'retry'],
    ['connection reset', networkErrorFrom(fetchFailed('ECONNRESET'), 'h'), 'unreachable', 'Cannot reach the grader', 'retry'],
    ['timeout', networkErrorFrom(timeout(), 'h'), 'timeout', 'The grader is not responding', 'retry'],
    ['server error 5xx', new ServerBusyError('HTTP 503', 503), 'server', 'Grader server error', 'retry'],
    ['rate limited 429', new ServerBusyError('HTTP 429', 429), 'throttled', 'Too many requests', 'retry'],
    ['too many login attempts', new AuthError('Too many failed login attempts.', 'throttled'), 'throttled', 'Too many login attempts', 'retry'],
    ['session expired, re-login impossible', new SessionExpiredError('expired', false), 'session', 'Session expired', 'login'],
    ['session expired, re-login failed', new AuthError('Wrong username or password.', 'wrong-password'), 'session', 'Session expired', 'login'],
  ];
  for (const [name, err, kind, title, action] of cases) {
    it(name, () => {
      expect(classifyConnectionError(err)).toMatchObject({ kind, title, action });
    });
  }

  it('non-connection errors are not banner material', () => {
    expect(classifyConnectionError(new LanguageNotAllowedError('nope'))).toBeNull();
    expect(classifyConnectionError(new Error('boom'))).toBeNull();
  });
});

describe('through the real client', () => {
  async function client() {
    const server = new FakeGrader();
    const c = new GraderClient({ baseUrl: 'https://grader.test', fetch: server.fetch, getStoredCredentials: async () => ({ username: 's', password: 'pw' }), sleep: async () => {} });
    await c.login({ username: 's', password: 'pw' });
    return { server, c };
  }

  it('DNS failure → offline; refused → unreachable; timeout → timeout; 5xx → server', async () => {
    const { server, c } = await client();
    for (const [rej, kind] of [[fetchFailed('ENOTFOUND'), 'offline'], [fetchFailed('ECONNREFUSED'), 'unreachable'], [timeout(), 'timeout']] as const) {
      server.rejectWith = rej;
      const err = await c.listSubmissions(201).catch((e) => e);
      expect(classifyConnectionError(err)?.kind).toBe(kind);
    }
    server.httpErrors = [500, 500, 500];
    const err = await c.listSubmissions(201).catch((e) => e);
    expect(classifyConnectionError(err)?.kind).toBe('server');
  });

  it('polling gives up after 2 consecutive network errors (no retry loop while offline)', async () => {
    const { server, c } = await client();
    server.networkFailures = 3;
    const err = await c.pollSubmission(8001).catch((e) => e);
    expect(classifyConnectionError(err)?.kind).toBe('unreachable');
    expect(server.count('GET', '/api/v1/submissions/8001')).toBe(0); // the 3 attempts never reached the server
  });
});

describe('describeSubmitFailure', () => {
  const offline = networkErrorFrom(fetchFailed('ENOTFOUND'), 'h');
  it('before reaching the server: nothing was submitted', () => {
    expect(describeSubmitFailure(offline, null)).toBe('Nothing was submitted: no internet connection.');
    expect(describeSubmitFailure(networkErrorFrom(fetchFailed('ECONNREFUSED'), 'h'), null)).toBe('Nothing was submitted: cannot reach the grader.');
    expect(describeSubmitFailure(new SessionExpiredError('x', false), null)).toMatch(/^Nothing was submitted: your login expired/);
  });
  it('ambiguous cases say so', () => {
    expect(describeSubmitFailure(networkErrorFrom(timeout(), 'h'), null)).toMatch(/may or may not have been received/);
    expect(describeSubmitFailure(new ServerBusyError('x', 502), null)).toMatch(/server error\. Nothing was submitted \(check History/);
  });
  it('after the submission was sent: results will load later', () => {
    expect(describeSubmitFailure(offline, 8001)).toBe('Your submission #8001 was sent. Results will load when the connection is back.');
  });
  it('other errors are not rewritten', () => {
    expect(describeSubmitFailure(new LanguageNotAllowedError('x'), null)).toBeNull();
  });
});
