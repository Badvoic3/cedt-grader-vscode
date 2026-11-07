import { mkdtemp, readdir, readFile, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupCache, clearCacheFiles, enforceLimit, scanCache } from '../src/data/cacheFiles';
import { CASES_DIR, CaseStore, mergeCases, parseCases, reorderCases, UNLINKED_DIR } from '../src/runner/store';
import type { RunnerCase } from '../src/runner/types';

const ids = () => {
  let n = 0;
  return () => `id${++n}`;
};
const c = (id: string, source: RunnerCase['source'], input: string, expected: string, testcaseId?: number): RunnerCase => ({ id, source, input, expected, ...(testcaseId ? { testcaseId } : {}) });

describe('mergeCases', () => {
  it('adds new cases in order and gives grader cases their id', () => {
    const r = mergeCases([], [{ input: '1', expected: 'a', testcaseId: 7 }, { input: '2', expected: 'b', testcaseId: 8 }], 'grader', ids());
    expect(r.cases).toEqual([c('id1', 'grader', '1', 'a', 7), c('id2', 'grader', '2', 'b', 8)]);
    expect([r.added, r.kept]).toEqual([2, 0]);
  });

  it('a sample equal to a grader case stays Grader', () => {
    const r = mergeCases([c('g', 'grader', '1\n', 'a b\n', 7)], [{ input: '1', expected: 'a  b' }], 'sample', ids());
    expect(r.cases).toEqual([c('g', 'grader', '1\n', 'a b\n', 7)]);
    expect([r.added, r.kept]).toEqual([0, 1]);
  });

  it('a grader case equal to a sample takes the badge, keeping its place and id', () => {
    const r = mergeCases([c('s', 'sample', '1', 'a'), c('x', 'custom', '9', 'z')], [{ input: '1\n', expected: 'a\n', testcaseId: 7 }], 'grader', ids());
    expect(r.cases.map((x) => [x.id, x.source, x.testcaseId])).toEqual([['s', 'grader', 7], ['x', 'custom', undefined]]);
  });

  it('a sample equal to a custom case takes the badge; a lower rank never does', () => {
    expect(mergeCases([c('x', 'custom', '1', 'a')], [{ input: '1', expected: 'a' }], 'sample', ids()).cases[0].source).toBe('sample');
    expect(mergeCases([c('s', 'sample', '1', 'a')], [{ input: '1', expected: 'a' }], 'custom', ids()).cases[0].source).toBe('sample');
  });

  it('inputs that differ in spacing stay two cases', () => {
    expect(mergeCases([c('a', 'sample', '1  2', 'x')], [{ input: '1 2', expected: 'x' }], 'sample', ids()).cases).toHaveLength(2);
  });

  it('a second Load updates a grader case by its id instead of adding it', () => {
    const r = mergeCases([c('g', 'grader', '1', 'old', 7)], [{ input: '1', expected: 'new', testcaseId: 7 }], 'grader', ids());
    expect(r.cases).toEqual([c('g', 'grader', '1', 'new', 7)]);
    expect([r.added, r.kept]).toEqual([0, 1]);
  });

  it('removes duplicates inside what is loaded', () => {
    expect(mergeCases([], [{ input: '1', expected: 'a' }, { input: '1\n', expected: 'a\n' }], 'sample', ids()).cases).toHaveLength(1);
  });

  it('never changes the list it was given', () => {
    const before = [c('s', 'sample', '1', 'a')];
    mergeCases(before, [{ input: '1', expected: 'a', testcaseId: 7 }], 'grader', ids());
    expect(before).toEqual([c('s', 'sample', '1', 'a')]);
  });
});

describe('reorderCases', () => {
  const list = [c('a', 'custom', '1', ''), c('b', 'custom', '2', ''), c('d', 'custom', '3', '')];
  it('named first, the rest after, unknown ids and repeats ignored', () => {
    expect(reorderCases(list, ['d', 'nope', 'a', 'd']).map((x) => x.id)).toEqual(['d', 'a', 'b']);
  });
});

describe('parseCases', () => {
  it.each([['not JSON', '{'], ['null', 'null'], ['another version', '{"version":2,"cases":[]}'], ['no list', '{"version":1}']])('%s is an empty list', (_, text) => {
    expect(parseCases(text, { problemId: 5 })).toEqual({ version: 1, problemId: 5, cases: [] });
  });
  it('drops a damaged case and keeps the rest', () => {
    const text = JSON.stringify({ version: 1, cases: [c('a', 'custom', '1', '2'), { id: 'b', source: 'odd', input: '', expected: '' }, { id: 'c' }, null] });
    expect(parseCases(text, { problemId: 5 }).cases.map((x) => x.id)).toEqual(['a']);
  });
});

