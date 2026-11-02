/**
 * Tests against pages captured from cedt-grader.nattee.net by scripts/probe.ts
 * (sanitized; captured outside any contest on 2026-11-02).
 */
import { describe, expect, it } from 'vitest';
import {
  detectContest,
  extractCsrf,
  hasLoginForm,
  mustBlock,
  parseCompilerMessage,
  parseLoginForm,
  parsePollUrl,
  parseProblemList,
  parseSubmissionStatus,
  parseSubmitPage,
  parseUserId,
} from '../src/grader';
import { DURING_CONTEST, realFixture } from './helpers';

const list = realFixture('main_list.html');
const submit = realFixture('direct_edit_problem.html');
const edit = realFixture('submission_edit.html');
const login = realFixture('login_page.html');
const graded = realFixture('latest_status_graded.turbo.html');
const pending = realFixture('latest_status_pending.turbo.html');
const cmsg = realFixture('compiler_msg.turbo.html');

/** What `_header.html.haml` adds while a contest is running. */
function asRunningContest(html: string): string {
  return html
    .replace('</nav>', '<div class="btn btn-dark" id="countdown"></div></nav>')
    .replace("Date.parse('')", "Date.parse('2026-11-02T16:00:00+07:00')")
    .replace(
      '</body>',
      '<script>window.addEventListener("load", function() {\n  too_early_count = 0\n  setInterval(updateRemainingTime,500)\n  setTimeout(checkInLoop,1000)\n})</script></body>',
    );
}

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

  it('is detected as normal (its checkInLoop reschedules itself, which must not count)', () => {
    const d = detectContest(list!);
    expect(d).toMatchObject({ inContest: false, certain: true, signals: ['header-script'] });
  });

  it('is detected as contest once the header contest markup is present', () => {
    const d = detectContest(asRunningContest(list!), DURING_CONTEST);
    expect(mustBlock(d)).toBe(true);
    expect(d.signals).toEqual(expect.arrayContaining(['countdown:(running)', 'check-in-loop-started', 'contest-end-time:running']));
  });

  it('only the load-listener start counts as "loop started"', () => {
    const onlyStart = list!.replace(
      '</body>',
      '<script>window.addEventListener("load", function() { setTimeout(checkInLoop,1000) })</script></body>',
    );
    expect(detectContest(onlyStart).signals).toContain('check-in-loop-started');
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

  it('normal → not blocked; contest markup → blocked', () => {
    expect(mustBlock(detectContest(submit!))).toBe(false);
    expect(mustBlock(detectContest(asRunningContest(submit!), DURING_CONTEST))).toBe(true);
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
    expect(mustBlock(detectContest(login!))).toBe(true); // not a logged-in page → uncertain
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
