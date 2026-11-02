import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Problem } from '../grader/types';

/**
 * Read-only access to Competitive Programming Helper problem files.
 *
 * Format confirmed from CPH 2026.10 (dist/extension.js `getProbSaveLocation`)
 * and real `.prob` files:
 *   path = <dirname(src)>/.cph/.<basename(src)>_<md5(src)>.prob
 *          or <cph.general.saveLocation>/.<basename(src)>_<md5(src)>.prob
 *   JSON = { name, url, tests:[{id,input,output}], interactive, memoryLimit,
 *            timeLimit, srcPath, group, local }
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
  interactive: boolean;
  memoryLimit: number;
  timeLimit: number;
  srcPath: string;
  group: string;
  local: boolean;
  [extra: string]: unknown;
}

export function cphProbPath(srcPath: string, saveLocation?: string): string {
  const file = `.${basename(srcPath)}_${createHash('md5').update(srcPath).digest('hex')}.prob`;
  return saveLocation && saveLocation !== '' ? join(saveLocation, file) : join(dirname(srcPath), '.cph', file);
}

export async function readCphProblem(srcPath: string, saveLocation?: string): Promise<CphProblem | null> {
  try {
    const text = await readFile(cphProbPath(srcPath, saveLocation), 'utf8');
    const p = JSON.parse(text) as CphProblem;
    return p && typeof p === 'object' && Array.isArray(p.tests) ? p : null;
  } catch {
    return null;
  }
}

const ID_IN_URL = [
  /\/submissions\/direct_edit_problem\/(\d+)/,
  /\/submissions\/prob\/(\d+)/,
  /\/problems\/(\d+)(?:\/|$)/,
  /\/testcases\/show_problem\/(\d+)/,
];

/**
 * Problem a CPH file points at, if any: a grader URL on the same host, or a
 * problem name (CPH local problems are named `Local: <file>`).
 */
export function matchCphProblem(cph: CphProblem, problems: Problem[], baseUrl: string): Problem | null {
  try {
    const u = new URL(cph.url);
    if (u.host === new URL(baseUrl).host) {
      for (const re of ID_IN_URL) {
        const m = re.exec(u.pathname);
        if (m) {
          const p = problems.find((x) => x.id === Number(m[1]));
          if (p) return p;
        }
      }
    }
  } catch {
    /* not a URL (local problems store the file path) */
  }
  const name = (cph.name ?? '').replace(/^Local:\s*/i, '').trim().toLowerCase();
  if (!name) return null;
  const hits = problems.filter((p) => p.name.toLowerCase() === name || p.fullName.toLowerCase() === name);
  return hits.length === 1 ? hits[0] : null;
}
