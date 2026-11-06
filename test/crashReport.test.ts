import { describe, expect, it } from 'vitest';
import { GraderError, NetworkError } from '../src/grader/errors';
import { CRASH } from '../src/shared/constants';
import { belongsToUs, buildReport, CrashGate, isReportable, looksLikeBug, sanitize, type CrashEnv, type SanitizeContext } from '../src/shared/crashReport';

const EXT = '/Users/ann/.vscode/extensions/badvoic3.cedt-grader-submit-1.0.1';
const ctx: SanitizeContext = {
  extensionPath: EXT,
  workspaceFolders: ['/Users/ann/Documents/hw', '/Users/ann/Documents/hw/sub'],
  home: '/Users/ann',
  terms: ['6530000021', 'Ann Example', 'cedt-grader.nattee.net', 'ann', 'anns-macbook', 'ab', null],
};
const env: CrashEnv = { extensionVersion: '1.0.1', appName: 'Visual Studio Code', appVersion: '1.145.0', platform: 'darwin', arch: 'arm64' };

describe('sanitize', () => {
  it.each([
    ['macOS home', "open '/Users/ann/Documents/a b/secret.cpp'", 'secret.cpp'],
    ['home path with spaces, unquoted', 'open /Users/ann/Documents/a b/secret.cpp', 'secret.cpp'],
    ['unknown path with spaces', 'open /srv/my files/secret.cpp', 'secret.cpp'],
    ['Windows path with spaces', 'read C:\\Users\\a b\\secret.cpp', 'secret.cpp'],
    ['Linux home', 'read /home/ann/secret.cpp failed', 'secret.cpp'],
    ['Windows path', 'read C:\\Users\\ann\\secret.cpp failed', 'secret.cpp'],
    ['Windows forward slashes', 'read C:/Users/ann/secret.cpp failed', 'secret.cpp'],
    ['UNC path', 'read \\\\server\\share\\secret.cpp failed', 'secret.cpp'],
    ['workspace', 'bad /Users/ann/Documents/hw/q1/secret.cpp', 'secret.cpp'],
    ['file URL', 'bad file:///Users/ann/Documents/a%20b/secret.cpp', 'secret.cpp'],
    ['Windows file URL', 'bad file:///c%3A/Users/ann/secret.cpp', 'secret.cpp'],
    ['JWT', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl', 'eyJ'],
    ['Bearer', 'Authorization: Bearer abc.def-123', 'abc.def-123'],
    ['token field', '{"token":"s3cr3tvalue"}', 's3cr3tvalue'],
    ['cookie', 'Cookie: _cafe_grader_session=abcdef; uuid=1', 'abcdef'],
    ['session pair', '_cafe_grader_session=abcdef', 'abcdef'],
    ['CSRF', 'authenticity_token=abcdef&x=1', 'abcdef'],
    ['password', 'password=hunter22&x=1', 'hunter22'],
    ['username', 'no entry for 6530000021', '6530000021'],
    ['full name', 'hello Ann Example!', 'Ann Example'],
    ['server URL', 'GET https://cedt-grader.nattee.net/api/v1/me?x=1', 'nattee'],
    ['server host', 'connect cedt-grader.nattee.net:443', 'nattee'],
    ['other URL', 'see https://example.com/private/page', 'example.com'],
    ['email', 'mail ann.e+x@student.chula.ac.th now', 'chula'],
    ['machine name', 'on anns-macbook today', 'anns-macbook'],
  ])('removes a %s', (_, text, secret) => {
    expect(sanitize(text, ctx)).not.toContain(secret);
  });

  it('keeps what is needed to read the error', () => {
    expect(sanitize("Cannot read properties of undefined (reading 'id')", ctx)).toBe("Cannot read properties of undefined (reading 'id')");
    expect(sanitize(`at f (${EXT}/dist/extension.js:1:42)`, ctx)).toBe('at f (<extension>/dist/extension.js:1:42)');
    expect(sanitize('1/2 of a/b', ctx)).toBe('1/2 of a/b');
    expect(sanitize(`at f (file://${EXT}/dist/pdfjs/pdf.min.mjs:1:2)`, ctx)).toBe('at f (<extension>/dist/pdfjs/pdf.min.mjs:1:2)');
  });

  it('matches a term only as a whole word, and ignores very short ones', () => {
    expect(sanitize('TypeError: planned scanner', { terms: ['ann', 'ype'] })).toBe('TypeError: planned scanner');
    expect(sanitize('cab', { terms: ['ab'] })).toBe('cab');
  });

  it('treats a term as text, not a pattern', () => {
    expect(sanitize('name a.b+c here', { terms: ['a.b+c'] })).toBe('name <private> here');
  });
});

const stack = [
  "TypeError: Cannot read properties of undefined (reading 'id')",
  `    at Flow.submit (${EXT}/dist/extension.js:1:48213)`,
  '    at Other.run (/Users/ann/.vscode/extensions/other.ext-1.0.0/dist/main.js:9:9)',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
  `    at async cmd (${EXT}/dist/extension.js:1:9)`,
].join('\n');
const input = { name: 'TypeError', message: "Cannot read properties of undefined (reading 'id')", stack, where: 'command submit' };

/** The text the issue will hold, read back from the address. */
const reportIn = (url: string) => new URL(url).searchParams.get('report');

describe('buildReport', () => {
  it('holds the environment, the error and only our own frames', () => {
    const r = buildReport(input, env, ctx);
    expect(r.report).toBe(
      [
        'Extension: 1.0.1',
        'App: Visual Studio Code 1.145.0',
        'OS: darwin arm64',
        'Where: command submit',
        "TypeError: Cannot read properties of undefined (reading 'id')",
        '  at Flow.submit (<extension>/dist/extension.js:1:48213)',
        '  at async cmd (<extension>/dist/extension.js:1:9)',
      ].join('\n'),
    );
    expect(r.report).not.toContain('other.ext');
    expect(r.title).toBe('Crash report: TypeError in command submit');
  });

  it('puts exactly the shown text in the address, whatever it contains', () => {
    const r = buildReport({ ...input, message: 'a & b #c + d = e % f' }, env, ctx);
    expect(reportIn(r.url)).toBe(r.report);
    const url = new URL(r.url);
    expect(url.origin + url.pathname).toBe('https://github.com/Badvoic3/cedt-grader-vscode/issues/new');
    expect(url.searchParams.get('template')).toBe('crash_report.yml');
    expect(url.searchParams.get('title')).toBe(r.title);
  });

  it.each([
    ['long English', 'x '.repeat(5000)],
    ['long Thai', 'ข้อผิดพลาด'.repeat(1000)],
    ['emoji', '😀'.repeat(2000)],
    ['half a surrogate pair', `bad \ud83d text`],
  ])('stays within the address limit: %s', (_, message) => {
    const frames = Array.from({ length: 30 }, (_, i) => `    at f${i} (${EXT}/dist/extension.js:1:${i})`).join('\n');
    const r = buildReport({ ...input, message, stack: `E\n${frames}` }, env, ctx);
    expect(r.url.length).toBeLessThanOrEqual(CRASH.maxUrlLength);
    expect(reportIn(r.url)).toBe(r.report);
    expect(r.report).toContain('Where: command submit');
  });

  it('keeps at most the set number of frames', () => {
    const frames = Array.from({ length: 30 }, (_, i) => `    at f${i} (${EXT}/dist/extension.js:1:${i})`).join('\n');
    const r = buildReport({ ...input, stack: `E\n${frames}` }, env, ctx);
    expect(r.report.split('\n').filter((l) => l.startsWith('  at'))).toHaveLength(CRASH.maxFrames);
  });

  it('cuts frames before the message', () => {
    const frames = Array.from({ length: 8 }, (_, i) => `    at someLongFunctionName${'x'.repeat(300)}${i} (${EXT}/dist/extension.js:1:${i})`).join('\n');
    const r = buildReport({ ...input, message: 'short and whole', stack: `E\n${frames}` }, env, ctx);
    expect(r.report).toContain('short and whole');
    expect(r.report.split('\n').filter((l) => l.startsWith('  at')).length).toBeLessThan(8);
  });

  it('reduces a panel script stack to the bundled file and position', () => {
    const web = 'Error: x\n    at render (https://file+.vscode-resource.vscode-cdn.net/Users/ann/.vscode/extensions/e/media/dist/webview.js?id=1:1:99)\n    at https://other.example/a.js:1:1';
    const r = buildReport({ name: 'PanelScriptError', message: 'x', stack: web, where: 'panel script', webview: true }, env, ctx);
    expect(r.report).toContain('  at render (<extension>/media/dist/webview.js:1:99)');
    expect(r.report).not.toContain('other.example');
    expect(r.report).not.toContain('Users');
  });

  it('gives the same error the same signature, and a different error another', () => {
    const a = buildReport({ ...input, message: 'bad item 12' }, env, ctx).signature;
    expect(buildReport({ ...input, message: 'bad item 345' }, env, ctx).signature).toBe(a);
    expect(buildReport({ ...input, message: 'other' }, env, ctx).signature).not.toBe(a);
    expect(buildReport({ ...input, message: 'bad item 12', stack: '' }, env, ctx).signature).not.toBe(a);
  });

  it('leaves nothing personal in the title or the address', () => {
    const r = buildReport({ name: 'Error', message: 'failed for 6530000021 in /Users/ann/Documents/hw/q1/secret.cpp', stack, where: 'Init failed for ann' }, env, ctx);
    for (const part of [r.title, r.report, decodeURIComponent(r.url)]) {
      for (const secret of ['6530000021', 'secret.cpp', '/Users/ann', ' ann']) expect(part).not.toContain(secret);
    }
  });
});

describe('what counts', () => {
  const coded = (code: string) => Object.assign(new Error('x'), { code });
  const named = (name: string, message = 'x') => Object.assign(new Error(message), { name });

  it('reports our own errors', () => {
    expect(isReportable(new TypeError('x'))).toBe(true);
    expect(isReportable(new Error('x'))).toBe(true);
  });

  it.each([
    ['grader error', new GraderError('x')],
    ['network error', new NetworkError('x')],
    ['fetch failure', new TypeError('fetch failed')],
    ['abort', named('AbortError')],
    ['cancel', new Error('Canceled')],
    ['missing file', coded('ENOENT')],
    ['no permission', coded('EACCES')],
    ['full disk', coded('ENOSPC')],
    ['VS Code file error', named('EntryNotFound (FileSystemError)')],
    ['not an error', 'text'],
    ['nothing', undefined],
  ])('skips a %s', (_, err) => {
    expect(isReportable(err)).toBe(false);
  });

  it('counts a handled error only when it can only be a bug', () => {
    expect(looksLikeBug(new TypeError('x'))).toBe(true);
    expect(looksLikeBug(new RangeError('x'))).toBe(true);
    expect(looksLikeBug(new ReferenceError('x'))).toBe(true);
    expect(looksLikeBug(new SyntaxError('Invalid regular expression'))).toBe(true);
    expect(looksLikeBug(new Error('x'))).toBe(false);
    expect(looksLikeBug(new SyntaxError('Unexpected token < in JSON at position 0'))).toBe(false);
    expect(looksLikeBug(new TypeError('fetch failed'))).toBe(false);
  });
});

describe('belongsToUs', () => {
  it('finds our path in a frame', () => {
    expect(belongsToUs(stack, EXT)).toBe(true);
    expect(belongsToUs('E\n    at f (c:\\Ext\\Our Ext\\dist\\a.js:1:1)', 'C:\\ext\\our ext')).toBe(true);
    expect(belongsToUs('E\n    at f (file:///c:/ext/our%20ext/dist/a.mjs:1:1)', 'C:\\ext\\our ext')).toBe(true);
  });

  it("ignores other extensions' errors, even when the message names our path", () => {
    expect(belongsToUs(`Error: ${EXT}\n    at f (/x/other/a.js:1:1)`, EXT)).toBe(false);
    expect(belongsToUs(undefined, EXT)).toBe(false);
    expect(belongsToUs(stack, '')).toBe(false);
  });
});

describe('CrashGate', () => {
  it('admits one prompt per distinct error', () => {
    const g = new CrashGate(3);
    expect(g.admit('a')).toBe(true);
    g.close();
    expect(g.admit('a')).toBe(false);
    expect(g.admit('b')).toBe(true);
  });

  it('keeps one open at a time, and a skipped error can come back', () => {
    const g = new CrashGate(3);
    expect(g.admit('a')).toBe(true);
    expect(g.admit('b')).toBe(false);
    g.close();
    expect(g.admit('b')).toBe(true);
  });

  it('stops at the session limit', () => {
    const g = new CrashGate(2);
    for (const s of ['a', 'b']) {
      expect(g.admit(s)).toBe(true);
      g.close();
    }
    expect(g.admit('c')).toBe(false);
  });
});
