/**
 * The pure parts of the controller's flows (src/flows/prompts.ts,
 * src/flows/results.ts) and the link-action rules (src/mapping/linkActions.ts).
 */
import { describe, expect, it } from 'vitest';
import type { Problem, SubmissionResult } from '../src/grader';
import { InlinePrompts } from '../src/flows/prompts';
import { countedSubmissionId, newestAfter, newResult, ResultStore, submissionPatch } from '../src/flows/results';
import { autoDetectOutcome, matchNote, NO_MATCH_INFO, unlinkScope } from '../src/mapping/linkActions';
import { type MatchResult, problemSubtitle } from '../src/mapping/match';
import { folderNames, foldersOf } from '../src/mapping/matchIndex';
import { S } from '../src/shared/strings';

const P = (id: number, name = `p${id}`): Problem => ({
  id, name, fullName: name, bestScore: null, lastScore: null, lastResult: null, lastSubmissionId: null, lastSubmissionTime: null,
  submissionCount: 0, hasTestcase: false, hasAttachment: false, permittedLanguageIds: null, tags: [], list: null,
});

describe('inline questions', () => {
  const setup = (visible = true) => {
    const calls = { change: 0, reveal: 0 };
    const p = new InlinePrompts(() => calls.change++, () => calls.reveal++, () => visible);
    return { p, calls };
  };
  const ok = [{ id: 'ok', label: 'OK' }];

  it('a question with stays survives a file switch; a new question or an answer still ends it', async () => {
    const { p } = setup();
    const first = p.ask('Link the folder?', ok, { stays: true });
    p.cancel();
    expect(p.current?.text).toBe('Link the folder?');
    const second = p.ask('Other?', ok);
    await expect(first).resolves.toBeUndefined();
    p.cancel();
    await expect(second).resolves.toBeUndefined();
    expect(p.current).toBeNull();
    const third = p.ask('Link the folder?', ok, { stays: true });
    p.answer(p.current!.id, 'ok');
    await expect(third).resolves.toBe('ok');
  });

  it('resolves with the button; answers for an older question are ignored', async () => {
    const { p, calls } = setup();
    const a = p.ask('first?', ok);
    const first = p.current!;
    expect(first).toMatchObject({ text: 'first?', detail: null, tone: 'info', near: null });
    p.answer(first.id + 1, 'ok'); // not this question
    expect(p.current).toBe(first);
    p.answer(first.id, 'ok');
    expect(await a).toBe('ok');
    expect(p.current).toBeNull();
    expect(calls).toEqual({ change: 2, reveal: 0 });
  });

  it('a new question, a file switch or a dismissal resolves the open one with undefined', async () => {
    const { p } = setup();
    const a = p.ask('a?', ok);
    const b = p.ask('b?', ok, { tone: 'warn', near: 'submit', detail: 'd' });
    expect(await a).toBeUndefined();
    expect(p.current).toMatchObject({ text: 'b?', tone: 'warn', near: 'submit', detail: 'd' });
    p.cancel();
    expect(await b).toBeUndefined();
    const c = p.ask('c?', ok);
    p.answer(p.current!.id, null);
    expect(await c).toBeUndefined();
  });

  it('shows the panel when it is hidden', () => {
    const { p, calls } = setup(false);
    void p.ask('x?', ok);
    expect(calls.reveal).toBe(1);
  });
});

describe('results', () => {
  const sub = (o: Partial<SubmissionResult>): SubmissionResult => ({
    id: 9, number: 3, problemId: 1, status: 'done', state: 'graded', points: 70, comment: 'PP-', compilerMessage: null, compileError: false, verdicts: [], submittedAt: null, language: null, ...o,
  });

  it('a poll update: grading while pending, done when graded, compile error message', () => {
    expect(submissionPatch(sub({ state: 'pending', status: 'grading' as SubmissionResult['status'] }), 'u')).toMatchObject({ phase: 'grading', message: S.submit.waitingStatus('grading') });
    expect(submissionPatch(sub({}), 'u')).toMatchObject({ phase: 'done', points: 70, number: 3, submissionUrl: 'u', compilerMessage: null, message: null });
    expect(submissionPatch(sub({ compileError: true, status: 'compilation_error' }), 'u')).toMatchObject({ compilerMessage: '', message: S.submit.compilationError });
  });

  it('results follow renamed files and folders; update needs an existing result', () => {
    const r = new ResultStore();
    r.set('/w/a/x.cpp', newResult(P(1), 'done', null));
    expect(r.update('/w/none.cpp', { points: 1 })).toBe(false);
    r.rename('/w/a', '/w/b');
    expect(r.get('/w/a/x.cpp')).toBeUndefined();
    expect(r.update('/w/b/x.cpp', { points: 50 })).toBe(true);
    expect(r.get('/w/b/x.cpp')).toMatchObject({ problemId: 1, points: 50 });
    expect(r.get(null)).toBeUndefined();
  });

  it('newer file: the most recent one edited after mine', () => {
    expect(newestAfter(10, [{ t: 5 }, { t: 10 }])).toBeNull();
    expect(newestAfter(10, [{ t: 12, n: 'a' }, { t: 15, n: 'b' }, { t: 11, n: 'c' }])).toEqual({ t: 15, n: 'b' });
  });

  it('counted submission: best points, the earliest on a tie, none without points', () => {
    // newest first
    expect(countedSubmissionId([{ id: 3, points: 80 }, { id: 2, points: 80 }, { id: 1, points: 40 }])).toBe(2);
    expect(countedSubmissionId([{ id: 2, points: 0 }, { id: 1, points: null }])).toBeNull();
    expect(countedSubmissionId([])).toBeNull();
  });
});

