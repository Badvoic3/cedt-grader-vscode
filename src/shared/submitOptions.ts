/**
 * What happens around a submission (settings `cedtGrader.saveBeforeSubmit`,
 * `cedtGrader.revealResultAfterSubmit`; both on by default). No `vscode` import.
 */

/** Save first only when asked to and the editor has unsaved changes (an untitled file can't be submitted). */
export function needsSave(opts: { saveBeforeSubmit: boolean; isDirty: boolean; isUntitled: boolean }): boolean {
  return opts.saveBeforeSubmit && opts.isDirty && !opts.isUntitled;
}

/** Show the Result section when grading finished for the file that is still open. */
export function shouldRevealResult(opts: { revealResultAfterSubmit: boolean; gradedFile: string; activeFile: string | null }): boolean {
  return opts.revealResultAfterSubmit && opts.activeFile === opts.gradedFile;
}
