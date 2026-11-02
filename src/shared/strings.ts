/**
 * Every user-facing text in one place (host messages, inline questions,
 * quick picks: `S`; sidebar and statement webviews: `W`; grader errors,
 * banner, status bar: `G`). No `vscode` import: the webviews bundle this file too.
 *
 * The tables below are the English texts (`EN`). The exported `S`, `W`, `G`, …
 * are copies that `setLanguage()` (src/shared/i18n.ts) overwrites in place
 * with another language's table, so callers always read `S.x` at call time
 * (never copy a text into a module-level constant).
 *
 * Rules: plain language, no jargon, say what happens to the user's files.
 * Parameterised texts are functions. Product and file names stay as they are.
 */

/** "1 test case" / "3 test cases". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** How a file is linked to a problem (lower case, used inside sentences). */
const EN_HOW_LINKED = {
  chosen: 'chosen by you',
  filename: 'matched by file name',
  cph: 'matched from CPH data',
  suggested: 'suggested',
} as const;

/** Labels in the "open which file" pick (row click / go to file). */
const EN_PICK_HOW = {
  chosen: 'linked',
  filename: 'matched by file name',
  cph: 'matched from CPH data',
  suggested: 'suggested',
} as const;

// ===================================================================== host

const EN_S = {
  common: {
    ok: 'OK',
    cancel: 'Cancel',
    keep: 'Keep',
    no: 'No',
    notNow: 'Not Now',
    showLog: 'Show Log',
    openSetting: 'Open Setting',
    installCph: 'Install CPH',
    edited: (when: string) => `edited ${when}`,
    modified: (when: string) => `modified ${when}`,
  },

  requestLogOff: 'Request logging is off. Turn on the setting "CEDT Grader: Debug Requests".',
  submitLabel: 'Submit to Grader',

  exam: {
    warning: 'This problem looks like part of an exam/contest. Submitting from VS Code may not be allowed. Check with your instructor.',
    openInBrowser: 'Open in Browser',
    submitAnyway: 'Submit Anyway',
  },

  files: {
    noLongerExists: (what: string, many: boolean) => `${what} no longer exist${many ? '' : 's'}.`,
    nLinkedFiles: (n: number) => `${n} linked files`,
    removeStale: 'Remove the stale link',
    filesFor: (name: string) => `Files for ${name}`,
    noLinkedFile: (name: string) => `${name}: no file is linked yet`,
    linkTo: (file: string) => `$(link) Link to ${file}`,
    createNew: '$(new-file) Create a new file',
    findByName: '$(search) Find a file by name',
    openStatement: '$(book) Open statement',
    cleanedDuplicates: (n: number) => `Cleaned up ${plural(n, 'duplicate file link')} (.cedt-grader.json).`,
    unlinkOthers: (what: string, problem: string) => `Unlink ${what} from ${problem}?`,
    nOtherFiles: (n: number) => `${n} other files`,
    unlink: 'Unlink',
    linksOnly: 'Only the links are removed; the files themselves are not deleted.',
    copied: (name: string) => `$(check) Copied "${name}"`,
    openFolderFirst: 'Open a folder first.',
    languagesNotLoaded: 'Languages could not be loaded yet. Try again in a moment.',
    newFileLanguage: (name: string) => `Language for the new ${name} file`,
    alreadyExists: (path: string) => `${path} already exists.`,
    openExisting: 'Open Existing',
    overwrite: 'Overwrite',
    noFileNamed: (name: string, exts: string) => `No source file in the workspace matches ${name} (${exts}).`,
    filesNamed: (name: string) => `Files for ${name}`,
    sameFolder: 'same folder',
    linkFileTo: (path: string, name: string, id: number) => `Link ${path} to ${name} (#${id})?`,
    link: 'Link',
    openSourceFirst: 'Open a source file first, then choose its problem.',
    openSourceFirstShort: 'Open a source file first.',
    problemFor: (file: string) => `Grader problem for ${file}`,
    counted: (n: number) => ` · counted ${n}`,
  },

  moved: {
    looksLike: (what: string) => `This looks like ${what}. Keep the link?`,
    notThisOne: 'Not this one',
    whichLink: (file: string) => `${file} may be a moved file. Keep which link?`,
    noneOfThese: 'None of these',
    skip: 'Skip',
    moveCphQuestion: (one: string | null, n: number) =>
      one !== null ? `Move CPH test cases to the new file too? (${one})` : `Move CPH test cases of ${n} renamed files too?`,
    moveCph: 'Move Test Cases',
    entry: (path: string, problem: string) => `${path}, linked to ${problem}`,
    movedCph: (done: number, skipped: number) =>
      `Moved CPH test cases for ${plural(done, 'file')} (old files kept as .bak)` +
      (skipped ? `; ${skipped} skipped because the new file already has CPH tests.` : '.') +
      ' CPH shows them when you switch to the file.',
  },

  autoDetect: {
    found: (name: string, how: string) => `Auto-detect found ${name} (${how}).`,
    switch: 'Switch to it',
    keepCurrent: 'Keep current',
    agrees: (name: string, how: string) => `Auto-detect agrees: ${name}${how ? ` (${how})` : ''}.`,
    ambiguousKept: (n: number) => `Auto-detect found ${n} equally good matches; your choice is kept.`,
    noneKept: 'Auto-detect found no exact match; your choice is kept.',
    none: 'Auto-detect found no matching problem. Choose one from the list.',
    how: { cph: 'from CPH data', filename: 'from the file name', suggested: 'suggested' } as Record<string, string>,
  },

  testcases: {
    none: (name: string) => `${name} has no test cases you can download.`,
    notAllowed: (name: string) => `The grader does not let you download the test cases of ${name}.`,
    tooLarge: (n: number) => `; ${n} ${n === 1 ? 'was' : 'were'} too large to download`,
    downloadAgain: 'Download Again',
    whereTo: (n: number) => `Downloaded ${plural(n, 'test case')}. Where should they go?`,
    whereToDetail: 'Save them as .in / .out files next to your source, or install CPH to run them inside VS Code.',
    saveAsFiles: 'Save as Files',
    createFolderQ: (folder: string, n: number) => `Create ${folder}/ for ${plural(n, 'test case')}?`,
    createFolder: 'Create Folder',
    unchanged: (n: number) => `${n} unchanged`,
    keptExisting: (n: number) => `${n} existing files kept (not overwritten)`,
    showFolder: 'Show Folder',
    savedFiles: (written: number, total: number, folder: string, tooLarge: string, extra: string) =>
      `Saved ${written} of ${plural(total, 'test case')} to ${folder}/${tooLarge}${extra ? ` (${extra})` : ''}. Install CPH to run these tests in VS Code.`,
    savedCph: (loaded: number, total: number, tooLarge: string) => `Saved to CPH: loaded ${loaded} of ${plural(total, 'test case')}${tooLarge}`,
    alreadyPresent: (n: number) => `${n} already present`,
    updated: (n: number) => `${n} updated`,
    added: (n: number) => `${n} added`,
    cphDone: (parts: string, backedUp: boolean) =>
      `${parts}.${backedUp ? ' Previous CPH file backed up (.bak).' : ''} CPH reloads tests when you switch to the file; don't run tests in CPH before that.`,
    reloadCph: 'Reload in CPH',
    failed: (why: string) => `Could not load test cases: ${why}`,
    suggestedQ: (name: string, sub: string) => `Load the test cases of ${name}${sub ? ` (${sub})` : ''}?`,
    load: 'Load test cases',
    progressTitle: (name: string) => `Test cases for ${name}`,
  },

  cache: {
    title: (size: string) => `Clear Cached Data (${size} in use)`,
    placeholder: 'Choose what to clear, then press Enter',
    files: 'Downloaded files',
    filesDetail: 'Problem statements, test cases and submission details. Downloaded again when needed.',
    lists: 'Problem list, history and remembered matches',
    listsDetail:
      'Saved problem list, submission history, remembered automatic matches, "not linked" files, dismissed notices, recently opened problems and links of deleted files.',
    links: 'File-to-problem links',
    linksDetail: 'Every problem you chose for a file, also the entries in .cedt-grader.json (the file itself is kept).',
    login: 'Saved login',
    loginDetail: 'Your saved password and login token (the same as Log Out).',
    backups: 'Backup files from test-case imports',
    backupsDetail: (n: number) => `${plural(n, 'old CPH test file')} (.prob.bak) this extension kept in your folders.`,
    confirm: (what: string) => `Clear ${what}? This can't be undone.`,
    clear: 'Clear',
    cleared: (size: string) => `Cached data cleared (${size} freed).`,
    skippedDirty: (n: number) => `${plural(n, '.cedt-grader.json file has', '.cedt-grader.json files have')} unsaved changes and ${n === 1 ? 'was' : 'were'} not emptied.`,
  },

  submit: {
    noSource: 'The grader does not return the source of this submission.',
    alreadyGrading: 'A submission is already being graded.',
    openToSubmit: 'Open a source file to submit it.',
    notAllowed: (lang: string) => `${lang} is not allowed for this problem.`,
    languageFor: 'Language for this submission',
    unavailable: 'This problem is no longer available on the grader.',
    newerOther: (path: string) => `Submit this file? ${path} was changed more recently.`,
    submitThis: 'Submit this file',
    openOther: 'Open the other file',
    bothLinked: (name: string, id: number) => `Both files are linked to ${name} (#${id}).`,
    suggestedQ: (name: string, sub: string) => `Submit to ${name}${sub ? ` (${sub})` : ''}?`,
    submit: 'Submit',
    chooseAnother: 'Choose another problem',
    confirmQ: (file: string, name: string, id: number, lang: string | null) => `Submit ${file} to ${name} (#${id})${lang ? ` as ${lang}` : ''}?`,
    confirmOff: 'You can turn this question off in Settings ("CEDT Grader: Confirm Before Submit").',
    waiting: 'Waiting to be graded…',
    submitting: 'Submitting…',
    connectionBack: 'Connection back. Loading the result…',
    stoppedWaiting: 'Stopped waiting. Use "Show Last Result" to check again.',
    stillGrading: 'Still being graded. Check again in a moment.',
    chooseFirst: 'Choose a problem first.',
    logInFirst: 'Log in first.',
    chooseProblemForFile: 'Choose the grader problem for this file.',
    notAccepted: (wanted: string) => `This problem doesn't accept ${wanted}.`,
    gradingTitle: (name: string, id: number) => `Grading ${name} (#${id})`,
    compilationError: 'Compilation error',
    waitingStatus: (status: string) => `Waiting to be graded… (${status})`,
    noSubmissionsYet: 'No submissions yet.',
    anotherFile: 'another file',
    testLabel: (n: number, word: string) => `Test ${n}: ${word}`,
  },

  account: {
    enterBoth: 'Enter your username and password.',
  },

  penaltyNote: {
    noWebSession: 'Hint/AI penalties not loaded (password not remembered). Scores shown are best scores.',
    unreadable: 'Could not read hint/AI penalties from the problem list. Scores shown are best scores.',
  },

  notice: {
    sameNameOne: 'Another file with the same name also matches this problem.',
    sameNameMany: (n: number) => `${n} other files with the same name also match this problem.`,
    linked: (n: number) => `${n} files are linked to this problem`,
  },

  statementOutdated: 'This problem is no longer available on the grader; this saved copy may be out of date.',

  match: {
    severalCould: 'Several problems could match this file. Choose one.',
    severalMatch: (cph: boolean) => `Several problems match this ${cph ? "file's CPH data" : 'file name'}. Choose one.`,
  },

  rename: {
    title: 'Rename file to match the problem',
    prompt: (current: string) => `New name for ${current} (links, open editors and CPH tests follow; Undo works)`,
    existsSuggest: (name: string, free: string) => `${name} already exists here. Try ${free}.`,
    invalid: {
      empty: 'Type a file name.',
      separator: 'Just a file name, without folders.',
      reserved: 'File names can’t contain : * ? " < > |',
    } as Record<string, string>,
    failed: (name: string) => `Couldn't rename the file to ${name}.`,
  },

  statementTab: (name: string) => `Statement: ${name}`,

  errors: {
    checkConnection: (msg: string) => `${msg} Check your internet connection.`,
    unexpected: (msg: string) => `Unexpected error: ${msg}`,
  },
} as const;

