import { readFile } from 'node:fs/promises';
import { basename, dirname, join, parse } from 'node:path';
import type { CaseSource } from '../runner/types';

/**
 * Reads old Competitive Programming Helper problem files, for the one-time
 * import only: nothing else may use this, and it writes nothing
 * (`test/retiredCph.test.ts`). No `vscode` import.
 *
 * Format confirmed from CPH 2026.10 and real `.prob` files:
 *   path = <dirname(src)>/.cph/.<basename(src)>_<md5(src)>.prob
 *          or <cph.general.saveLocation>/.<basename(src)>_<md5(src)>.prob
 *   JSON = { name, url, tests:[{id,input,output}], interactive, memoryLimit,
 *            timeLimit, srcPath, group, local }
 * The md5 is of the path when the file was made, so a renamed or moved source
 * is found by scanning, not by working out the name.
 */
export interface CphTest {
  id: number;
  input: string;
  output: string;
}

export interface CphProblem {
  name: string;
  url: string;
  tests: CphTest[];
  srcPath: string;
}

/** 7e15: a safe integer, far above CPH ms-timestamp ids (~1.8e12). Grader cases: GRADER_ID_BASE + grader testcase id. */
export const GRADER_ID_BASE = 7_000_000_000_000_000;
/** Statement samples: STATEMENT_ID_BASE + their number (1, 2, …). Above every grader marker, below MAX_SAFE_INTEGER. */
export const STATEMENT_ID_BASE = 7_500_000_000_000_000;

const ID_IN_URL = [
  /\/submissions\/direct_edit_problem\/(\d+)/,
  /\/submissions\/prob\/(\d+)/,
  /\/problems\/(\d+)(?:\/|$)/,
  /\/testcases\/show_problem\/(\d+)/,
];

/** `.cph/<file>.prob`, in a path relative to a folder. */
export const isProbPath = (rel: string): boolean => /(^|\/)\.cph\/[^/]+\.prob$/.test(rel);

/** A `.prob` file, or null when it can't be used. */
export async function readProb(path: string): Promise<CphProblem | null> {
  try {
    const p = JSON.parse(await readFile(path, 'utf8')) as Partial<CphProblem> | null;
    if (!p || !Array.isArray(p.tests)) return null;
    const tests = p.tests.filter((t) => typeof t?.input === 'string' && typeof t?.output === 'string');
    return { name: typeof p.name === 'string' ? p.name : '', url: typeof p.url === 'string' ? p.url : '', srcPath: typeof p.srcPath === 'string' ? p.srcPath : '', tests };
  } catch {
    return null;
  }
}

/** The file a `.prob` belongs to: the one its name gives next to `.cph/` (in a moved or copied folder `srcPath` is out of date), else `srcPath`. */
export function sourceOf(probPath: string, srcPath: string, exists: (path: string) => boolean): string {
  const m = /^\.(.+)_[0-9a-f]{32}\.prob$/.exec(basename(probPath));
  const beside = m && basename(dirname(probPath)) === '.cph' ? join(dirname(dirname(probPath)), m[1]) : null;
  return beside && exists(beside) ? beside : srcPath;
}

/** A web address on another host: a problem from another judge. CPH's local problems store a file path, which isn't one. */
function onOtherJudge(url: string, baseUrl: string): boolean {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && u.host !== new URL(baseUrl).host;
  } catch {
    return false;
  }
}

/** The problem a URL on this server points at. */
export function problemIdInUrl(url: string, baseUrl: string): number | null {
  try {
    const u = new URL(url);
    if (u.host !== new URL(baseUrl).host) return null;
    for (const re of ID_IN_URL) {
      const m = re.exec(u.pathname);
      if (m) return Number(m[1]);
    }
  } catch {
    /* not a URL (CPH's local problems store the file path) */
  }
  return null;
}

export interface ProbPlan {
  /** Tied to this grader: imported, and part of the cleanup. Anything else belongs to CPH and is left alone. */
  ours: boolean;
  /** Where the cases go; null = the file's own list. */
  problemId: number | null;
  /** The link to save for the source file. */
  linkTo: number | null;
}

/**
 * What to do with one `.prob`. `linked`: the problem the source is linked to;
 * `nameMatch`: what its name or folder matches for sure; `known`: is this
 * problem in the list? A link to one that isn't would only show "unavailable".
 */
export function planProb(p: Pick<CphProblem, 'url' | 'tests'>, baseUrl: string, linked: number | null, nameMatch: number | null, known: (id: number) => boolean): ProbPlan {
  const marked = p.tests.some((t) => t.id >= GRADER_ID_BASE);
  if (!marked && onOtherJudge(p.url, baseUrl)) return { ours: false, problemId: null, linkTo: null };
  const inUrl = problemIdInUrl(p.url, baseUrl);
  const byUrl = inUrl !== null && known(inUrl) ? inUrl : null;
  const problemId = byUrl ?? linked ?? nameMatch;
  return { ours: marked || inUrl !== null || problemId !== null, problemId, linkTo: linked === null ? byUrl : null };
}

export interface OldCase {
  input: string;
  expected: string;
  testcaseId?: number;
}

/** A `.prob`'s tests by their badge: the id says where each came from. */
export function casesBySource(tests: readonly CphTest[]): Record<CaseSource, OldCase[]> {
  const out: Record<CaseSource, OldCase[]> = { grader: [], sample: [], custom: [] };
  for (const t of tests) {
    const c = { input: t.input, expected: t.output };
    if (t.id >= STATEMENT_ID_BASE) out.sample.push(c);
    else if (t.id >= GRADER_ID_BASE) out.grader.push({ ...c, testcaseId: t.id - GRADER_ID_BASE });
    else out.custom.push(c);
  }
  return out;
}

/** The binary CPH leaves beside a source. */
export function binaryOf(src: string): string {
  return join(dirname(src), `${parse(src).name}.bin`);
}
