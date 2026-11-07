/** MappingStore over the link table: real files, a fake VS Code workspace. Nothing may appear in the user's folders. */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MappingStore } from '../src/mapping/store';
import { importOldLinks } from '../src/migration/importLinks';
import { KEYS } from '../src/shared/stateKeys';

const env = vi.hoisted(() => ({ folders: [] as { uri: { fsPath: string }; name: string; index: number }[] }));

vi.mock('vscode', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const file = (p: string) => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` });
  const folderOf = (p: string) => env.folders.find((f) => p === f.uri.fsPath || p.startsWith(`${f.uri.fsPath}${path.sep}`));
  return {
    Uri: { file, joinPath: (u: { fsPath: string }, ...parts: string[]) => file(path.join(u.fsPath, ...parts)) },
    workspace: {
      get workspaceFolders() {
        return env.folders;
      },
      getWorkspaceFolder: (u: { fsPath: string }) => folderOf(u.fsPath),
      asRelativePath: (u: { fsPath: string }) => {
        const f = folderOf(u.fsPath);
        return !f || f.uri.fsPath === u.fsPath ? u.fsPath : path.relative(f.uri.fsPath, u.fsPath).split(path.sep).join('/');
      },
      fs: { readFile: (u: { fsPath: string }) => fs.readFile(u.fsPath) },
    },
  };
});

class Memo {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string, fallback?: T): T {
    return (this.data.has(key) ? this.data.get(key) : fallback) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, value);
  }
}

const BASE = 'https://grader.example';
const uri = (fsPath: string) => ({ scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` }) as never;
const open = (...paths: string[]) => {
  env.folders = paths.map((p, index) => ({ uri: { fsPath: p }, name: p.split('/').pop() ?? '', index }));
};

