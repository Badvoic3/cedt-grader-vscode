import { describe, expect, it } from 'vitest';
import { checkGraderServer } from '../src/grader';
import type { FetchLike } from '../src/grader';
import { FakeGrader } from './fakeServer';

const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const html = (status: number, text = '<html>') => new Response(text, { status, headers: { 'content-type': 'text/html' } });

function serving(...answers: (Response | Error)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const a = answers.shift() ?? new Error('no more answers');
    if (a instanceof Error) throw a;
    return a;
  };
  return { fetch, calls };
}
const check = (s: { fetch: FetchLike }, url = 'https://g.example') => checkGraderServer(url, { fetch: s.fetch }).then((r) => r.status);

describe('checkGraderServer', () => {
  it('the fake cafe-grader passes, and gets no credentials', async () => {
    const server = new FakeGrader();
    expect((await checkGraderServer('https://grader.test', { fetch: server.fetch })).status).toBe('compatible');
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({ method: 'GET', path: '/api/v1/languages' });
    expect(server.requests[0].headers?.Authorization).toBeUndefined();
  });

  it('401 with the token error is compatible; one anonymous GET, no body', async () => {
    const s = serving(json(401, { error: 'Missing authorization token' }));
    expect(await check(s)).toBe('compatible');
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].url).toBe('https://g.example/api/v1/languages');
    expect(s.calls[0].init?.method).toBe('GET');
    expect(s.calls[0].init?.body).toBeUndefined();
    expect((s.calls[0].init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('a language list is compatible', async () => {
    expect(await check(serving(json(200, [{ id: 1, name: 'c', pretty_name: 'C', ext: 'c' }])))).toBe('compatible');
  });

  it.each([
    ['a web page', () => html(200)],
    ['a 404 page', () => html(404)],
    ['a login page with 401', () => html(401)],
    ['401 JSON about something else', () => json(401, { error: 'Unauthorized' })],
    ['401 with no error', () => json(401, {})],
    ['401 JSON null', () => json(401, null)],
    ['other JSON', () => json(200, { ok: true })],
    ['a list of something else', () => json(200, [{ id: 'a' }])],
    ['broken JSON', () => new Response('{', { status: 401, headers: { 'content-type': 'application/json' } })],
    ['a forbidden answer', () => json(403, { error: 'token' })],
  ])('%s is incompatible', async (_, answer) => {
    expect(await check(serving(answer()))).toBe('incompatible');
  });

  it('a body too large to be this answer is incompatible', async () => {
    expect(await check(serving(html(200, 'x'.repeat(2 * 1024 * 1024))))).toBe('incompatible');
  });

  it.each([
    ['no connection', () => new TypeError('fetch failed')],
    ['503', () => html(503)],
    ['500', () => json(500, { error: 'token' })],
    ['429', () => json(429, { error: 'Too many requests' })],
  ])('%s is unreachable and not retried', async (_, answer) => {
    const s = serving(answer());
    expect(await check(s)).toBe('unreachable');
    expect(s.calls).toHaveLength(1);
  });

  it('a redirect to another origin is refused and not followed', async () => {
    const s = serving(new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/api/v1/languages' } }));
    expect(await check(s)).toBe('incompatible');
    expect(s.calls).toHaveLength(1);
  });

  it('https → http on the same host is refused', async () => {
    const s = serving(new Response(null, { status: 301, headers: { location: 'http://g.example/api/v1/languages' } }));
    expect(await check(s)).toBe('incompatible');
    expect(s.calls).toHaveLength(1);
  });

  it('a redirect within the origin is followed', async () => {
    const s = serving(new Response(null, { status: 302, headers: { location: '/grader/api/v1/languages' } }), json(401, { error: 'Missing authorization token' }));
    expect(await check(s)).toBe('compatible');
  });

  it('an http address is checked the same way', async () => {
    const s = serving(json(401, { error: 'Missing authorization token' }));
    expect(await check(s, 'http://g.example')).toBe('compatible');
    expect(s.calls[0].url).toBe('http://g.example/api/v1/languages');
  });
});
