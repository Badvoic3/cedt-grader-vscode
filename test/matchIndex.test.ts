import { describe, expect, it } from 'vitest';
import type { Problem } from '../src/grader';
import { resolveProblem } from '../src/mapping/match';
import { buildMatchIndex, matchFile, type SourceFile } from '../src/mapping/matchIndex';

const BASE = 'https://grader.example';
const P = (id: number, name: string, fullName = name, tags: string[] = []): Problem => ({
  id, name, fullName, bestScore: null, lastScore: null, lastResult: null, lastSubmissionId: null, lastSubmissionTime: null,
  submissionCount: 0, hasTestcase: true, hasAttachment: false, permittedLanguageIds: null, tags, list: null,
});
const problems = [
  P(1, '00_Intro_11', '00_Intro_★_Hello_World'),
  P(2, '01_Expr_11'),
  P(3, '01_Expr_12', '01_Expr_12', ['Expr']),
  P(4, 'da68_f2_zero_one_subset_sum'),
  P(5, 'da68_f2_closed_city', 'เมืองปิด'),
  P(6, 'hw03_binary_search'),
];
const F = (fsPath: string, folders: string[] = []): SourceFile => ({ fsPath, folders });

/** Fixture files: exact names in different spellings, suggestions, a tie, below threshold, folder/tag bonus. */
const files = [
  F('/w/00_Intro_11.cpp'),
  F('/w/hw/00 intro-11.CPP', ['hw']),
  F('/w/data algo/da68_f2_zero_one_subset_sum.cpp', ['data algo']),
  F('/w/i2cedt/DA68-F2-Zero.One.Subset_Sum.py', ['i2cedt']),
  F('/w/da68_f2_closed.cpp'), // confident suggestion → 5
  F('/w/01_expr.cpp'), // tie 2 / 3 → nobody
  F('/w/expr/01_expr.cpp', ['expr']), // folder named like 3's tag → 3
  F('/w/scratch/closed.cpp', ['scratch']), // below the threshold → nobody
  F('/w/notes.txt.cpp'),
  F('/w/hw03-binary-search.c'),
  // Folder mode: files inside a folder named like a problem (a package: driver + headers).
  F('/w/pkg/da68_f2_closed_city/main.cpp', ['pkg', 'da68_f2_closed_city']), // exact folder name → 5
  F('/w/pkg/da68_f2_closed_city/student.h', ['pkg', 'da68_f2_closed_city']), // any file of the folder → 5
  F('/w/hw03_binary_search_pkg/main.cpp', ['hw03_binary_search_pkg']), // confident suggestion from the folder → 6
  F('/w/01_Expr_11/00_Intro_11.cpp', ['01_Expr_11']), // the file's own name wins over its folder → 1
  F('/w/expr/main.cpp', ['expr']), // folder named like nothing → nobody
  F('/w/main.cpp'), // top of the workspace: no folder step → nobody
];

describe('one matcher: problem → file gives the same answer as file → problem', () => {
  const index = buildMatchIndex(files, problems, BASE);

  it('for every fixture file, the index lists it under exactly the problem it resolves to (or nowhere)', () => {
    for (const f of files) {
      const r = resolveProblem({ savedProblemId: null, filePath: f.fsPath, problems, baseUrl: BASE, folders: f.folders });
      const owner = r.kind === 'match' ? r.problem.id : null;
      const listedUnder = [...index.entries()].filter(([, fs]) => fs.some((x) => x.fsPath === f.fsPath)).map(([id]) => id);
      expect(listedUnder, f.fsPath).toEqual(owner === null ? [] : [owner]);
      expect(matchFile(f, problems, BASE)?.problemId ?? null, f.fsPath).toBe(owner);
    }
  });

  it('for every problem, clicking it finds exactly the files that show it when opened', () => {
    for (const p of problems) {
      const opened = files.filter((f) => matchFile(f, problems, BASE)?.problemId === p.id).map((f) => f.fsPath).sort();
      expect((index.get(p.id) ?? []).map((x) => x.fsPath).sort(), p.name).toEqual(opened);
    }
  });

  it('the expected answers for the fixture pairs', () => {
    const ids = (id: number) => (index.get(id) ?? []).map((x) => `${x.fsPath} (${x.how})`).sort();
    expect(ids(1)).toEqual(['/w/00_Intro_11.cpp (filename)', '/w/01_Expr_11/00_Intro_11.cpp (filename)', '/w/hw/00 intro-11.CPP (filename)']);
    expect(ids(4)).toEqual(['/w/data algo/da68_f2_zero_one_subset_sum.cpp (filename)', '/w/i2cedt/DA68-F2-Zero.One.Subset_Sum.py (filename)']);
    expect(ids(5)).toEqual(['/w/da68_f2_closed.cpp (suggested)', '/w/pkg/da68_f2_closed_city/main.cpp (folder)', '/w/pkg/da68_f2_closed_city/student.h (folder)']);
    expect(ids(3)).toEqual(['/w/expr/01_expr.cpp (suggested)']); // folder/tag bonus breaks the tie
    expect(ids(2)).toEqual([]); // the bare tie goes to nobody
    expect(ids(6)).toEqual(['/w/hw03-binary-search.c (filename)', '/w/hw03_binary_search_pkg/main.cpp (suggested)']);
  });

  it('folder step: exact folder name is its own source; ties between folder names ask', () => {
    const r = resolveProblem({ savedProblemId: null, filePath: '/w/x/01_expr_11/main.cpp', problems, baseUrl: BASE, folders: ['x', '01_expr_11'] });
    expect(r.kind === 'match' && r.source).toBe('folder');
    const twins = [...problems, P(7, 'dup_pkg'), P(8, 'DUP-PKG')];
    const t = resolveProblem({ savedProblemId: null, filePath: '/w/dup_pkg/main.cpp', problems: twins, baseUrl: BASE, folders: ['dup_pkg'] });
    expect(t).toMatchObject({ kind: 'ambiguous', source: 'folder' });
    // A folder named by the file-name pattern ("{id}_{name}") is exact too.
    const pat = resolveProblem({ savedProblemId: null, filePath: '/w/6_hw03_binary_search/main.cpp', problems, baseUrl: BASE, folders: ['6_hw03_binary_search'], namePattern: '{id}_{name}.{ext}' });
    expect(pat.kind === 'match' && [pat.problem.id, pat.source]).toEqual([6, 'folder']);
  });

  it('no problems loaded → empty index (nothing guessed)', () => {
    expect(buildMatchIndex(files, [], BASE).size).toBe(0);
  });
});
