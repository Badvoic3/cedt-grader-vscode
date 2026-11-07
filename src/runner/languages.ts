import { fileExt } from '../grader/languages';
import { runToEnd } from './process';
import type { ProcessApi } from './types';

/**
 * Which language a file is, and which tools on this computer run it. Folder
 * mode passes the `Runs` file here, so the language follows the program even
 * while `student.h` is the open editor.
 */
export type RunnerLanguage = 'cpp' | 'c' | 'python' | 'java' | 'javascript' | 'rust' | 'go' | 'php' | 'ruby' | 'haskell';

const BY_EXT: Readonly<Record<string, RunnerLanguage>> = {
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  c: 'c',
  py: 'python',
  java: 'java',
  js: 'javascript', mjs: 'javascript',
  rs: 'rust',
  go: 'go',
  php: 'php',
  rb: 'ruby',
  hs: 'haskell',
};

const BY_LANGUAGE_ID: Readonly<Record<string, RunnerLanguage>> = {
  cpp: 'cpp', c: 'c', python: 'python', java: 'java', javascript: 'javascript', rust: 'rust', go: 'go', php: 'php', ruby: 'ruby', haskell: 'haskell',
};

const BY_SHEBANG: readonly [RegExp, RunnerLanguage][] = [
  [/\bpython[\d.]*\b/, 'python'],
  [/\bnode\b/, 'javascript'],
  [/\bruby\b/, 'ruby'],
  [/\bphp\b/, 'php'],
];

const CPP_TOKENS = /#\s*include\s*<(?:iostream|vector|string|algorithm|map|set|queue|stack|list|deque|utility|bits\/stdc\+\+\.h)>|\busing\s+namespace\b|\bnamespace\s+\w|\bclass\s+\w|\btemplate\s*<|\bstd::/;

