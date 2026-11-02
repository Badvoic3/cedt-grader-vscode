import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, sep } from 'node:path';
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

export const STALE_DAYS = 30;

/** New path for `p` when `oldPath` (a file, or a folder containing it) moved to `newPath`; null if unaffected. */
export function remapPath(p: string, oldPath: string, newPath: string, separator = sep): string | null {
  if (p === oldPath) return newPath;
  const prefix = oldPath.endsWith(separator) ? oldPath : oldPath + separator;
  return p.startsWith(prefix) ? newPath + p.slice(oldPath.length) : null;
}

/** Mappings to move for one rename (file or folder). The entry (how it was chosen) is kept; staleness is cleared. */
export function planRename(entries: LocatedEntry[], oldPath: string, newPath: string, separator = sep): { from: string; to: string; entry: MappingEntry }[] {
  const out: { from: string; to: string; entry: MappingEntry }[] = [];
  for (const e of entries) {
    const to = remapPath(e.fsPath, oldPath, newPath, separator);
    if (to !== null) {
      const { staleSince: _drop, ...entry } = e.entry;
      out.push({ from: e.fsPath, to, entry });
    }
  }
  return out;
}

/** Entries affected by deleting `deletedPath` (a file or a folder). */
export function affectedByDelete(entries: LocatedEntry[], deletedPath: string, separator = sep): LocatedEntry[] {
  return entries.filter((e) => remapPath(e.fsPath, deletedPath, deletedPath, separator) !== null && !e.entry.staleSince);
}

/** Stale mappings older than `days` (to remove). */
export function expired(entries: LocatedEntry[], now: Date, days = STALE_DAYS): LocatedEntry[] {
  const limit = now.getTime() - days * 86_400_000;
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
  const name = basename(newPath);
  const out: LocatedEntry[] = [];
  for (const e of entries) {
    if (e.fsPath === newPath || basename(e.fsPath) !== name) continue;
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
): Promise<{ status: 'moved' | 'none' | 'target-exists'; from: string; to: string }> {
  const from = cphProbPath(oldSrc, saveLocation);
  const to = cphProbPath(newSrc, saveLocation);
  if (!(await pathExists(from))) return { status: 'none', from, to };
  if (await pathExists(to)) return { status: 'target-exists', from, to };
  const p = JSON.parse(await readFile(from, 'utf8')) as CphProblem;
  const moved: CphProblem = { ...p, srcPath: newSrc, ...(p.url === oldSrc ? { url: newSrc } : {}) };
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, JSON.stringify(moved));
  await rename(from, `${from}.bak`); // the old file is kept as a backup
  return { status: 'moved', from, to };
}
