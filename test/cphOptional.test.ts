import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseTestcaseTarget, CPH_EXTENSION_ID, CphPresence, saveTestcasesAsFiles, testsFolderFor } from '../src/cphIntegration';
import { resolveProblem } from '../src/mapping/match';
import { readCphProblem } from '../src/mapping/cph';
import { manifest } from './helpers';
import type { Problem } from '../src/grader';

function fakeExtensions(installed: boolean) {
  let listener = () => {};
  const api = {
    installed,
    getExtension: (id: string) => (api.installed && id === CPH_EXTENSION_ID ? { id } : undefined),
    onDidChange: (l: () => void) => ((listener = l), { dispose() {} }),
    fire: () => listener(),
  };
  return api;
}

describe('CPH detection', () => {
  it('absent: getExtension → undefined; re-checked when extensions change', () => {
    const ext = fakeExtensions(false);
    const changes: boolean[] = [];
    const cph = new CphPresence(ext, (v) => changes.push(v));
    expect(cph.installed).toBe(false);
    ext.installed = true;
    ext.fire();
    expect(cph.installed).toBe(true);
    ext.installed = false; // disabled in the Extensions view
    ext.fire();
    expect(cph.installed).toBe(false);
    expect(changes).toEqual([true, false]);
  });
});

describe('where test cases go', () => {
  it('CPH installed → CPH .prob, unchanged (even if "files" was chosen earlier)', () => {
    expect(chooseTestcaseTarget(true, undefined)).toBe('cph');
    expect(chooseTestcaseTarget(true, 'files')).toBe('cph');
  });
  it('CPH absent → ask once, then the remembered choice', () => {
    expect(chooseTestcaseTarget(false, undefined)).toBe('ask');
    expect(chooseTestcaseTarget(false, 'files')).toBe('files');
  });
});

describe('Save as files (CPH absent)', () => {
  const cases = [
    { testcaseId: 2, num: 2, input: '5 5', output: '10' },
    { testcaseId: 1, num: 1, input: '1 2\r\n', output: '3\n' },
  ];

  it('writes <problem>/tests/<n>.in|out next to the source, \\n line endings, trailing newline kept', async () => {
    const src = mkdtempSync(join(tmpdir(), 'tcfiles-'));
    const folder = testsFolderFor(src, '00_​Intro_11');
    expect(relative(src, folder)).toBe(join('00_Intro_11', 'tests'));
    const r = await saveTestcasesAsFiles(folder, cases);
    expect(r).toMatchObject({ written: 2, unchanged: 0, keptExisting: 0 });
    expect(readdirSync(folder).sort()).toEqual(['1.in', '1.out', '2.in', '2.out']);
    expect(readFileSync(join(folder, '1.in'), 'utf8')).toBe('1 2\n');
    expect(readFileSync(join(folder, '1.out'), 'utf8')).toBe('3\n');
    expect(readFileSync(join(folder, '2.in'), 'utf8')).toBe('5 5');
  });

  it('re-import: unchanged files are left; edited files are never overwritten', async () => {
    const folder = join(mkdtempSync(join(tmpdir(), 'tcfiles2-')), 'p', 'tests');
    await saveTestcasesAsFiles(folder, cases);
    writeFileSync(join(folder, '2.out'), 'my edited answer');
    const r = await saveTestcasesAsFiles(folder, cases);
    expect(r).toMatchObject({ written: 0, unchanged: 1, keptExisting: 1 });
    expect(readFileSync(join(folder, '2.out'), 'utf8')).toBe('my edited answer');
  });
});

describe('everything else works without CPH', () => {
  const P = (id: number, name: string): Problem => ({
    id, name, fullName: name, bestScore: null, lastScore: null, lastResult: null, lastSubmissionId: null, lastSubmissionTime: null,
    submissionCount: 0, hasTestcase: false, hasAttachment: false, permittedLanguageIds: null, tags: [], list: null,
  });

  it('linking: no .prob files → reading costs nothing and matching uses the file name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nocph-'));
    const src = join(dir, '00_Intro_11.cpp');
    writeFileSync(src, '');
    expect(await readCphProblem(src)).toBeNull();
    const r = resolveProblem({ savedProblemId: null, cph: null, filePath: src, problems: [P(1, '00_Intro_11')], baseUrl: 'https://x' });
    expect(r).toMatchObject({ kind: 'match', source: 'filename' });
    expect(readdirSync(dir)).toEqual(['00_Intro_11.cpp']); // nothing created (no .cph folder)
  });

  it('core modules (grader, data, sidebar UI, statement viewer) do not depend on CPH code', () => {
    const root = join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.ts$/.test(f.name) && /mapping\/cph|cphImport|cphIntegration/.test(readFileSync(p, 'utf8'))) offenders.push(relative(root, p));
      }
    };
    for (const d of ['src/grader', 'src/data', 'src/ui', 'webview']) walk(join(root, d));
    // src/data/testcaseStore.ts only imports the GraderCase *type* from cphImport.
    expect(offenders).toEqual(['src/data/testcaseStore.ts']);
    expect(readFileSync(join(root, 'src/data/testcaseStore.ts'), 'utf8')).toMatch(/import type \{ GraderCase \} from '..\/mapping\/cphImport'/);
  });

  it('CPH is not a dependency or part of an extension pack', () => {
    const pkg = manifest();
    expect(pkg.extensionDependencies ?? []).not.toContain(CPH_EXTENSION_ID);
    expect(pkg.extensionPack ?? []).not.toContain(CPH_EXTENSION_ID);
    const titles = [pkg.displayName, pkg.description, ...pkg.contributes.commands.map((c: { title: string }) => c.title)].join(' ');
    expect(titles).not.toMatch(/CPH|Competitive Programming Helper/);
  });
});


