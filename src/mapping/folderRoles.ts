import { pathKey } from './paths';

/**
 * Folder mode: the two roles of a package folder (no `vscode` import; unit tested).
 *
 *  - run file: the program with `main()` (the provided driver, e.g. `main.cpp`,
 *    `main_dense.cpp`); CPH runs it and the grader's test cases belong to it;
 *  - submit file: the file the student edits and submits (e.g. `student.h`,
 *    `densegraph.h`); the grader compiles it with its own driver.
 *
 * Rule checked against every zip package on the live grader (47 of 47 agree
 * with "submit only file X" in the problem statements, none asked):
 *  run: the only C/C++ source with `main(` at the start of a line (comments
 *       and strings removed; `int` / `signed` / `void` / `auto main`), else
 *       the only such file whose name starts with "main", else ask;
 *  submit: among the files the run file includes with `#include "…"`
 *       (transitively, relative to the including file, then the folder root;
 *       the run file itself excluded), the first rule with exactly one file:
 *       named in a comment of the run file that reads like "add your code in
 *       X" → named `student.*` → the only one with a stub comment ("your code
 *       here", "write your code", TODO, …) → ask.
 */

export type RunWhy = 'only-main' | 'main-name';
export type SubmitWhy = 'named-in-run' | 'student' | 'stub';

export interface FolderRoles {
  run: { file: string; why: RunWhy } | null;
  submit: { file: string; why: SubmitWhy } | null;
  /** Files with `main()` (choices for the run file when it must be asked). */
  runCandidates: string[];
}

/**
 * A file at the top of a workspace folder that holds a whole package (both
 * roles found) gets folder mode when it was matched for sure. A suggestion
 * isn't: nothing about a guess should change which file Submit sends.
 */
export function isRootPackage(source: string, roles: Pick<FolderRoles, 'run' | 'submit'>): boolean {
  return (source === 'filename' || source === 'cph') && !!roles.run && !!roles.submit;
}

const SOURCE = /\.(c|cc|cpp|cxx)$/i;
/** `main(` at the start of a line, optionally after a return type. */
const HAS_MAIN = /^[ \t]*(?:(?:int|signed|void|auto)[ \t]+)?main[ \t]*\(/m;
/** Stub comments as seen in course packages ("// your code here", "//  you have to write something below this line", TODO). */
export const STUB = /(?:your|write|add|put)\b[^\n]{0,40}\b(?:code|here|something|below|implementation)\b|\bTODO\b|\bimplement (?:this|here)/i;

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
const stripStrings = (s: string) => s.replace(/"(?:\\.|[^"\\\n])*"/g, '""').replace(/'(?:\\.|[^'\\\n])*'/g, "''");
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does this C/C++ source define `main`? */
export function hasMain(text: string): boolean {
  return HAS_MAIN.test(stripStrings(stripComments(text)));
}

/** Local files reached from `from` through `#include "…"` (not `from` itself), in discovery order. */
export function includeClosure(files: ReadonlyMap<string, string>, from: string): string[] {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const p = queue.shift()!;
    for (const m of stripComments(files.get(p) ?? '').matchAll(/^[ \t]*#[ \t]*include[ \t]*"([^"]+)"/gm)) {
      const hit = [normalize(dirOf(p) + m[1]), normalize(m[1])].find((x) => files.has(x));
      if (hit && hit !== from && !seen.has(hit)) {
        seen.add(hit);
        queue.push(hit);
      }
    }
  }
  return [...seen];
}

