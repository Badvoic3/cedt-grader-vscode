import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { cphProbPath, type CphProblem, type CphTest } from './cph';

/**
 * Writes grader test cases into CPH's `.prob` file in CPH's own format
 * (confirmed in agrawal-d/cph src/types.ts + src/parser.ts @ ef8c7a7):
 *   path  `<dir>/.cph/.<basename>_<md5(srcPath)>.prob` (or cph.general.saveLocation)
 *   JSON  { name, url, interactive, memoryLimit, timeLimit, group, tests: [{ input, output, id }], srcPath, local? }
 *   CPH writes it with plain JSON.stringify (no indentation); so do we.
 *
 * Imported cases are marked through their `id` (the only per-test field CPH
 * keeps when it re-saves): GRADER_ID_BASE + grader testcase id. A re-import
 * updates those in place; the user's own tests are never touched.
 */
export const GRADER_ID_BASE = 7_000_000_000_000_000; // 7e15: a safe integer, far above CPH ms-timestamp ids (~1.8e12)

export interface GraderCase {
  testcaseId: number;
  num: number;
  input: string;
  output: string;
}

export interface ImportResult {
  probPath: string;
  created: boolean;
  backupPath: string | null;
  added: number;
  updated: number;
  /** Already in the file (same id with same content, or same input+output as one of your tests). */
  alreadyPresent: number;
  /** Total tests in the file afterwards. */
  total: number;
}

/** `\r\n` / `\r` → `\n`; trailing newlines are kept exactly as in the file. */
export function normalizeEol(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

export const isGraderTest = (t: CphTest) => t.id >= GRADER_ID_BASE;

export async function importIntoCph(opts: {
  srcPath: string;
  saveLocation?: string;
  problemName: string;
  problemUrl: string;
  cases: GraderCase[];
}): Promise<ImportResult> {
  const probPath = cphProbPath(opts.srcPath, opts.saveLocation);
  let existing: CphProblem | null = null;
  let raw: string | null = null;
  try {
    raw = await readFile(probPath, 'utf8');
    existing = JSON.parse(raw) as CphProblem;
    if (!existing || !Array.isArray(existing.tests)) throw new Error('not a CPH problem file');
  } catch (err) {
    if (raw !== null) throw new Error(`The CPH file ${probPath} could not be read (${err instanceof Error ? err.message : err}); not changed.`);
    existing = null;
  }

  let backupPath: string | null = null;
  if (existing && raw !== null) {
    backupPath = `${probPath}.bak`;
    await copyFile(probPath, backupPath);
  }

  const problem: CphProblem = existing ?? {
    name: opts.problemName,
    url: opts.problemUrl,
    interactive: false,
    memoryLimit: 1024,
    timeLimit: 3000,
    group: 'local',
    tests: [],
    srcPath: opts.srcPath,
    local: true,
  };

  const key = (t: { input: string; output: string }) => `${normalizeEol(t.input)}\u0000${normalizeEol(t.output)}`;
  let added = 0;
  let updated = 0;
  let alreadyPresent = 0;
  const tests = [...problem.tests];
  for (const c of [...opts.cases].sort((a, b) => a.num - b.num)) {
    const input = normalizeEol(c.input);
    const output = normalizeEol(c.output);
    const id = GRADER_ID_BASE + c.testcaseId;
    const mine = tests.findIndex((t) => t.id === id);
    if (mine >= 0) {
      if (tests[mine].input === input && tests[mine].output === output) alreadyPresent++;
      else {
        tests[mine] = { ...tests[mine], input, output };
        updated++;
      }
      continue;
    }
    if (tests.some((t) => key(t) === key({ input, output }))) {
      alreadyPresent++;
      continue;
    }
    tests.push({ id, input, output });
    added++;
  }
  problem.tests = tests;

  await mkdir(dirname(probPath), { recursive: true });
  await writeFile(probPath, JSON.stringify(problem));
  return { probPath, created: !existing, backupPath, added, updated, alreadyPresent, total: tests.length };
}
