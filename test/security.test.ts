/**
 * Regression tests for the security review (2026-11-04): hostile input from
 * the grader, attachments, statements and `.cedt-grader.json`. The inputs are
 * the reviewer's probe inputs (H1, M1, M2, L1–L9). No network: fake fetch.
 */
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readSampleTables, SampleReadLimitError, type Pdfjs } from '../src/data/pdfSamples';
import { ApiClient } from '../src/grader/api';
import { caseNumbers, classifyConnectionError, GraderClient, GraderError, isContestPage, parseGraderComment, RedirectRefusedError, safeExt, VERDICT_STRING_RE } from '../src/grader';
import { HttpSession } from '../src/grader/http';
import { Redactor } from '../src/grader/redact';
import { isProtectedName, planZip, writeExtracted } from '../src/mapping/attachment';
import { folderNameFor, fileNameFor } from '../src/mapping/match';
import { parseMappingFile, serializeMappingFile } from '../src/mapping/mappingFile';
import { nearestFolderLink } from '../src/mapping/mappingOps';
import { saveTestcasesAsFiles, testsFolderFor } from '../src/mapping/testCases';
import { ATTACHMENT, STATEMENT } from '../src/shared/constants';
import { SecretLedger, secretKey } from '../src/shared/secrets';
import { KEYS } from '../src/shared/stateKeys';
import { G, S } from '../src/shared/strings';
import { FakeGrader } from './fakeServer';

const BASE = 'https://grader.example';
const ms = (f: () => unknown): number => {
  const t = performance.now();
  f();
  return performance.now() - t;
};

// ------------------------------------------------------------------ H1

describe('H1: zip attachments never write dot folders, .git or .cedt-grader.json', () => {
  const hostile = zipSync({
    'pkg/main.cpp': strToU8('int main(){}'),
    'pkg/.git/HEAD': strToU8('ref: refs/heads/main\n'),
    'pkg/.git/config': strToU8('[core]\n\tfsmonitor = "touch /tmp/pwned"\n'),
    'pkg/.vscode/tasks.json': strToU8('{"version":"2.0.0","tasks":[]}'),
    'pkg/.vscode/settings.json': strToU8('{"cedtGrader.confirmBeforeSubmit":false}'),
    'pkg/src/.idea/workspace.xml': strToU8('<x/>'),
    'pkg/.GIT/objects/ab': strToU8('x'),
    'pkg/sub/.git': strToU8('gitdir: ../gitstuff\n'),
    'pkg/.cedt-grader.json': strToU8('{"version":1,"files":{"..":{"problemId":7,"folder":true}}}'),
    'pkg/sub/.CEDT-GRADER.JSON': strToU8('{}'),
    'pkg/.clang-format': strToU8('BasedOnStyle: LLVM\n'),
    'pkg/sub/student.h': strToU8('// stub\n'),
  });

  it('planZip skips them at any depth and keeps plain dot files', () => {
    const plan = planZip(hostile);
    expect(plan.topFolder).toBe('pkg');
    expect(plan.files.map((f) => f.rel)).toEqual(['.clang-format', 'main.cpp', 'sub/student.h']);
  });

  it('nothing of them is written', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cedt-sec-h1-')), 'out');
    await writeExtracted(dir, planZip(hostile).files);
    const written = (readdirSync(dir, { recursive: true }) as string[]).map((p) => p.replace(/\\/g, '/')).sort();
    expect(written).toEqual(['.clang-format', 'main.cpp', 'sub', 'sub/student.h']);
  });

  it('a single-file download is never saved as .cedt-grader.json or .git', () => {
    expect(isProtectedName('.cedt-grader.json')).toBe(true);
    expect(isProtectedName('.Cedt-Grader.JSON')).toBe(true);
    expect(isProtectedName('.git')).toBe(true);
    expect(isProtectedName('.clang-format')).toBe(false);
    expect(isProtectedName('main.cpp')).toBe(false);
  });
});

// ------------------------------------------------------------------ L6

