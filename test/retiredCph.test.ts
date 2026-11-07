/**
 * CPH and `.in` / `.out` export are retired. All that is left is reading old
 * data once, in `src/migration/`, which nothing else may reach. Nothing may
 * write `.cph` or `.in` / `.out` files.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const files = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((f) => {
    const p = join(dir, f.name);
    return f.isDirectory() ? files(p) : /\.ts$/.test(f.name) ? [p] : [];
  });
const code = [...files('src'), ...files('webview')].map((p) => ({ path: relative('.', p), text: readFileSync(join(ROOT, p), 'utf8') }));
const outsideMigration = code.filter((f) => !f.path.startsWith('src/migration/'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const CPH_ID = 'DivyanshuAgrawal.competitive-programming-helper';

describe('CPH is gone', () => {
  it('only the extension itself reaches src/migration/, through importLinks, from the controller', () => {
    const importers = outsideMigration.filter((f) => /from '[./]*migration\//.test(f.text)).map((f) => f.path);
    expect(importers).toEqual(['src/controller.ts']);
  });

  it("no code outside src/migration/ names CPH's id, commands or settings", () => {
    const hits = outsideMigration.filter((f) => /competitive-programming-helper|cph\.(runTestCases|general)|getConfiguration\('cph'\)|\.prob\b/.test(f.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ''))).map((f) => f.path);
    expect(hits).toEqual([]);
  });

  it('the migration only reads: no write call touches a .cph path', () => {
    for (const f of code) expect(f.text, f.path).not.toMatch(/(writeFile|copyFile|mkdir)\([^)]*(\.cph|\.prob)/);
    const cph = code.find((f) => f.path === 'src/migration/cph.ts');
    expect(cph?.text).not.toMatch(/writeFile|copyFile|mkdir/);
  });

  it('no setting, key, command, keyword or walkthrough step is left', () => {
    const pkg = JSON.stringify(manifest);
    expect(pkg).not.toMatch(/CPH|competitive-programming-helper|saveTestcasesAsFiles/i);
    expect(manifest.extensionDependencies ?? []).not.toContain(CPH_ID);
    expect(manifest.extensionPack ?? []).not.toContain(CPH_ID);
    const keys = code.find((f) => f.path === 'src/shared/stateKeys.ts')?.text;
    expect(keys).not.toMatch(/cphTipDismissed|cphAutoShowDismissed|testcaseTarget/);
  });

  it('no user-facing text mentions CPH', () => {
    for (const p of ['src/shared/strings.ts', 'src/shared/strings.th.ts', 'package.nls.json', 'package.nls.th.json']) {
      expect(readFileSync(join(ROOT, p), 'utf8'), p).not.toMatch(/\bCPH\b|Competitive Programming Helper/);
    }
  });
});

describe('.in / .out export is gone', () => {
  it('nothing writes test cases into the workspace', () => {
    for (const f of code) expect(f.text, f.path).not.toMatch(/\.(in|out)['`]\s*[,)]|saveTestcasesAsFiles|testsFolderOf|testsFolderFor/);
  });
});
