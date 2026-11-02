import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TestcaseStore } from '../src/data/testcaseStore';
import { GraderClient, type Problem } from '../src/grader';
import { cphProbPath, type CphProblem } from '../src/mapping/cph';
import { GRADER_ID_BASE, importIntoCph, normalizeEol } from '../src/mapping/cphImport';
import { cleanName, fileNameFor, normalizeName, resolveProblem, suggest } from '../src/mapping/match';
import { parseMappingFile, reverseIndex } from '../src/mapping/mappingFile';
import { createFileNoOverwrite } from '../src/mapping/newFile';
import { FakeGrader } from './fakeServer';
import { fixture } from './helpers';

const BASE = 'https://cedt-grader.nattee.net';
const P = (id: number, name: string, fullName = name): Problem => ({
  id, name, fullName, bestScore: null, lastScore: null, lastResult: null, lastSubmissionId: null, lastSubmissionTime: null,
  submissionCount: 0, hasTestcase: true, hasAttachment: false, permittedLanguageIds: null, list: null,
});
const problems = [
  P(1360, '00_Intro_11', '00_Intro_★_Hello_World'),
  P(1759, 'DigLo69_Exam2__1'),
  P(1271, '01_Expr_11', '01_Expr_★_An_Expression'),
  P(1272, '01_Expr_12', '01_Expr_★_Quadratic_Root'),
  P(1734, 'da68_f2_closed_city', 'เมืองปิด'),
];

describe('name normalization', () => {
  it('zero-width characters, separators, case', () => {
    expect(normalizeName('00_​Intro_​11')).toBe('00_intro_11');
    expect(normalizeName('  00 intro--11 ')).toBe('00_intro_11');
    expect(normalizeName('DigLo69.Exam2__1')).toBe('diglo69_exam2_1');
    expect(normalizeName('A﻿ ‌-_. b')).toBe('a_b');
  });
  it('clean name for copying keeps the original spelling', () => {
    expect(cleanName(' 00_​Intro_​11‍ ')).toBe('00_Intro_11');
    expect(normalizeName(cleanName('00_​Intro_11'))).toBe(normalizeName('00_Intro_11'));
  });
  it('file names from problem names never contain path separators', () => {
    expect(fileNameFor('00_​Intro_11', 'cpp')).toBe('00_Intro_11.cpp');
    expect(fileNameFor('a/b:c', '.py')).toBe('a_b_c.py');
  });
});

describe('matching order', () => {
  const m = (over: Partial<Parameters<typeof resolveProblem>[0]>) =>
    resolveProblem({ savedProblemId: null, cph: null, filePath: '/w/x.cpp', problems, baseUrl: BASE, ...over });

  it('1. a saved mapping always wins', () => {
    const r = m({ savedProblemId: 1759, filePath: '/w/00_Intro_11.cpp' });
    expect(r).toMatchObject({ kind: 'match', source: 'saved', problem: { id: 1759 } });
  });

  it('stale mapping (problem gone) is ignored and reported', () => {
    const r = m({ savedProblemId: 999, filePath: '/w/00_Intro_11.cpp' });
    expect(r).toMatchObject({ kind: 'match', source: 'filename', problem: { id: 1360 } });
    const r2 = m({ savedProblemId: 999, filePath: '/w/unrelated_zzz.cpp' });
    expect(r2).toMatchObject({ kind: 'none', staleMappingId: 999 });
  });

  it('saved mapping is kept while the problem list is not loaded yet', () => {
    expect(m({ savedProblemId: 999, problems: undefined })).toMatchObject({ kind: 'match', source: 'saved', problem: { id: 999 } });
  });

  it('2. CPH .prob: grader URL, then problem name', () => {
    const byUrl = { name: 'whatever', url: `${BASE}/submissions/direct_edit_problem/1271`, tests: [] } as unknown as CphProblem;
    expect(m({ cph: byUrl, filePath: '/w/00_Intro_11.cpp' })).toMatchObject({ source: 'cph', problem: { id: 1271 } });
    const byName = { name: 'Local: 01 expr 12', url: '/w/x.cpp', tests: [] } as unknown as CphProblem;
    expect(m({ cph: byName })).toMatchObject({ source: 'cph', problem: { id: 1272 } });
  });

  it('3. exact normalized file name', () => {
    expect(m({ filePath: '/w/00 intro-11.cpp' })).toMatchObject({ kind: 'match', source: 'filename', problem: { id: 1360 } });
    expect(m({ filePath: '/w/DigLo69.Exam2__1.dig' })).toMatchObject({ source: 'filename', problem: { id: 1759 } });
  });

  it('ambiguous matches are not chosen', () => {
    const dup = [...problems, P(5000, '00_intro_11', 'Duplicate')];
    expect(m({ filePath: '/w/00_intro_11.cpp', problems: dup })).toMatchObject({ kind: 'ambiguous', source: 'filename' });
    expect((m({ filePath: '/w/00_intro_11.cpp', problems: dup }) as { candidates: Problem[] }).candidates.map((p) => p.id)).toEqual([1360, 5000]);
  });

  it('4. otherwise suggestions (closest few), not a match', () => {
    const r = m({ filePath: '/w/01_expr.cpp' });
    expect(r.kind).toBe('none');
    expect((r as { suggestions: Problem[] }).suggestions.map((p) => p.id).slice(0, 2).sort()).toEqual([1271, 1272]);
    expect(suggest('totally_unrelated', problems)).toEqual([]);
  });
});

