/**
 * Every user-facing text in one place (host messages, inline questions,
 * quick picks, and the sidebar / statement webviews), ready for translation
 * (Phase 6). No `vscode` import: the webviews bundle this file too.
 *
 * Rules: plain language, no jargon, say what happens to the user's files.
 * Parameterised texts are functions. Product and file names stay as they are.
 */

/** "1 test case" / "3 test cases". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** How a file is linked to a problem (lower case, used inside sentences). */
export const HOW_LINKED = {
  chosen: 'chosen by you',
  filename: 'matched by file name',
  cph: 'matched from CPH data',
  suggested: 'suggested',
} as const;

/** Labels in the "open which file" pick (row click / go to file). */
export const PICK_HOW = {
  chosen: 'linked',
  filename: 'matched by file name',
  cph: 'matched from CPH data',
  suggested: 'suggested',
} as const;

// ===================================================================== host

export const S = {
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
    noSourceLanguage: (name: string) => `No source-file language is allowed for ${name}.`,
    noFileNamed: (name: string, exts: string) => `No source file named "${name}" (${exts}) in the workspace.`,
    filesNamed: (name: string) => `Files named ${name}`,
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
  },

  errors: {
    checkConnection: (msg: string) => `${msg} Check your internet connection.`,
    unexpected: (msg: string) => `Unexpected error: ${msg}`,
  },
} as const;
