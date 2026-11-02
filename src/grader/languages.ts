import type { Language } from './types';

/** File extension (lowercase, with dot) → canonical cafe-grader language name. */
export const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  '.cpp': 'C++',
  '.cc': 'C++',
  '.cxx': 'C++',
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

export function languageForPath(filePath: string): string | null {
  const m = /(\.[^./\\]+)$/.exec(filePath.toLowerCase());
  return m ? (EXTENSION_LANGUAGE[m[1]] ?? null) : null;
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

/** Pick the language for `filePath` among the problem's allowed languages. */
export function chooseLanguage(filePath: string, options: Language[]): LanguageChoice {
  const wanted = languageForPath(filePath);
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
