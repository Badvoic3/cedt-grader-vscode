/**
 * Problem attachments (the website's "File"): Content-Disposition parsing,
 * the client call on the fake grader, request discipline, and safe zip
 * extraction (paths, caps, single top folder, never overwrite).
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { DataService } from '../src/data/dataService';
import { GraderClient, GraderError, parseContentDisposition } from '../src/grader';
import { attachmentKind, AttachmentError, entryPath, extractedFileToOpen, fileToOpen, freeFolderName, ownFolderStem, planZip, submitCandidates, writeExtracted, writeNewFile } from '../src/mapping/attachment';
import { ATTACHMENT } from '../src/shared/constants';
import { FakeGrader } from './fakeServer';

const zip = (files: Record<string, string>): Uint8Array => {
  const z: Zippable = {};
  for (const [k, v] of Object.entries(files)) z[k] = strToU8(v);
  return zipSync(z);
};

/** A package like the course zips: main.cpp (driver) + headers, optionally in one top folder, with macOS junk. */
const PACKAGE = {
  'student/main.cpp': '#include "student.h"\nint main() { return 0; }\n',
  'student/student.h': '// write your code here\n',
  'student/vector.h': '#pragma once\n',
  'student/student.cbp': '<CodeBlocks_project_file/>',
  '__MACOSX/student/._main.cpp': 'junk',
  'student/.DS_Store': 'junk',
};

describe('Content-Disposition file name', () => {
  it('prefers filename* (UTF-8, percent-encoded), then filename="…"', () => {
    expect(parseContentDisposition(`attachment; filename="TEMPLATE Project 2569 %2870-%29.dig"; filename*=UTF-8''TEMPLATE%20Project%202569%20%2870-%29.dig`)).toBe('TEMPLATE Project 2569 (70-).dig');
    expect(parseContentDisposition('attachment; filename="student.zip"')).toBe('student.zip');
    expect(parseContentDisposition('attachment; filename=plain.cpp')).toBe('plain.cpp');
    expect(parseContentDisposition(`attachment; filename*=UTF-8''%E0%B9%82%E0%B8%88%E0%B8%97%E0%B8%A2%E0%B9%8C.cpp`)).toBe('โจทย์.cpp');
  });

  it('drops folders and refuses unusable names', () => {
    expect(parseContentDisposition('attachment; filename="../../etc/passwd"')).toBe('passwd');
    expect(parseContentDisposition('attachment; filename=C:\\x\\a.cpp')).toBe('a.cpp');
    expect(parseContentDisposition('attachment; filename=".."')).toBeNull();
    expect(parseContentDisposition('attachment; filename="a?b.cpp"')).toBeNull();
    expect(parseContentDisposition('attachment')).toBeNull();
    expect(parseContentDisposition(null)).toBeNull();
  });
});

function setup() {
  const server = new FakeGrader();
  const client = new GraderClient({ baseUrl: 'https://grader.test', getStoredCredentials: async () => ({ username: 'student', password: 'pw' }), fetch: server.fetch, sleep: async () => {} });
  return { server, client };
}

describe('GraderClient.getAttachment (GET /api/v1/problems/{id}/files/attachment)', () => {
  it('returns the bytes, the file name and the type (JWT, no web session)', async () => {
    const { server, client } = setup();
    await client.login({ username: 'student', password: 'pw' });
    server.attachment = { bytes: zip({ 'main.cpp': 'x' }), type: 'application/zip', disposition: `attachment; filename="student.zip"; filename*=UTF-8''student.zip` };
    const a = await client.getAttachment(201);
    expect(a.status).toBe(200);
    if (a.status !== 200) return;
    expect(a.filename).toBe('student.zip');
    expect(a.contentType).toBe('application/zip');
    expect(attachmentKind(a.filename, a.contentType, a.bytes)).toBe('zip');
    const req = server.requests.at(-1)!;
    expect(req.path).toBe('/api/v1/problems/201/files/attachment');
    expect(req.headers.Authorization).toMatch(/^Bearer /);
  });

  it('404 / 403 are statuses (no attachment, or not open to you), not errors', async () => {
    const { server, client } = setup();
    await client.login({ username: 'student', password: 'pw' });
    expect(await client.getAttachment(201)).toEqual({ status: 404, error: 'Attachment not found' });
    server.unavailable.set(204, 403);
    expect((await client.getAttachment(204)).status).toBe(403);
  });

  it('refuses a download over the size cap', async () => {
    const { server, client } = setup();
    await client.login({ username: 'student', password: 'pw' });
    server.attachment = { bytes: new Uint8Array(ATTACHMENT.maxDownloadBytes + 1), type: 'application/octet-stream', disposition: 'attachment; filename="big.bin"' };
    await expect(client.getAttachment(201)).rejects.toBeInstanceOf(GraderError);
  });
});

