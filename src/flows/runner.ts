import * as vscode from 'vscode';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isAtOrInside } from '../mapping/paths';
import { Builder, buildRoot, type Program } from '../runner/compile';
import { runCases } from '../runner/execute';
import { detectRunnerLanguage, type RunnerLanguage, Toolchains } from '../runner/languages';
import { nodeProcessApi } from '../runner/process';
import { allPassed, emptyState, type RunState, summarize } from '../runner/state';
import type { CaseList, CaseOwner, CaseRun, ProcessApi, RunLimits, RunnerCase, RunSummary } from '../runner/types';
import { RUNNER } from '../shared/constants';
import { S } from '../shared/strings';
import type { Host } from './host';

/** What one run works on, resolved from the active file. */
interface RunTarget {
  owner: CaseOwner;
  language: RunnerLanguage;
  folder: string;
  /** The program first. */
  sources: string[];
  leftOut: string[];
  /** The folder (folder mode) or the file whose unsaved edits are saved first. */
  saveScope: { folder: string } | { file: string };
}

export const ownerKey = (o: CaseOwner): string => ('file' in o ? `file:${o.file}` : `problem:${o.problemId}`);

/**
 * The built-in runner: a thin flow over `src/runner/*`. Results stay in memory
 * per list, so a file switch during a run loses nothing. One run at a time.
 * Every path out of a run, Stop and failures included, ends in `phase: 'idle'`.
 */
export class Runner {
  private readonly states = new Map<string, RunState>();
  private readonly tools: Toolchains;
  private readonly builder: Builder;
  private active: { abort: AbortController } | null = null;
  private notifyTimer: NodeJS.Timeout | undefined;
  /** The active file's list, for the panels (they render synchronously). */
  private list: CaseList | null = null;

  constructor(
    private readonly host: Host,
    private readonly proc: ProcessApi = nodeProcessApi,
  ) {
    this.tools = new Toolchains(
      proc,
      () => ({ path: process.env.PATH ?? process.env.Path ?? '', platform: process.platform, exists: existsSync }),
      () => host.cfg.runnerCompilerPaths,
    );
    this.builder = new Builder(proc, {
      platform: process.platform,
      root: buildRoot(process.platform, tmpdir(), process.env),
      fallbackRoot: join(host.ctx.globalStorageUri.fsPath, 'bin'),
    });
  }

  get running(): boolean {
    return !!this.active;
  }

  /** Whose list the active file shows: its problem, else the file itself. */
  owner(): CaseOwner | null {
    const h = this.host;
    if (h.problem) return { problemId: h.problem.id };
    return h.fileUri ? { file: h.fileUri.fsPath } : null;
  }

  private state(owner: CaseOwner): RunState {
    const key = ownerKey(owner);
    let s = this.states.get(key);
    if (!s) {
      s = emptyState();
      this.states.set(key, s);
    }
    return s;
  }

  summary(): RunSummary {
    const owner = this.owner();
    if (!owner) return { kind: 'no-cases' };
    return summarize(this.list?.cases ?? [], this.state(owner));
  }

  /** The active file changed: its list, after carrying over cases written before the file was linked. */
  async onActiveFile(): Promise<void> {
    const h = this.host;
    const owner = this.owner();
    // A suggestion is only a guess: the user's cases wait until the link is real.
    if (owner && 'problemId' in owner && h.fileUri && h.problem?.source !== 'suggested') await h.cases.moveUnlinked(h.fileUri.fsPath, owner);
    await this.reload(owner);
  }

  private async reload(owner = this.owner()): Promise<void> {
    this.list = owner ? await this.host.cases.read(owner) : null;
    this.host.emit();
  }

  /** A file or folder moved. */
  async onMoved(oldPath: string, newPath: string): Promise<void> {
    await this.host.cases.moved(oldPath, newPath);
    await this.reload();
  }

  /** Forget the results and stop what is running: another account or server starts clean. */
  reset(): void {
    this.stop();
    this.states.clear();
    this.list = null;
    this.tools.reset();
  }

  stop(): void {
    this.active?.abort.abort();
  }

  /** Run every case, or just `only`. Returns the summary when a run really ended; null when it didn't start. */
  async run(only?: readonly string[]): Promise<RunSummary | null> {
    if (this.active) return null;
    // Taken before the first await: a double click must not start two runs.
    const abort = new AbortController();
    this.active = { abort };
    let started = false;
    try {
      const h = this.host;
      if (!vscode.workspace.isTrusted) {
        void h.tellInline(null, S.runner.untrusted);
        return null;
      }
      const target = await this.target();
      if (!target) return null;
      await this.saveDirty(target);
      const list = await h.cases.read(target.owner);
      const cases = only ? list.cases.filter((c) => only.includes(c.id)) : list.cases;
      if (!cases.length) return null;

      const st = this.state(target.owner);
      started = true;
      for (const c of cases) st.runs.delete(c.id);
      Object.assign(st, { phase: 'compiling', failure: null, leftOut: target.leftOut, warnings: '' });
      this.changed(true);
      try {
        const program = await this.compile(target, st, abort.signal);
        if (program) {
          st.phase = 'running';
          await this.execute(target, program, cases, st, abort.signal);
        }
      } catch (err) {
        st.failure = { message: h.describe(err), file: null, line: null };
      } finally {
        st.phase = 'idle';
      }
      return summarize(list.cases, st);
    } finally {
      this.active = null;
      if (started) await this.reload();
    }
  }

