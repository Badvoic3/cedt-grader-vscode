import { describe, expect, it } from 'vitest';
import {
  cleanText,
  extractAlerts,
  extractCsrf,
  hasLoginForm,
  parseCompilerMessage,
  parseEvaluations,
  parseLoginForm,
  parsePollUrl,
  parseProblemList,
  parseSubmissionStatus,
  parseSubmitPage,
  parseUserId,
  sanitizeHtml,
} from '../src/grader';
import { fixture, realFixture } from './helpers';

describe('cleanText', () => {
  it('strips zero-width spaces and collapses whitespace', () => {
    expect(cleanText(' p01_​sum \n x ')).toBe('p01_sum x');
  });
});

describe('login page', () => {
  it('finds the form, token and alert', () => {
    const html = fixture('login_page.synthetic.html');
    expect(hasLoginForm(html)).toBe(true);
    const f = parseLoginForm(html);
    expect(f.present).toBe(true);
    expect(f.token).toBe('REDACTED');
    expect(f.hasAgreement).toBe(false);
    expect(extractAlerts(html)).toEqual(['Wrong password']);
  });

  it('detects the agreement checkbox and its label', () => {
    const f = parseLoginForm(fixture('login_page.agreement.synthetic.html'));
    expect(f.hasAgreement).toBe(true);
    expect(f.agreementValue).toBe('1');
    expect(f.agreementText).toBe('I agree to the exam rules');
  });
});

describe('problem list', () => {
  const html = fixture('main_list.normal.synthetic.html');

  it('parses rows into problems', () => {
    const ps = parseProblemList(html);
    expect(ps.map((p) => p.id)).toEqual([101, 102, 103]);
    expect(ps[0]).toMatchObject({
      name: 'p00_hello',
      fullName: 'Hello_World',
      bestScore: 100,
      latestSubmissionId: 5001,
      statementUrl: '/problems/101/download/statement',
      testcasesUrl: '/testcases/show_problem/101',
    });
    expect(ps[1]).toMatchObject({ name: 'p01_sum', bestScore: 70, latestSubmissionId: 5002 });
    expect(ps[2]).toMatchObject({ id: 103, name: 'p02_graph', bestScore: 0, latestSubmissionId: null });
    expect(ps[2].testcasesUrl).toBeUndefined();
  });

  it('is not logged-out and has a csrf token and user id', () => {
    expect(hasLoginForm(html)).toBe(false);
    expect(extractCsrf(html)).toBe('REDACTED');
    expect(parseUserId(html)).toBe(12345);
  });

  it('does not confuse contest table rows with problems', () => {
    const ps = parseProblemList(fixture('main_list.contest.synthetic.html'));
    expect(ps.map((p) => p.id)).toEqual([101, 102, 103]);
    expect(ps[0].name).toBe('DigLo69_Exam2__1');
  });

  const real = realFixture('main_list.html');
  it.runIf(real)('parses the real (sanitized) list', () => {
    const ps = parseProblemList(real!);
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) {
      expect(p.id).toBeGreaterThan(0);
      expect(p.name).not.toMatch(/​/);
    }
  });
});

describe('submit page', () => {
  it('reads languages and form', () => {
    const p = parseSubmitPage(fixture('direct_edit_problem.normal.synthetic.html'), 999);
    expect(p.problemId).toBe(102);
    expect(p.problemName).toBe('[p01_sum]');
    expect(p.problemFullName).toBe('Sum_of_Array');
    expect(p.canSubmit).toBe(true);
    expect(p.languageForced).toBe(false);
    expect(p.csrfToken).toBe('REDACTED');
    expect(p.languages).toEqual([
      { id: 1, name: 'C', selected: false },
      { id: 2, name: 'C++', selected: true },
      { id: 4, name: 'Python', selected: false },
      { id: 5, name: 'Java', selected: false },
    ]);
  });

  it('notices a closed problem', () => {
    const p = parseSubmitPage(fixture('direct_edit_problem.closed.synthetic.html'), 7);
    expect(p.canSubmit).toBe(false);
    expect(p.languages).toEqual([]);
    expect(p.problemId).toBe(7);
  });

  const real = realFixture('direct_edit_problem.html');
  it.runIf(real)('parses the real (sanitized) submit page', () => {
    const p = parseSubmitPage(real!, 1);
    expect(p.canSubmit).toBe(true);
    expect(p.languages.length).toBeGreaterThan(0);
  });
});

