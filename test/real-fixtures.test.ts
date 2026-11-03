/**
 * Tests against data captured from cedt-grader.nattee.net by scripts/probe.ts
 * (sanitized; outside any contest). Skipped when a fixture is missing.
 */
import { describe, expect, it } from 'vitest';
import type { ApiLanguage, ApiProblem, ApiSubmission, ApiSubmissionBrief } from '../src/grader';
import { matchLanguages, parseGraderComment } from '../src/grader';
import { realFixture } from './helpers';

const json = <T>(name: string): T | null => {
  const s = realFixture(name);
  return s ? (JSON.parse(s) as T) : null;
};
const problems = json<ApiProblem[]>('api_problems.json');
const problem = json<ApiProblem>('api_problem.json');
const languages = json<ApiLanguage[]>('api_languages.json');
const submission = json<ApiSubmission>('api_submission.json');
const history = json<ApiSubmissionBrief[]>('api_submissions.json');
const testcases = json<{ id: number; num: number; access: string; input_bytes: number | null; sol_bytes: number | null }[]>('api_testcases.json');

describe.runIf(problems)('real /api/v1/problems', () => {
  it('has the fields the client reads', () => {
    for (const p of problems!) {
      expect(typeof p.id).toBe('number');
      expect(typeof p.name).toBe('string');
      expect('best_score' in p && 'last_score' in p && 'submission_count' in p && 'has_testcase' in p && 'permitted_languages' in p).toBe(true);
    }
  });
});

describe.runIf(problem)('real /api/v1/problems/{id}', () => {
  it('has full_score and submission_ids', () => {
    expect('full_score' in problem!).toBe(true);
    expect(Array.isArray(problem!.submission_ids)).toBe(true);
  });
});

describe.runIf(languages)('real /api/v1/languages', () => {
  it('maps C++ by name or extension', () => {
    const langs = languages!.map((l) => ({ id: l.id, name: l.pretty_name, code: l.name, ext: l.ext }));
    expect(matchLanguages('C++', langs)).toHaveLength(1);
    expect(matchLanguages('C', langs)).toHaveLength(1);
  });
});

describe.runIf(submission)('real /api/v1/submissions/{id}', () => {
  it('status and comment parse', () => {
    expect(['submitted', 'evaluating', 'done', 'compilation_error', 'compilation_success', 'grader_error']).toContain(submission!.status);
    if (submission!.status === 'done') expect(parseGraderComment(submission!.grader_comment).length).toBeGreaterThan(0);
    expect(submission!.source === undefined || submission!.source === null || submission!.source === '// source removed').toBe(true);
  });
});

describe.runIf(history)('real /api/v1/problems/{id}/submissions', () => {
  it('newest first, with the fields History reads', () => {
    for (const h of history!) {
      expect(typeof h.id).toBe('number');
      expect('number' in h && 'language' in h && 'submitted_at' in h && 'points' in h && 'status' in h && 'grader_comment' in h).toBe(true);
    }
    const times = history!.map((h) => Date.parse(h.submitted_at ?? ''));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

describe.runIf(testcases)('real /api/v1/problems/{id}/testcases', () => {
  it('ids, numbers, student "preview" access and sizes', () => {
    for (const t of testcases!) {
      expect(typeof t.id).toBe('number');
      expect(typeof t.num).toBe('number');
      expect(t.access).toBe('preview');
      expect('input_bytes' in t && 'sol_bytes' in t).toBe(true);
    }
  });
});
