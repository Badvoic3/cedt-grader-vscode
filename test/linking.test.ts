import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TestcaseStore } from '../src/data/testcaseStore';
import { GraderClient, type Problem } from '../src/grader';
import { cleanName, decideSuggestion, fileNameFor, normalizeName, resolveProblem, scoreCandidates, suggest } from '../src/mapping/match';
import { MATCH } from '../src/shared/constants';
import { createFileNoOverwrite } from '../src/mapping/newFile';
import { FakeGrader } from './fakeServer';
import { fixture } from './helpers';

const BASE = 'https://cedt-grader.nattee.net';
const P = (id: number, name: string, fullName = name): Problem => ({
  id, name, fullName, bestScore: null, lastScore: null, lastResult: null, lastSubmissionId: null, lastSubmissionTime: null,
  submissionCount: 0, hasTestcase: true, hasAttachment: false, permittedLanguageIds: null, tags: [], list: null,
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
    resolveProblem({ savedProblemId: null, filePath: '/w/x.cpp', problems, baseUrl: BASE, ...over });

  it('1. a saved mapping always wins', () => {
    const r = m({ savedProblemId: 1759, filePath: '/w/00_Intro_11.cpp' });
    expect(r).toMatchObject({ kind: 'match', source: 'saved', problem: { id: 1759 } });
  });

  it('saved link whose problem is missing from the list → unavailable (kept, not replaced)', () => {
    const r = m({ savedProblemId: 999, filePath: '/w/00_Intro_11.cpp' });
    expect(r).toMatchObject({ kind: 'unavailable', problemId: 999 });
    expect((r as { suggestions: Problem[] }).suggestions.map((p) => p.id)).toContain(1360);
  });

  it('saved mapping is kept while the problem list is not loaded yet', () => {
    expect(m({ savedProblemId: 999, problems: undefined })).toMatchObject({ kind: 'match', source: 'saved', problem: { id: 999 } });
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

  it('4a. a confident suggestion (score ≥ MATCH.suggestMinScore, clearly ahead) is used as "suggested"', () => {
    const r = m({ filePath: '/w/da68_f2_closed.cpp' });
    expect(r).toMatchObject({ kind: 'match', source: 'suggested', problem: { id: 1734 } });
  });

  it('4b. two candidates close in score → "Several problems could match", none picked', () => {
    const r = m({ filePath: '/w/01_expr.cpp' });
    expect(r.kind).toBe('ambiguous');
    expect((r as { source: string }).source).toBe('suggested');
    expect((r as { candidates: Problem[] }).candidates.map((p) => p.id).sort()).toEqual([1271, 1272]);
  });

  it('4c. below the threshold: not used; candidates only for the picker', () => {
    const r = m({ filePath: '/w/closed.cpp' });
    expect(r.kind).toBe('none');
    expect(decideSuggestion(scoreCandidates('closed', problems))).toEqual({ kind: 'below' });
    expect(suggest('totally_unrelated', problems)).toEqual([]);
  });

  it('4d. folder named like a problem tag adds MATCH.folderTagBonus (can break a tie)', () => {
    const tagged = problems.map((p) => (p.id === 1272 ? { ...p, tags: ['Expr'] } : p));
    const plain = scoreCandidates('01_expr', tagged);
    const inFolder = scoreCandidates('01_expr', tagged, ['hw', 'expr']);
    const s = (xs: typeof plain, id: number) => xs.find((x) => x.p.id === id)!.score;
    expect(s(inFolder, 1272) - s(plain, 1272)).toBeCloseTo(MATCH.folderTagBonus);
    expect(s(inFolder, 1271)).toBe(s(plain, 1271));
    expect(m({ filePath: '/w/expr/01_expr.cpp', problems: tagged, folders: ['expr'] })).toMatchObject({ kind: 'match', source: 'suggested', problem: { id: 1272 } });
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