/** probe5: a zip whose zip64 end record claims `count` entries (only one is real). */
function withEntryCount(count: number): Uint8Array {
  const base = zipSync({ 'main.cpp': strToU8('int main(){}') });
  const eocd = base.length - 22;
  const cdOff = new DataView(base.buffer).getUint32(eocd + 16, true);
  const body = base.subarray(0, eocd);
  const z64 = new Uint8Array(56);
  const d64 = new DataView(z64.buffer);
  d64.setUint32(0, 0x06064b50, true);
  d64.setUint32(32, count, true);
  d64.setUint32(48, cdOff, true);
  const loc = new Uint8Array(20);
  const dl = new DataView(loc.buffer);
  dl.setUint32(0, 0x07064b50, true);
  dl.setUint32(8, body.length, true);
  const out = new Uint8Array(body.length + 56 + 20 + 22);
  out.set(body, 0);
  out.set(z64, body.length);
  out.set(loc, body.length + 56);
  out.set(base.slice(eocd), body.length + 76);
  return out;
}

describe('L6: a zip claiming a huge entry count is refused quickly', () => {
  it('2^32 - 1 claimed entries: refused in well under a second', () => {
    let err: unknown;
    const t = ms(() => {
      try {
        planZip(withEntryCount(4_294_967_295));
      } catch (e) {
        err = e;
      }
    });
    expect((err as Error)?.message).toBe(S.attachment.tooManyFiles(ATTACHMENT.maxEntries));
    expect(t).toBeLessThan(500);
  });

  it('10^7 claimed entries (probe5, 1.4 s before) are refused too', () => {
    expect(() => planZip(withEntryCount(10_000_000))).toThrow(S.attachment.tooManyFiles(ATTACHMENT.maxEntries));
  });

  it('a real zip is still read', () => {
    expect(planZip(withEntryCount(1)).files.map((f) => f.rel)).toEqual(['main.cpp']);
  });
});

// ------------------------------------------------------------------ M1

/** The website's spelling (exponential in JavaScript). Only run on short strings here. */
const WEBSITE_RE = /^(?:[?P\-sTMxE!]+|\[[?P\-sTMxE!]+\])+$/;

describe('M1: the verdict pattern is linear and accepts exactly the same strings', () => {
  it('same answers as the website spelling (fixed cases + every string up to length 6 over a small alphabet)', () => {
    const fixed = ['PPPPTPPPPPP-', 'P[P-][xP][PPP]', '[P-][PsP][PP]', '?', '!', 'No testcase', 'PZ', '[[P]]', '[P', 'P]', 'P[]', '[P[-]]', 'p', '', '[]', 'P[P]P', '[?!]'];
    for (const s of fixed) expect(VERDICT_STRING_RE.test(s), s).toBe(WEBSITE_RE.test(s));
    const alphabet = ['P', '-', '[', ']', 'Z', ' '];
    let checked = 0;
    const walk = (s: string) => {
      expect(VERDICT_STRING_RE.test(s), JSON.stringify(s)).toBe(WEBSITE_RE.test(s));
      checked++;
      if (s.length < 6) for (const c of alphabet) walk(s + c);
    };
    walk('');
    expect(checked).toBeGreaterThan(50_000);
  });

  it('a long run of codes + one other character finishes in < 50 ms (28 letters took 8.6 s)', () => {
    for (const s of ['P'.repeat(10_000) + 'Z', 'P'.repeat(30) + ' (TLE)', 'T'.repeat(40) + 'Z', '[' + 'P'.repeat(10_000), 'P[PP]'.repeat(2_000) + 'Z']) {
      let r: unknown;
      const t = ms(() => (r = parseGraderComment(s)));
      expect(r).toEqual([]);
      expect(t, s.slice(0, 12)).toBeLessThan(50);
    }
    expect(parseGraderComment('P'.repeat(200))).toHaveLength(200);
  });
});

// ------------------------------------------------------------------ L8

