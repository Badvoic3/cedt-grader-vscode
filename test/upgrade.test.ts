/**
 * Upgrading from an older version keeps working: data written by v0.7.0
 * (`.cedt-grader.json`, saved problem lists, CPH files with imported tests)
 * reads the same with the current code, and nothing is turned into a folder
 * link or rewritten just by being read.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripGraderKey } from '../src/data/testcaseStore';
import { normalizeProblem } from '../src/grader/types';
import { cphProbPath } from '../src/mapping/cph';
import { GRADER_ID_BASE, importIntoCph, type GraderCase } from '../src/mapping/cphImport';
import { parseMappingFile, serializeMappingFile } from '../src/mapping/mappingFile';
import { type LocatedEntry, nearestFolderLink } from '../src/mapping/mappingOps';

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
  it('an old .cedt-grader.json reads the same and is written back byte for byte', () => {
    const d = parseMappingFile(V070_MAPPING);
    expect(Object.keys(d.files)).toEqual(['hw/a.cpp', 'hw/pkg/main.cpp', 'old/gone.cpp']);
    for (const e of Object.values(d.files)) expect(e).not.toHaveProperty('folder');
    expect(serializeMappingFile(d)).toBe(V070_MAPPING);
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

  it('tests imported into CPH by an older version (with the KEY line) are updated in place on the next import', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedt-upgrade-'));
    const src = join(dir, 'main.cpp');
    writeFileSync(src, 'int main() {}\n');
    const graderCases: GraderCase[] = [
      { testcaseId: 1, num: 1, input: '3\n', output: '1\n2\nKEY: abc\n' },
      { testcaseId: 2, num: 2, input: '4\n', output: '0\nKEY: abc\n' },
    ];
    await importIntoCph({ srcPath: src, problemName: 'p', problemUrl: 'u', cases: graderCases }); // what the old version wrote
    const { cases, key } = stripGraderKey(graderCases, readFileSync(src, 'utf8'));
    expect(key).toBe('abc');
    const r = await importIntoCph({ srcPath: src, problemName: 'p', problemUrl: 'u', cases });
    expect([r.added, r.updated]).toEqual([0, 2]);
    const prob = JSON.parse(readFileSync(cphProbPath(src), 'utf8')) as { tests: { id: number; output: string }[] };
    expect(prob.tests.map((t) => [t.id - GRADER_ID_BASE, t.output])).toEqual([
      [1, '1\n2\n'],
      [2, '0\n'],
    ]);
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
