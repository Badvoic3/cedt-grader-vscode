import type { Language } from './types';

/**
 * Languages come from the server (`GET /api/v1/languages`: name, pretty
 * name, `ext`; cached for the session). This table is only the fallback for
 * when that list isn't available (offline, before login) or doesn't know an
 * extension (e.g. `.cc` / `.cxx`, which the server lists as `cpp`).
 * File extension (lowercase, with dot) → canonical cafe-grader language name.
 */
export const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  '.cpp': 'C++',
  '.cc': 'C++',
  '.cxx': 'C++',
  // Headers (folder mode: a package's file to submit is often a header). `.h` is C when only C is allowed.
  '.h': 'C++',
  '.hpp': 'C++',
  '.hh': 'C++',
  '.hxx': 'C++',
  '.c': 'C',
  '.py': 'Python',
  '.java': 'Java',
  '.rs': 'Rust',
  '.go': 'Go',
  '.php': 'PHP',
  '.hs': 'Haskell',
  '.rb': 'Ruby',
  '.pas': 'Pascal',
  '.sql': 'PostgreSQL',
  '.dig': 'Digital',
};

/** Spellings a server may use for the same language (display name, internal name or extension). */
const ALIASES: Readonly<Record<string, string[]>> = {
  'C++': ['c++', 'cpp', 'g++', 'cc', 'cxx'],
  C: ['c', 'gcc'],
  Python: ['python', 'python3', 'py'],
  Java: ['java'],
  Rust: ['rust', 'rs'],
  Go: ['go', 'golang'],
  PHP: ['php'],
  Haskell: ['haskell', 'ghc', 'hs'],
  Ruby: ['ruby', 'rb'],
  Pascal: ['pascal', 'fpc', 'freepascal', 'pas'],
  PostgreSQL: ['postgresql', 'postgres', 'sql'],
  Digital: ['digital', 'dig'],
};

/** Lower-case extension without the dot ('' if none). */
export function fileExt(filePath: string): string {
  const m = /\.([^./\\]+)$/.exec(filePath.toLowerCase());
  return m ? m[1] : '';
}

/** Server languages whose `ext` is the file's extension. */
export function languagesByExt(filePath: string, options: Language[]): Language[] {
  const ext = fileExt(filePath);
  return ext ? options.filter((o) => (o.ext ?? '').toLowerCase().replace(/^\./, '') === ext) : [];
}

/** Fallback table only (see EXTENSION_LANGUAGE). */
export function languageForPath(filePath: string): string | null {
  const ext = fileExt(filePath);
  return ext ? (EXTENSION_LANGUAGE[`.${ext}`] ?? null) : null;
}

/**
 * Language name for a file: the server's language for its extension when
 * the server list (`all`) knows it, else the fallback table.
 */
export function languageNameForPath(filePath: string, all: Language[]): string | null {
  const byExt = languagesByExt(filePath, all);
  if (byExt.length) return byExt[0].name;
  return languageForPath(filePath);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Languages matching a canonical name. Exact matches on display name,
 * internal code or extension win; otherwise a display name that starts with
 * an alias followed by a space/digit/paren (`Python 3`, `C++17`). `C` never
 * matches `C++` / `C#`.
 */
export function matchLanguages(canonical: string, options: Language[]): Language[] {
  const aliases = ALIASES[canonical] ?? [norm(canonical)];
  const exact = options.filter((o) => [o.name, o.code, o.ext].some((v) => aliases.includes(norm(v ?? ''))));
  if (exact.length) return exact;
  return options.filter((o) => {
    const n = norm(o.name);
    return aliases.some((a) => n.startsWith(a) && /^(?:$|[\s\d(\-.])/.test(n.slice(a.length)));
  });
}

export type LanguageChoice =
  | { kind: 'match'; language: Language }
  | { kind: 'ambiguous'; candidates: Language[] }
  | { kind: 'not-allowed'; wanted: string; allowed: Language[] }
  | { kind: 'unknown-extension'; allowed: Language[] };

/**
 * Pick the language for `filePath` among the problem's allowed languages.
 * The server's `ext` decides first (`all` = every server language, to tell
 * "not allowed here" from "unknown"); the fallback table only when the
 * server doesn't list the extension.
 */
export function chooseLanguage(filePath: string, options: Language[], all: Language[] = []): LanguageChoice {
  const byExt = languagesByExt(filePath, options);
  if (byExt.length === 1) return { kind: 'match', language: byExt[0] };
  if (byExt.length > 1) return { kind: 'ambiguous', candidates: byExt };
  const known = languagesByExt(filePath, all);
  if (known.length) return { kind: 'not-allowed', wanted: known[0].name, allowed: options };
  let wanted = languageForPath(filePath);
  // A `.h` header is C++ or C: C when the problem takes C but not C++.
  if (fileExt(filePath) === 'h' && !matchLanguages('C++', options).length && matchLanguages('C', options).length) wanted = 'C';
  if (options.length === 1) {
    if (wanted && matchLanguages(wanted, options).length === 0) return { kind: 'not-allowed', wanted, allowed: options };
    return { kind: 'match', language: options[0] };
  }
  if (!wanted) return { kind: 'unknown-extension', allowed: options };
  const matches = matchLanguages(wanted, options);
  if (matches.length === 1) return { kind: 'match', language: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches };
  return { kind: 'not-allowed', wanted, allowed: options };
}