/** A grader language name ("C++", "cpp", "Python 3") → the runner's language; null when it can't run here (Pascal, …). */
export function runnerLanguageOfName(name: string): RunnerLanguage | null {
  const n = name.toLowerCase().trim();
  if (/^(?:c\+\+|cpp|g\+\+|cc|cxx)(?:$|[\s\d(-])/.test(n)) return 'cpp';
  if (/^(?:c|gcc)(?:$|[\s\d(-])/.test(n)) return 'c';
  if (/^(?:python|py)(?:$|[\s\d(-])/.test(n)) return 'python';
  if (/^java(?:$|[\s\d(-])/.test(n)) return 'java';
  if (/^(?:javascript|js|node)/.test(n)) return 'javascript';
  if (/^(?:rust|rs)(?:$|[\s\d(-])/.test(n)) return 'rust';
  if (/^(?:go|golang)(?:$|[\s\d(-])/.test(n)) return 'go';
  if (/^php/.test(n)) return 'php';
  if (/^(?:ruby|rb)(?:$|[\s\d(-])/.test(n)) return 'ruby';
  if (/^(?:haskell|ghc|hs)(?:$|[\s\d(-])/.test(n)) return 'haskell';
  return null;
}

export interface LanguageInput {
  path: string;
  /** The file's text, for `.h` files and shebangs. */
  text?: string;
  /** VS Code's `document.languageId`. */
  languageId?: string;
  /** Other files in the same folder, for `.h` files. */
  siblings?: readonly string[];
  /** The Submit language chosen for this file: one selector for both. */
  selected?: string | null;
  /** Names of the languages the problem permits (null: all). */
  permitted?: readonly string[] | null;
}

/** A `.h` file on its own: its neighbours, then its text, then what the problem permits. C++ when nothing says C. */
function headerLanguage(i: LanguageInput): RunnerLanguage {
  const exts = (i.siblings ?? []).map(fileExt);
  const cpp = exts.some((e) => e === 'cpp' || e === 'cc' || e === 'cxx');
  const c = exts.includes('c');
  if (cpp !== c) return cpp ? 'cpp' : 'c';
  if (CPP_TOKENS.test(i.text ?? '')) return 'cpp';
  const allowed = i.permitted?.map(runnerLanguageOfName);
  return c || (allowed?.includes('c') && !allowed.includes('cpp')) ? 'c' : 'cpp';
}

export function detectRunnerLanguage(i: LanguageInput): RunnerLanguage | null {
  const ext = fileExt(i.path);
  const chosen = i.selected ? runnerLanguageOfName(i.selected) : null;
  const fromFile = ext === 'h' ? headerLanguage(i) : (BY_EXT[ext] ?? null);
  // A chosen language settles C against C++ and names a file with no known extension. It never
  // turns `a.py` into C++: that is a mismatch Submit already reports.
  if (chosen && (!fromFile || ((fromFile === 'c' || fromFile === 'cpp') && (chosen === 'c' || chosen === 'cpp')))) return chosen;
  if (fromFile) return fromFile;
  const byId = i.languageId ? BY_LANGUAGE_ID[i.languageId] : undefined;
  if (byId) return byId;
  const first = /^#![^\n]*/.exec(i.text ?? '')?.[0];
  return first ? (BY_SHEBANG.find(([re]) => re.test(first))?.[1] ?? null) : null;
}

// ------------------------------------------------------------------ tools

export interface Tool {
  /** Absolute path, never a bare name: on Windows a bare name is looked up in the cwd first. */
  path: string;
  /** Arguments that are part of the tool (`py -3`). */
  args: string[];
  /** First line of its version text; part of the binary cache key. */
  version: string;
}

export interface Toolset {
  compiler?: Tool;
  runtime?: Tool;
}

export type ToolResult = { ok: true; tools: Toolset } | { ok: false; missing: string };

/** Candidates in the order tried; each is a command with its fixed arguments. */
const TOOLS: Readonly<Record<RunnerLanguage, { compiler?: string[][]; runtime?: string[][] }>> = {
  cpp: { compiler: [['g++'], ['clang++']] },
  c: { compiler: [['gcc'], ['clang']] },
  python: { runtime: [['python3'], ['python'], ['py', '-3']] },
  java: { compiler: [['javac']], runtime: [['java']] },
  javascript: { runtime: [['node']] },
  rust: { compiler: [['rustc']] },
  go: { compiler: [['go']] },
  php: { runtime: [['php']] },
  ruby: { runtime: [['ruby']] },
  haskell: { compiler: [['ghc']] },
};

/** `go version`, `java -version`: most tools take `--version`. */
const VERSION_ARGS: Readonly<Record<string, string[]>> = { go: ['version'], java: ['-version'], javac: ['-version'] };

export interface PathLookup {
  /** The `PATH` value. */
  path: string;
  platform: NodeJS.Platform;
  exists: (file: string) => boolean;
}

/**
 * `name` on `PATH`, as an absolute path. Relative entries are skipped (`.` on
 * `PATH` must not let a workspace plant a compiler). On Windows only `.exe`:
 * Node can't start a `.cmd` without a shell, and we never use one.
 */
export function findOnPath(name: string, l: PathLookup): string | null {
  const win = l.platform === 'win32';
  const absolute = win ? /^[a-zA-Z]:[\\/]/ : /^\//;
  const sep = win ? '\\' : '/';
  const file = win && !/\.exe$/i.test(name) ? `${name}.exe` : name;
  for (const dir of l.path.split(win ? ';' : ':')) {
    if (!absolute.test(dir)) continue;
    const full = `${dir.replace(/[\\/]+$/, '')}${sep}${file}`;
    if (l.exists(full)) return full;
  }
  return null;
}

/** Tools found so far: checked on first need, once per session (`reset` starts again). */
export class Toolchains {
  private readonly found = new Map<RunnerLanguage, Promise<ToolResult>>();

  constructor(
    private readonly proc: ProcessApi,
    private readonly lookup: () => PathLookup,
    /** `cedtGrader.runner.compilerPaths`: tool name → absolute path. */
    private readonly overrides: () => Readonly<Record<string, string>> = () => ({}),
  ) {}

  get(language: RunnerLanguage): Promise<ToolResult> {
    let r = this.found.get(language);
    if (!r) {
      r = this.probe(language);
      this.found.set(language, r);
    }
    return r;
  }

  reset(): void {
    this.found.clear();
  }

  private async probe(language: RunnerLanguage): Promise<ToolResult> {
    const want = TOOLS[language];
    const tools: Toolset = {};
    for (const role of ['compiler', 'runtime'] as const) {
      const candidates = want[role];
      if (!candidates) continue;
      for (const c of candidates) {
        const tool = await this.check(c, language);
        if (tool) {
          tools[role] = tool;
          break;
        }
      }
      if (!tools[role]) return { ok: false, missing: candidates.map((c) => c[0]).join(' / ') };
    }
    return { ok: true, tools };
  }

  /** Found and working: macOS ships a `java` that only says no JDK is installed, and Windows a `python` that opens the Store. */
  private async check([name, ...args]: string[], language: RunnerLanguage): Promise<Tool | null> {
    const l = this.lookup();
    const path = this.overrides()[name] || findOnPath(name, l);
    if (!path) return null;
    const r = await runToEnd(this.proc, path, [...args, ...(VERSION_ARGS[name] ?? ['--version'])], { timeoutMs: 10_000 });
    const version = `${r.stdout}\n${r.stderr}`.trim().split('\n')[0] ?? '';
    if (r.code !== 0 || (language === 'python' && !/^Python 3/.test(version))) return null;
    return { path, args, version };
  }
}
