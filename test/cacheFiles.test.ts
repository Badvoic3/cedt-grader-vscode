import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CacheFile,
  cleanupCache,
  clearCacheFiles,
  enforceLimit,
  formatBytes,
  pickExpired,
  pickLru,
  scanCache,
  statementIds,
  writeAtomic,
} from '../src/data/cacheFiles';
import { StatementStore } from '../src/data/statementStore';
import { TestcaseStore } from '../src/data/testcaseStore';
import { GraderClient } from '../src/grader';
import { CACHE } from '../src/shared/constants';
import { FakeGrader } from './fakeServer';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 2);

/** A cache root with files of `bytes` bytes, last used `daysAgo` days before NOW. */
function root(files: Record<string, { bytes: number; daysAgo: number }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cedt-cache-'));
  for (const [rel, f] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, Buffer.alloc(f.bytes));
    const t = new Date(NOW - f.daysAgo * DAY);
    utimesSync(p, t, t);
  }
  return dir;
}

const names = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
const F = (path: string, bytes: number, lastUsed: number, temp = false): CacheFile => ({ path, bytes, lastUsed, temp });

describe('LRU eviction', () => {
  it('deletes the least recently used first and stops at the limit', () => {
    const files = [F('a', 40, 3), F('b', 40, 1), F('c', 40, 2)];
    expect(pickLru(files, 120, new Set())).toEqual([]);
    expect(pickLru(files, 100, new Set()).map((f) => f.path)).toEqual(['b']);
    expect(pickLru(files, 40, new Set()).map((f) => f.path)).toEqual(['b', 'c']);
  });

  it('never picks the file just written or a temporary file', () => {
    const files = [F('old', 50, 1), F('new', 50, 2), F('x.tmp', 50, 0, true)];
    expect(pickLru(files, 50, new Set(['old'])).map((f) => f.path)).toEqual(['new']);
  });

  it('enforceLimit removes files on disk until the cache fits; the kept file stays', async () => {
    const dir = root({
      'statements/h/1.pdf': { bytes: 400, daysAgo: 5 },
      'statements/h/2.pdf': { bytes: 400, daysAgo: 1 },
      'testcases/h/1.json': { bytes: 400, daysAgo: 3 },
      'testcases/h/2.json': { bytes: 400, daysAgo: 9 },
    });
    const r = await enforceLimit(dir, 1000, [join(dir, 'testcases/h/2.json')]);
    expect(r).toEqual({ removed: 2, bytes: 800 });
    expect(names(dir)).toEqual(['2.json', '2.pdf']);
  });

  it('a cache hit (touch) moves a file to the back of the queue', async () => {
    const server = new FakeGrader();
    const client = new GraderClient({ baseUrl: 'https://grader.test', fetch: server.fetch, getStoredCredentials: async () => ({ username: 's', password: 'pw' }), sleep: async () => {} });
    await client.login({ username: 's', password: 'pw' });
    const dir = mkdtempSync(join(tmpdir(), 'cedt-lru-'));
    const written: string[] = [];
    const store = new StatementStore(dir, () => client, () => {}, (p) => written.push(p));
    await store.get(201);
    await store.get(202);
    expect(written.map((p) => p.split(/[\\/]/).pop())).toEqual(['201.pdf', '202.pdf']);
    // Make 201 the oldest, then read it from the cache: it becomes the newest.
    const old = new Date(NOW - 10 * DAY);
    utimesSync(written[0], old, old);
    utimesSync(written[1], new Date(NOW - 5 * DAY), new Date(NOW - 5 * DAY));
    await store.get(201);
    expect(statSync(written[0]).mtimeMs).toBeGreaterThan(statSync(written[1]).mtimeMs);
    const files = await scanCache(dir);
    expect(pickLru(files, files[0].bytes, new Set()).map((f) => f.path.split(/[\\/]/).pop())).toEqual(['202.pdf']);
  });
});