describe('CaseStore', () => {
  let root: string;
  let store: CaseStore;
  const file = (id = 1) => join(root, CASES_DIR, 'g.example', `${id}.json`);
  const P = { problemId: 1 };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'runner-store-'));
    store = new CaseStore(root, () => 'https://g.example', () => {}, ids());
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('a problem with no file is an empty list, and reading writes nothing', async () => {
    expect((await store.read(P)).cases).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it('keeps lists apart per server', async () => {
    await store.add(P, { input: '1', expected: '2' });
    const other = new CaseStore(root, () => 'https://other.example:8080');
    expect((await other.read(P)).cases).toEqual([]);
    await other.add(P);
    expect(await readdir(join(root, CASES_DIR))).toEqual(['g.example', 'other.example_8080']);
  });

  it('add, then a re-read from disk', async () => {
    await store.add(P, { input: 'i', expected: 'o' });
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ version: 1, problemId: 1, cases: [c('id1', 'custom', 'i', 'o')] });
  });

  it('a deleted grader case comes back on Load, at the end', async () => {
    await store.merge(1, [{ input: '1', expected: 'a', testcaseId: 7 }, { input: '2', expected: 'b', testcaseId: 8 }], 'grader');
    await store.remove(P, 'id1');
    const r = await store.merge(1, [{ input: '1', expected: 'a', testcaseId: 7 }, { input: '2', expected: 'b', testcaseId: 8 }], 'grader');
    expect(r.file.cases.map((x) => x.testcaseId)).toEqual([8, 7]);
    expect([r.added, r.kept]).toEqual([1, 1]);
  });

  it('an edit turns a loaded case into Custom, and a later Load leaves it alone', async () => {
    await store.merge(1, [{ input: '1', expected: 'a', testcaseId: 7 }], 'grader');
    const f = await store.update(P, 'id1', { expected: 'mine' });
    expect(f.cases).toEqual([c('id1', 'custom', '1', 'mine')]);
    const r = await store.merge(1, [{ input: '1', expected: 'a', testcaseId: 7 }], 'grader');
    expect(r.file.cases.map((x) => [x.source, x.expected])).toEqual([['custom', 'mine'], ['grader', 'a']]);
  });

  it('an edit that changes nothing keeps the badge and writes nothing', async () => {
    await store.merge(1, [{ input: '1', expected: 'a', testcaseId: 7 }], 'grader');
    const before = await readFile(file(), 'utf8');
    expect((await store.update(P, 'id1', { input: '1' })).cases[0].source).toBe('grader');
    expect(await readFile(file(), 'utf8')).toBe(before);
  });

  it('writes to one file never lose each other', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.add(P, { input: String(i), expected: '' })));
    expect((await store.read(P)).cases.map((x) => x.input)).toEqual(Array.from({ length: 20 }, (_, i) => String(i)));
  });

  it('keeps limits and the sample tip beside the cases', async () => {
    await store.add(P);
    await store.setMeta(1, { limits: { timeMs: 1000, memoryMB: 256, fetchedAt: 'now' } });
    await store.setMeta(1, { sampleTip: { failedRuns: 2, dismissed: false } });
    expect(await store.read(P)).toMatchObject({ limits: { timeMs: 1000 }, sampleTip: { failedRuns: 2 }, cases: [{ id: 'id1' }] });
  });

  it('a damaged file reads as empty and the next write replaces it', async () => {
    await store.add(P);
    await writeFile(file(), 'garbage');
    expect((await store.read(P)).cases).toEqual([]);
    await store.add(P, { input: 'x', expected: 'y' });
    expect((await store.read(P)).cases.map((x) => x.input)).toEqual(['x']);
  });

  describe('clear', () => {
    beforeEach(async () => {
      await store.merge(1, [{ input: '1', expected: 'a', testcaseId: 7 }], 'grader');
      await store.merge(1, [{ input: '2', expected: 'b' }], 'sample');
      await store.add(P, { input: '3', expected: 'c' });
      await store.merge(2, [{ input: '1', expected: 'a', testcaseId: 9 }], 'grader');
    });

    it('downloaded cases go, custom cases stay, and an emptied list is deleted', async () => {
      await store.clear(['grader', 'sample']);
      expect((await store.read(P)).cases.map((x) => x.source)).toEqual(['custom']);
      expect(await readdir(join(root, CASES_DIR, 'g.example'))).toEqual(['1.json']);
    });

    it('custom cases go on their own', async () => {
      expect(await store.customCount()).toBe(1);
      await store.clear(['custom']);
      expect((await store.read(P)).cases.map((x) => x.source)).toEqual(['grader', 'sample']);
      expect(await store.customCount()).toBe(0);
    });

    it('covers every server, and does nothing when there is no folder', async () => {
      const other = new CaseStore(root, () => 'https://other.example');
      await other.add(P, { input: 'x', expected: 'y' });
      expect(await store.customCount()).toBe(2);
      await store.clear(['grader', 'sample', 'custom']);
      expect(await store.customCount()).toBe(0);
      await rm(join(root, CASES_DIR), { recursive: true, force: true });
      await expect(store.clear(['custom'])).resolves.toBeUndefined();
    });
  });

  describe('unlinked files', () => {
    const A = { file: '/work/a.cpp' };
    const B = { file: '/work/b.cpp' };

    it('keeps a list per file, on no server', async () => {
      await store.add(A, { input: 'a', expected: '1' });
      await store.add(B, { input: 'b', expected: '2' });
      expect((await store.read(A)).cases.map((x) => x.input)).toEqual(['a']);
      expect((await store.read(A)).file).toBe('/work/a.cpp');
      const other = new CaseStore(root, () => 'https://other.example');
      expect((await other.read(B)).cases.map((x) => x.input)).toEqual(['b']);
      expect(await readdir(join(root, CASES_DIR))).toEqual([UNLINKED_DIR]);
    });

    it('edits, deletes and reorders like a problem list', async () => {
      await store.add(A, { input: 'a', expected: '1' });
      await store.add(A, { input: 'b', expected: '2' });
      await store.reorder(A, ['id2', 'id1']);
      await store.update(A, 'id1', { expected: 'x' });
      await store.remove(A, 'id2');
      expect((await store.read(A)).cases).toEqual([c('id1', 'custom', 'a', 'x')]);
    });

    it('a rename carries the cases to the new path', async () => {
      await store.add(A, { input: 'a', expected: '1' });
      await store.moveUnlinked(A.file, B);
      expect((await store.read(A)).cases).toEqual([]);
      expect((await store.read(B)).cases.map((x) => x.input)).toEqual(['a']);
      expect((await store.read(B)).file).toBe(B.file);
    });

    it('linking the file carries the cases to the problem, without repeating one it has', async () => {
      await store.merge(1, [{ input: 'g', expected: '1', testcaseId: 7 }], 'grader');
      await store.add(A, { input: 'g', expected: '1' });
      await store.add(A, { input: 'mine', expected: '2' });
      await store.moveUnlinked(A.file, P);
      expect((await store.read(P)).cases.map((x) => [x.source, x.input])).toEqual([['grader', 'g'], ['custom', 'mine']]);
      expect((await store.read(A)).cases).toEqual([]);
      expect(await readdir(join(root, CASES_DIR, UNLINKED_DIR))).toEqual([]);
    });

    it('moving a file with no list changes nothing', async () => {
      await store.moveUnlinked(A.file, P);
      expect(await readdir(root)).toEqual([]);
    });

    it('a move to the same path keeps the list', async () => {
      await store.add(A, { input: 'a', expected: '1' });
      await store.moveUnlinked(A.file, A);
      expect((await store.read(A)).cases).toHaveLength(1);
    });

    it('Clear counts and removes them as custom cases, and "downloaded" leaves them', async () => {
      await store.add(A, { input: 'a', expected: '1' });
      expect(await store.customCount()).toBe(1);
      await store.clear(['grader', 'sample']);
      expect(await store.customCount()).toBe(1);
      await store.clear(['custom']);
      expect(await store.customCount()).toBe(0);
    });
  });

  it('the cache rules never touch the lists', async () => {
    await store.add(P, { input: 'mine', expected: 'x' });
    const old = new Date(Date.now() - 400 * 86_400_000);
    await utimes(file(), old, old);
    const cached = join(root, 'testcases', 'g.example', '1.json');
    await mkdir(join(root, 'testcases', 'g.example'), { recursive: true });
    await writeFile(cached, 'x'.repeat(100));
    await utimes(cached, old, old);

    expect((await scanCache(root)).map((f) => f.path)).toEqual([cached]);
    await enforceLimit(root, 0);
    await cleanupCache(root, { now: Date.now(), maxBytes: 0, unusedDays: 30, tempDays: 1 });
    await clearCacheFiles(root);
    expect((await store.read(P)).cases.map((x) => x.input)).toEqual(['mine']);
  });
});