/** The old `isContestPage` (quadratic). Only run on short strings here. */
const oldContest = (html: string): boolean => {
  if (/Date\.parse\(\s*'[^']+'\s*\)/.test(html)) return true;
  const m = /<[^>]*\bid=["']countdown["'][^>]*>([^<]*)</i.exec(html);
  return m !== null && !/analysis mode/i.test(m[1]);
};

describe('L8: isContestPage is linear with the same answers', () => {
  it('same answers as the old pattern on generated pages', () => {
    const parts = ['<', '>', 'div ', 'xid="countdown"', ' id="countdown"', "id='COUNTDOWN'", 'ANALYSIS MODE', '12:00', '<b>', ' '];
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    let contests = 0;
    for (let i = 0; i < 20_000; i++) {
      let html = '';
      for (let k = rnd(9); k >= 0; k--) html += parts[rnd(parts.length)];
      const want = oldContest(html);
      if (want) contests++;
      expect(isContestPage(html), JSON.stringify(html)).toBe(want);
    }
    expect(contests).toBeGreaterThan(100); // both answers were exercised
    expect(isContestPage('<nav><div class="btn" id="countdown"></div></nav>')).toBe(true);
    expect(isContestPage('<div id="countdown">ANALYSIS MODE</div>')).toBe(false);
  });

  it('a long run of "<" without ">" finishes in < 50 ms (40 000 took 0.8 s)', () => {
    for (const html of ['<'.repeat(200_000), '<' + ' id="countdown"'.repeat(20_000), '<a id="countdown"'.repeat(20_000)]) {
      expect(ms(() => isContestPage(html))).toBeLessThan(50);
    }
  });
});

// ------------------------------------------------------------------ M2

interface Seen {
  url: string;
  method?: string;
  body?: string;
  headers: Record<string, string>;
  redirect?: string;
}
function recorder(answer: (url: string, init: RequestInit) => Response) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    seen.push({ url, method: init.method, body: init.body ? String(init.body) : undefined, headers: (init.headers ?? {}) as Record<string, string>, redirect: init.redirect });
    return answer(url, init);
  };
  return { seen, fetch };
}
const redirect = (status: number, location: string, cookie?: string) => {
  const h = new Headers({ location });
  if (cookie) h.append('set-cookie', cookie);
  return new Response(null, { status, headers: h });
};

describe('M2: redirects never leave the grader origin', () => {
  it('web login: a 307 to another host is refused, the password is not re-sent (probe2 A)', async () => {
    const { seen, fetch } = recorder((url) => (url.endsWith('/login/login') ? redirect(307, 'http://evil.example/collect', '_cafe_grader_session=S; path=/') : new Response('ok')));
    const s = new HttpSession(BASE, fetch);
    const err = await s.request('/login/login', { method: 'POST', body: new URLSearchParams({ login: 'u', password: 'hunter2' }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedirectRefusedError);
    expect(seen.map((r) => r.url)).toEqual([`${BASE}/login/login`]);
  });

  it('web session: https → http on the same host is refused, the cookie stays (probe2 B)', async () => {
    const { seen, fetch } = recorder((url) => (url === `${BASE}/main/list` ? redirect(302, 'http://grader.example/main/list2', '_cafe_grader_session=S; path=/') : new Response('ok')));
    const s = new HttpSession(BASE, fetch);
    await expect(s.request('/main/list')).rejects.toBeInstanceOf(RedirectRefusedError);
    expect(seen).toHaveLength(1);
  });

  it('web session: a redirect within the origin is still followed (with the cookie)', async () => {
    const { seen, fetch } = recorder((url) => (url === `${BASE}/` ? redirect(302, '/main/list', '_cafe_grader_session=S; path=/') : new Response('list')));
    const r = await new HttpSession(BASE, fetch).request('/');
    expect(r.body).toBe('list');
    expect(seen[1]).toMatchObject({ url: `${BASE}/main/list`, headers: { Cookie: '_cafe_grader_session=S' } });
  });

  it('API login: fetch never follows by itself; a 307 to another host is refused, the body is not re-sent', async () => {
    const { seen, fetch } = recorder(() => redirect(307, 'https://evil.example/api/v1/auth/login'));
    const api = new ApiClient(BASE, fetch, () => {}, new Redactor());
    await expect(api.login('u', 'hunter2')).rejects.toBeInstanceOf(RedirectRefusedError);
    expect(seen).toHaveLength(1);
    expect(seen[0].redirect).toBe('manual');
  });

  it('API GET: the token never goes to another origin; within the origin it is followed', async () => {
    const away = recorder(() => redirect(302, 'https://cdn.example/x'));
    const api = new ApiClient(BASE, away.fetch, () => {}, new Redactor());
    api.setToken('tok-123456');
    await expect(api.get('/api/v1/problems')).rejects.toBeInstanceOf(RedirectRefusedError);
    expect(away.seen.map((r) => r.url)).toEqual([`${BASE}/api/v1/problems`]);

    const home = recorder((url) => (url.endsWith('/api/v1/problems') ? redirect(301, '/api/v1/problems/') : Response.json([{ id: 1 }])));
    const api2 = new ApiClient(BASE, home.fetch, () => {}, new Redactor());
    api2.setToken('tok-123456');
    expect(await api2.get('/api/v1/problems')).toEqual([{ id: 1 }]);
    expect(home.seen[1]).toMatchObject({ url: `${BASE}/api/v1/problems/`, method: 'GET', headers: { Authorization: 'Bearer tok-123456' } });
  });

  it('the banner says where the grader tried to send the request', () => {
    const p = classifyConnectionError(new RedirectRefusedError('grader.example', 'http://evil.example'));
    expect(p).toMatchObject({ kind: 'unreachable', title: G.unreachableTitle, message: G.redirectRefused('grader.example', 'http://evil.example'), action: 'retry' });
  });
});

// ------------------------------------------------------------------ L5

/** A body of `mb` MB without Content-Length (chunked), counting what was read. */
function chunked(mb: number) {
  const state = { produced: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (state.produced >= mb * 1048576) return c.close();
      state.produced += 1048576;
      c.enqueue(new Uint8Array(1048576));
    },
  });
  return { state, stream };
}

