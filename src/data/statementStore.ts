import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraderClient } from '../grader/client';

/**
 * Problem statements, cached on disk in the extension's globalStorage
 * (never in the workspace), keyed by server host and problem id.
 * Reopening a statement reads the cache and sends no request; only
 * `refresh: true` (the viewer's Refresh button) fetches again.
 *
 * Order: PDF (`/api/v1/problems/{id}/files/pdf`), else the text
 * description (`/api/v1/problems/{id}/description`), else "none".
 */
export type Statement =
  | { kind: 'pdf'; bytes: Uint8Array }
  | { kind: 'description'; markdown: boolean; text: string }
  | { kind: 'none'; reason: 'hidden' | 'missing' };

export class StatementStore {
  private readonly inflight = new Map<string, Promise<Statement>>();

  constructor(
    private readonly dir: string,
    private readonly client: () => GraderClient,
    private readonly log: (line: string) => void = () => {},
  ) {}

  private folder(): string {
    return join(this.dir, 'statements', new URL(this.client().baseUrl).host.replace(/[^a-z0-9.-]/gi, '_'));
  }

  async get(problemId: number, opts: { refresh?: boolean } = {}): Promise<Statement> {
    if (!opts.refresh) {
      const cached = await this.readCache(problemId);
      if (cached) {
        this.log(`cache hit  statement:${problemId} (disk)`);
        return cached;
      }
    }
    const key = String(problemId);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    this.log(`cache miss statement:${problemId}${opts.refresh ? ' (refresh)' : ''}`);
    const p = this.fetch(problemId).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async fetch(problemId: number): Promise<Statement> {
    const c = this.client();
    const pdf = await c.getStatementPdf(problemId);
    let st: Statement;
    if (pdf.status === 200) st = { kind: 'pdf', bytes: pdf.bytes };
    else {
      const d = await c.getDescription(problemId);
      st = d ? { kind: 'description', markdown: d.markdown, text: d.description } : { kind: 'none', reason: pdf.status === 403 ? 'hidden' : 'missing' };
    }
    await this.writeCache(problemId, st);
    return st;
  }

  private async readCache(id: number): Promise<Statement | null> {
    const base = join(this.folder(), String(id));
    try {
      return { kind: 'pdf', bytes: new Uint8Array(await readFile(`${base}.pdf`)) };
    } catch {
      /* no pdf */
    }
    try {
      const j = JSON.parse(await readFile(`${base}.json`, 'utf8')) as Statement;
      return j.kind === 'description' || j.kind === 'none' ? j : null;
    } catch {
      return null;
    }
  }

  private async writeCache(id: number, st: Statement): Promise<void> {
    const folder = this.folder();
    const base = join(folder, String(id));
    try {
      await mkdir(folder, { recursive: true });
      await rm(`${base}.pdf`, { force: true });
      await rm(`${base}.json`, { force: true });
      if (st.kind === 'pdf') await writeFile(`${base}.pdf`, st.bytes);
      else await writeFile(`${base}.json`, JSON.stringify(st));
    } catch (err) {
      this.log(`statement cache not written: ${err instanceof Error ? err.message : err}`);
    }
  }
}