describe('latest submission status', () => {
  it('none', () => {
    expect(parseSubmissionStatus(fixture('latest_status_none.synthetic.html')).state).toBe('none');
  });

  it('pending', () => {
    const s = parseSubmissionStatus(fixture('latest_status_pending.synthetic.html'));
    expect(s).toMatchObject({
      id: 5003,
      state: 'pending',
      score: null,
      tries: 3,
      time: '14:03:22',
      refreshDelayMs: 2000,
      refreshUrl: '/submissions/get_latest_submission_status/12345/102',
      compileError: false,
    });
  });

  it('graded with verdict strip, groups and unknown tile classes', () => {
    const s = parseSubmissionStatus(fixture('latest_status_graded.synthetic.html'));
    expect(s.state).toBe('graded');
    expect(s.id).toBe(5003);
    expect(s.score).toBe(70);
    expect(s.tries).toBe(3);
    expect(s.comment).toBe('PPPPPPPPP----PP-PPT[Px]');
    expect(s.verdicts).toHaveLength(21);
    expect(s.verdicts[9]).toEqual({ index: 10, ok: false, label: 'Test 10 of 20: Wrong Answer', kind: 'wrong' });
    expect(s.verdicts[18]).toMatchObject({ kind: 'time_limit', ok: false });
    expect(s.verdicts[19]).toMatchObject({ ok: true, group: 1 });
    // Unknown class: no crash, raw title kept.
    expect(s.verdicts[20]).toMatchObject({ kind: 'somethingnew', ok: false, label: 'Test 21 of 21: Mystery Verdict', group: 1 });
    expect(s.compileError).toBe(false);
  });

  it('compile error', () => {
    const s = parseSubmissionStatus(fixture('latest_status_compile_error.synthetic.html'));
    expect(s).toMatchObject({ id: 5004, state: 'graded', score: 0, comment: 'Compilation error', compileError: true });
    expect(s.verdicts).toEqual([]);
  });

  it('graded even when the score row is hidden by the server', () => {
    const html = fixture('latest_status_graded.synthetic.html').replace(/<div class="col-12">\s*<span class="mi">speed[\s\S]*?<\/div>\n<\/div>/, '</div>');
    const s = parseSubmissionStatus(html);
    expect(s.state).toBe('graded');
    expect(s.score).toBeNull();
  });

  for (const name of ['latest_status_graded.turbo.html', 'latest_status_pending.turbo.html']) {
    const real = realFixture(name);
    it.runIf(real)(`parses real ${name}`, () => {
      const s = parseSubmissionStatus(real!);
      expect(s.id).toBeGreaterThan(0);
      expect(s.state).toBe(name.includes('pending') ? 'pending' : 'graded');
    });
  }
});

describe('turbo modals', () => {
  it('compiler message', () => {
    const m = parseCompilerMessage(fixture('compiler_msg.synthetic.html'));
    expect(m).toContain("error: 'cout' was not declared in this scope");
    expect(m).toContain('cout << x;');
  });

  it('evaluations', () => {
    const ev = parseEvaluations(fixture('evaluations.synthetic.html'));
    expect(ev).toHaveLength(2);
    expect(ev[1]).toMatchObject({ num: '2', time: '1.004s', memory: '3.52MB', result: 'T Time Limit Exceed', score: '0%' });
  });
});

describe('poll url', () => {
  it('reads the server-rendered poll URL', () => {
    const html = '<a id="refresh" href="/submissions/get_latest_submission_status/77/102">r</a>';
    expect(parsePollUrl(html)).toBe('/submissions/get_latest_submission_status/77/102');
    expect(parseUserId(html)).toBe(77);
  });
});

describe('sanitizeHtml', () => {
  it('removes tokens, names, user id, emails and student ids', () => {
    const html = `<html><head><meta name="csrf-token" content="SECRETTOKEN123"></head><body>
      <a data-user-id="4242" href="/users/profile">Somchai Jaidee</a>
      <input type="hidden" name="authenticity_token" value="SECRETTOKEN456">
      <a href="/submissions/get_latest_submission_status/4242/9">x</a>
      Hello Somchai Jaidee (6730123421) somchai@student.chula.ac.th login 6730123421</body></html>`;
    const out = sanitizeHtml(html, { personal: ['6730123421'], userId: 4242 });
    expect(out).not.toMatch(/SECRETTOKEN/);
    expect(out).not.toMatch(/Somchai/);
    expect(out).not.toMatch(/4242/);
    expect(out).not.toMatch(/6730123421/);
    expect(out).not.toMatch(/chula/);
    expect(out).toContain('get_latest_submission_status/12345/9');
  });
});