describe('MappingStore', () => {
  let storage: string;
  let w: string;
  let ctx: { workspaceState: Memo; globalState: Memo; globalStorageUri: { fsPath: string } };
  let store: MappingStore;
  const link = (problemId: number, extra: object = {}) => ({ problemId, name: `p${problemId}`, ...extra });
  const mine = (fsPath: string) => store.get(uri(fsPath), BASE);

  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), 'cedt-store-'));
    w = mkdtempSync(join(tmpdir(), 'cedt-ws-'));
    open(w);
    ctx = { workspaceState: new Memo(), globalState: new Memo(), globalStorageUri: { fsPath: storage } };
    store = new MappingStore(ctx as never);
  });

  it('set, get, remove; no file appears in the workspace', async () => {
    await store.set(uri(join(w, 'a.cpp')), link(1));
    await store.set(uri(join(w, 'pkg')), link(2, { folder: true, submitFile: 'a.h' }));
    expect(await mine(join(w, 'a.cpp'))).toEqual(link(1));
    expect(await mine(join(w, 'pkg'))).toEqual(link(2, { folder: true, submitFile: 'a.h' }));
    await store.set(uri(join(w, 'a.cpp')), undefined);
    expect(await mine(join(w, 'a.cpp'))).toBeUndefined();
    expect(readdirSync(w)).toEqual([]);
  });

  it('a link for another server is not this one, and is not listed', async () => {
    await store.set(uri(join(w, 'a.cpp')), link(1, { baseUrl: 'https://other' }));
    expect(await mine(join(w, 'a.cpp'))).toBeUndefined();
    expect(await store.get(uri(join(w, 'a.cpp')), 'https://other')).toBeDefined();
    expect((await store.mappedProblemIds(BASE)).size).toBe(0);
  });

  it('problem id → files, as file or folder', async () => {
    await store.set(uri(join(w, 'a.cpp')), link(1));
    await store.set(uri(join(w, 'b')), link(1, { folder: true }));
    await store.set(uri(join(w, 'c.cpp')), link(2));
    const got = await store.linksFor(1, BASE);
    expect(got.map((l) => [(l.uri as unknown as { fsPath: string }).fsPath, l.folder]).sort()).toEqual([[join(w, 'a.cpp'), false], [join(w, 'b'), true]]);
    expect(await store.linkedElsewhere(1, BASE)).toEqual([join(w, 'c.cpp')]);
  });

  it('choosing a problem clears "not linked"', async () => {
    await store.setUnlinked(uri(join(w, 'a.cpp')), true);
    await store.set(uri(join(w, 'a.cpp')), link(1));
    expect(store.isUnlinked(uri(join(w, 'a.cpp')))).toBe(false);
  });

  it('rename moves links, also inside a renamed folder, and folder roles follow', async () => {
    await store.set(uri(join(w, 'pkg')), link(1, { folder: true, submitFile: 'old.h', runFile: 'main.cpp' }));
    await store.set(uri(join(w, 'pkg', 'x.cpp')), link(2));
    await store.rename(uri(join(w, 'pkg', 'old.h')), uri(join(w, 'pkg', 'new.h')));
    expect((await mine(join(w, 'pkg')))?.submitFile).toBe('new.h');
    const moved = await store.rename(uri(join(w, 'pkg')), uri(join(w, 'lib')));
    expect(moved).toHaveLength(2);
    expect(await mine(join(w, 'pkg'))).toBeUndefined();
    expect(await mine(join(w, 'lib', 'x.cpp'))).toEqual(link(2));
    expect((await mine(join(w, 'lib')))?.runFile).toBe('main.cpp');
  });

  it('a role file moved out of its folder is detected again', async () => {
    await store.set(uri(join(w, 'pkg')), link(1, { folder: true, submitFile: 'a.h' }));
    await store.rename(uri(join(w, 'pkg', 'a.h')), uri(join(w, 'a.h')));
    expect((await mine(join(w, 'pkg')))?.submitFile).toBeUndefined();
  });

  it('delete marks stale; stale links expire after 30 days; a deleted role file is forgotten', async () => {
    await store.set(uri(join(w, 'a.cpp')), link(1));
    await store.set(uri(join(w, 'pkg')), link(2, { folder: true, submitFile: 'a.h' }));
    const then = new Date('2026-01-01T00:00:00.000Z');
    expect(await store.markDeleted(uri(join(w, 'a.cpp')), then)).toBe(1);
    await store.markDeleted(uri(join(w, 'pkg', 'a.h')), then);
    expect(await mine(join(w, 'a.cpp'))).toBeUndefined();
    expect((await mine(join(w, 'pkg')))?.submitFile).toBeUndefined();
    expect(await store.expireStale(new Date('2026-01-10T00:00:00.000Z'))).toBe(0);
    expect(await store.expireStale(new Date('2026-03-01T00:00:00.000Z'))).toBe(1);
    expect(await store.everyEntry()).toHaveLength(1);
  });

  it('reconnect moves a stale link and clears staleness', async () => {
    await store.set(uri(join(w, 'a.cpp')), link(1, { staleSince: '2026-01-01T00:00:00.000Z' }));
    const [from] = await store.everyEntry();
    await store.reconnect(from, uri(join(w, 'b.cpp')));
    expect(await mine(join(w, 'b.cpp'))).toEqual(link(1));
    expect(await store.everyEntry()).toHaveLength(1);
  });

  describe('which folder is open', () => {
    it('a subfolder root still finds the link and the folder link above it', async () => {
      await store.set(uri(join(w, 'pkg')), link(1, { folder: true }));
      await store.set(uri(join(w, 'pkg', 'x.cpp')), link(2));
      open(join(w, 'pkg'));
      expect(await mine(join(w, 'pkg', 'x.cpp'))).toEqual(link(2));
      expect((await store.resolve(uri(join(w, 'pkg', 'y.cpp')), BASE))?.folder).toBe(join(w, 'pkg'));
    });

    it("another folder's links exist but are not listed here", async () => {
      await store.set(uri(join(w, 'a.cpp')), link(1));
      const other = mkdtempSync(join(tmpdir(), 'cedt-other-'));
      open(other);
      expect(await store.allEntries()).toEqual([]);
      expect((await store.mappedProblemIds(BASE)).size).toBe(0);
      expect(await store.everyEntry()).toHaveLength(1); // what a moved folder reconnects from
      expect(await mine(join(w, 'a.cpp'))).toEqual(link(1));
    });

    it('a link saved outside every folder is listed in every window', async () => {
      open();
      await store.set(uri('/elsewhere/a.cpp'), link(1));
      open(w);
      expect((await store.allEntries()).map((e) => e.fsPath)).toEqual(['/elsewhere/a.cpp']);
    });

    it("clearing links removes this window's and leaves other folders'", async () => {
      await store.set(uri(join(w, 'a.cpp')), link(1));
      const other = mkdtempSync(join(tmpdir(), 'cedt-other-'));
      open(other);
      await store.set(uri(join(other, 'b.cpp')), link(2));
      expect(await store.clearLinks()).toBe(1);
      expect((await store.everyEntry()).map((e) => e.fsPath)).toEqual([join(w, 'a.cpp')]);
    });
  });

  describe('old links', () => {
    const OLD = JSON.stringify({ version: 1, files: { 'hw/a.cpp': { problemId: 1, name: 'p1' }, pkg: { problemId: 2, name: 'p2', folder: true, submitFile: 'student.h' } } });
    const run = () => importOldLinks(ctx as never, store);

    it('copies .cedt-grader.json, and leaves the file exactly as it was', async () => {
      writeFileSync(join(w, '.cedt-grader.json'), OLD);
      expect(await run()).toBe(2);
      expect(await mine(join(w, 'hw', 'a.cpp'))).toEqual(link(1));
      expect((await mine(join(w, 'pkg')))?.submitFile).toBe('student.h');
      expect(readFileSync(join(w, '.cedt-grader.json'), 'utf8')).toBe(OLD);
    });

    it('runs once per folder: an unlinked file does not get its link back', async () => {
      writeFileSync(join(w, '.cedt-grader.json'), OLD);
      await run();
      await store.set(uri(join(w, 'hw', 'a.cpp')), undefined);
      expect(await run()).toBe(0);
      expect(await mine(join(w, 'hw', 'a.cpp'))).toBeUndefined();
    });

    it('a folder added later is imported then', async () => {
      await run();
      const other = mkdtempSync(join(tmpdir(), 'cedt-other-'));
      writeFileSync(join(other, '.cedt-grader.json'), OLD);
      open(w, other);
      expect(await run()).toBe(2);
    });

    it('a moved folder brings its links back at the new path', async () => {
      writeFileSync(join(w, '.cedt-grader.json'), OLD);
      await run();
      const moved = mkdtempSync(join(tmpdir(), 'cedt-moved-'));
      writeFileSync(join(moved, '.cedt-grader.json'), OLD);
      open(moved);
      ctx.workspaceState = new Memo(); // a moved folder is a new workspace
      expect(await run()).toBe(2);
      expect(await mine(join(moved, 'hw', 'a.cpp'))).toEqual(link(1));
    });

    it('what the user chose since is never replaced', async () => {
      writeFileSync(join(w, '.cedt-grader.json'), OLD);
      await store.set(uri(join(w, 'hw', 'a.cpp')), link(9));
      await run();
      expect(await mine(join(w, 'hw', 'a.cpp'))).toEqual(link(9));
    });

    it('takes the state keys and removes them; global links stay listed everywhere', async () => {
      await ctx.workspaceState.update(KEYS.mappings, { 'x/a.cpp': { ...link(1), fsPath: join(w, 'a.cpp') } });
      await ctx.globalState.update(KEYS.mappings, { '/o/b.cpp': { ...link(2), fsPath: '/o/b.cpp' } });
      await ctx.workspaceState.update(KEYS.legacyMapping, { [join(w, 'c.cpp')]: link(3) });
      expect(await run()).toBe(3);
      for (const m of [ctx.workspaceState, ctx.globalState]) {
        expect(m.get(KEYS.mappings)).toBeUndefined();
        expect(m.get(KEYS.legacyMapping)).toBeUndefined();
      }
      expect(await store.allEntries()).toHaveLength(3);
    });

    it('a workspace with nothing old writes nothing', async () => {
      await run();
      expect(readdirSync(storage)).toEqual([]);
    });

    it('a table it cannot write leaves everything to try again', async () => {
      await ctx.workspaceState.update(KEYS.mappings, { 'x/a.cpp': { ...link(1), fsPath: join(w, 'a.cpp') } });
      writeFileSync(join(storage, 'links'), 'a file where the folder goes');
      await expect(run()).rejects.toThrow();
      expect(ctx.workspaceState.get(KEYS.mappings)).toBeDefined();
      expect(ctx.globalState.get(KEYS.linksImported)).toBeUndefined();
    });
  });
});