describe('reverse lookup', () => {
  it('problem id → mapped files, other servers ignored', () => {
    const d = parseMappingFile(JSON.stringify({ files: { 'a.cpp': { problemId: 1, name: 'x' }, 'b/a.cpp': { problemId: 1, name: 'x' }, 'c.cpp': { problemId: 2, name: 'y', baseUrl: 'https://other' } } }));
    const r = reverseIndex(d, BASE);
    expect(r.get(1)).toEqual(['a.cpp', 'b/a.cpp']);
    expect(r.has(2)).toBe(false);
  });
});

describe('new file for a problem', () => {
  it('creates, and never overwrites without an explicit choice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'newfile-'));
    const f = join(dir, fileNameFor('00_​Intro_11', 'cpp'));
    expect(await createFileNoOverwrite(f, async () => 'overwrite')).toBe('created');
    writeFileSync(f, 'my code');
    let asked = 0;
    expect(await createFileNoOverwrite(f, async () => (asked++, 'cancel'))).toBe('cancel');
    expect(readFileSync(f, 'utf8')).toBe('my code');
    expect(await createFileNoOverwrite(f, async () => 'open')).toBe('open');
    expect(readFileSync(f, 'utf8')).toBe('my code');
    expect(asked).toBe(1);
  });
});

describe('CPH import', () => {
  const cases = [
    { testcaseId: 21187, num: 2, input: '5 5', output: '10' },
    { testcaseId: 21186, num: 1, input: '1 2\r\n', output: '3\n' },
  ];

  function workspace() {
    const dir = mkdtempSync(join(tmpdir(), 'cphimp-'));
    const src = join(dir, 'sol.cpp');
    writeFileSync(src, '');
    return { dir, src, prob: cphProbPath(src) };
  }

  it('creates a .prob in CPH format with the problem name and grader URL', async () => {
    const { src, prob } = workspace();
    const r = await importIntoCph({ srcPath: src, problemName: '00_Intro_11', problemUrl: `${BASE}/submissions/direct_edit_problem/1360`, cases });
    expect(r).toMatchObject({ created: true, backupPath: null, added: 2, alreadyPresent: 0, total: 2 });
    const raw = readFileSync(prob, 'utf8');
    expect(raw.startsWith('{"name"')).toBe(true); // plain JSON.stringify like CPH
    const p = JSON.parse(raw) as CphProblem;
    expect(p).toMatchObject({ name: '00_Intro_11', url: `${BASE}/submissions/direct_edit_problem/1360`, srcPath: src, interactive: false, memoryLimit: 1024, timeLimit: 3000, group: 'local', local: true });
    // sorted by num, line endings normalized, trailing newline kept, ids marked
    expect(p.tests).toEqual([
      { id: GRADER_ID_BASE + 21186, input: '1 2\n', output: '3\n' },
      { id: GRADER_ID_BASE + 21187, input: '5 5', output: '10' },
    ]);
  });

  it('merges into an existing .prob (sanitized real file): backup, own tests first, no duplicates on re-import', async () => {
    const { src, prob } = workspace();
    mkdirSync(join(prob, '..'), { recursive: true });
    const existing = JSON.parse(fixture('cph_local.prob')) as CphProblem;
    writeFileSync(prob, JSON.stringify({ ...existing, srcPath: src, url: src }));
    const original = readFileSync(prob, 'utf8');

    const r1 = await importIntoCph({ srcPath: src, problemName: 'x', problemUrl: 'u', cases });
    expect(r1).toMatchObject({ created: false, added: 2, total: 4 });
    expect(r1.backupPath).toBe(`${prob}.bak`);
    expect(readFileSync(`${prob}.bak`, 'utf8')).toBe(original);
    const p = JSON.parse(readFileSync(prob, 'utf8')) as CphProblem;
    expect(p.tests.slice(0, 2)).toEqual(existing.tests); // my tests untouched, first
    expect(p.name).toBe('Local: test'); // existing metadata kept

    const r2 = await importIntoCph({ srcPath: src, problemName: 'x', problemUrl: 'u', cases });
    expect(r2).toMatchObject({ added: 0, alreadyPresent: 2, updated: 0, total: 4 });

    // A changed grader case is updated in place (found by its marked id).
    const r3 = await importIntoCph({ srcPath: src, problemName: 'x', problemUrl: 'u', cases: [{ ...cases[0], output: '11' }] });
    expect(r3).toMatchObject({ updated: 1, added: 0, total: 4 });
  });

  it('a case equal to one of my own tests is not added again', async () => {
    const { src, prob } = workspace();
    mkdirSync(join(prob, '..'), { recursive: true });
    writeFileSync(prob, JSON.stringify({ name: 'x', url: src, tests: [{ id: 1, input: '5 5', output: '10' }], interactive: false, memoryLimit: 1024, timeLimit: 3000, srcPath: src, group: 'local', local: true }));
    const r = await importIntoCph({ srcPath: src, problemName: 'x', problemUrl: 'u', cases: [cases[0]] });
    expect(r).toMatchObject({ added: 0, alreadyPresent: 1, total: 1 });
  });

  it('an unreadable .prob is left alone', async () => {
    const { src, prob } = workspace();
    mkdirSync(join(prob, '..'), { recursive: true });
    writeFileSync(prob, '{broken');
    await expect(importIntoCph({ srcPath: src, problemName: 'x', problemUrl: 'u', cases })).rejects.toThrow(/not changed/);
    expect(readFileSync(prob, 'utf8')).toBe('{broken');
    expect(existsSync(`${prob}.bak`)).toBe(false);
  });

  it('honours cph.general.saveLocation', async () => {
    const { src } = workspace();
    const save = mkdtempSync(join(tmpdir(), 'cphsave-'));
    const r = await importIntoCph({ srcPath: src, saveLocation: save, problemName: 'x', problemUrl: 'u', cases });
    expect(r.probPath.startsWith(save)).toBe(true);
  });

  it('normalizeEol', () => {
    expect(normalizeEol('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });
});

describe('test case download (TestcaseStore)', () => {
  async function setup() {
    const server = new FakeGrader();
    const client = new GraderClient({ baseUrl: 'https://grader.test', fetch: server.fetch, getStoredCredentials: async () => ({ username: 's', password: 'pw' }), sleep: async () => {} });
    await client.login({ username: 's', password: 'pw' });
    const store = new TestcaseStore(mkdtempSync(join(tmpdir(), 'tc-')), () => client);
    return { server, store };
  }

  it('downloads one at a time, caches per problem; second import makes no request', async () => {
    const { server, store } = await setup();
    const progress: string[] = [];
    const r = await store.get(201, { onProgress: (d, t) => progress.push(`${d}/${t}`) });
    expect(r).toMatchObject({ status: 'ok', fromCache: false });
    expect(server.maxParallelTestcase).toBe(1);
    expect(server.testcaseLog).toEqual(['21186/input', '21186/sol', '21187/input', '21187/sol']);
    expect(progress).toEqual(['0/2', '1/2', '2/2']);
    const n = server.requests.length;
    const again = await store.get(201);
    expect(again).toMatchObject({ status: 'ok', fromCache: true });
    expect(server.requests.length).toBe(n);
    await store.get(201, { refresh: true });
    expect(server.testcaseLog).toHaveLength(8);
  });

  it('never imports truncated cases (input or sol)', async () => {
    const { server, store } = await setup();
    server.testcases = [
      { id: 1, num: 1, input: 'a', sol: 'b' },
      { id: 2, num: 2, input: 'very large input', sol: 'x', truncated: 'input' },
      { id: 3, num: 3, input: 'c', sol: 'very large answer', truncated: 'sol' },
    ];
    const r = await store.get(300);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.set.cases.map((c) => c.testcaseId)).toEqual([1]);
    expect(r.set.truncated).toEqual([{ testcaseId: 2, num: 2 }, { testcaseId: 3, num: 3 }]);
    expect(server.testcaseLog).not.toContain('2/sol'); // no point fetching the answer of a cut input
  });

  it('403 → not available (not an error)', async () => {
    const { server, store } = await setup();
    server.testcases = 403;
    expect(await store.get(201)).toEqual({ status: 'not-available' });
  });
});

describe('copy of a real CPH fixture is in the confirmed format', () => {
  it('has exactly the CPH fields', () => {
    const p = JSON.parse(fixture('cph_local.prob'));
    expect(Object.keys(p).sort()).toEqual(['group', 'interactive', 'local', 'memoryLimit', 'name', 'srcPath', 'tests', 'timeLimit', 'url']);
    expect(Object.keys(p.tests[0]).sort()).toEqual(['id', 'input', 'output']);
  });
});


