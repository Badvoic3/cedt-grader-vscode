import { STALE_LINK_DAYS } from '../shared/constants';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, relative } from 'node:path';
import { isAtOrInside, isInside, pathKey, remapPath } from './paths';
import { cphProbPath, type CphProblem } from './cph';
import type { MappingEntry } from './mappingFile';

/**
 * Pure helpers for keeping file → problem mappings correct when files move
 * (no `vscode` import; unit tested). The store applies the results.
 */
export interface LocatedEntry {
  /** Absolute path of the mapped source file. */
  fsPath: string;
  entry: MappingEntry;
}

export const STALE_DAYS = STALE_LINK_DAYS;

export { remapPath } from './paths';

/** Mappings to move for one rename (file or folder). The entry (how it was chosen) is kept; staleness is cleared. */
export function planRename(entries: LocatedEntry[], oldPath: string, newPath: string, caseInsensitive?: boolean): { from: string; to: string; entry: MappingEntry }[] {
  const out: { from: string; to: string; entry: MappingEntry }[] = [];
  for (const e of entries) {
    const to = remapPath(e.fsPath, oldPath, newPath, caseInsensitive);
    if (to !== null) {
      const { staleSince: _drop, ...entry } = e.entry;
      out.push({ from: e.fsPath, to, entry });
    }
  }
  return out;
}

/**
 * Folder mode: the folder link a file belongs to, i.e. the nearest folder
 * entry above it (non-stale). A file's own entry is checked by the caller first.
 */
export function nearestFolderLink(entries: LocatedEntry[], fsPath: string, caseInsensitive?: boolean): LocatedEntry | undefined {
  let best: LocatedEntry | undefined;
  for (const e of entries) {
    if (!e.entry.folder || e.entry.staleSince || !isInside(fsPath, e.fsPath, caseInsensitive)) continue;
    if (!best || e.fsPath.length > best.fsPath.length) best = e;
  }
  return best;
}

/** Absolute path of a folder link's submit file (null when not chosen yet). */
export function submitFilePath(folderPath: string, submitFile: string | undefined): string | null {
  if (!submitFile) return null;
  const joiner = folderPath.includes('\\') && !folderPath.includes('/') ? '\\' : '/';
  return `${folderPath.replace(/[\\/]+$/, '')}${joiner}${submitFile.split('/').join(joiner)}`;
}

/**
 * A folder link's submit file after `oldPath` (a file or folder) moved to
 * `newPath`: the new relative path, `undefined` when it left the folder (asked
 * again on the next submit), or null when unaffected.
 */
export function submitFileAfterMove(folderPath: string, submitFile: string | undefined, oldPath: string, newPath: string, caseInsensitive?: boolean): string | undefined | null {
  const abs = submitFilePath(folderPath, submitFile);
  if (!abs) return null;
  const moved = remapPath(abs, oldPath, newPath, caseInsensitive);
  if (moved === null) return null;
  if (!isInside(moved, folderPath, caseInsensitive)) return undefined;
  return relative(folderPath, moved).split(/[\\/]/).join('/');
}

/** Was a folder link's submit file deleted (itself or a folder above it, inside the linked folder)? */
export function submitFileDeleted(folderPath: string, submitFile: string | undefined, deletedPath: string, caseInsensitive?: boolean): boolean {
  const abs = submitFilePath(folderPath, submitFile);
  return !!abs && isAtOrInside(abs, deletedPath, caseInsensitive) && !isAtOrInside(folderPath, deletedPath, caseInsensitive);
}

/** Entries affected by deleting `deletedPath` (a file or a folder). */
export function affectedByDelete(entries: LocatedEntry[], deletedPath: string, caseInsensitive?: boolean): LocatedEntry[] {
  return entries.filter((e) => remapPath(e.fsPath, deletedPath, deletedPath, caseInsensitive) !== null && !e.entry.staleSince);
}

/** Stale mappings older than `days` (to remove). */
export function expired(entries: LocatedEntry[], now: Date, days = STALE_DAYS): LocatedEntry[] {
  const limit = now.getTime() - days * 86_400_000; // days → ms
  return entries.filter((e) => e.entry.staleSince && Date.parse(e.entry.staleSince) < limit);
}

/**
 * Saved mappings that probably belong to `newPath` after a move outside VS
 * Code: same file name, and the mapped file no longer exists. `exists` is
 * only called for those same-name candidates (no workspace scan).
 */
export async function reconnectCandidates(
  entries: LocatedEntry[],
  newPath: string,
  exists: (p: string) => Promise<boolean>,
  dismissed: Set<string> = new Set(),
): Promise<LocatedEntry[]> {
  const name = pathKey(basename(newPath));
  const out: LocatedEntry[] = [];
  for (const e of entries) {
    if (pathKey(e.fsPath) === pathKey(newPath) || pathKey(basename(e.fsPath)) !== name) continue;
    if (dismissed.has(dismissKey(e.fsPath, newPath))) continue;
    if (!(await exists(e.fsPath))) out.push(e);
  }
  return out;
}

export const dismissKey = (oldPath: string, newPath: string) => `${oldPath}\u0000${newPath}`;

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * CPH names its file after the full source path (`.<basename>_<md5(path)>.prob`)
 * and does not follow renames, so the tests of a renamed file are orphaned.
 * Copy them to the name CPH expects for the new path (srcPath updated; `url`
 * too when it held the old path, as for CPH's local problems) and keep the old
 * file as `.bak`. Never overwrites an existing .prob of the new path.
 */
export async function moveCphProblem(
  oldSrc: string,
  newSrc: string,
  saveLocation?: string,
): Promise<{ status: 'moved' | 'none' | 'target-exists'; from: string; to: string; backup?: string }> {
  const from = cphProbPath(oldSrc, saveLocation);
  const to = cphProbPath(newSrc, saveLocation);
  if (!(await pathExists(from))) return { status: 'none', from, to };
  if (await pathExists(to)) return { status: 'target-exists', from, to };
  const p = JSON.parse(await readFile(from, 'utf8')) as CphProblem;
  const moved: CphProblem = { ...p, srcPath: newSrc, ...(p.url === oldSrc ? { url: newSrc } : {}) };
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, JSON.stringify(moved));
  const backup = `${from}.bak`;
  await rename(from, backup); // the old file is kept as a backup
  return { status: 'moved', from, to, backup };
}
