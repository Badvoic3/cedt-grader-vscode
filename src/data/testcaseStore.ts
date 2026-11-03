import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraderClient } from '../grader/client';
import type { GraderCase } from '../mapping/cphImport';
import { touch, writeAtomic } from './cacheFiles';

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
    /** A file was written (the controller enforces the cache size limit). */
    private readonly onWrite: (path: string) => void = () => {},
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
        await touch(this.file(problemId)); // least recently used goes first when the cache is full
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
      await writeAtomic(this.file(problemId), JSON.stringify(set));
      this.onWrite(this.file(problemId));
    } catch (err) {
      this.log(`testcase cache not written: ${err instanceof Error ? err.message : err}`);
    }
    return { status: 'ok', set, fromCache: false };
  }
}

/**
 * Problems with a provided driver (`main.cpp` from the attachment) are graded
 * with the grader's own main, which also prints a last line `KEY: <token>`
 * (seen live: the same token on every case; problems without an attachment
 * have none). The provided main doesn't print it, so local runs would always
 * fail. Removed only when every case ends with the same `KEY: <token>` line
 * and the program the tests are for doesn't print that token itself. The
 * cache keeps the grader's text as it is.
 */
export function stripGraderKey(cases: GraderCase[], programText = ''): { cases: GraderCase[]; key: string | null } {
  const KEY_LINE = /(?:^|\n)KEY:[ \t]*(\S+)[ \t]*\s*$/;
  const keys = cases.map((c) => KEY_LINE.exec(c.output)?.[1] ?? null);
  const key = keys[0];
  if (!key || keys.some((k) => k !== key) || programText.includes(key)) return { cases, key: null };
  return { cases: cases.map((c) => ({ ...c, output: c.output.replace(KEY_LINE, (m) => (m.startsWith('\n') ? '\n' : '')) })), key };
}
