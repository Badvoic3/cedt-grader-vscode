import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraderClient } from '../grader/client';
import type { GraderCase } from '../mapping/cphImport';

/**
 * Grader test cases per problem, cached in the extension's globalStorage
 * (`testcases/<host>/<problemId>.json`). A second import reads the cache;
 * only `refresh: true` downloads again. Cases are downloaded one at a time
 * (input, then sol), never in a parallel burst.
 *
 * Truncated ("preview") files are never imported: they are listed in
 * `truncated` instead.
 */
export interface TestcaseSet {
  fetchedAt: string;
  /** Complete cases, ready for CPH. */
  cases: GraderCase[];
  /** Cases the grader only showed in part (too large for student access). */
  truncated: { testcaseId: number; num: number }[];
}

export type TestcaseResult = { status: 'ok'; set: TestcaseSet; fromCache: boolean } | { status: 'not-available' };

export class TestcaseStore {
  constructor(
    private readonly dir: string,
    private readonly client: () => GraderClient,
    private readonly log: (line: string) => void = () => {},
  ) {}

  private file(problemId: number): string {
    return join(this.dir, 'testcases', new URL(this.client().baseUrl).host.replace(/[^a-z0-9.-]/gi, '_'), `${problemId}.json`);
  }

  async get(
    problemId: number,
    opts: { refresh?: boolean; onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
  ): Promise<TestcaseResult> {
    if (!opts.refresh) {
      try {
        const set = JSON.parse(await readFile(this.file(problemId), 'utf8')) as TestcaseSet;
        this.log(`cache hit  testcases:${problemId} (disk)`);
        return { status: 'ok', set, fromCache: true };
      } catch {
        /* not cached */
      }
    }
    this.log(`cache miss testcases:${problemId}${opts.refresh ? ' (refresh)' : ''}`);
    const c = this.client();
    const list = await c.listTestcases(problemId);
    if (list === null) return { status: 'not-available' };
    const sorted = [...list].sort((a, b) => a.num - b.num);
    const set: TestcaseSet = { fetchedAt: new Date().toISOString(), cases: [], truncated: [] };
    let done = 0;
    opts.onProgress?.(0, sorted.length);
    for (const t of sorted) {
      if (opts.signal?.aborted) throw new Error('Cancelled.');
      const input = await c.getTestcaseFile(t.id, 'input');
      // No need to fetch the answer of a case we cannot use.
      const sol = input.truncated ? null : await c.getTestcaseFile(t.id, 'sol');
      if (input.truncated || !sol || sol.truncated) set.truncated.push({ testcaseId: t.id, num: t.num });
      else set.cases.push({ testcaseId: t.id, num: t.num, input: input.text, output: sol.text });
      opts.onProgress?.(++done, sorted.length);
    }
    try {
      await mkdir(join(this.file(problemId), '..'), { recursive: true });
      await writeFile(this.file(problemId), JSON.stringify(set));
    } catch (err) {
      this.log(`testcase cache not written: ${err instanceof Error ? err.message : err}`);
    }
    return { status: 'ok', set, fromCache: false };
  }
}
