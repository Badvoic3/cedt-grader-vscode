import { KEYS } from '../shared/stateKeys';

/**
 * "Clear Cached Data": what each checkbox removes. Pure (no `vscode`
 * import); the controller applies the plan.
 *
 * Nothing in the workspace is deleted except the `.prob.bak` files this
 * extension recorded creating, and only with "backups" selected.
 * `.cedt-grader.json` is emptied (never deleted) only with "links".
 */
export type ClearCategory = 'files' | 'lists' | 'links' | 'login' | 'backups';

export const CLEAR_ORDER: readonly ClearCategory[] = ['files', 'lists', 'links', 'login', 'backups'];

export const CLEAR_DEFAULTS: Readonly<Record<ClearCategory, boolean>> = {
  files: true,
  lists: true,
  links: false,
  login: false,
  backups: false,
};

export interface ClearPlan {
  /** Delete downloaded statements / test cases (globalStorage) and forget submission details in memory. */
  cacheFiles: boolean;
  /** Forget the problem list and history in memory (and reload the list when logged in). */
  resetData: boolean;
  /** Remove stale links (file missing) even when the other links are kept. */
  staleLinks: boolean;
  /** Remove every link, including the entries in each `.cedt-grader.json`. */
  allLinks: boolean;
  /** Same as Log Out: delete the saved password and token. */
  logout: boolean;
  /** Delete the recorded `.prob.bak` files. */
  backups: boolean;
  /** Keys to remove (only keys that exist). */
  workspaceKeys: string[];
  globalKeys: string[];
}

export function planClear(
  selected: ReadonlySet<ClearCategory>,
  present: { workspace: readonly string[]; global: readonly string[] },
): ClearPlan {
  const ws = new Set<string>();
  const gl = new Set<string>();
  if (selected.has('files')) gl.add(KEYS.statementView);
  if (selected.has('lists')) {
    for (const k of present.workspace) if (k.startsWith(KEYS.problemsPrefix)) ws.add(k);
    for (const k of [KEYS.autoMatches, KEYS.dismissedNotices, KEYS.dismissedReconnects, KEYS.recentlyOpened]) ws.add(k);
    ws.add(KEYS.unlinked);
    gl.add(KEYS.unlinked); // files outside any folder
  }
  if (selected.has('links')) {
    for (const k of [KEYS.mappings, KEYS.legacyMapping, KEYS.languageByFile]) ws.add(k);
    for (const k of [KEYS.mappings, KEYS.legacyMapping]) gl.add(k);
  }
  const has = (list: readonly string[]) => (k: string) => list.includes(k);
  return {
    cacheFiles: selected.has('files'),
    resetData: selected.has('lists'),
    staleLinks: selected.has('lists') && !selected.has('links'),
    allLinks: selected.has('links'),
    logout: selected.has('login'),
    backups: selected.has('backups'),
    workspaceKeys: [...ws].filter(has(present.workspace)).sort(),
    globalKeys: [...gl].filter(has(present.global)).sort(),
  };
}

// ------------------------------------------------------------------ backups

export interface BackupRecord {
  path: string;
  /** ISO time it was (last) written. */
  at: string;
}

/** Remember a backup this extension wrote (one record per path, newest time). */
export function recordBackup(list: readonly BackupRecord[], path: string, at: Date): BackupRecord[] {
  return [...list.filter((b) => b.path !== path), { path, at: at.toISOString() }];
}

/** Recorded backups that may be deleted: our own `.prob.bak` files that still exist. */
export function backupsToDelete(list: readonly BackupRecord[], exists: (path: string) => boolean): BackupRecord[] {
  return list.filter((b) => /\.prob\.bak$/.test(b.path) && exists(b.path));
}

/** Keep only the entries of `record` whose key is one of `ids` (statement view state of statements still cached). */
export function keepIds<T>(record: Readonly<Record<string, T>>, ids: ReadonlySet<number>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => ids.has(Number(k))));
}
