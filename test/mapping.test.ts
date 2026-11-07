import { describe, expect, it } from 'vitest';
import { resolveProblem } from '../src/mapping/match';
import { parseMappingFile } from '../src/migration/oldLinks';


describe('.cedt-grader.json', () => {
  it('normalizes paths', () => {
    const d = parseMappingFile(JSON.stringify({ version: 1, files: { '.\\a\\b.cpp': { problemId: 1360, name: '00_Intro_11' } } }));
    expect(Object.keys(d.files)).toEqual(['a/b.cpp']);
  });

  it('ignores garbage and invalid entries', () => {
    expect(parseMappingFile('not json').files).toEqual({});
    expect(parseMappingFile('{"files":{"x.cpp":{"problemId":"7"},"y.cpp":{"problemId":-1}}}').files).toEqual({});
  });
});

describe('matcher memo', () => {
  it('a problem renamed in place is matched by its new name', () => {
    const p = { id: 1, name: 'old_name', fullName: 'old_name', bestScore: null, lastScore: null, lastResult: null, lastSubmissionId: null, lastSubmissionTime: null, submissionCount: 0, hasTestcase: false, hasAttachment: false, permittedLanguageIds: null, tags: [], list: null };
    const run = (file: string) => resolveProblem({ savedProblemId: null, filePath: file, problems: [p], baseUrl: 'https://x', namePattern: '{id}_{name}.{ext}' });
    expect(run('/w/old_name.cpp')).toMatchObject({ kind: 'match', source: 'filename' });
    p.name = 'new_name';
    p.fullName = 'new_name';
    expect(run('/w/new_name.cpp')).toMatchObject({ kind: 'match', source: 'filename' });
    expect(run('/w/1_new_name.cpp')).toMatchObject({ kind: 'match', source: 'filename' });
    expect(run('/w/old_name.cpp').kind).not.toBe('match');
  });
});
