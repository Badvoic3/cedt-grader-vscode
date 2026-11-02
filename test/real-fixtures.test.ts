/**
 * Tests against pages captured from cedt-grader.nattee.net by scripts/probe.ts
 * (sanitized; captured outside any contest on 2026-11-02).
 */
import { describe, expect, it } from 'vitest';
import {
  extractCsrf,
  hasLoginForm,
  parseCompilerMessage,
  parseLoginForm,
  parsePollUrl,
  parseProblemList,
  parseSubmissionStatus,
  parseSubmitPage,
  parseUserId,
} from '../src/grader';
import { realFixture } from './helpers';

const list = realFixture('main_list.html');
const submit = realFixture('direct_edit_problem.html');
const edit = realFixture('submission_edit.html');
const login = realFixture('login_page.html');
const graded = realFixture('latest_status_graded.turbo.html');
const pending = realFixture('latest_status_pending.turbo.html');
const cmsg = realFixture('compiler_msg.turbo.html');

describe.runIf(list)('real /main/list', () => {
  it('parses all problems', () => {
    const ps = parseProblemList(list!);
    expect(ps.length).toBe(292);
    expect(ps.find((p) => p.id === 1360)).toMatchObject({
      name: '00_Intro_11',
      fullName: '00_Intro_★_Hello_World',
      bestScore: 100,
    });
    expect(ps.find((p) => p.id === 1756)).toMatchObject({ name: 'DigLo69_Project', bestScore: 0, latestSubmissionId: null });
    expect(ps.find((p) => p.id === 1734)?.fullName).toBe('เมืองปิด');
    for (const p of ps) expect(p.name).not.toMatch(/[​]/);
  });

  it('is a logged-in page with token and user id', () => {
    expect(hasLoginForm(list!)).toBe(false);
    expect(extractCsrf(list!)).toBeTruthy();
    expect(parseUserId(list!)).toBe(12345);
  });

});

describe.runIf(submit)('real submit page', () => {
  it('reads languages, name and form', () => {
    const p = parseSubmitPage(submit!, 1360);
    expect(p.problemId).toBe(1360);
    expect(p.canSubmit).toBe(true);
    expect(p.problemName).toBe('[00_Intro_11]');
    expect(p.problemFullName).toBe('00_Intro_★_Hello_World');
    expect(p.languages.map((l) => l.name)).toEqual([
      'C', 'C++', 'Pascal', 'Java', 'Ruby', 'Python', 'Haskell', 'Digital', 'PHP', 'Rust', 'Go', 'PostgreSQL', 'Archive', 'Text', 'Viva Exam',
    ]);
    expect(p.languages.find((l) => l.selected)?.name).toBe('C++');
    expect(p.csrfToken).toBeTruthy();
  });

});

describe.runIf(edit)('real /submissions/{id}/edit', () => {
  it('renders the poll URL with the user id', () => {
    expect(parsePollUrl(edit!)).toMatch(/^\/submissions\/get_latest_submission_status\/12345\/1360$/);
  });
});

describe.runIf(login)('real login page', () => {
  it('has the form, a token, no agreement', () => {
    const f = parseLoginForm(login!);
    expect(f.present).toBe(true);
    expect(f.token).toBeTruthy();
    expect(f.hasAgreement).toBe(false);
  });
});

describe('real poll responses', () => {
  it.runIf(graded)('graded (wrong answer, 1 test)', () => {
    const s = parseSubmissionStatus(graded!);
    expect(s.state).toBe('graded');
    expect(s.id).toBeGreaterThan(0);
    expect(s.score).toBe(0);
    expect(s.verdicts).toEqual([{ index: 1, ok: false, label: 'Test 1 of 1: Wrong Answer', kind: 'wrong' }]);
    expect(s.compileError).toBe(false);
  });

  it.runIf(pending)('pending', () => {
    const s = parseSubmissionStatus(pending!);
    expect(s.state).toBe('pending');
    expect(s.refreshUrl).toMatch(/get_latest_submission_status\/12345\/1360$/);
    expect(s.refreshDelayMs).toBeGreaterThan(0);
  });

  it.runIf(cmsg)('compiler message modal', () => {
    expect(typeof parseCompilerMessage(cmsg!)).toBe('string');
  });
});
