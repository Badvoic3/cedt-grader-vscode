import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Problem } from '../src/grader';
import { cphProbPath, matchCphProblem, readCphProblem } from '../src/mapping/cph';
import { lookup, parseMappingFile, serializeMappingFile } from '../src/mapping/mappingFile';

const BASE = 'https://cedt-grader.nattee.net';
const P = (id: number, name: string, fullName = name): Problem => ({
  id, name, fullName, bestScore: null, lastScore: null, lastResult: null, lastSubmissionId: null, lastSubmissionTime: null,
  submissionCount: 0, hasTestcase: false, hasAttachment: false, permittedLanguageIds: null, tags: [], list: null,
});
const problems = [P(1360, '00_Intro_11', '00_Intro_★_Hello_World'), P(1759, 'DigLo69_Exam2__1'), P(1271, '01_Expr_11')];

describe('.cedt-grader.json', () => {
  it('round-trips and normalizes paths', () => {
    const d = parseMappingFile(JSON.stringify({ version: 1, files: { '.\\a\\b.cpp': { problemId: 1360, name: '00_Intro_11' } } }));
    expect(Object.keys(d.files)).toEqual(['a/b.cpp']);
    expect(parseMappingFile(serializeMappingFile(d))).toEqual(d);
  });

  it('ignores garbage and invalid entries', () => {
    expect(parseMappingFile('not json').files).toEqual({});
    expect(parseMappingFile('{"files":{"x.cpp":{"problemId":"7"},"y.cpp":{"problemId":-1}}}').files).toEqual({});
  });

  it('ignores entries for another server', () => {
    const d = parseMappingFile(JSON.stringify({ files: { 'a.cpp': { problemId: 1, name: 'x', baseUrl: 'https://other' } } }));
    expect(lookup(d, 'a.cpp', BASE)).toBeUndefined();
    expect(lookup(d, 'a.cpp', 'https://other')?.problemId).toBe(1);
  });
});

describe('CPH .prob files', () => {
  it('computes the same path as CPH (md5 of the full source path)', () => {
    // From the user's workspace: .cph/.test.cpp_d91f7014ebc867db60a02993b068a793.prob
    expect(cphProbPath('/Users/badvoic3/Documents/project/test.cpp')).toBe(
      '/Users/badvoic3/Documents/project/.cph/.test.cpp_d91f7014ebc867db60a02993b068a793.prob',
    );
    expect(cphProbPath('/x/y/a.cpp', '/save')).toMatch(/^\/save\/\.a\.cpp_[0-9a-f]{32}\.prob$/);
  });

  it('reads a .prob file and returns null when missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cph-'));
    const src = join(dir, 'sol.cpp');
    mkdirSync(join(dir, '.cph'));
    const prob = { name: 'Local: sol', url: src, tests: [{ id: 1, input: '1', output: '2' }], interactive: false, memoryLimit: 1024, timeLimit: 3000, srcPath: src, group: 'local', local: true };
    writeFileSync(cphProbPath(src), JSON.stringify(prob));
    expect(await readCphProblem(src)).toEqual(prob);
    expect(await readCphProblem(join(dir, 'other.cpp'))).toBeNull();
  });

  it('matches a grader URL on the same host', () => {
    const cph = { name: 'whatever', url: `${BASE}/submissions/direct_edit_problem/1759`, tests: [] } as never;
    expect(matchCphProblem(cph, problems, BASE)?.id).toBe(1759);
  });

  it('matches "Local: <problem name>" and ignores other hosts / ambiguous names', () => {
    const local = (name: string, url = '/tmp/x.cpp') => ({ name, url, tests: [] }) as never;
    expect(matchCphProblem(local('Local: 00_Intro_11'), problems, BASE)?.id).toBe(1360);
    expect(matchCphProblem(local('Local: test'), problems, BASE)).toBeNull();
    expect(matchCphProblem(local('x', 'https://codeforces.com/problemset/problem/1360/A'), problems, BASE)).toBeNull();
    expect(matchCphProblem(local('Local: dup'), [P(1, 'dup'), P(2, 'dup')], BASE)).toBeNull();
  });
});
