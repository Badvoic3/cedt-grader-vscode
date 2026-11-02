import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BASE_URL } from '../src/shared/constants';

/** Source files of the extension and webviews. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|css)$/.test(f) ? [p] : [];
  });
}
const FILES = [...sources('src'), ...sources('webview')];

describe('scalability: nothing course-specific or scattered', () => {
  it('no course/problem names in code (problem names come from the server)', () => {
    const bad = /\b(diglab|exam6\d|da6\d_|i2cedt|chula|00_intro|01_expr)/i;
    const hits = FILES.filter((f) => bad.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('the default grader URL lives only in constants.ts (and package.json)', () => {
    const hits = FILES.filter((f) => !f.endsWith('constants.ts') && readFileSync(f, 'utf8').includes('cedt-grader.nattee.net'));
    expect(hits).toEqual([]);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.contributes.configuration.properties['cedtGrader.baseUrl'].default).toBe(DEFAULT_BASE_URL);
  });

  it('the score cap 100 is one named constant (no literal 100 in score logic)', () => {
    for (const f of ['src/grader/score.ts', 'src/grader/types.ts']) {
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code.replace(/\* 100\) \/ 100/g, '')).not.toMatch(/\b100\b/);
    }
  });
});
