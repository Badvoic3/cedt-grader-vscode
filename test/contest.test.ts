import { describe, expect, it } from 'vitest';
import { isContestPage } from '../src/grader';
import { fixture, realFixture } from './helpers';

describe('isContestPage', () => {
  it('normal page → false; same page with the contest header markup → true', () => {
    // Real page captured outside any contest (falls back to the synthetic one).
    const normal = realFixture('main_list.html') ?? fixture('main_list.normal.synthetic.html');
    expect(isContestPage(normal)).toBe(false);
    const contest = normal
      .replace("Date.parse('')", "Date.parse('2026-11-02T16:00:00+07:00')")
      .replace('</nav>', '<div class="btn btn-dark" id="countdown"></div></nav>');
    expect(isContestPage(contest)).toBe(true);
  });
});
