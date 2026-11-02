import { describe, expect, it } from 'vitest';
import { detectContest } from '../src/grader';
import { CONTEST_BLOCK_MESSAGE, decideSubmit } from '../src/submitGate';
import { DURING_CONTEST, fixture } from './helpers';

const normal = detectContest(fixture('direct_edit_problem.normal.synthetic.html'));
const contest = detectContest(fixture('direct_edit_problem.contest.synthetic.html'), DURING_CONTEST);
const uncertain = detectContest('<html><body>maintenance</body></html>');

describe('decideSubmit (contest gate)', () => {
  it('normal page → allow', () => {
    expect(decideSubmit(normal, false)).toEqual({ kind: 'allow' });
  });

  it('contest + setting off (default) → block with the website message', () => {
    expect(decideSubmit(contest, false)).toEqual({ kind: 'block', reason: CONTEST_BLOCK_MESSAGE });
  });

  it('uncertain detection + setting off → block', () => {
    expect(decideSubmit(uncertain, false).kind).toBe('block');
  });

  it('no detection at all → block', () => {
    expect(decideSubmit(null, true).kind).toBe('block');
  });

  it('contest + setting on → confirm (asked every time), mentions instructor permission', () => {
    const d = decideSubmit(contest, true);
    expect(d.kind).toBe('confirm');
    expect(d.kind === 'confirm' && d.reason).toMatch(/instructor/);
    // Same input, same answer: nothing is remembered between calls.
    expect(decideSubmit(contest, true).kind).toBe('confirm');
  });
});
