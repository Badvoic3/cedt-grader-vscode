import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cphProbPath } from '../src/mapping/cph';
import {
  affectedByDelete,
  dismissKey,
  expired,
  type LocatedEntry,
  moveCphProblem,
  planRename,
  reconnectCandidates,
  remapPath,
} from '../src/mapping/mappingOps';

const E = (fsPath: string, problemId = 1, extra: object = {}): LocatedEntry => ({ fsPath, entry: { problemId, name: `p${problemId}`, ...extra } });

describe('renames inside VS Code', () => {
  it('single file rename keeps how the problem was chosen', () => {
    const plan = planRename([E('/w/a.cpp', 1), E('/w/b.cpp', 2)], '/w/a.cpp', '/w/sub/a2.cpp', false);
    expect(plan).toEqual([{ from: '/w/a.cpp', to: '/w/sub/a2.cpp', entry: { problemId: 1, name: 'p1' } }]);
  });

  it('folder rename moves every mapped file inside it (and only those)', () => {
    const entries = [E('/w/hw/a.cpp', 1), E('/w/hw/deep/b.cpp', 2), E('/w/hw2/c.cpp', 3), E('/w/other.cpp', 4)];
    const plan = planRename(entries, '/w/hw', '/w/homework', false);
    expect(plan.map((p) => [p.from, p.to])).toEqual([
      ['/w/hw/a.cpp', '/w/homework/a.cpp'],
      ['/w/hw/deep/b.cpp', '/w/homework/deep/b.cpp'],
    ]);
  });

  it('a stale mark is cleared when the file is moved back', () => {
    const plan = planRename([E('/w/a.cpp', 1, { staleSince: '2026-01-01T00:00:00Z' })], '/w/a.cpp', '/w/b.cpp', false);
    expect(plan[0].entry).toEqual({ problemId: 1, name: 'p1' });
  });

  it('remapPath does not match name prefixes', () => {
    expect(remapPath('/w/hw2/c.cpp', '/w/hw', '/x', false)).toBeNull();
    expect(remapPath('/w/hw', '/w/hw', '/x', false)).toBe('/x');
  });
});

describe('moves outside VS Code → reconnect prompt', () => {
  const entries = [E('/old/hw/sol.cpp', 1), E('/old/x/other.cpp', 2), E('/still/here/sol.cpp', 3)];
  const exists = (p: string) => Promise.resolve(p.startsWith('/still/'));

  it('exactly one candidate: same file name, old path missing', async () => {
    const asked: string[] = [];
    const c = await reconnectCandidates(entries, '/new/hw/sol.cpp', (p) => (asked.push(p), exists(p)));
    expect(c.map((e) => e.fsPath)).toEqual(['/old/hw/sol.cpp']);
    // fs.stat only for same-name candidates; no scanning
    expect(asked.sort()).toEqual(['/old/hw/sol.cpp', '/still/here/sol.cpp']);
  });

  it('several candidates are all offered (pick or skip)', async () => {
    const c = await reconnectCandidates([...entries, E('/old/b/sol.cpp', 9)], '/new/sol.cpp', exists);
    expect(c.map((e) => e.entry.problemId)).toEqual([1, 9]);
  });

  it('"Not this one" is remembered for that pair', async () => {
    const c = await reconnectCandidates(entries, '/new/hw/sol.cpp', exists, new Set([dismissKey('/old/hw/sol.cpp', '/new/hw/sol.cpp')]));
    expect(c).toEqual([]);
  });
});

describe('deleted files → stale → expired after 30 days', () => {
  it('delete marks (does not remove) mappings of the file or folder', () => {
    const entries = [E('/w/hw/a.cpp', 1), E('/w/hw/b.cpp', 2), E('/w/c.cpp', 3)];
    expect(affectedByDelete(entries, '/w/hw', false).map((e) => e.fsPath)).toEqual(['/w/hw/a.cpp', '/w/hw/b.cpp']);
    expect(affectedByDelete([E('/w/a.cpp', 1, { staleSince: 'x' })], '/w/a.cpp', false)).toEqual([]); // already stale
  });

  it('only stale mappings older than 30 days expire', () => {
    const now = new Date('2026-11-02T12:00:00Z');
    const entries = [
      E('/w/old.cpp', 1, { staleSince: '2026-09-01T00:00:00Z' }),
      E('/w/recent.cpp', 2, { staleSince: '2026-10-20T00:00:00Z' }),
      E('/w/live.cpp', 3),
    ];
    expect(expired(entries, now).map((e) => e.fsPath)).toEqual(['/w/old.cpp']);
  });
});

describe('CPH .prob follows a rename', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'cphmove-'));
    const oldSrc = join(dir, 'a.cpp');
    const newSrc = join(dir, 'sub', 'b.cpp');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(newSrc, '');
    const from = cphProbPath(oldSrc);
    mkdirSync(join(from, '..'), { recursive: true });
    writeFileSync(from, JSON.stringify({ name: 'Local: a', url: oldSrc, tests: [{ id: 1, input: '1', output: '2' }], interactive: false, memoryLimit: 1024, timeLimit: 3000, srcPath: oldSrc, group: 'local', local: true }));
    return { dir, oldSrc, newSrc, from, to: cphProbPath(newSrc) };
  }

  it('copies to the name CPH expects for the new path, updates srcPath/url, keeps the old as .bak', async () => {
    const { oldSrc, newSrc, from, to } = setup();
    const r = await moveCphProblem(oldSrc, newSrc);
    expect(r.status).toBe('moved');
    expect(to).toMatch(/sub\/\.cph\/\.b\.cpp_[0-9a-f]{32}\.prob$/);
    const p = JSON.parse(readFileSync(to, 'utf8'));
    expect(p).toMatchObject({ srcPath: newSrc, url: newSrc, tests: [{ id: 1, input: '1', output: '2' }] });
    expect(existsSync(from)).toBe(false);
    expect(JSON.parse(readFileSync(`${from}.bak`, 'utf8')).srcPath).toBe(oldSrc);
  });

  it('never overwrites CPH tests that already exist for the new path', async () => {
    const { oldSrc, newSrc, from, to } = setup();
    mkdirSync(join(to, '..'), { recursive: true });
    writeFileSync(to, '{"mine":true}');
    expect((await moveCphProblem(oldSrc, newSrc)).status).toBe('target-exists');
    expect(readFileSync(to, 'utf8')).toBe('{"mine":true}');
    expect(existsSync(from)).toBe(true);
  });

  it('nothing to move when the old file has no CPH tests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cphmove2-'));
    expect((await moveCphProblem(join(dir, 'x.cpp'), join(dir, 'y.cpp'))).status).toBe('none');
  });
});
