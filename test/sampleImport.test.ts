// @vitest-environment jsdom
/**
 * Experimental "Import sample cases from this statement": message validation,
 * the import rules (CPH markers, duplicates, files), the folder-mode target
 * and the viewer's preview / button.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveTestcasesAsFiles } from '../src/cphIntegration';
import { cphProbPath, type CphProblem } from '../src/mapping/cph';
import { GRADER_ID_BASE, importIntoCph, STATEMENT_ID_BASE } from '../src/mapping/cphImport';
import { runFileFor } from '../src/mapping/folderRoles';
import { sampleCasesToImport, validateSampleCases } from '../src/mapping/sampleImport';
import { SAMPLES } from '../src/shared/constants';
import { W } from '../src/shared/strings';
import { renderSamples } from '../webview/samplesPreview';
import { buildToolbar } from '../webview/statementToolbar';

const ok = [
  { input: '3\n1 2 3', output: '6', annotated: false },
  { input: '1\n5', output: '5', annotated: true },
];

describe('message validation (webview data is untrusted)', () => {
  it('accepts strings within the caps; annotated must be exactly true', () => {
    expect(validateSampleCases(ok)).toEqual(ok);
    expect(validateSampleCases([{ input: '1', output: '', annotated: 'yes' }])).toEqual([{ input: '1', output: '', annotated: false }]);
  });

  it('rejects non-arrays, empty lists, wrong types, empty input, and anything over the caps', () => {
    for (const bad of [null, 'x', {}, [], [null], [{ input: 1, output: '2' }], [{ input: '1' }], [{ input: '  ', output: '2' }]]) expect(validateSampleCases(bad)).toBeNull();
    expect(validateSampleCases(Array.from({ length: SAMPLES.maxCases + 1 }, () => ok[0]))).toBeNull();
    expect(validateSampleCases([{ input: 'x'.repeat(SAMPLES.maxCaseChars + 1), output: '' }])).toBeNull();
    expect(validateSampleCases([{ input: '1', output: 'x'.repeat(SAMPLES.maxCaseChars + 1) }])).toBeNull();
  });

  it('numbered from 1, `\\n` line endings, one trailing newline', () => {
    expect(sampleCasesToImport([{ input: '1 2\r\n3  \n\n', output: '3', annotated: false }])).toEqual([{ testcaseId: 1, num: 1, input: '1 2\n3\n', output: '3\n' }]);
  });
});

describe('import (same rules as Load test cases)', () => {
  function workspace() {
    const dir = mkdtempSync(join(tmpdir(), 'samples-'));
    const src = join(dir, 'sol.cpp');
    writeFileSync(src, '');
    return { dir, src, prob: cphProbPath(src) };
  }

  it('statement cases get their own marker range, after my tests; duplicates by input+output are skipped', async () => {
    const { src, prob } = workspace();
    mkdirSync(join(prob, '..'), { recursive: true });
    const mine = { id: 1730000000000, input: '1\n5\n', output: '5\n' };
    const grader = { id: GRADER_ID_BASE + 21186, input: '9\n', output: '81\n' };
    writeFileSync(prob, JSON.stringify({ name: 'x', url: 'u', tests: [mine, grader], interactive: false, memoryLimit: 1024, timeLimit: 3000, srcPath: src, group: 'local', local: true }));
    const cases = sampleCasesToImport([...ok, { input: '9', output: '81', annotated: false }]);
    const r = await importIntoCph({ srcPath: src, problemName: 'x', problemUrl: 'u', cases, idBase: STATEMENT_ID_BASE });
    expect(r).toMatchObject({ added: 1, alreadyPresent: 2, total: 3, backupPath: `${prob}.bak` });
    const p = JSON.parse(readFileSync(prob, 'utf8')) as CphProblem;
    expect(p.tests).toEqual([mine, grader, { id: STATEMENT_ID_BASE + 1, input: '3\n1 2 3\n', output: '6\n' }]);
    expect(STATEMENT_ID_BASE + SAMPLES.maxCases).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(STATEMENT_ID_BASE).toBeGreaterThan(GRADER_ID_BASE + 1e14); // grader testcase ids never reach the statement range

    // Importing again changes nothing.
    const r2 = await importIntoCph({ srcPath: src, problemName: 'x', problemUrl: 'u', cases, idBase: STATEMENT_ID_BASE });
    expect(r2).toMatchObject({ added: 0, updated: 0, total: 3 });
  });

  it('without CPH: tests/sample<n>.in|out next to grader cases, never overwriting', async () => {
    const { dir } = workspace();
    const folder = join(dir, 'tests');
    mkdirSync(folder);
    writeFileSync(join(folder, '1.in'), 'grader\n');
    writeFileSync(join(folder, 'sample2.out'), 'mine\n');
    const r = await saveTestcasesAsFiles(folder, sampleCasesToImport(ok), 'sample');
    expect(r).toMatchObject({ written: 2, keptExisting: 0 });
    expect(readdirSync(folder).sort()).toEqual(['1.in', 'sample1.in', 'sample1.out', 'sample2.in', 'sample2.out']);
    expect(readFileSync(join(folder, 'sample1.in'), 'utf8')).toBe('3\n1 2 3\n');
    expect(readFileSync(join(folder, 'sample2.out'), 'utf8')).toBe('mine\n'); // kept
    expect(readFileSync(join(folder, '1.in'), 'utf8')).toBe('grader\n');
    expect(existsSync(join(folder, '1.out'))).toBe(false);
  });
});

describe('folder mode: the run file, not the submit file', () => {
  const driver = '#include "student.h"\n#include <iostream>\nint main() {\n  return 0;\n}\n';
  it('chosen (while it exists) → detected main → the only C/C++ source → ask', () => {
    const files = ['main.cpp', 'student.h'];
    const texts = new Map([['main.cpp', driver], ['student.h', '// your code here']]);
    expect(runFileFor(files, texts)).toBe('main.cpp');
    expect(runFileFor(files, texts, 'student.h')).toBe('student.h'); // the user's choice wins
    expect(runFileFor(files, texts, 'gone.cpp')).toBe('main.cpp');
    expect(runFileFor(['a.cpp', 'b.h'], new Map([['a.cpp', 'void f();'], ['b.h', '']]))).toBe('a.cpp');
    expect(runFileFor(['a.cpp', 'b.cpp'], new Map([['a.cpp', ''], ['b.cpp', '']]))).toBeNull();
  });
});

describe('viewer: button and preview', () => {
  const noop = () => {};
  const handlers = { zoomOut: noop, zoomIn: noop, fitWidth: noop, prevPage: noop, nextPage: noop, prevMatch: noop, nextMatch: noop, refresh: noop, openInBrowser: noop, importSamples: noop };

  it('the toolbar button is PDF-only, with a tooltip and the same aria-label', () => {
    const { samplesBtn } = buildToolbar(handlers);
    expect(samplesBtn.classList.contains('pdf-only')).toBe(true);
    expect(samplesBtn.dataset.tip).toBe(W.importSamplesTip);
    expect(samplesBtn.getAttribute('aria-label')).toBe(W.importSamplesTip);
    expect(samplesBtn.hasAttribute('title')).toBe(false);
  });

  it('preview: warning, cases as text (never HTML), the annotated mark, Import sends the cases', () => {
    const sent: unknown[] = [];
    const evil = { input: '<img src=x onerror=alert(1)>', output: '<b>6</b>', annotated: true };
    const panel = renderSamples({ kind: 'tables', tables: [{ page: 2, cases: [ok[0], evil] }] }, { importCases: (c) => sent.push(c), close: noop });
    expect(panel.textContent).toContain(W.samplesWarning);
    expect(panel.querySelector('img, b')).toBeNull();
    expect([...panel.querySelectorAll('pre')].map((p) => p.textContent)).toEqual(['3\n1 2 3', '6', evil.input, evil.output]);
    expect(panel.querySelectorAll('.sample.annotated')).toHaveLength(1);
    expect(panel.textContent).toContain(W.samplesAnnotated);
    expect(panel.textContent).toContain(W.samplesCase(2, 2));
    const importBtn = [...panel.querySelectorAll('button')].find((b) => b.textContent === W.samplesImport)!;
    importBtn.click();
    expect(sent).toEqual([[ok[0], evil]]);
    for (const b of panel.querySelectorAll('button.tb')) expect(b.getAttribute('aria-label')).toBe((b as HTMLElement).dataset.tip);
  });

  it('nothing found: says so plainly, no Import button', () => {
    const panel = renderSamples({ kind: 'tables', tables: [] }, { importCases: noop, close: noop });
    expect(panel.textContent).toContain(W.samplesNone);
    expect([...panel.querySelectorAll('button')].some((b) => b.textContent === W.samplesImport)).toBe(false);
  });
});
