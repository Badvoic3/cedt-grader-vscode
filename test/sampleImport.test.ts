/**
 * "Load sample cases": host extraction (pdf.js legacy build, loaded on first
 * use), the statement cache (no request when it is cached), and the import
 * rules (CPH markers, duplicates, `tests/sample<n>` files).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveTestcasesAsFiles } from '../src/cphIntegration';
import { pdfjsLoader, PDFJS_FILES, readSampleTables } from '../src/data/pdfSamples';
import { StatementStore } from '../src/data/statementStore';
import { GraderClient } from '../src/grader';
import { cphProbPath, type CphProblem } from '../src/mapping/cph';
import { GRADER_ID_BASE, importIntoCph, STATEMENT_ID_BASE } from '../src/mapping/cphImport';
import { sampleCasesToImport } from '../src/mapping/sampleImport';
import { FakeGrader } from './fakeServer';
import { buildPdf, sampleStatementPdf } from './samplePdf';

const ok = [
  { input: '3\n1 2 3', output: '6', annotated: false },
  { input: '1\n5', output: '5', annotated: true },
];
/** The same files the build copies to dist/pdfjs. */
const PDFJS_DIR = join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build');

describe('host extraction (pdf.js legacy build)', () => {
  const load = pdfjsLoader(PDFJS_DIR);

  it('reads the example table of a statement PDF', async () => {
    expect(await readSampleTables(sampleStatementPdf(), await load())).toEqual([
      { page: 1, cases: [{ input: '3\n1 2 3', output: '6', annotated: false }, { input: '1\n5', output: '5', annotated: false }] },
    ]);
  });

  it('no table → nothing; the bytes it is given are left intact', async () => {
    const bytes = buildPdf([{ texts: [{ str: 'Just text, no table.', x: 50, y: 700, font: 'F1' }] }]);
    const copy = bytes.slice();
    expect(await readSampleTables(bytes, await load())).toEqual([]);
    expect(bytes).toEqual(copy);
  });

  it('pdf.js is loaded once, on first use; a missing build fails that call only', async () => {
    expect(await load()).toBe(await load());
    const broken = pdfjsLoader(join(tmpdir(), 'no-pdfjs-here'));
    await expect(broken()).rejects.toThrow();
  });

  it('the build ships the legacy files the loader imports, and no host module imports pdf.js statically', () => {
    const build = readFileSync(join(__dirname, '..', 'esbuild.mjs'), 'utf8');
    for (const f of Object.values(PDFJS_FILES)) {
      expect(build).toContain(f);
      expect(existsSync(join(PDFJS_DIR, f))).toBe(true);
    }
    expect(readFileSync(join(__dirname, '..', '.vscodeignore'), 'utf8')).toContain('!dist/pdfjs/**');
    const srcFiles = readdirSync(join(__dirname, '..', 'src'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    for (const f of srcFiles) expect(readFileSync(join(__dirname, '..', 'src', f), 'utf8')).not.toMatch(/from ['"]pdfjs-dist/);
  });
});

describe('statement source: the cache first, else the statement request once', () => {
  async function setup() {
    const server = new FakeGrader();
    server.pdfBytes = sampleStatementPdf();
    const client = new GraderClient({ baseUrl: 'https://grader.test', fetch: server.fetch, getStoredCredentials: async () => ({ username: 's', password: 'pw' }), sleep: async () => {} });
    await client.login({ username: 's', password: 'pw' });
    const store = new StatementStore(mkdtempSync(join(tmpdir(), 'samples-st-')), () => client);
    const requests = () => server.count('GET', /\/(files\/pdf|description)$/);
    return { server, store, requests };
  }

  it('cached (opened before): no request at all', async () => {
    const { store, requests } = await setup();
    await store.get(301); // the user opened the statement earlier
    expect(requests()).toBe(1);
    const st = await store.cached(301);
    expect(st?.kind).toBe('pdf');
    expect(await readSampleTables((st as { bytes: Uint8Array }).bytes, await pdfjsLoader(PDFJS_DIR)())).toHaveLength(1);
    expect(requests()).toBe(1);
  });

  it('not cached: the statement request once, then cached for the next time', async () => {
    const { store, requests } = await setup();
    expect(await store.cached(302)).toBeNull();
    expect(requests()).toBe(0);
    expect((await store.get(302)).kind).toBe('pdf');
    expect(requests()).toBe(1);
    expect((await store.cached(302))?.kind).toBe('pdf');
    expect(requests()).toBe(1);
  });

  it('no PDF (403 / 404): the statement is not a PDF, so there is nothing to read', async () => {
    const { server, store } = await setup();
    server.pdf = 404;
    server.description = 404;
    expect((await store.get(303)).kind).toBe('none');
    server.pdf = 403;
    server.description = { markdown: true, description: '# Sum' };
    expect((await store.get(304)).kind).toBe('description');
  });
});

describe('import (same rules as Load test cases)', () => {
  function workspace() {
    const dir = mkdtempSync(join(tmpdir(), 'samples-'));
    const src = join(dir, 'sol.cpp');
    writeFileSync(src, '');
    return { dir, src, prob: cphProbPath(src) };
  }

  it('numbered from 1, `\\n` line endings, one trailing newline', () => {
    expect(sampleCasesToImport([{ input: '1 2\r\n3  \n\n', output: '3', annotated: false }])).toEqual([{ testcaseId: 1, num: 1, input: '1 2\n3\n', output: '3\n' }]);
  });

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
    expect(STATEMENT_ID_BASE + 1000).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(STATEMENT_ID_BASE).toBeGreaterThan(GRADER_ID_BASE + 1e14); // grader testcase ids never reach the statement range

    // Loading again changes nothing.
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
