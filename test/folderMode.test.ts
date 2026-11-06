/**
 * Folder mode: a problem linked to a folder (a package: driver + headers).
 * Link storage in `.cedt-grader.json`, nearest-folder resolution, the
 * submit file following renames / deletes, "files for this problem" seeing
 * a folder as one item, and `.h` headers as C++ (or C).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cphProbPath } from '../src/mapping/cph';
import { chooseLanguage, type Language } from '../src/grader';
import { listFolderFiles } from '../src/mapping/folderFiles';
import { pickScope } from '../src/mapping/linkActions';
import { lookup, mappingKey, parseMappingFile, reverseIndex, ROOT_KEY, serializeMappingFile } from '../src/mapping/mappingFile';
import { affectedByDelete, cphFilesAfterFolderRename, fileLinksInside, type LocatedEntry, moveCphProblem, nearestFolderLink, planRename, submitFileAfterMove, submitFileDeleted, submitFilePath, unlinkedAround } from '../src/mapping/mappingOps';
import { folderNameFor } from '../src/mapping/match';
import { isAtOrInside, isInside } from '../src/mapping/paths';
import { type AutoMatch, linkedNotice, mergeProblemFiles } from '../src/mapping/problemFiles';

const BASE = 'https://grader.example';
const E = (fsPath: string, problemId: number, extra: object = {}): LocatedEntry => ({ fsPath, entry: { problemId, name: `p${problemId}`, ...extra } });
const FOLDER = (fsPath: string, problemId: number, submitFile?: string) => E(fsPath, problemId, { folder: true, ...(submitFile ? { submitFile } : {}) });

describe('.cedt-grader.json: folder links', () => {
  it('keeps folder and submitFile (normalized), drops a submitFile outside the folder', () => {
    const d = parseMappingFile(
      JSON.stringify({
        version: 1,
        files: {
          'pkg/da68_x': { problemId: 7, name: 'da68_x', folder: true, submitFile: './sub\\student.h', runFile: 'main.cpp' },
          'pkg/evil': { problemId: 8, name: 'e', folder: true, submitFile: '../outside.h' },
          'a.cpp': { problemId: 9, name: 'a', submitFile: 'ignored.h' },
        },
      }),
    );
    expect(d.files['pkg/da68_x']).toEqual({ problemId: 7, name: 'da68_x', folder: true, submitFile: 'sub/student.h', runFile: 'main.cpp' });
    expect(d.files['pkg/evil']).toEqual({ problemId: 8, name: 'e', folder: true });
    expect(d.files['a.cpp']).toEqual({ problemId: 9, name: 'a' }); // submitFile only means something for folders
    expect(parseMappingFile(serializeMappingFile(d))).toEqual(d);
    expect(reverseIndex(d, BASE).get(7)).toEqual(['pkg/da68_x']);
    expect(lookup(d, 'pkg/da68_x', BASE)?.folder).toBe(true);
  });
});

describe('.cedt-grader.json: a link on the workspace folder', () => {
  it('uses the key "." and survives a round trip', () => {
    expect(mappingKey('')).toBe(ROOT_KEY);
    expect(mappingKey('./')).toBe(ROOT_KEY);
    expect(mappingKey('pkg/')).toBe('pkg');
    const d = parseMappingFile(JSON.stringify({ version: 1, files: { '.': { problemId: 7, name: 'x', folder: true, submitFile: 'student.h' }, './': { problemId: 8, name: 'y', folder: true } } }));
    expect(Object.keys(d.files)).toEqual(['.']); // one entry: later spellings win
    expect(lookup(d, ROOT_KEY, BASE)?.problemId).toBe(8);
    expect(parseMappingFile(serializeMappingFile(d))).toEqual(d);
  });
});

describe('what a folder link overrides', () => {
  it('single-file links inside it, for this server, not stale', () => {
    const entries = [E('/w/pkg/a.cpp', 1), E('/w/pkg/sub/b.cpp', 2), E('/w/pkg2/c.cpp', 3), FOLDER('/w/pkg/inner', 4), E('/w/pkg/d.cpp', 5, { baseUrl: 'https://other.example' }), E('/w/pkg/e.cpp', 6, { staleSince: '2026-01-01' }), E('/w/pkg/f.cpp', 7, { baseUrl: BASE })];
    expect(fileLinksInside(entries, '/w/pkg', BASE, false).map((e) => e.entry.problemId)).toEqual([1, 2, 7]);
  });

  it('"not linked" on the folder, inside it and above it, nothing beside it', () => {
    const paths = ['/w/pkg', '/w/pkg/a.cpp', '/w', '/w/pkg2', '/w/other/b.cpp'];
    expect(unlinkedAround(paths, '/w/pkg', false)).toEqual(['/w/pkg', '/w/pkg/a.cpp', '/w']);
  });

  it('a pick applies to a linked folder, never to one only matched by name', () => {
    expect(pickScope({ folderLink: true, folderMatched: false })).toBe('folder');
    expect(pickScope({ folderLink: true, folderMatched: true })).toBe('file');
    expect(pickScope({ folderLink: false, folderMatched: false })).toBe('file');
  });
});

describe('listing a folder', () => {
  const tree = () => {
    const dir = mkdtempSync(join(tmpdir(), 'list-'));
    mkdirSync(join(dir, 'sub', 'deep'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'main.cpp'), '');
    writeFileSync(join(dir, 'sub', 'a.h'), '');
    writeFileSync(join(dir, 'sub', 'deep', 'b.h'), '');
    writeFileSync(join(dir, 'node_modules', 'x', 'c.h'), '');
    return dir;
  };

  it('walks sub-folders with "/" paths and stays out of dependency folders', async () => {
    expect((await listFolderFiles(tree(), 100)).sort()).toEqual(['main.cpp', 'sub/a.h', 'sub/deep/b.h']);
  });

  it('stops at the limit, and a missing folder is empty', async () => {
    expect(await listFolderFiles(tree(), 2)).toHaveLength(2);
    expect(await listFolderFiles('/no/such/folder', 10)).toEqual([]);
  });
});

describe('which link applies to a file', () => {
  const entries = [FOLDER('/w/pkg', 1, 'student.h'), FOLDER('/w/pkg/inner', 2), E('/w/pkg/own.cpp', 3), FOLDER('/w/old', 4, 'a.h'), { ...FOLDER('/w/gone', 5), entry: { ...FOLDER('/w/gone', 5).entry, staleSince: '2026-01-01' } }];

  it('the nearest folder link above the file (stale ones ignored)', () => {
    expect(nearestFolderLink(entries, '/w/pkg/main.cpp', false)?.entry.problemId).toBe(1);
    expect(nearestFolderLink(entries, '/w/pkg/inner/x/y.cpp', false)?.entry.problemId).toBe(2);
    expect(nearestFolderLink(entries, '/w/pkg2/main.cpp', false)).toBeUndefined(); // not a name prefix
    expect(nearestFolderLink(entries, '/w/pkg', false)).toBeUndefined(); // the folder itself
    expect(nearestFolderLink(entries, '/w/gone/a.cpp', false)).toBeUndefined();
  });

  it('isInside / isAtOrInside compare whole path segments', () => {
    expect(isInside('/w/pkg/a.cpp', '/w/pkg', false)).toBe(true);
    expect(isInside('/w/pkg', '/w/pkg', false)).toBe(false);
    expect(isAtOrInside('/w/pkg', '/w/pkg', false)).toBe(true);
    expect(isAtOrInside('/w/pkg2/a.cpp', '/w/pkg', false)).toBe(false);
  });
});

describe('renames and deletes', () => {
  it('a folder rename moves the folder link (its submit file is relative, so it follows)', () => {
    const plan = planRename([FOLDER('/w/student', 1, 'student.h'), E('/w/other.cpp', 2)], '/w/student', '/w/da68_x', false);
    expect(plan).toEqual([{ from: '/w/student', to: '/w/da68_x', entry: { problemId: 1, name: 'p1', folder: true, submitFile: 'student.h' } }]);
  });

  it('the submit file follows a rename inside the folder; moved out → asked again', () => {
    expect(submitFilePath('/w/pkg', 'sub/a.h')).toBe('/w/pkg/sub/a.h');
    expect(submitFilePath('/w/pkg', undefined)).toBeNull();
    expect(submitFileAfterMove('/w/pkg', 'student.h', '/w/pkg/student.h', '/w/pkg/mine.h', false)).toBe('mine.h');
    expect(submitFileAfterMove('/w/pkg', 'sub/a.h', '/w/pkg/sub', '/w/pkg/lib', false)).toBe('lib/a.h');
    expect(submitFileAfterMove('/w/pkg', 'student.h', '/w/pkg/student.h', '/w/elsewhere/student.h', false)).toBeUndefined();
    expect(submitFileAfterMove('/w/pkg', 'student.h', '/w/pkg/main.cpp', '/w/pkg/m.cpp', false)).toBeNull(); // unaffected
  });

  it('deleting the submit file clears it; deleting the folder marks the link stale', () => {
    expect(submitFileDeleted('/w/pkg', 'student.h', '/w/pkg/student.h', false)).toBe(true);
    expect(submitFileDeleted('/w/pkg', 'sub/a.h', '/w/pkg/sub', false)).toBe(true);
    expect(submitFileDeleted('/w/pkg', 'student.h', '/w/pkg/main.cpp', false)).toBe(false);
    expect(submitFileDeleted('/w/pkg', 'student.h', '/w/pkg', false)).toBe(false); // the whole folder: stale link instead
    expect(affectedByDelete([FOLDER('/w/pkg', 1)], '/w/pkg', false)).toHaveLength(1);
  });
});

describe('files for a problem: a folder is one item', () => {
  const base = { problemId: 7, chosen: [] as string[], auto: [] as AutoMatch[], matched: [] as { fsPath: string; how: 'filename' | 'folder' | 'suggested' }[], unlinked: [] as string[], linkedElsewhere: [] as string[], caseInsensitive: false };
  const M = (how: 'filename' | 'folder' | 'suggested', ...paths: string[]) => paths.map((fsPath) => ({ fsPath, how }));

  it('files matched by their folder name collapse into the folder', () => {
    const files = mergeProblemFiles({ ...base, matched: M('folder', '/w/da68_x/main.cpp', '/w/da68_x/student.h', '/w/da68_x/vector.h') });
    expect(files).toEqual([{ fsPath: '/w/da68_x', how: 'folder', folder: true }]);
    expect(linkedNotice(files, '/w/da68_x/main.cpp', (p) => p.replace('/w/', ''))).toBeNull(); // one item: no notice
  });

  it('a chosen folder link covers name matches inside it; a file elsewhere is a second item', () => {
    const files = mergeProblemFiles({ ...base, chosenFolders: ['/w/pkg'], matched: [...M('folder', '/w/pkg/main.cpp'), ...M('filename', '/w/pkg/da68_x.cpp', '/w/old/da68_x.cpp')] });
    expect(files).toEqual([
      { fsPath: '/w/old/da68_x.cpp', how: 'filename' },
      { fsPath: '/w/pkg', how: 'chosen', folder: true },
    ]);
    const n = linkedNotice(files, '/w/pkg/student.h', (p) => p.replace('/w/', ''))!;
    expect(n.files.map((f) => [f.path, f.current])).toEqual([
      ['old/da68_x.cpp', false],
      ['pkg/', true], // the active file is inside the folder
    ]);
  });

  it('"not linked" and links to other problems also block whole folders', () => {
    expect(mergeProblemFiles({ ...base, matched: M('folder', '/w/da68_x/main.cpp'), unlinked: ['/w/da68_x'] })).toEqual([]);
    expect(mergeProblemFiles({ ...base, matched: M('filename', '/w/other/da68_x.cpp'), linkedElsewhere: ['/w/other'] })).toEqual([]);
    // A file's own choice still counts inside a folder linked elsewhere.
    expect(mergeProblemFiles({ ...base, chosen: ['/w/other/mine.cpp'], linkedElsewhere: ['/w/other'] })).toEqual([{ fsPath: '/w/other/mine.cpp', how: 'chosen' }]);
  });

  it('remembered folder auto-matches collapse the same way', () => {
    const a: AutoMatch = { fsPath: '/w/da68_x/main.cpp', problemId: 7, how: 'folder', at: 1 };
    expect(mergeProblemFiles({ ...base, auto: [a] })).toEqual([{ fsPath: '/w/da68_x', how: 'folder', folder: true }]);
  });
});

describe('folder names for problems', () => {
  it('the file-name pattern without .{ext}', () => {
    expect(folderNameFor('da68_m_count_value')).toBe('da68_m_count_value');
    expect(folderNameFor('a/b: c', '{id}_{name}.{ext}', 12)).toBe('12_a_b_ c');
  });
});

describe('headers are C++ (or C)', () => {
  const L = (id: number, name: string, ext: string): Language => ({ id, name, code: ext, ext });
  const C = L(1, 'C', 'c');
  const CPP = L(2, 'C++', 'cpp');
  it('.h → C++, or C when the problem takes C only; .hpp → C++', () => {
    expect(chooseLanguage('student.h', [C, CPP], [C, CPP])).toEqual({ kind: 'match', language: CPP });
    expect(chooseLanguage('student.h', [CPP], [C, CPP])).toEqual({ kind: 'match', language: CPP });
    expect(chooseLanguage('student.h', [C], [C, CPP])).toEqual({ kind: 'match', language: C });
    expect(chooseLanguage('list.hpp', [CPP], [C, CPP])).toEqual({ kind: 'match', language: CPP });
    expect(chooseLanguage('list.hpp', [C], [C, CPP])).toMatchObject({ kind: 'not-allowed', wanted: 'C++' });
  });
});

describe('CPH test cases follow a renamed folder (their file name holds the md5 of the old path)', () => {
  const prob = (src: string) => JSON.stringify({ name: 'x', url: 'u', tests: [{ id: 1, input: '1', output: '2' }], interactive: false, memoryLimit: 1, timeLimit: 1, srcPath: src, group: 'g', local: false });

  it('without a save location: the .cph folder moved along; each .prob is renamed for the new path (.bak kept)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cedt-cphmv-'));
    const oldDir = join(root, 'student');
    const newDir = join(root, 'da68_x');
    mkdirSync(join(oldDir, '.cph'), { recursive: true });
    const oldMain = join(oldDir, 'main.cpp');
    writeFileSync(oldMain, 'int main(){}');
    writeFileSync(cphProbPath(oldMain), prob(oldMain));
    writeFileSync(join(oldDir, '.cph', '.other.cpp_x.prob'), prob('/elsewhere/other.cpp')); // not from this folder
    renameSync(oldDir, newDir);
    const found = await cphFilesAfterFolderRename(oldDir, newDir);
    expect(found.map((f) => [f.oldSrc, f.newSrc])).toEqual([[oldMain, join(newDir, 'main.cpp')]]);
    const r = await moveCphProblem(found[0].oldSrc, found[0].newSrc, undefined, found[0].prob);
    expect(r.status).toBe('moved');
    const moved = JSON.parse(readFileSync(cphProbPath(join(newDir, 'main.cpp')), 'utf8'));
    expect(moved.srcPath).toBe(join(newDir, 'main.cpp'));
    expect(moved.tests).toHaveLength(1);
    expect(existsSync(`${found[0].prob}.bak`)).toBe(true);
    expect(await cphFilesAfterFolderRename(oldDir, newDir)).toEqual([]); // nothing orphaned any more
  });

  it('with a CPH save location: the .prob stayed there and is found by its srcPath', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cedt-cphmv-'));
    const save = join(root, 'cph-store');
    mkdirSync(save);
    const oldMain = join(root, 'pkg', 'main_dense.cpp');
    writeFileSync(cphProbPath(oldMain, save), prob(oldMain));
    const found = await cphFilesAfterFolderRename(join(root, 'pkg'), join(root, 'd57_q1_dense'), save);
    expect(found.map((f) => f.newSrc)).toEqual([join(root, 'd57_q1_dense', 'main_dense.cpp')]);
  });
});