/** "a/./b/../c.h" → "a/c.h" (relative, "/" separators). */
function normalize(p: string): string {
  const out: string[] = [];
  for (const s of p.replace(/\\/g, '/').split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}

/** `files`: relative path ("/" separators) → text, for the folder's C/C++ sources and headers. */
export function detectFolderRoles(files: ReadonlyMap<string, string>): FolderRoles {
  const runCandidates = [...files.keys()].filter((p) => SOURCE.test(p) && hasMain(files.get(p)!)).sort();
  const named = runCandidates.filter((p) => /^main/i.test(base(p)));
  const run: FolderRoles['run'] =
    runCandidates.length === 1 ? { file: runCandidates[0], why: 'only-main' } : named.length === 1 ? { file: named[0], why: 'main-name' } : null;
  if (!run) return { run: null, submit: null, runCandidates };
  return { run, submit: submitFor(files, run.file), runCandidates };
}

/** The submit file for a given run file (also used when the user chose the run file). */
export function submitFor(files: ReadonlyMap<string, string>, run: string): FolderRoles['submit'] {
  const closure = includeClosure(files, run);
  const runText = files.get(run) ?? '';
  const comments = (runText.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) ?? []).join('\n');
  const one = (list: string[], why: SubmitWhy) => (list.length === 1 ? { file: list[0], why } : null);
  const mentioned = STUB.test(comments) ? closure.filter((c) => new RegExp(`\\b${escapeRe(base(c))}\\b`).test(comments)) : [];
  const student = closure.filter((c) => /^student\./i.test(base(c)));
  const stubbed = closure.filter((c) => STUB.test(files.get(c) ?? ''));
  return one(mentioned, 'named-in-run') ?? one(student, 'student') ?? one(stubbed, 'stub');
}

/** C/C++ sources and headers (role detection reads these). */
export const CODE_FILE = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i;

/** Why a folder's submit / run file is what it is (tooltip in the card). */
export type RoleWhy = SubmitWhy | RunWhy | 'chosen' | 'only-file';

/** A folder's state for the role rules: its source files (relative, "/"), the user's choices, the C/C++ texts and what detection found. */
export interface FolderState {
  files: string[];
  submitFile?: string;
  runFile?: string;
  texts: ReadonlyMap<string, string>;
  roles: FolderRoles | null;
}

/**
 * The file Submit sends / CPH runs, with why: the user's choice (while it is
 * still a file of the folder), else detected (a chosen run file decides the
 * submit file), else the folder's only source file (submit only); null = asked when needed.
 */
export function folderRole(role: 'submit' | 'run', f: FolderState): { file: string; why: RoleWhy } | null {
  const has = (x: string | undefined) => !!x && f.files.some((y) => pathKey(y) === pathKey(x));
  const chosen = role === 'submit' ? f.submitFile : f.runFile;
  if (has(chosen)) return { file: chosen!, why: 'chosen' };
  if (role === 'run') return f.roles?.run ?? null;
  const detected = (has(f.runFile) ? submitFor(f.texts, f.runFile!) : null) ?? f.roles?.submit ?? null;
  if (detected) return detected;
  return f.files.length === 1 ? { file: f.files[0], why: 'only-file' } : null;
}

/** The choices when the run file must be asked: files with `main()`, else every C/C++ source. */
export function runChoices(files: string[], roles: FolderRoles | null): string[] {
  return roles?.runCandidates.length ? roles.runCandidates : files.filter((x) => SOURCE.test(x));
}

/** C/C++ sources of the folder (the card's Runs dropdown). */
export function runSources(files: string[]): string[] {
  return files.filter((x) => SOURCE.test(x));
}

/** The file that stands for a folder (row click, notice, newer-file check): chosen submit file, else detected submit, else run, else the first source file. */
export function standInFile(files: string[], chosenSubmit: string | undefined, roles: FolderRoles | null): string | null {
  if (!files.length) return null;
  if (chosenSubmit && files.includes(chosenSubmit)) return chosenSubmit;
  return roles?.submit?.file ?? roles?.run?.file ?? files[0];
}

/** `standInFile` needs the detected roles only without a usable chosen submit file. */
export function needsRolesForStandIn(files: string[], chosenSubmit: string | undefined): boolean {
  return files.length > 0 && !(chosenSubmit && files.includes(chosenSubmit));
}

/**
 * Submit with another source file of the folder open (e.g. main.cpp): ask
 * "submit the submit file or the open file?" only while the folder has no
 * chosen submit file and the open file is one of its source files.
 */
export function asksSubmitOrOpen(o: { openRel: string; targetRel: string; files: string[]; chosenSubmit: string | undefined }): boolean {
  return pathKey(o.openRel) !== pathKey(o.targetRel) && o.files.includes(o.openRel) && !o.chosenSubmit;
}
