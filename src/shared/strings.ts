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
  folder: 'matched by folder name',
  cph: 'matched from CPH data',
  suggested: 'suggested',
} as const;

/** Labels in the "open which file" pick (row click / go to file). */
const EN_PICK_HOW = {
  chosen: 'linked',
  filename: 'matched by file name',
  folder: 'matched by folder name',
  cph: 'matched from CPH data',
  suggested: 'suggested',
} as const;

// ===================================================================== host

const EN_S = {
  common: {
    ok: 'OK',
    cancel: 'Cancel',
    dismiss: 'Dismiss',
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
    removeStale: 'Remove the old link',
    filesFor: (name: string) => `Files for ${name}`,
    noLinkedFile: (name: string) => `${name}: no file is linked yet`,
    linkTo: (file: string) => `$(link) Link to ${file}`,
    createNew: '$(new-file) Create a new file',
    findByName: '$(search) Find a matching file',
    openStatement: '$(file-pdf) Open statement',
    cleanedDuplicates: (n: number) => `Removed ${plural(n, 'duplicate file link')} from .cedt-grader.json.`,
    unlinkOthers: (what: string, problem: string) => `Unlink ${what} from ${problem}?`,
    nOtherFiles: (n: number) => `${n} other files`,
    unlink: 'Unlink',
    linksOnly: 'Only the links are removed; the files themselves are not deleted.',
    copied: (name: string) => `$(check) Copied "${name}"`,
    saveHere: 'Save here',
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
    badPattern: (why: string) => `The file-name pattern setting can't be used (${why}), so {name}.{ext} is used instead.`,
    patternProblem: {
      ext: 'it must end with .{ext}',
      nameOrId: 'it needs {name} or {id}',
      placeholder: 'only {name}, {id} and {ext} are allowed',
      character: "it contains a character file names can't have",
    } as Record<string, string>,
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
    how: { cph: 'from CPH data', filename: 'from the file name', folder: 'from the folder name', suggested: 'suggested' } as Record<string, string>,
  },

  testcases: {
    none: (name: string) => `${name} has no test cases you can download.`,
    notAllowed: (name: string) => `The grader doesn't let you download the test cases of ${name}.`,
    tooLarge: (n: number) => `; ${n} ${n === 1 ? 'was' : 'were'} too large to download`,
    downloadAgain: 'Download Again',
    downloadProgress: (done: number, total: number) => `Downloading ${done} / ${total}`,
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
    cphDone: (parts: string, backedUp: boolean, reloaded: boolean) =>
      `${parts}.${backedUp ? ' Previous CPH file backed up (.bak).' : ''}${reloaded ? ' Ready to run in CPH.' : ' Switch to the file (or press Reload in CPH) before running them in CPH.'}`,
    reloadCph: 'Reload in CPH',
    keyRemoved: ' The last line "KEY: …" was left out of the expected outputs: only the grader\'s own main prints it.',
    failed: (why: string) => `Couldn't load the test cases: ${why}`,
    suggestedQ: (name: string, sub: string) => `Load the test cases of ${name}${sub ? ` (${sub})` : ''}?`,
    load: 'Load test cases',
    progressTitle: (name: string) => `Test cases for ${name}`,
  },

  samples: {
    load: 'Load Sample Cases',
    suggestedQ: (name: string, sub: string) => `Load the statement's sample cases for ${name}${sub ? ` (${sub})` : ''} into this file?`,
    noPdf: "This problem's statement has no PDF to read.",
    none: 'No example table found in the statement.',
    incomplete: (n: number) =>
      `${plural(n, 'row')} of the statement's example table couldn't be read, so no sample cases were loaded. Copy them from the statement by hand.`,
    loaded: (n: number) => `Loaded ${plural(n, 'sample case')} from the statement.`,
    annotated: (n: number) => ` Notes were removed from ${plural(n, 'case')}, so check them.`,
    whereTo: (n: number) => `${plural(n, 'sample case')} read from the statement. Where should they go?`,
    savedFiles: (written: number, folder: string, extra: string) =>
      `Saved ${plural(written, 'case')} to ${folder}/ (sample1.in, sample1.out, …)${extra ? ` (${extra})` : ''}.`,
    savedCph: (parts: string) => `Saved to CPH: ${parts}`,
    failed: (why: string) => `Couldn't load the sample cases: ${why}`,
    tooLong: "The statement is too long to read the example table, so no sample cases were loaded. Copy them from the statement by hand.",
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
    noSource: "The grader doesn't give back the code of this submission.",
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
    /** Detail under the one-time question for an automatic match; `how` is HOW_LINKED (e.g. "matched by file name"). */
    confirmOnce: (how: string) => `This file was ${how}. Submitting links it to this problem, so you won't be asked again.`,
    whichFileQ: (name: string, id: number) => `Which file do you submit to ${name} (#${id})?`,
    submitNamed: (file: string) => `Submit ${file}`,
    submitOpen: (file: string) => `Submit ${file} (open file)`,
    whichFileDetail: 'The grader takes one file per submission. Your choice is remembered for this folder (change it under Submits).',
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
    graded: 'Graded',
    waitingStatus: (status: string) => `Waiting to be graded… (${status})`,
    noSubmissionsYet: 'No submissions yet.',
    anotherFile: 'another file',
    testLabel: (n: number, word: string) => `Test ${n}: ${word}`,
    saveFailed: (file: string) => `Couldn't save ${file}, so nothing was submitted. Save it, then submit again.`,
  },

  account: {
    enterBoth: 'Enter your username and password.',
  },

  penaltyNote: {
    noWebSession: "Hint and AI-assist penalties aren't shown because your password isn't remembered. Scores are your best scores, without penalties.",
    unreadable: "Couldn't read the hint and AI-assist penalties from the grader's problem list. Scores are your best scores, without penalties.",
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
    severalMatchFolder: 'Several problems match the name of this folder. Choose one.',
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

  folder: {
    openFile: 'Open a file of the folder first.',
    replaceQ: (folder: string, old: string, name: string) => `${folder}/ is linked to ${old}. Link it to ${name} instead?`,
    replaceFilesQ: (folder: string, n: number, name: string) =>
      `${n === 1 ? '1 file' : `${n} files`} in ${folder}/ ${n === 1 ? 'is' : 'are'} linked to another problem. Link the whole folder to ${name} instead?`,
    replace: 'Link to this problem',
    cancelUnlinksFile: (file: string, name: string) => `Cancel removes the link from ${file} to ${name}. Dismiss changes nothing.`,
    cancelStopsMatch: (folder: string, name: string) => `Cancel stops matching ${folder} to ${name}. Dismiss changes nothing.`,
    cancelRestores: (file: string, name: string) => `Cancel links ${file} to ${name} again. Dismiss changes nothing.`,
    nowFolder: (folder: string) => `$(folder) ${folder}/ is now linked to the problem`,
    nowFile: (file: string) => `$(file) Only ${file} is linked now`,
    noSources: (folder: string) => `${folder}/ has no source file to submit.`,
    whichFile: (name: string) => `Which file do you submit for ${name}?`,
    oneFile: 'The grader takes one file per submission, so only this file is sent. You can change it under Current problem.',
    onlyThisSent: (file: string) => `Only ${file} is sent (the grader takes one file).`,
    whichRunFile: (name: string) => `Which program runs the tests for ${name}?`,
    runFileDetail: 'Test cases belong to the program with main() (the provided driver), which includes your file.',
    why: {
      'named-in-run': (run: string) => `named in a comment of ${run}`,
      student: (_run: string) => 'the included file named student.*',
      stub: (_run: string) => 'the included file with a "your code here" comment',
      'only-main': (_run: string) => 'the only file with main()',
      'main-name': (_run: string) => 'the file with main() named main*',
      chosen: (_run: string) => 'your choice',
      'only-file': (_run: string) => 'the only source file',
    },
  },

  runTests: {
    noTests: 'There are no test cases to run yet. Load the test cases first.',
    noTestsShort: 'load the test cases first',
  },

  cphAutoShow: {
    question: 'CPH opens its own panel every time you switch to a source file, which can hide this panel. Turn that off?',
    detail: 'This changes CPH\'s setting "Auto Show Judge". You can still open CPH yourself, and turn the setting back on in VS Code\'s settings.',
    turnOff: 'Turn it off',
    keep: 'Keep it',
    never: "Don't ask again",
    done: 'CPH no longer opens its panel by itself.',
    failed: (why: string) => `Couldn't change CPH's setting: ${why}`,
  },

  attachment: {
    none: (name: string) => `${name} has no attachment on the grader.`,
    writeFailed: (why: string) => `Couldn't save the attachment: ${why}`,
    renameQ: (name: string, proposal: string) => `Downloaded ${name}. Rename it to ${proposal} to match the problem?`,
    rename: 'Rename',
    keepName: 'Keep the name',
    extractQ: (zip: string, n: number, dir: string) => `${zip} has ${plural(n, 'file')}. Extract them into a new folder in ${dir}?`,
    extractAndLink: (folder: string) => `Name it after the problem (${folder}/) and link it`,
    extractOnly: (folder: string) => `Keep the original name (${folder}/), don't link`,
    contents: (list: string, n: number) =>
      `Files: ${list}${n > 6 ? `, … (${n})` : ''}. Nothing is overwritten. Linking puts the problem in folder mode: every file of the folder shows this problem.`,
    unsafePath: (name: string) => `The zip contains an unsafe path (${name}), so nothing was extracted.`,
    duplicate: (name: string) => `The zip contains ${name} twice, so nothing was extracted.`,
    tooManyFiles: (n: number) => `The zip has more than ${n} files, so nothing was extracted.`,
    tooBig: (mb: number) => `The zip's files add up to more than ${mb} MB, so nothing was extracted.`,
    unreadable: (why: string) => `Couldn't read the zip (${why}), so nothing was extracted.`,
    empty: 'The zip has no files.',
    noFreeName: (name: string) => `Couldn't find a free folder name for ${name}.`,
    exists: (path: string) => `${path} already exists; nothing was overwritten.`,
  },

  statementTab: (name: string) => `Statement: ${name}`,

  errors: {
    checkConnection: (msg: string) => `${msg} Check your internet connection.`,
    unexpected: (msg: string) => `Something went wrong: ${msg}`,
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
  rememberPassword: "Remember password on this computer",
  logIn: "Log in",
  searchPlaceholder: "Search by name or id…",
  searchProblems: "Search problems",
  filterPlaceholder: "Filter by name or id…",
  filterProblems: "Filter problems",
  readingTheResults: "Reading the results",
  refreshHistory: "Refresh history",
  refreshProblems: "Refresh problem list",
  retry: "Retry",
  showingSavedData: "Showing what was loaded before; it may be out of date.",
  userOnHost: (user: string | number, host: string | number) => `${user} on ${host}`,
  logOut: "Log out",
  logOutTip: "Log out and forget the saved password",
  loggingIn: (host: string | number) => `Logging in to ${host}…`,
  savedLogin: "Saved login:",
  useAnotherAccount: "Use another account",
  loadingProblems: "Loading problems…",
  problemListNotLoaded: "The problem list isn't loaded yet.",
  loadProblems: "Load problems",
  noMatchingProblems: "No matching problems.",
  matchesForThisFile: "Matches for this file",
  suggestedForThisFile: "Suggested for this file",
  allProblems: "All problems",
  moreResults: (n: string | number) => `${n} more. Type more of the name to narrow it down.`,
  countedScore: "Counted score",
  penaltiesFromListTip: "Hint and AI-assist penalties, read from the grader's problem list",
  fromProblemList: "from problem list",
  best: "Best",
  latest: "Latest",
  attempts: "Attempts",
  rawSumScoring: "raw-sum scoring",
  latestBelowBest: (latest: string | number, best: string | number) => `Latest: ${latest}. Your best, ${best}, still counts.`,
  openFileToSubmit: "Open a source file to submit it.",
  unknownType: "unknown type",
  changeProblemTip: (name: string | number, id: string | number) => `${name} (#${id}). Click to choose another problem.`,
  chooseProblem: "Choose problem",
  chooseProblemEllipsis: "Choose problem…",
  problem: "Problem",
  openStatement: "Open statement",
  copyProblemName: "Copy problem name",
  openOnTheGraderWebsite: "Open on the grader website",
  autoDetectTip: "Auto-detect the problem for this file again",
  unlinkThisFile: "Unlink this file",
  unlinkThisFileTip: "Unlink this file (removes your choice; auto-detect won't link it again)",
  dontMatchThisFileTip: "Don't match this file (auto-detect won't link it to a problem again)",
  notLinkedToAProblem: "Not linked to a problem",
  chooseProblemTip: "Choose the grader problem for this file",
  autoDetect: "Auto-detect",
  autoDetectAgainTip: "Find the problem for this file again (from the file name or CPH data)",
  problemUnavailableMsg: "This problem is no longer available on the grader.",
  changeProblem: "Change problem",
  changeProblemTitle: "Link this file to another problem",
  removeLink: "Remove link",
  removeLinkTip: "Forget the link for this file",
  loadingLanguages: "Loading languages…",
  oneLanguageOnly: "This problem allows only one language",
  languageTip: "Language for this submission",
  loading: "Loading…",
  chooseLanguage: "Choose language…",
  language: "Language",
  loadingTestCases: "Downloading…",
  loadTestCases: "Load test cases",
  downloadingTestCases: "Downloading the grader's test cases…",
  loadTestCasesCphTip: "Download the grader's test cases into CPH",
  loadTestCasesFilesTip: "Download the grader's test cases and save them as .in / .out files (CPH isn't installed)",
  saveTestcasesAsFiles: "Save the grader's test cases as .in / .out files",
  loadSampleCases: 'Load samples',
  readingSampleCases: 'Reading…',
  readingStatementTip: 'Reading the example table in the statement…',
  loadSampleCasesTip: 'Load the sample cases from the example table in the problem statement (PDF), also for problems without grader test cases. An unusual layout may be read wrong, so check the cases.',
  languageNotAccepted: (language: string | number) => `This problem doesn't accept ${language}. Wrong problem?`,
  change: "Change",
  acceptedLanguages: (languages: string | number) => `Accepted: ${languages}`,
  cphTip: "Want to run test cases inside VS Code? Install the Competitive Programming Helper (CPH) extension.",
  install: "Install",
  cphInstallTip: "Open CPH's page in the Extensions view",
  notNow: "Not now",
  notNowTip: "Hide until VS Code restarts",
  dontShowAgainTip: "Don't show this tip again",
  dontShowAgain: "Don't show again",
  gradingOtherFile: (problem: string | number) => `Grading ${problem} for another file…`,
  verdictPerTest: "Verdict per test",
  legendBox: "a box = tests scored together",
  legendTiles: "One tile per test case, in order. Tests in a box are scored together: one failing tile fails the whole box.",
  legendHover: "Hover over a tile or a box for details.",
  noResultYet: "Nothing submitted from this file yet in this session.",
  attempt: (number: string | number) => `Attempt ${number}`,
  grading: "Grading…",
  compilerMessage: "Compiler message",
  empty: "(empty)",
  openInEditor: "Open in editor",
  testsPassed: (passed: string | number, total: string | number) => `${passed} of ${total} tests passed`,
  maxTime: "Max time",
  peakMemory: "Peak memory",
  result: "Result",
  score: "Score",
  time: "Time",
  memory: "Memory",
  openThisVersion: "Open this version",
  openThisVersionTip: "Open the submitted code in a new, unsaved editor",
  noSourceTip: "The grader doesn't give back the code of this submission",
  compareWithCurrentFile: "Compare with current file",
  openInBrowser: "Open in browser",
  website: "Website",
  submissionTip: (id: string | number, when: string | number) => `Submission #${id} · ${when}`,
  ce: "CE",
  countedTip: "This submission holds your counted (best) score",
  countedLabel: "Counted (best) submission",
  counted: "counted",
  compileError: "compile error",
  loadingDetails: "Loading details…",
  chooseProblemForHistory: "Choose a problem to see its submissions.",
  mayBeOutOfDate: "May be out of date (couldn't reach the grader).",
  noSubmissions: "No submissions for this problem yet.",
  nSubmissions: (n: number) => `${n} submission${n === 1 ? '' : 's'}`,
  refreshing: "Refreshing…",
  autoDetectWontRelink: "Auto-detect won't link it again",
  linkTo: (fileName: string | number) => `Link to ${fileName}`,
  useFor: (name: string | number, fileName: string | number) => `Use ${name} for ${fileName}`,
  goToLinkedFile: "Go to linked file",
  findMatchingFile: "Find a matching file",
  newFileForThisProblem: "New file for this problem",
  openFileToLink: (prefix: string | number) => `${prefix}Open a source file to link a problem`,
  nFilesLinked: (n: string | number) => `${n} files are linked to this problem`,
  hideTheList: "Hide the list",
  dismiss: 'Dismiss',
  troubleshooting: 'Troubleshooting',
  troubleshootingTip: 'Open the troubleshooting guide on GitHub',
  renameToProblem: 'Rename file to match the problem',
  renameToProblemTip: (from: string, to: string) => `Rename ${from} to ${to} (you can edit the name first)`,
  dismissNoticeTip: 'Hide this notice until the files for this problem change',
  showTheFiles: "Show the files",
  hide: "Hide",
  show: "Show",
  thisFile: (how: string | number) => `this file · ${how}`,
  open: "Open",
  openPath: (path: string | number) => `Open ${path}`,
  unlink: "Unlink",
  unlinkFileTip: (path: string | number) => `Remove the link of ${path} (the file is not deleted)`,
  dontMatchThisFile: "Don't match this file",
  dontMatchFileTip: (path: string | number) => `Stop matching ${path} to this problem (the file is not changed)`,
  unlinkTheOtherFiles: "Unlink the other files",
  unlinkOthersTip: "Removes only the links; the files themselves are not deleted",
  suggestedFromFileName: "Suggested from the file name",
  useThisTip: (name: string | number, problemId: string | number) => `Link this file to ${name} (#${problemId})`,
  useThis: "Use this",
  logInToSeeProblems: "Log in to see your problems.",
  nProblems: (n: string | number) => `${n} problems`,
  nOfProblems: (n: string | number, n1: string | number) => `${n} of ${n1} problems`,
  all: "All",
  unsolved: "Unsolved",
  unsolvedTip: "Not tried yet, or best score below 100",
  inProgress: "In progress",
  inProgressTip: "Submitted, best score below 100",
  solved: "Solved",
  solvedTip: "Best score 100 or more",
  filterProblemsByStatus: "Filter problems by status",
  sortProblems: "Sort problems",
  filterProblemsByTopic: "Filter problems by topic",
  /** "Tags" dropdown (the problems' other tags, several at once). */
  tagsFilter: 'Tags',
  tagsChosen: (names: string) => `Tags: ${names}`,
  tagsFilterTip: 'Filter by other tags of the problems (several at once)',
  tagMatch: 'Match',
  tagMatchAny: 'Any (OR)',
  tagMatchAll: 'All (AND)',
  tagMatchAnyTip: 'Show problems that have at least one of the chosen tags',
  tagMatchAllTip: 'Show problems that have every chosen tag',
  clearTags: 'Clear',
  clearTagsTip: 'Untick all tags',
  /** Screen-reader text for the tags on a problem row. */
  problemTags: (names: string) => `tags: ${names}`,
  pageNumber: "Page number",
  zoomLevel: "Zoom level",
  findInStatement: "Find in statement",
  findTip: "Find in statement (Cmd/Ctrl+F)",
  zoomOutTip: "Zoom out (Cmd/Ctrl -)",
  zoomInTip: "Zoom in (Cmd/Ctrl +)",
  fitWidthTip: "Fit width (Cmd/Ctrl 0)",
  previousPage: "Previous page",
  nextPage: "Next page",
  previousMatchTip: "Previous match (Shift+Enter)",
  nextMatchTip: "Next match (Enter)",
  statement: "Statement",
  refreshStatementTip: "Refresh (download again)",
  noMatches: "No matches",
  matchOf: (current: string | number, total: string | number) => `${current} of ${total}`,
  loadingStatement: "Loading statement…",
  pdfError: (why: string | number) => `Couldn't show the PDF: ${why}`,
  sectionAccount: 'Account',
  sectionCurrent: 'Current problem',
  sectionResult: 'Result',
  sectionHistory: 'History',
  sectionProblems: 'Problems',
  notAttemptedYet: 'Not attempted yet',
  scorePillTip: (counted: string, outOf: string | null, penalty: string | null, attempts: number) =>
    `Counted score: ${counted}${outOf !== null ? ` / ${outOf}` : ''} (your best submission${penalty ? `, ${penalty}` : ''}) · ${plural(attempts, 'attempt')}`,
  compilationError: 'Compilation error',
  graded: 'Graded',
  /** Topic pill tooltip (also its aria-label): the state, then what the next click does (order from the setting). */
  topicTip: (description: string | null, topic: string, state: 'off' | 'out' | 'in', order: 'showFirst' | 'hideFirst') => {
    const next = (order === 'hideFirst' ? { off: 'out', out: 'in', in: 'off' } : { off: 'in', in: 'out', out: 'off' })[state];
    const now = state === 'in' ? `Showing only ${topic} problems. ` : state === 'out' ? `Hiding ${topic} problems. ` : `${topic}: `;
    const click = next === 'in' ? `click to show only ${topic} problems` : next === 'out' ? `click to hide ${topic} problems` : `click to stop filtering by ${topic}`;
    return `${description ? `${description}. ` : ''}${now}${state === 'off' ? click : click[0].toUpperCase() + click.slice(1)}`;
  },
  defaultOrder: "Default order",
  nameAZ: "Name A–Z",
  nameZA: "Name Z–A",
  latestSubmission: "Latest submission",
  bestScoreLowToHigh: "Best score (low to high)",
  bestScoreHighToLow: "Best score (high to low)",
  recentlyOpened: "Recently opened",
  downloadAttachment: 'Download attachment',
  downloading: 'Downloading…',
  linkFolder: 'Link the whole folder',
  linkFolderTip: 'Link the whole folder (every file in it shows this problem; Submit sends one chosen file)',
  linkOnlyFile: 'Link only this file',
  folderLinked: (folder: string) => `Folder linked by you: ${folder}`,
  submits: 'Submits',
  submitFileTip: 'The grader takes one file per submission: only this file is sent.',
  submitFileAsk: 'Asked on the first submit',
  runs: 'Runs',
  runFileTip: 'Test cases are loaded for this program, and Run tests runs it (it includes the file you submit)',
  runFileAsk: 'Asked when loading or running tests',
  automatic: (file: string) => `Automatic: ${file}`,
  whyTip: (why: string) => `Found automatically: ${why}`,
  runTests: 'Run tests',
  runTestsTip: 'Run the loaded test cases on your computer (Competitive Programming Helper)',
  unlinkThisFolder: 'Unlink this folder',
  unlinkThisFolderTip: "Unlink this folder (auto-detect won't link its files again)",
  dontMatchThisFolder: "Don't match this folder",
  dontMatchThisFolderTip: "Don't match this folder (auto-detect won't link its files to a problem again)",
} as const;

/** Match line under the problem selector. */
const EN_W_SOURCE = {
  saved: 'Chosen by you',
  filename: 'Matched by file name',
  folder: 'Matched by folder name',
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
  statusGradingTip: "CEDT Grader: waiting for the result. Click to open the panel.",
  statusConnectionTip: (message: string | number) => `${message} Click to open the panel.`,
  statusChooseTip: "Choose the CEDT Grader problem for this file",
  statusLastTip: (name: string | number, id: string | number, score: string | number, counted: string | number) => `${name} (#${id}): last score ${score}${counted}. Click to open the panel.`,
  statusOpenTip: (name: string | number, id: string | number) => `${name} (#${id}): open the CEDT Grader panel`,
  statementHidden: "The grader doesn't show this statement in VS Code. Use \"Open in Browser\".",
  statementMissing: "This problem has no statement.",
  loginThrottledTitle: "Too many login attempts",
  loginThrottledMsg: "The grader is blocking logins for a few minutes. Wait, then press Retry.",
  sessionExpiredTitle: "Login expired",
  sessionExpiredMsg: "Your grader login expired and couldn't be renewed. Log in again.",
  rateLimitedTitle: "Too many requests",
  rateLimitedMsg: "The grader is getting too many requests. Wait a minute, then press Retry.",
  offlineTitle: "No internet connection",
  offlineMsg: "Check your internet connection, then press Retry.",
  timeoutTitle: "The grader is not responding",
  timeoutMsg: "The grader took too long to answer. It may be busy; press Retry in a moment.",
  serverErrorTitle: "Grader problem",
  serverErrorMsg: "Something went wrong on the grader's side. Try again in a few minutes.",
  unreachableTitle: "Can't reach the grader",
  unreachableMsg: "Couldn't connect to the grader. Check your internet, then press Retry.",
  submitSentResultLater: (id: string | number) => `Your submission #${id} was sent. Its result loads when the connection is back.`,
  submitMaybeReceived: "The grader didn't answer in time, so it may or may not have received your code. Check History before submitting again.",
  submitNothingServerError: "Something went wrong on the grader's side. Nothing was submitted (check History to be sure).",
  submitNothingLoginExpired: "Nothing was submitted: your login expired. Log in again, then submit again.",
  submitNothingRateLimited: "Nothing was submitted: the grader is getting too many requests. Try again in a minute.",
  submitNothing: (why: string | number) => `Nothing was submitted: ${why}.`,
  timeoutDetail: (host: string | number) => `The grader (${host}) didn't answer in time.`,
  offlineDetail: (host: string | number) => `No internet connection (couldn't reach ${host}).`,
  unreachableDetail: (host: string | number) => `Couldn't connect to the grader (${host}).`,
  redirectRefused: (from: string, to: string) =>
    `The grader (${from}) sent the request on to another address (${to}), so it was stopped. If that is the grader's address, put it in the cedtGrader.baseUrl setting.`,
  tooManyRedirects: 'Too many redirects from the grader.',
  logInFirst: "Log in to CEDT Grader first.",
  loginExpired: "Your grader login has expired. Log in again.",
  noWebSession: "Not logged in to the grader website. Log in again.",
  fileEmpty: "The file is empty. Write your solution first.",
  pollTimeout: "Still not graded after 3 minutes. Check History again in a while.",
  invalidId: (id: string | number) => `Not a valid id: ${id}`,
  wrongPassword: "Wrong username or password.",
  loginThrottled: "Too many failed login attempts. Wait a few minutes and try again.",
  loginRefused: "The grader refused the login. Your account may be disabled or limited to some networks; ask your instructor.",
  loginFailedHttp: (status: string | number) => `Couldn't log in (HTTP ${status}). Try again in a moment.`,
  rateLimited: "The grader is getting too many requests. Try again in a minute.",
  httpError: (status: string | number) => `The grader answered with an error (HTTP ${status}). Try again in a moment.`,
  loginExpiredShort: "Your grader login has expired.",
  httpRefused: (status: string | number) => `The grader refused this request (HTTP ${status}).`,
  languageNotAllowed: (allowed: string | number) => `This problem doesn't accept that language. Allowed: ${allowed}.`,
  problemUnavailableDetail: (why: string | number) => `This problem is no longer available on the grader (${why}).`,
  submissionRejected: (why: string | number) => `The grader rejected the submission: ${why}`,
  problemUnavailable: "This problem is no longer available on the grader.",
  notFound: (why: string | number) => `Not found on the grader (${why}).`,
  refused: (why: string | number) => `The grader refused the request: ${why}`,
  notLoggedIn: "Not logged in.",
  countedFirst: (score: string | number) => `First counted score: ${score}.`,
  countedImproved: (before: string | number, after: string | number) => `Counted score improved: ${before} → ${after}.`,
  countedKept: (score: string | number, best: string | number) => `This submission scored ${score}; your best, ${best}, still counts.`,
  countedUnchanged: (score: string | number) => `Counted score unchanged (${score}).`,
  downloadTooLarge: (mb: number) => `The file is larger than ${mb} MB, so it wasn't downloaded.`,
} as const;

/** How the problem was chosen (`ViewState.problem.sourceLabel`). "from CPH" only when CPH data was actually used. */
const EN_MATCH_SOURCE = {
  saved: 'Chosen by you',
  cph: 'Matched from CPH data',
  filename: 'Matched by file name',
  folder: 'Matched by folder name',
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
