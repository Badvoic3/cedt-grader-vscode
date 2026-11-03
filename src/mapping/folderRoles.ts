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

/**
 * The run file of a folder that isn't the active one (statement sample
 * import): the user's choice while it still exists → detected → the only
 * C/C++ source; null = ask. `files`: the folder's source files; `texts`: as
 * for detectFolderRoles.
 */
export function runFileFor(files: readonly string[], texts: ReadonlyMap<string, string>, chosen?: string): string | null {
  if (chosen && files.includes(chosen)) return chosen;
  const sources = files.filter((f) => SOURCE.test(f));
  return detectFolderRoles(texts).run?.file ?? (sources.length === 1 ? sources[0] : null);
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