describe('L5: download caps are enforced while reading', () => {
  it('an attachment without Content-Length stops at the cap (probe2 C read all 60 MB)', async () => {
    const { state, stream } = chunked(60);
    const api = new ApiClient(BASE, async () => new Response(stream), () => {}, new Redactor());
    api.setToken('tok-123456');
    await expect(api.getBytes('/api/v1/problems/1/files/attachment', ATTACHMENT.maxDownloadBytes)).rejects.toBeInstanceOf(GraderError);
    expect(state.produced).toBeLessThanOrEqual(ATTACHMENT.maxDownloadBytes + 2 * 1048576);
  });

  it('the statement PDF has a cap (probe2 D accepted 60 MB)', async () => {
    expect(STATEMENT.maxPdfBytes).toBe(50 * 1048576);
    const server = new FakeGrader();
    const big = chunked(60);
    const fetch = async (url: string, init?: RequestInit) => (url.endsWith('/files/pdf') ? new Response(big.stream) : server.fetch(url, init));
    const client = new GraderClient({ baseUrl: 'https://grader.test', getStoredCredentials: async () => ({ username: 'student', password: 'pw' }), fetch, sleep: async () => {} });
    await client.login({ username: 'student', password: 'pw' });
    await expect(client.getStatementPdf(201)).rejects.toThrow(G.downloadTooLarge(50));
    expect(big.state.produced).toBeLessThanOrEqual(STATEMENT.maxPdfBytes + 2 * 1048576);
  });

  it('a body under the cap is returned whole', async () => {
    const api = new ApiClient(BASE, async () => new Response(new Uint8Array(3000)), () => {}, new Redactor());
    api.setToken('tok-123456');
    const r = await api.getBytes('/api/v1/problems/1/files/pdf', 5000);
    expect(r.status === 200 && r.bytes.length).toBe(3000);
  });
});

// ------------------------------------------------------------------ L1, L2, L3

describe('L1: test-case numbers from the server never become paths', () => {
  it('a bad or duplicate num → cases numbered 1, 2, … in list order', () => {
    expect(caseNumbers([3, 1, 2])).toEqual([3, 1, 2]);
    expect(caseNumbers(['../../../../escaped', 2])).toEqual([1, 2]);
    expect(caseNumbers([1, 1])).toEqual([1, 2]);
    expect(caseNumbers([0, 1.5, -2])).toEqual([1, 2, 3]);
  });

  it('the client renumbers a hostile list', async () => {
    const server = new FakeGrader();
    const fetch = async (url: string, init?: RequestInit) =>
      url.endsWith('/api/v1/problems/201/testcases') ? Response.json([{ id: 9, num: '../../../../escaped', access: 'preview' }, { id: 10, num: 2, access: 'preview' }]) : server.fetch(url, init);
    const client = new GraderClient({ baseUrl: 'https://grader.test', getStoredCredentials: async () => ({ username: 'student', password: 'pw' }), fetch, sleep: async () => {} });
    await client.login({ username: 'student', password: 'pw' });
    expect((await client.listTestcases(201))?.map((t) => t.num)).toEqual([1, 2]);
  });

  it('saving files: a hostile num (e.g. from an old cache) stays inside the tests folder (probe1 #8)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'cedt-sec-l1-'));
    const tests = join(base, 'ws', 'hw', 'p', 'tests');
    const r = await saveTestcasesAsFiles(tests, [{ testcaseId: 1, num: '../../../../escaped' as unknown as number, input: 'in', output: 'out' }]);
    expect(r.written).toBe(1);
    expect(existsSync(join(base, 'escaped.in'))).toBe(false);
    expect(readdirSync(tests).sort()).toEqual(['case1.in', 'case1.out']);
  });
});

