import type { Problem } from '../grader/types';
import { MATCH } from '../shared/constants';
import type { CphProblem } from './cph';
import { matchCphProblem } from './cph';
import { applyPattern, DEFAULT_NAME_PATTERN, isDefaultPattern, stemFor } from './namePattern';

/** How the current file's problem was chosen (an icon next to the problem name). */
export type MatchSource = 'saved' | 'cph' | 'filename' | 'folder' | 'suggested';

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
  const hit = NORMALIZED.get(s);
  if (hit !== undefined) return hit;
  const n = cleanName(s)
    .toLowerCase()
    .replace(/[\s\-_.]+/g, '_')
    .replace(/^_+|_+$/g, '');
  remember(NORMALIZED, s, n);
  return n;
}

/**
 * Memo of the pure name helpers: the match index runs the matcher over up to
 * 5 000 files against every problem, and normalizing the same ~300 problem
 * names again for each file took ~1.7 s of the extension host's thread.
 * Bounded: emptied when it grows past MEMO_MAX entries.
 */
const MEMO_MAX = 20_000;
const NORMALIZED = new Map<string, string>();
const TOKENS = new Map<string, Set<string>>();

function remember<T>(memo: Map<string, T>, key: string, value: T): void {
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(key, value);
}

/** Per problem object (the list's objects are reused for every file): normalized name, full name, pattern stem. */
const PROBLEM_NAMES = new WeakMap<Problem, { name: string; full: string; pattern?: string; patternStem?: string }>();

function namesOf(p: Problem): { name: string; full: string; pattern?: string; patternStem?: string } {
  let n = PROBLEM_NAMES.get(p);
  if (!n) {
    n = { name: normalizeName(p.name), full: normalizeName(p.fullName) };
    PROBLEM_NAMES.set(p, n);
  }
  return n;
}

/** The normalized name a problem's file gets from the file-name pattern ("{id}_{name}" → "1360_00_intro_11"). */
function patternStem(pattern: string, p: Problem): string {
  const n = namesOf(p);
  if (n.pattern !== pattern || n.patternStem === undefined) {
    n.pattern = pattern;
    n.patternStem = normalizeName(stemFor(pattern, { id: p.id, cleanName: cleanName(p.name) }));
  }
  return n.patternStem;
}

/** The words of a normalized name (2+ characters), as compared by `similarity`. */
function tokensOf(name: string): Set<string> {
  let t = TOKENS.get(name);
  if (!t) {
    t = new Set(name.split('_').filter((x) => x.length >= 2));
    remember(TOKENS, name, t);
  }
  return t;
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
  /** File-name pattern (`cedtGrader.fileNamePattern`, validated); a file named by it is an exact match too. */
  namePattern?: string;
}

export type MatchResult =
  | { kind: 'match'; problem: Problem; source: MatchSource; suggestions: Problem[] }
  /** Several problems match equally well (or suggestions too close to call): don't choose, ask. */
  | { kind: 'ambiguous'; candidates: Problem[]; source: 'cph' | 'filename' | 'folder' | 'suggested' }
  /** A saved link whose problem is no longer on the grader (missing from the list). Kept, shown as unavailable. */
  | { kind: 'unavailable'; problemId: number; suggestions: Problem[] }
  | { kind: 'none'; suggestions: Problem[] };

