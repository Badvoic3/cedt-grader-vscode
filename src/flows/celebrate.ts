import { SERVER_SCORE_CAP } from '../shared/constants';
import { tagKey } from '../shared/tags';
import { dayKey } from './breakRules';

/**
 * The first-full-score celebration and the trophies, without VS Code. A problem celebrates once: the first time a
 * submission passes every test or brings the counted score to 100. A problem that was already full before (on the
 * website, or before this version) is recorded silently. Times are epoch milliseconds passed in by the caller.
 */

/** Stored per account (globalState): problem id → when it first became full (0 = already full when first seen). */
export type FirstFull = Record<string, number>;

/** A stored record read back safely: anything that isn't a time ≥ 0 is dropped. */
export function normalizeFirstFull(raw: unknown): FirstFull {
  const out: FirstFull = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, t] of Object.entries(raw)) if (/^\d+$/.test(id) && typeof t === 'number' && Number.isFinite(t) && t >= 0) out[id] = Math.floor(t);
  return out;
}

export interface FinishedSubmission {
  /** The problem's best raw score before this submission. */
  bestBefore: number | null;
  /** The counted score after it. */
  countedAfter: number | null;
  points: number | null;
  verdicts: readonly { ok: boolean }[];
  compileError: boolean;
  /** The problem is already in `FirstFull`. */
  known: boolean;
  /** Its score is a raw sum with no maximum: 100 doesn't mean full. */
  rawSum: boolean;
}

/** 'celebrate' = record it and play; 'record' = record it silently; 'none' = nothing to do. */
export function shouldCelebrate(s: FinishedSubmission): 'celebrate' | 'record' | 'none' {
  const allPassed = !s.compileError && s.verdicts.length > 0 && s.verdicts.every((v) => v.ok);
  // A raw sum at 100 counts only when the server gives no per-test verdicts to go by.
  const reached = s.rawSum
    ? !s.compileError && !s.verdicts.length && (s.points ?? 0) >= SERVER_SCORE_CAP
    : (s.countedAfter ?? 0) >= SERVER_SCORE_CAP || (!s.compileError && (s.points ?? 0) >= SERVER_SCORE_CAP);
  if (!(allPassed || reached) || s.known) return 'none';
  const fullBefore = (s.bestBefore ?? 0) >= SERVER_SCORE_CAP && !(s.rawSum && allPassed);
  return fullBefore ? 'record' : 'celebrate';
}

export interface TopicProgress {
  name: string;
  solved: number;
  total: number;
}

export interface Trophies {
  /** Problems at a full score. */
  firsts: number;
  /** Days in a row with a new full score, ending today or yesterday. */
  streak: number;
  best: number;
  /** Topics with every problem solved. */
  wholeTopics: number;
  topics: TopicProgress[];
}

interface ProblemLike {
  id: number;
  status: 'solved' | 'inprogress' | 'untried';
  tags?: readonly string[];
}

/** Day number of a 4:00-to-4:00 day. */
function dayNumber(t: number): number {
  const [y, m, d] = dayKey(t).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** The current and the longest run of days with a new full score (silent records don't count). */
export function streaks(firstFull: FirstFull, now: number): { streak: number; best: number } {
  const days = [...new Set(Object.values(firstFull).filter((t) => t > 0).map(dayNumber))].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  const last = days.at(-1);
  const streak = last !== undefined && dayNumber(now) - last <= 1 ? run : 0;
  return { streak, best };
}

/** Progress in each of the website's topics, in their order (topics no problem has are left out). */
export function topicProgress(problems: readonly ProblemLike[], topics: readonly { name: string }[], firstFull: FirstFull): TopicProgress[] {
  const out: TopicProgress[] = [];
  for (const t of topics) {
    const k = tagKey(t.name);
    const inTopic = problems.filter((p) => (p.tags ?? []).some((x) => tagKey(x) === k));
    if (inTopic.length) out.push({ name: t.name, solved: inTopic.filter((p) => isFull(p, firstFull)).length, total: inTopic.length });
  }
  return out;
}

const isFull = (p: ProblemLike, firstFull: FirstFull) => p.status === 'solved' || String(p.id) in firstFull;

export function trophyStats(firstFull: FirstFull, problems: readonly ProblemLike[], topics: readonly { name: string }[], now: number): Trophies {
  const ids = new Set(Object.keys(firstFull));
  for (const p of problems) if (p.status === 'solved') ids.add(String(p.id));
  const progress = topicProgress(problems, topics, firstFull);
  return { firsts: ids.size, ...streaks(firstFull, now), wholeTopics: progress.filter((t) => t.solved === t.total).length, topics: progress };
}

/** The toast's topic line: the problem's first topic. */
export function topicOf(problem: ProblemLike | undefined, progress: readonly TopicProgress[]): TopicProgress | null {
  if (!problem) return null;
  const tags = new Set((problem.tags ?? []).map(tagKey));
  return progress.find((t) => tags.has(tagKey(t.name))) ?? null;
}
