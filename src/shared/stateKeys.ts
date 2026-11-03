/**
 * Every key the extension stores in VS Code's workspaceState / globalState
 * (no `vscode` import). One list, so "Clear Cached Data"
 * (`src/data/cacheClear.ts`) knows exactly what each checkbox removes.
 * Secrets (`cedtGrader.password:…` / `cedtGrader.token:…`) are in
 * SecretStorage and are only removed by Log Out / "Saved login".
 */
export const KEYS = {
  // ---- workspaceState
  /** Problem list saved for a quick start, `cedtGrader.problems.v2:<baseUrl>:<user>` (older versions: other `cedtGrader.problems…` keys). */
  problemsPrefix: 'cedtGrader.problems',
  /** File → problem links (also globalState for files outside any folder). */
  mappings: 'cedtGrader.mappings',
  /** Links saved by the first versions (absolute-path keys). */
  legacyMapping: 'cedtGrader.mapping',
  /** Files explicitly marked "not linked" (also globalState for files outside any folder). */
  unlinked: 'cedtGrader.unlinked',
  /** Remembered auto-matches (file name / CPH / suggestion) of files that were open. */
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
  /** "Save as files" chosen for test cases (no CPH). */
  testcaseTarget: 'cedtGrader.testcaseTarget',

  // ---- globalState
  /** Statement viewer page / zoom / scroll per problem. */
  statementView: 'cedtGrader.statementView',
  /** Last daily housekeeping run (stale links, cache files). */
  lastCleanup: 'cedtGrader.lastMappingCleanup',
  /** Language of the last "New file". */
  lastNewFileLanguage: 'cedtGrader.lastNewFileLanguage',
  /** "Don't show again" on the CPH tip. */
  cphTipDismissed: 'cedtGrader.cphTipDismissed',
  /** "Don't ask again" on the question about CPH opening its panel on every file switch. */
  cphAutoShowDismissed: 'cedtGrader.cphAutoShowDismissed',
  /** "Remember password on this computer". */
  rememberPassword: 'cedtGrader.rememberPassword',
  /** `.prob.bak` files this extension created in the workspace (deleted only from "Clear Cached Data"). */
  backups: 'cedtGrader.backups',
} as const;
