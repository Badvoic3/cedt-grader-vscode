import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Language } from '../src/grader';
import { caseInsensitiveGlob, excludeGlob, filterCandidates, includeGlob, rankCandidates } from '../src/mapping/findByName';
import { chooseNewFileLanguage, isAutoPickable } from '../src/mapping/newFileLanguage';

// Languages as the real server reports them (test/fixtures/api_languages.json).
const L = (id: number, name: string, code: string, ext: string): Language => ({ id, name, code, ext });
const ARCHIVE = L(13, 'Archive', 'archive', 'zip');
const C = L(1, 'C', 'c', 'c');
const CPP = L(2, 'C++', 'cpp', 'cpp');
const DIGITAL = L(8, 'Digital', 'digital', 'dig');
const PY = L(6, 'Python', 'python', 'py');
const JAVA = L(4, 'Java', 'java', 'java');
const VIVA = L(15, 'Viva Exam', 'viva', 'null');
const TEXT = L(14, 'Text', 'text', 'txt');

describe('New file: extension order', () => {
  const base = { activeFilePath: null as string | null, lastUsedLanguageId: null as number | null, defaultLanguageName: 'C++' };

  it('never auto-picks archive / binary / non-source languages', () => {
    expect([ARCHIVE, DIGITAL, VIVA, TEXT].map(isAutoPickable)).toEqual([false, false, false, false]);
    expect([C, CPP, PY, JAVA].map(isAutoPickable)).toEqual([true, true, true, true]);
  });

  it('1. the active file language, if permitted (Archive listed first is ignored)', () => {
    const r = chooseNewFileLanguage({ ...base, permitted: [ARCHIVE, C, CPP, PY], activeFilePath: '/w/x/sol.py', lastUsedLanguageId: CPP.id });
    expect(r).toEqual({ kind: 'auto', language: PY, reason: 'active-file' });
  });

  it('2. else the last language used for new files, if permitted', () => {
    const r = chooseNewFileLanguage({ ...base, permitted: [ARCHIVE, C, CPP, JAVA], activeFilePath: '/w/notes.md', lastUsedLanguageId: JAVA.id });
    expect(r).toEqual({ kind: 'auto', language: JAVA, reason: 'last-used' });
  });

  it('3. else cedtGrader.defaultLanguage (C++), if permitted', () => {
    expect(chooseNewFileLanguage({ ...base, permitted: [ARCHIVE, C, CPP], lastUsedLanguageId: PY.id })).toEqual({ kind: 'auto', language: CPP, reason: 'default' });
    expect(chooseNewFileLanguage({ ...base, permitted: [ARCHIVE, PY], defaultLanguageName: 'Python' })).toEqual({ kind: 'auto', language: PY, reason: 'default' });
  });

  it('4. else a quick pick of all permitted languages (binaries offered there)', () => {
    expect(chooseNewFileLanguage({ ...base, permitted: [ARCHIVE, DIGITAL] })).toEqual({ kind: 'pick', options: [ARCHIVE, DIGITAL] });
    // a .dig active file still does not auto-pick Digital
    expect(chooseNewFileLanguage({ ...base, permitted: [DIGITAL], activeFilePath: '/w/c.dig' }).kind).toBe('pick');
    // the active file's language is not permitted, nothing else fits
    expect(chooseNewFileLanguage({ ...base, permitted: [ARCHIVE, JAVA], activeFilePath: '/w/a.cpp', defaultLanguageName: 'C++' }).kind).toBe('pick');
  });
});

describe('Find file by name', () => {
  /** Fixture tree: .cpp sources, a compiled binary, a .dSYM bundle, build output, .cph data. */
  function tree() {
    const root = mkdtempSync(join(tmpdir(), 'find-'));
    const files = [
      'hw/00_Intro_11.cpp',
      'hw/00_intro_11.bin',
      'hw/00_Intro_11.dSYM/Contents/Resources/DWARF/00_Intro_11',
      'hw/00_Intro_11.dSYM/Contents/00_Intro_11.cpp',
      'build/00_Intro_11.cpp',
      'out/00_Intro_11.o',
      'other/00_INTRO_11.CPP',
      'other/00_Intro_11.py',
      'other/00_Intro_11_v2.cpp',
      '.cph/00_Intro_11.cpp',
      'node_modules/x/00_Intro_11.cpp',
    ];
    for (const f of files) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), '');
    }
    return { root, all: files.map((f) => join(root, f)) };
  }

  it('keeps only sources of permitted languages, named exactly like the problem (case-insensitive)', () => {
    const { root, all } = tree();
    const kept = filterCandidates(all, '00_​Intro_11', ['cpp', 'cc', 'cxx']).map((p) => p.slice(root.length + 1)).sort();
    expect(kept).toEqual(['hw/00_Intro_11.cpp', 'other/00_INTRO_11.CPP']);
    // Python not permitted → .py excluded; with Python permitted it is included.
    expect(filterCandidates(all, '00_Intro_11', ['py']).map((p) => p.slice(root.length + 1))).toEqual(['other/00_Intro_11.py']);
    // Binary extensions never, even if a language claims them.
    expect(filterCandidates(all, '00_Intro_11', ['bin', 'o', 'zip'])).toEqual([]);
  });

  it('ranks: same folder as the active file first, then most recently modified', () => {
    const { root } = tree();
    const a = join(root, 'hw/00_Intro_11.cpp');
    const b = join(root, 'other/00_INTRO_11.CPP');
    utimesSync(a, new Date('2026-01-01'), new Date('2026-01-01'));
    utimesSync(b, new Date('2026-06-01'), new Date('2026-06-01'));
    const mtime = (p: string) => (p === a ? Date.parse('2026-01-01') : Date.parse('2026-06-01'));
    expect(rankCandidates([a, b], join(root, 'hw'), mtime)).toEqual([a, b]);
    expect(rankCandidates([a, b], join(root, 'elsewhere'), mtime)).toEqual([b, a]);
  });

  it('globs: case-insensitive include; exclude merges our folders, *.dSYM, settings and .gitignore', () => {
    expect(caseInsensitiveGlob('Ab_1')).toBe('[aA][bB]_1');
    expect(includeGlob('00_Intro_11', ['cpp'])).toBe('**/00_[iI][nN][tT][rR][oO]_11.{cpp,CPP}');
    const ex = excludeGlob([{ '**/tmp': true, '**/keep': false }, { '**/dist': true }], 'node_modules/\n# comment\n/coverage\n*.log\n!important.log\n');
    for (const part of ['**/node_modules/**', '**/.git/**', '**/bin/**', '**/build/**', '**/out/**', '**/.cph/**', '**/*.dSYM/**', '**/tmp', '**/dist', 'coverage', '**/*.log']) {
      expect(ex).toContain(part);
    }
    expect(ex).not.toContain('**/keep');
    expect(ex).not.toContain('important.log');
  });
});
