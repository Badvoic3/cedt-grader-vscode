import { languageForPath, matchLanguages } from '../grader/languages';
import type { Language } from '../grader/types';

/**
 * Languages never chosen automatically for a new file (offered only in the
 * quick pick): archives / binaries / non-source "languages". cafe-grader
 * marks Archive as `binary: true`; the API does not expose that flag, so the
 * known names and extensions are listed here.
 */
const NON_SOURCE_CODES = new Set(['archive', 'digital', 'viva', 'text']);
const NON_SOURCE_EXTS = new Set(['zip', 'jar', 'dig', 'null', '', 'bin', 'exe', 'o', 'out', 'txt']);

export function isAutoPickable(l: Language): boolean {
  return !NON_SOURCE_CODES.has(l.code.toLowerCase()) && !NON_SOURCE_EXTS.has((l.ext ?? '').toLowerCase());
}

export type NewFileLanguage = { kind: 'auto'; language: Language; reason: 'active-file' | 'last-used' | 'default' } | { kind: 'pick'; options: Language[] };

/**
 * Extension for "New file for this problem", in this order:
 *  1. the active file's language, if permitted;
 *  2. the last language used for new files, if permitted;
 *  3. `cedtGrader.defaultLanguage` (default C++), if permitted;
 *  4. otherwise ask (quick pick of all permitted languages, binaries included).
 * Archive / binary / non-source languages are never chosen automatically.
 */
export function chooseNewFileLanguage(opts: {
  permitted: Language[];
  activeFilePath: string | null;
  lastUsedLanguageId: number | null;
  defaultLanguageName: string;
}): NewFileLanguage {
  const auto = opts.permitted.filter(isAutoPickable);
  if (opts.activeFilePath) {
    const wanted = languageForPath(opts.activeFilePath);
    const hit = wanted ? matchLanguages(wanted, auto)[0] : undefined;
    if (hit) return { kind: 'auto', language: hit, reason: 'active-file' };
  }
  const last = auto.find((l) => l.id === opts.lastUsedLanguageId);
  if (last) return { kind: 'auto', language: last, reason: 'last-used' };
  const def = matchLanguages(opts.defaultLanguageName, auto)[0] ?? auto.find((l) => l.name.toLowerCase() === opts.defaultLanguageName.toLowerCase());
  if (def) return { kind: 'auto', language: def, reason: 'default' };
  return { kind: 'pick', options: opts.permitted };
}
