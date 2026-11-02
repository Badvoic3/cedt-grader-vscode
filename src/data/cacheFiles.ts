import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Downloaded files in the extension's globalStorage (statements, test cases):
 * size limit with least-recently-used eviction, daily cleanup and "Clear
 * Cached Data". No `vscode` import: unit tested directly.
 *
 * "Last used" is the file's mtime: the stores `touch()` a file on every cache
 * hit (atime is unreliable, e.g. on macOS), so no index file is needed.
 * Only the folders in `CACHE_DIRS` under the root are ever touched.
 */
export const CACHE_DIRS = ['statements', 'testcases'] as const;

const TEMP_RE = /\.tmp$/;
const DAY_MS = 86_400_000;

export interface CacheFile {
  path: string;
  bytes: number;
  /** ms since epoch (mtime). */
  lastUsed: number;
  /** Leftover of an interrupted write. */
  temp: boolean;
}

export interface Removed {
  removed: number;
  bytes: number;
}

/** Every file under `<root>/<CACHE_DIRS>` (missing folders are empty). */
export async function scanCache(root: string): Promise<CacheFile[]> {
  const out: CacheFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        try {
          const s = await stat(p);
          out.push({ path: p, bytes: s.size, lastUsed: s.mtimeMs, temp: TEMP_RE.test(e.name) });
        } catch {
          /* removed meanwhile */
        }
      }
    }
  };
  for (const d of CACHE_DIRS) await walk(join(root, d));
  return out;
}

export function totalBytes(files: readonly CacheFile[]): number {
  return files.reduce((n, f) => n + f.bytes, 0);
}

/** Mark a cached file as used now (LRU order). Never throws. */
export async function touch(path: string, now = new Date()): Promise<void> {
  try {
    await utimes(path, now, now);
  } catch {
    /* gone or read-only: it just looks older */
  }
}

/**
 * Write via a temporary file and rename, so a crash never leaves a half
 * written cache file (only a `*.tmp`, removed by the daily cleanup).
 */
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Files to delete so the total is at most `maxBytes`: least recently used
 * first. Files in `keep` (e.g. the one just written) and temporary files
 * (possibly being written right now) are never picked.
 */
export function pickLru(files: readonly CacheFile[], maxBytes: number, keep: ReadonlySet<string> = new Set()): CacheFile[] {
  let total = totalBytes(files);
  if (total <= maxBytes) return [];
  const candidates = files.filter((f) => !f.temp && !keep.has(f.path)).sort((a, b) => a.lastUsed - b.lastUsed || a.path.localeCompare(b.path));
  const out: CacheFile[] = [];
  for (const f of candidates) {
    if (total <= maxBytes) break;
    out.push(f);
    total -= f.bytes;
  }
  return out;
}

/** Files not used for `unusedDays`, and temporary files older than `tempDays`. */
export function pickExpired(files: readonly CacheFile[], now: number, unusedDays: number, tempDays: number): CacheFile[] {
  return files.filter((f) => now - f.lastUsed > (f.temp ? tempDays : unusedDays) * DAY_MS);
}

export async function removeFiles(files: readonly CacheFile[]): Promise<Removed> {
  let removed = 0;
  let bytes = 0;
  for (const f of files) {
    try {
      await rm(f.path, { force: true });
      removed++;
      bytes += f.bytes;
    } catch {
      /* in use / permissions: try again next time */
    }
  }
  return { removed, bytes };
}

/** Delete least recently used files until the cache fits `maxBytes`. */
export async function enforceLimit(root: string, maxBytes: number, keep: readonly string[] = []): Promise<Removed> {
  return removeFiles(pickLru(await scanCache(root), maxBytes, new Set(keep)));
}

/** Daily: remove expired and leftover temporary files, then enforce the size limit. */
export async function cleanupCache(
  root: string,
  opts: { now: number; maxBytes: number; unusedDays: number; tempDays: number },
): Promise<Removed> {
  const files = await scanCache(root);
  const old = pickExpired(files, opts.now, opts.unusedDays, opts.tempDays);
  const a = await removeFiles(old);
  const gone = new Set(old.map((f) => f.path));
  const b = await removeFiles(pickLru(files.filter((f) => !gone.has(f.path)), opts.maxBytes));
  return { removed: a.removed + b.removed, bytes: a.bytes + b.bytes };
}

/** "Clear Cached Data": every downloaded file (only the `CACHE_DIRS` folders). */
export async function clearCacheFiles(root: string): Promise<Removed> {
  const files = await scanCache(root);
  const r = await removeFiles(files);
  for (const d of CACHE_DIRS) await rm(join(root, d), { recursive: true, force: true }).catch(() => {});
  return r;
}

/** Problem ids that still have a cached statement (any server). */
export function statementIds(files: readonly CacheFile[]): Set<number> {
  const out = new Set<number>();
  for (const f of files) {
    const m = /[\\/]statements[\\/][^\\/]+[\\/](\d+)\.(?:pdf|json)$/.exec(f.path);
    if (m) out.add(Number(m[1]));
  }
  return out;
}

/** "12.3 MB", "640 KB", "0 B". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
