import type { Problem } from '../grader/types';
import { S } from '../shared/strings';
import type { MatchResult, MatchSource } from './match';

/**
 * Rules behind the panel's link actions (no `vscode` import; unit tested):
 * what Auto-detect does, what ✕ unlinks, and the matching note.
 */

/** Matching details for the active file: picker suggestions and the ambiguous candidates. */
export interface MatchInfo {
  suggestions: Problem[];
  ambiguous: Problem[] | null;
  ambiguousSource: 'cph' | 'filename' | 'folder' | 'suggested' | null;
}

export const NO_MATCH_INFO: MatchInfo = { suggestions: [], ambiguous: null, ambiguousSource: null };

/** The note under the selector when several problems match. */
export function matchNote(m: MatchInfo): string | null {
  if (!m.ambiguous) return null;
  if (m.ambiguousSource === 'suggested') return S.match.severalCould;
  if (m.ambiguousSource === 'folder') return S.match.severalMatchFolder;
  return S.match.severalMatch(m.ambiguousSource === 'cph');
}

/**
 * Auto-detect (matching without the saved link) for a file that may have a
 * saved link: switch to a different match (asked), say it agrees, say the
 * link is kept (nothing / several found), or apply (no saved link; `none` =
 * nothing at all was found).
 */
export type AutoDetectOutcome =
  | { kind: 'switch'; problem: Problem; source: MatchSource }
  | { kind: 'agrees'; problem: Problem; source: MatchSource }
  | { kind: 'kept'; ambiguous: number | null }
  | { kind: 'apply'; none: boolean };

export function autoDetectOutcome(savedProblemId: number | null, m: MatchResult): AutoDetectOutcome {
  if (savedProblemId !== null) {
    if (m.kind === 'match') return { kind: m.problem.id !== savedProblemId ? 'switch' : 'agrees', problem: m.problem, source: m.source };
    return { kind: 'kept', ambiguous: m.kind === 'ambiguous' ? m.candidates.length : null };
  }
  return { kind: 'apply', none: m.kind === 'none' && !m.suggestions.length };
}

/**
 * What ✕ ("Unlink this file / folder", "Don't match this file / folder")
 * applies to: a folder link, a folder matched by its name, or the file.
 */
export type UnlinkScope = 'folder-link' | 'folder-name' | 'file';

export function unlinkScope(o: { folderLink: boolean; folderMatched: boolean; source: MatchSource | null }): UnlinkScope {
  if (o.folderLink) return o.folderMatched ? 'folder-name' : 'folder-link';
  return o.source === 'folder' ? 'folder-name' : 'file';
}
