import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { StatementStore } from '../src/data/statementStore';
import { GraderClient } from '../src/grader';
import { FakeGrader } from './fakeServer';

vi.mock('vscode', () => ({}));
const { render } = await import('../src/ui/statementPanel');
const B = { title: 't', problemId: 1, name: 'p' };

async function setup() {
  const server = new FakeGrader();
  const client = new GraderClient({ baseUrl: 'https://grader.test', fetch: server.fetch, getStoredCredentials: async () => ({ username: 's', password: 'pw' }), sleep: async () => {} });
  await client.login({ username: 's', password: 'pw' });
  const dir = mkdtempSync(join(tmpdir(), 'cedt-statements-'));
  const store = new StatementStore(dir, () => client);
  const fetches = () => server.count('GET', /\/(files\/pdf|description)$/);
  return { server, store, dir, fetches };
}

describe('StatementStore (globalStorage cache)', () => {
  it('PDF: fetched once, then served from disk; reopening sends no request', async () => {
    const { store, fetches, dir } = await setup();
    const a = await store.get(201);
    expect(a.kind).toBe('pdf');
    expect(fetches()).toBe(1);
    const b = await store.get(201);
    expect(b).toEqual(a);
    expect(fetches()).toBe(1);
    // A new store (VS Code restarted) reads the disk cache; its client must not be called.
    const offlineClient = {
      baseUrl: 'https://grader.test',
      getStatementPdf: () => Promise.reject(new Error('must not fetch')),
      getDescription: () => Promise.reject(new Error('must not fetch')),
    } as unknown as GraderClient;
    const again = new StatementStore(dir, () => offlineClient);
    expect(await again.get(201)).toEqual(a);
    expect(readdirSync(join(dir, 'statements', 'grader.test'))).toEqual(['201.pdf']);
  });

  it('Refresh refetches', async () => {
    const { store, fetches } = await setup();
    await store.get(201);
    await store.get(201, { refresh: true });
    expect(fetches()).toBe(2);
  });

  it('403 (PDF hidden) falls back to the description; cached too', async () => {
    const { server, store, fetches } = await setup();
    server.pdf = 403;
    server.description = { markdown: true, description: '# Sum\n\nAdd **two** numbers.' };
    expect(await store.get(202)).toEqual({ kind: 'description', markdown: true, text: '# Sum\n\nAdd **two** numbers.' });
    await store.get(202);
    expect(fetches()).toBe(2); // pdf + description once
  });

  it('no PDF and no description → none (hidden / missing)', async () => {
    const { server, store } = await setup();
    server.pdf = 403;
    server.description = 403;
    expect(await store.get(203)).toEqual({ kind: 'none', reason: 'hidden' });
    server.pdf = 404;
    server.description = 404;
    expect(await store.get(204, { refresh: true })).toEqual({ kind: 'none', reason: 'missing' });
  });

  it('panel hidden/shown or reloaded webview ("ready" again) → served from disk, no request', async () => {
    const { store, fetches } = await setup();
    await store.get(206); // first open downloads
    for (let i = 0; i < 5; i++) await store.get(206); // every later "ready"
    expect(fetches()).toBe(1);
  });

  it('pdf message carries the saved view (page / zoom / scroll) for reopened tabs', async () => {
    const view = { page: 3, scale: '1.5', scrollTop: 120, scrollLeft: 0 };
    await expect(render(B, { kind: 'pdf', bytes: new Uint8Array([1]) }, view)).resolves.toMatchObject({ type: 'pdf', problemId: 1, view });
  });

  it('concurrent opens share one request', async () => {
    const { store, fetches } = await setup();
    await Promise.all([store.get(205), store.get(205)]);
    expect(fetches()).toBe(1);
  });
});

describe('statement rendering', () => {
  it('markdown is rendered with raw HTML escaped', async () => {
    const m = await render(B, { kind: 'description', markdown: true, text: '**bold** <script>alert(1)</script> <img src=x onerror=alert(1)>' });
    expect(m.type).toBe('html');
    const html = (m as { html: string }).html;
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain('&lt;script&gt;');
  });

  it('non-markdown (website HTML) is shown as escaped text', async () => {
    const m = await render(B, { kind: 'description', markdown: false, text: '<p>Line 1</p><p>Line <b>2</b> &amp; more</p><script>x()</script>' });
    const html = (m as { html: string }).html;
    expect(html).toMatch(/^<pre class="text">/);
    expect(html).not.toMatch(/<p>|<b>|<script/);
    expect(html).toContain('Line 1');
    expect(html).toContain('&amp; more');
  });

  it('hidden / missing statements give a message', async () => {
    await expect(render(B, { kind: 'none', reason: 'hidden' })).resolves.toMatchObject({ type: 'message', text: expect.stringContaining('Open in Browser') });
    await expect(render(B, { kind: 'none', reason: 'missing' })).resolves.toMatchObject({ type: 'message', text: 'This problem has no statement.' });
  });
});