describe('request discipline: attachments only on click', () => {
  it('one GET per click, a double click shares it, nothing on list / history loads', async () => {
    const { server, client } = setup();
    await client.login({ username: 'student', password: 'pw' });
    const log: string[] = [];
    const data = new DataService({ client: () => client, canFetch: () => true, log: (l) => log.push(l) });
    data.setVisible(true);
    server.attachment = { bytes: strToU8('int main(){}'), type: 'text/x-c++src', disposition: 'attachment; filename="t.cpp"' };
    const count = () => server.count('GET', /\/files\/attachment$/);
    await data.loadProblems();
    await data.loadHistory(201);
    expect(count()).toBe(0);
    const all = () => server.count('GET', /./) + server.count('POST', /./);
    const before = all();
    const [a, b] = await Promise.all([data.downloadAttachment(201), data.downloadAttachment(201)]);
    expect(a).toBe(b);
    expect(count()).toBe(1);
    expect(all()).toBe(before + 1); // nothing else (no list, history or login request)
    expect(log.some((l) => l.includes('dedup') && l.includes('attachment:201'))).toBe(true);
    expect(data.isDownloading(201)).toBe(false);
    await data.downloadAttachment(201); // never cached: a new click downloads again
    expect(count()).toBe(2);
  });
});

describe('kind', () => {
  it('a zip needs both the name/type and the bytes', () => {
    const z = zip({ 'a.cpp': 'x' });
    expect(attachmentKind('student.zip', 'application/zip', z)).toBe('zip');
    expect(attachmentKind(null, 'application/x-zip-compressed', z)).toBe('zip');
    expect(attachmentKind('notes.zip', 'application/zip', strToU8('not a zip'))).toBe('file');
    expect(attachmentKind('Template.dig', 'application/xml', strToU8('<circuit/>'))).toBe('file');
    expect(attachmentKind('a.cpp', 'text/x-c++src', z)).toBe('file'); // zip bytes but nothing says zip
  });
});

describe('planZip: checked before anything is written', () => {
  it('skips macOS junk and directory entries, strips one top folder', () => {
    const plan = planZip(zip(PACKAGE));
    expect(plan.topFolder).toBe('student');
    expect(plan.files.map((f) => f.rel)).toEqual(['main.cpp', 'student.cbp', 'student.h', 'vector.h']);
  });

  it('keeps the layout when there are two top-level entries', () => {
    const plan = planZip(zip({ 'main.cpp': 'x', 'lib/list.h': 'y' }));
    expect(plan.topFolder).toBeNull();
    expect(plan.files.map((f) => f.rel)).toEqual(['lib/list.h', 'main.cpp']);
  });

  it('rejects path traversal, absolute paths and drive letters', () => {
    expect(() => entryPath('../x.cpp')).toThrow(AttachmentError);
    expect(() => entryPath('a/../../b.cpp')).toThrow(AttachmentError);
    expect(() => entryPath('/etc/passwd')).toThrow(AttachmentError);
    expect(() => entryPath('C:\\x\\a.cpp')).toThrow(AttachmentError);
    expect(() => entryPath('a\\..\\..\\b')).toThrow(AttachmentError);
    expect(() => entryPath('bad:name.cpp')).toThrow(AttachmentError);
    expect(entryPath('dir/')).toBe('');
    expect(entryPath('./a/./b.cpp')).toBe('a/b.cpp');
    expect(() => planZip(zip({ 'ok.cpp': 'x', '../evil.cpp': 'y' }))).toThrow(AttachmentError);
  });

  it('rejects the same path twice (case / Unicode spelling)', () => {
    const z = zipSync({ 'a/Main.cpp': strToU8('1'), 'a/main.cpp': strToU8('2') });
    const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';
    if (caseInsensitive) expect(() => planZip(z)).toThrow(/twice/);
    const nfd = zipSync({ ['\u0e42\u0e08\u0e17\u0e22\u0e4c.cpp'.normalize('NFD')]: strToU8('1'), ['\u0e42\u0e08\u0e17\u0e22\u0e4c.cpp'.normalize('NFC') + '/']: new Uint8Array() });
    expect(planZip(nfd).files).toHaveLength(1);
  });

  it('caps the number of files and the total size (declared and real)', () => {
    expect(() => planZip(zip({ 'a.cpp': 'x', 'b.cpp': 'y', 'c.cpp': 'z' }), { maxEntries: 2, maxTotalBytes: 1000 })).toThrow(/more than 2 files/);
    const big = zipSync({ 'big.txt': new Uint8Array(5000) }); // compresses to a few bytes: a tiny zip bomb
    expect(big.length).toBeLessThan(200);
    expect(() => planZip(big, { maxEntries: 10, maxTotalBytes: 4000 })).toThrow(AttachmentError);
  });

  it('unreadable or empty zips are refused with a reason', () => {
    expect(() => planZip(strToU8('PK\u0003\u0004 broken'))).toThrow(AttachmentError);
    expect(() => planZip(zip({ '__MACOSX/._x': 'junk' }))).toThrow(/no files/);
  });
});

