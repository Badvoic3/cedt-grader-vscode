import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import { ATTACHMENT } from '../shared/constants';
import { S } from '../shared/strings';
import { BINARY_EXTS } from './findByName';
import { pathKey } from './paths';
import { comparePaths } from './problemFiles';
import { pathExists } from './newFile';
import { invalidFileName } from './renameToProblem';

/**
 * Problem attachments (the website's "File" link): a single file, or a zip
 * package extracted into a new folder. Pure helpers plus the no-overwrite
 * writer (no `vscode` import; unit tested).
 *
 * Extraction safety: paths are checked before anything is written (no
 * absolute paths, drive letters, ".." or reserved characters; no two entries
 * for the same path), entry count and total size are capped on the declared
 * sizes before inflating and again on the real output, entries are always
 * written as plain files (never links), and nothing existing is overwritten.
 */

export class AttachmentError extends Error {}

export type AttachmentKind = 'zip' | 'file';

/** A zip when the name or type says so and the bytes are a zip (local file header). */
export function attachmentKind(filename: string | null, contentType: string | null, bytes: Uint8Array): AttachmentKind {
  const saysZip = /\.zip$/i.test(filename ?? '') || /^application\/(x-)?zip(-compressed)?$/i.test(contentType ?? '');
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  return saysZip && isZip ? 'zip' : 'file';
}

export interface ZipPlan {
  /** Relative paths ("/" separators, NFC) with their contents, the shared top folder already removed. */
  files: { rel: string; data: Uint8Array }[];
  /** The single top-level folder every entry was in (removed from `files`), if any. */
  topFolder: string | null;
}

/** macOS metadata that zips made in Finder carry along, and shipped build output (`main.o`; a PDF is kept). */
function isJunk(segs: string[]): boolean {
  const last = segs[segs.length - 1];
  const ext = extname(last).slice(1).toLowerCase();
  return segs[0] === '__MACOSX' || last === '.DS_Store' || last.startsWith('._') || (ext !== 'pdf' && BINARY_EXTS.has(ext));
}

/** A compiled program without an extension (ELF, Mach-O, PE): shipped build output, never extracted. */
export function isExecutable(data: Uint8Array): boolean {
  const b = (i: number) => data[i] ?? -1;
  if (b(0) === 0x7f && b(1) === 0x45 && b(2) === 0x4c && b(3) === 0x46) return true; // ELF
  if (b(0) === 0x4d && b(1) === 0x5a) return true; // MZ (Windows)
  const magic = ((b(0) << 24) | (b(1) << 16) | (b(2) << 8) | b(3)) >>> 0;
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic); // Mach-O / universal
}

/** A safe relative path for a zip entry, or why not. Directory entries (trailing "/") give ''. */
export function entryPath(name: string): string {
  const raw = name.normalize('NFC').replace(/\\/g, '/');
  if (raw.endsWith('/')) return '';
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw new AttachmentError(S.attachment.unsafePath(name));
  const segs = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (!segs.length) return '';
  for (const s of segs) if (s === '..' || invalidFileName(s)) throw new AttachmentError(S.attachment.unsafePath(name));
  return segs.join('/');
}

/** Read a zip into memory after checking every path and the size caps. Throws AttachmentError. */
export function planZip(bytes: Uint8Array, limits: { maxEntries: number; maxTotalBytes: number } = ATTACHMENT): ZipPlan {
  const seen = new Set<string>();
  const order: string[] = [];
  let count = 0;
  let declared = 0;
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes, {
      filter: (f) => {
        const rel = entryPath(f.name);
        if (!rel || isJunk(rel.split('/'))) return false;
        const key = pathKey(rel);
        if (seen.has(key)) throw new AttachmentError(S.attachment.duplicate(rel));
        seen.add(key);
        if (++count > limits.maxEntries) throw new AttachmentError(S.attachment.tooManyFiles(limits.maxEntries));
        declared += f.originalSize;
        if (declared > limits.maxTotalBytes) throw new AttachmentError(S.attachment.tooBig(Math.round(limits.maxTotalBytes / 1048576)));
        order.push(f.name);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof AttachmentError) throw e;
    throw new AttachmentError(S.attachment.unreadable(e instanceof Error ? e.message : String(e)));
  }
  let total = 0;
  const files = order
    .map((name) => {
      const data = unzipped[name];
      if (!data) throw new AttachmentError(S.attachment.unreadable(name));
      total += data.length;
      if (total > limits.maxTotalBytes) throw new AttachmentError(S.attachment.tooBig(Math.round(limits.maxTotalBytes / 1048576)));
      return { rel: entryPath(name), data };
    })
    .filter((f) => extname(f.rel) || !isExecutable(f.data));
  if (!files.length) throw new AttachmentError(S.attachment.empty);
  // One shared top-level folder ("student/main.cpp", "student/student.h") is removed.
  const tops = new Set(files.map((f) => (f.rel.includes('/') ? f.rel.split('/')[0] : '')));
  let topFolder: string | null = null;
  if (tops.size === 1 && !tops.has('')) {
    topFolder = [...tops][0];
    for (const f of files) f.rel = f.rel.slice(topFolder.length + 1);
  }
  files.sort((a, b) => comparePaths(a.rel, b.rel));
  return { files, topFolder };
}

/** Files a folder can submit: source extensions only (no project files, binaries or PDFs), in path order. */
export function submitCandidates(rels: string[], sourceExts: string[]): string[] {
  const exts = new Set(sourceExts.map((e) => e.toLowerCase().replace(/^\./, '')));
  return rels
    .filter((r) => {
      const e = extname(r).slice(1).toLowerCase();
      return e && exts.has(e) && !BINARY_EXTS.has(e);
    })
    .sort(comparePaths);
}

/** The file to open after extracting: the one with `int main`, else the first source file. */
export function fileToOpen(files: { rel: string; data: Uint8Array }[], candidates: string[]): string | null {
  const withMain = candidates.find((c) => /\bint\s+main\s*\(/.test(new TextDecoder().decode(files.find((f) => f.rel === c)?.data ?? new Uint8Array())));
  return withMain ?? candidates[0] ?? null;
}

/** "<name>", "<name>_2", "<name>_3", … : the first folder name that doesn't exist. */
export async function freeFolderName(desired: string, exists: (name: string) => boolean | Promise<boolean>): Promise<string> {
  if (!(await exists(desired))) return desired;
  for (let i = 2; i < 1000; i++) if (!(await exists(`${desired}_${i}`))) return `${desired}_${i}`;
  throw new AttachmentError(S.attachment.noFreeName(desired));
}

/**
 * Write the planned files into a NEW folder `dir` (created here, fails if it
 * exists). Every file is created with `wx` and must stay inside `dir`.
 */
export async function writeExtracted(dir: string, files: { rel: string; data: Uint8Array }[]): Promise<void> {
  if (await pathExists(dir)) throw new AttachmentError(S.attachment.exists(dir));
  await mkdir(dir);
  const root = resolve(dir);
  for (const f of files) {
    const target = resolve(join(root, ...f.rel.split('/')));
    const rel = relative(root, target);
    if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) throw new AttachmentError(S.attachment.unsafePath(f.rel));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.data, { flag: 'wx' });
  }
}

/** Write a single downloaded file; never overwrites (`wx`). */
export async function writeNewFile(path: string, data: Uint8Array): Promise<void> {
  await writeFile(path, data, { flag: 'wx' });
}
