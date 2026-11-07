import * as vscode from 'vscode';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isAtOrInside } from '../mapping/paths';
import { Builder, buildRoot, type Program } from '../runner/compile';
import { runCases } from '../runner/execute';
import { detectRunnerLanguage, type RunnerLanguage, Toolchains } from '../runner/languages';
import { nodeProcessApi } from '../runner/process';
import { allPassed, emptyState, nextSampleTip, type RunState, sampleTipShown, summarize } from '../runner/state';
import type { CaseList, CaseOwner, CaseRun, ProcessApi, RunLimits, RunnerCase, RunSummary } from '../runner/types';
import { RUNNER } from '../shared/constants';
import type { TestsHead, ViewState } from '../shared/messages';
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
}

const NO_CASES: readonly RunnerCase[] = [];

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
  /** Whose list `list` is: right after a file switch it can still be the last file's. */
  private listKey: string | null = null;
  /** Moves on with `reset`: work started before it is out of date. */
  private session = 0;
  /** Case changes, one at a time: a run starts after the last one. */
  private edits: Promise<unknown> = Promise.resolve();

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

  private shown(owner: CaseOwner | null): CaseList | null {
    return owner && this.listKey === ownerKey(owner) ? this.list : null;
  }

  summary(): RunSummary {
    const owner = this.owner();
    if (!owner) return { kind: 'no-cases' };
    return summarize(this.shown(owner)?.cases ?? [], this.state(owner));
  }

  /** The main panel's Run tests row. */
  panelView(): Omit<NonNullable<ViewState['runTests']>, 'testsOpen'> {
    const summary = this.summary();
    return { summary, running: this.running, disabledReason: summary.kind === 'no-cases' ? S.runTests.noCases : null };
  }

  /** What the Test view shows; `key` changes when another list takes over. */
  testsView(): { head: TestsHead; key: string | null; cases: readonly RunnerCase[]; runs: ReadonlyMap<string, CaseRun> } {
    const h = this.host;
    const owner = this.owner();
    const list = this.shown(owner);
    const st = owner ? this.state(owner) : emptyState();
    const problem = h.problem;
    const name = h.fileUri ? basename(h.fileUri.fsPath) : null;
    return {
      key: owner ? ownerKey(owner) : null,
      cases: list?.cases ?? NO_CASES,
      runs: st.runs,
      head: {
        title: problem?.name ?? name,
        problemId: problem?.id ?? null,
        limits: this.knownLimits(list),
        summary: this.summary(),
        running: this.running,
        failure: st.failure,
        leftOut: st.leftOut,
        load: problem
          ? {
              testcases: problem.hasTestcase ? { busy: h.tests.busy } : null,
              samples: !h.tests.statementNoPdf || h.tests.samplesBusy ? { busy: h.tests.samplesBusy } : null,
            }
          : null,
        sampleTip: !!list && sampleTipShown(list.sampleTip, list.cases, st.runs),
      },
    };
  }

  /** One change to the active list. Changes keep their order, and a failed one is shown, not thrown. */
  private change(apply: (owner: CaseOwner) => Promise<CaseList>): Promise<void> {
    const owner = this.owner();
    if (!owner) return Promise.resolve();
    const key = ownerKey(owner);
    const next = this.edits.then(async () => {
      try {
        const list = await apply(owner);
        if (this.listKey === key) this.list = list;
        this.host.emit();
      } catch (err) {
        void this.host.tellInline(err, S.runner.saveFailed(this.host.describe(err)));
      }
    });
    this.edits = next;
    return next;
  }

  addCase(): Promise<void> {
    return this.change((o) => this.host.cases.add(o));
  }

  /** New text: the case's old result no longer says anything about it. */
  editCase(id: string, text: Partial<Pick<RunnerCase, 'input' | 'expected'>>): Promise<void> {
    return this.change((o) => {
      this.state(o).runs.delete(id);
      return this.host.cases.update(o, id, text);
    });
  }

  removeCase(id: string): Promise<void> {
    return this.change((o) => {
      this.state(o).runs.delete(id);
      return this.host.cases.remove(o, id);
    });
  }

  reorderCases(ids: readonly string[]): Promise<void> {
    return this.change((o) => this.host.cases.reorder(o, ids));
  }

  /** Set Actual as Expected. A cut output isn't the program's whole answer, so it is refused. */
  async setExpected(id: string): Promise<void> {
    const owner = this.owner();
    const actual = owner ? this.state(owner).runs.get(id)?.actual : undefined;
    if (actual && !actual.truncated) await this.editCase(id, { expected: actual.text });
  }

  /** The whole text, also when the Test view shows it cut. */
  textOf(id: string, what: 'input' | 'expected' | 'actual' | 'stderr'): string | null {
    const owner = this.owner();
    if (!owner) return null;
    if (what === 'input' || what === 'expected') return this.shown(owner)?.cases.find((c) => c.id === id)?.[what] ?? null;
    return this.state(owner).runs.get(id)?.[what === 'actual' ? 'actual' : 'stderr']?.text ?? null;
  }

  /** What Compare in VS Code opens; null without an output to compare. */
  compareTexts(id: string): { n: number; expected: string; actual: string } | null {
    const owner = this.owner();
    const cases = this.shown(owner)?.cases ?? [];
    const at = cases.findIndex((c) => c.id === id);
    const actual = owner ? this.state(owner).runs.get(id)?.actual?.text : undefined;
    return at >= 0 && actual !== undefined ? { n: at + 1, expected: cases[at].expected, actual } : null;
  }

  /** The tip stays away for this problem. */
  dismissSampleTip(): Promise<void> {
    return this.change(async (o) => {
      if ('file' in o) return this.host.cases.read(o);
      const failedRuns = (await this.host.cases.read(o)).sampleTip?.failedRuns ?? 0;
      return this.host.cases.setMeta(o.problemId, { sampleTip: { failedRuns, dismissed: true } });
    });
  }

  failureText(): string | null {
    const owner = this.owner();
    return owner ? (this.state(owner).failure?.message ?? null) : null;
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
    const list = owner ? await this.host.cases.read(owner) : null;
    // Only the newest file's list: reads of two quick switches can end in either order.
    const now = this.owner();
    if ((now && ownerKey(now)) !== (owner && ownerKey(owner))) return;
    if (owner && list && this.list && this.listKey === ownerKey(owner)) this.dropStale(owner, this.list, list);
    this.list = list;
    this.listKey = owner ? ownerKey(owner) : null;
    this.host.emit();
  }

  /** A re-download can change a case's text: its result no longer says anything about it. */
  private dropStale(owner: CaseOwner, before: CaseList, now: CaseList): void {
    const old = new Map(before.cases.map((c) => [c.id, c]));
    const { runs } = this.state(owner);
    for (const c of now.cases) {
      const was = old.get(c.id);
      if (was && (was.input !== c.input || was.expected !== c.expected)) runs.delete(c.id);
    }
  }

  /** The compiler settings changed. */
  toolsChanged(): void {
    this.tools.reset();
  }

  /** The case files changed from outside this flow (Clear Cached Data). */
  refresh(): Promise<void> {
    return this.reload();
  }

  /** A file or folder moved. */
  async onMoved(oldPath: string, newPath: string): Promise<void> {
    await this.host.cases.moved(oldPath, newPath);
    await this.reload();
  }

  /** Forget the results and stop what is running: another account or server starts clean. */
  reset(): void {
    this.session++;
    this.stop();
    this.states.clear();
    this.list = null;
    this.listKey = null;
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
      await this.edits;
      const target = await this.target();
      if (!target) return null;
      const list = await h.cases.read(target.owner);
      if (this.listKey === ownerKey(target.owner)) this.list = list;
      const cases = only ? list.cases.filter((c) => only.includes(c.id)) : list.cases;
      if (!cases.length) return null;

      const st = this.state(target.owner);
      started = true;
      for (const c of cases) st.runs.delete(c.id);
      Object.assign(st, { phase: 'compiling', failure: null, leftOut: target.leftOut, warnings: '' });
      this.changed(true);
      try {
        const [program, limits] = await Promise.all([this.compile(target, st, abort.signal), this.limitsFor(target.owner, list)]);
        if (program) {
          st.phase = 'running';
          await this.execute(target, program, cases, st, limits, abort.signal);
        }
      } catch (err) {
        st.failure = { message: h.describe(err), file: null, line: null };
      } finally {
        st.phase = 'idle';
      }
      // A run that was stopped or didn't compile says nothing about the samples.
      if (!abort.signal.aborted && !st.failure && 'problemId' in target.owner) {
        const tip = nextSampleTip(list.sampleTip, list.cases, st.runs);
        if (tip.failedRuns !== (list.sampleTip?.failedRuns ?? 0)) await h.cases.setMeta(target.owner.problemId, { sampleTip: tip });
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

  private async execute(t: RunTarget, program: Program, cases: readonly RunnerCase[], st: RunState, limits: RunLimits, signal: AbortSignal): Promise<void> {
    const start = (p: Program) =>
      runCases({
        proc: this.proc,
        cases,
        program: p,
        limits,
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
    if (again && (await start(again)).noexec) {
      for (const c of cases) st.runs.delete(c.id);
      st.failure = { message: S.runner.compilerFailed('EACCES'), file: null, line: null };
    }
  }

  private defaultLimits(): RunLimits {
    const c = this.host.cfg;
    return { timeMs: c.runnerDefaultTimeSeconds * 1000, memoryMB: c.runnerDefaultMemoryMB, source: 'default' };
  }

  /** The limits on the list now: the grader's last known ones, else the defaults. */
  knownLimits(list: CaseList | null = this.list): RunLimits {
    return list?.limits ? { timeMs: list.limits.timeMs, memoryMB: list.limits.memoryMB, source: 'grader' } : this.defaultLimits();
  }

  /** Ask the grader once per session (`DataService.limits`), and keep what it says for offline use. */
  private async readLimits(problemId: number): Promise<RunLimits | null> {
    const h = this.host;
    const session = this.session;
    const got = await h.data.limits(problemId);
    // Lists are per server: what the last server said must not land in the next one's.
    if (!got || session !== this.session) return null;
    try {
      const saved = (await h.cases.read({ problemId })).limits;
      if (saved?.timeMs !== got.timeMs || saved?.memoryMB !== got.memoryMB) {
        await h.cases.setMeta(problemId, { limits: { ...got, fetchedAt: new Date().toISOString() } });
        await this.reload();
      }
    } catch {
      /* not kept for offline use, then; this run still has them */
    }
    return { ...got, source: 'grader' };
  }

  /** The test view opened: the limit line should be right before the first run. */
  fetchLimits(): void {
    const owner = this.owner();
    if (owner && 'problemId' in owner) void this.readLimits(owner.problemId);
  }

  /** Saved limits start a run at once. Without any, a slow server only delays it by `limitsWaitMs`. */
  private async limitsFor(owner: CaseOwner, list: CaseList): Promise<RunLimits> {
    if ('file' in owner) return this.defaultLimits();
    const read = this.readLimits(owner.problemId);
    if (list.limits) return this.knownLimits(list);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), RUNNER.limitsWaitMs);
    });
    const got = await Promise.race([read, late]);
    clearTimeout(timer);
    return got ?? this.defaultLimits();
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
    // First: the language and the folder's `main()`s are read from the disk.
    await this.saveDirty(link ? { folder: link.fsPath } : { file: path });
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
    };
  }

  private async saveDirty(scope: { folder: string } | { file: string }): Promise<void> {
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
