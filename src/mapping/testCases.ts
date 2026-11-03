import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileNameFor } from './match';

/**
 * The neutral test-case shape and the rules every target shares (no `vscode`
 * import, no CPH code). Grader test cases and statement samples both become
 * `GraderCase`s; `writeCases` (writeCases.ts) puts them into CPH's `.prob` or
 * into `.in` / `.out` files. The built-in runner (after v1.0) reuses this.
 *
 * Shared rules:
 * - markers: each kind has its own CPH id range and file-name prefix, so a
 *   re-import updates its own cases and never touches the user's tests;
 * - duplicates: a case with the same input + output as one already there is
 *   skipped (also between grader cases and samples);
 * - never overwrite: CPH's file is backed up to `.prob.bak` first; a `.in` /
 *   `.out` file that already exists is never replaced;
 * - line endings `\n`; trailing newlines kept as given.
 */
export interface GraderCase {
  testcaseId: number;
  num: number;
  input: string;
  output: string;
}

export type CaseKind = 'grader' | 'sample';

/** 7e15: a safe integer, far above CPH ms-timestamp ids (~1.8e12). Grader cases: GRADER_ID_BASE + grader testcase id. */
export const GRADER_ID_BASE = 7_000_000_000_000_000;
/** Statement samples ("Load sample cases"): STATEMENT_ID_BASE + their number (1, 2, …). 7.5e15: above every grader marker, below MAX_SAFE_INTEGER (~9e15). */
export const STATEMENT_ID_BASE = 7_500_000_000_000_000;

/** How each kind is marked: its CPH test id range and its file-name prefix (`<prefix><n>.in`). */
export const CASE_MARKERS: Record<CaseKind, { idBase: number; filePrefix: string }> = {
  grader: { idBase: GRADER_ID_BASE, filePrefix: '' },
  sample: { idBase: STATEMENT_ID_BASE, filePrefix: 'sample' },
};

/** `\r\n` / `\r` → `\n`; trailing newlines are kept exactly as in the file. */
export function normalizeEol(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/** Duplicate key of a case (input + output, line endings normalized). */
export function caseKey(t: { input: string; output: string }): string {
  return `${normalizeEol(t.input)}\u0000${normalizeEol(t.output)}`;
}

/** `<source dir>/<clean problem name>/tests` */
export function testsFolderFor(sourceDir: string, problemName: string): string {
  const folder = fileNameFor(problemName, 'x').replace(/\.x$/, '');
  return join(sourceDir, folder, 'tests');
}

/** Where a file's cases go as files: folder mode → `<folder>/tests` (the folder already carries the problem's name); else `testsFolderFor` next to the file. */
export function testsFolderOf(filePath: string, folder: string | null, problemName: string): string {
  return folder ? join(folder, 'tests') : testsFolderFor(dirname(filePath), problemName);
}

export interface SaveFilesResult {
  folder: string;
  written: number;
  /** Already there with the same content. */
  unchanged: number;
  /** Already there with different content: never overwritten. */
  keptExisting: number;
  /** The same input + output is already in the folder under another name (e.g. a sample equal to a grader case): skipped. */
  alreadyPresent: number;
}

async function readIfFile(path: string): Promise<string | null> {
  try {
    return (await stat(path)).isFile() ? await readFile(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/** Complete `<stem>.in` + `<stem>.out` pairs already in the folder, by duplicate key → stem. */
async function existingPairs(folder: string): Promise<Map<string, string>> {
  const names = await readdir(folder).catch(() => [] as string[]);
  const out = new Map<string, string>();
  for (const n of names.filter((x) => x.endsWith('.in')).sort()) {
    const stem = n.slice(0, -3);
    if (!names.includes(`${stem}.out`)) continue;
    const input = await readIfFile(join(folder, n));
    const output = await readIfFile(join(folder, `${stem}.out`));
    if (input !== null && output !== null && !out.has(caseKey({ input, output }))) out.set(caseKey({ input, output }), stem);
  }
  return out;
}

/**
 * Write `<prefix><num>.in` / `<prefix><num>.out` per case. Existing files are
 * never overwritten; a case already in the folder under another name is
 * skipped. Statement samples use the prefix `sample`, so they never collide
 * with grader cases.
 */
export async function saveTestcasesAsFiles(folder: string, cases: GraderCase[], prefix = ''): Promise<SaveFilesResult> {
  await mkdir(folder, { recursive: true });
  const pairs = await existingPairs(folder);
  let written = 0;
  let unchanged = 0;
  let keptExisting = 0;
  let alreadyPresent = 0;
  for (const c of [...cases].sort((a, b) => a.num - b.num)) {
    const stem = `${prefix}${c.num}`;
    const other = pairs.get(caseKey(c));
    if (other !== undefined && other !== stem) {
      alreadyPresent++;
      continue;
    }
    let caseWritten = false;
    let caseKept = false;
    for (const [ext, text] of [['in', c.input], ['out', c.output]] as const) {
      const path = join(folder, `${stem}.${ext}`);
      const content = normalizeEol(text);
      const existing = await readIfFile(path);
      if (existing === null) {
        await writeFile(path, content, { flag: 'wx' });
        caseWritten = true;
      } else if (existing !== content) {
        caseKept = true;
      }
    }
    if (caseKept) {
      if (caseWritten) written++;
      else keptExisting++;
      continue;
    }
    if (caseWritten) written++;
    else unchanged++;
    if (!pairs.has(caseKey(c))) pairs.set(caseKey(c), stem); // a later identical case in this batch is a duplicate
  }
  return { folder, written, unchanged, keptExisting, alreadyPresent };
}
