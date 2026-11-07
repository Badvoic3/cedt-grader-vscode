/**
 * The one-time `.prob` import and cleanup (roadmap §1.2): rules, then the whole
 * flow on real folders with the real stores and a fake VS Code. Only the Trash
 * and the notice are fake.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MappingStore } from '../src/mapping/store';
import { binaryOf, casesBySource, GRADER_ID_BASE, isProbPath, planProb, problemIdInUrl, readProb, sourceOf, STATEMENT_ID_BASE } from '../src/migration/cph';
import { migrateOldFiles, type OldFilesDeps } from '../src/migration/oldFiles';
import { CaseStore } from '../src/runner/store';
import { KEYS } from '../src/shared/stateKeys';
import { S } from '../src/shared/strings';

const env = vi.hoisted(() => ({
  folders: [] as { uri: { fsPath: string }; name: string; index: number }[],
  answers: [] as (string | undefined)[],
  notices: [] as string[],
  warnings: [] as string[],
  warnAnswer: undefined as string | undefined,
  trash: [] as string[],
  noTrash: false,
  opened: [] as string[],
  saveLocation: '',
}));

vi.mock('vscode', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const file = (p: string) => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` });
  const folderOf = (p: string) => env.folders.find((f) => p === f.uri.fsPath || p.startsWith(`${f.uri.fsPath}${path.sep}`));
  return {
    Uri: { file, parse: (s: string) => ({ toString: () => s }), joinPath: (u: { fsPath: string }, ...parts: string[]) => file(path.join(u.fsPath, ...parts)) },
    env: { openExternal: async (u: { toString(): string }) => void env.opened.push(u.toString()) },
    workspace: {
      get workspaceFolders() {
        return env.folders;
      },
      getWorkspaceFolder: (u: { fsPath: string }) => folderOf(u.fsPath),
      asRelativePath: (u: { fsPath: string }) => u.fsPath,
      getConfiguration: () => ({ get: () => env.saveLocation }),
      fs: {
        delete: async (u: { fsPath: string }, o?: { useTrash?: boolean }) => {
          if (o?.useTrash && env.noTrash) throw new Error('no trash here');
          if (o?.useTrash) env.trash.push(u.fsPath);
          await fs.rm(u.fsPath, { recursive: true });
        },
      },
    },
    window: {
      showWarningMessage: async (text: string) => {
        env.warnings.push(text);
        return env.warnAnswer;
      },
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
const URL_OF = (id: number) => `${BASE}/submissions/direct_edit_problem/${id}`;
const G = (n: number, input = `g${n}\n`, output = `o${n}\n`) => ({ id: GRADER_ID_BASE + n, input, output });
const MINE = (n: number) => ({ id: 1730000000000 + n, input: `m${n}\n`, output: `r${n}\n` });

describe('rules', () => {
  it('a URL on this server gives its problem; another host or a file path does not', () => {
    expect(problemIdInUrl(URL_OF(1360), BASE)).toBe(1360);
    expect(problemIdInUrl(`${BASE}/problems/7/x`, BASE)).toBe(7);
    expect(problemIdInUrl('https://codeforces.com/problems/1360', BASE)).toBeNull();
    expect(problemIdInUrl('/w/a.cpp', BASE)).toBeNull();
  });

  it('ours: a marker, a URL here, a link, or a name match. Anything else is CPH\'s', () => {
    const cf = { url: 'https://codeforces.com/problemset/problem/1/A', tests: [MINE(1)] };
    expect(planProb(cf, BASE, null, null)).toEqual({ ours: false, problemId: null, linkTo: null });
    expect(planProb({ ...cf, tests: [G(1)] }, BASE, null, null)).toEqual({ ours: true, problemId: null, linkTo: null });
    expect(planProb({ url: URL_OF(5), tests: [] }, BASE, null, null)).toEqual({ ours: true, problemId: 5, linkTo: 5 });
    expect(planProb(cf, BASE, 8, null)).toEqual({ ours: true, problemId: 8, linkTo: null });
    expect(planProb(cf, BASE, null, 9)).toEqual({ ours: true, problemId: 9, linkTo: null });
  });

  it('a file already linked keeps its link; the URL still says whose cases these are', () => {
    expect(planProb({ url: URL_OF(5), tests: [] }, BASE, 8, null)).toEqual({ ours: true, problemId: 5, linkTo: null });
  });

  it('ids give the badge', () => {
    const g = casesBySource([G(21), { id: STATEMENT_ID_BASE + 1, input: 's', output: 't' }, MINE(1)]);
    expect(g.grader).toEqual([{ input: 'g21\n', expected: 'o21\n', testcaseId: 21 }]);
    expect(g.sample).toEqual([{ input: 's', expected: 't' }]);
    expect(g.custom).toEqual([{ input: 'm1\n', expected: 'r1\n' }]);
  });

  it('a moved folder: the source comes from the .prob name beside .cph/', () => {
    const prob = join('/new/hw/.cph', `.a.cpp_${'0'.repeat(32)}.prob`);
    const moved = join('/new/hw', 'a.cpp');
    expect(sourceOf(prob, '/old/hw/a.cpp', (p) => p === moved)).toBe(moved);
    expect(sourceOf(prob, '/old/hw/a.cpp', (p) => p === '/old/hw/a.cpp')).toBe('/old/hw/a.cpp');
    expect(sourceOf(prob, '/old/hw/a.cpp', () => false)).toBe('/old/hw/a.cpp');
  });

  it('paths', () => {
    expect(isProbPath('hw/.cph/.a.cpp_1.prob')).toBe(true);
    expect(isProbPath('.cph/.a.cpp_1.prob')).toBe(true);
    expect(isProbPath('hw/a.prob')).toBe(false);
    expect(isProbPath('hw/.cph/.a.cpp_1.prob.bak')).toBe(false);
    expect(binaryOf(join('/w/hw', 'a.cpp'))).toBe(join('/w/hw', 'a.bin'));
  });

  it('a .prob it cannot use is null, and a broken test is dropped', async () => {
    const d = mkdtempSync(join(tmpdir(), 'cedt-prob-'));
    writeFileSync(join(d, 'bad'), '{');
    writeFileSync(join(d, 'none'), '{"name":"x"}');
    writeFileSync(join(d, 'ok'), JSON.stringify({ tests: [{ id: 1, input: 'a', output: 'b' }, { id: 2 }, null] }));
    expect(await readProb(join(d, 'bad'))).toBeNull();
    expect(await readProb(join(d, 'none'))).toBeNull();
    expect((await readProb(join(d, 'ok')))?.tests).toHaveLength(1);
  });

  it('the real CPH file format reads', async () => {
    const p = await readProb(join(__dirname, 'fixtures', 'cph_local.prob'));
    expect(p?.tests.length).toBeGreaterThan(0);
    expect(typeof p?.srcPath).toBe('string');
  });
});

describe('migrateOldFiles', () => {
  let w: string;
  let storage: string;
  let ctx: { workspaceState: Memo; globalState: Memo; globalStorageUri: { fsPath: string } };
  let mapping: MappingStore;
  let cases: CaseStore;
  let changed: number;
  const names: Record<string, number> = {};

  const write = (rel: string, text = '') => {
    mkdirSync(join(w, rel, '..'), { recursive: true });
    writeFileSync(join(w, rel), text);
    return join(w, rel);
  };
  const prob = (src: string, url: string, tests: object[], name = 'x') =>
    write(`${src.replace(/[^/]+$/, '')}.cph/.${src.split('/').pop()}_${'a'.repeat(32)}.prob`, JSON.stringify({ name, url, tests, srcPath: join(w, src), group: 'local' }));
  const deps = (): OldFilesDeps => ({
    ctx: ctx as never,
    mapping,
    cases,
    baseUrl: BASE,
    nameMatch: (src) => names[basename(src)] ?? null,
    problemName: (id) => `p${id}`,
    changed: async () => void changed++,
    ask: async (_text, buttons, detail) => {
      if (buttons.length === 1) return undefined; // the "moved" message
      env.notices.push(detail ?? '');
      return env.answers.shift();
    },
  });
  const run = async () => {
    const offer = await migrateOldFiles(deps());
    await offer?.();
  };
  const listOf = async (problemId: number) => (await cases.read({ problemId })).cases;

  beforeEach(() => {
    w = mkdtempSync(join(tmpdir(), 'cedt-old-'));
    storage = mkdtempSync(join(tmpdir(), 'cedt-oldst-'));
    env.folders = [{ uri: { fsPath: w }, name: 'w', index: 0 }];
    Object.assign(env, { answers: [], notices: [], warnings: [], warnAnswer: undefined, trash: [], noTrash: false, opened: [], saveLocation: '' });
    for (const k of Object.keys(names)) delete names[k];
    ctx = { workspaceState: new Memo(), globalState: new Memo(), globalStorageUri: { fsPath: storage } };
    mapping = new MappingStore(ctx as never);
    cases = new CaseStore(storage, () => BASE);
    changed = 0;
  });

  it('a fresh workspace: no question, nothing written, and it is not scanned again', async () => {
    write('hw/a.cpp');
    await run();
    expect(env.notices).toEqual([]);
    expect(ctx.workspaceState.get(KEYS.cleanupSettled)).toHaveLength(1);
    expect(readdirSync(storage)).toEqual([]);
  });

  it('imports links and cases before asking anything, with badges and no duplicates', async () => {
    write('hw/a.cpp');
    prob('hw/a.cpp', URL_OF(11), [G(1), { id: STATEMENT_ID_BASE + 1, input: 'g1\r\n', output: 'o1\n' }, MINE(1)]);
    await run();
    expect((await mapping.get({ fsPath: join(w, 'hw/a.cpp') } as never, BASE))).toEqual({ problemId: 11, name: 'p11', baseUrl: BASE });
    expect((await listOf(11)).map((c) => [c.source, c.input])).toEqual([['grader', 'g1\n'], ['custom', 'm1\n']]);
    expect(changed).toBe(1);
    expect(env.notices).toEqual([S.migration.noticeDetail(1)]);
    expect(existsSync(join(w, 'hw/.cph'))).toBe(true); // nothing moved without an answer
  });

  it('several .prob files of one problem merge into one list', async () => {
    write('a.cpp');
    write('sub/b.cpp');
    prob('a.cpp', URL_OF(11), [G(1), MINE(1)]);
    prob('sub/b.cpp', URL_OF(11), [G(1), MINE(2)]);
    await run();
    expect((await listOf(11)).map((c) => c.input).sort()).toEqual(['g1\n', 'm1\n', 'm2\n']);
  });

  it("the grader's KEY line comes off, as with Load", async () => {
    write('a.cpp', 'int main(){}');
    prob('a.cpp', URL_OF(11), [G(1, 'i\n', '1\nKEY: abc\n'), G(2, 'j\n', '2\nKEY: abc\n')]);
    await run();
    expect((await listOf(11)).map((c) => c.expected)).toEqual(['1\n', '2\n']);
  });

  it('an existing link, a "not linked" file and a missing source get no new link, but keep their cases', async () => {
    write('linked.cpp');
    write('off.cpp');
    await mapping.set({ fsPath: join(w, 'linked.cpp') } as never, { problemId: 8, name: 'p8', baseUrl: BASE });
    await mapping.setUnlinked({ fsPath: join(w, 'off.cpp') } as never, true);
    prob('linked.cpp', URL_OF(11), [MINE(1)]);
    prob('off.cpp', URL_OF(12), [MINE(2)]);
    prob('gone.cpp', URL_OF(13), [MINE(3)]);
    await run();
    expect((await mapping.get({ fsPath: join(w, 'linked.cpp') } as never, BASE))?.problemId).toBe(8);
    expect(await mapping.get({ fsPath: join(w, 'off.cpp') } as never, BASE)).toBeUndefined();
    expect(await mapping.get({ fsPath: join(w, 'gone.cpp') } as never, BASE)).toBeUndefined();
    expect(await listOf(11)).toHaveLength(1);
    expect(await listOf(12)).toHaveLength(1);
    expect(await listOf(13)).toHaveLength(1);
  });

  it('a name match brings the cases to that problem without saving a link', async () => {
    write('foo.cpp');
    names['foo.cpp'] = 20;
    prob('foo.cpp', 'Local', [MINE(1)], 'Local: foo');
    await run();
    expect(await listOf(20)).toHaveLength(1);
    expect(await mapping.get({ fsPath: join(w, 'foo.cpp') } as never, BASE)).toBeUndefined();
  });

  it('marked cases of an unknown problem stay with their file', async () => {
    const src = write('z.cpp');
    prob('z.cpp', 'https://other.example/problems/1', [G(1)]);
    await run();
    expect((await cases.read({ file: src })).cases).toHaveLength(1);
  });

  it("another judge's .prob is not imported, not counted and not touched", async () => {
    write('cf.cpp');
    const theirs = prob('cf.cpp', 'https://codeforces.com/problemset/problem/1/A', [MINE(1)]);
    await run();
    expect(env.notices).toEqual([]);
    expect(existsSync(theirs)).toBe(true);
    expect((await cases.read({ file: join(w, 'cf.cpp') })).cases).toEqual([]);
  });

  it('Move to Trash: only what is ours, and .cph/ only once empty', async () => {
    write('hw/a.cpp');
    write('hw/cf.cpp');
    write('hw/a.bin');
    write('hw/data.bin');
    write('.cedt-grader.json', '{"version":1,"files":{}}');
    const mine = prob('hw/a.cpp', URL_OF(11), [G(1)]);
    write(`hw/.cph/.a.cpp_${'a'.repeat(32)}.prob.bak`, '{}');
    const theirs = prob('hw/cf.cpp', 'https://codeforces.com/problemset/problem/1/A', [MINE(1)]);
    env.answers = ['trash'];
    await run();
    expect(env.notices).toEqual([S.migration.noticeDetail(4)]);
    expect(env.trash.sort()).toEqual([join(w, '.cedt-grader.json'), join(w, 'hw/a.bin'), mine, `${mine}.bak`].sort());
    expect(existsSync(theirs)).toBe(true);
    expect(existsSync(join(w, 'hw/data.bin'))).toBe(true);
    expect(existsSync(join(w, 'hw/a.cpp'))).toBe(true);
  });

  it('with only our files, the empty .cph/ goes too', async () => {
    write('a.cpp');
    prob('a.cpp', URL_OF(11), [G(1)]);
    env.answers = ['trash'];
    await run();
    expect(existsSync(join(w, '.cph'))).toBe(false);
    expect(readdirSync(w)).toEqual(['a.cpp']);
  });

  it('answered once, never asked again; a deleted case does not return', async () => {
    write('a.cpp');
    prob('a.cpp', URL_OF(11), [G(1), MINE(1)]);
    env.answers = ['never'];
    await run();
    const [first] = await listOf(11);
    await cases.remove({ problemId: 11 }, first.id);
    await run();
    expect(env.notices).toHaveLength(1);
    expect(await listOf(11)).toHaveLength(1);
    expect(existsSync(join(w, '.cph'))).toBe(true); // Don't Ask Again keeps the files
  });

  it('dismissing the question is no answer: asked on the next start, nothing imported twice', async () => {
    write('a.cpp');
    prob('a.cpp', URL_OF(11), [G(1)]);
    await run();
    const [first] = await listOf(11);
    await cases.remove({ problemId: 11 }, first.id);
    await run();
    expect(env.notices).toHaveLength(2);
    expect(await listOf(11)).toEqual([]);
  });

  it("What's New opens the changelog, and the question comes back", async () => {
    write('a.cpp');
    prob('a.cpp', URL_OF(11), [G(1)]);
    env.answers = ['new'];
    await run();
    expect(env.opened[0]).toMatch(/CHANGELOG\.md$/);
    expect(env.notices).toHaveLength(2);
    expect(ctx.workspaceState.get(KEYS.cleanupSettled)).toBeUndefined();
  });

  it('no Trash: asks, then deletes; declined, the files stay and it asks next time', async () => {
    write('a.cpp');
    const p = prob('a.cpp', URL_OF(11), [G(1)]);
    env.noTrash = true;
    env.answers = ['trash'];
    await run();
    expect(env.warnings).toEqual([S.migration.noTrash(1)]);
    expect(existsSync(p)).toBe(true);
    expect(ctx.workspaceState.get(KEYS.cleanupSettled)).toBeUndefined();
    env.answers = ['trash'];
    env.warnAnswer = S.migration.deleteForever;
    await run();
    expect(existsSync(p)).toBe(false);
    expect(ctx.workspaceState.get(KEYS.cleanupSettled)).toHaveLength(1);
  });

  it("CPH's save location: found by srcPath, only for sources in the open folder", async () => {
    write('a.cpp');
    const save = mkdtempSync(join(tmpdir(), 'cedt-save-'));
    env.saveLocation = save;
    writeFileSync(join(save, '.a.cpp_1.prob'), JSON.stringify({ name: 'x', url: URL_OF(11), tests: [G(1)], srcPath: join(w, 'a.cpp') }));
    writeFileSync(join(save, '.b.cpp_2.prob'), JSON.stringify({ name: 'x', url: URL_OF(12), tests: [G(2)], srcPath: '/elsewhere/b.cpp' }));
    env.answers = ['trash'];
    await run();
    expect(await listOf(11)).toHaveLength(1);
    expect(await listOf(12)).toEqual([]);
    expect(readdirSync(save)).toEqual(['.b.cpp_2.prob']);
  });

  it('recorded .prob.bak files in the folder are offered; others are never touched', async () => {
    const bak = write('old/.cph/.x.cpp_1.prob.bak', '{}');
    await ctx.globalState.update(KEYS.backups, [{ path: bak, at: '' }, { path: '/elsewhere/.cph/.y.prob.bak', at: '' }, { path: join(w, 'main.cpp'), at: '' }]);
    write('main.cpp', 'mine');
    env.answers = ['trash'];
    await run();
    expect(env.trash).toContain(bak);
    expect(env.trash).not.toContain(join(w, 'main.cpp'));
    expect(readFileSync(join(w, 'main.cpp'), 'utf8')).toBe('mine');
  });
});
