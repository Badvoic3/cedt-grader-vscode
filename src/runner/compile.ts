import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { RUNNER } from '../shared/constants';
import { S } from '../shared/strings';
import type { RunnerLanguage, Toolset } from './languages';
import { runToEnd } from './process';
import type { CompileFailure, ProcessApi } from './types';

/**
 * Turns source files into something to run. Flags match the grader
 * (`-DEVAL -std=gnu++17 -O2`, `-iquote`), and nothing is ever written next to
 * the sources: a build is `<root>/<hash>/`, reused while the hash of the
 * sources, their local includes, the flags and the compiler stays the same.
 */
export interface BuildInput {
  language: RunnerLanguage;
  /** Folder mode: the package folder; else the file's folder. */
  folder: string;
  /** Absolute paths; the first is the program. */
  sources: readonly string[];
  tools: Toolset;
  extraArgs?: readonly string[];
  signal?: AbortSignal;
}

export interface Program {
  command: string;
  args: string[];
  /** Compiled just now, not reused: the first case may be slowed by antivirus. */
  fresh: boolean;
  /** Compiler text of a successful build. */
  warnings: string;
}

/** `failure: null`: stopped by the user. */
export type BuildResult = { ok: true; program: Program } | { ok: false; failure: CompileFailure | null };

const INTERPRETED: ReadonlySet<RunnerLanguage> = new Set(['python', 'javascript', 'php', 'ruby']);
const HEADER = /\.(?:h|hh|hpp|hxx)$/i;

export interface CommandInput {
  language: RunnerLanguage;
  folder: string;
  sources: readonly string[];
  tools: Toolset;
  outDir: string;
  platform: NodeJS.Platform;
  extraArgs?: readonly string[];
}

const programName = (platform: NodeJS.Platform) => (platform === 'win32' ? 'prog.exe' : 'prog');

function stackFlag(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') return [`-Wl,-stack_size,0x${RUNNER.stackBytes.toString(16)}`];
  if (platform === 'win32') return [`-Wl,--stack,${RUNNER.stackBytes}`];
  return []; // Linux: `ulimit -s` when it runs (runCommand)
}

/** The compile command (no shell, so spaces and Thai in paths need nothing); null for a language with no compile step. */
export function compileCommand(i: CommandInput): { command: string; args: string[] } | null {
  const tool = i.tools.compiler;
  if (!tool) return null;
  const out = join(i.outDir, programName(i.platform));
  const extra = i.extraArgs ?? [];
  const run = i.sources[0];
  switch (i.language) {
    case 'cpp':
    case 'c': {
      const std = i.language === 'cpp' ? '-std=gnu++17' : '-std=gnu17';
      const asSource = HEADER.test(run) ? ['-x', i.language === 'cpp' ? 'c++' : 'c'] : [];
      return {
        command: tool.path,
        args: [
          ...tool.args, '-o', out, '-iquote', i.folder, '-DEVAL', std, '-O2', '-pipe', '-Wall', '-Wextra', '-fdiagnostics-color=never',
          ...(i.platform === 'win32' ? ['-static'] : []), // no DLL mismatch; macOS can't link static, Linux may lack the static libraries
          ...stackFlag(i.platform), ...extra, ...asSource, ...i.sources,
        ],
      };
    }
    case 'java':
      return { command: tool.path, args: [...tool.args, '-encoding', 'UTF-8', '-d', i.outDir, ...extra, run] };
    case 'rust':
      return { command: tool.path, args: [...tool.args, '-O', '-o', out, ...extra, run] };
    case 'go':
      return { command: tool.path, args: [...tool.args, 'build', '-o', out, ...extra, run] };
    case 'haskell':
      return { command: tool.path, args: [...tool.args, '-O2', '-outputdir', i.outDir, '-o', out, ...extra, run] };
    default:
      return null;
  }
}

