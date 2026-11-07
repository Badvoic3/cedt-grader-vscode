/**
 * The neutral test-case shape (no `vscode` import): grader test cases and
 * statement samples both become `GraderCase`s on their way into the runner's list.
 */
export interface GraderCase {
  testcaseId: number;
  num: number;
  input: string;
  output: string;
}

/** `\r\n` / `\r` → `\n`; trailing newlines are kept exactly as in the file. */
export function normalizeEol(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}
