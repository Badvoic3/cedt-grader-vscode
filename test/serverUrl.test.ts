import { describe, expect, it } from 'vitest';
import { DEFAULT_BASE_URL } from '../src/shared/constants';
import { isInsecure, isLoopback, normalizeServerUrl, normalizeTypedServer } from '../src/shared/serverUrl';

describe('normalizeServerUrl', () => {
  it.each([
    ['', DEFAULT_BASE_URL],
    ['   ', DEFAULT_BASE_URL],
    ['grader.example.ac.th', 'https://grader.example.ac.th'],
    ['localhost:3000', 'https://localhost:3000'],
    ['  https://g.example/  ', 'https://g.example'],
    ['https://g.example/sub/path/', 'https://g.example/sub/path'],
    ['HTTP://G.Example', 'http://g.example'],
    ['https://user:secret@g.example/x?y=1#z', 'https://g.example/x'],
  ])('%j → %s', (raw, url) => expect(normalizeServerUrl(raw)).toBe(url));

  it.each(['ftp://g.example', 'file:///etc/passwd', 'javascript://x', 'https://', 'not a url'])('refuses %j', (raw) => {
    expect(normalizeServerUrl(raw)).toBeNull();
  });
});

describe('plain http', () => {
  it.each(['http://localhost:3000', 'http://127.0.0.1', 'http://[::1]:3000', 'http://app.localhost'])('%s stays on this computer', (u) => {
    expect(isLoopback(u)).toBe(true);
    expect(isInsecure(u)).toBe(false);
  });
  it('anything else is insecure, https never is', () => {
    expect(isInsecure('http://grader.example')).toBe(true);
    expect(isInsecure('http://127.0.0.1.example.com')).toBe(true);
    expect(isInsecure('https://grader.example')).toBe(false);
  });
});

describe('normalizeTypedServer', () => {
  it('a bare word with no scheme is a slip', () => {
    for (const raw of ['example', 'example:3000', 'grader/path']) expect(normalizeTypedServer(raw)).toBeNull();
  });

  it('a dotted name, this computer, an IP or a typed scheme is an address', () => {
    expect(normalizeTypedServer('grader.example.ac.th')).toBe('https://grader.example.ac.th');
    expect(normalizeTypedServer('localhost:3000')).toBe('https://localhost:3000');
    expect(normalizeTypedServer('10.0.0.5')).toBe('https://10.0.0.5');
    expect(normalizeTypedServer('[::1]:3000')).toBe('https://[::1]:3000');
    expect(normalizeTypedServer('http://grader')).toBe('http://grader');
  });

  it('empty still means the default server', () => {
    expect(normalizeTypedServer('')).toBe(DEFAULT_BASE_URL);
  });
});
