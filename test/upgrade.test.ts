/**
 * Upgrading from an older version keeps working: data written by v0.7.0
 * (`.cedt-grader.json`, saved problem lists)
 * reads the same with the current code, and nothing is turned into a folder
 * link just by being read.
 */
import { describe, expect, it } from 'vitest';
import type { GraderCase } from '../src/mapping/testCases';
import { stripGraderKey } from '../src/data/testcaseStore';
import { normalizeProblem } from '../src/grader/types';
import { type LocatedEntry, nearestFolderLink } from '../src/mapping/mappingOps';
import { collectOldLinks, parseMappingFile } from '../src/migration/oldLinks';

/** `.cedt-grader.json` exactly as v0.7.0 writes it (file links only; a stale one; another server). */
const V070_MAPPING =
  JSON.stringify(
    {
      version: 1,
      files: {
        'hw/a.cpp': { problemId: 11, name: 'p11' },
        'hw/pkg/main.cpp': { problemId: 12, name: 'p12', baseUrl: 'https://grader.example' },
        'old/gone.cpp': { problemId: 13, name: 'p13', staleSince: '2026-10-01T00:00:00.000Z' },
      },
    },
    null,
    2,
  ) + '\n';

describe('upgrade from v0.7.0', () => {
  it('an old .cedt-grader.json reads the same', () => {
    const d = parseMappingFile(V070_MAPPING);
    expect(Object.keys(d.files)).toEqual(['hw/a.cpp', 'hw/pkg/main.cpp', 'old/gone.cpp']);
    for (const e of Object.values(d.files)) expect(e).not.toHaveProperty('folder');
  });

  it('old file links never act as folder links', () => {
    const d = parseMappingFile(V070_MAPPING);
    const located: LocatedEntry[] = Object.entries(d.files).map(([rel, entry]) => ({ fsPath: `/w/${rel}`, entry }));
    expect(nearestFolderLink(located, '/w/hw/pkg/main.cpp/x.h', false)).toBeUndefined();
    expect(nearestFolderLink(located, '/w/hw/a.cpp', false)).toBeUndefined();
  });

  it('a problem list saved by an older version gets every current field', () => {
    const p = normalizeProblem({ id: 5, name: 'x', bestScore: 70 } as never);
    expect(p).toMatchObject({ id: 5, name: 'x', bestScore: 70, hasAttachment: false, hasTestcase: false, tags: [], permittedLanguageIds: null, list: null });
  });

});

describe('old links, gathered for the link table', () => {
  const file = (folder: string, files: object) => ({ folder, text: JSON.stringify({ version: 1, files }) });

  it('a v0.7.0 file gives full paths, keeping server and staleness', () => {
    const links = collectOldLinks({ files: [{ folder: '/w', text: V070_MAPPING }] });
    expect(links.map((l) => l.fsPath)).toEqual(['/w/hw/a.cpp', '/w/hw/pkg/main.cpp', '/w/old/gone.cpp']);
    expect(links[1].baseUrl).toBe('https://grader.example');
    expect(links[2].staleSince).toBe('2026-10-01T00:00:00.000Z');
    for (const l of links) expect(l).not.toHaveProperty('outside');
  });

  it('a v1.0.0 folder link keeps its roles, and "." is the folder itself', () => {
    const [root, pkg] = collectOldLinks({
      files: [file('/w', { '.': { problemId: 1, name: 'r', folder: true }, pkg: { problemId: 2, name: 'p', folder: true, submitFile: 'student.h', runFile: 'main.cpp' } })],
    });
    expect(root).toMatchObject({ fsPath: '/w', folder: true });
    expect(pkg).toEqual({ problemId: 2, name: 'p', folder: true, submitFile: 'student.h', runFile: 'main.cpp', fsPath: '/w/pkg' });
  });

  it('state wins over the file, as it did in the old store', () => {
    const links = collectOldLinks({
      workspaceState: { 'w/a.cpp': { problemId: 7, name: 'state', fsPath: '/w/a.cpp' } },
      files: [file('/w', { 'a.cpp': { problemId: 8, name: 'file' } })],
    });
    expect(links).toEqual([{ problemId: 7, name: 'state', fsPath: '/w/a.cpp' }]);
  });

  it('global links stay visible in every window; first-version keys are read; broken entries are skipped', () => {
    const links = collectOldLinks({
      globalState: { '/o/a.cpp': { problemId: 1, name: 'a', fsPath: '/o/a.cpp' }, bad: { problemId: 2, name: 'no path' } },
      workspaceLegacy: { '/w/old.cpp': { problemId: 3, name: 'old' }, '/w/bad.cpp': { problemId: -1, name: 'x' } },
    });
    expect(links).toEqual([
      { problemId: 3, name: 'old', fsPath: '/w/old.cpp' },
      { problemId: 1, name: 'a', fsPath: '/o/a.cpp', outside: true },
    ]);
  });

  it('a file outside the folder is ignored', () => {
    expect(collectOldLinks({ files: [file('/w', { '../x.cpp': { problemId: 1, name: 'x' } })] })).toEqual([]);
  });
});

describe("the grader's KEY line (printed only by the grader's own main)", () => {
  const C = (output: string, id = 1): GraderCase => ({ testcaseId: id, num: id, input: '', output });

  it('removed when every case ends with the same KEY line', () => {
    const r = stripGraderKey([C('1\n2\n-1\nKEY: Hh2hNML\n', 1), C('0\nKEY: Hh2hNML', 2)]);
    expect(r.key).toBe('Hh2hNML');
    expect(r.cases.map((c) => c.output)).toEqual(['1\n2\n-1\n', '0\n']);
  });

  it('kept when the keys differ, a case has none, or there is none at all', () => {
    for (const cases of [[C('1\nKEY: a\n', 1), C('2\nKEY: b\n', 2)], [C('1\nKEY: a\n', 1), C('2\n', 2)], [C('3\n')], []]) {
      expect(stripGraderKey(cases)).toEqual({ cases, key: null });
    }
  });

  it('kept when the program prints that key itself; a KEY line in the middle is output', () => {
    const cases = [C('1\nKEY: abc\n')];
    expect(stripGraderKey(cases, 'cout << "KEY: abc";').key).toBeNull();
    expect(stripGraderKey([C('KEY: abc\n1\n')]).key).toBeNull();
  });
});