/**
 * Matching order for the active file:
 *  1. a saved mapping (always wins; when its problem no longer exists it is
 *     reported as unavailable, never silently replaced),
 *  2. the CPH .prob file (grader URL or problem name),
 *  3. exact normalized match between file name and problem name,
 *  4. exact normalized match between the name of the folder the file is in
 *     and a problem name (source 'folder'), so every file of a package folder
 *     named like a problem belongs to it,
 *  5. otherwise a suggestion: the closest candidate when its score reaches
 *     MATCH.suggestMinScore and leads the next one by MATCH.suggestMinMargin
 *     (source 'suggested', not saved); close candidates → ambiguous
 *     ("Several problems could match"); below the threshold → the same rules
 *     for the folder's name; still nothing → none (the candidates are only
 *     offered in the picker).
 * More than one equally good match → ambiguous (the user is asked).
 * The folder is the file's parent inside the workspace (`folders`, relative):
 * a file at the top of a workspace folder has none.
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
  const fileHits = exactHits(stem, problems, input.namePattern);
  if (fileHits.length === 1) return { kind: 'match', problem: fileHits[0], source: 'filename', suggestions: [] };
  if (fileHits.length > 1) return { kind: 'ambiguous', candidates: fileHits, source: 'filename' };

  const folders = input.folders ?? [];
  const folder = normalizeName(folders[folders.length - 1] ?? '');
  const folderHits = exactHits(folder, problems, input.namePattern);
  if (folderHits.length === 1) return { kind: 'match', problem: folderHits[0], source: 'folder', suggestions: [] };
  if (folderHits.length > 1) return { kind: 'ambiguous', candidates: folderHits, source: 'folder' };

  const scored = scoreCandidates(stem, problems, folders);
  const decision = decideSuggestion(scored);
  if (decision.kind === 'suggested') return { kind: 'match', problem: decision.problem, source: 'suggested', suggestions: scored.map((x) => x.p) };
  if (decision.kind === 'close') return { kind: 'ambiguous', candidates: decision.candidates, source: 'suggested' };
  // The file name says nothing: the same rules for the folder's name.
  const byFolder = scoreCandidates(folder, problems, folders);
  const folderDecision = decideSuggestion(byFolder);
  if (folderDecision.kind === 'suggested') return { kind: 'match', problem: folderDecision.problem, source: 'suggested', suggestions: byFolder.map((x) => x.p) };
  if (folderDecision.kind === 'close') return { kind: 'ambiguous', candidates: folderDecision.candidates, source: 'suggested' };
  return { kind: 'none', suggestions: (scored.length ? scored : byFolder).map((x) => x.p) };
}

/** Problems whose name (or full name, or file-name pattern stem) normalizes to `stem`. */
function exactHits(stem: string, problems: Problem[], pattern: string | undefined): Problem[] {
  if (!stem) return [];
  let hits = problems.filter((p) => namesOf(p).name === stem);
  if (!hits.length) hits = problems.filter((p) => namesOf(p).full === stem);
  // A name made by the file-name pattern ("{id}_{name}.{ext}" → "1360_00_Intro_11") is exact too.
  if (!hits.length && !isDefaultPattern(pattern)) {
    hits = problems.filter((p) => patternStem(pattern!, p) === stem);
  }
  return hits;
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
  const tokens = tokensOf(stem);
  const dirs = folders.map(normalizeName).filter(Boolean);
  return problems
    .map((p) => {
      const { name: n, full: f } = namesOf(p);
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
  const other = tokensOf(name);
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

/**
 * A problem's full name without a repeated "name:" prefix (card title,
 * questions); null when it adds nothing to the name.
 */
export function problemSubtitle(name: string, fullName: string): string | null {
  const full = fullName.trim();
  if (!full || full === name) return null;
  if (full.startsWith(`${name}:`)) return full.slice(name.length + 1).trim() || null;
  return full;
}

/** A safe folder name for a problem (folder mode, extracted attachments): the file-name pattern without `.{ext}`. */
export function folderNameFor(problemName: string, pattern: string = DEFAULT_NAME_PATTERN, problemId = 0): string {
  return stemFor(isDefaultPattern(pattern) ? DEFAULT_NAME_PATTERN : pattern, { id: problemId, cleanName: cleanName(problemName) }).normalize('NFC');
}

/**
 * A safe file name for a problem (clean name, path separators and reserved
 * characters replaced), by the file-name pattern (default `{name}.{ext}`).
 */
export function fileNameFor(problemName: string, ext: string, pattern: string = DEFAULT_NAME_PATTERN, problemId = 0): string {
  return applyPattern(isDefaultPattern(pattern) ? DEFAULT_NAME_PATTERN : pattern, { id: problemId, cleanName: cleanName(problemName) }, ext);
}