describe('link actions', () => {
  it('auto-detect: switch / agrees / kept with a saved link; apply without one', () => {
    const m: MatchResult = { kind: 'match', problem: P(2), source: 'filename', suggestions: [] };
    expect(autoDetectOutcome(1, m)).toMatchObject({ kind: 'switch', problem: { id: 2 } });
    expect(autoDetectOutcome(2, m)).toMatchObject({ kind: 'agrees', source: 'filename' });
    expect(autoDetectOutcome(2, { kind: 'ambiguous', candidates: [P(3), P(4)], source: 'filename' })).toEqual({ kind: 'kept', ambiguous: 2 });
    expect(autoDetectOutcome(2, { kind: 'none', suggestions: [] })).toEqual({ kind: 'kept', ambiguous: null });
    expect(autoDetectOutcome(null, { kind: 'none', suggestions: [] })).toEqual({ kind: 'apply', none: true });
    expect(autoDetectOutcome(null, { kind: 'none', suggestions: [P(5)] })).toEqual({ kind: 'apply', none: false });
    expect(autoDetectOutcome(null, m)).toEqual({ kind: 'apply', none: false });
  });

  it('✕ unlinks the folder in folder mode or for a folder-name match, else the file', () => {
    expect(unlinkScope({ folderLink: true, folderMatched: false, source: 'saved' })).toBe('folder-link');
    expect(unlinkScope({ folderLink: true, folderMatched: true, source: 'folder' })).toBe('folder-name');
    expect(unlinkScope({ folderLink: false, folderMatched: false, source: 'folder' })).toBe('folder-name');
    expect(unlinkScope({ folderLink: false, folderMatched: false, source: 'filename' })).toBe('file');
    expect(unlinkScope({ folderLink: false, folderMatched: false, source: null })).toBe('file');
  });

  it('matching note only when several problems match', () => {
    expect(matchNote(NO_MATCH_INFO)).toBeNull();
    expect(matchNote({ ...NO_MATCH_INFO, ambiguous: [P(1)], ambiguousSource: 'suggested' })).toBe(S.match.severalCould);
    expect(matchNote({ ...NO_MATCH_INFO, ambiguous: [P(1)], ambiguousSource: 'folder' })).toBe(S.match.severalMatchFolder);
    expect(matchNote({ ...NO_MATCH_INFO, ambiguous: [P(1)], ambiguousSource: 'filename' })).toBe(S.match.severalMatch);
  });

  it('problem subtitle drops a repeated "name:" prefix', () => {
    expect(problemSubtitle('a', 'a')).toBeNull();
    expect(problemSubtitle('a', ' ')).toBeNull();
    expect(problemSubtitle('a', 'a: Sum')).toBe('Sum');
    expect(problemSubtitle('a', 'a:')).toBeNull();
    expect(problemSubtitle('a', 'Other')).toBe('Other');
  });

  it('folders of a workspace-relative directory', () => {
    expect(foldersOf('week1/pkg')).toEqual(['week1', 'pkg']);
    expect(foldersOf('.')).toEqual([]);
    expect(foldersOf('C:/outside')).toEqual(['outside']);
    expect(folderNames('/w/week1/pkg', 'week1/pkg', { path: '/w', name: 'w' })).toEqual(['w', 'week1', 'pkg']);
    expect(folderNames('/w', '/w', { path: '/w', name: 'renamed' })).toEqual(['renamed']);
    expect(folderNames('/Users/me/Downloads', '/Users/me/Downloads', null)).toEqual(['Downloads']);
    expect(folderNames('C:\\Users\\me\\pkg', 'C:\\Users\\me\\pkg', null)).toEqual(['pkg']);
  });
});