// ================================================================ webviews

/** Sidebar and statement viewer texts (webview/*.ts). */
const EN_W = {
  ago: {
    justNow: 'just now',
    minAgo: (m: number) => `${m} min ago`,
    hoursAgo: (h: number) => `${h} h ago`,
    daysAgo: (d: number) => `${d} day${d === 1 ? '' : 's'} ago`,
  },
  username: "Username",
  password: "Password",
  rememberPasswordOnThisComputer: " Remember password on this computer",
  logIn: " Log in",
  searchByNameOrId: "Search by name or id…",
  searchProblems: "Search problems",
  filterByNameOrId: "Filter by name or id…",
  filterProblems: "Filter problems",
  readingTheResults: "Reading the results",
  refreshHistory: "Refresh history",
  refreshProblemList: "Refresh problem list",
  retry: " Retry",
  showingSavedDataBelowIt: "Showing saved data below; it may be out of date.",
  userOnHost: (v0: string | number, host: string | number) => `${v0} on ${host}`,
  logOut: " Log out",
  logOutAndForgetThe: "Log out and forget the saved password",
  loggingInTo: (host: string | number) => ` Logging in to ${host}…`,
  savedLogin: "Saved login: ",
  useAnotherAccount: "Use another account",
  loadingProblems: "Loading problems…",
  problemListNotLoaded: "Problem list not loaded. ",
  loadProblems: "Load problems",
  noMatchingProblems: "No matching problems.",
  matchesForThisFile: "Matches for this file",
  suggestedForThisFile: "Suggested for this file",
  allProblems: "All problems",
  moreRefineTheSearch: (v0: string | number) => `${v0} more. Refine the search.`,
  countedScore: "Counted score",
  hintAiAssistPenaltiesRead: "Hint/AI-assist penalties read from the problem list page",
  fromProblemList: "from problem list",
  notAttempted: "Not attempted",
  best: "Best ",
  latest: "Latest ",
  attempts: "Attempts ",
  rawSumScoring: "raw-sum scoring",
  latestYourBestStillCounts: (v0: string | number, v1: string | number) => ` Latest: ${v0} — your best ${v1} still counts.`,
  openSourceToSubmit: " Open a source file to submit it.",
  unknownType: "unknown type",
  chooseAnotherProblem: (name: string | number, id: string | number) => `${name} (#${id}) — choose another problem`,
  chooseProblem: "Choose problem",
  chooseProblemEllipsis: "Choose problem…",
  problem: "Problem",
  openStatement: "Open statement",
  copyProblemName: "Copy problem name",
  openOnTheGraderWebsite: "Open on the grader website",
  autoDetectTheProblemFor: "Auto-detect the problem for this file again",
  unlinkThisFile: "Unlink this file",
  unlinkThisFileTip: "Unlink this file (removes your choice; auto-detect won't link it again)",
  dontMatchThisFileTip: "Don't match this file (auto-detect won't link it to a problem again)",
  notLinkedToAProblem: "Not linked to a problem",
  pickTheGraderProblemFor: "Pick the grader problem for this file",
  autoDetect: "Auto-detect",
  matchThisFileToA: "Match this file to a problem again (file name, CPH data)",
  problemUnavailableMsg: "This problem is no longer available on the grader.",
  changeProblem: "Change problem",
  linkThisFileToAnother: "Link this file to another problem",
  removeLink: "Remove link",
  forgetTheLinkForThis: "Forget the link for this file",
  loadingLanguages: "Loading languages…",
  thisProblemAllowsOnlyOne: "This problem allows only one language",
  languageForThisSubmission: "Language for this submission",
  loading: "Loading…",
  chooseLanguage: "Choose language…",
  language: "Language",
  loadingTestCases: " Loading test cases…",
  loadTestCases: " Load test cases",
  downloadingTestCases: "Downloading test cases…",
  downloadIntoCph: "Download the grader's test cases into CPH",
  downloadAsFiles: "Download the grader's test cases (CPH isn't installed: save them as .in/.out files)",
  thisProblemDoesnTAccept: (wanted: string | number) => `This problem doesn't accept ${wanted}. Wrong problem?`,
  change: "Change",
  accepted: (v0: string | number) => `Accepted: ${v0}`,
  wantToRunTestCases: "Want to run test cases inside VS Code? Install the Competitive Programming Helper (CPH) extension.",
  install: "Install",
  openCphSPageIn: "Open CPH's page in the Extensions view",
  notNow: "Not now",
  hideUntilVsCodeRestarts: "Hide until VS Code restarts",
  donTShowThisTip: "Don't show this tip again",
  donTShowAgain: "Don't show again",
  gradingForAnotherFile: (gradingElsewhere: string | number) => ` Grading ${gradingElsewhere} for another file…`,
  verdictPerTest: "Verdict per test",
  aBoxTestsScoredTogether: "a box = tests scored together",
  oneTilePerTestCase: "One tile per test case, in order. A box earns the lowest score inside it: one failing tile fails the whole box.",
  hoverATileOrA: "Hover a tile or a box for details.",
  noSubmissionYetForThis: "No submission yet for this file in this session.",
  attempt: (number: string | number) => `Attempt ${number}`,
  grading: "Grading…",
  compilerMessage: "Compiler message",
  empty: "(empty)",
  openInEditor: " Open in editor",
  resubmit: " Resubmit",
  submitTheCurrentFileAgain: "Submit the current file again",
  ofTestsPassed: (passed: string | number, n1: string | number) => `${passed} of ${n1} tests passed`,
  maxTime: "Max time ",
  peakMemory: "Peak memory ",
  result: "Result",
  score: "Score",
  time: "Time",
  memory: "Memory",
  openThisVersion: " Open this version",
  openTheSubmittedSourceIn: "Open the submitted source in a new untitled editor",
  theGraderDoesNotReturn: "The grader does not return the source of this submission",
  compareWithCurrentFile: " Compare with current file",
  compareWithCurrentFileTip: "Compare with current file",
  openInBrowser: "Open in browser",
  website: "Website",
  submission: (submissionId: string | number, v1: string | number) => `Submission #${submissionId} · ${v1}`,
  ce: "CE",
  thisSubmissionHoldsYourCounted: "This submission holds your counted (best) score",
  countedBestSubmission: "Counted (best) submission",
  counted: "counted",
  ofTestsPassedShort: (v0: string | number, n1: string | number) => `${v0} of ${n1} tests passed`,
  compileError: "compile error",
  loadingDetails: " Loading details…",
  chooseAProblemToSee: "Choose a problem to see its submissions.",
  mayBeOutOfDate: " May be out of date (could not reach the grader).",
  noSubmissionsForThisProblem: "No submissions for this problem yet.",
  nSubmissions: (n: string | number, v1: string | number) => `${n} submission${v1}`,
  refreshing: " Refreshing…",
  autoDetectWonTRe: "Auto-detect won't re-link it",
  linkTo: (fileName: string | number) => `Link to ${fileName}`,
  useFor: (name: string | number, fileName: string | number) => `Use ${name} for ${fileName}`,
  goToLinkedFile: "Go to linked file",
  findFileByName: "Find file by name",
  newFileForThisProblem: "New file for this problem",
  openSourceToLink: (v0: string | number) => `${v0}Open a source file to link a problem`,
  filesAreLinkedToThis: (n: string | number) => `${n} files are linked to this problem`,
  hideTheList: "Hide the list",
  dismiss: 'Dismiss',
  renameToProblem: 'Rename file to match the problem',
  renameToProblemTip: (from: string, to: string) => `Rename ${from} to ${to} (you can edit the name first)`,
  dismissNoticeTip: 'Hide this notice until the files for this problem change',
  showTheFiles: "Show the files",
  hide: "Hide",
  show: "Show",
  thisFile: (v0: string | number) => `this file · ${v0}`,
  open: "Open",
  openPath: (path: string | number) => `Open ${path}`,
  unlink: "Unlink",
  removeTheLinkOfThe: (path: string | number) => `Remove the link of ${path} (the file is not deleted)`,
  donTMatchThisFile: "Don't match this file",
  stopMatchingToThisProblem: (path: string | number) => `Stop matching ${path} to this problem (the file is not changed)`,
  unlinkTheOtherFiles: "Unlink the other files",
  removesOnlyTheLinksThe: "Removes only the links; the files themselves are not deleted",
  suggestedFromTheFileName: "Suggested from the file name",
  linkThisFileTo: (name: string | number, problemId: string | number) => `Link this file to ${name} (#${problemId})`,
  useThis: "Use this",
  loadingProblemsIcon: " Loading problems…",
  logInToSeeYour: "Log in to see your problems.",
  loadProblemsIcon: " Load problems",
  nProblems: (n: string | number) => `${n} problems`,
  nOfProblems: (n: string | number, n1: string | number) => `${n} of ${n1} problems`,
  all: "All",
  unsolved: "Unsolved",
  notTriedYetOrNot: "Not tried yet or not 100 yet",
  inProgress: "In progress",
  submittedBestScoreBelow100: "Submitted, best score below 100",
  solved: "Solved",
  bestScore100OrMore: "Best score 100 or more",
  filterProblemsByStatus: "Filter problems by status",
  sortProblems: "Sort problems",
  filterProblemsByTopic: "Filter problems by topic",
  pageNumber: "Page number",
  zoomLevel: "Zoom level",
  findInStatement: "Find in statement",
  findInStatementCmdCtrl: "Find in statement (Cmd/Ctrl+F)",
  zoomOutCmdCtrl: "Zoom out (Cmd/Ctrl -)",
  zoomInCmdCtrl: "Zoom in (Cmd/Ctrl +)",
  fitWidthCmdCtrl0: "Fit width (Cmd/Ctrl 0)",
  previousPage: "Previous page",
  nextPage: "Next page",
  previousMatchShiftEnter: "Previous match (Shift+Enter)",
  nextMatchEnter: "Next match (Enter)",
  statement: "Statement",
  refreshDownloadAgain: "Refresh (download again)",
  noMatches: "No matches",
  matchOf: (current: string | number, total: string | number) => `${current} of ${total}`,
  loadingStatement: "Loading statement…",
  couldNotDisplayThePdf: (v0: string | number) => `Could not display the PDF: ${v0}`,
  sectionAccount: 'Account',
  sectionCurrent: 'Current problem',
  sectionResult: 'Result',
  sectionHistory: 'History',
  sectionProblems: 'Problems',
  notAttemptedYet: 'Not attempted yet',
  scorePillTip: (counted: string, outOf: string | null, penalty: string | null, attempts: number) =>
    `Counted score: ${counted}${outOf !== null ? ` / ${outOf}` : ''} (your best submission${penalty ? `, ${penalty}` : ''}) · ${plural(attempts, 'attempt')}`,
  compilationError: 'Compilation error',
  points: (n: string) => `${n} points`,
  graded: 'Graded',
  topicTip: (description: string | null, topic: string, active: boolean) =>
    `${description ? `${description}. ` : ''}${active ? 'Click again to show all topics' : `Show only ${topic} problems`}`,
  defaultOrder: "Default order",
  nameAZ: "Name A–Z",
  nameZA: "Name Z–A",
  latestSubmission: "Latest submission",
  bestScoreLowToHigh: "Best score (low to high)",
  bestScoreHighToLow: "Best score (high to low)",
  recentlyOpened: "Recently opened",
} as const;

