import { KEYS } from '../shared/stateKeys';

/**
 * "Clear Cached Data": what each checkbox removes. Pure (no `vscode`
 * import); the controller applies the plan. Nothing in the workspace is deleted.
 */
export type ClearCategory = 'files' | 'custom' | 'lists' | 'links' | 'login';

export const CLEAR_ORDER: readonly ClearCategory[] = ['files', 'custom', 'lists', 'links', 'login'];

export const CLEAR_DEFAULTS: Readonly<Record<ClearCategory, boolean>> = {
  files: true,
  custom: false,
  lists: true,
  links: false,
  login: false,
};

export interface ClearPlan {
  /** Delete downloaded statements / test cases (globalStorage), the loaded cases in the runner's lists, and forget submission details in memory. */
  cacheFiles: boolean;
  /** Delete the user's own test cases from the runner's lists. */
  customCases: boolean;
  /** Forget the problem list and history in memory (and reload the list when logged in). */
  resetData: boolean;
  /** Remove stale links (file missing) even when the other links are kept. */
  staleLinks: boolean;
  /** Remove this window's links from the link table. */
  allLinks: boolean;
  /** Same as Log Out: delete the saved password and token. */
  logout: boolean;
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
    gl.add(KEYS.autoMatches); // windows with no folder open
    ws.add(KEYS.unlinked);
    gl.add(KEYS.unlinked); // files outside any folder
  }
  if (selected.has('links')) {
    ws.add(KEYS.languageByFile);
  }
  const has = (list: readonly string[]) => (k: string) => list.includes(k);
  return {
    cacheFiles: selected.has('files'),
    customCases: selected.has('custom'),
    resetData: selected.has('lists'),
    staleLinks: selected.has('lists') && !selected.has('links'),
    allLinks: selected.has('links'),
    logout: selected.has('login'),
    workspaceKeys: [...ws].filter(has(present.workspace)).sort(),
    globalKeys: [...gl].filter(has(present.global)).sort(),
  };
}

/** Keep only the entries of `record` whose key is one of `ids` (statement view state of statements still cached). */
export function keepIds<T>(record: Readonly<Record<string, T>>, ids: ReadonlySet<number>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => ids.has(Number(k))));
}
