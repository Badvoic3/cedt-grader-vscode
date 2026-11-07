import { describe, expect, it, vi } from 'vitest';
import { DataService } from '../src/data/dataService';
import { GraderClient } from '../src/grader';
import { parseProblemLimits } from '../src/grader/providers/cafeGrader/parsers';
import { FakeGrader } from './fakeServer';

describe('parseProblemLimits', () => {
  it('reads the line of the live page, whatever the spacing', () => {
    expect(parseProblemLimits('<em>Limit: 10.0 s , 512 MB</em>')).toEqual({ timeMs: 10_000, memoryMB: 512 });
    expect(parseProblemLimits('<em>\nLimit:\n1.5\n<span>s</span>,\n<span>256</span>\n<span>MB</span></em>')).toEqual({ timeMs: 1500, memoryMB: 256 });
    expect(parseProblemLimits('<em>Limit: 2 s, 64 MB</em>')).toEqual({ timeMs: 2000, memoryMB: 64 });
  });
  it('a statement that mentions a limit is not taken for it', () => {
    expect(parseProblemLimits('<p>Limit: 1 s, 2 MB</p><em>other</em>')).toBeNull();
    expect(parseProblemLimits('<em>see below</em><em>Limit: 3 s, 8 MB</em>')).toEqual({ timeMs: 3000, memoryMB: 8 });
  });
  it.each(['', '<em>Limit: s, MB</em>', '<em>Limit: 0 s, 0 MB</em>', '<em>Limit: 1 s</em>', '<html>a page with no limits</html>'])('no usable line: %j', (html) => {
    expect(parseProblemLimits(html)).toBeNull();
  });
});

async function setup(stored = true) {
  const server = new FakeGrader();
  const client = new GraderClient({
    baseUrl: 'https://grader.test',
    getStoredCredentials: async () => (stored ? { username: 'student', password: 'pw' } : undefined),
    fetch: server.fetch,
    sleep: async () => {},
  });
  await client.login({ username: 'student', password: 'pw' });
  return { server, client };
}

describe('GraderClient.problemLimits', () => {
  it('reads the problem page through the web session', async () => {
    const { server, client } = await setup();
    expect(await client.problemLimits(201)).toEqual({ timeMs: 1500, memoryMB: 256 });
    expect(server.problemPageHits).toBe(1);
  });
  it('a page without the line is null (a viva exam redirects to the list)', async () => {
    const { server, client } = await setup();
    server.problemPage = () => '<html>the list</html>';
    expect(await client.problemLimits(201)).toBeNull();
  });
  it('rejects an id that is no id', async () => {
    const { client } = await setup();
    await expect(client.problemLimits(-1)).rejects.toThrow();
  });
});

describe('DataService.limits', () => {
  const make = (client: GraderClient, canFetch = true) => {
    const log = vi.fn();
    const data = new DataService({ client: () => client, canFetch: () => canFetch, log, describe: String });
    return { data, log };
  };

  it('one request per problem per session, shared while in flight', async () => {
    const { server, client } = await setup();
    const { data } = make(client);
    const [a, b] = await Promise.all([data.limits(201), data.limits(201)]);
    expect(a).toEqual({ timeMs: 1500, memoryMB: 256 });
    expect(b).toBe(a);
    await data.limits(201);
    expect(server.problemPageHits).toBe(1);
    await data.limits(202);
    expect(server.problemPageHits).toBe(2);
  });

  it('a failure is no limits and no second request: no banner, no retry loop', async () => {
    const { client } = await setup();
    const spy = vi.spyOn(client, 'problemLimits').mockRejectedValue(new Error('offline'));
    const { data } = make(client);
    expect(await data.limits(201)).toBeNull();
    expect(await data.limits(201)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('asks nothing when logged out', async () => {
    const { server, client } = await setup();
    const { data } = make(client, false);
    expect(await data.limits(201)).toBeNull();
    expect(server.problemPageHits).toBe(0);
  });

  it('a new session asks again', async () => {
    const { server, client } = await setup();
    const { data } = make(client);
    await data.limits(201);
    data.clear();
    await data.limits(201);
    expect(server.problemPageHits).toBe(2);
  });
});