  /** The main panel's Run tests: opens the split unless every case passed. */
  static shouldOpenTests(s: RunSummary | null): boolean {
    return !!s && !allPassed(s);
  }

  private async compile(t: RunTarget, st: RunState, signal: AbortSignal): Promise<Program | null> {
    const found = await this.tools.get(t.language);
    if (!found.ok) {
      st.failure = { message: S.runner.missingTool(found.missing), file: null, line: null };
      return null;
    }
    const r = await this.builder.build({ language: t.language, folder: t.folder, sources: t.sources, tools: found.tools, extraArgs: this.host.cfg.runnerExtraCompileArgs[t.language], signal });
    if (r.ok) {
      st.warnings = r.program.warnings;
      return r.program;
    }
    st.failure = r.failure;
    return null;
  }

  private async execute(t: RunTarget, program: Program, cases: readonly RunnerCase[], st: RunState, signal: AbortSignal): Promise<void> {
    const start = (p: Program) =>
      runCases({
        proc: this.proc,
        cases,
        program: p,
        limits: this.limits(),
        scratchRoot: tmpdir(),
        env: { ...process.env, PYTHONUTF8: '1' },
        platform: process.platform,
        signal,
        onUpdate: (run: CaseRun) => {
          st.runs.set(run.caseId, run);
          this.changed();
        },
      });
    const { noexec } = await start(program);
    if (!noexec) return;
    // A temp folder mounted `noexec`: build in the extension's storage for the rest of the session.
    for (const c of cases) st.runs.delete(c.id);
    if (!this.builder.useFallback()) {
      st.failure = { message: S.runner.compilerFailed('EACCES'), file: null, line: null };
      return;
    }
    const again = await this.compile(t, st, signal);
    if (again) await start(again);
  }

  private limits(): RunLimits {
    const c = this.host.cfg;
    return { timeMs: c.runnerDefaultTimeSeconds * 1000, memoryMB: c.runnerDefaultMemoryMB, source: 'default' };
  }

  private async target(): Promise<RunTarget | null> {
    const h = this.host;
    const owner = this.owner();
    const problem = h.currentProblem();
    if (h.folder.link && problem && !(await h.folder.askRole('run', problem))) return null;
    const run = h.folder.runUri();
    if (!owner || !run) {
      void h.tellInline(null, S.runner.noFile);
      return null;
    }
    const path = run.fsPath;
    const link = h.folder.link;
    const folder = link?.fsPath ?? dirname(path);
    const text = await readFile(path, 'utf8').catch(() => '');
    const language = detectRunnerLanguage({
      path,
      text,
      languageId: vscode.workspace.textDocuments.find((d) => d.uri.toString() === run.toString())?.languageId,
      siblings: await readdir(dirname(path)).catch(() => []),
      selected: link ? null : h.languages.find((l) => l.id === h.selectedLanguageId)?.name,
      permitted: problem?.permittedLanguageIds ? h.allowedLanguages(problem).map((l) => l.name) : null,
    });
    if (!language) {
      void h.tellInline(null, S.runner.noLanguage);
      return null;
    }
    const set = link && (language === 'cpp' || language === 'c') ? await h.folder.compileFiles() : null;
    const abs = (rel: string) => join(folder, ...rel.split('/'));
    return {
      owner,
      language,
      folder,
      sources: set ? set.sources.map(abs) : [path],
      leftOut: set?.leftOut ?? [],
      saveScope: link ? { folder: link.fsPath } : { file: path },
    };
  }

  private async saveDirty(t: RunTarget): Promise<void> {
    const scope = t.saveScope;
    for (const d of vscode.workspace.textDocuments) {
      if (d.isDirty && !d.isUntitled && ('folder' in scope ? isAtOrInside(d.uri.fsPath, scope.folder) : d.uri.fsPath === scope.file)) await d.save();
    }
  }

  /** Progress reaches the panels at most every `updateMs`; `now` skips the wait. */
  private changed(now = false): void {
    if (now) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
      this.host.emit();
      return;
    }
    this.notifyTimer ??= setTimeout(() => {
      this.notifyTimer = undefined;
      this.host.emit();
    }, RUNNER.updateMs);
  }
}
