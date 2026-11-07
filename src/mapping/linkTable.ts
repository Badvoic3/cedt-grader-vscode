import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from '../data/cacheFiles';
import { LIMITS } from '../shared/constants';
import { isAtOrInside, normalizeAbsPath, pathKey } from './paths';

/**
 * Every file → problem link, in one table by full path:
 * `<globalStorage>/links/links.json` (no `vscode` import). One table, so a link
 * holds whichever folder is open, and a moved folder can reconnect.
 *
 * The folder is outside `CACHE_DIRS`: these are the user's choices, not a cache.
 * Another window can write the file too, so `read` notices a change on disk and
 * `change` holds a lock file while it patches what is there.
 */
export interface MappingEntry {
  problemId: number;
  /** Problem short name at the time of mapping. */
  name: string;
  baseUrl?: string;
  /** Set when the mapped file was deleted / went missing; removed after 30 days (see mappingOps). */
  staleSince?: string;
  /**
   * Folder mode: the path is a folder and every file inside it belongs to the
   * problem (a file's own link still wins). Submit sends `submitFile` only.
   */
  folder?: true;
  /**
   * Folder mode, the user's choices (relative to the folder, "/" separators):
   * the file Submit sends, and the program the runner runs.
   * Missing → detected (src/mapping/folderRoles.ts), asked only when that fails.
   */
  submitFile?: string;
  runFile?: string;
}

export interface StoredLink extends MappingEntry {
  /** Absolute path of the linked file or folder. */
  fsPath: string;
  /** Saved while the path was outside every workspace folder: shown in every window. */
  outside?: true;
}

/** By `pathKey(fsPath)`. */
export type Links = Record<string, StoredLink>;

export const LINKS_DIR = 'links';
export const LINKS_FILE = 'links.json';
/** Beside the folder, so taking it creates nothing when a change turns out to change nothing. */
const LOCK_FILE = 'links.lock';
const LOCK_RETRY_MS = 20;

function validLink(v: unknown): v is StoredLink {
  const e = v as Partial<StoredLink> | null;
  return !!e && typeof e.fsPath === 'string' && !!e.fsPath && typeof e.name === 'string' && Number.isInteger(e.problemId) && (e.problemId as number) > 0;
}

/** Text from disk → links, without the entries that make no sense; null when the file as a whole can't be used. */
export function parseLinks(text: string): Links | null {
  try {
    const raw = JSON.parse(text) as { version?: unknown; links?: unknown } | null;
    if (raw?.version !== 1 || !raw.links || typeof raw.links !== 'object') return null;
    const out: Links = {};
    for (const e of Object.values(raw.links)) if (validLink(e)) out[pathKey(e.fsPath)] = e;
    return out;
  } catch {
    return null;
  }
}

export function serializeLinks(links: Links): string {
  const sorted: Links = {};
  for (const k of Object.keys(links).sort()) sorted[k] = links[k];
  return JSON.stringify({ version: 1, links: sorted }, null, 1);
}

/** Does a link belong to this window: inside an open folder, or saved outside every folder? */
export function inScope(link: StoredLink, folders: readonly string[]): boolean {
  return !!link.outside || folders.some((f) => isAtOrInside(link.fsPath, f));
}

/** Add the links that have no entry yet (an existing link always wins). Returns how many were added. */
export function addMissing(links: Links, incoming: readonly StoredLink[]): number {
  let added = 0;
  for (const e of incoming) {
    const k = pathKey(e.fsPath);
    if (links[k]) continue;
    links[k] = { ...e, fsPath: normalizeAbsPath(e.fsPath) };
    added++;
  }
  return added;
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

export class LinkTable {
  private readonly root: string;
  private readonly path: string;
  private memo: { stamp: string; links: Links; unusable: boolean } | undefined;
  /** The last write, so writes from this window wait their turn without touching the lock. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.root = root;
    this.path = join(root, LINKS_DIR, LINKS_FILE);
  }

  /** The file's identity on disk: every write replaces it, so its inode changes too. */
  private async stamp(): Promise<string> {
    try {
      const s = await stat(this.path);
      return `${s.ino}:${s.mtimeMs}:${s.size}`;
    } catch (err) {
      if (isMissing(err)) return 'none';
      throw err;
    }
  }

  /** Throws when the file can't be read now: that says nothing about what is in it. */
  private async load(): Promise<{ links: Links; unusable: boolean }> {
    const stamp = await this.stamp();
    if (this.memo?.stamp === stamp) return this.memo;
    const text = stamp === 'none' ? null : await readFile(this.path, 'utf8').catch((err) => {
      if (isMissing(err)) return null;
      throw err;
    });
    const links = text === null ? {} : parseLinks(text);
    this.memo = { stamp, links: links ?? {}, unusable: links === null };
    return this.memo;
  }

  /** The current links, or the last ones seen while the file can't be read. Don't change the result: use `change`. */
  async read(): Promise<Readonly<Links>> {
    await this.queue.catch(() => {});
    return this.load().then((now) => now.links, () => this.memo?.links ?? {});
  }

  /** Only one window at a time reads, patches and writes. A lock older than any write was left by a crash. */
  private async lock(): Promise<() => Promise<void>> {
    const path = join(this.root, LOCK_FILE);
    await mkdir(this.root, { recursive: true });
    const giveUp = Date.now() + LIMITS.linkLockWaitMs;
    for (;;) {
      try {
        await (await open(path, 'wx')).close();
        return () => rm(path, { force: true });
      } catch (err) {
        // Windows answers EPERM while the other window's lock is being removed.
        if (Date.now() > giveUp || !['EEXIST', 'EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      }
      const age = await stat(path).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > LIMITS.linkLockStaleMs) await rm(path, { force: true }).catch(() => {});
      else await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }

  /**
   * Patch the table as it is on disk now and save it. `patch` works on a copy;
   * returning false means no change. A file that couldn't be read is kept as
   * `links.json.bad` rather than replaced; one that can't be read just now
   * fails the change and stays as it is.
   */
  change(patch: (links: Links) => boolean | void): Promise<void> {
    const job = async () => {
      const unlock = await this.lock();
      try {
        const now = await this.load();
        const links = { ...now.links };
        if (patch(links) === false) return;
        if (now.unusable) await rename(this.path, `${this.path}.bad`).catch(() => {});
        await writeAtomic(this.path, serializeLinks(links));
        this.memo = undefined; // the next read sees this write, or a later one from another window
      } finally {
        await unlock();
      }
    };
    const next = this.queue.catch(() => {}).then(job);
    this.queue = next;
    return next;
  }
}
