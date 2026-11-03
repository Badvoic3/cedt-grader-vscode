/**
 * The one test-case pipeline (src/mapping/testCases.ts + writeCases.ts):
 * grader cases and statement samples reach CPH or files with the same rules.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cphProbPath, type CphProblem } from '../src/mapping/cph';
import { CASE_MARKERS, GRADER_ID_BASE, saveTestcasesAsFiles, STATEMENT_ID_BASE, testsFolderOf } from '../src/mapping/testCases';
import { caseCounts, writeCases } from '../src/mapping/writeCases';
import { S } from '../src/shared/strings';

const grader = [
  { testcaseId: 11, num: 1, input: '1 2\n', output: '3\n' },
  { testcaseId: 12, num: 2, input: '5 5\n', output: '10\n' },
];
const samples = [
  { testcaseId: 1, num: 1, input: '1 2\n', output: '3\n' }, // the same as grader case 1
  { testcaseId: 2, num: 2, input: '0 0\n', output: '0\n' },
];

describe('markers', () => {
  it('each kind has its own CPH id range and file prefix', () => {
    expect(CASE_MARKERS.grader).toEqual({ idBase: GRADER_ID_BASE, filePrefix: '' });
    expect(CASE_MARKERS.sample).toEqual({ idBase: STATEMENT_ID_BASE, filePrefix: 'sample' });
  });

  it('tests folder: <folder>/tests in folder mode, else <dir>/<problem>/tests', () => {
    expect(testsFolderOf('/w/pkg/main.cpp', '/w/pkg', 'p')).toBe(join('/w/pkg', 'tests'));
    expect(testsFolderOf('/w/a.cpp', null, '00_Intro')).toBe(join('/w', '00_Intro', 'tests'));
  });
});

describe('CPH target', () => {
  it('grader cases then samples: duplicates skipped across kinds, backup written, counts reported', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipe-cph-'));
    const src = join(dir, 'a.cpp');
    writeFileSync(src, '');
    const target = { kind: 'cph', srcPath: src, problemName: 'a', problemUrl: 'u' } as const;
    const r1 = await writeCases(target, grader, 'grader');
    expect(r1).toMatchObject({ target: 'cph', added: 2, alreadyPresent: 0, backupPath: null, total: 2 });
    const r2 = await writeCases(target, samples, 'sample');
    expect(r2).toMatchObject({ target: 'cph', added: 1, alreadyPresent: 1, total: 3, backupPath: `${cphProbPath(src)}.bak` });
    const p = JSON.parse(readFileSync(cphProbPath(src), 'utf8')) as CphProblem;
    expect(p.tests.map((t) => t.id)).toEqual([GRADER_ID_BASE + 11, GRADER_ID_BASE + 12, STATEMENT_ID_BASE + 2]);
    expect(caseCounts(r2)).toEqual([S.testcases.alreadyPresent(1), S.testcases.added(1)]);
  });
});

describe('files target', () => {
  it('a sample equal to a grader case already in the folder is skipped, not written again', async () => {
    const folder = join(mkdtempSync(join(tmpdir(), 'pipe-files-')), 'tests');
    const r1 = await writeCases({ kind: 'files', folder }, grader, 'grader');
    expect(r1).toMatchObject({ target: 'files', written: 2, alreadyPresent: 0 });
    const r2 = await writeCases({ kind: 'files', folder }, samples, 'sample');
    expect(r2).toMatchObject({ written: 1, unchanged: 0, alreadyPresent: 1, keptExisting: 0 });
    expect(readdirSync(folder).sort()).toEqual(['1.in', '1.out', '2.in', '2.out', 'sample2.in', 'sample2.out']);
    expect(caseCounts(r2)).toEqual([S.testcases.alreadyPresent(1)]);
  });

  it('duplicates inside one batch are written once; line endings compared normalized', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'pipe-batch-'));
    const r = await saveTestcasesAsFiles(folder, [
      { testcaseId: 1, num: 1, input: '1\r\n', output: '1\n' },
      { testcaseId: 2, num: 2, input: '1\n', output: '1\n' },
    ]);
    expect(r).toMatchObject({ written: 1, alreadyPresent: 1 });
    expect(readdirSync(folder).sort()).toEqual(['1.in', '1.out']);
  });

  it('a half pair (only .in) is no duplicate; an edited file is never overwritten', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'pipe-half-'));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, '7.in'), '1 2\n'); // no 7.out
    writeFileSync(join(folder, '2.out'), 'mine\n');
    const r = await saveTestcasesAsFiles(folder, grader);
    expect(r).toMatchObject({ written: 2, alreadyPresent: 0, keptExisting: 0 });
    expect(readFileSync(join(folder, '2.out'), 'utf8')).toBe('mine\n');
    expect(caseCounts({ target: 'files', folder, written: 0, unchanged: 1, keptExisting: 2, alreadyPresent: 0 })).toEqual([S.testcases.unchanged(1), S.testcases.keptExisting(2)]);
  });
});
