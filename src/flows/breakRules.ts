import { BREAK } from '../shared/constants';

/**
 * The break reminder's rules (option B of docs/research/break-interval.md), without VS Code: the timer, when the
 * status-bar hint shows, when the prompt may come, the daily limits, and which break scene opens. All times are
 * epoch milliseconds passed in by the caller, so the rules are tested with a fake clock.
 */

export const BREAK_SCENES = ['random', 'sand', 'donut3d', 'donut2d', 'breathe', 'swarm'] as const;
export type BreakSceneSetting = (typeof BREAK_SCENES)[number];
export type BreakScene = Exclude<BreakSceneSetting, 'random'>;
export const SCENES: readonly BreakScene[] = ['sand', 'donut3d', 'donut2d', 'breathe', 'swarm'];

/** A task boundary that may carry the prompt. Failures are never boundaries. */
export type BoundaryKind = 'verdict-pass' | 'switch' | 'tests-pass';
export type PromptAnswer = 'take' | 'snooze' | 'not-today' | 'ignored';

/** What may not be interrupted right now. */
export interface Holds {
  grading: boolean;
  running: boolean;
  /** The grader's last list page was an exam or contest page. */
  exam: boolean;
}

/** Stored per account (globalState): the prompts of the current "day" (it starts at 4:00), and "Not today". */
export interface BreakDay {
  day: string;
  prompts: number;
  notTodayUntil: number | null;
  lastScene: BreakScene | null;
}

const MINUTE = 60_000;

/** The day a time belongs to, as `YYYY-MM-DD`: a day starts at 4:00 local time, so a late night counts as the evening before. */
export function dayKey(t: number): string {
  const d = new Date(t - BREAK.dayStartsAtHour * 60 * MINUTE);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The next 4:00 after `t`. */
export function nextDayStart(t: number): number {
  const d = new Date(t);
  d.setHours(BREAK.dayStartsAtHour, 0, 0, 0);
  if (d.getTime() <= t) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** A stored day read back safely: anything missing or odd becomes a fresh day. */
export function normalizeBreakDay(raw: unknown, t: number): BreakDay {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<BreakDay>;
  const lastScene = (SCENES as readonly unknown[]).includes(o.lastScene) ? (o.lastScene as BreakScene) : null;
  const notTodayUntil = typeof o.notTodayUntil === 'number' && o.notTodayUntil > t ? o.notTodayUntil : null;
  if (o.day !== dayKey(t)) return { day: dayKey(t), prompts: 0, notTodayUntil, lastScene };
  const prompts = typeof o.prompts === 'number' && o.prompts >= 0 ? Math.floor(o.prompts) : 0;
  return { day: o.day, prompts, notTodayUntil, lastScene };
}

/** Which scene a break opens: the pinned one, or a random one that isn't the last one. */
export function pickScene(setting: BreakSceneSetting, last: BreakScene | null, random: () => number): BreakScene {
  if (setting !== 'random') return setting;
  const choices = SCENES.filter((s) => s !== last);
  return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
}

export type BreakShow = 'none' | 'hint';

/**
 * The work timer. Work starts with the first activity (an edit, a run, a submit) and goes on while gaps stay under
 * 10 minutes; a longer gap starts it again. The hint shows once `minutes` of work have passed; the prompt is
 * offered only through `boundary()`, inside its window after the hint.
 */
export class BreakTimer {
  private workStart: number | null = null;
  private lastActivity: number | null = null;
  private hintAt: number | null = null;
  private snoozeUntil: number | null = null;
  private celebratedAt = -Infinity;
  private promptAt: number | null = null;

  constructor(private minutes: number) {}

  setMinutes(minutes: number): void {
    this.minutes = minutes;
  }

  /** An edit, a run or a submit. */
  activity(t: number): void {
    this.expire(t);
    if (this.workStart === null) this.workStart = t;
    this.lastActivity = t;
  }

  /** A celebration just played: no prompt right after it. */
  celebrated(t: number): void {
    this.celebratedAt = t;
  }

  /** How long the current stretch of work has lasted (0 when there is none). */
  worked(t: number): number {
    this.expire(t);
    return this.workStart === null ? 0 : t - this.workStart;
  }

  /** The status bar: the hint after `minutes` of work, unless the user said "Not today". */
  show(t: number, day: BreakDay): BreakShow {
    if (day.notTodayUntil !== null && t < day.notTodayUntil) return 'none';
    if (this.worked(t) < this.minutes * MINUTE) {
      // The setting went up: the hint and its window start again from when it next shows.
      this.hintAt = null;
      this.snoozeUntil = null;
      return 'none';
    }
    if (this.hintAt === null) this.hintAt = t;
    return 'hint';
  }

  /**
   * A task boundary happened: whether to show the prompt now. It needs the hint to be up, the window after it
   * (20–60 min, or 0–40 min after a snooze) to be open, the day's limit not reached, and nothing to hold it back.
   */
  boundary(t: number, _kind: BoundaryKind, holds: Holds, day: BreakDay): boolean {
    if (this.show(t, day) !== 'hint' || this.hintAt === null) return false;
    if (this.promptAt !== null && t - this.promptAt < BREAK.promptOpenMs) return false;
    if (holds.grading || holds.running || holds.exam) return false;
    if (t - this.celebratedAt < BREAK.afterCelebrationMs) return false;
    if (day.prompts >= BREAK.maxPromptsPerDay) return false;
    const [from, to] = this.snoozeUntil !== null
      ? [this.snoozeUntil, this.snoozeUntil + BREAK.promptWindowEndMs - BREAK.promptAfterHintMs]
      : [this.hintAt + BREAK.promptAfterHintMs, this.hintAt + BREAK.promptWindowEndMs];
    return t >= from && t <= to;
  }

  /** The prompt is on screen; the day's count goes up now, so an ignored prompt counts too. */
  prompted(day: BreakDay, t: number): BreakDay {
    this.promptAt = t;
    return { ...day, prompts: day.prompts + 1 };
  }

  /** The user's answer, whenever it comes (or none: the prompt was closed). */
  answer(t: number, a: PromptAnswer, day: BreakDay): BreakDay {
    this.promptAt = null;
    if (a === 'take') this.reset();
    if (a === 'snooze') this.snoozeUntil = t + BREAK.snoozeMs;
    if (a === 'not-today') return { ...day, notTodayUntil: nextDayStart(t) };
    return day;
  }

  /** A break was taken (from the prompt, the hint, or a command): start counting again. */
  reset(): void {
    this.workStart = null;
    this.lastActivity = null;
    this.hintAt = null;
    this.snoozeUntil = null;
  }

  private expire(t: number): void {
    if (this.lastActivity !== null && t - this.lastActivity >= BREAK.idleResetMs) this.reset();
  }
}
