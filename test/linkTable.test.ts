/** The link table: one file by full path, safe with two windows, never loses a file it can't read. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { addMissing, inScope, LINKS_DIR, LINKS_FILE, LinkTable, type Links, parseLinks, serializeLinks, type StoredLink } from '../src/mapping/linkTable';
import { pathKey } from '../src/mapping/paths';

const L = (fsPath: string, problemId = 1, extra: Partial<StoredLink> = {}): StoredLink => ({ fsPath, problemId, name: `p${problemId}`, ...extra });
const put = (links: Links, l: StoredLink) => {
  links[pathKey(l.fsPath)] = l;
};

describe('the file', () => {
  it('round-trips, every field kept', () => {
    const links: Links = {};
    put(links, L('/w/pkg', 2, { folder: true, submitFile: 'a.h', runFile: 'main.cpp', baseUrl: 'https://g', staleSince: '2026-01-01T00:00:00.000Z', outside: true }));
    expect(parseLinks(serializeLinks(links))).toEqual(links);
  });

  it('whole-file garbage or a future version is null, not an empty table', () => {
    expect(parseLinks('not json')).toBeNull();
    expect(parseLinks('{"version":2,"links":{}}')).toBeNull();
    expect(parseLinks('{"version":1}')).toBeNull();
  });

  it('drops broken entries, and keys come from the path, not the file', () => {
    const text = JSON.stringify({ version: 1, links: { wrong: L('/w/a.cpp'), b: { fsPath: '/w/b.cpp', problemId: 'x', name: 'n' }, c: { problemId: 1, name: 'n' }, d: null } });
    expect(Object.keys(parseLinks(text) ?? {})).toEqual([pathKey('/w/a.cpp')]);
  });
});

describe('scope', () => {
  it('inside an open folder, or saved outside every folder', () => {
    expect(inScope(L('/w/a.cpp'), ['/w'])).toBe(true);
    expect(inScope(L('/w'), ['/w'])).toBe(true);
    expect(inScope(L('/wx/a.cpp'), ['/w'])).toBe(false);
    expect(inScope(L('/o/a.cpp', 1, { outside: true }), [])).toBe(true);
    expect(inScope(L('/w/a.cpp'), [])).toBe(false);
  });
});

describe('addMissing', () => {
  it('never replaces a link, and counts what it added', () => {
    const links: Links = {};
    put(links, L('/w/a.cpp', 1));
    expect(addMissing(links, [L('/w/a.cpp', 2), L('/w/b.cpp', 3)])).toBe(1);
    expect(links[pathKey('/w/a.cpp')].problemId).toBe(1);
    expect(links[pathKey('/w/b.cpp')].problemId).toBe(3);
  });
});

describe('LinkTable', () => {
  let root: string;
  const path = () => join(root, LINKS_DIR, LINKS_FILE);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cedt-table-'));
  });

  it('says so after a write, and only then', async () => {
    const table = new LinkTable(root);
    let writes = 0;
    table.onWrite = () => writes++;
    await table.change(() => false);
    expect(writes).toBe(0);
    await table.change((l) => put(l, L('/w/a.cpp')));
    expect(writes).toBe(1);
  });

  it('no file is an empty table, and reading creates nothing', async () => {
    expect(await new LinkTable(root).read()).toEqual({});
    expect(existsSync(path())).toBe(false);
  });

  it('a patch that changes nothing writes nothing', async () => {
    await new LinkTable(root).change(() => false);
    expect(existsSync(path())).toBe(false);
  });

  it('saves, and a new table reads it back', async () => {
    await new LinkTable(root).change((l) => put(l, L('/w/a.cpp')));
    expect(Object.keys(await new LinkTable(root).read())).toEqual([pathKey('/w/a.cpp')]);
  });

  it('writes from one window run in order, none lost', async () => {
    const t = new LinkTable(root);
    await Promise.all([1, 2, 3, 4, 5].map((n) => t.change((l) => put(l, L(`/w/${n}.cpp`, n)))));
    expect(Object.keys(await t.read())).toHaveLength(5);
  });

  it("two windows: each sees the other's write, and neither undoes it", async () => {
    const a = new LinkTable(root);
    const b = new LinkTable(root);
    await a.change((l) => put(l, L('/w/a.cpp')));
    expect(Object.keys(await b.read())).toHaveLength(1); // b caches from here on
    await b.change((l) => put(l, L('/w/b.cpp', 2)));
    expect(Object.keys(await a.read())).toHaveLength(2);
    await a.change((l) => put(l, L('/w/c.cpp', 3)));
    expect(Object.keys(await b.read())).toHaveLength(3);
  });

  it('a file it cannot read is kept as .bad on the next write', async () => {
    mkdirSync(join(root, LINKS_DIR));
    writeFileSync(path(), '{broken');
    const t = new LinkTable(root);
    expect(await t.read()).toEqual({});
    expect(readFileSync(path(), 'utf8')).toBe('{broken'); // reading changes nothing
    await t.change((l) => put(l, L('/w/a.cpp')));
    expect(readFileSync(`${path()}.bad`, 'utf8')).toBe('{broken');
    expect(Object.keys(await t.read())).toHaveLength(1);
  });
});

describe('reading and writing safely', () => {
  let root: string;
  let file: string;
  const lock = () => join(root, 'links.lock');
  const add = (t: LinkTable, n: number) => t.change((links) => put(links, L(`/w/${n}.cpp`, n)));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cedt-table-'));
    file = join(root, LINKS_DIR, LINKS_FILE);
  });

  it('a read that fails is not a bad file: nothing is moved, replaced or forgotten', async () => {
    const t = new LinkTable(root);
    await add(t, 1);
    expect(Object.keys(await t.read())).toHaveLength(1);
    const good = readFileSync(file, 'utf8');
    rmSync(file);
    mkdirSync(file); // stat works, reading fails
    expect(Object.keys(await t.read())).toHaveLength(1);
    await expect(add(t, 2)).rejects.toThrow();
    expect(existsSync(`${file}.bad`)).toBe(false);
    rmSync(file, { recursive: true });
    writeFileSync(file, good);
    await add(t, 2);
    expect(Object.keys(await t.read())).toHaveLength(2);
  });

  it('two windows writing at once keep each other\'s links', async () => {
    const [a, b] = [new LinkTable(root), new LinkTable(root)];
    await Promise.all(Array.from({ length: 30 }, (_, n) => add(n % 2 ? a : b, n + 1)));
    expect(Object.keys(await new LinkTable(root).read())).toHaveLength(30);
    expect(existsSync(lock())).toBe(false);
  });

  it('waits for the other window, and takes over a lock left by a crash', async () => {
    const t = new LinkTable(root);
    writeFileSync(lock(), '');
    setTimeout(() => rmSync(lock()), 60);
    await add(t, 1);
    expect(Object.keys(await t.read())).toHaveLength(1);
    writeFileSync(lock(), '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock(), old, old);
    await add(t, 2);
    expect(Object.keys(await t.read())).toHaveLength(2);
    expect(existsSync(lock())).toBe(false);
  });

  it('a change that changes nothing leaves nothing behind', async () => {
    await new LinkTable(root).change(() => false);
    expect(existsSync(join(root, LINKS_DIR))).toBe(false);
    expect(existsSync(lock())).toBe(false);
  });
});
