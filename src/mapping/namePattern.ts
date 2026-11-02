/**
 * File-name pattern (setting `cedtGrader.fileNamePattern`, default
 * `{name}.{ext}`) used by "New file for this problem", "Rename file to match
 * the problem", and the matcher's exact-name step (both directions), so a
 * file named by the pattern is "Matched by file name". No `vscode` import.
 *
 * Placeholders: `{name}` (the clean problem name, safe for file names),
 * `{id}` (the problem id), `{ext}` (the language's extension). The pattern
 * must end with `.{ext}` and contain `{name}` or `{id}`; other text is kept
 * as it is (letters, digits, spaces, `-`, `_`, `.`).
 */
export const DEFAULT_NAME_PATTERN = '{name}.{ext}';

export type PatternProblem = 'ext' | 'nameOrId' | 'placeholder' | 'character';

export interface PatternCheck {
  /** The pattern to use: the setting when valid, otherwise the default. */
  pattern: string;
  /** Why the setting was not used (null: valid). */
  problem: PatternProblem | null;
}

const RESERVED = /[\\/:*?"<>|\u0000-\u001f]/;

export function checkPattern(raw: unknown): PatternCheck {
  const p = typeof raw === 'string' ? raw.trim() : '';
  if (!p) return { pattern: DEFAULT_NAME_PATTERN, problem: null };
  const bad = (problem: PatternProblem): PatternCheck => ({ pattern: DEFAULT_NAME_PATTERN, problem });
  if (!p.endsWith('.{ext}') || p.indexOf('{ext}') !== p.length - '{ext}'.length) return bad('ext');
  const stem = p.slice(0, -'.{ext}'.length);
  const unknown = [...stem.matchAll(/\{([^}]*)\}/g)].some((m) => m[1] !== 'name' && m[1] !== 'id');
  if (unknown || /[{}]/.test(stem.replace(/\{(name|id)\}/g, ''))) return bad('placeholder');
  if (!/\{(name|id)\}/.test(stem)) return bad('nameOrId');
  if (RESERVED.test(stem.replace(/\{(name|id)\}/g, ''))) return bad('character');
  return { pattern: p, problem: null };
}

/** A problem name made safe for a file name (path separators and reserved characters replaced). */
export function safeName(cleanProblemName: string): string {
  return cleanProblemName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+$/g, '') || 'problem';
}

/** The file name the pattern gives (pattern assumed valid, see `checkPattern`). */
export function applyPattern(pattern: string, problem: { id: number; cleanName: string }, ext: string): string {
  return stemFor(pattern, problem) + `.${ext.replace(/^\./, '')}`;
}

/** The pattern without `.{ext}`, placeholders filled in. */
export function stemFor(pattern: string, problem: { id: number; cleanName: string }): string {
  return pattern
    .slice(0, -'.{ext}'.length)
    .replace(/\{name\}/g, safeName(problem.cleanName))
    .replace(/\{id\}/g, String(problem.id));
}

export function isDefaultPattern(pattern: string | undefined): boolean {
  return !pattern || pattern === DEFAULT_NAME_PATTERN;
}