/** Match line under the problem selector. */
const EN_W_SOURCE = {
  saved: 'Chosen by you',
  filename: 'Matched by file name',
  cph: 'Matched from CPH data',
  suggested: 'Suggested',
} as const;

// ================================================================ grader / host modules

/** Connection banner, grader errors, status bar, statement panel, score lines. */
const EN_G = {
  /** Verdict words, as on the website (`config/locales/en.yml`), by evaluation kind. */
  verdict: {
    waiting: 'Judging',
    correct: 'Correct',
    wrong: 'Wrong Answer',
    partial: 'Partially Correct',
    time_limit: 'Time Limit Exceed',
    memory_limit: 'Memory Limit Exceed',
    crash: 'Program Crashed',
    unknown_error: 'UNKNOWN ERROR',
    grader_error: 'GRADER ERROR',
  } as Record<string, string>,
  unknownVerdict: 'Unknown',
  testOf: (n: number, total: number, word: string) => `Test ${n} of ${total}: ${word}`,
  groupHint: 'Tests in a box are scored together — the box earns the lowest score inside it.',
  groupOf: (group: number, groups: number, passed: number, total: number, hint: string) => `Group ${group} of ${groups}: ${passed}/${total} passed. ${hint}`,
  /** Penalty label "-10 AI assist". */
  penalty: (cost: string, what: 'both' | 'ai' | 'hints' | 'other') =>
    `-${cost} ${{ both: 'hints + AI assist', ai: 'AI assist', hints: 'hints', other: 'penalty' }[what]}`,
  statusBar: {
    grading: (name: string) => `Grading ${name}…`,
    connection: (title: string) => `Grader: ${title}`,
    chooseProblem: 'Grader: choose problem',
    submitWithScore: (score: string) => `${score}  Submit to Grader`,
    submit: 'Submit to Grader',
    counted: (n: string) => `, counted ${n}`,
  },
  rawSumTip: 'This problem adds up raw test scores (raw-sum scoring), so there is no fixed maximum.',
  cedtGraderWaitingForThe: "CEDT Grader: waiting for the verdict. Click to open the panel.",
  clickToOpenThePanel: (message: string | number) => `${message} Click to open the panel.`,
  mapThisFileToA: "Map this file to a CEDT Grader problem",
  lastClickToOpenThe: (name: string | number, id: string | number, score: string | number, v3: string | number) => `${name} (#${id}): last ${score}${v3}. Click to open the panel.`,
  openTheCedtGraderPanel: (name: string | number, id: string | number) => `${name} (#${id}): open the CEDT Grader panel`,
  theStatementIsNotAvailable: "The statement is not available in VS Code for this problem. Use \"Open in Browser\".",
  thisProblemHasNoStatement: "This problem has no statement.",
  tooManyLoginAttempts: "Too many login attempts",
  theGraderIsBlockingLogins: "The grader is blocking logins for a few minutes. Wait, then press Retry.",
  sessionExpired: "Session expired",
  yourGraderLoginExpiredAnd: "Your grader login expired and logging in again failed. Log in again.",
  tooManyRequests: "Too many requests",
  theGraderIsRateLimiting: "The grader is rate-limiting requests. Wait a minute, then press Retry.",
  noInternetConnection: "No internet connection",
  checkYourInternetConnectionThen: "Check your internet connection, then press Retry.",
  theGraderIsNotResponding: "The grader is not responding",
  theRequestTimedOutThe: "The request timed out. The server may be busy; press Retry in a moment.",
  graderServerError: "Grader server error",
  theGraderReturnedAServer: "The grader returned a server error (5xx). Try again later.",
  cannotReachTheGrader: "Cannot reach the grader",
  theGraderServerIsUnreachable: "The grader server is unreachable. Check your connection or try again later.",
  yourSubmissionWasSentResults: (sentId: string | number) => `Your submission #${sentId} was sent. Results will load when the connection is back.`,
  theGraderDidNotAnswer: "The grader did not answer in time. Check History before resubmitting: it may or may not have been received.",
  nothingSubmittedServerError: "The grader returned a server error. Nothing was submitted (check History to be sure).",
  nothingWasSubmittedYourLogin: "Nothing was submitted: your login expired. Log in again and resubmit.",
  nothingWasSubmittedTheGrader: "Nothing was submitted: the grader is rate-limiting requests. Try again in a minute.",
  nothingWasSubmitted: (v0: string | number) => `Nothing was submitted: ${v0}.`,
  timeoutHost: (host: string | number) => `The grader (${host}) did not answer in time.`,
  noInternetConnectionCannotReach: (host: string | number) => `No internet connection (cannot reach ${host}).`,
  cannotReachTheGraderServer: (host: string | number) => `Cannot reach the grader server (${host}).`,
  logInToCedtGrader: "Log in to CEDT Grader first.",
  yourGraderLoginHasExpired: "Your grader login has expired. Please log in again.",
  noWebSession: "No web session.",
  theFileIsEmpty: "The file is empty.",
  stillNotGradedAfter3: "Still not graded after 3 minutes. Check again later.",
  invalidId: (id: string | number) => `Invalid id: ${id}`,
  wrongUsernameOrPassword: "Wrong username or password.",
  tooManyFailedLoginAttempts: "Too many failed login attempts. Wait a few minutes and try again.",
  loginRefusedByTheGrader: "Login refused by the grader.",
  loginFailedHttp: (status: string | number) => `Login failed (HTTP ${status}).`,
  rateLimitedTryLater: "The grader is rate-limiting requests. Try again in a minute.",
  theGraderReturnedAnError: (status: string | number) => `The grader returned an error (HTTP ${status}).`,
  loginExpiredShort: "Your grader login has expired.",
  theGraderRefusedTheRequest: (status: string | number) => `The grader refused the request (HTTP ${status}).`,
  thatLanguageIsNotAllowed: (v0: string | number) => `That language is not allowed for this problem. Allowed: ${v0}.`,
  problemUnavailableMsg: (msg: string | number) => `This problem is no longer available on the grader (${msg}).`,
  submissionRejected: (msg: string | number) => `Submission rejected: ${msg}`,
  problemUnavailable: "This problem is no longer available on the grader.",
  notFoundOnTheGrader: (msg: string | number) => `Not found on the grader (${msg}).`,
  refusedMsg: (msg: string | number) => `The grader refused the request: ${msg}`,
  notLoggedIn: "Not logged in.",
  firstCountedScore: (v0: string | number) => `First counted score: ${v0}.`,
  countedScoreImproved: (v0: string | number, v1: string | number) => `Counted score improved: ${v0} → ${v1}.`,
  thisSubmissionScoredYourBest: (v0: string | number, v1: string | number) => `This submission scored ${v0}; your best ${v1} still counts.`,
  countedScoreUnchanged: (v0: string | number) => `Counted score unchanged (${v0}).`,
} as const;

