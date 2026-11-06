/**
 * Folder mode must follow every file of a linked folder, also when neither
 * the folder nor its files match a problem by name (docs: causes A–E of the
 * "folder link not following sibling files" bug). Real MappingStore, FolderMode
 * and Links over a fake VS Code workspace on a temporary folder.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Host } from '../src/flows/host';
import { FolderMode } from '../src/flows/folderMode';
import { Links } from '../src/flows/links';
import { MappingStore } from '../src/mapping/store';

const env = vi.hoisted(() => ({ folders: [] as { uri: { fsPath: string }; name: string; index: number }[], dialog: undefined as unknown }));

vi.mock('vscode', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const file = (p: string) => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` });
  const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
  const folderOf = (p: string) => env.folders.find((f) => inside(p, f.uri.fsPath));
  return {
    Uri: { file, joinPath: (u: { fsPath: string }, ...parts: string[]) => file(path.posix.join(u.fsPath, ...parts)) },
    workspace: {
      get workspaceFolders() {
        return env.folders;
      },
      textDocuments: [],
      getWorkspaceFolder: (u: { fsPath: string }) => folderOf(u.fsPath),
      // As in VS Code: a workspace folder itself and anything outside come back as the full path.
      asRelativePath: (u: string | { fsPath: string }) => {
        const p = typeof u === 'string' ? u : u.fsPath;
        const f = folderOf(p);
        return !f || f.uri.fsPath === p ? p : path.posix.relative(f.uri.fsPath, p);
      },
      fs: {
        readFile: (u: { fsPath: string }) => fs.readFile(u.fsPath),
        writeFile: (u: { fsPath: string }, data: Uint8Array) => fs.writeFile(u.fsPath, data),
      },
    },
    window: { showInformationMessage: async () => undefined, setStatusBarMessage: () => undefined, showOpenDialog: async () => env.dialog },
    commands: { executeCommand: async () => undefined },
  };
});

const BASE = 'https://grader.example';
const uri = (p: string) => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` }) as never;

class Memo {
  private data = new Map<string, unknown>();
  get<T>(key: string, fallback?: T): T {
    return (this.data.has(key) ? this.data.get(key) : fallback) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

/** The parts of the controller these flows use. */
function session() {
  const mapping = new MappingStore({ workspaceState: new Memo(), globalState: new Memo() } as never);
  const problems = [
    { id: 1, name: 'alpha', fullName: 'alpha', tags: [] },
    { id: 2, name: 'beta', fullName: 'beta', tags: [] },
    { id: 3, name: 'gamma', fullName: 'gamma', tags: [] },
  ];
  const s = {
    mapping,
    problems,
    cfg: { baseUrl: BASE, fileNamePattern: { pattern: '{name}.{ext}' } },
    data: { problemList: () => ({ problems }) },
    cphSaveLocation: () => '',
    fileUri: null as { fsPath: string } | null,
    problem: null as { id: number; name: string } | null,
    /** Answer to the inline questions; undefined = dismissed. */
    answer: undefined as string | undefined,
    /** Problem the picker returns; undefined = cancelled. */
    pick: undefined as number | undefined,
    asked: [] as string[],
    /** Options of the last question, and its answer callback while `hold` is on. */
    askOpts: undefined as { stays?: boolean } | undefined,
    askButtons: [] as string[],
    askDetail: undefined as string | undefined,
    hold: false,
    release: null as ((id: string | undefined) => void) | null,
    currentProblem: () => s.problem,
    allSourceExts: () => ['cpp', 'c', 'h', 'py'],
    askInline: async (text: string, buttons: { id: string }[], opts?: { detail?: string; stays?: boolean }) => {
      s.asked.push(text);
      s.askOpts = opts;
      s.askButtons = buttons.map((b) => b.id);
      s.askDetail = opts?.detail;
      return s.hold ? new Promise<string | undefined>((resolve) => (s.release = resolve)) : s.answer;
    },
    chooseProblemQuickPick: async (apply: (id: number) => Promise<void>) => {
      if (s.pick !== undefined) await apply(s.pick);
    },
    setActiveFile: async (u: { fsPath: string }) => {
      s.fileUri = u;
      const link = await mapping.activeLink(u as never, BASE);
      await s.folder.load(link?.folder ? { fsPath: link.folder, entry: link.entry } : null);
      s.problem = link ? { id: link.entry.problemId, name: link.entry.name } : null;
      // As the controller does: a file with no link in a folder named like a problem is folder mode, unsaved.
      const byName = link || mapping.isUnlinkedHere(u as never) ? undefined : problems.find((p) => p.name === basename(dirname(u.fsPath)));
      if (byName) {
        await s.folder.load({ fsPath: dirname(u.fsPath), entry: { problemId: byName.id, name: byName.name, baseUrl: BASE, folder: true } }, true);
        s.problem = byName;
      }
    },
    folder: null as unknown as FolderMode,
    links: null as unknown as Links,
  };
  s.folder = new FolderMode(s as unknown as Host);
  s.links = new Links(s as unknown as Host);
  return s;
}

