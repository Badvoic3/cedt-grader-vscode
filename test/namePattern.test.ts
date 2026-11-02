import { describe, expect, it } from 'vitest';
import type { Problem } from '../src/grader';
import { fileNameFor, resolveProblem } from '../src/mapping/match';
import { buildMatchIndex, matchFile, type SourceFile } from '../src/mapping/matchIndex';
import { applyPattern, checkPattern, DEFAULT_NAME_PATTERN } from '../src/mapping/namePattern';
import { nameMatchesProblem, renameProposal } from '../src/mapping/renameToProblem';
import { EN, S } from '../src/shared/strings';

const BASE = 'https://grader.example';
const P = (id: number, name: string, fullName = name): Problem => ({
  id, name, fullName, bestScore: null, lastScore: null, lastResult: null, lastSubmissionId: null, lastSubmissionTime: null,
  submissionCount: 0, hasTestcase: true, hasAttachment: false, permittedLanguageIds: null, tags: [], list: null,
});
const problems = [P(1360, '00_Intro_11', '00_Intro_★_Hello_World'), P(1271, '01_Expr_11'), P(1272, '01_Expr_12'), P(9, 'a/b:c')];
const F = (fsPath: string): SourceFile => ({ fsPath, folders: [] });
const ID_NAME = '{id}_{name}.{ext}';

describe('checkPattern', () => {
  it('accepts the default, empty (→ default) and patterns with {name} / {id} ending in .{ext}', () => {
    expect(checkPattern(undefined)).toEqual({ pattern: DEFAULT_NAME_PATTERN, problem: null });
    expect(checkPattern('  ')).toEqual({ pattern: DEFAULT_NAME_PATTERN, problem: null });
    for (const p of ['{name}.{ext}', '{id}_{name}.{ext}', 'hw-{id}.{ext}', 'P {id} {name}.v2.{ext}']) expect(checkPattern(p)).toEqual({ pattern: p, problem: null });
  });

  it('falls back to the default and says why', () => {
    expect(checkPattern('{name}')).toMatchObject({ pattern: DEFAULT_NAME_PATTERN, problem: 'ext' });
    expect(checkPattern('{name}.{ext}.bak')).toMatchObject({ problem: 'ext' });
    expect(checkPattern('{ext}.{ext}')).toMatchObject({ problem: 'ext' });
    expect(checkPattern('solution.{ext}')).toMatchObject({ problem: 'nameOrId' });
    expect(checkPattern('{title}.{ext}')).toMatchObject({ problem: 'placeholder' });
    expect(checkPattern('{name.{ext}')).toMatchObject({ problem: 'placeholder' });
    expect(checkPattern('week1/{name}.{ext}')).toMatchObject({ problem: 'character' });
    expect(checkPattern('{name}?.{ext}')).toMatchObject({ problem: 'character' });
  });

  it('every reason has a message', () => {
    for (const why of ['ext', 'nameOrId', 'placeholder', 'character']) expect(EN.S.files.patternProblem[why]).toBeTruthy();
    expect(S.files.badPattern('x')).toContain('{name}.{ext}');
  });
});

describe('names from the pattern', () => {
  it('default is unchanged; {id} and literal text are filled in; unsafe characters replaced', () => {
    expect(fileNameFor('00_Intro_11', 'cpp')).toBe('00_Intro_11.cpp');
    expect(fileNameFor('00_Intro_11', 'cpp', ID_NAME, 1360)).toBe('1360_00_Intro_11.cpp');
    expect(fileNameFor('a/b:c', '.py', 'hw-{id}-{name}.{ext}', 9)).toBe('hw-9-a_b_c.py');
    expect(applyPattern('{id}.{ext}', { id: 7, cleanName: 'x' }, 'java')).toBe('7.java');
  });

  it('rename proposal and "already matches" follow the pattern', () => {
    expect(renameProposal('/w/sol.cpp', '00_Intro_11', ID_NAME, 1360)).toBe('1360_00_Intro_11.cpp');
    expect(nameMatchesProblem('/w/1360_00_Intro_11.cpp', '00_Intro_11', ID_NAME, 1360)).toBe(true);
    // The plain problem name still counts as matching (no rename offered).
    expect(nameMatchesProblem('/w/00_Intro_11.cpp', '00_Intro_11', ID_NAME, 1360)).toBe(true);
    expect(nameMatchesProblem('/w/1360_00_Intro_11.cpp', '00_Intro_11')).toBe(false);
  });
});

describe('matcher with a pattern (one rule, both directions)', () => {
  const files = [F('/w/1360_00_Intro_11.cpp'), F('/w/1271_01-expr-11.py'), F('/w/01_Expr_12.cpp'), F('/w/1360_notes.cpp'), F('/w/sol.cpp')];

  it('a file named by the pattern is "Matched by file name"', () => {
    const r = resolveProblem({ savedProblemId: null, cph: null, filePath: '/w/1360_00_Intro_11.cpp', problems, baseUrl: BASE, namePattern: ID_NAME });
    expect(r).toMatchObject({ kind: 'match', source: 'filename', problem: { id: 1360 } });
    // Without the pattern it's at most a suggestion.
    const plain = resolveProblem({ savedProblemId: null, cph: null, filePath: '/w/1360_00_Intro_11.cpp', problems, baseUrl: BASE });
    expect(plain.kind === 'match' ? plain.source : plain.kind).not.toBe('filename');
  });

  it('normalization applies (case, - _ . and spaces)', () => {
    expect(matchFile(F('/w/1271_01-expr-11.py'), problems, BASE, ID_NAME)).toEqual({ problemId: 1271, how: 'filename' });
  });

  it('plain problem names still match exactly under a pattern', () => {
    expect(matchFile(F('/w/01_Expr_12.cpp'), problems, BASE, ID_NAME)).toEqual({ problemId: 1272, how: 'filename' });
  });

  it('file → problem and problem → file agree', () => {
    const index = buildMatchIndex(files, problems, BASE, ID_NAME);
    for (const f of files) {
      const m = matchFile(f, problems, BASE, ID_NAME);
      const listed = [...index.entries()].filter(([, l]) => l.some((x) => x.fsPath === f.fsPath)).map(([id]) => id);
      expect(listed, f.fsPath).toEqual(m ? [m.problemId] : []);
    }
  });
});