/** How the problem was chosen (`ViewState.problem.sourceLabel`). "from CPH" only when CPH data was actually used. */
const EN_MATCH_SOURCE = {
  saved: 'Chosen by you',
  cph: 'Matched from CPH data',
  filename: 'Matched by file name',
  suggested: 'Suggested — click to confirm',
};

// ================================================================ tables

/** The English texts: the reference every other language must match (same keys, same function parameters). */
export const EN = {
  HOW_LINKED: EN_HOW_LINKED,
  PICK_HOW: EN_PICK_HOW,
  S: EN_S,
  W: EN_W,
  W_SOURCE: EN_W_SOURCE,
  G: EN_G,
  MATCH_SOURCE: EN_MATCH_SOURCE,
};

/** Same shape as `EN`, with every text widened to `string` (functions keep their parameters). */
type Widen<T> = T extends (...args: infer A) => unknown
  ? (...args: A) => string
  : T extends string
    ? string
    : { -readonly [K in keyof T]: Widen<T[K]> };

/** A complete translation: tsc fails when a key is missing or a function's parameters differ. */
export type Strings = Widen<typeof EN>;

function copy<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)])) as T;
}

// Live tables (English until `setLanguage` says otherwise).
export const HOW_LINKED: Strings['HOW_LINKED'] = copy(EN.HOW_LINKED);
export const PICK_HOW: Strings['PICK_HOW'] = copy(EN.PICK_HOW);
export const S: Strings['S'] = copy(EN.S);
export const W: Strings['W'] = copy(EN.W);
export const W_SOURCE: Strings['W_SOURCE'] = copy(EN.W_SOURCE);
export const G: Strings['G'] = copy(EN.G);
export const MATCH_SOURCE: Strings['MATCH_SOURCE'] = copy(EN.MATCH_SOURCE);