let dir: string;
let root: string;
let pkg: string;
const FILES = ['foo.cpp', 'bar.cpp', 'student.h'];

/** Every file of the folder and which problem / folder link it gets. */
async function follow(s: ReturnType<typeof session>, folder: string) {
  const out: Record<string, [number | null, string | null]> = {};
  for (const f of FILES) {
    await s.setActiveFile(uri(join(folder, f)));
    out[f] = [s.problem?.id ?? null, s.folder.link?.fsPath ?? null];
  }
  return out;
}
const allOn = (problemId: number, folder: string) => Object.fromEntries(FILES.map((f) => [f, [problemId, folder]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'siblings-'));
  root = join(dir, 'ws');
  pkg = join(root, 'xyz_folder');
  mkdirSync(pkg, { recursive: true });
  for (const f of FILES) writeFileSync(join(pkg, f), `// ${f}\n`);
  env.folders = [{ uri: { fsPath: root }, name: 'ws', index: 0 }];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('both click orders', () => {
  it('pick a problem, then link the folder', async () => {
    const s = session();
    await s.setActiveFile(uri(join(pkg, 'foo.cpp')));
    await s.links.mapCurrentFile(1);
    await s.folder.toggle();
    expect(await follow(s, pkg)).toEqual(allOn(1, pkg));
  });

  it('link the folder, then pick a problem', async () => {
    const s = session();
    await s.setActiveFile(uri(join(pkg, 'foo.cpp')));
    s.pick = 1;
    await s.folder.toggle();
    expect(await follow(s, pkg)).toEqual(allOn(1, pkg));
  });
});

describe('cause A: picking a problem in folder mode', () => {
  it('moves the folder link, keeps its files, and writes no link for the file', async () => {
    const s = session();
    await s.mapping.set(uri(pkg), { problemId: 1, name: 'alpha', baseUrl: BASE, folder: true, submitFile: 'student.h', runFile: 'foo.cpp' });
    await s.setActiveFile(uri(join(pkg, 'foo.cpp')));
    await s.links.mapCurrentFile(2);
    expect(await follow(s, pkg)).toEqual(allOn(2, pkg));
    expect(await s.mapping.get(uri(pkg), BASE)).toMatchObject({ problemId: 2, name: 'beta', folder: true, submitFile: 'student.h', runFile: 'foo.cpp' });
    expect(await s.mapping.get(uri(join(pkg, 'foo.cpp')), BASE)).toBeUndefined();
  });

  describe('with a file inside linked to another problem', () => {
    const start = async (s: ReturnType<typeof session>) => {
      await s.mapping.set(uri(pkg), { problemId: 3, name: 'gamma', baseUrl: BASE, folder: true, submitFile: 'student.h' });
      await s.mapping.set(uri(join(pkg, 'bar.cpp')), { problemId: 2, name: 'beta', baseUrl: BASE });
      await s.setActiveFile(uri(join(pkg, 'foo.cpp')));
    };

    it('asks, then every file follows and the folder keeps its files', async () => {
      const s = session();
      await start(s);
      s.answer = 'replace';
      await s.links.mapCurrentFile(1);
      expect(s.asked).toHaveLength(1);
      expect(await follow(s, pkg)).toEqual(allOn(1, pkg));
      expect(await s.mapping.get(uri(pkg), BASE)).toMatchObject({ problemId: 1, folder: true, submitFile: 'student.h' });
    });

    it('declining changes nothing', async () => {
      const s = session();
      await start(s);
      s.answer = 'cancel';
      await s.links.mapCurrentFile(1);
      expect((await s.mapping.get(uri(pkg), BASE))?.problemId).toBe(3);
      expect((await s.mapping.get(uri(join(pkg, 'bar.cpp')), BASE))?.problemId).toBe(2);
    });

    it('picking the problem that file already has needs no question', async () => {
      const s = session();
      await start(s);
      await s.links.mapCurrentFile(2);
      expect(s.asked).toEqual([]);
      expect(await follow(s, pkg)).toEqual(allOn(2, pkg));
    });
  });

  it('a folder only matched by its name is not changed: the pick is for the file', async () => {
    const s = session();
    await s.setActiveFile(uri(join(pkg, 'foo.cpp')));
    await s.folder.load({ fsPath: pkg, entry: { problemId: 1, name: 'alpha', baseUrl: BASE, folder: true } }, true);
    await s.links.mapCurrentFile(2);
    expect(await s.mapping.get(uri(pkg), BASE)).toBeUndefined();
    expect((await s.mapping.get(uri(join(pkg, 'foo.cpp')), BASE))?.problemId).toBe(2);
  });
});

describe('cause B: Link the whole folder with no problem yet', () => {
  it('opens the picker and links the folder with the choice', async () => {
    const s = session();
    await s.setActiveFile(uri(join(pkg, 'bar.cpp')));
    s.pick = 2;
    await s.folder.toggle();
    expect(await s.mapping.get(uri(pkg), BASE)).toMatchObject({ problemId: 2, folder: true });
    expect(await s.mapping.get(uri(join(pkg, 'bar.cpp')), BASE)).toBeUndefined();
  });

  it('a cancelled picker links nothing', async () => {
    const s = session();
    await s.setActiveFile(uri(join(pkg, 'bar.cpp')));
    await s.folder.toggle();
    expect(await s.mapping.get(uri(pkg), BASE)).toBeUndefined();
  });
});

describe('cause C: "not linked" around the folder', () => {
  const linkFrom = async (s: ReturnType<typeof session>) => {
    await s.mapping.set(uri(join(pkg, 'foo.cpp')), { problemId: 1, name: 'alpha', baseUrl: BASE });
    await s.setActiveFile(uri(join(pkg, 'foo.cpp')));
    await s.folder.toggle();
  };

  it('is cleared for a sibling file', async () => {
    const s = session();
    await s.mapping.setUnlinked(uri(join(pkg, 'bar.cpp')), true);
    await linkFrom(s);
    expect(await follow(s, pkg)).toEqual(allOn(1, pkg));
  });

  it('is cleared for the folder itself', async () => {
    const s = session();
    await s.mapping.setUnlinked(uri(pkg), true);
    await linkFrom(s);
    expect(await follow(s, pkg)).toEqual(allOn(1, pkg));
  });

  it('is cleared for a folder above it, not for an unrelated one', async () => {
    const s = session();
    const other = join(root, 'other');
    await s.mapping.setUnlinked(uri(root), true);
    await s.mapping.setUnlinked(uri(other), true);
    await linkFrom(s);
    expect(await follow(s, pkg)).toEqual(allOn(1, pkg));
    expect(s.mapping.isUnlinked(uri(other))).toBe(true);
  });
});

describe('cause D: file links inside the folder', () => {
  const start = async (s: ReturnType<typeof session>) => {
    await s.mapping.set(uri(join(pkg, 'foo.cpp')), { problemId: 1, name: 'alpha', baseUrl: BASE });
    await s.mapping.set(uri(join(pkg, 'bar.cpp')), { problemId: 2, name: 'beta', baseUrl: BASE });
    await s.setActiveFile(uri(join(pkg, 'foo.cpp')));
  };

  it('a link to another problem is replaced after asking', async () => {
    const s = session();
    await start(s);
    s.answer = 'replace';
    await s.folder.toggle();
    expect(s.asked).toHaveLength(1);
    expect(await follow(s, pkg)).toEqual(allOn(1, pkg));
  });

  it('Dismiss leaves everything as it was', async () => {
    const s = session();
    await start(s);
    s.answer = 'dismiss';
    await s.folder.toggle();
    expect(s.askButtons).toEqual(['replace', 'cancel', 'dismiss']);
    expect(await s.mapping.get(uri(pkg), BASE)).toBeUndefined();
    expect((await s.mapping.get(uri(join(pkg, 'foo.cpp')), BASE))?.problemId).toBe(1);
    expect((await s.mapping.get(uri(join(pkg, 'bar.cpp')), BASE))?.problemId).toBe(2);
  });

  it('Cancel removes the link that raised the question, and says so first', async () => {
    const s = session();
    await start(s);
    s.answer = 'cancel';
    await s.folder.toggle();
    expect(s.askDetail).toContain('foo.cpp');
    expect(await s.mapping.get(uri(pkg), BASE)).toBeUndefined();
    expect(await s.mapping.get(uri(join(pkg, 'foo.cpp')), BASE)).toBeUndefined();
    expect(s.mapping.isUnlinked(uri(join(pkg, 'foo.cpp')))).toBe(true);
    expect((await s.mapping.get(uri(join(pkg, 'bar.cpp')), BASE))?.problemId).toBe(2);
    expect(s.problem).toBeNull();
  });

  it('Cancel from another file still removes the link of the file that raised it', async () => {
    const s = session();
    await start(s);
    s.hold = true;
    const action = s.folder.toggle();
    while (!s.release) await new Promise((r) => setTimeout(r, 1));
    await s.setActiveFile(uri(join(pkg, 'bar.cpp')));
    s.release('cancel');
    await action;
    expect(await s.mapping.get(uri(join(pkg, 'foo.cpp')), BASE)).toBeUndefined();
    expect(s.fileUri?.fsPath).toBe(join(pkg, 'bar.cpp'));
    expect(s.problem?.id).toBe(2);
  });

  it('nothing to undo when the problem came from the picker: Link or Cancel only', async () => {
    const s = session();
    await s.mapping.set(uri(join(pkg, 'bar.cpp')), { problemId: 2, name: 'beta', baseUrl: BASE });
    await s.setActiveFile(uri(join(pkg, 'foo.cpp')));
    s.pick = 1;
    s.answer = 'cancel';
    await s.folder.toggle();
    expect(s.askButtons).toEqual(['replace', 'cancel']);
    expect(s.mapping.isUnlinked(uri(join(pkg, 'foo.cpp')))).toBe(false);
    expect(await s.mapping.get(uri(pkg), BASE)).toBeUndefined();
  });

  it('a link to the same problem is covered without asking', async () => {
    const s = session();
    await s.mapping.set(uri(join(pkg, 'foo.cpp')), { problemId: 1, name: 'alpha', baseUrl: BASE });
    await s.mapping.set(uri(join(pkg, 'bar.cpp')), { problemId: 1, name: 'alpha', baseUrl: BASE });
    await s.setActiveFile(uri(join(pkg, 'foo.cpp')));
    await s.folder.toggle();
    expect(s.asked).toEqual([]);
    expect(await follow(s, pkg)).toEqual(allOn(1, pkg));
  });

  it('a stale link never blocks the folder', async () => {
    const s = session();
    await s.mapping.set(uri(join(pkg, 'bar.cpp')), { problemId: 2, name: 'beta', baseUrl: BASE, staleSince: '2026-01-01T00:00:00.000Z' });
    await s.mapping.set(uri(join(pkg, 'foo.cpp')), { problemId: 1, name: 'alpha', baseUrl: BASE });
    await s.setActiveFile(uri(join(pkg, 'foo.cpp')));
    await s.folder.toggle();
    expect(s.asked).toEqual([]);
    expect(await follow(s, pkg)).toEqual(allOn(1, pkg));
  });

  it('confirming a folder-name match leaves links to other problems alone', async () => {
    const s = session();
    await s.mapping.set(uri(join(pkg, 'bar.cpp')), { problemId: 2, name: 'beta', baseUrl: BASE });
    await s.mapping.setUnlinked(uri(join(pkg, 'student.h')), true);
    await s.setActiveFile(uri(join(pkg, 'foo.cpp')));
    await s.folder.load({ fsPath: pkg, entry: { problemId: 1, name: 'alpha', baseUrl: BASE, folder: true } }, true);
    expect(await s.folder.keepMatch()).toBe(true);
    expect((await s.mapping.get(uri(join(pkg, 'bar.cpp')), BASE))?.problemId).toBe(2);
    expect(s.mapping.isUnlinked(uri(join(pkg, 'student.h')))).toBe(false);
  });
});

describe('Auto-detect on a folder matched by its name', () => {
  let named: string;
  beforeEach(() => {
    named = join(root, 'alpha');
    mkdirSync(named);
    for (const f of FILES) writeFileSync(join(named, f), `// ${f}\n`);
  });
  const start = async (s: ReturnType<typeof session>) => {
    await s.mapping.set(uri(join(named, 'bar.cpp')), { problemId: 2, name: 'beta', baseUrl: BASE });
    await s.setActiveFile(uri(join(named, 'foo.cpp')));
  };

  it('saves the folder link: no second click on Link the whole folder', async () => {
    const s = session();
    await s.setActiveFile(uri(join(named, 'foo.cpp')));
    expect(s.folder.matched).toBe(true);
    await s.links.autoDetect();
    expect(s.asked).toEqual([]);
    expect(s.folder.matched).toBe(false);
    expect(await s.mapping.get(uri(named), BASE)).toMatchObject({ problemId: 1, folder: true });
    expect(await follow(s, named)).toEqual(allOn(1, named));
  });

  it('asks about a file linked to another problem, then every file follows', async () => {
    const s = session();
    await start(s);
    s.answer = 'replace';
    await s.links.autoDetect();
    expect(s.asked).toHaveLength(1);
    expect(await follow(s, named)).toEqual(allOn(1, named));
  });

  it('Dismiss saves nothing and keeps the match', async () => {
    const s = session();
    await start(s);
    s.answer = 'dismiss';
    await s.links.autoDetect();
    expect(s.folder.matched).toBe(true);
    expect(await s.mapping.get(uri(named), BASE)).toBeUndefined();
    expect((await s.mapping.get(uri(join(named, 'bar.cpp')), BASE))?.problemId).toBe(2);
  });

  it('Cancel drops the match: the folder is no longer matched', async () => {
    const s = session();
    await start(s);
    s.answer = 'cancel';
    await s.links.autoDetect();
    expect(s.mapping.isUnlinked(uri(named))).toBe(true);
    expect(s.problem).toBeNull();
    expect(s.folder.link).toBeNull();
    expect((await s.mapping.get(uri(join(named, 'bar.cpp')), BASE))?.problemId).toBe(2);
  });

  it('the folder icon on a folder match: Cancel drops the match too', async () => {
    const s = session();
    await start(s);
    s.answer = 'cancel';
    await s.folder.toggle();
    expect(s.askDetail).toContain('alpha/');
    expect(s.mapping.isUnlinked(uri(named))).toBe(true);
    expect(s.problem).toBeNull();
  });

  it('Cancel after switching from a chosen link puts that link back', async () => {
    const s = session();
    await s.mapping.set(uri(join(named, 'bar.cpp')), { problemId: 2, name: 'beta', baseUrl: BASE });
    await s.mapping.set(uri(join(named, 'foo.cpp')), { problemId: 3, name: 'gamma', baseUrl: BASE });
    await s.setActiveFile(uri(join(named, 'foo.cpp')));
    const answers = ['switch', 'cancel'];
    s.askInline = async (text: string, buttons: { id: string }[], opts?: { detail?: string; stays?: boolean }) => {
      s.asked.push(text);
      s.askButtons = buttons.map((b) => b.id);
      s.askDetail = opts?.detail;
      return answers.shift();
    };
    await s.links.autoDetect();
    expect(s.askDetail).toContain('gamma');
    expect((await s.mapping.get(uri(join(named, 'foo.cpp')), BASE))?.problemId).toBe(3);
    expect(s.problem?.id).toBe(3);
    expect(s.mapping.isUnlinked(uri(named))).toBe(false);
  });

  it('a file matched on its own name is not saved', async () => {
    const s = session();
    writeFileSync(join(pkg, 'beta.cpp'), '');
    await s.setActiveFile(uri(join(pkg, 'beta.cpp')));
    await s.links.autoDetect();
    expect(await s.mapping.get(uri(pkg), BASE)).toBeUndefined();
    expect(await s.mapping.get(uri(join(pkg, 'beta.cpp')), BASE)).toBeUndefined();
  });
});

describe('moving to another file while a folder question is open', () => {
  const start = async (s: ReturnType<typeof session>) => {
    await s.mapping.set(uri(join(pkg, 'foo.cpp')), { problemId: 1, name: 'alpha', baseUrl: BASE });
    await s.mapping.set(uri(join(pkg, 'bar.cpp')), { problemId: 2, name: 'beta', baseUrl: BASE });
    await s.setActiveFile(uri(join(pkg, 'foo.cpp')));
    s.hold = true;
  };
  const whileOpen = async (s: ReturnType<typeof session>, action: Promise<void>, next: string) => {
    while (!s.release) await new Promise((r) => setTimeout(r, 1));
    expect(s.askOpts?.stays).toBe(true);
    await s.setActiveFile(uri(next));
    s.release('replace');
    await action;
  };

  it('Link the whole folder still applies, and the file you moved to stays active', async () => {
    const s = session();
    await start(s);
    await whileOpen(s, s.folder.toggle(), join(pkg, 'bar.cpp'));
    expect(s.fileUri?.fsPath).toBe(join(pkg, 'bar.cpp'));
    expect(s.problem?.id).toBe(1);
    expect(s.folder.link?.fsPath).toBe(pkg);
    s.hold = false;
    expect(await follow(s, pkg)).toEqual(allOn(1, pkg));
  });

  it('it also works from a file outside the folder', async () => {
    const s = session();
    const away = join(root, 'away.cpp');
    writeFileSync(away, '');
    await start(s);
    await whileOpen(s, s.folder.toggle(), away);
    expect(s.fileUri?.fsPath).toBe(away);
    expect(s.folder.link).toBeNull();
    s.hold = false;
    expect(await follow(s, pkg)).toEqual(allOn(1, pkg));
  });

  it('a pick in folder mode and Auto-detect ask the same way', async () => {
    const a = session();
    await a.mapping.set(uri(pkg), { problemId: 3, name: 'gamma', baseUrl: BASE, folder: true });
    await a.mapping.set(uri(join(pkg, 'bar.cpp')), { problemId: 2, name: 'beta', baseUrl: BASE });
    await a.setActiveFile(uri(join(pkg, 'foo.cpp')));
    a.hold = true;
    await whileOpen(a, a.links.mapCurrentFile(1), join(pkg, 'student.h'));
    a.hold = false;
    expect(await follow(a, pkg)).toEqual(allOn(1, pkg));

    const named = join(root, 'alpha');
    mkdirSync(named);
    for (const f of FILES) writeFileSync(join(named, f), '');
    const b = session();
    await b.mapping.set(uri(join(named, 'bar.cpp')), { problemId: 2, name: 'beta', baseUrl: BASE });
    await b.setActiveFile(uri(join(named, 'foo.cpp')));
    b.hold = true;
    await whileOpen(b, b.links.autoDetect(), join(named, 'student.h'));
    b.hold = false;
    expect(await follow(b, named)).toEqual(allOn(1, named));
  });
});

describe('cause E: the folder is the workspace root, or outside the workspace', () => {
  it('links the workspace root under the key "."', async () => {
    env.folders = [{ uri: { fsPath: pkg }, name: 'xyz_folder', index: 0 }];
    const s = session();
    await s.mapping.set(uri(join(pkg, 'foo.cpp')), { problemId: 1, name: 'alpha', baseUrl: BASE });
    await s.setActiveFile(uri(join(pkg, 'foo.cpp')));
    expect(s.folder.modeTarget().reason).toBeNull();
    await s.folder.toggle();
    expect(await follow(s, pkg)).toEqual(allOn(1, pkg));
    const saved = JSON.parse(readFileSync(join(pkg, '.cedt-grader.json'), 'utf8'));
    expect(Object.keys(saved.files)).toEqual(['.']);
    expect(s.folder.view()?.path).toBe('xyz_folder/');
  });

  it('a workspace-root link is read back from .cedt-grader.json on another machine', async () => {
    env.folders = [{ uri: { fsPath: pkg }, name: 'xyz_folder', index: 0 }];
    writeFileSync(join(pkg, '.cedt-grader.json'), JSON.stringify({ version: 1, files: { '.': { problemId: 2, name: 'beta', baseUrl: BASE, folder: true } } }));
    expect(await follow(session(), pkg)).toEqual(allOn(2, pkg));
  });

  it('links a folder outside the workspace without touching it', async () => {
    env.folders = [];
    const s = session();
    await s.mapping.set(uri(join(pkg, 'foo.cpp')), { problemId: 1, name: 'alpha', baseUrl: BASE });
    await s.setActiveFile(uri(join(pkg, 'foo.cpp')));
    expect(s.folder.modeTarget().reason).toBeNull();
    await s.folder.toggle();
    expect(await follow(s, pkg)).toEqual(allOn(1, pkg));
    expect(existsSync(join(pkg, '.cedt-grader.json'))).toBe(false);
    expect(s.folder.view()?.path).toBe('xyz_folder/');
  });
});

describe('a package opened as the workspace folder', () => {
  const pkgFiles = () => {
    env.folders = [{ uri: { fsPath: pkg }, name: 'xyz_folder', index: 0 }];
    writeFileSync(join(pkg, 'main.cpp'), '#include "student.h"\nint main() { return 0; }\n');
    writeFileSync(join(pkg, 'student.h'), '// add your code here\n');
  };

  it('folder mode is automatic for a sure match with both roles found', async () => {
    pkgFiles();
    const s = session();
    expect(await s.folder.atRootPackage(uri(join(pkg, 'main.cpp')), 'filename')).toBe(true);
    expect(await s.folder.atRootPackage(uri(join(pkg, 'main.cpp')), 'cph')).toBe(true);
  });

  it('a suggestion, or a file further down, changes nothing', async () => {
    pkgFiles();
    mkdirSync(join(pkg, 'sub'));
    const s = session();
    expect(await s.folder.atRootPackage(uri(join(pkg, 'main.cpp')), 'suggested')).toBe(false);
    expect(await s.folder.atRootPackage(uri(join(pkg, 'sub', 'x.cpp')), 'filename')).toBe(false);
  });

  it('without a driver there is no package', async () => {
    env.folders = [{ uri: { fsPath: pkg }, name: 'xyz_folder', index: 0 }];
    expect(await session().folder.atRootPackage(uri(join(pkg, 'foo.cpp')), 'filename')).toBe(false);
  });
});

describe('folder names the matcher sees', () => {
  it('at the workspace folder: its name; below it: the path from there', () => {
    const s = session();
    expect(s.links.sourceFile(join(root, 'top.cpp')).folders).toEqual(['ws']);
    expect(s.links.sourceFile(join(pkg, 'foo.cpp')).folders).toEqual(['ws', 'xyz_folder']);
  });

  it('outside the workspace: only the parent folder, no OS path segments', () => {
    env.folders = [];
    expect(session().links.sourceFile('/Users/me/Downloads/pkg/a.cpp').folders).toEqual(['pkg']);
  });
});

describe('a window with no folder open', () => {
  it('remembers auto-matches globally', async () => {
    env.folders = [];
    const s = session();
    await s.mapping.recordAuto(uri('/tmp/a.cpp'), 1, 'filename');
    expect(s.mapping.autoMatches().map((a) => a.problemId)).toEqual([1]);
    env.folders = [{ uri: { fsPath: root }, name: 'ws', index: 0 }];
    expect(s.mapping.autoMatches()).toEqual([]); // a workspace keeps its own list
  });

  it('asks where a new file goes; cancelled = nowhere', async () => {
    env.folders = [];
    const s = session();
    env.dialog = [uri('/picked')];
    expect((await s.links.targetFolder())?.fsPath).toBe('/picked');
    env.dialog = undefined;
    expect(await s.links.targetFolder()).toBeUndefined();
  });

  it('the active file wins over everything, then the workspace folder', async () => {
    const s = session();
    expect((await s.links.targetFolder())?.fsPath).toBe(root);
    s.fileUri = uri(join(pkg, 'foo.cpp'));
    expect((await s.links.targetFolder())?.fsPath).toBe(pkg);
  });
});
