import { extname } from 'node:path';
import { cleanName, fileNameFor, fileStem, normalizeName } from './match';
import { isDefaultPattern, stemFor } from './namePattern';

/**
 * "Rename file to match the problem" (no `vscode` import, unit tested).
 * The rename itself goes through `WorkspaceEdit.renameFile` in the
 * controller, so editors, links and our rename handling
 * all follow, and Undo works.
 */

/** Does the file name already match the problem (same normalization as the matcher; the plain name or the file-name pattern)? */
export function nameMatchesProblem(fsPath: string, problemName: string, pattern?: string, problemId = 0): boolean {
  const stem = normalizeName(fileStem(fsPath).normalize('NFC'));
  if (stem === normalizeName(cleanName(problemName).normalize('NFC'))) return true;
  return !isDefaultPattern(pattern) && stem === normalizeName(stemFor(pattern!, { id: problemId, cleanName: cleanName(problemName) }).normalize('NFC'));
}

/** Proposed new name by the file-name pattern (default "<clean problem name>.<current extension>", Unicode NFC). */
export function renameProposal(fsPath: string, problemName: string, pattern?: string, problemId = 0): string {
  const ext = extname(fsPath).replace(/^\./, '');
  const name = fileNameFor(problemName, ext || 'txt', pattern, problemId).normalize('NFC');
  return ext ? name : name.replace(/\.txt$/, '');
}

/** "<stem>_<n>.<ext>". */
export function withSuffix(name: string, n: number): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  return `${stem}_${n}${ext}`;
}

/** "<stem>_2.<ext>", "<stem>_3.<ext>", … : the first name that doesn't exist. */
export async function freeName(desired: string, exists: (name: string) => boolean | Promise<boolean>): Promise<string> {
  if (!(await exists(desired))) return desired;
  for (let i = 2; i < 1000; i++) {
    const candidate = withSuffix(desired, i);
    if (!(await exists(candidate))) return candidate;
  }
  return desired;
}

/** Problem with a typed new name (null = fine). */
export function invalidFileName(name: string): 'empty' | 'separator' | 'reserved' | null {
  const n = name.trim();
  if (!n) return 'empty';
  if (/[\\/]/.test(n)) return 'separator';
  if (/[:*?"<>|\u0000-\u001f]/.test(n) || n === '.' || n === '..') return 'reserved';
  return null;
}