describe('L2: a problem named "." or ".." gives its id as the folder name', () => {
  it('tests folder, folder name and file name (probe1 #6)', () => {
    expect(testsFolderFor('/ws/hw', '..', 42)).toBe(join('/ws/hw', '42', 'tests'));
    expect(testsFolderFor('/ws/hw', '.', 42)).toBe(join('/ws/hw', '42', 'tests'));
    expect(testsFolderFor('/ws/hw', '..')).toBe(join('/ws/hw', 'problem', 'tests'));
    expect(folderNameFor('..', undefined, 42)).toBe('42');
    expect(folderNameFor('...', '.{name}.{ext}', 42)).toBe('.42');
    expect(fileNameFor('..', 'cpp', undefined, 42)).toBe('42.cpp');
  });

  it('ordinary names are unchanged', () => {
    expect(testsFolderFor('/ws/hw', 'p_ai', 42)).toBe(join('/ws/hw', 'p_ai', 'tests'));
    expect(folderNameFor('a..b', undefined, 42)).toBe('a..b');
    expect(fileNameFor('Mr. Smith', 'cpp')).toBe('Mr. Smith.cpp');
  });
});

describe('L3: a language extension with separators never leaves the folder', () => {
  it('the client keeps only plain extensions', () => {
    expect(safeExt('cpp')).toBe('cpp');
    expect(safeExt('.cpp')).toBe('.cpp');
    expect(safeExt('c++')).toBe('c++');
    expect(safeExt('cpp/../../../../tmp/evil')).toBe('');
    expect(safeExt('..')).toBe('');
    expect(safeExt(null)).toBe('');
  });

  it('the file name never contains a separator (probe1 #7)', () => {
    expect(fileNameFor('p', 'cpp/../../../../tmp/evil')).toBe('p.txt');
    expect(fileNameFor('p', '..')).toBe('p.txt');
    expect(fileNameFor('p', 'cpp')).toBe('p.cpp');
  });

  it('GraderClient.languages drops a hostile ext', async () => {
    const server = new FakeGrader();
    const fetch = async (url: string, init?: RequestInit) =>
      url.endsWith('/api/v1/languages') ? Response.json([{ id: 1, name: 'cpp', pretty_name: 'C++', ext: 'cpp/../../../../tmp/evil' }, { id: 2, name: 'python', pretty_name: 'Python', ext: 'py' }]) : server.fetch(url, init);
    const client = new GraderClient({ baseUrl: 'https://grader.test', getStoredCredentials: async () => ({ username: 'student', password: 'pw' }), fetch, sleep: async () => {} });
    await client.login({ username: 'student', password: 'pw' });
    expect((await client.languages()).map((l) => l.ext)).toEqual(['', 'py']);
  });
});

// ------------------------------------------------------------------ L4

describe('L4: .cedt-grader.json entries outside the workspace are ignored', () => {
  const hostile = JSON.stringify({
    version: 1,
    files: {
      '..': { problemId: 7, name: 'x', folder: true, submitFile: 'other/secret.cpp' },
      '../../..': { problemId: 8, name: 'y', folder: true },
      'a/../../b.cpp': { problemId: 10, name: 'w' },
      '/etc/passwd': { problemId: 11, name: 'v' },
      'C:\\Users\\x.cpp': { problemId: 12, name: 'u' },
      a: { problemId: 9, name: 'z', folder: true, submitFile: '/etc/passwd' },
      '..notes/x.cpp': { problemId: 13, name: 't' },
    },
  });

  it('parse keeps only paths inside the folder (probe1 #9)', () => {
    const m = parseMappingFile(hostile);
    expect(Object.keys(m.files).sort()).toEqual(['..notes/x.cpp', 'a']);
    expect(m.files.a).toEqual({ problemId: 9, name: 'z', folder: true });
    const ws = '/Users/me/hw';
    const located = Object.entries(m.files).map(([rel, entry]) => ({ fsPath: join(ws, rel), entry }));
    expect(nearestFolderLink(located, '/Users/me/hw/sub/main.cpp', false)).toBeUndefined();
  });

  it('a file with only valid entries is written back byte for byte', () => {
    const ok = serializeMappingFile(parseMappingFile(JSON.stringify({ version: 1, files: { 'hw/a.cpp': { problemId: 1, name: 'a' }, pkg: { problemId: 2, name: 'b', folder: true, submitFile: 'student.h' } } })));
    expect(serializeMappingFile(parseMappingFile(ok))).toBe(ok);
  });
});

// ------------------------------------------------------------------ L7

