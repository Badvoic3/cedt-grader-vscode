import { describe, expect, it } from 'vitest';
import { chooseLanguage, languageForPath, languageNameForPath, matchLanguages, type Language } from '../src/grader';

const L = (id: number, name: string, ext = '', code = ''): Language => ({ id, name, code, ext });
const OPTS = [L(1, 'C', 'c', 'c'), L(2, 'C++', 'cpp', 'cpp'), L(3, 'Pascal', 'pas'), L(4, 'Python', 'py', 'python'), L(5, 'Java', 'java'), L(6, 'Rust', 'rs'), L(7, 'Go', 'go'), L(8, 'PostgreSQL', 'sql')];

describe('languageForPath', () => {
  it.each([
    ['a.cpp', 'C++'],
    ['a.cc', 'C++'],
    ['A.CXX', 'C++'],
    ['a.c', 'C'],
    ['x/y/sol.py', 'Python'],
    ['Main.java', 'Java'],
    ['m.rs', 'Rust'],
    ['m.go', 'Go'],
    ['m.php', 'PHP'],
    ['m.hs', 'Haskell'],
    ['m.rb', 'Ruby'],
    ['m.pas', 'Pascal'],
    ['q.sql', 'PostgreSQL'],
    ['circuit.dig', 'Digital'],
  ])('%s → %s', (path, lang) => {
    expect(languageForPath(path)).toBe(lang);
  });

  it('unknown extensions', () => {
    expect(languageForPath('notes.txt')).toBeNull();
    expect(languageForPath('Makefile')).toBeNull();
  });
});

describe('matchLanguages', () => {
  it('C does not match C++', () => {
    expect(matchLanguages('C', OPTS).map((l) => l.id)).toEqual([1]);
    expect(matchLanguages('C++', OPTS).map((l) => l.id)).toEqual([2]);
  });

  it('accepts versioned names', () => {
    const opts = [L(10, 'Python 3'), L(11, 'Python 2'), L(12, 'C++17')];
    expect(matchLanguages('Python', opts).map((l) => l.id)).toEqual([10, 11]);
    expect(matchLanguages('C++', opts).map((l) => l.id)).toEqual([12]);
    expect(matchLanguages('C', opts)).toEqual([]);
  });

  it('case-insensitive aliases', () => {
    expect(matchLanguages('C++', [L(1, 'cpp')]).map((l) => l.id)).toEqual([1]);
    expect(matchLanguages('Go', [L(1, 'Golang')]).map((l) => l.id)).toEqual([1]);
  });
});

describe('chooseLanguage', () => {
  it('match', () => {
    expect(chooseLanguage('sol.cpp', OPTS)).toEqual({ kind: 'match', language: OPTS[1] });
  });
  it('ambiguous', () => {
    const r = chooseLanguage('a.py', [L(10, 'Python 3'), L(11, 'Python 2')]);
    expect(r.kind).toBe('ambiguous');
  });
  it('not allowed for this problem', () => {
    const r = chooseLanguage('a.java', [L(2, 'C++')]);
    expect(r).toMatchObject({ kind: 'not-allowed', wanted: 'Java' });
  });
  it('unknown extension', () => {
    expect(chooseLanguage('a.txt', OPTS).kind).toBe('unknown-extension');
  });
  it('single allowed language must still fit the file', () => {
    expect(chooseLanguage('a.cpp', [L(2, 'C++', 'cpp')])).toMatchObject({ kind: 'match' });
    expect(chooseLanguage('a.py', [L(2, 'C++', 'cpp')])).toMatchObject({ kind: 'not-allowed' });
  });
  it('matches on the API extension / internal name too', () => {
    expect(matchLanguages('C++', [L(9, 'GNU G++ 17', 'cpp', 'cpp')]).map((l) => l.id)).toEqual([9]);
  });
});

describe('languages come from the server (GET /api/v1/languages ext); the table is only a fallback', () => {
  it('a language the table does not know is matched by the server ext', () => {
    const all = [...OPTS, L(9, 'Kotlin', 'kt', 'kotlin')];
    expect(chooseLanguage('Main.kt', all, all)).toEqual({ kind: 'match', language: L(9, 'Kotlin', 'kt', 'kotlin') });
    expect(languageNameForPath('Main.kt', all)).toBe('Kotlin');
    expect(languageForPath('Main.kt')).toBeNull(); // not in the fallback table
  });

  it('server ext known but not allowed for this problem → not-allowed with the server name', () => {
    const all = [...OPTS, L(9, 'Kotlin', 'kt')];
    expect(chooseLanguage('Main.kt', [OPTS[1], OPTS[3]], all)).toMatchObject({ kind: 'not-allowed', wanted: 'Kotlin' });
  });

  it('the server name wins over the table (pretty names differ per server)', () => {
    const all = [L(2, 'C++ (g++ 13, C++20)', 'cpp', 'cpp')];
    expect(languageNameForPath('a.cpp', all)).toBe('C++ (g++ 13, C++20)');
    expect(chooseLanguage('a.cpp', all, all)).toMatchObject({ kind: 'match', language: { id: 2 } });
  });

  it('extensions the server does not list (.cc) and no server list at all (offline) use the table', () => {
    expect(chooseLanguage('a.cc', OPTS, OPTS)).toMatchObject({ kind: 'match', language: { id: 2 } });
    expect(chooseLanguage('a.py', OPTS)).toMatchObject({ kind: 'match', language: { id: 4 } });
    expect(languageNameForPath('a.cc', [])).toBe('C++');
  });
});
