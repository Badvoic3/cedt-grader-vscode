import { G } from '../shared/strings';
import { SERVER_SCORE_CAP } from '../shared/constants';
import type { ListScoreInfo, Problem } from './types';

/**
 * The score the server counts, as rendered by cafe-grader
 * (`app/views/main/_problem.html.haml`, `Submission.max_score_report`):
 *
 *   counted = max(0, min(best, 100 - min(100, hint_cost + ai_assist_cost)))
 *
 * where `best` is the max points over regular submissions (test drives and
 * repaired copies excluded; the API's `best_score` already does this).
 * Problems whose live dataset is in "raw sum" mode show the raw best, uncapped.
 */
export function countedScore(best: number | null, cost = 0, rawSum = false): number | null {
  if (best === null) return null;
  if (rawSum) return best;
  const cap = SERVER_SCORE_CAP - Math.min(SERVER_SCORE_CAP, Math.max(0, cost));
  return Math.max(0, Math.min(best, cap));
}

export interface ScoreSummary {
  /** The number that counts (null = never submitted). */
  counted: number | null;
  best: number | null;
  latest: number | null;
  attempts: number;
  /** Penalty points (0 if none). */
  penalty: number;
  /** e.g. "-10 AI assist", "-5 hints + AI assist"; null without a penalty. */
  penaltyLabel: string | null;
  rawSum: boolean;
  /** "Out of": always SERVER_SCORE_CAP (scores are normalized to 0–100); null for raw-sum problems. */
  outOf: number | null;
  /** 'problem-list' when hint/AI data from /main/list was applied; 'api' when only the API was available. */
  source: 'api' | 'problem-list';
  /** Latest submission scored lower than the counted score. */
  latestBelowCounted: boolean;
}

export function penaltyLabel(info: Pick<ListScoreInfo, 'cost' | 'hintCount' | 'aiCount'>): string | null {
  if (!info.cost) return null;
  const what =
    info.hintCount && info.aiCount ? 'hints + AI assist' : info.aiCount ? 'AI assist' : info.hintCount ? 'hints' : 'penalty';
  return `-${fmt(info.cost)} ${what}`;
}

export function summarize(p: Pick<Problem, 'bestScore' | 'lastScore' | 'submissionCount' | 'list'>): ScoreSummary {
  const list = p.list;
  const best = p.bestScore ?? list?.rawMax ?? null;
  const rawSum = list?.rawSum ?? false;
  const cost = list?.cost ?? 0;
  const counted = countedScore(best, cost, rawSum);
  return {
    counted,
    best,
    latest: p.lastScore,
    attempts: p.submissionCount,
    penalty: rawSum ? 0 : cost,
    penaltyLabel: rawSum || !list ? null : penaltyLabel(list),
    rawSum,
    outOf: outOfFor(rawSum),
    source: list ? 'problem-list' : 'api',
    latestBelowCounted: p.lastScore !== null && counted !== null && p.lastScore < counted,
  };
}

/** "Out of" for a problem: SERVER_SCORE_CAP, or null (no maximum) for raw-sum problems. */
export function outOfFor(rawSum: boolean): number | null {
  return rawSum ? null : SERVER_SCORE_CAP;
}

/**
 * The one display rule for a score (Current problem, problem rows, results,
 * history): "70 / 100" for normal problems, the raw number for raw-sum
 * problems (with a tooltip saying why there is no maximum).
 */
export function scoreText(points: number | null, rawSum: boolean): { text: string; tip: string | null } {
  if (points === null) return { text: '–', tip: null };
  const out = outOfFor(rawSum);
  return out === null ? { text: fmt(points), tip: G.rawSumTip } : { text: `${fmt(points)} / ${fmt(out)}`, tip: null };
}

/** One-line verdict on whether a new submission changed the counted score. */
export function describeImprovement(before: number | null, after: number | null, points: number | null): string | null {
  if (after === null || points === null) return null;
  if (before === null) return G.firstCountedScore(fmt(after));
  if (after > before) return G.countedScoreImproved(fmt(before), fmt(after));
  if (points < after) return G.thisSubmissionScoredYourBest(fmt(points), fmt(after));
  return G.countedScoreUnchanged(fmt(after));
}

export function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
