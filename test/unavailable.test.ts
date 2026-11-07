import { describe, expect, it } from 'vitest';
import { DataService } from '../src/data/dataService';
import { GraderClient, ProblemUnavailableError, SubmitRejectedError } from '../src/grader';
import { parseMappingFile } from '../src/migration/oldLinks';
import { FakeGrader } from './fakeServer';

async function setup() {
  const server = new FakeGrader();
  const client = new GraderClient({ baseUrl: 'https://grader.test', fetch: server.fetch, getStoredCredentials: async () => ({ username: 's', password: 'pw' }), sleep: async () => {} });
  await client.login({ username: 's', password: 'pw' });
  return { server, client };
}

describe('problem no longer available on the grader', () => {
  it('404 → ProblemUnavailableError (problem, history, submit)', async () => {
    const { server, client } = await setup();
    server.unavailable.set(201, 404);
    await expect(client.listSubmissions(201)).rejects.toMatchObject({ status: 404 });
    await expect(client.listSubmissions(201)).rejects.toBeInstanceOf(ProblemUnavailableError);
    await expect(client.submit(201, 2, 'x', 'a.cpp')).rejects.toBeInstanceOf(ProblemUnavailableError);
  });

  it('403 → ProblemUnavailableError too (closed to you)', async () => {
    const { server, client } = await setup();
    server.unavailable.set(201, 403);
    await expect(client.listSubmissions(201)).rejects.toMatchObject({ status: 403 });
    await expect(client.submit(201, 2, 'x', 'a.cpp')).rejects.toBeInstanceOf(ProblemUnavailableError);
  });

  it('other 403 / 422 answers stay what they were', async () => {
    const { server, client } = await setup();
    server.submitError = { status: 422, body: { errors: ['code too long'] } };
    await expect(client.submit(201, 2, 'x', 'a.cpp')).rejects.toBeInstanceOf(SubmitRejectedError);
  });

  it('history keeps the cached list and reports the problem as unavailable (no banner, no crash)', async () => {
    const { server, client } = await setup();
    const data = new DataService({ client: () => client, canFetch: () => true, setTimer: () => 0, clearTimer: () => {} });
    data.setVisible(true);
    const errors: [string, unknown][] = [];
    data.onError = (e, key) => errors.push([key, e]);
    const first = await data.loadHistory(201);
    server.unavailable.set(201, 404);
    const again = await data.loadHistory(201, true);
    expect(again).toEqual(first); // cached data still shown
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe('history:201');
    expect(errors[0][1]).toBeInstanceOf(ProblemUnavailableError);
    expect(data.historyState(201)).toMatchObject({ stale: true, loading: false });
  });
});

describe('duplicate links in .cedt-grader.json', () => {
  it('duplicate keys and keys that are the same path become one entry', () => {
    const text = `{"version":1,"files":{
      "a.cpp": {"problemId":1,"name":"x"},
      "./a.cpp": {"problemId":2,"name":"y"},
      "b\\\\c.cpp": {"problemId":3,"name":"z"},
      "b/c.cpp": {"problemId":3,"name":"z"},
      "d.cpp": {"problemId":4,"name":"w"},
      "d.cpp": {"problemId":5,"name":"v"}
    }}`;
    const cleaned = parseMappingFile(text);
    expect(Object.keys(cleaned.files).sort()).toEqual(['a.cpp', 'b/c.cpp', 'd.cpp']);
  });
});
