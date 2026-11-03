import { S } from '../shared/strings';
import { importIntoCph } from './cphImport';
import { CASE_MARKERS, type CaseKind, type GraderCase, saveTestcasesAsFiles } from './testCases';

/**
 * The one "cases → target" step (no `vscode` import; unit tested): grader
 * test cases and statement samples go through here, into CPH's `.prob` or
 * into `.in` / `.out` files, with the rules of testCases.ts (markers,
 * duplicates, `.bak`, never overwrite).
 */
export type CaseTarget =
  | { kind: 'cph'; srcPath: string; saveLocation?: string; problemName: string; problemUrl: string }
  | { kind: 'files'; folder: string };

export type CaseWriteResult =
  | { target: 'cph'; added: number; updated: number; alreadyPresent: number; total: number; backupPath: string | null }
  | { target: 'files'; folder: string; written: number; unchanged: number; keptExisting: number; alreadyPresent: number };

export async function writeCases(target: CaseTarget, cases: GraderCase[], kind: CaseKind): Promise<CaseWriteResult> {
  const marker = CASE_MARKERS[kind];
  if (target.kind === 'files') return { target: 'files', ...(await saveTestcasesAsFiles(target.folder, cases, marker.filePrefix)) };
  const r = await importIntoCph({ ...target, cases, idBase: marker.idBase });
  return { target: 'cph', added: r.added, updated: r.updated, alreadyPresent: r.alreadyPresent, total: r.total, backupPath: r.backupPath };
}

/** The counts after a write, as message parts ("2 already present", "1 added", …); zero counts left out. */
export function caseCounts(r: CaseWriteResult): string[] {
  if (r.target === 'cph') {
    return [r.alreadyPresent ? S.testcases.alreadyPresent(r.alreadyPresent) : '', r.updated ? S.testcases.updated(r.updated) : '', r.added ? S.testcases.added(r.added) : ''].filter(Boolean);
  }
  return [r.unchanged ? S.testcases.unchanged(r.unchanged) : '', r.alreadyPresent ? S.testcases.alreadyPresent(r.alreadyPresent) : '', r.keptExisting ? S.testcases.keptExisting(r.keptExisting) : ''].filter(Boolean);
}
