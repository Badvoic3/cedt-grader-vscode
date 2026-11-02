/**
 * Request discipline (claude-code-prompt.md, "History and request usage"):
 * request counts are measured at the HTTP level on the fake grader.
 */
import { describe, expect, it } from 'vitest';
import { DataService, HISTORY_TTL_MS, SWITCH_DEBOUNCE_MS } from '../src/data/dataService';
import { GraderClient } from '../src/grader';
import { FakeGrader } from './fakeServer';

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

async function setup(opts: { visible?: boolean } = {}) {
  const server = new FakeGrader();
  let clock = Date.parse('2026-11-02T12:00:00+07:00');
  const waits: number[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const log: string[] = [];
  const client = new GraderClient({
    baseUrl: 'https://grader.test',
    getStoredCredentials: async () => ({ username: 'student', password: 'pw' }),
    fetch: server.fetch,
    now: () => new Date(clock),
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  await client.login({ username: 'student', password: 'pw' });
  server.requests = [];
  const data = new DataService({
    client: () => client,
    canFetch: () => true,
    now: () => clock,
    log: (l) => log.push(l),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => void ((h as { cancelled: boolean }).cancelled = true),
  });
  data.setVisible(opts.visible ?? true);
  /** Run due debounce timers (the latest non-cancelled one). */
  const fireTimers = async () => {
    for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
    await settle();
  };
  const api = (path: string | RegExp) => server.count('GET', path);
  return { server, client, data, waits, timers, fireTimers, api, log, tick: (ms: number) => void (clock += ms) };
}

const HISTORY_201 = '/api/v1/problems/201/submissions';
const HISTORY_204 = '/api/v1/problems/204/submissions';

describe('cache freshness', () => {
  it('history is fresh for 5 minutes, then refetched', async () => {
    const { data, api, tick } = await setup();
    await data.loadHistory(201);
    await data.loadHistory(201);
    expect(api(HISTORY_201)).toBe(1);
    tick(HISTORY_TTL_MS - 1000);
    await data.loadHistory(201);
    expect(api(HISTORY_201)).toBe(1);
    tick(2000);
    await data.loadHistory(201);
    expect(api(HISTORY_201)).toBe(2);
  });

  it('problem list and languages are cached for the session', async () => {
    const { data, api, tick } = await setup();
    await data.loadProblems();
    await data.languages();
    tick(10 * HISTORY_TTL_MS);
    await data.loadProblems();
    await data.languages();
    expect(api('/api/v1/problems')).toBe(1);
    expect(api('/api/v1/languages')).toBe(1);
    await data.loadProblems(true); // the Refresh button
    expect(api('/api/v1/problems')).toBe(2);
  });
});

describe('switching files', () => {
  it(`debounced: ${10} rapid switches → at most 1 fetch, after ${SWITCH_DEBOUNCE_MS} ms`, async () => {
    const { data, api, timers, fireTimers } = await setup();
    for (let i = 0; i < 10; i++) data.focusProblem(i % 2 ? 204 : 201);
    expect(timers.filter((t) => !t.cancelled)).toHaveLength(1);
    expect(timers.find((t) => !t.cancelled)!.ms).toBe(SWITCH_DEBOUNCE_MS);
    expect(api(/\/submissions$/)).toBe(0); // nothing before the debounce fires
    await fireTimers();
    expect(api(/\/submissions$/)).toBe(1);
    expect(api(HISTORY_204)).toBe(1); // the last focused problem
  });

  it('switching back and forth while the cache is fresh makes no requests', async () => {
    const { data, server, fireTimers } = await setup();
    data.focusProblem(201);
    await fireTimers();
    data.focusProblem(204);
    await fireTimers();
    const before = server.requests.length;
    for (let i = 0; i < 20; i++) {
      data.focusProblem(i % 2 ? 201 : 204);
      await fireTimers();
    }
    expect(server.requests.length).toBe(before);
  });

  it('hidden panel: nothing is fetched; pending loads run when it becomes visible', async () => {
    const { data, api, fireTimers } = await setup({ visible: false });
    data.focusProblem(201);
    await fireTimers();
    await data.loadProblems(true);
    await data.loadHistory(201);
    expect(api(/^\/api\/v1\//)).toBe(0);
    data.setVisible(true);
    await settle();
    expect(api('/api/v1/problems')).toBe(1);
    expect(api(HISTORY_201)).toBe(1);
  });
});

describe('in-flight de-duplication', () => {
  it('same key → same promise → one request', async () => {
    const { data, api } = await setup();
    const [a, b, c] = await Promise.all([data.loadHistory(201), data.loadHistory(201), data.loadHistory(201, true)]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(api(HISTORY_201)).toBe(1);
    await Promise.all([data.loadDetail(7001), data.loadDetail(7001)]);
    expect(api('/api/v1/submissions/7001')).toBe(1);
  });
});

describe('submission details', () => {
  it('cached only once final; in-progress details are always refetched', async () => {
    const { data, server, api } = await setup();
    server.statusSequence = ['evaluating', 'evaluating', 'done'];
    await data.loadDetail(8001);
    await data.loadDetail(8001);
    expect(api('/api/v1/submissions/8001')).toBe(2);
    expect(data.detail(8001)).toBeUndefined();
    const d = await data.loadDetail(8001);
    expect(d?.status).toBe('done');
    await data.loadDetail(8001);
    await data.loadDetail(8001);
    expect(api('/api/v1/submissions/8001')).toBe(3); // cached forever from now on
  });

  it('recordDetail keeps the final poll response without another request', async () => {
    const { data, client, api } = await setup();
    const final = await client.getSubmission(8001);
    data.recordDetail(final);
    await data.loadDetail(8001);
    expect(api('/api/v1/submissions/8001')).toBe(1);
  });
});

describe('after a submit', () => {
  it('refreshes that problem history and the problem list once (API only, no /main/list)', async () => {
    const { data, server, api } = await setup();
    await data.loadProblems();
    await data.loadHistory(201);
    await data.loadHistory(204);
    server.requests = [];
    await data.afterSubmit(201);
    expect(api(HISTORY_201)).toBe(1);
    expect(api(HISTORY_204)).toBe(0); // no other problems
    expect(api('/api/v1/problems')).toBe(1);
    expect(api('/main/list')).toBe(0);
    expect(data.problemList()!.problems.find((p) => p.id === 201)!.list).toMatchObject({ cost: 10 }); // penalties kept
    // And it is fresh again afterwards.
    await data.loadHistory(201);
    await data.loadProblems();
    expect(server.requests.length).toBe(2);
  });
});

describe('errors', () => {
  it('offline: cached history is kept and flagged "may be out of date"', async () => {
    const { data, server } = await setup();
    const first = await data.loadHistory(201);
    server.networkFailures = 1;
    const again = await data.loadHistory(201, true);
    expect(again).toEqual(first);
    expect(data.historyState(201)).toEqual({ loading: false, stale: true, error: null });
  });

  it('429 / 5xx: GETs are retried with back-off (2 s, 4 s), then served', async () => {
    const { data, server, waits, api } = await setup();
    server.httpErrors = [429, 503];
    const h = await data.loadHistory(201);
    expect(h).toHaveLength(1);
    expect(waits).toEqual([2000, 4000]);
    expect(api(HISTORY_201)).toBe(3);
  });

  it('429 persisting: cached data shown as stale, no endless retries', async () => {
    const { data, server, api } = await setup();
    await data.loadHistory(201);
    server.httpErrors = [429, 429, 429, 429];
    await data.loadHistory(201, true);
    expect(api(HISTORY_201)).toBe(4); // 1 + 3 attempts
    expect(data.historyState(201).stale).toBe(true);
  });

  it('debug log shows hits and misses, never tokens', async () => {
    const { data, log } = await setup();
    await data.loadHistory(201);
    await data.loadHistory(201);
    expect(log.some((l) => l.startsWith('cache miss history:201'))).toBe(true);
    expect(log.some((l) => l.startsWith('cache hit  history:201'))).toBe(true);
    expect(log.join('\n')).not.toMatch(/tok\d|Bearer|pw/);
  });
});

describe('saved data from an older version', () => {
  it('a persisted problem list without `tags` / `topics` is normalized, not crashed on', async () => {
    const old = {
      at: 1,
      list: {
        listStatus: 'loaded',
        problems: [
          { id: 1360, name: '00_Intro_11', fullName: 'Hello', bestScore: 100, lastScore: 100, lastResult: 'P', lastSubmissionId: 1, lastSubmissionTime: null, submissionCount: 1, hasTestcase: false, hasAttachment: false, permittedLanguageIds: null, list: null },
          { id: 1361 }, // even more incomplete
          null,
        ],
      },
    };
    const data = new DataService({ client: () => { throw new Error('no network expected'); }, canFetch: () => false, persist: { load: () => old as never, save: () => {} } });
    const list = data.problemList()!;
    expect(list.topics).toBeNull();
    expect(list.problems.map((p) => p.id)).toEqual([1360, 1361]);
    for (const p of list.problems) {
      expect(p.tags).toEqual([]);
      expect(p.list).toBeNull();
    }
    expect(list.problems[1]).toMatchObject({ name: '#1361', submissionCount: 0, permittedLanguageIds: null });
    expect(data.cache.isFresh('problems', { kind: 'session' })).toBe(false); // still refetched this session
  });

  it('unreadable saved data is ignored', () => {
    const data = new DataService({ client: () => { throw new Error('x'); }, canFetch: () => false, persist: { load: () => { throw new Error('corrupt'); }, save: () => {} } });
    expect(data.problemList()).toBeUndefined();
    const data2 = new DataService({ client: () => { throw new Error('x'); }, canFetch: () => false, persist: { load: () => ({ at: 1, list: { problems: 'nope' } }) as never, save: () => {} } });
    expect(data2.problemList()).toBeUndefined();
  });
});
