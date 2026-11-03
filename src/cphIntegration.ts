import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraderCase } from './mapping/cphImport';
import { normalizeEol } from './mapping/cphImport';
import { fileNameFor } from './mapping/match';

/**
 * Optional integration with Competitive Programming Helper (CPH).
 * The extension works fully without it; CPH is never a dependency or part of
 * an extension pack. Only this module decides whether CPH is installed.
 */
export const CPH_EXTENSION_ID = 'DivyanshuAgrawal.competitive-programming-helper';
/** CPH's public "Run test cases" command (no arguments: runs the active editor's file; CPH 2026.10). */
export const CPH_RUN_COMMAND = 'cph.runTestCases';

/**
 * CPH's setting that opens its panel on every switch to a source file
 * (`cph.general.autoShowJudge`, default on). That panel can cover ours, so
 * the panel offers once to turn it off.
 */
export const CPH_AUTO_SHOW_SECTION = 'cph';
export const CPH_AUTO_SHOW_KEY = 'general.autoShowJudge';

/** Where the setting is on (what `WorkspaceConfiguration.inspect` reports), or null when it is off. */
export type AutoShowScope = 'global' | 'workspace' | 'workspaceFolder' | 'default';

export interface AutoShowInspect {
  defaultValue?: unknown;
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/**
 * Which level turns CPH's auto-show on (the most specific one set wins, as in
 * VS Code), or null when it is off. Unset everywhere = CPH's default (on).
 */
export function cphAutoShowScope(i: AutoShowInspect | undefined): AutoShowScope | null {
  if (!i) return null;
  const levels: [AutoShowScope, unknown][] = [
    ['workspaceFolder', i.workspaceFolderValue],
    ['workspace', i.workspaceValue],
    ['global', i.globalValue],
    ['default', i.defaultValue ?? true],
  ];
  const [scope, value] = levels.find(([, v]) => v !== undefined) ?? ['default', true];
  return value === false ? null : scope;
}

/** The bits of `vscode.extensions` we need (injected, so tests run without VS Code). */
export interface ExtensionsApi {
  getExtension(id: string): unknown;
  onDidChange(listener: () => void): { dispose(): void };
}

/** Tracks whether CPH is installed and enabled (re-checked when extensions change). */
export class CphPresence {
  private current: boolean;
  private readonly sub: { dispose(): void };

  constructor(api: ExtensionsApi, onChange: (installed: boolean) => void = () => {}) {
    this.current = !!api.getExtension(CPH_EXTENSION_ID);
    this.sub = api.onDidChange(() => {
      const now = !!api.getExtension(CPH_EXTENSION_ID);
      if (now !== this.current) {
        this.current = now;
        onChange(now);
      }
    });
  }

  get installed(): boolean {
    return this.current;
  }

  dispose(): void {
    this.sub.dispose();
  }
}

/** Where "Load test cases" writes: CPH's .prob when CPH is installed, else files (remembered) or ask. */
export type TestcaseTarget = 'cph' | 'files' | 'ask';

export function chooseTestcaseTarget(cphInstalled: boolean, remembered: 'files' | undefined): TestcaseTarget {
  if (cphInstalled) return 'cph';
  return remembered === 'files' ? 'files' : 'ask';
}

/** `<source dir>/<clean problem name>/tests` */
export function testsFolderFor(sourceDir: string, problemName: string): string {
  const folder = fileNameFor(problemName, 'x').replace(/\.x$/, '');
  return join(sourceDir, folder, 'tests');
}

export interface SaveFilesResult {
  folder: string;
  written: number;
  /** Already there with the same content. */
  unchanged: number;
  /** Already there with different content: never overwritten. */
  keptExisting: number;
}

/**
 * Write `<prefix><num>.in` / `<prefix><num>.out` per case. Line endings `\n`,
 * trailing newlines kept. Existing files are never overwritten. Statement
 * samples use the prefix `sample` so they never collide with grader cases.
 */
export async function saveTestcasesAsFiles(folder: string, cases: GraderCase[], prefix = ''): Promise<SaveFilesResult> {
  await mkdir(folder, { recursive: true });
  let written = 0;
  let unchanged = 0;
  let keptExisting = 0;
  for (const c of [...cases].sort((a, b) => a.num - b.num)) {
    let caseWritten = false;
    let caseKept = false;
    for (const [ext, text] of [['in', c.input], ['out', c.output]] as const) {
      const path = join(folder, `${prefix}${c.num}.${ext}`);
      const content = normalizeEol(text);
      let existing: string | null = null;
      try {
        if ((await stat(path)).isFile()) existing = await readFile(path, 'utf8');
      } catch {
        existing = null;
      }
      if (existing === null) {
        await writeFile(path, content, { flag: 'wx' });
        caseWritten = true;
      } else if (existing !== content) {
        caseKept = true;
      }
    }
    if (caseWritten) written++;
    else if (caseKept) keptExisting++;
    else unchanged++;
  }
  return { folder, written, unchanged, keptExisting };
}

