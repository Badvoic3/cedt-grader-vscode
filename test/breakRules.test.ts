import { describe, expect, it } from 'vitest';
import { BreakTimer, dayKey, nextDayStart, normalizeBreakDay, pickScene, SCENES, type BreakDay, type Holds } from '../src/flows/breakRules';

const MIN = 60_000;
const T0 = new Date(2026, 10, 9, 13, 0, 0).getTime(); // 13:00 local
const free: Holds = { grading: false, running: false, exam: false };
const fresh = (t = T0): BreakDay => normalizeBreakDay(undefined, t);

/** Activity every `every` minutes from `from` for `minutes` minutes; returns the last time. */
function work(timer: BreakTimer, from: number, minutes: number, every = 5): number {
  let t = from;
  for (let m = 0; m <= minutes; m += every) { t = from + m * MIN; timer.activity(t); }
  return t;
}

describe('break timer', () => {
  it('shows the hint after 90 minutes of work with short gaps', () => {
    const timer = new BreakTimer(90);
    const day = fresh();
    work(timer, T0, 85, 9);
    expect(timer.show(T0 + 85 * MIN, day)).toBe('none');
    timer.activity(T0 + 90 * MIN);
    expect(timer.show(T0 + 90 * MIN, day)).toBe('hint');
  });

  it('a 10-minute gap starts the count again; a 9-minute gap does not', () => {
    const a = new BreakTimer(90);
    work(a, T0, 60);
    a.activity(T0 + 69 * MIN); // 9 min after the last activity: still the same stretch
    expect(a.worked(T0 + 69 * MIN)).toBe(69 * MIN);
    const b = new BreakTimer(90);
    work(b, T0, 60);
    b.activity(T0 + 70 * MIN); // 10 min: a new stretch
    expect(b.worked(T0 + 70 * MIN)).toBe(0);
    expect(b.worked(T0 + 200 * MIN)).toBe(0); // and idle time never counts
  });

  it('offers the prompt only at a boundary 20 to 60 minutes after the hint', () => {
    const timer = new BreakTimer(90);
    let day = fresh();
    const hint = work(timer, T0, 90);
    expect(timer.show(hint, day)).toBe('hint');
    for (const m of [0, 10, 19]) expect(timer.boundary(work(timer, hint, m, 1), 'verdict-pass', free, day)).toBe(false);
    work(timer, hint, 20, 1);
    expect(timer.boundary(hint + 20 * MIN, 'switch', free, day)).toBe(true);
    day = timer.prompted(day);
    expect(timer.boundary(hint + 21 * MIN, 'switch', free, day)).toBe(false); // one prompt at a time
    day = timer.answer(hint + 22 * MIN, 'ignored', day);
    work(timer, hint + 22 * MIN, 40);
    expect(timer.boundary(hint + 61 * MIN, 'tests-pass', free, day)).toBe(false); // window closed: the hint stays
    expect(timer.show(hint + 61 * MIN, day)).toBe('hint');
  });

  it('holds the prompt while grading, running tests, on an exam page, and just after a celebration', () => {
    const timer = new BreakTimer(90);
    const day = fresh();
    const hint = work(timer, T0, 90);
    timer.show(hint, day);
    const t = work(timer, hint, 30);
    expect(timer.boundary(t, 'verdict-pass', { ...free, grading: true }, day)).toBe(false);
    expect(timer.boundary(t, 'verdict-pass', { ...free, running: true }, day)).toBe(false);
    expect(timer.boundary(t, 'verdict-pass', { ...free, exam: true }, day)).toBe(false);
    timer.celebrated(t - 5_000);
    expect(timer.boundary(t, 'verdict-pass', free, day)).toBe(false);
    expect(timer.boundary(t + 6_000, 'verdict-pass', free, day)).toBe(true);
  });

  it('at most two prompts a day; an ignored prompt counts', () => {
    const timer = new BreakTimer(90);
    let day = fresh();
    const hint = work(timer, T0, 90);
    timer.show(hint, day);
    let t = work(timer, hint, 20);
    expect(timer.boundary(t, 'switch', free, day)).toBe(true);
    day = timer.answer(t, 'ignored', timer.prompted(day));
    day = timer.answer(t, 'snooze', timer.prompted(day));
    t = work(timer, t, 30);
    expect(timer.boundary(t, 'switch', free, day)).toBe(false);
    expect(day.prompts).toBe(2);
  });

  it('snooze moves the prompt 30 minutes on', () => {
    const timer = new BreakTimer(90);
    let day = fresh();
    const hint = work(timer, T0, 90);
    timer.show(hint, day);
    let t = work(timer, hint, 20);
    day = timer.answer(t, 'snooze', timer.prompted(day));
    t = work(timer, t, 25);
    expect(timer.boundary(t, 'switch', free, day)).toBe(false);
    t = work(timer, t, 5);
    expect(timer.boundary(t, 'switch', free, day)).toBe(true);
  });

  it('"Take a break" starts the count again; "Not today" hides everything until 4:00', () => {
    const timer = new BreakTimer(90);
    let day = fresh();
    const hint = work(timer, T0, 90);
    timer.show(hint, day);
    day = timer.answer(hint, 'take', day);
    expect(timer.show(hint, day)).toBe('none');
    expect(timer.worked(hint)).toBe(0);
    const t = work(timer, hint, 95);
    day = timer.answer(t, 'not-today', day);
    expect(timer.show(t, day)).toBe('none');
    const tomorrow4 = new Date(2026, 10, 10, 4, 0, 0).getTime();
    expect(day.notTodayUntil).toBe(tomorrow4);
    expect(timer.show(tomorrow4 - 1, day)).toBe('none');
  });
});

describe('days', () => {
  it('a day starts at 4:00, so 2:00 still belongs to the evening before', () => {
    expect(dayKey(new Date(2026, 10, 10, 2, 0).getTime())).toBe('2026-11-09');
    expect(dayKey(new Date(2026, 10, 10, 4, 0).getTime())).toBe('2026-11-10');
    expect(nextDayStart(new Date(2026, 10, 10, 2, 0).getTime())).toBe(new Date(2026, 10, 10, 4, 0).getTime());
    expect(nextDayStart(new Date(2026, 10, 10, 4, 0).getTime())).toBe(new Date(2026, 10, 11, 4, 0).getTime());
  });

  it('a stored day is read back safely, and a new day starts at zero prompts', () => {
    expect(normalizeBreakDay('junk', T0)).toEqual({ day: dayKey(T0), prompts: 0, notTodayUntil: null, lastScene: null });
    const stored = { day: dayKey(T0), prompts: 2, notTodayUntil: T0 + MIN, lastScene: 'sand' };
    expect(normalizeBreakDay(stored, T0)).toEqual(stored);
    expect(normalizeBreakDay(stored, T0 + 24 * 60 * MIN).prompts).toBe(0);
    expect(normalizeBreakDay({ ...stored, lastScene: 'nope', prompts: -3 }, T0)).toMatchObject({ prompts: 0, lastScene: null });
  });
});

describe('scene choice', () => {
  it('random never repeats the last scene; a pinned scene always wins', () => {
    for (const last of SCENES) for (let i = 0; i < 20; i++) expect(pickScene('random', last, () => i / 20)).not.toBe(last);
    expect(new Set(Array.from({ length: 20 }, (_, i) => pickScene('random', null, () => i / 20))).size).toBe(SCENES.length);
    expect(pickScene('breathe', 'breathe', Math.random)).toBe('breathe');
  });
});
