/**
 * "Load sample cases": host extraction (pdf.js legacy build, loaded on first
 * use), the statement cache (no request when it is cached), and the import
 * rules.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pdfjsLoader, PDFJS_FILES, readSampleTables } from '../src/data/pdfSamples';
import { StatementStore } from '../src/data/statementStore';
import { GraderClient } from '../src/grader';
import { sampleCasesToImport } from '../src/mapping/sampleImport';
import { FakeGrader } from './fakeServer';
import { buildPdf, sampleStatementPdf } from './samplePdf';

/** The same files the build copies to dist/pdfjs (library) and media/dist/pdfjs (worker). */
const PDFJS_DIR = join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build');

describe('host extraction (pdf.js legacy build)', () => {
  const load = pdfjsLoader(PDFJS_DIR);

  it('reads the example table of a statement PDF', async () => {
    expect(await readSampleTables(sampleStatementPdf(), await load())).toEqual([
      { page: 1, cases: [{ input: '3\n1 2 3', output: '6', annotated: false }, { input: '1\n5', output: '5', annotated: false }] },
    ]);
  }, 30_000); // the first pdf.js load can take over 5 s on a shared Windows runner

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
    // No CJK CMaps are packed (course statements embed their fonts), and the viewer asks for none.
    expect(build).not.toMatch(/\/cmaps/);
    expect(readFileSync(join(__dirname, '..', 'webview', 'statement.ts'), 'utf8')).not.toMatch(/cMapUrl/);
    // One worker file for the host and the statement viewer: both use the legacy build.
    expect(build.match(/copyFile\([^)]*pdf\.worker/g)).toHaveLength(1);
    expect(build).toContain('legacy/build/pdf.worker.min.mjs');
    expect(readFileSync(join(__dirname, '..', 'webview', 'pdfjs-global.ts'), 'utf8')).toMatch(/from 'pdfjs-dist\/legacy\/build\/pdf\.mjs'/);
    expect(readFileSync(join(__dirname, '..', 'webview', 'statement.ts'), 'utf8')).toMatch(/from 'pdfjs-dist\/legacy\/web\/pdf_viewer\.mjs'/);
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
    const { server, store, requests } = await setup();
    await store.get(301); // the user opened the statement earlier
    expect(requests()).toBe(1);
    const all = () => server.count('GET', /./) + server.count('POST', /./);
    const before = all();
    const st = await store.cached(301);
    expect(st?.kind).toBe('pdf');
    expect(await readSampleTables((st as { bytes: Uint8Array }).bytes, await pdfjsLoader(PDFJS_DIR)())).toHaveLength(1);
    expect(requests()).toBe(1);
    expect(all()).toBe(before); // pdf.js reads the bytes in the host: no request of any kind (no fonts, no CMaps)
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

  it('no PDF (403 / 404): the statement is not a PDF, so there is nothing to read; the cache says so without a request', async () => {
    const { server, store, requests } = await setup();
    expect(await store.cachedKind(303)).toBeNull(); // unknown: the button stays
    server.pdf = 404;
    server.description = 404;
    expect((await store.get(303)).kind).toBe('none');
    server.pdf = 403;
    server.description = { markdown: true, description: '# Sum' };
    expect((await store.get(304)).kind).toBe('description');
    const before = requests();
    expect([await store.cachedKind(303), await store.cachedKind(304)]).toEqual(['other', 'other']); // the button hides
    server.pdf = 'pdf';
    await store.get(305);
    expect(await store.cachedKind(305)).toBe('pdf');
    expect(requests()).toBe(before + 1);
  });
});

describe('import (same rules as Load test cases)', () => {
  it('numbered from 1, `\\n` line endings, one trailing newline', () => {
    expect(sampleCasesToImport([{ input: '1 2\r\n3  \n\n', output: '3', annotated: false }])).toEqual([{ testcaseId: 1, num: 1, input: '1 2\n3\n', output: '3\n' }]);
  });

});