describe('daily cleanup', () => {
  it('removes files unused for 30 days and old temp files, keeps recent ones', async () => {
    const dir = root({
      'statements/h/1.pdf': { bytes: 10, daysAgo: 31 },
      'statements/h/2.pdf': { bytes: 10, daysAgo: 29 },
      'testcases/h/3.json': { bytes: 10, daysAgo: 45 },
      'testcases/h/4.json.ab12cd34.tmp': { bytes: 10, daysAgo: 31 },
      'testcases/h/5.json.ab12cd34.tmp': { bytes: 10, daysAgo: 1 },
    });
    const r = await cleanupCache(dir, { now: NOW, maxBytes: 1e9, unusedDays: CACHE.unusedDays, tempDays: CACHE.tempDays });
    expect(r.removed).toBe(3);
    expect(names(dir)).toEqual(['2.pdf', '5.json.ab12cd34.tmp']);
  });

  it('also enforces the size limit on what is left', async () => {
    const dir = root({
      'statements/h/1.pdf': { bytes: 100, daysAgo: 2 },
      'statements/h/2.pdf': { bytes: 100, daysAgo: 1 },
    });
    await cleanupCache(dir, { now: NOW, maxBytes: 150, unusedDays: 30, tempDays: 30 });
    expect(names(dir)).toEqual(['2.pdf']);
  });

  it('pickExpired uses the temp age for *.tmp files', () => {
    const files = [F('a', 1, NOW - 3 * DAY), F('b.tmp', 1, NOW - 3 * DAY, true)];
    expect(pickExpired(files, NOW, 30, 2).map((f) => f.path)).toEqual(['b.tmp']);
  });

  it('only looks inside the cache folders of the root', async () => {
    const dir = root({
      'statements/h/1.pdf': { bytes: 10, daysAgo: 99 },
      'other/keep.json': { bytes: 10, daysAgo: 99 },
      'keep.txt': { bytes: 10, daysAgo: 99 },
    });
    await cleanupCache(dir, { now: NOW, maxBytes: 0, unusedDays: 30, tempDays: 30 });
    expect(names(dir)).toEqual(['keep.json', 'keep.txt']);
  });
});

describe('clear and helpers', () => {
  it('clearCacheFiles deletes every downloaded file and nothing else', async () => {
    const dir = root({
      'statements/h/1.pdf': { bytes: 10, daysAgo: 0 },
      'testcases/h/1.json': { bytes: 20, daysAgo: 0 },
      'other.json': { bytes: 5, daysAgo: 0 },
    });
    expect(await clearCacheFiles(dir)).toEqual({ removed: 2, bytes: 30 });
    expect(names(dir)).toEqual(['other.json']);
    expect(existsSync(join(dir, 'statements'))).toBe(false);
    expect(await clearCacheFiles(dir)).toEqual({ removed: 0, bytes: 0 });
  });

  it('writeAtomic leaves no temporary file behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedt-atomic-'));
    await writeAtomic(join(dir, 'testcases/h/7.json'), '{"a":1}');
    expect(names(dir)).toEqual(['7.json']);
  });

  it('TestcaseStore: atomic write, onWrite, touch on hit', async () => {
    const server = new FakeGrader();
    const client = new GraderClient({ baseUrl: 'https://grader.test', fetch: server.fetch, getStoredCredentials: async () => ({ username: 's', password: 'pw' }), sleep: async () => {} });
    await client.login({ username: 's', password: 'pw' });
    const dir = mkdtempSync(join(tmpdir(), 'cedt-tc-'));
    const written: string[] = [];
    const store = new TestcaseStore(dir, () => client, () => {}, (p) => written.push(p));
    await store.get(201);
    expect(written).toHaveLength(1);
    expect(names(dir)).toEqual(['201.json']);
    const old = new Date(NOW - 10 * DAY);
    utimesSync(written[0], old, old);
    await store.get(201);
    expect(statSync(written[0]).mtimeMs).toBeGreaterThan(old.getTime());
    expect(written).toHaveLength(1); // a cache hit writes nothing
  });

  it('statementIds reads problem ids of cached statements', () => {
    expect([...statementIds([F('/g/statements/h/12.pdf', 1, 0), F('/g/statements/h/13.json', 1, 0), F('/g/testcases/h/14.json', 1, 0)])]).toEqual([12, 13]);
  });

  it('formatBytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(120 * 1024 * 1024)).toBe('120 MB');
  });
});