/** The class to start: the one holding `main`, with its package. */
export function javaMainClass(text: string, fileStem: string): string {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(code)?.[1];
  const at = code.search(/\bstatic\s+void\s+main\s*\(|\bvoid\s+static\s+main\s*\(/);
  const owners = at < 0 ? [] : [...code.slice(0, at).matchAll(/\bclass\s+(\w+)/g)];
  const cls = owners.at(-1)?.[1] ?? fileStem;
  return pkg ? `${pkg}.${cls}` : cls;
}

/** How to start what `compileCommand` made, or the source itself for an interpreted language. */
export function runCommand(i: Omit<CommandInput, 'extraArgs'>, runFileText = ''): { command: string; args: string[] } {
  const run = i.sources[0];
  const binary = join(i.outDir, programName(i.platform));
  const rt = i.tools.runtime;
  switch (i.language) {
    case 'python':
    case 'javascript':
    case 'php':
    case 'ruby':
      return { command: rt!.path, args: [...rt!.args, run] };
    case 'java':
      return { command: rt!.path, args: [...rt!.args, '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-Xss512m', '-cp', i.outDir, javaMainClass(runFileText, basename(run).replace(/\.[^.]*$/, ''))] };
    case 'cpp':
    case 'c':
      // No shell text is built from a path: `$0` is the program.
      if (i.platform === 'linux') return { command: '/bin/sh', args: ['-c', 'ulimit -s unlimited 2>/dev/null; exec "$0"', binary] };
      return { command: binary, args: [] };
    default:
      return { command: binary, args: [] };
  }
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** The first error's place, for the `g++`/`clang`, `javac`, `rustc`, `go` and `ghc` formats. Windows paths keep their `C:`. */
export function parseCompileError(text: string): Pick<CompileFailure, 'file' | 'line'> {
  const clean = text.replace(ANSI, '');
  const m =
    /^(.+?):(\d+)(?::\d+)?:\s*(?:fatal\s+)?error\b/m.exec(clean) ?? // g++, clang, javac, ghc
    /^\s*-->\s*(.+?):(\d+):\d+/m.exec(clean) ?? // rustc
    /^(\S+\.go):(\d+):\d+:/m.exec(clean); // go
  return m ? { file: m[1], line: Number(m[2]) } : { file: null, line: null };
}

function failureFrom(text: string): CompileFailure {
  const message = text.replace(ANSI, '').trim().slice(0, RUNNER.compileMessageChars);
  return { message, ...parseCompileError(message), ...(/bits\/stdc\+\+\.h['"]? file not found/.test(message) ? { hint: S.runner.bitsStdc } : {}) };
}

/** The sources and every local file they reach with `#include "…"`, relative to the includer, then the folder. Missing files are skipped. */
export async function localFiles(sources: readonly string[], folder: string, read: (p: string) => Promise<string | null>): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const queue = [...sources];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    if (found.has(p)) continue;
    const text = await read(p);
    if (text === null) continue;
    found.set(p, text);
    for (const m of text.matchAll(/^[ \t]*#[ \t]*include[ \t]*"([^"]+)"/gm)) queue.push(join(dirname(p), m[1]), join(folder, m[1]));
  }
  return found;
}

/** Windows toolchains break on non-ASCII paths (engine research, §5): such a build happens in a staged copy. */
export function needsStaging(paths: readonly string[], platform: NodeJS.Platform): boolean {
  return platform === 'win32' && paths.some((p) => /[^\x20-\x7e]/.test(p));
}

/** Where builds go. A Windows temp folder under a Thai user name can't be used by the toolchains, so an ASCII one replaces it. */
export function buildRoot(platform: NodeJS.Platform, tmp: string, env: NodeJS.ProcessEnv): string {
  const base = needsStaging([tmp], platform) ? (env.ProgramData ?? 'C:\\ProgramData') : tmp;
  return join(base, 'cedt-grader-bin');
}

export class Builder {
  private fallback = false;

  constructor(
    private readonly proc: ProcessApi,
    private readonly o: {
      platform: NodeJS.Platform;
      /** `<tmp>/cedt-grader-bin`. */
      root: string;
      /** `<globalStorage>/bin`, for a temp folder mounted `noexec`. */
      fallbackRoot: string;
      env?: NodeJS.ProcessEnv;
    },
  ) {}

  /** The build folder can't run programs: use the other one for the rest of the session. */
  useFallback(): boolean {
    if (this.fallback) return false;
    this.fallback = true;
    return true;
  }

  get root(): string {
    return this.fallback ? this.o.fallbackRoot : this.o.root;
  }

  private env(): NodeJS.ProcessEnv {
    const env = { ...(this.o.env ?? process.env) };
    if (this.o.platform !== 'win32') env.LC_ALL = 'C'; // compiler messages the parser knows
    else env.TMP = env.TEMP = this.root;
    return env;
  }

  async build(i: BuildInput): Promise<BuildResult> {
    const platform = this.o.platform;
    const base = { language: i.language, folder: i.folder, sources: i.sources, tools: i.tools, platform };
    const files = await localFiles(i.sources, i.folder, (p) => readFile(p, 'utf8').catch(() => null));
    if (INTERPRETED.has(i.language)) return { ok: true, program: { ...runCommand({ ...base, outDir: '' }), fresh: false, warnings: '' } };

    const hash = createHash('sha256');
    for (const part of [i.language, platform, i.tools.compiler?.path ?? '', i.tools.compiler?.version ?? '', ...(i.extraArgs ?? [])]) hash.update(`${part}\0`);
    for (const [p, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(`${relative(i.folder, p)}\0${text}\0`);
    const outDir = join(this.root, hash.digest('hex').slice(0, 32));
    const text = files.get(i.sources[0]) ?? '';
    const ready = () => ({ ...runCommand({ ...base, outDir }, text) });
    if (await stat(outDir).then((s) => s.isDirectory(), () => false)) return { ok: true, program: { ...ready(), fresh: false, warnings: '' } };

    await mkdir(this.root, { recursive: true });
    const work = `${outDir}.${randomBytes(4).toString('hex')}.tmp`;
    await mkdir(work, { recursive: true });
    try {
      const staged = needsStaging([i.folder, ...i.sources, this.root], platform) ? await this.stage(i, files, work) : null;
      const cmd = compileCommand({ ...base, folder: staged?.folder ?? i.folder, sources: staged?.sources ?? i.sources, outDir: work, extraArgs: i.extraArgs })!;
      const r = await runToEnd(this.proc, cmd.command, cmd.args, { timeoutMs: RUNNER.compileTimeoutMs, maxBytes: 4 * RUNNER.compileMessageChars, cwd: staged?.folder ?? i.folder, env: this.env(), signal: i.signal });
      if (i.signal?.aborted) return { ok: false, failure: null };
      if (r.timedOut) return { ok: false, failure: { message: S.runner.compileTimedOut, file: null, line: null } };
      if (r.spawnError) return { ok: false, failure: { message: S.runner.compilerFailed(r.spawnError.message), file: null, line: null } };
      const said = `${r.stderr}\n${r.stdout}`.trim();
      if (r.code !== 0) return { ok: false, failure: failureFrom(said) };
      if (staged) await rm(staged.folder, { recursive: true, force: true });
      await rename(work, outDir).catch(() => {}); // lost a race to an identical build: that one is used
      await this.prune();
      return { ok: true, program: { ...ready(), fresh: true, warnings: said.slice(0, RUNNER.compileMessageChars) } };
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Copy the sources and headers with the same layout under an ASCII folder. */
  private async stage(i: BuildInput, files: ReadonlyMap<string, string>, work: string): Promise<{ folder: string; sources: string[] }> {
    const folder = join(work, 'src');
    const inside = (p: string) => relative(i.folder, p);
    for (const p of files.keys()) {
      const rel = inside(p);
      if (rel.startsWith(`..${sep}`)) continue;
      await mkdir(dirname(join(folder, rel)), { recursive: true });
      await copyFile(p, join(folder, rel));
    }
    return { folder, sources: i.sources.map((s) => join(folder, inside(s))) };
  }

  /** Keep the newest builds; the temp folder isn't emptied on every system. */
  private async prune(): Promise<void> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    if (names.length <= RUNNER.keepBuilds) return;
    const dated = await Promise.all(names.map(async (n) => ({ n, at: await stat(join(this.root, n)).then((s) => s.mtimeMs, () => 0) })));
    dated.sort((a, b) => b.at - a.at);
    for (const { n } of dated.slice(RUNNER.keepBuilds)) await rm(join(this.root, n), { recursive: true, force: true }).catch(() => {});
  }
}