describe('folder contents', () => {
  it('submit candidates are source files only, in path order', () => {
    const exts = ['cpp', 'h', 'c', 'py'];
    expect(submitCandidates(['student.cbp', 'main.cpp', 'student.h', 'main.o', 'notes.pdf', 'sub/x.h', 'main'], exts)).toEqual(['main.cpp', 'student.h', 'sub/x.h']);
  });

  it('opens the file with int main first', () => {
    const files = [
      { rel: 'student.h', data: strToU8('// your code') },
      { rel: 'main_dense.cpp', data: strToU8('int main() {}') },
    ];
    expect(fileToOpen(files, ['main_dense.cpp', 'student.h'])).toBe('main_dense.cpp');
    expect(fileToOpen(files.slice(0, 1), ['student.h'])).toBe('student.h');
    expect(fileToOpen([], [])).toBeNull();
  });
});

describe('writing: a new folder, never overwriting', () => {
  it('extracts into a new folder only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedt-att-'));
    const plan = planZip(zip(PACKAGE));
    await writeExtracted(join(dir, 'pkg'), plan.files);
    expect(readdirSync(join(dir, 'pkg')).sort()).toEqual(['main.cpp', 'student.cbp', 'student.h', 'vector.h']);
    expect(readFileSync(join(dir, 'pkg', 'student.h'), 'utf8')).toBe('// write your code here\n');
    await expect(writeExtracted(join(dir, 'pkg'), plan.files)).rejects.toBeInstanceOf(AttachmentError);
  });

  it('free folder names get _2, _3; single files are written with wx', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedt-att-'));
    mkdirSync(join(dir, 'da_x'));
    mkdirSync(join(dir, 'da_x_2'));
    const exists = (n: string) => readdirSync(dir).includes(n);
    expect(await freeFolderName('da_x', exists)).toBe('da_x_3');
    expect(await freeFolderName('new', exists)).toBe('new');
    writeFileSync(join(dir, 'a.dig'), 'mine');
    await expect(writeNewFile(join(dir, 'a.dig'), strToU8('theirs'))).rejects.toThrow();
    expect(readFileSync(join(dir, 'a.dig'), 'utf8')).toBe('mine');
  });
});

describe('after extracting', () => {
  const f = (rel: string, text: string) => ({ rel, data: strToU8(text) });

  it('opens the detected submit file, else the run file, else the int main file', () => {
    const pkg = [f('main.cpp', '#include "student.h"\nint main() {}\n'), f('student.h', '// your code here'), f('readme.txt', '')];
    expect(extractedFileToOpen(pkg, ['cpp', 'h'])).toBe('student.h');
    expect(extractedFileToOpen([f('main.cpp', 'int main() {}'), f('util.cpp', '')], ['cpp'])).toBe('main.cpp');
    expect(extractedFileToOpen([f('a.py', ''), f('b.py', '')], ['py'])).toBe('a.py');
    expect(extractedFileToOpen([f('notes.txt', '')], ['cpp'])).toBeNull();
  });

  it('own folder name: the top folder, else the zip name; reserved characters replaced', () => {
    expect(ownFolderStem('pkg', 'x.zip')).toBe('pkg');
    expect(ownFolderStem(null, 'Lab 1.ZIP')).toBe('Lab 1');
    expect(ownFolderStem(null, 'a:b?.zip')).toBe('a_b_');
    expect(ownFolderStem(null, null)).toBe('attachment');
    expect(ownFolderStem(null, '.zip')).toBe('attachment');
  });
});
