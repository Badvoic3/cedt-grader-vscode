/**
 * Every key the extension stores in VS Code's workspaceState / globalState
 * (no `vscode` import). One list, so "Clear Cached Data"
 * (`src/data/cacheClear.ts`) knows exactly what each checkbox removes.
 * Secrets (`cedtGrader.password:…` / `cedtGrader.token:…`) are in
 * SecretStorage and are only removed by Log Out / "Saved login" and when the
 * user or grader address changes (src/shared/secrets.ts).
 */
export const KEYS = {
  // ---- workspaceState
  /** Problem list saved for a quick start, `cedtGrader.problems.v2:<baseUrl>:<user>` (older versions: other `cedtGrader.problems…` keys). */
  problemsPrefix: 'cedtGrader.problems',
  /** Old file → problem links (also globalState), read once by src/migration/importLinks.ts and then removed. */
  mappings: 'cedtGrader.mappings',
  /** Links saved by the first versions (absolute-path keys): as `mappings`. */
  legacyMapping: 'cedtGrader.mapping',
  /** Workspace folders whose `.cedt-grader.json` was copied into the link table. "Clear Cached Data" leaves it, or cleared links would return. */
  linksImported: 'cedtGrader.linksImported',
  /** Files explicitly marked "not linked" (also globalState for files outside any folder). */
  unlinked: 'cedtGrader.unlinked',
  /** Remembered auto-matches (file name / folder / suggestion) of files that were open. */
  autoMatches: 'cedtGrader.autoMatches',
  /** Dismissed "files for this problem" notices: problem id → notice signature. */
  dismissedNotices: 'cedtGrader.dismissedNotices',
  /** Dismissed "reconnect a moved file" questions. */
  dismissedReconnects: 'cedtGrader.dismissedReconnects',
  /** Problem id → last opened (sorting "recently opened"). */
  recentlyOpened: 'cedtGrader.recentlyOpened',
  /** Language chosen per file. */
  languageByFile: 'cedtGrader.languageByFile',
  /** Problem list filter and sort. */
  problemFilter: 'cedtGrader.problemFilter',

  // ---- globalState
  /** Statement viewer page / zoom / scroll per problem. */
  statementView: 'cedtGrader.statementView',
  /** Last daily housekeeping run (stale links, cache files). */
  lastCleanup: 'cedtGrader.lastMappingCleanup',
  /** Language of the last "New file". */
  lastNewFileLanguage: 'cedtGrader.lastNewFileLanguage',
  /** "Remember password on this computer". */
  rememberPassword: 'cedtGrader.rememberPassword',
  /** Grader addresses a login has accepted: these aren't checked again. */
  verifiedServers: 'cedtGrader.verifiedServers',
  /** `.prob.bak` files older versions created: read by the one-time cleanup only. */
  backups: 'cedtGrader.backups',
  /** SecretStorage keys written (password / token per address and user), so Log Out removes all of them (src/shared/secrets.ts). */
  secretKeys: 'cedtGrader.secretKeys',
} as const;
