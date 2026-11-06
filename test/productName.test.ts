import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|css|md|json)$/.test(n) ? [p] : [];
  });

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

describe('product name', () => {
  it('is Grader Submit, on the extension ID that keeps updates and stored data', () => {
    expect(pkg.displayName).toBe('Grader Submit');
    expect(pkg.name).toBe('cedt-grader-submit');
    expect(pkg.publisher).toBe('Badvoic3');
  });

  // Lower-case ids (`cedtGrader.*`, `.cedt-grader.json`, the default address) stay: nobody reads them as a name.
  it('no text anyone reads says CEDT', () => {
    const read = [...files('src'), ...files('webview'), ...files('media/walkthrough'), 'package.json', 'package.nls.json', 'package.nls.th.json'];
    expect(read.filter((f) => /CEDT/.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