function fakePdfjs(doc: { numPages: number; getPage: (n: number) => Promise<never> | Promise<unknown> }, destroyed: { doc: boolean }): Pdfjs {
  return {
    getDocument: () => ({ promise: Promise.resolve({ ...doc, destroy: async () => void (destroyed.doc = true) }) }),
    OPS: {} as Pdfjs['OPS'],
    GlobalWorkerOptions: { workerSrc: '' },
  } as unknown as Pdfjs;
}

describe('L7: reading samples has a page cap and a time budget', () => {
  it('a PDF with more pages than the cap is refused before any page is read', async () => {
    const destroyed = { doc: false };
    let pagesRead = 0;
    const pdfjs = fakePdfjs({ numPages: 50_000, getPage: () => (pagesRead++, new Promise<never>(() => {})) }, destroyed);
    await expect(readSampleTables(new Uint8Array(10), pdfjs)).rejects.toBeInstanceOf(SampleReadLimitError);
    expect(pagesRead).toBe(0);
    expect(destroyed.doc).toBe(true);
  });

  it('a page that never finishes stops at the time budget', async () => {
    const destroyed = { doc: false };
    const pdfjs = fakePdfjs({ numPages: 3, getPage: () => new Promise<never>(() => {}) }, destroyed);
    const t = performance.now();
    const err = await readSampleTables(new Uint8Array(10), pdfjs, { maxPages: 100, timeBudgetMs: 50 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SampleReadLimitError);
    expect((err as Error).message).toBe(S.samples.tooLong);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(destroyed.doc).toBe(true);
  });

  it('the budget is also checked between pages', async () => {
    let clock = 0;
    const page = { view: [0, 0, 600, 800], getOperatorList: async () => ((clock += 400), { fnArray: [], argsArray: [] }), getTextContent: async () => ({ items: [] }), commonObjs: { get: () => null } };
    const pdfjs = fakePdfjs({ numPages: 10, getPage: async () => page }, { doc: false });
    await expect(readSampleTables(new Uint8Array(10), pdfjs, { maxPages: 100, timeBudgetMs: 1000, now: () => clock })).rejects.toBeInstanceOf(SampleReadLimitError);
  });
});

// ------------------------------------------------------------------ L9

function fakeSecrets() {
  const store = new Map<string, string>();
  const state = new Map<string, unknown>();
  const ledger = new SecretLedger(
    { store: async (k, v) => void store.set(k, v), delete: async (k) => void store.delete(k) },
    { get: <T>(k: string, d: T) => (state.has(k) ? (state.get(k) as T) : d), update: async (k, v) => void state.set(k, v) },
  );
  return { store, state, ledger };
}

describe('L9: saved passwords and tokens of earlier users / addresses are removed', () => {
  it('a change of user or address forgets the previous one', async () => {
    const { store, ledger } = fakeSecrets();
    await ledger.store(secretKey('password', BASE, 'alice'), 'pw-a');
    await ledger.store(secretKey('token', BASE, 'alice'), '{"token":"t"}');
    await ledger.store(secretKey('password', BASE, 'bob'), 'pw-b');
    await ledger.forgetAccount(BASE, 'alice');
    expect([...store.keys()]).toEqual([secretKey('password', BASE, 'bob')]);
    await ledger.forgetAccount(BASE, ''); // no user: nothing
    expect(store.size).toBe(1);
  });

  it('Log Out removes every key written (any user, any address) plus the current ones', async () => {
    const { store, state, ledger } = fakeSecrets();
    store.set('cedtGrader.password:https://old:legacy', 'from an older version'); // never listed
    await ledger.store(secretKey('password', BASE, 'alice'), 'pw-a');
    await ledger.store(secretKey('password', 'https://other.example', 'carol'), 'pw-c');
    await ledger.store(secretKey('token', 'https://other.example', 'carol'), 't');
    expect(state.get(KEYS.secretKeys)).toHaveLength(3);
    await ledger.forgetAll([secretKey('password', BASE, 'dave'), 'cedtGrader.password:https://old:legacy']);
    expect(store.size).toBe(0);
    expect(ledger.written()).toEqual([]);
  });

  it('a deleted key leaves the list; a corrupt list reads as empty', async () => {
    const { state, ledger } = fakeSecrets();
    await ledger.store('k1', 'v');
    await ledger.delete('k1');
    expect(ledger.written()).toEqual([]);
    state.set(KEYS.secretKeys, 'not a list');
    expect(ledger.written()).toEqual([]);
  });
});
