import { describe, expect, it } from 'vitest';
import { detectContest, mustBlock } from '../src/grader';
import { AFTER_CONTEST, DURING_CONTEST, fixture, realFixture } from './helpers';

describe('detectContest', () => {
  it('normal list page → not a contest, certain', () => {
    const d = detectContest(fixture('main_list.normal.synthetic.html'), DURING_CONTEST);
    expect(d).toMatchObject({ inContest: false, certain: true });
    expect(mustBlock(d)).toBe(false);
    // checkInLoop() is defined (and reschedules itself) on every page; that alone is not a contest.
    expect(d.signals).toEqual(['header-script']);
  });

  it('normal submit page → not a contest', () => {
    const d = detectContest(fixture('direct_edit_problem.normal.synthetic.html'));
    expect(mustBlock(d)).toBe(false);
  });

  it('running contest list page → contest, with name and end time', () => {
    const d = detectContest(fixture('main_list.contest.synthetic.html'), DURING_CONTEST);
    expect(d.inContest).toBe(true);
    expect(d.certain).toBe(true);
    expect(d.contestName).toBe('DigLo69 Exam 2');
    expect(d.endTime).toBe('2026-11-02T16:00:00+07:00');
    expect(d.signals).toEqual(
      expect.arrayContaining([
        'countdown:(running)',
        'check-in-loop-started',
        'contest-end-time:running',
        'contest-table',
        'contest-window:open',
      ]),
    );
  });

  it('running contest submit page → contest', () => {
    const d = detectContest(fixture('direct_edit_problem.contest.synthetic.html'), DURING_CONTEST);
    expect(mustBlock(d)).toBe(true);
  });

  it('contest mode stays blocked after the end time (another contest may be running)', () => {
    expect(mustBlock(detectContest(fixture('main_list.contest.synthetic.html'), AFTER_CONTEST))).toBe(true);
    const over = detectContest(fixture('main_list.contest_over.synthetic.html'), AFTER_CONTEST);
    expect(over.inContest).toBe(true);
    expect(over.signals).toContain('countdown:Contest is over');
  });

  it('contest mode without an enrolled contest → contest', () => {
    const d = detectContest(fixture('main_list.contest_mode_no_contest.synthetic.html'));
    expect(d.inContest).toBe(true);
    expect(d.signals).toEqual(expect.arrayContaining(['countdown:NO CONTEST', 'contest-mode-text']));
  });

  it('analysis mode → not a contest', () => {
    const d = detectContest(fixture('main_list.analysis.synthetic.html'));
    expect(d).toMatchObject({ inContest: false, certain: true });
    expect(d.signals).toContain('countdown:analysis-mode');
  });

  describe('uncertain → treated as contest', () => {
    it('page without the header script (login page, error page, changed layout)', () => {
      const d = detectContest(fixture('login_page.synthetic.html'));
      expect(d.certain).toBe(false);
      expect(d.inContest).toBe(true);
      expect(mustBlock(d)).toBe(true);
    });

    it('empty / garbage HTML', () => {
      expect(mustBlock(detectContest(''))).toBe(true);
      expect(mustBlock(detectContest('<html><body>502 Bad Gateway</body></html>'))).toBe(true);
    });

    it('unparseable end time', () => {
      const html = fixture('main_list.normal.synthetic.html').replace("Date.parse('')", "Date.parse('not a date')");
      const d = detectContest(html);
      expect(d.inContest).toBe(true);
      expect(d.certain).toBe(false);
      expect(d.signals).toContain('contest-end-time:unparseable');
    });
  });

  it('a filled end time alone is enough', () => {
    const html = fixture('main_list.normal.synthetic.html').replace(
      "Date.parse('')",
      "Date.parse('2026-11-02T16:00:00+07:00')",
    );
    expect(detectContest(html, DURING_CONTEST).inContest).toBe(true);
  });

  for (const name of ['main_list.html', 'direct_edit_problem.html']) {
    const real = realFixture(name);
    it.runIf(real)(`real ${name} (captured outside a contest) → normal`, () => {
      expect(detectContest(real!).inContest).toBe(false);
    });
  }
});
