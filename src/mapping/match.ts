import type { Problem } from '../grader/types';
import { MATCH } from '../shared/constants';
import type { CphProblem } from './cph';
import { matchCphProblem } from './cph';

/** How the current file's problem was chosen (an icon next to the problem name). */
export type MatchSource = 'saved' | 'cph' | 'filename' | 'suggested';

/** Tooltip of that icon. "from CPH" only when CPH data was actually used. */
export const SOURCE_LABEL: Readonly<Record<MatchSource, string>> = {
  saved: 'Chosen by you',
  cph: 'Matched from CPH data',
  filename: 'Matched by file name',
  suggested: 'Suggested — click to confirm',
};

/** Zero-width characters the grader's problem list contains (`_&ZeroWidthSpace;`). */
const ZERO_WIDTH = /[​‌‍﻿]/g;

/** The problem name as it should be typed / used for a file name. */
export function cleanName(s: string): string {
  return (s ?? '').replace(ZERO_WIDTH, '').trim();
}

/**
 * Normalize for comparison: zero-width removed, trimmed, lowercased; spaces,
 * "-", "_" and "." are the same separator and repeats collapse.
 */
export function normalizeName(s: string): string {
  return cleanName(s)
    .toLowerCase()
    .replace(/[\s\-_.]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** File name without directory and (last) extension. */
export function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export interface MatchInput {
  /** Saved mapping for this file, if any. */
  savedProblemId: number | null;
  cph: CphProblem | null;
  filePath: string;
  /** Problem list; empty/undefined when not loaded yet. */
  problems: Problem[] | undefined;
  baseUrl: string;
  /** Workspace-relative parent folder names of the file (for the folder/tag bonus). */
  folders?: string[];
}

export type MatchResult =
  | { kind: 'match'; problem: Problem; source: MatchSource; suggestions: Problem[] }
  /** Several problems match equally well (or suggestions too close to call): don't choose, ask. */
  | { kind: 'ambiguous'; candidates: Problem[]; source: 'cph' | 'filename' | 'suggested' }
  /** A saved link whose problem is no longer on the grader (missing from the list). Kept, shown as unavailable. */
  | { kind: 'unavailable'; problemId: number; suggestions: Problem[] }
  | { kind: 'none'; suggestions: Problem[] };

/**
 * Matching order for the active file:
 *  1. a saved mapping (always wins; when its problem no longer exists it is
 *     reported as unavailable, never silently replaced),
 *  2. the CPH .prob file (grader URL or problem name),
 *  3. exact normalized match between file name and problem name,
 *  4. otherwise a suggestion: the closest candidate when its score reaches
 *     MATCH.suggestMinScore and leads the next one by MATCH.suggestMinMargin
 *     (source 'suggested', not saved); close candidates → ambiguous
 *     ("Several problems could match"); below the threshold → none (the
 *     candidates are only offered in the picker).
 * More than one equally good match → ambiguous (the user is asked).
 */
export function resolveProblem(input: MatchInput): MatchResult {
  const problems = input.problems ?? [];
  const loaded = input.problems !== undefined && input.problems.length > 0;

  if (input.savedProblemId !== null) {
    const p = problems.find((x) => x.id === input.savedProblemId);
    if (p) return { kind: 'match', problem: p, source: 'saved', suggestions: [] };
    if (!loaded) return { kind: 'match', problem: placeholder(input.savedProblemId), source: 'saved', suggestions: [] };
    return { kind: 'unavailable', problemId: input.savedProblemId, suggestions: suggest(normalizeName(fileStem(input.filePath)), problems) };
  }
  if (!loaded) return { kind: 'none', suggestions: [] };

  if (input.cph) {
    const byUrl = matchCphProblem({ ...input.cph, name: '' }, problems, input.baseUrl);
    if (byUrl) return { kind: 'match', problem: byUrl, source: 'cph', suggestions: [] };
    const cphName = normalizeName((input.cph.name ?? '').replace(/^Local:\s*/i, ''));
    if (cphName) {
      const hits = problems.filter((p) => normalizeName(p.name) === cphName || normalizeName(p.fullName) === cphName);
      if (hits.length === 1) return { kind: 'match', problem: hits[0], source: 'cph', suggestions: [] };
      if (hits.length > 1) return { kind: 'ambiguous', candidates: hits, source: 'cph' };
    }
  }

  const stem = normalizeName(fileStem(input.filePath));
  if (stem) {
    let hits = problems.filter((p) => normalizeName(p.name) === stem);
    if (!hits.length) hits = problems.filter((p) => normalizeName(p.fullName) === stem);
    if (hits.length === 1) return { kind: 'match', problem: hits[0], source: 'filename', suggestions: [] };
    if (hits.length > 1) return { kind: 'ambiguous', candidates: hits, source: 'filename' };
  }

  const scored = scoreCandidates(stem, problems, input.folders ?? []);
  const suggestions = scored.map((x) => x.p);
  const decision = decideSuggestion(scored);
  if (decision.kind === 'suggested') return { kind: 'match', problem: decision.problem, source: 'suggested', suggestions };
  if (decision.kind === 'close') return { kind: 'ambiguous', candidates: decision.candidates, source: 'suggested' };
  return { kind: 'none', suggestions };
}

export interface ScoredCandidate {
  p: Problem;
  score: number;
}

/**
 * Candidates by match score (best first, at least MATCH.pickerMinScore):
 * name similarity (token overlap / shared part), plus MATCH.folderTagBonus
 * when a parent folder is named like one of the problem's tags.
 */
export function scoreCandidates(stem: string, problems: Problem[], folders: string[] = [], max: number = MATCH.maxCandidates): ScoredCandidate[] {
  if (!stem) return [];
  const tokens = new Set(stem.split('_').filter((t) => t.length >= 2));
  const dirs = folders.map(normalizeName).filter(Boolean);
  return problems
    .map((p) => {
      const n = normalizeName(p.name);
      const f = normalizeName(p.fullName);
      let score = Math.max(similarity(stem, tokens, n), similarity(stem, tokens, f) * 0.9);
      if (score > 0 && dirs.length && (p.tags ?? []).some((t) => dirs.includes(normalizeName(t)))) score += MATCH.folderTagBonus;
      return { p, score: Math.min(1, score) };
    })
    .filter((x) => x.score >= MATCH.pickerMinScore)
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    .slice(0, max);
}

/** Use the top candidate only when it is confident and clearly ahead. */
export function decideSuggestion(
  scored: ScoredCandidate[],
): { kind: 'suggested'; problem: Problem; score: number } | { kind: 'close'; candidates: Problem[] } | { kind: 'below' } {
  const [top, next] = scored;
  if (!top || top.score < MATCH.suggestMinScore) return { kind: 'below' };
  if (next && top.score - next.score < MATCH.suggestMinMargin) {
    return { kind: 'close', candidates: scored.filter((x) => top.score - x.score < MATCH.suggestMinMargin).map((x) => x.p) };
  }
  return { kind: 'suggested', problem: top.p, score: top.score };
}

/** The closest few problems by match score (picker candidates). */
export function suggest(stem: string, problems: Problem[], max: number = MATCH.maxCandidates): Problem[] {
  return scoreCandidates(stem, problems, [], max).map((x) => x.p);
}

function similarity(stem: string, tokens: Set<string>, name: string): number {
  if (!name) return 0;
  if (name.includes(stem) || stem.includes(name)) return 0.9 * (Math.min(stem.length, name.length) / Math.max(stem.length, name.length)) + 0.1;
  const other = new Set(name.split('_').filter((t) => t.length >= 2));
  if (!tokens.size || !other.size) return 0;
  let common = 0;
  for (const t of tokens) if (other.has(t)) common++;
  return common / Math.max(tokens.size, other.size);
}

export function placeholder(id: number, name = ''): Problem {
  return {
    id,
    name: name || `#${id}`,
    fullName: name,
    bestScore: null,
    lastScore: null,
    lastResult: null,
    lastSubmissionId: null,
    lastSubmissionTime: null,
    submissionCount: 0,
    hasTestcase: false,
    hasAttachment: false,
    permittedLanguageIds: null,
    tags: [],
    list: null,
  };
}

/** A safe file name from a problem name (clean name, path separators and reserved characters replaced). */
export function fileNameFor(problemName: string, ext: string): string {
  const safe = cleanName(problemName).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+$/g, '') || 'problem';
  return `${safe}.${ext.replace(/^\./, '')}`;
}
