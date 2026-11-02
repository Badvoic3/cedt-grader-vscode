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

/** Extra spellings a server might use for the same language. */
const ALIASES: Readonly<Record<string, string[]>> = {
  'C++': ['c++', 'cpp', 'g++'],
  C: ['c', 'gcc'],
  Python: ['python', 'python3', 'py'],
  Java: ['java'],
  Rust: ['rust'],
  Go: ['go', 'golang'],
  PHP: ['php'],
  Haskell: ['haskell', 'ghc'],
  Ruby: ['ruby'],
  Pascal: ['pascal', 'fpc', 'freepascal'],
  PostgreSQL: ['postgresql', 'postgres', 'sql'],
  Digital: ['digital'],
};

export function languageForPath(filePath: string): string | null {
  const m = /(\.[^./\\]+)$/.exec(filePath.toLowerCase());
  return m ? (EXTENSION_LANGUAGE[m[1]] ?? null) : null;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Options of the per-problem `<select>` that match a canonical language.
 * Exact alias matches win; otherwise a name that starts with the alias and
 * continues with a space/digit/paren (e.g. `Python 3`, `C++17`) is accepted,
 * but `C` never matches `C++` / `C#`.
 */
export function matchLanguages(canonical: string, options: Language[]): Language[] {
  const aliases = ALIASES[canonical] ?? [norm(canonical)];
  const exact = options.filter((o) => aliases.includes(norm(o.name)));
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

export function chooseLanguage(filePath: string, options: Language[], forced = false): LanguageChoice {
  if (forced && options.length >= 1) {
    // Server forces its only permitted language; still verify it fits the file.
    const wanted = languageForPath(filePath);
    if (wanted && matchLanguages(wanted, options).length === 0) {
      return { kind: 'not-allowed', wanted, allowed: options };
    }
    return { kind: 'match', language: options.find((o) => o.selected) ?? options[0] };
  }
  const wanted = languageForPath(filePath);
  if (!wanted) return { kind: 'unknown-extension', allowed: options };
  const matches = matchLanguages(wanted, options);
  if (matches.length === 1) return { kind: 'match', language: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches };
  return { kind: 'not-allowed', wanted, allowed: options };
}
